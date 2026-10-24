import { segmentationSize } from '../../../../shared/render/cameraLook'
import type { FromWorker, ToWorker } from './protocol'

/** Where person segmentation (the camera's background blur) is: loaded on first use, once per window. */
export type SegmenterState = { status: 'idle' } | { status: 'loading' } | { status: 'ready' } | { status: 'failed'; reason: string }

/** Where the person is in one camera picture: RGBA pixels, alpha = person, covering the whole picture. */
export interface PersonMask {
  pixels: ImageData
}

/** Pictures in a row that may fail (each is drawn unblurred) before segmentation counts as broken. */
const MAX_MISSES = 3

let worker: Worker | null = null
let state: SegmenterState = { status: 'idle' }
let ready: Promise<boolean> | null = null
let nextId = 1
let misses = 0
const pending = new Map<number, (mask: PersonMask | null) => void>()
const listeners = new Set<() => void>()

export const segmenterState = (): SegmenterState => state

/** Calls `listener` whenever the state changes; returns the unsubscribe function. */
export function onSegmenterState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setState(next: SegmenterState): void {
  state = next
  for (const l of [...listeners]) l()
}

/** Segmentation cannot run here: everything waiting gets no mask, and the camera is drawn unblurred from now on. */
function fail(reason: string): void {
  if (state.status === 'failed') return
  console.warn(`Background blur is unavailable: ${reason}`)
  worker?.terminate()
  worker = null
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
  setState({ status: 'failed', reason })
}

function settle(id: number, mask: PersonMask | null): void {
  const resolve = pending.get(id)
  pending.delete(id)
  resolve?.(mask)
}

function onMessage(e: MessageEvent<FromWorker>): void {
  const msg = e.data
  if (msg.type === 'ready') {
    if (state.status === 'loading') setState({ status: 'ready' })
  } else if (msg.type === 'mask') {
    misses = 0
    settle(msg.id, { pixels: new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height) })
  } else if (msg.type === 'missed') {
    // One picture failed: it gets no mask. Failing again and again means segmentation is broken here.
    settle(msg.id, null)
    if (++misses >= MAX_MISSES) fail(msg.reason)
    else console.warn(`Background blur skipped a camera frame: ${msg.reason}`)
  } else {
    fail(msg.reason)
  }
}

/** Starts loading segmentation (once); resolves true when it can run, false when it cannot. */
export function ensureSegmenter(): Promise<boolean> {
  if (ready) return ready
  ready = new Promise<boolean>((resolve) => {
    const done = (): void => {
      if (state.status === 'ready' || state.status === 'failed') {
        off()
        resolve(state.status === 'ready')
      }
    }
    const off = onSegmenterState(done)
    setState({ status: 'loading' })
    try {
      worker = new Worker(new URL('./segmentation.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = onMessage
      worker.onerror = (e) => fail(`it ${state.status === 'ready' ? 'stopped working' : 'could not start'} (${e.message || 'worker error'})`)
      worker.postMessage({ type: 'init' } satisfies ToWorker)
    } catch (err) {
      fail(`it could not start (${err instanceof Error ? err.message : String(err)})`)
    }
    done()
  })
  return ready
}

let scratch: CanvasRenderingContext2D | null = null

/**
 * The person mask of `image` (a camera picture `width` x `height`), or null when segmentation
 * cannot run or this picture failed. The picture is scaled down to the model's size first, the same way for the preview
 * and the export, so the same frame always gets the same mask.
 */
export async function segmentPicture(image: CanvasImageSource, width: number, height: number): Promise<PersonMask | null> {
  if (!(await ensureSegmenter()) || !worker) return null
  const size = segmentationSize(width, height)
  if (!scratch) scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!scratch) return null
  const c = scratch.canvas
  if (c.width !== size.width || c.height !== size.height) {
    c.width = size.width
    c.height = size.height
  }
  scratch.imageSmoothingEnabled = true
  scratch.imageSmoothingQuality = 'high'
  scratch.drawImage(image, 0, 0, width, height, 0, 0, size.width, size.height)
  const pixels = scratch.getImageData(0, 0, size.width, size.height).data.buffer as ArrayBuffer
  const id = nextId++
  return new Promise<PersonMask | null>((resolve) => {
    pending.set(id, resolve)
    worker!.postMessage({ type: 'segment', id, width: size.width, height: size.height, pixels } satisfies ToWorker, [pixels])
  })
}
