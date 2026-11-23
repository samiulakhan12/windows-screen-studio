/**
 * Reading and writing covers and Find's choices (docs/design/auto-blur.md §4.3-4.6, §2.12): the
 * readers every project and preference goes through, private bleeps' kind markers, the legacy
 * shapes older Flown draws, merging past the limits, Home thumbnails and the count of private items.
 * Pure. Nothing a file covers is ever uncovered by reading it.
 */
import type { Bleep, Cover, FindRecord, NormRect, PrivacyPrefs, PrivateKind, Project, ProjectPrivacy, RejectedPlace, Shape } from '../types'
import { COVER_DARK, PRIVATE_KINDS, isPrivateKind } from './kinds'
import { MAX_KEYS_PER_COVER, coverSlack, drawnBox, keysWithin, parsePath, pathKeys, rememberKeys, simplifyKeys, unionBox, writePath, type CoverKey } from './coverPath'

/** At most this many covers in a project (§4.2). */
export const MAX_COVERS = 2000
/** At most this many keys in all of a project's covers (§4.2). */
export const MAX_KEYS = 200000
/** The ids of the shapes written for older Flown start with this (§4.6). */
export const LEGACY_PREFIX = '~cover:'
/** At most this many legacy shapes in a written project. */
export const MAX_LEGACY_SHAPES = 4000

/** A cover lasts at least this long (one frame at 60 fps is 16.7 ms). */
const MIN_COVER = 0.02
/** Smallest box side, normalised. */
const MIN_SIDE = 0.002
/** Most keys a rejected place keeps. */
const MAX_REJECTED_KEYS = 400
const MAX_REJECTED = 5000
const MAX_REGIONS = 5
const MAX_LIST = 200
const MAX_ENTRY = 80
const MAX_SAID_IDS = 2000
const MAX_THIN_SPANS = 2000

const HEX = /^#[0-9a-f]{6}$/
const GROUP = /^[A-Za-z0-9_-]{1,32}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
/** A bleep's id, as uniqueIds writes them. */
const BLEEP_ID = /^[^\u0000-\u001f]{1,64}$/
const REGION = /^[A-Z]{2}$/
const SIG = /^[0-9a-f]{64}$/
const READER = /^[a-z0-9+._-]{1,64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const floorMs = (v: number): number => Math.floor(v * 1000 + 1e-6) / 1000
const ceilMs = (v: number): number => Math.ceil(v * 1000 - 1e-6) / 1000

/** A key's box held inside the frame: x and y in 0..1 − MIN_SIDE, w and h at least MIN_SIDE and at most to the frame's edge. */
function clampKey(k: CoverKey): CoverKey {
  // Inside the frame already (written paths round outward by at most 0.0001): kept as it is.
  if (k.x >= 0 && k.y >= 0 && k.x <= 1 - MIN_SIDE && k.y <= 1 - MIN_SIDE && k.w >= MIN_SIDE && k.h >= MIN_SIDE && k.x + k.w <= 1 + 1e-9 && k.y + k.h <= 1 + 1e-9) return k
  const x = clamp(k.x, 0, 1 - MIN_SIDE)
  const y = clamp(k.y, 0, 1 - MIN_SIDE)
  // The far edges stay where they were when inside the frame, so clamping never shrinks what is inside it.
  const r = clamp(k.x + k.w, x + MIN_SIDE, 1)
  const b = clamp(k.y + k.h, y + MIN_SIDE, 1)
  return { t: k.t, x, y, w: r - x, h: b - y }
}

const unionKeys = (keys: readonly CoverKey[]): CoverKey => {
  let box: NormRect = keys[0]
  for (const k of keys) box = unionBox(box, k)
  return { t: keys[0].t, ...box }
}

/** At least MIN_COVER long, about its middle, held inside the recording; never dropped (§4.3). Times to the millisecond, start down and end up. */
export function widenShort(cover: Cover, duration: number): Cover {
  if (cover.end - cover.start >= MIN_COVER - 1e-9) return cover
  const dur = finite(duration) && duration > 0 ? duration : cover.end
  const mid = (cover.start + cover.end) / 2
  let start = mid - MIN_COVER / 2
  let end = mid + MIN_COVER / 2
  if (start < 0) {
    end -= start
    start = 0
  }
  if (end > dur) {
    start = Math.max(0, start - (end - dur))
    end = dur
  }
  start = floorMs(start)
  end = Math.min(dur, ceilMs(end))
  if (end - start < MIN_COVER - 1e-9 && dur >= MIN_COVER) {
    if (start + MIN_COVER <= dur) end = ceilMs(start + MIN_COVER)
    else start = floorMs(end - MIN_COVER)
  }
  return { ...cover, start, end }
}

/** One stored cover read, or null when it cannot be (no usable times or path). */
function readCover(v: Record<string, unknown>, dur: number): Cover | null {
  if (!finite(v.start) || !finite(v.end) || !(v.start < v.end) || typeof v.path !== 'string') return null
  const parsed = parsePath(v.path)
  if (!parsed || !parsed.length) return null
  let keys = parsed
  let changed = false
  for (let i = 0; i < parsed.length; i++) {
    const k = clampKey(parsed[i])
    if (k.x !== parsed[i].x || k.y !== parsed[i].y || k.w !== parsed[i].w || k.h !== parsed[i].h) {
      if (!changed) keys = parsed.slice()
      changed = true
      keys[i] = k
    }
  }
  if (keys.length > MAX_KEYS_PER_COVER) {
    keys = [unionKeys(keys)]
    changed = true
  }
  const start = clamp(v.start, 0, dur)
  const end = clamp(v.end, 0, dur)
  if (!(end > start) && !(dur > 0)) return null
  // A path inside the frame within the limits is kept as written; anything clamped or joined is written again.
  const path = changed ? writePath(keys) : v.path
  let cover: Cover = {
    id: v.id as string,
    start,
    end: end > start ? end : start,
    path,
    color: typeof v.color === 'string' && HEX.test(v.color) ? v.color : COVER_DARK
  }
  if (v.found === 'auto' || v.found === 'check') cover.found = v.found
  if (isPrivateKind(v.kind)) cover.kind = v.kind
  if (typeof v.group === 'string' && GROUP.test(v.group)) cover.group = v.group
  if (v.lost === true) cover.lost = true
  if (v.thin === true) cover.thin = true
  if (v.missed === true) cover.missed = true
  cover = widenShort(cover, dur)
  if (!changed) rememberKeys(cover, keys)
  return cover
}

/**
 * Stored covers (§4.3), in one linear pass: anything that is not an object, has no id (or a repeated
 * one), no finite start < end or a path that does not parse is dropped; times are clamped to the
 * recording and short covers widened; boxes are clamped to the frame; colours not '#rrggbb' read as
 * Dark; the optional fields are kept only when valid and unknown ones dropped. Past the limits it
 * merges and simplifies, only ever growing boxes and times. undefined for absent or empty input.
 */
export function readCovers(raw: unknown, duration: number): Cover[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined
  const dur = finite(duration) && duration > 0 ? duration : 0
  const ids = new Set<string>()
  let out: Cover[] = []
  for (const v of raw) {
    if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id) || ids.has(v.id)) continue
    const c = readCover(v, dur)
    if (!c) continue
    ids.add(c.id)
    out.push(c)
  }
  if (!out.length) return undefined
  if (out.length > MAX_COVERS) out = mergeCovers(out, MAX_COVERS)
  let total = 0
  for (const c of out) total += pathKeys(c).length
  if (total > MAX_KEYS) out = simplifyKeys(out, MAX_KEYS)
  return out
}

