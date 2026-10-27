/**
 * The speech models on this PC (docs/design/offline-captions.md §3.1, §4): userData/speech-models
 * holds the catalog's files, their .part downloads and speech.json (the default model, which
 * files were verified at which size and time, and the speed measured on this PC). Only catalog
 * files whose pin matched are ever handed out. Workstream B's own module.
 */
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import type { SpeechModelStatus, SpeechModelView } from '../../shared/api/speech'
import { DEFAULT_SPEECH_MODEL, isSpeechModelId, modelUrl, SPEECH_MODELS, speechModel, speechModelBlock, type SpeechModelId, type SpeechModelSpec } from '../../shared/speech/catalog'
import { localErrorMessage, modelBlockReason } from '../../shared/speech/errors'
import { writeFileAtomicSync } from '../atomicWrite'
import { DownloadFailure, downloadPinned, electronGet, type HttpGet } from './download'
import type { HelperBuild } from './helper'

/** speech.json, as stored. */
export interface SpeechSettingsFile {
  version: 1
  defaultModel: SpeechModelId
  /** Files whose SHA-256 matched their pin, with the size and modification time they had then. */
  verified: Partial<Record<SpeechModelId, { bytes: number; mtimeMs: number }>>
  /** Processing time / audio time measured on this PC (speech-dense parts of 60 s or more) by the build that ran, smoothed. */
  measured: Partial<Record<SpeechModelId, { rtf: number; threads: number; build: HelperBuild }>>
}

export const SPEECH_DIR = 'speech-models'
export const SPEECH_SETTINGS_FILE = 'speech.json'
/** .part files untouched for this long are deleted at startup. */
export const STALE_PART_MS = 30 * 24 * 3600_000
/** Largest speech.json read. */
const SETTINGS_MAX = 64 * 1024
/** Measured speeds outside this are ignored. */
const RTF_RANGE = [0.005, 20] as const
const BUILDS: readonly HelperBuild[] = ['standard', 'compatible', 'host']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** speech.json from anything: an unknown default becomes DEFAULT_SPEECH_MODEL, odd entries are dropped. */
export function sanitizeSpeechSettings(raw: unknown): SpeechSettingsFile {
  const out: SpeechSettingsFile = { version: 1, defaultModel: DEFAULT_SPEECH_MODEL, verified: {}, measured: {} }
  if (!isObject(raw) || raw.version !== 1) return out
  if (isSpeechModelId(raw.defaultModel)) out.defaultModel = raw.defaultModel
  if (isObject(raw.verified)) {
    for (const [id, v] of Object.entries(raw.verified)) {
      const spec = speechModel(id)
      if (spec && isObject(v) && v.bytes === spec.bytes && finite(v.mtimeMs) && v.mtimeMs >= 0) out.verified[spec.id] = { bytes: v.bytes, mtimeMs: v.mtimeMs }
    }
  }
  if (isObject(raw.measured)) {
    for (const [id, v] of Object.entries(raw.measured)) {
      if (!isSpeechModelId(id) || !isObject(v) || !finite(v.rtf) || !finite(v.threads) || !BUILDS.includes(v.build as HelperBuild)) continue
      if (v.rtf < RTF_RANGE[0] || v.rtf > RTF_RANGE[1] || v.threads < 1 || v.threads > 256) continue
      out.measured[id] = { rtf: v.rtf, threads: Math.floor(v.threads), build: v.build as HelperBuild }
    }
  }
  return out
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk)
  return hash.digest('hex')
}

/** What the store needs from the PC and the network (tests pass fakes). */
export interface SpeechStoreDeps {
  /** Memory in all and the helper build running here (speechModelBlock). */
  pc?: () => { totalMemBytes: number; build: 'standard' | 'compatible' | 'host' | null }
  get?: HttpGet
  /** SSW_SPEECH_MODEL_BASE_URL (unpackaged only): downloads come from there. */
  baseUrl?: string | null
  freeBytes?: (dir: string) => Promise<number | null>
  /** Something a view shows changed (a download's progress included). */
  onChange?: () => void
  /** Download timing overrides (tests). */
  download?: { stallMs?: number; retryDelaysMs?: readonly number[]; rename?: (from: string, to: string) => Promise<void> }
}

interface ActiveDownload {
  id: SpeechModelId
  controller: AbortController
  discard: boolean
  done: Promise<void>
}

