import { app, BrowserWindow, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute, relative, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { missingPermissions } from '@shared/plugin-registry'
import { cleanCommands, validateManifest, type PluginCommand, type PluginManifest, type PluginInfo, type ViewModel, type ViewEvent, type PromptRequest, type RunInfo, type ProjectDecoration } from '@shared/plugins'
import { isBrowsable } from '@shared/external'
import { fsError, permissionError, type PolicyCtx } from './plugin-policy'

export { validateManifest }

export interface HostBridge {
  send(channel: string, payload: unknown): void
  /** current project root of the active window, null on the welcome screen */
  projectRoot(): string | null
  /** the open projects and their linked folders */
  projects(): { root: string; linked: string[] }[]
  /** the workbench window is on screen (not hidden, not minimized) */
  visible(): boolean
  settings(): Record<string, any>
}

const MAX_FILES = 2000, MAX_BYTES = 20 * 1024 * 1024, MAX_READ = 10 * 1024 * 1024

/**
 * Plugin host (DESIGN.md §7). Each plugin runs in its own hidden, sandboxed renderer (Chromium sandbox, no Node,
 * a private session whose requests are all cancelled). Its only door is the `ctPlugin` bridge of
 * resources/plugin-host/preload.js: every call arrives here tagged with the caller's webContents and is checked
 * against the plugin's permissions (plugin-policy.ts). resources/plugin-host/bootstrap.js rebuilds the `ctx` API
 * on top of it. Plugins are folders with `plugin.json` and `main.js`: built-ins in resources/plugins, user plugins
 * in userData/plugins.
 */
export class PluginHost {
  readonly userDir: string
  private plugins = new Map<string, Loaded>()
  private byContents = new Map<number, Loaded>()
  private views = new Map<string, ViewModel>()
  private prompts = new Map<number, (v: string | null) => void>()
  private promptSeq = 0
  /** commands each running plugin added with ctx.commands.set (its manifest's come first) */
  private dynamicCommands = new Map<string, PluginCommand[]>()
  /** questions to the renderer (the selection), answered through queryReply */
  private queries = new Map<number, (v: unknown) => void>()
  private querySeq = 0
  private popoverSeq = 0
  private watchSeq = 0
  private runSeq = 0
  private runs: RunInfo[] = []
  private bootstrap: string

  constructor(private builtinDir: string, private bridge: HostBridge, private hostDir: string, userDir = join(app.getPath('userData'), 'plugins')) {
    this.userDir = userDir
    mkdirSync(userDir, { recursive: true })
    this.bootstrap = readFileSync(join(hostDir, 'bootstrap.js'), 'utf8').replace(/;\s*$/, '')
    ipcMain.on('plugin:call', (e, method: string, args: unknown) => { e.returnValue = this.call(e, method, args) })
    ipcMain.handle('plugin:callAsync', (e, method: string, args: unknown) => this.callAsync(e, method, args))
    ipcMain.on('plugin:send', (e, method: string, args: unknown) => this.onSend(e, method, args))
  }

  list(): PluginInfo[] { return [...this.plugins.values()].map((p) => p.info) }
  get(id: string): PluginInfo | undefined { return this.plugins.get(id)?.info }
  viewModel(viewId: string) { return this.views.get(viewId) ?? null }
  builtinIds(): string[] {
    try { return readdirSync(this.builtinDir).filter((n) => existsSync(join(this.builtinDir, n, 'plugin.json'))).map((n) => JSON.parse(readFileSync(join(this.builtinDir, n, 'plugin.json'), 'utf8')).id) } catch { return [] }
  }

  loadAll() {
    for (const [dir, builtin] of [[this.builtinDir, true], [this.userDir, false]] as const) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue
        const pdir = join(dir, name)
        try { if (!statSync(pdir).isDirectory() || !existsSync(join(pdir, 'plugin.json'))) continue } catch { continue }
        this.load(pdir, builtin)
      }
    }
    this.changed()
  }

  /**
   * Loads a plugin folder: activated unless invalid, disabled by the user (settings.disabledPlugins) or, for a
   * user plugin, asking for permissions that were not approved (settings.pluginPermissions).
   */
  load(dir: string, builtin = false) {
    let manifest: PluginManifest
    try { manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) } catch { return }
    const err = validateManifest(manifest)
    if (!err && this.plugins.has(manifest.id) && this.plugins.get(manifest.id)!.info.dir !== dir) {
      console.warn(`[plugins] ${manifest.id}: already loaded from ${this.plugins.get(manifest.id)!.info.dir}, ${dir} ignored`)
      return
    }
    const s = this.bridge.settings()
    const disabled = !err && (s.disabledPlugins ?? []).includes(manifest.id)
    const pending = err || builtin ? [] : missingPermissions(manifest.permissions, s.pluginPermissions?.[manifest.id])
    const info: PluginInfo = { manifest, dir, builtin, enabled: !err && !disabled && !pending.length, disabled: disabled || undefined, pendingPermissions: pending.length ? pending : undefined, error: err ?? undefined }
    const loaded: Loaded = { info, watchers: new Map(), popovers: new Set(), decorations: new Map() }
    this.plugins.set(manifest.id, loaded)
    if (info.enabled) this.activate(loaded)
  }

  /** Stops a plugin (its window, hence its code and timers, watchers, views) and forgets it. */
  unload(id: string) {
    const p = this.plugins.get(id)
    if (!p) return
    this.stop(p)
    for (const v of [...this.views.keys()]) if (v.startsWith(id + ':')) this.views.delete(v)
    this.plugins.delete(id)
    this.changed()
  }

  /** Reloads a plugin from its folder after a settings change (enable, disable, approval). */
  reload(id: string) {
    const p = this.plugins.get(id)
    if (!p) return
    const { dir, builtin } = p.info
    this.unload(id)
    this.load(dir, builtin)
    this.changed()
  }

  private changed() { this.bridge.send('plugins:changed', this.list()); this.sendCommands() }

  /** The commands of the running plugins: their manifest's, then those they set. */
  commands(): PluginCommand[] {
    return [...this.plugins.values()].filter((p) => p.win && p.info.enabled).flatMap((p) => {
      const id = p.info.manifest.id
      const all = [...cleanCommands(id, p.info.manifest.contributes?.commands), ...(this.dynamicCommands.get(id) ?? [])]
      return all.filter((c, i) => all.findIndex((x) => x.id === c.id) === i)
    })
  }
  private sendCommands() { this.bridge.send('plugins:commands', this.commands()) }
  /** a command chosen in the palette or on its shortcut: to its plugin only */
  runCommand(pluginId: string, id: string) {
    const p = this.plugins.get(pluginId)
    if (p && this.commands().some((c) => c.pluginId === pluginId && c.id === id)) this.emit(p, 'command', id)
  }
  queryReply(id: number, value: unknown) { this.queries.get(id)?.(value); this.queries.delete(id) }
  /** asks the renderer, with an answer of null when it does not reply in time */
  private ask(kind: string): Promise<unknown> {
    return new Promise((res) => {
      const id = ++this.querySeq
      const t = setTimeout(() => { this.queries.delete(id); res(null) }, 3000)
      this.queries.set(id, (v) => { clearTimeout(t); res(v) })
      this.bridge.send('plugins:query', { id, kind })
    })
  }

  private activate(p: Loaded) {
    const { manifest, dir } = p.info
    let files: Record<string, string>
    try { files = readPluginFiles(dir) } catch (e) { return this.fail(p, e) }
    const ses = session.fromPartition('plugin:' + manifest.id)   // in memory, per plugin
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('devtools:') }))   // no network (yet)
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    const win = new BrowserWindow({
      show: false, width: 480, height: 320, title: `plugin ${manifest.id}`,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, preload: join(this.hostDir, 'preload.js'), backgroundThrottling: false, spellcheck: false, webgl: false },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.on('render-process-gone', (_e, d) => { if (p.win === win) this.fail(p, `le processus du plugin s'est arrêté (${d.reason})`) })
    p.win = win
    this.byContents.set(win.webContents.id, p)
    this.sendCommands()
    win.loadURL('about:blank')
      .then(() => win.webContents.executeJavaScript(`(${this.bootstrap}\n)(window.ctPlugin, ${JSON.stringify(manifest)}, ${JSON.stringify(files)}); void 0`))
      .catch((e) => this.fail(p, e))
  }

  private stop(p: Loaded) {
    p.watchers.forEach((w) => w.close()); p.watchers.clear()
    if (this.dynamicCommands.delete(p.info.manifest.id)) this.sendCommands()
    if (p.decorations.size) { p.decorations.clear(); this.sendDecorations() }
    const win = p.win
    p.win = undefined
    if (!win || win.isDestroyed()) return
    this.byContents.delete(win.webContents.id)
    try { win.webContents.send('plugin:event', 'deactivate', []) } catch { /* gone */ }
    setTimeout(() => { if (!win.isDestroyed()) win.destroy() }, 100)   // lets deactivate() run
  }

  private fail(p: Loaded, e: unknown) {
    p.info.error = String((e as Error)?.message ?? e).split('\n')[0]
    p.info.enabled = false
    console.error(`[plugin ${p.info.manifest.id}]`, e)
    this.stop(p)
    this.changed()
  }

  private emit(p: Loaded, ev: string, ...args: unknown[]) {
    if (p.win && !p.win.isDestroyed()) p.win.webContents.send('plugin:event', ev, args)
  }

  // MARK: bridge (plugin → host)

  private caller(e: IpcMainEvent | IpcMainInvokeEvent): Loaded | undefined { return this.byContents.get(e.sender.id) }

  private policy(p: Loaded): PolicyCtx {
    return { builtin: p.info.builtin, permissions: new Set(p.info.manifest.permissions ?? []), pluginDir: p.info.dir, projectRoot: this.bridge.projectRoot(), home: homedir(), real: realpathSync }
  }

  private checkFs(p: Loaded, path: unknown): string {
    const err = fsError(path, this.policy(p))
    if (err) throw new Error(err)
    return path as string
  }

  private call(e: IpcMainEvent, method: string, a: any): { value?: unknown; error?: string } {
    const p = this.caller(e)
    if (!p) return { error: 'not a plugin' }
    try { return { value: this.sync(p, method, a ?? {}) } } catch (err) { return { error: String((err as Error)?.message ?? err) } }
  }

  private async callAsync(e: IpcMainInvokeEvent, method: string, a: any): Promise<{ value?: unknown; error?: string }> {
    const p = this.caller(e)
    if (!p) return { error: 'not a plugin' }
    try {
      const perm = permissionError(method, this.policy(p))
      if (perm) throw new Error(perm)
      if (method === 'process.exec') {
        if (typeof a?.file !== 'string' || !Array.isArray(a.args) || a.args.some((x: unknown) => typeof x !== 'string')) throw new Error('exec(file, args[]) expected')
        const cwd = typeof a.cwd === 'string' ? a.cwd : undefined
        // nothing waits on a question no one sees (credentials, an ssh passphrase), nor runs for ever: 2 min by default, 10 at most
        const timeout = Math.min(600_000, Math.max(1000, typeof a.timeout === 'number' ? a.timeout : 120_000))
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }) }
        return { value: await new Promise((res) => execFile(a.file, a.args, { cwd, env, timeout, maxBuffer: 8_000_000 }, (err, stdout, stderr) => {
          const killed = !!(err as any)?.killed
          res({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) + (killed ? `\n(arrêté après ${timeout / 1000} s)` : '') })
        })) }
      }
      if (method === 'workspace.selection') return { value: (await this.ask('selection')) ?? { text: '', file: null, source: null } }
      if (method === 'ui.prompt') {
        const req = a as Omit<PromptRequest, 'id'>
        return { value: await new Promise<string | null>((res) => { const id = ++this.promptSeq; this.prompts.set(id, res); this.bridge.send('plugins:prompt', { id, title: String(req.title ?? ''), placeholder: req.placeholder, options: req.options, choice: !!req.choice }) }) }
      }
      throw new Error(`unknown method ${method}`)
    } catch (err) { return { error: String((err as Error)?.message ?? err) } }
  }

  private sync(p: Loaded, method: string, a: any): unknown {
    const id = p.info.manifest.id
    const perm = permissionError(method, this.policy(p))
    if (perm) throw new Error(perm)
    const ownView = (viewId: unknown) => { if (typeof viewId !== 'string' || !viewId.startsWith(id + ':')) throw new Error('not a view of this plugin'); return viewId }
    switch (method) {
      case 'plugin.dir': return p.info.dir
      case 'workspace.project': return this.bridge.projectRoot()
      case 'workspace.projects': return this.bridge.projects()
      case 'workspace.visible': return this.bridge.visible()
      case 'workspace.openProject': {
        if (typeof a.path !== 'string' || !isAbsolute(a.path)) throw new Error('openProject: absolute path expected')
        return void this.bridge.send('plugins:openProject', { path: a.path, claude: !!a.claude })
      }
      case 'workspace.openUrl': {
        if (typeof a.url !== 'string' || !isBrowsable(a.url)) throw new Error('openUrl: https, or http on this machine')
        return void shell.openExternal(a.url)
      }
      case 'workspace.openFile': return void this.bridge.send('plugins:openFile', { path: this.checkFs(p, a.path) })
      case 'workspace.openDiff': if (a.path !== undefined) this.checkFs(p, a.path); return void this.bridge.send('plugins:openDiff', { title: String(a.title ?? ''), path: a.path, original: a.original, modified: a.modified, unified: a.unified })
      case 'fs.exists': return existsSync(this.checkFs(p, a.path))
      case 'fs.read': {
        const path = this.checkFs(p, a.path)
        if (statSync(path).size > MAX_READ) throw new Error('file too large')
        return readFileSync(path, 'utf8')
      }
      case 'fs.list': try { return readdirSync(this.checkFs(p, a.path), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })) } catch (err) { if (/requires|absolute|invalid/.test(String(err))) throw err; return [] }
      case 'fs.watch': {
        const w = watch(this.checkFs(p, a.path), { recursive: false }, (_ev, name) => this.emit(p, 'fs', wid, name ? String(name) : undefined))
        const wid = ++this.watchSeq
        p.watchers.set(wid, w)
        return wid
      }
      case 'fs.unwatch': p.watchers.get(a.wid)?.close(); p.watchers.delete(a.wid); return
      case 'ui.viewSet': { const viewId = ownView(a.viewId); this.views.set(viewId, a.model); return void this.bridge.send('plugins:view', { viewId, model: a.model }) }
      case 'ui.projectDecoration': {
        if (typeof a.root !== 'string' || !a.root) throw new Error('projectDecoration: root expected')
        const d = a.deco
        if (d == null) p.decorations.delete(a.root)
        else {
          if (typeof d.text !== 'string') throw new Error('projectDecoration: text expected')
          const tone = ['ok', 'warn', 'error', 'info'].includes(d.tone) ? d.tone : undefined
          p.decorations.set(a.root, { text: d.text.slice(0, 48), ...(tone ? { tone } : {}), ...(typeof d.tooltip === 'string' ? { tooltip: d.tooltip.slice(0, 400) } : {}) })
        }
        return void this.sendDecorations()
      }
      case 'ui.notify': return void this.bridge.send('plugins:notify', { title: String(a.title ?? ''), body: a.body === undefined ? undefined : String(a.body) })
      case 'ui.popover': { const pid = `popover:${++this.popoverSeq}`; p.popovers.add(pid); this.bridge.send('plugins:popover', { id: pid, anchorViewId: ownView(a.viewId), model: a.model }); return pid }
      case 'ui.popoverUpdate': if (!p.popovers.has(a.id)) throw new Error('unknown popover'); return void this.bridge.send('plugins:popover', { id: a.id, anchorViewId: ownView(a.viewId), model: a.model })
      case 'ui.popoverClose': if (p.popovers.delete(a.id)) this.bridge.send('plugins:popoverClose', { id: a.id }); return
      case 'terminal.run': {
        if (typeof a.cwd !== 'string') throw new Error('run: cwd expected')
        const argv = Array.isArray(a.argv) ? a.argv : undefined
        if (argv && argv.some((c: unknown) => !Array.isArray(c) || c.some((x) => typeof x !== 'string'))) throw new Error('run: argv must be string[][]')
        if (a.command !== undefined && typeof a.command !== 'string') throw new Error('run: command must be a string')
        const runId = `${id}:${++this.runSeq}`
        this.bridge.send('plugins:run', { cwd: a.cwd, command: a.command, argv, label: typeof a.label === 'string' ? a.label : undefined, tab: a.tab === 'new' ? 'new' : 'reuse', id: runId })
        return runId
      }
      case 'terminal.runs': return this.runs.filter((r) => r.id.startsWith(id + ':'))
      case 'terminal.stop': case 'terminal.show': {
        if (typeof a.id !== 'string' || !a.id.startsWith(id + ':')) throw new Error('not a command of this plugin')
        return void this.bridge.send(method === 'terminal.stop' ? 'plugins:stopRun' : 'plugins:showRun', { id: a.id })
      }
      case 'claude.insertPrompt': {
        if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('insertPrompt: text expected')
        if (a.text.length > 50_000) throw new Error('insertPrompt: text too long')
        return void this.bridge.send('plugins:insertPrompt', { text: a.text, send: a.send === true })
      }
      case 'commands.set': { this.dynamicCommands.set(id, cleanCommands(id, a.list)); return void this.sendCommands() }
      case 'settings.get': { const s = this.bridge.settings(); return s.plugins?.[id]?.[a.key] ?? p.info.manifest.contributes?.settings?.[a.key]?.default }
      case 'storage.get': return readStorage(this.storageFile(id))[a.key]
      case 'storage.set': { const f = this.storageFile(id); const d = readStorage(f); d[a.key] = a.value; mkdirSync(dirname(f), { recursive: true }); return void writeFileSync(f, JSON.stringify(d, null, 2)) }
    }
    throw new Error(`unknown method ${method}`)
  }

  private onSend(e: IpcMainEvent, method: string, a: any) {
    const p = this.caller(e)
    if (!p) return
    const tag = `[plugin ${p.info.manifest.id}]`
    if (method === 'console' && Array.isArray(a)) (a[0] === 'error' ? console.error : a[0] === 'warn' ? console.warn : console.log)(tag, ...(Array.isArray(a[1]) ? a[1] : []))
    else if (method === 'fail') this.fail(p, String(a))
  }

  private storageFile(id: string) { return join(this.userDir, '.storage', id + '.json') }

  // MARK: renderer → host

  /** to the plugin owning the view (or the popover) only */
  viewEvent(e: ViewEvent) {
    for (const p of this.plugins.values()) if (e.viewId.startsWith(p.info.manifest.id + ':') || p.popovers.has(e.viewId)) this.emit(p, 'view:' + e.viewId, e)
  }
  projectChanged(root: string | null) { for (const p of this.plugins.values()) this.emit(p, 'project', root) }
  projectsChanged() { const list = this.bridge.projects(); for (const p of this.plugins.values()) this.emit(p, 'projects', list) }
  visibilityChanged(visible: boolean) { for (const p of this.plugins.values()) this.emit(p, 'visibility', visible) }
  /** every plugin's decorations of project tabs and linked folders */
  decorations(): (ProjectDecoration & { root: string; pluginId: string })[] {
    return [...this.plugins.values()].flatMap((p) => [...p.decorations].map(([root, d]) => ({ root, pluginId: p.info.manifest.id, ...d })))
  }
  private sendDecorations() { this.bridge.send('plugins:decorations', this.decorations()) }
  commandEnd(info: { command: string; exit: number | null }) { for (const p of this.plugins.values()) this.emit(p, 'commandEnd', info) }
  /** commands started by plugins still running: each plugin hears about its own */
  runsChanged(list: RunInfo[]) {
    this.runs = list.filter((r) => r && typeof r.id === 'string')
    for (const p of this.plugins.values()) { const pid = p.info.manifest.id + ':'; this.emit(p, 'runs', this.runs.filter((r) => r.id.startsWith(pid))) }
  }
  promptReply(id: number, value: string | null) { this.prompts.get(id)?.(value); this.prompts.delete(id) }
  dispose() { for (const p of this.plugins.values()) { p.watchers.forEach((w) => w.close()); if (p.win && !p.win.isDestroyed()) p.win.destroy() } }
}

interface Loaded { info: PluginInfo; win?: BrowserWindow; watchers: Map<number, FSWatcher>; popovers: Set<string>; decorations: Map<string, ProjectDecoration> }

/** The plugin's .js files (posix relative path → source) handed to its window. */
export function readPluginFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  let count = 0, bytes = 0
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' && d === dir) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.js')) {
        const src = readFileSync(p, 'utf8')
        if (++count > MAX_FILES || (bytes += src.length) > MAX_BYTES) throw new Error('plugin trop gros')
        out[relative(dir, p).split(sep).join('/')] = src
      }
    }
  }
  walk(dir)
  return out
}

function readStorage(file: string): Record<string, unknown> { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
