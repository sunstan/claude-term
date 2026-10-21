# ClaudeTerm v2 — notes for Claude Code

Electron workbench for Claude Code (macOS, Windows, Linux). Successor of the native Swift v1 in
branch `v1` / tag `v1-swift`; the design is in `docs/DESIGN.md` (read it before structural changes).

- Run: `npm run dev` (electron-vite --watch: HMR for the renderer, main/preload rebuilt and Electron restarted on change). Build: `npm run build`.
  Dev name/icon on macOS: `npm run dev:bundle` (also run by postinstall) renames node_modules' Electron.app to ClaudeTerm.
  Typecheck: `npm run typecheck`. Tests: `npm test` (vitest, `tests/`). Run all three before a commit.
- Tests cover `src/shared` (pure) and the main services that touch files: `ClaudeSettings`, `ClaudeData`,
  `SessionTracker`, `FileOps` (temp dirs via `tests/helpers.ts`). Add a test whenever these change.
- UI checks without the user: the dev app exposes CDP on port 9333; `npx tsx scripts/ui.ts` drives it
  (Playwright over CDP): `shot <name>` (screenshot in `scratch/`, then Read it), `click "<selector>"`,
  `type`, `key`, `text`, `eval`, `state` (store dump via `window.__ct_state`), chained with `--`.
  Use it after every visible change instead of asking for a screenshot.
- Layout: `src/main` (services + IPC, Node), `src/preload` (contextBridge → `window.ct`, typed by
  `src/shared/ipc.ts`), `src/renderer` (React, zustand store in `stores/workbench.ts`),
  `src/shared` (pure code, tested). No Node in the renderer; every capability goes through `window.ct`.
- UI: token-driven. Colors only through `var(--ct-<token>)` (tokens listed in `src/shared/theme.ts`,
  `TOKEN_FALLBACKS`), never hard-coded. Islands (`Island` component) with the shared header; no shadows.
  Icons come from `lucide-react` through `workbench/icons.tsx` (bundled; CSP forbids icon fonts/CDNs).
- Themes: VS Code format (`colors`, `tokenColors`) + our tokens; built-ins in `resources/themes`,
  user themes in `userData/themes`. A VS Code theme must load unchanged.
- Terminals: one xterm per tab, created outside React (`terminal/TerminalView.tsx`) so switching tabs
  keeps scrollback; pty in main (`services/pty.ts`). PATH comes from the user's login shell.
- Nothing machine-specific goes in the user's projects (absolute paths, app state): it lives in `userData`
  (e.g. linked folders: `services/links.ts`, passed to claude with `--settings` at launch). A project only gets
  files meant to be shared (`.mcp.json`, skills the user creates).
- Claude Code files (`~/.claude/...`) are read, never rewritten except the ones listed in
  `docs/DESIGN.md` §8. Never `~/.claude.json`: use `claude mcp add|remove`. Strip `CLAUDE_CODE_*` env.
- Language: code, comments, commit messages, README.md and docs in English; UI strings in French
  (i18n later). README.fr.md mirrors README.md when it exists.
- Windows: `windowsMode` setting (`native` | `wsl`) decides how `claude` and shells are spawned.
- Updates: `services/updater.ts` reads the GitHub releases of sunstan/claude-term. Windows / Linux: electron-updater.
  macOS (unsigned, so no Squirrel): latest-mac.yml → zip (sha512) → a detached script swaps the .app after quit.
  Release: every push to main (workflow `release`, version from `scripts/next-version.mjs`: last tag + 1 patch, or
  package.json when higher; injected with `--config.extraMetadata.version`, never committed). `CT_UPDATE_URL=http://127.0.0.1:<port>`
  points a packaged app at a local feed (`latest/download/latest-mac.yml`, `download/v<version>/<zip>`) for tests.
- Packaging: `electron-builder.yml`; `npm run dist:mac|win|linux`. Themes ship as `extraResources/themes`,
  node-pty is unpacked from the asar. A packaged app started with `CT_CDP_PORT=9444` exposes CDP and the
  test hooks, so `CT_CDP_PORT=9444 npx tsx scripts/ui.ts …` drives it like the dev app. Icons in `build/`.
- Plugins: host in `src/main/services/plugins.ts` (one hidden sandboxed BrowserWindow per plugin, bridge in
  `resources/plugin-host/`, permission checks in `plugin-policy.ts`), contract in `src/shared/plugins.ts`,
  API typings in `resources/plugins/claudeterm.d.ts`, built-ins in `resources/plugins/<id>/` (Git; core features such as the
  Exécuter panel are not plugins: they need the editor), user plugins in
  `userData/plugins`. Views are declarative models rendered by `workbench/PluginView.tsx`; plugins never draw.
- License: PolyForm Noncommercial 1.0.0.
- File icons: Catppuccin SVGs in `src/renderer/assets/catppuccin`; their lavender neutrals were recolored to the theme's grey (hue/saturation of `island.bg`, lightness kept), recorded in `mapping.json` > `recolored`. Redo it if the icons are updated.
