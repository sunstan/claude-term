/**
 * The Mémo of a project (pure, tested): links (name + URL), personal notes (Markdown files kept in the app's data)
 * and project files pinned for quick access. Machine-specific, so never written in the project.
 */

export interface MemoLink { name: string; url: string }
export interface MemoNote { name: string; path: string }
/** A project file pinned in the Mémo; `exists` false once it was moved or deleted */
export interface MemoPin { path: string; exists: boolean }
export interface ProjectMemo { root: string; links: MemoLink[]; notes: MemoNote[]; pins: MemoPin[] }

/**
 * What the user typed as a link's URL: trimmed, `https://` added when there is no scheme, a mail address as mailto:.
 * null for anything that would not open in the browser or the mail app (file:, javascript:, custom schemes).
 */
export function normalizeUrl(input: string): string | null {
  const s = input.trim()
  if (!s || /\s/.test(s)) return null
  if (/^[^@/:\s]+@[^@/:\s]+\.[^@/:\s]+$/.test(s)) return 'mailto:' + s
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  // host:port (localhost:3000) reads as a scheme: only http(s) and mailto are schemes here
  const url = scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? s : scheme && !/^\d/.test(s.slice(scheme.length + 1)) ? null : 'https://' + s
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol === 'mailto:') return u.pathname ? url : null
    return u.hostname ? url : null
  } catch { return null }
}

/** A link's name when the user gave none: the host without www. (the address for mailto:). */
export function defaultLinkName(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'mailto:') return decodeURIComponent(u.pathname)
    return u.hostname.replace(/^www\./, '') + (u.port ? ':' + u.port : '')
  } catch { return url }
}

/** A note's name as a file name: characters no file system takes are dropped, `.md` added. null when nothing is left. */
export function noteFileName(name: string): string | null {
  const base = name.trim().replace(/\.md$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^\.+/, '').trim().slice(0, 120)
  return base ? base + '.md' : null
}

/** The name shown for a note file. */
export const noteName = (file: string): string => (file.split(/[\\/]/).pop() ?? file).replace(/\.md$/i, '')

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/** Whether `text` contains every word of the filter (case and accents ignored). */
export function matchesFilter(text: string, filter: string): boolean {
  const t = fold(text)
  return fold(filter).split(/\s+/).filter(Boolean).every((w) => t.includes(w))
}
