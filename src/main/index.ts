import { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell, nativeTheme, session, net } from 'electron'
import { join, basename, isAbsolute, resolve, parse } from 'node:path'
import { homedir } from 'node:os'
import { execFile, spawnSync } from 'node:child_process'
import { readdirSync, statSync, existsSync, readFileSync, watch } from 'node:fs'
import { SettingsService } from './services/settings'
import { ThemeService } from './services/themes'
import { PtyService } from './services/pty'
import { createWindow, applyOverlayTheme } from './window'
import { ClaudeData } from './services/claude-data'
import { SessionTracker } from './services/session-tracker'
import { ClaudeSettings } from './services/claude-settings'
import { HookHub } from './services/hooks'
import { FileService, DirWatcher } from './services/files'
import { FileOps } from './services/file-ops'
import { ProjectLinks } from './services/links'
import { Skills } from './services/skills'
import { Mcp } from './services/mcp'
import { scanClaudeProcesses } from './services/process'
import { ContentSearch, FileIndex } from './services/search'
import { Attachments } from './services/attachments'
import { PluginHost } from './services/plugins'
import { Updater } from './services/updater'
import { UsageService } from './services/usage'
import { TestsService } from './services/tests'
import { ProblemsService } from './services/problems'
import { detectRunnables } from '@shared/runnables'
import { DefaultModelGuard } from './services/default-model'
import { NPM_LATEST, STATUS_URL, parseStatusPage } from '@shared/claude-info'
import { PluginStore, type ApprovalRequest } from './services/plugin-store'
import { catalogueItems, type Catalogue, type RegistryEntry } from '@shared/plugin-registry'
import { PLUGIN_PERMISSIONS, type PluginPermission } from '@shared/plugins'
import { opensInDefaultApp } from '@shared/external'
import type { DirEntry } from '@shared/ipc'

// One packaged instance: a second one would drain the same hook spool (userData/events) and take the first one's
// events. It leaves before any service starts. Dev runs are left out: electron-vite starts the new app before the old
// one has quit.
if (app.isPackaged && !app.requestSingleInstanceLock()) process.exit(0)
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() } })

// Windows: notifications are attributed to the Start menu shortcut, whose AppUserModelID is the appId of electron-builder.yml
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('fr.jerome.claudeterm')

// Chrome DevTools Protocol for scripted UI checks (scripts/ui.ts): always in dev, on demand (CT_CDP_PORT) when packaged
if (!app.isPackaged || process.env.CT_CDP_PORT) {
  const port = process.env.CT_CDP_PORT || '9333'
  // dev restarts (electron-vite) start the new app before the old one has let go of the port: wait for it (≤ 3 s)
  if (!app.isPackaged) {
    const held = process.platform === 'win32'
      ? () => new RegExp(`:${port}\\s+\\S+\\s+LISTENING`).test(String(spawnSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }).stdout ?? ''))
      : () => !!spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).stdout?.length
    for (let i = 0; i < 30 && held(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  app.commandLine.appendSwitch('remote-debugging-port', port)
}

const settings = new SettingsService()
const builtinThemes = app.isPackaged ? join(process.resourcesPath, 'themes') : join(app.getAppPath(), 'resources', 'themes')
const themes = new ThemeService(settings, builtinThemes)

let win: BrowserWindow | null = null
const send = (channel: string, payload: unknown) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload) }

const links = new ProjectLinks(app.getPath('userData'))
const ptys = new PtyService(() => settings.get(), (id, data) => send('pty:data', { id, data }), (id, code) => send('pty:exit', { id, code }), links)

// pty
ipcMain.handle('pty:create', (_e, opts) => ptys.create(opts))
ipcMain.on('pty:write', (_e, { id, data }) => ptys.write(id, data))
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => ptys.resize(id, cols, rows))
ipcMain.on('pty:kill', (_e, { id }) => ptys.kill(id))

