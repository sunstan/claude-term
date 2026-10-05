import { Icons } from './icons'
import { TermBubble, attentionColor, attentionLabel } from './TermBubble'
import { useReorder } from './useReorder'
import { TerminalHost } from '@/terminal/TerminalView'
import { useEffect, useState } from 'react'
import { useWorkbench, isClaude, type Project, type Tab } from '@/stores/workbench'
import { VStack, useCollapsed } from './Split'
import { SessionBlock } from './SessionBlock'
import { Island } from './Island'
import { MenuButton, ContextMenu } from './Menu'
import { shortcutLabel, withShortcut } from '@/actions'
import { EditorHost, ImageView, DiffHost } from '@/editor/EditorHost'
import { MarkdownPreview } from '@/editor/MarkdownPreview'
import { Gutter, useStoredSize } from './Split'
import { t as tr } from '@/i18n'


/** File state of the current tab, in the island header (terminal tabs show theirs in a floating bubble: TermBubble). */
function TabStatus({ tab }: { tab: Tab }) {
  const { reloadFile, saveFile } = useWorkbench()
  const badge = (text: string, color: string) => <span className="badge" style={{ background: `color-mix(in srgb, ${color} 20%, transparent)`, color }}>{text}</span>
  if (tab.kind === 'file') {
    return (
      <span className="tstatus">
        {tab.error && <span style={{ color: 'var(--ct-badge-error)' }}>{tab.error}</span>}
        {tab.changedOnDisk && <span className="item">{badge(tr('modifié sur le disque'), 'var(--ct-badge-warn)')}<button className="linkbtn" onClick={() => reloadFile(tab.path!)}>{tr('Recharger')}</button></span>}
        {tab.dirty && !tab.changedOnDisk && <button className="linkbtn" onClick={() => saveFile(tab.path!)}>{withShortcut(tr('Enregistrer'), 'app.save')}</button>}
      </span>
    )
  }
  return null
}

function tabColor(t: Tab) {
  if (!t.alive) return 'var(--ct-text-tertiary)'
  if (isClaude(t)) return 'var(--ct-accent)'
  if (t.busy) return 'var(--ct-badge-ok)'
  if (t.lastExit !== null && t.lastExit !== 0) return 'var(--ct-badge-error)'
  return 'var(--ct-badge-info)'
}

