/**
 * The text reader helper's protocol (docs/design/auto-blur.md §5.2, §5.5, §5.8, §16.0): one JSON
 * object a line each way over stdin and stdout. Main parses every line the helper writes strictly:
 * an unknown key, a wrong type or a line over 16 MB gives null, never a throw, and nothing of the
 * line is logged (§10.6). Pure.
 */

export const OCR_PROTOCOL = 1

/** A rectangle in video pixels: x, y, width, height. */
export type Box = [x: number, y: number, w: number, h: number]

/** A model file the helper checks (size and SHA-256 of the buffer it parses) before parsing any. */
export interface ModelPin {
  file: string
  path: string
  bytes: number
  sha256: string
}

/** A region that moved between two analysed frames: its box, the shift (pixels, positive right and down), its score and the other candidates. */
export interface LookMove {
  box: Box
  dx: number
  dy: number
  score: number
  alt: [dx: number, dy: number, score: number][]
}

/** One analysed frame of the look pass: its time, whether it is a key frame, its changed tiles (bit string) and its moves. */
export interface LookFrame {
  t: number
  key: boolean
  tiles: string
  moves: LookMove[]
}

/** One recogniser's reading of a line: its text, confidence and each character's x-range. */
export interface ReadVariant {
  model: 'tiny' | 'small' | 'windows'
  text: string
  conf: number
  spans: [number, number][]
}

/** One text line of a read: its box and quad, its readings, the colour of the ring around it and the ring's spread. */
export interface ReadLine {
  box: Box
  quad: [number, number][]
  variants: ReadVariant[]
  ring: string
  spread: number
}

/** What a read returns: its lines, its QR codes and, when it stopped at a cap, the areas it did not finish. */
export interface ReadResult {
  t: number
  lines: ReadLine[]
  qr: { quad: [number, number][]; payload: string | null }[]
  partial?: Box[]
}

export interface Candidate {
  dx: number
  dy: number
  scale: number
}

export interface TrackMatch {
  track: number
  parts: (number | null)[]
  best: Candidate | null
  second: number
}

export type HelperCommand =
  | { op: 'open'; id: number; protocol: 1; reader: 'paddle' | 'windows'; models: ModelPin[]; ffmpeg: string }
  | { op: 'look'; id: number; video: string; k: number; step: number; from: number; to: number }
  | { op: 'read'; id: number; video: string; key: number; t: number; areas: Box[] }
  | { op: 'careful'; id: number; read: number; lines: number[] }
  | { op: 'release'; id: number; read: number }
  /** A follow session over [from, to] (to ≥ from), walked forward (dir 1) or backward from `to` (dir -1). */
  | { op: 'followOpen'; id: number; video: string; key: number; from: number; to: number; dir: 1 | -1 }
  | { op: 'track'; id: number; session: number; track: number; t: number; parts: Box[] }
  | { op: 'match'; id: number; session: number; t: number; tracks: { track: number; parts: number[]; candidates: Candidate[] }[] }
  | { op: 'closeSession'; id: number; session: number }
  | { op: 'cancel'; id: number; target: number }
  | { op: 'pause'; id: number }
  | { op: 'resume'; id: number }
  | { op: 'stop'; id: number }

export type HelperEvent =
  | { alive: number }
  | { id: number; opened: { protocol: number; version: string; reader: 'paddle' | 'windows' } }
  | { id: number; look: LookFrame[]; done: boolean }
  | { id: number; read: ReadResult }
  | { id: number; careful: ReadVariant[][] }
  | { id: number; session: { from: number; to: number; frames: number } }
  | { id: number; matched: TrackMatch[] }
  | { id: number; done: true }
  | { id: number; error: 'model' | 'read' | 'video' | 'tooLarge' | 'stopped' | 'cancelled' | 'panic' | 'bad-command' }

/** Longest line either side accepts. */
export const MAX_LINE = 16 * 1024 * 1024

