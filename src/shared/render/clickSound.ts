/**
 * Click sounds (CursorSettings.clickSound).
 *
 * CONTRACT between the cursor builder (implements this module and the preview playback
 * with WebAudio) and the export builder (calls clickSoundJob() from the export audio
 * graph and mixes the clicks in). The sound itself is synthesised (no asset file), so
 * preview and export sound the same: both evaluate the formula in CLICK_PARTIALS, the
 * preview in JS (clickWaveform) and the export in ffmpeg (clickSoundSource).
 */
import { clamp } from '../engine/math'
import { outputDuration, sourceToOutput } from '../engine/timeline'
import type { Clip, CursorTrack, Project } from '../types'
import { cursorLook } from './cursorFx'

export interface ClickSoundJob {
  /** OUTPUT times (seconds, after cuts and speed changes) at which a click plays. */
  times: number[]
  /** Linear gain 0..1. */
  volume: number
}

/* ---------- the sound ---------- */

/**
 * One click: a few exponentially decaying sine partials (a bright tick, a body and a soft
 * low "tock"), all starting at zero phase so the sound starts without a step. About 4 ms
 * to the peak, inaudible after ~40 ms.
 */
export const CLICK_PARTIALS: readonly { freq: number; amp: number; tau: number }[] = [
  { freq: 4200, amp: 0.3, tau: 0.0012 },
  { freq: 1900, amp: 0.38, tau: 0.004 },
  { freq: 380, amp: 0.34, tau: 0.009 }
]

/** Length (seconds) and sample rate of the export's click source. */
export const CLICK_SOUND = { duration: 0.06, sampleRate: 48000 }

/** Clicks closer together than this (seconds) sound once. */
export const CLICK_MIN_GAP = 0.03

/** The click's waveform at `t` seconds after it starts (0 outside the sound). */
export function clickSample(t: number): number {
  if (t < 0 || t >= CLICK_SOUND.duration) return 0
  let v = 0
  for (const p of CLICK_PARTIALS) v += p.amp * Math.sin(2 * Math.PI * p.freq * t) * Math.exp(-t / p.tau)
  return v
}

/** One click sampled at `sampleRate` (for a WebAudio buffer). */
export function clickWaveform(sampleRate: number): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.round(CLICK_SOUND.duration * sampleRate))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = clickSample(i / sampleRate)
  return out
}

/**
 * The click formula as an ffmpeg expression in `t`. Only digits, letters, `.*+-/()` and no
 * commas, colons or quotes, so it can be used inside a filtergraph without escaping.
 */
export function clickSoundExpression(): string {
  return CLICK_PARTIALS.map((p) => `${p.amp}*sin(2*PI*${p.freq}*t)*exp(-t/${p.tau})`).join('+')
}

/**
 * ffmpeg lavfi source for ONE click (mono, 48 kHz), e.g. for
 * `-f lavfi -i "aevalsrc=...:d=0.06:s=48000"`. Sounds exactly like the preview click.
 */
export function clickSoundSource(): string {
  return `aevalsrc=${clickSoundExpression()}:d=${CLICK_SOUND.duration}:s=${CLICK_SOUND.sampleRate}`
}

/* ---------- which clicks sound ---------- */

const inVideo = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1

/** Sorted times that are at least CLICK_MIN_GAP apart. */
function spaced(times: number[]): number[] {
  const out: number[] = []
  for (const t of times) if (out.length === 0 || t - out[out.length - 1] >= CLICK_MIN_GAP) out.push(t)
  return out
}

const soundingCache = new WeakMap<CursorTrack, number[]>()

/**
 * Source times of the clicks that make a sound, sorted: every button, but only clicks the
 * click effects also show (inside the recorded video; a window recording's clicks on
 * other windows are not). None without valid cursor data. Cached per track.
 */
