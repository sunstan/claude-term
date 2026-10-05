import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ViewAction, ViewItem, ViewModel } from '@shared/plugins'
import { FILE_COLORS, filterItems } from '@shared/plugins'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Icons } from './icons'
import { FileIcon } from './FileIcon'
import { Island, Empty } from './Island'
import { ContextMenu, type MenuItem } from './Menu'
import { treeKeyOf, usePlugins } from '@/stores/plugins'
import { useWorkbench } from '@/stores/workbench'
import { Gutter, useStoredSize } from './Split'
import { t } from '@/i18n'

const icon = (name: string | undefined, size = 12) => {
  const f = (Icons as Record<string, ((s?: number) => React.ReactElement) | undefined>)[name ?? '']
  return f ? f(size) : Icons.puzzle(size)
}
const colorOf = (c?: string) => (!c ? undefined : c.startsWith('#') ? c : `var(--ct-${c.replace(/\./g, '-')})`)

/** Colored extension chip for a file path. */
function FileChip({ path }: { path: string }) {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  const color = FILE_COLORS[ext] ?? 'var(--ct-text-tertiary)'
  const label = ext.length <= 4 && ext !== path.toLowerCase() ? ext.slice(0, 4) : '·'
  return <span className="fchip" style={{ background: `color-mix(in srgb, ${color} 22%, transparent)`, color }}>{label}</span>
}

export type Send = (type: 'select' | 'open' | 'action' | 'toolbar' | 'check' | 'input' | 'button' | 'menu', extra?: { itemId?: string; actionId?: string; value?: boolean | string; fieldId?: string }) => void

/** Renders a plugin's declarative view model inside an island (sidebar placement). */
export function PluginViewIsland({ viewId, title, grow }: { viewId: string; title: string; grow?: boolean }) {
  const model = usePlugins((s) => s.views[viewId])
  const root = useWorkbench((s) => s.projects.find((p) => p.id === s.activeProjectId)?.root)
  const treeKey = treeKeyOf(viewId, root)
  useEffect(() => { if (!model) window.ct.plugins.view(viewId).then((m) => { if (m) usePlugins.setState((s) => ({ views: { ...s.views, [viewId]: m } })) }) }, [viewId])
  const send: Send = (type, extra) => window.ct.plugins.event({ viewId, type, ...extra })
  const folds = model?.kind === 'tree' && model.foldAll ? groupIds(model.items) : []
  const toolbar = (model && 'toolbar' in model && model.toolbar?.length) || folds.length ? (
    <>
      {model && 'toolbar' in model && model.toolbar?.map((a) => <button key={a.id} title={a.title} disabled={a.disabled} onClick={() => send('toolbar', { actionId: a.id })}>{icon(a.icon, 14)}</button>)}
      {folds.length > 0 && <>
        <button title={t('Tout replier')} onClick={() => usePlugins.getState().setAllOpen(treeKey, folds, false)}>{Icons.collapseAll(14)}</button>
        <button title={t('Tout déplier')} onClick={() => usePlugins.getState().setAllOpen(treeKey, folds, true)}>{Icons.expandAll(14)}</button>
      </>}
    </>
  ) : undefined
  return (
    <Island title={(model && 'title' in model && model.title) || title} icon={Icons.puzzle(14)} actions={toolbar} grow={grow} dataView={viewId}>
      <PluginViewBody model={model} send={send} layoutKey={viewId} stateKey={treeKey} />
    </Island>
  )
}

/** The nodes of a tree that have children: what folds. */
function groupIds(items: ViewItem[]): string[] {
  return items.flatMap((i) => (i.children?.length ? [i.id, ...groupIds(i.children)] : []))
}

