import { duckKeyframes, fadeGainAt, fadeKeyframes, gainAt, type Keyframe } from '../../../shared/audio/automation'
import { audioLook, musicEnd, needsAudioGraph, recordingMix, SOURCE_FILES, STEM_KINDS, type AudioLook, type AudioSource, type StemKind } from '../../../shared/audio/settings'
import { analysisSources, musicDucking, previewNormalizeGain, soundActivity, type AudioAnalysis } from '../../../shared/audio/soundtrack'
import type { Range } from '../../../shared/audio/activity'
import { clamp } from '../../../shared/engine/math'
import { outputDuration, playableFrom, sourceToOutput } from '../../../shared/engine/timeline'
import { mediaUrl } from '../../../shared/mediaUrl'
import type { Project } from '../../../shared/types'
import { loadAudioAnalysis } from './audioAnalysis'
import { createAudio } from './media'

/** Seconds of gain automation scheduled ahead of the playhead; more is added as playback gets there. */
const HORIZON = 30
/** A stem further than this from the video (seconds) is moved; closer, its speed is nudged. */
const STEM_SEEK = 0.15
const STEM_NUDGE = 0.02
/** The same for music, which only has to follow the timeline, not lips. */
const MUSIC_SEEK = 0.3
const MUSIC_NUDGE = 0.08
/** Largest speed correction of a drifting element (inaudible with pitch preserved). */
const MAX_NUDGE = 0.04
/** Automation is re-anchored when the video and the audio clock disagree by more than this. */
const ANCHOR_DRIFT = 0.05

interface Graph {
  ctx: AudioContext
  /** The video element's own (mixed) track. */
  screen: GainNode
  /** The recording's sound: master volume and the normalisation gain. */
  rec: GainNode
  /** A soft limiter while normalised (loudnorm limits peaks in the export). */
  limiter: WaveShaperNode
  /** Fades of the whole soundtrack. */
  master: GainNode
}

interface Source {
  el: HTMLAudioElement
  node: MediaElementAudioSourceNode
  gain: GainNode
  failed: boolean
}

interface Music extends Source {
  path: string
  fade: GainNode
  duck: GainNode
  /** Length of the file once known. */
  duration: number | null
}

let softLimit: Float32Array<ArrayBuffer> | null = null

/** Unity below 0.7, then a smooth knee that never reaches full scale (about -1 dBFS at most). */
function softLimitCurve(): Float32Array<ArrayBuffer> {
  if (softLimit) return softLimit
  const n = 2049
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= 0.7 ? a : 0.7 + 0.2 * Math.tanh((a - 0.7) / 0.2)
    curve[i] = Math.sign(x) * y
  }
  softLimit = curve
  return curve
}

/**
 * The preview's soundtrack. Without anything to add it leaves the video element playing its
 * own track (as before). Otherwise a Web Audio graph takes over, created on first need:
 * - the recording: the video's mixed track, or the microphone and system stems in their own
 *   audio elements, kept on the video's time through seeks, cuts and speed changes (a far
 *   drift is re-seeked, a small one corrected with a slight speed change);
 * - per-source and master volume, and loudness normalisation approximated by one gain (from
 *   the measured loudness) and a soft limiter; noise reduction is export-only;
 * - background music on the OUTPUT timeline (it runs on through cuts), looped, faded and
 *   ducked under the recording's sound;
 * - fades of the whole soundtrack.
 * Fades and ducking are the same keyframed curves the export renders (shared/audio), run as
 * Web Audio ramps anchored to the playhead and re-anchored after every jump.
 */
export class PreviewAudio {
  private project: Project
  /** The project's sound settings with defaults, and the edit's output length (kept for every frame). */
  private look: AudioLook
  private length: number
  private graph: Graph | null = null
  private readonly stems = new Map<StemKind, Source>()
  private music: Music | null = null
  private analysis: AudioAnalysis = {}
  private analysisVersion = 0
  private readonly requested = new Set<AudioSource>()
  private playing = false
  private speed = 1
  /** Audio-clock time and output time the scheduled automation starts from. */
  private anchor: { ctx: number; out: number; until: number } | null = null
  /** What the scheduled curves were made from; they are rebuilt only when it changes. */
  private curvesKey = ''
  private activity: { key: string; ranges: Range[] | null } = { key: '', ranges: null }
  private loudness: { key: string; gain: number } = { key: '', gain: 1 }
  private warnedStems = false
  private limiting = false
  private disposed = false

  constructor(
    private readonly screen: HTMLVideoElement,
    project: Project
  ) {
    this.project = project
    this.look = audioLook(project.audio)
    this.length = outputDuration(project.clips)
    this.apply()
  }

  /* ---------- settings ---------- */

