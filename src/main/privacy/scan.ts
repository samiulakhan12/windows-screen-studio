/**
 * Find private info in main (docs/design/auto-blur.md §5): the look pass, the plan of reads, the
 * reads with the text rules in their worker and the careful pass, the walks that follow each found
 * text, and the covers that leave for the renderer, which hold no text (D5). Also *Follow what is
 * under it*, the text under a cover and *Cover this text everywhere* (§5.9), which share the helper
 * and its queue, ahead of Find's reads.
 *
 * The screen's text lives only here and in the helper: lines, raw texts and templates are dropped when
 * a run ends; only the folded text of each read line, with its frame and box, is kept, for 10 minutes,
 * for *Cover this text everywhere* (§5.7, D22), and cleared earlier by forgetReads (Stop, the editor
 * closing, the page going away, a new Find). Nothing of it is written, logged or sent.
 *
 * The helper itself is part P2's (readerHelper.ts, readerModels.ts): it reaches the scan through
 * `setReaderStart`, or a test's `ScanDeps.helper`.
 */
import path from 'node:path'
import type { EverywhereRequest, EverywhereResult, FindFailure, FindProgress, FindRequest, FindResult, FollowRequest, FollowResult, FoundCover, UnderCoverRequest, UnderCoverResult } from '../../shared/api/privacy'
import { stepKeys, writePath } from '../../shared/privacy/coverPath'
import { foldText } from '../../shared/privacy/detect/clean'
import { groupKeyOf, type DetectOptions, type Hit } from '../../shared/privacy/detect/detect'
import { compileNames, looksLikeName } from '../../shared/privacy/detect/names'
import { charRanges, meanCharWidth, padOf } from '../../shared/privacy/detect/score'
import { foundColour, groupExtras, hideLength } from '../../shared/privacy/found'
import { COVER_DARK } from '../../shared/privacy/kinds'
import { addLookFrames, clip, emptyLook, frameNear, intersect, keyBefore, lookScale, lookStep, overlaps, regionsAt, union, type LookData, type Size } from '../../shared/privacy/look'
import { findNotices } from '../../shared/privacy/notices'
import { followAll, partsOf, type IndexedRead, type Matcher, type Placed, type ReadIndex, type Track } from '../../shared/privacy/paths'
import { addRead, hintsOf, planReads, readBudget, secondEstimate, spansOf, type PlannedRead, type ReadHints, type ReadPlan } from '../../shared/privacy/plan'
import type { Box, Candidate, HelperCommand, LookFrame, ModelPin, ReadLine, ReadResult, ReadVariant, TrackMatch } from '../../shared/privacy/protocol'
import { READER_ID } from '../../shared/privacy/readerCatalog'
import type { CursorTrack, Project } from '../../shared/types'
import { ffmpegPath } from '../ffmpeg'
import * as projects from '../projects'
import { lookKeyOf, readLookCache, writeLookCache } from './lookCache'
import { RulesHost } from './rulesHost'

/* ---------- the helper, as the scan uses it (P2's OcrHelper answers to this) ---------- */

type Bare<O extends HelperCommand['op']> = Omit<Extract<HelperCommand, { op: O }>, 'op' | 'id'>

/** A follow session (§5.8, D26): templates per track, matches per frame. */
export interface ScanSession {
  track(track: number, t: number, parts: readonly Box[]): Promise<void>
  match(t: number, tracks: readonly { track: number; parts: readonly number[]; candidates: readonly Candidate[] }[]): Promise<TrackMatch[]>
  close(): Promise<void>
}

/** The text reader helper (P2's OcrHelper), started and with its models open. */
export interface ScanHelper {
  open(pins: ModelPin[], ffmpeg: string, reader?: 'paddle' | 'windows'): Promise<void>
  look(req: Bare<'look'>, onFrames: (f: LookFrame[]) => void, signal: AbortSignal): Promise<void>
  read(req: Bare<'read'>, signal: AbortSignal): Promise<{ id: number; result: ReadResult }>
  careful(readId: number, lines: readonly number[]): Promise<ReadVariant[][]>
  release(readId: number): void
  followOpen(req: Bare<'followOpen'>, signal: AbortSignal): Promise<ScanSession>
  pause(): void
  resume(): void
  stop(): Promise<void>
  kill(): void
  readonly exited: Promise<number | null>
}

/** Why there is no helper: no reader (missing or damaged models) or no helper on this PC. */
export class ScanUnavailable extends Error {
  constructor(readonly reason: 'reader' | 'helper') {
    super(`privacy: ${reason}`)
    this.name = 'ScanUnavailable'
  }
}

/** A read whose rules took longer than their limit (§10.3): failed, its areas covered. */
class RulesTimeout extends Error {}

/** The rules as the scan uses them (RulesHost; tests give their own). */
export interface ScanRules {
  detect(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions): Promise<Hit[] | 'timeout'>
  detectCareful(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions): Promise<{ hits: Hit[]; careful: number[] } | 'timeout'>
  close(): void
}

export interface ScanDeps {
  /** A started helper with the reader's models open; with `models` false, one for following by template alone. Rejects with ScanUnavailable. */
  helper?: (models: boolean) => Promise<ScanHelper>
  projectDir?: (id: string) => string
  readProject?: (id: string) => Promise<Project>
  readCursor?: (id: string) => Promise<CursorTrack | null>
  ffmpeg?: () => string
  now?: () => number
  /** Whether Flown is recording (Find waits, and pauses the helper while it does, §5.11). */
  recording?: () => boolean
  rules?: () => ScanRules
  random?: () => number
  /** This PC's decode speed, measured on the look pass (ms a 1080p frame, one thread). */
  recordDecode?: (msPerFrame1080: number) => void
  /** Counts and times only (§10.6). */
  log?: (line: string) => void
}

