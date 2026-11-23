import { useSyncExternalStore } from 'react'
import { displayTime } from '../../../shared/editor/clips'
import { coverFromShape } from '../../../shared/editor/coverEdit'
import { itemKey } from '../../../shared/editor/multiSelect'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { t } from '../../../shared/i18n/t'
import type { EditorServices } from '../editor/context'
import { useGroup } from '../editor/groupContext'
import { coverColourNow } from './coverPick'
import './covers.css'

/**
 * The note and *Turn into a cover* under a blur or pixelate shape's strength (docs/design/auto-blur.md
 * §2.4): even fully on, blurred or pixelated text can sometimes be read back. The button replaces
 * the shape with a cover over the same box and times (coloured from the paused frame), in one undo
 * step, and selects it.
 */
export function WeakBlurNote(props: { services: EditorServices; shapeId: string }): JSX.Element | null {
  const { store, player } = props.services
  const group = useGroup()
  const shape = useSyncExternalStore(store.subscribe, () => store.state.shapes?.find((s) => s.id === props.shapeId))
  if (!shape || (shape.kind !== 'blur' && shape.kind !== 'pixelate')) return null
  const noteId = `cover-weak-note-${shape.id}`

  const turn = async (): Promise<void> => {
    const box = { x: Math.min(shape.x, shape.x + shape.w), y: Math.min(shape.y, shape.y + shape.h), w: Math.abs(shape.w), h: Math.abs(shape.h) }
    // The paused frame when it shows the shape, else the shape's own middle.
    const at = displayTime(store.state.clips, player.time)
    const when = at >= shape.start && at < shape.end ? at : (shape.start + shape.end) / 2
    const color = await coverColourNow(props.services, when, box)
    let id: string | null = null
    store.update((p) => {
      const r = coverFromShape(p, shape.id, color)
      id = r?.id ?? null
      return r ? r.project : p
    })
    if (id) group.select([itemKey('cover', id)], itemKey('cover', id))
  }

  return (
    <div className="cover-weak-note" data-testid="cover-weak-note">
      <p className="hint" id={noteId}>
        {t(PRIVACY_COPY.weak.note)}
      </p>
      <button type="button" className="btn ghost small" aria-describedby={noteId} onClick={() => void turn()} data-testid="cover-weak-turn">
        {t(PRIVACY_COPY.weak.turn)}
      </button>
    </div>
  )
}
