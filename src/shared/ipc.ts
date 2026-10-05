/** Typed contract between renderer (`window.ct`) and main. */
import type { ThemeSpec, ResolvedTheme } from './theme'
import type { ToolEvent } from './claude-format'
import { DEFAULT_REGISTRY, type Catalogue } from './plugin-registry'
import type { UpdateState } from './update'
import type { UsageSnapshot } from './usage'
import type { ServiceStatus } from './claude-info'

export interface ClaudeInfo { version: string | null; latest: string | null; model: string | null; status?: ServiceStatus; error?: string }

export interface UsageState {
  /** our status line is declared in ~/.claude/settings.json; foreign: another one is (never replaced) */
  installed: boolean
  foreign?: string
  /** limits merged from the status line and the usage API (per limit, the most recent reading) */
  snapshot: UsageSnapshot | null
  /** subscription of the claude.ai login of Claude Code (from its credentials) */
  plan?: { subscription?: string; tier?: string }
  /** last usage API call: when it answered, or why it failed */
  /** at: last answer; attemptAt: last call, failed or not (the panel's throttle) */
  api?: { at?: number; attemptAt?: number; error?: string; busy?: boolean }
}
import type { RunInfo } from './plugins'
import type { RunGroup } from './runnables'
import type { TestNode, TestResult, TestSuite } from './tests'
import type { Diagnostic, Todo } from './problems'
import type { PluginInfo, ViewModel, ViewEvent, RunRequest, PromptRequest, PopoverRequest, DiffRequest } from './plugins'

export type TabKind = 'claude' | 'shell'

export interface PtyCreate {
  cwd: string
  kind: TabKind
  /** `claude --resume <id>` */
  resume?: string
  /** exported as CLAUDETERM_ROOT for the shell's `claude` wrapper */
  projectRoot?: string
}

/** Shell-integration and cwd events parsed from OSC sequences in the renderer. */
export const OSC_SHELL = 7770

/** Derived state of one Claude session, kept in main by the SessionTracker. */
export interface SessionState {
  sessionId?: string
  title?: string
  events: ToolEvent[]
  /** absolute path → number of accesses */
  files: Record<string, number>
  backups: Record<string, { name: string; version: number }>
  bashDiffs: Record<string, string[]>
  inputTokens: number
  outputTokens: number
  /** model of the last assistant message and context tokens at that point (transcript) */
  model?: string
  contextTokens?: number
  planPath?: string
  planText: string
  planMode: boolean
  permissionMode?: string
  runningTools: { id: string; name: string; detail: string }[]
}

/** What a Claude tab is waiting for, as reported by Claude Code hooks. */
export interface Attention { kind: 'permission' | 'idle' | 'done'; message: string }

export interface SessionInfo {
  id: string
  path: string
  title: string
  modified: number
  projectPath: string
  messageCount: number
  gitBranch: string
}

export interface PlanInfo { path: string; title: string; modified: number }

export interface LinkedProject { path: string; role: string; readOnly: boolean }

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'project' | 'linked' | 'personal' | 'plugin'
  isCommand: boolean
  manualOnly: boolean
  autoOnly: boolean
}

export interface MCPServer {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  headers: Record<string, string>
  scope: 'project' | 'linked' | 'local' | 'user' | 'claudeAI' | 'plugin'
  sourcePath: string
  disabled: boolean
  health?: 'unknown' | 'connected' | 'needsAuth' | 'failed'
}

export interface ClaudeProcess {
  pid: number
  started: number
  elapsed: string
  /** '' where the platform's table has none (Windows) */
  cpu: string
  memMB: number
  /** '?' where it cannot be read (Windows) */
  cwd: string
  command?: string
  /** the app's terminal it runs in (its shell or itself is that pty's process); absent: started elsewhere */
  ptyId?: string
  children: { pid: number; command: string; cpu: string }[]
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
}

