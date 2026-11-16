/**
 * What Make my captions great says (docs/design/captions-studio.md §2.4, §2.8), in the UI language:
 * the result's notice and the button's hint. shared/captions/great.ts keeps the plan; main imports
 * it, so its words are here (docs/design/output-and-languages.md §9.1, test 86).
 */
import type { GreatSummary, ResolvedGreatOptions } from '../../../shared/captions/great'
import { STUDIO_PRESETS } from '../../../shared/captions/studioPresets'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
import { presetName } from './panels/captionTiles'

/** The style's name as the summary holds it (the look's English name, or "Brand"), in the UI language. */
function styleName(name: string): string {
  if (name === 'Brand') return t('captions.studio.brand')
  const preset = STUDIO_PRESETS.find((p) => p.name === name)
  return preset ? presetName(preset.id) : name
}

const count = (key: MessageKey, n: number): string => t(key, { count: n, n: fmt.count(n) })

/**
 * "Captions: Bold Pop, 38 words emphasised, 3 emoji, 1 counter, 1 list" followed by `review`
 * (reviewHint: ". Review (Shift + R)") and `undo` (undoHint: " · Ctrl + Z to undo"), §2.8.
 */
export function greatNotice(s: GreatSummary, undo = '', review = ''): string {
  const parts: string[] = []
  if (s.style) parts.push(styleName(s.style))
  if (s.emphasised) parts.push(count('captions.great.done.emphasised', s.emphasised))
  if (s.emoji) parts.push(count('captions.great.done.emoji', s.emoji))
  if (s.keywords) parts.push(count('captions.great.done.keywords', s.keywords))
  if (s.counters) parts.push(count('captions.great.done.counters', s.counters))
  if (s.lists) parts.push(count('captions.great.done.lists', s.lists))
  if (s.lowerThirds) parts.push(count('captions.great.done.lowerThirds', s.lowerThirds))
  if (s.chapters) parts.push(count('captions.great.done.chapters', s.chapters))
  if (s.quotes) parts.push(count('captions.great.done.quotes', s.quotes))
  if (s.tidied) parts.push(count('captions.great.done.tidied', s.tidied))
  if (s.bleeped) parts.push(count('captions.great.done.bleeped', s.bleeped))
  if (!parts.length) return s.providerFailed ? t('captions.great.done.nothingOffline') : t('captions.great.done.nothing')
  // A line of facts, joined as the notice always was (", ").
  const values = { parts: parts.join(', '), review, undo }
  return s.providerFailed ? t('captions.great.done.summaryOffline', values) : t('captions.great.done.summary', values)
}

/** The hint under the button, from the resolved options (§2.4). */
export function greatHint(o: ResolvedGreatOptions): string {
  const parts: string[] = []
  if (o.style) parts.push(t('captions.great.hint.style'))
  if (o.emphasis) parts.push(t('captions.great.hint.emphasis'))
  if (o.emoji) parts.push(t('captions.great.hint.emoji'))
  if (o.keywords) parts.push(t('captions.great.hint.keywords'))
  if (o.counters) parts.push(t('captions.great.hint.counters'))
  if (o.lists) parts.push(t('captions.great.hint.lists'))
  if (o.speakers) parts.push(t('captions.great.hint.speakers'))
  if (o.chapters) parts.push(t('captions.great.hint.chapters'))
  if (o.quotes) parts.push(t('captions.great.hint.quotes'))
  if (!parts.length) return o.tidy ? t('captions.great.hint.tidiesOnly') : t('captions.great.hint.none')
  const list = fmt.list(parts)
  return o.tidy ? t('captions.great.hint.addsAndTidies', { list }) : t('captions.great.hint.adds', { list })
}