let readerStart: ((models: boolean) => Promise<ScanHelper>) | null = null

/** How the scan starts the text reader (P2's readerHelper and readerModels; null: no reader in this build). */
export function setReaderStart(start: ((models: boolean) => Promise<ScanHelper>) | null): void {
  readerStart = start
}

interface Deps {
  helper: (models: boolean) => Promise<ScanHelper>
  projectDir: (id: string) => string
  readProject: (id: string) => Promise<Project>
  readCursor: (id: string) => Promise<CursorTrack | null>
  ffmpeg: () => string
  now: () => number
  recording: () => boolean
  rules: () => ScanRules
  random: () => number
  recordDecode: (ms: number) => void
  log: (line: string) => void
}

function withDefaults(d: ScanDeps): Deps {
  return {
    helper: d.helper ?? ((models) => (readerStart ? readerStart(models) : Promise.reject(new ScanUnavailable('reader')))),
    projectDir: d.projectDir ?? ((id) => projects.projectDir(id)),
    readProject: d.readProject ?? ((id) => projects.readProject(id)),
    readCursor: d.readCursor ?? ((id) => projects.readCursor(id).catch(() => null)),
    ffmpeg: d.ffmpeg ?? (() => ffmpegPath()),
    now: d.now ?? Date.now,
    recording: d.recording ?? (() => false),
    rules: d.rules ?? (() => new RulesHost()),
    random: d.random ?? Math.random,
    recordDecode: d.recordDecode ?? (() => undefined),
    log: d.log ?? ((line) => console.info(line))
  }
}

/* ---------- one helper for Find, Follow and Everywhere (§5.1) ---------- */

interface Shared {
  helper: ScanHelper
  users: number
  /** Follow and Everywhere at work: Find sends no new read meanwhile (they go ahead of its reads). */
  urgent: number
  waiters: (() => void)[]
}

let shared: Shared | null = null
let starting: Promise<Shared> | null = null

async function acquire(start: (models: boolean) => Promise<ScanHelper>, models: boolean): Promise<Shared> {
  if (shared) {
    shared.users++
    return shared
  }
  if (!starting)
    starting = start(models).then(
      (helper) => {
        shared = { helper, users: 0, urgent: 0, waiters: [] }
        starting = null
        return shared
      },
      (err) => {
        starting = null
        throw err
      }
    )
  const s = await starting
  s.users++
  return s
}

async function release(s: Shared): Promise<void> {
  s.users--
  if (s.users > 0) return
  if (shared === s) shared = null
  await s.helper.stop().catch(() => s.helper.kill())
}

const urgentBegin = (s: Shared): void => void s.urgent++
function urgentEnd(s: Shared): void {
  s.urgent = Math.max(0, s.urgent - 1)
  if (!s.urgent) for (const w of s.waiters.splice(0)) w()
}
const urgentDone = (s: Shared): Promise<void> => (s.urgent ? new Promise((resolve) => s.waiters.push(resolve)) : Promise.resolve())

/* ---------- what is kept after a run (D22) ---------- */

/** How long the folded texts of the last Find are kept after it ends. */
export const KEEP_MS = 10 * 60 * 1000

interface KeptRead {
  t: number
  areas: Box[]
  lines: { box: Box; texts: string[] }[]
}

let kept: { projectId: string; until: number; reads: KeptRead[] } | null = null
let keptTimer: ReturnType<typeof setTimeout> | null = null
/** The text read under a cover for *Cover this text everywhere*, by request id (§5.9 step 1). */
const under = new Map<string, { projectId: string; text: string; until: number }>()

/** Forgets every text kept: the last Find's folded reads and the texts read under covers. */
export function forgetReads(): void {
  kept = null
  under.clear()
  if (keptTimer) clearTimeout(keptTimer)
  keptTimer = null
}

function keepReads(projectId: string, reads: KeptRead[], now: number): void {
  forgetReads()
  kept = { projectId, until: now + KEEP_MS, reads }
  keptTimer = setTimeout(forgetReads, KEEP_MS)
  keptTimer.unref?.()
}

function keptFor(projectId: string, now: number): KeptRead[] | null {
  if (!kept || kept.projectId !== projectId) return null
  if (now > kept.until) {
    kept = null
    return null
  }
  return kept.reads
}

/** How many lines' folded texts are kept for `projectId` now (tests). */
export function keptLines(projectId: string, now = Date.now()): number {
  return (keptFor(projectId, now) ?? []).reduce((n, r) => n + r.lines.length, 0)
}

/** Whether a text read under a cover is kept for this request (tests). */
export function underKept(requestId: string): boolean {
  return under.has(requestId)
}

/* ---------- small helpers ---------- */

const floorMs = (t: number): number => Math.floor(t * 1000 + 1e-6) / 1000
const ceilMs = (t: number): number => Math.ceil(t * 1000 - 1e-6) / 1000
const toNormBox = (b: Box, size: Size): { x: number; y: number; w: number; h: number } => {
  const c = clip(b, size)
  return { x: c[0] / size.width, y: c[1] / size.height, w: c[2] / size.width, h: c[3] / size.height }
}
const pathOfBox = (t: number, b: Box, size: Size): string => writePath([{ t, ...toNormBox(b, size) }])
const randomGroup = (random: () => number): string => {
  let s = ''
  for (let i = 0; i < 12; i++) s += Math.floor(Math.min(0.999999, Math.max(0, random())) * 36).toString(36)
  return s
}
/** Share of `box` inside the union of `areas`. */
function coverage(areas: readonly Box[], box: Box): number {
  const a = box[2] * box[3]
  if (!(a > 0)) return 0
  let inside = 0
  for (const r of areas) {
    const i = intersect(r, box)
    if (i) inside += i[2] * i[3]
  }
  return Math.min(1, inside / a)
}
const bestVariant = (l: ReadLine): ReadVariant | undefined => l.variants.reduce<ReadVariant | undefined>((b, v) => (!b || v.conf > b.conf ? v : b), undefined)