const nfcLine = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const s = v.normalize('NFC').trim()
  if (!s || s.length > MAX_ENTRY || /[\r\n\u2028\u2029]/.test(s) || /[\u0000-\u001f\u007f]/.test(s)) return null
  return s
}

/** Up to MAX_LIST entries of 1..80 characters, NFC, one line, each once. */
function readList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    const s = nfcLine(v)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= MAX_LIST) break
  }
  return out
}

function readKinds(raw: unknown): PrivateKind[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return PRIVATE_KINDS.filter((k) => raw.includes(k))
}

function readRegions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const v of raw) if (typeof v === 'string' && REGION.test(v) && !out.includes(v) && out.length < MAX_REGIONS) out.push(v)
  return out
}

/** "start end" pairs joined by ';', read like a path's times: at most MAX_THIN_SPANS, inside the recording, in order. */
function readSpans(raw: unknown, dur: number): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  const out: string[] = []
  let last = -Infinity
  for (const pair of raw.split(';')) {
    const f = pair.split(' ')
    if (f.length !== 2 || !f.every((x) => /^-?\d+(?:\.\d+)?$/.test(x))) return undefined
    const a = clamp(Number(f[0]), 0, dur)
    const b = clamp(Number(f[1]), 0, dur)
    if (!(b > a) || a < last) return undefined
    last = b
    out.push(`${floorMs(a)} ${ceilMs(b)}`)
    if (out.length >= MAX_THIN_SPANS) break
  }
  return out.length ? out.join(';') : undefined
}

const count = (v: unknown): number | undefined => (finite(v) && v >= 0 && Number.isInteger(v) ? v : undefined)

