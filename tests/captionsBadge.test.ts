import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelView, SpeechState } from '../src/shared/api/speech'
import { SPEECH_MODELS, type SpeechModelId } from '../src/shared/speech/catalog'

/*
 * The ring on the Captions tab while a download from that tab runs (docs/design/offline-captions.md
 * §7.6, §10.3 item 2), through useCaptionsHost without a DOM: the hooks it calls are stand-ins,
 * and the speech state is pushed the way main's speech:changed does.
 */

type Status = SpeechModelView['status']
function speechState(statuses: Partial<Record<SpeechModelId, Status>> = {}): SpeechState {
  return {
    engine: { available: true, build: 'standard', threads: 3 },
    detector: { available: true },
    models: SPEECH_MODELS.map((m) => ({
      id: m.id,
      tier: m.tier,
      name: m.name,
      bytes: m.bytes,
      rtf4: m.rtf4,
      ramMB: m.ramMB,
      wer: m.wer,
      partSeconds: m.partSeconds,
      license: m.license,
      status: statuses[m.id] ?? { state: 'missing' },
      inUse: false,
      allowed: true
    })),
    defaultModel: 'whisper-base',
    disk: { free: 100e9, used: 0 },
    memory: { total: 16 * 2 ** 30, free: 8e9 },
    cores: 4
  }
}

let push: ((state: SpeechState) => void) | null = null
let finish: { resolve: () => void; reject: (err: unknown) => void } | null = null
vi.stubGlobal('window', {
  api: {
    getSpeechState: () => Promise.resolve(speechState()),
    onSpeechState: (listener: (state: SpeechState) => void) => {
      push = listener
      return () => undefined
    },
    downloadSpeechModel: () => new Promise<void>((resolve, reject) => (finish = { resolve, reject })),
    setDefaultSpeechModel: () => Promise.resolve(),
    transcribe: () => new Promise(() => undefined),
    onTranscribeProgress: () => () => undefined
  }
})

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRef: (current: unknown) => ({ current }),
  useEffect: (fn: () => void) => void fn(),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  // useEditor() is the only context useCaptionsHost reads.
  useContext: () => ({ store: { state: { id: 'p1' } }, player: {} })
}))

interface Badge {
  phase: 'download' | 'verify' | 'job'
  title: string
}
interface SpeechStateModule {
  useCaptionsHost(projectId: string, onNotice: (m: string) => void, captionsOpen: boolean): Badge | null
  downloadThenCaptions(projectId: string, model: SpeechModelId, options: object): Promise<void>
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SPEECH_STATE = '../src/renderer/src/editor/speechState'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the Captions tab badge (useCaptionsHost)', () => {
  let m: SpeechStateModule
  const badge = (projectId = 'p1'): Badge | null => m.useCaptionsHost(projectId, () => undefined, false)
  beforeEach(async () => {
    vi.resetModules()
    push = null
    finish = null
    m = (await import(/* @vite-ignore */ SPEECH_STATE)) as SpeechStateModule
    expect(badge()).toBeNull()
    await flush()
    expect(push).not.toBeNull()
  })

  it('shows the download of this project, its share, also while it waits to try again', async () => {
    void m.downloadThenCaptions('p1', 'whisper-tiny', {})
    push!(speechState({ 'whisper-tiny': { state: 'downloading', received: 25, total: 100, bytesPerSecond: 1e6 } }))
    expect(badge()).toEqual({ phase: 'download', title: 'Captions: downloading the speech model, 25 %' })
    push!(speechState({ 'whisper-tiny': { state: 'downloading', received: 80, total: 100, bytesPerSecond: 0, retrying: { attempt: 1, of: 3 } } }))
    expect(badge()).toEqual({ phase: 'download', title: 'Captions: downloading the speech model, 80 %' })
    // Another editor's tab has no ring for it.
    expect(badge('p2')).toBeNull()
  })

  it('shows the check of the download until captions start', async () => {
    void m.downloadThenCaptions('p1', 'whisper-tiny', {})
    push!(speechState({ 'whisper-tiny': { state: 'verifying' } }))
    expect(badge()).toEqual({ phase: 'verify', title: 'Captions: checking the download' })
    // Installed while the download call has not returned yet: still the step before captions.
    push!(speechState({ 'whisper-tiny': { state: 'installed' } }))
    expect(badge()?.phase).toBe('verify')
  })

  it('no ring for a download without the intent (Settings), nor after it failed', async () => {
    push!(speechState({ 'whisper-tiny': { state: 'downloading', received: 25, total: 100, bytesPerSecond: 1e6 } }))
    expect(badge()).toBeNull()
    void m.downloadThenCaptions('p1', 'whisper-tiny', {})
    expect(badge()?.phase).toBe('download')
    finish!.reject(new Error('The connection dropped.'))
    await flush()
    expect(badge()).toBeNull()
  })
})
