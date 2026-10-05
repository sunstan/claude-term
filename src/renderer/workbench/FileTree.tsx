import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { DirEntry, FileOpResult } from '@shared/ipc'
import { Icons } from './icons'
import { FileIcon } from './FileIcon'
import { useWorkbench, type Project } from '@/stores/workbench'
import { pinFile } from '@/stores/memo'
import { ContextMenu, type MenuItem } from './Menu'
import { t as tr } from '@/i18n'
import { foldersTo, useExplorer } from '@/stores/explorer'
import { isInside as isUnder } from '@shared/claude-format'

const mac = window.ct.platform === 'darwin'
const MOD = mac ? '⌘' : 'Ctrl+'
const parentOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p

/** paths copied / cut in the explorer, shared by every tree (paste into another project works too) */
const useClip = create<{ paths: string[]; cut: boolean }>(() => ({ paths: [], cut: false }))

/** reloads a shown folder now (our own operations; the folder watcher catches the others, debounced) */
const reloaders = new Set<(dir: string) => void>()
const reload = (...dirs: string[]) => { for (const d of new Set(dirs)) reloaders.forEach((r) => r(d)) }

type Edit = { kind: 'file' | 'folder'; dir: string } | { kind: 'rename'; path: string }
interface TreeCtx {
  /** dotfiles and git-ignored entries are listed */
  showHidden: boolean
  isOpen(p: string): boolean
  setOpen(p: string, open: boolean): void
  edit: Edit | null
  error: string | null
  /** false when refused (the field stays, with the error) */
  commit(name: string): Promise<boolean>
  cancel(): void
  menuFor(entry: DirEntry): (MenuItem | 'sep')[]
}
const Tree = createContext<TreeCtx>(null as unknown as TreeCtx)

/**
 * Lazy directory tree bounded to `root`, refreshed on disk changes. Single click selects (sets the cwd for new
 * tabs), double click opens. Keyboard (the tree takes focus on click): ↑ ↓ move, → opens a folder / goes into it,
 * ← closes it / goes to its parent, Enter opens a file or toggles a folder, Space is Quick Look (macOS);
 * ⌘C ⌘X ⌘V copy / cut / paste, ⌘D duplicates, ⌘⌫ (Delete elsewhere) to the Trash, F2 renames. Open folders are kept
 * by root (useExplorer); a reveal request for a path under the root opens its folders and selects it.
 */
