/**
 * The finder's cache in a project's `.cache/sounds.json` (docs/design/sound-finder.md §3.3): the
 * scores of each source, kept with what they were made from (the file's size and time, the model,
 * the scan version and the speech skipped), so a recording is listened to once. Main writes and
 * reads the file; both sides check every entry with readCacheEntry, as untrusted input.
 */
import { HOP_SECONDS, SCAN, SCORE_COLUMNS, SOUND_MODEL, WINDOW_SECONDS } from './sounds'

export const SOUNDS_CACHE_FILE = 'sounds.json'
/** Largest cache file read or written. */
export const SOUNDS_CACHE_MAX = 8 << 20
/** Longest recording listened to (4 h), and so most windows an entry may have. */
export const MAX_SCAN_SECONDS = 4 * 3600
export const MAX_WINDOWS = Math.ceil(MAX_SCAN_SECONDS / HOP_SECONDS) + 2

export interface SoundCacheEntry {
  /** The source file when it was listened to. */
  size: number
  mtimeMs: number
  /** SOUND_MODEL.sha256 and SCAN.version. */
  model: string
  scan: number
  /** skipKey of the speech ranges whose windows were not classified. */
  skip: string
  hop: number
  window: number
  columns: string[]
  n: number
  /** Base64 of n × columns bytes. */
  scores: string
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Standard base64 of `bytes` (no Buffer or btoa: the same in main, the renderer and tests). */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

/** The bytes of standard base64 `text`, or null when it is not base64 or decodes to more than `max` bytes. */
export function fromBase64(text: string, max: number): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !B64_RE.test(text)) return null
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const n = (text.length / 4) * 3 - pad
  if (!(n <= max)) return null
  const out = new Uint8Array(n)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (text[i + k] === '=' ? 0 : B64.indexOf(text[i + k])))
    const triple = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3]
    if (o < n) out[o++] = triple >> 16
    if (o < n) out[o++] = (triple >> 8) & 255
    if (o < n) out[o++] = triple & 255
  }
  return out
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A cache entry from anything: null unless every field is as written (the scores' length included). */
export function readCacheEntry(raw: unknown): SoundCacheEntry | null {
  if (!isObject(raw)) return null
  const { size, mtimeMs, model, scan, skip, hop, window, columns, n, scores } = raw
  if (!finite(size) || size < 0 || !finite(mtimeMs) || mtimeMs < 0) return null
  if (typeof model !== 'string' || !/^[0-9a-f]{64}$/.test(model) || !finite(scan) || !Number.isInteger(scan) || scan < 1) return null
  if (typeof skip !== 'string' || !/^([0-9a-f]{8}|none)$/.test(skip)) return null
  if (!finite(hop) || hop <= 0 || hop > 10 || !finite(window) || window <= 0 || window > 10) return null
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 64 || !columns.every((c) => typeof c === 'string' && /^[a-z]{1,16}$/.test(c))) return null
  if (!finite(n) || !Number.isInteger(n) || n < 0 || n > MAX_WINDOWS || typeof scores !== 'string') return null
  if (scores.length !== 4 * Math.ceil((n * columns.length) / 3)) return null
  if (!fromBase64(scores, n * columns.length)) return null
  return { size, mtimeMs, model, scan, skip, hop, window, columns: [...columns] as string[], n, scores }
}

/** Whether `e` holds this version's scores of the file as it is now, with the same speech skipped. */
export function cacheMatches(e: SoundCacheEntry, file: { size: number; mtimeMs: number }, skip: string): boolean {
  return (
    e.size === file.size &&
    e.mtimeMs === file.mtimeMs &&
    e.model === SOUND_MODEL.sha256 &&
    e.scan === SCAN.version &&
    e.skip === skip &&
    Math.abs(e.hop - HOP_SECONDS) < 1e-9 &&
    Math.abs(e.window - WINDOW_SECONDS) < 1e-9 &&
    e.columns.join() === SCORE_COLUMNS.join()
  )
}

/** The entry for freshly made scores. */
export function cacheEntry(file: { size: number; mtimeMs: number }, skip: string, n: number, scores: Uint8Array): SoundCacheEntry {
  return { size: file.size, mtimeMs: file.mtimeMs, model: SOUND_MODEL.sha256, scan: SCAN.version, skip, hop: HOP_SECONDS, window: WINDOW_SECONDS, columns: [...SCORE_COLUMNS], n, scores: toBase64(scores.subarray(0, n * SCORE_COLUMNS.length)) }
}

/** The scores of an entry readCacheEntry accepted. */
export const entryScores = (e: SoundCacheEntry): Uint8Array => fromBase64(e.scores, e.n * e.columns.length) ?? new Uint8Array(0)