/** A hit as a walk starts from it: its own box, its line, its character width and padding, its own text. */
function hitShape(hit: Hit, lines: readonly ReadLine[]): { own: Box; line: Box; cw: number; padH: number; text: string; ring: string; spread: number } {
  let own: Box | null = null
  let line: Box | null = null
  let text = ''
  let cw = 0
  let padH = 0
  let ring = COVER_DARK
  let spread = Infinity
  for (const s of hit.spans) {
    const l = lines[s.line]
    const v = l?.variants[s.variant]
    if (!l || !v || !(s.end > s.start)) continue
    const chars = charRanges(l, v)
    const x0 = chars[2 * s.start]
    const x1 = chars[2 * (s.end - 1) + 1]
    const b: Box = [Math.min(x0, x1), l.box[1], Math.max(1, Math.abs(x1 - x0)), l.box[3]]
    own = own ? union(own, b) : b
    text += v.text.slice(s.start, s.end)
    if (!line) {
      line = l.box
      cw = meanCharWidth(chars, l.box)
      padH = padOf({ box: l.box, charWidth: cw }).h
      ring = l.ring
      spread = l.spread
    }
  }
  return { own: own ?? hit.box, line: line ?? hit.box, cw: cw || 8, padH, text, ring, spread }
}

/* ---------- a run ---------- */

interface Found {
  id: string
  key: string
  own: string
  t: number
  box: Box
  parts: Box[]
  line: Box
  kind: FoundCover['kind']
  score: number
  color: string
  lost: boolean
  thin: boolean
}

interface DoneRead {
  t: number
  areas: Box[]
  lines: { box: Box; texts: string[] }[]
  hits: Found[]
  failed: boolean
  /** Areas a capped read could not finish twice: covered as lost areas. */
  unread: Box[]
  done: boolean
  thin: boolean
}

interface CoreRequest {
  projectId: string
  requestId: string
  kinds: readonly FoundCover['kind'][]
  regions: readonly string[]
  names: readonly string[]
  neverHide: readonly string[]
  /** *Cover this text everywhere* without kept reads: only this text, as kind 'text' (§5.9). */
  target?: { folded: string; raw: string }
}

type Progress = (p: FindProgress) => void

/** The lines of a read holding the target text (folded), as hits of kind 'text' over their line. */
function targetHits(lines: readonly ReadLine[], folded: string, frame: Size): Hit[] {
  const out: Hit[] = []
  lines.forEach((l, i) => {
    const k = l.variants.findIndex((v) => foldText(v.text).includes(folded))
    if (k < 0) return
    const v = Math.max(3, 0.35 * l.box[3])
    out.push({ kind: 'text', rule: 'everywhere', score: 0.9, spans: [{ line: i, variant: k, start: 0, end: l.variants[k].text.length }], box: clip([l.box[0] - v, l.box[1] - v, l.box[2] + 2 * v, l.box[3] + 2 * v], frame) })
  })
  return out
}

/** Areas a capped read did not finish, split in two for the extra reads (§5.4 point 8, §10.3). */
const halves = (a: Box): Box[] => (a[2] >= a[3] ? [[a[0], a[1], Math.ceil(a[2] / 2), a[3]] as Box, [a[0] + Math.floor(a[2] / 2), a[1], Math.ceil(a[2] / 2), a[3]] as Box] : [[a[0], a[1], a[2], Math.ceil(a[3] / 2)] as Box, [a[0], a[1] + Math.floor(a[3] / 2), a[2], Math.ceil(a[3] / 2)] as Box])

/** The look data of a recording: from the project's cache, else the helper's look pass (then kept). */
async function lookFor(s: Shared, project: Project, dir: string, signal: AbortSignal, d: Deps, onLook: (fraction: number) => void): Promise<LookData | 'stopped' | 'video'> {
  const size = { width: project.width, height: project.height }
  const fps = project.capture?.fps ?? 60
  const k = lookScale(size.width, size.height)
  const step = lookStep(fps)
  const key = await lookKeyOf(dir, k, step)
  if (!key) return 'video'
  const cached = await readLookCache(dir, key)
  if (cached) return cached
  const data = emptyLook(size, fps)
  const t0 = d.now()
  try {
    await s.helper.look({ video: path.join(dir, 'screen.mp4'), k, step, from: 0, to: project.duration }, (frames) => {
      addLookFrames(data, frames)
      const last = data.frames[data.frames.length - 1]
      if (last && project.duration > 0) onLook(Math.min(1, last.t / project.duration))
    }, signal)
  } catch {
    return signal.aborted ? 'stopped' : 'video'
  }
  if (signal.aborted) return 'stopped'
  if (!data.frames.length) return 'video'
  const frames = project.duration * fps
  if (frames > 0) d.recordDecode(((d.now() - t0) * 1.8 * ((1920 * 1080) / (size.width * size.height))) / frames)
  await writeLookCache(dir, key, data).catch(() => undefined)
  return data
}

