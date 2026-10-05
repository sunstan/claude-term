/** Plugin system contract: manifest, declarative view models, host ↔ renderer messages. */
import { parse as parseKey } from './keymap'

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  main: string
  /** "startup" (default) or lazy: "onView:<viewId>" */
  activation?: string[]
  permissions?: ('process' | 'fs:home' | 'network' | 'secrets' | 'prompt')[]
  contributes?: {
    activity?: { id: string; side: 'left' | 'right'; title: string; icon: string }[]
    /** placement: sidebar (default, under the activity) or bottom (a tab of the center session block) */
    views?: { id: string; activity?: string; title: string; placement?: 'sidebar' | 'bottom' }[]
    /** in the palette (> mode), with an optional shortcut; ctx.commands.onRun hears them (ctx.commands.set adds more) */
    commands?: { id: string; title: string; shortcut?: string }[]
    settings?: Record<string, { type: 'string' | 'boolean' | 'number'; default?: unknown; description?: string; enum?: string[] }>
  }
}

export type PluginPermission = NonNullable<PluginManifest['permissions']>[number]
export const PLUGIN_PERMISSIONS: Record<PluginPermission, string> = {
  process: 'lancer des programmes et des commandes dans le terminal',
  'fs:home': 'lire les fichiers du dossier personnel (sinon : le projet ouvert seulement)',
  network: 'accès réseau (pas encore disponible : bloqué)',
  secrets: 'secrets du trousseau (pas encore disponible)',
  prompt: 'écrire des prompts dans l’onglet Claude du projet, et les envoyer',
}

/** A command a plugin offers: in the palette, and on its shortcut ("Mod+Alt+P") unless the app's keymap has it. */
export interface PluginCommand { pluginId: string; id: string; title: string; shortcut?: string }

/** The commands a plugin declares (manifest, then ctx.commands.set), checked: at most 100, ids unique, shortcuts parsable. */
export function cleanCommands(pluginId: string, list: unknown): PluginCommand[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: PluginCommand[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^[\w.:-]{1,80}$/.test(c.id) || seen.has(c.id)) continue
    if (typeof c.title !== 'string' || !c.title.trim()) continue
    seen.add(c.id)
    const shortcut = typeof c.shortcut === 'string' && parseKey(c.shortcut) ? c.shortcut : undefined
    out.push({ pluginId, id: c.id, title: c.title.trim().slice(0, 120), ...(shortcut ? { shortcut } : {}) })
    if (out.length === 100) break
  }
  return out
}

/** enabled = activated; disabled = turned off by the user; pendingPermissions = asked by the manifest, not approved yet */
export interface PluginInfo { manifest: PluginManifest; dir: string; builtin: boolean; enabled: boolean; disabled?: boolean; pendingPermissions?: PluginPermission[]; error?: string }

export function validateManifest(m: any): string | null {
  if (!m || typeof m !== 'object') return 'plugin.json invalide'
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(m.id)) return 'id manquant ou invalide'
  if (typeof m.name !== 'string' || !m.name) return 'name manquant'
  if (typeof m.main !== 'string' || !m.main) return 'main manquant'
  if (m.version !== undefined && typeof m.version !== 'string') return 'version invalide'
  if (m.permissions !== undefined && (!Array.isArray(m.permissions) || m.permissions.some((x: unknown) => typeof x !== 'string' || !Object.hasOwn(PLUGIN_PERMISSIONS, x as string)))) return 'permissions invalides'
  for (const a of m.contributes?.activity ?? []) if (!a.id || !a.title || (a.side !== 'left' && a.side !== 'right')) return 'contributes.activity invalide'
  for (const v of m.contributes?.views ?? []) if (!v.id || (!v.activity && v.placement !== 'bottom')) return 'contributes.views invalide'
  return null
}


// MARK: view models (rendered by the workbench, never drawn by plugins)

