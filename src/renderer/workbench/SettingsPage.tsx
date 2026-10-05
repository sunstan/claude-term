import { useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_REGISTRY } from '@shared/plugin-registry'
import { useUpdate } from '@/stores/update'
import type { UpdateState } from '@shared/update'
import type { ThemeSpec } from '@shared/theme'
import { Icons } from './icons'
import { t } from '@/i18n'
import { useWorkbench } from '@/stores/workbench'
import { installedMonoFonts } from './fonts'
import { ClaudeCodeSettings } from './ClaudeCodeSettings'
import { ACTIONS, binding, conflicts, defaultBinding, fromEvent, label as keyLabel } from '@shared/keymap'

type Section = 'general' | 'apparence' | 'editeur' | 'raccourcis' | 'terminal' | 'claude' | 'notifications' | 'plugins' | 'windows'

/** App settings modal: sections on the left, grouped blocks of rows on the right. */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const settings = useWorkbench((s) => s.settings)!
  const [section, setSection] = useState<Section>('general')
  const update = useUpdate((s) => s.state)
  const [themes, setThemes] = useState<ThemeSpec[]>([])
  const [fonts, setFonts] = useState<string[]>([])
  const [hooks, setHooks] = useState<boolean | null>(null)
  const [hookError, setHookError] = useState<string | null>(null)
  useEffect(() => { window.ct.themes.list().then(setThemes); window.ct.claude.hooksInstalled().then(setHooks); installedMonoFonts().then(setFonts) }, [])
  const set = (patch: Parameters<typeof window.ct.settings.set>[0]) => window.ct.settings.set(patch)
  const toggleHooks = async (on: boolean) => {
    const r = await window.ct.setHooks(on)
    if (r.ok) { setHooks(on); setHookError(null) } else setHookError(r.error ?? 'erreur')
  }
  const sections: { id: Section; label: string }[] = [
    { id: 'general', label: t('Général') }, { id: 'apparence', label: t('Apparence') }, { id: 'editeur', label: t('Éditeur') }, { id: 'raccourcis', label: t('Raccourcis') },
    { id: 'terminal', label: t('Terminal') }, { id: 'claude', label: t('Claude Code') }, { id: 'notifications', label: t('Notifications') }, { id: 'plugins', label: t('Plugins') },
    ...(window.ct.platform === 'win32' ? [{ id: 'windows' as Section, label: t('Windows') }] : []),
  ]
  const fontSelect = (value: string, onChange: (v: string) => void) => (
    <select value={fonts.includes(value) || value === '' ? value : '__custom'} onChange={(e) => onChange(e.target.value === '__custom' ? value : e.target.value)}>
      <option value="">{t('par défaut')}</option>
      {fonts.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
      {value && !fonts.includes(value) && <option value="__custom">{value}</option>}
    </select>
  )
  const num = (value: number, min: number, max: number, unit: string, onChange: (v: number) => void) => (
    <span className="unit-row"><input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, +e.target.value || min)))} /><span className="unit">{unit}</span></span>
  )
  return (
    <div className="island grow settings">
      <div className="hdr"><span>{t('Réglages')}</span><span className="spacer" /><button onClick={onClose} title={t('Fermer')}>{Icons.x()}</button></div>
      <div className="content settings-body">
        <div className="settings-nav">
          {sections.map((s) => <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setSection(s.id)}>{s.label}</button>)}
        </div>
        <div className="settings-form">
          {section === 'general' && (
            <>
            <Group title={t('Mises à jour')}>
              <Row label={t('Version {v}', { v: update.current ?? '' })} hint={updateText(update)}>
                {update.status === 'ready'
                  ? <button className="btn primary" onClick={() => window.ct.update.install()}>{t('Redémarrer et installer')}</button>
                  : <button className="btn" disabled={update.status === 'unsupported' || update.status === 'checking' || update.status === 'downloading'} onClick={() => window.ct.update.check()}>{update.status === 'checking' ? <span className="spin" /> : t('Rechercher')}</button>}
              </Row>
              <Row label={t('Automatiques')} hint={t('Au démarrage puis toutes les 6 h ; le téléchargement se fait en arrière-plan.')}><Toggle checked={settings.autoUpdate} onChange={(v) => set({ autoUpdate: v })} /></Row>
            </Group>
            <Group title={t('Langue')}>
              <Row label={t('Langue de l\'interface')} hint={t('Système = celle de macOS / Windows.')}>
                <select value={settings.language} onChange={(e) => set({ language: e.target.value as 'system' | 'fr' | 'en' })}>
                  <option value="system">{t('Système')}</option><option value="fr">Français</option><option value="en">English</option>
                </select>
              </Row>
            </Group>
            </>
          )}
          {section === 'apparence' && (
            <Group title={t('Thème')}>
              <Row label={t('Thème')} hint={t("Système : sombre ou clair selon l'apparence de l'OS.")}>
                <select value={settings.themeFollowSystem ? 'system' : settings.themeFixed}
                  onChange={(e) => e.target.value === 'system' ? set({ themeFollowSystem: true }) : set({ themeFollowSystem: false, themeFixed: e.target.value })}>
                  <option value="system">{t('Suivre le système')}</option>
                  {themes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </Row>
              <Row label={t('Thèmes perso')} hint={t("Dépose un thème VS Code (.json) dans le dossier des thèmes de l'app ; il apparaît ici au prochain lancement.")} />
            </Group>
          )}
          {section === 'editeur' && (
            <>
              <Group title={t('Police')}>
                <Row label={t('Police')}>{fontSelect(settings.editorFontFamily, (v) => set({ editorFontFamily: v }))}</Row>
                <Row label={t('Taille')}>{num(settings.editorFontSize, 9, 28, 'pt', (v) => set({ editorFontSize: v }))}</Row>
                <Row label={t('Interligne')} hint={t('0 = automatique.')}>{num(settings.editorLineHeight, 0, 48, 'px', (v) => set({ editorLineHeight: v }))}</Row>
              </Group>
              <Group title={t('Affichage')}>
                <Row label={t('Retour à la ligne')} hint={t('Replier les lignes longues')}><Toggle checked={settings.editorWordWrap} onChange={(v) => set({ editorWordWrap: v })} /></Row>
                <Row label={t('Minimap')}><Toggle checked={settings.editorMinimap} onChange={(v) => set({ editorMinimap: v })} /></Row>
              </Group>
              <Group title={t('Enregistrement')}>
                <Row label={t("Reformater à l'enregistrement")} hint={t('Indentation et mise en forme avant chaque écriture (JSON, JS/TS, CSS, HTML…).')}>
                  <Toggle checked={settings.formatOnSave} onChange={(v) => set({ formatOnSave: v })} />
                </Row>
                <Row label={t('Enregistrement automatique')} hint={t("Enregistre les fichiers modifiés quand l'éditeur perd le focus : changement d'onglet, clic dans le terminal, fenêtre en arrière-plan. Désactivé, ⌘S enregistre. Un fichier modifié sur le disque entre-temps n'est jamais écrasé automatiquement.")}>
                  <Toggle checked={settings.autoSave} onChange={(v) => set({ autoSave: v })} />
                </Row>
              </Group>
            </>
          )}
          {section === 'raccourcis' && <Shortcuts Group={Group} Row={Row} />}
          {section === 'terminal' && (
            <Group title={t('Police')}>
              <Row label={t('Police')}>{fontSelect(settings.fontFamily, (v) => set({ fontFamily: v }))}</Row>
              <Row label={t('Taille')}>{num(settings.fontSize, 9, 24, 'pt', (v) => set({ fontSize: v }))}</Row>
            </Group>
          )}
          {section === 'claude' && <ClaudeCodeSettings Group={Group} Row={Row} Toggle={Toggle} />}
          {section === 'notifications' && (
            <>
              <Group title={t('Hooks Claude Code')}>
                <Row label={t('Installer les hooks')} hint={t("Ajoute deux hooks (Notification, Stop) dans ~/.claude/settings.json qui signalent à ClaudeTerm les permissions en attente, les sessions inactives et les réponses terminées. Fonctionne aussi pour les sessions lancées hors de ClaudeTerm dans un dossier ouvert.")}>
                  <Toggle checked={hooks === true} disabled={hooks === null} onChange={toggleHooks} />
                  {hookError && <div className="error">{hookError}</div>}
                </Row>
              </Group>
              <Group title={t('Alertes')}>
                <Row label={t('Notifications système')} hint={t("Quand l'onglet n'est pas visible.")}><Toggle checked={settings.notifyOS} onChange={(v) => set({ notifyOS: v })} /></Row>
                {window.ct.platform === 'darwin' && <Row label={t('Badge du Dock')} hint={t("Nombre d'onglets en attente")}><Toggle checked={settings.dockBadge} onChange={(v) => set({ dockBadge: v })} /></Row>}
                {window.ct.platform !== 'darwin' && <Row label={t('Barre des tâches')} hint={window.ct.platform === 'win32' ? t("Nombre d'onglets en attente sur l'icône, qui clignote tant que la fenêtre n'est pas au premier plan") : t("L'icône clignote tant que la fenêtre n'est pas au premier plan")}><Toggle checked={settings.dockBadge} onChange={(v) => set({ dockBadge: v })} /></Row>}
              </Group>
            </>
          )}
          {section === 'plugins' && (
            <Group title={t('Catalogue')}>
              <Row label={t('Adresse du catalogue')} hint={t('registry.json listant les plugins installables (https, http://localhost ou file:).')}>
                <input key={settings.pluginRegistry} defaultValue={settings.pluginRegistry} spellCheck={false} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== settings.pluginRegistry) set({ pluginRegistry: v }) }} style={{ width: 320 }} />
              </Row>
              <Row label={t('Catalogue par défaut')}>
                <button className="btn" disabled={settings.pluginRegistry === DEFAULT_REGISTRY} onClick={() => set({ pluginRegistry: DEFAULT_REGISTRY })}>{t('Rétablir')}</button>
              </Row>
            </Group>
          )}
          {section === 'windows' && (
            <Group title={t('Claude Code')}>
              <Row label={t('Environnement')} hint={t('Où tourne claude : Windows natif, ou dans une distribution WSL (les shells et ~/.claude suivent).')}>
                <select value={settings.windowsMode} onChange={(e) => set({ windowsMode: e.target.value as 'native' | 'wsl' })}>
                  <option value="native">{t('Windows natif')}</option><option value="wsl">WSL</option>
                </select>
              </Row>
              {settings.windowsMode === 'wsl' && (
                <Row label={t('Distribution WSL')} hint={t('Vide = distribution par défaut.')}>
                  <input value={settings.wslDistro} placeholder="Ubuntu" onChange={(e) => set({ wslDistro: e.target.value })} style={{ width: 200 }} />
                </Row>
              )}
            </Group>
          )}
        </div>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <div className="sgroup"><div className="sgroup-title">{title}</div><div className="sgroup-body">{children}</div></div>
}

