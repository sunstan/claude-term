import { useState, type DragEvent } from 'react'

/**
 * Drag and drop reordering of a row of tabs (axis x) or a list (axis y). `kind` keeps rows apart (a project tab cannot
 * land among the center tabs); the drop side follows the pointer (left / right, or top / bottom half of the target).
 * Spread `props(id)` on each item.
 */
export function useReorder(kind: string, onMove: (from: string, to: string, place: 'before' | 'after') => void, axis: 'x' | 'y' = 'x') {
  const type = 'application/x-claudeterm-' + kind
  const [over, setOver] = useState<{ id: string; place: 'before' | 'after' } | null>(null)
  const side = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return (axis === 'x' ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) ? 'before' as const : 'after' as const
  }
  const props = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => { e.dataTransfer.setData(type, id); e.dataTransfer.effectAllowed = 'move' },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(type)) return
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'
      const place = side(e)
      if (over?.id !== id || over.place !== place) setOver({ id, place })
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.id === id ? null : o)) },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const from = e.dataTransfer.getData(type)
      setOver(null)
      if (!from) return
      e.preventDefault(); e.stopPropagation()
      onMove(from, id, side(e))
    },
    onDragEnd: () => setOver(null),
  })
  const dropClass = (id: string) => (over?.id === id ? ' drop-' + over.place : '')
  return { props, dropClass }
}
