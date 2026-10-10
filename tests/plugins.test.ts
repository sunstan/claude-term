import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { validateManifest, filterItems, cleanCommands } from '../src/shared/plugins'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const fsApi = { exists: (p: string) => existsSync(p), read: (p: string) => readFileSync(p, 'utf8'), list: (p: string) => { try { return readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })) } catch { return [] } } }

describe('plugin manifests', () => {
  it('validates ids, main and contributions', () => {
    expect(validateManifest({ id: 'x.y', name: 'X', main: 'main.js' })).toBeNull()
    expect(validateManifest({ id: 'Bad Id', name: 'X', main: 'main.js' })).toMatch(/id/)
    expect(validateManifest({ id: 'x', name: 'X' })).toMatch(/main/)
    expect(validateManifest({ id: 'x', name: 'X', main: 'm.js', contributes: { activity: [{ id: 'a', title: 'A', side: 'top' }] } })).toMatch(/activity/)
  })
})

describe('view search', () => {
  const items = [
    { id: 'g1', label: 'devgen · npm', children: [{ id: 'a', label: 'start', detail: 'tsx src/server.ts' }, { id: 'b', label: 'gen', detail: 'tsx src/cli.ts' }] },
    { id: 'g2', label: 'mobile · npm', children: [{ id: 'c', label: 'dev', detail: 'expo start' }] },
  ]
  it('finds commands by name or command line, folders by name with all their commands', () => {
    expect(filterItems(items, 'gen').map((g) => [g.label, g.children?.map((c) => c.label)])).toEqual([['devgen · npm', ['start', 'gen']]])
    expect(filterItems(items, 'dev').map((g) => [g.label, g.children?.map((c) => c.label)])).toEqual([['devgen · npm', ['start', 'gen']], ['mobile · npm', ['dev']]])
    expect(filterItems(items, 'expo').map((g) => [g.label, g.children?.map((c) => c.label)])).toEqual([['mobile · npm', ['dev']]])
    expect(filterItems(items, 'cli')[0].children?.map((c) => c.label)).toEqual(['gen'])
    expect(filterItems(items, 'zzz')).toEqual([])
    expect(filterItems(items, 'expo')[0].expanded).toBe(true)
  })
})

describe('plugin commands', () => {
  it('keeps valid commands: unique ids, a title, a parsable shortcut, 100 at most', () => {
    expect(cleanCommands('acme.x', [
      { id: 'review', title: ' Revue ', shortcut: 'Mod+Alt+R' },
      { id: 'review', title: 'twice' },
      { id: 'bad id!', title: 'x' },
      { id: 'notitle', title: '' },
      { id: 'badkey', title: 'K', shortcut: 'Hyper+K' },
      'nope',
    ])).toEqual([{ pluginId: 'acme.x', id: 'review', title: 'Revue', shortcut: 'Mod+Alt+R' }, { pluginId: 'acme.x', id: 'badkey', title: 'K' }])
    expect(cleanCommands('acme.x', 'nope')).toEqual([])
    expect(cleanCommands('acme.x', Array.from({ length: 150 }, (_, i) => ({ id: 'c' + i, title: 'C' })))).toHaveLength(100)
  })
})