export function soundingClicks(cursor: CursorTrack): number[] {
  if (!cursor.valid) return []
  let times = soundingCache.get(cursor)
  if (!times) {
    times = spaced(
      cursor.clicks
        .filter((c) => Number.isFinite(c.t) && inVideo(c))
        .map((c) => c.t)
        .sort((a, b) => a - b)
    )
    soundingCache.set(cursor, times)
  }
  return times
}

/** Clicks to mix into the export, or null when click sounds are off or there are none. */
export function clickSoundJob(project: Project, cursor: CursorTrack, clips: Clip[]): ClickSoundJob | null {
  const look = cursorLook(project.cursor)
  const volume = clamp(look.clickSoundVolume, 0, 1)
  if (!look.clickSound || !(volume > 0) || clips.length === 0) return null
  const total = outputDuration(clips)
  const times: number[] = []
  for (const s of soundingClicks(cursor)) {
    // Clicks in cuts are not in the video, so they are not heard either.
    const o = sourceToOutput(clips, s)
    if (o !== null && o < total) times.push(o)
  }
  // A sped-up clip can bring clicks closer together than they were recorded.
  const out = spaced(times)
  return out.length > 0 ? { times: out, volume } : null
}

/* ---------- preview scheduling ---------- */

/** Index of the first value greater than `v` in sorted `values` (values.length if none). */
function firstAfter(values: number[], v: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid] <= v) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface DueClick {
  /** Source time of the click. */
  t: number
  /** Seconds from now (wall clock) until it is due. */
  delay: number
}

/**
 * Decides, frame by frame during preview playback, which clicks to play. Pure (no audio):
 * the player feeds it the source time of every frame it draws and plays what comes back.
 *
 * - Each click plays once per pass, and only while playback runs through it: `restart`
 *   (play, a seek, a jump over a cut) starts a new pass at that time, and a frame that
 *   goes backwards or arrives after a long stall does too, so scrubbing never fires a
 *   burst of old clicks.
 * - Clicks in cuts never play: the window never reaches past the current clip's end, and
 *   jumping over the cut restarts at the next clip.
 * - Clicks just ahead of the frame (within `lookahead` output seconds) are returned with
 *   the delay at which they are due, so they land on time instead of up to a frame late.
 */
export class ClickSoundScheduler {
  private times: number[]
  /** Clicks after this source time have not been handled in this pass. */
  private from: number | null = null
  private last: number | null = null

  constructor(
    times: number[] = [],
    private readonly lookahead = 1 / 50,
    /** Output seconds between two frames beyond which playback is not continuous. */
    private readonly maxGap = 0.3,
    /** Most clicks returned for one frame. */
    private readonly maxPerFrame = 4
  ) {
    this.times = times
  }

  /** New click times (the track or the edit changed); the current pass continues. */
  setTimes(times: number[]): void {
    this.times = times
  }

  /** Starts a new pass at source time `t` (a click exactly at `t` still plays). */
  restart(t: number): void {
    this.from = t - 1e-6
    this.last = t
  }

  /** Forgets the pass: the next frame starts a new one there. */
  reset(): void {
    this.from = null
    this.last = null
  }

  /** A frame at source time `t` of `clip` is being shown: the clicks to play for it. */
  frame(t: number, clip: { start: number; end: number; speed: number }): DueClick[] {
    const speed = clip.speed > 0 ? clip.speed : 1
    if (this.from === null || this.last === null || t < this.last - 1e-4 || t - this.last > this.maxGap * speed) this.restart(t)
    const from = Math.max(this.from!, clip.start - 1e-6)
    const upper = Math.min(t + this.lookahead * speed, clip.end - 1e-9)
    const out: DueClick[] = []
    if (upper > from) {
      for (let i = firstAfter(this.times, from); i < this.times.length && this.times[i] <= upper && out.length < this.maxPerFrame; i++) {
        out.push({ t: this.times[i], delay: Math.max(0, (this.times[i] - t) / speed) })
      }
      this.from = Math.max(this.from!, upper)
    }
    this.last = t
    return out
  }
}
