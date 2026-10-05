import { describe, it, expect } from 'vitest'
import { fold, fuzzy, paletteInput, rank } from '../src/shared/palette'

describe('command palette', () => {
  it('reads the prefix', () => {
    expect(paletteInput('app.ts')).toEqual({ mode: 'files', query: 'app.ts' })
    expect(paletteInput('> nouvel')).toEqual({ mode: 'commands', query: 'nouvel' })
    expect(paletteInput('@refacto')).toEqual({ mode: 'sessions', query: 'refacto' })
    expect(paletteInput('/rev')).toEqual({ mode: 'skills', query: 'rev' })
    expect(paletteInput('')).toEqual({ mode: 'files', query: '' })
  })

  it('matches without case or accents, substrings first, then word starts in order', () => {
    expect(fold('Exécuteurs ÉTÉ')).toBe('executeurs ete')
    expect(fuzzy('Exécuteurs', 'execu')).toBeGreaterThan(0)
    expect(fuzzy('Nouvel onglet Claude', 'nou cla')).toBeGreaterThan(0)
    expect(fuzzy('Nouvel onglet Claude', 'cla nou')).toBe(0)
    expect(fuzzy('Nouvel onglet shell', 'xyz')).toBe(0)
    expect(fuzzy('Réglages', 'regl')).toBeGreaterThan(fuzzy('Nouvel onglet Claude', 'nou cla'))
    expect(fuzzy('anything', '')).toBe(1)
  })

  it('ranks the best first and keeps the order of ties', () => {
    const items = ['Fermer l’onglet', 'Nouvel onglet shell', 'Nouvel onglet Claude', 'Onglet suivant']
    expect(rank(items, (x) => x, 'onglet').slice(0, 1)).toEqual(['Onglet suivant'])
    expect(rank(items, (x) => x, 'nou')).toEqual(['Nouvel onglet shell', 'Nouvel onglet Claude'])
    expect(rank(items, (x) => x, '')).toEqual(items)
    expect(rank(items, (x) => x, 'o', 2)).toHaveLength(2)
  })
})
