/**
 * What a project can run (the "Exécuter" panel, Scripts tab): npm scripts (workspaces included), make targets,
 * cargo, go, python, shell scripts. Pure: takes an fs-like object; tested. Ids are stable (`<kind>:<dir>[:<name>]`),
 * the panel keeps its open / closed state and its running commands by them.
 */
import type { ViewAction, ViewItem } from './plugins'
import { normId } from './run-lines'

export interface RunFs { exists(p: string): boolean; read(p: string): string; list(p: string): { name: string; dir: boolean }[] }
export interface RunItem extends ViewItem { cwd: string; command: string }
/** `install`: the command that installs the group's dependencies (npm groups: their package manager's) */
export interface RunGroup extends ViewItem { children: RunItem[]; install?: string }
/** scripts the user groups under a name, to start or stop together (ids of RunItem) */
export interface UserRunGroup { name: string; items: string[] }

const FAVORITES = ['dev', 'start', 'build', 'test', 'lint', 'preview', 'typecheck', 'check']
const RUN: ViewAction = { id: 'run', title: 'Lancer', icon: 'play', primary: true }
const INSTALL: ViewAction = { id: 'install', title: 'Installer les dépendances', icon: 'download' }
const GROUP_ADD: ViewAction = { id: 'group-add', title: 'Ajouter à un groupe…', icon: 'plus' }

/** keeps the separator of `a` (backslashes on Windows) */
function join(a: string, b: string) { const sep = a.includes('\\') && !a.includes('/') ? '\\' : '/'; return a.replace(/[\\/]+$/, '') + sep + b.split('/').join(sep) }
const item = (id: string, label: string, cwd: string, command: string, o: Partial<RunItem> = {}): RunItem => ({ id, label, icon: 'terminal', cwd, command, actions: [RUN], contextMenu: [GROUP_ADD], ...o })

