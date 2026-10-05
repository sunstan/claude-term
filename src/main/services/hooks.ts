import { app, Notification, BrowserWindow } from 'electron'
import { watch, type FSWatcher, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Attention } from '@shared/ipc'
import { ClaudeSettings } from './claude-settings'
import type { SessionTracker } from './session-tracker'

/**
 * Claude Code hooks (Notification, Stop) spool JSON events into `userData/events` through a small
 * script; this hub drains them, routes each to a tab, keeps the per-tab attention state, fires
 * OS notifications and the dock badge.
 */
export class HookHub {
  readonly dir: string
  readonly script: string
  static readonly events = ['Notification', 'Stop']
  private watcher?: FSWatcher
  private attention = new Map<string, Attention>()
  private draining = false

  constructor(
    private claudeSettings: ClaudeSettings,
    private trackers: () => Map<string, SessionTracker>,
    private send: (channel: string, payload: unknown) => void,
    private isVisible: (tabId: string) => boolean,
    private getSettings: () => { notifyOS: boolean; dockBadge: boolean },
    private focusTab: (tabId: string) => void,
    private mainWindow: () => BrowserWindow | null,
    base = app.getPath('userData'),
  ) {
    this.dir = join(base, 'events')
    this.script = join(base, process.platform === 'win32' ? 'hook.cmd' : 'hook.sh')
    mkdirSync(this.dir, { recursive: true })
    this.installScript()
    try { this.watcher = watch(this.dir, () => this.drain()) } catch { setInterval(() => this.drain(), 2000) }
    this.drain()
  }

  // MARK: script + settings.json entries

  installScript() {
    const body = hookScript(this.dir, process.platform)
    if (!existsSync(this.script) || readFileSync(this.script, 'utf8') !== body) writeFileSync(this.script, body)
    if (process.platform !== 'win32') chmodSync(this.script, 0o755)
  }

  /** Claude Code runs hook commands through a shell: the path (which may contain spaces) is quoted. */
  get command(): string { return process.platform === 'win32' ? `"${this.script}"` : shellQuote(this.script) }
  private isOurs = (c: string) => c === this.command || c === this.script || c === `"${this.script}"`

  installed(): boolean {
    const r = this.claudeSettings.read()
    if (!r.ok) return false
    return HookHub.events.every((ev) => this.claudeSettings.hasHook(r.data, ev, this.command))
  }

  setInstalled(on: boolean): { ok: boolean; error?: string } {
    this.installScript()
    const r = this.claudeSettings.read()
    if (!r.ok) return { ok: false, error: r.error }
    for (const ev of HookHub.events) this.claudeSettings.setHook(r.data, ev, this.command, on, this.isOurs)
    try { this.claudeSettings.write(r.data); return { ok: true } } catch (e) { return { ok: false, error: String(e) } }
  }

  // MARK: events

  private retry?: ReturnType<typeof setTimeout>
  private drain() {
    if (this.draining) return
    this.draining = true
    try {
      // files still being written (older scripts wrote the .json directly) are read again shortly
      if (drainSpool(this.dir, (o) => this.handle(o)) > 0 && !this.retry) this.retry = setTimeout(() => { this.retry = undefined; this.drain() }, 300)
    } finally { this.draining = false }
  }

  private handle(o: any) {
    const event = String(o.hook_event_name ?? '')
    const transcript = typeof o.transcript_path === 'string' ? o.transcript_path : null
    const cwd = typeof o.cwd === 'string' ? o.cwd : null
    const message = String(o.message ?? '')
    const type = String(o.notification_type ?? '')
    let attention: Attention
    if (event === 'Stop') attention = { kind: 'done', message: '' }
    else if (event === 'Notification') {
      if (type === 'permission_prompt' || /permission/i.test(message)) attention = { kind: 'permission', message }
      else if (type === 'idle_prompt' || /waiting/i.test(message)) attention = { kind: 'idle', message }
      else return   // auth_success and friends
    } else return

    // route: transcript path first, then cwd
    const all = [...this.trackers().values()]
    const t = all.find((x) => x.transcriptPath === transcript)
      ?? all.find((x) => cwd && x.cwd === cwd && !x.transcriptPath)
      ?? all.find((x) => cwd && x.cwd === cwd)
    if (!t) return
    if (!t.transcriptPath && transcript) t.attachTranscript(transcript)

    const win = this.mainWindow()
    const visible = this.isVisible(t.tabId) && (win?.isFocused() ?? false)
    if (visible && attention.kind === 'done') return
    this.set(t.tabId, attention)
    if (!visible && this.getSettings().notifyOS) this.notify(t, attention)
    // Windows / Linux: the taskbar entry flashes until the window gets the focus back (macOS: the Dock badge)
    if (process.platform !== 'darwin' && win && !win.isFocused() && this.getSettings().dockBadge) win.flashFrame(true)
  }

