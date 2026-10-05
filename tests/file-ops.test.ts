import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { FileOps, freeName, transferAll, UndoLog, type ConflictChoice } from '../src/main/services/file-ops'

describe('file operations', () => {
  it('names copies like the Finder', () => {
    const taken = new Set(['a.ts', 'a copie.ts', '.env', 'dir'].map((n) => join('/d', n)))
    const ex = (p: string) => taken.has(p)
    expect(freeName('/d', 'b.ts', ex)).toBe('b.ts')
    expect(freeName('/d', 'a.ts', ex)).toBe('a copie 2.ts')
    expect(freeName('/d', '.env', ex)).toBe('.env copie')
    expect(freeName('/d', 'dir', ex)).toBe('dir copie')
  })

  it('creates files and folders, never over an existing one', () => {
    const t = new TempDir()
    expect(FileOps.create(t.path, 'a.ts', false)).toEqual({ ok: true, path: join(t.path, 'a.ts') })
    expect(FileOps.create(t.path, 'src', true)).toEqual({ ok: true, path: join(t.path, 'src') })
    expect(FileOps.create(t.path, 'a.ts', false)).toMatchObject({ ok: false, error: expect.stringMatching(/existe déjà/) })
    expect(FileOps.create(t.path, '../evil', false)).toMatchObject({ ok: false, error: 'nom invalide' })
    expect(FileOps.create(t.path, '', true)).toMatchObject({ ok: false })
    t.dispose()
  })

  it('renames, refusing a taken name but allowing a change of case', () => {
    const t = new TempDir()
    t.write('a.ts', 'A'); t.write('b.ts', 'B')
    expect(FileOps.rename(join(t.path, 'a.ts'), 'b.ts')).toMatchObject({ ok: false })
    expect(readFileSync(join(t.path, 'b.ts'), 'utf8')).toBe('B')
    expect(FileOps.rename(join(t.path, 'a.ts'), 'c.ts')).toEqual({ ok: true, path: join(t.path, 'c.ts') })
    expect(FileOps.rename(join(t.path, 'c.ts'), 'C.ts')).toEqual({ ok: true, path: join(t.path, 'C.ts') })
    expect(FileOps.rename(join(t.path, 'C.ts'), 'x/y')).toMatchObject({ ok: false, error: 'nom invalide' })
    t.dispose()
  })

  it('copies (free names, folders recursive), moves, refuses a folder into itself', () => {
    const t = new TempDir()
    t.write('src/a.ts', 'A'); t.write('src/sub/b.ts', 'B'); t.write('dest/a.ts', 'OLD')
    const src = join(t.path, 'src'), dest = join(t.path, 'dest')
    expect(FileOps.transfer(join(src, 'a.ts'), dest, false)).toEqual({ ok: true, path: join(dest, 'a copie.ts') })
    expect(readFileSync(join(dest, 'a.ts'), 'utf8')).toBe('OLD')
    expect(FileOps.transfer(join(src, 'a.ts'), src, false)).toEqual({ ok: true, path: join(src, 'a copie.ts') })   // duplicate
    expect(FileOps.transfer(join(src, 'sub'), dest, false)).toEqual({ ok: true, path: join(dest, 'sub') })
    expect(readFileSync(join(dest, 'sub', 'b.ts'), 'utf8')).toBe('B')
    expect(FileOps.transfer(src, join(src, 'sub'), false)).toMatchObject({ ok: false, error: expect.stringMatching(/lui-même/) })
    expect(FileOps.transfer(src, src, true)).toMatchObject({ ok: false })
    expect(FileOps.transfer(join(src, 'sub'), dest, true)).toEqual({ ok: true, path: join(dest, 'sub copie') })
    expect(existsSync(join(src, 'sub'))).toBe(false)
    expect(FileOps.transfer(join(src, 'a.ts'), src, true)).toEqual({ ok: true, path: join(src, 'a.ts') })   // move in place: nothing
    expect(FileOps.transfer(join(t.path, 'nope'), dest, false)).toMatchObject({ ok: false })
    expect(FileOps.transfer(join(src, 'a.ts'), join(src, 'a.ts'), false)).toMatchObject({ ok: false })
    expect(readdirSync(dest).sort()).toEqual(['a copie.ts', 'a.ts', 'sub', 'sub copie'])
    t.dispose()
  })

  it('transfers several paths, asking once when names are taken', async () => {
    const t = new TempDir()
    t.write('src/a.ts', 'A'); t.write('src/b.ts', 'B'); t.write('dest/a.ts', 'OLD'); t.write('dest/x/y.ts', 'Y')
    const src = join(t.path, 'src'), dest = join(t.path, 'dest')
    const trashed: string[] = []
    const trash = async (p: string) => { trashed.push(p); rmSync(p, { recursive: true }) }
    const asked: string[][] = []
    const deps = (c: ConflictChoice) => ({ choose: async (taken: string[]) => { asked.push(taken); return c }, trash })
    expect(FileOps.conflicts([join(src, 'a.ts'), join(src, 'b.ts'), join(dest, 'a.ts')], dest)).toEqual([join(src, 'a.ts')])

    expect(await transferAll([join(src, 'a.ts'), join(src, 'b.ts')], dest, false, deps('cancel'))).toEqual([])
    expect(readdirSync(dest).sort()).toEqual(['a.ts', 'x'])
    expect(asked).toEqual([[join(src, 'a.ts')]])

    expect(await transferAll([join(src, 'a.ts')], dest, false, deps('keep'))).toEqual([{ ok: true, path: join(dest, 'a copie.ts') }])

    const r = await transferAll([join(src, 'a.ts'), join(src, 'b.ts')], dest, true, deps('replace'))
    expect(r).toEqual([{ ok: true, path: join(dest, 'a.ts') }, { ok: true, path: join(dest, 'b.ts') }])
    expect(readFileSync(join(dest, 'a.ts'), 'utf8')).toBe('A')
    expect(trashed).toEqual([join(dest, 'a.ts')])
    expect(readdirSync(src)).toEqual([])

    // never a folder that holds the source: dest/x/y.ts moved into dest/x's parent under the name "x" would trash it
    t.write('dest/x/x', 'inner')
    expect(await transferAll([join(dest, 'x', 'x')], dest, true, deps('replace'))).toMatchObject([{ ok: false }])
    expect(existsSync(join(dest, 'x', 'x'))).toBe(true)
    // no conflict, no question
    asked.length = 0
    expect(await transferAll([join(dest, 'b.ts')], src, true, deps('cancel'))).toEqual([{ ok: true, path: join(src, 'b.ts') }])
    expect(asked).toEqual([])
    t.dispose()
  })

  it('undoes renames, moves, creates and copies, newest first, never over a name taken since', async () => {
    const t = new TempDir()
    t.write('a.ts', 'A'); t.write('dir/keep.ts', 'K')
    const trashed: string[] = []
    const log = new UndoLog(async (p) => { trashed.push(p); rmSync(p, { recursive: true }) }, 3)
    const p = (...s: string[]) => join(t.path, ...s)
    expect(log.peek()).toBeNull()
    expect(await log.undo()).toMatchObject({ error: expect.any(String), moved: [] })

    log.push({ kind: 'rename', pairs: [] })   // nothing done: not recorded
    expect(log.peek()).toBeNull()

    const ren = FileOps.rename(p('a.ts'), 'b.ts'); if (!ren.ok) throw new Error()
    log.push({ kind: 'rename', pairs: [[p('a.ts'), ren.path]] })
    const deps = { choose: async () => 'keep' as const, trash: async () => {}, log }
    await transferAll([p('b.ts')], p('dir'), true, deps)
    await transferAll([p('dir', 'keep.ts')], t.path, false, deps)
    expect(log.peek()).toEqual({ kind: 'copy', count: 1, name: 'keep.ts' })

    expect(await log.undo()).toEqual({ moved: [], removed: [p('keep.ts')], dirs: [t.path] })
    expect(trashed).toEqual([p('keep.ts')])
    expect(log.peek()).toEqual({ kind: 'move', count: 1, name: 'b.ts' })
    expect(await log.undo()).toEqual({ moved: [[p('dir', 'b.ts'), p('b.ts')]], removed: [], dirs: [t.path, p('dir')] })
    // the old name is taken again: the rename is not undone
    t.write('a.ts', 'NEW')
    expect(await log.undo()).toMatchObject({ moved: [], error: expect.stringMatching(/existe déjà/) })
    expect(readFileSync(p('b.ts'), 'utf8')).toBe('A')
    expect(log.peek()).toBeNull()

    // bounded: the oldest is dropped
    for (const n of ['1', '2', '3', '4']) log.push({ kind: 'create', paths: [p(n)] })
    expect([await log.undo(), await log.undo(), await log.undo()].map((r) => r.dirs)).toEqual([[t.path], [t.path], [t.path]])
    expect(log.peek()).toBeNull()
    t.dispose()
  })
})
