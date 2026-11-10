import { describe, expect, it } from 'vitest'

/*
 * whenReady (src/renderer/src/editor/media.ts) for a video whose first frame has loaded and which is
 * seeking again: the export dialog's preview asks for it while its first seek is still running (the
 * Thumbnail frame slider moved before the preview's first frame). 'loadeddata' never fires a second
 * time, so the wait has to end with the seek; before, the preview stayed blank until the next move.
 */

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow its DOM types.
const MEDIA = '../src/renderer/src/editor/media'
const { whenReady } = (await import(/* @vite-ignore */ MEDIA)) as { whenReady(v: unknown): Promise<void> }

class FakeVideo extends EventTarget {
  readyState = 0
  error: { message: string } | null = null
}

/** 'ready', 'failed: …', or 'waiting' when the promise has not settled after the events ran. */
async function outcome(p: Promise<void>): Promise<string> {
  const pending = Symbol('pending')
  const r = await Promise.race([p.then(() => 'ready', (e: Error) => `failed: ${e.message}`), new Promise((res) => setTimeout(() => res(pending), 20))])
  return r === pending ? 'waiting' : (r as string)
}

describe('whenReady', () => {
  it('is ready at once with a current frame, and after the first frame loads', async () => {
    const v = new FakeVideo()
    v.readyState = 2
    expect(await outcome(whenReady(v))).toBe('ready')
    const w = new FakeVideo()
    const p = whenReady(w)
    expect(await outcome(p)).toBe('waiting')
    w.readyState = 2
    w.dispatchEvent(new Event('loadeddata'))
    expect(await outcome(p)).toBe('ready')
  })

  it('a video seeking again after its first frame is ready when the seek ends, not only on a second loadeddata', async () => {
    const v = new FakeVideo()
    // Loaded, then a seek started: HAVE_METADATA until 'seeked'.
    v.readyState = 1
    const p = whenReady(v)
    expect(await outcome(p)).toBe('waiting')
    v.readyState = 4
    v.dispatchEvent(new Event('seeked'))
    expect(await outcome(p)).toBe('ready')
  })

  it("waits on through a 'seeked' or 'canplay' that leaves no current frame, and fails on an error", async () => {
    const v = new FakeVideo()
    v.readyState = 1
    const p = whenReady(v)
    v.dispatchEvent(new Event('seeked'))
    expect(await outcome(p)).toBe('waiting')
    v.readyState = 3
    v.dispatchEvent(new Event('canplay'))
    expect(await outcome(p)).toBe('ready')
    const w = new FakeVideo()
    const q = whenReady(w)
    w.error = { message: 'broken' }
    w.dispatchEvent(new Event('error'))
    expect(await outcome(q)).toBe('failed: Could not load video (broken)')
  })
})
