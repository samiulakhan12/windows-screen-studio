/**
 * The unwanted-sound finder's listener (docs/design/sound-finder.md §2.2, §4.2): YAMNet through
 * MediaPipe's audio classifier, on the CPU, off the editor's thread. Everything it loads ships inside
 * the app (Vite copies the WebAssembly runtime and the model into the build), so nothing is
 * downloaded. One source per worker: samples arrive in chunks, each window is scored once
 * (SoundScanner), and the scores go back at the end.
 */
import { AudioClassifier } from '@mediapipe/tasks-audio'
import wasmLoaderUrl from '@mediapipe/tasks-audio/audio_wasm_module_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-audio/audio_wasm_module_internal.wasm?url'
import modelUrl from '../../../../../resources/sounds/yamnet.tflite?url'
import { SCAN, SOUND_MODEL } from '../../../../shared/audio/sounds'
import { SoundScanner } from '../../../../shared/audio/soundsScan'
import type { FromWorker, ToWorker } from './protocol'

/** The parts of the worker scope used here (the renderer is type-checked with the DOM library). */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker, transfer?: Transferable[]): void
}

const absolute = (url: string): string => new URL(url, self.location.href).href

/** Why it cannot listen, in words for the Audio panel. */
function explain(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  if (/memory/i.test(text)) return 'this PC ran out of memory for it'
  if (/fetch|load|404|not found/i.test(text)) return `its files could not be loaded (${text})`
  return text || 'unknown error'
}

let classifier: AudioClassifier | null = null
let scanner: SoundScanner | null = null
/** Messages are handled one after another (loading the model is asynchronous). */
let queue: Promise<void> = Promise.resolve()
let failed = false

async function load(): Promise<AudioClassifier> {
  const c = await AudioClassifier.createFromOptions(
    { wasmLoaderPath: absolute(wasmLoaderUrl), wasmBinaryPath: absolute(wasmBinaryUrl) },
    { baseOptions: { modelAssetPath: absolute(modelUrl), delegate: 'CPU' }, maxResults: -1, scoreThreshold: 0 }
  )
  // A first window proves the whole pipeline runs here.
  scoresOf(c, new Float32Array(SCAN.window))
  return c
}

const scores = new Float32Array(SOUND_MODEL.classes)

/** Every class score of one window (index = class). */
function scoresOf(c: AudioClassifier, window: Float32Array): Float32Array {
  const result = c.classify(window, SCAN.rate)
  scores.fill(0)
  for (const cat of result[0]?.classifications[0]?.categories ?? []) if (cat.index >= 0 && cat.index < scores.length) scores[cat.index] = cat.score
  return scores
}

function fail(err: unknown): void {
  failed = true
  scope.postMessage({ type: 'failed', reason: explain(err) })
}

async function handle(msg: ToWorker): Promise<void> {
  if (failed) return
  if (msg.type === 'start') {
    classifier ??= await load()
    const c = classifier
    scanner = new SoundScanner((w) => scoresOf(c, w), msg.skip)
    scope.postMessage({ type: 'ready' })
  } else if (msg.type === 'chunk') {
    if (!scanner) throw new Error('No sound to listen to')
    scanner.push(new Float32Array(msg.samples))
    scope.postMessage({ type: 'progress', seconds: scanner.seconds })
  } else {
    if (!scanner) throw new Error('No sound to listen to')
    const { n, scores: bytes } = scanner.finish()
    const buffer = bytes.buffer as ArrayBuffer
    scope.postMessage({ type: 'done', n, scores: buffer, stats: scanner.stats }, [buffer])
    scanner = null
  }
}

scope.onmessage = (e) => {
  queue = queue.then(() => handle(e.data)).catch(fail)
}
