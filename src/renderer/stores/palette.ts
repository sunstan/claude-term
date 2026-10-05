import { create } from 'zustand'

/** The command palette's open state: the text it opens with (a prefix picks the mode), null when closed. */
export const usePalette = create<{ text: string | null; open(text: string): void; close(): void }>((set) => ({
  text: null, open: (text) => set({ text }), close: () => set({ text: null }),
}))
