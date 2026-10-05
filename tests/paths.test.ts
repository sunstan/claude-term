import { describe, it, expect } from 'vitest'
import { shellEscapePath, pathsForPrompt, pathFromFileUri, windowsQuotePath } from '../src/shared/paths'
describe('paths for the prompt', () => {
  it('escapes shell-special characters like a terminal drop', () => {
    expect(shellEscapePath('/Users/j/My Project/a (1).png')).toBe('/Users/j/My\\ Project/a\\ \\(1\\).png')
    expect(shellEscapePath("/x/it's")).toBe("/x/it\\'s")
    expect(pathsForPrompt(['/a b', '/c'])).toBe('/a\\ b /c ')
  })
  it('keeps Windows paths as Windows Terminal drops them', () => {
    expect(windowsQuotePath('C:\\Users\\j\\a.png')).toBe('C:\\Users\\j\\a.png')
    expect(windowsQuotePath('C:\\My Project\\a (1).png')).toBe('"C:\\My Project\\a (1).png"')
    expect(pathsForPrompt(['C:\\x\\a.png', 'C:\\y z\\b.png'], true)).toBe('C:\\x\\a.png "C:\\y z\\b.png" ')
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