const ERRORS = ['model', 'read', 'video', 'tooLarge', 'stopped', 'cancelled', 'panic', 'bad-command'] as const
const MODELS = ['tiny', 'small', 'windows'] as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const int = (v: unknown): v is number => num(v) && Number.isInteger(v) && v >= 0
/** `o` has exactly the keys `keys` (optional ones may be missing). */
function keysAre(o: Obj, keys: readonly string[], optional: readonly string[] = []): boolean {
  const own = Object.keys(o)
  for (const k of own) if (!keys.includes(k) && !optional.includes(k)) return false
  for (const k of keys) if (!(k in o)) return false
  return true
}
const arrayOf = <T>(v: unknown, ok: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every((x) => ok(x))
const isBox = (v: unknown): v is Box => Array.isArray(v) && v.length === 4 && v.every(num)
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(num)
const isTriple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(num)
const isCandidate = (v: unknown): v is Candidate => isObj(v) && keysAre(v, ['dx', 'dy', 'scale']) && num(v.dx) && num(v.dy) && num(v.scale)

const isMove = (v: unknown): v is LookMove => isObj(v) && keysAre(v, ['box', 'dx', 'dy', 'score', 'alt']) && isBox(v.box) && num(v.dx) && num(v.dy) && num(v.score) && arrayOf(v.alt, isTriple)
const isLookFrame = (v: unknown): v is LookFrame => isObj(v) && keysAre(v, ['t', 'key', 'tiles', 'moves']) && num(v.t) && typeof v.key === 'boolean' && typeof v.tiles === 'string' && arrayOf(v.moves, isMove)
const isVariant = (v: unknown): v is ReadVariant =>
  isObj(v) && keysAre(v, ['model', 'text', 'conf', 'spans']) && (MODELS as readonly unknown[]).includes(v.model) && typeof v.text === 'string' && num(v.conf) && arrayOf(v.spans, isPair)
const isLine = (v: unknown): v is ReadLine =>
  isObj(v) && keysAre(v, ['box', 'quad', 'variants', 'ring', 'spread']) && isBox(v.box) && arrayOf(v.quad, isPair) && arrayOf(v.variants, isVariant) && typeof v.ring === 'string' && /^#[0-9a-f]{6}$/.test(v.ring) && num(v.spread)
const isQr = (v: unknown): v is ReadResult['qr'][number] => isObj(v) && keysAre(v, ['quad', 'payload']) && arrayOf(v.quad, isPair) && (v.payload === null || typeof v.payload === 'string')
const isRead = (v: unknown): v is ReadResult =>
  isObj(v) && keysAre(v, ['t', 'lines', 'qr'], ['partial']) && num(v.t) && arrayOf(v.lines, isLine) && arrayOf(v.qr, isQr) && (v.partial === undefined || arrayOf(v.partial, isBox))
const isMatch = (v: unknown): v is TrackMatch =>
  isObj(v) && keysAre(v, ['track', 'parts', 'best', 'second']) && int(v.track) && Array.isArray(v.parts) && v.parts.every((p) => p === null || num(p)) && (v.best === null || isCandidate(v.best)) && num(v.second)

/** One line the helper wrote, read strictly; null for anything else (never throws). */
export function parseHelperEvent(line: string): HelperEvent | null {
  if (typeof line !== 'string' || line.length > MAX_LINE) return null
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObj(v)) return null
  if ('alive' in v) return keysAre(v, ['alive']) && int(v.alive) ? { alive: v.alive } : null
  if (!int(v.id)) return null
  const id = v.id
  if ('opened' in v) {
    const o = v.opened
    return keysAre(v, ['id', 'opened']) && isObj(o) && keysAre(o, ['protocol', 'version', 'reader']) && int(o.protocol) && typeof o.version === 'string' && (o.reader === 'paddle' || o.reader === 'windows')
      ? { id, opened: { protocol: o.protocol, version: o.version, reader: o.reader } }
      : null
  }
  if ('look' in v) return keysAre(v, ['id', 'look', 'done']) && arrayOf(v.look, isLookFrame) && typeof v.done === 'boolean' ? { id, look: v.look, done: v.done } : null
  if ('read' in v) return keysAre(v, ['id', 'read']) && isRead(v.read) ? { id, read: v.read } : null
  if ('careful' in v) return keysAre(v, ['id', 'careful']) && Array.isArray(v.careful) && v.careful.every((x) => arrayOf(x, isVariant)) ? { id, careful: v.careful as ReadVariant[][] } : null
  if ('session' in v) {
    const s = v.session
    return keysAre(v, ['id', 'session']) && isObj(s) && keysAre(s, ['from', 'to', 'frames']) && num(s.from) && num(s.to) && int(s.frames) ? { id, session: { from: s.from, to: s.to, frames: s.frames } } : null
  }
  if ('matched' in v) return keysAre(v, ['id', 'matched']) && arrayOf(v.matched, isMatch) ? { id, matched: v.matched } : null
  if ('error' in v) return keysAre(v, ['id', 'error']) && (ERRORS as readonly unknown[]).includes(v.error) ? { id, error: v.error as (typeof ERRORS)[number] } : null
  if ('done' in v) return keysAre(v, ['id', 'done']) && v.done === true ? { id, done: true } : null
  return null
}

