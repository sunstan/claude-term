import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Invocation } from './claude-bin'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import type { MCPServer } from '@shared/ipc'

/**
 * MCP servers: `.mcp.json` of a project (ours to edit), `~/.claude.json` for user/local scopes
 * (read only: user scope changes go through `claude mcp add|remove`).
 */
export class Mcp {
  readonly userConfigPath: string
  constructor(home = homedir(), private claudeCommand: (args: string[]) => Invocation | null = () => null) {
    this.userConfigPath = join(home, '.claude.json')
  }

  static from(name: string, o: any, scope: MCPServer['scope'], sourcePath: string): MCPServer {
    const s: MCPServer = { name, transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, scope, sourcePath, disabled: false }
    if (typeof o.url === 'string') { s.url = o.url; s.transport = o.type === 'sse' ? 'sse' : 'http' }
    if (typeof o.command === 'string') s.command = o.command
    if (Array.isArray(o.args)) s.args = o.args.map(String)
    if (o.env && typeof o.env === 'object') s.env = o.env
    if (o.headers && typeof o.headers === 'object') s.headers = o.headers
    if (o.type === 'stdio' || (!o.url && o.command)) s.transport = 'stdio'
    return s
  }

  static toJson(s: MCPServer): any {
    const o: any = {}
    if (s.transport === 'stdio') {
      o.type = 'stdio'; o.command = s.command
      if (s.args.length) o.args = s.args
      if (Object.keys(s.env).length) o.env = s.env
    } else {
      o.type = s.transport; o.url = s.url
      if (Object.keys(s.headers).length) o.headers = s.headers
    }
    return o
  }

  project(root: string, scope: MCPServer['scope'] = 'project'): MCPServer[] {
    const p = join(root, '.mcp.json')
    let o: any
    try { o = JSON.parse(readFileSync(p, 'utf8')) } catch { return [] }
    const servers = o?.mcpServers
    if (!servers || typeof servers !== 'object') return []
    const disabled = new Set(this.disabledInProject(root))
    return Object.keys(servers).sort().map((n) => { const s = Mcp.from(n, servers[n], scope, p); s.disabled = disabled.has(n); s.ref = { path: p, name: n }; return s })
  }

