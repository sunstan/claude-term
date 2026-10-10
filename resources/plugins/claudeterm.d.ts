/**
 * ClaudeTerm plugin API. A plugin is a folder with plugin.json and main.js exporting activate(ctx) (optionally
 * deactivate()). It runs in a sandboxed browser context: no Node, no network, `require` only for its own .js files
 * (relative paths). Everything else goes through ctx, checked against the permissions of plugin.json:
 * - "process": process.exec and terminal.run
 * - fs (exists / read / list / watch, openFile): the plugin folder and the open project; "fs:home" widens it to the
 *   home folder. Absolute paths only.
 * - "prompt": claude.insertPrompt
 */
export interface ViewAction { id: string; title: string; icon?: string; primary?: boolean }
export interface ViewItem {
  id: string; label: string; detail?: string; extra?: string; icon?: string; color?: string
  /** file path → file-type icon; folder path → folder icon */
  file?: string; folder?: string
  badges?: string[]; actions?: ViewAction[]; contextMenu?: (ViewAction | 'sep')[]; children?: ViewItem[]; expanded?: boolean; checked?: boolean; muted?: boolean
}
export type ViewModel =
  | { kind: 'empty'; text: string }
  | { kind: 'list'; items: ViewItem[]; toolbar?: ViewAction[] }
  | { kind: 'tree'; items: ViewItem[]; toolbar?: ViewAction[] }
  | { kind: 'markdown'; text: string }
  | { kind: 'diff'; text: string }
export interface ViewEvent { viewId: string; type: 'select' | 'open' | 'action' | 'toolbar'; itemId?: string; actionId?: string }

export interface Context {
  plugin: { id: string; dir: string }
  workspace: {
    /** root folder of the active project, null on the welcome screen */
    readonly project: string | null
    onDidChangeProject(cb: (root: string | null) => void): () => void
    /** opens a file in an editor tab of the active project */
    openFile(path: string): void
    /**
     * What is selected in the tab shown (the editor or a terminal), and the file the editor shows (absolute path).
     * source null: nothing to read there (a diff, the welcome screen).
     */
    selection(): Promise<{ text: string; file: string | null; source: 'editor' | 'terminal' | null }>
    fs: {
      exists(path: string): boolean
      read(path: string): string
      list(path: string): { name: string; dir: boolean }[]
      /** non-recursive; cb gets the changed entry name when the OS reports it */
      watch(path: string, cb: (name?: string) => void): () => void
    }
  }
  ui: {
    /** a view declared in plugin.json (contributes.views[].id) */
    view(id: string): { set(model: ViewModel): void; onEvent(cb: (e: ViewEvent) => void): () => void }
    notify(title: string, body?: string): void
    /** modal text input; resolves null when cancelled */
    prompt(req: { title: string; placeholder?: string; options?: string[] }): Promise<string | null>
  }
  terminal: {
    /**
     * Types a command into a shell tab of the active project ('reuse' an idle one, or 'new'). `command` is typed as
     * is; `argv` commands are quoted for the tab's shell (zsh / bash / PowerShell) and chained: each one runs only
     * when the previous one succeeded. Prefer argv for anything built from user input.
     */
    run(req: { cwd: string; command?: string; argv?: string[][]; label?: string; tab?: 'reuse' | 'new' }): string
    /** commands this plugin started that are still running (started: the shell has begun running it) */
    runs(): { id: string; tabId: string; cwd: string; command: string; label?: string; started: boolean }[]
    onDidChangeRuns(cb: (runs: { id: string; tabId: string; cwd: string; command: string; label?: string; started: boolean }[]) => void): () => void
    /** Ctrl+C in the tab running it (requires "process"); show: brings its tab to the front */
    stop(id: string): void
    show(id: string): void
    /** a foreground command ended in a shell tab of the active project */
    onCommandEnd(cb: (info: { command: string; exit: number | null }) => void): () => void
  }
  /** requires the "prompt" permission */
  claude: {
    /**
     * Types `text` into the active project's Claude tab (the one shown, else the last used, else a new one once Claude
     * is ready) as one paste, several lines kept; `send` presses Enter after it, otherwise the user completes it.
     */
    insertPrompt(text: string, opts?: { send?: boolean }): void
  }
  /**
   * Commands in the palette (> mode), each with an optional shortcut ("Mod+Alt+P"; Mod is ⌘ on macOS, Ctrl elsewhere).
   * The app's own shortcuts come first; in a terminal, Ctrl+letter alone stays the shell's. plugin.json's
   * contributes.commands are listed too; `set` replaces the ones this plugin added before.
   */
  commands: {
    set(list: { id: string; title: string; shortcut?: string }[]): void
    onRun(cb: (id: string) => void): () => void
  }
  /** requires the "process" permission */
  process: { exec(file: string, args?: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> }
  settings: { get(key: string): unknown }
  storage: { get(key: string): unknown; set(key: string, value: unknown): void }
}
