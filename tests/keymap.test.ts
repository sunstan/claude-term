import { describe, it, expect } from 'vitest'
import { ACTIONS, parse, matches, fromEvent, label, binding, conflicts, terminalSafe, findAction } from '../src/shared/keymap'
const ev = (key: string, code: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m })

describe('keymap', () => {
  it('JetBrains defaults, no conflicts by default', () => {
    expect(binding('editor.action.formatDocument', {})).toBe('Mod+Alt+L')
    expect(binding('editor.action.formatDocument', { 'editor.action.formatDocument': 'Mod+Shift+F' })).toBe('Mod+Shift+F')
    expect(binding('nope', {})).toBe('')
    expect(conflicts({})).toEqual({})
    expect(conflicts({ 'app.git': 'Mod+T' })).toMatchObject({ 'app.git': ['app.newShell'], 'app.newShell': ['app.git'] })
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length)
  })
  it('parse and match on macOS and Windows, composed keys fall back to the physical key', () => {
    expect(parse('Mod+Shift+L')).toEqual({ mod: true, ctrl: false, alt: false, shift: true, key: 'l' })
    expect(parse('')).toBeNull(); expect(parse('Mod+')).toBeNull(); expect(parse('Hyper+L')).toBeNull()
    expect(matches('Mod+Alt+L', ev('¬', 'KeyL', { metaKey: true, altKey: true }), true)).toBe(true)
    expect(matches('Mod+Alt+L', ev('l', 'KeyL', { ctrlKey: true, altKey: true }), false)).toBe(true)
    expect(matches('Mod+Alt+L', ev('l', 'KeyL', { metaKey: true }), true)).toBe(false)
    expect(matches('Mod+/', ev('/', 'Slash', { metaKey: true }), true)).toBe(true)
    expect(matches('Mod+1', ev('&', 'Digit1', { metaKey: true }), true)).toBe(true)
    expect(matches('Ctrl+Space', ev(' ', 'Space', { ctrlKey: true }), true)).toBe(true)
    expect(matches('Alt+Shift+ArrowUp', ev('ArrowUp', 'ArrowUp', { altKey: true, shiftKey: true }), true)).toBe(true)
    expect(matches('Bad+X', ev('x', 'KeyX'), true)).toBe(false)
  })
  it('recorder and labels', () => {
    expect(fromEvent(ev('Meta', 'MetaLeft', { metaKey: true }), true)).toBeNull()
    expect(fromEvent(ev('¬', 'KeyL', { metaKey: true, altKey: true }), true)).toBe('Mod+Alt+L')
    expect(fromEvent(ev('g', 'KeyG', { ctrlKey: true }), true)).toBe('Ctrl+G')
    expect(fromEvent(ev('l', 'KeyL', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+L')
    expect(fromEvent(ev('F6', 'F6', { shiftKey: true }), true)).toBe('Shift+F6')
    expect(fromEvent(ev('/', 'Slash', { metaKey: true }), true)).toBe('Mod+/')
    expect(label('Mod+Alt+L', true)).toBe('⌥⌘L'); expect(label('Ctrl+Shift+ArrowUp', true)).toBe('⌃⇧↑')
    expect(label('Mod+Alt+L', false)).toBe('Ctrl+Alt+L'); expect(label('Mod+Backspace', false)).toBe('Ctrl+Backspace'); expect(label('', true)).toBe('—')
  })
  it('VS Code preset, per platform where VS Code differs, without conflicts', () => {
    expect(binding('app.goToFile', {}, 'vscode')).toBe('Mod+P')
    expect(binding('app.commit', {}, 'vscode')).toBe('')
    expect(binding('app.closeTab', {}, 'vscode')).toBe('Mod+W')   // same as JetBrains
    expect(binding('editor.action.startFindReplaceAction', {}, 'vscode', false)).toBe('Mod+H')
    expect(binding('editor.action.startFindReplaceAction', {}, 'vscode', true)).toBe('Mod+Alt+F')
    expect(binding('app.goToFile', { 'app.goToFile': 'Mod+E' }, 'vscode')).toBe('Mod+E')
    for (const mac of [true, false]) { expect(conflicts({}, 'vscode', mac)).toEqual({}); expect(conflicts({}, 'jetbrains', mac)).toEqual({}) }
  })
  it('every project panel has its shortcut', () => {
    for (const id of ['app.explorer', 'app.search', 'app.history', 'app.skills', 'app.mcp', 'app.plugins', 'app.run']) expect(binding(id, {})).toMatch(/^Mod\+\d$/)
  })
  it('AltGr types, it is never a shortcut', () => {
    expect(matches('Mod+Alt+S', { ...ev('s', 'KeyS', { ctrlKey: true, altKey: true }), altGraph: true }, false)).toBe(false)
    expect(matches('Mod+Alt+S', ev('s', 'KeyS', { ctrlKey: true, altKey: true }), false)).toBe(true)
  })
  it('leaves Ctrl+letter to the shell in a terminal', () => {
    expect(terminalSafe('Mod+W', false)).toBe(false)
    expect(terminalSafe('Mod+K', false)).toBe(false)
    expect(terminalSafe('Mod+Shift+T', false)).toBe(true)
    expect(terminalSafe('Mod+Alt+S', false)).toBe(true)
    expect(terminalSafe('Mod+1', false)).toBe(true)
    expect(terminalSafe('Mod+,', false)).toBe(true)
    expect(terminalSafe('Ctrl+PageDown', false)).toBe(true)
    expect(terminalSafe('Mod+W', true)).toBe(true)    // ⌘W on macOS
    expect(terminalSafe('Ctrl+G', true)).toBe(false)  // ⌃G on macOS is the shell's
    const ctrlW = ev('w', 'KeyW', { ctrlKey: true })
    expect(findAction(ctrlW, {}, false)?.id).toBe('app.closeTab')
    expect(findAction(ctrlW, {}, false, { inTerminal: true })).toBeNull()
    expect(findAction(ev('T', 'KeyT', { ctrlKey: true, shiftKey: true }), {}, false, { inTerminal: true })?.id).toBe('app.newClaude')
    expect(findAction(ev('w', 'KeyW', { metaKey: true }), {}, true, { inTerminal: true })?.id).toBe('app.closeTab')
    expect(findAction(ev('p', 'KeyP', { ctrlKey: true }), {}, false, { preset: 'vscode' })?.id).toBe('app.goToFile')
  })
})
