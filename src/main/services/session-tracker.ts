import { watch, type FSWatcher, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseTranscript, completeLines, isEmptyUpdate, isInside, applyQueue, type ToolEvent } from '@shared/claude-format'
import type { SessionState } from '@shared/ipc'
import type { ClaudeData } from './claude-data'

/**
 * Follows one Claude session (one tab): finds its transcript, tails it, keeps the derived
 * state (files touched, plan, tokens…) and pushes updates to the renderer.
 * Watches the project folder and the transcript; a slow poll covers watcher misses.
 */
export class SessionTracker {
  state: SessionState
  private transcript: string | null = null
  /** the transcript a SessionStart hook named, until Claude Code writes it */
  private pending: string | null = null
  private offset = 0
  private rest = ''
  private startedAt = Date.now()
  private reusesTranscript: boolean
  private dirWatcher?: FSWatcher
  private fileWatcher?: FSWatcher
  private planWatcher?: FSWatcher
  private timer?: ReturnType<typeof setInterval>
  private planMtime = -1
  private stopped = false

  get transcriptPath() { return this.transcript ?? this.pending }
  attachTranscript(path: string) { if (!this.transcript && existsSync(path)) { this.attach(path); this.poll() } }

  constructor(
    readonly tabId: string,
    readonly cwd: string,
    private data: ClaudeData,
    private claimed: Set<string>,
    private emit: (tabId: string, state: SessionState, newEvents: ToolEvent[]) => void,
    opts: { resume?: string; reuse?: boolean } = {},
  ) {
    this.reusesTranscript = !!opts.reuse || !!opts.resume
    this.state = emptyState()
    if (opts.resume) {
      // the same spelling as the transcript paths hooks report, which route attention to this tab
      const p = join(data.projectDir(cwd), `${opts.resume}.jsonl`)
      if (existsSync(p)) this.attach(p)
    }
    this.watchDir()
    this.timer = setInterval(() => this.poll(), 1500)
    this.poll()
  }

  private watchDir() {
    const dir = this.data.projectDir(this.cwd)
    if (!existsSync(dir)) return
    try { this.dirWatcher = watch(dir, () => this.poll()) } catch { /* fallback: poll */ }
  }

  private attach(path: string) {
    this.transcript = path
    this.claimed.add(path)
    this.state.sessionId = basename(path, '.jsonl')
    this.state.transcriptPath = path
    try { this.fileWatcher = watch(path, () => this.poll()) } catch { /* poll */ }
  }

  private poll() {
    if (this.stopped) return
    if (!this.transcript) {
      if (!this.dirWatcher) this.watchDir()
      // the session the hooks named, else the newest unclaimed transcript of the folder
      if (this.pending) { if (existsSync(this.pending)) { this.attach(this.pending); this.pending = null } }
      else {
        const p = this.data.newestTranscript(this.cwd, this.startedAt - 2000, this.reusesTranscript, this.claimed)
        if (p) this.attach(p)
      }
    }
    let changed = false
    const newEvents: ToolEvent[] = []
    if (this.transcript) {
      const { chunk, offset } = this.data.readFrom(this.transcript, this.offset)
      if (chunk) {
        this.offset = offset
        const { lines, rest } = completeLines(this.rest + chunk)
        this.rest = rest
        const u = parseTranscript(lines, { plansDir: this.data.plansDir, home: this.data.home })
        if (!isEmptyUpdate(u)) {
          changed = true
          const s = this.state
          s.events.push(...u.events); newEvents.push(...u.events)
          if (s.events.length > 500) s.events.splice(0, s.events.length - 500)
          s.inputTokens += u.inputTokens; s.outputTokens += u.outputTokens
          if (u.model) s.model = u.model
          if (u.effort) s.effort = u.effort
          Object.assign(s.agents, u.agents)
          if (u.queueOps.length) s.queue = applyQueue(s.queue, u.queueOps)
          s.images += u.images
          if (u.contextTokens !== undefined) s.contextTokens = u.contextTokens
          for (const e of u.events) if (e.file && !isInside(e.file, this.data.plansDir)) s.files[e.file] = (s.files[e.file] ?? 0) + 1
          for (const [p, d] of Object.entries(u.bashDiffs)) (s.bashDiffs[p] ??= []).push(...d)
          for (const [p, b] of Object.entries(u.backups)) {
            const e = s.backups[p]
            if (e && e.version <= b.version) continue
            s.backups[p] = b
            if (s.files[p] === undefined) s.files[p] = 0
          }
          if (u.planMode !== undefined) s.planMode = u.planMode
          if (u.planPath && u.planPath !== s.planPath) { s.planPath = u.planPath; this.planMtime = -1; this.watchPlan() }
          if (u.aiTitle) s.title = u.aiTitle
          if (u.permissionMode) s.permissionMode = u.permissionMode
          if (u.startedTools.length || u.finishedTools.length) {
            const done = new Set(u.finishedTools)
            s.runningTools = [...s.runningTools, ...u.startedTools].filter((t) => !done.has(t.id))
          }
        }
      }
    }
    if (this.transcript && this.pollAgents()) changed = true
    if (this.refreshPlan()) changed = true
    if (changed) this.emit(this.tabId, this.state, newEvents)
  }

