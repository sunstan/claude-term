import { create } from 'zustand'
import { isInteractiveClaude } from '@shared/models'
import { reorder } from '@shared/order'
import { clearLine, commandLine, dialectFor } from '@shared/shell'
import { t } from '@/i18n'
import { pathsForPrompt } from '@shared/paths'
import type { ResolvedTheme } from '@shared/theme'
import type { Settings, TabKind, SessionState, Attention } from '@shared/ipc'

export interface Tab {
  id: string
  kind: TabKind | 'file' | 'diff'
  title: string
  cwd: string
  ptyId?: string
  path?: string
  alive: boolean
  exitCode?: number
  /** a foreground command is running (shell integration) */
  busy: boolean
  /** a command a plugin started here (terminal.run), until it ends: started once the shell reports it */
  run?: { id: string; label?: string; started: boolean; at: number }
  lastCommand: string
  lastExit: number | null
  /** `claude` typed in a shell tab */
  claudeRunning: boolean
  /** derived Claude session state (main's SessionTracker) */
  session?: SessionState
  attention?: Attention | null
  // file tabs
  fileKind?: 'text' | 'image' | 'other'
  dirty?: boolean
  /** the file changed on disk while there were unsaved edits */
  changedOnDisk?: boolean
  imageUrl?: string
  error?: string
  /** markdown files: code | split | preview */
  mdMode?: 'code' | 'split' | 'preview'
  /** diff tabs */
  diff?: { original?: string; modified?: string; unified?: string; language?: string }
}

export const isClaude = (t: Tab) => t.kind === 'claude' || t.claudeRunning

export interface Project {
  id: string
  root: string | null
  tabs: Tab[]
  currentTabId: string | null
  selectedPath: string | null
  selectedFolder: string
}

export type LeftActivity = 'explorer' | 'search' | 'history' | 'skills' | 'mcp' | 'plugins' | 'run' | (string & {})
export type RightActivity = 'claude' | 'process' | 'history' | 'skills' | (string & {})

interface Workbench {
  theme: ResolvedTheme | null
  settings: Settings | null
  projects: Project[]
  activeProjectId: string | null
  /** last Claude tab shown per project: the session block keeps following it */
  lastClaudeTab: Record<string, string>
  sessionMode: 'plan' | 'activity' | 'files' | (string & {})
  setSessionMode(m: 'plan' | 'activity' | 'files' | (string & {})): void
  showSettings: boolean
  setShowSettings(v: boolean): void
  leftActivity: LeftActivity | null
  rightActivity: RightActivity | null
  layout: Record<string, number | boolean>
  /** Updates a layout value; the settings file is written after a short delay (drags). */
  setLayout(key: string, value: number | boolean | ((prev: number) => number)): void

  init(): Promise<void>
  setLeft(a: LeftActivity | null): void
  setRight(a: RightActivity | null): void
  newProject(root?: string | null): Project
  setRoot(id: string, root: string): void
  closeProject(id: string): Promise<void>
  setActiveProject(id: string): void
  /** drag and drop of the project tabs (order kept in openProjects) and of the center tabs */
  moveProject(from: string, to: string, place: 'before' | 'after'): void
  moveTab(projectId: string, from: string, to: string, place: 'before' | 'after'): void
  select(projectId: string, path: string, isDir: boolean): void
  newTab(projectId: string, kind: TabKind, cwd?: string, resume?: string): Promise<void>
  /** types text into the current Claude tab of the project (opens one if needed) */
  insertPrompt(projectId: string, text: string): Promise<void>
  /** types escaped file paths into a terminal tab (the current one, else the Claude tab) */
  sendPaths(projectId: string, paths: string[], tabId?: string): Promise<void>
  captureScreen(projectId: string): Promise<void>
  /** runs a command in an idle shell tab of the project (or a new one), cd-ing first when needed */
  /** types commands into a shell tab (strings as is, argv arrays quoted for its shell), chained on success */
  runCommand(projectId: string, cwd: string, cmds: (string | string[])[], tab?: 'reuse' | 'new', run?: { id: string; label?: string }): Promise<void>
  closeTab(projectId: string, tabId: string): Promise<void>
  /** explorer rename / move: file tabs at or under `from` follow (unsaved edits kept) */
  pathMoved(from: string, to: string): Promise<void>
  /** explorer deletion: file tabs at or under a path close, except the ones with unsaved edits */
  pathsRemoved(paths: string[]): Promise<void>
  /** closes every file tab (terminals stay), except `keep` */
  closeFiles(projectId: string, keep?: string): Promise<void>
  setCurrentTab(projectId: string, tabId: string): void
  tabExited(ptyId: string, code: number): void
  /** "start;<cmd>" | "end;<exit>" from the shell hooks (OSC 7770) */
  shellEvent(tabId: string, msg: string): void
  clearAttention(tabId: string): void
  /** opens a text or image file in the center (anything else goes to the default app) */
  /** opens (or shows) a file tab; `line`: 1-based line to reveal and put the cursor on */
  openFile(projectId: string, path: string, line?: number): Promise<void>
  reloadFile(path: string): Promise<void>
  saveCurrentFile(): Promise<void>
  saveFile(path: string): Promise<void>
  setFileDirty(path: string, dirty: boolean): void
  setMdMode(tabId: string, mode: 'code' | 'split' | 'preview'): void
  openDiff(projectId: string, req: { title: string; path?: string; original?: string; modified?: string; unified?: string }): void
  autoSaveAll(): Promise<void>
  /** tells main which tab is in front and clears its attention */
  visibleChanged(): void
  setCwd(tabId: string, cwd: string): void
}