  setProject(project: Project): void {
    const prev = this.project
    this.project = project
    if (project.audio !== prev.audio || project.hasAudio !== prev.hasAudio || project.audioStems !== prev.audioStems || project.clips !== prev.clips) {
      this.look = audioLook(project.audio)
      this.length = outputDuration(project.clips)
      this.apply()
    }
  }

  /** Loads the music file again (a new pick replaced it under the same name). */
  reloadMusic(): void {
    this.disposeMusic()
    this.apply()
  }

  /** Gain of the whole soundtrack's fades at source time `t` (the player's click sounds follow it). */
  fadeAt(t: number): number {
    const look = this.look
    if (look.fadeIn <= 0 && look.fadeOut <= 0) return 1
    return fadeGainAt(this.outputAt(t), this.length, look.fadeIn, look.fadeOut)
  }

  /** Brings the graph in line with the project: sources, gains, music, measurements, curves. */
  private apply(): void {
    if (this.disposed) return
    const p = this.project
    if (!this.graph && !needsAudioGraph(p)) return this.applyElementOnly()
    const g = this.ensureGraph()
    if (!g) return this.applyElementOnly()
    const look = this.look
    const mix = recordingMix(p)
    const stemsOk = mix.kind === 'stems' && Object.keys(mix.stems).every((k) => !this.stems.get(k as StemKind)?.failed)
    if (mix.kind === 'stems' && !stemsOk && !this.warnedStems) {
      this.warnedStems = true
      console.warn('A sound track of the recording could not be loaded; the preview plays the mixed sound.')
    }
    for (const kind of STEM_KINDS) {
      const gain = stemsOk && mix.kind === 'stems' ? (mix.stems[kind] ?? 0) : 0
      const stem = gain > 0 ? this.ensureStem(g, kind) : this.stems.get(kind)
      if (!stem) continue
      stem.gain.gain.value = gain
      if (gain <= 0) stem.el.pause()
      else if (this.playing && stem.el.paused) this.startStem(stem)
    }
    g.screen.gain.value = mix.kind === 'mix' || (mix.kind === 'stems' && !stemsOk) ? 1 : 0
    this.requestAnalysis()
    const norm = look.normalize ? this.normalizeGain() : 1
    g.rec.gain.value = mix.kind === 'none' ? 0 : mix.volume * norm
    if (this.limiting !== look.normalize) {
      this.limiting = look.normalize
      g.limiter.curve = look.normalize ? softLimitCurve() : null
    }
    this.applyMusic(g)
    this.scheduleIfChanged()
  }

  /** No graph: the video element plays its own track at up to 100% (as earlier versions did). */
  private applyElementOnly(): void {
    const { volume, muted } = this.look
    this.screen.muted = !this.project.hasAudio || muted || volume <= 0
    this.screen.volume = clamp(volume, 0, 1)
  }

  private ensureGraph(): Graph | null {
    if (this.graph) return this.graph
    try {
      const ctx = new AudioContext({ latencyHint: 'playback' })
      const screen = ctx.createGain()
      const rec = ctx.createGain()
      const limiter = ctx.createWaveShaper()
      const master = ctx.createGain()
      // From now on the video's track plays through the graph only.
      ctx.createMediaElementSource(this.screen).connect(screen)
      screen.connect(rec).connect(limiter).connect(master).connect(ctx.destination)
      this.screen.muted = false
      this.screen.volume = 1
      if (!this.playing) void ctx.suspend()
      this.graph = { ctx, screen, rec, limiter, master }
    } catch (err) {
      // Without Web Audio the preview plays the video's own track; the export applies everything.
      console.warn('Sound effects are not available in the preview:', err)
    }
    return this.graph
  }

  private ensureStem(g: Graph, kind: StemKind): Source {
    const existing = this.stems.get(kind)
    if (existing) return existing
    const el = createAudio(mediaUrl(this.project.id, SOURCE_FILES[kind]))
    const node = g.ctx.createMediaElementSource(el)
    const gain = g.ctx.createGain()
    node.connect(gain).connect(g.rec)
    const stem: Source = { el, node, gain, failed: false }
    el.addEventListener('error', () => {
      stem.failed = true
      this.apply()
    })
    this.stems.set(kind, stem)
    return stem
  }

