import { useEffect, useMemo } from 'react'
import type { ViewModel } from '@shared/plugins'
import { fromUserGroup, runnablesTree } from '@shared/runnables'
import { Icons } from '../icons'
import { Island, Empty } from '../Island'
import { PluginViewBody, type Send } from '../PluginView'
import { PanelTabs } from '../PanelTabs'
import { useWorkbench, type Project } from '@/stores/workbench'
import { useRunnables } from '@/stores/runnables'
import { useTests } from '@/stores/tests'
import { failedCount, testsTree } from '@shared/tests'
import { t } from '@/i18n'

/**
 * The Exécuteurs panel (left): Scripts (npm, make, cargo, go, python, shell scripts of the project, what runs first)
 * and Tests, as full-width tabs above the filter. Scripts is rendered by the same tree as plugin views (search, badges,
 * remembered open state).
 */
export function RunIsland({ project }: { project: Project }) {
  const groups = useRunnables((s) => s.groups)
  const launched = useRunnables((s) => s.launched)
  const urls = useRunnables((s) => s.urls)
  const runGroups = useWorkbench((s) => s.settings?.runGroups)
  const tabs = useWorkbench((s) => s.projects)   // runs follow the tabs (started, ended)
  useEffect(() => { useRunnables.getState().load(project.root); useTests.getState().load(project.root) }, [project.root])
  useEffect(() => window.ct.runnables.onChanged((root) => { if (root === useRunnables.getState().root) useRunnables.getState().load(root) }), [])
  const running = useMemo(() => useRunnables.getState().running(), [launched, tabs, urls])
  const userGroups = useMemo(() => useRunnables.getState().userGroups(), [runGroups, project.root, groups])
  const model: ViewModel = !project.root ? { kind: 'empty', text: t('Ouvre un projet') }
    : !groups.length && !running.length ? { kind: 'empty', text: t('Rien à lancer ici : pas de package.json, Makefile, Cargo.toml, go.mod ni script.') }
    : { kind: 'tree', search: true, items: runnablesTree(groups, running, userGroups) }
  const r = useRunnables.getState()
  const send: Send = (type, extra) => {
    const raw = extra?.itemId ?? '', act = extra?.actionId
    // a script under one of the user's groups is that script
    const inGroup = fromUserGroup(raw)
    const id = inGroup?.itemId ?? raw
    const group = raw.startsWith('ug:') && !inGroup ? raw.slice(3) : null
    const runId = id.startsWith('run:') ? id.slice(4) : r.runOf(id)
    if (group) {
      if (act === 'group-run') r.runGroup(group)
      else if (act === 'group-stop') r.stopGroup(group)
      else if (act === 'group-delete') r.deleteGroup(group)
      return
    }
    if (act === 'group-add') return void r.addToGroup(id)
    if (act === 'group-remove' && inGroup) return r.removeFromGroup(inGroup.group, inGroup.itemId)
    if (act === 'install') return r.install(id)
    if (act === 'stop') { if (runId) r.stop(runId); return }
    if (act === 'show') { if (runId) r.show(runId); return }
    if (act === 'open-url') { if (runId) r.openUrl(runId); return }
    if (type === 'open' && id.startsWith('run:')) return r.show(id.slice(4))
    if ((type === 'action' && act === 'run') || type === 'open') r.runItem(id)
  }
  // Tests: suites → files → describes → tests, with the last results
  const suites = useTests((s) => s.suites)
  const results = useTests((s) => s.results)
  const testsLoading = useTests((s) => s.loading)
  const tm = useTests.getState()
  const testModel: ViewModel = testsLoading && !suites.length ? { kind: 'empty', text: t('Recherche des tests…') }
    : !suites.length ? { kind: 'empty', text: t('Aucun test trouvé : ni Vitest, ni Jest, ni pytest dans ce projet.') }
    : { kind: 'tree', search: true, items: testsTree(suites, results, tm.runningIds(), project.root ?? '') }
  const sendTests: Send = (type, extra) => {
    const id = extra?.itemId ?? ''
    if (type === 'action' && extra?.actionId === 'run') return tm.run(id)
    if (type === 'action' && extra?.actionId === 'stop') return tm.stop(id)
    if (type === 'action' && extra?.actionId === 'fix') return tm.fix(id)
    if (type === 'select' || type === 'open') { const at = tm.locate(id); if (at) useWorkbench.getState().openFile(project.id, at.path, at.line) }
  }
  const actions = <button title={t('Actualiser')} onClick={() => { r.load(project.root); tm.load(project.root) }}>{Icons.refresh(14)}</button>
  return (
    <Island title={t('Exécuteurs')} icon={Icons.play(14)} actions={actions} grow dataView="run">
      {project.root ? (
        <PanelTabs storeKey="run" tabs={[
          { id: 'scripts', label: t('Scripts'), count: running.length, content: <PluginViewBody model={model} send={send} layoutKey="run:scripts" /> },
          { id: 'tests', label: t('Tests'), count: failedCount(results, suites), content: <PluginViewBody model={testModel} send={sendTests} layoutKey="run:tests" /> },
        ]} />
      ) : <Empty>{t('Ouvre un projet')}</Empty>}
    </Island>
  )
}
