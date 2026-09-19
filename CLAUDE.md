# ClaudeTerm — notes for Claude Code

macOS app, SwiftUI + SwiftTerm, SwiftPM without Xcode (Command Line Tools only).

- Build and run: `./build.sh && open ClaudeTerm.app`. Kill the running instance first:
  `pkill -f ClaudeTerm.app/Contents/MacOS`.
- Tests: `./test.sh` (Swift Testing; XCTest is not available without Xcode). Tests cover the pure
  parts: `ClaudeData`, `LinkStore`, `SettingsModel`, `SkillStore`, `NpmProject`, `MCPStore`.
  Add a test whenever these files change.
- Screenshots cannot be taken from the terminal (permission denied): ask Jérôme.
- Validated UI rules: left = project, center = session (bottom block), right = global; no
  double-click to trigger actions in lists (navigation / opening only); full hit areas
  (`contentShape`) on every custom button; no cards with shadows, full-width bordered blocks;
  lists are transparent (`scrollContentBackground(.hidden)`) over a single window background.
- Never mutate SwiftUI state during layout: views inside `HSplitView`/`VSplitView` get `onAppear`
  from AppKit layout, so defer state changes there with `DispatchQueue.main.async`; never touch
  SwiftUI-owned AppKit views (List scroll views: `scrollerStyle`…) — it crashes in AttributeGraph.
- SwiftUI `List` + `onDrag`/`onTapGesture` breaks selection: use `itemProvider` and the AppKit
  `DoubleClickMonitor`.
- No polling when an event exists: shell state comes from the OSC 7770 shell integration.
- Claude Code files (`~/.claude/...`) are read, never rewritten except `settings.json` (form),
  `sessions-index.json` (deletion), `<project>/.claude/settings.local.json` (links) and
  `<project>/.mcp.json` (MCP). Never `~/.claude.json`: go through `claude mcp add|remove`.
  Preserve unknown keys, refuse to write over unreadable JSON.
- Claude Code permission rules: `//path` is absolute, `/path` is project-relative.
- Project folder encoding: ASCII only (`[^a-zA-Z0-9]` → `-`).
- Language: code, comments, commit messages and README.md in English; UI source strings in French
  (they are the localization keys), English table in `Resources/en.lproj/Localizable.strings`
  (`plutil -lint` to check); README.fr.md mirrors README.md. "un skill" is masculine in French.
  Literals passed to `Text`, `Label`, `Button`, `.help`, `Section`, `Picker` localize automatically;
  any `String`-typed literal (badges, alerts, tuples, `.help(cond ? a : b)`) goes through `L("…")`
  or `String(localized:)` when interpolated. App preferences (language, font, appearance) live in
  `AppSettings.swift`; the right-panel "Settings" tab is only about Claude Code's `settings.json`.
- Notifications rely on Claude Code hooks (`Notification`, `Stop`) spooled by `hook.sh` into
  `~/Library/Application Support/ClaudeTerm/events`; `EventHub` routes them to tabs. The hooks are only
  installed from Settings, never silently.
- License: PolyForm Noncommercial 1.0.0 (LICENSE.md).