export interface ViewAction { id: string; title: string; icon?: string; primary?: boolean; shortcut?: string; disabled?: boolean }
export interface ViewItem {
  id: string
  label: string
  /** secondary text, inline after the label */
  detail?: string
  /** right-aligned text (e.g. "↑26") */
  extra?: string
  icon?: string
  /** a file path: shown with the file-type icon */
  file?: string
  /** a folder path: shown with the folder icon (open/closed follows the node) */
  folder?: string
  /** icon color: a token name (accent, badge.ok…) or a hex */
  color?: string
  badges?: string[]
  /** hover actions */
  actions?: ViewAction[]
  /** right-click menu ('sep' for a separator) */
  contextMenu?: (ViewAction | 'sep')[]
  children?: ViewItem[]
  expanded?: boolean
  /** defined = a checkbox is shown (group nodes: tri-state derived from children) */
  checked?: boolean
  /** dimmed row */
  muted?: boolean
  /** label color by change kind */
  tone?: 'added' | 'deleted' | 'modified' | 'renamed'
  /** highlighted row */
  selected?: boolean
  /** commit graph cell (list with graph: true) */
  graph?: { node: number; color: number; up: [number, number, number][]; down: [number, number, number][]; width: number }
}
export interface ViewFooter {
  fields?: { id: string; placeholder?: string; value?: string; multiline?: boolean }[]
  checks?: { id: string; label: string; checked: boolean }[]
  buttons?: ViewAction[]
}
export type ViewModel =
  | { kind: 'empty'; text: string }
  | { kind: 'list'; items: ViewItem[]; toolbar?: ViewAction[]; footer?: ViewFooter; search?: boolean; title?: string; detail?: ViewModel; graph?: boolean }
  /** foldAll: Tout replier / Tout déplier in the header; nodes that disappear forget whether they were folded */
  | { kind: 'tree'; items: ViewItem[]; toolbar?: ViewAction[]; footer?: ViewFooter; search?: boolean; title?: string; detail?: ViewModel; foldAll?: boolean }
  | { kind: 'markdown'; text: string }
  | { kind: 'diff'; text: string }
  /** panes stacked vertically with draggable separators */
  | { kind: 'stack'; panes: ViewModel[] }
  /** key/value fields and a text body (e.g. a commit) */
  | { kind: 'detail'; fields: { label: string; value: string; mono?: boolean }[]; body?: string }

/** Renderer → host: an interaction on a view (or a popover, whose id is "popover:<n>"). */
export interface ViewEvent {
  viewId: string
  type: 'select' | 'open' | 'action' | 'toolbar' | 'check' | 'input' | 'button' | 'menu'
  itemId?: string
  actionId?: string
  /** check: the new state; input: the field value */
  value?: boolean | string
  fieldId?: string
}

/** Host → renderer: a popover anchored to a view's header (search + list/tree). */
export interface PopoverRequest { id: string; anchorViewId: string; model: ViewModel }

/** Host → renderer: a side-by-side diff tab (original/modified) or a unified diff tab. */
export interface DiffRequest { title: string; path?: string; original?: string; modified?: string; unified?: string }

/** Host → renderer: a text prompt (modal); answered with `plugins:promptReply`. */
/** `choice`: only the options, as buttons (no text to type) */
export interface PromptRequest { id: number; title: string; placeholder?: string; options?: string[]; choice?: boolean }

/**
 * Host → renderer: a terminal command request. `command` is typed as is; `argv` commands are quoted for the tab's
 * shell and chained (each runs only if the previous one succeeded). Both may be given: command first.
 */
export interface RunRequest { cwd: string; command?: string; argv?: string[][]; label?: string; tab?: 'reuse' | 'new'; /** set by the host: `<pluginId>:<n>`, returned by terminal.run */ id?: string }

/** A command a plugin started in a shell tab, until it ends (shell integration): what terminal.runs() lists. */
export interface RunInfo { id: string; tabId: string; cwd: string; command: string; label?: string; started: boolean }

/** A short chip a plugin shows on a project tab or a linked folder (ui.projectDecoration). */
export interface ProjectDecoration { text: string; tone?: 'ok' | 'warn' | 'error' | 'info'; tooltip?: string }

export const FILE_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', js: '#e8c547', jsx: '#e8c547', mjs: '#e8c547', json: '#e8c547', py: '#4b8bbe', md: '#8a8f9e', css: '#a074c4', scss: '#c6538c',
  html: '#e44d26', sh: '#6cc644', zsh: '#6cc644', rs: '#dea584', go: '#00add8', swift: '#f05138', java: '#b07219', kt: '#a97bff', rb: '#cc342d', php: '#777bb3',
  yml: '#cb171e', yaml: '#cb171e', toml: '#9c4221', sql: '#e38c00', vue: '#41b883', svelte: '#ff3e00', c: '#555555', h: '#555555', cpp: '#f34b7d', cs: '#178600',
  png: '#b45fd6', jpg: '#b45fd6', jpeg: '#b45fd6', svg: '#ffb13b', lock: '#8a8f9e', txt: '#8a8f9e',
}

export const VIEW_ICONS = ['play', 'box', 'terminal', 'file', 'folder', 'sparkle', 'plug', 'puzzle', 'search', 'list', 'activity', 'gear', 'cpu', 'clock', 'link', 'code', 'image', 'stop'] as const

/** Items matching the query (label or detail); a matching group keeps all its children (a folder found by name). */
export function filterItems(items: ViewItem[], q: string): ViewItem[] {
  return items.flatMap((it) => {
    const hit = it.label.toLowerCase().includes(q) || (it.detail ?? '').toLowerCase().includes(q)
    if (hit) return [{ ...it, expanded: true }]
    const kids = it.children ? filterItems(it.children, q) : undefined
    if (kids && kids.length) return [{ ...it, children: kids, expanded: true }]
    return []
  })
}