/** The body of a view: list/tree with optional search, footer and detail pane; markdown; diff. */
export function PluginViewBody({ model, send, wide, layoutKey = 'pv', stateKey }: { model: ViewModel | undefined; send: Send; wide?: boolean; layoutKey?: string; stateKey?: string }) {
  // sizes go by layoutKey; open / closed nodes by stateKey (a plugin view's: per project)
  const treeKey = stateKey ?? layoutKey
  const [q, setQ] = useState('')
  // a view with foldAll forgets the folds of nodes it no longer shows; not the first model seen under a key, which
  // may still be another project's
  const seenKey = useRef<string | null>(null)
  useEffect(() => {
    if (model?.kind !== 'tree' || !model.foldAll) return
    if (seenKey.current === treeKey) usePlugins.getState().forgetMissing(treeKey, new Set(groupIds(model.items)))
    seenKey.current = treeKey
  }, [model, treeKey])
  const [ctx, setCtx] = useState<{ x: number; y: number; item: ViewItem } | null>(null)
  // keyboard: a cursor over the visible rows (DOM order); Enter does what a double click does
  const [cursor, setCursor] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowsOf = () => [...(listRef.current?.querySelectorAll<HTMLElement>('.pv-row[data-id]') ?? [])]
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const rows = rowsOf()
    const i = rows.findIndex((r) => r.dataset.id === cursor)
    const at = i >= 0 ? rows[i] : null
    const go = (r?: HTMLElement) => { if (!r) return; setCursor(r.dataset.id!); r.scrollIntoView({ block: 'nearest' }) }
    const group = at?.dataset.group === '1', open = at?.dataset.open === '1'
    const toggle = (o: boolean) => at && usePlugins.getState().setOpen(treeKey, at.dataset.id!, o)
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(i < 0 ? rows[0] : rows[i + 1]); break
      case 'ArrowUp':
        e.preventDefault()
        if (i <= 0 && model && 'search' in model && model.search) { setCursor(null); (listRef.current?.parentElement?.querySelector('.search input') as HTMLInputElement | null)?.focus() }
        else go(rows[i - 1])
        break
      case 'ArrowRight': e.preventDefault(); if (group && !open) toggle(true); else if (group) go(rows[i + 1]); break
      case 'ArrowLeft': {
        e.preventDefault()
        if (group && open) { toggle(false); break }
        const depth = Number(at?.dataset.depth ?? 0)
        for (let j = i - 1; j >= 0; j--) if (Number(rows[j].dataset.depth) < depth) { go(rows[j]); break }
        break
      }
      case 'Enter': e.preventDefault(); if (at) { if (group) toggle(!open); else send('open', { itemId: at.dataset.id }) } break
      case ' ': if (at?.dataset.check) { e.preventDefault(); send('check', { itemId: at.dataset.id, value: at.dataset.check !== '1' }) } break
    }
  }
  if (!model) return <Empty>{t('Chargement…')}</Empty>
  if (model.kind === 'empty') return <Empty>{model.text}</Empty>
  if (model.kind === 'markdown') return <div className="md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(model.text, { async: false }) as string) }} />
  if (model.kind === 'diff') return <DiffText text={model.text} />
  if (model.kind === 'stack') return <Stack panes={model.panes} send={send} layoutKey={layoutKey} />
  if (model.kind === 'detail') return (
    <div className="pv-info">
      {model.body && <div className="pv-info-body">{model.body}</div>}
      <div className="pv-info-fields">{model.fields.map((f) => <div key={f.label} className="pv-info-row"><span className="k">{f.label}</span><span className={'v' + (f.mono ? ' mono' : '')}>{f.value}</span></div>)}</div>
    </div>
  )
  const items = q ? filterItems(model.items, q.toLowerCase()) : model.items
  const list = (
    <div className="pv-main">
      {model.search && <div className="search"><input value={q} placeholder={t('filtrer…')} onChange={(e) => setQ(e.target.value)} autoFocus
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.focus(); const first = rowsOf()[0]; if (first) setCursor(first.dataset.id!) } }} /></div>}
      <div className={'list pv' + (model.kind === 'list' && model.graph ? ' graph' : '')} tabIndex={0} ref={listRef} onKeyDown={onListKey}>
        <Cursor.Provider value={{ cursor, setCursor }}>
        {items.length === 0 && <Empty>{q ? t('Aucun résultat') : '—'}</Empty>}
        {items.map((it) => <Node key={it.id} item={it} depth={0} tree={model.kind === 'tree'} send={send} stateKey={treeKey} forceOpen={!!q} graphWidth={model.kind === 'list' && model.graph && !q ? Math.max(1, ...model.items.map((x) => x.graph?.width ?? 1)) : 0} onMenu={(e, item) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, item }) }} />)}
        </Cursor.Provider>
      </div>
      {model.footer && <Footer footer={model.footer} send={send} />}
      <ContextMenu at={ctx} onClose={() => setCtx(null)} items={(ctx?.item.contextMenu ?? []).map((a): MenuItem | 'sep' => a === 'sep' ? 'sep' : { label: a.title, icon: a.icon ? icon(a.icon, 13) : undefined, shortcut: a.shortcut, disabled: a.disabled, onSelect: () => send('menu', { itemId: ctx!.item.id, actionId: a.id }) })} />
    </div>
  )
  if (model.detail && wide) return <Split list={list} detail={<PluginViewBody model={model.detail} send={send} layoutKey={layoutKey + ':detail'} />} layoutKey={layoutKey} />
  return list
}

/** List on the left (75 % by default), detail on the right; the separator is draggable and remembered. */
function Split({ list, detail, layoutKey }: { list: ReactNode; detail: ReactNode; layoutKey: string }) {
  const [pct, setPct] = useStoredSize('split:' + layoutKey, 75)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className="pv-split" ref={ref}>
      <div className="pv-split-main" style={{ width: `${pct}%` }}>{list}</div>
      <Gutter axis="x" className="inner" size={pct} onSize={setPct} min={20} max={90} reset={75} scale={() => 100 / (ref.current?.clientWidth || 1000)} />
      <div className="pv-detail">{detail}</div>
    </div>
  )
}