function readFindRecord(raw: unknown, dur: number): FindRecord | undefined {
  if (!isObj(raw) || typeof raw.at !== 'string' || !ISO.test(raw.at) || !Number.isFinite(Date.parse(raw.at))) return undefined
  const rec: FindRecord = { at: raw.at, kinds: readKinds(raw.kinds) ?? [], listened: raw.listened === true }
  if (typeof raw.captionsSig === 'string' && SIG.test(raw.captionsSig)) rec.captionsSig = raw.captionsSig
  if (typeof raw.reader === 'string' && READER.test(raw.reader)) rec.reader = raw.reader
  const failed = count(raw.failed)
  if (failed !== undefined) rec.failed = failed
  if (raw.stopped === true) rec.stopped = true
  if (finite(raw.readTo) && raw.readTo >= 0) rec.readTo = Math.min(raw.readTo, dur)
  const thin = readSpans(raw.thin, dur)
  if (thin) rec.thin = thin
  const suppressed = count(raw.suppressed)
  if (suppressed !== undefined) rec.suppressed = suppressed
  if (Array.isArray(raw.saidIds)) {
    const ids = [...new Set(raw.saidIds.filter((s): s is string => typeof s === 'string' && BLEEP_ID.test(s)))].slice(0, MAX_SAID_IDS)
    if (ids.length) rec.saidIds = ids
  }
  return rec
}

function readRejected(raw: unknown, dur: number): RejectedPlace[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: RejectedPlace[] = []
  for (const v of raw) {
    if (out.length >= MAX_REJECTED) break
    if (!isObj(v) || !isPrivateKind(v.kind) || !finite(v.start) || !finite(v.end) || typeof v.path !== 'string') continue
    const start = clamp(v.start, 0, dur)
    const end = clamp(v.end, 0, dur)
    if (!(end > start)) continue
    const keys = parsePath(v.path)
    if (!keys || !keys.length) continue
    // A longer removed path is simplified (only growing its boxes), never dropped.
    const path = writePath(keysWithin(keys.map(clampKey), MAX_REJECTED_KEYS))
    out.push({ kind: v.kind, start, end, path })
  }
  return out
}

/**
 * Find's choices and record for a project (§4.3): kinds from PRIVATE_KINDS; at most 5 regions of two
 * capital letters; at most 200 names and never-hide words of 1-80 characters (NFC, one line); `find`
 * with a valid ISO time; at most 5,000 rejected places. Unknown fields dropped. undefined when
 * absent or nothing is left.
 */
export function readPrivacy(raw: unknown, duration: number): ProjectPrivacy | undefined {
  if (!isObj(raw)) return undefined
  const dur = finite(duration) && duration > 0 ? duration : 0
  const out: ProjectPrivacy = {}
  const kinds = readKinds(raw.kinds)
  if (kinds) out.kinds = kinds
  const regions = readRegions(raw.regions)
  if (regions) out.regions = regions
  if (typeof raw.listen === 'boolean') out.listen = raw.listen
  const names = readList(raw.names)
  if (names) out.names = names
  const neverHide = readList(raw.neverHide)
  if (neverHide) out.neverHide = neverHide
  const find = readFindRecord(raw.find, dur)
  if (find) out.find = find
  const rejected = readRejected(raw.rejected, dur)
  if (rejected) out.rejected = rejected
  return Object.keys(out).length ? out : undefined
}

const COLOURS: readonly NonNullable<PrivacyPrefs['colour']>[] = ['ring', 'dark', 'light', 'black', 'white']

/** The `privacy` preference (§4.5), with readPrivacy's limits; null for anything that is not an object. */
export function readPrivacyPrefs(raw: unknown): PrivacyPrefs | null {
  if (!isObj(raw)) return null
  const out: PrivacyPrefs = {}
  const kinds = readKinds(raw.kinds)
  if (kinds) out.kinds = kinds
  const regions = readRegions(raw.regions)
  if (regions) out.regions = regions
  const names = readList(raw.names)
  if (names) out.names = names
  const neverHide = readList(raw.neverHide)
  if (neverHide) out.neverHide = neverHide
  const colour = COLOURS.find((c) => c === raw.colour)
  if (colour) out.colour = colour
  if (raw.showCovers === false) out.showCovers = false
  return out
}

/* ---------- private bleeps (§4.4) ---------- */

const PRIVATE_WORD = /^:([a-z]+)(?::([a-z0-9]{1,16}))?$/

/** A private bleep's word starts with ':' (no caption word's bleepKey ever does). */
export function isPrivateBleep(b: Pick<Bleep, 'word'>): boolean {
  return typeof b.word === 'string' && b.word.startsWith(':')
}

/** The word of a private bleep: ':' + kind, then ':' + its said text's group when it has one (':card:k3v9q2m8xa'). */
export function privateBleepWord(kind: PrivateKind, group: string): string {
  const g = typeof group === 'string' ? group.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) : ''
  return g ? `:${kind}:${g}` : `:${kind}`
}

/** The kind a private bleep hides, or null for any other bleep. */
export function privateKindOf(b: Pick<Bleep, 'word'>): PrivateKind | null {
  const m = typeof b.word === 'string' ? PRIVATE_WORD.exec(b.word) : null
  return m && isPrivateKind(m[1]) ? m[1] : null
}

