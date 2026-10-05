/**
 * Keymap: actions with defaults per preset (JetBrains, VS Code). Shortcuts are "Mod+Shift+L" (Mod = ⌘ on macOS,
 * Ctrl elsewhere). A VS Code default is given only where it differs from the JetBrains one.
 */
export type KeymapPreset = 'jetbrains' | 'vscode'
type PerPlatform = string | { mac: string; other: string }
/** general: anywhere (and over the others); editor: Monaco; terminal: only while a terminal has the focus */
export interface KeyAction { id: string; scope: 'general' | 'editor' | 'terminal'; label: string; default: string; vscode?: PerPlatform }

export const ACTIONS: KeyAction[] = [
  // general
  { id: 'app.newShell', scope: 'general', label: 'Nouvel onglet shell', default: 'Mod+T', vscode: 'Ctrl+Shift+`' },
  { id: 'app.newClaude', scope: 'general', label: 'Nouvel onglet Claude', default: 'Mod+Shift+T' },
  { id: 'app.closeTab', scope: 'general', label: "Fermer l'onglet", default: 'Mod+W' },
  { id: 'app.nextTab', scope: 'general', label: 'Onglet suivant', default: 'Mod+Shift+]', vscode: 'Ctrl+PageDown' },
  { id: 'app.prevTab', scope: 'general', label: 'Onglet précédent', default: 'Mod+Shift+[', vscode: 'Ctrl+PageUp' },
  { id: 'app.newProject', scope: 'general', label: 'Nouveau projet', default: 'Mod+N', vscode: 'Mod+Shift+N' },
  { id: 'app.openFolder', scope: 'general', label: 'Ouvrir un dossier', default: 'Mod+O' },
  { id: 'app.goToFile', scope: 'general', label: 'Aller au fichier', default: 'Mod+Shift+O', vscode: 'Mod+P' },
  { id: 'app.commands', scope: 'general', label: 'Commandes', default: 'Mod+Shift+A', vscode: 'Mod+Shift+P' },
  { id: 'app.settings', scope: 'general', label: 'Réglages', default: 'Mod+,' },
  { id: 'app.save', scope: 'general', label: 'Enregistrer', default: 'Mod+S' },
  { id: 'app.screenshot', scope: 'general', label: "Capture d'écran → prompt", default: 'Mod+Alt+S' },
  { id: 'app.explorer', scope: 'general', label: 'Explorateur', default: 'Mod+1', vscode: 'Mod+Shift+E' },
  { id: 'app.search', scope: 'general', label: 'Recherche', default: 'Mod+2', vscode: 'Mod+Shift+F' },
  { id: 'app.history', scope: 'general', label: 'Historique du projet', default: 'Mod+3' },
  { id: 'app.skills', scope: 'general', label: 'Skills du projet', default: 'Mod+4' },
  { id: 'app.mcp', scope: 'general', label: 'MCP', default: 'Mod+5' },
  { id: 'app.plugins', scope: 'general', label: 'Plugins', default: 'Mod+6', vscode: 'Mod+Shift+X' },
  { id: 'app.run', scope: 'general', label: 'Exécuteurs', default: 'Mod+7', vscode: 'Mod+Shift+D' },
  { id: 'app.git', scope: 'general', label: 'Git', default: 'Mod+9', vscode: 'Ctrl+Shift+G' },
  { id: 'app.commit', scope: 'general', label: 'Commit', default: 'Mod+K', vscode: '' },
  // terminal (while it has the focus; its own keys, so not limited to what terminals leave to the app)
  { id: 'terminal.find', scope: 'terminal', label: 'Rechercher dans le terminal', default: 'Mod+F' },
  // editor (Monaco commands)
  { id: 'editor.action.formatDocument', scope: 'editor', label: 'Reformater le code', default: 'Mod+Alt+L', vscode: 'Alt+Shift+F' },
  { id: 'editor.action.commentLine', scope: 'editor', label: 'Commenter la ligne', default: 'Mod+/' },
  { id: 'editor.action.blockComment', scope: 'editor', label: 'Commentaire de bloc', default: 'Mod+Alt+/', vscode: 'Alt+Shift+A' },
  { id: 'editor.action.copyLinesDownAction', scope: 'editor', label: 'Dupliquer la ligne', default: 'Mod+D', vscode: 'Alt+Shift+ArrowDown' },
  { id: 'editor.action.deleteLines', scope: 'editor', label: 'Supprimer la ligne', default: 'Mod+Backspace', vscode: 'Mod+Shift+K' },
  { id: 'editor.action.moveLinesUpAction', scope: 'editor', label: 'Monter la ligne', default: 'Alt+Shift+ArrowUp', vscode: 'Alt+ArrowUp' },
  { id: 'editor.action.moveLinesDownAction', scope: 'editor', label: 'Descendre la ligne', default: 'Alt+Shift+ArrowDown', vscode: 'Alt+ArrowDown' },
  { id: 'editor.action.gotoLine', scope: 'editor', label: 'Aller à la ligne', default: 'Mod+L', vscode: 'Ctrl+G' },
  { id: 'actions.find', scope: 'editor', label: 'Rechercher', default: 'Mod+F' },
  { id: 'editor.action.startFindReplaceAction', scope: 'editor', label: 'Remplacer', default: 'Mod+R', vscode: { mac: 'Mod+Alt+F', other: 'Mod+H' } },
  { id: 'editor.action.addSelectionToNextFindMatch', scope: 'editor', label: 'Sélectionner l’occurrence suivante', default: 'Ctrl+G', vscode: 'Mod+D' },
  { id: 'editor.action.smartSelect.expand', scope: 'editor', label: 'Étendre la sélection', default: 'Alt+ArrowUp', vscode: { mac: 'Mod+Ctrl+Shift+ArrowRight', other: 'Alt+Shift+ArrowRight' } },
  { id: 'editor.action.smartSelect.shrink', scope: 'editor', label: 'Réduire la sélection', default: 'Alt+ArrowDown', vscode: { mac: 'Mod+Ctrl+Shift+ArrowLeft', other: 'Alt+Shift+ArrowLeft' } },
  { id: 'editor.action.revealDefinition', scope: 'editor', label: 'Aller à la définition', default: 'Mod+B', vscode: 'F12' },
  { id: 'editor.action.rename', scope: 'editor', label: 'Renommer le symbole', default: 'Shift+F6', vscode: 'F2' },
  { id: 'editor.action.triggerSuggest', scope: 'editor', label: 'Complétion', default: 'Ctrl+Space' },
  { id: 'editor.foldAll', scope: 'editor', label: 'Tout replier', default: 'Mod+Shift+-' },
  { id: 'editor.unfoldAll', scope: 'editor', label: 'Tout déplier', default: 'Mod+Shift+=' },
]

