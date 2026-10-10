import { describe, it, expect } from 'vitest'
import { shellEscapePath, pathsForPrompt, pathFromFileUri, windowsQuotePath, pathShell, wslPath, windowsPathFromWsl } from '../src/shared/paths'
describe('paths for the prompt', () => {
  it('escapes shell-special characters like a terminal drop', () => {
    expect(shellEscapePath('/Users/j/My Project/a (1).png')).toBe('/Users/j/My\\ Project/a\\ \\(1\\).png')
    expect(shellEscapePath("/x/it's")).toBe("/x/it\\'s")
    expect(pathsForPrompt(['/a b', '/c'])).toBe('/a\\ b /c ')
  })
  it('keeps Windows paths as Windows Terminal drops them', () => {
    expect(windowsQuotePath('C:\\Users\\j\\a.png')).toBe('C:\\Users\\j\\a.png')
    expect(windowsQuotePath('C:\\My Project\\a (1).png')).toBe('"C:\\My Project\\a (1).png"')
    expect(pathsForPrompt(['C:\\x\\a.png', 'C:\\y z\\b.png'], 'windows')).toBe('C:\\x\\a.png "C:\\y z\\b.png" ')
  })
  it('keeps $ and ` literal for PowerShell: single quotes, a quote inside doubled', () => {
    expect(windowsQuotePath('C:\\data\\$cache\\x.txt')).toBe("'C:\\data\\$cache\\x.txt'")
    expect(windowsQuotePath("C:\\a`b\\it's.txt")).toBe("'C:\\a`b\\it''s.txt'")
  })
  it('hands WSL shells their own names for Windows paths, escaped for bash', () => {
    expect(pathShell('darwin', 'wsl')).toBe('posix')
    expect(pathShell('win32', 'native')).toBe('windows')
    expect(pathShell('win32', 'wsl')).toBe('wsl')
    expect(wslPath('C:\\Users\\me\\a.ts')).toBe('/mnt/c/Users/me/a.ts')
    expect(wslPath('D:\\')).toBe('/mnt/d')
    expect(wslPath('C:')).toBe('/mnt/c')
    expect(wslPath('\\\\wsl$\\Ubuntu\\home\\me\\p')).toBe('/home/me/p')
    expect(wslPath('\\\\wsl.localhost\\Ubuntu')).toBe('/')
    expect(wslPath('/home/me')).toBe('/home/me')
    expect(pathsForPrompt(['C:\\Users\\me\\a b.ts'], 'wsl')).toBe('/mnt/c/Users/me/a\\ b.ts ')
  })
  it('names the folders WSL reports the Windows way', () => {
    expect(windowsPathFromWsl('/mnt/c/proj/x')).toBe('C:\\proj\\x')
    expect(windowsPathFromWsl('/mnt/d')).toBe('D:\\')
    expect(windowsPathFromWsl('/home/me/p', 'Ubuntu')).toBe('\\\\wsl$\\Ubuntu\\home\\me\\p')
    expect(windowsPathFromWsl('/home/me/p')).toBe('/home/me/p')
    expect(windowsPathFromWsl('C:\\x', 'Ubuntu')).toBe('C:\\x')
  })
})

describe('OSC 7 reports', () => {
  it('gives the local path back', () => {
    expect(pathFromFileUri('file://mac.local/Users/j/My%20Project')).toBe('/Users/j/My Project')
    expect(pathFromFileUri('file://HOST/mnt/c/Projets')).toBe('/mnt/c/Projets')
    expect(pathFromFileUri('file:///C:/Projets/x%20y')).toBe('C:\\Projets\\x y')
    expect(pathFromFileUri('file:///C:/')).toBe('C:\\')
    expect(pathFromFileUri('file:///D:')).toBe('D:\\')
    expect(pathFromFileUri('file:///tmp/100%')).toBe('/tmp/100%')
    expect(pathFromFileUri('http://x/y')).toBeNull()
  })
})
