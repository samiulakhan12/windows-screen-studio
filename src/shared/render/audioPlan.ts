/**
 * The export's soundtrack as an ffmpeg filter graph, built from the job alone (pure, so every
 * graph is unit tested): the recording (the screen proxy's mixed track, or the microphone and
 * system stems with their own gains), cut and re-timed clip by clip; optional noise reduction
 * and loudness normalisation; background music on the output timeline with its fades and
 * ducking; the click sounds; and fades of the whole soundtrack. A job without any of the
 * newer settings produces exactly the graph earlier versions did, except that re-timed clips
 * are cut to the exact length of their video and kept on its frames, click sounds keep the
 * recording's channels, and sources mixed together are made stereo.
 */
import type { ClickSounds, ExportJob } from '../api/export'
import { duckExpression, fitFades } from '../audio/automation'
import { LOUDNESS_TARGET } from '../audio/loudness'
import { musicEnd, STEM_KINDS, type StemKind } from '../audio/settings'
import { atempoChain, atempoStages } from '../engine/timeline'
import type { Clip } from '../types'
import { clickSoundSource } from './clickSound'

/** Sample rate of every soundtrack the export writes (Opus requires 48 kHz; AAC is fine with it). */
export const AUDIO_RATE = 48000

/** Seconds as a compact decimal string for filter arguments. */
const sec = (v: number): string => String(Math.max(0, +v.toFixed(6)))
/** `,volume=g` when `g` changes anything. */
const gainFilter = (g: number): string => (Math.abs(g - 1) > 1e-6 ? `,volume=${+g.toFixed(4)}` : '')

/** afftdn's delay: half its 50 ms window (1200 samples at 48 kHz, 1102 at 44.1 kHz), at any strength. */
export const DENOISE_LATENCY = 0.025

/**
 * Noise reduction (ffmpeg afftdn) for a strength of 0..1. The noise floor is what afftdn
 * treats as noise: raising it with the strength (-60 to -32 dB) is what makes it stronger,
 * together with the amount of reduction (8 to 30 dB). Gentle settings only touch faint hiss;
 * strong ones also remove a noisy room's hum, and can thin out very quiet speech.
 */
export function denoiseFilter(strength: number): string {
  const s = Math.min(1, Math.max(0, strength))
  // afftdn returns every sample DENOISE_LATENCY late and drops as much at the end: the pad
  // lets the end out and the trim puts the cleaned sound back on its own samples.
  const d = DENOISE_LATENCY
  return `apad=pad_dur=${d},afftdn=nr=${Math.round(8 + 22 * s)}:nf=${Math.round(-60 + 28 * s)},atrim=start=${d},asetpts=PTS-STARTPTS`
}

/**
 * EBU R128 loudness normalisation (about -16 LUFS). loudnorm measures dual-mono like the
 * stereo it plays as, and works at 192 kHz internally: the result is resampled back.
 */
export const NORMALIZE_FILTERS = `aformat=channel_layouts=stereo,loudnorm=I=${LOUDNESS_TARGET.integrated}:TP=${LOUDNESS_TARGET.truePeak}:LRA=${LOUDNESS_TARGET.range},aresample=${AUDIO_RATE}`

/**
 * How early atempo plays a clip re-timed to `speed`, in output seconds. Each atempo stage
 * returns its sound about half a window (1/48 s) early in its own output time, and every later
 * stage scales what the earlier ones left: 41.7 ms at 0.5x, 125 ms at 0.25x, 10.4 ms at 2x.
 * The real lead varies with the sound around this (from about half of it, for the middle of a
 * slowed-down beep): sound ahead of the picture is what viewers notice, so the full lead is
 * taken back and what is left errs late.
 */
export function atempoLead(speed: number): number {
  let lead = 0
  for (const s of atempoStages(speed)) lead = (lead + 1 / 48) / s
  return lead
}

/**
 * A clip's sound re-timed to `speed` (at AUDIO_RATE), on its frames. atempo plays its sound
 * atempoLead early, so the clip is given twice that lead of silence first (in recording time)
 * and the first lead of what atempo returns is dropped: the sound starts and stays on its
 * frames, with no gap at the start. Sound from before the clip instead of the silence would
 * be heard, as atempo plays its first window at once.
 */
function retimeFilters(speed: number): string {
  const lead = atempoLead(speed)
  return `adelay=delays=${(2 * lead * speed * 1000).toFixed(3)}:all=1,${atempoChain(speed)},asetpts=PTS-STARTPTS,atrim=start_sample=${Math.round(lead * AUDIO_RATE)},asetpts=PTS-STARTPTS`
}

