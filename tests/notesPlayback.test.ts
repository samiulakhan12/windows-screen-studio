import { describe, expect, it } from 'vitest'
import { applyView, choosePlaying, reachedEnd, type Playback, type PlaybackInput } from '../src/shared/notes/playback'

const rec = (over: Partial<PlaybackInput> = {}): PlaybackInput => ({ mode: 'record', recording: 'countdown', take: 1, shown: true, autoStart: true, ...over })

/** Feeds views one after the other; returns every step. */
function run(...inputs: PlaybackInput[]): { state: Playback; toTop: boolean }[] {
  let prev: Playback | null = null
  return inputs.map((input) => {
    const step = applyView(prev, input)
    prev = step.state
    return step
  })
}

describe('notes playback', () => {
  it('holds the text at the top during the countdown', () => {
    const [first, again] = run(rec(), rec())
    expect(first.toTop).toBe(true)
    expect(first.state.playing).toBe(false)
    expect(again.toTop).toBe(false)
    expect(again.state.playing).toBe(false)
  })

  it('starts on the first recording status with autoStart, not without', () => {
    expect(run(rec(), rec({ recording: 'recording' }))[1].state.playing).toBe(true)
    expect(run(rec({ autoStart: false }), rec({ recording: 'recording', autoStart: false }))[1].state.playing).toBe(false)
  })

  it('pauses with the recording and resumes only if it was scrolling', () => {
    const steps = run(rec(), rec({ recording: 'recording' }), rec({ recording: 'paused' }), rec({ recording: 'recording' }))
    expect(steps[2].state.playing).toBe(false)
    expect(steps[2].state.want).toBe(true)
    expect(steps[3].state.playing).toBe(true)
    expect(steps[3].toTop).toBe(false)

    let p = run(rec(), rec({ recording: 'recording' }))[1].state
    p = choosePlaying(p, false)
    p = applyView(p, rec({ recording: 'paused' })).state
    expect(applyView(p, rec({ recording: 'recording' })).state.playing).toBe(false)
  })

  it('pauses while hidden and resumes when shown', () => {
    const steps = run(rec(), rec({ recording: 'recording' }), rec({ recording: 'recording', shown: false }), rec({ recording: 'recording', shown: true }))
    expect(steps[2].state.playing).toBe(false)
    expect(steps[3].state.playing).toBe(true)
    const paused = choosePlaying(steps[1].state, false)
    const hidden = applyView(paused, rec({ recording: 'recording', shown: false })).state
    expect(applyView(hidden, rec({ recording: 'recording', shown: true })).state.playing).toBe(false)
  })

  it('goes back to the top for a new take', () => {
    const steps = run(rec(), rec({ recording: 'recording' }), rec({ take: 2 }), rec({ take: 2, recording: 'recording' }))
    expect(steps[2].toTop).toBe(true)
    expect(steps[2].state.playing).toBe(false)
    expect(steps[3].state.playing).toBe(true)
  })

  it('opens a rehearsal paused at the top', () => {
    const [step] = run({ mode: 'rehearse', recording: null, take: 0, shown: true, autoStart: true })
    expect(step.toTop).toBe(true)
    expect(step.state.playing).toBe(false)
    const playing = choosePlaying(step.state, true)
    expect(playing.playing).toBe(true)
    expect(applyView(playing, { mode: 'rehearse', recording: null, take: 0, shown: true, autoStart: false }).state.playing).toBe(true)
  })

  it('lets a play pressed during the countdown win over autoStart', () => {
    let p = run(rec({ autoStart: false }))[0].state
    p = choosePlaying(p, true)
    expect(p.playing).toBe(false)
    expect(applyView(p, rec({ recording: 'recording', autoStart: false })).state.playing).toBe(true)
  })

  it('lets the presenter scroll during a paused recording', () => {
    let p = run(rec(), rec({ recording: 'recording' }), rec({ recording: 'paused' }))[2].state
    p = choosePlaying(p, true)
    expect(p.playing).toBe(true)
    expect(applyView(p, rec({ recording: 'paused' })).state.playing).toBe(true)
    expect(applyView(p, rec({ recording: 'recording' })).state.playing).toBe(true)
  })

  it('stops at the end and stays stopped', () => {
    const p = reachedEnd(run(rec(), rec({ recording: 'recording' }))[1].state)
    expect(p.playing).toBe(false)
    expect(applyView(p, rec({ recording: 'paused' })).state.playing).toBe(false)
    expect(applyView(applyView(p, rec({ recording: 'paused' })).state, rec({ recording: 'recording' })).state.playing).toBe(false)
  })
})
