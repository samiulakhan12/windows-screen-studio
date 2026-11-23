/*
 * Helpers of the scan's tests (docs/design/auto-blur.md §17.1, tests 136-160 and 229-240): synthetic
 * look data (tiles and moves as the helper writes them, look.ts's grid), a scripted matcher for the
 * walks that matches templates against planted text moving over time, and a fake helper for runFind.
 */
import { addLookFrames, emptyLook, lookScale, tileGrid, type LookData, type Size } from '../src/shared/privacy/look'
import type { Box, Candidate, LookFrame, LookMove, ReadLine, ReadResult, ReadVariant, TrackMatch } from '../src/shared/privacy/protocol'

/** The base64 bit string of the tiles a list of boxes (video pixels) touches (look.ts's encoding). */
export function tilesOf(size: Size, boxes: readonly Box[], k = lookScale(size.width, size.height)): string {
  const { cols, rows, tile } = tileGrid({ k, size })
  const bytes = new Uint8Array(Math.ceil((cols * rows) / 8))
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b[0] / tile))
    const y0 = Math.max(0, Math.floor(b[1] / tile))
    const x1 = Math.min(cols - 1, Math.ceil((b[0] + b[2]) / tile) - 1)
    const y1 = Math.min(rows - 1, Math.ceil((b[1] + b[3]) / tile) - 1)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * cols + x
        bytes[i >> 3] |= 1 << (i & 7)
      }
  }
  return Buffer.from(bytes).toString('base64')
}

export interface FrameScript {
  changed?: Box[]
  moves?: LookMove[]
  key?: boolean
}

/** Look data of a recording: `seconds` long at `fps`, every analysed frame scripted by `at` (its index and time). */
export function lookOf(size: Size, fps: number, seconds: number, at: (i: number, t: number) => FrameScript = () => ({})): LookData {
  const data = emptyLook(size, fps)
  const frames: LookFrame[] = []
  const n = Math.floor((seconds * fps) / data.step)
  for (let i = 0; i < n; i++) {
    const t = Math.round(((i * data.step) / fps) * 1e6) / 1e6
    const s = at(i, t)
    frames.push({ t, key: s.key ?? (i * data.step) % 15 === 0, tiles: tilesOf(size, s.changed ?? [], data.k), moves: s.moves ?? [] })
  }
  addLookFrames(data, frames)
  return data
}

export const HD: Size = { width: 1920, height: 1080 }

/** A move of `box` by (dx, dy) with no alternatives. */
export const move = (box: Box, dx: number, dy: number, score = 0.95, alt: [number, number, number][] = []): LookMove => ({ box, dx, dy, score, alt })

/* ---------- a scripted screen: planted texts that move over time ---------- */

/** A planted text: where its box is at each source time (null when it is not on screen or hidden). */
export interface Planted {
  key: string
  text: string
  at: (t: number) => Box | null
}

/** Whether `inner` lies inside `outer` (with a tolerance in pixels). */
export const inside = (inner: Box, outer: Box, tol = 0.5): boolean => inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[0] + inner[2] <= outer[0] + outer[2] + tol && inner[1] + inner[3] <= outer[1] + outer[3] + tol

/**
 * A matcher over planted texts, as the helper's follow session answers (paths.ts's Matcher): a
 * track's parts are templates of the text at the frame they were cut; a candidate places them at
 * template + (dx, dy) (scale about the parts' centre) and the search finds the text within 8 px of
 * that place (±4 template pixels at half size), answering the exact place. A part scores `score`
 * (0.9) where the text is, else `miss` (0.1). `second` is the best score of the candidates that land
 * elsewhere (more than 2 px from the best). Check reads answer the planted texts in the area.
 */
export class ScriptedMatcher {
  readonly calls: { t: number; tracks: number[]; candidates: Candidate[][] }[] = []
  readonly checks: { t: number; area: Box }[] = []
  readonly tracked: { track: number; t: number }[] = []
  private readonly tracks = new Map<number, { t: number; parts: Box[]; key: string }>()
  constructor(
    private readonly planted: readonly Planted[],
    private readonly keyOf: (track: number) => string,
    private readonly opts: { miss?: number; score?: number; second?: (t: number) => number | undefined; check?: (t: number, area: Box) => ReadResult | null } = {}
  ) {}

