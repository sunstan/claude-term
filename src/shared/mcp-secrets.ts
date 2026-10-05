/**
 * Secrets of MCP server configs, masked before they leave main (pure, tested). The renderer only ever sees the mask;
 * on save, main puts the real values back from where the server came from (`unmaskServer`): a value still masked
 * keeps the stored one, a value typed anew replaces it.
 */
import type { MCPServer } from './ipc'

export const MASK = '••••••'

const SECRET_NAME = /(token|secret|passw(or)?d|passwd|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|auth|credential|bearer|cookie|session|signature|^key$|_key$|-key$)/i

/** An env variable, header or query parameter whose value is a secret by its name. */
export const isSecretName = (name: string): boolean => SECRET_NAME.test(name)

function maskRecord(r: Record<string, string>): { out: Record<string, string>; n: number } {
  let n = 0
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(r)) {
    const secret = v !== '' && (isSecretName(k) || /^(bearer|basic|token)\s+\S/i.test(v))
    out[k] = secret ? MASK : v
    if (secret) n++
  }
  return { out, n }
}

/** `--token=x` and `--api-key x` style arguments: the value is masked, the flag kept. */
function maskArgs(args: string[]): { out: string[]; n: number } {
  let n = 0
  const out = args.map((a, i) => {
    const eq = a.match(/^(--?[A-Za-z0-9_-]+)=(.+)$/)
    if (eq && isSecretName(eq[1])) { n++; return `${eq[1]}=${MASK}` }
    const prev = args[i - 1]
    if (prev && /^--?[A-Za-z0-9_-]+$/.test(prev) && isSecretName(prev) && !a.startsWith('-')) { n++; return MASK }
    return a
  })
  return { out, n }
}

/** Secret query parameters and the password of `user:password@`. */
function maskUrl(url: string): { out: string; n: number } {
  let n = 0
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@\s]*:)([^@/\s]+)@/i, (_m, head: string) => { n++; return `${head}${MASK}@` })
  out = out.replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep: string, k: string, v: string) => (v && isSecretName(decodeURIComponent(k)) ? (n++, `${sep}${k}=${MASK}`) : m))
  return { out, n }
}

/** A copy of the server with its secrets masked; `secrets` counts them. */
export function maskServer(s: MCPServer): MCPServer {
  const env = maskRecord(s.env), headers = maskRecord(s.headers), args = maskArgs(s.args), url = maskUrl(s.url)
  const secrets = env.n + headers.n + args.n + url.n
  return { ...s, env: env.out, headers: headers.out, args: args.out, url: url.out, ...(secrets ? { secrets } : {}) }
}

/**
 * The server to write: `next` as the user left it, its masked values taken back from `stored` (the same server as it
 * is on disk). A masked value with nothing to take it from is refused rather than written as the mask.
 */
export function unmaskServer(next: MCPServer, stored: MCPServer | null): MCPServer {
  const fromRecord = (n: Record<string, string>, o: Record<string, string> | undefined) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(n)) {
      if (!v.includes(MASK)) { out[k] = v; continue }
      if (o?.[k] === undefined) throw new Error(`Valeur masquée sans source : ${k}`)
      out[k] = o[k]
    }
    return out
  }
  const args = (() => {
    if (!next.args.some((a) => a.includes(MASK))) return next.args
    const old = stored?.args ?? [], masked = maskArgs(old).out, used = new Set<number>()
    return next.args.map((a) => {
      if (!a.includes(MASK)) return a
      const j = masked.findIndex((m, i) => m === a && !used.has(i))
      if (j < 0) throw new Error(`Argument masqué sans source : ${a}`)
      used.add(j)
      return old[j]
    })
  })()
  const url = (() => {
    if (!next.url.includes(MASK)) return next.url
    const old = stored?.url ?? ''
    if (maskUrl(old).out === next.url) return old
    throw new Error('Adresse masquée modifiée : retape le secret')
  })()
  const { secrets: _s, ref: _r, ...rest } = next
  return { ...rest, env: fromRecord(next.env, stored?.env), headers: fromRecord(next.headers, stored?.headers), args, url }
}
