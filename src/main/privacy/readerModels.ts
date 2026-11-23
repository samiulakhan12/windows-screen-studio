/**
 * The text reader's models on this PC (docs/design/auto-blur.md §5.12, §10.2): userData/
 * reader-models holds the five pinned files (readerCatalog.ts) under their upstream folders, their
 * .part downloads and models.json (`{ files: { [file]: { bytes, sha256 } }, decodeMs? }`: what was
 * verified, and this PC's measured decode speed). One download at a time, one file after another,
 * through downloadPinned: a .part resumed with Range after its prefix is hashed, every redirect hop
 * checked against Hugging Face's hosts, size and SHA-256 checked at the end. Cancel keeps the
 * .part files for resuming. Before every Find, checkReader hashes every file again; a damaged one
 * is deleted and the state is `damaged`. Remove deletes the folder. Nothing else is ever downloaded
 * for this feature, and nothing downloaded is ever run: the files are data the helper checks again.
 *
 * One state for the whole app (finding 29): every window, Find's dialog and Settings see the same
 * one, sent to all of them on every change (readerIpc.ts).
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ReaderState } from '../../shared/api/privacy'
import { READER_BYTES, READER_FILES, readerUrls, type ReaderFile } from '../../shared/privacy/readerCatalog'
import type { ModelPin } from '../../shared/privacy/protocol'
import { writeFileAtomicSync } from '../atomicWrite'
import { allowDownloadUrl, DownloadFailure, downloadPinned, electronGet, type HttpGet } from '../speech/download'
import { helperPath, HelperError, OcrHelper, type HelperDeps } from './readerHelper'

/** userData/reader-models (§5.12). */
export const READER_DIR = 'reader-models'
export const MODELS_FILE = 'models.json'
/** Windows' exit code for a processor that lacks an instruction the helper uses. */
export const ILLEGAL_INSTRUCTION = 0xc000001d
/** Largest models.json read. */
const SETTINGS_MAX = 16 * 1024
/** A measured decode speed outside this range (ms a 1080p frame) is ignored. */
const DECODE_RANGE = [0.05, 1000] as const

/** What a download needs from the network and the disk (tests pass fakes). */
export interface DownloadDeps {
  get?: HttpGet
  /** The addresses of a file, in order (readerUrls when absent). */
  sources?: (f: ReaderFile) => string[]
  /** An origin allowed besides Hugging Face's (a local server in tests). */
  testBase?: string | null
  freeBytes?: (dir: string) => Promise<number | null>
  retryDelaysMs?: readonly number[]
  stallMs?: number
}

interface ModelsFile {
  files: Record<string, { bytes: number; sha256: string }>
  decodeMs?: number
}

let damaged = false
let failure: string | null = null
let unavailable: 'helper' | 'cpu' | null = null
let active: { promise: Promise<ReaderState>; controller: AbortController; done: number } | null = null
const listeners = new Set<(s: ReaderState) => void>()

/** The folder of the reader's files. */
export function readerDir(): string {
  return path.join(app.getPath('userData'), READER_DIR)
}

const fileOf = (f: ReaderFile): string => path.join(readerDir(), ...f.file.split('/'))

function readModelsFile(): ModelsFile {
  try {
    const p = path.join(readerDir(), MODELS_FILE)
    if (statSync(p).size > SETTINGS_MAX) return { files: {} }
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const out: ModelsFile = { files: {} }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>
      if (r.files && typeof r.files === 'object' && !Array.isArray(r.files)) {
        for (const f of READER_FILES) {
          const v = (r.files as Record<string, unknown>)[f.file] as { bytes?: unknown; sha256?: unknown } | undefined
          if (v && v.bytes === f.bytes && v.sha256 === f.sha256) out.files[f.file] = { bytes: f.bytes, sha256: f.sha256 }
        }
      }
      if (typeof r.decodeMs === 'number' && r.decodeMs >= DECODE_RANGE[0] && r.decodeMs <= DECODE_RANGE[1]) out.decodeMs = r.decodeMs
    }
    return out
  } catch {
    return { files: {} }
  }
}

