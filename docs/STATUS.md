# ClaudeTerm v2 — status (2026-09-27)

Handoff for the next session. Design: `docs/DESIGN.md`. Working rules: `CLAUDE.md`.

## Done

- **Workbench**: Electron + React + TS; islands UI (no borders), activity bars (left = project, right = global,
  38 px column, first icon aligned on the island header), centered project tabs, no status bar (tab state in the
  center header), resizable everything persisted in `settings.json > layout`.
- **Themes**: VS Code format + own tokens, one hue per theme (lightness only varies), ClaudeTerm Dark / Light,
  single selector (follow system or a theme).
- **Terminal**: node-pty + xterm (WebGL), Claude / shell tabs, shell integration (OSC 7770 busy/exit, OSC 7 cwd),
  claude from the login-shell PATH, WSL mode prepared. Integration for zsh / bash (rc files), PowerShell 5.1 / 7
  (`shared/powershell.ts`: a script after the user's profile through `-EncodedCommand`, wrapping `prompt` and
  `PSConsoleHostReadLine`; Ctrl+Shift+F12 bound to RevertLine clears the pending line) and WSL (the account's
  zsh / bash on the same rc files, folder passed through WSLENV). Checked through ConPTY on Windows 11.
- **Claude**: transcript tracking, session block (Plan / Activité / Fichiers with per-session diffs), hooks
  (Notification, Stop) → attention, OS notifications, dock badge; attachments (drop, ⌘V image, ⌥⌘S capture).
  Windows: capture through the Snipping Tool (`SNIP_SCRIPT`: waits on the clipboard sequence number, never reads
  or clears the clipboard), taskbar overlay with the count of tabs waiting (drawn by `renderer/taskbar.ts`) and
  flashing until the window has the focus (Linux: flashing).
  Session binding through the hooks (SessionStart, `CLAUDETERM_TAB`), tab state from Claude's terminal title (working
  pulse, done when a turn ends out of sight), effort in the bubble, tab rename. Activité: an entry opens in full (tool
  input and result, or the text, read from the transcript on demand by `ref`), Agent / Task calls open the sub-agent's
  activity (`<session>/subagents/agent-<id>.jsonl`, breadcrumb back; its writes count in Fichiers). Details are streamed
  from the transcript (the read stops at the entry).
- **Editor**: Monaco tabs, dirty by content, auto save on focus loss, confirm on close, reload on external change,
  images, markdown code / split / preview (floating switch, moves under the find bar), JetBrains-like find /
  replace bar (⌘F / ⌘R), side-by-side diff tabs, separate editor fonts, format on save option.
- **Islands**: explorer + linked folders, search (Noms: file names, Contenu: ripgrep through `@vscode/ripgrep`'s per-platform package, unpacked from the asar; case / word / regex, include / exclude globs, .gitignore followed, grouped by file), project history (left) / all history (right),
  skills (project / personal / plugins), MCP (project / user), Claude processes.
- **Command palette** (`workbench/Palette.tsx`, `shared/palette.ts`): files, `>` commands (app actions, panels, plugin panels, with
  their shortcuts), `@` sessions (resume), `/` skills (typed into the Claude tab); Aller au fichier / Commandes (⇧⌘O, ⇧⌘A;
  VS Code: ⌘P, ⇧⌘P). Menus and tooltips show the shortcuts the keymap has (`withShortcut`).
- **Settings modal**: Général (language fr/en/system), Apparence, Éditeur, Raccourcis (JetBrains or VS Code preset,
  recorder, conflicts, reset), Terminal, Claude Code (`~/.claude/settings.json` form), Notifications, Windows.
- **Shortcuts in terminals**: xterm hands the app's shortcuts over (custom key handler → window listener); on Windows /
  Linux Ctrl+letter alone stays the shell's (`terminalSafe`), AltGr is never a shortcut. Ctrl+C copies a selection,
  Ctrl+Shift+V pastes, Ctrl+V in a Windows Claude tab pastes text (bracketed) or sends Alt+V for an image.
- **Icons**: Catppuccin (MIT) Mocha/Latte, lavender neutrals recolored to the theme grey; Lucide for UI icons.
- **Plugins**: host in main (vm per plugin), declarative views (list, tree, markdown, diff, stack, detail, graph,
  checkboxes, footer, context menus, search, popover, bottom placement), API typings `resources/plugins/claudeterm.d.ts`.
  - **Lanceur**: npm (workspaces), make, cargo, go, python, shell scripts.
  - **Git**: checkbox commit panel (group by directory), branches (menu: switch, new from, diff, pull, push, rename,
    safe delete), branch popover, commits in the bottom block with graph + files + details, diff tabs. Every write
    is a visible `git` command, nothing destructive. Parsers, model and graph at **100 % coverage** (`npm run test:git`).
- **Plugin catalogue** (DESIGN.md §7.1): `registry.json` from `settings.pluginRegistry` (Réglages > Plugins),
  Plugins island with Installés / Catalogue tabs, install with sha256 check + native permission approval,
  install from a .tgz URL, update (asks again only when permissions grow), enable / disable and uninstall
  without restart, approval of pending permissions. `services/tar.ts` (safe .tgz reader), `services/plugin-store.ts`,
  `shared/plugin-registry.ts`, tests in `tests/plugin-store.test.ts`. Checked end to end with a local `file:` catalogue.
- **Packaging**: electron-builder (dmg / nsis / AppImage), GitHub Actions workflow, `CT_CDP_PORT` test hooks.
- **Terminal bubble** (top right of a terminal, like the markdown modes): shell = running command or exit code;
  Claude = attention, permission / plan mode, running tools, model (menu: `/model <alias>` typed in the tab, the
  default of ~/.claude/settings.json put back since Claude Code saves it), context % (status line figure per session,
  else ≈ from the transcript), tokens. The island header keeps only the file state.
- **Exécuter panel** (core, ⌘7; the Lanceur plugin was removed 2026-09-28, its activity and open state migrated):
  header tabs, Scripts (`shared/runnables.ts`), "En cours" with stop (Ctrl+C) / show, store `stores/runnables.ts`.
  Editor gutter ▶ / ■ on every runnable line (`shared/run-lines.ts`: package.json scripts, Makefile targets, shell
  scripts, shell commands of Markdown code blocks), through the same store. **Tests tab**: Vitest / Jest / pytest
  suites per package (`shared/tests.ts`: detection, tests read from the files, commands, JSON / JUnit reports;
  `services/tests.ts`: discovery, reports in userData watched), run all / file / test in a shell tab, statuses, failures
  count on the tab, "Corriger avec Claude" (prompt typed in the Claude tab, not sent), ▶ in test files' gutter (red when
  the last run failed).
