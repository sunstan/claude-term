import { describe, it, expect } from 'vitest'
import { encodePowershell, powershellArgs, powershellIntegration, PS_CLEAR_LINE } from '../src/shared/powershell'

describe('PowerShell integration script', () => {
  it('encodes the script as -EncodedCommand expects (base64 of UTF-16LE)', () => {
    for (const s of ['echo hi', 'é € 😀 "quotes" $x', '']) expect(encodePowershell(s)).toBe(Buffer.from(s, 'utf16le').toString('base64'))
  })

  it('runs after the profile and stays interactive', () => {
    const args = powershellArgs(7770)
    expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])
    expect(args).not.toContain('-NoProfile')
    expect(Buffer.from(args[3], 'base64').toString('utf16le')).toBe(powershellIntegration(7770))
  })

  it('reports start, end and cwd, and binds the clear-line key', () => {
    const s = powershellIntegration(7770)
    expect(s).toContain('"7770;start;"')
    expect(s).toContain('"7770;end;"')
    expect(s).toContain('"7;"')
    expect(s).toContain('Ctrl+Shift+F12')
    expect(PS_CLEAR_LINE).toBe('\x1b[24;6~')   // Ctrl+Shift+F12 as a terminal sends it
    expect(s).not.toContain('`')   // no PowerShell escapes: [char] codes only
  })
})

// a real PowerShell in a pseudo-terminal (ConPTY), as the app runs it
describe.skipIf(process.platform !== 'win32')('PowerShell integration in a terminal', () => {
  it('reports commands, exit codes and the cwd, and clears a pending line', async () => {
    const pty = await import('node-pty')
    const script = 'Set-PSReadLineOption -HistorySaveStyle SaveNothing\r\n' + powershellIntegration(7770)
    const p = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', encodePowershell(script)], { cols: 160, rows: 40, cwd: process.env.SystemRoot ?? 'C:\\Windows', env: process.env as Record<string, string> })
    let out = ''
    p.onData((d) => { out += d })
    const events = () => [...out.matchAll(/\x1b\](7770|7);([^\x07]*)\x07/g)].map((m) => `${m[1]};${m[2]}`)
    const until = async (pred: () => boolean) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 50)) }
    try {
      await until(() => events().includes('7770;end;0'))
      p.write('cmd /c exit 3\r')
      await until(() => events().includes('7770;end;3'))
      p.write('cd C:\\Users\r')
      await until(() => events().includes('7;file:///C:/Users'))
      p.write('pending input')
      await new Promise((r) => setTimeout(r, 300))
      p.write(PS_CLEAR_LINE + 'echo ok\r')
      await until(() => events().includes('7770;start;echo ok'))
      expect(events()).toEqual(expect.arrayContaining(['7770;start;cmd /c exit 3', '7770;end;3', '7770;start;cd C:\\Users', '7;file:///C:/Users', '7770;start;echo ok']))
      expect(events().some((e) => e.includes('pending'))).toBe(false)
    } finally { p.kill() }
  }, 30_000)
})