function writeModelsFile(m: ModelsFile): void {
  try {
    writeFileAtomicSync(path.join(readerDir(), MODELS_FILE), `${JSON.stringify(m)}\n`)
  } catch {
    // The folder is gone (removed meanwhile): nothing to record.
  }
}

/** Every file in place at its pinned size (the hashes are checked before use, checkReader). */
function present(): boolean {
  return READER_FILES.every((f) => {
    try {
      return statSync(fileOf(f)).size === f.bytes
    } catch {
      return false
    }
  })
}

/** The reader's state now. */
export function readerState(): ReaderState {
  if (unavailable) return { status: 'unavailable', reason: unavailable }
  if (!helperPath()) return { status: 'unavailable', reason: 'helper' }
  if (active) return { status: 'downloading', done: active.done, total: READER_BYTES }
  if (failure !== null) return { status: 'failed', reason: failure }
  if (damaged) return { status: 'damaged' }
  if (present()) return { status: 'ready', bytes: READER_BYTES, decodeMs: decodeSpeed() }
  return { status: 'none' }
}

/** Calls `listener` with the state on every change; returns the unsubscribe. */
export function onReaderState(listener: (s: ReaderState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tells the download's caller and every listener; a listener that fails stops nothing. */
function notify(extra?: (s: ReaderState) => void): void {
  const s = readerState()
  for (const l of extra ? [extra, ...listeners] : listeners) {
    try {
      l(s)
    } catch {
      // A window that went away: the others still hear.
    }
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk)
  return hash.digest('hex')
}

/** Whether `f` is on disk with its pinned size and SHA-256. */
async function verified(f: ReaderFile): Promise<'ok' | 'missing' | 'bad'> {
  const file = fileOf(f)
  const size = (await fsp.stat(file).catch(() => null))?.size
  if (size === undefined) return 'missing'
  if (size !== f.bytes) return 'bad'
  return (await sha256Of(file).catch(() => '')) === f.sha256 ? 'ok' : 'bad'
}

/**
 * Downloads every file not already verified, one after another. Resolves with the state after it:
 * `ready`, `none` when cancelled (the .part files stay), or `failed` with the reason to show
 * (finding 26). A second call while one runs gets the running one. When this build has no helper
 * that runs here, nothing is downloaded and the state (`unavailable`) comes back at once.
 */
export function downloadReader(onState: (s: ReaderState) => void, signal: AbortSignal, deps: DownloadDeps = {}): Promise<ReaderState> {
  if (active) return active.promise
  // Without a helper that can run here, the files would be of no use: nothing is downloaded.
  if (unavailable || !helperPath()) return Promise.resolve(readerState())
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) controller.abort()
  failure = null
  damaged = false
  const run = { promise: Promise.resolve<ReaderState>({ status: 'none' }), controller, done: 0 }
  active = run
  run.promise = (async (): Promise<ReaderState> => {
    try {
      await fsp.mkdir(readerDir(), { recursive: true })
      notify(onState)
      const record: ModelsFile = { ...readModelsFile(), files: {} }
      let before = 0
      for (const f of READER_FILES) {
        if ((await verified(f)) !== 'ok') {
          const dest = fileOf(f)
          await fsp.rm(dest, { force: true })
          await fsp.mkdir(path.dirname(dest), { recursive: true })
          const sources = deps.sources ? deps.sources(f) : readerUrls(f)
          const testBase = deps.testBase ?? null
          await downloadPinned({ url: sources[sources.length - 1], bytes: f.bytes, sha256: f.sha256 }, dest, {
            get: deps.get ?? electronGet(),
            signal: controller.signal,
            sources,
            allow: (u) => allowDownloadUrl(u, testBase),
            freeBytes: deps.freeBytes,
            stallMs: deps.stallMs,
            retryDelaysMs: deps.retryDelaysMs,
            onProgress: (p) => {
              run.done = before + p.received
              notify(onState)
            }
          })
        }
        before += f.bytes
        run.done = before
        record.files[f.file] = { bytes: f.bytes, sha256: f.sha256 }
        notify(onState)
      }
      writeModelsFile(record)
    } catch (err) {
      const kind = err instanceof DownloadFailure ? err.kind : 'other'
      if (kind !== 'cancelled') failure = err instanceof Error ? err.message : String(err)
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (active === run) active = null
    }
    const state = readerState()
    notify(onState)
    return state
  })()
  return run.promise
}

/** Stops the download (its .part files stay for the next one). */
export async function cancelReaderDownload(): Promise<void> {
  const run = active
  if (!run) return
  run.controller.abort()
  await run.promise.catch(() => undefined)
}

/** Deletes the reader's folder. */
export async function removeReader(): Promise<ReaderState> {
  await cancelReaderDownload()
  await fsp.rm(readerDir(), { recursive: true, force: true })
  damaged = false
  failure = null
  notify()
  return readerState()
}

/**
 * Checks every file's size and SHA-256 before a Find (§10.2): the pins to send the helper, or null.
 * A file that is there but not the pinned one is deleted and the state becomes `damaged`.
 */
export async function checkReader(): Promise<ModelPin[] | null> {
  const pins: ModelPin[] = []
  let bad = false
  let missing = false
  for (const f of READER_FILES) {
    const v = await verified(f)
    if (v === 'bad') {
      bad = true
      await fsp.rm(fileOf(f), { force: true })
    } else if (v === 'missing') missing = true
    else pins.push({ file: f.file, path: fileOf(f), bytes: f.bytes, sha256: f.sha256 })
  }
  if (bad) {
    damaged = true
    notify()
    return null
  }
  return missing ? null : pins
}

/** The helper refused the files (`error: 'model'`): they are deleted and the state is `damaged`. */
export async function readerDamaged(): Promise<void> {
  for (const f of READER_FILES) await fsp.rm(fileOf(f), { force: true })
  damaged = true
  notify()
}

/** Records this PC's decode speed after a Find: ms to decode one 1080p frame, blended into the last (0.7 old, 0.3 new). */
export function recordDecodeSpeed(msPerFrame1080: number): void {
  if (!Number.isFinite(msPerFrame1080) || msPerFrame1080 < DECODE_RANGE[0] || msPerFrame1080 > DECODE_RANGE[1]) return
  const m = readModelsFile()
  const next = m.decodeMs === undefined ? msPerFrame1080 : 0.7 * m.decodeMs + 0.3 * msPerFrame1080
  m.decodeMs = Math.round(next * 1000) / 1000
  writeModelsFile(m)
  notify()
}

/** This PC's measured decode speed (ms a 1080p frame), or null until a Find recorded one. */
export function decodeSpeed(): number | null {
  return readModelsFile().decodeMs ?? null
}

/**
 * The reader ready for a Find: the files checked (checkReader), the helper started and opened with
 * their pins and the bundled ffmpeg. The helper refusing the files makes the state `damaged`; a
 * helper that is missing, or ends at once on an instruction the processor lacks, makes it
 * `unavailable`.
 */
export async function startReader(ffmpeg: string, deps: HelperDeps = {}): Promise<OcrHelper> {
  const pins = await checkReader()
  if (!pins) throw new HelperError('model')
  let helper: OcrHelper
  try {
    helper = await OcrHelper.start(deps)
  } catch (err) {
    if (err instanceof HelperError && err.kind === 'missing') {
      unavailable = 'helper'
      notify()
    }
    throw err
  }
  void helper.exited.then((code) => {
    if (code === ILLEGAL_INSTRUCTION || code === ILLEGAL_INSTRUCTION - 2 ** 32) {
      unavailable = 'cpu'
      notify()
    }
  })
  try {
    await helper.open(pins, ffmpeg)
  } catch (err) {
    helper.kill()
    if (err instanceof HelperError && err.kind === 'model') await readerDamaged()
    throw err
  }
  return helper
}

/** Tests: forget what this module holds in memory. */
export function resetReaderModels(): void {
  damaged = false
  failure = null
  unavailable = null
  active = null
  listeners.clear()
}
