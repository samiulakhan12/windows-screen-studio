/**
 * Isolation of mixed-direction text (docs/design/output-and-languages.md §13.3): the user's own text
 * (project names, chapter titles, file names, preset names) inside a sentence of another script is
 * wrapped in FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE, or LEFT-TO-RIGHT / RIGHT-TO-LEFT ISOLATE
 * when its direction is known (keycaps, timecodes, sizes and paths are 'ltr'). English adds nothing,
 * so the English UI stays byte for byte as it is (§0 decision 12).
 */
import { uiLanguage } from './t'

const FSI = '⁨'
const LRI = '⁦'
const RLI = '⁧'
const PDI = '⁩'

/** `value` isolated for a sentence of the UI language; unchanged in English. */
export function isolate(value: string, dir?: 'ltr' | 'rtl'): string {
  if (uiLanguage() === 'en') return value
  return `${dir === 'ltr' ? LRI : dir === 'rtl' ? RLI : FSI}${value}${PDI}`
}

/** Text without isolate characters (copying to the clipboard strips them, §13.3). */
export const withoutIsolates = (text: string): string => text.replace(/[⁦-⁩]/g, '')