  /** where each sub-agent's transcript has been read up to (by agent id) */
  private agentReads = new Map<string, { offset: number; rest: string }>()
  /** Files the session's sub-agents touch count in the session's files (their activity is read on demand). */
  private pollAgents(): boolean {
    let changed = false
    for (const { agentId } of Object.values(this.state.agents)) {
      const path = this.data.subagentPath(this.transcript!, agentId)
      const r = this.agentReads.get(agentId) ?? { offset: 0, rest: '' }
      const { chunk, offset } = this.data.readFrom(path, r.offset)
      if (!chunk) continue
      const { lines, rest } = completeLines(r.rest + chunk)
      this.agentReads.set(agentId, { offset, rest })
      const u = parseTranscript(lines, { plansDir: this.data.plansDir, home: this.data.home })
      const s = this.state
      for (const e of u.events) if (e.file && !isInside(e.file, this.data.plansDir)) { s.files[e.file] = (s.files[e.file] ?? 0) + 1; changed = true }
      for (const [p, d] of Object.entries(u.bashDiffs)) { (s.bashDiffs[p] ??= []).push(...d); changed = true }
      for (const [p, b] of Object.entries(u.backups)) {
        const e = s.backups[p]
        if (e && e.version <= b.version) continue
        s.backups[p] = b; changed = true
        if (s.files[p] === undefined) s.files[p] = 0
      }
    }
    return changed
  }

  private watchPlan() {
    this.planWatcher?.close()
    if (this.state.planPath && existsSync(this.state.planPath)) {
      try { this.planWatcher = watch(this.state.planPath, () => this.poll()) } catch { /* poll */ }
    }
  }

  private refreshPlan(): boolean {
    const p = this.state.planPath
    if (!p) { if (this.state.planText) { this.state.planText = ''; return true } return false }
    let m = -1
    try { m = statSync(p).mtimeMs } catch { /* not yet written */ }
    if (m === this.planMtime) return false
    this.planMtime = m
    this.state.planText = this.data.readText(p)
    if (!this.planWatcher && m >= 0) this.watchPlan()
    return true
  }

  setPlan(path: string | null) {
    this.state.planPath = path ?? undefined
    this.planMtime = -1
    this.watchPlan()
    if (this.refreshPlan() || !path) this.emit(this.tabId, this.state, [])
  }

  /**
   * Claude Code started a session in this tab (SessionStart hook). `startup` binds only a tab that has none yet: a
   * claude that Claude itself runs (claude -p in its shell) inherits the tab and starts sessions too. `clear`,
   * `resume` and `compact` move the tab to their transcript.
   */
  sessionStarted(path: string, source: string) {
    if (this.stopped || path === this.transcript || path === this.pending) return
    if (source === 'startup' && (this.transcript || this.pending)) return
    if (this.transcript) {
      this.fileWatcher?.close(); this.fileWatcher = undefined
      this.claimed.delete(this.transcript)
      this.transcript = null
      this.offset = 0; this.rest = ''; this.agentReads.clear()
      this.state = emptyState()
      this.planMtime = -1; this.planWatcher?.close(); this.planWatcher = undefined
    }
    // Claude Code writes the transcript with the first message: until then the path waits, claimed for this tab
    if (this.pending) this.claimed.delete(this.pending)
    this.pending = path
    this.claimed.add(path)
    this.poll()
    this.emit(this.tabId, this.state, [])
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
    this.dirWatcher?.close(); this.fileWatcher?.close(); this.planWatcher?.close()
    if (this.transcript) this.claimed.delete(this.transcript)
    if (this.pending) this.claimed.delete(this.pending)
  }
}

export function emptyState(): SessionState {
  return { events: [], files: {}, backups: {}, bashDiffs: {}, agents: {}, queue: [], images: 0, inputTokens: 0, outputTokens: 0, planText: '', planMode: false, runningTools: [] }
}
