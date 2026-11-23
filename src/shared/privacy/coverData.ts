/**
 * Reading and writing covers and Find's choices (docs/design/auto-blur.md §4.3-4.6, §2.12): the
 * readers every project and preference goes through, private bleeps' kind markers, the legacy
 * shapes older Flown draws, merging past the limits, Home thumbnails and the count of private items.
 * Pure. Nothing a file covers is ever uncovered by reading it.
 */
import type { Bleep, Cover, FindRecord, NormRect, PrivacyPrefs, PrivateKind, Project, ProjectPrivacy, RejectedPlace, Shape } from '../types'
import { COVER_DARK, PRIVATE_KINDS, isPrivateKind } from './kinds'
import { MAX_KEYS_PER_COVER, coverSlack, drawnBox, keysWithin, parsePath, pathKeys, scanPath, simplifyKeys, unionBox, writePath, type CoverKey } from './coverPath'

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

/** Whether a key's box is inside the frame as clampKey keeps it (its fast check). */
const insideFrame = (x: number, y: number, w: number, h: number): boolean =>
  x >= 0 && y >= 0 && x <= 1 - MIN_SIDE && y <= 1 - MIN_SIDE && w >= MIN_SIDE && h >= MIN_SIDE && x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9

/**
 * One stored cover read, with its number of keys, or null when it cannot be (no usable times or
 * path). The path is checked without making its keys (scanPath); a path inside the frame within the
 * limits is kept as written, and its keys are made when they are first drawn (pathKeys).
 */
function readCover(v: Record<string, unknown>, dur: number): { cover: Cover; keys: number } | null {
  if (!finite(v.start) || !finite(v.end) || !(v.start < v.end) || typeof v.path !== 'string') return null
  const flat = scanPath(v.path)
  if (!flat || !flat.length) return null
  let count = flat.length / 5
  let changed = count > MAX_KEYS_PER_COVER
  for (let i = 0; i < flat.length && !changed; i += 5) {
    if (insideFrame(flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4])) continue
    const k = { t: flat[i], x: flat[i + 1], y: flat[i + 2], w: flat[i + 3], h: flat[i + 4] }
    const c = clampKey(k)
    if (c.x !== k.x || c.y !== k.y || c.w !== k.w || c.h !== k.h) changed = true
  }
  let path = v.path
  // Anything clamped or joined is written again.
  if (changed) {
    let keys = parsePath(v.path)!.map(clampKey)
    if (keys.length > MAX_KEYS_PER_COVER) keys = [unionKeys(keys)]
    path = writePath(keys)
    count = keys.length
  }
  const start = clamp(v.start, 0, dur)
  const end = clamp(v.end, 0, dur)
  if (!(end > start) && !(dur > 0)) return null
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
  return { cover, keys: count }
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
  let total = 0
  for (const v of raw) {
    if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id) || ids.has(v.id)) continue
    const r = readCover(v, dur)
    if (!r) continue
    ids.add(r.cover.id)
    out.push(r.cover)
    total += r.keys
  }
  if (!out.length) return undefined
  if (out.length > MAX_COVERS) {
    out = mergeCovers(out, MAX_COVERS)
    total = 0
    for (const c of out) total += pathKeys(c).length
  }
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

const GRID = 8
/** Each cover's candidates: its nearest neighbours by start time among covers sharing a cell. */
const NEIGHBOURS = 8
const LOST = 1
const THIN = 2
const MISSED = 4

/**
 * The covers while merging, in start order (ties by rank), as arrays: a merge makes no object, and
 * covers close in time sit close in memory, where their merges read them.
 */
interface Merging {
  n: number
  /** The input cover whose id, colour and group a cover keeps: its first member. */
  owner: Int32Array
  /** The first of its members in the input: survivors keep the input's order. */
  rank: Int32Array
  start: Float64Array
  end: Float64Array
  /** Its envelope's edges. */
  x0: Float64Array
  y0: Float64Array
  x1: Float64Array
  y1: Float64Array
  /** 0: the user's; 1: 'auto'; 2: 'check'. */
  found: Uint8Array
  /** 1 + its kind's place in `kinds`; 0: none. */
  kind: Int32Array
  /** LOST, THIN and MISSED. */
  flags: Uint8Array
  merged: Uint8Array
  /** Its keys in effect in `pool`, flat (t, x, y, w, h each): `keyLen[i]` numbers from `keyAt[i]`. */
  keyAt: Int32Array
  keyLen: Int32Array
  pool: Float64Array
  /** The first free place in `pool`. */
  top: number
}