/**
 * Mono to stereo at full level on both sides (as the preview's Web Audio upmixes), stereo
 * unchanged. amix gives its output the first input's channel layout, so every source mixed
 * with another is made stereo first: a mono microphone would make the whole soundtrack mono.
 */
export const STEREO = 'pan=stereo|FL=FL+FC|FR=FR+FC'

/** One stem of the recording in the graph: its input, gain and whether it is cleaned. */
export interface StemPart {
  input: string
  gain: number
  denoise: boolean
}

/** The recording's sound in the graph. */
export interface RecordingPart {
  clips: Clip[]
  /** Master gain, after the sources are mixed (and normalised). */
  volume: number
  /** The screen proxy's mixed track (used when there are no stems). */
  input: string
  /** Separately kept sources mixed instead of `input`. */
  stems?: StemPart[]
  /** Noise reduction strength 0..1 (on the stems marked `denoise`, or on the mixed track). */
  noiseReduction?: number
  normalize?: boolean
}

/** Background music in the graph. */
export interface MusicPart {
  input: string
  volume: number
  /** Output second where it stops (the end, or where a non-looping track runs out). */
  end: number
  fadeIn: number
  fadeOut: number
  /** ffmpeg expression in `t` for its ducked gain (see duckExpression). */
  duck?: string
}

/**
 * Soundtrack for an edit: each kept clip of the source audio is cut out, sped up
 * or slowed down (pitch preserved), and the pieces are joined in order. Gaps in
 * the source audio (a late-starting or early-ending track) become silence, and the
 * result is exactly `duration` seconds long so it never cuts the last video frames.
 */
export function audioFilterGraph(clips: Clip[], volume: number, duration: number, input = '1:a', out = 'aout'): string {
  return recordingGraph({ clips, volume, input }, duration, out)
}

/**
 * Sample (at AUDIO_RATE) where each clip starts on the output timeline, then where the last
 * one ends: the video shows clip i from output second sum(len/speed) of the clips before it.
 */
export function clipSampleBounds(clips: Clip[], rate = AUDIO_RATE): number[] {
  let t = 0
  return [0, ...clips.map((c) => Math.round((t += (c.end - c.start) / c.speed) * rate))]
}

/** audioFilterGraph for the recording with its stems, noise reduction and normalisation. */
export function recordingGraph(rec: RecordingPart, duration: number, out = 'aout'): string {
  const { clips } = rec
  const n = clips.length
  const parts: string[] = []
  const denoise = rec.noiseReduction && rec.noiseReduction > 0 ? `,${denoiseFilter(rec.noiseReduction)}` : ''
  // atempo never returns exactly len/speed seconds (tens of ms off per clip), and concat would
  // carry each error into every later clip. So an edit with re-timed clips works at the export's
  // rate and cuts every clip to the exact samples the video gives it.
  const retimed = clips.some((c) => Math.abs(c.speed - 1) > 1e-6)
  const bounds = retimed ? clipSampleBounds(clips) : []
  const resample = retimed ? `aresample=${AUDIO_RATE}:async=1:first_pts=0` : 'aresample=async=1:first_pts=0'
  let head: string
  const stems = rec.stems ?? []
  if (stems.length === 0) {
    head = `[${rec.input}]${resample}${denoise}`
  } else if (stems.length === 1) {
    const s = stems[0]
    head = `[${s.input}]${resample}${s.denoise ? denoise : ''}${gainFilter(s.gain)}`
  } else {
    // The stems are as long as the video (padded at record time), so they line up sample for sample.
    stems.forEach((s, i) => parts.push(`[${s.input}]${resample}${s.denoise ? denoise : ''}${gainFilter(s.gain)},${STEREO}[m${i}]`))
    head = `${stems.map((_, i) => `[m${i}]`).join('')}amix=inputs=${stems.length}:duration=longest:dropout_transition=0:normalize=0`
  }
  parts.push(`${head}${n > 1 ? `,asplit=${n}${clips.map((_, i) => `[s${i}]`).join('')}` : '[s0]'}`)
  clips.forEach((c, i) => {
    const len = c.end - c.start
    const tempo = Math.abs(c.speed - 1) > 1e-6 ? `,${retimeFilters(c.speed)}` : ''
    const exact = retimed ? `,apad=whole_len=${bounds[i + 1] - bounds[i]},atrim=end_sample=${bounds[i + 1] - bounds[i]}` : ''
    parts.push(`[s${i}]atrim=start=${sec(c.start)}:end=${sec(c.end)},asetpts=PTS-STARTPTS,apad=whole_dur=${sec(len)},atrim=end=${sec(len)}${tempo}${exact}[c${i}]`)
  })
  const joined = n > 1 ? `${clips.map((_, i) => `[c${i}]`).join('')}concat=n=${n}:v=0:a=1,` : '[c0]'
  const normalize = rec.normalize ? `${NORMALIZE_FILTERS},` : ''
  const gain = Math.abs(rec.volume - 1) > 1e-6 ? `volume=${+rec.volume.toFixed(4)},` : ''
  parts.push(`${joined}${normalize}${gain}apad=whole_dur=${sec(duration)},atrim=end=${sec(duration)}[${out}]`)
  return parts.join(';')
}