export class SpeechModelStore {
  private settingsCache: SpeechSettingsFile | null = null
  private readonly holds = new Map<SpeechModelId, number>()
  /** Live statuses that the disk cannot tell (downloading, verifying, failed). */
  private readonly live = new Map<SpeechModelId, SpeechModelStatus>()
  /** Hash results of files without a matching verified record, by size and time. */
  private readonly checked = new Map<SpeechModelId, { key: string; ok: boolean }>()
  private active: ActiveDownload | null = null

  constructor(
    readonly dir: string,
    private readonly deps: SpeechStoreDeps = {}
  ) {}

  private fileOf(spec: SpeechModelSpec): string {
    return path.join(this.dir, spec.file)
  }

  private changed(): void {
    this.deps.onChange?.()
  }

  /** speech.json (defaults when missing or malformed). */
  settings(): SpeechSettingsFile {
    if (this.settingsCache) return this.settingsCache
    let raw: unknown = null
    try {
      const text = readFileSync(path.join(this.dir, SPEECH_SETTINGS_FILE), 'utf8')
      if (text.length <= SETTINGS_MAX) raw = JSON.parse(text)
    } catch {
      // Missing or malformed: the defaults.
    }
    this.settingsCache = sanitizeSpeechSettings(raw)
    return this.settingsCache
  }