/** A follow session's matcher, its check reads added to the plan (§5.4 point 8). */
function matcherOpen(s: Shared, look: LookData, video: string, signal: AbortSignal, plan: ReadPlan | null) {
  return async (dir: 1 | -1, from: number, to: number): Promise<Matcher & { close(): Promise<void> }> => {
    const session = await s.helper.followOpen({ video, key: keyBefore(look, from), from, to, dir }, signal)
    return {
      track: (track, t, parts) => session.track(track, t, parts),
      match: (t, tracks) => session.match(t, tracks),
      checkRead: async (t, area) => {
        try {
          const r = await s.helper.read({ video, key: keyBefore(look, t), t, areas: [area] }, signal)
          s.helper.release(r.id)
          if (plan) addRead(plan, t, [area], 'check')
          return r.result
        } catch {
          return null
        }
      },
      close: () => session.close().catch(() => undefined)
    }
  }
}

/** Pauses the helper while Flown records (§5.11), checked every 2 s; returns the stop of the check. */
function pauseWhileRecording(s: Shared, d: Deps, onWaiting: (waiting: boolean) => void): () => void {
  let paused = false
  const check = (): void => {
    const now = d.recording()
    if (now && !paused) {
      paused = true
      s.helper.pause()
      onWaiting(true)
    } else if (!now && paused) {
      paused = false
      s.helper.resume()
      onWaiting(false)
    }
  }
  const timer = setInterval(check, 2000)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    if (paused) s.helper.resume()
  }
}

/** Waits while Flown records (Find does not start then); false when stopped meanwhile. */
async function notRecording(d: Deps, signal: AbortSignal, onWaiting: () => void): Promise<boolean> {
  if (!d.recording()) return true
  onWaiting()
  while (d.recording()) {
    if (signal.aborted) return false
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }
  return !signal.aborted
}

/**
 * One run of the scan: Find (§5.1-5.10), or *Cover this text everywhere* with a target and no kept
 * reads (§5.9). The result holds covers only.
 */
