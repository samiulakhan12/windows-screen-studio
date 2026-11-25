/**
 * Every AI request masked for secrets said aloud (docs/design/auto-blur.md §7.6): the captions under
 * private bleeps masked by time, and every string of the request (found by walking it, not by a list
 * of known fields) with the spoken forms masked. The request itself when the project has no private
 * bleeps, so every request of an older project is what it was. Ordinary bleeps are not applied here.
 */
import { maskedSegments } from '../captions/cleanup'
import type { Bleep, CaptionSegment, Project } from '../types'
import { isPrivateBleep } from './coverData'
import { maskPrivate, spokenForms, type SpokenForms } from './spoken'

/** Keys whose strings are identifiers the answer is matched by, never words: left as they are. */
const IDS = new Set(['id', 'requestId', 'task', 'caption'])

function walk(value: unknown, forms: SpokenForms | null, key: string | null): unknown {
  if (typeof value === 'string') return key !== null && IDS.has(key) ? value : maskPrivate(value, forms)
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((v) => {
      const m = walk(v, forms, null)
      if (m !== v) changed = true
      return m
    })
    return changed ? out : value
  }
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    const m = walk(v, forms, k)
    if (m !== v) changed = true
    out[k] = m
  }
  return changed ? out : value
}

const isSegmentList = (v: unknown): v is CaptionSegment[] =>
  Array.isArray(v) && v.every((s) => !!s && typeof s === 'object' && typeof (s as CaptionSegment).text === 'string' && Number.isFinite((s as CaptionSegment).start) && Number.isFinite((s as CaptionSegment).end))

export function maskRequest<R extends object>(request: R, project: Pick<Project, 'transcript' | 'bleeps'>): R {
  const own: Bleep[] = (project?.bleeps ?? []).filter(isPrivateBleep)
  if (!own.length) return request
  const forms = spokenForms(project)
  // Captions anywhere in the request (its segments, or a list of them) are masked by time first.
  const byTime = (v: unknown): unknown => (isSegmentList(v) && v.length ? maskedSegments(v, own) : v)
  let timed: Record<string, unknown> = request as Record<string, unknown>
  const masked = new Map<string, string>()
  for (const [k, v] of Object.entries(request)) {
    const m = byTime(v)
    if (m !== v) {
      timed = { ...timed, [k]: m }
      for (const s of m as CaptionSegment[]) masked.set(s.id, s.text)
    }
  }
  // A caption's words sent as data ('marks': { id, w }) are those of its masked text, when they line up.
  const marks = timed.marks as { captions?: { id: string; w: string[] }[] } | undefined
  if (marks?.captions?.some((c) => masked.has(c.id))) {
    const captions = marks.captions.map((c) => {
      const words = masked.get(c.id)?.split(/\s+/).filter(Boolean)
      return words && words.length === c.w.length ? { ...c, w: words } : c
    })
    timed = { ...timed, marks: { ...marks, captions } }
  }
  return walk(timed, forms, null) as R
}

/**
 * An AI answer that rewrites captions sent through maskRequest (§7.4, §7.6: Tidy captions' AI fix):
 * each caption whose text the request masked keeps the text it was sent with, its own words, so a
 * masked character is never stored over what was said and Uncover brings every word back; the
 * others keep the answer's text. `maskedSent` is maskRequest's output for `sent` (the same captions,
 * as the provider got them). `answer` itself when the request masked none.
 */
export function keepMaskedCaptions<S extends { id: string; text: string }>(answer: readonly S[], sent: readonly CaptionSegment[], maskedSent: readonly CaptionSegment[]): readonly S[] {
  const own = new Map(sent.map((s) => [s.id, s.text]))
  const masked = new Set(maskedSent.filter((s) => own.has(s.id) && own.get(s.id) !== s.text).map((s) => s.id))
  if (!masked.size) return answer
  return answer.map((s) => (masked.has(s.id) && own.get(s.id) !== s.text ? { ...s, text: own.get(s.id)! } : s))
}

