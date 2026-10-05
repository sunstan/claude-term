/**
 * Command lines typed into a terminal tab, per shell dialect (pure, tested). Plugins pass argv arrays; the app
 * quotes and chains them for the tab's shell: POSIX (zsh, bash, WSL) or Windows PowerShell 5.1 (native Windows).
 */
import { PS_CLEAR_LINE } from './powershell'

export type Dialect = 'posix' | 'powershell'

export const dialectFor = (platform: string, windowsMode: 'native' | 'wsl'): Dialect =>
  platform === 'win32' && windowsMode !== 'wsl' ? 'powershell' : 'posix'

const POSIX_BARE = /^[A-Za-z0-9_\-./:=@%+,]+$/
// no leading @ (splatting) nor commas (arrays) in PowerShell
const PS_BARE = /^[A-Za-z0-9_\-./:=%+]+$/

export function quoteArg(a: string, d: Dialect): string {
  if (a !== '' && (d === 'posix' ? POSIX_BARE : PS_BARE).test(a)) return a
  if (d === 'posix') return "'" + a.replace(/'/g, "'\\''") + "'"
  // Windows PowerShell 5.1 drops an empty argument to a native program; "" reaches it as an empty one
  if (a === '') return `'""'`
  // PowerShell 5.1 hands native programs the raw quote characters: escape them for the program's own parser,
  // then double every quote PowerShell treats as a single-quote delimiter (typographic ones included)
  const native = a.replace(/(\\*)"/g, '$1$1\\"')
  return "'" + native.replace(/['\u2018\u2019\u201A\u201B]/g, (m) => m + m) + "'"
}

/**
 * Typed before a command to clear what the user left at the prompt. POSIX line editors take ^U. PSReadLine has no
 * key that does it in every edit mode (it inserts ^U as a character in Windows mode, Escape starts a chord in Emacs
 * mode): the PowerShell integration binds one of its own.
 */
export const clearLine = (d: Dialect): string => (d === 'posix' ? '\x15' : PS_CLEAR_LINE)

/** A path argument for `cd` (a leading "-" or "~" must not be taken literally by the shell either way). */
const cdTo = (cwd: string, d: Dialect) => (d === 'posix' ? `cd ${quoteArg(cwd, d)}` : `Set-Location -LiteralPath ${quoteArg(cwd, d)}`)

/**
 * One line running each command only when the previous one succeeded, after an optional `cd`.
 * A string is typed as is (a user-visible command such as "npm run dev"); an array is an argv to quote.
 */
export function commandLine(d: Dialect, cmds: (string | string[])[], cwd?: string): string {
  const parts = [...(cwd ? [cdTo(cwd, d)] : []), ...cmds.map((c) => (typeof c === 'string' ? c : argvLine(c, d)))]
  if (!parts.length) return ''
  if (d === 'posix') return parts.join(' && ')
  // Windows PowerShell 5.1 has no &&: nest on $? (true when the previous cmdlet / native exit code succeeded)
  return parts.reduceRight((rest, p) => (rest ? `${p}; if ($?) { ${rest} }` : p), '')
}

/** A quoted program is a string expression in PowerShell: the call operator makes it a command again. */
function argvLine(argv: string[], d: Dialect): string {
  const line = argv.map((a) => quoteArg(a, d)).join(' ')
  return d === 'powershell' && argv.length && quoteArg(argv[0], d) !== argv[0] ? '& ' + line : line
}
