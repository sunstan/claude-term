import { create } from 'zustand'
import type { RunGroup, RunItem, Running, UserRunGroup } from '@shared/runnables'
import type { RunLine } from '@shared/run-lines'
import { normId } from '@shared/run-lines'
import { DevUrlSniffer } from '@shared/dev-url'
import type { DevServer } from '@shared/listening'
import { useWorkbench } from './workbench'
import { useAsk } from './ask'
import { t } from '@/i18n'

/**
 * The Exécuter panel's state (Scripts tab): what the active project can run, and the commands it started, followed
 * through the tab that runs them (tab.run, shell integration) until they end. A script runs in a tab of its own,
 * reused while it lives; its output is read for a dev server's address. The editor's gutter ▶ goes through here too,
 * so a line started from a file shows in "En cours" and can be stopped.
 */
interface RunnablesStore {
  root: string | null
  groups: RunGroup[]
  /** run id → what was started */
  launched: Record<string, { itemId: string; label: string; command: string }>
  /** a script's own tab, by its normalized id */
  scriptTabs: Record<string, string>
  /** run id → the dev server address its output printed */
  urls: Record<string, string>
  /** servers listening under the app's terminals, Claude's background ones included (pollServers) */
  servers: DevServer[]
  pollServers(): Promise<void>
  load(root: string | null): Promise<void>
  item(itemId: string): RunItem | undefined
  /** starts a script in its own tab; shows it when it already runs */
  runItem(itemId: string): Promise<void>
  runLine(line: RunLine): void
  stop(runId: string): void
  show(runId: string): void
  openUrl(runId: string): void
  /** the group's dependencies (its package manager's install) */
  install(groupId: string): void
  /** runs still alive, from the tabs */
  running(): Running[]
  /** the run of an item (or of a gutter line), matched across path spellings */
  runOf(itemId: string): string | undefined
  /** the active project's named groups of scripts */
  userGroups(): UserRunGroup[]
  addToGroup(itemId: string): Promise<void>
  removeFromGroup(name: string, itemId: string): void
  deleteGroup(name: string): void
  runGroup(name: string): Promise<void>
  stopGroup(name: string): void
}

let seq = 0

export const useRunnables = create<RunnablesStore>((set, get) => ({
  root: null,
  groups: [],
  launched: {},
  scriptTabs: {},
  urls: {},
  servers: [],
  async pollServers() {
    if (polling) return
    polling = true
    try { const servers = await window.ct.processes.devServers(); if (JSON.stringify(servers) !== JSON.stringify(get().servers)) set({ servers }) } finally { polling = false }
  },
  async load(root) {
    set({ root })
    const groups = root ? await window.ct.runnables.detect(root) : []
    if (get().root === root) set({ groups })
  },
  item(itemId) {
    const want = normId(itemId)
    for (const g of get().groups) for (const c of g.children) if (normId(c.id) === want) return c
    return undefined
  },
  async runItem(itemId) {
    const it = get().item(itemId)
    if (!it) return
    const live = get().runOf(it.id)
    if (live) return get().show(live)
    await startRun(it.id, it.label, it.cwd, it.command, { own: true })
  },
  runLine(line) {
    // a script the tab lists runs as its item (its package manager, its own tab), any other line as is
    const it = get().item(line.itemId)
    if (it) get().runItem(it.id)
    else startRun(line.itemId, line.label, line.cwd, line.command)
  },
  stop(runId) { const t = tabOfRun(runId); if (t?.ptyId) window.ct.pty.write(t.ptyId, '\x03') },
  show(runId) {
    const st = useWorkbench.getState()
    for (const p of st.projects) { const t = p.tabs.find((x) => x.run?.id === runId); if (t) { st.setActiveProject(p.id); st.setCurrentTab(p.id, t.id); return } }
  },
  openUrl(runId) { const u = get().urls[runId]; if (u) window.ct.app.openUrl(u) },
  install(groupId) {
    const g = get().groups.find((x) => normId(x.id) === normId(groupId))
    if (!g?.install) return
    const dir = g.children[0]?.cwd ?? g.id.replace(/^[a-z]+:/, '')
    startRun(g.id + ':install', g.install, dir, g.install, { own: true })
  },
  running() {
    const { launched, urls } = get()
    return useWorkbench.getState().projects.flatMap((p) => p.tabs).filter((t) => t.alive && t.run && launched[t.run.id])
      .map((t) => ({ runId: t.run!.id, itemId: launched[t.run!.id].itemId, label: launched[t.run!.id].label, command: t.lastCommand || launched[t.run!.id].command, started: t.run!.started, url: urls[t.run!.id] }))
  },
  runOf(itemId) {
    const want = normId(itemId)
    return get().running().find((r) => r.itemId && normId(r.itemId) === want)?.runId
  },
  userGroups() {
    const root = get().root
    return (root && useWorkbench.getState().settings?.runGroups?.[root]) || []
  },
  async addToGroup(itemId) {
    const it = get().item(itemId)
    if (!it) return
    const groups = get().userGroups()
    // the existing groups are choices, not a default value (accepting it as is made a group « Dev, Build »)
    const name = (await useAsk.getState().ask(t('Ajouter « {s} » au groupe', { s: it.label }), t('nom du groupe'), groups.map((g) => g.name)))?.trim()
    if (!name) return
    const same = groups.find((g) => g.name.toLowerCase() === name.toLowerCase())
    if (same?.items.some((id) => normId(id) === normId(it.id))) return
    saveGroups(same ? groups.map((g) => (g === same ? { ...g, items: [...g.items, it.id] } : g)) : [...groups, { name, items: [it.id] }])
  },
  removeFromGroup(name, itemId) {
    saveGroups(get().userGroups().map((g) => (g.name === name ? { ...g, items: g.items.filter((id) => normId(id) !== normId(itemId)) } : g)))
  },
  deleteGroup(name) { saveGroups(get().userGroups().filter((g) => g.name !== name)) },
  async runGroup(name) {
    // one after the other: each may open its tab
    for (const id of get().userGroups().find((g) => g.name === name)?.items ?? []) await get().runItem(id)
  },
  stopGroup(name) {
    for (const id of get().userGroups().find((g) => g.name === name)?.items ?? []) { const r = get().runOf(id); if (r) get().stop(r) }
  },
}))

