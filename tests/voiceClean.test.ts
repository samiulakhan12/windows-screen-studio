// Clean voice's shared rules (shared/audio/voiceClean, docs/design/clean-voice.md §3–§4).
import { describe, expect, it } from 'vitest'
import { recordingMix } from '../src/shared/audio/settings'
import {
  DEFAULT_VOICE,
  isVoiceStrength,
  staleVoiceFiles,
  VOICE_ENGINE,
  VOICE_FILE_RE,
  VOICE_KEEP,
  VOICE_PART_RE,
  voiceFileName,
  voiceGraph,
  voiceKeyInput,
  voiceLook,
  voicePartName,
  voicePasses,
  voiceSourceOf,
  voiceTarget,
  withCleanVoice
} from '../src/shared/audio/voiceClean'
import { migrateProject } from '../src/shared/engine/project'
import type { AudioSettings, Project } from '../src/shared/types'

type Sound = Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>

const sound = (audio: Partial<AudioSettings> = {}, over: Partial<Sound> = {}): Sound => ({
  hasAudio: true,
  audioStems: { mic: true, system: true },
  audio: { volume: 1, muted: false, ...audio },
  ...over
})
const on = { voice: { on: true, strength: 'normal' as const } }

describe('voiceLook', () => {
  it('reads an older project (no field) as off at Normal', () => {
    expect(voiceLook({})).toEqual({ on: false, strength: 'normal' })
    expect(DEFAULT_VOICE).toEqual({ on: false, strength: 'normal' })
  })

  it('keeps a valid setting and sanitises a malformed one', () => {
    expect(voiceLook({ voice: { on: true, strength: 'strong' } })).toEqual({ on: true, strength: 'strong' })
    expect(voiceLook({ voice: { on: false, strength: 'light' } })).toEqual({ on: false, strength: 'light' })
    expect(voiceLook({ voice: { on: 'yes', strength: 'loud' } as never })).toEqual({ on: false, strength: 'normal' })
    expect(voiceLook({ voice: null as never })).toEqual(DEFAULT_VOICE)
    expect(voiceLook({ voice: 3 as never })).toEqual(DEFAULT_VOICE)
  })

  it('accepts the three strengths only', () => {
    for (const s of ['light', 'normal', 'strong']) expect(isVoiceStrength(s)).toBe(true)
    for (const s of ['Normal', '', 'max', 1, null, undefined]) expect(isVoiceStrength(s)).toBe(false)
  })
})

describe('voiceTarget (§4.1)', () => {
  it('is nothing while the switch is off', () => {
    expect(voiceTarget(sound())).toBeNull()
    expect(voiceTarget(sound({ voice: { on: false, strength: 'strong' } }))).toBeNull()
  })

  it('cleans the microphone stem when the recording kept stems and the microphone is heard', () => {
    expect(voiceTarget(sound(on))).toBe('mic')
    expect(voiceTarget(sound({ ...on, mic: { volume: 0.5, muted: false } }))).toBe('mic')
    expect(voiceTarget(sound(on, { audioStems: { mic: true, system: false } }))).toBe('mic')
  })

  it('cleans nothing when the microphone is muted, at 0 % or was not recorded', () => {
    expect(voiceTarget(sound({ ...on, mic: { volume: 1, muted: true } }))).toBeNull()
    expect(voiceTarget(sound({ ...on, mic: { volume: 0, muted: false } }))).toBeNull()
    expect(voiceTarget(sound(on, { audioStems: { mic: false, system: true } }))).toBeNull()
    expect(voiceSourceOf(sound(on, { audioStems: { mic: false, system: true } }))).toBe('noMic')
  })

  it('cleans the mixed track of a recording without stems', () => {
    expect(voiceTarget(sound(on, { audioStems: undefined }))).toBe('mix')
    expect(voiceSourceOf(sound({}, { audioStems: undefined }))).toBe('mix')
  })

  it('cleans nothing in a silent or muted recording', () => {
    expect(voiceTarget(sound(on, { hasAudio: false }))).toBeNull()
    expect(voiceTarget(sound({ ...on, muted: true }))).toBeNull()
    expect(voiceTarget(sound({ ...on, volume: 0 }))).toBeNull()
    expect(voiceSourceOf(sound({ muted: true }))).toBe('silent')
    // Every source off.
    expect(voiceSourceOf(sound({ mic: { volume: 1, muted: true }, system: { volume: 0, muted: false } }))).toBe('silent')
  })
})

describe('withCleanVoice', () => {
  it('plays the stems at unity when the microphone is cleaned', () => {
    const p = sound(on)
    expect(recordingMix(p)).toEqual({ kind: 'mix', volume: 1 })
    expect(withCleanVoice(recordingMix(p), p)).toEqual({ kind: 'stems', volume: 1, stems: { mic: 1, system: 1 } })
  })

  it('keeps the gains of a muted system stem and the master volume', () => {
    const p = sound({ ...on, volume: 0.8, system: { volume: 1, muted: true } })
    expect(withCleanVoice(recordingMix(p), p)).toEqual({ kind: 'stems', volume: 0.8, stems: { mic: 1 } })
  })

  it('changes nothing else', () => {
    const cases: Sound[] = [
      sound(),
      sound({ voice: { on: false, strength: 'normal' } }),
      sound(on, { audioStems: undefined }),
      sound({ ...on, mic: { volume: 1, muted: true } }),
      sound({ ...on, muted: true }),
      sound({ ...on, mic: { volume: 0.5, muted: false } })
    ]
    for (const p of cases) {
      const mix = recordingMix(p)
      expect(withCleanVoice(mix, p)).toBe(mix)
    }
  })
})

