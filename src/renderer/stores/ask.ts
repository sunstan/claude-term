import { create } from 'zustand'

/** A line the app asks the user for (a script group's name…); the App shows it in the prompt modal. */
export const useAsk = create<{
  req: { title: string; placeholder?: string; options?: string[] } | null
  resolve: ((v: string | null) => void) | null
  /** options: offered as choices (a click picks one), the field still takes a new value */
  ask(title: string, placeholder?: string, options?: string[]): Promise<string | null>
  done(v: string | null): void
}>((set, get) => ({
  req: null, resolve: null,
  ask: (title, placeholder, options) => new Promise((resolve) => { get().resolve?.(null); set({ req: { title, placeholder, options }, resolve }) }),
  done: (v) => { get().resolve?.(v); set({ req: null, resolve: null }) },
}))
