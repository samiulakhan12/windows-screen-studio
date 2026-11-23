import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { jobSoundGains, soundGains } from '../src/shared/audio/soundsEdit'
import { writePath } from '../src/shared/privacy/coverPath'
import type { Bleep, Cover, Project } from '../src/shared/types'

/*
 * Peek and Listen, preview only (docs/design/auto-blur.md §2.8, §8.5; §17.1 tests 56 to 58): the
 * store's lifetime, the player's scene, the preview's sound, and the join stills. The videos, the
 * compositor, the soundtrack and the stills are stand-ins that record what happens (as in
 * tests/previewFreeze.test.ts).
 */

const scenes: Record<string, unknown>[] = []
vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_ctx: unknown, _w: number, _h: number, _t: number, scene: Record<string, unknown>) => void scenes.push(scene)
}))
vi.mock('../src/renderer/src/editor/previewAudio', () => ({
  PreviewAudio: class {
    failedStems: string[] = []
    onStemFailed: (() => void) | null = null
    setProject() {}
    play() {}
    pause() {}
    jump() {}
    setRate() {}
    setView() {}
    setSilent() {}
    hold() {}
    frame() {}
    fadeAt() {
      return 1
    }
    reloadMusic() {}
    dispose() {}
  }
}))
vi.mock('../src/renderer/src/editor/freezeStills', () => ({
  FreezeStills: class {
    get() {
      return { width: 1280, height: 720 }
    }
    prepare() {}
    dispose() {}
  }
}))
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ onCursorAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ onStyleAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({ onCameraMasksChanged: () => () => undefined, heldLivePicture: () => null, CameraMaskPreparer: class {} }))
vi.mock('../src/renderer/src/render/frameSource', () => ({ openTrack: async () => ({ track: { samples: null } }) }))
vi.mock('../src/renderer/src/render/joinLayer', () => ({ composeJoinStill: () => undefined, scratchTarget: () => ({}), releaseScratch: () => undefined }))

class FakeVideo extends EventTarget {
  seeking = false
  readyState = 4
  paused = true
  playbackRate = 1
  duration = 60
  videoWidth = 1280
  videoHeight = 720
  muted = false
  preservesPitch = true
  error: unknown = null
  currentSrc = 'studio-media://p/screen.mp4'
  src = this.currentSrc
  currentTime = 0
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  removeAttribute(): void {}
  load(): void {}
}

let raf: (() => void)[] = []
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => raf.push(cb))
vi.stubGlobal('cancelAnimationFrame', () => undefined)
vi.stubGlobal('VideoFrame', class {})
const inputs = new Map<string, (() => void)[]>()
vi.stubGlobal('window', {
  api: { stopAnalysis: async () => undefined, exportCapabilities: async () => ({}) },
  addEventListener: (type: string, fn: () => void) => inputs.set(type, [...(inputs.get(type) ?? []), fn]),
  removeEventListener: (type: string, fn: () => void) => inputs.set(type, (inputs.get(type) ?? []).filter((f) => f !== fn))
})
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) })
vi.stubGlobal('Path2D', class {})
const frame = (): void => {
  const due = raf
  raf = []
  for (const cb of due) cb()
}

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const PLAYER = '../src/renderer/src/editor/player'
const PEEK = '../src/renderer/src/privacy/peek'
const EXPORTER = '../src/renderer/src/editor/exporter'
const STILLS = '../src/renderer/src/guide/guideStills'
const JOIN_STILLS = '../src/renderer/src/editor/joinStills'
type Peek = {
  peekCovers(ids: readonly string[] | 'all' | null): void
  peekWhileReviewing(on: boolean): void
  listenBleep(id: string | null): void
  showCoverMarks(on: boolean): void
  clearPeek(): void
  peekNow(): { ids: readonly string[] | 'all' | null; review: boolean; listen: string | null; marks: boolean }
  peekedScene<S>(scene: S): S
  listenedGains(gains: readonly { start: number; end: number; gain: number }[], project: Pick<Project, 'bleeps'>): readonly { start: number; end: number; gain: number }[]
  listenedProject<P extends Pick<Project, 'bleeps'>>(project: P): P
}
const peek = (await import(/* @vite-ignore */ PEEK)) as Peek
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as {
  PreviewPlayer: new (s: FakeVideo, w: FakeVideo | null, p: Project) => { attachCanvas(c: unknown): void; setScene(s: unknown, b: unknown): void; dispose(): void; seek(t: number): void }
}

const cover = (id: string, start: number, end: number): Cover => ({ id, start, end, path: writePath([{ t: start, x: 0.2, y: 0.2, w: 0.2, h: 0.05 }]), color: '#203040' })
function project(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
  })
  return { ...p, ...over }
}

afterEach(() => {
  peek.clearPeek()
  peek.showCoverMarks(true)
  vi.useRealTimers()
})