  /** Adds or replaces a server in `.mcp.json`; refuses to overwrite unreadable JSON. */
  write(server: MCPServer, root: string, replacing?: string) {
    const p = join(root, '.mcp.json')
    let o: any = {}
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8')
      if (raw.trim()) { try { o = JSON.parse(raw) } catch { throw new Error(".mcp.json illisible, rien n'a été écrit") } }
    }
    o.mcpServers ??= {}
    if (replacing && replacing !== server.name) delete o.mcpServers[replacing]
    o.mcpServers[server.name] = Mcp.toJson(server)
    writeFileSync(p, JSON.stringify(o, null, 2) + '\n')
  }

  remove(name: string, root: string) {
    const p = join(root, '.mcp.json')
    let o: any
    try { o = JSON.parse(readFileSync(p, 'utf8')) } catch { return }
    if (!o?.mcpServers) return
    delete o.mcpServers[name]
    writeFileSync(p, JSON.stringify(o, null, 2) + '\n')
  }

  private userConfig(): any { try { return JSON.parse(readFileSync(this.userConfigPath, 'utf8')) } catch { return {} } }
  /** A project's entry in ~/.claude.json, whose keys are written with forward slashes on Windows. */
  private projectEntry(root: string): any {
    const projects = this.userConfig().projects ?? {}
    if (projects[root]) return projects[root]
    const want = sameRoot(root)
    const key = Object.keys(projects).find((k) => sameRoot(k) === want)
    return key ? projects[key] : undefined
  }
  user(): MCPServer[] {
    const servers = this.userConfig().mcpServers ?? {}
    return Object.keys(servers).sort().map((n) => ({ ...Mcp.from(n, servers[n], 'user', this.userConfigPath), ref: { path: this.userConfigPath, name: n } }))
  }
  local(root: string): MCPServer[] {
    const servers = this.projectEntry(root)?.mcpServers ?? {}
    return Object.keys(servers).sort().map((n) => ({ ...Mcp.from(n, servers[n], 'local', this.userConfigPath), ref: { path: this.userConfigPath, root, name: n } }))
  }
  disabledInProject(root: string): string[] {
    const d = this.projectEntry(root)?.disabledMcpjsonServers
    return Array.isArray(d) ? d : []
  }
  /** Every project Claude Code has seen (~/.claude.json). */
  knownRoots(): string[] { return Object.keys(this.userConfig().projects ?? {}) }

  /**
   * Servers of other projects to copy from: their `.mcp.json` and their local servers, from `candidates` (open and
   * recent projects first) and every project Claude Code knows. The same name with the same config is listed once;
   * `detail` names the project.
   */
  library(excluding: string | null, candidates: string[]): (MCPServer & { detail: string })[] {
    const roots = new Map<string, string>()
    for (const r of [...candidates, ...this.knownRoots()]) { const k = sameRoot(r); if (!roots.has(k) && (!excluding || k !== sameRoot(excluding))) roots.set(k, r) }
    const seen = new Set<string>(), out: (MCPServer & { detail: string })[] = []
    for (const root of roots.values()) {
      for (const s of [...this.project(root), ...this.local(root)]) {
        const key = s.name + JSON.stringify(Mcp.toJson(s))
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ ...s, detail: basename(root.replace(/[\\/]+$/, '')) || root })
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail))
  }

  /**
   * The server a `ref` points to, as stored: in ~/.claude.json, or in the `.mcp.json` of one of `roots` (never
   * another file).
   */
  find(ref: MCPServer['ref'], roots: string[]): MCPServer | null {
    if (!ref || typeof ref.path !== 'string' || typeof ref.name !== 'string') return null
    if (ref.path === this.userConfigPath) return (ref.root ? this.local(ref.root) : this.user()).find((s) => s.name === ref.name) ?? null
    if (basename(ref.path) !== '.mcp.json') return null
    const dir = sameRoot(dirname(ref.path))
    const root = [...roots, ...this.knownRoots()].find((r) => sameRoot(r) === dir)
    return root ? this.project(root).find((s) => s.name === ref.name) ?? null : null
  }

  /** `claude mcp <args>` in the project (user-scope changes and health checks). */
  cli(args: string[], cwd: string | null): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const inv = this.claudeCommand(['mcp', ...args]) ?? { file: 'claude', args: ['mcp', ...args] }
      const env: NodeJS.ProcessEnv = { ...process.env, ...inv.env }
      for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k]
      execFile(inv.file, inv.args, { cwd: cwd ?? undefined, env, timeout: 60_000, maxBuffer: 4_000_000, windowsVerbatimArguments: inv.verbatim }, (err, stdout, stderr) => {
        resolve({ code: err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0, output: String(stdout) + String(stderr) })
      })
    })
  }

  /** Parses `claude mcp list`: "name: target - ✔ Connected" lines. */
  static parseList(text: string): { name: string; target: string; health: MCPServer['health'] }[] {
    const out: { name: string; target: string; health: MCPServer['health'] }[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      const sep = line.lastIndexOf(' - ')
      if (sep < 0) continue
      const head = line.slice(0, sep)
      const colon = head.lastIndexOf(': ')
      if (colon < 0) continue
      const status = line.slice(sep + 3)
      out.push({ name: head.slice(0, colon).trim(), target: head.slice(colon + 2).trim(), health: status.startsWith('✔') ? 'connected' : /auth/i.test(status) ? 'needsAuth' : 'failed' })
    }
    return out
  }

  static addArgs(s: MCPServer, scope: string): string[] {
    const a = ['add', '-s', scope, '-t', s.transport]
    for (const [k, v] of Object.entries(s.env)) a.push('-e', `${k}=${v}`)
    for (const [k, v] of Object.entries(s.headers)) a.push('-H', `${k}: ${v}`)
    a.push(s.name)
    if (s.transport === 'stdio') { a.push('--', s.command, ...s.args) } else a.push(s.url)
    return a
  }
}

/** A folder as compared across spellings: forward slashes, no trailing one, the drive letter's case ignored. */
function sameRoot(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}
