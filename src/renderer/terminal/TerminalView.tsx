import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import type { ResolvedTheme } from '@shared/theme'
import { OSC_SHELL } from '@shared/ipc'
import * as pathsMod from '@shared/paths'
const require_paths = () => pathsMod
import { useWorkbench, tabPathShell, provideTerminalText, type Tab } from '@/stores/workbench'
import { lastLines } from '@shared/workspace'
import { binding, findAction, matches } from '@shared/keymap'
import { TermFindBar, useTermFind } from './TermFind'
import { keyEvent, pluginCommandFor } from '@/actions'
import { t as tr } from '@/i18n'

/** Terminals live outside React (one xterm per tab), attached to the visible container. */
const terminals = new Map<string, { term: Terminal; fit: FitAddon; search: SearchAddon; el: HTMLDivElement; dispose: () => void }>()

// at quit the workspace saves each shell's last lines (userData/scrollback)
provideTerminalText((tabId) => {
  const b = terminals.get(tabId)?.term.buffer.active
  if (!b) return null
  const lines: string[] = []
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
  return lastLines(lines, 1000) || null
})
if (import.meta.env.DEV || window.ct.debug) (window as any).__ct_termText = (tabId: string) => {
  const t = terminals.get(tabId)?.term; if (!t) return null
  const b = t.buffer.active; const lines: string[] = []
  for (let i = Math.max(0, b.baseY + b.cursorY - 5); i <= b.baseY + b.cursorY; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
  return lines
}

function xtermTheme(t: ResolvedTheme) {
  const k = t.tokens
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = t.ansi
  return {
    background: k['terminal.bg'], foreground: k['terminal.fg'], cursor: k['terminal.cursor'], cursorAccent: k['terminal.bg'],
    selectionBackground: k['terminal.selection'],
    black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  }
}

/** xterm needs a real font list (WebGL measures glyphs with ctx.font): resolve our CSS variable. */
function monoFont(pref: string): string {
  if (pref) return `"${pref}", ${defaultMono()}`
  return defaultMono()
}
function defaultMono(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--ct-font-mono').trim() || 'Menlo, monospace'
}

/** Creates a tab's terminal before it is first shown (a script started in the background): nothing it prints is lost. */
export function prepareTerminal(tab: Tab) {
  const s = useWorkbench.getState()
  if (s.theme && s.settings) getOrCreate(tab, s.theme, s.settings.fontFamily, s.settings.fontSize)
}

export function getOrCreate(tab: Tab, theme: ResolvedTheme, fontFamily: string, fontSize: number) {
  let t = terminals.get(tab.id)
  if (t) return t
  const term = new Terminal({
    allowProposedApi: true, cursorBlink: true, fontSize, fontFamily: monoFont(fontFamily),
    theme: xtermTheme(theme), scrollback: 10000, macOptionIsMeta: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const search = new SearchAddon({ highlightLimit: 1000 })
  term.loadAddon(search)
  const el = document.createElement('div')
  el.className = 'term'
  term.open(el)
  try { term.loadAddon(new WebglAddon()) } catch { /* canvas renderer fallback */ }
  const unsubs: (() => void)[] = []
  // a shell reopened from the last launch: its last lines first, greyed, above the new prompt
  if (tab.replay) {
    term.write('\x1b[90m' + tab.replay.replace(/\r?\n/g, '\r\n') + '\r\n── ' + tr('session restaurée') + ' ──\x1b[0m\r\n')
    const tabId = tab.id
    queueMicrotask(() => useWorkbench.setState((s) => ({ projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((x) => (x.id === tabId ? { ...x, replay: undefined } : x)) })) })))
  }
  if (tab.ptyId) {
    const id = tab.ptyId
    unsubs.push(window.ct.pty.onData(id, (d) => term.write(d)))
    unsubs.push(window.ct.pty.onExit(id, (code) => { useWorkbench.getState().tabExited(id, code); term.write(`\r\n\x1b[90m[process terminé, code ${code}]\x1b[0m\r\n`) }))
    term.onData((d) => window.ct.pty.write(id, d))
    const mac = window.ct.platform === 'darwin', win = window.ct.platform === 'win32'
    const isClaudeTab = () => { const t = useWorkbench.getState().projects.flatMap((p) => p.tabs).find((x) => x.ptyId === id); return !!t && (t.kind === 'claude' || t.claudeRunning) }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // the app's shortcuts go up to the window listener (App.tsx): xterm would send them to the shell and stop them
      const s = useWorkbench.getState().settings
      if (findAction(keyEvent(e), s?.keybindings ?? {}, mac, { preset: s?.keymapPreset, inTerminal: true }) || pluginCommandFor(keyEvent(e), true)) return false
      if (matches(binding('terminal.find', s?.keybindings ?? {}, s?.keymapPreset, mac), keyEvent(e), mac)) { e.preventDefault(); useTermFind.getState().open(tab.id); return false }
      if (!mac && e.ctrlKey && !e.altKey && !e.metaKey) {
        const k = e.code === 'KeyC' ? 'c' : e.code === 'KeyV' ? 'v' : ''
        // Ctrl+C copies the selection when there is one (Windows Terminal's rule), else it stays the interrupt
        if (k === 'c' && (term.hasSelection() || e.shiftKey)) {
          if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection() }
          return false
        }
        // Ctrl+Shift+V, and Ctrl+V in a Claude tab on Windows: the browser's paste (handled below), sent as a bracketed
        // paste. Ctrl+V stays ^V elsewhere: PSReadLine pastes the clipboard itself (several lines without running
        // them), Claude Code on Linux reads its image.
        if (k === 'v' && (e.shiftKey || (win && isClaudeTab()))) return false
        if (k === 'v' && win) window.ct.attachments.clipboardImage().then((p) => { if (p) window.ct.pty.write(id, require_paths().pathsForPrompt([p], tabPathShell())) })
      }
      return true
    })
    // a clipboard holding an image and no text: Claude reads it itself (Alt+V on Windows); a shell gets the saved file's path
    el.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items ?? [])
      const image = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'))
      if (!image || items.some((i) => i.kind === 'string' && i.type === 'text/plain')) return
      e.preventDefault(); e.stopPropagation()
      if (win && isClaudeTab()) { window.ct.pty.write(id, '\x1bv'); return }
      const blob = image.getAsFile()
      if (!blob) return
      const fr = new FileReader()
      fr.onload = async () => { const p = await window.ct.attachments.saveDataUrl(String(fr.result)); if (p) window.ct.pty.write(id, require_paths().pathsForPrompt([p], tabPathShell())) }
      fr.readAsDataURL(blob)
    }, true)
    // drop: files (their paths), images (saved), or plain-text paths from our own tree
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy' })
    el.addEventListener('drop', async (e) => {
      e.preventDefault()
      const paths: string[] = []
      for (const f of Array.from(e.dataTransfer?.files ?? [])) { const p = window.ct.attachments.pathForFile(f); if (p) paths.push(p) }
      if (!paths.length) {
        const txt = e.dataTransfer?.getData('text/plain') ?? ''
        if (txt.startsWith('/') || /^[A-Za-z]:\\/.test(txt)) paths.push(...txt.split('\n').filter(Boolean))
      }
      if (!paths.length) {
        for (const item of Array.from(e.dataTransfer?.items ?? [])) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const blob = item.getAsFile(); if (!blob) continue
            const url = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsDataURL(blob) })
            const p = await window.ct.attachments.saveDataUrl(url); if (p) paths.push(p)
          }
        }
      }
      if (paths.length) { window.ct.pty.write(id, require_paths().pathsForPrompt(paths, tabPathShell())); term.focus() }
    })
    term.onResize(({ cols, rows }) => window.ct.pty.resize(id, cols, rows))
    // shell integration (start/end of commands) and cwd reports
    term.parser.registerOscHandler(OSC_SHELL, (data) => { useWorkbench.getState().shellEvent(tab.id, data); return true })
    term.parser.registerOscHandler(7, (data) => {
      const p = require_paths().pathFromFileUri(data)
      if (p) useWorkbench.getState().setCwd(tab.id, p)
      return true
    })
    // Claude Code's title: a spinner while it works, ✳ at rest
    term.onTitleChange((title) => useWorkbench.getState().claudeTitle(tab.id, title))
  }
  t = { term, fit, search, el, dispose: () => { unsubs.forEach((u) => u()); term.dispose(); terminals.delete(tab.id) } }
  terminals.set(tab.id, t)
  return t
}

