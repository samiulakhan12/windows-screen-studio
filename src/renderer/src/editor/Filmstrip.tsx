import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { timelineGaps, type Gap } from '../../../shared/editor/clips'
import { filmstripTiles, tileSource, type FilmstripMeta } from '../../../shared/editor/filmstrip'
import { overlaps } from '../../../shared/editor/timelineScale'
import { cropOf, visibleSize } from '../../../shared/engine/crop'
import type { Clip, NormRect } from '../../../shared/types'
import { useEditor } from './context'
import { useDevicePixelRatio } from './devicePixelRatio'
import { useFilmstripShown } from './filmstripPref'
import { useWaveformShown } from './waveformPref'
import './filmstrip.css'

/**
 * Frames of the recording on the clip track (E-07, docs/design/versions.md §3.2): one canvas over
 * the timeline's render window, under the waveform. The frames come from one sheet main makes
 * from the proxy (window.api.getFilmstrip), asked for at idle and only while shown; each tile of
 * a fixed grid shows the frame nearest its middle. Editor chrome: never drawn by the compositor
 * or the exporter, and redrawn only when what it shows changes, never per playback frame.
 */

type StripState = 'none' | 'loading' | 'ready' | 'error'

/** Largest canvas side in device pixels (Chromium's limit): a huge render window is drawn softer. */
const MAX_CANVAS_PX = 16384
/** How strongly frames show over the clip colour: softer under the waveform so it stays readable. */
const ALPHA = { withWave: 0.55, alone: 0.85 }
/** Cuts and trims keep this much of their frames over the hatching (as the waveform's gapAlpha). */
const GAP_ALPHA = 0.3
/** The speed badge's box inside a clip block (as ClipWaveform). */
const BADGE = { x: 4, y: 1, w: 46, h: 19, minClipPx: 28 }
/** Tile width limits in CSS pixels (the track is 40 px tall). */
const TILE = { min: 14, max: 142 }

/* ---------- the sheets, one per project, decoded once ---------- */

interface Sheet {
  meta: FilmstripMeta
  image: ImageBitmap
}

const sheets = new Map<string, Promise<Sheet | null>>()
/** Sheets kept decoded (about 15 MB each): the project open and the one before. */
const KEEP_SHEETS = 2

/** The decoded sheet of project `id` (asked of main once per editor session; a failure is asked again next time). */
function loadSheet(id: string): Promise<Sheet | null> {
  let p = sheets.get(id)
  if (p) {
    // The most recently used last, so the oldest is the one released.
    sheets.delete(id)
    sheets.set(id, p)
  }
  if (!p) {
    p = window.api
      .getFilmstrip(id)
      .then(async (r) => (r ? { meta: r.meta, image: await createImageBitmap(new Blob([r.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })) } : null))
      .catch((err: unknown) => {
        console.warn('The filmstrip could not be read:', err)
        return null
      })
      .then((s) => {
        if (!s) sheets.delete(id)
        return s
      })
    sheets.set(id, p)
    while (sheets.size > KEEP_SHEETS) {
      const [oldest, sheet] = sheets.entries().next().value!
      sheets.delete(oldest)
      void sheet.then((s) => s?.image.close())
    }
  }
  return p
}

/* ---------- the tooltip hint (read by the Timeline for the clip track's title) ---------- */

const hintListeners = new Set<() => void>()
let hint = ''

function publishHint(next: string): void {
  if (next === hint) return
  hint = next
  for (const l of [...hintListeners]) l()
}

const subscribeHint = (l: () => void): (() => void) => {
  hintListeners.add(l)
  return () => {
    hintListeners.delete(l)
  }
}

/** What the clip track's tooltip adds about the frames ('' when none are shown). */
export const useFilmstripHint = (): string => useSyncExternalStore(subscribeHint, () => hint)

/* ---------- drawing ---------- */

interface Scene {
  px: number
  win: { start: number; end: number }
  duration: number
  sheet: Sheet
  tileW: number
  crop: NormRect | null
  gaps: readonly Gap[]
  clips: readonly Clip[]
  alpha: number
  dpr: number
}