export interface Combo { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string }

/** "Mod+Shift+L" → combo. Key names follow KeyboardEvent.key (single chars lowercased). */
export function parse(s: string): Combo | null {
  if (!s) return null
  const parts = s.split('+'); const key = parts.pop()!
  if (!key) return null
  const c: Combo = { mod: false, ctrl: false, alt: false, shift: false, key: key.length === 1 ? key.toLowerCase() : key }
  for (const p of parts) {
    if (p === 'Mod') c.mod = true; else if (p === 'Ctrl') c.ctrl = true; else if (p === 'Alt') c.alt = true; else if (p === 'Shift') c.shift = true; else return null
  }
  return c
}

/** A keydown as the keymap reads it; altGraph: AltGr held (Windows reports it as Ctrl+Alt). */
export interface KeyEventLike { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; altGraph?: boolean }

const CODE_KEYS: Record<string, string> = { Slash: '/', Comma: ',', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Space: 'Space', Backquote: '`' }

/** Event (key, code and modifier flags) → does it match `s` on this platform? */
export function matches(s: string, e: KeyEventLike, mac: boolean): boolean {
  const c = parse(s)
  if (!c || e.altGraph) return false
  // macOS: Mod is ⌘ and Ctrl is ⌃; elsewhere both are Ctrl
  const wantMeta = mac && c.mod, wantCtrl = mac ? c.ctrl : c.mod || c.ctrl
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== c.alt || e.shiftKey !== c.shift) return false
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  // with Alt/Shift on macOS, e.key is the composed character: fall back to the physical key
  const fromCode = e.code?.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.code?.startsWith('Digit') ? e.code.slice(5) : undefined
  return k === c.key || fromCode === c.key || (e.code !== undefined && CODE_KEYS[e.code] === c.key) || (c.key === 'Space' && k === ' ')
}

