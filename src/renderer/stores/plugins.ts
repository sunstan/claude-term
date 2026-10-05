import { create } from 'zustand'
import { useWorkbench } from './workbench'
import type { PluginInfo, ViewModel, PopoverRequest, PluginCommand } from '@shared/plugins'
import type { PluginDecoration } from '@shared/ipc'

/** a folder as compared across spellings (slashes, trailing one, case on Windows) */
const sameRoot = (p: string) => { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return window.ct.platform === 'win32' ? s.toLowerCase() : s }

interface PluginStore {
  plugins: PluginInfo[]
  views: Record<string, ViewModel>
  popovers: PopoverRequest[]
  /** the running plugins' commands (palette, shortcuts) */
  commands: PluginCommand[]
  closePopover(id: string): void
  init(): void
  /** views placed in the center bottom block */
  bottomViews(): { id: string; title: string; pluginId: string }[]
  /** activity entries contributed for a side */
  activities(side: 'left' | 'right'): { id: string; title: string; icon: string; pluginId: string }[]
  viewsOf(activityId: string): { id: string; title: string; pluginId: string }[]
  /** tree nodes opened / closed by the user (settings.treeState): kept across tab switches and restarts */
  treeState: Record<string, Record<string, boolean>>
  setOpen(viewId: string, itemId: string, open: boolean): void
  /** chips plugins show on project tabs and linked folders */
  decorations: PluginDecoration[]
  decorationsOf(root: string | null): PluginDecoration[]
}

let saveTimer: ReturnType<typeof setTimeout> | undefined

export const usePlugins = create<PluginStore>((set, get) => ({
  plugins: [],
  views: {},
  popovers: [],
  commands: [],
  closePopover(id) { set((s) => ({ popovers: s.popovers.filter((p) => p.id !== id) })) },
  bottomViews() {
    return get().plugins.filter((p) => p.enabled).flatMap((p) => (p.manifest.contributes?.views ?? []).filter((v) => v.placement === 'bottom').map((v) => ({ id: `${p.manifest.id}:${v.id}`, title: v.title, pluginId: p.manifest.id })))
  },
  treeState: {},
  decorations: [],
  decorationsOf(root) {
    if (!root) return []
    const want = sameRoot(root)
    return get().decorations.filter((d) => sameRoot(d.root) === want)
  },
  setOpen(viewId, itemId, open) {
    set((s) => {
      // bounded: the oldest choices of a view go first (item ids of closed projects pile up otherwise)
      const view = Object.entries({ ...s.treeState[viewId], [itemId]: open }).filter(([k]) => k !== itemId).slice(-499)
      return { treeState: { ...s.treeState, [viewId]: Object.fromEntries([...view, [itemId, open]]) } }
    })
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => window.ct.settings.set({ treeState: get().treeState }), 400)
  },
  init() {
    window.ct.settings.get().then((s) => {
      const ts = { ...(s.treeState ?? {}) }
      // the Lanceur plugin's tree is the Exécuter panel's Scripts tab now (same item ids)
      if (ts['claudeterm.runnables:runnables'] && !ts['run:scripts']) { ts['run:scripts'] = ts['claudeterm.runnables:runnables']; delete ts['claudeterm.runnables:runnables']; window.ct.settings.set({ treeState: ts }) }
      set({ treeState: ts })
    })
    window.ct.plugins.list().then((plugins) => set({ plugins }))
    window.ct.plugins.commands().then((commands) => set({ commands }))
    window.ct.plugins.onCommands((commands) => set({ commands }))
    window.ct.plugins.onChanged((plugins) => {
      set({ plugins })
      // a disabled or uninstalled plugin takes its activity with it
      const wb = useWorkbench.getState()
      const gone = (a: string | null) => !!a?.includes(':') && !plugins.some((p) => p.enabled && a.startsWith(p.manifest.id + ':'))
      if (gone(wb.leftActivity)) wb.setLeft('explorer')
      if (gone(wb.rightActivity)) wb.setRight(null)
    })
    window.ct.plugins.onView(({ viewId, model }) => set((s) => ({ views: { ...s.views, [viewId]: model } })))
    window.ct.plugins.onPopover((r) => set((s) => ({ popovers: [...s.popovers.filter((p) => p.id !== r.id), r] })))
    window.ct.plugins.onPopoverClose((id) => set((s) => ({ popovers: s.popovers.filter((p) => p.id !== id) })))
    window.ct.plugins.decorations().then((decorations) => set({ decorations }))
    window.ct.plugins.onDecorations((decorations) => set({ decorations }))
  },
  activities(side) {
    return get().plugins.filter((p) => p.enabled).flatMap((p) => (p.manifest.contributes?.activity ?? []).filter((a) => a.side === side).map((a) => ({ id: `${p.manifest.id}:${a.id}`, title: a.title, icon: a.icon, pluginId: p.manifest.id })))
  },
  viewsOf(activityId) {
    const [pluginId, aid] = activityId.split(':')
    const p = get().plugins.find((x) => x.manifest.id === pluginId)
    return (p?.manifest.contributes?.views ?? []).filter((v) => v.activity === aid && v.placement !== 'bottom').map((v) => ({ id: `${pluginId}:${v.id}`, title: v.title, pluginId }))
  },
}))