function newMerging(n: number, poolSize: number): Merging {
  return {
    n,
    owner: new Int32Array(n),
    rank: new Int32Array(n),
    start: new Float64Array(n),
    end: new Float64Array(n),
    x0: new Float64Array(n),
    y0: new Float64Array(n),
    x1: new Float64Array(n),
    y1: new Float64Array(n),
    found: new Uint8Array(n),
    kind: new Int32Array(n),
    flags: new Uint8Array(n),
    merged: new Uint8Array(n),
    keyAt: new Int32Array(n),
    keyLen: new Int32Array(n),
    pool: new Float64Array(Math.max(16, poolSize)),
    top: 0
  }
}

/** Copies cover `i` of `from` to place `p` of `to`, its keys to the end of `to`'s pool. */
function copyMerging(from: Merging, i: number, to: Merging, p: number): void {
  to.owner[p] = from.owner[i]
  to.rank[p] = from.rank[i]
  to.start[p] = from.start[i]
  to.end[p] = from.end[i]
  to.x0[p] = from.x0[i]
  to.y0[p] = from.y0[i]
  to.x1[p] = from.x1[i]
  to.y1[p] = from.y1[i]
  to.found[p] = from.found[i]
  to.kind[p] = from.kind[i]
  to.flags[p] = from.flags[i]
  to.merged[p] = from.merged[i]
  const len = from.keyLen[i]
  to.pool.set(from.pool.subarray(from.keyAt[i], from.keyAt[i] + len), to.top)
  to.keyAt[p] = to.top
  to.keyLen[p] = len
  to.top += len
}

/**
 * Places 0 … n−1 ordered by start, then rank: a native sort of the starts with each place in the
 * low bits (which can only swap near-ties), then an insertion pass that puts those right.
 */
function orderByStart(start: Float64Array, rank: Int32Array): Int32Array {
  const n = start.length
  const order = new Int32Array(n)
  const before = (a: number, b: number): boolean => start[a] < start[b] || (start[a] === start[b] && rank[a] < rank[b])
  if (n >= 1 << 22) {
    const idx = Array.from({ length: n }, (_v, i) => i).sort((a, b) => start[a] - start[b] || rank[a] - rank[b])
    for (let i = 0; i < n; i++) order[i] = idx[i]
    return order
  }
  const packed = new Float64Array(n)
  const words = new Uint32Array(packed.buffer)
  for (let i = 0; i < n; i++) {
    packed[i] = start[i]
    words[2 * i] = (words[2 * i] & ~0x3fffff) | i
  }
  packed.sort()
  for (let i = 0; i < n; i++) order[i] = words[2 * i] & 0x3fffff
  for (let i = 1; i < n; i++) {
    const v = order[i]
    let j = i - 1
    while (j >= 0 && before(v, order[j])) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = v
  }
  return order
}

/** The covers in start order, each with its keys in effect and their envelope. */
function startMerging(covers: readonly Cover[], kinds: string[]): Merging {
  const n = covers.length
  const start = new Float64Array(n)
  const rank = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    start[i] = covers[i].start
    rank[i] = i
  }
  const order = orderByStart(start, rank)
  const keyLists: CoverKey[][] = new Array(n)
  let total = 0
  for (let p = 0; p < n; p++) {
    keyLists[p] = activeKeys(covers[order[p]])
    total += keyLists[p].length * 5
  }
  // Room for the keys, and for a round's merges after them (a merge writes at most both members' keys).
  const s = newMerging(n, 2 * total)
  const kindIds = new Map<string, number>()
  for (let p = 0; p < n; p++) {
    const i = order[p]
    const c = covers[i]
    const keys = keyLists[p]
    s.owner[p] = i
    s.rank[p] = i
    s.start[p] = c.start
    s.end[p] = c.end
    let x0 = keys.length ? Infinity : 0
    let y0 = keys.length ? Infinity : 0
    let x1 = keys.length ? -Infinity : 1
    let y1 = keys.length ? -Infinity : 1
    s.keyAt[p] = s.top
    for (const k of keys) {
      x0 = Math.min(x0, k.x)
      y0 = Math.min(y0, k.y)
      x1 = Math.max(x1, k.x + k.w)
      y1 = Math.max(y1, k.y + k.h)
      s.pool[s.top++] = k.t
      s.pool[s.top++] = k.x
      s.pool[s.top++] = k.y
      s.pool[s.top++] = k.w
      s.pool[s.top++] = k.h
    }
    s.keyLen[p] = s.top - s.keyAt[p]
    s.x0[p] = x0
    s.y0[p] = y0
    s.x1[p] = x1
    s.y1[p] = y1
    s.found[p] = c.found === 'check' ? 2 : c.found ? 1 : 0
    if (c.kind) {
      let id = kindIds.get(c.kind)
      if (id === undefined) {
        kinds.push(c.kind)
        kindIds.set(c.kind, (id = kinds.length))
      }
      s.kind[p] = id
    }
    s.flags[p] = (c.lost ? LOST : 0) | (c.thin ? THIN : 0) | (c.missed ? MISSED : 0)
  }
  return s
}

