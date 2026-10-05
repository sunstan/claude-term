import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icons } from './icons'
import { FileIcon } from './FileIcon'
import { useWorkbench } from '@/stores/workbench'
import { usePlugins } from '@/stores/plugins'
import { usePalette } from '@/stores/palette'
import { runAppAction } from '@/actions'
import { ACTIONS, binding, label as keyLabel } from '@shared/keymap'
import { joinPath } from '@shared/claude-format'
import { paletteInput, rank, PALETTE_PREFIXES, type PaletteMode } from '@shared/palette'
import type { SessionInfo, SkillInfo } from '@shared/ipc'
import { t } from '@/i18n'

interface Item { key: string; icon: ReactNode; label: string; detail?: string; hint?: string; run: () => void }

const RIGHT = [
  { id: 'claude', title: 'Claude : usage, version, artifacts' }, { id: 'process', title: 'Process Claude' },
  { id: 'history', title: 'Historique (toutes les sessions)' }, { id: 'skills', title: 'Skills perso et plugins' },
]
const MODES: Record<PaletteMode, string> = { files: 'Fichiers du projet', commands: 'Commandes', sessions: 'Sessions Claude', skills: 'Skills et commandes /' }

/** Command palette: files, `>` commands, `@` sessions, `/` skills; ↑ ↓ to move, Enter to run, Esc to close. */
export function Palette() {
  const initial = usePalette((s) => s.text)
  if (initial === null) return null
  return <PaletteModal initial={initial} />
}

function PaletteModal({ initial }: { initial: string }) {
  const close = usePalette((s) => s.close)
  const [text, setText] = useState(initial)
  const [sel, setSel] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const st = useWorkbench()
  const project = st.projects.find((p) => p.id === st.activeProjectId)
  const root = project?.root ?? null
  const mac = window.ct.platform === 'darwin'
  const { mode, query } = paletteInput(text)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); const n = initial.length; input.current?.setSelectionRange(n, n) }, [])
  useEffect(() => { setSel(0) }, [text])
  useEffect(() => {
    if (mode !== 'files' || !root || !query) { setFiles([]); return }
    let live = true
    const timer = setTimeout(() => window.ct.search.files(root, query).then((r) => { if (live) setFiles(r) }), 80)
    return () => { live = false; clearTimeout(timer) }
  }, [mode, query, root])
  useEffect(() => { if (mode === 'sessions' && !sessions) window.ct.claude.allSessions().then(setSessions) }, [mode])
  useEffect(() => {
    if (mode !== 'skills' || skills) return
    Promise.all([root ? window.ct.skills.project(root) : [], root ? window.ct.skills.linked(root) : [], window.ct.skills.personal(), window.ct.skills.plugins()])
      .then((all) => setSkills(all.flat()))
  }, [mode])

  const run = (f: () => void) => { close(); f() }
  const items: Item[] = useMemo(() => {
    if (mode === 'commands') {
      const kb = st.settings?.keybindings ?? {}, preset = st.settings?.keymapPreset
      const actions: Item[] = ACTIONS.filter((a) => a.scope === 'general').map((a) => {
        const k = binding(a.id, kb, preset, mac)
        return { key: a.id, icon: Icons.play(13), label: t(a.label), hint: k ? keyLabel(k, mac) : undefined, run: () => runAppAction(a.id) }
      })
      const right: Item[] = RIGHT.map((r) => ({ key: 'right:' + r.id, icon: Icons.columns(13), label: t(r.title), run: () => st.setRight(st.rightActivity === r.id ? null : r.id) }))
      const plug = usePlugins.getState()
      const plugins: Item[] = [...plug.activities('left').map((a) => ({ a, side: 'left' as const })), ...plug.activities('right').map((a) => ({ a, side: 'right' as const }))]
        .map(({ a, side }) => ({ key: 'plugin:' + a.id, icon: Icons.puzzle(13), label: a.title, detail: t('panneau'), run: () => (side === 'left' ? st.setLeft(a.id) : st.setRight(a.id)) }))
      return rank([...actions, ...right, ...plugins], (x) => x.label, query)
    }
    if (mode === 'sessions') {
      return rank(sessions ?? [], (s) => `${s.title} ${s.projectPath.split(/[\\/]/).pop()}`, query, 60).map((s) => ({
        key: s.path, icon: Icons.claude(13), label: s.title || t('(sans titre)'),
        detail: [s.projectPath.split(/[\\/]/).filter(Boolean).pop(), s.gitBranch, new Date(s.modified).toLocaleDateString()].filter(Boolean).join(' · '),
        run: () => { if (project) st.newTab(project.id, 'claude', s.projectPath || undefined, s.id) },
      }))
    }
    if (mode === 'skills') {
      return rank(skills ?? [], (s) => `${s.name} ${s.description}`, query).map((s) => ({
        key: s.path, icon: Icons.sparkle(13), label: '/' + s.name, detail: s.description,
        run: () => { if (project) st.insertPrompt(project.id, '/' + s.name + ' ') },
      }))
    }
    return files.map((r) => ({
      key: r, icon: <FileIcon path={r} size={14} />, label: r.split('/').pop() ?? r, detail: r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : undefined,
      run: () => { if (project && root) st.openFile(project.id, joinPath(root, r.split('/'))) },
    }))
  }, [mode, query, files, sessions, skills, st.settings, st.rightActivity, project?.id, root])

  const pick = (i: number) => { const it = items[i]; if (it) run(it.run) }
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="palette" role="dialog" aria-label={t('Palette de commandes')}>
        <input ref={input} value={text} spellCheck={false} placeholder={t('Fichier, ou > commande, @ session, / skill')} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); pick(sel) }
          }} />
        <div className="palette-mode muted">{t(MODES[mode])}</div>
        <div className="palette-list">
          {items.map((it, i) => (
            <div key={it.key} className={'palette-item' + (i === sel ? ' sel' : '')} onMouseMove={() => i !== sel && setSel(i)} onClick={() => pick(i)}>
              <span className="ico">{it.icon}</span>
              <span className="label">{it.label}</span>
              {it.detail && <span className="detail">{it.detail}</span>}
              {it.hint && <span className="hint">{it.hint}</span>}
            </div>
          ))}
          {!items.length && (mode !== 'files' || query) && <div className="palette-empty muted">{t('Aucun résultat')}</div>}
          {mode === 'files' && !query && (
            <div className="palette-help">
              {PALETTE_PREFIXES.map((p) => (
                <button key={p.prefix} className="palette-item" onClick={() => { setText(p.prefix); input.current?.focus() }}>
                  <span className="ico prefix">{p.prefix}</span><span className="label">{t(MODES[p.mode])}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
