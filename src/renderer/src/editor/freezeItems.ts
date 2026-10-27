import { createAnnotation } from '../../../shared/editor/annotations'
import { FREEZE_REFUSAL_TEXT, freezeAtPlayhead, freezeIdAt, freezeTextRange, setFreezeSound } from '../../../shared/editor/freezeEdit'
import type { Freeze, Project } from '../../../shared/types'
import type { EditorServices } from './context'
import type { Selection } from './selection'

/*
 * Freeze frames at the playhead (E-11): the one code path for the Clip panel and the editor's
 * commands (palette and shortcuts).
 */

interface Options {
  onSelect: (sel: Selection) => void
  /** Says why nothing changed, or what did. */
  onNotice: (message: string) => void
}

/**
 * Freezes the frame under the playhead (3 s, the sound paused) and selects the freeze. When that is
 * refused, says why, and selects the freeze in the way (one already there, or holding the picture).
 */
export function addFreezeAt({ store, player }: EditorServices, opts: Options): void {
  const r = freezeAtPlayhead(store.state, player.time)
  if ('refused' in r) {
    if (r.id) opts.onSelect({ kind: 'freeze', id: r.id })
    opts.onNotice(FREEZE_REFUSAL_TEXT[r.refused])
    return
  }
  store.update(() => r.project)
  opts.onSelect({ kind: 'freeze', id: r.id })
}

/** The freeze a command acts on: the selected one, else the one at the playhead (null when neither). */
export function freezeTarget(p: Project, sel: Selection, t: number): Freeze | null {
  const id = sel?.kind === 'freeze' ? sel.id : freezeIdAt(p, t)
  return p.freezes?.find((f) => f.id === id) ?? null
}

/** Switches the selected freeze (else the one at the playhead) between pausing and keeping the sound: one undo step. */
export function toggleFreezeSound({ store, player }: EditorServices, sel: Selection, opts: Options): void {
  const p = store.state
  const f = freezeTarget(p, sel, player.time)
  if (!f) return opts.onNotice('Select a freeze frame first')
  const sound = f.sound === 'pause' ? 'continue' : 'pause'
  const next = setFreezeSound(p, f.id, sound)
  if (next === p) return opts.onNotice('Nothing plays after the end of the video, so this freeze pauses the sound')
  store.update(() => next)
  if (sel?.kind !== 'freeze') opts.onSelect({ kind: 'freeze', id: f.id })
  opts.onNotice(sound === 'pause' ? 'Freeze frame: the recording waits with its sound paused' : 'Freeze frame: the sound keeps playing')
}

/** Adds a text that shows through the whole freeze, selects it (to type in) and shows the frozen frame. */
export function addTextOnFreeze({ store, player }: EditorServices, f: Freeze, onSelect: (sel: Selection) => void): void {
  const range = freezeTextRange(store.state.clips, f)
  if (!range) return
  const a = createAnnotation(range.start, store.state.duration, range)
  store.update((p) => ({ ...p, annotations: [...p.annotations, a] }))
  onSelect({ kind: 'annotation', id: a.id })
  player.seek(f.at)
}