- **Errors / TODO** (tabs of the center bottom block, after the session tabs): the project's own tsc (each tsconfig
  that compiles) and ESLint (when configured), found in node_modules/.bin, run in the background (`services/problems.ts`,
  one check at a time, each request gets its own project), on project open, save and end of a Claude turn; markers in
  the editor (Monaco's own semantic errors are off: it does not see the project). TODO / FIXME / HACK / XXX in
  comments and Markdown. Both grouped by file, click to the line, "Corriger / Demander à Claude" types the prompt. The plugin API keeps `terminal.run` ids, `runs`, `stop`, `show`.
- Default model: set from the Claude panel (settings.json `model`); the bubble's menu only changes the session, the
  `DefaultModelGuard` (services/default-model.ts) puts the default back whenever Claude Code saves a switched alias.
- Explorer: keyboard (↑ ↓ move, → open / enter, ← close / parent, Enter opens, Space = Quick Look on macOS),
  context menus on files, folders and the empty area. File management: new file / folder (inline name field), cut /
  copy / paste (⌘X ⌘C ⌘V, shared between projects), duplicate (⌘D), rename (F2), Trash after a confirmation (⌘⌫,
  Delete elsewhere). Main side in `services/file-ops.ts`: never overwrites (taken name refused, copies named
  "x copie.ts"), refuses a folder into itself and the disk root / home. Open file tabs follow a rename or move
  (unsaved edits kept) and close on deletion unless dirty. Shown folders are watched (`DirWatcher`), so outside
  changes appear.
- Claude icon: the terminal icon in orange (`Icons.claude`) everywhere it means Claude; skills keep the sparkle.
- **Claude panel** (right bar): subscription usage from Claude Code's status line (5 h session, week, per-model
  week, extra credit; gauges with reset delays), Claude Code version and default model (global data only), a
  button to the artifacts gallery (claude.ai/code/artifacts, default browser). The status line is ours only
  on demand (`services/usage.ts`: a script copies the JSON Claude Code pipes to it into `userData/usage/status.json`,
  prints nothing). Artifacts cannot be listed natively: the Artifact tools exist only in interactive sessions, not in
  `claude -p`.
- **Automatic updates**: GitHub releases of `sunstan/claude-term` (v2 on `main` since 2026-09-27, Swift v1 kept in
  the `v1` branch and `v1-swift` tag). Windows / Linux through electron-updater; macOS through our own updater
  (unsigned builds): feed, zip sha512, bundle version check, swap after quit + reopen. Checked end to end with a
  local feed (packaged 2.0.0 → 2.0.1). Settings › Général › Mises à jour; download icon in the right bar when ready.
  CI workflow `release`: every push to main → next version (last tag + 1 patch, or package.json when higher) →
  draft release → 3 platforms → published when all succeed. First release: v2.0.0.
- **Resize handles**: a thin line on hover and while dragging, double-click resets.
- **Explorer**: open folders kept per project (settings `explorerOpen`), reveal the shown file (Alt+F1), collapse all,
  dotfiles and git-ignored entries hidden or dimmed (`git check-ignore` per folder read, `services/explorer.ts`), ✳ on
  folders with Claude sessions, insert paths into the prompt. Several rows marked (Ctrl / Cmd, Shift, Ctrl+A), dragged
  into a folder (move; Ctrl, Option on macOS: copy), OS files dropped in are copied; taken names asked once (replace
  to the Trash, keep both, cancel); Ctrl+Z undoes the last create, rename, move or copy (`UndoLog` in main).