/** The group of a private bleep's said text, or null (no group, or not a private bleep). */
export function privateGroupOf(b: Pick<Bleep, 'word'>): string | null {
  const m = typeof b.word === 'string' ? PRIVATE_WORD.exec(b.word) : null
  return m && isPrivateKind(m[1]) && m[2] ? m[2] : null
}

/* ---------- legacy shapes (§4.6) ---------- */

const area = (b: NormRect): number => Math.max(0, b.w) * Math.max(0, b.h)

/** The keys in effect over [start, end): the one active at the start, then each one after it before the end. */
function activeKeys(cover: Cover): CoverKey[] {
  const keys = pathKeys(cover)
  if (!keys.length) return []
  // Usually every key is in effect already: the parsed keys themselves (never changed by the callers).
  if (keys[0].t === cover.start && keys[keys.length - 1].t < cover.end) return keys as CoverKey[]
  let first = 0
  for (let i = 0; i < keys.length && keys[i].t <= cover.start; i++) first = i
  const out: CoverKey[] = [{ ...keys[first], t: cover.start }]
  for (let i = first + 1; i < keys.length && keys[i].t < cover.end; i++) if (keys[i].t > cover.start) out.push(keys[i])
  return out
}

/**
 * A cover cut into pieces for older Flown (§4.6): runs of keys whose union is at most 1.5 times the
 * area of the run's largest box, at most 4 (the last takes the rest); each from its first key's time
 * to the next piece's first key, widened by `slack` at both ends, with the union of its keys' boxes.
 */
export function legacyPieces(cover: Cover, slack: number): { start: number; end: number; box: NormRect }[] {
  const keys = activeKeys(cover)
  if (!keys.length) return []
  const runs: CoverKey[][] = []
  let run: CoverKey[] = []
  let box: NormRect | null = null
  let largest = 0
  for (const k of keys) {
    if (run.length && runs.length < 3) {
      const joined: NormRect = unionBox(box!, k)
      const big = Math.max(largest, area(k))
      if (area(joined) > 1.5 * big) {
        runs.push(run)
        run = []
        box = null
        largest = 0
      }
    }
    run.push(k)
    box = box ? unionBox(box, k) : { x: k.x, y: k.y, w: k.w, h: k.h }
    largest = Math.max(largest, area(k))
  }
  runs.push(run)
  return runs.map((r, i) => {
    let b: NormRect = r[0]
    for (const k of r) b = unionBox(b, k)
    const start = i === 0 ? cover.start : r[0].t
    const end = i === runs.length - 1 ? cover.end : runs[i + 1][0].t
    return { start: Math.max(0, start - slack), end: end + slack, box: { x: b.x, y: b.y, w: b.w, h: b.h } }
  })
}

/** The two shapes older Flown draws for one piece: a full-strength pixelate that never fades, then an opaque box over it. */
function pieceShapes(cover: Cover, n: number, p: { start: number; end: number; box: NormRect }): Shape[] {
  const at = { start: p.start, end: p.end, x: p.box.x, y: p.box.y, w: p.box.w, h: p.box.h }
  return [
    { id: `${LEGACY_PREFIX}${cover.id}:${n}:p`, kind: 'pixelate', ...at, color: cover.color, strokeWidth: 0, fill: true, opacity: 1, strength: 1 },
    { id: `${LEGACY_PREFIX}${cover.id}:${n}:r`, kind: 'rect', ...at, color: cover.color, strokeWidth: 0, fill: true, opacity: 1, strength: 1 }
  ]
}

/**
 * `project` itself when it has no covers; otherwise a copy whose shapes end with the legacy shapes
 * (§4.6), at most MAX_LEGACY_SHAPES: past that each cover's pieces are merged into one, the largest
 * covers first, and past half that many covers, covers are merged first.
 */
export function withLegacyShapes(project: Project): Project {
  let covers = project.covers
  if (!covers?.length) return project
  const slack = coverSlack(project.capture?.fps ?? 60)
  if (covers.length > MAX_LEGACY_SHAPES / 2) covers = mergeCovers(covers, MAX_LEGACY_SHAPES / 2)
  const pieces = covers.map((c) => legacyPieces(c, slack))
  let total = pieces.reduce((s, p) => s + 2 * p.length, 0)
  if (total > MAX_LEGACY_SHAPES) {
    const size = (c: Cover): number => {
      const b = drawnBox(c, (c.start + c.end) / 2, (c.end - c.start) / 2 + 1)
      return (b ? area(b) : 0) * (c.end - c.start)
    }
    const order = covers.map((_c, i) => i).sort((a, b) => size(covers![b]) - size(covers![a]))
    for (const i of order) {
      if (total <= MAX_LEGACY_SHAPES) break
      const p = pieces[i]
      if (p.length <= 1) continue
      let box = p[0].box
      for (const q of p) box = unionBox(box, q.box)
      total -= 2 * (p.length - 1)
      pieces[i] = [{ start: p[0].start, end: p[p.length - 1].end, box }]
    }
  }
  const legacy: Shape[] = []
  covers.forEach((c, i) => pieces[i].forEach((p, n) => legacy.push(...pieceShapes(c, n, p))))
  return { ...project, shapes: [...(project.shapes ?? []), ...legacy] }
}

