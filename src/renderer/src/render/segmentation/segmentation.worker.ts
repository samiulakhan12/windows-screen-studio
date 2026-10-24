/**
 * Person segmentation off the main thread: MediaPipe's selfie segmenter, run on the CPU so the
 * same picture always gives the same mask. Everything it loads ships inside the app (Vite copies
 * the WebAssembly runtime and the model into the build), so nothing is downloaded.
 */
import { ImageSegmenter } from '@mediapipe/tasks-vision'
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url'
import modelUrl from '../../../../../resources/segmentation/selfie_segmenter.tflite?url'
import { maskPixels } from '../../../../shared/render/cameraLook'
import type { FromWorker, ToWorker } from './protocol'

/** The parts of the worker scope used here (the renderer is type-checked with the DOM library). */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker, transfer?: Transferable[]): void
}

let segmenter: Promise<ImageSegmenter> | null = null

const absolute = (url: string): string => new URL(url, self.location.href).href

/** Why segmentation cannot run, in words for the Camera panel. */
function explain(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  if (/webgl|activeTexture|getContext/i.test(text)) return 'it needs WebGL graphics, which are turned off or unavailable on this PC'
  if (/fetch|load|404|not found/i.test(text)) return `its files could not be loaded (${text})`
  return text || 'unknown error'
}

/** MediaPipe hands pictures to its graph as WebGL textures, even when the model runs on the CPU. */
function hasWebGl(): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false
  const c = new OffscreenCanvas(1, 1)
  return !!(c.getContext('webgl2') ?? c.getContext('webgl'))
}

async function load(): Promise<ImageSegmenter> {
  if (!hasWebGl()) throw new Error('WebGL is unavailable')
  const s = await ImageSegmenter.createFromOptions(
    { wasmLoaderPath: absolute(wasmLoaderUrl), wasmBinaryPath: absolute(wasmBinaryUrl) },
    {
      baseOptions: { modelAssetPath: absolute(modelUrl), delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false
    }
  )
  // A first picture proves the whole pipeline runs here (texture upload included).
  run(s, new ImageData(16, 16))
  return s
}

/** Person confidence of every pixel of `image`, as mask pixels. */
function run(s: ImageSegmenter, image: ImageData): Uint8ClampedArray {
  const result = s.segment(image)
  try {
    const mask = result.confidenceMasks?.[0]
    if (!mask) throw new Error('The segmenter returned no mask')
    return maskPixels(mask.getAsFloat32Array())
  } finally {
    result.close()
  }
}

scope.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'init') {
    segmenter ??= load()
    segmenter.then(
      () => scope.postMessage({ type: 'ready' }),
      (err: unknown) => scope.postMessage({ type: 'failed', reason: explain(err) })
    )
    return
  }
  const { id, width, height, pixels } = msg
  ;(segmenter ??= load())
    .then((s) => {
      const out = run(s, new ImageData(new Uint8ClampedArray(pixels), width, height))
      scope.postMessage({ type: 'mask', id, width, height, pixels: out.buffer as ArrayBuffer }, [out.buffer as ArrayBuffer])
    })
    .catch((err: unknown) => scope.postMessage({ type: 'failed', id, reason: explain(err) }))
}
