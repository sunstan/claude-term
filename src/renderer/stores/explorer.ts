import { create } from 'zustand'
import { isInside } from '@shared/claude-format'
import { useWorkbench } from './workbench'

const parentOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
const MAX_PER_ROOT = 400

interface Explorer {
  /** open folders by tree root (settings.explorerOpen once loaded) */
  open: Record<string, string[]>
  loaded: boolean
  /** a path for the tree whose root holds it to show: its folders opened, selected, scrolled to */
  reveal: { path: string; n: number } | null
  openOf(root: string): string[]
  setOpen(root: string, path: string, on: boolean): void
  collapseAll(root: string): void
  revealPath(path: string): void
}

/** Explorer state shared by every tree and kept across project switches and restarts. */
export const useExplorer = create<Explorer>((set, get) => {
  const ensure = () => {
    if (get().loaded) return
    const saved = useWorkbench.getState().settings?.explorerOpen
    if (saved) set({ open: { ...saved, ...get().open }, loaded: true })
  }
  const write = (root: string, list: string[]) => {
    ensure()
    set((s) => ({ open: { ...s.open, [root]: list.slice(-MAX_PER_ROOT) } }))
    save(get)
  }
  return {
    open: {},
    loaded: false,
    reveal: null,
    openOf(root) { ensure(); return get().open[root] ?? [] },
    setOpen(root, path, on) {
      const cur = get().openOf(root)
      if (on === cur.includes(path)) return
      write(root, on ? [...cur, path] : cur.filter((p) => p !== path))
    },
    collapseAll(root) { write(root, []) },
    revealPath(path) { set((s) => ({ reveal: { path, n: (s.reveal?.n ?? 0) + 1 } })) },
  }
})

/** The folders between `root` (excluded) and `path` (excluded), outermost first. */
export function foldersTo(root: string, path: string): string[] {
  if (!isInside(path, root) || path === root) return []
  const out: string[] = []
  for (let d = parentOf(path); d.length > root.length && d !== root; d = parentOf(d)) out.unshift(d)
  return out
}

let timer: ReturnType<typeof setTimeout> | undefined
function save(get: () => Explorer) {
  clearTimeout(timer)
  timer = setTimeout(() => {
    // folders left empty are dropped
    const open = Object.fromEntries(Object.entries(get().open).filter(([, l]) => l.length))
    window.ct.settings.set({ explorerOpen: open })
  }, 500)
}