// fs
ipcMain.handle('fs:readdir', (_e, path: string): DirEntry[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .map((d) => {
        let isDir = d.isDirectory()
        if (d.isSymbolicLink()) { try { isDir = statSync(join(path, d.name)).isDirectory() } catch { /* dangling */ } }
        return { name: d.name, path: join(path, d.name), isDir, hidden: d.name.startsWith('.') }
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1))
  } catch { return [] }
})
ipcMain.handle('fs:exists', (_e, path: string) => existsSync(path))
const files = new FileService((path) => send('fs:changed', { path }))
ipcMain.handle('fs:readFile', (_e, path: string) => files.read(path))
ipcMain.handle('fs:writeFile', (_e, { path, text }) => files.write(path, text))
ipcMain.on('fs:watch', (_e, path: string) => files.watch(path))
ipcMain.on('fs:unwatch', (_e, path: string) => files.unwatch(path))
const dirs = new DirWatcher((dir) => send('fs:dirChanged', { path: dir }))
ipcMain.on('fs:watchDir', (_e, dir: string) => dirs.watch(dir))
ipcMain.on('fs:unwatchDir', (_e, dir: string) => dirs.unwatch(dir))
// explorer file management; never the disk root, the home folder or one of its parents
const safe = (p: unknown): p is string => typeof p === 'string' && isAbsolute(p) && resolve(p) === p && p !== parse(p).root
  && !homedir().startsWith(p) && p.split(/[\\/]/).filter(Boolean).length >= 2
ipcMain.handle('fs:create', (_e, { dir, name, folder }) => (safe(dir) || dir === homedir() ? FileOps.create(dir, name, !!folder) : { ok: false, error: 'emplacement refusé' }))
ipcMain.handle('fs:rename', (_e, { path, name }) => (safe(path) ? FileOps.rename(path, name) : { ok: false, error: 'emplacement refusé' }))
ipcMain.handle('fs:transfer', (_e, { paths, dest, move }: { paths: string[]; dest: string; move: boolean }) =>
  (Array.isArray(paths) && paths.every(safe) && (safe(dest) || dest === homedir()) ? paths.map((p) => FileOps.transfer(p, dest, !!move)) : [{ ok: false, error: 'emplacement refusé' }]))
ipcMain.handle('fs:trash', async (_e, paths: string[]) => {
  if (!Array.isArray(paths) || !paths.length || !paths.every(safe)) return false
  const what = paths.length === 1 ? `« ${basename(paths[0])} »` : `ces ${paths.length} éléments`
  const r = await dialog.showMessageBox(win!, { type: 'warning', message: `Mettre ${what} à la corbeille ?`, detail: 'Vous pourrez les récupérer depuis la corbeille.', buttons: ['Mettre à la corbeille', 'Annuler'], defaultId: 0, cancelId: 1 })
  if (r.response !== 0) return false
  for (const p of paths) await shell.trashItem(p).catch(() => {})
  return true
})
ipcMain.handle('app:confirmSave', async (_e, name: string) => {
  const r = await dialog.showMessageBox(win!, { type: 'question', message: `Enregistrer les modifications de ${name} ?`, detail: 'Sinon elles seront perdues.', buttons: ['Enregistrer', 'Ne pas enregistrer', 'Annuler'], defaultId: 0, cancelId: 2 })
  return (['save', 'discard', 'cancel'] as const)[r.response]
})

// themes / settings
ipcMain.handle('themes:list', () => themes.list())
ipcMain.handle('themes:current', () => themes.current())
themes.onChange((t) => { send('themes:changed', t); if (win) applyOverlayTheme(win, t) })
ipcMain.handle('settings:get', () => settings.get())
ipcMain.handle('settings:set', (_e, patch) => settings.set(patch))
settings.onChange((s) => send('settings:changed', s))

