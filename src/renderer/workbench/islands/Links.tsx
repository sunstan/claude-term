import { useEffect, useState } from 'react'
import type { LinkedProject } from '@shared/ipc'
import { Icons } from '../icons'
import { Island, Empty } from '../Island'
import { FileTree } from '../FileTree'
import { useWorkbench, type Project } from '@/stores/workbench'
import { t } from '@/i18n'
import { Decorations } from '../Decorations'

/** Linked folders island: list with roles and read-only flag, each expandable into its own tree. */
export function LinksIsland({ project, collapsed, onCollapse }: { project: Project; collapsed: boolean; onCollapse: (c: boolean) => void }) {
  const root = project.root!
  const settings = useWorkbench((s) => s.settings)!
  const [links, setLinks] = useState<LinkedProject[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => { window.ct.links.load(root).then(setLinks) }, [root])
  const save = async (next: LinkedProject[]) => {
    setLinks(next)
    const r = await window.ct.links.save(root, next)
    setError(r.ok ? null : r.error ?? 'erreur')
  }
  const add = (path: string) => { if (!links.some((l) => l.path === path) && path !== root) save([...links, { path, role: '', readOnly: false }]) }
  const candidates = settings.recentProjects.filter((d) => d !== root && !links.some((l) => l.path === d))
  const actions = (
    <>
      <button title={t('Rôles et accès')} onClick={() => setEditing(!editing)} style={{ opacity: links.length ? 1 : 0.4 }}>{Icons.list()}</button>
      <button title={t('Lier un dossier…')} onClick={async () => { const d = await window.ct.app.pickFolder(); if (d) add(d) }}>{Icons.plus()}</button>
    </>
  )
  return (
    <Island title={t('Dossiers liés')} icon={Icons.link(14)} actions={actions} collapsible collapsed={collapsed} onCollapse={onCollapse}>
      {error && <div className="error" style={{ padding: '6px 10px' }}>{error}</div>}
      {editing && links.length > 0 && (
        <div className="links-editor">
          <div className="hint">{t("Gardé dans les données de l'app, rien n'est écrit dans le projet. Donné à Claude au lancement (nouvelles sessions).")}</div>
          {links.map((l) => (
            <div key={l.path} className="link-edit">
              <div className="name">{l.path.split(/[\\/]/).pop()}</div>
              <input placeholder={t('rôle (API, design system…)')} value={l.role} onChange={(e) => save(links.map((x) => (x.path === l.path ? { ...x, role: e.target.value } : x)))} />
              <label className="check"><input type="checkbox" checked={l.readOnly} onChange={(e) => save(links.map((x) => (x.path === l.path ? { ...x, readOnly: e.target.checked } : x)))} /> {t('lecture seule')}</label>
              <button className="linkbtn" onClick={() => save(links.filter((x) => x.path !== l.path))}>{t('Retirer')}</button>
            </div>
          ))}
        </div>
      )}
      {links.length === 0 ? (
        <div className="links-empty">
          <Empty>{t('Lie l\'API, le design system… Claude y aura accès sans qu\'on lui dise.')}</Empty>
          {candidates.length > 0 && <div className="plan-pick"><div className="hint">{t('Récents :')}</div>{candidates.slice(0, 6).map((d) => <button key={d} className="linkbtn" onClick={() => add(d)}>{d.split(/[\\/]/).pop()}</button>)}</div>}
        </div>
      ) : (
        <div className="tree">
          {links.map((l) => (
            <div key={l.path}>
              <div className={'row dir' + (expanded === l.path ? ' sel' : '')} onClick={() => setExpanded(expanded === l.path ? null : l.path)} title={l.path}>
                <span className={'chev' + (expanded === l.path ? ' open' : '')}>{Icons.chevron(10)}</span>
                <span className="ico">{Icons.link(13)}</span>
                <span>{l.path.split(/[\\/]/).pop()}</span>
                {l.role && <span className="muted" style={{ marginLeft: 4 }}>{l.role}</span>}
                <Decorations root={l.path} />
                {l.readOnly && <span className="badge" style={{ marginLeft: 'auto', background: 'var(--ct-hover-bg)', color: 'var(--ct-text-secondary)' }}>ro</span>}
              </div>
              {expanded === l.path && <div style={{ paddingLeft: 8 }}><FileTree project={project} root={l.path} /></div>}
            </div>
          ))}
        </div>
      )}
    </Island>
  )
}
