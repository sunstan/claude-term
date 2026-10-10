import { useEffect, useState, type DragEvent } from 'react'
import { defaultLinkName, matchesFilter, normalizeUrl, type MemoLink, type MemoNote, type MemoPin, type ProjectMemo } from '@shared/memo'
import { reorder } from '@shared/order'
import { Icons } from '../icons'
import { Island, Empty } from '../Island'
import { PanelTabs } from '../PanelTabs'
import { ContextMenu, MenuButton, type MenuItem } from '../Menu'
import { useReorder } from '../useReorder'
import { useWorkbench, useActiveProject, type Project } from '@/stores/workbench'
import { useMemoVersion, pinFile } from '@/stores/memo'
import { t } from '@/i18n'

const mac = window.ct.platform === 'darwin'
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
/** The URL as shown under its name: without the scheme nor a trailing slash. */
const shortUrl = (url: string) => url.replace(/^(https?:\/\/|mailto:)/, '').replace(/\/$/, '')
/** A path under the project as the project names it, anything else from the home folder. */
const where = (path: string, root: string | null) => {
  const sep = path.includes('\\') ? '\\' : '/'
  if (root && path.startsWith(root + sep)) return path.slice(root.length + 1)
  const home = window.ct.home
  return path.startsWith(home) ? '~' + path.slice(home.length) : path
}

/** The project's Mémo (left): its links and its notes, the second tab also listing the files pinned there. */
export function MemoIsland({ project }: { project: Project }) {
  const root = project.root!
  const version = useMemoVersion((s) => s.version)
  const [memo, setMemo] = useState<ProjectMemo | null>(null)
  useEffect(() => { window.ct.memo.load(root).then(setMemo) }, [root, version])
  if (!memo) return <Island title={t('Mémo')} icon={Icons.notebook(14)} grow><Empty>…</Empty></Island>
  return (
    <Island title={t('Mémo')} icon={Icons.notebook(14)} grow>
      <PanelTabs storeKey="memo" tabs={[
        { id: 'links', label: t('Liens'), count: memo.links.length, content: <LinksTab root={root} links={memo.links} /> },
        { id: 'notes', label: t('Notes'), count: memo.notes.length + memo.pins.length, content: <NotesTab project={project} memo={memo} /> },
      ]} />
    </Island>
  )
}

/** Every project's Mémo (right), read only: links and notes grouped by project. */
export function MemoAllIsland() {
  const version = useMemoVersion((s) => s.version)
  const [all, setAll] = useState<ProjectMemo[] | null>(null)
  useEffect(() => { window.ct.memo.list().then((l) => setAll(l.sort((a, b) => base(a.root).localeCompare(base(b.root))))) }, [version])
  const links = (all ?? []).filter((m) => m.links.length)
  const notes = (all ?? []).filter((m) => m.notes.length || m.pins.length)
  return (
    <Island title={t('Mémo')} icon={Icons.notebook(14)} grow>
      <PanelTabs storeKey="memo-all" tabs={[
        { id: 'links', label: t('Liens'), count: links.reduce((n, m) => n + m.links.length, 0), content: <AllLinks memos={links} /> },
        { id: 'notes', label: t('Notes'), count: notes.reduce((n, m) => n + m.notes.length + m.pins.length, 0), content: <AllNotes memos={notes} /> },
      ]} />
    </Island>
  )
}

// MARK: links

const save = async (root: string, links: MemoLink[]) => { await window.ct.memo.saveLinks(root, links); useMemoVersion.getState().bump() }