// claude sessions
const claudeData = new ClaudeData()
const trackers = new Map<string, SessionTracker>()
const claimed = new Set<string>()
ipcMain.on('claude:track', (_e, { tabId, cwd, opts }) => {
  trackers.get(tabId)?.stop()
  trackers.set(tabId, new SessionTracker(tabId, cwd, claudeData, claimed, (id, state, newEvents) => send('claude:update', { tabId: id, state, newEvents }), opts ?? {}))
})
ipcMain.on('claude:untrack', (_e, { tabId }) => { trackers.get(tabId)?.stop(); trackers.delete(tabId) })
ipcMain.on('claude:setPlan', (_e, { tabId, path }) => trackers.get(tabId)?.setPlan(path))
ipcMain.handle('claude:plans', () => claudeData.plans())
ipcMain.handle('claude:sessions', (_e, cwd: string) => claudeData.sessions(cwd))
ipcMain.handle('claude:allSessions', () => claudeData.allSessions())
ipcMain.handle('claude:hasSessions', (_e, cwd: string) => claudeData.hasSessions(cwd))
ipcMain.handle('claude:deleteSession', (_e, s) => claudeData.deleteSession(s, (p) => shell.trashItem(p)))
ipcMain.handle('claude:sessionDiff', (_e, { path, backupName, sessionId }) => claudeData.sessionDiff(path, backupName, sessionId))
ipcMain.handle('claude:readText', (_e, path: string) => claudeData.readText(path))

// hooks → attention, notifications, dock badge
let visibleTab: string | null = null
ipcMain.on('ui:visibleTab', (_e, { tabId }) => { visibleTab = tabId })
const hooks = new HookHub(new ClaudeSettings(claudeData.settingsPath), () => trackers, send, (id) => id === visibleTab,
  () => { const s = settings.get(); return { notifyOS: s.notifyOS, dockBadge: s.dockBadge } }, (tabId) => send('claude:focusTab', { tabId }),
  () => (win && !win.isDestroyed() ? win : null))   // not getAllWindows(): plugin windows are hidden BrowserWindows too
ipcMain.on('claude:clearAttention', (_e, { tabId }) => hooks.clear(tabId))
ipcMain.on('claude:turnEnded', (_e, { tabId }) => { if (typeof tabId === 'string') hooks.turnEnded(tabId) })
ipcMain.on('claude:untrack', (_e, { tabId }) => hooks.clear(tabId))
ipcMain.handle('hooks:installed', () => hooks.installed())
const claudeSettingsFile = new ClaudeSettings(claudeData.settingsPath)
ipcMain.handle('claudeSettings:read', () => ({ ...claudeSettingsFile.read(), path: claudeData.settingsPath }))
ipcMain.handle('claudeSettings:write', (_e, data) => { try { claudeSettingsFile.write(data); return { ok: true } } catch (e) { return { ok: false, error: String(e) } } })