  private save(update: (s: SpeechSettingsFile) => void): void {
    const next = structuredClone(this.settings())
    update(next)
    this.settingsCache = next
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileAtomicSync(path.join(this.dir, SPEECH_SETTINGS_FILE), JSON.stringify(next, null, 2))
    } catch (err) {
      console.warn(`Could not save ${SPEECH_SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  defaultModel(): SpeechModelId {
    return this.settings().defaultModel
  }

  /**
   * The speed measured with `build` (default: the build running here); null when none was, or it
   * was another build's (speech.json roams with the Windows profile). With no build known yet, the
   * last one measured.
   */
  measured(id: SpeechModelId, build: HelperBuild | null = this.deps.pc?.().build ?? null): { rtf: number; threads: number } | null {
    const m = this.settings().measured[id]
    return m && (!build || m.build === build) ? { rtf: m.rtf, threads: m.threads } : null
  }

  /**
   * Whether `spec`'s file is there and matches its pin: a regular file (not a link) with the
   * verified size and time, else hashed again (the result kept for that size and time).
   */
  private async check(spec: SpeechModelSpec): Promise<'installed' | 'damaged' | 'missing'> {
    const file = this.fileOf(spec)
    const stat = await fs.lstat(file).catch(() => null)
    if (!stat) return 'missing'
    if (!stat.isFile() || stat.isSymbolicLink()) return 'damaged'
    const record = this.settings().verified[spec.id]
    if (record && record.bytes === stat.size && record.mtimeMs === stat.mtimeMs) return 'installed'
    if (stat.size !== spec.bytes) return 'damaged'
    const key = `${stat.size}|${stat.mtimeMs}`
    const memo = this.checked.get(spec.id)
    if (memo?.key === key) return memo.ok ? 'installed' : 'damaged'
    const ok = (await sha256File(file).catch(() => '')) === spec.sha256
    this.checked.set(spec.id, { key, ok })
    if (ok) this.save((s) => (s.verified[spec.id] = { bytes: stat.size, mtimeMs: stat.mtimeMs }))
    else if (record) this.save((s) => delete s.verified[spec.id])
    return ok ? 'installed' : 'damaged'
  }

  private async status(spec: SpeechModelSpec): Promise<SpeechModelStatus> {
    const live = this.live.get(spec.id)
    if (live && live.state !== 'failed') return live
    const disk = await this.check(spec)
    if (disk === 'installed') return { state: 'installed' }
    if (live) return live
    const part = await fs.stat(`${this.fileOf(spec)}.part`).catch(() => null)
    if (part?.isFile()) return { state: 'stopped', received: part.size, total: spec.bytes }
    return { state: disk }
  }

  private block(spec: SpeechModelSpec): { allowed: boolean; reason?: string } {
    const pc = this.deps.pc?.() ?? { totalMemBytes: Infinity, build: null }
    const block = speechModelBlock(spec, pc)
    return block ? { allowed: false, reason: modelBlockReason(block, spec, pc.totalMemBytes) } : { allowed: true }
  }

  /** Every catalog model with its status on this PC. */
  async views(): Promise<SpeechModelView[]> {
    const out: SpeechModelView[] = []
    for (const spec of SPEECH_MODELS) {
      const measured = this.measured(spec.id)
      out.push({
        id: spec.id,
        tier: spec.tier,
        name: spec.name,
        bytes: spec.bytes,
        rtf4: spec.rtf4,
        ramMB: spec.ramMB,
        wer: spec.wer,
        partSeconds: spec.partSeconds,
        license: spec.license,
        status: await this.status(spec),
        inUse: (this.holds.get(spec.id) ?? 0) > 0,
        ...this.block(spec),
        ...(measured ? { measured } : {})
      })
    }
    return out
  }

  /** Bytes the models folder's files use. */
  async used(): Promise<number> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[])
    let total = 0
    for (const n of names) total += (await fs.lstat(path.join(this.dir, n)).catch(() => null))?.size ?? 0
    return total
  }

  /** The verified file of `id` (hashed again when its size or time changed); rejects with a message when missing or damaged. */
  async installedFile(id: SpeechModelId): Promise<string> {
    const spec = speechModel(id)
    if (!spec) throw new Error(localErrorMessage('no-model'))
    const state = await this.check(spec)
    if (state === 'missing') throw new Error(localErrorMessage('no-model', { model: id }))
    if (state === 'damaged') {
      this.changed()
      throw new Error(localErrorMessage('damaged', { model: id }))
    }
    return this.fileOf(spec)
  }

  /** The engine could not load the file, or crashed: the next use hashes it again. */
  clearVerified(id: SpeechModelId): void {
    this.checked.delete(id)
    if (this.settings().verified[id]) this.save((s) => delete s.verified[id])
  }

  /** Blends a speed measured with `build` into speech.json (0.5 old, 0.5 new; another build's is replaced). */
  recordMeasured(id: SpeechModelId, rtf: number, threads: number, build: HelperBuild): void {
    if (!finite(rtf) || rtf < RTF_RANGE[0] || rtf > RTF_RANGE[1] || !(threads >= 1)) return
    const old = this.measured(id, build)
    const blended = old ? 0.5 * old.rtf + 0.5 * rtf : rtf
    this.save((s) => (s.measured[id] = { rtf: Math.round(blended * 10000) / 10000, threads: Math.floor(threads), build }))
  }

  /** Marks `id` in use while a transcription runs; returns the release function (Remove is refused meanwhile). */
  hold(id: SpeechModelId): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
    this.changed()
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.holds.get(id) ?? 1) - 1
      if (n > 0) this.holds.set(id, n)
      else this.holds.delete(id)
      this.changed()
    }
  }

  /**
   * Downloads `id` (continuing a stopped download); resolves once installed and verified.
   * Rejects with a message ('Cancelled.' when cancelled). The first verified model becomes the
   * default when the default is not installed.
   */
  async download(id: unknown): Promise<void> {
    const spec = speechModel(id)
    if (!spec) throw new Error('Unknown speech model.')
    const { allowed, reason } = this.block(spec)
    if (!allowed) throw new Error(reason)
    if (this.active) throw new Error(this.active.id === spec.id ? 'This speech model is already downloading.' : 'Another speech model is downloading.')
    if ((await this.check(spec)) === 'installed') return
    const controller = new AbortController()
    const active: ActiveDownload = { id: spec.id, controller, discard: false, done: Promise.resolve() }
    this.active = active
    const dest = this.fileOf(spec)
    const partSize = (await fs.stat(`${dest}.part`).catch(() => null))?.size ?? 0
    let progress = { received: partSize, total: spec.bytes, bytesPerSecond: 0 }
    let retrying: { attempt: number; of: number } | null = null
    const setDownloading = (): void => {
      this.live.set(spec.id, { state: 'downloading', ...progress, ...(retrying ? { retrying } : {}) })
      this.changed()
    }
    setDownloading()
    const run = (async () => {
      await fs.mkdir(this.dir, { recursive: true })
      await downloadPinned({ url: modelUrl(spec, this.deps.baseUrl ?? undefined), bytes: spec.bytes, sha256: spec.sha256 }, dest, {
        get: this.deps.get ?? electronGet(),
        signal: controller.signal,
        testBase: this.deps.baseUrl ?? null,
        freeBytes: this.deps.freeBytes,
        stallMs: this.deps.download?.stallMs,
        retryDelaysMs: this.deps.download?.retryDelaysMs,
        rename: this.deps.download?.rename,
        onProgress: (p) => {
          progress = p
          setDownloading()
        },
        onRetry: (r) => {
          retrying = r
          setDownloading()
        },
        onVerifying: () => {
          this.live.set(spec.id, { state: 'verifying' })
          this.changed()
        }
      })
      const stat = await fs.lstat(dest)
      this.checked.delete(spec.id)
      const installedDefault = (await this.check(speechModel(this.defaultModel())!)) === 'installed'
      this.save((s) => {
        s.verified[spec.id] = { bytes: stat.size, mtimeMs: stat.mtimeMs }
        if (!installedDefault || s.defaultModel === spec.id) s.defaultModel = spec.id
      })
    })()
    active.done = run.then(
      () => undefined,
      () => undefined
    )
    try {
      await run
      this.live.delete(spec.id)
    } catch (err) {
      const failure = err instanceof DownloadFailure ? err : new DownloadFailure('other', err instanceof Error ? err.message : String(err))
      if (failure.kind === 'cancelled') {
        this.live.delete(spec.id)
        if (active.discard) await this.deletePart(spec)
        throw new Error('Cancelled.')
      }
      const received = (await fs.stat(`${dest}.part`).catch(() => null))?.size ?? 0
      this.live.set(spec.id, { state: 'failed', received, total: spec.bytes, error: failure.kind, ...(failure.status ? { status: failure.status } : {}), message: failure.message })
      throw new Error(failure.message)
    } finally {
      if (this.active === active) this.active = null
      this.changed()
    }
  }

  private async deletePart(spec: SpeechModelSpec): Promise<void> {
    await fs.rm(`${this.fileOf(spec)}.part`, { force: true })
    await fs.rm(`${this.fileOf(spec)}.part.json`, { force: true })
  }

  /** Stops the download of `id`; `discard` also deletes the part already downloaded. */
  async cancelDownload(id: unknown, discard: boolean): Promise<void> {
    const spec = speechModel(id)
    if (!spec) throw new Error('Unknown speech model.')
    const active = this.active
    if (active?.id === spec.id) {
      active.discard = discard
      active.controller.abort()
      await active.done
    } else if (discard) {
      await this.deletePart(spec)
    }
    if (discard && this.live.get(spec.id)?.state === 'failed') this.live.delete(spec.id)
    this.changed()
  }

  /** Deletes the model's file and any part. Refused while a transcription holds it. */
  async remove(id: unknown): Promise<void> {
    const spec = speechModel(id)
    if (!spec) throw new Error('Unknown speech model.')
    if ((this.holds.get(spec.id) ?? 0) > 0) throw new Error('Captions are being made with this model. Cancel them first.')
    if (this.active?.id === spec.id) await this.cancelDownload(spec.id, true)
    await fs.rm(this.fileOf(spec), { force: true })
    await this.deletePart(spec)
    this.live.delete(spec.id)
    this.checked.delete(spec.id)
    let next = this.defaultModel()
    if (next === spec.id) {
      next = DEFAULT_SPEECH_MODEL
      for (const m of SPEECH_MODELS) {
        if (m.id !== spec.id && (await this.check(m)) === 'installed') {
          next = m.id
          break
        }
      }
    }
    this.save((s) => {
      delete s.verified[spec.id]
      s.defaultModel = next
    })
    this.changed()
  }

  /** The model used for new captions: only an installed one. */
  async setDefault(id: unknown): Promise<void> {
    const spec = speechModel(id)
    if (!spec) throw new Error('Unknown speech model.')
    if ((await this.check(spec)) !== 'installed') throw new Error('Only a downloaded speech model can be the default.')
    this.save((s) => (s.defaultModel = spec.id))
    this.changed()
  }

  /** At startup: .part files (and their .part.json) untouched for STALE_PART_MS are deleted. */
  async sweepStaleParts(now = Date.now()): Promise<string[]> {
    const removed: string[] = []
    for (const spec of SPEECH_MODELS) {
      const part = `${this.fileOf(spec)}.part`
      const stat = await fs.stat(part).catch(() => null)
      if (!stat || now - stat.mtimeMs < STALE_PART_MS) continue
      await this.deletePart(spec)
      removed.push(part)
    }
    return removed
  }

  /** Quitting: a download stops and keeps its part (Continue later). */
  stopDownloads(): void {
    this.active?.controller.abort()
  }
}
