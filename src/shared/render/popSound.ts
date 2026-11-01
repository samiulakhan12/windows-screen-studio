/**
 * Synthesised pop and ding sounds for graphics, and bleep tones (docs/design/captions-studio.md
 * §10.6, §11.7): the same partials in the preview (Web Audio) and the export (ffmpeg), as the click
 * sounds are made (clickSound.ts).
 *
 * Times are output seconds of the exported video (pause freezes included) on the captions' clock
 * (§9.1 rule 6): a graphic appears when the sound time reaches its start, so in a continue freeze
 * its pop sounds with the speech, and a pop at a pause freeze sounds when the freeze starts.
 */
import { wordsBleeped } from '../captions/cleanup'
import { EMOJI_KEYS } from '../captions/emojiList'
import { editToVideo, planOf, type FreezePlan } from '../engine/freeze'
import { outputDuration, playableFrom, sourceToOutput } from '../engine/timeline'
import type { Clip, Graphic, Project } from '../types'

/** Decaying sine partials (Hz, amplitude, decay constant in s) and length (s). */
export const POP_SOUNDS: Readonly<Record<'pop' | 'ding', { partials: readonly { freq: number; amp: number; tau: number }[]; duration: number }>> = {
  pop: {
    partials: [
      { freq: 520, amp: 0.55, tau: 0.04 },
      { freq: 1040, amp: 0.25, tau: 0.02 },
      { freq: 2600, amp: 0.08, tau: 0.006 }
    ],
    duration: 0.12
  },
  ding: {
    partials: [
      { freq: 1320, amp: 0.4, tau: 0.35 },
      { freq: 2640, amp: 0.12, tau: 0.18 },
      { freq: 3960, amp: 0.05, tau: 0.08 }
    ],
    duration: 0.9
  }
}

/** Each pop plays at this volume (§10.6). */
export const POP_VOLUME = 0.35

/** The bleep tone (§11.7 rule 5): a 1 kHz sine at 0.25, with short ramps at both ends so it starts and stops without a click. */
export const BLEEP_TONE = { freq: 1000, gain: 0.25, ramp: 0.005 } as const

/** Sample rate of the export's sound sources (the soundtrack's AUDIO_RATE). */
export const POP_SAMPLE_RATE = 48000

/** Most tone spans in one job (bounds the audio graph; readBleeps keeps at most 2000 bleeps, joined here when they touch). */
export const MAX_TONES = 2000
/** Most pop times of one sound in one job (readGraphics keeps at most 500 graphics). */
export const MAX_POP_TIMES = 500

/** The sound `sound` at `t` seconds after it starts (0 outside it). */
export function popSample(sound: 'pop' | 'ding', t: number): number {
  const s = POP_SOUNDS[sound]
  if (t < 0 || t >= s.duration) return 0
  let v = 0
  for (const p of s.partials) v += p.amp * Math.sin(2 * Math.PI * p.freq * t) * Math.exp(-t / p.tau)
  return v
}

/** One sound's samples at `rate`. */
export function popWaveform(sound: 'pop' | 'ding', rate: number): Float32Array {
  const n = Math.max(1, Math.round(POP_SOUNDS[sound].duration * rate))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = popSample(sound, i / rate)
  return out
}

/** The sound as an ffmpeg expression in `t`: digits, letters and `.*+-/()` only, so no escaping is needed in a filtergraph. */
function popExpression(sound: 'pop' | 'ding'): string {
  return POP_SOUNDS[sound].partials.map((p) => `${p.amp}*sin(2*PI*${p.freq}*t)*exp(-t/${p.tau})`).join('+')
}

/** The ffmpeg source expression of one sound (mono, 48 kHz), for `-f lavfi -i <source>`. */
export function popSoundSource(sound: 'pop' | 'ding'): string {
  return `aevalsrc=${popExpression(sound)}:d=${POP_SOUNDS[sound].duration}:s=${POP_SAMPLE_RATE}`
}

/** The tone's gain at `t` seconds into a span of `length` seconds: linear ramps of BLEEP_TONE.ramp at both ends. */
function toneEnvelope(t: number, length: number): number {
  const r = Math.min(BLEEP_TONE.ramp, length / 2)
  if (t < 0 || t >= length) return 0
  if (r <= 0) return 1
  return Math.min(1, t / r, (length - t) / r)
}

/** One tone span of `length` seconds sampled at `rate`, ramps included (the preview's buffer; the export's afade gives the same curve). */
export function toneWaveform(length: number, rate: number): Float32Array {
  const n = Math.max(1, Math.round(length * rate))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    out[i] = BLEEP_TONE.gain * Math.sin(2 * Math.PI * BLEEP_TONE.freq * t) * toneEnvelope(t, n / rate)
  }
  return out
}

/** The ffmpeg source of the bleep tone, `length` seconds long (mono, 48 kHz): every span is cut from it, starting at phase 0. */
export function toneSoundSource(length: number): string {
  return `aevalsrc=${BLEEP_TONE.gain}*sin(2*PI*${BLEEP_TONE.freq}*t):d=${+Math.max(0.01, length).toFixed(6)}:s=${POP_SAMPLE_RATE}`
}