// Claude panel: subscription usage (status line), Claude Code version and default model
const usage = new UsageService(app.getPath('userData'), claudeSettingsFile, (s) => send('usage:changed', s), process.platform, {
  // Claude Code's claude.ai login: the Keychain on macOS, its credentials file elsewhere (read only, never refreshed here)
  credentials: () => new Promise((res) => {
    const parse = (raw: string) => { try { const o = JSON.parse(raw).claudeAiOauth; return o?.accessToken ? { accessToken: o.accessToken, expiresAt: o.expiresAt, subscriptionType: o.subscriptionType, rateLimitTier: o.rateLimitTier } : null } catch { return null } }
    if (process.platform === 'darwin') execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 30_000 }, (err, out) => res(err ? null : parse(String(out))))
    else { try { res(parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json'), 'utf8'))) } catch { res(null) } }
  }),
  getJson: async (url, headers) => {
    const r = await net.fetch(url, { headers: { ...headers, 'User-Agent': `ClaudeTerm/${app.getVersion()}` }, cache: 'no-store' })
    if (r.status === 401) throw new Error('connexion refusée (401) : ouvre une session Claude pour renouveler le jeton')
    if (r.status === 429) throw new Error('trop de demandes (429) : réessaie dans quelques minutes')
    if (!r.ok) throw new Error(`API d'usage : HTTP ${r.status}`)
    return r.json()
  },
})
usage.start()
ipcMain.handle('usage:state', () => usage.state())
ipcMain.handle('usage:install', (_e, on: boolean) => usage.setInstalled(on))
ipcMain.handle('usage:refresh', () => usage.refresh())
// the terminal bubble's model menu changes the session only: Claude Code's `/model` also saves the alias as the
// default for new sessions, the guard puts the user's default back whenever that happens (even late)
const defaultModel = new DefaultModelGuard(claudeSettingsFile)
ipcMain.handle('claude:switchModel', (_e, { ptyId, alias }: { ptyId: string; alias: string }) => {
  if (!/^[a-z0-9.[\]-]+$/i.test(alias)) return
  defaultModel.beforeSwitch(alias)
  // ^U clears what the user may have started typing (several lines: one per ^U), then the command
  ptys.write(ptyId, '\x15'.repeat(10) + `/model ${alias}\r`)
})
// the Claude panel's default model (new sessions): settings.json, kept by the guard from then on
ipcMain.handle('claude:setDefaultModel', (_e, model: string | null) => (model === null || /^[a-z0-9.[\]-]+$/i.test(model) ? defaultModel.setDefault(model) : { ok: false, error: 'modèle invalide' }))
ipcMain.handle('claude:defaultModel', () => { const r = claudeSettingsFile.read(); return r.ok && typeof r.data.model === 'string' ? r.data.model : null })
let claudeVersion: Promise<string | null> | null = null
const cached = <T,>(ttl: number, load: () => Promise<T>) => { let v: { at: number; p: Promise<T> } | null = null; return (force = false) => { if (force || !v || Date.now() - v.at > ttl) v = { at: Date.now(), p: load() }; return v.p } }
const getPublicJson = async (url: string) => { const r = await net.fetch(url, { cache: 'no-store', headers: { 'User-Agent': `ClaudeTerm/${app.getVersion()}` } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
const latestClaude = cached(3600_000, () => getPublicJson(NPM_LATEST).then((d: any) => (typeof d?.version === 'string' ? d.version : null)).catch(() => null))
const serviceStatus = cached(300_000, () => getPublicJson(STATUS_URL).then((d) => ({ status: parseStatusPage(d) })).catch((e) => ({ error: String((e as Error)?.message ?? e) })))
ipcMain.handle('usage:claude', async (_e, refresh?: boolean) => {
  if (refresh) claudeVersion = null
  claudeVersion ??= new Promise((res) => {
    const inv = ptys.claudeCommand(['--version'], false)
    if (!inv) return res(null)
    execFile(inv.file, inv.args, { env: { ...process.env, ...inv.env }, timeout: 15_000, windowsVerbatimArguments: inv.verbatim }, (err, out) => res(err ? null : String(out).trim().split(/\s/)[0] || null))
  })
  const r = claudeSettingsFile.read()
  const [version, latest, services] = await Promise.all([claudeVersion, latestClaude(!!refresh), serviceStatus(!!refresh)])
  return { version, latest, model: r.ok && typeof r.data.model === 'string' ? r.data.model : null, ...services }
})
ipcMain.handle('hooks:set', (_e, on: boolean) => hooks.setInstalled(on))

// npm, links, skills, mcp, processes, search
const ok = (fn: () => unknown) => { try { const r = fn(); return { ok: true, ...(typeof r === 'string' ? { path: r } : {}) } } catch (e) { return { ok: false, error: (e as Error).message } } }
ipcMain.handle('links:load', (_e, root: string) => links.load(root))
ipcMain.handle('links:save', (_e, { root, links: l }) => ok(() => links.save(root, l)))
const skills = new Skills()
ipcMain.handle('skills:project', (_e, root: string) => skills.project(root))
ipcMain.handle('skills:linked', (_e, root: string) => links.load(root).flatMap((l) => skills.project(l.path, 'linked')))
ipcMain.handle('skills:personal', () => skills.personal())
ipcMain.handle('skills:plugins', () => skills.plugins())
ipcMain.handle('skills:create', (_e, { name, description, root }) => ok(() => skills.create(name, description, root)))
ipcMain.handle('skills:remove', (_e, s) => ok(() => skills.remove(s)))
const mcp = new Mcp(undefined, (args) => ptys.claudeCommand(args, false))
ipcMain.handle('mcp:project', (_e, root: string) => mcp.project(root))
ipcMain.handle('mcp:linked', (_e, root: string) => links.load(root).flatMap((l) => mcp.project(l.path, 'linked')))
ipcMain.handle('mcp:user', () => mcp.user())
ipcMain.handle('mcp:local', (_e, root: string) => mcp.local(root))
ipcMain.handle('mcp:library', (_e, root: string | null) => mcp.library(root, settings.get().recentProjects))
ipcMain.handle('mcp:write', (_e, { server, root, replacing }) => ok(() => mcp.write(server, root, replacing)))
ipcMain.handle('mcp:remove', (_e, { name, root }) => ok(() => mcp.remove(name, root)))
ipcMain.handle('mcp:cli', (_e, { args, cwd }) => mcp.cli(args, cwd))
ipcMain.handle('mcp:health', async (_e, cwd: string | null) => {
  const r = await mcp.cli(['list'], cwd)
  return Object.fromEntries(Mcp.parseList(r.output).map((x) => [x.name, x.health]))
})
// Exécuter panel (Scripts): what the project can run, re-detected when its root folder changes
const runFs = { exists: (p: string) => existsSync(p), read: (p: string) => readFileSync(p, 'utf8'), list: (p: string) => { try { return readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })) } catch { return [] } } }
let runWatch: { root: string; w: ReturnType<typeof watch> } | null = null
ipcMain.handle('runnables:detect', (_e, root: string) => {
  if (runWatch?.root !== root) {
    runWatch?.w.close(); runWatch = null
    let t: ReturnType<typeof setTimeout> | undefined
    try { runWatch = { root, w: watch(root, { recursive: false }, () => { clearTimeout(t); t = setTimeout(() => send('runnables:changed', { root }), 400) }) } } catch { /* not watchable */ }
  }
  try { return detectRunnables(runFs, root) } catch { return [] }
})
// Exécuteurs panel (Tests): suites, tests read from the files, results from the reports of the runs
const testsService = new TestsService(app.getPath('userData'), runFs, (results) => send('tests:results', results))
ipcMain.handle('tests:discover', (_e, root: string) => { try { return testsService.discover(root) } catch { return [] } })
ipcMain.handle('tests:results', () => testsService.results())
// Errors / TODO tabs of the center bottom block
const problems = new ProblemsService(runFs, () => ptys.env())
ipcMain.handle('problems:check', (_e, root: string) => problems.check(root))
ipcMain.handle('problems:todos', (_e, root: string) => problems.todos(root))
ipcMain.handle('proc:scan', () => scanClaudeProcesses(ptys.pids()))
ipcMain.on('proc:kill', (_e, { pid, signal }) => { try { process.kill(pid, signal ?? 'SIGTERM') } catch { /* gone */ } })
const index = new FileIndex()
ipcMain.handle('search:files', (_e, { root, query }) => index.search(root, query))
const contentSearch = new ContentSearch()
ipcMain.handle('search:content', (_e, { root, query }) => (typeof root === 'string' && isAbsolute(root) && query && typeof query.query === 'string' ? contentSearch.run(root, query) : { files: [], count: 0, truncated: false }))

// attachments (images → files → prompt)
const attachments = new Attachments()
ipcMain.handle('att:saveDataUrl', (_e, d: string) => attachments.saveDataUrl(d))
ipcMain.handle('att:clipboardImage', () => attachments.clipboardImage())
ipcMain.handle('att:captureScreen', async () => { const p = await attachments.captureScreen(); if (p) { win?.show(); win?.focus() } return p })

// plugins
let activeRoot: string | null = null
const builtinPlugins = app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'resources', 'plugins')
const pluginHostDir = app.isPackaged ? join(process.resourcesPath, 'plugin-host') : join(app.getAppPath(), 'resources', 'plugin-host')
const pluginHost = new PluginHost(builtinPlugins, { send, projectRoot: () => activeRoot, settings: () => settings.get() as any }, pluginHostDir)
ipcMain.handle('plugins:list', () => pluginHost.list())
ipcMain.handle('plugins:viewModel', (_e, id: string) => pluginHost.viewModel(id))
ipcMain.on('plugins:event', (_e, ev) => pluginHost.viewEvent(ev))
ipcMain.on('plugins:project', (_e, root: string | null) => { if (root !== activeRoot) { activeRoot = root; pluginHost.projectChanged(root) } })
ipcMain.on('plugins:commandEnd', (_e, info) => pluginHost.commandEnd(info))
ipcMain.on('plugins:runs', (_e, list) => pluginHost.runsChanged(Array.isArray(list) ? list : []))
ipcMain.on('plugins:promptReply', (_e, { id, value }) => pluginHost.promptReply(id, value))

