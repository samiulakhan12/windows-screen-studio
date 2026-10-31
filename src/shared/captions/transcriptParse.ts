/**
 * What transcription providers return, read into one shape (times in seconds from the start of
 * the part that was sent). Responses are checked field by field: anything malformed is dropped
 * or, when nothing usable is left, reported, never passed on.
 *
 * OpenAI: the audio transcriptions endpoint with response_format "verbose_json" and
 * timestamp_granularities ["segment", "word"] returns { language, duration, text, segments:
 * [{ id, start, end, text, ... }], words: [{ word, start, end }] }
 * (https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).
 * gpt-transcribe and later OpenAI models answer response_format "json" with { text, languages:
 * [{ code }], usage } and no times (parseOpenAiText; timed in transcriptTiming.ts).
 * Gemini: generateContent with a response schema (GEMINI_TRANSCRIPT_SCHEMA) returns that JSON
 * as the text of the first candidate (https://ai.google.dev/gemini-api/docs/structured-output).
 */
import { checkWordTimes } from './transcriptTiming'

export interface RawWord {
  text: string
  start: number
  end: number
  /** Its times are a guess (the provider gave none, or impossible ones): docs/design/transcription.md §3. */
  estimated?: true
}

export interface RawSegment {
  start: number
  end: number
  text: string
  words?: RawWord[]
  /** Who speaks ("Speaker 1"), when the provider labelled it (Gemini). */
  speaker?: string
}

export interface RawTranscript {
  /** BCP-47 language code when known. */
  language?: string
  segments: RawSegment[]
  /**
   * The answer had text but no times: one segment covering the whole part, without words. The
   * transcription job times it from the sound (transcriptTiming.timeTextPart).
   */
  untimed?: true
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Collapses whitespace; at most `max` characters. */
export const cleanText = (v: string, max = 2000): string => v.replace(/\s+/g, ' ').trim().slice(0, max)

/** Language names Whisper reports (it gives "english", not "en") for the languages people record in most. */
const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en', bengali: 'bn', hindi: 'hi', urdu: 'ur', arabic: 'ar', spanish: 'es', french: 'fr', german: 'de',
  italian: 'it', portuguese: 'pt', dutch: 'nl', russian: 'ru', ukrainian: 'uk', polish: 'pl', turkish: 'tr',
  chinese: 'zh', japanese: 'ja', korean: 'ko', vietnamese: 'vi', thai: 'th', indonesian: 'id', malay: 'ms',
  persian: 'fa', hebrew: 'he', greek: 'el', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi',
  czech: 'cs', romanian: 'ro', hungarian: 'hu', tamil: 'ta', telugu: 'te', marathi: 'mr', gujarati: 'gu',
  punjabi: 'pa', kannada: 'kn', malayalam: 'ml', nepali: 'ne', filipino: 'tl', tagalog: 'tl', swahili: 'sw'
}

/** A BCP-47 code from a code ("en", "pt-BR") or an English language name; undefined when unknown. */
export function languageCode(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(s)) {
    const [lang, ...rest] = s.split('-')
    return [lang.toLowerCase(), ...rest].join('-')
  }
  return LANGUAGE_NAMES[s.toLowerCase()]
}

/** A word or segment time pair, ordered and inside [0, limit]; null when unusable. */
function times(start: unknown, end: unknown, limit: number): { start: number; end: number } | null {
  if (!finite(start) || !finite(end)) return null
  const s = Math.min(Math.max(0, start), limit)
  const e = Math.min(Math.max(0, end), limit)
  if (e < s) return null
  return { start: s, end: e }
}

const byStart = (a: { start: number }, b: { start: number }): number => a.start - b.start

/** The usable words of `list`, sorted by start (or in the order sent, to check that order first). */
function readWords(list: unknown, limit: number, key: 'word' | 'text', sort = true): RawWord[] {
  if (!Array.isArray(list)) return []
  const out: RawWord[] = []
  for (const w of list) {
    if (!isObject(w) || typeof w[key] !== 'string') continue
    const text = cleanText(w[key] as string, 200)
    const t = times(w.start, w.end, limit)
    if (text && t) out.push({ text, ...t })
  }
  return sort ? out.sort(byStart) : out
}

/** Words of `words` whose middle lies in [start, end) (the last segment takes its end too). */
function wordsIn(words: readonly RawWord[], start: number, end: number, last: boolean): RawWord[] {
  return words.filter((w) => {
    const mid = (w.start + w.end) / 2
    return mid >= start && (mid < end || (last && mid <= end + 0.5))
  })
}

/**
 * An OpenAI verbose_json transcription of a part `partSeconds` long. Words come as one list
 * for the whole part and are handed to the segment they fall in.
 */
export function parseOpenAiTranscription(json: unknown, partSeconds: number): RawTranscript {
  if (!isObject(json)) throw new Error('The transcription service returned something that is not a transcript.')
  const limit = partSeconds + 1
  const words = readWords(json.words, limit, 'word')
  const segments: RawSegment[] = []
  const list = Array.isArray(json.segments) ? json.segments : []
  for (let i = 0; i < list.length; i++) {
    const s: unknown = list[i]
    if (!isObject(s) || typeof s.text !== 'string') continue
    const text = cleanText(s.text)
    const t = times(s.start, s.end, limit)
    if (!text || !t) continue
    const own = wordsIn(words, t.start, t.end, i === list.length - 1)
    segments.push({ ...t, text, ...(own.length ? { words: own } : {}) })
  }
  if (segments.length === 0 && typeof json.text === 'string' && cleanText(json.text)) {
    // Text but no timings (only whisper-1 gives segments): timed from the sound like a text answer.
    return parseOpenAiText(json, partSeconds)
  }
  return { language: languageCode(json.language), segments }
}