export interface Settings {
  language: 'system' | 'fr' | 'en'
  themeFollowSystem: boolean
  themeDark: string
  themeLight: string
  themeFixed: string
  /** terminal font (empty = default mono stack) */
  fontFamily: string
  fontSize: number
  /** editor font, independent from the terminal */
  editorFontFamily: string
  editorFontSize: number
  editorLineHeight: number
  editorWordWrap: boolean
  editorMinimap: boolean
  /** editor: save dirty files when the editor loses focus (tab switch, window blur) */
  autoSave: boolean
  /** editor: run the formatter before writing a file */
  formatOnSave: boolean
  /** defaults the shortcuts start from (shared/keymap) */
  keymapPreset: 'jetbrains' | 'vscode'
  /** shortcut overrides by action id, over the preset's defaults */
  keybindings: Record<string, string>
  openProjects: string[]
  recentProjects: string[]
  leftActivity: string | null
  rightActivity: string | null
  /** sizes (px) and collapsed flags of the workbench, by element id */
  layout: Record<string, number | boolean>
  /** OS notifications when the tab is not visible */
  notifyOS: boolean
  dockBadge: boolean
  /** Windows: run claude natively or inside WSL */
  windowsMode: 'native' | 'wsl'
  wslDistro: string
  /** plugin catalogue (registry.json) */
  pluginRegistry: string
  /** plugin ids turned off by the user (built-ins included) */
  disabledPlugins: string[]
  /** permissions approved per user plugin */
  pluginPermissions: Record<string, string[]>
  /** check the GitHub releases at startup and every 6 h, download in the background */
  autoUpdate: boolean
  /** open / closed nodes of plugin trees chosen by the user, by view id then item id */
  treeState: Record<string, Record<string, boolean>>
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'system',
  themeFollowSystem: true,
  themeDark: 'claudeterm-dark',
  themeLight: 'claudeterm-light',
  themeFixed: 'claudeterm-dark',
  fontFamily: '',
  fontSize: 13,
  editorFontFamily: '',
  editorFontSize: 13,
  editorLineHeight: 0,
  editorWordWrap: false,
  editorMinimap: false,
  autoSave: true,
  formatOnSave: false,
  keymapPreset: 'jetbrains',
  keybindings: {},
  openProjects: [],
  recentProjects: [],
  leftActivity: 'explorer',
  rightActivity: null,
  layout: {},
  notifyOS: true,
  dockBadge: true,
  windowsMode: 'native',
  wslDistro: '',
  pluginRegistry: DEFAULT_REGISTRY,
  disabledPlugins: [],
  pluginPermissions: {},
  autoUpdate: true,
  treeState: {},
}

export type FileOpResult = { ok: true; path: string } | { ok: false; error: string }

