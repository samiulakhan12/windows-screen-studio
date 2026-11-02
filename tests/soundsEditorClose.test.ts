import { describe, expect, it, vi } from 'vitest'
import type { SoundsApi } from '../src/shared/api/sounds'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * Closing the editor stops a search for unwanted sounds as Cancel does (docs/design/sound-finder.md
 * §4.7): the player's dispose cancels it. Without that it went on without the levels and the speech
 * detector (their measurement stops with the editor), or ended as a failure when main dropped its
 * stream. The player's soundtrack, compositor and videos are stand-ins (as in previewNoFollow.test.ts).
 */

/** The levels and the speech detector: held until released (a stop of the project's work makes them come back empty). */
const analysis = vi.hoisted(() => ({ hold: false, release: [] as (() => void)[] }))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({
  loadAudioAnalysis: () => (analysis.hold ? new Promise((resolve) => analysis.release.push(() => resolve({}))) : Promise.resolve({}))
}))
vi.mock('../src/renderer/src/render/compositor', () => ({ drawFrame: () => undefined }))
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
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ onCursorAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ onStyleAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({
  onCameraMasksChanged: () => () => undefined,
  heldLivePicture: () => null
}))

class FakeVideo extends EventTarget {
  seeking = false
  readyState = 4
  paused = true
  playbackRate = 1
  duration = 60
  videoWidth = 1920
  videoHeight = 1080
  muted = false
  preservesPitch = true
  error: unknown = null
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

/** Main's side of a stop of the project's work: its sound streams are dropped. */
const mainStops: (() => void)[] = []
vi.stubGlobal('requestAnimationFrame', () => 0)
vi.stubGlobal('cancelAnimationFrame', () => undefined)
vi.stubGlobal('VideoFrame', class {})
vi.stubGlobal('Path2D', class {})
vi.stubGlobal('window', {
  api: {
    stopAnalysis: async () => {
      for (const stop of mainStops.splice(0)) stop()
    }
  }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const PLAYER = '../src/renderer/src/editor/player'
const SCAN = '../src/renderer/src/editor/sounds/soundScan'
type ScanProject = Pick<Project, 'id' | 'hasAudio' | 'audioStems' | 'duration'>
type Listener = { info: Promise<{ size: number; mtimeMs: number }>; done: Promise<{ n: number; scores: Uint8Array }>; stop(): void }
type ListenFn = (api: SoundsApi, project: ScanProject, source: string, skip: unknown, onSeconds: (s: number) => void) => Listener
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { PreviewPlayer: new (s: FakeVideo, w: FakeVideo | null, p: Project) => { dispose(): void } }
const { scanState, startScan } = (await import(/* @vite-ignore */ SCAN)) as {
  scanState(id: string): { status: string; preparing?: boolean; message?: string }
  startScan(api: SoundsApi, p: ScanProject, listen: ListenFn): Promise<void>
}

const project = (id: string): Project =>
  createProject({
    id,
    name: id,
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })

const api = { soundsCached: vi.fn(async () => null), soundsSave: vi.fn(async () => undefined) } as unknown as SoundsApi

describe('closing the editor during a search for unwanted sounds', () => {
  it('stops it while the recording is still being got ready: nothing is listened to', async () => {
    const p = project('close-preparing')
    const player = new PreviewPlayer(new FakeVideo(), null, p)
    const listen = vi.fn<ListenFn>(() => ({ info: Promise.resolve({ size: 1, mtimeMs: 1 }), done: Promise.resolve({ n: 0, scores: new Uint8Array(0) }), stop: () => undefined }))
    analysis.hold = true
    const run = startScan(api, p, listen)
    expect(scanState(p.id)).toMatchObject({ status: 'listening', preparing: true })
    player.dispose()
    // The measurement stopped with the editor: it comes back empty.
    for (const release of analysis.release.splice(0)) release()
    await run
    analysis.hold = false
    expect(listen).not.toHaveBeenCalled()
    expect(scanState(p.id)).toEqual({ status: 'idle' })
  })

  it('stops it while listening: the workers stop and the dropped stream is no failure', async () => {
    const p = project('close-listening')
    const player = new PreviewPlayer(new FakeVideo(), null, p)
    const stopped: string[] = []
    const listen = vi.fn<ListenFn>((_api, _p, source) => {
      let fail!: (e: Error) => void
      const done = new Promise<{ n: number; scores: Uint8Array }>((_resolve, reject) => (fail = reject))
      done.catch(() => undefined)
      // Main drops the stream: the next read finds no such stream.
      mainStops.push(() => fail(new Error('No such sound stream')))
      return {
        info: Promise.resolve({ size: 1, mtimeMs: 1 }),
        done,
        stop: () => {
          stopped.push(source)
          fail(new Error('cancelled'))
        }
      }
    })
    const run = startScan(api, p, listen)
    await vi.waitFor(() => expect(listen).toHaveBeenCalled())
    player.dispose()
    await run
    expect(stopped).toContain('mix')
    expect(scanState(p.id)).toEqual({ status: 'idle' })
  })
})