// plugin catalogue (DESIGN.md §7.1)
const setApproved = (id: string, perms: string[] | null) => {
  const all = { ...settings.get().pluginPermissions }
  if (perms) all[id] = perms; else delete all[id]
  settings.set({ pluginPermissions: all })
}
const pluginStore = new PluginStore(pluginHost.userDir, app.getVersion(), {
  download,
  builtinIds: () => pluginHost.builtinIds(),
  installedVersion: (id) => pluginHost.get(id)?.manifest.version,
  approved: (id) => settings.get().pluginPermissions[id],
  approve: approvePlugin,
  setApproved,
  unload: (id) => pluginHost.unload(id),
  load: (dir) => { pluginHost.load(dir); send('plugins:changed', pluginHost.list()) },
})
let registryCache: { url: string; entries: RegistryEntry[]; skipped: string[] } | null = null
ipcMain.handle('plugins:catalogue', async (_e, refresh: boolean): Promise<Catalogue> => {
  const url = settings.get().pluginRegistry
  try {
    if (refresh || registryCache?.url !== url) registryCache = { url, ...(await pluginStore.registry(url)) }
    return { url, items: catalogueItems(registryCache.entries, pluginHost.list(), app.getVersion()), skipped: registryCache.skipped }
  } catch (e) {
    return { url, items: [], skipped: [], error: String((e as Error)?.message ?? e) }
  }
})
ipcMain.handle('plugins:install', async (_e, src: { id: string } | { url: string }) => {
  if ('url' in src) return pluginStore.install({ url: src.url })
  const entry = registryCache?.entries.find((x) => x.id === src.id)
  return entry ? pluginStore.install({ entry }) : { ok: false, error: 'plugin absent du catalogue' }
})
ipcMain.handle('plugins:uninstall', async (_e, id: string) => {
  const p = pluginHost.get(id)
  if (!p) return { ok: false, error: 'plugin inconnu' }
  const r = await dialog.showMessageBox(win!, { type: 'warning', message: `Désinstaller « ${p.manifest.name} » ?`, detail: `Le dossier ${p.dir} sera supprimé. Ses données (storage) sont conservées.`, buttons: ['Désinstaller', 'Annuler'], defaultId: 1, cancelId: 1 })
  if (r.response !== 0) return { ok: false, error: 'annulé' }
  settings.set({ disabledPlugins: settings.get().disabledPlugins.filter((x) => x !== id) })
  return pluginStore.uninstall(id, p.dir)
})
ipcMain.handle('plugins:setEnabled', (_e, { id, enabled }: { id: string; enabled: boolean }) => {
  const others = settings.get().disabledPlugins.filter((x) => x !== id)
  settings.set({ disabledPlugins: enabled ? others : [...others, id] })
  pluginHost.reload(id)
})
ipcMain.handle('plugins:approve', async (_e, id: string) => {
  const p = pluginHost.get(id)
  if (!p?.pendingPermissions) return false
  const perms = p.manifest.permissions ?? []
  if (!(await approvePlugin({ id, name: p.manifest.name, version: p.manifest.version, source: p.dir, sha256: '', permissions: perms, verified: false }))) return false
  setApproved(id, perms)
  pluginHost.reload(id)
  return true
})

