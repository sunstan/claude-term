import { Island, Empty } from './Island'
import { Icons } from './icons'
import { FileTree } from './FileTree'
import { useMemo } from 'react'
import { useWorkbench, type Project } from '@/stores/workbench'
import { Gutter, VStack, PStack, useStoredSize, useCollapsed } from './Split'
import { LinksIsland } from './islands/Links'
import { SearchIsland } from './islands/Search'
import { SkillsIsland } from './islands/Skills'
import { McpIsland } from './islands/Mcp'
import { ProcessIsland } from './islands/Process'
import { ClaudeIsland } from './islands/Claude'
import { HistoryIsland } from './islands/History'
import { PluginViewIsland } from './PluginView'
import { PluginsIsland } from './islands/Plugins'
import { RunIsland } from './islands/Run'
import { MemoIsland, MemoAllIsland } from './islands/Memo'
import { usePlugins } from '@/stores/plugins'
import { useExplorer } from '@/stores/explorer'
import { isInside } from '@shared/claude-format'
import { withShortcut } from '@/actions'

function PluginViews({ activity }: { activity: string }) {
  const plugins = usePlugins((s) => s.plugins)
  const views = useMemo(() => usePlugins.getState().viewsOf(activity), [plugins, activity])
  if (!views.length) return <Island title={activity} grow><Empty>—</Empty></Island>
  return <PStack ids={views.map((v) => v.id)}>{views.map((v) => <PluginViewIsland key={v.id} viewId={v.id} title={v.title} grow />)}</PStack>
}
import { t } from '@/i18n'

/** Explorer header: reveal the shown file, collapse every folder, hidden and ignored files, the folder in the OS. */
function ExplorerActions({ project }: { project: Project }) {
  const showHidden = useWorkbench((s) => s.settings?.explorerShowHidden ?? true)
  const file = project.tabs.find((x) => x.id === project.currentTabId && x.kind === 'file')?.path
  const root = project.root
  return (
    <>
      <button title={withShortcut(t('Révéler le fichier affiché'), 'app.revealFile')} disabled={!file || !root || !isInside(file, root)} onClick={() => file && useExplorer.getState().revealPath(file)}>{Icons.locate(15)}</button>
      <button title={t('Tout replier')} disabled={!root} onClick={() => root && useExplorer.getState().collapseAll(root)}>{Icons.collapseAll(15)}</button>
      <button title={showHidden ? t('Cacher les fichiers masqués et ceux que git ignore') : t('Afficher les fichiers masqués (.env, .claude…) et ceux que git ignore')}
        onClick={() => window.ct.settings.set({ explorerShowHidden: !showHidden })}>{showHidden ? Icons.eye(15) : Icons.eyeOff(15)}</button>
      <button title={t(window.ct.platform === 'darwin' ? 'Afficher dans le Finder' : "Afficher dans l'explorateur")} onClick={() => root && window.ct.app.revealInFinder(root)}>{Icons.external()}</button>
    </>
  )
}

export function LeftSidebar({ project }: { project: Project }) {
  const activity = useWorkbench((s) => s.leftActivity)
  const [width, setWidth] = useStoredSize('left', 260)
  const [linksCollapsed, setLinksCollapsed] = useCollapsed('links')
  const [mcpCollapsed, setMcpCollapsed] = useCollapsed('mcp-user')
  if (!activity) return null
  const name = project.root?.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return (
    <>
    <div className="sidebar left" style={{ width }}>
      {activity === 'explorer' && (
        <VStack id="explorer" collapsed={linksCollapsed} initial={200}
          top={
            <Island title={name} icon={Icons.folder(14)} grow actions={<ExplorerActions project={project} />}>
              {project.root ? <FileTree project={project} root={project.root} /> : <Empty>{t('Aucun dossier')}</Empty>}
            </Island>}
          bottom={<LinksIsland project={project} collapsed={linksCollapsed} onCollapse={setLinksCollapsed} />}
        />
      )}
      {activity === 'search' && <SearchIsland project={project} />}
      {activity === 'history' && <HistoryIsland scope="project" />}
      {activity === 'skills' && <SkillsIsland title={t('Skills du projet')} root={project.root} createIn={project.root} grow load={async () => [...(await window.ct.skills.project(project.root!)), ...(await window.ct.skills.linked(project.root!))]} />}
      {activity === 'mcp' && (
        <VStack id="mcp" collapsed={mcpCollapsed}
          top={<McpIsland scope="project" root={project.root} grow />}
          bottom={<McpIsland scope="user" root={project.root} collapsed={mcpCollapsed} onCollapse={setMcpCollapsed} />}
        />
      )}
      {activity === 'plugins' && <PluginsIsland />}
      {activity === 'run' && <RunIsland project={project} />}
      {activity === 'memo' && project.root && <MemoIsland project={project} />}
      {activity.includes(':') && <PluginViews activity={activity} />}
    </div>
    <Gutter axis="x" className="left" size={width} onSize={setWidth} min={180} max={600} reset={260} />
    </>
  )
}

export function RightSidebar() {
  const activity = useWorkbench((s) => s.rightActivity)
  const [width, setWidth] = useStoredSize('right', 320)
  const [pluginsCollapsed, setPluginsCollapsed] = useCollapsed('skills-plugins')
  if (!activity) return null
  return (
    <>
    <Gutter axis="x" className="right" size={width} onSize={setWidth} sign={-1} min={220} max={700} reset={320} />
    <div className="sidebar right" style={{ width }}>
      {activity === 'claude' && <ClaudeIsland />}
      {activity === 'process' && <ProcessIsland />}
      {activity === 'history' && <HistoryIsland scope="all" />}
      {activity === 'memo' && <MemoAllIsland />}
      {activity.includes(':') && <PluginViews activity={activity} />}
      {activity === 'skills' && (
        <VStack id="skills" collapsed={pluginsCollapsed}
          top={<SkillsIsland title={t('Skills perso')} root={null} createIn={null} grow load={() => window.ct.skills.personal()} />}
          bottom={<SkillsIsland title={t('Skills des plugins')} root={null} collapsed={pluginsCollapsed} onCollapse={setPluginsCollapsed} load={() => window.ct.skills.plugins()} />}
        />
      )}
    </div>
    </>
  )
}
