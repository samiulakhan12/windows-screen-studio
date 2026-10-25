/**
 * What transcription providers return, read into one shape (times in seconds from the start of
 * the part that was sent). Responses are checked field by field: anything malformed is dropped
 * or, when nothing usable is left, reported, never passed on.
 *
 * OpenAI: the audio transcriptions endpoint with response_format "verbose_json" and
 * timestamp_granularities ["segment", "word"] returns { language, duration, text, segments:
 * [{ id, start, end, text, ... }], words: [{ word, start, end }] }
 * (https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).
 * Gemini: generateContent with a response schema (GEMINI_TRANSCRIPT_SCHEMA) returns that JSON
 * as the text of the first candidate (https://ai.google.dev/gemini-api/docs/structured-output).
 */

export interface RawWord {
  text: string
  start: number
  end: number
}

export interface RawSegment {
  start: number
  end: number
  text: string
  words?: RawWord[]
}

export interface RawTranscript {
  /** BCP-47 language code when known. */
  language?: string
  segments: RawSegment[]
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

function readWords(list: unknown, limit: number, key: 'word' | 'text'): RawWord[] {
  if (!Array.isArray(list)) return []
  const out: RawWord[] = []
  for (const w of list) {
    if (!isObject(w) || typeof w[key] !== 'string') continue
    const text = cleanText(w[key] as string, 200)
    const t = times(w.start, w.end, limit)
    if (text && t) out.push({ text, ...t })
  }
  return out.sort((a, b) => a.start - b.start)
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
    // Text but no timings: the model does not give segments (only whisper-1 does).
    throw new Error('This transcription model returned text without timings. Choose whisper-1 as the transcription model in Settings.')
  }
  return { language: languageCode(json.language), segments }
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
    const words = readWords(s.words, limit, 'text').filter((w) => w.end >= t.start - 0.5 && w.start <= t.end + 0.5)
    segments.push({ ...t, text, ...(words.length ? { words } : {}) })
  }
  return { language: languageCode(json.language), segments: segments.sort((a, b) => a.start - b.start) }
}
