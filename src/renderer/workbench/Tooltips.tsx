import { useEffect, useLayoutEffect, useRef, useState } from 'react'

type Tip = { text: string; rect: DOMRect; place: 'below' | 'right' | 'left' }

/**
 * Tooltips for the whole app: the window shows no native `title`. After a short hover over an element with a `title`
 * (moved to `data-tip`, so a native one never doubles it) or a `data-tip`, the text appears below it; beside the bar
 * for the activity bars' icons, above when there is no room below, always kept inside the window. A click, a key,
 * a scroll or leaving hides it.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let shown: Element | null = null
    const hide = () => { clearTimeout(timer); shown = null; setTip(null) }
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[title], [data-tip]') ?? null
      if (el === shown) return
      hide()
      if (!el) return
      const title = el.getAttribute('title')
      if (title !== null) { el.setAttribute('data-tip', title); el.removeAttribute('title') }
      shown = el
      timer = setTimeout(() => {
        if (!el.isConnected) return
        const text = el.getAttribute('data-tip') ?? ''
        const bar = el.closest('.activity')
        setTip({ text, rect: el.getBoundingClientRect(), place: bar ? (bar.classList.contains('right') ? 'left' : 'right') : 'below' })
      }, 500)
    }
    const events = ['mousedown', 'keydown', 'wheel', 'dragstart'] as const
    document.addEventListener('mouseover', over)
    for (const ev of events) document.addEventListener(ev, hide, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('mouseover', over)
      for (const ev of events) document.removeEventListener(ev, hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])
  // placed once measured: beside or below the element, flipped above near the bottom, inside the window
  useLayoutEffect(() => {
    const t = ref.current
    if (!t || !tip) return
    const r = tip.rect, w = t.offsetWidth, h = t.offsetHeight, m = 4
    let x: number, y: number
    if (tip.place === 'right') { x = r.right + 6; y = r.top + r.height / 2 - h / 2 }
    else if (tip.place === 'left') { x = r.left - 6 - w; y = r.top + r.height / 2 - h / 2 }
    else {
      x = r.left + r.width / 2 - w / 2
      y = r.bottom + 6 + h > window.innerHeight - m ? r.top - 6 - h : r.bottom + 6
    }
    t.style.left = Math.max(m, Math.min(x, window.innerWidth - w - m)) + 'px'
    t.style.top = Math.max(m, Math.min(y, window.innerHeight - h - m)) + 'px'
    t.style.visibility = 'visible'
  }, [tip])
  if (!tip?.text) return null
  return <div ref={ref} className="tooltip" role="tooltip">{tip.text}</div>
}
