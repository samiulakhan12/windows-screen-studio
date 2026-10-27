import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Range } from '../../../shared/audio/activity'
import type { AudioLevels } from '../../../shared/audio/loudness'
import { activitySources, type AudioSource } from '../../../shared/audio/settings'
import { sourceActivity, type AudioAnalysis } from '../../../shared/audio/soundtrack'
import { pauseRanges, WAVEFORM, waveformColumns, waveformLanes, waveformRef, type WaveformLane } from '../../../shared/audio/waveform'
import { timelineGaps, type Gap } from '../../../shared/editor/clips'
import { overlaps } from '../../../shared/editor/timelineScale'
import type { Clip } from '../../../shared/types'
import { loadAudioAnalysis } from './audioAnalysis'
import { useEditor } from './context'
import { useDevicePixelRatio } from './devicePixelRatio'
import { useWaveformShown } from './waveformPref'
import './waveform.css'

/**
 * The recording's sound on the clip track (E-04, docs/design/timeline-waveform.md): one canvas
 * over the timeline's render window, in source time like every track. The levels are the ones
 * the main process measures for ducking and Remove silences (loadAudioAnalysis), requested at
 * idle and only while the waveform is shown. Editor chrome: never drawn by the compositor or
 * the exporter, and it redraws only when what it shows changes, never per playback frame.
 */

type WaveState = 'none' | 'loading' | 'ready' | 'error'

/** Largest canvas side in device pixels (Chromium's limit): a huge render window is drawn softer. */
const MAX_CANVAS_PX = 16384
/** Space kept above and below the tallest sound, px. */
const MARGIN = 4
/** The speed badge's box inside a clip block (.speed-badge), cleared so the badge shows through. */
const BADGE = { x: 4, y: 1, w: 46, h: 19, minClipPx: 28 }
const NO_RANGES: Range[] = []

/* ---------- the tooltip hint (read by the Timeline for the clip track's title) ---------- */

const hintListeners = new Set<() => void>()
let hint = ''

function publishHint(next: string): void {
  if (next === hint) return
  hint = next
  for (const l of [...hintListeners]) l()
}

function subscribeHint(l: () => void): () => void {
  hintListeners.add(l)
  return () => {
    hintListeners.delete(l)
  }
}

/** What the clip track's tooltip adds about the waveform ('' when none is shown). */
export const useWaveformHint = (): string => useSyncExternalStore(subscribeHint, () => hint)

function hintFor(state: WaveState, lanes: readonly WaveformLane[]): string {
  if (state === 'loading') return ' · Reading the sound for the waveform…'
  if (state === 'error') return ' · The waveform could not read the sound'
  if (state === 'none') return ''
  const what = lanes.some((l) => l.side !== 'both') ? 'microphone above the line, system sound below' : "the recording's sound"
  return ` · Waveform: ${what}; darker stretches are pauses${lanes.some((l) => l.muted) ? ' (grey: muted)' : ''}`
}

/* ---------- drawing ---------- */

interface Colours {
  mix: string
  mic: string
  system: string
  muted: string
  pause: string
}

interface Scene {
  px: number
  win: Range
  state: Exclude<WaveState, 'none'>
  lanes: readonly { lane: WaveformLane; levels: AudioLevels | undefined }[]
  ref: number | null
  pauses: readonly Range[]
  gaps: readonly Gap[]
  clips: readonly Clip[]
  /** devicePixelRatio, which a move to a monitor with another scale factor changes. */
  dpr: number
}

function readColours(el: HTMLElement): Colours {
  const css = getComputedStyle(el)
  const v = (name: string): string => css.getPropertyValue(`--wave-${name}`).trim()
  return { mix: v('mix'), mic: v('mic'), system: v('system'), muted: v('muted'), pause: v('pause') }
}

