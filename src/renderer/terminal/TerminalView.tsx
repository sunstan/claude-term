import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ResolvedTheme } from '@shared/theme'
import { OSC_SHELL } from '@shared/ipc'
import * as pathsMod from '@shared/paths'
const require_paths = () => pathsMod
import { useWorkbench, type Tab } from '@/stores/workbench'

/** Terminals live outside React (one xterm per tab), attached to the visible container. */
const terminals = new Map<string, { term: Terminal; fit: FitAddon; el: HTMLDivElement; dispose: () => void }>()
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

export function getOrCreate(tab: Tab, theme: ResolvedTheme, fontFamily: string, fontSize: number) {
  let t = terminals.get(tab.id)
  if (t) return t
  const term = new Terminal({
    allowProposedApi: true, cursorBlink: true, fontSize, fontFamily: monoFont(fontFamily),
    theme: xtermTheme(theme), scrollback: 10000, macOptionIsMeta: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const el = document.createElement('div')
  el.className = 'term'
  term.open(el)
  try { term.loadAddon(new WebglAddon()) } catch { /* canvas renderer fallback */ }
  const unsubs: (() => void)[] = []
  if (tab.ptyId) {
    const id = tab.ptyId
    unsubs.push(window.ct.pty.onData(id, (d) => term.write(d)))
    unsubs.push(window.ct.pty.onExit(id, (code) => { useWorkbench.getState().tabExited(id, code); term.write(`\r\n\x1b[90m[process terminé, code ${code}]\x1b[0m\r\n`) }))
    term.onData((d) => window.ct.pty.write(id, d))
    // ⌘V / Ctrl+V with an image on the clipboard: save it and type its path instead of pasting text
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key === 'v' && !e.shiftKey) {
        window.ct.attachments.clipboardImage().then((p) => { if (p) window.ct.pty.write(id, require_paths().pathsForPrompt([p], window.ct.platform === 'win32')) })
        return true   // text paste still goes through xterm's own handler
      }
      return true
    })
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
      if (paths.length) { window.ct.pty.write(id, require_paths().pathsForPrompt(paths, window.ct.platform === 'win32')); term.focus() }
    })
    term.onResize(({ cols, rows }) => window.ct.pty.resize(id, cols, rows))
    // shell integration (start/end of commands) and cwd reports
    term.parser.registerOscHandler(OSC_SHELL, (data) => { useWorkbench.getState().shellEvent(tab.id, data); return true })
    term.parser.registerOscHandler(7, (data) => {
      const p = require_paths().pathFromFileUri(data)
      if (p) useWorkbench.getState().setCwd(tab.id, p)
      return true
    })
  }
  t = { term, fit, el, dispose: () => { unsubs.forEach((u) => u()); term.dispose(); terminals.delete(tab.id) } }
  terminals.set(tab.id, t)
  return t
}

export function disposeTerminal(tabId: string) { terminals.get(tabId)?.dispose() }
export function focusTerminal(tabId: string) { terminals.get(tabId)?.term.focus() }

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

  return (
    <div className="term-wrap" ref={ref}>
      {!tab.alive && <span className="term-dead">terminé{tab.exitCode !== undefined ? ` (${tab.exitCode})` : ''}</span>}
    </div>
  )
}
