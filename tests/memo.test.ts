import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { defaultLinkName, matchesFilter, normalizeUrl, noteFileName, noteName } from '../src/shared/memo'
import { MemoStore } from '../src/main/services/memo'

describe('memo links and names', () => {
  it('normalizes what the user types into a web or mail link, refuses anything else', () => {
    expect(normalizeUrl('  https://github.com/sunstan/claude-term ')).toBe('https://github.com/sunstan/claude-term')
    expect(normalizeUrl('github.com/x')).toBe('https://github.com/x')
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000')
    expect(normalizeUrl('http://localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(normalizeUrl('jerome@example.fr')).toBe('mailto:jerome@example.fr')
    expect(normalizeUrl('mailto:a@b.fr')).toBe('mailto:a@b.fr')
    for (const bad of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', 'ftp://h/x', 'two words', 'https://']) expect(normalizeUrl(bad)).toBeNull()
  })
  it('names a link after its host, a note after its file', () => {
    expect(defaultLinkName('https://www.figma.com/file/abc')).toBe('figma.com')
    expect(defaultLinkName('http://localhost:3000/')).toBe('localhost:3000')
    expect(defaultLinkName('mailto:a@b.fr')).toBe('a@b.fr')
    expect(noteFileName(' Idées / à faire? ')).toBe('Idées  à faire.md')
    expect(noteFileName('notes.md')).toBe('notes.md')
    expect(noteFileName('..')).toBeNull()
    expect(noteFileName('  ')).toBeNull()
    expect(noteName('/x/memo/Réunion.md')).toBe('Réunion')
  })
  it('filters on every word, case and accents ignored', () => {
    expect(matchesFilter('Maquettes Figma figma.com', 'figma maq')).toBe(true)
    expect(matchesFilter('Réunion équipe', 'reunion EQUIPE')).toBe(true)
    expect(matchesFilter('Docs', 'api')).toBe(false)
    expect(matchesFilter('Docs', '  ')).toBe(true)
  })
})

describe('MemoStore', () => {
  it('keeps links, notes and pins per project in the app data, never in the project', async () => {
    const t = new TempDir()
    const trashed: string[] = []
    const store = new MemoStore(join(t.path, 'ud'), async (p) => { trashed.push(p); rmSync(p) })
    const root = join(t.path, 'proj'), other = join(t.path, 'other')
    expect(store.load(root)).toEqual({ root, links: [], notes: [], pins: [] })
    expect(store.list()).toEqual([])

    store.saveLinks(root, [{ name: 'Docs', url: 'docs.example.com' }, { name: '', url: 'https://x.dev' }, { name: 'bad', url: 'javascript:alert(1)' }])
    expect(store.load(root).links).toEqual([{ name: 'Docs', url: 'https://docs.example.com' }, { name: 'https://x.dev', url: 'https://x.dev' }])

    const a = store.newNote(root, 'Idées')
    const b = store.newNote(root, 'Idées')
    expect(a.startsWith(store.dir(root))).toBe(true)
    expect(b).toBe(join(store.dir(root), 'Idées 2.md'))
    expect(readFileSync(a, 'utf8')).toBe('# Idées\n\n')
    expect(store.load(root).notes.map((n) => n.name)).toEqual(['Idées', 'Idées 2'])

    const renamed = store.renameNote(root, b, 'Réunion')
    expect(existsSync(b)).toBe(false)
    expect(() => store.renameNote(root, renamed, 'Idées')).toThrow(/déjà/)
    // a path outside the project's notes is refused
    expect(() => store.renameNote(root, join(t.path, 'x.md'), 'y')).toThrow()
    await expect(store.deleteNote(other, renamed)).rejects.toThrow()
    await store.deleteNote(root, renamed)
    expect(trashed).toEqual([renamed])

    const pinned = t.write('proj/docs/ARCHITECTURE.md', '#')
    store.savePins(root, [pinned, pinned, 'relative/path', join(t.path, 'gone.md')])
    expect(store.load(root).pins).toEqual([{ path: pinned, exists: true }, { path: join(t.path, 'gone.md'), exists: false }])

    // a project with notes only is listed too
    store.newNote(other, 'n')
    expect(store.list().map((m) => m.root).sort()).toEqual([other, root].sort())
    expect(existsSync(join(root, '.claude'))).toBe(false)
    t.dispose()
  })
})