  async track(track: number, t: number, parts: readonly Box[]): Promise<void> {
    this.tracked.push({ track, t })
    this.tracks.set(track, { t, parts: parts.map((p) => [...p] as Box), key: this.keyOf(track) })
  }

  async match(t: number, asks: readonly { track: number; parts: readonly number[]; candidates: readonly Candidate[] }[]): Promise<TrackMatch[]> {
    this.calls.push({ t, tracks: asks.map((a) => a.track), candidates: asks.map((a) => [...a.candidates]) })
    return asks.map((a) => {
      const tr = this.tracks.get(a.track)!
      const p = this.planted.find((x) => x.key === tr.key)
      const now = p?.at(t) ?? null
      const then = p?.at(tr.t) ?? null
      const hits = a.candidates.map((c) => {
        if (!now || !then) return null
        const cx = then[0] + then[2] / 2
        const cy = then[1] + then[3] / 2
        const x = cx + c.scale * (then[0] - cx) + c.dx
        const y = cy + c.scale * (then[1] - cy) + c.dy
        if (Math.abs(x - now[0]) > 8 || Math.abs(y - now[1]) > 8 || Math.abs(then[2] * c.scale - now[2]) > 2) return null
        return { dx: c.dx + now[0] - x, dy: c.dy + now[1] - y, scale: c.scale }
      })
      const found = hits.find((h) => h !== null) ?? null
      const top = found ? (this.opts.score ?? 0.9) : (this.opts.miss ?? 0.1)
      const elsewhere = hits.some((h) => !h || !found || Math.abs(h.dx - found.dx) > 2 || Math.abs(h.dy - found.dy) > 2) ? (this.opts.miss ?? 0.1) : 0
      const second = this.opts.second?.(t) ?? (found ? elsewhere : this.opts.miss ?? 0.1)
      return { track: a.track, parts: a.parts.map(() => top), best: found ?? (a.candidates[0] ?? null), second }
    })
  }

  async checkRead(t: number, area: Box): Promise<ReadResult | null> {
    this.checks.push({ t, area })
    if (this.opts.check) return this.opts.check(t, area)
    const lines: ReadLine[] = []
    for (const p of this.planted) {
      const b = p.at(t)
      if (b && inside(b, area, 2)) lines.push({ box: b, quad: [], variants: [{ model: 'tiny', text: p.text, conf: 0.95, spans: [] }], ring: '#202020', spread: 0 })
    }
    return { t, lines, qr: [] }
  }
}

/* ---------- a fake helper for the scan (scan.ts's ScanHelper) ---------- */

export interface FakeScript {
  /** The look pass's frames (sent in batches of 1,000). */
  look: LookData
  /** The planted texts on screen over time (reads and follow sessions see them). */
  planted: readonly Planted[]
  /** Overrides a read: 'fail' throws, a ReadResult answers as it is. */
  read?: (t: number, areas: readonly Box[], n: number) => ReadResult | 'fail' | undefined | Promise<ReadResult | 'fail' | undefined>
  /** Waits before answering each read (to hold Find's reads while a test acts). */
  gate?: (t: number, n: number) => Promise<void>
  /** QR codes a read of `areas` at `t` sees (besides the planted lines). */
  qr?: (t: number, areas: readonly Box[]) => ReadResult['qr']
}

