import { useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { reorder } from '@shared/order'

/**
 * Drag and drop reordering of a row of tabs (axis x) or a list (axis y), live: while an item is dragged, the others
 * make room where it would land (render the items through `arrange`); the move is saved on drop and undone when the
 * drag ends anywhere else. An item moves past another once the pointer crosses that one's middle, so items of
 * different sizes do not swap back and forth. `kind` keeps lists apart (a project tab cannot land among the center
 * tabs). Items slide to their new place (each one from where it was, through a transform). Spread `props(id)` on each
 * item and `zone` on their container.
 */
export function useReorder(kind: string, onMove: (from: string, to: string, place: 'before' | 'after') => void, axis: 'x' | 'y' = 'x') {
  const type = 'application/x-claudeterm-' + kind
  /** the item dragged, and the order shown meanwhile once it moved */
  // done: dropped, the order shown until the items' saved order (async for some lists) is the same
  // lifted: the item's own slot is left empty (only the drag image shows it), from the frame after the drag started
  const [drag, setDragState] = useState<{ id: string; order: string[] | null; done?: boolean; lifted?: boolean } | null>(null)
  const done = useRef(false)
  done.current = !!drag?.done
  const els = useRef(new Map<string, HTMLElement>())
  const before = useRef<Map<string, DOMRect> | null>(null)
  /** every change of the order shown slides the items: where they are now, before React moves them */
  const setDrag = (next: { id: string; order: string[] | null } | null) => {
    before.current = new Map([...els.current].map(([id, el]) => [id, el.getBoundingClientRect()]))
    setDragState(next)
  }
  useLayoutEffect(() => {
    const was = before.current
    before.current = null
    if (!was) return
    for (const [id, el] of els.current) {
      const a = was.get(id)
      if (!a) continue
      const b = el.getBoundingClientRect()
      const d = axis === 'x' ? a.left - b.left : a.top - b.top
      if (Math.abs(d) < 1) continue
      // from the old place to the new one, without the transform the old rect may still carry
      el.style.transition = 'none'
      el.style.transform = `${axis === 'x' ? 'translateX' : 'translateY'}(${d}px)`
      void el.offsetWidth
      el.style.transition = 'transform 160ms ease'
      el.style.transform = ''
      el.addEventListener('transitionend', () => { el.style.transition = '' }, { once: true })
    }
  }, [drag?.order])
  const half = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return (axis === 'x' ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) ? 'before' as const : 'after' as const
  }
  /** the items' saved order, as `arrange` last saw it */
  let ids: string[] = []
  /** The items in the order to show: the live one while one of them is dragged. */
  const arrange = <T,>(items: T[], key: (x: T) => string): T[] => {
    ids = items.map(key)
    saved.current = ids
    const order = drag?.order
    if (!order) return items
    const byId = new Map(items.map((x) => [key(x), x]))
    // items that appeared meanwhile stay at the end
    return [...order.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...items.filter((x) => !order.includes(key(x)))]
  }
  const commit = () => {
    const d = drag
    if (!d?.order || d.order.join('\n') === ids.join('\n')) { setDrag(null); return }
    const order = d.order.filter((id) => ids.includes(id)), i = order.indexOf(d.id)
    done.current = true
    setDragState({ ...d, order, done: true })
    if (i > 0) onMove(d.id, order[i - 1], 'after')
    else if (i === 0 && order.length > 1) onMove(d.id, order[1], 'before')
  }
  // a drop kept: let go once the list saved it (or after a while, if saving failed)
  const saved = useRef<string[]>([])
  useLayoutEffect(() => {
    if (!drag?.done) return
    if (drag.order!.join('\n') === saved.current.join('\n')) { setDragState(null); return }
    const t = setTimeout(() => setDrag(null), 2000)
    return () => clearTimeout(t)
  })
  const accepts = (e: DragEvent<HTMLElement>) => !!drag && e.dataTransfer.types.includes(type)
  const props = (id: string) => ({
    ref: (el: HTMLElement | null) => { if (el) els.current.set(id, el); else els.current.delete(id) },
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(type, id); e.dataTransfer.effectAllowed = 'move'
      setDrag({ id, order: null })
      // not at once: the browser takes the drag image from the item once this handler returns
      setTimeout(() => setDragState((d) => (d?.id === id && !d.done ? { ...d, lifted: true } : d)))
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!accepts(e)) return
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'
      const d = drag!
      if (id === d.id) return
      const order = d.order ?? ids
      const from = order.indexOf(d.id), to = order.indexOf(id)
      if (from < 0 || to < 0) return
      // past the middle of the item, in the direction the pointer goes
      const side = half(e)
      if ((to > from && side === 'after') || (to < from && side === 'before')) setDrag({ ...d, order: reorder(order, (x) => x, d.id, id, side) })
    },
    onDrop: (e: DragEvent<HTMLElement>) => { if (accepts(e)) { e.preventDefault(); e.stopPropagation(); commit() } },
    // after a drop the order shown stays (done); a drag ending anywhere else puts the items back
    onDragEnd: () => { if (!done.current) setDrag(null) },
  })
  /** The container: a drop between two items, or past the last one, keeps the order shown. */
  const zone = {
    onDragOver: (e: DragEvent<HTMLElement>) => { if (accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } },
    onDrop: (e: DragEvent<HTMLElement>) => { if (accepts(e)) { e.preventDefault(); commit() } },
  }
  /** ' dragging' on the item being dragged: its slot, where it will land, shows empty. */
  const dropClass = (id: string) => (drag?.id === id && drag.lifted && !drag.done ? ' dragging' : '')
  return { props, zone, arrange, dropClass }
}
