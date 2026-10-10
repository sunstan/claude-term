import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { DirEntry, FileOpResult, UndoInfo } from '@shared/ipc'
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
/** our drags carry the paths under this type (text/plain keeps them for the terminal, one per line) */
const DRAG_TYPE = 'application/x-claudeterm-paths'
/** Option copies on macOS (the Finder's key), Ctrl elsewhere */
const copyKey = (e: React.DragEvent) => (mac ? e.altKey : e.ctrlKey)

/** paths copied / cut in the explorer, shared by every tree (paste into another project works too) */
const useClip = create<{ paths: string[]; cut: boolean }>(() => ({ paths: [], cut: false }))
/** the paths being dragged from a tree: dragover cannot read the data, only its types */
let dragging: string[] | null = null

/** reloads a shown folder now (our own operations; the folder watcher catches the others, debounced) */
const reloaders = new Set<(dir: string) => void>()
const reload = (...dirs: string[]) => { for (const d of new Set(dirs)) reloaders.forEach((r) => r(d)) }

type Edit = { kind: 'file' | 'folder'; dir: string } | { kind: 'rename'; path: string }
interface TreeCtx {
  /** dotfiles and git-ignored entries are listed */
  showHidden: boolean
  isOpen(p: string): boolean
  setOpen(p: string, open: boolean): void
  /** selected: the project's selection, or one of several marked rows */
  isSelected(p: string): boolean
  /** a click on a row: plain selects it, ⌘/Ctrl adds or removes it, Shift extends from the last one clicked */
  pick(e: React.MouseEvent, entry: DirEntry): void
  /** selects that row alone */
  selectOne(entry: DirEntry): void
  /** the rows an operation started on `path` applies to: every marked row when it is one of them */
  targets(path: string): string[]
  dropDir: string | null
  /** drag-and-drop handlers for a row that drops into `dir` */
  dropOn(dir: string): Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDrop'>
  startDrag(e: React.DragEvent, entry: DirEntry): void
  edit: Edit | null
  error: string | null
  /** false when refused (the field stays, with the error) */
  commit(name: string): Promise<boolean>
  cancel(): void
  menuFor(entry: DirEntry): (MenuItem | 'sep')[]
  /** reads the operation an undo would revert, for the menus */
  refreshUndo(): void
}
const Tree = createContext<TreeCtx>(null as unknown as TreeCtx)

function undoLabel(u: UndoInfo | null): string {
  if (!u) return tr('Annuler la dernière opération')
  const one = u.count === 1
  switch (u.kind) {
    case 'create': return tr('Annuler la création de « {n} »', { n: u.name })
    case 'rename': return tr('Annuler le renommage de « {n} »', { n: u.name })
    case 'move': return one ? tr('Annuler le déplacement de « {n} »', { n: u.name }) : tr('Annuler le déplacement de {c} éléments', { c: u.count })
    case 'copy': return one ? tr('Annuler la copie de « {n} »', { n: u.name }) : tr('Annuler la copie de {c} éléments', { c: u.count })
  }
}

/**
 * Lazy directory tree bounded to `root`, refreshed on disk changes. Single click selects (sets the cwd for new
 * tabs), ⌘/Ctrl-click and Shift-click mark several rows, double click opens. Keyboard (the tree takes focus on
 * click): ↑ ↓ move (with Shift: extend), → opens a folder / goes into it, ← closes it / goes to its parent, Enter
 * opens a file or toggles a folder, Space is Quick Look (macOS); ⌘C ⌘X ⌘V copy / cut / paste, ⌘D duplicates,
 * ⌘⌫ (Delete elsewhere) to the Trash, F2 renames, ⌘Z undoes the last create, rename, move or copy, ⌘A marks every
 * row shown, Escape unmarks. Rows drag into folders (move; with Option on macOS, Ctrl elsewhere: copy), into a
 * terminal (their paths), and files dragged from the OS are copied in. Open folders are kept by root (useExplorer);
 * a reveal request for a path under the root opens its folders and selects it.
 */
