/**
 * Claude Code file formats (pure, no I/O): transcript lines, project path encoding, diffs.
 * Knowledge ported from the native v1; the formats are undocumented and may change.
 */

export interface ToolEvent {
  id: number
  time: string
  /** tool name, "text", "user", "Edit (bash)" */
  kind: string
  detail: string
  file: string | null
  /** where the entry is in the transcript ("<record uuid>:<content index>"), to read its detail on demand */
  ref?: string
  /** tool_use id of a tool call */
  toolId?: string
}

/** A sub-agent an Agent / Task call started: its transcript is <session>/subagents/agent-<agentId>.jsonl. */
export interface AgentLink { agentId: string; description?: string }

export interface TranscriptUpdate {
  events: ToolEvent[]
  /** tool_use id → the sub-agent it started */
  agents: Record<string, AgentLink>
  inputTokens: number
  outputTokens: number
  /** model of the last assistant message (as the API names it: no [1m] suffix) */
  model?: string
  /** tokens in the context at the last assistant message: input + cache read + cache creation */
  contextTokens?: number
  planPath?: string
  planMode?: boolean
  aiTitle?: string
  permissionMode?: string
  /** reasoning effort: of the last assistant message, or set by a /effort command (before any reply) */
  effort?: string
  startedTools: { id: string; name: string; detail: string }[]
  finishedTools: string[]
  /** absolute path → earliest backup (file-history-snapshot records) */
  backups: Record<string, { name: string; version: number }>
  /** absolute path → unified-diff hunks of edits made through Bash commands */
  bashDiffs: Record<string, string[]>
}

export function emptyUpdate(): TranscriptUpdate {
  return { events: [], agents: {}, inputTokens: 0, outputTokens: 0, startedTools: [], finishedTools: [], backups: {}, bashDiffs: {} }
}

export function isEmptyUpdate(u: TranscriptUpdate): boolean {
  return u.events.length === 0 && u.inputTokens === 0 && u.outputTokens === 0 && u.planPath === undefined
    && u.planMode === undefined && u.aiTitle === undefined && u.permissionMode === undefined && u.model === undefined && u.contextTokens === undefined
    && u.effort === undefined && Object.keys(u.agents).length === 0
    && u.startedTools.length === 0 && u.finishedTools.length === 0
    && Object.keys(u.backups).length === 0 && Object.keys(u.bashDiffs).length === 0
}

/** Claude Code's project folder name: every byte outside [a-zA-Z0-9] becomes "-". */
export function encodeProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** `base` followed by `parts`, joined with the separator `base` uses (Claude Code writes Windows paths with backslashes). */
export function joinPath(base: string, parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts.filter(Boolean)].join(sep)
}

/** `path` is below `dir`, whatever separator each uses; Windows paths compare without case. */
export function isInside(path: string, dir: string): boolean {
  const norm = (p: string) => { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s }
  return norm(path).startsWith(norm(dir) + '/')
}

let eventSeq = 0

export function oneLine(s: string): string {
  return s.replace(/\n/g, ' ⏎ ').slice(0, 200)
}

export function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string)
    return texts.length ? texts.join(' ') : null
  }
  return null
}

/**
 * Parses complete transcript lines. `plansDir` marks plan files, `home` resolves snapshot paths
 * when the record has no realParentDir.
 */
