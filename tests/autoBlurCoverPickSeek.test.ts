import { describe, expect, it, vi } from 'vitest'

/**
 * A new cover's colour is read from a hidden <video> of the project's screen (docs/design/auto-blur.md
 * §8.4). Found end to end (A14), where the guide's *Blur an area…* always gave Dark instead of the
 * colour around the area in the step's own shot frame:
 * - a video just made has no metadata: a browser then takes a time set on it as where to start, and
 *   no seek happens (HTML's "default playback start position"), so no `seeked` came and the pick
 *   timed out. The seek now waits for the metadata.
 * - the video is served from Flown's media address: without `crossOrigin = 'anonymous'` (as the
 *   preview's own video has) the canvas it is drawn on is tainted and getImageData throws.
 */

/** A hidden video as Chromium has it: no seek before its metadata, which arrives a moment after `src`. */
class Video extends EventTarget {
  crossOrigin: string | null = null
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
      drawImage(source: Video) {
        // A media element from another origin without CORS taints the canvas, as a browser does.
        if (source.crossOrigin !== 'anonymous') this.tainted = true
      },
      tainted: false,
      getImageData(_x: number, _y: number, w: number, h: number) {
        if (this.tainted) throw new Error('SecurityError: The canvas has been tainted by cross-origin data.')
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
