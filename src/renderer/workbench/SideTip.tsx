import { useEffect, useState } from 'react'

/**
 * Tooltips of the activity bars' icons (`data-tip`): the window shows no native title there. After a short hover the
 * label appears beside the icon, toward the middle of the window; a click or leaving hides it.
 */
export function SideTips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; side: 'left' | 'right' } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let shown: Element | null = null
    const hide = () => { clearTimeout(timer); shown = null; setTip(null) }
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('.activity [data-tip]')
      if (el === shown) return
      hide()
      if (!el) return
      shown = el
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect()
        const right = !!el.closest('.activity.right')
        setTip({ text: el.getAttribute('data-tip') ?? '', x: right ? r.left - 6 : r.right + 6, y: r.top + r.height / 2, side: right ? 'right' : 'left' })
      }, 450)
    }
    document.addEventListener('mouseover', over)
    document.addEventListener('mousedown', hide, true)
    window.addEventListener('blur', hide)
    return () => { hide(); document.removeEventListener('mouseover', over); document.removeEventListener('mousedown', hide, true); window.removeEventListener('blur', hide) }
  }, [])
  if (!tip?.text) return null
  return <div className={'side-tip ' + tip.side} style={{ left: tip.x, top: tip.y }}>{tip.text}</div>
}