/**
 * Most text kept from a text-only answer per 30 s of its part (30 s of fast speech is well under
 * 1000 characters), so a model that loops over music cannot fill the transcript (§10).
 */
const TEXT_PER_30_SECONDS = 2000

/**
 * An OpenAI "json" transcription (gpt-transcribe and later: { text, languages: [{ code }], usage },
 * no times) of a part `partSeconds` long: one untimed segment over the whole part (empty when
 * nothing was said), and the first language detected.
 */
export function parseOpenAiText(json: unknown, partSeconds: number): RawTranscript {
  if (!isObject(json) || typeof json.text !== 'string') throw new Error('The transcription service returned something that is not a transcript.')
  const text = cleanText(json.text, TEXT_PER_30_SECONDS * Math.max(1, Math.ceil(partSeconds / 30) || 1))
  const detected = Array.isArray(json.languages) ? json.languages.map((l) => (isObject(l) ? languageCode(l.code) : undefined)).find(Boolean) : languageCode(json.language)
  const end = Math.max(0, partSeconds)
  return { ...(detected ? { language: detected } : {}), segments: text ? [{ start: 0, end, text }] : [], untimed: true }
}

/** Most speakers told apart in one part. */
const MAX_SPEAKERS = 20
const SPEAKER_RE = /^speaker\s*(\d{1,2})$/i

/**
 * Speaker labels of one part as "Speaker N": a "Speaker N" label (N 1..MAX_SPEAKERS) is kept, any
 * other label becomes the next free number in order of first appearance; segments without a
 * label stay without (docs/design/transcription.md §6.2).
 */
export function normalizeSpeakerLabels(segments: readonly RawSegment[]): RawSegment[] {
  const names = new Map<string, string>()
  const used = new Set<number>()
  for (const s of segments) {
    const m = s.speaker ? SPEAKER_RE.exec(s.speaker.trim()) : null
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= MAX_SPEAKERS) used.add(Number(m[1]))
  }
  return segments.map((s) => {
    const { speaker, ...rest } = s
    const raw = speaker?.trim()
    if (!raw) return rest
    const key = raw.toLowerCase()
    let name = names.get(key)
    if (!name) {
      const m = SPEAKER_RE.exec(raw)
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= MAX_SPEAKERS) name = `Speaker ${Number(m[1])}`
      else {
        let n = 1
        while (used.has(n)) n++
        if (n > MAX_SPEAKERS) return rest
        used.add(n)
        name = `Speaker ${n}`
      }
      names.set(key, name)
    }
    return { ...rest, speaker: name }
  })
}

/** The JSON a Gemini transcription answers with (responseJsonSchema). */
export const GEMINI_TRANSCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string', description: 'BCP-47 code of the spoken language, e.g. "en".' },
    segments: {
      type: 'array',
      description: 'What was said, in order, one sentence or short phrase per segment.',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'Seconds from the start of the audio when the segment starts.' },
          end: { type: 'number', description: 'Seconds from the start of the audio when the segment ends.' },
          text: { type: 'string', description: 'The words spoken, verbatim.' },
          speaker: { type: 'string', description: 'Who speaks: "Speaker 1" for the first voice heard, "Speaker 2" for the next, and so on; the same label for the same voice.' },
          words: {
            type: 'array',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } },
              required: ['text', 'start', 'end']
            }
          }
        },
        required: ['start', 'end', 'text']
      }
    }
  },
  required: ['segments']
} as const

/** Parses the text of a Gemini transcription answer (JSON per GEMINI_TRANSCRIPT_SCHEMA). */
export function parseGeminiTranscription(text: string, partSeconds: number): RawTranscript {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('The transcription service returned something that is not a transcript.')
  }
  if (!isObject(json) || !Array.isArray(json.segments)) throw new Error('The transcription service returned something that is not a transcript.')
  const limit = partSeconds + 1
  const segments: RawSegment[] = []
  for (const s of json.segments) {
    if (!isObject(s) || typeof s.text !== 'string') continue
    const text = cleanText(s.text)
    const t = times(s.start, s.end, limit)
    if (!text || !t) continue
    // In the order sent: words out of order are a sign of impossible times.
    const words = readWords(s.words, limit, 'text', false).filter((w) => w.end >= t.start - 0.5 && w.start <= t.end + 0.5)
    const speaker = typeof s.speaker === 'string' ? cleanText(s.speaker, 64) : ''
    // Impossible word times are replaced by an estimate (docs/design/transcription.md §4); kept ones are sorted.
    const checked = checkWordTimes({ ...t, text, ...(words.length ? { words } : {}), ...(speaker ? { speaker } : {}) })
    checked.words?.sort(byStart)
    segments.push(checked)
  }
  return { language: languageCode(json.language), segments: normalizeSpeakerLabels(segments.sort((a, b) => a.start - b.start)) }
}