function LinksTab({ root, links }: { root: string; links: MemoLink[] }) {
  const [q, setQ] = useState('')
  /** the link being edited (its index), or a new one (-1) */
  const [editing, setEditing] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; i: number } | null>(null)
  const drag = useReorder('memo-link', (from, to, place) => save(root, reorder(links, (l) => l.url, from, to, place)), 'y')
  const shown = links.map((l, i) => ({ l, i })).filter(({ l }) => matchesFilter(l.name + ' ' + l.url, q))
  const submit = (i: number, link: MemoLink): string | null => {
    if (links.some((x, j) => j !== i && x.url === link.url)) return t('Ce lien est déjà dans le mémo')
    save(root, i < 0 ? [...links, link] : links.map((x, j) => (j === i ? link : x)))
    setEditing(null)
    return null
  }
  // a link dragged from the browser (or its address bar) is added under its host name
  const onDragOver = (e: DragEvent) => { if (e.dataTransfer.types.includes('text/uri-list')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }
  const onDrop = (e: DragEvent) => {
    const url = normalizeUrl(e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) ?? '')
    if (!url) return
    e.preventDefault()
    if (!links.some((l) => l.url === url)) save(root, [...links, { name: defaultLinkName(url), url }])
  }
  const items = (i: number): (MenuItem | 'sep')[] => [
    { label: t('Ouvrir'), icon: Icons.external(13), onSelect: () => window.ct.app.openUrl(links[i].url) },
    { label: t("Copier l'URL"), onSelect: () => navigator.clipboard.writeText(links[i].url) },
    { label: t('Modifier…'), onSelect: () => setEditing(i) },
    'sep',
    { label: t('Supprimer'), danger: true, onSelect: () => save(root, links.filter((_, j) => j !== i)) },
  ]
  return (
    <div className="memo-tab" onDragOver={onDragOver} onDrop={onDrop}>
      <div className="search memo-bar">
        <input placeholder={t('filtrer…')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button title={t('Ajouter un lien')} onClick={() => setEditing(-1)}>{Icons.plus(14)}</button>
      </div>
      {editing === -1 && <LinkForm onSubmit={(l) => submit(-1, l)} onCancel={() => setEditing(null)} />}
      {links.length === 0 && editing !== -1 ? <Empty>{t('Docs, tickets, maquettes, environnements… Ajoute un lien avec +, ou glisse-le depuis le navigateur.')}</Empty> : (
        <div className="list">
          {shown.map(({ l, i }) => editing === i ? <LinkForm key={l.url} initial={l} onSubmit={(x) => submit(i, x)} onCancel={() => setEditing(null)} /> : (
            <div key={l.url} {...(q ? {} : drag.props(l.url))} className={'lrow memo-row' + drag.dropClass(l.url)} title={l.url}
              onClick={() => window.ct.app.openUrl(l.url)} onContextMenu={(e) => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, i }) }}>
              <span className="ico">{Icons.link(13)}</span>
              <div className="lbody">
                <div className="head"><span className="name">{l.name}</span></div>
                <div className="desc">{shortUrl(l.url)}</div>
              </div>
              <span className="acts">
                <button title={t('Modifier…')} onClick={(e) => { e.stopPropagation(); setEditing(i) }}>{Icons.pencil(12)}</button>
                <button title={t('Supprimer')} onClick={(e) => { e.stopPropagation(); save(root, links.filter((_, j) => j !== i)) }}>{Icons.x(12)}</button>
              </span>
            </div>
          ))}
          {q && shown.length === 0 && <Empty>{t('Aucun lien')}</Empty>}
        </div>
      )}
      <ContextMenu at={menu?.at ?? null} items={menu ? items(menu.i) : []} onClose={() => setMenu(null)} />
    </div>
  )
}