function draw(canvas: HTMLCanvasElement, s: Scene, colours: Colours): void {
  const cssW = Math.max(0, (s.win.end - s.win.start) * s.px)
  const cssH = canvas.parentElement?.clientHeight ?? 0
  const r = Math.min(s.dpr, MAX_CANVAS_PX / Math.max(1, cssW))
  // Resizing also clears it.
  canvas.width = Math.round(cssW * r)
  canvas.height = Math.round(cssH * r)
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width === 0 || canvas.height === 0) return
  ctx.setTransform(r, 0, 0, r, 0, 0)
  const c = cssH / 2
  const x = (t: number): number => (t - s.win.start) * s.px
  if (s.state === 'loading') {
    ctx.fillStyle = colours.muted
    ctx.fillRect(0, c - WAVEFORM.hairline, cssW, 2 * WAVEFORM.hairline)
    return
  }
  if (s.state !== 'ready') return

  ctx.fillStyle = colours.pause
  for (const p of s.pauses) if (overlaps(p, s.win)) ctx.fillRect(x(p.start), 1, (p.end - p.start) * s.px, cssH - 2)

  // One column per device pixel; each lane is one polygon, its top edge left to right, then its bottom edge back.
  const columns = canvas.width
  const step = cssW / columns
  const amp = c - MARGIN
  for (const { lane, levels } of s.lanes) {
    const h = levels && s.ref !== null ? waveformColumns(levels, s.ref, s.win.start, s.win.end, columns) : new Float32Array(columns)
    const reach = (k: number): number => Math.max(h[k] * amp, WAVEFORM.hairline)
    const top = (k: number): number => (lane.side === 'down' ? c : c - reach(k))
    const bottom = (k: number): number => (lane.side === 'up' ? c : c + reach(k))
    ctx.beginPath()
    ctx.moveTo(0, top(0))
    for (let k = 0; k < columns; k++) ctx.lineTo((k + 0.5) * step, top(k))
    ctx.lineTo(cssW, top(columns - 1))
    ctx.lineTo(cssW, bottom(columns - 1))
    for (let k = columns - 1; k >= 0; k--) ctx.lineTo((k + 0.5) * step, bottom(k))
    ctx.lineTo(0, bottom(0))
    ctx.closePath()
    ctx.fillStyle = lane.muted ? colours.muted : colours[lane.source]
    ctx.fill()
  }

  // Cuts and trims keep a faded waveform over their hatching: what restoring them brings back.
  ctx.globalCompositeOperation = 'destination-out'
  ctx.globalAlpha = 1 - WAVEFORM.gapAlpha
  // Opaque, so globalAlpha alone sets how much is taken away.
  ctx.fillStyle = '#000'
  for (const g of s.gaps) if (overlaps(g, s.win)) ctx.fillRect(x(g.start), 0, (g.end - g.start) * s.px, cssH)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'

  // No z-index lifts a speed badge above the canvas (a selected or hovered clip block is its own
  // stacking context), so its box is left clear: the Timeline shows one on a sped-up clip over 28 px.
  for (const clip of s.clips) {
    if (clip.speed !== 1 && (clip.end - clip.start) * s.px > BADGE.minClipPx && overlaps(clip, s.win)) {
      ctx.clearRect(x(clip.start) + BADGE.x, BADGE.y, BADGE.w, BADGE.h)
    }
  }
}

/* ---------- the component ---------- */

const laneKey = (l: WaveformLane): string => `${l.source}:${l.side}:${l.muted ? 'muted' : 'heard'}`

