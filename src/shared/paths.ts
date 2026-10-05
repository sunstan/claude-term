/** Escapes a path the way a terminal drag-and-drop does (backslash before shell-special characters). */
export function shellEscapePath(p: string): string {
  return p.replace(/([ '"()\[\]&;$<>|`\\*?{}~#!])/g, '\\$1')
}

/** A Windows path as Windows Terminal drops it: as is, in double quotes when it has a space or a shell-special character. */
export function windowsQuotePath(p: string): string {
  return /[\s'"()&;$<>|`{}@,]/.test(p) ? `"${p}"` : p
}

/** Paths typed into a terminal for a prompt or a command, separated and followed by a space. */
export function pathsForPrompt(paths: string[], windows = false): string {
  return paths.map(windows ? windowsQuotePath : shellEscapePath).join(' ') + ' '
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
