import { execFile } from 'node:child_process'
import { discoverServers, parseLsof, parseNetstat, parseSs, type DevServer, type ListeningSocket } from '@shared/listening'
import { processRows } from './process'

const run = (file: string, args: string[]) => new Promise<string>((resolve) => {
  execFile(file, args, { maxBuffer: 8_000_000, windowsHide: true, timeout: 10_000, env: { ...process.env, LC_ALL: 'C' } }, (_e, out) => resolve(String(out ?? '')))
})

/** Listening TCP sockets on this machine: netstat (Windows), lsof (macOS), ss then lsof (Linux). */
async function listening(): Promise<ListeningSocket[]> {
  if (process.platform === 'win32') return parseNetstat(await run('netstat.exe', ['-ano']))
  const lsof = () => run(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']).then(parseLsof)
  if (process.platform === 'darwin') return lsof()
  const ss = parseSs(await run('ss', ['-ltnpH']))
  return ss.length ? ss : lsof()
}

/**
 * A port answers HTML (a page, not an API, a debugger or a database): asked once per process and port, when it shows
 * up, and remembered while it listens (a request every minute would fill the server's log).
 */
const html = new Map<string, Promise<boolean>>()
function servesHtml(key: string, url: string): Promise<boolean> {
  let known = html.get(key)
  if (!known) { known = probe(url); html.set(key, known) }
  return known
}
async function probe(url: string): Promise<boolean> {
  let ok = false
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000), headers: { Accept: 'text/html' } })
    ok = (r.headers.get('content-type') ?? '').includes('text/html')
    await r.body?.cancel()
  } catch { /* closed, or not HTTP */ }
  return ok
}

/** Servers listening under the app's terminals (`ptyPids`: pid → pty id) that answer a page. */
export async function devServers(ptyPids: Map<number, string>): Promise<DevServer[]> {
  if (!ptyPids.size) return []
  const [sockets, rows] = await Promise.all([listening(), processRows()])
  const found = discoverServers(sockets, rows, ptyPids)
  // forget the servers gone: a new process on the same port is asked again
  const live = new Set(found.map((s) => `${s.pid}:${s.port}`))
  for (const k of html.keys()) if (!live.has(k)) html.delete(k)
  const ok = await Promise.all(found.map((s) => servesHtml(`${s.pid}:${s.port}`, s.probe)))
  return found.filter((_, i) => ok[i]).map(({ probe: _p, ...s }) => s)
}