/** A stored shapes list without the legacy shapes (anything else as it was). */
export function withoutLegacyShapes(shapes: unknown): unknown {
  if (!Array.isArray(shapes)) return shapes
  const kept = shapes.filter((s) => !(isObj(s) && typeof s.id === 'string' && s.id.startsWith(LEGACY_PREFIX)))
  return kept.length === shapes.length ? shapes : kept
}

/* ---------- merging (§5.10) ---------- */

/** A cover while merging: its keys in effect, kept in memory until the end. */
interface Merging {
  cover: Cover
  /** Its keys in effect, flat: t, x, y, w, h for each. */
  k: Float64Array
  merged: boolean
}

const flatKeys = (keys: readonly CoverKey[]): Float64Array => {
  const out = new Float64Array(keys.length * 5)
  keys.forEach((k, i) => {
    out[i * 5] = k.t
    out[i * 5 + 1] = k.x
    out[i * 5 + 2] = k.y
    out[i * 5 + 3] = k.w
    out[i * 5 + 4] = k.h
  })
  return out
}

const keysOfFlat = (f: Float64Array): CoverKey[] => {
  const out: CoverKey[] = []
  for (let i = 0; i < f.length; i += 5) out.push({ t: f[i], x: f[i + 1], y: f[i + 2], w: f[i + 3], h: f[i + 4] })
  return out
}

let scratch = new Float64Array(1024)

/** One cover holding both: whose drawn box contains each one's at every time (§5.10). Linear in their keys. */
function mergeTwo(a: Merging, b: Merging): Merging {
  const ka = a.k
  const kb = b.k
  const na = ka.length
  const nb = kb.length
  if (scratch.length < na + nb) scratch = new Float64Array(2 * (na + nb))
  const out = scratch
  let n = 0
  let i = 0
  let j = 0
  const ca = a.cover
  const cb = b.cover
  // Walk both key lists in time order, each holding its last key.
  while (i < na || j < nb) {
    const t = j >= nb || (i < na && ka[i] <= kb[j]) ? ka[i] : kb[j]
    while (i < na && ka[i] <= t) i += 5
    while (j < nb && kb[j] <= t) j += 5
    const hasA = i > 0 && t >= ca.start && t < ca.end
    const hasB = j > 0 && t >= cb.start && t < cb.end
    if (!hasA && !hasB) continue
    let x0: number, y0: number, x1: number, y1: number
    if (hasA && hasB) {
      x0 = Math.min(ka[i - 4], kb[j - 4])
      y0 = Math.min(ka[i - 3], kb[j - 3])
      x1 = Math.max(ka[i - 4] + ka[i - 2], kb[j - 4] + kb[j - 2])
      y1 = Math.max(ka[i - 3] + ka[i - 1], kb[j - 3] + kb[j - 1])
    } else {
      const s = hasA ? ka : kb
      const e = hasA ? i : j
      x0 = s[e - 4]
      y0 = s[e - 3]
      x1 = x0 + s[e - 2]
      y1 = y0 + s[e - 1]
    }
    const w = x1 - x0
    const h = y1 - y0
    if (n && out[n - 4] === x0 && out[n - 3] === y0 && out[n - 2] === w && out[n - 1] === h) continue
    out[n] = t
    out[n + 1] = x0
    out[n + 2] = y0
    out[n + 3] = w
    out[n + 4] = h
    n += 5
  }
  const first = ca.start <= cb.start ? ca : cb
  const cover: Cover = { id: first.id, start: Math.min(ca.start, cb.start), end: Math.max(ca.end, cb.end), path: '', color: first.color }
  // A cover the user owns stays the user's; otherwise the stricter tier wins.
  if (ca.found && cb.found) cover.found = ca.found === 'check' || cb.found === 'check' ? 'check' : 'auto'
  if (ca.kind && ca.kind === cb.kind) cover.kind = ca.kind
  else if (ca.kind && cb.kind && ca.found && cb.found) cover.kind = first.kind
  if (first.group) cover.group = first.group
  if (ca.lost || cb.lost) cover.lost = true
  if (ca.thin || cb.thin) cover.thin = true
  if (ca.missed && cb.missed) cover.missed = true
  return { cover, k: out.slice(0, n), merged: true }
}

const GRID = 8
/** Each cover's candidates: its nearest neighbours by start time among covers sharing a cell. */
const NEIGHBOURS = 8

interface Item {
  m: Merging
  /** Its envelope's edges. */
  x0: number
  y0: number
  x1: number
  y1: number
  /** The first of its members in the input: survivors keep the input's order. */
  rank: number
}