export function FileTree({ project, root }: { project: Project; root: string }) {
  const openList = useExplorer((s) => s.open[root])
  const open = useMemo(() => new Set(useExplorer.getState().openOf(root)), [openList, root])
  const showHidden = useWorkbench((s) => s.settings?.explorerShowHidden ?? true)
  const revealReq = useExplorer((s) => s.reveal)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const select = useWorkbench((s) => s.select)
  const openFile = useWorkbench((s) => s.openFile)
  const newTab = useWorkbench((s) => s.newTab)
  const clip = useClip()
  const isOpen = (p: string) => open.has(p)
  const setOpen = (p: string, on: boolean) => useExplorer.getState().setOpen(root, p, on)
  const rows = () => [...(ref.current?.querySelectorAll<HTMLElement>('.row[data-path]') ?? [])]
  const focus = () => ref.current?.focus({ preventScroll: true })
  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(null), 5000); return () => clearTimeout(t) }, [error])
  // opened folders' rows arrive as each folder is read: the row is looked for a few times
  useEffect(() => {
    const path = revealReq?.path
    if (!path || !isUnder(path, root)) return
    for (const d of foldersTo(root, path)) setOpen(d, true)
    select(project.id, path, false)
    let tries = 0
    const timer = setInterval(() => {
      const row = rows().find((r) => r.dataset.path === path)
      if (row || ++tries > 40) { clearInterval(timer); row?.scrollIntoView({ block: 'center' }); focus() }
    }, 50)
    return () => clearInterval(timer)
  }, [revealReq?.n])

  const fail = (r: FileOpResult[]) => { const e = r.find((x) => !x.ok); setError(e && !e.ok ? e.error : null) }
  const reveal = (path: string, isDir: boolean) => { select(project.id, path, isDir); requestAnimationFrame(() => rows().find((r) => r.dataset.path === path)?.scrollIntoView({ block: 'nearest' })) }
  const dirOf = (entry?: DirEntry) => (!entry ? root : entry.isDir ? entry.path : parentOf(entry.path))

  const newItem = (kind: 'file' | 'folder', dir: string) => { if (dir !== root) setOpen(dir, true); setError(null); setEdit({ kind, dir }) }
  const rename = (path: string) => { setError(null); setEdit({ kind: 'rename', path }) }
  const copy = (path: string, cut: boolean) => useClip.setState({ paths: [path], cut })
  const paste = async (dir: string) => {
    const { paths, cut } = useClip.getState()
    if (!paths.length) return
    const r = await window.ct.fs.transfer(paths, dir, cut)
    fail(r)
    if (cut) {
      for (const [i, x] of r.entries()) if (x.ok) await useWorkbench.getState().pathMoved(paths[i], x.path)
      useClip.setState({ paths: [], cut: false })
    }
    if (dir !== root) setOpen(dir, true)
    reload(dir, ...(cut ? paths.map(parentOf) : []))
    const last = r.filter((x) => x.ok).at(-1)
    if (last?.ok) reveal(last.path, false)
  }
  const duplicate = async (path: string) => {
    const r = await window.ct.fs.transfer([path], parentOf(path), false)
    fail(r); reload(parentOf(path))
    if (r[0]?.ok) reveal(r[0].path, false)
  }
  const remove = async (path: string) => {
    if (path === root || !(await window.ct.fs.trash([path]))) return focus()
    await useWorkbench.getState().pathsRemoved([path])
    reload(parentOf(path)); focus()
  }
  const commit = async (name: string): Promise<boolean> => {
    const e = edit
    if (!e) return true
    name = name.trim()
    if (!name || (e.kind === 'rename' && name === nameOf(e.path))) { setEdit(null); focus(); return true }
    const r = e.kind === 'rename' ? await window.ct.fs.rename(e.path, name) : await window.ct.fs.create(e.dir, name, e.kind === 'folder')
    if (!r.ok) { setError(r.error); return false }
    if (e.kind === 'rename') await useWorkbench.getState().pathMoved(e.path, r.path)
    setEdit(null); setError(null); focus()
    reload(e.kind === 'rename' ? parentOf(e.path) : e.dir)
    reveal(r.path, e.kind === 'folder')
    if (e.kind === 'file') openFile(project.id, r.path)
    return true
  }
  const cancel = () => { setEdit(null); setError(null); focus() }

  const menuFor = (entry?: DirEntry): (MenuItem | 'sep')[] => {
    const dir = dirOf(entry)
    const fileOps: (MenuItem | 'sep')[] = entry ? [
      'sep',
      { label: tr('Couper'), shortcut: MOD + 'X', onSelect: () => copy(entry.path, true) },
      { label: tr('Copier'), shortcut: MOD + 'C', onSelect: () => copy(entry.path, false) },
      { label: tr('Coller'), shortcut: MOD + 'V', disabled: !clip.paths.length, onSelect: () => paste(dir) },
      { label: tr('Dupliquer'), shortcut: MOD + 'D', onSelect: () => duplicate(entry.path) },
      { label: tr('Renommer…'), shortcut: 'F2', onSelect: () => rename(entry.path) },
      { label: tr('Mettre à la corbeille'), shortcut: mac ? '⌘⌫' : tr('Suppr'), danger: true, onSelect: () => remove(entry.path) },
    ] : [{ label: tr('Coller'), shortcut: MOD + 'V', disabled: !clip.paths.length, onSelect: () => paste(dir) }]
    const create: (MenuItem | 'sep')[] = [
      { label: tr('Nouveau fichier…'), icon: Icons.file(13), onSelect: () => newItem('file', dir) },
      { label: tr('Nouveau dossier…'), icon: Icons.folder(13), onSelect: () => newItem('folder', dir) },
    ]
    const where = entry?.path ?? root
    const general: (MenuItem | 'sep')[] = [
      ...(entry ? [{ label: tr('Insérer le chemin dans le prompt'), icon: Icons.prompt(13), onSelect: () => useWorkbench.getState().sendPaths(project.id, [entry.path]) }, 'sep' as const] : []),
      ...(mac && entry ? [{ label: tr("Coup d'œil"), shortcut: tr('Espace'), onSelect: () => window.ct.app.quickLook(where) }] : []),
      { label: tr(mac ? 'Afficher dans le Finder' : "Afficher dans l'explorateur"), onSelect: () => window.ct.app.revealInFinder(where) },
      { label: tr('Copier le chemin'), onSelect: () => navigator.clipboard.writeText(where) },
    ]
    if (entry && !entry.isDir) return [
      { label: tr('Ouvrir'), onSelect: () => openFile(project.id, entry.path) },
      ...(project.root ? [{ label: tr('Épingler dans le mémo'), icon: Icons.pin(13), onSelect: () => pinFile(project.root!, entry.path) }] : []),
      ...general, ...fileOps,
    ]
    return [
      { label: tr('Nouvel onglet Claude ici'), icon: Icons.claude(13), onSelect: () => newTab(project.id, 'claude', where) },
      { label: tr('Nouveau shell ici'), icon: Icons.terminal(13), onSelect: () => newTab(project.id, 'shell', where) },
      'sep', ...create, 'sep', ...general, ...fileOps,
    ]
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (edit) return
    const list = rows()
    const cur = project.selectedPath
    const i = list.findIndex((r) => r.dataset.path === cur)
    const at = i >= 0 ? list[i] : null
    const isDir = at?.dataset.dir === '1'
    const mod = mac ? e.metaKey : e.ctrlKey
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase()
      if (k === 'v') { e.preventDefault(); paste(at ? (isDir ? cur! : parentOf(cur!)) : root) }
      else if (at && (k === 'c' || k === 'x')) { e.preventDefault(); copy(cur!, k === 'x') }
      else if (at && k === 'd') { e.preventDefault(); duplicate(cur!) }
      else if (at && mac && e.key === 'Backspace') { e.preventDefault(); remove(cur!) }
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const go = (r: HTMLElement | undefined) => { if (!r) return; select(project.id, r.dataset.path!, r.dataset.dir === '1'); r.scrollIntoView({ block: 'nearest' }) }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(i < 0 ? list[0] : list[i + 1]); break
      case 'ArrowUp': e.preventDefault(); go(i < 0 ? list[0] : list[Math.max(0, i - 1)]); break
      case 'ArrowRight':
        e.preventDefault()
        if (at && isDir) { if (!isOpen(cur!)) setOpen(cur!, true); else go(/^[\\/]/.test(list[i + 1]?.dataset.path?.slice(cur!.length) ?? '') && list[i + 1]?.dataset.path?.startsWith(cur!) ? list[i + 1] : undefined) }
        break
      case 'ArrowLeft': {
        e.preventDefault()
        if (at && isDir && isOpen(cur!)) { setOpen(cur!, false); break }
        go(cur ? list.find((r) => r.dataset.path === parentOf(cur)) : undefined)
        break
      }
      case 'Enter':
        e.preventDefault()
        if (at && isDir) setOpen(cur!, !isOpen(cur!))
        else if (at) openFile(project.id, cur!)
        break
      case ' ':
        if (mac && cur) { e.preventDefault(); window.ct.app.quickLook(cur) }
        break
      case 'F2': if (at) { e.preventDefault(); rename(cur!) } break
      case 'Delete': if (at && !mac) { e.preventDefault(); remove(cur!) } break
    }
  }
  return (
    <Tree.Provider value={{ showHidden, isOpen, setOpen, edit, error, commit, cancel, menuFor }}>
      <div className="tree" tabIndex={0} ref={ref} onKeyDown={onKeyDown}
        onContextMenu={(e) => { if ((e.target as HTMLElement).closest('.row')) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}>
        <ContextMenu at={menu} onClose={() => setMenu(null)} items={menu ? menuFor() : []} />
        {error && <div className="tree-error">{error}</div>}
        <Dir key={root} project={project} path={root} depth={0} />
      </div>
    </Tree.Provider>
  )
}