async function scanCore(req: CoreRequest, onProgress: Progress, signal: AbortSignal, d: Deps): Promise<FindResult> {
  const tag = { projectId: req.projectId, requestId: req.requestId }
  const fail = (reason: FindFailure): FindResult => ({ ok: false, ...tag, reason })
  let project: Project
  try {
    project = await d.readProject(req.projectId)
  } catch {
    return fail('failed')
  }
  const size: Size = { width: project.width, height: project.height }
  if (!(size.width > 0 && size.height > 0 && project.duration > 0)) return fail('video')
  if (size.width > 7680 || size.height > 4320 || size.width * size.height > 40e6) return fail('tooLarge')
  const fps = project.capture?.fps ?? 60
  const duration = project.duration
  const dir = d.projectDir(req.projectId)
  const video = path.join(dir, 'screen.mp4')
  let last = 0
  let lastPhase = ''
  const progress = (phase: FindProgress['phase'], done: number, total: number, secondsLeft: number | null, force = false): void => {
    const now = d.now()
    if (!force && phase === lastPhase && now - last < 250) return
    last = now
    lastPhase = phase
    onProgress({ ...tag, phase, done, total, secondsLeft: secondsLeft === null ? null : Math.max(0, Math.round(secondsLeft)) })
  }
  const empty = (stopped: boolean): FindResult => ({ ok: true, ...tag, found: [], failedReads: 0, thinSpans: '', stopped, readTo: stopped ? 0 : null, reader: READER_ID })
  if (!(await notRecording(d, signal, () => progress('waiting', 0, 0, null, true)))) return empty(true)
  if (!req.target) forgetReads()
  let s: Shared
  try {
    s = await acquire(d.helper, true)
  } catch (err) {
    return fail(err instanceof ScanUnavailable ? err.reason : 'helper')
  }
  const started = d.now()
  const rules = req.target ? null : d.rules()
  /** Set when the run lets go of the helper: its exit then is no death. */
  let finished = false
  let lookPhase = true
  const unpause = pauseWhileRecording(s, d, (waiting) => (waiting ? progress('waiting', 0, 0, null, true) : progress(lookPhase ? 'look' : 'read', 0, 0, null, true)))
  try {
    // 1. The look pass.
    progress('look', 0, 100, null, true)
    const look = await lookFor(s, project, dir, signal, d, (f) => progress('look', Math.round(f * 100), 100, null))
    lookPhase = false
    if (look === 'video') return fail('video')
    if (look === 'stopped') return empty(true)
    const cursor = await d.readCursor(req.projectId).catch(() => null)
    const hints = hintsOf(cursor)
    // 2. The plan.
    const plan = planReads(look, hints, size, fps, readBudget(duration, size))
    const options: DetectOptions = { kinds: req.kinds.filter((k) => k !== 'notice' && k !== 'text'), regions: [...req.regions], names: compileNames(req.names, req.neverHide), frame: { width: size.width, height: size.height } }
    const extra = groupExtras(d.random)
    const groups = new Map<string, string>()
    const groupOf = (key: string): string => {
      let g = groups.get(key)
      if (!g) {
        g = randomGroup(d.random)
        groups.set(key, g)
      }
      return g
    }
    // 3. The reads: at most three in flight, each with its rules and careful pass.
    const jobs: { read: PlannedRead; depth: number }[] = [...plan.reads].sort((a, b) => a.t - b.t).map((read) => ({ read, depth: 0 }))
    const done: DoneRead[] = []
    let failedReads = 0
    let next = 0
    let deaths = 0
    let crashed = false
    let restarting: Promise<void> | null = null
    let lines = 0
    let readSeconds: number | null = null
    let unitsDone = 0
    const readStart = d.now()
    const stopped = (): boolean => signal.aborted || crashed
    const watch = (h: ScanHelper): void =>
      void h.exited.then(() => {
        if (finished || s.helper !== h || stopped()) return
        deaths++
        if (deaths >= 2) {
          crashed = true
          return
        }
        restarting = d.helper(true).then(
          (fresh) => {
            s.helper = fresh
            watch(fresh)
            restarting = null
          },
          () => {
            crashed = true
            restarting = null
          }
        )
      })
    watch(s.helper)
    const doRead = async (job: { read: PlannedRead; depth: number }): Promise<void> => {
      const p = job.read
      const slot: DoneRead = { t: p.t, areas: p.areas, lines: [], hits: [], failed: false, unread: [], done: false, thin: p.thin }
      done.push(slot)
      const helper = s.helper
      let id = -1
      try {
        const r = await helper.read({ video, key: keyBefore(look, p.t), t: p.t, areas: p.areas }, signal)
        id = r.id
        let read = r.result.lines
        let hits: Hit[]
        if (req.target) {
          helper.release(id)
          hits = targetHits(read, req.target.folded, size)
        } else {
          const first = await rules!.detectCareful(read, r.result.qr, options)
          if (first === 'timeout') {
            helper.release(id)
            throw new RulesTimeout()
          }
          hits = first.hits
          if (first.careful.length) {
            const variants = await helper.careful(id, first.careful)
            read = read.map((l) => ({ ...l, variants: [...l.variants] }))
            first.careful.forEach((i, k) => read[i] && read[i].variants.push(...(variants[k] ?? [])))
            const again = await rules!.detect(read, r.result.qr, options)
            if (again === 'timeout') throw new RulesTimeout()
            hits = again
          } else helper.release(id)
        }
        // A capped read: its unfinished areas read again in halves, once; what is still unread is covered.
        for (const a of r.result.partial ?? []) {
          if (job.depth >= 1) {
            slot.unread.push(a)
            failedReads++
          } else for (const half of halves(a)) jobs.push({ read: addRead(plan, p.t, [half], 'partial'), depth: job.depth + 1 })
        }
        slot.lines = read.map((l) => ({ box: l.box, texts: l.variants.map((v) => foldText(v.text)) }))
        lines += read.length
        const own = new Map<string, Found>()
        hits.forEach((h, i) => {
          const shape = hitShape(h, read)
          const key = h.kind === 'qr' ? `qr@${Math.round(h.box[0] / 32)},${Math.round(h.box[1] / 32)}` : req.target ? req.target.folded : groupKeyOf(h, read)
          if (!key) return
          const block = !!h.block || h.kind === 'qr' || !!req.target
          const box = block ? h.box : hideLength(h.box, shape.cw, shape.padH, extra(key), size)
          const f: Found = { id: `${done.indexOf(slot)}:${i}`, key, own: req.target ? req.target.raw : shape.text, t: p.t, box, parts: partsOf(h.kind === 'qr' ? h.box : shape.own, shape.line[3]), line: shape.line, kind: h.kind, score: h.score, color: foundColour(shape.ring, shape.spread), lost: !!h.lost, thin: p.thin }
          const twin = own.get(key)
          if (twin && overlaps(twin.box, f.box)) {
            if (f.score > twin.score) twin.score = f.score
            twin.box = union(twin.box, f.box)
            return
          }
          own.set(twin ? `${key}#${i}` : key, f)
        })
        slot.hits = [...own.values()]
        slot.done = true
        unitsDone += p.units
        if (readSeconds === null && done.filter((x) => x.done).length >= 5 && unitsDone > 0) readSeconds = (d.now() - readStart) / 1000 / unitsDone
      } catch {
        if (signal.aborted && !crashed) return
        slot.failed = true
        slot.done = true
        failedReads++
      }
    }
    const worker = async (): Promise<void> => {
      while (next < jobs.length && !stopped()) {
        await urgentDone(s)
        if (restarting) await restarting
        if (stopped() || next >= jobs.length) break
        const job = jobs[next++]
        await doRead(job)
        const left = jobs.slice(next).reduce((u, j) => u + j.read.units, 0)
        progress('read', done.filter((x) => x.done).length, jobs.length, secondEstimate({ ...plan, units: left }, look, { readSeconds }))
      }
    }
    progress('read', 0, jobs.length, secondEstimate(plan, look, { readSeconds: null }), true)
    await Promise.all([worker(), worker(), worker()])
    const readAll = !stopped() && next >= jobs.length
    // Where the screen was read to: every planned read at or before it finished.
    let readTo: number | null = null
    if (!readAll) {
      const times = jobs.map((j) => j.read.t)
      const doneAt = new Set(done.filter((x) => x.done).map((x) => x.t))
      readTo = 0
      for (const t of [...new Set(times)].sort((a, b) => a - b)) {
        if (!doneAt.has(t)) break
        readTo = t
      }
    }
    // The folded texts, kept for Cover this text everywhere (D22).
    if (!req.target && !signal.aborted) keepReads(req.projectId, done.filter((x) => x.done && !x.failed).map((x) => ({ t: x.t, areas: x.areas, lines: x.lines })), d.now())

    // 4. Following.
    const found: FoundCover[] = []
    const index: ReadIndex = { reads: done.filter((x) => x.done).map((x): IndexedRead => ({ t: x.t, areas: x.areas, lines: x.lines, hits: x.hits.map((h) => ({ id: h.id, key: h.key, box: h.box, parts: h.parts })), ...(x.failed ? { failed: true } : {}) })) }
    const hitsById = new Map<string, Found>()
    for (const x of done) for (const h of x.hits) hitsById.set(h.id, h)
    const starts = [...hitsById.values()].sort((a, b) => a.t - b.t)
    const consumed = new Set<string>()
    const walked = new Set<string>()
    const thinSpans = spansOf(plan.thinSpans)
    const open = matcherOpen(s, look, video, signal, plan)
    const toPlaced = (h: Found): Placed => ({ id: h.id, key: h.key, own: h.own, t: h.t, box: h.box, parts: h.parts, line: h.line })
    const spans: Found[][] = []
    for (const h of starts) {
      const span = spans[spans.length - 1]
      if (span && h.t - span[0].t < 60) span.push(h)
      else spans.push([h])
    }
    let spanDone = 0
    const coverOf = (h: Found, track: Track): void => {
      if (!track.placements.length || !(track.end > track.start)) return
      const end = Math.min(duration, track.end)
      const ids = [h.id, ...(track.consumed ?? [])]
      const score = Math.max(...ids.map((id) => hitsById.get(id)?.score ?? 0))
      const thin = track.thin || ids.some((id) => hitsById.get(id)?.thin) || thinSpans.some(([a, b]) => track.start < b && a < end)
      const f: FoundCover = { kind: h.kind, score, group: groupOf(h.key), start: floorMs(Math.max(0, track.start)), end: ceilMs(end), path: writePath(stepKeys(track.placements, fps)), color: h.color }
      if (track.lost || h.lost || track.unfinished) f.lost = true
      if (thin) f.thin = true
      found.push(f)
    }
    for (const span of spans) {
      const todo = span.filter((h) => !consumed.has(h.id))
      if (!todo.length) continue
      if (stopped()) break
      progress('follow', spanDone, spans.length, null)
      let tracks: Track[]
      try {
        tracks = await followAll(todo.map(toPlaced), look, index, open, hints, size, { duration, stopped })
      } catch {
        tracks = []
      }
      todo.forEach((h, i) => {
        const tr = tracks[i]
        if (!tr) return
        walked.add(h.id)
        for (const c of tr.consumed ?? []) consumed.add(c)
        coverOf(h, tr)
      })
      spanDone++
    }
    // Hits never walked (Find stopped first): covered from the last read of their place without them, to the end, over their region.
    for (const h of starts) {
      if (walked.has(h.id) || consumed.has(h.id)) continue
      const before = index.reads.filter((r) => r.t < h.t && !r.failed && coverage(r.areas, h.box) >= 0.95 && !r.hits.some((x) => x.key === h.key)).pop()
      const from = before ? floorMs(before.t + 1 / fps) : 0
      let box = h.box
      const at = frameNear(look, h.t)
      if (at >= 0) for (const g of regionsAt(look, at)) if (overlaps(g, box)) box = union(box, g)
      found.push({ kind: h.kind, score: h.score, group: groupOf(h.key), start: from, end: ceilMs(duration), path: pathOfBox(from, box, size), color: h.color, lost: true, ...(h.thin ? { thin: true as const } : {}) })
    }
    // 5. A failed read never drops silently: its areas covered from it until the next good read of them.
    const sorted = [...done].sort((a, b) => a.t - b.t)
    for (const x of sorted) {
      const areas = x.failed ? x.areas : x.unread
      if (!areas.length) continue
      let box = areas[0]
      for (const a of areas) box = union(box, a)
      const nextGood = sorted.find((y) => y.t > x.t && y.done && !y.failed && coverage(y.areas, box) >= 0.95)
      found.push({ kind: 'text', score: 0.6, group: randomGroup(d.random), start: floorMs(x.t), end: ceilMs(nextGood ? nextGood.t : duration), path: pathOfBox(floorMs(x.t), box, size), color: COVER_DARK, lost: true })
    }
    // 6. Pop-up notifications, from the look data (§6.13).
    if (!req.target && req.kinds.includes('notice') && !stopped())
      for (const n of findNotices(look, project)) found.push({ kind: 'notice', score: 0.7, group: randomGroup(d.random), start: floorMs(n.start), end: ceilMs(Math.min(duration, n.end)), path: pathOfBox(floorMs(n.start), n.box, size), color: COVER_DARK })
    const stoppedRun = signal.aborted || crashed
    const extras = (why: PlannedRead['why']): number => plan.reads.filter((x) => x.why === why).length
    d.log(`privacy: ${req.target ? 'cover everywhere' : 'find'} read ${done.length} areas (${plan.units} units, ${extras('partial')} partial, ${extras('check')} check), ${lines} lines, ${failedReads} failed, ${found.length} covers in ${((d.now() - started) / 1000).toFixed(2)} s${stoppedRun ? ', stopped' : ''}`)
    return { ok: true, ...tag, found: found.sort((a, b) => a.start - b.start), failedReads, thinSpans: plan.thinSpans, stopped: stoppedRun, readTo: stoppedRun ? (readTo ?? null) : null, reader: READER_ID, ...(crashed ? { crashed: true as const } : {}) }
  } finally {
    finished = true
    unpause()
    rules?.close()
    await release(s)
  }
}

