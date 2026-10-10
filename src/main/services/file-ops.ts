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
  const replaced: string[] = []
  for (const p of paths) {
    if (replace && taken.includes(p)) {
      const existing = join(destDir, basename(p))
      if (inside(p, existing)) { out.push({ ok: false, error: `« ${basename(existing)} » contient ce qui y va` }); continue }
      try { await deps.trash(existing); replaced.push(existing) } catch (e) { out.push(err(e)); continue }
    }
    const r = FileOps.transfer(p, destDir, move)
    // the replaced item is in the Trash: say so when the move or copy that was to take its place failed
    out.push(!r.ok && replaced.includes(join(destDir, basename(p))) ? { ...r, error: `${r.error} (l'élément remplacé est dans la corbeille)` } : r)
  }
  const rep = replaced.length ? { replaced } : {}
  if (move) deps.log?.push({ kind: 'move', pairs: out.flatMap((r, i): [string, string][] => (r.ok && r.path !== paths[i] ? [[paths[i], r.path]] : [])), ...rep })
  else deps.log?.push({ kind: 'copy', paths: out.flatMap((r) => (r.ok ? [r.path] : [])), ...rep })
  return out
}

/**
 * An explorer operation as the undo log keeps it: renames and moves as (from, to) pairs, what was created as paths with
 * the time it was last changed then (an undo leaves alone what changed since); `replaced`: what the operation sent to the
 * Trash to take its name (an undo cannot bring it back: it says where it is).
 */
export type FileOp =
  | { kind: 'rename' | 'move'; pairs: [string, string][]; replaced?: string[] }
  | { kind: 'create' | 'copy'; paths: string[]; stamps?: number[]; replaced?: string[] }

const stamp = (p: string) => { try { return statSync(p).mtimeMs } catch { return -1 } }
const within = (p: string, root: string) => { const r = relative(root, p); return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r)) }
const pathsOf = (op: FileOp) => ('pairs' in op ? op.pairs.flat() : op.paths)

/**
 * The last explorer operations, undone newest first, for the tree they were made in (an explorer undoes its own, not
 * another project's): a rename or a move goes back (never over a name taken since), what a create or a copy made goes to
 * the Trash unless it changed since. A deletion is not here: it already went to the Trash.
 */
export class UndoLog {
  private ops: FileOp[] = []
  constructor(private trash: (path: string) => Promise<void>, private max = 30) {}

  push(op: FileOp) {
    const n = 'pairs' in op ? op.pairs.length : op.paths.length
    if (!n) return
    if ('paths' in op) op = { ...op, stamps: op.paths.map(stamp) }
    this.ops.push(op)
    if (this.ops.length > this.max) this.ops.shift()
  }

  /** the newest operation made under `root` (every path of it), when a root is given */
  private last(root?: string): number {
    for (let i = this.ops.length - 1; i >= 0; i--) if (!root || pathsOf(this.ops[i]).every((p) => within(p, root))) return i
    return -1
  }

  peek(root?: string): UndoInfo | null {
    const op = this.ops[this.last(root)]
    if (!op) return null
    const list = 'pairs' in op ? op.pairs.map(([from]) => from) : op.paths
    return { kind: op.kind, count: list.length, name: basename(list[0]) }
  }

  async undo(root?: string): Promise<UndoResult> {
    const i = this.last(root)
    if (i < 0) return { moved: [], removed: [], dirs: [], error: 'rien à annuler' }
    const [op] = this.ops.splice(i, 1)
    const replacedNote = op.replaced?.length ? ` ; remplacé avant, à la corbeille : ${op.replaced.map((p) => basename(p)).join(', ')}` : ''
    if ('paths' in op) {
      const removed: string[] = [], kept: string[] = []
      for (const [k, p] of op.paths.entries()) {
        if (!existsSync(p)) continue
        if (op.stamps && stamp(p) !== op.stamps[k]) { kept.push(basename(p)); continue }
        try { await this.trash(p); removed.push(p) } catch (e) { kept.push(`${basename(p)} (${String((e as Error)?.message ?? e)})`) }
      }
      const error = kept.length ? `modifié depuis ou impossible à mettre à la corbeille, laissé : ${kept.join(', ')}` : undefined
      return { moved: [], removed, dirs: [...new Set(op.paths.map((p) => dirname(p)))], ...(error || replacedNote ? { error: (error ?? 'annulé') + replacedNote } : {}) }
    }
    const moved: [string, string][] = []
    const dirs = [...new Set(op.pairs.flatMap(([from, to]) => [dirname(from), dirname(to)]))]
    const stop = (error: string): UndoResult => ({ moved, removed: [], dirs, error: error + replacedNote })
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
    return { moved, removed: [], dirs, ...(replacedNote ? { error: 'annulé' + replacedNote } : {}) }
  }
}