/** The lines a read of `areas` at `t` gives over planted texts: each text at least half inside an area, its characters spread evenly. */
export function plantedLines(planted: readonly Planted[], t: number, areas: readonly Box[]): ReadLine[] {
  const lines: ReadLine[] = []
  for (const p of planted) {
    const b = p.at(t)
    if (!b) continue
    const half = areas.some((a) => {
      const x0 = Math.max(a[0], b[0])
      const y0 = Math.max(a[1], b[1])
      const x1 = Math.min(a[0] + a[2], b[0] + b[2])
      const y1 = Math.min(a[1] + a[3], b[1] + b[3])
      return x1 > x0 && y1 > y0 && (x1 - x0) * (y1 - y0) >= 0.5 * b[2] * b[3]
    })
    if (!half) continue
    const n = p.text.length
    const cw = b[2] / Math.max(1, n)
    lines.push({ box: [...b] as Box, quad: [], variants: [{ model: 'tiny', text: p.text, conf: 0.95, spans: Array.from({ length: n }, (_v, i) => [b[0] + i * cw, b[0] + (i + 1) * cw] as [number, number]) }], ring: '#202020', spread: 2 })
  }
  return lines
}

/** A helper that answers from a script: look frames, reads of planted texts, careful variants, follow sessions matching templates by where the texts are. */
export class FakeHelper {
  readonly exited: Promise<number | null>
  private exit!: (code: number | null) => void
  private next = 0
  private reads = 0
  /** `log` collects the commands of every helper a test starts, in order. */
  constructor(
    private readonly script: FakeScript,
    readonly log: string[] = []
  ) {
    this.exited = new Promise((resolve) => (this.exit = resolve))
  }

  async open(): Promise<void> {
    this.log.push('open')
  }

  async look(_req: unknown, onFrames: (f: LookFrame[]) => void, signal: AbortSignal): Promise<void> {
    this.log.push('look')
    const frames = this.script.look.frames
    for (let i = 0; i < frames.length; i += 1000) {
      if (signal.aborted) throw new Error('stopped')
      onFrames(frames.slice(i, i + 1000))
      await Promise.resolve()
    }
  }

  async read(req: { t: number; areas: Box[]; key: number }, signal: AbortSignal): Promise<{ id: number; result: ReadResult }> {
    this.log.push(`read ${req.t} key ${req.key}`)
    const n = this.reads++
    if (this.script.gate) await this.script.gate(req.t, n)
    if (signal.aborted) throw new Error('stopped')
    const over = await this.script.read?.(req.t, req.areas, n)
    if (over === 'fail') throw new Error('read')
    return { id: ++this.next, result: over ?? { t: req.t, lines: plantedLines(this.script.planted, req.t, req.areas), qr: this.script.qr?.(req.t, req.areas) ?? [] } }
  }

  async careful(_id: number, lines: readonly number[]): Promise<ReadVariant[][]> {
    this.log.push('careful')
    return lines.map(() => [])
  }

  release(): void {
    this.log.push('release')
  }

  async followOpen(req: { dir: 1 | -1; from: number }): Promise<{ track(track: number, t: number, parts: readonly Box[]): Promise<void>; match(t: number, tracks: readonly { track: number; parts: readonly number[]; candidates: readonly Candidate[] }[]): Promise<TrackMatch[]>; close(): Promise<void> }> {
    this.log.push(`followOpen ${req.dir}`)
    const keys = new Map<number, string>()
    const planted = this.script.planted
    // A track is the planted text under its first part when its template is cut.
    const m = new ScriptedMatcher(planted, (track) => keys.get(track) ?? '')
    return {
      track: async (track, t, parts) => {
        this.log.push('track')
        const p = planted.find((x) => {
          const b = x.at(t)
          return !!b && parts.length > 0 && b[0] < parts[0][0] + parts[0][2] && parts[0][0] < b[0] + b[2] && b[1] < parts[0][1] + parts[0][3] && parts[0][1] < b[1] + b[3]
        })
        keys.set(track, p?.key ?? `none${track}`)
        await m.track(track, t, parts)
      },
      match: async (t, tracks) => {
        this.log.push(`match ${t}`)
        return m.match(t, tracks)
      },
      close: async () => void this.log.push('close')
    }
  }

  pause(): void {
    this.log.push('pause')
  }

  resume(): void {
    this.log.push('resume')
  }

  async stop(): Promise<void> {
    this.log.push('stop')
    this.exit(0)
  }

  kill(): void {
    this.exit(null)
  }

  /** The process dies (a crash the read cannot catch). */
  crash(): void {
    this.exit(1)
  }
}
