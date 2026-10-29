// Clean voice's stems as the editor sees them (src/renderer/src/editor/voiceStems.ts,
// docs/design/clean-voice.md §4.4), with a fake API.
import { describe, expect, it } from 'vitest'
import { VOICE_CANCELLED, VOICE_REPLACED, type VoiceApi, type VoiceProgress, type VoiceStemStatus } from '../src/shared/api/voice'
import type { VoiceSource } from '../src/shared/audio/voiceClean'
import type { VoiceStrength } from '../src/shared/types'

type State = { state: string; progress?: number; file?: string; message?: string }
interface Stems {
  subscribe(l: () => void): () => void
  get(id: string, source: VoiceSource, strength: VoiceStrength): State
  want(id: string, source: VoiceSource, strength: VoiceStrength): void
  prepare(id: string, source: VoiceSource, strength: VoiceStrength): Promise<string>
  cancel(id: string): Promise<void>
  forget(id: string, source: VoiceSource, strength: VoiceStrength): void
  isOriginal(id: string): boolean
  setOriginal(id: string, on: boolean): void
  closeProject(id: string): void
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const STEMS = '../src/renderer/src/editor/voiceStems'
const { VoiceStems } = (await import(/* @vite-ignore */ STEMS)) as { VoiceStems: new (api: VoiceApi) => Stems }

/** A fake main process: renders wait until `finish` / `fail` is called. */
function fakeApi(initial: VoiceStemStatus = { state: 'missing' }) {
  let status = initial
  let progress: ((p: VoiceProgress) => void) | null = null
  const waiting: { resolve: (f: string) => void; reject: (e: Error) => void }[] = []
  const calls = { status: 0, prepare: 0, cancel: 0 }
  const api: VoiceApi = {
    voiceStatus: async () => {
      calls.status++
      return status
    },
    prepareVoice: () => {
      calls.prepare++
      return new Promise<string>((resolve, reject) => waiting.push({ resolve, reject }))
    },
    cancelVoice: async () => {
      calls.cancel++
      // As Electron forwards a rejection from main.
      for (const w of waiting.splice(0)) w.reject(new Error(`Error invoking remote method 'voice:prepare': Error: ${VOICE_CANCELLED}`))
    },
    onVoiceProgress: (l) => {
      progress = l
      return () => undefined
    }
  }
  return {
    api,
    calls,
    setStatus: (s: VoiceStemStatus) => (status = s),
    progress: (p: VoiceProgress) => progress?.(p),
    finish: (file: string) => waiting.splice(0).forEach((w) => w.resolve(file)),
    fail: (message: string) => waiting.splice(0).forEach((w) => w.reject(new Error(`Error invoking remote method 'voice:prepare': Error: ${message}`)))
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const FILE = 'voice-0123456789abcdef.m4a'

describe('VoiceStems', () => {
  it('makes a missing stem as soon as the preview wants it, once', async () => {
    const f = fakeApi()
    const s = new VoiceStems(f.api)
    let changes = 0
    s.subscribe(() => changes++)
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'checking' })
    s.want('p', 'mic', 'normal')
    s.want('p', 'mic', 'normal')
    await tick()
    expect(f.calls.prepare).toBe(1)
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'working', progress: 0 })
    f.progress({ projectId: 'p', source: 'mic', strength: 'normal', progress: 0.4 })
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'working', progress: 0.4 })
    f.finish(FILE)
    await tick()
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'ready', file: FILE })
    expect(changes).toBeGreaterThan(2)
    // Progress that arrives late changes nothing.
    f.progress({ projectId: 'p', source: 'mic', strength: 'normal', progress: 0.9 })
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'ready', file: FILE })
  })

  it('uses a stem that is already there', async () => {
    const f = fakeApi({ state: 'ready', file: FILE })
    const s = new VoiceStems(f.api)
    s.want('p', 'mix', 'light')
    await tick()
    expect(s.get('p', 'mix', 'light')).toEqual({ state: 'ready', file: FILE })
    expect(f.calls.prepare).toBe(0)
    await expect(s.prepare('p', 'mix', 'light')).resolves.toBe(FILE)
    expect(f.calls.prepare).toBe(0)
  })

  it('keeps each project, source and strength apart', async () => {
    const f = fakeApi()
    const s = new VoiceStems(f.api)
    s.want('p', 'mic', 'normal')
    await tick()
    expect(s.get('p', 'mic', 'strong')).toEqual({ state: 'checking' })
    expect(s.get('q', 'mic', 'normal')).toEqual({ state: 'checking' })
    f.progress({ projectId: 'q', source: 'mic', strength: 'normal', progress: 0.5 })
    expect(s.get('q', 'mic', 'normal')).toEqual({ state: 'checking' })
  })

  it('after Cancel the preview does not start it again; Clean now does', async () => {
    const f = fakeApi()
    const s = new VoiceStems(f.api)
    s.want('p', 'mic', 'normal')
    await tick()
    await s.cancel('p')
    await tick()
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'stopped' })
    s.want('p', 'mic', 'normal')
    await tick()
    expect(f.calls.prepare).toBe(1)
    const again = s.prepare('p', 'mic', 'normal')
    await tick()
    expect(f.calls.prepare).toBe(2)
    f.finish(FILE)
    await expect(again).resolves.toBe(FILE)
  })

  it('a render replaced by another strength is made again when wanted again (undo back to it)', async () => {
    const f = fakeApi()
    const s = new VoiceStems(f.api)
    s.want('p', 'mic', 'normal')
    await tick()
    // Main stops it for Strong.
    f.fail(VOICE_REPLACED)
    await tick()
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'checking' })
    s.want('p', 'mic', 'normal')
    await tick()
    expect(f.calls.prepare).toBe(2)
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'working', progress: 0 })
  })

  it('a failure is shown with its reason and not retried until asked', async () => {
    const f = fakeApi()
    const s = new VoiceStems(f.api)
    s.want('p', 'mic', 'normal')
    await tick()
    f.fail('The disk is full.')
    await tick()
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'failed', message: 'The disk is full.' })
    s.want('p', 'mic', 'normal')
    await tick()
    expect(f.calls.prepare).toBe(1)
    const retry = s.prepare('p', 'mic', 'normal')
    await tick()
    f.fail('Again.')
    await expect(retry).rejects.toThrow('Again.')
  })

  it('the export joins a render under way', async () => {
    const f = fakeApi()
    const s = new VoiceStems(f.api)
    const a = s.prepare('p', 'mic', 'strong')
    const b = s.prepare('p', 'mic', 'strong')
    await tick()
    expect(f.calls.prepare).toBe(1)
    f.finish(FILE)
    await expect(Promise.all([a, b])).resolves.toEqual([FILE, FILE])
  })

  it('the export checks a ready stem is still there, and makes it again with progress when it is gone', async () => {
    const f = fakeApi({ state: 'ready', file: FILE })
    const s = new VoiceStems(f.api)
    s.want('p', 'mic', 'normal')
    await tick()
    // Still there: the same file, without a render or a flash of another state.
    const same = s.prepare('p', 'mic', 'normal')
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'ready', file: FILE })
    await expect(same).resolves.toBe(FILE)
    expect(f.calls.prepare).toBe(0)
    // Deleted from the project folder meanwhile.
    f.setStatus({ state: 'missing' })
    const again = s.prepare('p', 'mic', 'normal')
    await tick()
    expect(f.calls.prepare).toBe(1)
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'working', progress: 0 })
    const other = 'voice-fedcba9876543210.m4a'
    f.finish(other)
    await expect(again).resolves.toBe(other)
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'ready', file: other })
  })

  it('a stem the preview cannot load is checked again', async () => {
    const f = fakeApi({ state: 'ready', file: FILE })
    const s = new VoiceStems(f.api)
    s.want('p', 'mic', 'normal')
    await tick()
    f.setStatus({ state: 'missing' })
    s.forget('p', 'mic', 'normal')
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'checking' })
    s.want('p', 'mic', 'normal')
    await tick()
    expect(f.calls.prepare).toBe(1)
  })

  it('Hear the original is per project and dropped when the editor closes', () => {
    const s = new VoiceStems(fakeApi().api)
    let changes = 0
    s.subscribe(() => changes++)
    s.setOriginal('p', true)
    s.setOriginal('p', true)
    expect(changes).toBe(1)
    expect(s.isOriginal('p')).toBe(true)
    expect(s.isOriginal('q')).toBe(false)
    s.closeProject('p')
    expect(s.isOriginal('p')).toBe(false)
  })

  it('a render stopped by closing the editor is made again when it opens again', async () => {
    const f = fakeApi()
    const s = new VoiceStems(f.api)
    s.want('p', 'mic', 'normal')
    await tick()
    s.closeProject('p')
    // Main stops the render when the editor closes.
    await f.api.cancelVoice('p')
    await tick()
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'checking' })
    s.want('p', 'mic', 'normal')
    await tick()
    expect(f.calls.prepare).toBe(2)
    expect(s.get('p', 'mic', 'normal')).toEqual({ state: 'working', progress: 0 })
  })
})