/* ---------- when they sound ---------- */

/** The language of the captions drawn on the video: the burned-in track's, else the spoken one. */
const burnedLanguage = (project: Project): string | undefined => project.captions?.track ?? project.transcript?.language

/**
 * Whether graphic `g` is ever drawn (§10.4): a graphic with `lang` only while the burned-in
 * captions have that language, an emoji only when it is in this build's emoji list, a keyword
 * made from caption words only while none of them is bleeped (§11.7: the caption then shows its
 * mask). The graphics layer and its sounds share this rule, so a pop never sounds for a graphic
 * that does not show; replacedAt follows it, so the caption's chunk shows instead.
 */
export function graphicDrawn(project: Project, g: Graphic): boolean {
  if (g.lang && g.lang !== burnedLanguage(project)) return false
  if (g.kind === 'emoji' && !EMOJI_KEYS.has(g.emoji)) return false
  if (g.kind === 'keyword' && g.anchor && wordsBleeped(project, g.anchor)) return false
  return true
}

/** Video seconds of edit seconds `o`, after the pause freezes at `o` too (a span that starts there sounds once the freeze ends). */
function videoAfter(plan: FreezePlan, o: number): number {
  let v = editToVideo(plan, o)
  for (const h of plan.holds) if (Math.abs(h.edit - o) <= 1e-9) v += h.length
  return v
}

/** The first source time at or after `s` that is in the edit (a start inside a cut shows at the next clip), or null. */
function shownFrom(clips: Clip[], s: number): number | null {
  const at = sourceToOutput(clips, s)
  if (at !== null) return at
  const next = playableFrom(clips, s)
  return next ? sourceToOutput(clips, next.time) : null
}

/** The pops of the project's graphics: output times on the captions' clock. */
export function popJob(project: Project): { times: number[]; sound: 'pop' | 'ding' }[] {
  const graphics = project.graphics
  if (!graphics?.length || project.clips.length === 0) return []
  const plan = planOf(project)
  const total = outputDuration(project.clips)
  const bySound: Record<'pop' | 'ding', number[]> = { pop: [], ding: [] }
  for (const g of graphics) {
    if (!g.sound || !graphicDrawn(project, g)) continue
    // A list card sounds once, when it first appears (§10.6).
    const at = shownFrom(project.clips, g.start)
    if (at === null || at >= total) continue
    // A graphic wholly inside a cut never shows.
    const end = sourceToOutput(project.clips, g.end) ?? shownFrom(project.clips, g.end) ?? total
    if (!(end > at)) continue
    bySound[g.sound].push(editToVideo(plan, at))
  }
  const out: { times: number[]; sound: 'pop' | 'ding' }[] = []
  for (const sound of ['pop', 'ding'] as const) {
    const times = [...new Set(bySound[sound])].sort((a, b) => a - b).slice(0, MAX_POP_TIMES)
    if (times.length) out.push({ times, sound })
  }
  return out
}

/**
 * The bleep tones (output seconds, split at cuts): each bleep whose sound is a tone, over the
 * parts of its span the edit keeps, mapped to the video's clock; a pause freeze inside a span
 * splits it too (the sound waits during the freeze). Overlapping spans are joined.
 */
export function toneJob(project: Project): { start: number; end: number }[] {
  const bleeps = project.bleeps
  const clips = project.clips
  if (!bleeps?.length || clips.length === 0) return []
  const plan = planOf(project)
  const edits: { start: number; end: number }[] = []
  for (const b of bleeps) {
    if (b.sound !== 'tone' || !(b.end > b.start)) continue
    let o = 0
    for (const c of clips) {
      const speed = c.speed > 0 ? c.speed : 1
      const len = (c.end - c.start) / speed
      const from = Math.max(b.start, c.start)
      const to = Math.min(b.end, c.end)
      if (to > from) edits.push({ start: o + (from - c.start) / speed, end: o + (to - c.start) / speed })
      o += len
    }
  }
  edits.sort((a, b) => a.start - b.start)
  const joined: { start: number; end: number }[] = []
  for (const e of edits) {
    const last = joined[joined.length - 1]
    // Overlapping spans are joined; the pieces of one span on both sides of a cut only touch, and stay apart.
    if (last && e.start < last.end - 1e-9) last.end = Math.max(last.end, e.end)
    else joined.push({ ...e })
  }
  const out: { start: number; end: number }[] = []
  for (const e of joined) {
    // Pieces between the pause freezes inside the span.
    const cuts = plan.holds.map((h) => h.edit).filter((at) => at > e.start + 1e-9 && at < e.end - 1e-9)
    const points = [e.start, ...cuts, e.end]
    for (let i = 0; i + 1 < points.length; i++) {
      const start = videoAfter(plan, points[i])
      const end = editToVideo(plan, points[i + 1])
      if (end - start > 1e-6) out.push({ start, end })
    }
  }
  return out.slice(0, MAX_TONES)
}
