/**
 * Freeze frame edits (E-11, docs/design/freeze-frame.md §4.8): add at the playhead, change the
 * length or the sound, move, remove. Each returns the next project (the same object when nothing
 * changes), so each is one undo step through store.update.
 *
 * Contracts commit: signatures final; the edits are not implemented until E-11 lands
 * (TODO(E-11) below). Only E-11's UI and commands call them.
 */
import type { Clip, Freeze, FreezeSound, Project } from '../types'

/** Why a freeze was not added: the playhead is in a cut, a freeze is there, the picture is already frozen there, the limit. */
export type FreezeRefusal = 'cut' | 'taken' | 'frozen' | 'full'

/** A freeze of the frame under the playhead `t` (snapped to the frame's start), or why not (with the freeze in the way). */
export function freezeAtPlayhead(
  p: Project,
  t: number,
  init?: Partial<Pick<Freeze, 'length' | 'sound'>>
): { project: Project; id: string } | { refused: FreezeRefusal; id?: string } {
  // TODO(E-11): design §4.8.
  void p
  void t
  void init
  throw new Error('freezeAtPlayhead: not implemented yet (E-11)')
}

/** The freeze's length, rounded to tenths within FREEZE.min..max. */
export function setFreezeLength(p: Project, id: string, length: number): Project {
  // TODO(E-11)
  void p
  void id
  void length
  throw new Error('setFreezeLength: not implemented yet (E-11)')
}

/** The freeze's sound mode. */
export function setFreezeSound(p: Project, id: string, sound: FreezeSound): Project {
  // TODO(E-11)
  void p
  void id
  void sound
  throw new Error('setFreezeSound: not implemented yet (E-11)')
}

/** The freeze moved to the frame at `t` (the same project when that frame is cut or taken). */
export function moveFreeze(p: Project, id: string, t: number): Project {
  // TODO(E-11)
  void p
  void id
  void t
  throw new Error('moveFreeze: not implemented yet (E-11)')
}

/** The project without the freeze (no `freezes` key when it was the last). */
export function removeFreeze(p: Project, id: string): Project {
  // TODO(E-11)
  void p
  void id
  throw new Error('removeFreeze: not implemented yet (E-11)')
}

/** Source range of a text that shows through the whole freeze ("Add text on the freeze"); null when it is inactive. */
export function freezeTextRange(clips: Clip[], f: Freeze): { start: number; end: number } | null {
  // TODO(E-11): design §4.8.
  void clips
  void f
  return null
}
