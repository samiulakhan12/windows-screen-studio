import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * Follows one pointer from a pointerdown until it is released. Listens on window
 * (filtered by pointer id) so the drag always ends, even if the element that
 * started it is re-rendered away mid-drag. Returns a function that stops following
 * at once (without onEnd), for a drag whose tool goes away while it is held.
 */
export function followPointer(e: ReactPointerEvent, onMove: (ev: PointerEvent) => void, onEnd?: (ev: PointerEvent) => void): () => void {
  const id = e.pointerId
  ;(e.currentTarget as Element).setPointerCapture?.(id)
  const move = (ev: PointerEvent): void => {
    if (ev.pointerId === id) onMove(ev)
  }
  const stop = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  const up = (ev: PointerEvent): void => {
    if (ev.pointerId !== id) return
    stop()
    onEnd?.(ev)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  return stop
}
