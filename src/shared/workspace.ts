/**
 * The tabs reopened at the next launch (pure, tested): Claude tabs resume their session, shells reopen in their folder
 * with their last lines shown again, files reopen; diff tabs are left out. Kept in the app's data.
 */

export interface SavedTab {
  kind: 'claude' | 'shell' | 'file'
  cwd: string
  /** the title shown (the session's, the folder's, the file's name) */
  title: string
  customTitle?: string
  /** Claude: the session to resume */
  session?: string
  /** file tabs */
  path?: string
  /** shells: key of the saved scrollback (userData/scrollback/<key>.txt) */
  scrollback?: string
  /** shells: the command running at quit, typed again (not run) */
  input?: string
}
export interface SavedProject { root: string; tabs: SavedTab[]; current: number }
export interface SavedWorkspace { projects: SavedProject[]; active: string | null }

/** What a tab carries that matters here (the renderer's Tab). */
export interface TabLike {
  id: string
  kind: string
  cwd: string
  title: string
  customTitle?: string
  path?: string
  busy: boolean
  lastCommand: string
  claudeRunning: boolean
  session?: { sessionId?: string | null }
  /** a restored tab not shown yet: what it reopens with */
  dormant?: { session?: string; scrollback?: string; input?: string }
}

/** A tab as saved; null for the ones not reopened (diffs). `scrollback`: the key its shell's lines are saved under. */
export function savedTab(t: TabLike, scrollback?: string): SavedTab | null {
  const base = { cwd: t.cwd, title: t.title, ...(t.customTitle ? { customTitle: t.customTitle } : {}) }
  if (t.kind === 'file') return t.path ? { kind: 'file', ...base, path: t.path } : null
  if (t.kind === 'claude') {
    const session = t.session?.sessionId ?? t.dormant?.session
    return { kind: 'claude', ...base, ...(session ? { session } : {}) }
  }
  if (t.kind !== 'shell') return null
  // a command still running (a dev server, `claude` typed in the shell) is typed again, not run
  const input = t.dormant ? t.dormant.input : t.busy || t.claudeRunning ? t.lastCommand.trim() || undefined : undefined
  const key = t.dormant ? t.dormant.scrollback : scrollback
  return { kind: 'shell', ...base, ...(key ? { scrollback: key } : {}), ...(input ? { input } : {}) }
}

/** The last `max` lines of a terminal's text, trailing blank lines dropped. */
export function lastLines(lines: string[], max = 1000): string {
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  return lines.slice(Math.max(0, end - max), end).map((l) => l.replace(/\s+$/, '')).join('\n')
}

/** A scrollback key the main process accepts (no path in it). */
export const isScrollbackKey = (k: unknown): k is string => typeof k === 'string' && /^[\w-]{1,64}$/.test(k)
