import { usePlugins } from '@/stores/plugins'

/** The chips plugins put on a project tab or a linked folder (ctx.ui.projectDecoration), e.g. Git's branch ↑↓●. */
export function Decorations({ root }: { root: string | null }) {
  usePlugins((s) => s.decorations)
  const list = usePlugins.getState().decorationsOf(root)
  if (!list.length) return null
  return <>{list.map((d) => <span key={d.pluginId} className={'pdeco' + (d.tone ? ' tone-' + d.tone : '')} title={d.tooltip}>{d.text}</span>)}</>
}
