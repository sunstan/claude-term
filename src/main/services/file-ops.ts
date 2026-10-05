import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, isAbsolute } from 'node:path'
import type { UndoInfo, UndoResult } from '@shared/ipc'

export type OpResult = { ok: true; path: string } | { ok: false; error: string }

/** "a.ts" → "a copie.ts", then "a copie 2.ts"… (Finder's French naming), the first free name in `dir` */
export function freeName(dir: string, name: string, exists: (p: string) => boolean): string {
  if (!exists(join(dir, name))) return name
  const ext = name.startsWith('.') && !name.slice(1).includes('.') ? '' : extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let i = 1; ; i++) { const n = `${stem} copie${i > 1 ? ' ' + i : ''}${ext}`; if (!exists(join(dir, n))) return n }
}

const inside = (child: string, parent: string) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }
const validName = (n: string) => !!n && !/[\\/]/.test(n) && n !== '.' && n !== '..'
const err = (e: unknown): OpResult => ({ ok: false, error: String((e as Error)?.message ?? e) })

/**
 * File management of the explorer (main side). Never overwrites: a name already taken is refused (create, rename),
 * a copy gets a free name; a folder cannot go into itself. Deletion is not here: it goes to the Trash (shell.trashItem).
 */
export const FileOps = {
  create(dir: string, name: string, folder: boolean): OpResult {
    if (!validName(name)) return { ok: false, error: 'nom invalide' }
    const p = join(dir, name)
    if (existsSync(p)) return { ok: false, error: `« ${name} » existe déjà` }
    try { if (folder) mkdirSync(p); else { mkdirSync(dir, { recursive: true }); writeFileSync(p, '', { flag: 'wx' }) } return { ok: true, path: p } } catch (e) { return err(e) }
  },

  rename(path: string, name: string): OpResult {
    if (!validName(name)) return { ok: false, error: 'nom invalide' }
    const to = join(dirname(path), name)
    if (to === path) return { ok: true, path }
    // a change of case only is allowed on case-insensitive disks (macOS, Windows)
    if (existsSync(to) && name.toLowerCase() !== basename(path).toLowerCase()) return { ok: false, error: `« ${name} » existe déjà` }
    try { renameSync(path, to); return { ok: true, path: to } } catch (e) { return err(e) }
  },

  /**
   * The sources whose name is already taken in `destDir`. A move within its own folder does nothing and a copy there
   * is a duplicate, so neither conflicts.
   */
  conflicts(paths: string[], destDir: string): string[] {
    return paths.filter((p) => dirname(p) !== destDir && existsSync(join(destDir, basename(p))))
  },

  /** copy (or move) `src` into the folder `destDir`; a copy in the same folder, or a taken name, gets "copie" */
  transfer(src: string, destDir: string, move: boolean): OpResult {
    try {
      if (!existsSync(src)) return { ok: false, error: 'introuvable : ' + basename(src) }
      if (!statSync(destDir).isDirectory()) return { ok: false, error: "la destination n'est pas un dossier" }
      if (statSync(src).isDirectory() && inside(destDir, src)) return { ok: false, error: 'un dossier ne peut pas aller dans lui-même' }
      if (move && dirname(src) === destDir) return { ok: true, path: src }
      const to = join(destDir, freeName(destDir, basename(src), existsSync))
      if (move) { try { renameSync(src, to) } catch { cpSync(src, to, { recursive: true, errorOnExist: true, force: false }); rmSync(src, { recursive: true }) } }
      else cpSync(src, to, { recursive: true, errorOnExist: true, force: false })
      return { ok: true, path: to }
    } catch (e) { return err(e) }
  },
}

export type ConflictChoice = 'replace' | 'keep' | 'cancel'

/**
 * Copies or moves `paths` into `destDir`. Names already taken there are `choose`n once for all: replace (the existing
 * items go to `trash` first; never a folder holding the source), keep both (free names), or cancel (nothing done,
 * no result). Recorded in `log` for undo.
 */
export async function transferAll(paths: string[], destDir: string, move: boolean,
  deps: { choose(taken: string[]): Promise<ConflictChoice>; trash(path: string): Promise<void>; log?: UndoLog }): Promise<OpResult[]> {
  const taken = FileOps.conflicts(paths, destDir)
  let replace = false
  if (taken.length) {
    const c = await deps.choose(taken)
    if (c === 'cancel') return []
    replace = c === 'replace'
  }
  const out: OpResult[] = []
  for (const p of paths) {
    if (replace && taken.includes(p)) {
      const existing = join(destDir, basename(p))
      if (inside(p, existing)) { out.push({ ok: false, error: `« ${basename(existing)} » contient ce qui y va` }); continue }
      try { await deps.trash(existing) } catch (e) { out.push(err(e)); continue }
    }
    out.push(FileOps.transfer(p, destDir, move))
  }
  if (move) deps.log?.push({ kind: 'move', pairs: out.flatMap((r, i): [string, string][] => (r.ok && r.path !== paths[i] ? [[paths[i], r.path]] : [])) })
  else deps.log?.push({ kind: 'copy', paths: out.flatMap((r) => (r.ok ? [r.path] : [])) })
  return out
}

/** An explorer operation as the undo log keeps it: renames and moves as (from, to) pairs, what was created as paths. */
export type FileOp =
  | { kind: 'rename' | 'move'; pairs: [string, string][] }
  | { kind: 'create' | 'copy'; paths: string[] }

/**
 * The last explorer operations, undone newest first: a rename or a move goes back (never over a name taken since),
 * what a create or a copy made goes to the Trash. A deletion is not here: it already went to the Trash.
 */
export class UndoLog {
  private ops: FileOp[] = []
  constructor(private trash: (path: string) => Promise<void>, private max = 30) {}

  push(op: FileOp) {
    const n = 'pairs' in op ? op.pairs.length : op.paths.length
    if (!n) return
    this.ops.push(op)
    if (this.ops.length > this.max) this.ops.shift()
  }

  peek(): UndoInfo | null {
    const op = this.ops.at(-1)
    if (!op) return null
    const list = 'pairs' in op ? op.pairs.map(([from]) => from) : op.paths
    return { kind: op.kind, count: list.length, name: basename(list[0]) }
  }

  async undo(): Promise<UndoResult> {
    const op = this.ops.pop()
    if (!op) return { moved: [], removed: [], dirs: [], error: 'rien à annuler' }
    if ('paths' in op) {
      const removed: string[] = []
      for (const p of op.paths) if (existsSync(p)) { await this.trash(p); removed.push(p) }
      return { moved: [], removed, dirs: [...new Set(op.paths.map((p) => dirname(p)))] }
    }
    const moved: [string, string][] = []
    const dirs = [...new Set(op.pairs.flatMap(([from, to]) => [dirname(from), dirname(to)]))]
    const stop = (error: string): UndoResult => ({ moved, removed: [], dirs, error })
    for (const [from, to] of [...op.pairs].reverse()) {
      if (!existsSync(to)) return stop('introuvable : ' + basename(to))
      // a change of case only (rename) finds `from` there on case-insensitive disks
      if (existsSync(from) && from.toLowerCase() !== to.toLowerCase()) return stop(`« ${basename(from)} » existe déjà`)
      if (!existsSync(dirname(from))) return stop('dossier introuvable : ' + dirname(from))
      try {
        try { renameSync(to, from) } catch { cpSync(to, from, { recursive: true, errorOnExist: true, force: false }); rmSync(to, { recursive: true }) }
      } catch (e) { return stop(String((e as Error)?.message ?? e)) }
      moved.push([to, from])
    }
    return { moved, removed: [], dirs }
  }
}
