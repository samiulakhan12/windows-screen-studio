import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * Follows one pointer from a pointerdown until it is released. Listens on window
 * (filtered by pointer id) so the drag always ends, even if the element that
 * started it is re-rendered away mid-drag.
 */
export function followPointer(e: ReactPointerEvent, onMove: (ev: PointerEvent) => void, onEnd?: (ev: PointerEvent) => void): void {
  const id = e.pointerId
  ;(e.currentTarget as Element).setPointerCapture?.(id)
  const move = (ev: PointerEvent): void => {
    if (ev.pointerId === id) onMove(ev)
  }
  const up = (ev: PointerEvent): void => {
    if (ev.pointerId !== id) return
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    onEnd?.(ev)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}