/** Sample positions of the clicks inside [0, total) samples, sorted, one per position. */
export function clickPositions(times: number[], duration: number, rate = AUDIO_RATE): number[] {
  const total = Math.round(duration * rate)
  const at = times.filter((t) => Number.isFinite(t) && t >= 0).map((t) => Math.round(t * rate)).filter((s) => s < total)
  return [...new Set(at)].sort((a, b) => a - b)
}

/**
 * The click track: one click (input `input`, a short mono sound) at each output time,
 * `duration` seconds long. It is built in time order (silence up to the first click,
 * then each click padded with silence up to the next one, cut short when the next
 * click comes first), so the work grows with the length, not length x clicks, and
 * every click lands on its exact sample. Null when no click falls inside the export.
 */
export function clickTrackGraph(clicks: ClickSounds, duration: number, input: string, out = 'clk', rate = AUDIO_RATE): string | null {
  const at = clickPositions(clicks.times, duration, rate)
  if (at.length === 0) return null
  const total = Math.round(duration * rate)
  const n = at.length
  const parts: string[] = []
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${rate}:channel_layouts=mono`
  parts.push(`[${input}]${fmt}${n > 1 ? `,asplit=${n}${at.map((_, i) => `[k${i}]`).join('')}` : '[k0]'}`)
  const segments: string[] = []
  if (at[0] > 0) {
    parts.push(`anullsrc=r=${rate}:cl=mono,${fmt},atrim=end_sample=${at[0]}[z]`)
    segments.push('[z]')
  }
  at.forEach((s, i) => {
    const len = (i + 1 < n ? at[i + 1] : total) - s
    parts.push(`[k${i}]apad=whole_len=${len},atrim=end_sample=${len}[p${i}]`)
    segments.push(`[p${i}]`)
  })
  const gain = `volume=${+Math.max(0, clicks.volume).toFixed(4)}`
  const joined = segments.length > 1 ? `${segments.join('')}concat=n=${segments.length}:v=0:a=1,` : segments[0]
  parts.push(`${joined}${gain},apad=whole_len=${total},atrim=end_sample=${total}[${out}]`)
  return parts.join(';')
}

/** Frames of 256 samples (5 ms): the ducking gain is evaluated once per frame, so ramps stay smooth. */
const DUCK_FRAME = 256

/**
 * Background music from the start of the output: cut where it ends, at its volume, faded in
 * and out (afade's default curve is linear, like the preview's ramps), ducked, then padded
 * with silence to exactly `duration`.
 */
export function musicGraph(m: MusicPart, duration: number, out = 'mus'): string {
  const end = Math.max(0, Math.min(duration, m.end))
  const f = fitFades(end, m.fadeIn, m.fadeOut)
  const chain = [`[${m.input}]aresample=async=1:first_pts=0`, STEREO, `atrim=end=${sec(end)}`]
  if (Math.abs(m.volume - 1) > 1e-6) chain.push(`volume=${+m.volume.toFixed(4)}`)
  if (f.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${sec(f.fadeIn)}`)
  if (f.fadeOut > 0) chain.push(`afade=t=out:st=${sec(end - f.fadeOut)}:d=${sec(f.fadeOut)}`)
  if (m.duck && m.duck !== '1') chain.push(`asetnsamples=n=${DUCK_FRAME}:p=0`, `volume=volume='${m.duck}':eval=frame`)
  chain.push(`apad=whole_dur=${sec(duration)}`, `atrim=end=${sec(duration)}`)
  return `${chain.join(',')}[${out}]`
}