function Dir({ project, path, depth }: { project: Project; path: string; depth: number }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const { edit, showHidden } = useContext(Tree)
  useEffect(() => {
    let live = true
    const load = () => window.ct.fs.readdir(path, true).then((e) => { if (live) setEntries(e) })
    load()
    const own = (d: string) => { if (d === path) load() }
    reloaders.add(own)
    window.ct.fs.watchDir(path)
    const off = window.ct.fs.onDirChanged(own)
    return () => { live = false; reloaders.delete(own); off(); window.ct.fs.unwatchDir(path) }
  }, [path])
  const adding = edit && edit.kind !== 'rename' && edit.dir === path ? edit.kind : null
  return (
    <>
      {adding && (
        <div className="row editing" style={{ paddingLeft: 6 + depth * 14 + (adding === 'folder' ? 0 : 19) }}>
          {adding === 'folder' && <span className="chev">{Icons.chevron(10)}</span>}
          <FileIcon path={path + '/untitled'} isDir={adding === 'folder'} />
          <NameInput initial="" />
        </div>
      )}
      {entries?.filter((e) => showHidden || !(e.hidden || e.ignored)).map((e) => (e.isDir ? <DirRow key={e.path} project={project} entry={e} depth={depth} /> : <FileRow key={e.path} project={project} entry={e} depth={depth} />))}
    </>
  )
}