let seq = 0
const nid = () => 'p' + ++seq
const name = (root: string | null) => (root ? root.split(/[\\/]/).filter(Boolean).pop() ?? root : t('Nouveau projet'))

export const useWorkbench = create<Workbench>((set, get) => ({
  theme: null,
  settings: null,
  projects: [],
  activeProjectId: null,
  lastClaudeTab: {},
  sessionMode: 'plan',
  setSessionMode(m) { set({ sessionMode: m }) },
  showSettings: false,
  setShowSettings(v) { set({ showSettings: v }) },
  leftActivity: 'explorer',
  rightActivity: null,
  layout: {},

  async init() {
    const [theme, settings] = await Promise.all([window.ct.themes.current(), window.ct.settings.get()])
    const projects: Project[] = []
    for (const root of settings.openProjects) {
      if (await window.ct.fs.exists(root)) projects.push({ id: nid(), root, tabs: [], currentTabId: null, selectedPath: null, selectedFolder: root })
    }
    if (projects.length === 0) projects.push({ id: nid(), root: null, tabs: [], currentTabId: null, selectedPath: null, selectedFolder: window.ct.home })
    // the Lanceur plugin became the Exécuter panel (2026-09-28)
    const left = settings.leftActivity === 'claudeterm.runnables:run' ? 'run' : settings.leftActivity
    set({ theme, settings, projects, activeProjectId: projects[0].id, leftActivity: left as LeftActivity | null, rightActivity: settings.rightActivity as RightActivity | null, layout: settings.layout ?? {} })
    window.ct.themes.onChange((theme) => set({ theme }))
    window.ct.settings.onChange((settings) => set({ settings }))
    window.ct.claude.onUpdate(({ tabId, state, newEvents }) => {
      // the session's title once it has one; until then the tab keeps its folder name
      patchTab(set, tabId, () => ({ session: state, ...(state.title ? { title: state.title } : {}) }))
      if (newEvents.length) get().clearAttention(tabId)
    })
    window.ct.claude.onAttention(({ tabId, attention }) => patchTab(set, tabId, () => ({ attention })))
    window.ct.claude.onFocusTab((tabId) => {
      const p = get().projects.find((x) => x.tabs.some((t) => t.id === tabId))
      if (p) { set({ activeProjectId: p.id }); get().setCurrentTab(p.id, tabId) }
    })
    window.addEventListener('focus', () => get().visibleChanged())
    window.addEventListener('blur', () => get().autoSaveAll())
    window.ct.fs.onChanged((path) => {
      const tabs = get().projects.flatMap((p) => p.tabs).filter((t) => t.kind === 'file' && t.path === path)
      if (!tabs.length) return
      if (tabs.some((t) => t.dirty)) set((s) => ({ projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.kind === 'file' && t.path === path ? { ...t, changedOnDisk: true } : t)) })) }))
      else get().reloadFile(path)
    })
  },

  setLeft(a) { set({ leftActivity: a }); window.ct.settings.set({ leftActivity: a }) },
  setRight(a) { set({ rightActivity: a }); window.ct.settings.set({ rightActivity: a }) },
  setLayout(key, value) {
    set((s) => {
      const prev = s.layout[key]
      const next = typeof value === 'function' ? value(typeof prev === 'number' ? prev : 0) : value
      return { layout: { ...s.layout, [key]: next } }
    })
    scheduleLayoutSave(get)
  },

  newProject(root = null) {
    const p: Project = { id: nid(), root, tabs: [], currentTabId: null, selectedPath: null, selectedFolder: root ?? window.ct.home }
    set((s) => ({ projects: [...s.projects, p], activeProjectId: p.id }))
    persistProjects(get)
    return p
  },
  setRoot(id, root) {
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, root, selectedFolder: root, selectedPath: null } : p)) }))
    persistProjects(get)
    const st = get().settings
    if (st) window.ct.settings.set({ recentProjects: [root, ...st.recentProjects.filter((r) => r !== root)].slice(0, 15) })
  },
  async closeProject(id) {
    const p = get().projects.find((x) => x.id === id)
    // tab by tab: unsaved files are confirmed (cancel keeps the project open), trackers, watchers and terminals released
    for (const t of p?.tabs ?? []) {
      await get().closeTab(id, t.id)
      if (get().projects.find((x) => x.id === id)?.tabs.some((y) => y.id === t.id)) return
    }
    set((s) => {
      const projects = s.projects.filter((x) => x.id !== id)
      const active = s.activeProjectId === id ? projects[0]?.id ?? null : s.activeProjectId
      return { projects, activeProjectId: active }
    })
    if (get().projects.length === 0) get().newProject(null)
    persistProjects(get)
  },
  setActiveProject(id) { set({ activeProjectId: id }); get().visibleChanged() },
  moveProject(from, to, place) { set((s) => ({ projects: reorder(s.projects, (p) => p.id, from, to, place) })); persistProjects(get) },
  moveTab(projectId, from, to, place) { set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, tabs: reorder(p.tabs, (t) => t.id, from, to, place) } : p)) })) },

  select(projectId, path, isDir) {
    const folder = isDir ? path : path.replace(/[\\/][^\\/]*$/, '')
    set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, selectedPath: path, selectedFolder: folder } : p)) }))
  },

  async newTab(projectId, kind, cwd, resume) {
    const p = get().projects.find((x) => x.id === projectId)
    if (!p) return
    const dir = cwd ?? p.selectedFolder
    const { id: ptyId, error } = await window.ct.pty.create({ cwd: dir, kind, projectRoot: p.root ?? undefined, resume })
    const tab: Tab = { id: 't' + ++seq, kind, title: name(dir), cwd: dir, ptyId, alive: !error, busy: false, lastCommand: '', lastExit: null, claudeRunning: false }
    if (error) tab.title += ' (erreur)'
    set((s) => ({ projects: s.projects.map((x) => (x.id === projectId ? { ...x, tabs: [...x.tabs, tab], currentTabId: tab.id } : x)), lastClaudeTab: kind === 'claude' ? { ...s.lastClaudeTab, [projectId]: tab.id } : s.lastClaudeTab }))
    if (error) console.error(error)
    else if (kind === 'claude') window.ct.claude.track(tab.id, dir, resume ? { resume } : undefined)
    get().visibleChanged()
  },
  async sendPaths(projectId, paths, tabId) {
    if (!paths.length) return
    const p = get().projects.find((x) => x.id === projectId)
    const t = p?.tabs.find((x) => x.id === (tabId ?? p.currentTabId))
    if (t?.ptyId && t.kind !== 'file' && t.alive) {
      window.ct.pty.write(t.ptyId, pathsForPrompt(paths, window.ct.platform === 'win32'))
      ;(await import('@/terminal/TerminalView')).focusTerminal(t.id)
    } else await get().insertPrompt(projectId, pathsForPrompt(paths, window.ct.platform === 'win32'))
  },
  async runCommand(projectId, cwd, cmds, tab = 'reuse', run) {
    const p = get().projects.find((x) => x.id === projectId)
    if (!p) return
    // a tab waiting for a plugin's command to start is not free either (two ▶ in a row)
    const free = (x: Tab) => x.kind === 'shell' && x.alive && !x.busy && !x.claudeRunning && !x.run
    let target = tab === 'reuse' ? (p.tabs.find((x) => x.id === p.currentTabId && free(x)) ?? p.tabs.find(free)) : undefined
    if (!target) {
      await get().newTab(projectId, 'shell', cwd)
      await new Promise((r) => setTimeout(r, 700))
      target = get().projects.find((x) => x.id === projectId)?.tabs.at(-1)
    }
    if (!target?.ptyId) return
    get().setCurrentTab(projectId, target.id)
    const s = get().settings
    const dialect = dialectFor(window.ct.platform, s?.windowsMode ?? 'native')
    const line = commandLine(dialect, cmds, target.cwd === cwd ? undefined : cwd)
    if (run) patchTab(set, target.id, () => ({ run: { id: run.id, label: run.label, started: false, at: Date.now() } }))
    window.ct.pty.write(target.ptyId, clearLine(dialect) + line + '\r')
    ;(await import('@/terminal/TerminalView')).focusTerminal(target.id)
  },
  async captureScreen(projectId) {
    const p = await window.ct.attachments.captureScreen()
    if (p) get().sendPaths(projectId, [p])
  },
  async insertPrompt(projectId, text) {
    const p = get().projects.find((x) => x.id === projectId)
    if (!p) return
    let t = p.tabs.find((x) => x.id === p.currentTabId && isClaude(x) && x.alive) ?? p.tabs.find((x) => isClaude(x) && x.alive)
    if (!t) { await get().newTab(projectId, 'claude'); await new Promise((r) => setTimeout(r, 1500)); t = get().projects.find((x) => x.id === projectId)?.tabs.at(-1) }
    if (!t?.ptyId) return
    get().setCurrentTab(projectId, t.id)
    window.ct.pty.write(t.ptyId, text)
    ;(await import('@/terminal/TerminalView')).focusTerminal(t.id)
  },
  async closeTab(projectId, tabId) {
    const p = get().projects.find((x) => x.id === projectId)
    const t = p?.tabs.find((x) => x.id === tabId)
    if (t?.kind === 'file' && t.path) {
      if (t.dirty) {
        const r = await window.ct.app.confirmSave(t.title)
        if (r === 'cancel') return
        if (r === 'save') { get().setCurrentTab(projectId, tabId); await get().saveCurrentFile(); if (get().projects.find((x) => x.id === projectId)?.tabs.find((x) => x.id === tabId)?.dirty) return }
      }
      const stillOpen = get().projects.some((x) => x.tabs.some((y) => y.id !== tabId && y.kind === 'file' && y.path === t.path))
      if (!stillOpen) { window.ct.fs.unwatch(t.path); (await import('@/editor/EditorHost')).disposeFile(t.path) }
    }
    if (t?.ptyId) window.ct.pty.kill(t.ptyId)
    // xterm, its WebGL context, scrollback and pty listener (every close path goes through here)
    if (t && t.kind !== 'file' && t.kind !== 'diff') (await import('@/terminal/TerminalView')).disposeTerminal(tabId)
    window.ct.claude.untrack(tabId)
    set((s) => ({
      projects: s.projects.map((x) => {
        if (x.id !== projectId) return x
        const idx = x.tabs.findIndex((y) => y.id === tabId)
        const tabs = x.tabs.filter((y) => y.id !== tabId)
        const current = x.currentTabId === tabId ? tabs[Math.min(idx, tabs.length - 1)]?.id ?? null : x.currentTabId
        return { ...x, tabs, currentTabId: current }
      }),
    }))
  },
  async pathMoved(from, to) {
    const under = (p?: string) => !!p && (p === from || p.startsWith(from + '/') || p.startsWith(from + '\\'))
    const moved = [...new Set(get().projects.flatMap((p) => p.tabs.filter((t) => t.kind === 'file' && under(t.path)).map((t) => t.path!)))]
    const host = await import('@/editor/EditorHost')
    const map = new Map(moved.map((p) => [p, to + p.slice(from.length)]))
    for (const [a, b] of map) { window.ct.fs.unwatch(a); host.renameFile(a, b); window.ct.fs.watch(b) }
    set((s) => ({ projects: s.projects.map((p) => ({
      ...p,
      selectedPath: under(p.selectedPath ?? undefined) ? to + p.selectedPath!.slice(from.length) : p.selectedPath,
      tabs: p.tabs.map((t) => (t.kind === 'file' && map.has(t.path!) ? { ...t, path: map.get(t.path!)!, title: map.get(t.path!)!.split(/[\\/]/).pop()!, cwd: map.get(t.path!)!.replace(/[\\/][^\\/]*$/, '') } : t)),
    })) }))
  },
  async pathsRemoved(paths) {
    const under = (p?: string) => !!p && paths.some((r) => p === r || p.startsWith(r + '/') || p.startsWith(r + '\\'))
    for (const p of get().projects) for (const t of p.tabs) if (t.kind === 'file' && !t.dirty && under(t.path)) await get().closeTab(p.id, t.id)
    set((s) => ({ projects: s.projects.map((p) => (under(p.selectedPath ?? undefined) ? { ...p, selectedPath: null } : p)) }))
  },
  async closeFiles(projectId, keep) {
    const p = get().projects.find((x) => x.id === projectId)
    if (!p) return
    for (const t of p.tabs.filter((x) => x.kind === 'file' && x.id !== keep)) {
      await get().closeTab(projectId, t.id)
      if (get().projects.find((x) => x.id === projectId)?.tabs.some((x) => x.id === t.id)) return   // cancelled in the save dialog
    }
  },
  setCurrentTab(projectId, tabId) {
    get().autoSaveAll()
    set((s) => {
      const t = s.projects.find((p) => p.id === projectId)?.tabs.find((x) => x.id === tabId)
      return { projects: s.projects.map((x) => (x.id === projectId ? { ...x, currentTabId: tabId } : x)), lastClaudeTab: t && isClaude(t) ? { ...s.lastClaudeTab, [projectId]: tabId } : s.lastClaudeTab }
    })
    get().visibleChanged()
  },
  tabExited(ptyId, code) {
    set((s) => ({ projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.ptyId === ptyId ? { ...t, alive: false, exitCode: code, busy: false, claudeRunning: false, run: undefined } : t)) })) }))
  },
  shellEvent(tabId, msg) {
    const [kind, rest = ''] = msg.split(/;(.*)/s)
    patchTab(set, tabId, (t) => {
      if (kind === 'start') {
        const claude = isInteractiveClaude(rest)   // not `claude update`, `claude mcp …`
        if (claude) {
          const resume = rest.match(/(?:--resume|-r)\s+(\S+)/)?.[1]
          const reuse = /--continue|--resume|\s-c\b|\s-r\b/.test(rest)
          window.ct.claude.track(t.id, t.cwd, { resume, reuse })
          set((s) => ({ lastClaudeTab: { ...s.lastClaudeTab, [projectOf(s, t.id)]: t.id } }))
          return { busy: true, lastCommand: rest, lastExit: null, claudeRunning: true, session: undefined, ...(t.run ? { run: { ...t.run, started: true } } : {}) }
        }
        return { busy: true, lastCommand: rest, lastExit: null, ...(t.run ? { run: { ...t.run, started: true } } : {}) }
      }
      if (kind === 'end') {
        if (t.claudeRunning) window.ct.claude.untrack(t.id)
        window.ct.plugins.commandEnd({ command: t.lastCommand, exit: rest === '' ? null : +rest })
        // a plugin's command is over once it has run; one that never started (cancelled with ^C, a shell that does not
        // report it) goes at the next prompt too, except the prompt a new tab prints right after it opened
        const over = t.run && (t.run.started || Date.now() - t.run.at > 1500)
        return { busy: false, lastExit: rest === '' ? null : +rest, claudeRunning: false, title: name(t.cwd), ...(over ? { run: undefined } : {}) }
      }
      return {}
    })
  },
  async openFile(projectId, path, line) {
    const p = get().projects.find((x) => x.id === projectId)
    if (!p) return
    if (line) (await import('@/editor/EditorHost')).revealWhenShown(path, line)
    const existing = p.tabs.find((t) => t.kind === 'file' && t.path === path)
    if (existing) { get().setCurrentTab(projectId, existing.id); return }
    const r = await window.ct.fs.readFile(path)
    if (r.kind === 'other') { window.ct.app.openExternal(path); return }
    const tab: Tab = { id: 't' + ++seq, kind: 'file', title: path.split(/[\\/]/).pop() ?? path, cwd: path.replace(/[\\/][^\\/]*$/, ''), path, alive: true, busy: false, lastCommand: '', lastExit: null, claudeRunning: false, fileKind: r.kind, dirty: false, imageUrl: r.dataUrl, error: r.error }
    if (r.kind === 'text' && r.text !== undefined) (await import('@/editor/EditorHost')).setFileText(path, r.text)
    window.ct.fs.watch(path)
    set((s) => ({ projects: s.projects.map((x) => (x.id === projectId ? { ...x, tabs: [...x.tabs, tab], currentTabId: tab.id } : x)) }))
    get().visibleChanged()
  },
  async reloadFile(path) {
    const r = await window.ct.fs.readFile(path)
    const ed = await import('@/editor/EditorHost')
    if (r.kind === 'text' && r.text !== undefined) ed.setFileText(path, r.text)
    set((s) => ({ projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.kind === 'file' && t.path === path ? { ...t, dirty: false, changedOnDisk: false, imageUrl: r.dataUrl ?? t.imageUrl, error: r.error } : t)) })) }))
  },
  async saveCurrentFile() {
    const s = get()
    const p = s.projects.find((x) => x.id === s.activeProjectId)
    const t = p?.tabs.find((x) => x.id === p.currentTabId)
    if (t?.kind === 'file' && t.path) await get().saveFile(t.path)
  },
  async saveFile(path) {
    const tabs = get().projects.flatMap((p) => p.tabs).filter((t) => t.kind === 'file' && t.path === path && t.fileKind === 'text')
    if (!tabs.length) return
    const ed = await import('@/editor/EditorHost')
    if (get().settings?.formatOnSave) await ed.formatIfActive(path)
    const text = ed.fileText(path)
    if (text === null) return
    const r = await window.ct.fs.writeFile(path, text)
    set((s) => ({ projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.kind === 'file' && t.path === path ? (r.ok ? { ...t, dirty: false, changedOnDisk: false, error: undefined } : { ...t, error: r.error }) : t)) })) }))
    if (r.ok) { ed.markSaved(path); (await import('./problems')).useProblems.getState().soon() }
  },
  setMdMode(tabId, mode) { patchTab(set, tabId, () => ({ mdMode: mode })) },
  openDiff(projectId, req) {
    const tab: Tab = { id: 't' + ++seq, kind: 'diff', title: req.title, cwd: req.path?.replace(/[\\/][^\\/]*$/, '') ?? '', path: req.path, alive: true, busy: false, lastCommand: '', lastExit: null, claudeRunning: false,
      diff: { original: req.original, modified: req.modified, unified: req.unified, language: req.path ? undefined : 'diff' } }
    set((s) => ({ projects: s.projects.map((x) => (x.id === projectId ? { ...x, tabs: [...x.tabs.filter((t) => !(t.kind === 'diff' && t.title === req.title)), tab], currentTabId: tab.id } : x)) }))
    get().visibleChanged()
  },
  setFileDirty(path, dirty) {
    set((s) => ({ projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.kind === 'file' && t.path === path && t.dirty !== dirty ? { ...t, dirty } : t)) })) }))
  },
  /** auto save on focus loss: every dirty file, never over one that changed on disk meanwhile */
  async autoSaveAll() {
    if (!get().settings?.autoSave) return
    const dirty = get().projects.flatMap((p) => p.tabs).filter((t) => t.kind === 'file' && t.dirty && !t.changedOnDisk && t.path)
    for (const t of dirty) await get().saveFile(t.path!)
  },
  clearAttention(tabId) {
    const t = get().projects.flatMap((p) => p.tabs).find((x) => x.id === tabId)
    if (t?.attention) { patchTab(set, tabId, () => ({ attention: null })); window.ct.claude.clearAttention(tabId) }
  },
  visibleChanged() {
    const s = get()
    const p = s.projects.find((x) => x.id === s.activeProjectId)
    const id = p?.currentTabId ?? null
    window.ct.claude.visibleTab(id)
    if (id && document.hasFocus()) s.clearAttention(id)
  },
  setCwd(tabId, cwd) { patchTab(set, tabId, (t) => (t.cwd === cwd ? {} : { cwd, title: name(cwd) })) },
}))

function projectOf(s: Workbench, tabId: string): string {
  return s.projects.find((p) => p.tabs.some((t) => t.id === tabId))?.id ?? ''
}

function patchTab(set: (fn: (s: Workbench) => Partial<Workbench>) => void, tabId: string, patch: (t: Tab) => Partial<Tab>) {
  set((s) => ({ projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, ...patch(t) } : t)) })) }))
}

let layoutTimer: ReturnType<typeof setTimeout> | undefined
function scheduleLayoutSave(get: () => Workbench) {
  clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => window.ct.settings.set({ layout: get().layout }), 400)
}

function persistProjects(get: () => Workbench) {
  window.ct.settings.set({ openProjects: get().projects.map((p) => p.root).filter((r): r is string => !!r) })
}

export const useActiveProject = () => useWorkbench((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)

/** The Claude tab the session block shows: the current tab if it is Claude, else the last Claude tab used. */
export function sessionTab(s: Workbench, p: Project): Tab | null {
  const cur = p.tabs.find((t) => t.id === p.currentTabId)
  if (cur && isClaude(cur)) return cur
  const last = p.tabs.find((t) => t.id === s.lastClaudeTab[p.id])
  return last && isClaude(last) ? last : null
}
