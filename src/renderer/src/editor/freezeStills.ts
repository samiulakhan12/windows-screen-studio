import { createVideo, seekedFrame, seekToFrame, whenReady } from './media'

/** Stills kept at once (a 4K one is about 33 MB). */
const MAX_STILLS = 6

/**
 * The frames continue freezes hold in the preview (E-11, docs/design/freeze-frame.md §4.6), while
 * the screen element plays on for its sound. Each comes from one hidden <video> through the export's
 * own seek path (seekToFrame + seekedFrame), so the preview shows the frame the export draws. Kept
 * in a small LRU keyed by the anchor in ms; until one is ready the preview draws the live picture.
 */
export class FreezeStills {
  private readonly video: HTMLVideoElement
  private readonly stills = new Map<number, ImageBitmap>()
  private readonly queue: number[] = []
  private busy = false
  /** The hidden video could not load or seek: the preview draws the live picture from now on. */
  private failed = false
  private disposed = false

  constructor(
    url: string,
    private readonly fps: number,
    /** Called when a still is ready (the paused preview redraws). */
    private readonly onReady?: () => void
  ) {
    this.video = createVideo(url)
    this.video.muted = true
  }

  /** The still of source time `at`, or null while it is being made (it is asked for). */
  get(at: number): ImageBitmap | null {
    const key = Math.round(at * 1000)
    const still = this.stills.get(key)
    if (!still) {
      this.request(key)
      return null
    }
    // Most recently used last.
    this.stills.delete(key)
    this.stills.set(key, still)
    return still
  }

  /** Makes the stills of these anchors ahead of time (the first MAX_STILLS of them). */
  prepare(ats: readonly number[]): void {
    for (const at of ats.slice(0, MAX_STILLS)) this.request(Math.round(at * 1000))
  }

  private request(key: number): void {
    if (this.disposed || this.failed || this.stills.has(key) || this.queue.includes(key)) return
    this.queue.push(key)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await whenReady(this.video)
      for (let key = this.queue.shift(); key !== undefined && !this.disposed; key = this.queue.shift()) {
        const at = key / 1000
        await seekToFrame(this.video, at, this.fps)
        const seeked = await seekedFrame(this.video, at, this.fps)
        let still: ImageBitmap
        try {
          still = await createImageBitmap(seeked?.frame ?? this.video)
        } finally {
          seeked?.frame.close()
        }
        if (this.disposed) {
          still.close()
          break
        }
        this.keep(key, still)
        this.onReady?.()
      }
    } catch {
      // The preview keeps drawing the live picture; the export decodes its own frames.
      this.failed = true
      this.queue.length = 0
    } finally {
      this.busy = false
    }
  }

  private keep(key: number, still: ImageBitmap): void {
    this.stills.get(key)?.close()
    this.stills.delete(key)
    this.stills.set(key, still)
    for (const [k, old] of this.stills) {
      if (this.stills.size <= MAX_STILLS) break
      old.close()
      this.stills.delete(k)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queue.length = 0
    for (const still of this.stills.values()) still.close()
    this.stills.clear()
    this.video.removeAttribute('src')
    this.video.load()
  }
}