/** The waveform inside `.clip-track`, over the render window `win` (source seconds) at `px` per second. */
export const ClipWaveform = memo(function ClipWaveform({ px, win, duration }: { px: number; win: Range; duration: number }): JSX.Element | null {
  const { store } = useEditor()
  const shown = useWaveformShown()
  const id = useSyncExternalStore(store.subscribe, () => store.state.id)
  const hasAudio = useSyncExternalStore(store.subscribe, () => store.state.hasAudio)
  const audioStems = useSyncExternalStore(store.subscribe, () => store.state.audioStems)
  const audio = useSyncExternalStore(store.subscribe, () => store.state.audio)
  const clips = useSyncExternalStore(store.subscribe, () => store.state.clips)
  const sound = { hasAudio, audioStems, audio }

  // Keyed on what they show, so the lanes keep their identity through a volume drag (no redraw).
  const current = waveformLanes(sound)
  const lanesKey = current.map(laneKey).join(',')
  const lanes = useMemo(() => current, [lanesKey])
  const sourcesKey = lanes.map((l) => l.source).join(',')
  // Sources whose sound counts for the pauses, as in the Clip panel's Silences (a muted stem does not).
  const activityKey = activitySources(sound).join(',')

  /* Levels: requested at idle while shown; a failed source is asked again when shown again or reopened. */
  const want = `${id}\u0000${sourcesKey}`
  const [loaded, setLoaded] = useState<{ key: string; analysis: AudioAnalysis | null } | null>(null)
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  useEffect(() => {
    if (!shown || !sourcesKey) return
    const sources = sourcesKey.split(',') as AudioSource[]
    const have = loadedRef.current
    if (have?.key === want && have.analysis) {
      if (sources.every((s) => have.analysis?.[s])) return
      setLoaded({ key: want, analysis: null })
    }
    let alive = true
    const idle = requestIdleCallback(
      () => {
        void loadAudioAnalysis(id, sources).then((analysis) => {
          if (alive) setLoaded({ key: want, analysis })
        })
      },
      { timeout: 1500 }
    )
    return () => {
      alive = false
      cancelIdleCallback(idle)
    }
  }, [id, sourcesKey, shown, want])

  const analysis = loaded?.key === want ? loaded.analysis : null
  const state: WaveState = !shown || lanes.length === 0 ? 'none' : !analysis ? 'loading' : lanes.every((l) => analysis[l.source]) ? 'ready' : 'error'

  const ref = useMemo(() => {
    if (!analysis) return null
    const levels = sourcesKey.split(',').map((s) => analysis[s as AudioSource])
    return waveformRef(levels.filter((l): l is AudioLevels => !!l))
  }, [analysis, sourcesKey])
  // Keyed on the sources that count, like the Clip panel's: a volume or trim drag never recomputes them.
  const pauses = useMemo(() => {
    const activity = analysis && sourceActivity(sound, analysis)
    return activity ? pauseRanges(activity, duration) : NO_RANGES
  }, [analysis, activityKey, duration])
  const gaps = useMemo(() => timelineGaps(clips, duration), [clips, duration])

  /* Drawing: only when something it shows or the scale factor changes (no React state, so it never re-renders). */
  const dpr = useDevicePixelRatio()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const draws = useRef(0)
  const colours = useRef<{ el: HTMLElement; values: Colours } | null>(null)
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || state === 'none') return
    if (colours.current?.el !== canvas) colours.current = { el: canvas, values: readColours(canvas) }
    const withLevels = lanes.map((lane) => ({ lane, levels: analysis?.[lane.source] }))
    draw(canvas, { px, win, state, lanes: withLevels, ref, pauses, gaps, clips, dpr }, colours.current.values)
    canvas.dataset.draws = String(++draws.current)
  }, [px, win, analysis, ref, lanes, pauses, gaps, clips, state, dpr])

  const hintText = hintFor(state, lanes)
  useEffect(() => publishHint(hintText), [hintText])
  useEffect(() => () => publishHint(''), [])

  if (state === 'none') return null
  return (
    <canvas
      ref={canvasRef}
      className="clip-wave"
      data-testid="clip-waveform"
      data-state={state}
      data-sources={sourcesKey}
      data-pauses={pauses.map((p) => `${p.start.toFixed(2)}-${p.end.toFixed(2)}`).join(';')}
      data-from={win.start}
      data-px={px}
      style={{ left: win.start * px, width: (win.end - win.start) * px }}
    />
  )
})
