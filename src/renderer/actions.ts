import { useWorkbench, type LeftActivity } from '@/stores/workbench'
import type { KeyEventLike } from '@shared/keymap'

/** A DOM keydown as the keymap reads it (AltGr is Ctrl+Alt on Windows: it types, it is never a shortcut). */
export const keyEvent = (e: KeyboardEvent): KeyEventLike => ({ key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, altGraph: e.getModifierState?.('AltGraph') })

const PANELS: Record<string, LeftActivity> = { 'app.explorer': 'explorer', 'app.search': 'search', 'app.history': 'history', 'app.skills': 'skills', 'app.mcp': 'mcp', 'app.plugins': 'plugins', 'app.run': 'run' }

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
    case 'app.goToFile': if (!p?.root) return false; st.setLeft('search'); return true
    case 'app.settings': st.setShowSettings(!st.showSettings); return true
    case 'app.save': st.saveCurrentFile(); return true
    case 'app.screenshot': if (!p?.root) return false; st.captureScreen(p.id); return true
    case 'app.git': if (!p?.root) return false; st.setLeft(st.leftActivity === 'claudeterm.git:git' ? null : 'claudeterm.git:git'); return true
    case 'app.commit': if (!p?.root) return false; st.setLeft('claudeterm.git:git'); setTimeout(() => (document.querySelector('.pv-footer textarea') as HTMLTextAreaElement | null)?.focus(), 150); return true
  }
  return false
}
