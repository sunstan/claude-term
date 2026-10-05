import { useEffect, useState } from 'react'
import type { MCPServer } from '@shared/ipc'
import { Icons } from '../icons'
import { Island, Empty } from '../Island'
import { useWorkbench } from '@/stores/workbench'
import { t } from '@/i18n'
import { MASK } from '@shared/mcp-secrets'

const empty = (): MCPServer => ({ name: '', transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, scope: 'project', sourcePath: '', disabled: false })
const summary = (s: MCPServer) => (s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url)

/** MCP servers of the project (.mcp.json, editable) or of the user (`claude mcp`, read + add/remove). */
export function McpIsland({ scope, root, collapsed, onCollapse, grow }: { scope: 'project' | 'user'; root: string | null; collapsed?: boolean; onCollapse?: (c: boolean) => void; grow?: boolean }) {
  const [servers, setServers] = useState<MCPServer[]>([])
  const [health, setHealth] = useState<Record<string, string>>({})
  const [checking, setChecking] = useState(false)
  const [editing, setEditing] = useState<{ s: MCPServer; replacing?: string } | null>(null)
  const [library, setLibrary] = useState<(MCPServer & { detail: string })[]>([])
  const [error, setError] = useState<string | null>(null)
  const insertPrompt = useWorkbench((s) => s.insertPrompt)
  const activeProjectId = useWorkbench((s) => s.activeProjectId)
  const reload = async () => {
    if (scope === 'project') setServers(root ? [...(await window.ct.mcp.project(root)), ...(await window.ct.mcp.linked(root))] : [])
    else setServers([...(await window.ct.mcp.user()), ...(root ? await window.ct.mcp.local(root) : [])])
  }
  useEffect(() => { reload(); if (scope === 'project') window.ct.mcp.library(root).then(setLibrary) }, [root, scope])
  const check = async () => { setChecking(true); setHealth(await window.ct.mcp.health(root)); setChecking(false) }
  const save = async () => {
    if (!editing) return
    const s = editing.s
    if (scope === 'project' && root) {
      const r = await window.ct.mcp.write(s, root, editing.replacing)
      if (!r.ok) { setError(r.error ?? 'erreur'); return }
    } else {
      const r = await window.ct.mcp.addUser(s, root)
      if (r.code !== 0) { setError(r.output.trim() || 'erreur'); return }
    }
    setEditing(null); setError(null); reload()
  }
  const remove = async (s: MCPServer) => {
    if (!confirm(t('Retirer le serveur « {name} » ?', { name: s.name }))) return
    if (s.scope === 'project' && root) await window.ct.mcp.remove(s.name, root)
    else if (s.scope === 'user' || s.scope === 'local') await window.ct.mcp.cli(['remove', '-s', s.scope, s.name], root)
    reload()
  }
  const actions = (
    <>
      <button title={t('Vérifier l\'état')} onClick={check}>{checking ? <span className="spin" /> : Icons.activity()}</button>
      {(scope === 'user' || root) && <button title={t('Ajouter')} onClick={() => setEditing({ s: empty() })}>{Icons.plus()}</button>}
    </>
  )
  const dot = (s: MCPServer) => { const h = health[s.name]; return h ? <span className="dot" style={{ background: h === 'connected' ? 'var(--ct-badge-ok)' : h === 'needsAuth' ? 'var(--ct-badge-warn)' : 'var(--ct-badge-error)' }} title={h} /> : null }
  return (
    <Island title={scope === 'project' ? t('MCP du projet') : t('MCP perso')} icon={Icons.plug(14)} actions={actions} collapsible={!!onCollapse} collapsed={collapsed} onCollapse={onCollapse} grow={grow}>
      {editing && (
        <div className="form">
          <div className="row-actions">
            <input placeholder={t('nom')} value={editing.s.name} onChange={(e) => setEditing({ ...editing, s: { ...editing.s, name: e.target.value } })} style={{ flex: 1 }} />
            <select value={editing.s.transport} onChange={(e) => setEditing({ ...editing, s: { ...editing.s, transport: e.target.value as MCPServer['transport'] } })}>
              <option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option>
            </select>
          </div>
          {editing.s.transport === 'stdio' ? (
            <input placeholder={t('commande et arguments (npx -y @x/server …)')} value={[editing.s.command, ...editing.s.args].join(' ')} onChange={(e) => { const [c = '', ...a] = e.target.value.split(/\s+/); setEditing({ ...editing, s: { ...editing.s, command: c, args: a.filter(Boolean) } }) }} />
          ) : (
            <input placeholder="https://…/mcp" value={editing.s.url} onChange={(e) => setEditing({ ...editing, s: { ...editing.s, url: e.target.value } })} />
          )}
          <input placeholder={editing.s.transport === 'stdio' ? t('env : KEY=value, autre=…') : t('headers : Authorization=Bearer …')} value={Object.entries(editing.s.transport === 'stdio' ? editing.s.env : editing.s.headers).map(([k, v]) => `${k}=${v}`).join(', ')}
            onChange={(e) => { const o: Record<string, string> = {}; for (const kv of e.target.value.split(',')) { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim() } setEditing({ ...editing, s: editing.s.transport === 'stdio' ? { ...editing.s, env: o } : { ...editing.s, headers: o } }) }} />
          {scope === 'project' && !editing.replacing && library.length > 0 && (
            // the copy keeps its source (ref): main takes its masked values from there
            <select value="" onChange={(e) => { const l = library[+e.target.value]; if (l) { const { detail: _d, ...server } = l; setEditing({ s: { ...server, scope: 'project', sourcePath: '' } }) } }}>
              <option value="">{t('Copier depuis un autre projet…')}</option>
              {library.map((l, i) => <option key={i} value={i}>{l.name} — {l.detail}</option>)}
            </select>
          )}
          {!!editing.s.secrets && <div className="hint">{t('{n} valeur(s) secrète(s) masquée(s) : laisse {mask} pour la garder, tape une nouvelle valeur pour la changer.', { n: editing.s.secrets, mask: MASK })}</div>}
          {error && <div className="error">{error}</div>}
          <div className="row-actions"><button className="btn primary" disabled={!editing.s.name.trim() || (editing.s.transport === 'stdio' ? !editing.s.command : !editing.s.url)} onClick={save}>{editing.replacing ? t('Enregistrer') : t('Ajouter')}</button><button className="btn" onClick={() => { setEditing(null); setError(null) }}>{t('Annuler')}</button></div>
        </div>
      )}
      {servers.length === 0 && !editing ? <Empty>{scope === 'project' ? t('Aucun serveur dans .mcp.json') : t('Aucun serveur perso')}</Empty> : (
        <div className="list">
          {servers.map((s) => (
            <div key={s.scope + s.name + s.sourcePath} className="lrow" title={s.sourcePath} style={{ opacity: s.disabled ? 0.5 : 1 }}>
              <span className="ico" style={{ color: 'var(--ct-badge-info)' }}>{Icons.plug(12)}</span>
              <div className="lbody">
                <div className="head">{dot(s)}<span className="name">{s.name}</span><span className="badge dim">{s.transport}</span>{s.scope !== 'project' && s.scope !== 'user' && <span className="badge dim">{s.scope === 'linked' ? t('lié') : s.scope}</span>}{s.disabled && <span className="badge dim">{t('désactivé')}</span>}</div>
                <div className="desc">{summary(s)}</div>
              </div>
              <span className="acts">
                {health[s.name] === 'needsAuth' && <button title={t('Ouvrir /mcp dans Claude pour s\'authentifier')} onClick={() => activeProjectId && insertPrompt(activeProjectId, '/mcp')}>{Icons.terminal(12)}</button>}
                {(s.scope === 'project' || s.scope === 'linked') && <button title={t('Modifier')} onClick={() => setEditing({ s: { ...s }, replacing: s.name })}>{Icons.list(12)}</button>}
                {(s.scope === 'project' || s.scope === 'user' || s.scope === 'local') && <button title={t('Retirer')} onClick={() => remove(s)}>{Icons.x(12)}</button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Island>
  )
}
