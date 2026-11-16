/**
 * The words of the Clip tab's Cuts and Cut style sections and the cut commands (docs/design/
 * editing-polish.md §2.1, §12), as messages (style.cuts.*), made where they are shown.
 */
import { fmt } from '../i18n/fmt'
import { t } from '../i18n/t'
import type { JoinKind } from '../types'

/** Each style's hint under its options (exact copy, §2.1). */
export const CUT_HINTS: Readonly<Record<JoinKind, string>> = {
  get cut() {
    return t('style.cuts.hint.cut')
  },
  get smooth() {
    return t('style.cuts.hint.smooth')
  },
  get crossfade() {
    return t('style.cuts.hint.crossfade')
  },
  get dip() {
    return t('style.cuts.hint.dip')
  },
  get slide() {
    return t('style.cuts.hint.slide')
  },
  get punch() {
    return t('style.cuts.hint.punch')
  }
}

/** The styles in the order the select and the radio group list them. */
export const CUT_KINDS: readonly JoinKind[] = ['cut', 'smooth', 'crossfade', 'dip', 'slide', 'punch']

/** "37 cuts. A cut jumps from one moment of the recording to the next." */
export const cutsLine = (n: number): string => t('style.cuts.line', { count: n, n: fmt.count(n) })

/** "Smoothed 34 cuts · 3 keep their own style · Ctrl + Z to undo" (`undo`: undoHint's " · … to undo" or ''). */
export function smoothedNotice(changed: number, kept: number, undo: string): string {
  const values = { count: changed, n: fmt.count(changed), kept, k: fmt.count(kept) }
  return `${kept > 0 ? t('style.cuts.smoothedKept', values) : t('style.cuts.smoothed', values)}${undo}`
}

export const alreadySmooth = (): string => t('style.cuts.alreadySmooth')
export const noCuts = (): string => t('style.cuts.noCuts')
export const noCutsInVideo = (): string => t('style.cuts.noCutsInVideo')
export const hardEverywhere = (): string => t('style.cuts.hardEverywhere')
export const noCutAfter = (): string => t('style.cuts.noCutAfter')
export const noCutBefore = (): string => t('style.cuts.noCutBefore')
/** "Every cut has the same style" (Give them the same style's notice). */
export const sameStyle = (): string => t('style.cuts.sameStyle')

/** "3 cuts have their own style." */
export const ownLine = (n: number): string => t('style.cuts.own', { count: n, n: fmt.count(n) })

/** What Smooth gives this cut (§2.1). */
export const hereLine = (kind: 'crossfade' | 'punch'): string => (kind === 'punch' ? t('style.cuts.herePunch') : t('style.cuts.hereCrossfade'))

/** Slide's row while Calm motion is on, and a dip shown as a crossfade by the flash rule (§2.1). */
export const calmNote = (): string => t('style.cuts.calmNote')
export const flashNote = (): string => t('style.cuts.flashNote')

/** "Cut 5 of 37". */
export const cutOf = (n: number, of: number): string => t('style.cuts.cutOf', { n: fmt.count(n), total: fmt.count(of) })

/** The slider value texts: "0.15 seconds", "110 percent". */
export const secondsText = (s: number): string => t('style.cuts.seconds', { n: fmt.number(Number(s.toFixed(2))) })
export const percentText = (scale: number): string => t('style.cuts.percent', { n: fmt.count(Math.round(scale * 100)) })

/** The sides a slide comes in from. */
export const SLIDE_NAMES: Readonly<Record<'right' | 'left' | 'top' | 'bottom', string>> = {
  get right() {
    return t('style.cuts.slide.right')
  },
  get left() {
    return t('style.cuts.slide.left')
  },
  get top() {
    return t('style.cuts.slide.top')
  },
  get bottom() {
    return t('style.cuts.slide.bottom')
  }
}