function npm(fs: RunFs, dir: string, label: string | null): (RunGroup & { workspaces: string[] }) | null {
  if (!fs.exists(join(dir, 'package.json'))) return null
  let pkg: any
  try { pkg = JSON.parse(fs.read(join(dir, 'package.json'))) } catch { return null }
  const manager = fs.exists(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : fs.exists(join(dir, 'yarn.lock')) ? 'yarn' : fs.exists(join(dir, 'bun.lockb')) || fs.exists(join(dir, 'bun.lock')) ? 'bun' : 'npm'
  const scripts = Object.entries<string>(pkg.scripts || {}).sort(([a], [b]) => {
    const ia = FAVORITES.indexOf(a), ib = FAVORITES.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
  const children = scripts.map(([name, cmd]) => item('npm:' + dir + ':' + name, name, dir, `${manager} run ${name}`, { detail: String(cmd), icon: 'box' }))
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : []
  return { id: 'npm:' + dir, label: `${label || pkg.name || 'package.json'} · ${manager}`, icon: 'box', children, workspaces: ws, install: `${manager} install`, actions: [INSTALL] }
}

function make(fs: RunFs, dir: string): RunGroup | null {
  const f = ['Makefile', 'makefile', 'GNUmakefile'].map((n) => join(dir, n)).find((p) => fs.exists(p))
  if (!f) return null
  const targets: string[] = []
  for (const line of fs.read(f).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/)
    if (m && !m[1].startsWith('.') && !targets.includes(m[1])) targets.push(m[1])
  }
  if (!targets.length) return null
  return { id: 'make:' + dir, label: 'Makefile', icon: 'box', children: targets.map((t) => item('make:' + dir + ':' + t, t, dir, `make ${t}`)) }
}

const fixed = (kind: string, label: string, marker: string, cmds: string[], strip: number) => (fs: RunFs, dir: string): RunGroup | null =>
  fs.exists(join(dir, marker)) ? { id: kind + ':' + dir, label, icon: 'box', children: cmds.map((c) => item(kind + ':' + dir + ':' + c, c.slice(strip), dir, c, { detail: c })) } : null
const cargo = fixed('cargo', 'Cargo', 'Cargo.toml', ['cargo run', 'cargo build', 'cargo test', 'cargo check', 'cargo clippy'], 6)
const go = fixed('go', 'Go', 'go.mod', ['go run .', 'go build ./...', 'go test ./...', 'go vet ./...'], 3)

function python(fs: RunFs, dir: string): RunGroup | null {
  const items: { name: string; cmd: string }[] = []
  if (fs.exists(join(dir, 'pyproject.toml'))) {
    const text = fs.read(join(dir, 'pyproject.toml'))
    const m = text.match(/\[project\.scripts\]([\s\S]*?)(\n\[|$)/)
    if (m) for (const line of m[1].split('\n')) { const s = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/); if (s) items.push({ name: s[1], cmd: s[1] }) }
    if (/\[tool\.pytest/.test(text) || fs.exists(join(dir, 'tests'))) items.push({ name: 'pytest', cmd: 'pytest' })
  }
  if (fs.exists(join(dir, 'manage.py'))) items.push({ name: 'runserver', cmd: 'python manage.py runserver' }, { name: 'migrate', cmd: 'python manage.py migrate' })
  if (fs.exists(join(dir, 'main.py'))) items.push({ name: 'main.py', cmd: 'python main.py' })
  if (fs.exists(join(dir, 'app.py'))) items.push({ name: 'app.py', cmd: 'python app.py' })
  if (!items.length) return null
  return { id: 'py:' + dir, label: 'Python', icon: 'box', children: items.map((i) => item('py:' + dir + ':' + i.name, i.name, dir, i.cmd, { detail: i.cmd })) }
}

function shell(fs: RunFs, dir: string): RunGroup | null {
  const scripts = fs.list(dir).filter((e) => !e.dir && /\.sh$/.test(e.name)).map((e) => e.name).sort()
  if (!scripts.length) return null
  return { id: 'sh:' + dir, label: 'Scripts shell', icon: 'terminal', children: scripts.map((s) => item('sh:' + dir + ':' + s, s, dir, `./${s}`)) }
}

/** Groups of runnable items for a project root (workspaces of the root package included). */
export function detectRunnables(fs: RunFs, root: string): RunGroup[] {
  const groups: RunGroup[] = []
  const rootNpm = npm(fs, root, null)
  if (rootNpm) {
    groups.push(rootNpm)
    // "./packages/*" and "packages/*" name the same folders
    for (const ws of rootNpm.workspaces.map((w) => String(w).replace(/^\.\//, '').replace(/\/+$/, ''))) {
      const dirs = ws.endsWith('/*') ? fs.list(join(root, ws.slice(0, -2))).filter((e) => e.dir).map((e) => join(join(root, ws.slice(0, -2)), e.name)) : [join(root, ws)]
      for (const d of dirs) { const g = npm(fs, d, d.split(/[\\/]/).pop() ?? d); if (g) groups.push(g) }
    }
  }
  for (const f of [make, cargo, go, python, shell]) { const g = f(fs, root); if (g) groups.push(g) }
  return groups.map((g) => { const { workspaces: _w, ...rest } = g as RunGroup & { workspaces?: string[] }; return rest })
}

// MARK: running commands in the tree

/** `url`: the dev server address its output printed */
export interface Running { runId: string; itemId?: string; label?: string; command: string; started: boolean; url?: string }
const STOP: ViewAction = { id: 'stop', title: 'Arrêter (Ctrl+C)', icon: 'stop', primary: true }
const SHOW: ViewAction = { id: 'show', title: 'Afficher le terminal', icon: 'terminal' }
const OPEN_URL: ViewAction = { id: 'open-url', title: 'Ouvrir dans le navigateur', icon: 'external' }
const RUN_ALL: ViewAction = { id: 'group-run', title: 'Tout lancer', icon: 'play', primary: true }
const STOP_ALL: ViewAction = { id: 'group-stop', title: 'Tout arrêter', icon: 'stop' }
const OPEN_SERVER: ViewAction = { id: 'open-server', title: 'Ouvrir dans le navigateur', icon: 'external', primary: true }
const SHOW_TAB: ViewAction = { id: 'show-tab', title: 'Afficher son terminal', icon: 'terminal' }

/** A server listening under one of the project's terminals (shared/listening), with the tab it descends from. */
export interface ServerRow { port: number; url: string; command: string; tab: string }
const portOf = (url: string) => { try { return Number(new URL(url).port) || null } catch { return null } }

/** The id a script has under a user group in the tree, and back. */
export const inUserGroup = (name: string, itemId: string) => `ug:${name}|${itemId}`
export const fromUserGroup = (id: string): { group: string; itemId: string } | null => {
  const m = id.match(/^ug:([^|]*)\|(.+)$/)
  return m ? { group: m[1], itemId: m[2] } : null
}

/**
 * The tree shown: an "En cours" group first (stop, open its address, show), then the user's groups (start or stop
 * together), then the servers listening under the project's terminals that no script showed (Claude starts some in the
 * background), then what was detected, running scripts badged; detected groups closed by default except a lone one.
 */
export function runnablesTree(groups: RunGroup[], running: Running[], userGroups: UserRunGroup[] = [], servers: ServerRow[] = []): ViewItem[] {
  const runOf = new Map(running.filter((r) => r.itemId).map((r) => [normId(r.itemId!), r]))
  const find = (id?: string) => { if (!id) return null; const want = normId(id); for (const g of groups) for (const c of g.children) if (normId(c.id) === want) return { g, c }; return null }
  const runs: ViewItem[] = running.map((r) => {
    const f = find(r.itemId)
    return {
      id: 'run:' + r.runId, label: f ? f.c.label : r.label || r.command, detail: r.url ?? (f ? f.g.label.split(' ·')[0] : r.command), icon: 'play', color: 'badge.ok',
      badges: r.started ? [] : ['démarrage'], actions: r.url ? [STOP, OPEN_URL, SHOW] : [STOP, SHOW],
    }
  })
  const withState = (c: RunItem): ViewItem => {
    const r = runOf.get(normId(c.id))
    return r ? { ...c, badges: [...(c.badges ?? []), 'en cours'], actions: r.url ? [STOP, OPEN_URL, SHOW] : [STOP, SHOW] } : c
  }
  const mine: ViewItem[] = userGroups.map((u) => {
    const found = u.items.map((id) => find(id)?.c).filter((c): c is RunItem => !!c)
    const live = found.some((c) => runOf.has(normId(c.id)))
    return {
      id: 'ug:' + u.name, label: u.name, icon: 'list', expanded: true, detail: found.length ? undefined : 'vide',
      actions: live ? [RUN_ALL, STOP_ALL] : [RUN_ALL], contextMenu: [{ id: 'group-delete', title: 'Supprimer le groupe', icon: 'trash' }],
      children: found.map((c) => ({ ...withState(c), id: inUserGroup(u.name, c.id), detail: find(c.id)!.g.label.split(' ·')[0], contextMenu: [{ id: 'group-remove', title: 'Retirer du groupe', icon: 'minus' }] })),
    }
  })
  const tree: ViewItem[] = groups.map((g) => ({ ...g, expanded: groups.length === 1, children: g.children.map(withState) }))
  const shown = new Set(running.map((r) => (r.url ? portOf(r.url) : null)))
  const srv: ViewItem[] = servers.filter((s) => !shown.has(s.port)).map((s) => ({
    id: 'srv:' + s.port, label: `localhost:${s.port}`, detail: s.command, icon: 'link', color: 'badge.ok', badges: [s.tab], actions: [OPEN_SERVER, SHOW_TAB],
  }))
  return [
    ...(runs.length ? [{ id: 'g:running', label: `En cours · ${runs.length}`, icon: 'play', expanded: true, children: runs }] : []),
    ...(srv.length ? [{ id: 'g:servers', label: `Serveurs · ${srv.length}`, icon: 'link', expanded: true, children: srv }] : []),
    ...mine, ...tree,
  ]
}