export function FileTree({ project, root }: { project: Project; root: string }) {
  const openList = useExplorer((s) => s.open[root])
  const open = useMemo(() => new Set(useExplorer.getState().openOf(root)), [openList, root])
  const showHidden = useWorkbench((s) => s.settings?.explorerShowHidden ?? true)
  const revealReq = useExplorer((s) => s.reveal)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [marked, setMarked] = useState<string[]>([])
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [undoInfo, setUndoInfo] = useState<UndoInfo | null>(null)
  const anchor = useRef<string | null>(null)
  const hover = useRef<{ dir: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const select = useWorkbench((s) => s.select)
  const openFile = useWorkbench((s) => s.openFile)
  const newTab = useWorkbench((s) => s.newTab)
  const clip = useClip()
  const isOpen = (p: string) => open.has(p)
  const setOpen = (p: string, on: boolean) => useExplorer.getState().setOpen(root, p, on)
  const rows = () => [...(ref.current?.querySelectorAll<HTMLElement>('.row[data-path]') ?? [])]
  const focus = () => ref.current?.focus({ preventScroll: true })
  const refreshUndo = () => { window.ct.fs.undoInfo(root).then(setUndoInfo) }
  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(null), 5000); return () => clearTimeout(t) }, [error])
  // opened folders' rows arrive as each folder is read: the row is looked for a few times
  useEffect(() => {
    const path = revealReq?.path
    if (!path || !isUnder(path, root)) return
    for (const d of foldersTo(root, path)) setOpen(d, true)
    select(project.id, path, false); setMarked([])
    let tries = 0
    const timer = setInterval(() => {
      const row = rows().find((r) => r.dataset.path === path)
      if (row || ++tries > 40) { clearInterval(timer); row?.scrollIntoView({ block: 'center' }); focus() }
    }, 50)
    return () => clearInterval(timer)
  }, [revealReq?.n])

  const isSelected = (p: string) => (marked.length ? marked.includes(p) : project.selectedPath === p)
  const targets = (path: string) => (marked.length > 1 && marked.includes(path) ? marked : [path])
  const shownPaths = () => rows().map((r) => r.dataset.path!)
  const range = (from: string, to: string) => {
    const list = shownPaths(), i = list.indexOf(from), j = list.indexOf(to)
    return i < 0 || j < 0 ? [to] : list.slice(Math.min(i, j), Math.max(i, j) + 1)
  }
  // read from the store, not the props: two clicks can come before a render
  const selectedNow = () => useWorkbench.getState().projects.find((p) => p.id === project.id)?.selectedPath ?? null
  const pick = (e: React.MouseEvent, entry: DirEntry) => {
    const mod = mac ? e.metaKey : e.ctrlKey
    if (e.shiftKey) setMarked(range(anchor.current ?? selectedNow() ?? entry.path, entry.path))
    else if (mod) {
      const sel = selectedNow()
      setMarked((m) => { const base = m.length ? m : sel ? [sel] : []; return base.includes(entry.path) ? base.filter((p) => p !== entry.path) : [...base, entry.path] })
      anchor.current = entry.path
    } else { setMarked([]); anchor.current = entry.path }
    select(project.id, entry.path, entry.isDir)
  }
  const selectOne = (entry: DirEntry) => { setMarked([]); anchor.current = entry.path; select(project.id, entry.path, entry.isDir) }

  const fail = (r: FileOpResult[]) => { const e = r.find((x) => !x.ok); setError(e && !e.ok ? e.error : null) }
  const reveal = (path: string, isDir: boolean) => { select(project.id, path, isDir); requestAnimationFrame(() => rows().find((r) => r.dataset.path === path)?.scrollIntoView({ block: 'nearest' })) }
  const dirOf = (entry?: DirEntry) => (!entry ? root : entry.isDir ? entry.path : parentOf(entry.path))

  const newItem = (kind: 'file' | 'folder', dir: string) => { if (dir !== root) setOpen(dir, true); setError(null); setEdit({ kind, dir }) }
  const rename = (path: string) => { setError(null); setEdit({ kind: 'rename', path }) }
  const copy = (paths: string[], cut: boolean) => useClip.setState({ paths, cut })
  /** copy or move into `dir`; main asks about names already taken there (no result: cancelled) */
  const transferTo = async (paths: string[], dir: string, move: boolean) => {
    paths = paths.filter((p) => p !== root)
    if (!paths.length) return
    const r = await window.ct.fs.transfer(paths, dir, move)
    focus()
    if (!r.length) return false
    fail(r)
    if (move) for (const [i, x] of r.entries()) if (x.ok && x.path !== paths[i]) await useWorkbench.getState().pathMoved(paths[i], x.path)
    if (dir !== root) setOpen(dir, true)
    reload(dir, ...(move ? paths.map(parentOf) : []))
    const done = r.flatMap((x) => (x.ok ? [x.path] : []))
    setMarked(done.length > 1 ? done : [])
    if (done.length) reveal(done.at(-1)!, false)
    return true
  }
  const paste = async (dir: string) => {
    const { paths, cut } = useClip.getState()
    if (!paths.length) return
    if (await transferTo(paths, dir, cut) && cut) useClip.setState({ paths: [], cut: false })
  }
  const duplicate = async (path: string) => {
    const r = await window.ct.fs.transfer([path], parentOf(path), false)
    fail(r); reload(parentOf(path))
    if (r[0]?.ok) reveal(r[0].path, false)
  }
  const remove = async (paths: string[]) => {
    paths = paths.filter((p) => p !== root)
    if (!paths.length || !(await window.ct.fs.trash(paths))) return focus()
    await useWorkbench.getState().pathsRemoved(paths)
    setMarked([]); reload(...paths.map(parentOf)); focus()
  }
  const undo = async () => {
    const r = await window.ct.fs.undo(root)
    for (const [from, to] of r.moved) await useWorkbench.getState().pathMoved(from, to)
    if (r.removed.length) await useWorkbench.getState().pathsRemoved(r.removed)
    setMarked([]); setError(r.error ?? null); reload(...r.dirs); focus()
    const back = r.moved.at(-1)?.[1]
    if (back) reveal(back, false)
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

  const startDrag = (e: React.DragEvent, entry: DirEntry) => {
    const paths = targets(entry.path)
    setMarked((m) => (m.includes(entry.path) ? m : []))
    dragging = paths
    e.dataTransfer.setData('text/plain', paths.join('\n'))
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths))
    e.dataTransfer.effectAllowed = 'copyMove'
  }
  const stopHover = () => { if (hover.current) clearTimeout(hover.current.timer); hover.current = null }
  const dropOn = (dir: string): Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDrop'> => ({
    onDragOver: (e) => {
      const types = e.dataTransfer.types, ours = types.includes(DRAG_TYPE)
      if (!ours && !types.includes('Files')) return
      e.stopPropagation()
      // a folder never goes into itself or below
      if (ours && dragging?.some((p) => p === dir || isUnder(dir, p))) { e.dataTransfer.dropEffect = 'none'; setDropDir(null); return }
      e.preventDefault()
      e.dataTransfer.dropEffect = ours && !copyKey(e) ? 'move' : 'copy'
      if (dropDir !== dir) setDropDir(dir)
      // a closed folder held under the pointer opens
      if (dir !== root && !isOpen(dir) && hover.current?.dir !== dir) {
        stopHover()
        hover.current = { dir, timer: setTimeout(() => setOpen(dir, true), 700) }
      }
    },
    onDrop: (e) => {
      e.preventDefault(); e.stopPropagation()
      setDropDir(null); stopHover()
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      if (raw) { try { transferTo(JSON.parse(raw), dir, !copyKey(e)) } catch { /* not ours after all */ } return }
      const files = Array.from(e.dataTransfer.files).map((f) => window.ct.attachments.pathForFile(f)).filter((p): p is string => !!p)
      if (files.length) transferTo(files, dir, false)
    },
  })
  useEffect(() => {
    const end = () => { dragging = null; setDropDir(null); stopHover() }
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end) }
  }, [])

  const menuFor = (entry?: DirEntry): (MenuItem | 'sep')[] => {
    const dir = dirOf(entry)
    const many = entry ? targets(entry.path) : []
    const count = many.length > 1 ? ` (${many.length})` : ''
    const undoItem: MenuItem = { label: undoLabel(undoInfo), shortcut: MOD + 'Z', disabled: !undoInfo, onSelect: undo }
    const fileOps: (MenuItem | 'sep')[] = entry ? [
      'sep',
      { label: tr('Couper') + count, shortcut: MOD + 'X', onSelect: () => copy(many, true) },
      { label: tr('Copier') + count, shortcut: MOD + 'C', onSelect: () => copy(many, false) },
      { label: tr('Coller'), shortcut: MOD + 'V', disabled: !clip.paths.length, onSelect: () => paste(dir) },
      { label: tr('Dupliquer'), shortcut: MOD + 'D', disabled: many.length > 1, onSelect: () => duplicate(entry.path) },
      { label: tr('Renommer…'), shortcut: 'F2', disabled: many.length > 1, onSelect: () => rename(entry.path) },
      { label: tr('Mettre à la corbeille') + count, shortcut: mac ? '⌘⌫' : tr('Suppr'), danger: true, onSelect: () => remove(many) },
      'sep', undoItem,
    ] : [{ label: tr('Coller'), shortcut: MOD + 'V', disabled: !clip.paths.length, onSelect: () => paste(dir) }, undoItem]
    const create: (MenuItem | 'sep')[] = [
      { label: tr('Nouveau fichier…'), icon: Icons.file(13), onSelect: () => newItem('file', dir) },
      { label: tr('Nouveau dossier…'), icon: Icons.folder(13), onSelect: () => newItem('folder', dir) },
    ]
    const where = entry?.path ?? root
    const general: (MenuItem | 'sep')[] = [
      ...(entry ? [{ label: tr('Insérer le chemin dans le prompt') + count, icon: Icons.prompt(13), onSelect: () => useWorkbench.getState().sendPaths(project.id, many) }, 'sep' as const] : []),
      ...(mac && entry ? [{ label: tr("Coup d'œil"), shortcut: tr('Espace'), onSelect: () => window.ct.app.quickLook(where) }] : []),
      { label: tr(mac ? 'Afficher dans le Finder' : "Afficher dans l'explorateur"), onSelect: () => window.ct.app.revealInFinder(where) },
      { label: tr('Copier le chemin'), onSelect: () => navigator.clipboard.writeText(entry ? many.join('\n') : where) },
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
    const current = () => (cur ? targets(cur) : [])
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase()
      if (k === 'v') { e.preventDefault(); paste(at ? (isDir ? cur! : parentOf(cur!)) : root) }
      else if (at && (k === 'c' || k === 'x')) { e.preventDefault(); copy(current(), k === 'x') }
      else if (at && k === 'd') { e.preventDefault(); duplicate(cur!) }
      else if (k === 'z') { e.preventDefault(); undo() }
      else if (k === 'a') { e.preventDefault(); setMarked(shownPaths()) }
      else if (at && mac && e.key === 'Backspace') { e.preventDefault(); remove(current()) }
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const go = (r: HTMLElement | undefined) => {
      if (!r) return
      const p = r.dataset.path!
      if (e.shiftKey) setMarked(range(anchor.current ?? cur ?? p, p))
      else { setMarked([]); anchor.current = p }
      select(project.id, p, r.dataset.dir === '1'); r.scrollIntoView({ block: 'nearest' })
    }
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
      case 'Escape': if (marked.length) { e.preventDefault(); setMarked([]) } break
      case ' ':
        if (mac && cur) { e.preventDefault(); window.ct.app.quickLook(cur) }
        break
      case 'F2': if (at) { e.preventDefault(); rename(cur!) } break
      case 'Delete': if (at && !mac) { e.preventDefault(); remove(current()) } break
    }
  }
  return (
    <Tree.Provider value={{ showHidden, isOpen, setOpen, isSelected, pick, selectOne, targets, dropDir, dropOn, startDrag, edit, error, commit, cancel, menuFor, refreshUndo }}>
      <div className={'tree' + (dropDir === root ? ' drop' : '')} tabIndex={0} ref={ref} onKeyDown={onKeyDown} {...dropOn(root)}
        onDragLeave={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) { setDropDir(null); stopHover() } }}
        onContextMenu={(e) => { if ((e.target as HTMLElement).closest('.row')) return; e.preventDefault(); refreshUndo(); setMenu({ x: e.clientX, y: e.clientY }) }}>
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

