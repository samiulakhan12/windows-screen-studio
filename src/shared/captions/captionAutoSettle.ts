/**
 * The settle rule of automatic caption changes (docs/design/captions-studio.md §11.8): a hand
 * change to an automatic thing makes it the user's; marks, anchors and places follow their words.
 * Pure. It joins the store's settle chain after settleDeletedWords (and, in phase B, the review
 * mode's settleAutoCuts), so every update ends with the project saving and reopening would give.
 *
 * Automation's own updates change a record and its item together (a new record object, a new
 * records array, a new `auto` object or a new id), so rules 1–3 keep them.
 */
import type { CaptionMark, CaptionSettings, CaptionWord, Graphic, Project, TitleCard } from '../types'
import { deepEqual } from './graphicRules'
import { remapAnchors } from './marks'

/**
 * The look of the caption settings (§11.8 rule 1): `studio` without its dragged place, `preset`,
 * `color`, `highlightColor`, `background`, `size`, `maxLines` and `font`. Showing or hiding
 * captions, the position, speaker names, the track, the digits and a dragged place are not the look.
 * Null for no settings. Review's Remove on the style row puts back these fields only.
 */
export function lookOf(c: CaptionSettings | undefined): Pick<CaptionSettings, 'studio' | 'preset' | 'color' | 'highlightColor' | 'background' | 'size' | 'maxLines' | 'font'> | null {
  if (!c) return null
  const studio = c.studio ? { ...c.studio, layout: { ...c.studio.layout, place: undefined } } : undefined
  return { studio, preset: c.preset, color: c.color, highlightColor: c.highlightColor, background: c.background, size: c.size, maxLines: c.maxLines, font: c.font }
}

const sameWords = (a: readonly CaptionWord[] | undefined, b: readonly CaptionWord[] | undefined): boolean => a === b || deepEqual(a ?? [], b ?? [])

/** Items whose `auto` stayed while something else changed lose it (rule 3). */
function settleItems<T extends { id: string; auto?: unknown }>(next: readonly T[] | undefined, prev: readonly T[] | undefined): T[] | undefined {
  if (!next || !prev || next === prev) return undefined
  const before = new Map(prev.map((x) => [x.id, x]))
  let changed = false
  const out = next.map((x) => {
    const p = before.get(x.id)
    if (!x.auto || !p || p === x || p.auto !== x.auto) return x
    const { auto: _a, ...rest } = x
    const { auto: _b, ...was } = p
    void _a
    void _b
    if (deepEqual(rest, was)) return x
    changed = true
    return rest as T
  })
  return changed ? out : undefined
}

/**
 * `p` without its `captionAuto.twin` record once the record has nothing to go with: no mark is
 * pending any more (kept, edited or deleted) or the captions have no Studio look. The twin stays
 * as it is: the user's from then on.
 */
export function settleTwinRecord(p: Project): Project {
  const auto = p.captionAuto
  if (!auto?.twin || (p.captions?.studio && p.captionMarks?.some((m) => m.auto))) return p
  const { twin: _t, ...rest } = auto
  void _t
  return withAuto(p, rest)
}

/** `next` settled against `prev` (rules 1–5 of §11.8); `next` itself when nothing changes. */
export function settleCaptionAuto(next: Project, prev: Project): Project {
  if (next === prev) return next
  let out = next
  // Rule 1: a look changed by hand drops the record of the automatic style.
  const style = next.captionAuto?.style
  if (style && style === prev.captionAuto?.style && next.captions !== prev.captions && !deepEqual(lookOf(next.captions), lookOf(prev.captions))) {
    const { style: _s, ...auto } = next.captionAuto!
    void _s
    out = withAuto(out, auto)
  }
  // Rule 2: a caption whose text or words changed drops its record when the record did not change.
  // An update that writes the records itself is automation's (a tidy run keeps a caption's first
  // record when it tidies it again; Review's Remove puts text back): it keeps them.
  const records = out.captionAuto?.text
  if (records?.length && next.transcript !== prev.transcript && next.captionAuto?.text === prev.captionAuto?.text) {
    const before = new Map((prev.captionAuto?.text ?? []).map((r) => [r.caption, r]))
    const was = new Map((prev.transcript?.segments ?? []).map((s) => [s.id, s]))
    const now = new Map((next.transcript?.segments ?? []).map((s) => [s.id, s]))
    const kept = records.filter((r) => {
      const a = was.get(r.caption)
      const b = now.get(r.caption)
      if (!b) return false
      const recordSame = before.get(r.caption) === r || deepEqual(before.get(r.caption), r)
      if (!recordSame || !a || a === b) return true
      return a.text === b.text && sameWords(a.words, b.words)
    })
    if (kept.length !== records.length) {
      const { text: _t, ...auto } = out.captionAuto!
      void _t
      out = withAuto(out, kept.length ? { ...auto, text: kept } : auto)
    }
  }
  // Rule 3: a hand edit makes a mark, graphic, bleep or title card the user's.
  const marks = settleItems<CaptionMark>(next.captionMarks, prev.captionMarks)
  if (marks) out = { ...out, captionMarks: marks }
  const graphics = settleItems<Graphic>(next.graphics, prev.graphics)
  if (graphics) out = { ...out, graphics }
  const bleeps = settleItems(next.bleeps, prev.bleeps)
  if (bleeps) out = { ...out, bleeps }
  const titles = settleItems<TitleCard>(next.titles, prev.titles)
  if (titles) out = { ...out, titles }
  // Rule 4: marks, word anchors and per-caption places follow their words.
  out = remapAnchors(out, prev)
  // Rule 5: the record of a twin made for automatic emphasis goes when no mark is pending.
  out = settleTwinRecord(out)
  return out
}

/** The project with these records (none: the field removed). */
function withAuto(p: Project, auto: NonNullable<Project['captionAuto']>): Project {
  if (auto.style || auto.text?.length || auto.twin) return { ...p, captionAuto: auto }
  const { captionAuto: _gone, ...rest } = p
  void _gone
  return rest
}