/** The grid cells (8 × 8 over the frame) a box touches. */
function cellsOf(b: NormRect): number[] {
  const x0 = clamp(Math.floor(b.x * GRID), 0, GRID - 1)
  const x1 = clamp(Math.floor((b.x + b.w) * GRID - 1e-9), 0, GRID - 1)
  const y0 = clamp(Math.floor(b.y * GRID), 0, GRID - 1)
  const y1 = clamp(Math.floor((b.y + b.h) * GRID - 1e-9), 0, GRID - 1)
  const out: number[] = []
  for (let y = y0; y <= y1; y++) for (let x = Math.max(0, x0); x <= x1; x++) out.push(y * GRID + x)
  return out
}

/**
 * One round of merging: each cover's candidates are its 8 nearest by start among the covers sharing
 * an 8 × 8 grid cell with it; the pairs come off a heap cheapest first, each cover at most once a
 * round, until `need` merges are made. The next round looks again around the merged covers. Returns
 * the covers after the round (a merged one in place of its first member).
 */
function mergeRound(items: Item[], need: number): Item[] {
  const n = items.length
  const starts = new Float64Array(n)
  for (let i = 0; i < n; i++) starts[i] = items[i].m.cover.start
  const byStart = Array.from({ length: n }, (_v, i) => i).sort((x, y) => starts[x] - starts[y] || x - y)
  // The cells of each cover, flat: cellsAt[cellFrom[i] .. cellFrom[i + 1]).
  const cellFrom = new Int32Array(n + 1)
  const cellList: number[] = []
  for (let i = 0; i < n; i++) {
    cellFrom[i] = cellList.length
    const it = items[i]
    for (const c of cellsOf({ x: it.x0, y: it.y0, w: it.x1 - it.x0, h: it.y1 - it.y0 })) cellList.push(c)
  }
  cellFrom[n] = cellList.length
  const cellsAt = Int32Array.from(cellList)
  // Each cell's covers in start order, flat (perCell offsets), and where each cover sits in each of its cells.
  const perCell = new Int32Array(GRID * GRID + 1)
  for (let q = 0; q < cellsAt.length; q++) perCell[cellsAt[q] + 1]++
  for (let c = 0; c < GRID * GRID; c++) perCell[c + 1] += perCell[c]
  const fill = perCell.slice(0, GRID * GRID)
  const lists = new Int32Array(cellsAt.length)
  const placeAt = new Int32Array(cellsAt.length)
  for (const i of byStart)
    for (let q = cellFrom[i]; q < cellFrom[i + 1]; q++) {
      const c = cellsAt[q]
      placeAt[q] = fill[c]
      lists[fill[c]++] = i
    }
  // Each cover's envelope edges, times, value (area × time) and kind class, for costing pairs.
  // Single precision is enough to order pairs by cost, and keeps these arrays small.
  const x0 = new Float32Array(n)
  const y0 = new Float32Array(n)
  const x1 = new Float32Array(n)
  const y1 = new Float32Array(n)
  const ends = new Float32Array(n)
  const worth = new Float32Array(n)
  const kindOf = new Int32Array(n)
  const kinds = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const it = items[i]
    const c = it.m.cover
    x0[i] = it.x0
    y0[i] = it.y0
    x1[i] = it.x1
    y1[i] = it.y1
    ends[i] = c.end
    worth[i] = (it.x1 - it.x0) * (it.y1 - it.y0) * (c.end - c.start)
    const kind = `${c.kind ?? ''}:${c.found ? 1 : 0}`
    let id = kinds.get(kind)
    if (id === undefined) kinds.set(kind, (id = kinds.size))
    kindOf[i] = id
  }
  // A pair's order: any kind after the same kind (by 10^6, more than any area × time), then the added area × time.
  const costOf = (a: number, b: number): number => {
    const w = Math.max(x1[a], x1[b]) - Math.min(x0[a], x0[b])
    const h = Math.max(y1[a], y1[b]) - Math.min(y0[a], y0[b])
    const t = Math.max(ends[a], ends[b]) - Math.fround(Math.min(starts[a], starts[b]))
    return (kindOf[a] === kindOf[b] ? 0 : 1e6) + w * h * t - worth[a] - worth[b]
  }
  // The pairs: cost and both covers.
  let cap = Math.max(16, n * NEIGHBOURS)
  let pk = new Float64Array(cap)
  let pa = new Int32Array(cap)
  let pb = new Int32Array(cap)
  let m = 0
  const addPair = (x: number, y: number): void => {
    if (m === cap) {
      cap *= 2
      const k2 = new Float64Array(cap)
      k2.set(pk)
      pk = k2
      const a2 = new Int32Array(cap)
      a2.set(pa)
      pa = a2
      const b2 = new Int32Array(cap)
      b2.set(pb)
      pb = b2
    }
    const a = x < y ? x : y
    const b = x < y ? y : x
    pk[m] = costOf(a, b)
    pa[m] = a
    pb[m] = b
    m++
  }
  // Candidates: walking out from the cover in each of its cells' lists, the nearest by start first; a pair both list once.
  const seen = new Int32Array(n).fill(-1)
  const chosen = new Int32Array(n * NEIGHBOURS).fill(-1)
  const left = new Int32Array(GRID * GRID)
  const right = new Int32Array(GRID * GRID)
  for (let i = 0; i < n; i++) {
    seen[i] = i
    const s0 = starts[i]
    const from = cellFrom[i]
    const cells = cellFrom[i + 1] - from
    for (let q = 0; q < cells; q++) {
      left[q] = placeAt[from + q] - 1
      right[q] = placeAt[from + q] + 1
    }
    let taken = 0
    while (taken < NEIGHBOURS) {
      let bestD = Infinity
      let bestO = -1
      let bestQ = -1
      let bestSide = 0
      for (let q = 0; q < cells; q++) {
        const c = cellsAt[from + q]
        const lo = perCell[c]
        const hi = perCell[c + 1]
        // Skip covers already listed from another cell.
        while (left[q] >= lo && seen[lists[left[q]]] === i) left[q]--
        while (right[q] < hi && seen[lists[right[q]]] === i) right[q]++
        if (left[q] >= lo) {
          const o = lists[left[q]]
          const d = s0 - starts[o]
          if (d < bestD || (d === bestD && o < bestO)) {
            bestD = d
            bestO = o
            bestQ = q
            bestSide = -1
          }
        }
        if (right[q] < hi) {
          const o = lists[right[q]]
          const d = starts[o] - s0
          if (d < bestD || (d === bestD && o < bestO)) {
            bestD = d
            bestO = o
            bestQ = q
            bestSide = 1
          }
        }
      }
      if (bestO < 0) break
      if (bestSide < 0) left[bestQ]--
      else right[bestQ]++
      seen[bestO] = i
      chosen[i * NEIGHBOURS + taken] = bestO
      taken++
      if (bestO < i) {
        let listed = false
        for (let q = bestO * NEIGHBOURS; q < (bestO + 1) * NEIGHBOURS; q++) if (chosen[q] === i) listed = true
        if (listed) continue
      }
      addPair(i, bestO)
    }
  }
  // No two covers share a cell: the neighbours by start time, wherever they are.
  if (!m) for (let k = 0; k + 1 < byStart.length; k++) addPair(byStart[k], byStart[k + 1])
  // The pairs cheapest first: sorted natively with each pair's index in the low bits of its cost
  // (a change of at most 2^-30 of the cost, so only near-ties can swap), or by a comparator past 2^22 pairs.
  const order = new Int32Array(m)
  if (m < 1 << 22) {
    const sorted = new Float64Array(m)
    const words = new Uint32Array(sorted.buffer)
    for (let k = 0; k < m; k++) {
      sorted[k] = pk[k]
      words[2 * k] = (words[2 * k] & ~0x3fffff) | k
    }
    sorted.sort()
    for (let k = 0; k < m; k++) order[k] = words[2 * k] & 0x3fffff
  } else {
    const idx = Array.from({ length: m }, (_v, k) => k).sort((x, y) => pk[x] - pk[y] || x - y)
    for (let k = 0; k < m; k++) order[k] = idx[k]
  }
  const used = new Uint8Array(n)
  const out: (Item | null)[] = items.slice()
  let made = 0
  for (let q = 0; q < m && made < need; q++) {
    const k = order[q]
    const x = pa[k]
    const y = pb[k]
    if (used[x] || used[y]) continue
    used[x] = 1
    used[y] = 1
    const ix = items[x]
    const iy = items[y]
    out[x] = { m: mergeTwo(ix.m, iy.m), x0: Math.min(ix.x0, iy.x0), y0: Math.min(ix.y0, iy.y0), x1: Math.max(ix.x1, iy.x1), y1: Math.max(ix.y1, iy.y1), rank: Math.min(ix.rank, iy.rank) }
    out[y] = null
    made++
  }
  return out.filter((it): it is Item => it !== null)
}