/** Panes stacked vertically; each separator is draggable, heights remembered as fractions. */
function Stack({ panes, send, layoutKey }: { panes: ViewModel[]; send: Send; layoutKey: string }) {
  const [first, setFirst] = useStoredSize('stack:' + layoutKey, 50)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className="pv-stack" ref={ref}>
      {panes.map((p, i) => (
        <div key={i} className="pv-stack-pane" style={i === 0 && panes.length > 1 ? { height: `${first}%`, flex: 'none' } : undefined}>
          {i > 0 && <Gutter axis="y" className="inner" size={first} onSize={setFirst} min={10} max={90} reset={50} scale={() => 100 / (ref.current?.clientHeight || 600)} />}
          <PluginViewBody model={p} send={send} layoutKey={`${layoutKey}:${i}`} />
        </div>
      ))}
    </div>
  )
}

const GRAPH_COLORS = ['#61afef', '#e5c07b', '#98c379', '#c678dd', '#e06c75', '#56b6c2', '#d19a66', '#ff9a3c']
const LANE = 14, ROW = 24

/** One row of the commit graph: segments to/from the row middle, and the commit dot. */
function GraphCell({ g, width }: { g: NonNullable<ViewItem['graph']>; width: number }) {
  const x = (i: number) => LANE / 2 + i * LANE, mid = ROW / 2
  const col = (c: number) => GRAPH_COLORS[c % GRAPH_COLORS.length]
  return (
    <svg className="pv-graph" width={width * LANE} height={ROW} aria-hidden>
      {g.up.map(([a, b, c], i) => <path key={'u' + i} d={a === b ? `M${x(a)} 0V${mid}` : `M${x(a)} 0C${x(a)} ${mid * 0.6} ${x(b)} ${mid * 0.4} ${x(b)} ${mid}`} stroke={col(c)} strokeWidth={1.6} fill="none" />)}
      {g.down.map(([a, b, c], i) => <path key={'d' + i} d={a === b ? `M${x(a)} ${mid}V${ROW}` : `M${x(a)} ${mid}C${x(a)} ${mid + mid * 0.6} ${x(b)} ${mid + mid * 0.4} ${x(b)} ${ROW}`} stroke={col(c)} strokeWidth={1.6} fill="none" />)}
      <circle cx={x(g.node)} cy={mid} r={3.6} fill={col(g.color)} stroke="var(--ct-island-bg)" strokeWidth={1.2} />
    </svg>
  )
}


function DiffText({ text }: { text: string }) {
  return <div className="diff">{text.split('\n').map((l, i) => <div key={i} className={'dl ' + (l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '')}>{l}</div>)}</div>
}

function Footer({ footer, send }: { footer: NonNullable<Extract<ViewModel, { kind: 'list' }>['footer']>; send: Send }) {
  const [vals, setVals] = useState<Record<string, string>>({})
  useEffect(() => { setVals((v) => { const n = { ...v }; for (const f of footer.fields ?? []) if (n[f.id] === undefined) n[f.id] = f.value ?? ''; return n }) }, [footer.fields?.map((f) => f.id + f.value).join('|')])
  return (
    <div className="pv-footer">
      {footer.fields?.map((f) => f.multiline
        ? <textarea key={f.id} placeholder={f.placeholder} value={vals[f.id] ?? ''} rows={3} onChange={(e) => { setVals({ ...vals, [f.id]: e.target.value }); send('input', { fieldId: f.id, value: e.target.value }) }} />
        : <input key={f.id} placeholder={f.placeholder} value={vals[f.id] ?? ''} onChange={(e) => { setVals({ ...vals, [f.id]: e.target.value }); send('input', { fieldId: f.id, value: e.target.value }) }} />)}
      {(footer.checks?.length || footer.buttons?.length) ? (
        <div className="pv-footer-row">
          {footer.checks?.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={c.checked} onChange={(e) => send('check', { itemId: c.id, value: e.target.checked })} /> {c.label}</label>)}
          <span className="spacer" />
          {footer.buttons?.map((b) => <button key={b.id} className={'btn' + (b.primary ? ' primary' : '')} disabled={b.disabled} title={b.title} onClick={() => send('button', { actionId: b.id })}>{b.icon && icon(b.icon, 13)} {b.title}</button>)}
        </div>
      ) : null}
    </div>
  )
}

function checkState(item: ViewItem): boolean | 'mixed' | undefined {
  if (item.children?.length) {
    const states = item.children.map(checkState).filter((s) => s !== undefined)
    if (!states.length) return item.checked
    if (states.every((s) => s === true)) return true
    if (states.every((s) => s === false)) return false
    return 'mixed'
  }
  return item.checked
}

