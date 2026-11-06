import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import type { ExportJob } from '../src/shared/api/export'
import { DUCK_GAIN, jobSoundGains, soundGainFilters, soundGains } from '../src/shared/audio/soundsEdit'
import { DEFAULT_CLEANUP, tidyCaptions } from '../src/shared/captions/cleanup'
import { cutWords, transcriptWords } from '../src/shared/editor/transcript'
import { createProject } from '../src/shared/engine/project'
import { cutRange } from '../src/shared/engine/timeline'
import { planSoundtrack } from '../src/shared/render/audioPlan'
import { toneJob } from '../src/shared/render/popSound'
import type { Bleep, Project, SoundSpan } from '../src/shared/types'

/*
 * Captions Studio's bleeps and the unwanted-sound finder's Mute and Duck on the same stretch
 * (docs/design/captions-studio.md §11.7, docs/design/sound-finder.md §4.6). A bleep mutes its word
 * through the sound finder's gains (bleepGains joined by soundGains): the recording's gain there is
 * 0 whether the stretch under it is muted, lowered or neither, applied once by one gain filter, and
 * the tone is added on top, the same over a muted stretch, in the preview and in the export.
 *
 * Until Captions Studio phase B a bleep only added its tone (the word's own sound was not muted, and
 * Clean up said so); these expectations were that interim behaviour and changed with it.
 */

class FakeParam {
  value = 1
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void {
    this.value = v
  }
  linearRampToValueAtTime(): void {}
}
class FakeNode {
  gain = new FakeParam()
  curve: unknown = null
  to: unknown = null
  constructor(readonly kind: string) {}
  connect<T>(n: T): T {
    this.to = n
    return n
  }
  disconnect(): void {}
}
class FakeAudioContext {
  static last: FakeAudioContext
  currentTime = 0
  destination = {}
  readonly nodes: FakeNode[] = []
  constructor() {
    FakeAudioContext.last = this
  }
  private node(kind: string): FakeNode {
    const n = new FakeNode(kind)
    this.nodes.push(n)
    return n
  }
  createGain = (): FakeNode => this.node('gain')
  createWaveShaper = (): FakeNode => this.node('shaper')
  createMediaElementSource = (): FakeNode => this.node('source')
  resume = (): Promise<void> => Promise.resolve()
  suspend = (): Promise<void> => Promise.resolve()
  close = (): Promise<void> => Promise.resolve()
}
vi.stubGlobal('AudioContext', FakeAudioContext)
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => ({}) }))

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const AUDIO = '../src/renderer/src/editor/previewAudio'
type Sound = { setProject(p: Project): void; dispose(): void; effectsOf(): { tones: { start: number; end: number }[] } }
const { PreviewAudio } = (await import(/* @vite-ignore */ AUDIO)) as { PreviewAudio: new (s: unknown, p: Project) => Sound }

const SECONDS = 6
const BLEEP: Bleep = { id: 'b1', start: 2, end: 3, word: 'damn', sound: 'tone' }

function project(bleeps: Bleep[], spans: SoundSpan['action'][]): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: SECONDS,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  p.clips = [{ id: 'c', start: 0, end: SECONDS, speed: 1 }]
  p.audio = { ...p.audio, volume: 1, muted: false }
  if (bleeps.length) p.bleeps = bleeps
  if (spans.length) p.sounds = { spans: spans.map((action) => ({ start: 2, end: 3, action, key: 'typing-200' })), ignored: [] }
  return p
}

/** The recording's chain in the graph `ctx`: its gain, the cut fades' and the unwanted sounds' gains. */
function chain(ctx: FakeAudioContext): number[] {
  const screen = ctx.nodes.find((n) => n.kind === 'source')!.to as FakeNode
  const rec = screen.to as FakeNode
  const cut = rec.to as FakeNode
  const sounds = cut.to as FakeNode
  return [rec.gain.value, cut.gain.value, sounds.gain.value]
}

