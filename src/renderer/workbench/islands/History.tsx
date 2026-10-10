import { useEffect, useState } from 'react'
import type { SessionInfo } from '@shared/ipc'
import { Icons } from '../icons'
import { Island, Empty } from '../Island'
import { useWorkbench, useActiveProject } from '@/stores/workbench'
import { t } from '@/i18n'

/** Past Claude sessions (this project or all), resume in a new Claude tab, open the transcript, delete. */
export function HistoryIsland({ scope }: { scope: 'project' | 'all' }) {
  const project = useActiveProject()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [q, setQ] = useState('')
  const { newTab, openFile } = useWorkbench()
  const root = project?.root ?? null
  const reload = () => (scope === 'project' && root ? window.ct.claude.sessions(root) : window.ct.claude.allSessions()).then(setSessions)
  useEffect(() => { reload() }, [scope, root, project?.tabs.length])
  const home = window.ct.home
  const short = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p)
  const fmt = (ms: number) => { const d = new Date(ms); return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) }
  const shown = sessions.filter((s) => !q || [s.title, s.projectPath, s.tabName ?? ''].some((x) => x.toLowerCase().includes(q.toLowerCase())))
  const resume = (s: SessionInfo) => project && newTab(project.id, 'claude', s.projectPath || undefined, s.id)
  return (
    <Island title={scope === 'project' ? t('Historique du projet') : t('Historique')} icon={Icons.clock(14)} grow>
      <div className="search"><input placeholder={t('filtrer…')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {shown.length === 0 ? <Empty>{t('Aucune session')}</Empty> : (
        <div className="list">
          {shown.map((s) => (
            <div key={s.path} className="lrow" title={s.path} onDoubleClick={() => resume(s)}>
              <span className="ico">{Icons.claude(12)}</span>
              <div className="lbody">
                <div className="head">{s.tabName && <TabName name={s.tabName} />}<span className="name">{s.title}</span></div>
                <div className="desc">{fmt(s.modified)}{s.messageCount ? ` · ${s.messageCount} msg` : ''}{s.gitBranch ? ` · ${s.gitBranch}` : ''}{scope === 'all' && s.projectPath ? ` · ${short(s.projectPath)}` : ''}</div>
              </div>
              <span className="acts">
                <button title={t('Reprendre dans un onglet Claude')} onClick={() => resume(s)}>{Icons.terminal(12)}</button>
                <button title={t('Ouvrir le transcript')} onClick={() => project && openFile(project.id, s.path)}>{Icons.file(12)}</button>
                <button title={t('Supprimer (corbeille)')} onClick={async () => { if (confirm(t('Supprimer la session « {title} » ?', { title: s.title }))) { await window.ct.claude.deleteSession(s); reload() } }}>{Icons.x(12)}</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Island>
  )
}

/** The name of the tab a session ran in, before its title. */
function TabName({ name }: { name: string }) {
  return <span className="badge tabname" title={t("Nom de l'onglet où la session a tourné")}>{Icons.claude(10)}{name}</span>
}
