/**
 * The display's scale factor, for canvases sized in device pixels. A window dragged to a monitor
 * with another scale factor changes devicePixelRatio without a resize, so no ResizeObserver sees it.
 */
import { useSyncExternalStore } from 'react'

const currentRatio = (): number => window.devicePixelRatio || 1

/** Calls `onChange` each time devicePixelRatio changes; returns the unsubscribe. */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  // The query matches only the ratio it names, so it is asked again at each new one.
  let mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  const onDpr = (): void => {
    mq.removeEventListener('change', onDpr)
    mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    mq.addEventListener('change', onDpr)
    onChange()
  }
  mq.addEventListener('change', onDpr)
  return () => mq.removeEventListener('change', onDpr)
}

/** devicePixelRatio, re-rendering when it changes. */
export const useDevicePixelRatio = (): number => useSyncExternalStore(watchDevicePixelRatio, currentRatio)
