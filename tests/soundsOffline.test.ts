import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * The sound worker reaches only the app's own files (docs/design/sound-finder.md §7). MediaPipe Tasks
 * posts usage statistics to Google once a minute while a classifier is alive, and the page's Content
 * Security Policy does not cover a module worker loaded from file://, so without this a long scan sent
 * them (the Audio panel says it listens on this PC).
 */

const OFFLINE = '../src/renderer/src/editor/sounds/offline'
const WORKER = '../src/renderer/src/editor/sounds/sounds.worker'
const { keepOffline } = (await import(/* @vite-ignore */ OFFLINE)) as {
  keepOffline(scope: { fetch: typeof fetch; location: { href: string; host: string } }): void
}

const STATS = 'https://odml.pa.googleapis.com/v1/log'
const INSTALLED = 'file:///C:/Program%20Files/Flown/resources/app.asar/out/renderer/assets/'

/** A worker scope at `href` whose own fetch answers 'ok' and notes what it was asked for. */
function fakeScope(href: string) {
  const asked: string[] = []
  const { host } = new URL(href)
  const scope = {
    location: { href, host },
    fetch: (async (input: string | URL | Request) => {
      asked.push(input instanceof Request ? input.url : String(input))
      return new Response('ok')
    }) as typeof fetch,
    onmessage: null,
    postMessage: () => undefined
  }
  return { scope, asked }
}

describe('keepOffline', () => {
  it('lets the installed app fetch its own files and nothing else', async () => {
    const { scope, asked } = fakeScope(`${INSTALLED}sounds.worker-1a2b.js`)
    keepOffline(scope)
    expect(await (await scope.fetch(`${INSTALLED}yamnet-3c4d.tflite`)).text()).toBe('ok')
    expect(await (await scope.fetch(new URL('audio_wasm_module_internal-5e6f.wasm', INSTALLED))).text()).toBe('ok')
    expect(await (await scope.fetch('./audio_wasm_module_internal-5e6f.js')).text()).toBe('ok')
    await expect(scope.fetch(STATS, { method: 'POST' })).rejects.toThrow(TypeError)
    await expect(scope.fetch(new URL(STATS))).rejects.toThrow(TypeError)
    await expect(scope.fetch(new Request(STATS, { method: 'POST' }))).rejects.toThrow(TypeError)
    // A Windows network share is somebody else's computer.
    await expect(scope.fetch('file://server/share/yamnet.tflite')).rejects.toThrow(TypeError)
    expect(asked).toEqual([`${INSTALLED}yamnet-3c4d.tflite`, `${INSTALLED}audio_wasm_module_internal-5e6f.wasm`, './audio_wasm_module_internal-5e6f.js'])
  })

  it('in development, lets it fetch from the dev server only', async () => {
    const { scope, asked } = fakeScope('http://localhost:5173/src/renderer/src/editor/sounds/sounds.worker.ts?worker_file&type=module')
    keepOffline(scope)
    expect(await (await scope.fetch('/resources/sounds/yamnet.tflite')).text()).toBe('ok')
    await expect(scope.fetch('http://localhost:8080/x')).rejects.toThrow(TypeError)
    await expect(scope.fetch(STATS)).rejects.toThrow(TypeError)
    expect(asked).toEqual(['/resources/sounds/yamnet.tflite'])
  })
})

vi.mock('@mediapipe/tasks-audio', () => ({ AudioClassifier: { createFromOptions: () => Promise.reject(new Error('not here')) } }))

describe('the sound worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is off the network as soon as it starts', async () => {
    const { scope, asked } = fakeScope(`${INSTALLED}sounds.worker-1a2b.js`)
    vi.stubGlobal('self', scope)
    await import(/* @vite-ignore */ WORKER)
    await expect(scope.fetch(STATS, { method: 'POST' })).rejects.toThrow(TypeError)
    expect(await (await scope.fetch(`${INSTALLED}yamnet-3c4d.tflite`)).text()).toBe('ok')
    expect(asked).toEqual([`${INSTALLED}yamnet-3c4d.tflite`])
  })
})
