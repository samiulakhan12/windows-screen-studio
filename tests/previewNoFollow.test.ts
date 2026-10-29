import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { DEFAULT_REFRAME } from '../src/shared/engine/reframeData'
import type { Project } from '../src/shared/types'

/*
 * Picking a zoom's point or region on the preview shows the whole recording (player.ts
 * unzoomedScene): without zooms and, for a video that follows the action, without following
 * (docs/design/vertical-video.md §8.1 rule 7), so the point picked is where it is in the
 * recording. The compositor, the videos and the animation frames are stand-ins that record what
 * happens (as in previewShuttle.test.ts).
 */

const drawn: { t: number; project: Project }[] = []

vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_ctx: unknown, _w: number, _h: number, t: number, scene: { project: Project }) => void drawn.push({ t, project: scene.project })
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
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ onCursorAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ onStyleAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({
  onCameraMasksChanged: () => () => undefined,
  heldLivePicture: () => null
}))

/** A <video> standing on its first frame. */
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

let raf: (() => void)[] = []
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => raf.push(cb))
vi.stubGlobal('cancelAnimationFrame', () => undefined)
vi.stubGlobal('VideoFrame', class {})
vi.stubGlobal('window', { api: { stopAnalysis: async () => undefined } })
vi.stubGlobal('Path2D', class {})

function frame(): void {
  const due = raf
  raf = []
  for (const cb of due) cb()
}

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const PLAYER = '../src/renderer/src/editor/player'
type Player = {
  attachCanvas(c: unknown): void
  setScene(scene: unknown, bg: unknown): void
  setNoZoom(on: boolean): void
  drawNow(): void
  dispose(): void
}
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { PreviewPlayer: new (s: FakeVideo, w: FakeVideo | null, p: Project) => Player }

describe('picking a point on the preview of a video that follows the action', () => {
  it('draws without zooms and without following while picking, and as set again after', () => {
    const p: Project = {
      ...createProject({
        id: 'p',
        name: 'p',
        duration: 60,
        width: 1920,
        height: 1080,
        hasWebcam: false,
        hasAudio: false,
        webcamOffset: 0,
        zooms: [{ id: 'z', start: 1, end: 4, scale: 2, focus: { mode: 'cursor' }, auto: true }],
        cursorValid: false,
        capture: { method: 'native', cursorInVideo: false, region: null }
      }),
      reframe: { ...DEFAULT_REFRAME }
    }
    p.style = { ...p.style, aspectRatio: '9:16' }
    const player = new PreviewPlayer(new FakeVideo(), null, p)
    player.attachCanvas({ width: 360, height: 640, getContext: () => ({}) })
    player.setScene({ project: p, cursor: { samples: [], clicks: [], valid: false } }, null)
    frame()

    drawn.length = 0
    player.setNoZoom(true)
    frame()
    player.drawNow()
    expect(drawn.length).toBeGreaterThan(0)
    for (const d of drawn) {
      expect(d.project).not.toHaveProperty('reframe')
      expect(d.project.zooms).toEqual([])
      expect(d.project.style).toBe(p.style)
    }

    drawn.length = 0
    player.setNoZoom(false)
    frame()
    player.drawNow()
    expect(drawn.length).toBeGreaterThan(0)
    for (const d of drawn) expect(d.project).toBe(p)
    player.dispose()
  })
})
