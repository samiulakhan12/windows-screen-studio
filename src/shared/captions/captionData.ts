/**
 * Reading a stored transcript: segments and words inside the recording, sorted, with unique ids
 * and clean one-line text; anything that cannot be shown is dropped. One rule for loading a
 * project (engine/project.ts) and for what a provider returns (the Captions tab), like
 * engine/titleData.ts for title cards.
 */
import type { CaptionSegment, CaptionWord, Transcript } from '../types'

/** Shortest caption kept, seconds. */
export const MIN_CAPTION = 0.05
/** Longest caption text kept, in characters. */
export const CAPTION_MAX_CHARS = 500
/** Most captions a transcript keeps (about 4 hours of speech). */
export const MAX_CAPTIONS = 5000
/** Most word timings one caption keeps. */
const MAX_WORDS = 400

const KINDS: Transcript['provider'][] = ['openai', 'gemini', 'anthropic', 'local']
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Caption text as stored and drawn: one line (control characters and line breaks become spaces), single spaces, trimmed, at most CAPTION_MAX_CHARS. */
export const cleanCaptionText = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CAPTION_MAX_CHARS)

let idCounter = 0
export const newCaptionId = (): string => `cap${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** The word timings of a caption inside it (start..end), sorted; null when none are usable. */
function readWords(raw: unknown, start: number, end: number): CaptionWord[] | null {
  if (!Array.isArray(raw)) return null
  const out: CaptionWord[] = []
  for (const w of raw.slice(0, MAX_WORDS * 2)) {
    if (!w || typeof w !== 'object') continue
    const { text, start: ws, end: we, estimated, deleted } = w as Partial<CaptionWord>
    if (typeof text !== 'string' || !finite(ws) || !finite(we)) continue
    const t = cleanCaptionText(text)
    if (!t) continue
    const s = Math.min(Math.max(ws, start), end)
    out.push({ text: t, start: s, end: Math.min(Math.max(we, s), end), ...(estimated === true ? { estimated } : {}), ...(deleted === true ? { deleted } : {}) })
  }
  out.sort((a, b) => a.start - b.start)
  return out.length ? out.slice(0, MAX_WORDS) : null
}

/**
 * Stored captions inside a recording of `duration` seconds: sorted by start, clamped to the
 * recording, at least MIN_CAPTION long, not overlapping (a caption starts where the one before
 * ends at the earliest), with text, and with unique ids (missing or repeated ones are replaced).
 */
export function readCaptionSegments(raw: unknown, duration = Infinity): CaptionSegment[] {
  if (!Array.isArray(raw)) return []
  const items: CaptionSegment[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue
    const r = s as Partial<CaptionSegment>
    if (!finite(r.start) || !finite(r.end) || typeof r.text !== 'string') continue
    const text = cleanCaptionText(r.text)
    const start = Math.max(0, r.start)
    const end = Math.min(r.end, duration)
    if (!text || !(end - start >= MIN_CAPTION)) continue
    const seg: CaptionSegment = { id: typeof r.id === 'string' && r.id && r.id.length <= 64 ? r.id : '', start, end, text }
    const words = readWords(r.words, start, end)
    if (words) seg.words = words
    items.push(seg)
  }
  items.sort((a, b) => a.start - b.start || a.end - b.end)
  const out: CaptionSegment[] = []
  const ids = new Set<string>()
  for (const seg of items) {
    if (out.length >= MAX_CAPTIONS) break
    const prevEnd = out.length ? out[out.length - 1].end : 0
    if (seg.start < prevEnd) {
      if (seg.end - prevEnd < MIN_CAPTION) continue
      seg.start = prevEnd
      if (seg.words) {
        seg.words = seg.words.map((w) => (w.start < prevEnd ? { ...w, start: prevEnd, end: Math.max(w.end, prevEnd) } : w))
      }
    }
    if (!seg.id || ids.has(seg.id)) {
      let id = newCaptionId()
      while (ids.has(id)) id = newCaptionId()
      seg.id = id
    }
    ids.add(seg.id)
    out.push(seg)
  }
  return out
}

/**
 * A stored transcript, or undefined when it is not one (not an object, or no segment list).
 * Its captions are read with readCaptionSegments; an unknown provider reads as 'openai' (the
 * field only says where the captions came from).
 */
export function readTranscript(raw: unknown, duration = Infinity): Transcript | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Partial<Record<keyof Transcript, unknown>>
  if (!Array.isArray(r.segments)) return undefined
  const t: Transcript = {
    provider: KINDS.includes(r.provider as Transcript['provider']) ? (r.provider as Transcript['provider']) : 'openai',
    model: typeof r.model === 'string' ? r.model.slice(0, 200) : '',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt.slice(0, 64) : '',
    segments: readCaptionSegments(r.segments, duration)
  }
  if (typeof r.language === 'string' && r.language.length <= 35 && LANGUAGE.test(r.language)) t.language = r.language
  return t
}