export function parseTranscript(lines: string[], opts: { plansDir: string; home: string }): TranscriptUpdate {
  const u = emptyUpdate()
  for (const line of lines) {
    if (!line.trim()) continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    if (!obj || typeof obj.type !== 'string') continue
    const time = typeof obj.timestamp === 'string' ? obj.timestamp : new Date().toISOString()
    switch (obj.type) {
      case 'ai-title':
        if (typeof obj.aiTitle === 'string') u.aiTitle = obj.aiTitle
        break
      case 'file-history-snapshot': {
        const tracked = obj.snapshot?.trackedFileBackups
        if (!tracked || typeof tracked !== 'object') break
        for (const [rel, b] of Object.entries<any>(tracked)) {
          if (!b || typeof b.backupFileName !== 'string') continue
          const version = typeof b.version === 'number' ? b.version : 1
          const segments = rel.split(/[\\/]/)
          const parent = typeof b.realParentDir === 'string' ? b.realParentDir : joinPath(opts.home, segments.slice(0, -1))
          const abs = joinPath(parent, segments.slice(-1))
          const e = u.backups[abs]
          if (e && e.version <= version) continue
          u.backups[abs] = { name: b.backupFileName, version }
        }
        break
      }
      case 'permission-mode':
        if (typeof obj.permissionMode === 'string') u.permissionMode = obj.permissionMode
        break
      case 'attachment': {
        const a = obj.attachment
        if (!a) break
        if (a.type === 'plan_mode') { u.planMode = true; if (typeof a.planFilePath === 'string') u.planPath = a.planFilePath }
        if (a.type === 'plan_mode_exit') { u.planMode = false; if (typeof a.planFilePath === 'string') u.planPath = a.planFilePath }
        break
      }
      case 'assistant': {
        const msg = obj.message
        if (!msg) break
        if (msg.usage) {
          u.inputTokens += msg.usage.input_tokens ?? 0
          u.outputTokens += msg.usage.output_tokens ?? 0
          // sidechains (subagents) have their own context
          if (!obj.isSidechain) u.contextTokens = (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)
        }
        if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>' && !obj.isSidechain) u.model = msg.model
        if (typeof obj.effort === 'string' && obj.effort && !obj.isSidechain) u.effort = obj.effort
        if (!Array.isArray(msg.content)) break
        msg.content.forEach((item: any, index: number) => {
          const ref = typeof obj.uuid === 'string' ? `${obj.uuid}:${index}` : undefined
          if (item?.type === 'tool_use') {
            const name: string = item.name ?? '?'
            const input = item.input ?? {}
            const file: string | null = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
            if (file && isInside(file, opts.plansDir)) u.planPath = file
            if (name === 'EnterPlanMode') u.planMode = true
            if (name === 'ExitPlanMode') u.planMode = false
            const detail = file ?? input.command ?? input.pattern ?? input.description ?? input.prompt ?? input.query ?? ''
            const toolId = typeof item.id === 'string' ? item.id : undefined
            u.events.push({ id: ++eventSeq, time, kind: name, detail: oneLine(String(detail)), file, ref, toolId })
            if (toolId) u.startedTools.push({ id: toolId, name, detail: oneLine(String(detail)) })
          } else if (item?.type === 'text' && typeof item.text === 'string' && item.text) {
            u.events.push({ id: ++eventSeq, time, kind: 'text', detail: oneLine(item.text), file: null, ref })
          }
        })
        break
      }
      case 'user': {
        // prompts carry the mode they were sent in; a session started by /clear has no permission-mode record
        if (typeof obj.permissionMode === 'string') u.permissionMode = obj.permissionMode
        const msg = obj.message
        if (!msg) break
        const bed = obj.toolUseResult?.bashEditDiff
        if (bed && Array.isArray(bed.files)) {
          for (const f of bed.files) {
            if (typeof f?.filePath !== 'string') continue
            let text = ''
            for (const h of f.hunks ?? []) {
              text += `@@ -${h.oldStart ?? 0},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@\n`
              text += (h.lines ?? []).join('\n') + '\n'
            }
            ;(u.bashDiffs[f.filePath] ??= []).push(text)
            u.events.push({ id: ++eventSeq, time, kind: 'Edit (bash)', detail: f.filePath, file: f.filePath })
          }
        }
        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item?.type === 'tool_result' && typeof item.tool_use_id === 'string') {
              u.finishedTools.push(item.tool_use_id)
              // an Agent / Task call returns the sub-agent it started (its transcript under <session>/subagents)
              const r = obj.toolUseResult
              if (r && typeof r.agentId === 'string' && /^[\w-]+$/.test(r.agentId)) u.agents[item.tool_use_id] = { agentId: r.agentId, ...(typeof r.description === 'string' ? { description: r.description } : {}) }
            }
          }
        }
        const t = textOf(msg.content)
        if (t && !t.startsWith('<')) u.events.push({ id: ++eventSeq, time, kind: 'user', detail: oneLine(t), file: null, ...(typeof obj.uuid === 'string' ? { ref: obj.uuid } : {}) })
        // `/effort <level>` is recorded when typed, before Claude answers
        const effort = t?.includes('<command-name>/effort</command-name>') ? t.match(/<command-args>\s*([a-z]+)\s*<\/command-args>/)?.[1] : undefined
        if (effort && !obj.isSidechain) u.effort = effort
        break
      }
    }
  }
  return u
}

/** The whole of an activity entry: a tool call with its input and result, Claude's text, or the user's prompt. */
export type EntryDetail =
  | { kind: 'tool'; name: string; input: string; output: string; isError: boolean; truncated: boolean }
  | { kind: 'text' | 'user'; text: string }

const MAX_DETAIL = 100_000

/** Text of a tool result's content (text blocks; other blocks named). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : c?.type ? `[${c.type}]` : '')).join('\n')
}

/**
 * Finds the entry `ref` points at ("<uuid>:<index>", or "<uuid>" for a prompt), fed the transcript's lines in order:
 * `line` returns the detail once known (a tool's waits for its result), `end` what was found when the lines run out.
 * The main process streams a transcript through it and stops at the first answer.
 */
