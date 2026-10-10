import { useState, type DragEvent } from 'react'
import { reorder } from '@shared/order'

/**
 * Drag and drop reordering of a row of tabs (axis x) or a list (axis y), live: while an item is dragged, the others
 * make room where it would land (render the items through `arrange`); the move is saved on drop and undone when the
 * drag ends anywhere else. An item moves past another once the pointer crosses that one's middle, so items of
 * different sizes do not swap back and forth. `kind` keeps lists apart (a project tab cannot land among the center
 * tabs). Spread `props(id)` on each item and `zone` on their container.
 */
export function useReorder(kind: string, onMove: (from: string, to: string, place: 'before' | 'after') => void, axis: 'x' | 'y' = 'x') {
  const type = 'application/x-claudeterm-' + kind
  /** the item dragged, and the order shown meanwhile once it moved */
  const [drag, setDrag] = useState<{ id: string; order: string[] | null } | null>(null)
  const half = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return (axis === 'x' ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) ? 'before' as const : 'after' as const
  }
  /** the items' saved order, as `arrange` last saw it */
  let ids: string[] = []
  /** The items in the order to show: the live one while one of them is dragged. */
  const arrange = <T,>(items: T[], key: (x: T) => string): T[] => {
    ids = items.map(key)
    const order = drag?.order
    if (!order) return items
    const byId = new Map(items.map((x) => [key(x), x]))
    // items that appeared meanwhile stay at the end
    return [...order.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...items.filter((x) => !order.includes(key(x)))]
  }
  const commit = () => {
    const d = drag
    setDrag(null)
    if (!d?.order || d.order.join('\n') === ids.join('\n')) return
    const order = d.order.filter((id) => ids.includes(id)), i = order.indexOf(d.id)
    if (i > 0) onMove(d.id, order[i - 1], 'after')
    else if (i === 0 && order.length > 1) onMove(d.id, order[1], 'before')
  }
  const accepts = (e: DragEvent<HTMLElement>) => !!drag && e.dataTransfer.types.includes(type)
  const props = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => { e.dataTransfer.setData(type, id); e.dataTransfer.effectAllowed = 'move'; setDrag({ id, order: null }) },
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
      if ((to > from && side === 'after') || (to < from && side === 'before')) setDrag({ id: d.id, order: reorder(order, (x) => x, d.id, id, side) })
    },
    onDrop: (e: DragEvent<HTMLElement>) => { if (accepts(e)) { e.preventDefault(); e.stopPropagation(); commit() } },
    onDragEnd: () => setDrag(null),
  })
  /** The container: a drop between two items, or past the last one, keeps the order shown. */
  const zone = {
    onDragOver: (e: DragEvent<HTMLElement>) => { if (accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } },
    onDrop: (e: DragEvent<HTMLElement>) => { if (accepts(e)) { e.preventDefault(); commit() } },
  }
  /** ' dragging' on the item being dragged, once it moved: it shows where it will land. */
  const dropClass = (id: string) => (drag?.id === id && drag.order ? ' dragging' : '')
  return { props, zone, arrange, dropClass }
}