describe('voiceGraph (§4.2)', () => {
  const graph = (clean: string): string =>
    `[0:a:0]aresample=48000,asplit[src][ref];[src]${clean}[clean];[clean][ref]amix=inputs=2:duration=shortest:normalize=0:weights=1 0[voice]`

  it('pads and trims the passes delay, and ends with the source', () => {
    expect(voiceGraph('normal')).toBe(graph('apad=pad_len=480,arnndn=m=sh.rnnn,atrim=start_sample=480,asetpts=PTS-STARTPTS'))
    expect(voiceGraph('light')).toBe(graph('apad=pad_len=480,arnndn=m=sh.rnnn:mix=0.75,atrim=start_sample=480,asetpts=PTS-STARTPTS'))
    expect(voiceGraph('strong')).toBe(graph('apad=pad_len=960,arnndn=m=sh.rnnn,arnndn=m=sh.rnnn,atrim=start_sample=960,asetpts=PTS-STARTPTS'))
    expect([voicePasses('light'), voicePasses('normal'), voicePasses('strong')]).toEqual([1, 1, 2])
  })

  it('names the model by its bare file name (no path to escape)', () => {
    expect(VOICE_ENGINE.model).toMatch(/^[a-z]+\.rnnn$/)
  })
})

describe('file names and keys (§3.3)', () => {
  it('names a stem by its 16 hex digit key only', () => {
    expect(voiceFileName('0123456789abcdef')).toBe('voice-0123456789abcdef.m4a')
    expect(voicePartName('0123456789abcdef')).toBe('voice-0123456789abcdef.part.m4a')
    for (const bad of ['', '0123456789ABCDEF', '0123456789abcde', '../../x', '0123456789abcdef0']) expect(() => voiceFileName(bad)).toThrow()
  })

  it('accepts exactly the stem names', () => {
    expect(VOICE_FILE_RE.test('voice-0123456789abcdef.m4a')).toBe(true)
    for (const bad of ['voice-0123456789abcdef.part.m4a', 'voice-0123456789abcdeg.m4a', 'voice-0123456789abcdef.m4a.exe', '../voice-0123456789abcdef.m4a', 'voice-.m4a', 'mic.m4a'])
      expect(VOICE_FILE_RE.test(bad)).toBe(false)
    expect(VOICE_PART_RE.test('voice-0123456789abcdef.part.m4a')).toBe(true)
    expect(VOICE_PART_RE.test('voice-0123456789abcdef.m4a')).toBe(false)
  })

  it('makes the key from the engine, strength, source and the file as it is now', () => {
    const base = voiceKeyInput('mic', 'normal', { size: 100, mtimeMs: 5.7 })
    expect(JSON.parse(base)).toEqual({ engine: VOICE_ENGINE.version, model: VOICE_ENGINE.sha256, strength: 'normal', source: 'mic', size: 100, mtime: 5 })
    expect(voiceKeyInput('mic', 'strong', { size: 100, mtimeMs: 5 })).not.toBe(base)
    expect(voiceKeyInput('mix', 'normal', { size: 100, mtimeMs: 5 })).not.toBe(base)
    expect(voiceKeyInput('mic', 'normal', { size: 101, mtimeMs: 5 })).not.toBe(base)
    expect(voiceKeyInput('mic', 'normal', { size: 100, mtimeMs: 6 })).not.toBe(base)
  })

  it('keeps the newest stems and always the current one', () => {
    const f = (n: number, t: number): { name: string; mtimeMs: number } => ({ name: `voice-${String(n).padStart(16, '0')}.m4a`, mtimeMs: t })
    const files = [f(1, 10), f(2, 50), f(3, 30), f(4, 40), { name: 'mic.m4a', mtimeMs: 1 }, { name: 'voice-x.m4a', mtimeMs: 1 }]
    // The current one (oldest here) plus the two newest others stay.
    expect(staleVoiceFiles(files, f(1, 10).name).sort()).toEqual([f(3, 30).name])
    expect(staleVoiceFiles(files, f(2, 50).name)).toEqual([f(1, 10).name])
    expect(VOICE_KEEP).toBe(3)
    expect(staleVoiceFiles([f(1, 1)], f(1, 1).name)).toEqual([])
  })
})

describe('old projects', () => {
  it('load unchanged: no voice field appears, and one stored is kept', () => {
    const raw = { version: 2, id: 'p', name: 'p', createdAt: '', duration: 1, width: 10, height: 10, hasAudio: true, clips: [], audio: { volume: 1, muted: false } }
    expect(migrateProject(structuredClone(raw) as never).audio).toEqual({ volume: 1, muted: false })
    const withVoice = { ...raw, audio: { volume: 1, muted: false, voice: { on: true, strength: 'light' } } }
    expect(migrateProject(structuredClone(withVoice) as never).audio.voice).toEqual({ on: true, strength: 'light' })
  })
})