  set(tabId: string, a: Attention | null) {
    if (a) this.attention.set(tabId, a); else this.attention.delete(tabId)
    this.send('claude:attention', { tabId, attention: a })
    this.refreshBadge()
  }
  clear(tabId: string) { if (this.attention.has(tabId)) this.set(tabId, null) }
  get(tabId: string) { return this.attention.get(tabId) ?? null }

  private refreshBadge() {
    if (process.platform !== 'darwin' || !app.dock) return
    const n = this.getSettings().dockBadge ? this.attention.size : 0
    app.dock.setBadge(n ? String(n) : '')
  }

  private notify(t: SessionTracker, a: Attention) {
    if (!Notification.isSupported()) return
    const title = t.state.title ?? t.cwd.split(/[\\/]/).pop() ?? 'Claude'
    const body = a.kind === 'permission' && a.message ? a.message : label(a)
    const n = new Notification({ title, body, silent: a.kind === 'done' })
    n.on('click', () => { const w = this.mainWindow(); w?.show(); w?.focus(); this.focusTab(t.tabId) })
    n.show()
  }
}

export function label(a: Attention): string {
  switch (a.kind) {
    case 'permission': return 'Permission en attente'
    case 'idle': return 'Claude attend une réponse'
    case 'done': return 'Claude a terminé'
  }
}

function shellQuote(s: string) { return "'" + s.replace(/'/g, "'\\''") + "'" }

/**
 * Handles and removes the complete events of a spool folder, in write order. An unreadable .json younger
 * than `graceMs` is kept for a later pass (it may still be written); older ones and stale .tmp files are removed.
 * Returns how many files were kept.
 */
export function drainSpool(dir: string, handle: (event: any) => void, now = Date.now(), graceMs = 5_000): number {
  let files: { n: string; p: string; t: number }[]
  try { files = readdirSync(dir).flatMap((n) => { try { return [{ n, p: join(dir, n), t: statSync(join(dir, n)).mtimeMs }] } catch { return [] } }) } catch { return 0 }
  // write order (Windows names are random), then name
  files.sort((a, b) => a.t - b.t || a.n.localeCompare(b.n))
  let kept = 0
  for (const { n, p, t } of files) {
    const age = now - t
    if (n.endsWith('.tmp')) { if (age > 60_000) try { unlinkSync(p) } catch { /* gone */ } continue }
    if (!n.endsWith('.json')) continue
    let event: unknown
    try { event = JSON.parse(readFileSync(p, 'utf8')) } catch {
      if (age < graceMs) { kept++; continue }
      try { unlinkSync(p) } catch { /* gone */ }
      continue
    }
    try { unlinkSync(p) } catch { /* gone */ }
    try { handle(event) } catch (e) { console.error('[hooks]', e) }
  }
  return kept
}

/** The spool script Claude Code runs for our hooks (JSON event on stdin → <dir>/<time>-<pid>-<rand>.json). */
export function hookScript(dir: string, platform: string): string {
  return platform === 'win32'
      // written as .tmp then renamed: the app only ever reads complete .json files
      ? `@echo off\r\nrem ClaudeTerm hook: spools the Claude Code event (JSON on stdin) for the app.\r\nif not exist "${dir}" mkdir "${dir}"\r\nset "f=${dir}\\%RANDOM%%RANDOM%%RANDOM%"\r\nmore > "%f%.tmp"\r\nmove /y "%f%.tmp" "%f%.json" >nul\r\nexit /b 0\r\n`
      : `#!/bin/sh\n# ClaudeTerm hook: spools the Claude Code event (JSON on stdin) for the app.\nd=${shellQuote(dir)}\nmkdir -p "$d"\nf="$d/$(date +%s)-$$-$RANDOM"\ncat > "$f.tmp" && mv "$f.tmp" "$f.json"\nexit 0\n`
}
