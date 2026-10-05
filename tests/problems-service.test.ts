import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { ProblemsService } from '../src/main/services/problems'

const fsApi = { exists: (p: string) => existsSync(p), read: (p: string) => readFileSync(p, 'utf8'), list: (p: string) => { try { return readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })) } catch { return [] } } }

describe('problems service', () => {
  it('runs the project\'s own tsc on each tsconfig that compiles something', async () => {
    const t = new TempDir()
    t.write('package.json', JSON.stringify({ name: 'demo' }))
    t.write('tsconfig.json', JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }))   // solution file: skipped
    t.write('tsconfig.app.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }))
    t.write('src/a.ts', 'const n: number = "x"\nexport {}\n')
    symlinkSync(join(__dirname, '..', 'node_modules'), join(t.path, 'node_modules'), 'junction')
    const s = new ProblemsService(fsApi, () => process.env)
    const r = await s.check(t.path)
    expect(r.tools).toEqual([{ tool: 'tsc', dir: t.path, config: 'tsconfig.app.json', ok: true }])
    expect(r.diagnostics).toEqual([expect.objectContaining({ file: join(t.path, 'src', 'a.ts'), line: 1, col: 7, severity: 'error', code: 'TS2322', source: 'tsc' })])
    t.dispose()
  }, 60_000)

  it('no checker installed: no tools, no diagnostics; finds todos in text files, skipping node_modules', async () => {
    const t = new TempDir()
    t.write('tsconfig.json', '{}')
    t.write('src/a.ts', '// TODO: first\nconst x = 1\n')
    t.write('README.md', '- TODO document\n')
    t.write('node_modules/lib/b.js', '// TODO not mine')
    t.write('package-lock.json', '"TODO"')
    const s = new ProblemsService(fsApi, () => process.env)
    expect(await s.check(t.path)).toMatchObject({ diagnostics: [], tools: [] })
    expect(s.todos(t.path).map((x) => [x.file.slice(t.path.length).replace(/\\/g, '/'), x.line, x.text]).sort()).toEqual([['/README.md', 1, 'document'], ['/src/a.ts', 1, 'first']])
    t.dispose()
  })
})

describe('problems service queue', () => {
  it('a request during another project\'s check gets its own project, identical waiting requests are shared', async () => {
    const s = new ProblemsService(fsApi, () => process.env)
    const order: string[] = []
    ;(s as any).run = async (root: string) => { order.push('start ' + root); await new Promise((r) => setTimeout(r, 30)); order.push('end ' + root); return { at: 0, diagnostics: [{ file: root }], tools: [] } }
    const a = s.check('/a'), b1 = s.check('/b'), b2 = s.check('/b')
    expect(b1).toBe(b2)
    expect((await a).diagnostics[0].file).toBe('/a')
    expect((await b1).diagnostics[0].file).toBe('/b')
    expect(order).toEqual(['start /a', 'end /a', 'start /b', 'end /b'])
    // once started, a new request for the same root queues a fresh check (the files may have changed since)
    const c = s.check('/b')
    expect(c).not.toBe(b1)
    expect((await c).diagnostics[0].file).toBe('/b')
  })
})
