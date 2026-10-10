import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DirEntry } from '@shared/ipc'

const NUL = '\0'

/**
 * The names in `dir` that git ignores. A tracked file never is, even when a pattern matches it; outside a repository,
 * or without git, none is (exit 128).
 */
export function ignoredNames(dir: string, names: string[], env?: NodeJS.ProcessEnv): Promise<Set<string>> {
  if (!names.length) return Promise.resolve(new Set())
  return new Promise((resolve) => {
    let out = ''
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: dir, env, windowsHide: true })
    const timer = setTimeout(() => child.kill(), 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { out += c })
    child.on('error', () => { clearTimeout(timer); resolve(new Set()) })
    // 0: some ignored, 1: none, 128: not a repository
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? new Set(out.split(NUL).filter(Boolean)) : new Set()) })
    child.stdin.on('error', () => { /* git gone before reading */ })
    child.stdin.end(names.join(NUL) + NUL)
  })
}

/** Whether `dir` is in a git repository (a .git above it); a yes is remembered, a no is checked again (a later git init). */
const inRepo = new Set<string>()
export function inRepository(dir: string): boolean {
  if (inRepo.has(dir)) return true
  const up = dirname(dir)
  const v = existsSync(join(dir, '.git')) || (up !== dir && inRepository(up))
  if (v) inRepo.add(dir)
  return v
}

/**
 * What git ignores in a folder, reused for a few seconds when its names did not change: a build or Claude's edits
 * reload the tree many times in a row, each reload would start git again.
 */
const ignoredCache = new Map<string, { names: string; at: number; set: Promise<Set<string>> }>()
function ignoredCached(dir: string, names: string[], env?: NodeJS.ProcessEnv): Promise<Set<string>> {
  if (!inRepository(dir)) return Promise.resolve(new Set())
  const key = names.join(NUL), hit = ignoredCache.get(dir)
  if (hit && hit.names === key && Date.now() - hit.at < 5000) return hit.set
  const set = ignoredNames(dir, names, env)
  ignoredCache.set(dir, { names: key, at: Date.now(), set })
  if (ignoredCache.size > 500) ignoredCache.delete(ignoredCache.keys().next().value!)
  return set
}

/**
 * A folder's entries, folders first, then by name. With `marks`: what git ignores, and the folders Claude Code has
 * sessions for (`hasSessions`).
 */
export async function listDir(path: string, o: { marks?: boolean; env?: NodeJS.ProcessEnv; hasSessions?: (dir: string) => boolean } = {}): Promise<DirEntry[]> {
  let entries: DirEntry[]
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .map((d) => {
        let isDir = d.isDirectory()
        if (d.isSymbolicLink()) { try { isDir = statSync(join(path, d.name)).isDirectory() } catch { /* dangling */ } }
        return { name: d.name, path: join(path, d.name), isDir, hidden: d.name.startsWith('.') }
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1))
  } catch { return [] }
  if (!o.marks) return entries
  // .git is git's own folder, never reported by check-ignore; folders go with a trailing slash so that "dir/"
  // patterns match them
  const ignored = await ignoredCached(path, entries.filter((e) => e.name !== '.git').map((e) => e.isDir ? e.name + '/' : e.name), o.env)
  return entries.map((e) => ({
    ...e,
    ...(ignored.has(e.name) || ignored.has(e.name + '/') ? { ignored: true } : {}),
    ...(e.isDir && o.hasSessions?.(e.path) ? { sessions: true } : {}),
  }))
}
