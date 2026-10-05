/** Claude processes from a process table (pure, tested): `ps` on macOS / Linux, Win32_Process on Windows. */
import type { ClaudeProcess } from './ipc'

export interface ProcRow { pid: number; ppid: number; started: number; cmd: string; name?: string; memBytes?: number; cpu?: string; elapsed?: string }

/** `Get-CimInstance Win32_Process | Select … | ConvertTo-Json`: one object or an array, dates as /Date(ms)/ (5.1) or ISO (7). */
export function parseCimProcesses(json: string): ProcRow[] {
  let data: unknown
  try { data = JSON.parse(json) } catch { return [] }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  const date = (v: unknown) => { const s = String(v ?? ''); const m = s.match(/Date\((-?\d+)/); return m ? +m[1] : Date.parse(s) || 0 }
  return list.flatMap((o: any) => {
    const pid = Number(o?.ProcessId)
    if (!pid) return []
    return [{ pid, ppid: Number(o.ParentProcessId) || 0, started: date(o.CreationDate), cmd: typeof o.CommandLine === 'string' ? o.CommandLine : '', name: typeof o.Name === 'string' ? o.Name : undefined, memBytes: Number(o.WorkingSetSize) || 0 }]
  })
}

/** A Claude Code process: the `claude` binary, or Node running the npm package's cli.js. */
export function isClaudeProcess(r: Pick<ProcRow, 'cmd' | 'name'>): boolean {
  if (r.name && /^claude(\.exe)?$/i.test(r.name)) return true
  if (/@anthropic-ai[\\/]claude-code[\\/]cli\.js/i.test(r.cmd)) return !/^\S*cmd(\.exe)?"?\s/i.test(r.cmd)
  const exe = r.cmd.split(' ')[0] ?? ''
  return exe === 'claude' || exe.endsWith('/claude')
}

/** Elapsed time the way `ps` prints it: [[dd-]hh:]mm:ss. */
export function elapsedSince(start: number, now: number): string {
  let s = Math.max(0, Math.floor((now - start) / 1000))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const p = (n: number) => String(n).padStart(2, '0')
  return (d ? `${d}-${p(h)}:` : h ? `${p(h)}:` : '') + `${p(m)}:${p(s)}`
}

/** The app's terminal (pty id) a process runs in: itself or one of its parents is a pty's process. */
export function ownerPty(pid: number, byPid: Map<number, ProcRow>, ptyPids: Map<number, string>, depth = 8): string | undefined {
  for (let p: number | undefined = pid, i = 0; p && i <= depth; i++) {
    const owner = ptyPids.get(p)
    if (owner) return owner
    p = byPid.get(p)?.ppid
  }
  return undefined
}

/** Claude processes with their descendants and the tab they run in; a claude started by another claude is a child. */
export function claudeTree(rows: ProcRow[], opts: { home: string; ptyPids: Map<number, string>; now: number }): ClaudeProcess[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const claude = rows.filter((r) => isClaudeProcess(r) && !(byPid.has(r.ppid) && isClaudeProcess(byPid.get(r.ppid)!)))
  const short = (c: string) => c.split(opts.home).join('~')
  return claude.map((r): ClaudeProcess => {
    const children: ClaudeProcess['children'] = []
    const frontier = [r.pid], seen = new Set<number>([r.pid])
    while (frontier.length) {
      const p = frontier.pop()!
      for (const c of rows) {
        if (c.ppid !== p || seen.has(c.pid)) continue
        seen.add(c.pid); frontier.push(c.pid)
        const command = short(c.cmd || c.name || '')
        if (command.startsWith('/bin/zsh -c source ~/.claude/shell-snapshots') || /^\\\?\?\\|conhost\.exe/i.test(command)) continue
        children.push({ pid: c.pid, command: command.slice(0, 120), cpu: c.cpu ?? '' })
      }
    }
    return {
      pid: r.pid, started: r.started, elapsed: r.elapsed ?? elapsedSince(r.started, opts.now), cpu: r.cpu ?? '',
      memMB: Math.round((r.memBytes ?? 0) / 1048576), cwd: '?', command: short(r.cmd).slice(0, 200), ptyId: ownerPty(r.pid, byPid, opts.ptyPids), children,
    }
  }).sort((a, b) => b.started - a.started)
}