/** the keyboard cursor of a list (see onListKey) */
const Cursor = createContext<{ cursor: string | null; setCursor: (id: string) => void }>({ cursor: null, setCursor: () => {} })

function Node({ item, depth, tree, send, onMenu, graphWidth = 0, stateKey, forceOpen }: { item: ViewItem; depth: number; tree: boolean; send: Send; onMenu: (e: React.MouseEvent, item: ViewItem) => void; graphWidth?: number; stateKey: string; forceOpen?: boolean }) {
  // the user's choice (kept per view in settings.treeState) wins over the plugin's default; a search opens matches
  const chosen = usePlugins((s) => s.treeState[stateKey]?.[item.id])
  const open = forceOpen || (chosen ?? item.expanded ?? true)
  const setOpen = (o: boolean) => usePlugins.getState().setOpen(stateKey, item.id, o)
  const hasChildren = tree && !!item.children?.length
  const kbd = useContext(Cursor)
  const cs = checkState(item)
  const cbRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (cbRef.current) cbRef.current.indeterminate = cs === 'mixed' }, [cs])
  return (
    <>
      <div className={'lrow pv-row' + (hasChildren && !item.folder && !item.file && depth === 0 ? ' group' : '') + (item.folder ? ' folder' : '') + (item.muted ? ' muted' : '') + (item.selected ? ' sel' : '') + (item.tone ? ' tone-' + item.tone : '') + (kbd.cursor === item.id ? ' kbd' : '')} style={{ paddingLeft: 8 + depth * 20 }}
        data-id={item.id} data-depth={depth} data-group={hasChildren ? '1' : undefined} data-open={hasChildren && open ? '1' : undefined} data-check={cs === undefined ? undefined : cs === true ? '1' : '0'}
        onMouseDown={() => kbd.setCursor(item.id)}
        onClick={() => (hasChildren ? setOpen(!open) : send('select', { itemId: item.id }))} onDoubleClick={() => !hasChildren && send('open', { itemId: item.id })}
        onContextMenu={(e) => item.contextMenu?.length && onMenu(e, item)} title={item.detail}>
        {graphWidth > 0 && item.graph ? <GraphCell g={item.graph} width={graphWidth} /> : null}
        {hasChildren ? <span className={'chev' + (open ? ' open' : '')}>{Icons.chevron(10)}</span> : tree ? <span className="chev placeholder" /> : null}
        {cs !== undefined && <input ref={cbRef} type="checkbox" className="pv-check" checked={cs === true} onClick={(e) => e.stopPropagation()} onChange={(e) => send('check', { itemId: item.id, value: e.target.checked })} />}
        {item.folder ? <FileIcon path={item.folder} isDir open={open} size={16} /> : !hasChildren && (item.file ? <FileIcon path={item.file} size={16} /> : item.graph ? null : <span className="ico" style={{ color: colorOf(item.color) }}>{icon(item.icon)}</span>)}
        <span className="pv-label"><span className="name">{item.label}</span>{item.detail && <span className="pv-detail-inline">{item.detail}</span>}{item.badges?.map((b) => <span key={b} className="badge dim">{b}</span>)}</span>
        {item.extra && <span className="pv-extra">{item.extra}</span>}
        {item.actions?.length ? (
          <span className={'acts' + (item.actions.some((a) => a.primary) ? ' always' : '')}>
            {item.actions.map((a) => <button key={a.id} title={a.title} className={a.primary ? 'primary' : ''} disabled={a.disabled} onClick={(e) => { e.stopPropagation(); send('action', { itemId: item.id, actionId: a.id }) }}>{icon(a.icon)}</button>)}
          </span>
        ) : null}
      </div>
      {hasChildren && open && item.children!.map((c) => <Node key={c.id} item={c} depth={depth + 1} tree={tree} send={send} onMenu={onMenu} stateKey={stateKey} forceOpen={forceOpen} />)}
    </>
  )
}

/** Popover anchored under a view's island header. */
export function PluginPopover({ id, anchorViewId, model, onClose }: { id: string; anchorViewId: string; model: ViewModel; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const el = document.querySelector(`[data-view="${anchorViewId}"] > .hdr`)
    const r = el?.getBoundingClientRect()
    setPos(r ? { x: Math.max(8, r.left), y: r.bottom + 4 } : { x: 100, y: 100 })
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [anchorViewId])
  if (!pos) return null
  const send: Send = (type, extra) => window.ct.plugins.event({ viewId: id, type, ...extra })
  return (
    <div className="menu ctx popover" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <PluginViewBody model={model} send={send} layoutKey={id} />
    </div>
  )
}
