import { describe, it, expect } from 'vitest'
import { clearLine, commandLine, dialectFor, quoteArg } from '../src/shared/shell'

describe('shell command lines', () => {
  it('picks the dialect of the tab shell', () => {
    expect(dialectFor('darwin', 'native')).toBe('posix')
    expect(dialectFor('linux', 'native')).toBe('posix')
    expect(dialectFor('win32', 'native')).toBe('powershell')
    expect(dialectFor('win32', 'wsl')).toBe('posix')
  })

  it('clears the pending line only where a key does it in every edit mode', () => {
    expect(clearLine('posix')).toBe('\x15')
    expect(clearLine('powershell')).toBe('')
  })

  it('quotes for POSIX shells', () => {
    expect(quoteArg('commit', 'posix')).toBe('commit')
    expect(quoteArg('feat/x@1,2', 'posix')).toBe('feat/x@1,2')
    expect(quoteArg("l'app", 'posix')).toBe("'l'\\''app'")
    expect(quoteArg('a b $HOME `x` "q"', 'posix')).toBe("'a b $HOME `x` \"q\"'")
    expect(quoteArg('', 'posix')).toBe("''")
  })

  it('quotes for Windows PowerShell 5.1', () => {
    expect(quoteArg('commit', 'powershell')).toBe('commit')
    expect(quoteArg("l'app", 'powershell')).toBe("'l''app'")
    expect(quoteArg('l’app ‘x’', 'powershell')).toBe("'l’’app ‘‘x’’'")
    expect(quoteArg('@all', 'powershell')).toBe("'@all'")
    expect(quoteArg('a,b', 'powershell')).toBe("'a,b'")
    expect(quoteArg('say "hi"', 'powershell')).toBe("'say \\\"hi\\\"'")
    expect(quoteArg('c:\\dir\\"x', 'powershell')).toBe("'c:\\dir\\\\\\\"x'")
    expect(quoteArg('$env:X', 'powershell')).toBe("'$env:X'")
    expect(quoteArg('', 'powershell')).toBe(`'""'`)
  })

  it('chains commands after an optional cd, each only if the previous succeeded', () => {
    const git = [['git', 'add', '--', 'new file.txt'], ['git', 'commit', '-m', "l'app", '--', 'a.txt'], ['git', 'push']]
    expect(commandLine('posix', git, '/tmp/my repo')).toBe("cd '/tmp/my repo' && git add -- 'new file.txt' && git commit -m 'l'\\''app' -- a.txt && git push")
    expect(commandLine('powershell', git, 'C:\\Users\\me\\my repo')).toBe(
      "Set-Location -LiteralPath 'C:\\Users\\me\\my repo'; if ($?) { git add -- 'new file.txt'; if ($?) { git commit -m 'l''app' -- a.txt; if ($?) { git push } } }")
    expect(commandLine('posix', ['npm run dev'])).toBe('npm run dev')
    expect(commandLine('powershell', ['npm run dev'], 'C:\\p')).toBe("Set-Location -LiteralPath 'C:\\p'; if ($?) { npm run dev }")
    expect(commandLine('posix', [])).toBe('')
    // a quoted program needs the call operator in PowerShell, not in sh
    expect(commandLine('powershell', [['C:\\Program Files\\node.exe', '-v']])).toBe("& 'C:\\Program Files\\node.exe' -v")
    expect(commandLine('posix', [['/opt/my app/node', '-v']])).toBe("'/opt/my app/node' -v")
  })
})
