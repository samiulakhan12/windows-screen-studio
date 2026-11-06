/**
 * The filmstrip on the clip track (E-07, docs/design/versions.md §3): the sheet of frames main
 * makes from the proxy, and which frame each tile of the track shows. Pure.
 */
import type { NormRect } from '../types'

/** The frames sheet as main made it (`.cache/filmstrip.json`). */
export interface FilmstripMeta {
  v: 1
  /** The proxy and numbers it was made from: another key means the sheet is made again. */
  key: string
  /** Source seconds between frames: frame `i` is at `i * interval`. */
  interval: number
  /** Frames on the sheet, left to right, then top to bottom. */
  count: number
  cols: number
  tileW: number
  tileH: number
}

/** The sheet's numbers (§3.1). */
export const FILMSTRIP = Object.freeze({
  /** Frames at most. */
  maxFrames: 400,
  /** Tile height in pixels on the sheet. */
  tileH: 72,
  cols: 20,
  minTileW: 24,
  maxTileW: 256
})

export interface FilmstripPlan {
  interval: number
  cols: number
  rows: number
  tileW: number
  tileH: number
}

/**
 * The sheet for a recording of `duration` seconds, `width` x `height`, whose proxy has a key frame
 * every `keyInterval` seconds: frames no closer than the key frames and at most maxFrames.
 */
export function filmstripPlan(duration: number, width: number, height: number, keyInterval: number): FilmstripPlan {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 1
  const key = Number.isFinite(keyInterval) && keyInterval > 0 ? keyInterval : 0.25
  const interval = Math.max(key, d / FILMSTRIP.maxFrames)
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9
  const tileW = Math.min(FILMSTRIP.maxTileW, Math.max(FILMSTRIP.minTileW, Math.round((FILMSTRIP.tileH * aspect) / 2) * 2))
  const frames = Math.ceil(d / interval) + 1
  return { interval, cols: FILMSTRIP.cols, rows: Math.ceil(frames / FILMSTRIP.cols), tileW, tileH: FILMSTRIP.tileH }
}

/** One tile of the track: where it is (CSS px from the track's start) and the frame it shows. */
export interface FilmTile {
  x: number
  frame: number
}

/**
 * The tiles over the render window `win` (source seconds) at `px` pixels per second, each `tileW`
 * CSS pixels wide on a grid that starts at 0, so tiles never move while scrolling; each shows the
 * frame nearest its middle (clamped to the recording `duration` and the sheet).
 */
export function filmstripTiles(meta: Pick<FilmstripMeta, 'interval' | 'count'>, win: { start: number; end: number }, px: number, tileW: number, duration: number): FilmTile[] {
  if (!(px > 0) || !(tileW > 0) || meta.count <= 0 || !(meta.interval > 0)) return []
  const endPx = Math.min(win.end, duration) * px
  const out: FilmTile[] = []
  for (let i = Math.max(0, Math.floor((win.start * px) / tileW)); i * tileW < endPx; i++) {
    const t = Math.min(duration, ((i + 0.5) * tileW) / px)
    out.push({ x: i * tileW, frame: Math.min(meta.count - 1, Math.max(0, Math.round(t / meta.interval))) })
  }
  return out
}

/** The part of tile `frame` of the sheet to draw: the whole tile, or the `crop` of it (normalised to the frame). */
export function tileSource(meta: Pick<FilmstripMeta, 'cols' | 'tileW' | 'tileH'>, frame: number, crop: NormRect | null): { sx: number; sy: number; sw: number; sh: number } {
  const col = frame % meta.cols
  const row = Math.floor(frame / meta.cols)
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 }
  return { sx: col * meta.tileW + c.x * meta.tileW, sy: row * meta.tileH + c.y * meta.tileH, sw: c.w * meta.tileW, sh: c.h * meta.tileH }
}

/** A meta read back from the cache or sent by main, checked; null when it is not one. */
export function sanitizeFilmstripMeta(raw: unknown): FilmstripMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
  if (m.v !== 1 || typeof m.key !== 'string' || typeof m.interval !== 'number' || !(m.interval > 0) || !Number.isFinite(m.interval)) return null
  if (!int(m.count, 1, FILMSTRIP.maxFrames + 1) || !int(m.cols, 1, 100) || !int(m.tileW, FILMSTRIP.minTileW, FILMSTRIP.maxTileW) || !int(m.tileH, 8, 512)) return null
  return { v: 1, key: m.key, interval: m.interval, count: m.count, cols: m.cols, tileW: m.tileW, tileH: m.tileH }
}