/* ---------- the public runs ---------- */

/**
 * Find private info (§5.1): the look pass, the reads (at most 3 in flight, careful, partial and check
 * reads), the walks, and the covers; paused while Flown records; *Stop* (the signal) ends it with what
 * it found, walks not finished run to the end as lost areas. The helper dying once is started again
 * from the next read; twice ends it with what it has (`crashed`).
 */
export async function runFind(request: FindRequest, onProgress: (p: FindProgress) => void, signal: AbortSignal, deps: ScanDeps = {}): Promise<FindResult> {
  const d = withDefaults(deps)
  return scanCore({ projectId: request.projectId, requestId: request.requestId, kinds: request.kinds, regions: request.regions, names: request.names, neverHide: request.neverHide }, onProgress, signal, d)
}

/** The lines of a read at least half inside `box`, in reading order. */
function linesUnder(result: ReadResult, box: Box): ReadLine[] {
  return result.lines
    .filter((l) => {
      const i = intersect(l.box, box)
      return !!i && i[2] * i[3] >= 0.5 * l.box[2] * l.box[3]
    })
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
}

/**
 * *Follow what is under it* (§5.9): the lines at least half inside the cover's box at its frame make
 * the template and the key; the walks of §5.8 run from there, with check reads both ways (no Find
 * plan to give evidence). Without the reader the template is the box itself, followed by template
 * alone, and the result is thin. *Stop* changes nothing.
 */
