/**
 * The look the caption gallery previews on the video (docs/design/captions-studio.md §2.5): while
 * a tile is hovered or focused for 300 ms, the preview draws the captions in that look with the
 * label "Previewing Bold Pop · Enter uses it" (focused) or "· Click to use it" (hovered: Enter acts
 * on the focus, not on the pointer). It is never saved, never an undo step and never
 * exported: the editor reads it only for the preview (PreviewStage). One per window.
 */
import { useSyncExternalStore } from 'react'
import type { CaptionSettings } from '../../../shared/types'

export interface PreviewLook {
  /** The gallery tile. */
  tile: string
  /** Its name, for the label. */
  name: string
  /** How the preview started: the tile got the focus (Enter picks it) or the pointer is on it (a click does). */
  via: 'focus' | 'pointer'
  /** The project's caption settings with the tile picked (what picking it would write). */
  captions: CaptionSettings
}

let current: PreviewLook | null = null
const listeners = new Set<() => void>()

export function setPreviewLook(look: PreviewLook | null): void {
  if (look === current || (!look && !current)) return
  current = look
  for (const l of listeners) l()
}

export const previewLook = (): PreviewLook | null => current

export function onPreviewLook(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePreviewLook(): PreviewLook | null {
  return useSyncExternalStore(onPreviewLook, previewLook)
}

/** "Previewing Bold Pop · Enter uses it" for a focused tile, "Previewing Bold Pop · Click to use it" for a hovered one. */
export const previewLabel = (look: PreviewLook): string => `Previewing ${look.name} · ${look.via === 'focus' ? 'Enter uses it' : 'Click to use it'}`
