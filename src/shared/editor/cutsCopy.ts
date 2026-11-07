/**
 * The words of the Clip tab's Cuts and Cut style sections and the cut commands (docs/design/
 * editing-polish.md §2.1, §12). Pure, so the copy is tested without a DOM.
 */
import type { JoinKind } from '../types'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Each style's hint under its options (exact copy, §2.1). */
export const CUT_HINTS: Readonly<Record<JoinKind, string>> = {
  cut: 'Jumps straight to the next clip.',
  smooth: 'A crossfade where the screen fills the picture, a punch-in where the camera fills most of it. The video keeps its length.',
  crossfade: 'The last frame before the cut fades into the next clip. Hides small jumps on the screen. The video keeps its length.',
  dip: 'Fades to a colour and back. For the start of a new part.',
  slide: 'The next clip pushes the last frame out of the picture.',
  punch: 'The next clip is shown a little closer: the camera in the camera layouts and side by side, otherwise the screen. The clip after it goes back. For talking-head cuts.'
}

/** The styles in the order the select and the radio group list them. */
export const CUT_KINDS: readonly JoinKind[] = ['cut', 'smooth', 'crossfade', 'dip', 'slide', 'punch']

/** "37 cuts. A cut jumps from one moment of the recording to the next." */
export const cutsLine = (n: number): string => `${plural(n, 'cut')}. A cut jumps from one moment of the recording to the next.`

/** "Smoothed 34 cuts · 3 keep their own style · Ctrl + Z to undo" (`undo`: undoHint's " · … to undo" or ''). */
export function smoothedNotice(changed: number, kept: number, undo: string): string {
  return `Smoothed ${plural(changed, 'cut')}${kept > 0 ? ` · ${kept} keep${kept === 1 ? 's' : ''} ${kept === 1 ? 'its' : 'their'} own style` : ''}${undo}`
}

export const ALREADY_SMOOTH = 'Every cut is already smooth'
export const NO_CUTS = 'No cuts to smooth'
export const HARD_EVERYWHERE = 'Every cut is a hard cut'
export const NO_CUT_AFTER = 'No cut after the playhead'
export const NO_CUT_BEFORE = 'No cut before the playhead'

/** "3 cuts have their own style." */
export const ownLine = (n: number): string => (n === 1 ? '1 cut has its own style.' : `${n} cuts have their own style.`)

/** What Smooth gives this cut (§2.1). */
export const hereLine = (kind: 'crossfade' | 'punch'): string =>
  kind === 'punch' ? 'Here: a punch-in (the camera fills most of the picture on both sides).' : 'Here: a crossfade (the screen fills the picture).'

/** Slide's row while Calm motion is on, and a dip shown as a crossfade by the flash rule (§2.1). */
export const CALM_NOTE = '(Crossfade while Calm motion is on)'
export const FLASH_NOTE = "Shown as a crossfade so dips don't flash too often."

/** "Cut 5 of 37". */
export const cutOf = (n: number, of: number): string => `Cut ${n} of ${of}`

/** The slider value texts: "0.15 seconds", "110 percent". */
export const secondsText = (s: number): string => `${Number(s.toFixed(2))} seconds`
export const percentText = (scale: number): string => `${Math.round(scale * 100)} percent`

export const SLIDE_NAMES = { right: 'Right', left: 'Left', top: 'Top', bottom: 'Bottom' } as const
