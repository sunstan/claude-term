/** Content search with ripgrep (pure, tested): the command line and the reading of its JSON output. */

export interface ContentQuery {
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  /** globs, comma-separated as typed ("src/**, *.ts"); exclude ones are negated */
  include?: string
  exclude?: string
}

export interface ContentMatch { line: number; text: string; ranges: [number, number][] }
export interface ContentFile { path: string; matches: ContentMatch[] }
export interface ContentResult { files: ContentFile[]; count: number; truncated: boolean; error?: string }

export const MAX_MATCHES = 2000
const MAX_LINE = 300

const globs = (s: string | undefined) => (s ?? '').split(',').map((g) => g.trim()).filter(Boolean)

/**
 * Arguments for `rg` run in the project folder. It follows .gitignore (git repository or not), searches dotfiles but
 * not .git, skips files over 1 MB and binaries; the explicit "." keeps rg from reading stdin.
 */
export function rgArgs(q: ContentQuery): string[] {
  return [
    '--json', '--hidden', '--no-require-git', '--max-filesize', '1M', '--max-columns', String(MAX_LINE), '--max-columns-preview',
    q.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(q.wholeWord ? ['--word-regexp'] : []),
    ...(q.regex ? [] : ['--fixed-strings']),
    '--glob', '!.git',
    ...globs(q.include).flatMap((g) => ['--glob', g]),
    ...globs(q.exclude).flatMap((g) => ['--glob', '!' + g]),
    '--regexp', q.query, '--', '.',
  ]
}

/** A UTF-8 byte offset of `text` as a character (UTF-16) offset. */
export function charOffset(text: string, byte: number): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byte) return i
    const c = text.codePointAt(i)!
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
    if (c >= 0x10000) i++
  }
  return text.length
}

/** Folds rg's JSON lines into files and matches (paths relative, with "/"); stops counting at MAX_MATCHES. */
export class RgReader {
  private byPath = new Map<string, ContentFile>()
  count = 0

  get full() { return this.count >= MAX_MATCHES }

  line(json: string) {
    if (this.full || !json.trim()) return
    let o: any
    try { o = JSON.parse(json) } catch { return }
    if (o?.type !== 'match') return
    const d = o.data
    const path = typeof d?.path?.text === 'string' ? d.path.text.replace(/\\/g, '/').replace(/^\.\//, '') : null
    const text = typeof d?.lines?.text === 'string' ? d.lines.text.replace(/\r?\n$/, '') : null
    if (!path || text === null || typeof d.line_number !== 'number') return
    const ranges = (Array.isArray(d.submatches) ? d.submatches : []).map((s: any): [number, number] => [charOffset(text, s.start), charOffset(text, s.end)])
    let f = this.byPath.get(path)
    if (!f) this.byPath.set(path, (f = { path, matches: [] }))
    f.matches.push({ line: d.line_number, text: text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text, ranges })
    this.count++
  }

  /** Files by path (rg's threads report them in any order), matches by line. */
  result(error?: string): ContentResult {
    const files = [...this.byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    for (const f of files) f.matches.sort((a, b) => a.line - b.line)
    return { files, count: this.count, truncated: this.full, ...(error ? { error } : {}) }
  }
}
