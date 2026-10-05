/** Command palette (pure, tested): what the typed prefix asks for, and how well an entry matches. */

export type PaletteMode = 'files' | 'commands' | 'sessions' | 'skills'

export const PALETTE_PREFIXES: { prefix: string; mode: PaletteMode }[] = [
  { prefix: '>', mode: 'commands' },
  { prefix: '@', mode: 'sessions' },
  { prefix: '/', mode: 'skills' },
]

/** "> new" → commands, "new"; no prefix → files. */
export function paletteInput(text: string): { mode: PaletteMode; query: string } {
  const p = PALETTE_PREFIXES.find((x) => text.startsWith(x.prefix))
  return p ? { mode: p.mode, query: text.slice(p.prefix.length).trim() } : { mode: 'files', query: text.trim() }
}

/** Lowercase without accents ("Exécuteurs" → "executeurs"), for matching what people type. */
export const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * How well `text` matches `query` (0: not at all). A substring wins, earlier and at a word start better; otherwise
 * every query word must start a word of the text, in order (« nou cla » → « Nouvel onglet Claude »).
 */
export function fuzzy(text: string, query: string): number {
  const t = fold(text), q = fold(query).trim()
  if (!q) return 1
  const at = t.indexOf(q)
  if (at >= 0) return 1000 - at * 4 - t.length + (at === 0 || /\W/.test(t[at - 1]) ? 200 : 0)
  const words = t.split(/[^a-z0-9]+/).filter(Boolean)
  let i = 0
  for (const qw of q.split(/\s+/)) {
    while (i < words.length && !words[i].startsWith(qw)) i++
    if (i === words.length) return 0
    i++
  }
  return 300 - t.length
}

/** The entries matching `query`, best first (ties keep their order), at most `limit`. */
export function rank<T>(items: T[], text: (x: T) => string, query: string, limit = 50): T[] {
  return items.map((x, i) => ({ x, i, s: fuzzy(text(x), query) })).filter((e) => e.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, limit).map((e) => e.x)
}
