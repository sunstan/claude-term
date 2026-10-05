import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { drainSpool, hookScript } from '../src/main/services/hooks'

describe('hook spool', () => {
  it('handles complete events in write order, keeps fresh partial files, drops stale ones', () => {
    const t = new TempDir()
    const old = (p: string, s: number) => utimesSync(p, new Date(Date.now() - s * 1000), new Date(Date.now() - s * 1000))
    old(t.write('b.json', JSON.stringify({ n: 2 })), 5)
    old(t.write('a.json', JSON.stringify({ n: 1 })), 10)
    t.write('partial.json', '{"hook_event_name": "St')
    old(t.write('broken.json', '{'), 30)
    t.write('writing.tmp', '{')
    old(t.write('stale.tmp', '{'), 120)
    t.write('other.txt', 'x')
    const seen: any[] = []
    expect(drainSpool(t.path, (e) => seen.push(e))).toBe(1)
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
    expect(readdirSync(t.path).sort()).toEqual(['other.txt', 'partial.json', 'writing.tmp'])
    // once complete, the kept file is handled on the next pass
    t.write('partial.json', '{"hook_event_name": "Stop"}')
    expect(drainSpool(t.path, (e) => seen.push(e))).toBe(0)
    expect(seen.at(-1)).toEqual({ hook_event_name: 'Stop' })
    // a handler error does not stop the drain nor keep the file
    t.write('c.json', '{}'); t.write('d.json', '{"x":1}')
    expect(drainSpool(t.path, (e) => { if (!e.x) throw new Error('boom'); seen.push(e) })).toBe(0)
    expect(seen.at(-1)).toEqual({ x: 1 })
    expect(existsSync(join(t.path, 'c.json'))).toBe(false)
    expect(drainSpool(join(t.path, 'missing'), () => {})).toBe(0)
    t.dispose()
  })

  it('hands over the tab an event names (CLAUDETERM_TAB in the file name)', () => {
    const t = new TempDir()
    t.write('1-2-3~ab12cd34.t7.json', '{"hook_event_name":"Stop"}')
    t.write('1-2-4~.json', '{"hook_event_name":"Notification"}')
    const seen: [string, string | undefined][] = []
    drainSpool(t.path, (e, tab) => seen.push([e.hook_event_name, tab]))
    expect(seen.sort()).toEqual([['Notification', undefined], ['Stop', 'ab12cd34.t7']])
    t.dispose()
  })

  it.skipIf(process.platform === 'win32')('the POSIX script spools stdin as a complete .json, never a partial one', () => {
    const t = new TempDir()
    const dir = join(t.path, "ev ents'")
    const script = t.write('hook.sh', hookScript(dir, 'darwin'))
    execFileSync('/bin/sh', [script], { input: '{"hook_event_name":"Stop","cwd":"/x"}', env: { ...process.env, CLAUDETERM_TAB: 'run1.t3' } })
    const names = readdirSync(dir)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^\d+-\d+-\d*~run1\.t3\.json$/)
    const seen: any[] = []
    drainSpool(dir, (e, tab) => seen.push({ ...e, tab }))
    expect(seen).toEqual([{ hook_event_name: 'Stop', cwd: '/x', tab: 'run1.t3' }])
    t.dispose()
  })

  it.skipIf(process.platform !== 'win32')('the Windows script spools stdin as a .json named after the tab, or none', () => {
    const t = new TempDir()
    const dir = join(t.path, 'events')
    const script = t.write('hook.cmd', hookScript(dir, 'win32'))
    const { CLAUDETERM_TAB: _, ...env } = process.env
    execFileSync('cmd.exe', ['/d', '/c', script], { input: '{"hook_event_name":"Stop"}', env: { ...env, CLAUDETERM_TAB: 'run1.t3' } })
    execFileSync('cmd.exe', ['/d', '/c', script], { input: '{"hook_event_name":"Notification"}', env })
    const seen: [string, string | undefined][] = []
    drainSpool(dir, (e, tab) => seen.push([e.hook_event_name, tab]))
    expect(seen.sort()).toEqual([['Notification', undefined], ['Stop', 'run1.t3']])
    t.dispose()
  })

  it('the Windows script writes a .tmp then moves it, named after the tab', () => {
    const s = hookScript('C:\\Users\\me\\AppData\\ClaudeTerm\\events', 'win32')
    expect(s).toContain('~%CLAUDETERM_TAB%"')
    expect(s).toContain('more > "%f%.tmp"')
    expect(s).toContain('move /y "%f%.tmp" "%f%.json" >nul')
    expect(s.split('\r\n').length).toBeGreaterThan(5)
  })
})
