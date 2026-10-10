import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, fstatSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { encodeProjectPath, firstUserText, lastAiTitle, transcriptCwd, unifiedDiff, textOf, isInside, entryFinder, parseTranscript, type EntryDetail, type ToolEvent } from '@shared/claude-format'
import type { SessionInfo, PlanInfo } from '@shared/ipc'

/** Paths and readers for what Claude Code writes under ~/.claude. */
export class ClaudeData {
  readonly home: string
  readonly root: string
  readonly plansDir: string
  readonly fileHistoryDir: string
  readonly settingsPath: string
  private titleCache = new Map<string, { mtime: number; title: string }>()
  private cwdCache = new Map<string, string>()

  constructor(home = homedir()) {
    this.home = home
    this.root = join(home, '.claude', 'projects')
    this.plansDir = join(home, '.claude', 'plans')
    this.fileHistoryDir = join(home, '.claude', 'file-history')
    this.settingsPath = join(home, '.claude', 'settings.json')
  }

  projectDir(cwd: string) { return join(this.root, encodeProjectPath(cwd)) }

  /** A sub-agent's transcript: <project>/<session>/subagents/agent-<id>.jsonl, next to the session's. */
  subagentPath(transcript: string, agentId: string) { return join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`) }

  /** A transcript of ours to read on the renderer's request: a .jsonl under ~/.claude/projects, no `..` in the way. */
  private readable(path: unknown): path is string {
    return typeof path === 'string' && path.endsWith('.jsonl') && resolve(path) === path && isInside(path, this.root) && existsSync(path)
  }

  /**
   * The whole of an activity entry, in the session or in one of its sub-agents. The transcript is streamed (it may be
   * tens of MB) and the read stops at the entry, or at its tool's result.
   */
  async entryDetail(transcript: string, ref: string, agentId?: string): Promise<EntryDetail | null> {
    const path = agentId ? (/^[\w-]+$/.test(agentId) ? this.subagentPath(transcript, agentId) : '') : transcript
    if (!this.readable(path) || typeof ref !== 'string' || !ref) return null
    const find = entryFinder(ref)
    const stream = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const l of lines) { const r = find.line(l); if (r !== undefined) return r }
      return find.end()
    } finally { lines.close(); stream.destroy() }
  }

  /** A sub-agent's activity, its description and type from the .meta.json beside it. */
  async subagent(transcript: string, agentId: string): Promise<{ events: ToolEvent[]; agentType?: string; description?: string } | null> {
    if (typeof agentId !== 'string' || !/^[\w-]+$/.test(agentId)) return null
    const path = this.subagentPath(transcript, agentId)
    if (!this.readable(path)) return null
    const u = parseTranscript((await readFile(path, 'utf8')).split('\n'), { plansDir: this.plansDir, home: this.home })
    let meta: any = {}
    try { meta = JSON.parse(await readFile(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch { /* none */ }
    return { events: u.events, ...(typeof meta.agentType === 'string' ? { agentType: meta.agentType } : {}), ...(typeof meta.description === 'string' ? { description: meta.description } : {}) }
  }

  /** Newest transcript of `cwd` created (or, with allowExisting, modified) after `after`, not already claimed. */
  newestTranscript(cwd: string, after: number, allowExisting: boolean, claimed: Set<string>): string | null {
    const dir = this.projectDir(cwd)
    if (!existsSync(dir)) return null
    let best: { p: string; t: number } | null = null
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.jsonl')) continue
      const p = join(dir, n)
      if (claimed.has(p)) continue
      let st
      try { st = statSync(p) } catch { continue }
      const t = allowExisting ? st.mtimeMs : st.birthtimeMs || st.ctimeMs
      if (t <= after) continue
      if (!best || t > best.t) best = { p, t }
    }
    return best?.p ?? null
  }

  /** Reads from `offset`; returns the chunk and the new offset. */
  readFrom(path: string, offset: number): { chunk: string; offset: number } {
    let fd: number
    try { fd = openSync(path, 'r') } catch { return { chunk: '', offset } }
    try {
      const size = fstatSync(fd).size
      if (size <= offset) return { chunk: '', offset }
      const buf = Buffer.alloc(size - offset)
      const n = readSync(fd, buf, 0, buf.length, offset)
      return { chunk: buf.toString('utf8', 0, n), offset: offset + n }
    } finally { closeSync(fd) }
  }

  private head(path: string, bytes = 64 * 1024): string[] {
    try {
      const fd = openSync(path, 'r')
      try { const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, 0); return buf.toString('utf8', 0, n).split('\n') } finally { closeSync(fd) }
    } catch { return [] }
  }
  private tail(path: string, bytes = 128 * 1024): string[] {
    try {
      const fd = openSync(path, 'r')
      try {
        const size = fstatSync(fd).size
        const start = Math.max(0, size - bytes)
        const buf = Buffer.alloc(size - start)
        const n = readSync(fd, buf, 0, buf.length, start)
        return buf.toString('utf8', 0, n).split('\n')
      } finally { closeSync(fd) }
    } catch { return [] }
  }

  hasSessions(cwd: string): boolean {
    const dir = this.projectDir(cwd)
    try { return readdirSync(dir).some((n) => n.endsWith('.jsonl')) } catch { return false }
  }

  /** Sessions started in `cwd` or below, newest first. */
  sessions(cwd: string): SessionInfo[] {
    const prefix = encodeProjectPath(cwd)
    let dirs: string[]
    try { dirs = readdirSync(this.root) } catch { return [] }
    return dirs.filter((d) => d === prefix || d.startsWith(prefix + '-'))
      .flatMap((d) => this.sessionsIn(join(this.root, d), d === prefix ? cwd : null))
      .filter((s) => s.projectPath === cwd || s.projectPath.startsWith(cwd + '/') || s.projectPath.startsWith(cwd + '\\'))
      .sort((a, b) => b.modified - a.modified)
  }

  allSessions(): SessionInfo[] {
    let dirs: string[]
    try { dirs = readdirSync(this.root) } catch { return [] }
    return dirs.flatMap((d) => this.sessionsIn(join(this.root, d), null)).sort((a, b) => b.modified - a.modified)
  }

  private sessionsIn(dir: string, fallbackProject: string | null): SessionInfo[] {
    let names: string[]
    try { names = readdirSync(dir) } catch { return [] }
    const index = new Map<string, any>()
    try {
      const obj = JSON.parse(readFileSync(join(dir, 'sessions-index.json'), 'utf8'))
      for (const e of obj.entries ?? []) if (e?.sessionId) index.set(e.sessionId, e)
    } catch { /* no index */ }
    const out: SessionInfo[] = []
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const id = n.slice(0, -6)
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      const e = index.get(id)
      if (e?.isSidechain) continue
      const cached = this.titleCache.get(p)
      let title: string
      if (cached && cached.mtime === st.mtimeMs) title = cached.title
      else {
        title = lastAiTitle(this.tail(p)) ?? e?.firstPrompt ?? firstUserText(this.head(p)) ?? '(sans titre)'
        this.titleCache.set(p, { mtime: st.mtimeMs, title })
      }
      let projectPath: string = e?.projectPath ?? this.cwdCache.get(p) ?? ''
      if (!projectPath) { projectPath = transcriptCwd(this.head(p)) ?? fallbackProject ?? ''; if (projectPath) this.cwdCache.set(p, projectPath) }
      out.push({ id, path: p, title: title.slice(0, 120), modified: st.mtimeMs, projectPath, messageCount: e?.messageCount ?? 0, gitBranch: e?.gitBranch ?? '' })
    }
    return out
  }

  plans(): PlanInfo[] {
    let names: string[]
    try { names = readdirSync(this.plansDir) } catch { return [] }
    return names.filter((n) => n.endsWith('.md')).map((n) => {
      const p = join(this.plansDir, n)
      let modified = 0, title = n
      try {
        modified = statSync(p).mtimeMs
        const first = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('#'))
        if (first) title = first.replace(/^[#\s]+/, '')
      } catch { /* unreadable */ }
      return { path: p, title, modified }
    }).sort((a, b) => b.modified - a.modified)
  }

  readText(path: string): string {
    try { return readFileSync(path, 'utf8') } catch { return '' }
  }

  /** Unified diff between the session's earliest backup of `path` (or nothing) and the file on disk. */
  sessionDiff(path: string, backupName: string | null, sessionId: string): string {
    let before = ''
    if (backupName) {
      const bp = join(this.fileHistoryDir, sessionId, backupName)
      if (existsSync(bp)) before = this.readText(bp)
    }
    const after = existsSync(path) ? this.readText(path) : ''
    return unifiedDiff(before, after)
  }

  /** Moves a transcript (and its companion folder) to the trash and drops it from sessions-index.json. */
  /** A session the renderer names: a transcript right under a project folder of ~/.claude/projects, named after its id. */
  private isSession(s: SessionInfo): boolean {
    return !!s && typeof s.id === 'string' && /^[\w-]+$/.test(s.id) && this.readable(s.path)
      && basename(s.path) === `${s.id}.jsonl` && dirname(dirname(s.path)) === this.root
  }

  async deleteSession(s: SessionInfo, trash: (p: string) => Promise<void>) {
    // nothing else is trashed, nor any other sessions-index.json written
    if (!this.isSession(s)) throw new Error('session introuvable')
    const dir = dirname(s.path)
    await trash(s.path)
    const companion = join(dir, s.id)
    if (existsSync(companion)) await trash(companion).catch(() => {})
    const index = join(dir, 'sessions-index.json')
    try {
      const obj = JSON.parse(readFileSync(index, 'utf8'))
      if (Array.isArray(obj.entries)) {
        obj.entries = obj.entries.filter((e: any) => e?.sessionId !== s.id)
        writeFileSync(index, JSON.stringify(obj, null, 2))
      }
    } catch { /* no index */ }
  }
}

export { basename, textOf }