- **Scripts** (Exécuter): each script in a tab of its own, reused while it lives; the dev server address read from the
  output (`shared/dev-url.ts`: complete lines, the echoed command skipped, local hosts only) with Ouvrir dans le
  navigateur; named groups started or stopped together (settings `runGroups`); npm groups install their dependencies;
  `runShow` off starts scripts without leaving the current tab (the terminal is created at once, nothing is lost).
- **Skills**: copy to the personal skills or the open project (whole folder), import a .md file or a skill folder
  (picked or dropped; a front matter added to a plain file).
- **MCP**: secrets (by name: token, key, password, auth…; Bearer values; secret flags and query parameters) masked in
  every IPC reply (`shared/mcp-secrets.ts`); main takes them back from the server's source (`ref`) on save, and adds
  user servers itself. Copy from every project Claude Code knows (~/.claude.json), not only the recent ones. Local
  servers and disabled ones are found again on Windows (keys with forward slashes).
- **Git plugin**: a chip on project tabs and linked folders (branch ↑↓●, a dot on conflicts or a divergence; one
  `git status` per repository every 15 s, none while the window is hidden). Switching branch with changes asks: set
  them aside (`git stash push -u -m "ClaudeTerm: <branch>"`, then switch; back on the branch, Réappliquer pops it) or
  carry them. Tout mettre à jour: `git pull --ff-only` per open repository, with a report. Worktrees listed, opened
  as a project with a Claude tab, created next to the repository (`<repo>.worktrees/<branch>`), removed without
  `--force`. The branch's PR / MR (gh or glab when installed, 60 s cache) with its checks and review. Parsers and
  model at 100 % coverage (`tests/git-plugin.test.ts`, `tests/git-worktrees.test.ts`). Plugin API:
  `workspace.projects` / `onDidChangeProjects`, `visible` / `onDidChangeVisibility`, `openProject`, `openUrl`,
  `ui.projectDecoration`, `prompt({ choice })`.
- **Sessions keep their tab's name** (`userData/session-names.json`): History shows it and finds it, resuming reopens
  the tab under it, an unnamed tab binding a named session takes it. Plugin trees can ask for Tout replier / Tout
  déplier (`foldAll`, folds kept per project): the Commit view does. The + menu opens Claude on a model (`--model`).
- **Dev servers** (`shared/listening.ts`, `services/dev-servers.ts`): Exécuteurs › Scripts shows a Serveurs group, the
  servers listening under the project's terminals that no script showed, Claude's background ones included (netstat on
  Windows, lsof on macOS, ss then lsof on Linux; tied to a tab through the process tree; MCP servers left out; only
  those answering text/html, checked once a minute). Polled every 15 s while the panel is open and a terminal lives.
- **App icon**: new logo (`build/src/logo.svg`, 800 px full bleed) placed on the macOS grid in
  `build/src/icon.svg` (824 px body, 100 px margin on 1024); `build/icon.png` / `icon.icns` generated from it.
- **Tabs reopen at launch** (2026-10-10): Claude tabs resume their session, shells reopen in their folder with their last
  lines greyed and the running command typed again, files reopen; a tab starts when first shown.
- **Mémo** (2026-10-10): left island per project, tabs Liens (add, edit, reorder, drop a link from the browser) and
  Notes (personal Markdown notes in userData, project files pinned from the explorer's menu or by a drop); the right
  bar's Mémo groups every project's links and notes, read only.
- **Tests**: 72 (vitest). UI checked through `scripts/ui.ts` (CDP) + screenshots.

## Open / next

0. **Next task: Linear plugin**, first catalogue plugin, in its own repo: needs the `fetch` (network permission,
   domain-scoped) and `secrets` (safeStorage) APIs in the host first. Then add it to `sunstan/claudeterm-plugins`
   `registry.json` with the plugin's release .tgz + sha256 (repo created 2026-09-27, empty registry, local clone in `../plugins`).
1. **Bug to reproduce**: the user sees the right icon column change size "when a tab is selected"; not reproduced
   (measured 38 px in every state). Waiting for before/after screenshots.
3. Plugins: Thèmes plugin (list, preview, VS Code import); `network` (domain-scoped, through the plugin session) and
   `secrets` permissions for the Linear plugin.
4. Windows: test on a real machine (native and WSL), `hook.cmd`, screen capture, Ctrl shortcuts typed in a
   terminal go to the shell instead of the app.
5. Formatter beyond Monaco's languages (Prettier).
6. Windows and Linux updates are untested on real machines (electron-updater, unsigned NSIS / AppImage).

## Gotchas

- Catalogue approval / uninstall use native dialogs from main: `scripts/ui.ts` cannot click them (osascript has no
  Accessibility access), the user has to.

- Built-in plugins run in main: changes in `resources/plugins` need an app restart (no HMR).
- Monaco 0.57 worker paths: `monaco-editor/editor/editor.worker.js?worker`.
- Renderer Vite root is `src/renderer`: globs into node_modules must be relative.
- Electron 44 clipboard API is async (W3C-like).
- zustand selectors must not return new arrays (use `useMemo` over the raw slice).