export async function followCover(request: FollowRequest, signal: AbortSignal, deps: ScanDeps = {}): Promise<FollowResult> {
  const d = withDefaults(deps)
  const tag = { projectId: request.projectId, requestId: request.requestId }
  const fail = (reason: 'none' | 'stopped' | 'busy' | 'failed'): FollowResult => ({ ok: false, ...tag, reason })
  let project: Project
  try {
    project = await d.readProject(request.projectId)
  } catch {
    return fail('failed')
  }
  const size: Size = { width: project.width, height: project.height }
  const fps = project.capture?.fps ?? 60
  const duration = project.duration
  if (!(size.width > 0 && size.height > 0 && duration > 0)) return fail('failed')
  let s: Shared
  let models = true
  try {
    s = await acquire(d.helper, true)
  } catch {
    try {
      s = await acquire(d.helper, false)
      models = false
    } catch {
      return fail('failed')
    }
  }
  urgentBegin(s)
  try {
    const dir = d.projectDir(request.projectId)
    const video = path.join(dir, 'screen.mp4')
    const look = await lookFor(s, project, dir, signal, d, () => undefined)
    if (look === 'stopped' || signal.aborted) return fail('stopped')
    if (look === 'video') return fail('failed')
    const at = frameNear(look, request.t)
    if (at < 0) return fail('none')
    const t = look.frames[at].t
    const box: Box = [request.box.x * size.width, request.box.y * size.height, request.box.w * size.width, request.box.h * size.height]
    let own = box
    let text = ''
    let lineH = box[3]
    if (models) {
      try {
        const r = await s.helper.read({ video, key: keyBefore(look, t), t, areas: [clip([box[0] - 16, box[1] - 16, box[2] + 32, box[3] + 32], size)] }, signal)
        s.helper.release(r.id)
        const under = linesUnder(r.result, box)
        if (under.length) {
          let u = under[0].box
          for (const l of under) u = union(u, l.box)
          own = intersect(u, box) ?? u
          text = under.map((l) => bestVariant(l)?.text ?? '').join(' ')
          lineH = under[0].box[3]
        }
      } catch {
        if (signal.aborted) return fail('stopped')
      }
    }
    const templateOnly = !models || !foldText(text)
    const cursor = await d.readCursor(request.projectId).catch(() => null)
    const keptReads = keptFor(request.projectId, d.now()) ?? []
    const index: ReadIndex = { reads: keptReads.map((r) => ({ ...r, hits: [] })), checkForward: true, ...(templateOnly ? { templateOnly: true } : {}) }
    const start: Placed = { id: 'follow', key: foldText(text) || 'follow', own: text, t, box, parts: partsOf(own, lineH), line: own }
    const [track] = await followAll([start], look, index, matcherOpen(s, look, video, signal, null), hintsOf(cursor), size, { duration, stopped: () => signal.aborted })
    if (signal.aborted) return fail('stopped')
    if (!track || !track.placements.length || !(track.end > track.start)) return fail('none')
    const end = Math.min(duration, track.end)
    return { ok: true, ...tag, path: writePath(stepKeys(track.placements, fps)), start: floorMs(Math.max(0, track.start)), end: ceilMs(end), walked: { start: floorMs(Math.max(0, track.start)), end: ceilMs(end) }, lostSpans: track.lostSpans, thin: templateOnly || track.thin }
  } catch {
    return fail(signal.aborted ? 'stopped' : 'failed')
  } finally {
    urgentEnd(s)
    await release(s)
  }
}

/**
 * The text under a cover at its frame (§5.9 step 1): kept for this request only (until the dialog
 * closes, at most 10 minutes); the renderer learns only whether it looks like a name.
 */
export async function underCover(request: UnderCoverRequest, signal: AbortSignal, deps: ScanDeps = {}): Promise<UnderCoverResult> {
  const d = withDefaults(deps)
  let project: Project
  try {
    project = await d.readProject(request.projectId)
  } catch {
    return { ok: false, reason: 'failed' }
  }
  const size: Size = { width: project.width, height: project.height }
  if (!(size.width > 0 && size.height > 0)) return { ok: false, reason: 'failed' }
  let s: Shared
  try {
    s = await acquire(d.helper, true)
  } catch (err) {
    return { ok: false, reason: err instanceof ScanUnavailable && err.reason === 'reader' ? 'reader' : 'failed' }
  }
  urgentBegin(s)
  try {
    const dir = d.projectDir(request.projectId)
    const cached = await (async () => {
      const key = await lookKeyOf(dir, lookScale(size.width, size.height), lookStep(project.capture?.fps ?? 60))
      return key ? readLookCache(dir, key) : null
    })()
    const t = cached && frameNear(cached, request.t) >= 0 ? cached.frames[frameNear(cached, request.t)].t : request.t
    const box: Box = [request.box.x * size.width, request.box.y * size.height, request.box.w * size.width, request.box.h * size.height]
    const r = await s.helper.read({ video: path.join(dir, 'screen.mp4'), key: cached ? keyBefore(cached, t) : t, t, areas: [clip([box[0] - 16, box[1] - 16, box[2] + 32, box[3] + 32], size)] }, signal)
    s.helper.release(r.id)
    const text = linesUnder(r.result, box)
      .map((l) => bestVariant(l)?.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!foldText(text)) return { ok: false, reason: 'noText' }
    if (under.size >= 8) under.delete(under.keys().next().value!)
    under.set(request.requestId, { projectId: request.projectId, text, until: d.now() + KEEP_MS })
    return { ok: true, nameLike: looksLikeName(text) }
  } catch {
    return { ok: false, reason: 'failed' }
  } finally {
    urgentEnd(s)
    await release(s)
  }
}

