/*
 * Helpers of the scan's tests (docs/design/auto-blur.md §17.1, tests 136-160 and 229-240): synthetic
 * look data (tiles and moves as the helper writes them, look.ts's grid), a scripted matcher for the
 * walks that matches templates against planted text moving over time, and a fake helper for runFind.
 */
import { addLookFrames, emptyLook, lookScale, tileGrid, type LookData, type Size } from '../src/shared/privacy/look'
import type { Box, Candidate, LookFrame, LookMove, ReadLine, ReadResult, TrackMatch } from '../src/shared/privacy/protocol'

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
 * template + (dx, dy) (scale about the parts' centre); a part scores 0.9 when the text is there within
 * 2 px, else `miss` (0.1). `second` is the best score of the other candidates. Check reads answer the
 * planted texts whose boxes lie in the area.
 */
export class ScriptedMatcher {
  readonly calls: { t: number; tracks: number[] }[] = []
  readonly checks: { t: number; area: Box }[] = []
  private readonly tracks = new Map<number, { t: number; parts: Box[]; key: string }>()
  constructor(
    private readonly planted: readonly Planted[],
    private readonly keyOf: (track: number) => string,
    private readonly opts: { miss?: number; score?: number; check?: (t: number, area: Box) => ReadResult | null } = {}
  ) {}

  async track(track: number, t: number, parts: readonly Box[]): Promise<void> {
    this.tracks.set(track, { t, parts: parts.map((p) => [...p] as Box), key: this.keyOf(track) })
  }

  async match(t: number, asks: readonly { track: number; parts: readonly number[]; candidates: readonly Candidate[] }[]): Promise<TrackMatch[]> {
    this.calls.push({ t, tracks: asks.map((a) => a.track) })
    return asks.map((a) => {
      const tr = this.tracks.get(a.track)!
      const p = this.planted.find((x) => x.key === tr.key)
      const now = p?.at(t) ?? null
      const then = p?.at(tr.t) ?? null
      const scores = a.candidates.map((c) => {
        if (!now || !then) return this.opts.miss ?? 0.1
        // Where the candidate puts the text's box, from where it was when the template was cut.
        const cx = then[0] + then[2] / 2
        const cy = then[1] + then[3] / 2
        const x = cx + c.scale * (then[0] - cx) + c.dx
        const y = cy + c.scale * (then[1] - cy) + c.dy
        const w = then[2] * c.scale
        return Math.abs(x - now[0]) <= 2 && Math.abs(y - now[1]) <= 2 && Math.abs(w - now[2]) <= 2 ? (this.opts.score ?? 0.9) : (this.opts.miss ?? 0.1)
      })
      let best = -1
      scores.forEach((s, i) => {
        if (best < 0 || s > scores[best]) best = i
      })
      const second = scores.filter((_s, i) => i !== best).reduce((m, s) => Math.max(m, s), 0)
      const top = best >= 0 ? scores[best] : 0
      return { track: a.track, parts: a.parts.map(() => top), best: best >= 0 ? a.candidates[best] : null, second }
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