async function approvePlugin(req: ApprovalRequest): Promise<boolean> {
  const perms = req.permissions.length ? req.permissions.map((p: PluginPermission) => `• ${p} — ${PLUGIN_PERMISSIONS[p]}`).join('\n') : 'aucune'
  const origin = req.sha256 ? `Source : ${req.source}\nsha256 : ${req.sha256}${req.verified ? ' (vérifié avec le catalogue)' : ' (non vérifié : installation depuis une URL)'}` : `Dossier : ${req.source}`
  const r = await dialog.showMessageBox(win!, {
    type: req.verified ? 'question' : 'warning',
    message: req.update ? `Mettre à jour « ${req.name} » ${req.update} → ${req.version} ?` : req.sha256 ? `Installer « ${req.name} » ${req.version} ?` : `Autoriser « ${req.name} » ?`,
    detail: `Permissions demandées :\n${perms}\n\n${origin}\n\nUn plugin s'exécute avec ces droits dans ClaudeTerm.`,
    buttons: [req.update ? 'Mettre à jour' : req.sha256 ? 'Installer' : 'Autoriser', 'Annuler'], defaultId: 1, cancelId: 1,
  })
  return r.response === 0
}

/** GET with a size cap (file: and http(s) through Electron's net stack). */
async function download(url: string, maxBytes: number): Promise<Buffer> {
  const res = await net.fetch(url, { redirect: 'follow', cache: 'no-store' })
  if (!res.ok) throw new Error(`téléchargement : HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error('fichier trop grand')
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) { reader.cancel(); throw new Error('fichier trop grand') }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

// updates (GitHub releases)
const updater = new Updater((s) => send('update:state', s), () => settings.get().autoUpdate)
ipcMain.handle('update:state', () => updater.get())
ipcMain.handle('update:check', () => updater.check())
ipcMain.on('update:install', () => updater.install())

// app
ipcMain.handle('app:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'] })
  return r.canceled ? null : r.filePaths[0]
})
// files the editor cannot show: their default app when it only views them, otherwise their folder (opening a
// program or a script would run it)
ipcMain.on('app:openExternal', (_e, p: string) => {
  if (typeof p !== 'string' || !isAbsolute(p)) return
  if (opensInDefaultApp(p)) shell.openPath(p); else shell.showItemInFolder(p)
})
// Windows taskbar: the overlay the renderer drew (count of tabs waiting); a data URL of an image, nothing else
ipcMain.on('app:setOverlay', (_e, { dataUrl, label }: { dataUrl: string | null; label: string }) => {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return
  const img = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,') ? nativeImage.createFromDataURL(dataUrl) : null
  win.setOverlayIcon(img, typeof label === 'string' ? label : '')
})
// web links go to the default browser (https only)
ipcMain.on('app:openUrl', (_e, url: string) => { if (/^https:\/\//.test(url)) shell.openExternal(url) })
ipcMain.on('app:reveal', (_e, p: string) => { shell.showItemInFolder(p) })
// macOS Quick Look panel on a file or folder (Space in the explorer, like the Finder)
ipcMain.on('app:quickLook', (_e, p: string) => { if (process.platform === 'darwin' && typeof p === 'string' && existsSync(p)) win?.previewFile(p) })

app.whenReady().then(() => {
  // dev runs the stock Electron binary: show the app icon in the Dock (packaged builds carry icon.icns)
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(app.getAppPath(), 'build', 'icon.png'))
  // renderer permissions: only the local font list (settings font pickers)
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'local-fonts')
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'local-fonts'))
  nativeTheme.themeSource = settings.get().themeFollowSystem ? 'system' : themes.current().type
  // Windows / Linux have no menu bar, so no default menu either: its accelerators act whenever the page leaves a key
  // alone (Ctrl+R reloads the workbench, Ctrl+W closes the window and quits). macOS keeps it for its menu bar.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  win = createWindow(themes.current())
  // plugin windows are hidden BrowserWindows too: closing the workbench window quits
  win.webContents.once('did-finish-load', () => { pluginStore.cleanStaging(); pluginHost.loadAll(); updater.start() })
  win.on('closed', () => { win = null; app.quit() })
  // the taskbar flashing for a tab waiting (hooks.ts) stops once the window is back
  win.on('focus', () => win?.flashFrame(false))
})

app.on('window-all-closed', () => { ptys.killAll(); app.quit() })
app.on('before-quit', () => { ptys.killAll(); pluginHost.dispose(); updater.onQuit(); usage.dispose(); testsService.dispose() })