/** A right click on a row outside the marked ones acts on that row alone. */
function useRowMenu(entry: DirEntry) {
  const { selectOne, targets, refreshUndo } = useContext(Tree)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (targets(entry.path).length === 1) selectOne(entry)
    refreshUndo()
    setMenu({ x: e.clientX, y: e.clientY })
  }
  return { menu, close: () => setMenu(null), onContextMenu }
}

function DirRow({ project, entry, depth }: { project: Project; entry: DirEntry; depth: number }) {
  const { isOpen, setOpen, isSelected, pick, edit, menuFor, dropDir, dropOn, startDrag } = useContext(Tree)
  const open = isOpen(entry.path)
  const { menu, close, onContextMenu } = useRowMenu(entry)
  const renaming = edit?.kind === 'rename' && edit.path === entry.path
  const cut = useClip((c) => c.cut && c.paths.includes(entry.path))
  return (
    <>
      <ContextMenu at={menu} onClose={close} items={menu ? menuFor(entry) : []} />
      <div className={'row dir' + (isSelected(entry.path) ? ' sel' : '') + (cut ? ' cut' : '') + (dropDir === entry.path ? ' drop' : '')} style={{ paddingLeft: 6 + depth * 14 }} data-path={entry.path} data-dir="1"
        onClick={(e) => pick(e, entry)}
        onDoubleClick={() => setOpen(entry.path, !open)}
        onContextMenu={onContextMenu}
        draggable={!renaming} onDragStart={(e) => startDrag(e, entry)} {...dropOn(entry.path)}
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
  const { isSelected, pick, edit, menuFor, dropOn, startDrag } = useContext(Tree)
  const openFile = useWorkbench((s) => s.openFile)
  const { menu, close, onContextMenu } = useRowMenu(entry)
  const renaming = edit?.kind === 'rename' && edit.path === entry.path
  const cut = useClip((c) => c.cut && c.paths.includes(entry.path))
  return (
    <>
    <ContextMenu at={menu} onClose={close} items={menu ? menuFor(entry) : []} />
    {/* dropped on a file: into its folder */}
    <div className={'row file' + (isSelected(entry.path) ? ' sel' : '') + (cut ? ' cut' : '')} style={{ paddingLeft: 6 + depth * 14 + 19 }} data-path={entry.path}
      onClick={(e) => pick(e, entry)}
      onDoubleClick={() => openFile(project.id, entry.path)}
      onContextMenu={onContextMenu}
      draggable={!renaming} onDragStart={(e) => startDrag(e, entry)} {...dropOn(parentOf(entry.path))}
      title={entry.path}>
      <FileIcon path={entry.path} />
      {renaming ? <NameInput initial={entry.name} /> : <span className={entry.hidden || entry.ignored ? 'dim' : undefined}>{entry.name}</span>}
    </div>
    </>
  )
}
