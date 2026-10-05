import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { RgReader, rgArgs, type ContentQuery, type ContentResult } from '@shared/search'

/** The platform's ripgrep from @vscode/ripgrep's optional packages; unpacked from the asar when packaged. */
export function rgPath(): string | null {
  const bin = `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`
  try { return require.resolve(bin).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') } catch { return null }
}

/** Content search in a project folder; a new search stops the one still running. */
export class ContentSearch {
  private current: ChildProcess | null = null

  run(root: string, q: ContentQuery): Promise<ContentResult> {
    this.current?.kill()
    const reader = new RgReader()
    const rg = rgPath()
    if (!q.query) return Promise.resolve(reader.result())
    if (!rg) return Promise.resolve(reader.result('ripgrep introuvable'))
    return new Promise((resolve) => {
      const p = spawn(rg, rgArgs(q), { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.current = p
      let rest = '', err = ''
      p.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        const lines = (rest + chunk).split('\n')
        rest = lines.pop() ?? ''
        for (const l of lines) reader.line(l)
        if (reader.full) p.kill()
      })
      p.stderr!.setEncoding('utf8').on('data', (c: string) => { err += c })
      p.on('error', (e) => resolve(reader.result(String(e.message))))
      p.on('close', (code) => {
        if (this.current === p) this.current = null
        reader.line(rest)
        // 1: nothing found; 2: some files unreadable, results kept unless the pattern itself is wrong
        const bad = code === 2 && !reader.count ? err.split('\n').find((l) => l.trim()) : undefined
        resolve(reader.result(bad))
      })
    })
  }
}

const IGNORE = new Set(['.git', 'node_modules', '.build', 'dist', 'out', '.next', '.cache', 'DerivedData', '.venv', '__pycache__', 'target', '.gradle'])
const MAX = 40_000

/** File name index per root, rebuilt when older than 20 s. */
export class FileIndex {
  private cache = new Map<string, { at: number; files: string[] }>()

  files(root: string): string[] {
    const c = this.cache.get(root)
    if (c && Date.now() - c.at < 20_000) return c.files
    const files: string[] = []
    const walk = (dir: string, depth: number) => {
      if (files.length >= MAX || depth > 12) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (files.length >= MAX) return
        if (e.isDirectory()) { if (!IGNORE.has(e.name)) walk(join(dir, e.name), depth + 1) }
        else if (e.isFile()) files.push(relative(root, join(dir, e.name)).split(sep).join('/'))  // '/' on every OS: queries and the renderer use it
      }
    }
    walk(root, 0)
    this.cache.set(root, { at: Date.now(), files })
    return files
  }

  /** Fuzzy match on the relative path: every query char in order; shorter paths and basename hits rank first. */
  search(root: string, query: string, limit = 60): string[] {
    const q = query.toLowerCase().replace(/\s+/g, '')
    if (!q) return []
    const scored: [number, string][] = []
    for (const f of this.files(root)) {
      const s = score(f.toLowerCase(), q)
      if (s > 0) scored.push([s, f])
    }
    return scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length).slice(0, limit).map(([, f]) => f)
  }
}

export function score(path: string, q: string): number {
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (base.includes(q)) return 1000 - base.length + (base.startsWith(q) ? 200 : 0)
  if (path.includes(q)) return 500 - path.length
  // subsequence match on the basename only (a query spread over folder names is noise)
  let i = 0, run = 0, best = 0
  for (let j = 0; j < base.length && i < q.length; j++) {
    if (base[j] === q[i]) { i++; run++; best = Math.max(best, run) } else run = 0
  }
  return i === q.length ? 100 + best * 5 - base.length / 10 : 0
}
