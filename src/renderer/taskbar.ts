import { useWorkbench } from '@/stores/workbench'
import { t } from '@/i18n'

/** Windows taskbar overlay: the number of tabs waiting for the user (the Dock badge's counterpart), 9+ above 9. */
export function watchTaskbarBadge() {
  if (window.ct.platform !== 'win32') return
  let last = -1
  useWorkbench.subscribe((s) => {
    const n = s.settings?.dockBadge === false ? 0 : s.projects.reduce((k, p) => k + p.tabs.filter((x) => x.attention).length, 0)
    if (n === last) return
    last = n
    window.ct.app.setOverlay(n ? draw(n > 9 ? '9+' : String(n)) : null, n ? t('{n} onglet(s) en attente', { n }) : '')
  })
}

/** A disc in the theme's accent with the figure in the theme's text or background colour, whichever reads better on it. */
function draw(text: string): string {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  const css = getComputedStyle(document.documentElement)
  // luminance of a CSS colour, as the canvas resolves it
  const lum = (color: string) => { g.fillStyle = color; g.fillRect(0, 0, 1, 1); const [r, gr, b] = g.getImageData(0, 0, 1, 1).data; return 0.2126 * r + 0.7152 * gr + 0.0722 * b }
  const accent = css.getPropertyValue('--ct-accent').trim()
  const ink = [css.getPropertyValue('--ct-text').trim(), css.getPropertyValue('--ct-window-bg').trim()]
  const a = lum(accent)
  const best = ink.reduce((x, y) => (Math.abs(lum(y) - a) > Math.abs(lum(x) - a) ? y : x))
  g.clearRect(0, 0, 32, 32)
  g.fillStyle = accent
  g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill()
  g.fillStyle = best
  g.font = `bold ${text.length > 1 ? 17 : 21}px ${getComputedStyle(document.body).fontFamily}`
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, 16, 17)
  return c.toDataURL('image/png')
}
