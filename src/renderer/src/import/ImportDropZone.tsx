import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { VideoImporter } from './useVideoImport'
import './import.css'

/** A file being dragged (not text or a link). */
const draggingFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')

/**
 * The library as a drop target: a video file dropped on it is imported. Only file drags are
 * taken (other drags pass through), and a drop elsewhere still never navigates the window
 * (security.ts).
 */
export function ImportDropZone({ importer, disabled, empty, children }: { importer: VideoImporter; disabled: boolean; empty: boolean; children: ReactNode }): JSX.Element {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const take = (e: DragEvent): boolean => {
    if (!draggingFiles(e)) return false
    e.preventDefault()
    e.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
    return true
  }
  return (
    <div
      className={`import-drop ${over && !disabled ? 'over' : ''}`}
      data-testid="import-drop"
      onDragEnter={(e) => {
        if (!take(e)) return
        depth.current++
        setOver(true)
      }}
      onDragOver={take}
      onDragLeave={(e) => {
        if (!draggingFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        depth.current = 0
        setOver(false)
        if (!take(e) || disabled) return
        importer.drop(e.dataTransfer.files)
      }}
    >
      {children}
      {empty && <p className="hint import-empty-hint">Or import a video made with another app: use Import video or drop it here.</p>}
      {over && !disabled && (
        <div className="import-drop-overlay" aria-hidden="true">
          <strong>Drop a video to import it</strong>
          <span>MP4, MOV, MKV or WebM</span>
        </div>
      )}
    </div>
  )
}