export interface CtApi {
  platform: NodeJS.Platform
  /** test hooks (window.__ct…) enabled: dev, or CT_CDP_PORT set on a packaged app */
  debug: boolean
  home: string
  pty: {
    create(opts: PtyCreate): Promise<{ id: string; error?: string }>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(id: string, cb: (data: string) => void): () => void
    onExit(id: string, cb: (code: number) => void): () => void
  }
  fs: {
    readdir(path: string): Promise<DirEntry[]>
    exists(path: string): Promise<boolean>
    /** editor: kind by content; text or image data URL */
    readFile(path: string): Promise<{ kind: 'text' | 'image' | 'other'; text?: string; dataUrl?: string; error?: string }>
    writeFile(path: string, text: string): Promise<{ ok: boolean; error?: string }>
    watch(path: string): void
    unwatch(path: string): void
    onChanged(cb: (path: string) => void): () => void
    /** explorer: a shown folder's entries changed (debounced, not recursive) */
    watchDir(dir: string): void
    unwatchDir(dir: string): void
    onDirChanged(cb: (dir: string) => void): () => void
    /** never overwrite: a taken name is refused, a copy gets "name copie" */
    create(dir: string, name: string, folder: boolean): Promise<FileOpResult>
    rename(path: string, name: string): Promise<FileOpResult>
    /** copy (or move) into the folder `dest` */
    transfer(paths: string[], dest: string, move: boolean): Promise<FileOpResult[]>
    /** to the Trash after a confirmation dialog; false when cancelled */
    trash(paths: string[]): Promise<boolean>
  }
  themes: {
    list(): Promise<ThemeSpec[]>
    current(): Promise<ResolvedTheme>
    onChange(cb: (t: ResolvedTheme) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onChange(cb: (s: Settings) => void): () => void
  }
  claude: {
    /** Follows the Claude session of a tab (claude tab, or `claude` typed in a shell). */
    track(tabId: string, cwd: string, opts?: { resume?: string; reuse?: boolean }): void
    untrack(tabId: string): void
    onUpdate(cb: (u: { tabId: string; state: SessionState; newEvents: ToolEvent[] }) => void): () => void
    setPlan(tabId: string, path: string | null): void
    plans(): Promise<PlanInfo[]>
    sessions(cwd: string): Promise<SessionInfo[]>
    allSessions(): Promise<SessionInfo[]>
    hasSessions(cwd: string): Promise<boolean>
    deleteSession(s: SessionInfo): Promise<void>
    sessionDiff(path: string, backupName: string | null, sessionId: string): Promise<string>
    readText(path: string): Promise<string>
    onAttention(cb: (u: { tabId: string; attention: Attention | null }) => void): () => void
    clearAttention(tabId: string): void
    /** the tab currently visible (for notification and attention decisions) */
    visibleTab(tabId: string | null): void
    onFocusTab(cb: (tabId: string) => void): () => void
    hooksInstalled(): Promise<boolean>
    setHooksInstalled(on: boolean): Promise<{ ok: boolean; error?: string }>
  }
  setHooks(on: boolean): Promise<{ ok: boolean; error?: string }>
  /** ~/.claude/settings.json as an object (form); unknown keys preserved on write */
  claudeSettings: {
    read(): Promise<{ ok: true; data: Record<string, any>; path: string } | { ok: false; error: string; path: string }>
    write(data: Record<string, any>): Promise<{ ok: boolean; error?: string }>
  }
  links: {
    load(root: string): Promise<LinkedProject[]>
    save(root: string, links: LinkedProject[]): Promise<{ ok: boolean; error?: string }>
  }
  skills: {
    project(root: string): Promise<SkillInfo[]>
    linked(root: string): Promise<SkillInfo[]>
    personal(): Promise<SkillInfo[]>
    plugins(): Promise<SkillInfo[]>
    create(name: string, description: string, root: string | null): Promise<{ ok: boolean; path?: string; error?: string }>
    remove(s: SkillInfo): Promise<{ ok: boolean; error?: string }>
  }
  mcp: {
    project(root: string): Promise<MCPServer[]>
    linked(root: string): Promise<MCPServer[]>
    user(): Promise<MCPServer[]>
    local(root: string): Promise<MCPServer[]>
    library(root: string | null): Promise<MCPServer[]>
    write(server: MCPServer, root: string, replacing?: string): Promise<{ ok: boolean; error?: string }>
    remove(name: string, root: string): Promise<{ ok: boolean; error?: string }>
    cli(args: string[], cwd: string | null): Promise<{ code: number; output: string }>
    /** `claude mcp list` parsed: name → health */
    health(cwd: string | null): Promise<Record<string, 'connected' | 'needsAuth' | 'failed'>>
  }
  runnables: {
    /** what the project can run (Scripts tab), and a change of its root folder */
    detect(root: string): Promise<RunGroup[]>
    onChanged(cb: (root: string) => void): () => void
  }
  tests: {
    /** suites of the project (Vitest, Jest, pytest) with their files and tests; report: where runs write their results */
    discover(root: string): Promise<(TestSuite & { report: string; files: { path: string; tests: TestNode[] }[] })[]>
    /** results of the last reports, by testKey */
    results(): Promise<[string, TestResult][]>
    onResults(cb: (r: [string, TestResult][]) => void): () => void
  }
  problems: {
    /** the project's tsc / ESLint in the background (one check at a time) */
    check(root: string): Promise<{ at: number; diagnostics: Diagnostic[]; tools: { tool: 'tsc' | 'eslint'; dir: string; config?: string; ok: boolean; error?: string }[] }>
    todos(root: string): Promise<Todo[]>
  }
  processes: {
    scan(): Promise<ClaudeProcess[]>
    kill(pid: number, signal?: 'SIGTERM' | 'SIGKILL'): void
  }
  search: {
    files(root: string, query: string): Promise<string[]>
  }
  plugins: {
    list(): Promise<PluginInfo[]>
    onChanged(cb: (list: PluginInfo[]) => void): () => void
    /** registry.json from settings.pluginRegistry, merged with the installed plugins (refresh: skip the cache) */
    catalogue(refresh?: boolean): Promise<Catalogue>
    /** download, verify, approve (native dialog), unpack and activate */
    install(src: { id: string } | { url: string }): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>
    uninstall(id: string): Promise<{ ok: boolean; error?: string }>
    setEnabled(id: string, enabled: boolean): Promise<void>
    /** approves the pending permissions of a plugin (native dialog) */
    approve(id: string): Promise<boolean>
    view(viewId: string): Promise<ViewModel | null>
    onView(cb: (u: { viewId: string; model: ViewModel }) => void): () => void
    event(e: ViewEvent): void
    onRun(cb: (r: RunRequest) => void): () => void
    onNotify(cb: (n: { title: string; body?: string }) => void): () => void
    /** tells the host which project root is active */
    projectChanged(root: string | null): void
    commandEnd(info: { command: string; exit: number | null }): void
    /** commands started by plugins that are still running (tabs with a run) */
    runs(list: RunInfo[]): void
    onStopRun(cb: (id: string) => void): () => void
    onShowRun(cb: (id: string) => void): () => void
    onPrompt(cb: (r: PromptRequest) => void): () => void
    promptReply(id: number, value: string | null): void
    onOpenFile(cb: (path: string) => void): () => void
    onOpenDiff(cb: (r: DiffRequest) => void): () => void
    onPopover(cb: (r: PopoverRequest) => void): () => void
    onPopoverClose(cb: (id: string) => void): () => void
  }
  attachments: {
    /** absolute path of a dropped File (Electron webUtils) */
    pathForFile(file: File): string
    saveDataUrl(dataUrl: string): Promise<string | null>
    clipboardImage(): Promise<string | null>
    captureScreen(): Promise<string | null>
  }
  usage: {
    state(): Promise<UsageState>
    onChanged(cb: (s: UsageState) => void): () => void
    /** declares / removes our status line in ~/.claude/settings.json (never a foreign one) */
    install(on: boolean): Promise<{ ok: boolean; error?: string }>
    /** asks the usage API of /usage with Claude Code's login (on demand) */
    refresh(): Promise<UsageState>
    /** version, default model, latest published Claude Code, Anthropic status (refresh: skip the caches) */
    claude(refresh?: boolean): Promise<ClaudeInfo>
    /** `/model <alias>` in a Claude tab, keeping the default model of ~/.claude/settings.json */
    switchModel(ptyId: string, alias: string): Promise<void>
    /** default model of new sessions (~/.claude/settings.json `model`; null: the account's) */
    defaultModel(): Promise<string | null>
    setDefaultModel(model: string | null): Promise<{ ok: boolean; error?: string }>
  }
  update: {
    state(): Promise<UpdateState>
    onState(cb: (s: UpdateState) => void): () => void
    check(): Promise<UpdateState>
    /** quits, installs the downloaded version and reopens the app */
    install(): void
  }
  app: {
    /** "Enregistrer" | "Ne pas enregistrer" | "Annuler" → 'save' | 'discard' | 'cancel' */
    confirmSave(name: string): Promise<'save' | 'discard' | 'cancel'>
    pickFolder(): Promise<string | null>
    openExternal(path: string): void
    /** an https link in the default browser */
    openUrl(url: string): void
    /** Windows taskbar overlay (the count of tabs waiting, drawn by the renderer as a PNG data URL); null clears it */
    setOverlay(dataUrl: string | null, label: string): void
    revealInFinder(path: string): void
    /** macOS Quick Look (no-op elsewhere) */
    quickLook(path: string): void
  }
}