export function disposeTerminal(tabId: string) { terminals.get(tabId)?.dispose() }
export function focusTerminal(tabId: string) { terminals.get(tabId)?.term.focus() }
export function terminalSelection(tabId: string): string { return terminals.get(tabId)?.term.getSelection() ?? '' }

export function TerminalHost({ tab }: { tab: Tab }) {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useWorkbench((s) => s.theme)!
  const settings = useWorkbench((s) => s.settings)!

  useEffect(() => {
    const host = ref.current!
    const t = getOrCreate(tab, theme, settings.fontFamily, settings.fontSize)
    host.appendChild(t.el)
    const ro = new ResizeObserver(() => { try { t.fit.fit() } catch { /* not laid out yet */ } })
    ro.observe(host)
    requestAnimationFrame(() => { try { t.fit.fit() } catch {} ; t.term.focus() })
    return () => { ro.disconnect(); if (t.el.parentElement === host) host.removeChild(t.el) }
  }, [tab.id])

  useEffect(() => {
    const t = terminals.get(tab.id)
    if (!t) return
    t.term.options.theme = xtermTheme(theme)
    t.term.options.fontSize = settings.fontSize
    t.term.options.fontFamily = monoFont(settings.fontFamily)
    try { t.fit.fit() } catch {}
  }, [theme, settings.fontFamily, settings.fontSize, tab.id])

  const finding = useTermFind((s) => s.tabId === tab.id)
  const search = terminals.get(tab.id)?.search
  return (
    <div className="term-wrap" ref={ref}>
      {!tab.alive && <span className="term-dead">terminé{tab.exitCode !== undefined ? ` (${tab.exitCode})` : ''}</span>}
      {finding && search && <TermFindBar search={search} onDone={() => focusTerminal(tab.id)} />}
    </div>
  )
}
