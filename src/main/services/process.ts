import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import type { ClaudeProcess } from '@shared/ipc'
import { claudeTree, parseCimProcesses, type ProcRow } from '@shared/processes'

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv) => new Promise<string>((resolve) => {
  execFile(file, args, { env, maxBuffer: 16_000_000, windowsHide: true, timeout: 20_000 }, (_e, out) => resolve(String(out ?? '')))
})

/** ps on macOS / Linux: pid, parent, start, elapsed, CPU %, memory, command. */
async function psRows(): Promise<ProcRow[]> {
  const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,etime=,%cpu=,rss=,command='], { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
  const rows: ProcRow[] = []
  for (const line of ps.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 11) continue
    const pid = +parts[0], ppid = +parts[1]
    if (!pid) continue
    const started = Date.parse(parts.slice(2, 7).join(' ')) || Date.now()
    rows.push({ pid, ppid, started, elapsed: parts[7], cpu: parts[8], memBytes: (+parts[9] || 0) * 1024, cmd: parts.slice(10).join(' ') })
  }
  return rows
}

/** Win32_Process through PowerShell (no CPU % there: it would need two samples). */
async function cimRows(): Promise<ProcRow[]> {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine,WorkingSetSize | ConvertTo-Json -Compress'])
  return parseCimProcesses(out)
}

/** The process table is costly on Windows (WMI): one scan at a time, kept for a few seconds. */
let inflight: Promise<ProcRow[]> | null = null
let cached: { at: number; rows: ProcRow[] } | null = null
const TTL = process.platform === 'win32' ? 4000 : 1500
export function processRows(): Promise<ProcRow[]> {
  if (cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.rows)
  inflight ??= (process.platform === 'win32' ? cimRows() : psRows()).then((r) => { cached = { at: Date.now(), rows: r }; return r }).finally(() => { inflight = null })
  return inflight
}

/** Running `claude` processes on this machine, with the app's terminal each runs in (`ptyPids`: pid → pty id). */
export async function scanClaudeProcesses(ptyPids: Map<number, string>): Promise<ClaudeProcess[]> {
  const claude = claudeTree(await processRows(), { home: homedir(), ptyPids, now: Date.now() })
  if (!claude.length || process.platform === 'win32') return claude
  const lsof = await run('/usr/sbin/lsof', ['-a', '-p', claude.map((c) => c.pid).join(','), '-d', 'cwd', '-Fn'], { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
  let current: number | null = null
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) current = +line.slice(1)
    else if (line.startsWith('n') && current) { const c = claude.find((x) => x.pid === current); if (c) c.cwd = line.slice(1) }
  }
  return claude
}