export function Center({ project }: { project: Project }) {
  const { newTab, closeTab, closeFiles, setCurrentTab, moveTab } = useWorkbench()
  const drag = useReorder('tab:' + project.id, (from, to, place) => moveTab(project.id, from, to, place))
  const [ctx, setCtx] = useState<{ x: number; y: number; tab: Tab } | null>(null)
  const setMdMode = useWorkbench((s) => s.setMdMode)
  const [splitWidth, setSplitWidth] = useStoredSize('md-split', 50)   // % of the editor area
  const fileCount = project.tabs.filter((t) => t.kind === 'file').length
  const [sessionCollapsed, setSessionCollapsed] = useCollapsed('session')
  const current = project.tabs.find((t) => t.id === project.currentTabId) ?? null
  useEffect(() => { document.querySelector('.tabs .tab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }) }, [project.currentTabId])
  const home = window.ct.home
  const short = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p)
  return (
    <div className="center">
      <ContextMenu at={ctx} onClose={() => setCtx(null)} items={ctx ? [
        { label: tr('Fermer'), shortcut: shortcutLabel('app.closeTab'), onSelect: () => closeTab(project.id, ctx.tab.id) },
        'sep',
        { label: tr('Fermer les autres fichiers'), disabled: fileCount < (ctx.tab.kind === 'file' ? 2 : 1), onSelect: () => closeFiles(project.id, ctx.tab.kind === 'file' ? ctx.tab.id : undefined) },
        { label: tr('Fermer tous les fichiers'), disabled: fileCount === 0, onSelect: () => closeFiles(project.id) },
        ...(ctx.tab.kind === 'file' ? ['sep' as const, { label: tr('Afficher dans le Finder'), onSelect: () => window.ct.app.revealInFinder(ctx.tab.path!) }, { label: tr('Copier le chemin'), onSelect: () => navigator.clipboard.writeText(ctx.tab.path!) }] : []),
      ] : []} />
      <VStack id="session" collapsed={sessionCollapsed} initial={240} min={120}
        top={<Island grow title={
            <div className="tabs">
              {project.tabs.map((t) => (
                <div key={t.id} {...drag.props(t.id)} className={'tab' + (t.id === project.currentTabId ? ' on' : '') + (t.dirty ? ' dirty' : '') + drag.dropClass(t.id)} onClick={() => setCurrentTab(project.id, t.id)} onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, tab: t }) }} title={t.kind === 'file' ? t.path : t.busy ? t.lastCommand : t.cwd}>
                  <span style={{ color: t.kind === 'file' ? (t.changedOnDisk ? 'var(--ct-badge-warn)' : 'var(--ct-text-secondary)') : tabColor(t), display: 'inline-flex', position: 'relative' }} title={t.attention ? attentionLabel(t.attention) : undefined}>
                    {t.kind === 'diff' ? Icons.columns(12) : t.kind === 'file' ? (t.fileKind === 'image' ? Icons.image(12) : Icons.file(12)) : isClaude(t) ? Icons.claude(12) : Icons.terminal(12)}
                    {t.attention && <span className="attn" style={{ background: attentionColor(t.attention) }} />}
                  </span>
                  <span style={{ fontStyle: t.dirty ? 'italic' : undefined }}>{t.title}</span>
                  <button className={'close' + (t.dirty ? ' dot' : '')} onClick={(e) => { e.stopPropagation(); closeTab(project.id, t.id) }} title={t.dirty ? withShortcut(tr('Modifications non enregistrées'), 'app.save') : withShortcut(tr('Fermer'), 'app.closeTab')}>
                    {t.dirty ? <span className="dirty-dot" /> : Icons.x(10)}
                  </button>
                </div>
              ))}
            </div>}
          actions={<>
            {current?.kind === 'file' && <TabStatus tab={current} />}
            <MenuButton title={tr('Nouvel onglet')} items={[
              { label: tr('Claude'), icon: Icons.claude(13), shortcut: shortcutLabel('app.newClaude'), onSelect: () => newTab(project.id, 'claude') },
              { label: tr('Shell'), icon: Icons.terminal(13), shortcut: shortcutLabel('app.newShell'), onSelect: () => newTab(project.id, 'shell') },
              ...(window.ct.platform !== 'linux' ? ['sep' as const, { label: tr("Capture d'écran → prompt"), icon: Icons.camera(13), shortcut: shortcutLabel('app.screenshot'), onSelect: () => useWorkbench.getState().captureScreen(project.id) }] : []),
            ]}>{Icons.plus()}</MenuButton>
          </>}>
          {current && current.kind === 'diff' ? <div className="term-wrap editor-bg"><DiffHost key={current.id} tab={current} /></div>
          : current && current.kind === 'file' ? (
            current.error ? <div className="term-wrap"><div className="empty">{current.error}</div></div>
            : current.fileKind === 'image' ? <div className="term-wrap"><ImageView src={current.imageUrl ?? ''} /></div>
            : /\.(md|markdown)$/i.test(current.path ?? '') ? (
              <div className="term-wrap editor-bg md-host">
                <div className={'md-panes mode-' + (current.mdMode ?? 'code')}>
                  {(current.mdMode ?? 'code') !== 'preview' && <div className="md-pane" style={{ flex: current.mdMode === 'split' ? `0 0 ${splitWidth}%` : '1' }}><EditorHost tab={current} /></div>}
                  {current.mdMode === 'split' && <Gutter axis="x" className="inner" onDrag={(d) => setSplitWidth((w) => Math.max(20, Math.min(80, w + (d / (document.querySelector('.md-panes')?.clientWidth || 1000)) * 100)))} />}
                  {(current.mdMode ?? 'code') !== 'code' && <div className="md-pane"><MarkdownPreview path={current.path!} /></div>}
                </div>
                <div className="md-modes">
                  {(['code', 'split', 'preview'] as const).map((m) => (
                    <button key={m} className={(current.mdMode ?? 'code') === m ? 'on' : ''} title={m === 'code' ? tr('Code') : m === 'split' ? tr('Côte à côte') : tr('Rendu')} onClick={() => setMdMode(current.id, m)}>
                      {m === 'code' ? Icons.code(13) : m === 'split' ? Icons.columns(13) : Icons.eye(13)}
                    </button>
                  ))}
                </div>
              </div>
            ) : <div className="term-wrap editor-bg"><EditorHost tab={current} /></div>
          ) : current ? (
            <div className="term-stack"><TerminalHost key={current.id} tab={current} /><TermBubble tab={current} /></div>
          ) : (
            <div className="term-wrap">
              <div className="welcome">
                <div>
                  <div style={{ color: 'var(--ct-text-tertiary)' }}>{Icons.terminalBox(40)}</div>
                  <h1>{tr('Aucune session')}</h1>
                  <p>{short(project.selectedFolder)}</p>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <button className="btn primary" onClick={() => newTab(project.id, 'claude')}>{Icons.claude(14)} Démarrer Claude</button>
                    <button className="btn" onClick={() => newTab(project.id, 'shell')}>{Icons.terminal(14)} Shell</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </Island>}
        bottom={<SessionBlock project={project} collapsed={sessionCollapsed} onCollapse={setSessionCollapsed} />}
      />
    </div>
  )
}