describe('a bleep and a muted or lowered sound on the same stretch, in the preview', () => {
  it('the bleep mutes the recording, also inside a lowered stretch, once; the tone is unchanged', async () => {
    const heard = (p: Project, at = 2.5): { chain: number[]; tones: { start: number; end: number }[] } => {
      const before = FakeAudioContext.last
      const sound = new PreviewAudio({ currentTime: at, muted: false, volume: 1 }, p)
      try {
        // Each of these plays through a graph of its own (a bleep's tone or the sound finder's curve).
        expect(FakeAudioContext.last).not.toBe(before)
        return { chain: chain(FakeAudioContext.last), tones: sound.effectsOf().tones }
      } finally {
        sound.dispose()
      }
    }
    const bleepOnly = heard(project([BLEEP], []))
    expect(bleepOnly.chain).toEqual([1, 1, 0])
    expect(bleepOnly.tones).toEqual([{ start: 2, end: 3 }])
    // Outside the bleep the recording is as it was.
    expect(heard(project([BLEEP], []), 4.5).chain).toEqual([1, 1, 1])
    // A Silence bleep mutes the same, with no tone.
    const silent = heard(project([{ ...BLEEP, sound: 'silence' }], []))
    expect(silent.chain).toEqual([1, 1, 0])
    expect(silent.tones).toEqual([])
    for (const action of ['mute', 'duck'] as const) {
      const both = heard(project([BLEEP], [action]))
      const spanOnly = heard(project([], [action]))
      expect(spanOnly.chain[2]).toBeCloseTo(action === 'mute' ? 0 : DUCK_GAIN, 9)
      expect(both.chain[2]).toBe(0)
      expect(both.chain.slice(0, 2)).toEqual(spanOnly.chain.slice(0, 2))
      expect(both.tones).toEqual(bleepOnly.tones)
    }
  })

  it('bleeping, muting and undoing them in any order keeps one graph going', () => {
    const states = [project([BLEEP], []), project([BLEEP], ['mute']), project([], ['mute']), project([BLEEP], ['duck']), project([], []), project([BLEEP], []), project([], ['duck'])]
    const sound = new PreviewAudio({ currentTime: 2.5, muted: false, volume: 1 }, states[0])
    // The bleep made the graph; it stays, and plays the sound finder's curve alone once the bleep goes.
    const ctx = FakeAudioContext.last
    try {
      for (const p of [...states, ...states.slice().reverse()]) {
        sound.setProject(p)
        const muted = p.bleeps ? 'mute' : p.sounds?.spans[0].action
        expect(FakeAudioContext.last).toBe(ctx)
        expect(chain(ctx)[2]).toBeCloseTo(muted === 'mute' ? 0 : muted === 'duck' ? DUCK_GAIN : 1, 9)
        expect(sound.effectsOf().tones).toEqual(p.bleeps ? [{ start: 2, end: 3 }] : [])
      }
    } finally {
      sound.dispose()
    }
  })
})

