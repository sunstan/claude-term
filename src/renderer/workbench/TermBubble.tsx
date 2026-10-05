import { isClaude, type Tab } from '@/stores/workbench'
import { useUsage } from '@/stores/usage'
import { MODEL_CHOICES, contextInfo, currentChoice, modelLabel, modelName, withWindowHint } from '@shared/models'
import { level } from '@shared/usage'
import { MenuButton } from './Menu'
import { Icons } from './icons'
import { t as tr } from '@/i18n'

export function attentionColor(a: { kind: string }) {
  return a.kind === 'permission' ? 'var(--ct-accent)' : a.kind === 'idle' ? 'var(--ct-badge-warn)' : 'var(--ct-badge-info)'
}
export function attentionLabel(a: { kind: string; message: string }) {
  return a.kind === 'permission' ? (a.message || tr('Permission en attente')) : a.kind === 'idle' ? tr('Claude attend une réponse') : tr('Claude a terminé')
}

const badge = (text: string, color: string) => <span className="badge" style={{ background: `color-mix(in srgb, ${color} 20%, transparent)`, color }}>{text}</span>

/**
 * Floating bubble at the top right of a terminal (like the markdown modes): the tab's state (command, exit code;
 * Claude: attention, permission / plan mode, running tools, tokens), and for Claude the current model (menu:
 * `/model <alias>` typed in the tab) and the context used.
 */
export function TermBubble({ tab }: { tab: Tab }) {
  const claude = isClaude(tab)
  const s = tab.session
  const live = useUsage((st) => (s?.sessionId ? st.bySession[s.sessionId] : undefined))
  const requested = useUsage((st) => st.requested[tab.id])
  const defaultModel = useUsage((st) => st.defaultModel)
  if (!claude) {
    const content = tab.busy ? <span className="item"><span className="spin" /><span className="cmd">{tab.lastCommand}</span></span>
      : tab.lastExit !== null ? <span className="item">{badge(tab.lastExit === 0 ? 'ok' : 'exit ' + tab.lastExit, tab.lastExit === 0 ? 'var(--ct-badge-ok)' : 'var(--ct-badge-error)')}<span className="cmd">{tab.lastCommand}</span></span>
      : null
    if (!content && tab.alive) return null
    return <div className="term-bubble">{content}{!tab.alive && badge(tr('terminé'), 'var(--ct-badge-error)')}</div>
  }
  // the model the tab runs: status line name, else the transcript's; a request shows until the transcript changes
  const running = live?.model ?? (s?.model ? modelLabel(s.model) : undefined)
  // a request is pending in the session it was made in, until the transcript shows another model
  const pending = requested && requested.sessionId === s?.sessionId && (!s?.model || s.model === requested.from) ? requested.alias : undefined
  const shown = pending ? modelName(pending) : running ?? (defaultModel ? modelName(defaultModel) : undefined)
  const model = live?.model ?? withWindowHint(s?.model, requested?.sessionId === s?.sessionId ? requested?.alias : undefined, defaultModel) ?? defaultModel
  const active = pending ?? currentChoice(model)
  const ctx = contextInfo({ statusPercent: live?.contextPercent, tokens: s?.contextTokens, model })
  const setModel = (alias: string) => {
    if (!tab.ptyId) return
    window.ct.usage.switchModel(tab.ptyId, alias)
    useUsage.getState().request(tab.id, alias, s?.model, s?.sessionId)
  }
  return (
    <div className="term-bubble">
      {tab.attention && badge(attentionLabel(tab.attention), attentionColor(tab.attention))}
      {s?.permissionMode && s.permissionMode !== 'default' && badge(s.permissionMode, 'var(--ct-accent)')}
      {s?.planMode && badge(tr('plan'), 'var(--ct-accent)')}
      {s && s.runningTools.length > 0 && <span className="item"><span className="spin" /><span className="cmd">{s.runningTools.map((r) => r.name).join(', ')}</span></span>}
      {!tab.alive ? badge(tr('terminé'), 'var(--ct-badge-error)') : (
        <MenuButton className="model" title={tr('Changer de modèle (/model)')} items={MODEL_CHOICES.map((c) => ({ label: c.label, icon: c.alias === active ? Icons.check(12) : <span style={{ width: 12 }} />, onSelect: () => setModel(c.alias) }))}>
          {Icons.claude(12)}<span>{shown ?? tr('modèle')}</span>{Icons.chevronDown(11)}
        </MenuButton>
      )}
      {/* shown only: /effort also saves the level as Claude Code's default, which the bubble must not change */}
      {tab.alive && s?.effort && <span className="item dim" title={tr('Effort de raisonnement de la session (/effort pour le changer)')}>{s.effort}</span>}
      {ctx && (
        <span className={'ctx ' + level(ctx.percent).tone} title={ctx.estimated ? tr('Estimé depuis le transcript (le suivi en continu donne le chiffre exact)') : tr('Contexte utilisé')}>
          <span className="mini"><span style={{ width: `${ctx.percent}%` }} /></span>{ctx.estimated ? '≈' : ''}{Math.round(ctx.percent)} %
        </span>
      )}
      {s && (s.inputTokens > 0 || s.outputTokens > 0) && <span className="item dim" title={tr('Tokens de la session : entrée ↓, sortie ↑')}>{short(s.inputTokens)} ↓ {short(s.outputTokens)} ↑</span>}
    </div>
  )
}

const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n))
