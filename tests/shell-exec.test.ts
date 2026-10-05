import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { commandLine, type Dialect } from '../src/shared/shell'
import { claudeInvocation } from '../src/main/services/claude-bin'

// Runs the generated lines in the real shells (sh here; Windows PowerShell 5.1 and cmd.exe on the Windows CI runner)
const win = process.platform === 'win32'
const dialect: Dialect = win ? 'powershell' : 'posix'
// stdout even when the chain ends on a failing command (that is the point of one test)
const runLine = (line: string, cwd: string): string => {
  try {
    return win
      ? execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', line], { cwd, encoding: 'utf8' })
      : execFileSync('/bin/sh', ['-c', line], { cwd, encoding: 'utf8' })
  } catch (e: any) { if (typeof e.stdout === 'string' && e.stdout) return e.stdout; throw e }
}
const node = process.execPath.includes(' ') ? 'node' : process.execPath   // plain node from PATH when the path has spaces

const WEIRD = ["l'app", 'l’app ‘x’', 'a b', '$HOME', '$env:PATH', '"quoted"', 'say "hi" now', 'x&y', 'a|b', 'semi;colon', '@at', 'a,b', '(paren)', '{brace}', 'back\\slash', 'dir\\"x', '*.ts', '~', '-n', '%PATH%', '!bang!', 'émoji ✓', '']

// each case starts real shells: slow on Windows while the whole suite runs
describe('command lines in the real shell', { timeout: 30_000 }, () => {
  it('every argument arrives intact', () => {
    const t = new TempDir()
    const script = t.write('argv.js', 'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))')
    const out = JSON.parse(runLine(commandLine(dialect, [[node, script, ...WEIRD]]), t.path))
    expect(out.argv).toEqual(WEIRD)
    t.dispose()
  })

  it('cd into an awkward folder, then chain: stops at the first failure', () => {
    const t = new TempDir()
    const script = t.write('argv.js', 'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))')
    const dir = join(t.path, "it's a (dir) & more")
    t.write(join(dir, 'keep'), '')
    const lines = runLine(commandLine(dialect, [[node, script, 'one'], [node, '-e', 'process.exit(3)'], [node, script, 'never']], dir), t.path).trim().split(/\r?\n/)
    expect(lines).toHaveLength(1)
    const first = JSON.parse(lines[0])
    expect(first.argv).toEqual(['one'])
    expect(first.cwd.toLowerCase()).toContain("it's a (dir) & more")
    t.dispose()
  })

  it.runIf(win)('a Windows npm shim through cmd.exe receives the arguments intact', () => {
    const t = new TempDir()
    t.write('argv.js', 'console.log(JSON.stringify(process.argv.slice(2)))')
    const shim = t.write('claude.cmd', `@"${process.execPath}" "%~dp0argv.js" %*\r\n`)
    const args = ['mcp', 'add', 'my server', 'https://h/?a=1&b=2', 'say "hi"', '%PATH%', '!x!', "l'app"]
    const inv = claudeInvocation(shim, args, { interactive: false, execPath: process.execPath, comspec: process.env.ComSpec, exists: () => false })
    const r = spawnSync(inv.file, inv.args, { encoding: 'utf8', windowsVerbatimArguments: inv.verbatim })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(args)
    t.dispose()
  })
})