describe('auto-blur P1: Peek and Listen stay in the preview', () => {
  it('56. The peek store clears on project close, before an export starts, before guide shots, and after 60 s without input; peekedScene adds peek only to the preview\'s scene', async () => {
    const p = project({ covers: [cover('a', 1, 5), cover('b', 2, 6)] })
    const screen = new FakeVideo()
    const player = new PreviewPlayer(screen, null, p)
    player.attachCanvas({ width: 640, height: 360, getContext: () => ({}) })
    const scene = { project: p, cursor: { samples: [], clicks: [], valid: false } }
    player.setScene(scene, null)
    frame()
    // The player's preview scene: Show where covers are (on by default) for a project with covers.
    expect(scenes.at(-1)!.coverMarks).toBe(true)
    expect(scenes.at(-1)!.peek).toBeUndefined()
    peek.peekCovers(['a'])
    frame()
    expect(scenes.at(-1)!.peek).toEqual({ ids: ['a'] })
    // peekedScene leaves a scene without covers, and with nothing peeked, as it is.
    peek.clearPeek()
    const bare = { project: project(), cursor: scene.cursor } as never
    expect(peek.peekedScene(bare)).toBe(bare)
    peek.showCoverMarks(false)
    expect(peek.peekedScene(scene as never)).toBe(scene)
    peek.showCoverMarks(true)
    // The project closes: Peek and Listen stop.
    peek.peekCovers('all')
    peek.listenBleep('pb')
    player.dispose()
    expect([peek.peekNow().ids, peek.peekNow().listen]).toEqual([null, null])
    // Before an export starts (exportVideo clears it first, whatever comes after).
    peek.peekCovers('all')
    const { exportVideo } = (await import(/* @vite-ignore */ EXPORTER)) as { exportVideo(i: unknown): Promise<unknown> }
    await exportVideo({ project: p }).catch(() => undefined)
    expect(peek.peekNow().ids).toBeNull()
    // Before guide shots.
    peek.peekCovers(['b'])
    peek.peekWhileReviewing(true)
    const { renderGuideStills } = (await import(/* @vite-ignore */ STILLS)) as { renderGuideStills(i: unknown, s: unknown[], o: unknown): AsyncGenerator<unknown> }
    await renderGuideStills({ project: p }, [{ key: 'k', t: 1, rect: { x: 0, y: 0, w: 10, h: 10 } }], { mime: 'image/png', quality: 1, maxWidth: 100, signal: new AbortController().signal })
      .next()
      .catch(() => undefined)
    expect([peek.peekNow().ids, peek.peekNow().review]).toEqual([null, false])
    // After 60 s without input; any input puts it off.
    vi.useFakeTimers()
    peek.peekCovers(['a'])
    vi.advanceTimersByTime(59_000)
    for (const f of inputs.get('keydown') ?? []) f()
    vi.advanceTimersByTime(59_000)
    expect(peek.peekNow().ids).toEqual(['a'])
    vi.advanceTimersByTime(1_500)
    expect(peek.peekNow().ids).toBeNull()
    // The outlines of Show where covers are stay as the preference says.
    expect(peek.peekNow().marks).toBe(true)
  })

  it('57. listenedGains leaves out only the listened bleep; the export\'s gains are unchanged', () => {
    const bleeps: Bleep[] = [
      { id: 'pb', start: 10, end: 11, word: ':card:k3v9q2m8xa', sound: 'tone' },
      { id: 'w', start: 10.5, end: 10.8, word: 'save', sound: 'tone' },
      { id: 'other', start: 20, end: 20.5, word: ':phone:abc', sound: 'tone' }
    ]
    const p = project({ bleeps, sounds: { spans: [{ start: 30, end: 31, action: 'mute' }] } as never })
    const before = jobSoundGains(p)
    const gains = soundGains(p)
    // Nothing listened to: the gains themselves.
    expect(peek.listenedGains(gains, p)).toBe(gains)
    peek.listenBleep('pb')
    const heard = peek.listenedGains(gains, p)
    // The listened span plays again, except where another bleep mutes its own word; the rest as before.
    expect(heard).toEqual([
      { start: 10.5, end: 10.8, gain: 0 },
      { start: 20, end: 20.5, gain: 0 },
      { start: 30, end: 31, gain: 0 }
    ])
    // The preview's tones leave it out too; the export's gains and project do not change.
    expect(peek.listenedProject(p).bleeps!.map((b) => b.id)).toEqual(['w', 'other'])
    expect(jobSoundGains(p)).toEqual(before)
    expect(p.bleeps).toBe(bleeps)
  })

  it('58. joinStills never returns a still composed with another peek state (its fallback)', async () => {
    const { JoinStills } = (await import(/* @vite-ignore */ JOIN_STILLS)) as {
      JoinStills: new (s: string, w: string | null, ready: () => void) => { prepare(w: unknown[], scene: unknown, w2: number, h: number): void; still(w: unknown, w2: number, h: number): unknown; dispose(): void }
    }
    vi.useFakeTimers()
    const p = project({ covers: [cover('a', 1, 5)] })
    const plain = { project: p }
    const peeked = { project: p, peek: { ids: ['a'] } }
    const marked = { project: p, coverMarks: true }
    const win = { clip: 'c2', from: 4, to: 5, still: { screen: 4, camera: null, held: false } }
    const stills = new JoinStills('studio-media://p/screen.mp4', null, () => undefined)
    await vi.runAllTimersAsync()
    stills.prepare([win], plain, 64, 36)
    await vi.runAllTimersAsync()
    const composed = stills.still(win, 64, 36)
    expect(composed).not.toBeNull()
    // Peek turned on: the still composed without it is never given; a hard cut until it is made again.
    stills.prepare([win], peeked, 64, 36)
    expect(stills.still(win, 64, 36)).toBeNull()
    await vi.runAllTimersAsync()
    expect(stills.still(win, 64, 36)).toBe(composed)
    // So for the cover outlines.
    stills.prepare([win], marked, 64, 36)
    expect(stills.still(win, 64, 36)).toBeNull()
    stills.dispose()
  })
})
