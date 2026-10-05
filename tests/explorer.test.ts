import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { ignoredNames, listDir } from '../src/main/services/explorer'

let t: TempDir
afterEach(() => t?.dispose())

describe('explorer listing', () => {
  it('folders first, then by name; dotfiles flagged hidden; no marks unless asked', async () => {
    t = new TempDir()
    t.write('b.txt', ''); t.write('A.txt', ''); t.write('.env', ''); t.write('src/x.ts', '')
    const e = await listDir(t.path)
    expect(e.map((x) => x.name)).toEqual(['src', '.env', 'A.txt', 'b.txt'])
    expect(e.find((x) => x.name === '.env')?.hidden).toBe(true)
    expect(e.every((x) => x.ignored === undefined && x.sessions === undefined)).toBe(true)
    expect(await listDir(join(t.path, 'missing'))).toEqual([])
  }, 20_000)

  it('marks what git ignores (folder patterns too, tracked files never) and folders with sessions', async () => {
    t = new TempDir()
    const git = (...a: string[]) => execFileSync('git', a, { cwd: t.path, windowsHide: true })
    git('init', '-q')
    t.write('.gitignore', 'node_modules/\n*.log\nkept.txt\n')
    t.write('node_modules/x/index.js', ''); t.write('debug.log', ''); t.write('src/a.ts', ''); t.write('kept.txt', '')
    git('add', '-f', 'kept.txt')
    const e = await listDir(t.path, { marks: true, hasSessions: (d) => d.endsWith('src') })
    const by = Object.fromEntries(e.map((x) => [x.name, x]))
    expect(by['node_modules'].ignored).toBe(true)
    expect(by['debug.log'].ignored).toBe(true)
    expect(by['kept.txt'].ignored).toBeUndefined()   // tracked
    expect(by['src'].ignored).toBeUndefined()
    expect(by['src'].sessions).toBe(true)
    expect(by['node_modules'].sessions).toBeUndefined()
    expect(by['.git']).toBeDefined()
  }, 20_000)

  it('outside a repository nothing is ignored', async () => {
    t = new TempDir()
    t.write('a.log', '')
    expect(await ignoredNames(t.path, ['a.log'], { ...process.env, GIT_CEILING_DIRECTORIES: t.path })).toEqual(new Set())
    expect(await ignoredNames(t.path, [])).toEqual(new Set())
  }, 20_000)
})
