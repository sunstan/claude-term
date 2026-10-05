/** Dev servers started from the app's terminals: listening TCP sockets, tied to a tab through the process tree. */
import { ownerPty, type ProcRow } from './processes'

export interface ListeningSocket {
  /** as the tool writes it: `127.0.0.1`, `0.0.0.0`, `[::]`, `[::1]`, `*` */
  address: string
  port: number
  pid: number
}

/** A server found listening under one of the app's terminals. */
export interface DevServer {
  /** what the user opens */
  url: string
  port: number
  pid: number
  /** the listening process's command line */
  command: string
  /** the terminal (pty id) it descends from */
  ptyId: string
}

/** reachable from this machine; an address of the network only does not serve a preview */
const LOCAL = new Set(['127.0.0.1', '0.0.0.0', '[::]', '[::1]', '*', '::', '::1', '[::ffff:127.0.0.1]'])
const split = (s: string) => { const m = /^(.*):(\d+)$/.exec(s); return m ? { address: m[1], port: Number(m[2]) } : null }

/**
 * `netstat -ano` (Windows). Some versions write the state in the system's language: a listening socket is told by its
 * empty remote address instead, `0.0.0.0:0` or `[::]:0`.
 */
export function parseNetstat(text: string): ListeningSocket[] {
  const out: ListeningSocket[] = []
  for (const line of text.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/)
    if (c[0] !== 'TCP' || c.length < 4) continue
    const local = split(c[1])
    const pid = Number(c[c.length - 1])
    if (!local || (c[2] !== '0.0.0.0:0' && c[2] !== '[::]:0') || !Number.isInteger(pid) || pid <= 0 || !LOCAL.has(local.address)) continue
    out.push({ ...local, pid })
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` (macOS): `p<pid>` opens a process, each `n<address>:<port>` is one of its sockets. */
export function parseLsof(text: string): ListeningSocket[] {
  const out: ListeningSocket[] = []
  let pid = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0
    else if (line.startsWith('n') && pid) {
      const local = split(line.slice(1))
      if (local && LOCAL.has(local.address)) out.push({ ...local, pid })
    }
  }
  return out
}

/** `ss -ltnpH` (Linux): the local address is the 4th column, the owner `users:(("node",pid=123,fd=21))` (one's own processes only). */
export function parseSs(text: string): ListeningSocket[] {
  const out: ListeningSocket[] = []
  for (const line of text.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/)
    if (c[0] !== 'LISTEN' || c.length < 5) continue
    const local = split(c[3])
    const pid = /pid=(\d+)/.exec(line)
    if (local && pid && LOCAL.has(local.address.replace(/%.*$/, ''))) out.push({ address: local.address.replace(/%.*$/, ''), port: local.port, pid: Number(pid[1]) })
  }
  return out
}

/** An MCP server Claude started may listen over HTTP (a dashboard, a driven browser): not the app being developed. */
const MCP = /\bmcp\b|[-_]mcp|mcp[-_]/i

/**
 * Servers listening among the descendants of the app's terminals (`ptyPids`: pid → pty id): those started by hand,
 * and above all those Claude starts in the background, whose output never goes through the tab. One per port:
 * `localhost` resolves to IPv4 and IPv6, and a server listening on both is one. `probe` is the address to check it
 * answers on (IPv6 only when it listens there only).
 */
export function discoverServers(sockets: readonly ListeningSocket[], rows: readonly ProcRow[], ptyPids: ReadonlyMap<number, string>): (DevServer & { probe: string })[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const found = new Map<number, DevServer & { probe: string }>()
  const v4 = (port: number) => sockets.some((s) => s.port === port && !s.address.includes(':') && s.address !== '[::1]')
  for (const s of sockets) {
    if (found.has(s.port)) continue
    const ptyId = ownerPty(s.pid, byPid, ptyPids as Map<number, string>, 16)
    const row = byPid.get(s.pid)
    const command = row?.cmd || row?.name || ''
    if (!ptyId || MCP.test(command)) continue
    const host = v4(s.port) || s.address === '*' ? '127.0.0.1' : '[::1]'
    found.set(s.port, { url: `http://localhost:${s.port}/`, probe: `http://${host}:${s.port}/`, port: s.port, pid: s.pid, command, ptyId })
  }
  return [...found.values()].sort((a, b) => a.port - b.port)
}

/** A command line made readable: each path cut to its last name (`node vite.js --port 5173`), at most `max` characters. */
export function shortCommand(cmd: string, max = 80): string {
  const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
  const s = cmd
    .replace(/"([^"]*)"/g, (_m, inner: string) => (/[\\/]/.test(inner) ? base(inner) : inner))
    .split(/\s+/).map((w) => (/^(?:[A-Za-z]:)?[\\/]/.test(w) ? base(w) : w)).join(' ')
    .replace(/\b(node|python|bun|deno)\.exe\b/gi, '$1')
    .trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
