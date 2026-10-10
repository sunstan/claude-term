/** Escapes a path the way a terminal drag-and-drop does (backslash before shell-special characters). */
export function shellEscapePath(p: string): string {
  return p.replace(/([ '"()\[\]&;$<>|`\\*?{}~#!])/g, '\\$1')
}

/**
 * A Windows path as Windows Terminal drops it: as is, in double quotes when it has a space or a shell-special character.
 * PowerShell expands $ and ` inside double quotes: such a path goes in single quotes (a ' in it doubled).
 */
export function windowsQuotePath(p: string): string {
  if (/[$`]/.test(p)) return `'${p.replace(/'/g, "''")}'`
  return /[\s'"()&;<>|{}@,]/.test(p) ? `"${p}"` : p
}

/** How the shells of the tabs read a path: POSIX (macOS, Linux), Windows (PowerShell, claude.exe), or WSL (bash / zsh fed Windows paths). */
export type PathShell = 'posix' | 'windows' | 'wsl'
export const pathShell = (platform: string, windowsMode?: 'native' | 'wsl'): PathShell =>
  platform !== 'win32' ? 'posix' : windowsMode === 'wsl' ? 'wsl' : 'windows'

/** A Windows path as WSL sees it: C:\x → /mnt/c/x, \\wsl$\<distro>\x (or \\wsl.localhost) → /x; anything else unchanged. */
export function wslPath(p: string): string {
  const drive = p.match(/^([A-Za-z]):(?:[\\/](.*))?$/)
  if (drive) return `/mnt/${drive[1].toLowerCase()}` + (drive[2] ? '/' + drive[2].replace(/\\/g, '/').replace(/\/$/, '') : '')
  const unc = p.match(/^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/i)
  if (unc) return (unc[1] ?? '/').replace(/\\/g, '/')
  return p
}

/** A path reported from WSL as Windows names it: /mnt/c/x → C:\x; other Linux paths under \\wsl$\<distro> when the distribution is known. */
export function windowsPathFromWsl(p: string, distro?: string): string {
  const m = p.match(/^\/mnt\/([a-z])(\/.*)?$/i)
  if (m) return `${m[1].toUpperCase()}:` + (m[2] ? m[2].replace(/\//g, '\\') : '\\')
  if (p.startsWith('/') && distro) return `\\\\wsl$\\${distro}` + p.replace(/\//g, '\\')
  return p
}

/** Paths typed into a terminal for a prompt or a command, separated and followed by a space. */
export function pathsForPrompt(paths: string[], shell: PathShell = 'posix'): string {
  const one = shell === 'windows' ? windowsQuotePath : shell === 'wsl' ? (p: string) => shellEscapePath(wslPath(p)) : shellEscapePath
  return paths.map(one).join(' ') + ' '
}

/**
 * Local path of an OSC 7 report (`file://host/path`, percent-encoded). Windows drive paths come as `/C:/x`
 * (PowerShell's integration) and are given back as `C:\x`; POSIX paths (macOS, Linux, WSL) are kept.
 */
export function pathFromFileUri(uri: string): string | null {
  const m = uri.match(/^file:\/\/[^/]*(\/.*)$/)
  if (!m) return null
  let p = m[1]
  try { p = decodeURIComponent(p) } catch { /* not encoded */ }
  return /^\/[A-Za-z]:(\/|$)/.test(p) ? (p.slice(1).replace(/\//g, '\\') + (p.length === 3 ? '\\' : '')) : p
}
