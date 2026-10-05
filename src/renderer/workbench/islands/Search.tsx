import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icons } from '../icons'
import { FileIcon } from '../FileIcon'
import { Island, Empty } from '../Island'
import { PanelTabs } from '../PanelTabs'
import { useWorkbench, type Project } from '@/stores/workbench'
import { joinPath } from '@shared/claude-format'
import type { ContentMatch, ContentResult } from '@shared/search'
import { t } from '@/i18n'

/** A project-relative "/" path as an absolute one, with the root's own separators. */
const absolute = (root: string, rel: string) => joinPath(root, rel.split('/'))

/** File names (fuzzy) or contents (ripgrep) of the project; Enter or double-click opens in the editor. */
export function SearchIsland({ project }: { project: Project }) {
  return (
    <Island title={t('Recherche')} icon={Icons.search(14)} grow>
      <PanelTabs storeKey="search" tabs={[
        { id: 'names', label: t('Noms'), content: <NameSearch project={project} /> },
        { id: 'content', label: t('Contenu'), content: <ContentSearch project={project} /> },
      ]} />
    </Island>
  )
}

function NameSearch({ project }: { project: Project }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<string[]>([])
  const [sel, setSel] = useState(0)
  const openFile = useWorkbench((s) => s.openFile)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    if (!q.trim()) { setResults([]); return }
    let live = true
    const t = setTimeout(() => window.ct.search.files(project.root!, q).then((r) => { if (live) { setResults(r); setSel(0) } }), 120)
    return () => { live = false; clearTimeout(t) }
  }, [q, project.root])
  const open = (rel: string) => openFile(project.id, absolute(project.root!, rel))
  return (
    <>
      <div className="search">
        <input ref={ref} value={q} placeholder={t('nom de fichier…')} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
            else if (e.key === 'Enter' && results[sel]) open(results[sel])
          }} />
      </div>
      {q && results.length === 0 && <Empty>{t('Aucun fichier')}</Empty>}
      <div className="results">
        {results.map((r, i) => (
          <div key={r} className={'frow' + (i === sel ? ' sel' : '')} onClick={() => setSel(i)} onDoubleClick={() => open(r)} title={r}>
            <FileIcon path={r} size={14} />
            <span className="name">{r.split('/').pop()}</span>
            <span className="rel">{r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : ''}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/** A match's line with its hits highlighted, leading spaces dropped, and cut before the first hit when it is far in. */
function Line({ m }: { m: ContentMatch }) {
  const first = m.ranges[0]?.[0] ?? 0
  const lead = m.text.length - m.text.trimStart().length
  const from = first - lead > 24 ? first - 12 : Math.min(lead, first)
  const parts: ReactNode[] = from > lead ? ['…'] : []
  let at = from
  for (const [a, b] of m.ranges) {
    if (b <= at) continue
    if (a > at) parts.push(m.text.slice(at, a))
    parts.push(<mark key={a}>{m.text.slice(Math.max(a, at), b)}</mark>)
    at = b
  }
  parts.push(m.text.slice(at))
  return <>{parts}</>
}

function ContentSearch({ project }: { project: Project }) {
  const [q, setQ] = useState('')
  const [cs, setCs] = useState(false), [word, setWord] = useState(false), [re, setRe] = useState(false)
  const [filters, setFilters] = useState(false)
  const [include, setInclude] = useState(''), [exclude, setExclude] = useState('')
  const [res, setRes] = useState<ContentResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState(0)
  const openFile = useWorkbench((s) => s.openFile)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    if (!q) { setRes(null); return }
    let live = true
    const timer = setTimeout(() => {
      setBusy(true)
      window.ct.search.content(project.root!, { query: q, caseSensitive: cs, wholeWord: word, regex: re, include, exclude })
        .then((r) => { if (live) { setRes(r); setSel(0); setClosed(new Set()) } }).finally(() => { if (live) setBusy(false) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [q, cs, word, re, include, exclude, project.root])
  // the visible match rows, in order, for the keyboard
  const rows = useMemo(() => (res?.files ?? []).flatMap((f) => (closed.has(f.path) ? [] : f.matches.map((m) => ({ path: f.path, m })))), [res, closed])
  const open = (path: string, line: number) => openFile(project.id, absolute(project.root!, path), line)
  const toggle = (on: boolean, set: (v: boolean) => void, label: string, title: string) =>
    <button className={'fb-opt' + (on ? ' on' : '')} title={title} aria-pressed={on} onClick={() => set(!on)}>{label}</button>
  let index = 0
  return (
    <>
      <div className="search content-search">
        <div className="fb-row">
          <input ref={ref} className={res?.error ? 'bad' : ''} value={q} placeholder={t('texte à chercher…')} spellCheck={false} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
              else if (e.key === 'Enter' && rows[sel]) open(rows[sel].path, rows[sel].m.line)
            }} />
          {toggle(cs, setCs, 'Cc', t('Respecter la casse'))}{toggle(word, setWord, 'W', t('Mot entier'))}{toggle(re, setRe, '.*', t('Expression régulière'))}
          <button className={'fb-btn' + (filters || include || exclude ? ' on' : '')} title={t('Fichiers à inclure / exclure')} onClick={() => setFilters(!filters)}>{Icons.filter(13)}</button>
        </div>
        {filters && <>
          <input value={include} placeholder={t('fichiers à inclure (ex. src/**, *.ts)')} spellCheck={false} onChange={(e) => setInclude(e.target.value)} />
          <input value={exclude} placeholder={t('fichiers à exclure (ex. **/*.test.ts)')} spellCheck={false} onChange={(e) => setExclude(e.target.value)} />
        </>}
        {res && q && (
          <div className="cs-summary muted">
            {res.error ? <span className="error">{res.error}</span>
              : res.count ? t('{n} résultat(s) dans {f} fichier(s)', { n: res.count, f: res.files.length }) + (res.truncated ? ' · ' + t('limite atteinte') : '') : busy ? '' : t('Aucun résultat')}
          </div>
        )}
      </div>
      <div className="results">
        {res?.files.map((f) => {
          const isOpen = !closed.has(f.path)
          return (
            <div key={f.path}>
              <div className="frow cs-file" title={f.path} onClick={() => setClosed((c) => { const n = new Set(c); if (isOpen) n.add(f.path); else n.delete(f.path); return n })}>
                <span className="chev">{isOpen ? Icons.chevronDown(12) : Icons.chevron(12)}</span>
                <FileIcon path={f.path} size={14} />
                <span className="name">{f.path.split('/').pop()}</span>
                <span className="rel">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                <span className="cs-count">{f.matches.length}</span>
              </div>
              {isOpen && f.matches.map((m) => {
                const i = index++
                return (
                  <div key={m.line + ':' + i} className={'frow cs-line' + (i === sel ? ' sel' : '')} onClick={() => setSel(i)} onDoubleClick={() => open(f.path, m.line)}>
                    <span className="cs-ln">{m.line}</span><span className="cs-text"><Line m={m} /></span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </>
  )
}
