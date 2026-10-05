import { describe, it, expect } from 'vitest'
import { isWebUrl, opensInDefaultApp } from '../src/shared/external'

describe('what leaves the app', () => {
  it('lets web and mail links go to the browser', () => {
    expect(isWebUrl('https://claude.com')).toBe(true)
    expect(isWebUrl('HTTP://localhost:5173/')).toBe(true)
    expect(isWebUrl('mailto:a@b.c')).toBe(true)
    expect(isWebUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isWebUrl('javascript:alert(1)')).toBe(false)
    expect(isWebUrl('ms-settings:privacy')).toBe(false)
    expect(isWebUrl('vscode://file/x')).toBe(false)
  })

  it('opens only files their default app views', () => {
    expect(opensInDefaultApp('C:\\Projets\\app\\doc.PDF')).toBe(true)
    expect(opensInDefaultApp('/Users/j/.claude/plans/x.md')).toBe(true)
    expect(opensInDefaultApp('/p/archive.tar.gz')).toBe(true)
    for (const p of ['C:\\x\\setup.exe', 'C:\\x\\run.bat', 'C:\\x\\a.ps1', 'C:\\x\\a.js', 'C:\\x\\a.lnk', 'C:\\x\\help.chm', 'C:\\x\\tool.py',
      '/Users/j/run.command', '/Users/j/build/app', '/p/.env', '/p/noext', '/p/a.unknownext']) {
      expect(opensInDefaultApp(p), p).toBe(false)
    }
  })
})