/**
 * Cover `y` merged into cover `x` (x before y in start order, so x is the first member): one cover
 * whose drawn box contains each one's at every time (§5.10). Linear in their keys; the merged keys
 * go to the end of the pool.
 */
function mergeInto(s: Merging, x: number, y: number): void {
  const pool = s.pool
  const ia = s.keyAt[x]
  const na = ia + s.keyLen[x]
  const ib = s.keyAt[y]
  const nb = ib + s.keyLen[y]
  const sa = s.start[x]
  const ea = s.end[x]
  const sb = s.start[y]
  const eb = s.end[y]
  const at = s.top
  let n = at
  let i = ia
  let j = ib
  // Walk both key lists in time order, each holding its last key.
  while (i < na || j < nb) {
    const t = j >= nb || (i < na && pool[i] <= pool[j]) ? pool[i] : pool[j]
    while (i < na && pool[i] <= t) i += 5
    while (j < nb && pool[j] <= t) j += 5
    const hasA = i > ia && t >= sa && t < ea
    const hasB = j > ib && t >= sb && t < eb
    if (!hasA && !hasB) continue
    let x0: number, y0: number, x1: number, y1: number
    if (hasA && hasB) {
      x0 = Math.min(pool[i - 4], pool[j - 4])
      y0 = Math.min(pool[i - 3], pool[j - 3])
      x1 = Math.max(pool[i - 4] + pool[i - 2], pool[j - 4] + pool[j - 2])
      y1 = Math.max(pool[i - 3] + pool[i - 1], pool[j - 3] + pool[j - 1])
    } else {
      const e = hasA ? i : j
      x0 = pool[e - 4]
      y0 = pool[e - 3]
      x1 = x0 + pool[e - 2]
      y1 = y0 + pool[e - 1]
    }
    const w = x1 - x0
    const h = y1 - y0
    if (n > at && pool[n - 4] === x0 && pool[n - 3] === y0 && pool[n - 2] === w && pool[n - 1] === h) continue
    pool[n] = t
    pool[n + 1] = x0
    pool[n + 2] = y0
    pool[n + 3] = w
    pool[n + 4] = h
    n += 5
  }
  s.keyAt[x] = at
  s.keyLen[x] = n - at
  s.top = n
  // A cover the user owns stays the user's; otherwise the stricter tier wins.
  const fx = s.found[x]
  const fy = s.found[y]
  const kx = s.kind[x]
  const ky = s.kind[y]
  s.found[x] = fx && fy ? Math.max(fx, fy) : 0
  s.kind[x] = kx && (kx === ky || (ky && fx && fy)) ? kx : 0
  s.flags[x] = ((s.flags[x] | s.flags[y]) & (LOST | THIN)) | (s.flags[x] & s.flags[y] & MISSED)
  s.start[x] = Math.min(sa, sb)
  s.end[x] = Math.max(ea, eb)
  s.x0[x] = Math.min(s.x0[x], s.x0[y])
  s.y0[x] = Math.min(s.y0[x], s.y0[y])
  s.x1[x] = Math.max(s.x1[x], s.x1[y])
  s.y1[x] = Math.max(s.y1[x], s.y1[y])
  s.rank[x] = Math.min(s.rank[x], s.rank[y])
  s.merged[x] = 1
}

/** The first and last of the 8 grid columns (or rows) across the frame that a span from `lo` to `hi` touches. */
const cellSpan = (lo: number, hi: number): [number, number] => [clamp(Math.floor(lo * GRID), 0, GRID - 1), clamp(Math.floor(hi * GRID - 1e-9), 0, GRID - 1)]

/**
 * One round of merging: each cover's candidates are its 8 nearest by start among the covers sharing
 * an 8 × 8 grid cell with it; the pairs are taken cheapest first, each cover at most once a round,
 * until `need` merges are made. The next round looks again around the merged covers. Returns the
 * covers after the round (a merged one in place of its first member), in start order.
 */
