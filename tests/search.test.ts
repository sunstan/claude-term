import { describe, it, expect, afterEach } from 'vitest'
import { charOffset, rgArgs, RgReader, MAX_MATCHES } from '../src/shared/search'
import { ContentSearch, rgPath } from '../src/main/services/search'
import { TempDir } from './helpers'

describe('content search: ripgrep arguments and output', () => {
  it('builds the command line from the options', () => {
    const a = rgArgs({ query: 'foo(', include: 'src/**, *.ts', exclude: 'dist' })
    expect(a).toEqual(expect.arrayContaining(['--json', '--fixed-strings', '--ignore-case', '--hidden', '--no-require-git']))
    expect(a.slice(-4)).toEqual(['--regexp', 'foo(', '--', '.'])
    expect(a.join(' ')).toContain('--glob !.git --glob src/** --glob *.ts --glob !dist')
    const b = rgArgs({ query: 'a.b', regex: true, caseSensitive: true, wholeWord: true })
    expect(b).toEqual(expect.arrayContaining(['--case-sensitive', '--word-regexp']))
    expect(b).not.toContain('--fixed-strings')
  })

  it('maps UTF-8 byte offsets to character offsets', () => {
    expect(charOffset('abc', 2)).toBe(2)
    expect(charOffset('été x', 5)).toBe(3)       // é is 2 bytes
    expect(charOffset('😀a', 4)).toBe(2)         // a surrogate pair is 4 bytes, 2 UTF-16 units
    expect(charOffset('ab', 10)).toBe(2)
  })

  it('groups matches by file with relative "/" paths', () => {
    const r = new RgReader()
    const m = (path: string, line: number, text: string, start: number, end: number) =>
      JSON.stringify({ type: 'match', data: { path: { text: path }, lines: { text: text + '\n' }, line_number: line, submatches: [{ match: { text: 'x' }, start, end }] } })
    r.line(JSON.stringify({ type: 'begin', data: { path: { text: './a.ts' } } }))
    r.line(m('./src/a.ts', 3, 'const été = foo', 14, 17))   // bytes: é takes 2
    r.line(m('.\\src\\b.ts', 1, 'foo', 0, 3))
    r.line(m('./src/a.ts', 9, 'foo()', 0, 3))
    r.line('not json')
    const res = r.result()
    expect(res.count).toBe(3)
    expect(res.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(res.files[0].matches[0]).toEqual({ line: 3, text: 'const été = foo', ranges: [[12, 15]] })
    expect(res.truncated).toBe(false)
  })

  it('stops at the cap', () => {
    const r = new RgReader()
    const line = JSON.stringify({ type: 'match', data: { path: { text: 'a' }, lines: { text: 'x' }, line_number: 1, submatches: [] } })
    for (let i = 0; i < MAX_MATCHES + 5; i++) r.line(line)
    expect(r.result()).toMatchObject({ count: MAX_MATCHES, truncated: true })
  })
})

describe('content search in a folder (the bundled ripgrep)', () => {
  let t: TempDir
  afterEach(() => t?.dispose())

  it('finds text, follows .gitignore, searches dotfiles but not .git', async () => {
    expect(rgPath()).toBeTruthy()
    t = new TempDir()
    t.write('src/a.ts', 'export const needle = 1\nconst NEEDLE = 2\n')
    t.write('.github/ci.yml', 'needle: yes\n')
    t.write('ignored/x.ts', 'needle\n')
    t.write('.gitignore', 'ignored/\n')
    t.write('.git/config', 'needle\n')
    const s = new ContentSearch()
    const r = await s.run(t.path, { query: 'needle' })
    expect(r.files.map((f) => f.path).sort()).toEqual(['.github/ci.yml', 'src/a.ts'])
    expect(r.count).toBe(3)
    const cs = await s.run(t.path, { query: 'needle', caseSensitive: true, include: '*.ts' })
    expect(cs.files.map((f) => [f.path, f.matches.map((m) => m.line)])).toEqual([['src/a.ts', [1]]])
    const re = await s.run(t.path, { query: 'NEED(LE', regex: true })
    expect(re.error).toBeTruthy()
  })
})