/**
 * The covers merged until there are at most `max` (§5.10, finding 7): the cheapest pairs first (the
 * same kind before any kind; cost = added area × added time), each cover's candidates its 8 nearest
 * by start among the covers sharing an 8 × 8 grid cell with it, in rounds that each take the
 * cheapest disjoint pairs and then look again around the merged covers. O(n log n) a round, and each
 * round at most halves the covers. Merging only grows boxes and times; no cover is dropped.
 */
export function mergeCovers(covers: readonly Cover[], max: number): Cover[] {
  if (covers.length <= max) return [...covers]
  let items: Item[] = covers.map((c, i) => {
    const keys = activeKeys(c)
    let x0 = keys.length ? Infinity : 0
    let y0 = keys.length ? Infinity : 0
    let x1 = keys.length ? -Infinity : 1
    let y1 = keys.length ? -Infinity : 1
    for (const k of keys) {
      x0 = Math.min(x0, k.x)
      y0 = Math.min(y0, k.y)
      x1 = Math.max(x1, k.x + k.w)
      y1 = Math.max(y1, k.y + k.h)
    }
    return { m: { cover: c, k: flatKeys(keys), merged: false }, x0, y0, x1, y1, rank: i }
  })
  while (items.length > Math.max(1, max)) {
    const before = items.length
    items = mergeRound(items, before - max)
    if (items.length === before) break
  }
  return items.sort((p, q) => p.rank - q.rank).map((it) => (it.m.merged ? { ...it.m.cover, path: writePath(keysWithin(keysOfFlat(it.m.k), MAX_KEYS_PER_COVER)) } : it.m.cover))
}

