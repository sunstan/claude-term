import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useWorkbench } from '@/stores/workbench'
import { t } from '@/i18n'

/** A size (px) kept in settings.json under `layout`. */
export function useStoredSize(key: string, initial: number): [number, (v: number | ((prev: number) => number)) => void] {
  const v = useWorkbench((s) => s.layout[key])
  const setLayout = useWorkbench((s) => s.setLayout)
  const value = typeof v === 'number' ? v : initial
  const set = useCallback((n: number | ((prev: number) => number)) => {
    setLayout(key, typeof n === 'function' ? (prev) => n(prev || initial) : n)
  }, [key, initial, setLayout])
  return [value, set]
}

/** A collapsed flag kept in settings.json under `layout`. */
export function useCollapsed(key: string): [boolean, (c: boolean) => void] {
  const v = useWorkbench((s) => s.layout['collapsed:' + key])
  const setLayout = useWorkbench((s) => s.setLayout)
  return [v === true, useCallback((c: boolean) => setLayout('collapsed:' + key, c), [key, setLayout])]
}

/**
 * Drag handle of a size. `axis` x resizes a width, y a height; `sign` −1 when the resized box is after the handle;
 * `scale` converts pixels to the size's unit (a percentage of the container). The size follows the pointer from where
 * the drag began, so a size held at a bound does not drift; a double-click gives back `reset`. The pointer is captured
 * and a veil covers the window while dragging, so an editor or a frame under it cannot take the moves.
 */
export function Gutter({ axis, size, onSize, min, max, reset, sign = 1, scale, className, inert }: {
  axis: 'x' | 'y'; size: number; onSize: (v: number) => void; min: number; max: number | (() => number); reset: number
  sign?: 1 | -1; scale?: () => number; className?: string; inert?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const clamp = (v: number) => Math.max(min, Math.min(typeof max === 'function' ? max() : max, v))
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget, from = axis === 'x' ? e.clientX : e.clientY, base = size, unit = scale?.() ?? 1
    el.setPointerCapture(e.pointerId)
    setDragging(true)
    const move = (ev: PointerEvent) => onSize(clamp(base + sign * ((axis === 'x' ? ev.clientX : ev.clientY) - from) * unit))
    const up = () => { setDragging(false); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return (
    <>
      <div className={'gutter ' + axis + (className ? ' ' + className : '') + (inert ? ' inert' : '') + (dragging ? ' dragging' : '')} onPointerDown={onDown} onDoubleClick={() => onSize(clamp(reset))} title={t('Glisser pour redimensionner ; double-clic : taille par défaut')} />
      {dragging && <div className={'drag-veil ' + axis} />}
    </>
  )
}

/**
 * Two stacked islands with a draggable divider; the bottom one has a remembered height and
 * can be collapsed (then the divider is inert).
 */
export function VStack({ id, top, bottom, collapsed, min = 100, initial = 220 }: {
  id: string; top: ReactNode; bottom: ReactNode; collapsed: boolean; min?: number; initial?: number
}) {
  const [h, setH] = useStoredSize(id, initial)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className="vstack" ref={ref}>
      <div className="vstack-top">{top}</div>
      <Gutter axis="y" inert={collapsed} size={h} onSize={setH} sign={-1} min={min} max={() => (ref.current?.clientHeight ?? 1000) - min - 20} reset={initial} />
      <div className="vstack-bottom" style={{ height: collapsed ? undefined : h, flex: collapsed ? 'none' : undefined }}>{bottom}</div>
    </div>
  )
}

export function useWindowResize(cb: () => void) {
  useEffect(() => { window.addEventListener('resize', cb); return () => window.removeEventListener('resize', cb) }, [cb])
}

/** N stacked islands: the first grows, the others keep a remembered height, gutters in between. */
export function PStack({ ids, children }: { ids: string[]; children: ReactNode[] }) {
  const layout = useWorkbench((s) => s.layout)
  const setLayout = useWorkbench((s) => s.setLayout)
  const kids = Array.isArray(children) ? children : [children]
  return (
    <div className="pstack">
      {kids.map((child, i) => {
        const key = 'pstack:' + ids[i]
        const h = typeof layout[key] === 'number' ? (layout[key] as number) : 220
        return (
          <div key={ids[i]} className={'pstack-item' + (i === 0 ? ' first' : '')} style={i === 0 ? undefined : { height: h }}>
            {i > 0 && <Gutter axis="y" size={h} onSize={(v) => setLayout(key, v)} sign={-1} min={90} max={2000} reset={220} />}
            {child}
          </div>
        )
      })}
    </div>
  )
}
