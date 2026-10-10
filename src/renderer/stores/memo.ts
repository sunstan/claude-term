import { create } from 'zustand'

/** Bumped after every change to a Mémo, so both islands (this project, all projects) read it again. */
export const useMemoVersion = create<{ version: number; bump(): void }>((set) => ({ version: 0, bump: () => set((s) => ({ version: s.version + 1 })) }))

/** Pins a file in a project's Mémo (the explorer's menu, a drop on the Notes tab); false when it already was. */
export async function pinFile(root: string, path: string): Promise<boolean> {
  const m = await window.ct.memo.load(root)
  if (m.pins.some((p) => p.path === path)) return false
  await window.ct.memo.savePins(root, [...m.pins.map((p) => p.path), path])
  useMemoVersion.getState().bump()
  return true
}
