import { describe, expect, it, vi } from 'vitest'

/**
 * A new cover's colour is read from a hidden <video> of the project's screen (docs/design/auto-blur.md
 * §8.4). A video just made has no metadata: a browser then takes a time set on it as where to start,
 * and no seek happens (HTML's "default playback start position"), so no `seeked` comes. Found end to
 * end (A14): the first pick of a session, the guide's *Blur an area…*, timed out and gave Dark instead
 * of the colour around the area in the step's own shot frame. The seek now waits for the metadata.
 */

/** A hidden video as Chromium has it: no seek before its metadata, which arrives a moment after `src`. */
class Video extends EventTarget {
  muted = false
  preload = ''
  readyState = 0
  videoWidth = 0
  videoHeight = 0
  private time = 0
  private source = ''
  get src(): string {
    return this.source
  }
  set src(v: string) {
    this.source = v
    setTimeout(() => {
      this.readyState = 1
      this.videoWidth = 64
      this.videoHeight = 36
      this.dispatchEvent(new Event('loadedmetadata'))
    }, 30)
  }
  get currentTime(): number {
    return this.time
  }
  set currentTime(t: number) {
    this.time = t
    if (this.readyState === 0) return
    setTimeout(() => {
      this.readyState = 2
      this.dispatchEvent(new Event('seeked'))
    }, 5)
  }
  removeAttribute(): void {}
  load(): void {}
}

/** Every pixel of the frame is this red. */
const RED = [200, 30, 30]
function canvas(): Record<string, unknown> {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(4 * w * h)
        for (let i = 0; i < w * h; i++) data.set([...RED, 255], i * 4)
        return { data }
      }
    })
  }
}

vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'video' ? new Video() : canvas()) })
vi.stubGlobal('window', { api: { getPref: async () => null } })

const PICK = '../src/renderer/src/privacy/coverPick'
const pick = (await import(/* @vite-ignore */ PICK)) as { ringColourAt(id: string, t: number, box: unknown): Promise<string> }

describe("a new cover's colour from a video just made", () => {
  it('waits for its metadata, then seeks and reads the ring', async () => {
    const t0 = Date.now()
    const colour = await pick.ringColourAt('fresh-project', 2.9, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect(colour).toBe('#c81e1e')
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
