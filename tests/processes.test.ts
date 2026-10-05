import { describe, it, expect } from 'vitest'
import { claudeTree, elapsedSince, isClaudeProcess, ownerPty, parseCimProcesses, type ProcRow } from '../src/shared/processes'

describe('Win32_Process table', () => {
  it('reads PowerShell 5.1 and 7 JSON, one object or many', () => {
    const one = parseCimProcesses('{"ProcessId":12,"ParentProcessId":4,"CreationDate":"\\/Date(1759650000000)\\/","Name":"claude.exe","CommandLine":"claude --resume x","WorkingSetSize":104857600}')
    expect(one).toEqual([{ pid: 12, ppid: 4, started: 1759650000000, cmd: 'claude --resume x', name: 'claude.exe', memBytes: 104857600 }])
    const many = parseCimProcesses('[{"ProcessId":1,"ParentProcessId":0,"CreationDate":"2026-10-05T10:00:00+02:00","Name":"a.exe","CommandLine":null},{"ProcessId":0}]')
    expect(many).toHaveLength(1)
    expect(many[0]).toMatchObject({ pid: 1, cmd: '', started: Date.parse('2026-10-05T10:00:00+02:00') })
    expect(parseCimProcesses('')).toEqual([])
  })

  it('tells Claude Code processes from the shims around them', () => {
    expect(isClaudeProcess({ name: 'claude.exe', cmd: '"C:\\Users\\j\\.local\\bin\\claude.exe"' })).toBe(true)
    expect(isClaudeProcess({ name: 'node.exe', cmd: '"node" "C:\\Users\\j\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume x' })).toBe(true)
    expect(isClaudeProcess({ name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\j\\AppData\\Roaming\\npm\\claude.cmd""' })).toBe(false)
    expect(isClaudeProcess({ cmd: '/Users/j/.local/bin/claude --continue' })).toBe(true)
    expect(isClaudeProcess({ cmd: 'claude' })).toBe(true)
    expect(isClaudeProcess({ cmd: '/usr/bin/claudette' })).toBe(false)
  })

  it('prints elapsed time like ps', () => {
    expect(elapsedSince(0, 65_000)).toBe('01:05')
    expect(elapsedSince(0, 3_725_000)).toBe('01:02:05')
    expect(elapsedSince(0, 90_061_000)).toBe('1-01:01:01')
    expect(elapsedSince(10, 0)).toBe('00:00')
  })
})

describe('Claude process tree', () => {
  const rows: ProcRow[] = [
    { pid: 100, ppid: 1, started: 0, cmd: 'electron.exe .' },
    { pid: 200, ppid: 100, started: 0, cmd: 'powershell.exe -NoLogo', name: 'powershell.exe' },   // a tab's shell
    { pid: 300, ppid: 200, started: 1000, cmd: 'C:\\Users\\j\\.local\\bin\\claude.exe', name: 'claude.exe', memBytes: 50 * 1048576 },
    { pid: 310, ppid: 300, started: 1100, cmd: 'C:\\Users\\j\\.local\\bin\\claude.exe --agent', name: 'claude.exe' },  // a claude started by claude
    { pid: 320, ppid: 300, started: 1200, cmd: 'C:\\Program Files\\Git\\bin\\bash.exe -c npm test', name: 'bash.exe' },
    { pid: 330, ppid: 320, started: 1300, cmd: 'node vitest', name: 'node.exe' },
    { pid: 400, ppid: 1, started: 2000, cmd: 'C:\\Users\\j\\.local\\bin\\claude.exe', name: 'claude.exe' },   // started elsewhere
  ]
  const ptyPids = new Map([[200, 'pty1']])

  it('finds the terminal a process runs in through its parents', () => {
    const byPid = new Map(rows.map((r) => [r.pid, r]))
    expect(ownerPty(330, byPid, ptyPids)).toBe('pty1')
    expect(ownerPty(200, byPid, ptyPids)).toBe('pty1')
    expect(ownerPty(400, byPid, ptyPids)).toBeUndefined()
    expect(ownerPty(330, byPid, ptyPids, 1)).toBeUndefined()
  })

  it('lists top-level claude processes with their descendants, newest first', () => {
    const t = claudeTree(rows, { home: 'C:\\Users\\j', ptyPids, now: 62_000 })
    expect(t.map((c) => [c.pid, c.ptyId])).toEqual([[400, undefined], [300, 'pty1']])
    const inTab = t.find((c) => c.pid === 300)!
    expect(inTab.children.map((c) => c.pid).sort()).toEqual([310, 320, 330])
    expect(inTab.memMB).toBe(50)
    expect(inTab.elapsed).toBe('01:01')
    expect(inTab.command).toBe('~\\.local\\bin\\claude.exe')
    expect(inTab.cwd).toBe('?')
  })
})
