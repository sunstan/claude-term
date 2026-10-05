import { useEffect, useState } from 'react'
import type { SkillInfo } from '@shared/ipc'
import { Icons } from '../icons'
import { Island, Empty } from '../Island'
import { MenuButton } from '../Menu'
import { useWorkbench } from '@/stores/workbench'
import { t } from '@/i18n'

const modeLabel = (s: SkillInfo) => (s.manualOnly || s.isCommand ? t('manuel') : s.autoOnly ? t('auto') : 'auto + /')
/** the explorer's drags carry their paths under this type */
const TREE_PATHS = 'application/x-claudeterm-paths'

/**
 * A list of skills with open / insert / delete. `createIn` (project root or null = personal) enables creation and
 * import (a .md file or a skill folder, picked or dropped on the list); `copyTo` offers to copy each skill there.
 * `root`: the project the listed skills belong to (null: personal or plugins).
 */
export function SkillsIsland({ title, load, root, createIn, copyTo, collapsed, onCollapse, grow }: {
  title: string; load: () => Promise<SkillInfo[]>; root: string | null; createIn?: string | null
  copyTo?: { root: string | null; label: string }
  collapsed?: boolean; onCollapse?: (c: boolean) => void; grow?: boolean
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const { openFile, insertPrompt, activeProjectId } = useWorkbench()
  const reload = () => load().then(setSkills)
  useEffect(() => { reload() }, [root])
  useEffect(() => { if (!notice && !error) return; const id = setTimeout(() => { setNotice(null); if (!creating) setError(null) }, 5000); return () => clearTimeout(id) }, [notice, error])
  const create = async () => {
    const r = await window.ct.skills.create(name.trim(), desc.trim(), createIn ?? null)
    if (!r.ok) { setError(r.error ?? 'erreur'); return }
    setCreating(false); setName(''); setDesc(''); setError(null); reload()
    if (r.path && activeProjectId) openFile(activeProjectId, r.path)
  }
  const importFrom = async (o: { path?: string; pick?: 'file' | 'folder' }) => {
    if (createIn === undefined) return
    const r = await window.ct.skills.import(createIn, o)
    if (r.canceled) return
    if (!r.ok) { setError(r.error ?? 'erreur'); return }
    setError(null); reload()
    if (r.path && activeProjectId) openFile(activeProjectId, r.path)
  }
  const copy = async (s: SkillInfo) => {
    if (!copyTo) return
    const r = await window.ct.skills.copy(s, copyTo.root, root)
    if (!r.ok) { setError(r.error ?? 'erreur'); return }
    setError(null); setNotice(t('« {name} » copié', { name: s.name }))
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDropping(false)
    const fromTree = e.dataTransfer.getData(TREE_PATHS)
    const paths: string[] = fromTree ? JSON.parse(fromTree) : Array.from(e.dataTransfer.files).map((f) => window.ct.attachments.pathForFile(f)).filter((p): p is string => !!p)
    for (const p of paths) await importFrom({ path: p })
  }
  const canDrop = (e: React.DragEvent) => createIn !== undefined && (e.dataTransfer.types.includes(TREE_PATHS) || e.dataTransfer.types.includes('Files'))
  const actions = createIn !== undefined ? (
    <>
      <MenuButton title={t('Importer un skill')} items={[
        { label: t('Importer un fichier .md…'), icon: Icons.file(13), onSelect: () => importFrom({ pick: 'file' }) },
        { label: t('Importer un dossier de skill…'), icon: Icons.folder(13), onSelect: () => importFrom({ pick: 'folder' }) },
      ]}>{Icons.download()}</MenuButton>
      <button title={t('Nouveau skill')} onClick={() => setCreating(!creating)}>{Icons.plus()}</button>
    </>
  ) : undefined
  return (
    <Island title={title} icon={Icons.sparkle(14)} actions={actions} collapsible={!!onCollapse} collapsed={collapsed} onCollapse={onCollapse} grow={grow}>
      <div className={'skills-drop' + (dropping ? ' drop' : '')}
        onDragOver={(e) => { if (!canDrop(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dropping) setDropping(true) }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false) }}
        onDrop={(e) => { if (canDrop(e)) onDrop(e) }}>
        {creating && (
          <div className="form">
            <input placeholder={t('nom (minuscules-tirets)')} value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder={t('description : quand Claude doit l\'utiliser')} value={desc} onChange={(e) => setDesc(e.target.value)} />
            {error && <div className="error">{error}</div>}
            <div className="row-actions"><button className="btn primary" disabled={!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)} onClick={create}>{t('Créer')}</button><button className="btn" onClick={() => setCreating(false)}>{t('Annuler')}</button></div>
          </div>
        )}
        {!creating && (error || notice) && <div className={error ? 'tree-error' : 'skills-notice'}>{error ?? notice}</div>}
        {skills.length === 0 && !creating ? <Empty>{root ? t('Aucun skill. Ils vivent dans .claude/skills/<nom>/SKILL.md.') : t('Aucun skill')}</Empty> : (
          <div className="list">
            {skills.map((s) => (
              <div key={s.path} className="lrow" onDoubleClick={() => activeProjectId && openFile(activeProjectId, s.path)} title={s.path}>
                <span className="ico" style={{ color: 'var(--ct-accent)' }}>{Icons.sparkle(12)}</span>
                <div className="lbody">
                  <div className="head"><span className="name">/{s.name}</span><span className="badge dim">{modeLabel(s)}</span>{s.source === 'linked' && <span className="badge dim">{t('lié')}</span>}</div>
                  {s.description && <div className="desc">{s.description}</div>}
                </div>
                <span className="acts">
                  {!s.autoOnly && <button title={t('Insérer /nom dans le prompt')} onClick={() => activeProjectId && insertPrompt(activeProjectId, `/${s.name} `)}>{Icons.terminal(12)}</button>}
                  {copyTo && <button title={copyTo.label} onClick={() => copy(s)}>{Icons.copy(12)}</button>}
                  {s.source !== 'plugin' && <button title={t('Supprimer')} onClick={async () => { if (confirm(t('Supprimer le skill « {name} » ?', { name: s.name }))) { await window.ct.skills.remove(s); reload() } }}>{Icons.x(12)}</button>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Island>
  )
}