function mergeRound(s: Merging, need: number): Merging {
  const n = s.n
  const { start: starts, end: ends, x0, y0, x1, y1 } = s
  // The cells of each cover, flat: cellsAt[cellFrom[i] .. cellFrom[i + 1]).
  const cellFrom = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) {
    const [cx0, cx1] = cellSpan(x0[i], x1[i])
    const [cy0, cy1] = cellSpan(y0[i], y1[i])
    cellFrom[i + 1] = cellFrom[i] + Math.max(0, cx1 - cx0 + 1) * Math.max(0, cy1 - cy0 + 1)
  }
  const cellsAt = new Int32Array(cellFrom[n])
  for (let i = 0; i < n; i++) {
    const [cx0, cx1] = cellSpan(x0[i], x1[i])
    const [cy0, cy1] = cellSpan(y0[i], y1[i])
    let q = cellFrom[i]
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cellsAt[q++] = cy * GRID + cx
  }
  // Each cell's covers in start order, flat (perCell offsets), and where each cover sits in each of its cells.
  const perCell = new Int32Array(GRID * GRID + 1)
  for (let q = 0; q < cellsAt.length; q++) perCell[cellsAt[q] + 1]++
  for (let c = 0; c < GRID * GRID; c++) perCell[c + 1] += perCell[c]
  const fill = perCell.slice(0, GRID * GRID)
  const lists = new Int32Array(cellsAt.length)
  const placeAt = new Int32Array(cellsAt.length)
  for (let i = 0; i < n; i++)
    for (let q = cellFrom[i]; q < cellFrom[i + 1]; q++) {
      const c = cellsAt[q]
      placeAt[q] = fill[c]
      lists[fill[c]++] = i
    }
  // Each cover's value (area × time) and class (kind and tier), for costing pairs.
  const worth = new Float64Array(n)
  const classOf = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    worth[i] = (x1[i] - x0[i]) * (y1[i] - y0[i]) * (ends[i] - starts[i])
    classOf[i] = s.kind[i] * 2 + (s.found[i] ? 1 : 0)
  }
  // A pair's order: another class after the same class (by 10^6, more than any area × time), then the added area × time.
  const costOf = (a: number, b: number): number => {
    const w = Math.max(x1[a], x1[b]) - Math.min(x0[a], x0[b])
    const h = Math.max(y1[a], y1[b]) - Math.min(y0[a], y0[b])
    const t = Math.max(ends[a], ends[b]) - Math.min(starts[a], starts[b])
    return (classOf[a] === classOf[b] ? 0 : 1e6) + w * h * t - worth[a] - worth[b]
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
  if (!m) for (let k = 0; k + 1 < n; k++) addPair(k, k + 1)
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
  const gone = new Uint8Array(n)
  let made = 0
  for (let q = 0; q < m && made < need; q++) {
    const k = order[q]
    const x = pa[k]
    const y = pb[k]
    if (used[x] || used[y]) continue
    used[x] = 1
    used[y] = 1
    mergeInto(s, x, y)
    gone[y] = 1
    made++
  }
  // The survivors, kept in start order with their keys side by side, and room for the next round's merges.
  let keys = 0
  for (let i = 0; i < n; i++) if (!gone[i]) keys += s.keyLen[i]
  const next = newMerging(n - made, 2 * keys)
  let p = 0
  for (let i = 0; i < n; i++) if (!gone[i]) copyMerging(s, i, next, p++)
  // A merged cover keeps its first member's start, so the order holds unless ranks swapped among equal starts.
  for (let i = 1; i < next.n; i++) {
    if (next.start[i - 1] < next.start[i] || (next.start[i - 1] === next.start[i] && next.rank[i - 1] < next.rank[i])) continue
    const again = orderByStart(next.start, next.rank)
    const sortedNext = newMerging(next.n, next.pool.length)
    for (let r = 0; r < next.n; r++) copyMerging(next, again[r], sortedNext, r)
    return sortedNext
  }
  return next
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
  const kinds: string[] = []
  let s = startMerging(covers, kinds)
  while (s.n > Math.max(1, max)) {
    const before = s.n
    s = mergeRound(s, before - max)
    if (s.n === before) break
  }
  const out: { rank: number; cover: Cover }[] = []
  for (let i = 0; i < s.n; i++) {
    const own = covers[s.owner[i]]
    if (!s.merged[i]) {
      out.push({ rank: s.rank[i], cover: own })
      continue
    }
    const keys: CoverKey[] = []
    for (let k = s.keyAt[i]; k < s.keyAt[i] + s.keyLen[i]; k += 5) keys.push({ t: s.pool[k], x: s.pool[k + 1], y: s.pool[k + 2], w: s.pool[k + 3], h: s.pool[k + 4] })
    const cover: Cover = { id: own.id, start: s.start[i], end: s.end[i], path: writePath(keysWithin(keys, MAX_KEYS_PER_COVER)), color: own.color }
    if (s.found[i]) cover.found = s.found[i] === 2 ? 'check' : 'auto'
    if (s.kind[i]) cover.kind = kinds[s.kind[i] - 1] as PrivateKind
    if (own.group) cover.group = own.group
    if (s.flags[i] & LOST) cover.lost = true
    if (s.flags[i] & THIN) cover.thin = true
    if (s.flags[i] & MISSED) cover.missed = true
    out.push({ rank: s.rank[i], cover })
  }
  return out.sort((p, q) => p.rank - q.rank).map((o) => o.cover)
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