  private applyMusic(g: Graph): void {
    const m = this.look.music
    if (this.music && (!m || m.path !== this.music.path)) this.disposeMusic()
    if (!m) return
    if (m.volume <= 0) {
      // Turned all the way down: silent and idle, ready to come back.
      if (this.music) {
        this.music.gain.gain.value = 0
        this.music.el.pause()
      }
      return
    }
    if (!this.music) {
      const el = createAudio(mediaUrl(this.project.id, m.path))
      const node = g.ctx.createMediaElementSource(el)
      const gain = g.ctx.createGain()
      const fade = g.ctx.createGain()
      const duck = g.ctx.createGain()
      node.connect(gain).connect(fade).connect(duck).connect(g.master)
      const music: Music = { el, node, gain, fade, duck, path: m.path, duration: null, failed: false }
      el.addEventListener('loadedmetadata', () => {
        music.duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null
        this.curvesKey = ''
        this.scheduleIfChanged()
        if (this.playing) this.syncMusic(true)
      })
      el.addEventListener('error', () => {
        music.failed = true
        console.warn('The background music could not be played in the preview:', el.error?.message)
      })
      this.music = music
      this.curvesKey = ''
    }
    this.music.gain.gain.value = m.volume
    this.music.el.loop = m.loop
    if (this.playing) this.syncMusic(false)
  }

  private disposeMusic(): void {
    const m = this.music
    if (!m) return
    this.music = null
    m.el.pause()
    m.node.disconnect()
    m.duck.disconnect()
    m.el.removeAttribute('src')
    m.el.load()
  }

  /* ---------- measurements ---------- */

  /** Asks for the levels ducking and normalisation need (once per source); applies them when they arrive. */
  private requestAnalysis(): void {
    const wanted = analysisSources(this.project).filter((s) => !this.requested.has(s))
    if (wanted.length === 0) return
    for (const s of wanted) this.requested.add(s)
    void loadAudioAnalysis(this.project.id, wanted).then((levels) => {
      if (this.disposed) return
      this.analysis = { ...this.analysis, ...levels }
      this.analysisVersion++
      this.apply()
    })
  }

  /** The loudness gain for the current mix (recomputed only when the mix or the edit changes). */
  private normalizeGain(): number {
    const mix = recordingMix(this.project)
    const key = `${this.analysisVersion}|${JSON.stringify(mix)}|${clipsKey(this.project)}`
    if (this.loudness.key !== key) this.loudness = { key, gain: previewNormalizeGain(this.project, this.analysis) }
    return this.loudness.gain
  }

  /** Where the recording has sound on the output timeline (memoised: the same for every frame). */
  private soundRanges(): Range[] | null {
    const look = this.look
    const key = `${this.analysisVersion}|${look.muted}|${look.volume > 0}|${STEM_KINDS.map((k) => look[k].muted || look[k].volume <= 0).join()}|${clipsKey(this.project)}`
    if (this.activity.key !== key) this.activity = { key, ranges: soundActivity(this.project, this.analysis) }
    return this.activity.ranges
  }

  /* ---------- automation ---------- */

  private curves(): { master: Keyframe[]; musicFade: Keyframe[]; duck: Keyframe[] } {
    const { look, length } = this
    const m = look.music
    const end = m ? musicEnd(length, this.music?.duration ?? null, m.loop) : length
    const duck = m ? musicDucking(this.project, this.soundRanges()) : null
    return {
      master: fadeKeyframes(length, look.fadeIn, look.fadeOut),
      musicFade: m ? fadeKeyframes(end, m.fadeIn, m.fadeOut) : [],
      duck: duck ? duckKeyframes(duck.ranges, length, duck.shape) : []
    }
  }

  private scheduleIfChanged(): void {
    const look = this.look
    const m = look.music
    const key = [
      look.fadeIn,
      look.fadeOut,
      m ? [m.path, m.loop, m.fadeIn, m.fadeOut, m.ducking, this.music?.duration].join() : '',
      this.soundRanges() ? this.activity.key : 'none',
      clipsKey(this.project)
    ].join('|')
    if (key === this.curvesKey) return
    this.curvesKey = key
    this.schedule()
  }

  /** Schedules the curves from the playhead on (or holds their current values while paused). */
  private schedule(): void {
    const g = this.graph
    if (!g) return
    const out = this.outputAt(this.screen.currentTime)
    const now = g.ctx.currentTime
    this.anchor = { ctx: now, out, until: out + HORIZON }
    const c = this.curves()
    this.ramp(g.master.gain, c.master, out, now)
    if (this.music) {
      this.ramp(this.music.fade.gain, c.musicFade, out, now)
      this.ramp(this.music.duck.gain, c.duck, out, now)
    }
  }

  private ramp(param: AudioParam, keys: Keyframe[], out: number, now: number): void {
    param.cancelScheduledValues(0)
    param.setValueAtTime(gainAt(keys, out), now)
    if (!this.playing) return
    for (const k of keys) {
      if (k.t <= out) continue
      param.linearRampToValueAtTime(k.gain, now + (k.t - out))
      // One keyframe past the horizon keeps the last ramp going until the next top-up.
      if (k.t > out + HORIZON) break
    }
  }

  /* ---------- playback ---------- */