/** Name and URL of a link; Enter saves, Escape cancels. The name defaults to the host. */
function LinkForm({ initial, onSubmit, onCancel }: { initial?: MemoLink; onSubmit: (l: MemoLink) => string | null; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    const u = normalizeUrl(url)
    if (!u) { setError(t('Adresse invalide : un lien web (http, https) ou une adresse mail')); return }
    setError(onSubmit({ name: name.trim() || defaultLinkName(u), url: u }))
  }
  const keys = (e: React.KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel() }
  return (
    <div className="memo-form" onClick={(e) => e.stopPropagation()}>
      <input autoFocus={!initial} placeholder={t('URL (https://…)')} value={url} spellCheck={false} onChange={(e) => { setUrl(e.target.value); setError(null) }} onKeyDown={keys} />
      <input autoFocus={!!initial} placeholder={t('nom (facultatif)')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={keys} />
      {error && <div className="error">{error}</div>}
      <div className="memo-form-btns">
        <button className="btn" onClick={onCancel}>{t('Annuler')}</button>
        <button className="btn primary" onClick={submit}>{initial ? t('Enregistrer') : t('Ajouter')}</button>
      </div>
    </div>
  )
}

// MARK: notes and pinned files

function NotesTab({ project, memo }: { project: Project; memo: ProjectMemo }) {
  const root = project.root!
  const openFile = useWorkbench((s) => s.openFile)
  const [q, setQ] = useState('')
  /** a new note (path ''), or the note being renamed */
  const [naming, setNaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: (MenuItem | 'sep')[] } | null>(null)
  const bump = () => useMemoVersion.getState().bump()
  const pins = memo.pins.map((p) => p.path)
  const savePins = async (next: string[]) => { await window.ct.memo.savePins(root, next); bump() }
  const drag = useReorder('memo-pin', (from, to, place) => savePins(reorder(pins, (p) => p, from, to, place)), 'y')
  const notes = memo.notes.filter((n) => matchesFilter(n.name, q))
  const pinned = memo.pins.filter((p) => matchesFilter(where(p.path, root), q))

  const name = async (value: string) => {
    const r = naming ? await window.ct.memo.renameNote(root, naming, value) : await window.ct.memo.newNote(root, value)
    if (!r.ok) { setError(r.error ?? 'erreur'); return }
    setNaming(null); setError(null); bump()
    if (!naming && r.path) openFile(project.id, r.path)
  }
  const remove = async (n: MemoNote) => {
    if (!confirm(t('Mettre la note « {name} » à la corbeille ?', { name: n.name }))) return
    const r = await window.ct.memo.deleteNote(root, n.path)
    if (!r.ok) setError(r.error ?? 'erreur')
    bump()
  }
  const pick = async () => { const p = await window.ct.app.pickFile(root); if (p) await pinFile(root, p) }
  // files from the explorer (their path as text) or from the system
  const onDragOver = (e: DragEvent) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }
  const onDrop = async (e: DragEvent) => {
    const paths = Array.from(e.dataTransfer.files).map((f) => window.ct.attachments.pathForFile(f)).filter(Boolean)
    if (!paths.length) paths.push(...e.dataTransfer.getData('text/plain').split('\n').filter((p) => p.startsWith('/') || /^[A-Za-z]:\\/.test(p) || p.startsWith('\\\\')))
    if (!paths.length) return
    e.preventDefault()
    for (const p of paths) await pinFile(root, p)
  }
  const noteItems = (n: MemoNote): (MenuItem | 'sep')[] => [
    { label: t('Ouvrir'), onSelect: () => openFile(project.id, n.path) },
    { label: t('Renommer…'), onSelect: () => setNaming(n.path) },
    { label: t(mac ? 'Afficher dans le Finder' : "Afficher dans l'explorateur"), onSelect: () => window.ct.app.revealInFinder(n.path) },
    'sep',
    { label: t('Mettre à la corbeille'), danger: true, onSelect: () => remove(n) },
  ]
  const pinItems = (p: MemoPin): (MenuItem | 'sep')[] => [
    { label: t('Ouvrir'), disabled: !p.exists, onSelect: () => openFile(project.id, p.path) },
    { label: t(mac ? 'Afficher dans le Finder' : "Afficher dans l'explorateur"), disabled: !p.exists, onSelect: () => window.ct.app.revealInFinder(p.path) },
    { label: t('Copier le chemin'), onSelect: () => navigator.clipboard.writeText(p.path) },
    'sep',
    { label: t('Retirer du mémo'), onSelect: () => savePins(pins.filter((x) => x !== p.path)) },
  ]
  const ctx = (items: (MenuItem | 'sep')[]) => (e: React.MouseEvent) => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, items }) }
  const empty = !memo.notes.length && !memo.pins.length && naming === null
  return (
    <div className="memo-tab" onDragOver={onDragOver} onDrop={onDrop}>
      <div className="search memo-bar">
        <input placeholder={t('filtrer…')} value={q} onChange={(e) => setQ(e.target.value)} />
        <MenuButton className="" title={t('Ajouter')} items={[
          { label: t('Nouvelle note'), icon: Icons.file(13), onSelect: () => { setNaming(''); setError(null) } },
          { label: t('Épingler un fichier…'), icon: Icons.pin(13), onSelect: pick },
        ]}>{Icons.plus(14)}</MenuButton>
      </div>
      {error && <div className="error" style={{ padding: '2px 10px 6px' }}>{error}</div>}
      {naming === '' && <NameInput placeholder={t('nom de la note')} onSubmit={name} onCancel={() => { setNaming(null); setError(null) }} />}
      {empty ? <Empty>{t('Des notes à toi sur ce projet (gardées dans les données de l\'app, pas dans le dépôt), et les fichiers du projet que tu ouvres souvent : glisse-les ici depuis l\'explorateur.')}</Empty> : (
        <div className="list">
          {(memo.notes.length > 0 || naming === '') && <div className="memo-group">{t('Notes')}</div>}
          {notes.map((n) => naming === n.path ? <NameInput key={n.path} initial={n.name} onSubmit={name} onCancel={() => { setNaming(null); setError(null) }} /> : (
            <div key={n.path} className="lrow memo-row" title={n.path} onClick={() => openFile(project.id, n.path)} onDoubleClick={() => setNaming(n.path)} onContextMenu={ctx(noteItems(n))}>
              <span className="ico">{Icons.file(13)}</span>
              <div className="lbody"><div className="head"><span className="name">{n.name}</span></div></div>
              <span className="acts">
                <button title={t('Renommer…')} onClick={(e) => { e.stopPropagation(); setNaming(n.path) }}>{Icons.pencil(12)}</button>
                <button title={t('Mettre à la corbeille')} onClick={(e) => { e.stopPropagation(); remove(n) }}>{Icons.x(12)}</button>
              </span>
            </div>
          ))}
          {memo.pins.length > 0 && <div className="memo-group">{t('Fichiers épinglés')}</div>}
          {pinned.map((p) => (
            <div key={p.path} {...(q ? {} : drag.props(p.path))} className={'lrow memo-row' + (p.exists ? '' : ' missing') + drag.dropClass(p.path)} title={p.path}
              onClick={() => p.exists && openFile(project.id, p.path)} onContextMenu={ctx(pinItems(p))}>
              <span className="ico">{Icons.pin(13)}</span>
              <div className="lbody">
                <div className="head"><span className="name">{base(p.path)}</span>{!p.exists && <span className="badge dim">{t('introuvable')}</span>}</div>
                {where(p.path, root) !== base(p.path) && <div className="desc">{where(p.path, root)}</div>}
              </div>
              <span className="acts">
                <button title={t('Retirer du mémo')} onClick={(e) => { e.stopPropagation(); savePins(pins.filter((x) => x !== p.path)) }}>{Icons.x(12)}</button>
              </span>
            </div>
          ))}
        </div>
      )}
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </div>
  )
}