function draw(canvas: HTMLCanvasElement, s: Scene): void {
  const cssW = Math.max(0, (s.win.end - s.win.start) * s.px)
  const cssH = canvas.parentElement?.clientHeight ?? 0
  const r = Math.min(s.dpr, MAX_CANVAS_PX / Math.max(1, cssW))
  canvas.width = Math.round(cssW * r)
  canvas.height = Math.round(cssH * r)
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width === 0 || canvas.height === 0) return
  ctx.setTransform(r, 0, 0, r, 0, 0)
  ctx.imageSmoothingQuality = 'medium'
  const left = s.win.start * s.px
  const end = s.duration * s.px - left
  ctx.globalAlpha = s.alpha
  for (const t of filmstripTiles(s.sheet.meta, s.win, s.px, s.tileW, s.duration)) {
    const src = tileSource(s.sheet.meta, t.frame, s.crop)
    const x = t.x - left
    // A 1 px seam between frames, and nothing past the recording's end.
    const w = Math.min(s.tileW - 1, end - x)
    if (w <= 0) continue
    ctx.drawImage(s.sheet.image, src.sx, src.sy, src.sw * (w / (s.tileW - 1)), src.sh, x, 0, w, cssH)
  }
  ctx.globalAlpha = 1

  // Cuts and trims keep fainter frames over their hatching: what restoring them brings back.
  ctx.globalCompositeOperation = 'destination-out'
  ctx.globalAlpha = 1 - GAP_ALPHA
  ctx.fillStyle = '#000'
  for (const g of s.gaps) if (overlaps(g, s.win)) ctx.fillRect((g.start - s.win.start) * s.px, 0, (g.end - g.start) * s.px, cssH)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'

  for (const clip of s.clips) {
    if (clip.speed !== 1 && (clip.end - clip.start) * s.px > BADGE.minClipPx && overlaps(clip, s.win)) {
      ctx.clearRect((clip.start - s.win.start) * s.px + BADGE.x, BADGE.y, BADGE.w, BADGE.h)
    }
  }
}

/* ---------- the component ---------- */

/** The frames inside `.clip-track`, over the render window `win` (source seconds) at `px` per second. */
export const Filmstrip = memo(function Filmstrip({ px, win, duration }: { px: number; win: { start: number; end: number }; duration: number }): JSX.Element | null {
  const { store } = useEditor()
  const shown = useFilmstripShown()
  const waveShown = useWaveformShown()
  const id = useSyncExternalStore(store.subscribe, () => store.state.id)
  const clips = useSyncExternalStore(store.subscribe, () => store.state.clips)
  const cropRaw = useSyncExternalStore(store.subscribe, () => store.state.crop)
  const width = useSyncExternalStore(store.subscribe, () => store.state.width)
  const height = useSyncExternalStore(store.subscribe, () => store.state.height)
  const crop = useMemo(() => cropOf({ crop: cropRaw, width, height }), [cropRaw, width, height])

  const [loaded, setLoaded] = useState<{ id: string; sheet: Sheet | null } | null>(null)
  useEffect(() => {
    if (!shown || loaded?.id === id) return
    let alive = true
    const idle = requestIdleCallback(
      () => {
        void loadSheet(id).then((sheet) => {
          if (alive) setLoaded({ id, sheet })
        })
      },
      { timeout: 1500 }
    )
    return () => {
      alive = false
      cancelIdleCallback(idle)
    }
  }, [id, shown, loaded])

  const sheet = loaded?.id === id ? loaded.sheet : undefined
  const state: StripState = !shown ? 'none' : sheet === undefined ? 'loading' : sheet ? 'ready' : 'error'

  // As wide as a frame of the shown picture (cropped) at the track's height.
  const visible = visibleSize({ crop: cropRaw, width, height })
  const tileW = Math.round(Math.min(TILE.max, Math.max(TILE.min, (40 * visible.width) / Math.max(1, visible.height))))
  const gaps = useMemo(() => timelineGaps(clips, duration), [clips, duration])

  const dpr = useDevicePixelRatio()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const draws = useRef(0)
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || state !== 'ready' || !sheet) return
    draw(canvas, { px, win, duration, sheet, tileW, crop, gaps, clips, alpha: waveShown ? ALPHA.withWave : ALPHA.alone, dpr })
    canvas.dataset.draws = String(++draws.current)
  }, [px, win, duration, sheet, tileW, crop, gaps, clips, waveShown, dpr, state])

  const hintText = state === 'loading' ? ' · Reading frames for the filmstrip…' : state === 'ready' ? ' · Frames show where you are, to find a moment by sight' : ''
  useEffect(() => publishHint(hintText), [hintText])
  useEffect(() => () => publishHint(''), [])

  if (state !== 'ready') return state === 'none' ? null : <span hidden data-testid="clip-filmstrip" data-state={state} />
  return (
    <canvas
      ref={canvasRef}
      className="clip-film"
      data-testid="clip-filmstrip"
      data-state={state}
      data-count={sheet!.meta.count}
      data-tile={tileW}
      style={{ left: win.start * px, width: (win.end - win.start) * px }}
    />
  )
})
