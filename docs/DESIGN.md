# ClaudeTerm v2 — design

Cross-platform workbench for Claude Code (macOS, Windows, Linux). Electron, architecture
borrowed from VS Code (contribution points, isolated extension host, theme format), code of
our own. Successor of the native Swift v1 (`../claude-term`), whose knowledge of Claude Code's
files carries over. test

## 1. Goals

- Claude Code is the main feature: terminal on top, session intelligence (plan, activity,
  files touched, permissions waiting) around it, read from what Claude Code already writes.
- Custom, token-driven UI ("islands"), themes compatible with VS Code themes.
- Plugins in JS/TS with a real API, `claude.*` being the differentiator.
- One codebase, one team (Windows users included).

Non-goals for now: git panel, Jira, being a general-purpose editor (Monaco covers "read and
fix a file while Claude works"; LSP is a later option).

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron 44, electron-vite 5 | cross-platform, VS Code's own base |
| UI | React 19 + TypeScript, CSS variables for tokens | custom UI, live theming |
| Terminal | @xterm/xterm 6 + WebGL addon, node-pty 1.1 | VS Code's terminal, no latency issue |
| Editor | monaco-editor | VS Code's editor: TextMate-grade highlighting, themes, find, multi-cursor |
| State | zustand | small, no boilerplate |
| Tests | vitest | main-process services and pure logic |
| Packaging | electron-builder | dmg / nsis / AppImage |
| Claude | `claude` CLI in a pty; `@anthropic-ai/claude-agent-sdk` for headless runs (plugins) | same binary the user has |

## 3. Processes

```
main (Node)                      renderer (Chromium, sandboxed)          extension host (utilityProcess)
  window, menus                    workbench UI                            plugin runtime, one vm per plugin
  PtyService (node-pty)            xterm views                             API implementation (RPC to main)
  FsService (readdir, watch)       Monaco                                  permissions enforced in main
  ClaudeDataService                stores (zustand)
    transcripts, sessions-index,
    file-history, plans, hooks
  SettingsService (userData/settings.json)
  ThemeService (themes dir)
  ShellIntegration (OSC 7770)
```

Renderer ↔ main through a typed IPC contract (`src/shared/ipc.ts`), exposed by the preload as
`window.ct`. No Node in the renderer. Streams (pty data, transcript events) are push channels.

## 4. Layout

```
┌──┬────────────────┬──────────────────────────────────┬──────────────┬─┐
│A │ island: finder │ tabs: ✳ claude · zsh · a.json    │ island       │a│
│c │────────────────│ terminal / editor (top)          │ (process…)   │c│
│t │ island: links  │──────────────────────────────────│              │t│
│  │                │ session block (plan/activity/    │              │ │
│  │                │ files), collapsible              │              │ │
└───────────────────────────────────────────────────────────────────────┘
```

- **Chrome**: macOS `titleBarStyle: hiddenInset` (traffic lights kept), Windows/Linux
  `titleBarStyle: hidden` + `titleBarOverlay` (native caption buttons over our title strip).
  The top strip holds the project tabs and is the drag region. Menus: native menu bar on macOS,
  hidden on Windows (commands via palette and the ⋯ button), like VS Code's custom title bar.
- **Left activity bar** (44 px): Explorer (2 islands: Finder, Linked folders), Search,
  History (this project's sessions), Skills (project), MCP (project + personal), Plugins, **Exécuter** (⌘7). Everything
  project-bound is on the left. Exécuter (core since 2026-09-28, was the Lanceur plugin): header tabs, Scripts
  (`shared/runnables.ts`: npm scripts with workspaces, make targets, cargo, go, python, shell scripts; "En cours" with
  stop / show) and Tests (Vitest, Jest, pytest; results from the runs' machine reports kept in userData). The editor's gutter ▶ comes from `shared/run-lines.ts` (package.json scripts, Makefile
  targets, shell scripts, shell commands of Markdown code blocks) and runs through the same store. Errors (project's
  tsc / ESLint) and TODO are tabs of the center bottom block (`shared/problems.ts`, `services/problems.ts`). **Mémo**
  (no default shortcut): tabs Liens (name + URL, http / https / mailto only, opened in the browser) and Notes (Markdown
  notes in `userData/memo/<hash of root>/`, opened in the editor, and project files pinned there); links and pins in
  `userData/memo.json` by root, nothing in the project (`services/memo.ts`, `shared/memo.ts`). The right bar's Mémo
  lists every project's, read only. Click active = collapse. The left bar and sidebar are **project-bound**:
  hidden while the active project has no folder (welcome screen).
- **App settings**: gear button at the bottom of the right activity bar on every platform (the
  top-right corner belongs to the native caption buttons on Windows/Linux). Opens the Settings modal.
  Project tabs and the "+" are centered in the title strip.
- **Right activity bar** (28 px, secondary): Process, History (all sessions, no scope selector), Skills (personal + plugins). **Global**, not bound to a
  project: always visible and usable, welcome screen included.
- **Center**: tab bar (terminal + editor tabs interleaved), terminal/editor on top, session
  block below.
- **No status bar** (removed 2026-09-27): the current tab's state (attention, plan / permission
  mode, running command or exit code, tokens, unsaved file) sits in the center island header, right
  of the tabs. Plugin status items will go there too.
- **Welcome screen** (project without a folder): "Open a folder…" and the **recent projects** list
  (name, path, Claude sessions badge), one click opens. On first launch the recents of the Swift v1
  are imported from its preferences (macOS only).
- **Islands**: `--island-bg`, radius 8, gutter 8 over `--window-bg`, no border and no shadow
  (decided 2026-09-27: the background step is enough), shared header (icon, title, actions, ⓘ,
  collapse) separated from the content by a 1 px `--island-border` line.

## 5. Themes

Same model as VS Code where it matters, so their themes load as-is:
`{ id, name, type, colors: { "editor.background": …, "sideBar.background": …, "terminal.ansiRed": … },
tokenColors: [...] }`. Our own tokens (`island.*`, `activity.*`, `status.*`…) are derived from
VS Code keys when absent (`sideBar.background` → `island.bg`, `activityBar.*`, `statusBar.*`,
`tab.*`, `terminal.*`). Applied as CSS variables on `:root`; Monaco gets `tokenColors` through
`monaco.editor.defineTheme`; xterm gets `terminal.ansi*`.
Built-ins: ClaudeTerm Dark, ClaudeTerm Light. User themes in `userData/themes/`, plugin themes in
their folder. Follow-system pairing (dark/light) or fixed.

## 6. Settings

Center tab (⌘,), sections + search: Général, Apparence, Éditeur, Terminal, Claude Code
(`~/.claude/settings.json` form), Notifications, Plugins, Raccourcis, **Windows** (`claude`
location: native or WSL distro; in WSL mode the pty runs `wsl.exe -d <distro>` and `~/.claude`
is read through `\\wsl$\<distro>\home\<user>\.claude`).
Stored in `userData/settings.json` (which also keeps the workbench `layout`: sidebar widths, island
heights, collapsed states, so the app reopens as it was left); plugins declare a schema (`contributes.settings`) and the form
is generated.

## 7. Plugins

Host (2026-09-28, replaces the `vm` contexts of phase 5.0, which were no security boundary): **each plugin runs in
its own hidden sandboxed renderer** (Chromium sandbox, no Node, private in-memory session whose requests are all
cancelled, navigation and window.open denied). Its only door is `window.ctPlugin` (`resources/plugin-host/preload.js`):
sync / async calls to main, which identifies the caller by its webContents and checks each call
(`src/main/services/plugin-policy.ts`); `resources/plugin-host/bootstrap.js` rebuilds the `ctx` API
(`resources/plugins/claudeterm.d.ts`) on it and provides `require` for the plugin's own files. Disabling a plugin
destroys its window. Permissions for user plugins (built-ins are trusted): `process` = `process.exec` and
`terminal.run`; fs = its folder and the open project, `fs:home` = the home folder (symlinks resolved); `prompt` =
`claude.insertPrompt` (a paste into the project's Claude tab, Enter after it with `send`; a new tab waits until Claude has
drawn its input); `network` and `secrets` = nothing yet. Without permission: `workspace.selection()` (the editor's or the
shown terminal's selection, and the file shown; main asks the window) and `commands.set` / `onRun` (with
`contributes.commands`: palette entries, shortcuts the app's keymap does not already take; in a terminal Ctrl+letter
alone stays the shell's). `terminal.run` returns an id: the tab carries it until the command ends (shell integration),
`terminal.runs()` / `onDidChangeRuns` list the plugin's running commands, `terminal.stop(id)` sends Ctrl+C ("process"). Events reach the owning plugin only; a plugin can only set its own views and popovers. Views are namespaced `<pluginId>:<viewId>`. Activity entries contributed by plugins sit
after a separator line in the bar. Built-in plugin: **Git** (`resources/plugins/git`, decided 2026-09-27 with a zero-bug rule): no git logic of our
own, reads through porcelain v2 / log formats parsed by tested code, every write is a plain `git`
command typed into a visible shell tab (add, restore --staged, commit -m, checkout), nothing
destructive (no reset --hard, checkout -- file, push --force, clean).

Folder `userData/plugins/<id>/` with `plugin.json` (id, version, engine, activation,
permissions, contributes: commands, activity, views, status, menus, themes, settings) and
`main.js`. Runs in the extension host (one `vm` context per plugin, host in an Electron
`utilityProcess`). API namespaces on `ctx`: `commands`, `ui` (activity, view, status, notify,
confirm, prompt, menu), `views` (declarative: tree, list, table, detail, markdown, diff, form,
toolbar, empty, progress — rendered by the workbench), `workspace`, `terminal`, `process`,
`fetch`, `storage`, `secrets` (safeStorage/keychain), `settings`, `themes`, `claude`
(sessions, events: message/tool/file/plan/attention/start/stop, `prompt`, `run` headless via the
Agent SDK, skills/mcp registration), `events`. Typings shipped (`claudeterm.d.ts`).
Permissions declared and approved at enable time, enforced in main (network domain-scoped,
process, secrets, fs scope).
Webviews for plugin UI: postponed on purpose.
First plugins: **Thèmes** (built-in: list, preview, apply, import VS Code theme/marketplace URL)
and **Linear** (API key in secrets, GraphQL, "Mes issues", "Démarrer avec Claude").

### 7.1 Distribution and catalogue (decided 2026-09-27)

- Built-in plugins live in the app repo (`resources/plugins`); the others live in the **monorepo**
  `sunstan/claudeterm-plugins` (`plugins/<id>/`, decided 2026-10-10): anyone adds one by pull request (checked by
  its `validate` workflow, read before merging); on main its `release` workflow publishes each new version as a
  release `<id>@<version>` with a deterministic `.tgz` (`plugin.json` under one top folder) and writes `registry.json`.
  A plugin hosted elsewhere is not in the catalogue, but installs by URL.
- **Catalogue**: a `registry.json` fetched from `settings.pluginRegistry` (default: raw GitHub of
  `sunstan/claudeterm-plugins`, `main` branch; `https:`, `http://localhost` and `file:` accepted):
  `{ "version": 1, "plugins": [{ id, name, description, version, engine?, permissions, repo, url, sha256 }] }`.
  `engine` is the minimal app version (`">=2.0.0"` or `"2.0.0"`).
- **Install** (catalogue or URL), all in main (`services/plugin-store.ts`): download (≤ 20 MB) → sha256 check
  (catalogue: must match; URL: the computed hash is shown in the approval) → unpack into
  `userData/plugins/.staging` (regular files and folders only, no absolute / `..` paths, ≤ 50 MB, ≤ 2000 files)
  → manifest checks (valid, id / version equal to the entry, not a built-in id, engine satisfied, permissions
  ⊆ the entry's) → **permission approval** (native dialog from main listing the permissions) → swap into
  `userData/plugins/<id>` and activate without restart.
- **Approved permissions** are stored in `settings.pluginPermissions[id]`; a user plugin whose manifest asks for
  more than what was approved is not activated ("permissions à approuver", approve from the island).
  Built-ins are trusted.
- **Enable / disable**: `settings.disabledPlugins`; disabling runs the plugin's disposers and hides its
  contributions, no restart. **Update**: catalogue version newer than the installed one; same flow, the
  approval only asks again when permissions grow. **Uninstall**: confirm, deactivate, remove the folder
  (its storage file is kept).
- **Plugins island** (left, ⌘6): tabs Installés / Catalogue, refresh, install from URL.

## 8. Claude Code integration (ported from v1)

- Claude tab = pty running `claude` (or `claude --resume <id>`) in the project cwd.
- Tabs reopen at the next launch (`userData/workspace.json`, `services/workspace.ts`, `shared/workspace.ts`): Claude tabs
  with `--resume` of their session, shells in their folder with their last 1000 lines replayed greyed (`userData/scrollback`)
  and the command running at quit typed again (not run), files; diffs are not kept. They start when first shown.
- Transcript: `~/.claude/projects/<encoded cwd>/<session>.jsonl` tailed for messages, tool
  calls, files touched, tokens, plan mode, permission mode; encoding of the cwd is ASCII-only
  (`[^a-zA-Z0-9]` → `-`). Claimed transcripts: the one the `SessionStart` hook names for the tab, else the newest
  file created after the tab start.
- Files touched + diffs: `~/.claude/file-history/<session>` backups, and `toolUseResult.bashEditDiff`.
- Plans: `~/.claude/plans`. Sessions index: `sessions-index.json` (deletion allowed).
- Hooks `Notification`, `Stop` and `SessionStart` installed only from settings (an install that lacks an event is
  shown there as to update, never changed at start), spooling events into `userData/events`. Every terminal has `CLAUDETERM_TAB=<run>.<tab>`; the spool
  file is named after it, so an event reaches the tab its claude runs in (then: transcript path, cwd). SessionStart
  binds the tab to its session: `startup` only while it has none (a `claude -p` that Claude runs inherits the tab),
  `clear` / `resume` / `compact` move it to their transcript, which may not be written yet.
- Shell integration: OSC 7770 from a private zsh / bash rc (busy state, last command, exit code, OSC 7 cwd);
  on Windows a PowerShell script run after the user's profile (`-EncodedCommand`, `shared/powershell.ts`), and in WSL
  mode the same zsh / bash rc files reached through `WSLENV`. Linked folders are not passed to `claude` in WSL mode
  (their files carry Windows paths).
- Writes are limited to: `~/.claude/settings.json` (form; hooks; our `statusLine` on demand, never over a foreign
  one), `sessions-index.json`,
  `<project>/.mcp.json` (project MCP, meant to be shared). Linked folders are machine-specific, so they live in the
  app's data (`userData/projects.json`, launch files in `userData/projects/<key>/`) and reach Claude through
  `--settings` + `--append-system-prompt-file` at launch; nothing is written in the project (2026-09-28). MCP user scope goes
  through `claude mcp add|remove`, never `~/.claude.json`.

## 9. Phases

| Phase | Content | Result |
|---|---|---|
| 0 | scaffold, window chrome, islands, tokens + 2 themes, activity bars, status bar, settings store | empty but themed workbench |
| 1 | PtyService + xterm tabs (Claude / shell), project tabs, Finder island, shell integration | usable terminal for Claude |
| 2 | ClaudeDataService: transcript tailing, session block (plan / activity / files+diff), hooks, notifications | v1 parity on the Claude side |
| 3 | Monaco editor tabs, search island, MCP, skills, links, history, process | v1 parity (minus npm scripts) |
| 4 | settings UI, Windows/WSL mode, packaging (dmg, nsis) | team can install |
| 5 | extension host + API + views renderer + Plugins island + Thèmes plugin | plugins |
| 6 | Linear plugin, `claude.run` via Agent SDK | Claude-driven workflow |

## 10. Repository layout

```
src/main/        services (pty, fs, claude-data, settings, themes, shell-integration), window, menu, ipc
src/preload/     contextBridge → window.ct (typed)
src/renderer/    workbench/ (layout, activity bars, islands, status), terminal/, editor/, theme/, stores/, views/
src/shared/      ipc contract, types, claude formats (pure, tested)
src/host/        extension host (phase 5)
resources/       themes/, icons, shell integration scripts
docs/            this doc, API reference (phase 5)
```
