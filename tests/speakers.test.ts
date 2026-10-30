import { describe, expect, it } from 'vitest'
import { BUNDLED_MODEL_LIST } from '../src/shared/ai/modelList'
import { readCaptionSegments, readTranscript } from '../src/shared/captions/captionData'
import { mergeWithNext, splitCaption } from '../src/shared/captions/edit'
import { retiredMessage, todayUtc } from '../src/shared/captions/retiredModel'
import { readCaptionSettings } from '../src/shared/captions/settings'
import {
  cleanSpeakerName,
  clearSpeakers,
  dropLoneSpeaker,
  nextSpeakerName,
  renameSpeaker,
  setSpeaker,
  speakerCaption,
  speakersOf,
  stemSpeakers
} from '../src/shared/captions/speakers'
import { subtitleFile, toPlainText, toSrt, toVtt } from '../src/shared/captions/subtitles'
import type { AudioLevels } from '../src/shared/audio/loudness'
import type { CaptionSegment } from '../src/shared/types'

const seg = (id: string, start: number, end: number, text: string, speaker?: string): CaptionSegment => ({ id, start, end, text, ...(speaker ? { speaker } : {}) })

describe('speaker names', () => {
  it('are one clean line of at most 32 characters', () => {
    expect(cleanSpeakerName('  Priya\n  Das ')).toBe('Priya Das')
    expect(cleanSpeakerName('x'.repeat(40))).toHaveLength(32)
    expect(cleanSpeakerName(3)).toBe('')
    expect(cleanSpeakerName('\u0000 ')).toBe('')
  })

  it('are listed in order with their counts; renamed everywhere at once (merging into an existing name)', () => {
    const list = [seg('a', 0, 1, 'hi', 'Speaker 1'), seg('b', 1, 2, 'yo', 'Speaker 2'), seg('c', 2, 3, 'ok', 'Speaker 1'), seg('d', 3, 4, 'no')]
    expect(speakersOf(list)).toEqual([{ name: 'Speaker 1', count: 2 }, { name: 'Speaker 2', count: 1 }])
    const renamed = renameSpeaker(list, 'Speaker 1', ' Priya ')!
    expect(renamed.map((s) => s.speaker)).toEqual(['Priya', 'Speaker 2', 'Priya', undefined])
    expect(renamed[1]).toBe(list[1])
    expect(renameSpeaker(list, 'Speaker 1', 'Speaker 1')).toBeNull()
    expect(renameSpeaker(list, 'Nobody', 'X')).toBeNull()
    expect(speakersOf(renameSpeaker(list, 'Speaker 2', 'Speaker 1')!)).toEqual([{ name: 'Speaker 1', count: 3 }])
    // An empty name removes the label.
    expect(renameSpeaker(list, 'Speaker 2', '  ')![1]).not.toHaveProperty('speaker')
  })

  it('are set per caption, cleared, and the next free one is offered', () => {
    const list = [seg('a', 0, 1, 'hi', 'Speaker 1'), seg('b', 1, 2, 'yo')]
    expect(setSpeaker(list, 'b', 'Speaker 1')![1].speaker).toBe('Speaker 1')
    expect(setSpeaker(list, 'a', 'Speaker 1')).toBeNull()
    expect(setSpeaker(list, 'a', '')![0]).not.toHaveProperty('speaker')
    expect(setSpeaker(list, 'zz', 'X')).toBeNull()
    expect(nextSpeakerName(list)).toBe('Speaker 2')
    expect(clearSpeakers(list)!.some((s) => s.speaker)).toBe(false)
    expect(clearSpeakers([seg('a', 0, 1, 'x')])).toBeNull()
  })

  it('are dropped when only one speaker is left', () => {
    expect(dropLoneSpeaker([seg('a', 0, 1, 'x', 'Speaker 1'), seg('b', 1, 2, 'y')]).some((s) => s.speaker)).toBe(false)
    expect(dropLoneSpeaker([seg('a', 0, 1, 'x', 'Speaker 1'), seg('b', 1, 2, 'y', 'Speaker 2')]).map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2'])
  })
})

describe('You and Others from the sound tracks', () => {
  /** Levels at 50 ms windows: `loud` ranges at -20 dB, the rest at -70 dB. */
  const levels = (seconds: number, loud: [number, number][], loudDb = -20): AudioLevels => {
    const power = new Float32Array(Math.round(seconds / 0.05))
    for (let i = 0; i < power.length; i++) {
      const t = (i + 0.5) * 0.05
      power[i] = 10 ** ((loud.some(([a, b]) => t >= a && t < b) ? loudDb : -70) / 10)
    }
    return { window: 0.05, power }
  }

  it('labels each caption by the track that has its sound, the microphone winning bleed and ties', () => {
    const mic = levels(20, [[0, 3], [10, 12], [12, 14]])
    // The computer sound has the other person (4..8) and, quietly, the user's voice bleeding in (10..12).
    const system = levels(20, [[4, 8], [10, 12]], -20)
    const micBleed: AudioLevels = { ...mic, power: mic.power.map((p, i) => ((i + 0.5) * 0.05 >= 10 && (i + 0.5) * 0.05 < 12 ? 10 ** (-10 / 10) : p)) }
    const list = [seg('a', 0, 3, 'mine'), seg('b', 4, 8, 'theirs', 'Speaker 9'), seg('c', 10, 12, 'both'), seg('d', 16, 18, 'quiet', 'Speaker 1'), seg('e', 19, 19.1, 'tiny')]
    const r = stemSpeakers(list, micBleed, system)
    expect(r.segments.map((s) => s.speaker)).toEqual(['You', 'Others', 'You', undefined, undefined])
    expect(r).toMatchObject({ you: 2, others: 1 })
  })

  it("counts the microphone only where its speech detector heard speech, when it ran", () => {
    const mic = { ...levels(10, [[0, 4]]), speech: [{ start: 3, end: 4 }] }
    const system = levels(10, [[0, 2]])
    expect(stemSpeakers([seg('a', 0, 2, 'x')], mic, system).segments[0].speaker).toBe('Others')
  })
})

describe('speakers in the files and on the video', () => {
  const clips = [{ id: 'c', start: 0, end: 10, speed: 1 }]
  const list = [seg('a', 1, 2, 'Hello there', 'Pri <a&b>'), seg('b', 3, 4, 'Hi')]

  it('WebVTT names the speaker with a voice tag, escaped', () => {
    expect(subtitleFile(list, clips, 'vtt')).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Pri &lt;a&amp;b&gt;>Hello there\n\n00:00:03.000 --> 00:00:04.000\nHi\n')
  })

  it('SRT and text start with "Name: " only when asked', () => {
    expect(subtitleFile(list, clips, 'srt')).toBe('1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nHi\n')
    expect(subtitleFile(list, clips, 'srt', undefined, { speakerNames: true })).toContain('\nPri <a&b>: Hello there\n')
    expect(toPlainText([{ start: 0, end: 1, text: 'Yo', speaker: 'Sam' }], { speakerNames: true })).toBe('Sam: Yo\n')
    expect(toPlainText([{ start: 0, end: 1, text: 'Yo', speaker: 'Sam' }])).toBe('Yo\n')
    expect(toSrt([{ start: 0, end: 1, text: 'Yo' }], { speakerNames: true })).toBe('1\n00:00:00,000 --> 00:00:01,000\nYo\n')
    expect(toVtt([{ start: 0, end: 1, text: 'a --> b', speaker: 'x-->y' }])).toContain('<v x-&gt;y>a -&gt; b')
  })

  it('draws the name as a first word timed at the caption start', () => {
    const timed = { ...seg('a', 1, 3, 'Hello there', 'Sam'), words: [{ text: 'Hello', start: 1.2, end: 2 }, { text: 'there', start: 2, end: 2.8 }] }
    expect(speakerCaption(timed)).toEqual({ id: 'a', start: 1, end: 3, speaker: 'Sam', text: 'Sam: Hello there', words: [{ text: 'Sam:', start: 1, end: 1 }, ...timed.words] })
    const plain = seg('b', 0, 1, 'Hi')
    expect(speakerCaption(plain)).toBe(plain)
    expect(speakerCaption({ ...seg('c', 0, 1, 'Hi', 'Sam'), words: [{ text: 'x', start: 0, end: 1 }, { text: 'y', start: 0, end: 1 }] })).not.toHaveProperty('words')
  })
})

describe('speakers in projects', () => {
  it('load when valid; old captions and settings load unchanged', () => {
    const old = [{ id: 'a', start: 0, end: 1, text: 'hi', words: [{ text: 'hi', start: 0, end: 1 }] }]
    expect(JSON.stringify(readCaptionSegments(old))).toBe(JSON.stringify(old))
    expect(readCaptionSegments([{ id: 'a', start: 0, end: 1, text: 'hi', speaker: ' Sam\n' }])[0].speaker).toBe('Sam')
    expect(readCaptionSegments([{ id: 'a', start: 0, end: 1, text: 'hi', speaker: 7 }])[0]).not.toHaveProperty('speaker')
    expect(readCaptionSegments([{ id: 'a', start: 0, end: 1, text: 'hi', speaker: '  ' }])[0]).not.toHaveProperty('speaker')
    const t = { provider: 'openai', model: 'gpt-transcribe', createdAt: 'x', segments: [{ id: 'a', start: 0, end: 1, text: 'hi', speaker: 'You', words: [{ text: 'hi', start: 0, end: 1, estimated: true }] }] }
    expect(readTranscript(t)).toEqual(t)
    const settings = { show: true, preset: 'clean', position: 'bottom', size: 0.045, color: '#ffffff', highlightColor: '#facc15', background: 'shadow', maxLines: 2 }
    expect(JSON.stringify(readCaptionSettings(settings))).toBe(JSON.stringify(settings))
    expect(readCaptionSettings({ ...settings, showSpeaker: true })?.showSpeaker).toBe(true)
    expect(readCaptionSettings({ ...settings, showSpeaker: 'yes' })).not.toHaveProperty('showSpeaker')
  })

  it('stay with both halves of a split and with a merge', () => {
    const list = [seg('a', 0, 2, 'one two', 'Sam'), seg('b', 2, 3, 'three', 'Ann')]
    const split = splitCaption(list, 'a', 1)!
    expect(split.map((s) => s.speaker)).toEqual(['Sam', 'Sam', 'Ann'])
    expect(mergeWithNext(list, 'a')![0].speaker).toBe('Sam')
    expect(mergeWithNext([seg('a', 0, 1, 'x'), seg('b', 1, 2, 'y', 'Ann')], 'a')![0].speaker).toBe('Ann')
    expect(mergeWithNext([seg('a', 0, 1, 'x'), seg('b', 1, 2, 'y')], 'a')![0]).not.toHaveProperty('speaker')
  })
})

describe('a retired model', () => {
  const list = BUNDLED_MODEL_LIST

  it('is still flagged, and its replacement suggested', () => {
    expect(list.providers.openai.transcriptionModel).toBe('gpt-transcribe')
    expect(list.retiring).toContainEqual({ provider: 'openai', model: 'whisper-1', on: '2027-02-26' })
  })

  it('fails with what to do from its day on, not before', () => {
    expect(retiredMessage(list, 'openai', 'whisper-1', '2027-02-25', 'transcription')).toBeNull()
    expect(retiredMessage(list, 'openai', 'whisper-1', '2027-02-26', 'transcription')).toBe(
      'OpenAI retired whisper-1 on 26 February 2027. Choose gpt-transcribe as the transcription model in Settings › AI providers, or make captions On this PC.'
    )
    expect(retiredMessage(list, 'openai', 'whisper-1', '2027-03-01', 'text')).toBe('OpenAI retired whisper-1 on 26 February 2027. Choose another model in Settings › AI providers.')
    expect(retiredMessage(list, 'openai', 'gpt-transcribe', '2030-01-01', 'transcription')).toBeNull()
    expect(retiredMessage(list, 'gemini', 'whisper-1', '2030-01-01', 'transcription')).toBeNull()
  })

  it('does not hide a key, quota, rate limit, server or network problem', () => {
    for (const kind of ['auth', 'quota', 'rate-limit', 'server', 'network', 'timeout', 'cancelled'] as const) {
      expect(retiredMessage(list, 'openai', 'whisper-1', '2027-03-01', 'transcription', kind)).toBeNull()
    }
    for (const kind of ['not-found', 'bad-request', 'other'] as const) expect(retiredMessage(list, 'openai', 'whisper-1', '2027-03-01', 'transcription', kind)).not.toBeNull()
  })

  it('suggests another model when the list still suggests the retired one', () => {
    const stale = { ...list, providers: { ...list.providers, openai: { model: 'm', transcriptionModel: 'whisper-1' } } }
    expect(retiredMessage(stale, 'openai', 'whisper-1', '2027-03-01', 'transcription')).toContain('Choose another transcription model')
    expect(todayUtc(new Date('2027-02-26T23:59:00Z'))).toBe('2027-02-26')
  })
})