/** Combo from a keydown (the recorder in the settings); null while only modifiers are held. */
export function fromEvent(e: KeyEventLike, mac: boolean): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'AltGraph'].includes(e.key)) return null
  const parts: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod')
  if (mac && e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const code = e.code ?? ''
  const key = code.startsWith('Key') ? code.slice(3).toUpperCase() : code.startsWith('Digit') ? code.slice(5)
    : CODE_KEYS[code] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  parts.push(key)
  return parts.join('+')
}

/** Human label: ⌘⇧L on macOS, Ctrl+Shift+L elsewhere. */
export function label(s: string, mac: boolean): string {
  const c = parse(s)
  if (!c) return '—'
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: mac ? '⌫' : 'Backspace', Space: mac ? '␣' : 'Space' }
  const k = arrows[c.key] ?? c.key.toUpperCase()
  if (mac) return (c.ctrl ? '⌃' : '') + (c.alt ? '⌥' : '') + (c.shift ? '⇧' : '') + (c.mod ? '⌘' : '') + k
  return [c.mod || c.ctrl ? 'Ctrl' : '', c.alt ? 'Alt' : '', c.shift ? 'Shift' : '', k].filter(Boolean).join('+')
}

/** The preset's shortcut for an action, before the user's overrides. */
export function defaultBinding(a: KeyAction, preset: KeymapPreset = 'jetbrains', mac = false): string {
  const v = preset === 'vscode' ? a.vscode : undefined
  if (v === undefined) return a.default
  return typeof v === 'string' ? v : mac ? v.mac : v.other
}

export function binding(id: string, overrides: Record<string, string>, preset: KeymapPreset = 'jetbrains', mac = false): string {
  const a = ACTIONS.find((x) => x.id === id)
  return overrides[id] ?? (a ? defaultBinding(a, preset, mac) : '')
}

/** Actions sharing a shortcut within the same scope (general conflicts with everything). */
export function conflicts(overrides: Record<string, string>, preset: KeymapPreset = 'jetbrains', mac = false): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const a of ACTIONS) for (const b of ACTIONS) {
    if (a.id === b.id) continue
    const x = binding(a.id, overrides, preset, mac), y = binding(b.id, overrides, preset, mac)
    if (x && x === y && (a.scope === b.scope || a.scope === 'general' || b.scope === 'general')) (out[a.id] ??= []).push(b.id)
  }
  return out
}

/**
 * Whether a shortcut is taken from a terminal for the app. Ctrl+letter alone belongs to the shell and to Claude Code
 * (^W deletes a word, ^K cuts the line, ^R searches the history…): only ⌘ combos, and Ctrl ones with Shift or Alt or on
 * a key that is not a letter, are the app's there.
 */
export function terminalSafe(s: string, mac: boolean): boolean {
  const c = parse(s)
  if (!c) return false
  const ctrl = mac ? c.ctrl : c.mod || c.ctrl
  if (mac && c.mod) return true
  return !(ctrl && !c.shift && !c.alt && /^[a-z]$/.test(c.key))
}

/** The general action a keydown triggers, if any; in a terminal, only the shortcuts it leaves to the app. */
export function findAction(e: KeyEventLike, overrides: Record<string, string>, mac: boolean, opts: { preset?: KeymapPreset; inTerminal?: boolean } = {}): KeyAction | null {
  for (const a of ACTIONS) {
    if (a.scope !== 'general') continue
    const s = binding(a.id, overrides, opts.preset, mac)
    if (matches(s, e, mac) && (!opts.inTerminal || terminalSafe(s, mac))) return a
  }
  return null
}
