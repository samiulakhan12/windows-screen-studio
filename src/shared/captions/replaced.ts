/**
 * What a card replaces while it shows (docs/design/captions-studio.md §10.1): the chunk holding
 * an anchored keyword's words, and the caption of an automatic quote card. Used by the Studio
 * layer and the legacy shownAt (one of its three guarded calls). Nothing is read twice: a card made
 * from caption words takes their place while it shows. Pure.
 */
import type { Project } from '../types'
import { wordsBleeped } from './cleanup'

/**
 * The captions and chunks replaced at source time `t` (the captions' clock, §9.1 rule 6): the chunk
 * holding the first word of each keyword pop-up made from caption words (its `anchor`, `replace`
 * not false) while it shows, and the caption of each automatic quote card while it shows (on
 * legacy looks too). A keyword in a language the burned-in captions are not in is not drawn, so it
 * replaces nothing. The one empty value, the same object every time, without anchored keywords
 * and automatic quote cards.
 */
export function replacedAt(project: Project, t: number): { captions: ReadonlySet<string>; chunks: readonly { caption: string; word: number }[] } {
  const anchored = project.graphics?.some((g) => g.kind === 'keyword' && g.anchor && g.replace !== false)
  const quotes = project.titles?.some((c) => c.auto?.by === 'quote')
  if (!anchored && !quotes) return NOTHING
  // The language of the burned-in captions: the track shown, else the spoken one.
  const shown = (project.captions?.track ?? project.transcript?.language ?? '').toLowerCase()
  const chunks: { caption: string; word: number }[] = []
  for (const g of project.graphics ?? []) {
    if (g.kind !== 'keyword' || !g.anchor || g.replace === false || !(t >= g.start && t < g.end)) continue
    if (g.lang && g.lang.toLowerCase() !== shown) continue
    // A keyword on a bleeped word is not drawn (graphicDrawn): the caption shows its mask.
    if (wordsBleeped(project, g.anchor)) continue
    chunks.push({ caption: g.anchor.caption, word: g.anchor.from })
  }
  const captions = new Set<string>()
  for (const c of project.titles ?? []) if (c.auto?.by === 'quote' && c.auto.caption && t >= c.start && t < c.end) captions.add(c.auto.caption)
  if (!chunks.length && !captions.size) return NOTHING
  return { captions, chunks }
}

/** What nothing replaces (one object, so callers can compare). */
const NOTHING: { captions: ReadonlySet<string>; chunks: readonly { caption: string; word: number }[] } = Object.freeze({ captions: new Set<string>(), chunks: [] })