/**
 * *Cover this text everywhere* (§5.9 step 2): the text read under the cover for this request is
 * looked for in the last Find's kept reads (within 10 minutes), each place followed; else a Find with
 * that text as its only target (other kinds off), with progress and *Stop*. Each place is a cover of
 * kind 'text' in one new group. Only with `remember` set and a name-like text does the result carry
 * it (`addedName`), the one text that reaches the renderer, by the user's choice.
 */
export async function coverEverywhere(request: EverywhereRequest, onProgress: (p: FindProgress) => void, signal: AbortSignal, deps: ScanDeps = {}): Promise<EverywhereResult> {
  const d = withDefaults(deps)
  const tag = { projectId: request.projectId, requestId: request.requestId }
  const read = under.get(request.requestId)
  if (!read || read.projectId !== request.projectId || d.now() > read.until) return { ok: false, ...tag, reason: 'failed' }
  const folded = foldText(read.text)
  const named = request.remember !== 'no' && looksLikeName(read.text) ? { addedName: read.text } : {}
  const reads = keptFor(request.projectId, d.now())
  if (!reads) {
    const r = await scanCore({ ...tag, kinds: [], regions: [], names: [], neverHide: [], target: { folded, raw: read.text } }, onProgress, signal, d)
    if (!r.ok) return r
    const group = randomGroup(d.random)
    return { ...r, found: r.found.map((f) => ({ ...f, kind: 'text' as const, group })), ...named }
  }
  let project: Project
  try {
    project = await d.readProject(request.projectId)
  } catch {
    return { ok: false, ...tag, reason: 'failed' }
  }
  const size: Size = { width: project.width, height: project.height }
  const fps = project.capture?.fps ?? 60
  let s: Shared
  try {
    s = await acquire(d.helper, true)
  } catch (err) {
    return { ok: false, ...tag, reason: err instanceof ScanUnavailable ? err.reason : 'helper' }
  }
  urgentBegin(s)
  try {
    const dir = d.projectDir(request.projectId)
    const look = await lookFor(s, project, dir, signal, d, (f) => onProgress({ ...tag, phase: 'look', done: Math.round(f * 100), total: 100, secondsLeft: null }))
    if (look === 'stopped') return { ok: true, ...tag, found: [], failedReads: 0, thinSpans: '', stopped: true, readTo: 0, reader: READER_ID }
    if (look === 'video') return { ok: false, ...tag, reason: 'video' }
    // The places: every kept line holding the text, padded as a cover is.
    const places: Placed[] = []
    const indexed: IndexedRead[] = reads.map((r, ri) => {
      const hits: IndexedRead['hits'] = []
      r.lines.forEach((l, li) => {
        if (!l.texts.some((x) => x.includes(folded))) return
        const v = Math.max(3, 0.35 * l.box[3])
        const box = clip([l.box[0] - v, l.box[1] - v, l.box[2] + 2 * v, l.box[3] + 2 * v], size)
        const id = `${ri}:${li}`
        const parts = partsOf(l.box, l.box[3])
        hits.push({ id, key: folded, box, parts })
        places.push({ id, key: folded, own: read.text, t: r.t, box, parts, line: l.box })
      })
      return { ...r, hits }
    })
    const cursor = await d.readCursor(request.projectId).catch(() => null)
    const hints: ReadHints = hintsOf(cursor)
    const group = randomGroup(d.random)
    const found: FoundCover[] = []
    const consumed = new Set<string>()
    const open = matcherOpen(s, look, path.join(dir, 'screen.mp4'), signal, null)
    places.sort((a, b) => a.t - b.t)
    for (let i = 0; i < places.length; i++) {
      if (signal.aborted) break
      const p = places[i]
      if (consumed.has(p.id)) continue
      onProgress({ ...tag, phase: 'follow', done: i, total: places.length, secondsLeft: null })
      const [track] = await followAll([p], look, { reads: indexed }, open, hints, size, { duration: project.duration, stopped: () => signal.aborted })
      for (const c of track?.consumed ?? []) consumed.add(c)
      if (!track || !track.placements.length || !(track.end > track.start)) continue
      found.push({ kind: 'text', score: 0.9, group, start: floorMs(Math.max(0, track.start)), end: ceilMs(Math.min(project.duration, track.end)), path: writePath(stepKeys(track.placements, fps)), color: COVER_DARK, ...(track.lost || track.unfinished ? { lost: true as const } : {}) })
    }
    return { ok: true, ...tag, found, failedReads: 0, thinSpans: '', stopped: signal.aborted, readTo: null, reader: READER_ID, ...named }
  } catch {
    return { ok: false, ...tag, reason: 'failed' }
  } finally {
    urgentEnd(s)
    await release(s)
  }
}