function Row({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="srow">
      <div className="slabel"><div>{label}</div>{hint && <div className="hint">{hint}</div>}</div>
      <div className="scontrol">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button className={'toggle' + (checked ? ' on' : '')} disabled={disabled} onClick={() => onChange(!checked)} role="switch" aria-checked={checked}><span /></button>
}


/** Keymap editor: click a shortcut, press the new combination (Escape cancels, Backspace clears). */
function Shortcuts({ Group, Row }: { Group: (p: { title: string; children: ReactNode }) => ReactNode; Row: (p: { label: string; hint?: string; children?: ReactNode }) => ReactNode }) {
  const settings = useWorkbench((s) => s.settings)!
  const kb = settings.keybindings ?? {}
  const preset = settings.keymapPreset ?? 'jetbrains'
  const mac = window.ct.platform === 'darwin'
  const [recording, setRecording] = useState<string | null>(null)
  const cf = conflicts(kb, preset, mac)
  const setKb = (next: Record<string, string>) => window.ct.settings.set({ keybindings: next })
  const onKey = (id: string, e: React.KeyboardEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (e.key === 'Escape') return setRecording(null)
    const combo = e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey ? '' : fromEvent(e.nativeEvent, mac)
    if (combo === null) return
    const def = defaultBinding(ACTIONS.find((a) => a.id === id)!, preset, mac)
    const next = { ...kb }; if (combo === def) delete next[id]; else next[id] = combo
    setKb(next); setRecording(null)
  }
  const group = (scope: 'general' | 'editor', title: string) => (
    <Group title={title}>
      {ACTIONS.filter((a) => a.scope === scope).map((a) => (
        <Row key={a.id} label={t(a.label)} hint={cf[a.id] ? t('En conflit avec : {x}', { x: cf[a.id].map((id) => t(ACTIONS.find((b) => b.id === id)!.label)).join(', ') }) : undefined}>
          <span className="unit-row">
            <button className={'key-recorder' + (recording === a.id ? ' on' : '') + (cf[a.id] ? ' conflict' : '')} onClick={() => setRecording(a.id)} onKeyDown={(e) => recording === a.id && onKey(a.id, e)} onBlur={() => setRecording(null)}>
              {recording === a.id ? t('Appuie sur les touches…') : keyLabel(binding(a.id, kb, preset, mac), mac)}
            </button>
            {kb[a.id] !== undefined && <button className="linkbtn" onClick={() => { const n = { ...kb }; delete n[a.id]; setKb(n) }}>{t('Rétablir')}</button>}
          </span>
        </Row>
      ))}
    </Group>
  )
  return (
    <>
      <div className="cc-bar">
        <select value={preset} onChange={(e) => window.ct.settings.set({ keymapPreset: e.target.value as 'jetbrains' | 'vscode' })}>
          <option value="jetbrains">JetBrains</option><option value="vscode">VS Code</option>
        </select>
        <span className="muted">{t('Clic sur un raccourci puis nouvelle combinaison ; Échap annule, ⌫ efface.')}</span><span className="spacer" />{Object.keys(kb).length > 0 && <button className="btn" onClick={() => setKb({})}>{t('Tout rétablir')}</button>}
      </div>
      {!mac && <div className="cc-bar"><span className="muted">{t('Dans un terminal, Ctrl + lettre reste au shell et à Claude (Ctrl+W efface un mot, Ctrl+R cherche dans l’historique) : seuls les raccourcis avec Maj ou Alt, ou sur une autre touche qu’une lettre, y passent à l’application.')}</span></div>}
      {group('general', t('Général'))}
      {group('editor', t('Éditeur'))}
    </>
  )
}

function updateText(u: UpdateState): string {
  switch (u.status) {
    case 'unsupported': return t('Mises à jour indisponibles : {r}.', { r: u.reason ?? '' })
    case 'checking': return t('Recherche…')
    case 'none': return t('À jour.')
    case 'downloading': return t('Téléchargement de la version {v}… {p} %', { v: u.version ?? '', p: u.progress ?? 0 })
    case 'ready': return t('La version {v} est prête ; elle sera aussi installée à la fermeture de l\'app.', { v: u.version ?? '' })
    case 'error': return t('Échec : {e}', { e: u.error ?? '' })
    default: return t('Depuis les versions publiées sur GitHub.')
  }
}