const isPin = (v: unknown): v is ModelPin => isObj(v) && keysAre(v, ['file', 'path', 'bytes', 'sha256']) && typeof v.file === 'string' && typeof v.path === 'string' && int(v.bytes) && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256)
const isTrackAsk = (v: unknown): v is { track: number; parts: number[]; candidates: Candidate[] } =>
  isObj(v) && keysAre(v, ['track', 'parts', 'candidates']) && int(v.track) && arrayOf(v.parts, int) && arrayOf(v.candidates, isCandidate)

/** One command line read strictly (the helper's side, and the fake helper of the tests); null for anything else. */
export function parseHelperCommand(line: string): HelperCommand | null {
  if (typeof line !== 'string' || line.length > MAX_LINE) return null
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObj(v) || typeof v.op !== 'string' || !int(v.id)) return null
  const str = (x: unknown): x is string => typeof x === 'string'
  switch (v.op) {
    case 'open':
      return keysAre(v, ['op', 'id', 'protocol', 'reader', 'models', 'ffmpeg']) && v.protocol === OCR_PROTOCOL && (v.reader === 'paddle' || v.reader === 'windows') && arrayOf(v.models, isPin) && str(v.ffmpeg) ? (v as HelperCommand) : null
    case 'look':
      return keysAre(v, ['op', 'id', 'video', 'k', 'step', 'from', 'to']) && str(v.video) && num(v.k) && int(v.step) && num(v.from) && num(v.to) ? (v as HelperCommand) : null
    case 'read':
      return keysAre(v, ['op', 'id', 'video', 'key', 't', 'areas']) && str(v.video) && num(v.key) && num(v.t) && arrayOf(v.areas, isBox) ? (v as HelperCommand) : null
    case 'careful':
      return keysAre(v, ['op', 'id', 'read', 'lines']) && int(v.read) && arrayOf(v.lines, int) ? (v as HelperCommand) : null
    case 'release':
      return keysAre(v, ['op', 'id', 'read']) && int(v.read) ? (v as HelperCommand) : null
    case 'followOpen':
      return keysAre(v, ['op', 'id', 'video', 'key', 'from', 'to', 'dir']) && str(v.video) && num(v.key) && num(v.from) && num(v.to) && (v.dir === 1 || v.dir === -1) ? (v as HelperCommand) : null
    case 'track':
      return keysAre(v, ['op', 'id', 'session', 'track', 't', 'parts']) && int(v.session) && int(v.track) && num(v.t) && arrayOf(v.parts, isBox) ? (v as HelperCommand) : null
    case 'match':
      return keysAre(v, ['op', 'id', 'session', 't', 'tracks']) && int(v.session) && num(v.t) && arrayOf(v.tracks, isTrackAsk) ? (v as HelperCommand) : null
    case 'closeSession':
      return keysAre(v, ['op', 'id', 'session']) && int(v.session) ? (v as HelperCommand) : null
    case 'cancel':
      return keysAre(v, ['op', 'id', 'target']) && int(v.target) ? (v as HelperCommand) : null
    case 'pause':
    case 'resume':
    case 'stop':
      return keysAre(v, ['op', 'id']) ? (v as HelperCommand) : null
    default:
      return null
  }
}

/** The line that sends `c` (JSON on one line; the caller adds the newline). */
export function commandLine(c: HelperCommand): string {
  return JSON.stringify(c)
}
