import { useEffect, useRef, useState } from 'react'
import { useEditor } from './context'
import { addOverlayFile, ipcMessage, isOverlayFile } from './overlayItems'
import type { Selection } from './selection'
import './overlays.css'

/** True while the focus is where pasting means text (a field, a text area, editable content). */
const typingTarget = (el: Element | null): boolean =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable || !!el.closest('[contenteditable="true"]'))

/** A modal dialog is open. */
const modalOpen = (): boolean => !!document.querySelector('[role="dialog"][aria-modal="true"], .modal')

/** A file being dragged in (not text or a link). */
const draggingFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

/**
 * Adds an image dropped anywhere on the editor, or pasted with Ctrl+V while the focus is not in
 * a text field, at the playhead (docs/design/brand-kit.md §4.5). Shows an outline while a file is
 * dragged over the window. A dropped file never navigates the window (security.ts also blocks it).
 */
export function OverlayDropZone({ onSelect, onNotice }: { onSelect: (sel: Selection) => void; onNotice: (message: string) => void }): JSX.Element | null {
  const services = useEditor()
  const [over, setOver] = useState(false)
  const latest = useRef({ services, onSelect, onNotice })
  latest.current = { services, onSelect, onNotice }

  useEffect(() => {
    let depth = 0
    const add = (file: File): void => {
      const { services: s, onSelect: select, onNotice: notice } = latest.current
      if (!isOverlayFile(file)) return notice('Only PNG, JPG, WebP, SVG and GIF images can be added')
      addOverlayFile(s, file, { onSelect: select }).then(
        (o) => notice(`Added ${o.name ?? 'the image'} at the playhead`),
        (err: unknown) => notice(ipcMessage(err))
      )
    }
    const onEnter = (e: DragEvent): void => {
      if (!draggingFiles(e)) return
      depth++
      setOver(true)
    }
    const onLeave = (e: DragEvent): void => {
      if (!draggingFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }
    const onOverEvent = (e: DragEvent): void => {
      if (!draggingFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      depth = 0
      setOver(false)
      if (!draggingFiles(e)) return
      e.preventDefault()
      // Not behind a dialog (export, palette, settings): the drop was not meant for the video.
      if (modalOpen()) return
      const file = e.dataTransfer?.files[0]
      if (file) add(file)
    }
    const onPaste = (e: ClipboardEvent): void => {
      if (typingTarget(document.activeElement) || modalOpen()) return
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      add(file)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOverEvent)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOverEvent)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  if (!over) return null
  return (
    <div className="overlay-drop" data-testid="overlay-drop">
      <span>Drop an image to add it at the playhead</span>
    </div>
  )
}