export function entryFinder(ref: string): { line(line: string): EntryDetail | null | undefined; end(): EntryDetail | null } {
  const [uuid, idx] = ref.split(':')
  let found: { name: string; id: unknown; input: string } | null = null
  const tool = (output: string, isError: boolean): EntryDetail =>
    ({ kind: 'tool', name: found!.name, input: found!.input.slice(0, MAX_DETAIL), output: output.slice(0, MAX_DETAIL), isError, truncated: output.length > MAX_DETAIL || found!.input.length > MAX_DETAIL })
  return {
    line(line) {
      if (!found && !line.includes(uuid)) return undefined
      let o: any
      try { o = JSON.parse(line) } catch { return undefined }
      if (!found) {
        if (o?.uuid !== uuid) return undefined
        if (o.type === 'user') return { kind: 'user', text: textOf(o.message?.content) ?? '' }
        const item = Array.isArray(o.message?.content) ? o.message.content[Number(idx)] : undefined
        if (!item || (item.type !== 'text' && item.type !== 'tool_use')) return null
        if (item.type === 'text') return { kind: 'text', text: String(item.text ?? '') }
        found = { name: String(item.name ?? '?'), id: item.id, input: JSON.stringify(item.input ?? {}, null, 2) }
        return undefined
      }
      // the tool's result comes in a later user record
      const res = Array.isArray(o?.message?.content) ? o.message.content.find((c: any) => c?.type === 'tool_result' && c.tool_use_id === found!.id) : undefined
      return res ? tool(resultText(res.content), !!res.is_error) : undefined
    },
    end: () => (found ? tool('', false) : null),
  }
}

/** The entry `ref` points at in transcript lines (see entryFinder). */
export function entryDetail(lines: string[], ref: string): EntryDetail | null {
  const f = entryFinder(ref)
  for (const l of lines) { const r = f.line(l); if (r !== undefined) return r }
  return f.end()
}

/** Splits a chunk into complete lines; the remainder (no trailing newline) is returned separately. */
export function completeLines(chunk: string): { lines: string[]; rest: string } {
  const i = chunk.lastIndexOf('\n')
  if (i < 0) return { lines: [], rest: chunk }
  return { lines: chunk.slice(0, i).split('\n'), rest: chunk.slice(i + 1) }
}

/** First user prompt of a transcript head (for titles); skips command/system-style messages. */
export function firstUserText(lines: string[]): string | null {
  for (const line of lines) {
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type !== 'user' || !obj.message) continue
    const t = textOf(obj.message.content)
    if (t && !t.startsWith('<') && !t.includes('<command-')) return t.slice(0, 90).replace(/\n/g, ' ')
  }
  return null
}

/** Last ai-title record of a transcript tail. */
export function lastAiTitle(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"ai-title"')) continue
    try { const t = JSON.parse(lines[i]).aiTitle; if (typeof t === 'string' && t) return t } catch { /* partial line */ }
  }
  return null
}

/** cwd recorded in the first transcript records. */
export function transcriptCwd(lines: string[]): string | null {
  for (const line of lines) {
    try { const c = JSON.parse(line).cwd; if (typeof c === 'string' && (c.startsWith('/') || /^[A-Za-z]:\\/.test(c))) return c } catch { /* skip */ }
  }
  return null
}

// MARK: - diffs

/** (+added, −removed) line counts of a unified diff. */
export function diffStats(diff: string): [number, number] {
  let a = 0, r = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) a++
    else if (line.startsWith('-')) r++
  }
  return [a, r]
}

/** Unified diff of two texts (Myers-free LCS, fine for source files), 3 lines of context. */
export function unifiedDiff(before: string, after: string, labelA = 'avant', labelB = 'après'): string {
  // like diff(1): the newline terminates a line, it does not start an empty one
  const split = (s: string) => (s === '' ? [] : (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n'))
  const a = split(before), b = split(after)
  // LCS table (bounded: very large files fall back to a whole-file replacement)
  if (a.length * b.length > 4_000_000) return `--- ${labelA}\n+++ ${labelB}\n@@ -1,${a.length} +1,${b.length} @@\n` + a.map((l) => '-' + l).join('\n') + '\n' + b.map((l) => '+' + l).join('\n') + '\n'
  const n = a.length, m = b.length
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }
  const ops: Op[] = []
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: ' ', s: a[i], ai: i, bi: j }); i++; j++ }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ t: '-', s: a[i], ai: i, bi: j }); i++ }   // deletions first, like diff(1)
    else { ops.push({ t: '+', s: b[j], ai: i, bi: j }); j++ }
  }
  if (!ops.some((o) => o.t !== ' ')) return ''
  const ctx = 3
  let out = `--- ${labelA}\n+++ ${labelB}\n`
  let k = 0
  while (k < ops.length) {
    if (ops[k].t === ' ') { k++; continue }
    const start = Math.max(0, k - ctx)
    let end = k
    while (end < ops.length) {
      if (ops[end].t !== ' ') { end++; continue }
      let run = end
      while (run < ops.length && ops[run].t === ' ') run++
      if (run - end > ctx * 2 || run >= ops.length) { end = Math.min(run, end + ctx); break }
      end = run
    }
    const hunk = ops.slice(start, end)
    const oldLines = hunk.filter((o) => o.t !== '+').length, newLines = hunk.filter((o) => o.t !== '-').length
    const oldStart = oldLines ? hunk[0].ai + 1 : hunk[0].ai, newStart = newLines ? hunk[0].bi + 1 : hunk[0].bi
    out += `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n` + hunk.map((o) => o.t + o.s).join('\n') + '\n'
    k = end
  }
  return out
}