const RATE = 48000
const ff = ffmpegPath()
const dir = mkdtempSync(path.join(tmpdir(), 'sounds-bleeps-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The recording: a 300 Hz sine at 0.5, mono. */
const RECORDING = path.join(dir, 'screen.wav')
spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*300*t):d=${SECONDS}:s=${RATE}`, '-ac', '1', RECORDING])

/** The export's soundtrack of `p` (the job the exporter makes of it), as mono samples. */
function exported(p: Project, withTones: boolean): { samples: Float32Array; graph: string } {
  const tones = withTones ? toneJob(p) : []
  const job: ExportJob = {
    width: 0,
    height: 0,
    fps: 30,
    frames: SECONDS * 30,
    format: 'm4a',
    quality: 'high',
    video: { kind: 'none' },
    outputPath: '/o.m4a',
    audio: { clips: p.clips, volume: 1, ...(jobSoundGains(p) ? { sounds: jobSoundGains(p) } : {}) },
    ...(tones.length ? { tones } : {})
  }
  const plan = planSoundtrack(job, { mix: RECORDING }, 0)
  const r = spawnSync(ff, ['-v', 'error', ...plan.args, '-filter_complex', plan.graph!, '-map', '[aout]', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  expect(r.status, r.stderr.toString()).toBe(0)
  return { samples: new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4), graph: plan.graph! }
}
const peak = (s: Float32Array, from: number, to: number, minus?: Float32Array): number => {
  let m = 0
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) m = Math.max(m, Math.abs(s[i] - (minus ? minus[i] : 0)))
  return m
}

describe('a bleep and a muted or lowered sound on the same stretch, in the export', () => {
  it('one gain filter on the recording mutes the bleep; the tone added on top, the same over a muted stretch', () => {
    const none = exported(project([], []), false)
    const full = peak(none.samples, 4, 5)
    expect(full).toBeGreaterThan(0.3)
    const plain = exported(project([BLEEP], []), false)
    // The bleep alone mutes its word through the sound finder's one gain filter (no volume=enable).
    expect(plain.graph.split(soundGainFilters(soundGains(project([BLEEP], [])))).length).toBe(2)
    expect(plain.graph).not.toContain('volume=enable')
    expect(peak(plain.samples, 2.1, 2.9) / full).toBeLessThan(1e-3)
    expect(peak(plain.samples, 4, 5)).toBeCloseTo(full, 3)
    expect(peak(plain.samples, 0.5, 1.9)).toBeCloseTo(full, 3)
    const toneAlone = (p: Project): Float32Array => {
      const a = exported(p, true).samples
      const b = exported(p, false).samples
      return a.map((v, i) => v - b[i])
    }
    const tone = toneAlone(project([BLEEP], []))
    expect(peak(tone, 2.1, 2.9)).toBeGreaterThan(0.1)
    expect(peak(tone, 3.5, 5)).toBeLessThan(1e-4)
    for (const action of ['mute', 'duck'] as const) {
      const p = project([BLEEP], [action])
      const { graph } = exported(p, true)
      // One gain on the recording: the bleep and the sound finder's stretch joined into one curve.
      expect(graph.split(soundGainFilters(soundGains(p))).length).toBe(2)
      expect(graph.match(/volume=volume=/g)?.length).toBe(1)
      const under = exported(p, false).samples
      expect(peak(under, 2.1, 2.9) / full).toBeLessThan(1e-3)
      expect(peak(under, 4, 5)).toBeCloseTo(full, 3)
      expect(peak(toneAlone(p), 0, SECONDS, tone)).toBeLessThan(1e-4)
    }
  })

  it('a project without bleeps or muted stretches builds the job and the graph of before', () => {
    const p = project([], [])
    expect(jobSoundGains(p)).toBeUndefined()
    const { graph } = exported(p, true)
    expect(graph).not.toContain('volume=volume=')
    expect(graph).not.toContain('asetnsamples')
  })
})

describe('a bleeped word the edit cuts out', () => {
  // "this is fuck good stuff" with 30 ms between the words, as a provider times speech: the bleep's
  // 0.05 s on each side of "fuck" reaches the end of "is" and the start of "good".
  const said = (): Project => ({
    ...project([], []),
    transcript: {
      provider: 'openai',
      model: 'test-model',
      createdAt: '2026-10-01T09:00:00.000Z',
      language: 'en',
      segments: [
        {
          id: 's1',
          start: 1,
          end: 2.6,
          text: 'this is fuck good stuff',
          words: [
            { text: 'this', start: 1, end: 1.3 },
            { text: 'is', start: 1.33, end: 1.5 },
            { text: 'fuck', start: 1.53, end: 1.9 },
            { text: 'good', start: 1.93, end: 2.2 },
            { text: 'stuff', start: 2.23, end: 2.6 }
          ]
        }
      ]
    }
  })
  const bleeped = (): Project => tidyCaptions(said(), { ...DEFAULT_CLEANUP, caps: false, punct: false, digits: 'off', bleep: 'standard', bleepSound: 'tone', words: [] }).project

  it('deleted in the Transcript tab: no tone at the cut and nothing muted around it, in the preview and the export', () => {
    const p = bleeped()
    expect(p.bleeps).toEqual([expect.objectContaining({ start: 1.48, end: 1.95, sound: 'tone' })])
    // The Transcript tab's cut: from the middle of the pause before the word to the middle of the one after.
    const cut: Project = { ...p, clips: cutWords(p.clips, transcriptWords(p.transcript), [[2, 2]], p.duration) }
    expect(cut.clips.map((c) => [c.start, c.end])).toEqual([
      [0, expect.closeTo(1.515, 9)],
      [expect.closeTo(1.915, 9), SECONDS]
    ])
    expect(toneJob(cut)).toEqual([])
    expect(soundGains(cut)).toEqual([])
    expect(jobSoundGains(cut)).toBeUndefined()
    // The preview's tones (its gain curve is soundGains through the clips: none here).
    const sound = new PreviewAudio({ currentTime: 1.5, muted: false, volume: 1 }, cut)
    try {
      expect(sound.effectsOf().tones).toEqual([])
    } finally {
      sound.dispose()
    }
    // The export plays exactly what the edit without the bleep plays: "is" and "good" whole, no tone.
    const { bleeps: _b, ...plain } = cut
    void _b
    const out = exported(cut, true).samples
    expect(peak(out, 0, SECONDS - 0.5, exported(plain, true).samples)).toBeLessThan(1e-4)
    expect(peak(out, 1.49, 1.51)).toBeGreaterThan(0.3)
  })

  it('a word the edit keeps part of keeps its whole bleep: muted and toned over what is kept', () => {
    const p = bleeped()
    const part: Project = { ...p, clips: cutRange(p.clips, 1.7, 2.1) }
    expect(soundGains(part)).toEqual([{ start: 1.48, end: 1.95, gain: 0 }])
    expect(toneJob(part)).toEqual([{ start: expect.closeTo(1.48, 9), end: expect.closeTo(1.7, 9) }])
    const out = exported(part, false).samples
    // From 1.48 to the cut at 1.7 (output time) the recording is silent.
    expect(peak(out, 1.5, 1.68)).toBeLessThan(1e-3)
  })
})