function saveGroups(list: UserRunGroup[]) {
  const root = useRunnables.getState().root
  const all = useWorkbench.getState().settings?.runGroups ?? {}
  if (!root) return
  const next = { ...all }
  if (list.length) next[root] = list; else delete next[root]
  window.ct.settings.set({ runGroups: next })
}

/**
 * Runs a command (a string typed as is, or an argv quoted for the tab's shell), followed until it ends. `own`: in the
 * script's own tab (a new one titled after it when it has none, or when that one is busy).
 */
export async function startRun(itemId: string, label: string, cwd: string, command: string | string[], o: { own?: boolean } = {}) {
  const st = useWorkbench.getState()
  if (!st.activeProjectId) return
  const id = `run:${++seq}`
  const text = typeof command === 'string' ? command : command.join(' ')
  useRunnables.setState((s) => ({ launched: { ...s.launched, [id]: { itemId, label, command: text } } }))
  const key = normId(itemId)
  const tab = o.own ? { id: useRunnables.getState().scriptTabs[key], title: label } : 'reuse' as const
  const tabId = await st.runCommand(st.activeProjectId, cwd, [command], tab, { id, label }, { show: st.settings?.runShow !== false })
  if (!tabId) return
  if (o.own) useRunnables.setState((s) => ({ scriptTabs: { ...s.scriptTabs, [key]: tabId } }))
  watchUrl(id, tabId, text)
}

/** reads the run's output for a dev server's address, until it has one or the run ends */
const watchers = new Map<string, () => void>()
function watchUrl(runId: string, tabId: string, command: string) {
  const tab = useWorkbench.getState().projects.flatMap((p) => p.tabs).find((x) => x.id === tabId)
  if (!tab?.ptyId) return
  const sniff = new DevUrlSniffer(command)
  const off = window.ct.pty.onData(tab.ptyId, (d) => {
    const url = sniff.feed(d)
    if (!url) return
    useRunnables.setState((s) => ({ urls: { ...s.urls, [runId]: url } }))
    off(); watchers.delete(runId)
  })
  watchers.set(runId, off)
}

function tabOfRun(runId: string) {
  for (const p of useWorkbench.getState().projects) { const t = p.tabs.find((x) => x.run?.id === runId); if (t) return t }
  return undefined
}

/** forget runs whose tab no longer carries them, and the tabs of scripts that are gone */
useWorkbench.subscribe((s) => {
  const tabs = s.projects.flatMap((p) => p.tabs)
  const alive = new Set(tabs.filter((t) => t.run).map((t) => t.run!.id))
  const { launched: l, urls, scriptTabs } = useRunnables.getState()
  // a run shows on its tab a moment after start(): only those already seen on a tab are forgotten
  const gone = Object.keys(l).filter((id) => !alive.has(id) && seenOnTab.has(id))
  if (gone.length) {
    const next = { ...l }, nextUrls = { ...urls }
    for (const id of gone) { delete next[id]; delete nextUrls[id]; seenOnTab.delete(id); watchers.get(id)?.(); watchers.delete(id) }
    useRunnables.setState({ launched: next, urls: nextUrls })
  }
  for (const id of alive) if (l[id]) seenOnTab.add(id)
  const ids = new Set(tabs.map((t) => t.id))
  const kept = Object.entries(scriptTabs).filter(([, tab]) => ids.has(tab))
  if (kept.length !== Object.keys(scriptTabs).length) useRunnables.setState({ scriptTabs: Object.fromEntries(kept) })
})
const seenOnTab = new Set<string>()
let polling = false
