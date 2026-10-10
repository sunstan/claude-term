import { useWorkbench, type LeftActivity } from '@/stores/workbench'
import { binding, label as keyLabel, matches, terminalSafe, type KeyEventLike } from '@shared/keymap'
import type { PluginCommand } from '@shared/plugins'
import { usePlugins } from '@/stores/plugins'
import { usePalette } from '@/stores/palette'

/**
 * A DOM keydown as the keymap reads it (AltGr is Ctrl+Alt on Windows / Linux: it types, it is never a shortcut).
 * Not on macOS, where ⌥ may be reported as AltGraph and is a shortcut modifier (⌥⌘S).
 */
export const keyEvent = (e: KeyboardEvent): KeyEventLike => ({ key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, altGraph: window.ct.platform !== 'darwin' && !!e.getModifierState?.('AltGraph') })

/** An action's shortcut as the keymap has it now (preset, overrides), for menus and tooltips; '' when unbound. */
export function shortcutLabel(id: string): string {
  const s = useWorkbench.getState().settings, mac = window.ct.platform === 'darwin'
  const k = binding(id, s?.keybindings ?? {}, s?.keymapPreset, mac)
  return k ? keyLabel(k, mac) : ''
}
export const withShortcut = (text: string, id: string) => { const k = shortcutLabel(id); return k ? `${text} (${k})` : text }

const PANELS: Record<string, LeftActivity> = { 'app.explorer': 'explorer', 'app.search': 'search', 'app.history': 'history', 'app.skills': 'skills', 'app.mcp': 'mcp', 'app.plugins': 'plugins', 'app.run': 'run', 'app.memo': 'memo' }

/** General (app-level) actions triggered by the keymap. Returns false when the action does not apply. */
export function runAppAction(id: string): boolean {
  const st = useWorkbench.getState()
  const p = st.projects.find((x) => x.id === st.activeProjectId)
  // the project's panels: the shortcut opens the panel, or closes it when it is the one shown
  if (PANELS[id]) { if (!p?.root) return false; st.setLeft(st.leftActivity === PANELS[id] ? null : PANELS[id]); return true }
  switch (id) {
    case 'app.newShell': if (!p?.root) return false; st.newTab(p.id, 'shell'); return true
    case 'app.newClaude': if (!p?.root) return false; st.newTab(p.id, 'claude'); return true
    case 'app.closeTab': if (st.showSettings) { st.setShowSettings(false); return true } if (!p?.currentTabId) return false; st.closeTab(p.id, p.currentTabId); return true
    case 'app.nextTab': case 'app.prevTab': {
      if (!p || p.tabs.length < 2) return false
      const i = p.tabs.findIndex((t) => t.id === p.currentTabId), d = id === 'app.nextTab' ? 1 : -1
      st.setCurrentTab(p.id, p.tabs[(i + d + p.tabs.length) % p.tabs.length].id); return true
    }
    case 'app.newProject': st.newProject(null); return true
    case 'app.openFolder': window.ct.app.pickFolder().then((d) => { if (d) { const s = useWorkbench.getState(); const target = p && !p.root ? p : s.newProject(null); s.setRoot(target.id, d) } }); return true
    case 'app.goToFile': usePalette.getState().open(''); return true
    case 'app.commands': usePalette.getState().open('>'); return true
    case 'app.settings': st.setShowSettings(!st.showSettings); return true
    case 'app.save': st.saveCurrentFile(); return true
    case 'app.screenshot': if (!p?.root) return false; st.captureScreen(p.id); return true
    case 'app.git': if (!p?.root) return false; st.setLeft(st.leftActivity === 'claudeterm.git:git' ? null : 'claudeterm.git:git'); return true
    case 'app.commit': if (!p?.root) return false; st.setLeft('claudeterm.git:git'); setTimeout(() => (document.querySelector('.pv-footer textarea') as HTMLTextAreaElement | null)?.focus(), 150); return true
  }
  return false
}

/** The plugin command a keydown triggers (after the app's own shortcuts); in a terminal, only those it leaves to the app. */
export function pluginCommandFor(e: KeyEventLike, inTerminal: boolean): PluginCommand | null {
  const mac = window.ct.platform === 'darwin'
  return usePlugins.getState().commands.find((c) => c.shortcut && matches(c.shortcut, e, mac) && (!inTerminal || terminalSafe(c.shortcut, mac))) ?? null
}
