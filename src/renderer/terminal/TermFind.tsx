import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import { Icons } from '@/workbench/icons'
import { t } from '@/i18n'

/** The terminal whose find bar is open (one at a time). */
export const useTermFind = create<{ tabId: string | null; open(tabId: string): void; close(): void }>((set) => ({
  tabId: null, open: (tabId) => set({ tabId }), close: () => set({ tabId: null }),
}))

/** A CSS colour as #rrggbb (xterm decorations take nothing else), mixed with `over` by `amount`. */
function hex(color: string, over?: string, amount = 0): string {
  const c = document.createElement('canvas').getContext('2d')!
  const rgb = (x: string) => { c.clearRect(0, 0, 1, 1); c.fillStyle = x; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3) }
  const a = rgb(color), b = over ? rgb(over) : a
  return '#' + a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount).toString(16).padStart(2, '0')).join('')
}

/** Find bar over a terminal (its scrollback included): Enter / ⇧Enter next / previous, Esc back to the terminal. */
export function TermFindBar({ search, onDone }: { search: SearchAddon; onDone: () => void }) {
  const close = useTermFind((s) => s.close)
  const [q, setQ] = useState('')
  const [cs, setCs] = useState(false), [word, setWord] = useState(false), [re, setRe] = useState(false)
  const [res, setRes] = useState<{ index: number; count: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  useEffect(() => {
    const sub = search.onDidChangeResults((r) => setRes({ index: r.resultIndex, count: r.resultCount }))
    return () => { sub.dispose(); search.clearDecorations() }
  }, [search])
  const opts = (incremental: boolean): ISearchOptions => {
    const css = getComputedStyle(document.documentElement)
    const accent = css.getPropertyValue('--ct-accent').trim(), bg = css.getPropertyValue('--ct-terminal-bg').trim()
    return {
      caseSensitive: cs, wholeWord: word, regex: re, incremental,
      decorations: { matchBackground: hex(accent, bg, 0.7), matchOverviewRuler: hex(accent), activeMatchBackground: hex(accent, bg, 0.35), activeMatchColorOverviewRuler: hex(accent) },
    }
  }
  const find = (back: boolean, incremental = false) => {
    if (!q) { search.clearDecorations(); setRes(null); return }
    try { back ? search.findPrevious(q, opts(false)) : search.findNext(q, opts(incremental)) } catch { setRes({ index: -1, count: 0 }) }
  }
  useEffect(() => { find(false, true) }, [q, cs, word, re])
  const done = () => { close(); onDone() }
  const toggle = (on: boolean, set: (v: boolean) => void, label: string, title: string) =>
    <button className={'fb-opt' + (on ? ' on' : '')} title={title} aria-pressed={on} onClick={() => { set(!on); input.current?.focus() }}>{label}</button>
  return (
    <div className="findbar term-find" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done() } }}>
      <div className="fb-row">
        <span className="fb-ico">{Icons.search(13)}</span>
        <input ref={input} value={q} placeholder={t('Rechercher dans le terminal')} spellCheck={false} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey) } }} />
        {toggle(cs, setCs, 'Cc', t('Respecter la casse'))}{toggle(word, setWord, 'W', t('Mot entier'))}{toggle(re, setRe, '.*', t('Expression régulière'))}
        <span className={'fb-count' + (q && res && !res.count ? ' none' : '')}>{q && res ? (res.count ? `${res.index + 1}/${res.count}` : t('0 résultat')) : ''}</span>
        <button className="fb-btn" title={t('Précédent (⇧↩)')} onClick={() => find(true)}>{Icons.chevronUp(14)}</button>
        <button className="fb-btn" title={t('Suivant (↩)')} onClick={() => find(false)}>{Icons.chevronDown(14)}</button>
        <button className="fb-btn" title={t('Fermer (Échap)')} onClick={done}>{Icons.x(13)}</button>
      </div>
    </div>
  )
}