/** Linear fades of the whole soundtrack (afade's default curve), or ''. */
function fadeFilters(duration: number, fadeIn = 0, fadeOut = 0): string {
  const f = fitFades(duration, fadeIn, fadeOut)
  const parts: string[] = []
  if (f.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${sec(f.fadeIn)}`)
  if (f.fadeOut > 0) parts.push(`afade=t=out:st=${sec(duration - f.fadeOut)}:d=${sec(f.fadeOut)}`)
  return parts.join(',')
}

/**
 * The export's soundtrack graph, ending in [aout]: the edited recording audio, the music and
 * the click track, mixed (added on top of each other, nothing renormalised), then faded.
 * Null when silent.
 */
export function soundtrackGraph(opts: {
  duration: number
  audio?: RecordingPart
  clicks?: { sounds: ClickSounds; input: string }
  music?: MusicPart
  fadeIn?: number
  fadeOut?: number
}): string | null {
  const { duration, audio, clicks, music } = opts
  const fades = fadeFilters(duration, opts.fadeIn, opts.fadeOut)
  const hasClicks = !!clicks && clickPositions(clicks.sounds.times, duration).length > 0
  // A single source without fades ends in [aout] directly (the graph earlier versions made).
  const solo = (audio ? 1 : 0) + (music ? 1 : 0) + (hasClicks ? 1 : 0) === 1 && !fades
  const branches: { label: string; graph: string }[] = []
  if (audio) {
    // Under stereo music, a mono recording is made stereo too (see STEREO).
    const graph = recordingGraph(audio, duration, solo ? 'aout' : music ? 'rec0' : 'rec')
    branches.push({ label: 'rec', graph: music && !solo ? `${graph};[rec0]${STEREO}[rec]` : graph })
  }
  if (music) branches.push({ label: 'mus', graph: musicGraph(music, duration, solo ? 'aout' : 'mus') })
  if (clicks && hasClicks) {
    const graph = clickTrackGraph(clicks.sounds, duration, clicks.input, solo ? 'aout' : 'clk0')!
    // amix gives all its inputs one channel layout: the mono click would make the whole
    // soundtrack mono. aresample lets the click take the layout of the sound it joins.
    branches.push({ label: 'clk', graph: solo ? graph : `${graph};[clk0]aresample[clk]` })
  }
  if (branches.length === 0) return null
  if (solo) return branches[0].graph
  const inputs = branches.map((b) => `[${b.label}]`).join('')
  const mix = branches.length > 1 ? `amix=inputs=${branches.length}:duration=first:dropout_transition=0:normalize=0` : ''
  return [...branches.map((b) => b.graph), `${inputs}${[mix, fades].filter(Boolean).join(',')}[aout]`].join(';')
}

/** Files the soundtrack reads, as resolved and checked by the main process. */
export interface SoundFiles {
  /** The screen proxy, whose audio track is the recording's mixed sound. */
  mix: string | null
  /** The stems the job asks for. */
  stems?: Partial<Record<StemKind, string>>
  music?: string | null
}

/**
 * Inputs (after `first` other inputs) and the graph that mixes them into [aout]: the
 * recording, the music (looped by the demuxer when it should repeat) and the click source.
 */
export function planSoundtrack(job: ExportJob, files: SoundFiles, first: number): { args: string[]; graph: string | null } {
  const args: string[] = []
  const duration = job.frames / job.fps
  let next = first
  let audio: RecordingPart | undefined
  if (job.audio && job.audio.clips.length > 0) {
    const { clips, volume, noiseReduction, normalize } = job.audio
    const extras = { ...(noiseReduction && noiseReduction > 0 ? { noiseReduction } : {}), ...(normalize ? { normalize: true } : {}) }
    const wanted = STEM_KINDS.filter((k) => job.audio?.stems?.[k] !== undefined)
    if (wanted.length > 0) {
      const stems: StemPart[] = []
      for (const k of wanted) {
        const file = files.stems?.[k]
        if (!file) throw new Error(`The ${k === 'mic' ? 'microphone' : 'system sound'} track of this recording is missing.`)
        args.push('-vn', '-i', file)
        stems.push({ input: `${next++}:a`, gain: job.audio.stems?.[k] ?? 1, denoise: k === 'mic' })
      }
      audio = { clips, volume, input: stems[0].input, stems, ...extras }
    } else if (files.mix) {
      args.push('-vn', '-i', files.mix)
      audio = { clips, volume, input: `${next++}:a`, ...extras }
    }
  }
  let music: MusicPart | undefined
  if (job.music && files.music) {
    const m = job.music
    if (m.loop) args.push('-stream_loop', '-1')
    args.push('-vn', '-i', files.music)
    const duck = m.duck && m.duck.depth > 0 ? duckExpression(m.duck.ranges, m.duck) : undefined
    music = { input: `${next++}:a`, volume: m.volume, end: musicEnd(duration, m.duration, m.loop), fadeIn: m.fadeIn, fadeOut: m.fadeOut, ...(duck ? { duck } : {}) }
  }
  let clicks: { sounds: ClickSounds; input: string } | undefined
  if (job.clicks && clickPositions(job.clicks.times, duration).length > 0) {
    args.push('-f', 'lavfi', '-i', clickSoundSource())
    clicks = { sounds: job.clicks, input: `${next++}:a` }
  }
  return { args, graph: soundtrackGraph({ duration, audio, clicks, music, fadeIn: job.fadeIn, fadeOut: job.fadeOut }) }
}