  /** Output time of source time `t` (a time inside a cut counts as the next clip's start). */
  private outputAt(t: number): number {
    const clips = this.project.clips
    const at = sourceToOutput(clips, t)
    if (at !== null) return at
    const next = playableFrom(clips, t)
    return next ? (sourceToOutput(clips, next.time) ?? 0) : this.length
  }

  /** Playback starts at source time `t` with clip speed `speed`. */
  play(t: number, speed: number): void {
    this.playing = true
    this.speed = speed
    const g = this.graph
    if (!g) return
    void g.ctx.resume()
    for (const stem of this.activeStems()) this.startStem(stem, t)
    this.syncMusic(true, t)
    this.schedule()
  }

  pause(): void {
    this.playing = false
    for (const stem of this.stems.values()) stem.el.pause()
    this.music?.el.pause()
    const g = this.graph
    if (!g) return
    // Hold every curve where it is (nothing more is scheduled while paused).
    this.schedule()
    void g.ctx.suspend()
  }

  /** The video jumped (a cut, or a seek while playing) to source time `t`. */
  jump(t: number, speed: number): void {
    this.speed = speed
    if (!this.graph || !this.playing) return
    for (const stem of this.activeStems()) this.startStem(stem, t)
    // The music runs on through cuts (output time is continuous); only a real seek moves it.
    this.syncMusic(false, t)
    this.schedule()
  }

  /** The clip speed changed without a seek (adjacent clips). */
  setRate(speed: number): void {
    this.speed = speed
    for (const stem of this.activeStems()) stem.el.playbackRate = speed
  }

  /** Called for every video frame while playing: keeps the elements and the automation on time. */
  frame(): void {
    const g = this.graph
    if (!g || !this.playing) return
    const t = this.screen.currentTime
    for (const stem of this.stems.values()) {
      if (stem.failed || stem.gain.gain.value <= 0) continue
      const drift = stem.el.currentTime - t
      if (Math.abs(drift) > STEM_SEEK) this.startStem(stem, t)
      else setRate(stem.el, this.speed * nudge(drift, STEM_NUDGE))
    }
    this.syncMusic(false, t)
    const out = this.outputAt(t)
    const a = this.anchor
    if (!a || out > a.until - 5 || Math.abs(a.out + (g.ctx.currentTime - a.ctx) - out) > ANCHOR_DRIFT) this.schedule()
  }

  private activeStems(): Source[] {
    return [...this.stems.values()].filter((s) => !s.failed && s.gain.gain.value > 0)
  }

  private startStem(stem: Source, t = this.screen.currentTime): void {
    stem.el.playbackRate = this.speed
    if (Math.abs(stem.el.currentTime - t) > 1e-3) stem.el.currentTime = t
    if (stem.el.paused) void stem.el.play().catch(() => undefined)
  }

  /** Keeps the music at the output time of source time `t`; `hard` moves it there at once. */
  private syncMusic(hard: boolean, t = this.screen.currentTime): void {
    const music = this.music
    const m = this.look.music
    if (!music || music.failed || !m || m.volume <= 0 || !this.playing) return
    const out = this.outputAt(t)
    const end = musicEnd(this.length, music.duration, m.loop)
    if (out >= end - 1e-3) {
      music.el.pause()
      return
    }
    const d = music.duration
    const want = m.loop && d ? out % d : out
    let drift = music.el.currentTime - want
    // Looping: the shorter way round.
    if (m.loop && d) drift = ((drift + d / 2) % d + d) % d - d / 2
    if (hard || Math.abs(drift) > MUSIC_SEEK) {
      music.el.currentTime = want
      music.el.playbackRate = 1
    } else {
      setRate(music.el, nudge(drift, MUSIC_NUDGE))
    }
    if (music.el.paused) void music.el.play().catch(() => undefined)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.playing = false
    for (const stem of this.stems.values()) {
      stem.el.pause()
      stem.el.removeAttribute('src')
      stem.el.load()
    }
    this.stems.clear()
    this.disposeMusic()
    void this.graph?.ctx.close()
    this.graph = null
  }
}

/** Sets an element's speed only when it changes (each change resamples). */
function setRate(el: HTMLMediaElement, rate: number): void {
  if (Math.abs(el.playbackRate - rate) > 1e-4) el.playbackRate = rate
}

/** Speed factor that closes a drift of `drift` seconds over about two seconds (none below `dead`). */
function nudge(drift: number, dead: number): number {
  if (Math.abs(drift) <= dead) return 1
  return 1 - clamp(drift / 2, -MAX_NUDGE, MAX_NUDGE)
}

/** Identity of the edit's timing (clips change identity on every edit). */
const clipsKey = (p: Project): string => p.clips.map((c) => `${c.start},${c.end},${c.speed}`).join(';')
