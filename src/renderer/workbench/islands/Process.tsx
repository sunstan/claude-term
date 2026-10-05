import { useEffect, useState } from 'react'
import type { ClaudeProcess } from '@shared/ipc'
import { Icons } from '../icons'
import { Island, Empty } from '../Island'
import { useWorkbench, isClaude } from '@/stores/workbench'
import { t } from '@/i18n'

/** Running claude processes on this machine, matched to tabs by cwd. */
export function ProcessIsland() {
  const [procs, setProcs] = useState<ClaudeProcess[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const { projects, setActiveProject, setCurrentTab } = useWorkbench()
  const home = window.ct.home
  const short = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p)
  useEffect(() => {
    let live = true
    const tick = () => window.ct.processes.scan().then((r) => { if (live) setProcs(r) })
    tick()
    const id = setInterval(tick, 2500)
    return () => { live = false; clearInterval(id) }
  }, [])
  // the terminal it runs in (its parents), else a Claude tab with the same folder
  const tabOf = (p: ClaudeProcess) => {
    if (p.ptyId) for (const pr of projects) for (const t of pr.tabs) if (t.ptyId === p.ptyId) return { pr, t }
    for (const pr of projects) for (const t of pr.tabs) if (isClaude(t) && t.cwd === p.cwd) return { pr, t }
    return null
  }
  return (
    <Island title={t('Process Claude')} icon={Icons.cpu(14)} grow actions={<span className="muted" style={{ fontWeight: 400, textTransform: 'none' }}>{procs.length}</span>}>
      {procs.length === 0 ? <Empty>{t('Aucun process claude en cours')}</Empty> : (
        <div className="list">
          {procs.map((p) => {
            const tab = tabOf(p)
            // Windows gives no cwd: the tab's folder, else the arguments (without the program's path) on their own line
            const where = p.cwd !== '?' ? short(p.cwd) : tab ? short(tab.t.cwd) : ''
            const name = where ? where.split(/[\\/]/).filter(Boolean).pop() || where : 'claude'
            const args = !where && p.command ? p.command.replace(/^("[^"]*"|\S+)\s*/, '') : ''
            return (
              <div key={p.pid}>
                <div className="lrow" onClick={() => setOpen(open === p.pid ? null : p.pid)}>
                  <span className="ico">{Icons.claude(12)}</span>
                  <div className="lbody">
                    <div className="head"><span className="name">{name}</span><span className="badge dim">PID {p.pid}</span><span className="badge dim">{tab ? t('cet onglet') : t('lancé ailleurs')}</span></div>
                    <div className="desc" title={p.command}>{[where, p.elapsed, p.cpu ? `${p.cpu}%` : '', `${p.memMB} Mo`, p.children.length ? `${p.children.length} ${t('sous-process')}` : ''].filter(Boolean).join(' · ')}</div>
                    {args && <div className="desc" title={p.command} style={{ fontFamily: 'var(--ct-font-mono)', fontSize: 10.5 }}>{args}</div>}
                  </div>
                  <span className="acts">
                    {tab && <button title={t('Aller à l\'onglet')} onClick={(e) => { e.stopPropagation(); setActiveProject(tab.pr.id); setCurrentTab(tab.pr.id, tab.t.id) }}>{Icons.terminal(12)}</button>}
                    <button title={t('Arrêter (SIGTERM)')} onClick={(e) => { e.stopPropagation(); if (confirm(t('Arrêter le process {pid} ?', { pid: p.pid }))) window.ct.processes.kill(p.pid) }}>{Icons.x(12)}</button>
                  </span>
                </div>
                {open === p.pid && p.children.map((c) => <div key={c.pid} className="desc" style={{ padding: '1px 10px 1px 34px', fontFamily: 'var(--ct-font-mono)', fontSize: 10.5 }}>{[c.pid, c.cpu ? `${c.cpu}%` : '', c.command].filter(Boolean).join(' · ')}</div>)}
              </div>
            )
          })}
        </div>
      )}
    </Island>
  )
}
