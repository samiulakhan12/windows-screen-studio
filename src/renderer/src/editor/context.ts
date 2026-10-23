import { createContext, useContext } from 'react'
import type { EditStore } from '../../../shared/editor/editStore'
import type { Project } from '../../../shared/types'
import type { PreviewPlayer } from './player'

/** Objects that live for one editor session and never change identity. */
export interface EditorServices {
  store: EditStore<Project>
  player: PreviewPlayer
}

export const EditorContext = createContext<EditorServices | null>(null)

export function useEditor(): EditorServices {
  const ctx = useContext(EditorContext)
  if (!ctx) throw new Error('useEditor must be used inside the editor')
  return ctx
}

/** Groups everything that happens until the pointer is released into one undo step. */
export function holdGesture(store: EditStore<Project>): void {
  store.beginGesture()
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    store.endGesture()
    window.removeEventListener('pointerup', end, true)
    window.removeEventListener('pointercancel', end, true)
  }
  window.addEventListener('pointerup', end, true)
  window.addEventListener('pointercancel', end, true)
}