/** inline name field (new file / folder, rename): Enter confirms, Escape cancels, leaving it confirms */
function NameInput({ initial }: { initial: string }) {
  const { commit, cancel, error } = useContext(Tree)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const i = ref.current!
    i.focus()
    const dot = initial.lastIndexOf('.')
    i.setSelectionRange(0, dot > 0 ? dot : initial.length)   // the stem, like the Finder
  }, [initial])
  return (
    <input ref={ref} className={'name-input' + (error ? ' bad' : '')} defaultValue={initial} spellCheck={false}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); done.current = true; commit(e.currentTarget.value).then((ok) => { done.current = ok }) }
        else if (e.key === 'Escape') { e.preventDefault(); done.current = true; cancel() }
      }}
      onBlur={(e) => { if (!done.current) { done.current = true; commit(e.currentTarget.value).then((ok) => { done.current = ok }) } }} />
  )
}

function DirRow({ project, entry, depth }: { project: Project; entry: DirEntry; depth: number }) {
  const { isOpen, setOpen, edit, menuFor } = useContext(Tree)
  const open = isOpen(entry.path)
  const select = useWorkbench((s) => s.select)
  const sel = project.selectedPath === entry.path
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const renaming = edit?.kind === 'rename' && edit.path === entry.path
  const cut = useClip((c) => c.cut && c.paths.includes(entry.path))
  return (
    <>
      <ContextMenu at={menu} onClose={() => setMenu(null)} items={menu ? menuFor(entry) : []} />
      <div className={'row dir' + (sel ? ' sel' : '') + (cut ? ' cut' : '')} style={{ paddingLeft: 6 + depth * 14 }} data-path={entry.path} data-dir="1"
        onClick={() => { select(project.id, entry.path, true) }}
        onDoubleClick={() => setOpen(entry.path, !open)}
        onContextMenu={(e) => { e.preventDefault(); select(project.id, entry.path, true); setMenu({ x: e.clientX, y: e.clientY }) }}
        draggable={!renaming} onDragStart={(e) => { e.dataTransfer.setData('text/plain', entry.path); e.dataTransfer.effectAllowed = 'copy' }}
        title={entry.path}>
        <span className={'chev' + (open ? ' open' : '')} onClick={(e) => { e.stopPropagation(); setOpen(entry.path, !open) }}>{Icons.chevron(10)}</span>
        <FileIcon path={entry.path} isDir open={open} />
        {renaming ? <NameInput initial={entry.name} /> : <span className={entry.hidden || entry.ignored ? 'dim' : undefined}>{entry.name}</span>}
        {entry.sessions && !renaming && <span className="sessions-mark" title={tr('Des sessions Claude ont été lancées dans ce dossier')}>✳</span>}
      </div>
      {open && <Dir project={project} path={entry.path} depth={depth + 1} />}
    </>
  )
}

function FileRow({ project, entry, depth }: { project: Project; entry: DirEntry; depth: number }) {
  const { edit, menuFor } = useContext(Tree)
  const select = useWorkbench((s) => s.select)
  const openFile = useWorkbench((s) => s.openFile)
  const sel = project.selectedPath === entry.path
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const renaming = edit?.kind === 'rename' && edit.path === entry.path
  const cut = useClip((c) => c.cut && c.paths.includes(entry.path))
  return (
    <>
    <ContextMenu at={menu} onClose={() => setMenu(null)} items={menu ? menuFor(entry) : []} />
    <div className={'row file' + (sel ? ' sel' : '') + (cut ? ' cut' : '')} style={{ paddingLeft: 6 + depth * 14 + 19 }} data-path={entry.path}
      onClick={() => select(project.id, entry.path, false)}
      onDoubleClick={() => openFile(project.id, entry.path)}
      onContextMenu={(e) => { e.preventDefault(); select(project.id, entry.path, false); setMenu({ x: e.clientX, y: e.clientY }) }}
      draggable={!renaming} onDragStart={(e) => { e.dataTransfer.setData('text/plain', entry.path); e.dataTransfer.effectAllowed = 'copy' }}
      title={entry.path}>
      <FileIcon path={entry.path} />
      {renaming ? <NameInput initial={entry.name} /> : <span className={entry.hidden || entry.ignored ? 'dim' : undefined}>{entry.name}</span>}
    </div>
    </>
  )
}