/* ---------- Home thumbnails and hiding (§9 rows 10 and 17) ---------- */

/** The time of a project's Home thumbnail: min(1 s, 15% of the recording). Main and Home both use it. */
export function thumbTime(duration: number): number {
  return Math.min(1, (finite(duration) && duration > 0 ? duration : 0) * 0.15)
}

/** The boxes to fill over a thumbnail taken in [from, to]: every cover and blur or pixelate shape active anywhere in it. */
export function thumbCovers(project: Project, from: number, to: number): NormRect[] {
  const out: NormRect[] = []
  const mid = (from + to) / 2
  const half = Math.max(0, (to - from) / 2)
  for (const c of project.covers ?? []) {
    const b = drawnBox(c, mid, half)
    if (b) out.push(b)
  }
  for (const s of project.shapes ?? []) {
    if (s.kind !== 'blur' && s.kind !== 'pixelate') continue
    if (!(s.start <= to && s.end > from)) continue
    const x = Math.min(s.x, s.x + s.w)
    const y = Math.min(s.y, s.y + s.h)
    out.push({ x, y, w: Math.abs(s.w), h: Math.abs(s.h) })
  }
  return out
}

/** Question 18 (§0): whether a crop counts as hiding part of the recordings. Answered (b): it does not. */
export const CROP_HIDES = false

/**
 * Whether the project hides any part of its recordings (§9 row 10): a cover, a blur or pixelate
 * shape, or a bleep (and the crop only if question 18 is answered (a)). The original recordings are
 * then never copied.
 */
export function hidesSomething(project: Pick<Project, 'covers' | 'shapes' | 'bleeps' | 'crop'>): boolean {
  if (project.covers?.length) return true
  if (project.bleeps?.length) return true
  if ((project.shapes ?? []).some((s) => s.kind === 'blur' || s.kind === 'pixelate')) return true
  return CROP_HIDES && !!project.crop
}

/** The unit every count of this feature uses (§2.12). */
export interface PrivateItems {
  /** Private items: groups of found covers, covers the user drew, groups of private bleeps. */
  items: number
  /** Items with a suggestion still waiting for review. */
  waiting: number
  /** Items with a Check suggestion waiting. */
  check: number
  /** Items said aloud (groups of private bleeps). */
  said: number
  /** Blur and pixelate shapes, which are not counted as hidden. */
  weak: number
}

/**
 * The project's private items (§2.12): one per group of found covers, one per cover without a
 * group, one per group of private bleeps (a said text). Ordinary bleeps are none; blur and pixelate
 * shapes count as `weak` only.
 */
export function privateItems(project: Pick<Project, 'covers' | 'bleeps' | 'shapes'>): PrivateItems {
  const groups = new Map<string, { waiting: boolean; check: boolean; said: boolean }>()
  let items = 0
  let waiting = 0
  let check = 0
  for (const c of project.covers ?? []) {
    if (!c.group) {
      items++
      if (c.found) waiting++
      if (c.found === 'check') check++
      continue
    }
    const g = groups.get(`c:${c.group}`) ?? { waiting: false, check: false, said: false }
    if (c.found) g.waiting = true
    if (c.found === 'check') g.check = true
    groups.set(`c:${c.group}`, g)
  }
  let lone = 0
  for (const b of project.bleeps ?? []) {
    if (!isPrivateBleep(b)) continue
    const group = privateGroupOf(b)
    const key = group ? `b:${group}` : `b:#${lone++}`
    const g = groups.get(key) ?? { waiting: false, check: false, said: true }
    if (b.auto) g.waiting = true
    groups.set(key, g)
  }
  let said = 0
  for (const g of groups.values()) {
    items++
    if (g.waiting) waiting++
    if (g.check) check++
    if (g.said) said++
  }
  const weak = (project.shapes ?? []).filter((s) => s.kind === 'blur' || s.kind === 'pixelate').length
  return { items, waiting, check, said, weak }
}