function NameInput({ initial = '', placeholder, onSubmit, onCancel }: { initial?: string; placeholder?: string; onSubmit: (v: string) => void; onCancel: () => void }) {
  return (
    <div className="memo-form">
      <input autoFocus defaultValue={initial} placeholder={placeholder} spellCheck={false} onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && e.currentTarget.value.trim()) onSubmit(e.currentTarget.value); if (e.key === 'Escape') onCancel() }}
        onBlur={onCancel} />
    </div>
  )
}

// MARK: every project (right)

/** A project's group header; the project's name, its path on hover. */
const Group = ({ root }: { root: string }) => <div className="memo-group" title={root}>{base(root)}</div>

function AllLinks({ memos }: { memos: ProjectMemo[] }) {
  const [q, setQ] = useState('')
  const shown = memos.map((m) => ({ m, links: m.links.filter((l) => matchesFilter(l.name + ' ' + l.url + ' ' + base(m.root), q)) })).filter((x) => x.links.length)
  if (!memos.length) return <Empty>{t('Aucun lien dans les mémos des projets')}</Empty>
  return (
    <div className="memo-tab">
      <div className="search"><input placeholder={t('filtrer…')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="list">
        {shown.map(({ m, links }) => (
          <div key={m.root}>
            <Group root={m.root} />
            {links.map((l) => (
              <div key={l.url} className="lrow memo-row" title={l.url} onClick={() => window.ct.app.openUrl(l.url)}>
                <span className="ico">{Icons.link(13)}</span>
                <div className="lbody">
                  <div className="head"><span className="name">{l.name}</span></div>
                  <div className="desc">{shortUrl(l.url)}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
        {shown.length === 0 && <Empty>{t('Aucun lien')}</Empty>}
      </div>
    </div>
  )
}

function AllNotes({ memos }: { memos: ProjectMemo[] }) {
  const project = useActiveProject()
  const openFile = useWorkbench((s) => s.openFile)
  const [q, setQ] = useState('')
  // a note or a file of another project opens in the editor of the project shown
  const open = (path: string) => project && openFile(project.id, path)
  const shown = memos.map((m) => ({
    m,
    notes: m.notes.filter((n) => matchesFilter(n.name + ' ' + base(m.root), q)),
    pins: m.pins.filter((p) => matchesFilter(where(p.path, m.root) + ' ' + base(m.root), q)),
  })).filter((x) => x.notes.length || x.pins.length)
  if (!memos.length) return <Empty>{t('Aucune note dans les mémos des projets')}</Empty>
  return (
    <div className="memo-tab">
      <div className="search"><input placeholder={t('filtrer…')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="list">
        {shown.map(({ m, notes, pins }) => (
          <div key={m.root}>
            <Group root={m.root} />
            {notes.map((n) => (
              <div key={n.path} className="lrow memo-row" title={n.path} onClick={() => open(n.path)}>
                <span className="ico">{Icons.file(13)}</span>
                <div className="lbody"><div className="head"><span className="name">{n.name}</span></div></div>
              </div>
            ))}
            {pins.map((p) => (
              <div key={p.path} className={'lrow memo-row' + (p.exists ? '' : ' missing')} title={p.path} onClick={() => p.exists && open(p.path)}>
                <span className="ico">{Icons.pin(13)}</span>
                <div className="lbody">
                  <div className="head"><span className="name">{base(p.path)}</span>{!p.exists && <span className="badge dim">{t('introuvable')}</span>}</div>
                  {where(p.path, m.root) !== base(p.path) && <div className="desc">{where(p.path, m.root)}</div>}
                </div>
              </div>
            ))}
          </div>
        ))}
        {shown.length === 0 && <Empty>{t('Aucune note')}</Empty>}
      </div>
    </div>
  )
}
