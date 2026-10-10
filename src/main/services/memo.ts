import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { noteFileName, noteName, normalizeUrl, type MemoLink, type ProjectMemo } from '@shared/memo'

interface Entry { links: MemoLink[]; pins: string[] }

/**
 * The Mémo of each project, kept in the app's data (never in the project): `userData/memo.json` holds the links and
 * the pinned files by project root, `userData/memo/<key>/` the project's notes as Markdown files the editor opens.
 */
export class MemoStore {
  readonly index: string
  constructor(private base: string, private trash: (path: string) => Promise<void>) { this.index = join(base, 'memo.json') }

  private all(): Record<string, Entry> { try { return JSON.parse(readFileSync(this.index, 'utf8')) } catch { return {} } }
  private write(all: Record<string, Entry>) { mkdirSync(dirname(this.index), { recursive: true }); writeFileSync(this.index, JSON.stringify(all, null, 2)) }
  private entry(all: Record<string, Entry>, root: string): Entry { return (all[root] ??= { links: [], pins: [] }) }

  /** Folder of a project's notes. */
  dir(root: string) { return join(this.base, 'memo', createHash('sha1').update(root).digest('hex').slice(0, 16)) }

  load(root: string): ProjectMemo {
    const e = this.all()[root] ?? { links: [], pins: [] }
    const dir = this.dir(root)
    let files: string[] = []
    try { files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort((a, b) => noteName(a).localeCompare(noteName(b), undefined, { numeric: true })) } catch { /* no notes yet */ }
    return {
      root,
      links: e.links,
      notes: files.map((f) => ({ name: noteName(f), path: join(dir, f) })),
      pins: e.pins.map((p) => ({ path: p, exists: existsSync(p) })),
    }
  }

  /** Every project with something in its Mémo (the right panel), links first then notes and pins. */
  list(): ProjectMemo[] {
    return Object.keys(this.all()).map((root) => this.load(root)).filter((m) => m.links.length || m.notes.length || m.pins.length)
  }

  /** Links as the island orders them; URLs are checked again here (http, https and mailto only). */
  saveLinks(root: string, links: MemoLink[]) {
    const clean = links.flatMap((l) => {
      const url = typeof l?.url === 'string' ? normalizeUrl(l.url) : null
      return url ? [{ name: String(l.name ?? '').trim().slice(0, 200) || url, url }] : []
    })
    const all = this.all()
    this.entry(all, root).links = clean
    this.write(all)
  }

  /** Pins: files of the project or of anywhere on disk, by absolute path, in the island's order. */
  savePins(root: string, pins: string[]) {
    const all = this.all()
    this.entry(all, root).pins = [...new Set(pins.filter((p) => typeof p === 'string' && isAbsolute(p)))]
    this.write(all)
  }

  /** A new note `<name>.md` (a free name when taken); its path, to open it in the editor. */
  newNote(root: string, name: string): string {
    const file = noteFileName(name)
    if (!file) throw new Error('nom de note invalide')
    const dir = this.dir(root)
    mkdirSync(dir, { recursive: true })
    let p = join(dir, file)
    for (let i = 2; existsSync(p); i++) p = join(dir, file.replace(/\.md$/, ` ${i}.md`))
    writeFileSync(p, `# ${noteName(p)}\n\n`)
    // the project is listed in the index even with notes only, so the right panel finds it
    const all = this.all()
    this.entry(all, root)
    this.write(all)
    return p
  }

  renameNote(root: string, path: string, name: string): string {
    this.own(root, path)
    const file = noteFileName(name)
    if (!file) throw new Error('nom de note invalide')
    const to = join(this.dir(root), file)
    if (to === path) return path
    if (existsSync(to) && to.toLowerCase() !== path.toLowerCase()) throw new Error('une note porte déjà ce nom')
    renameSync(path, to)
    return to
  }

  async deleteNote(root: string, path: string) {
    this.own(root, path)
    await this.trash(path)
  }

  /** A note path the renderer names must be one of this project's notes. */
  private own(root: string, path: string) {
    const rel = relative(this.dir(root), path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || /[\\/]/.test(rel) || !rel.toLowerCase().endsWith('.md') || !existsSync(path)) throw new Error('note introuvable')
  }
}
