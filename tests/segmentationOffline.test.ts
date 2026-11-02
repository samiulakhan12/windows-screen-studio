import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * The camera's background-blur worker reaches only the app's own files, like the sound worker
 * (tests/soundsOffline.test.ts, docs/design/sound-finder.md §7). It runs the same MediaPipe Tasks
 * runtime, whose usage logger is made with every segmenter and posts statistics to Google once a
 * minute; the page's Content Security Policy does not cover a module worker loaded from file://, so
 * without the guard a camera with Background blur on sent them.
 */

const WORKER = '../src/renderer/src/render/segmentation/segmentation.worker'
const STATS = 'https://odml.pa.googleapis.com/v1/log'
const INSTALLED = 'file:///C:/Program%20Files/Flown/resources/app.asar/out/renderer/assets/'

/** What became of the statistics the segmenter sent as it was made, and the model files it fetched. */
const { sends } = vi.hoisted(() => ({ sends: [] as string[] }))

// The segmenter fetches its model and posts its usage statistics through the worker's own fetch.
vi.mock('@mediapipe/tasks-vision', () => ({
  ImageSegmenter: {
    createFromOptions: async (_files: unknown, options: { baseOptions: { modelAssetPath: string } }) => {
      const scope = (globalThis as unknown as { self: { fetch: typeof fetch } }).self
      await scope.fetch(options.baseOptions.modelAssetPath).then(
        () => sends.push('model fetched'),
        () => sends.push('model refused')
      )
      await scope.fetch(STATS, { method: 'POST' }).then(
        () => sends.push('statistics sent'),
        () => sends.push('statistics refused')
      )
      return {
        segment: () => ({ confidenceMasks: [{ getAsFloat32Array: () => new Float32Array(256) }], close: () => undefined }),
        close: () => undefined
      }
    }
  }
}))

/** A worker scope at `href` whose own fetch answers 'ok' and notes what it was asked for. */
function fakeScope(href: string) {
  const asked: string[] = []
  const posted: { type: string }[] = []
  const { host } = new URL(href)
  const scope = {
    location: { href, host },
    fetch: (async (input: string | URL | Request) => {
      asked.push(input instanceof Request ? input.url : String(input))
      return new Response('ok')
    }) as typeof fetch,
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (message: { type: string }) => {
      posted.push(message)
    }
  }
  return { scope, asked, posted }
}

describe('the camera blur worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is off the network as soon as it starts, and its segmenter cannot send usage statistics', async () => {
    const { scope, asked, posted } = fakeScope(`${INSTALLED}segmentation.worker-1a2b.js`)
    vi.stubGlobal('self', scope)
    // Enough of a worker for the segmenter to load: WebGL is there, pictures are ImageData.
    vi.stubGlobal('OffscreenCanvas', class { getContext = () => ({}) })
    vi.stubGlobal('ImageData', class { constructor(readonly width: number, readonly height: number) {} })
    await import(/* @vite-ignore */ WORKER)

    // Before any message: Google is refused, the app's own files are not.
    await expect(scope.fetch(STATS, { method: 'POST' })).rejects.toThrow(TypeError)
    await expect(scope.fetch(new Request(STATS, { method: 'POST' }))).rejects.toThrow(TypeError)
    expect(await (await scope.fetch(`${INSTALLED}selfie_segmenter-3c4d.tflite`)).text()).toBe('ok')

    scope.onmessage?.({ data: { type: 'init' } })
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'ready' }))
    expect(sends).toEqual(['model fetched', 'statistics refused'])
    expect(asked.every((url) => new URL(url, scope.location.href).host === '')).toBe(true)
    expect(asked.some((url) => url.includes('odml.pa.googleapis.com'))).toBe(false)
  })
})
