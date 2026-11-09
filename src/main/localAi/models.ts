/**
 * The text models on disk (docs/design/smart-tools.md §9.4): userData/text-models holds the
 * catalogue's files, their .part downloads and models.json (the Use choice and the speeds measured
 * on this PC). Downloads go through downloadPinned with its rules (a .part resumed with Range,
 * SHA-256 checked as the bytes arrive, a 60 s stall, 3 retries, Retry-After, free space first,
 * https on Hugging Face only), from the mirror when it exists and then unsloth's pinned commit.
 * Only catalogue file names are ever opened; before a file goes to the helper its size must equal
 * the catalogue's and its first 4 bytes must be `GGUF` (the hash was checked when it was written).
 *
 * Test hook (§22 test 104): SSW_TEXT_MODEL_TEST_CATALOG is read only when the app is not packaged.
 */
import { app } from 'electron'
import { mkdirSync, promises as fsp, readFileSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalAiState, LocalModelId, LocalModelState, LocalModelUse } from '../../shared/api/localAi'
import { isLocalModelId, isLocalModelUse, LOCAL_MODELS, localModelBlock, localModelUrls, pickLocalModel, type LocalModelSpec } from '../../shared/localAi/catalog'
import { blockReason, diskMessage, LOCAL_MESSAGES } from '../../shared/localAi/messages'
import { writeFileAtomicSync } from '../atomicWrite'
import { allowDownloadUrl, DownloadFailure, downloadPinned, electronGet, type HttpGet } from '../speech/download'
import { STALE_PART_MS } from '../speech/models'

/** userData/text-models (§4.7). */
export const TEXT_MODELS_DIR = 'text-models'
export const MODELS_FILE = 'models.json'
/** Largest models.json read. */
const SETTINGS_MAX = 16 * 1024
/** Measured speeds outside this range (tokens a second) are ignored. */
const SPEED_RANGE = [0.05, 50_000] as const
/** A finished request blends in its measured speeds: new = 0.7 × old + 0.3 × measured (§9.8). */
export const SPEED_BLEND = 0.3

/** models.json, as stored. */
export interface ModelsFile {
  version: 1
  use: LocalModelUse
  speeds: Partial<Record<LocalModelId, { read: number; write: number }>>
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const inRange = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= SPEED_RANGE[0] && v <= SPEED_RANGE[1]

/** models.json from anything: an unknown Use is Automatic; odd speeds are dropped. */
export function sanitizeModelsFile(raw: unknown): ModelsFile {
  const out: ModelsFile = { version: 1, use: 'auto', speeds: {} }
  if (!isObject(raw) || raw.version !== 1) return out
  if (isLocalModelUse(raw.use)) out.use = raw.use
  if (isObject(raw.speeds)) {
    for (const [id, v] of Object.entries(raw.speeds)) {
      if (isLocalModelId(id) && isObject(v) && inRange(v.read) && inRange(v.write)) out.speeds[id] = { read: v.read, write: v.write }
    }
  }
  return out
}

/** A catalogue entry of the test catalogue, which may name its own address on this PC (unpackaged only). */
export type TestModelSpec = LocalModelSpec & { url?: string }

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.gguf$/

/** The test catalogue's entries, checked: catalogue ids, plain file names, pins, and only a loopback http(s) address. */
export function readTestCatalog(raw: unknown): TestModelSpec[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > LOCAL_MODELS.length) return null
  const out: TestModelSpec[] = []
  for (const e of raw) {
    if (!isObject(e) || !isLocalModelId(e.id) || out.some((m) => m.id === e.id)) return null
    const base = LOCAL_MODELS.find((m) => m.id === e.id)!
    if (typeof e.file !== 'string' || !FILE_NAME.test(e.file)) return null
    if (typeof e.bytes !== 'number' || !Number.isInteger(e.bytes) || e.bytes <= 0 || e.bytes > 256 << 20) return null
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return null
    let url: string | undefined
    if (e.url !== undefined) {
      try {
        const u = new URL(String(e.url))
        if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) return null
        url = u.href
      } catch {
        return null
      }
    }
    const num = (k: 'peakMB' | 'minTotalMemGB' | 'read' | 'write' | 'loadS'): number => (typeof e[k] === 'number' && Number.isFinite(e[k] as number) && (e[k] as number) > 0 ? (e[k] as number) : base[k])
    out.push({
      ...base,
      file: e.file,
      bytes: e.bytes,
      sha256: e.sha256,
      peakMB: num('peakMB'),
      minTotalMemGB: num('minTotalMemGB'),
      read: num('read'),
      write: num('write'),
      loadS: num('loadS'),
      ...(url ? { url } : {})
    })
  }
  return out
}

/**
 * The catalogue a test names (a small model on a local server, for the e2e run): the JSON array in
 * the file SSW_TEXT_MODEL_TEST_CATALOG names, read only when the app is not packaged; null otherwise
 * or when the file cannot be read or its entries are not valid (readTestCatalog).
 */
export function testCatalog(): readonly LocalModelSpec[] | null {
  if (app.isPackaged) return null
  const file = process.env.SSW_TEXT_MODEL_TEST_CATALOG
  if (!file) return null
  try {
    return readTestCatalog(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown)
  } catch {
    return null
  }
}

/** What the store needs from the PC and the network (tests pass fakes). */
export interface LocalModelDeps {
  /** The models this build offers (the catalogue, or the test catalogue). */
  catalog: () => readonly TestModelSpec[]
  /** Memory, and whether this build has the helper. */
  pc: () => { totalMemBytes: number; freeMemBytes: number; helper: boolean }
  /**
   * The processor from the speech helpers' probe (§9.5): AVX2 with FMA and F16C, or null when the
   * probe failed or this build has no speech helper. ssw-llm is never started to find out.
   */
  processor: () => Promise<boolean | null>
  get?: HttpGet
  freeBytes?: (dir: string) => Promise<number | null>
  /** The helper has `file` loaded: stop it before the file goes (Remove). */
  unload?: (file: string) => Promise<void>
  /**
   * The model file the helper holds now, and whether it has finished loading, or null: its memory
   * counts as free, as the next run uses it or the helper gives it back before another model
   * loads; while it still loads, only for that same model (§9.5).
   */
  held?: () => { file: string; loaded: boolean } | null
  /** Something Settings shows changed (a download's progress included). */
  onChange?: () => void
  download?: { stallMs?: number; retryDelaysMs?: readonly number[] }
}

interface ActiveDownload {
  id: LocalModelId
  controller: AbortController
  done: number
  promise: Promise<LocalAiState>
}

export class LocalModelStore {
  private settingsCache: ModelsFile | null = null
  private active: ActiveDownload | null = null

  constructor(
    readonly dir: string,
    private readonly deps: LocalModelDeps
  ) {}

  private specs(): readonly TestModelSpec[] {
    return this.deps.catalog()
  }

  private spec(id: unknown): TestModelSpec | null {
    return isLocalModelId(id) ? (this.specs().find((m) => m.id === id) ?? null) : null
  }

  fileOf(spec: Pick<LocalModelSpec, 'file'>): string {
    return path.join(this.dir, spec.file)
  }

  /** models.json (defaults when missing or malformed). */
  settings(): ModelsFile {
    if (this.settingsCache) return this.settingsCache
    let raw: unknown = null
    try {
      const text = readFileSync(path.join(this.dir, MODELS_FILE), 'utf8')
      if (text.length <= SETTINGS_MAX) raw = JSON.parse(text)
    } catch {
      // Missing or malformed: the defaults.
    }
    this.settingsCache = sanitizeModelsFile(raw)
    return this.settingsCache
  }

  private save(update: (s: ModelsFile) => void): void {
    const next = structuredClone(this.settings())
    update(next)
    this.settingsCache = next
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileAtomicSync(path.join(this.dir, MODELS_FILE), JSON.stringify(next, null, 2))
    } catch (err) {
      console.warn(`Could not save ${MODELS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Forgets the cached models.json (tests: a restart). */
  reload(): void {
    this.settingsCache = null
  }

  /** Whether `spec`'s file is usable: a regular file of the catalogue's size starting with `GGUF`. */
  async check(spec: TestModelSpec): Promise<'ready' | 'damaged' | 'missing'> {
    const file = this.fileOf(spec)
    const stat = await fsp.lstat(file).catch(() => null)
    if (!stat) return 'missing'
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== spec.bytes) return 'damaged'
    let handle: fs.promises.FileHandle | null = null
    try {
      handle = await fsp.open(file, 'r')
      const head = Buffer.alloc(4)
      const { bytesRead } = await handle.read(head, 0, 4, 0)
      return bytesRead === 4 && head.toString('latin1') === 'GGUF' ? 'ready' : 'damaged'
    } catch {
      return 'damaged'
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  /** The state Settings and the text tools show (§2.5). */
  async state(): Promise<LocalAiState> {
    const pcBase = this.deps.pc()
    const avx2 = await this.deps.processor().catch(() => null)
    const pc = { ...pcBase, avx2 }
    const models: LocalModelState[] = []
    const ready: LocalModelId[] = []
    for (const spec of this.specs()) {
      const block = localModelBlock(spec, pc)
      if (this.active?.id === spec.id) {
        models.push({ id: spec.id, state: 'downloading', bytes: spec.bytes, done: this.active.done, block })
        continue
      }
      const disk = await this.check(spec)
      if (disk === 'ready') ready.push(spec.id)
      models.push({ id: spec.id, state: disk, bytes: spec.bytes, block })
    }
    const s = this.settings()
    // The memory the helper holds is not lost to the next run: count the peak of its model as free.
    // While the model still loads, most of that memory is not taken yet, so the peak counts only for
    // that model (the run waits for it); any other model is measured against the memory free now.
    const held = this.deps.held?.() ?? null
    const heldSpec = held ? this.specs().find((spec) => ready.includes(spec.id) && this.fileOf(spec) === held.file) : undefined
    if (held && heldSpec) {
      const peak = heldSpec.peakMB * 2 ** 20
      const withHeld = Math.min(pc.totalMemBytes, pc.freeMemBytes + peak)
      const pick = (free: number, ids: readonly LocalModelId[] = ready): LocalModelId | null => pickLocalModel(s.use, ids, { ...pc, freeMemBytes: free })
      if (held.loaded || pick(withHeld) === heldSpec.id) pc.freeMemBytes = withHeld
      else if (!pick(pc.freeMemBytes) && pick(withHeld, [heldSpec.id]) === heldSpec.id) {
        // Automatic would take a bigger model on the memory the loading one is about to use: stay below that model's peak.
        const bigger = Math.min(...this.specs().filter((spec) => spec.id !== heldSpec.id && ready.includes(spec.id)).map((spec) => spec.peakMB * 2 ** 20))
        pc.freeMemBytes = Math.max(peak, Math.min(withHeld, bigger - 1))
      }
    }
    return { models, use: s.use, active: pickLocalModel(s.use, ready, pc), pc, speeds: { ...s.speeds } }
  }

  /** The verified file of `id` for the helper; rejects with §9.9's message when it is missing or damaged. */
  async modelFile(id: LocalModelId): Promise<string> {
    const spec = this.spec(id)
    if (!spec || (await this.check(spec)) !== 'ready') throw new Error(LOCAL_MESSAGES.damaged)
    return this.fileOf(spec)
  }

  /** The catalogue entry of `id` with the speeds measured on this PC (§9.8). */
  specWithSpeeds(id: LocalModelId): TestModelSpec | null {
    const spec = this.spec(id)
    if (!spec) return null
    const measured = this.settings().speeds[id]
    return measured ? { ...spec, read: measured.read, write: measured.write } : spec
  }

  /**
   * Downloads `id` from its pinned sources (§9.4), resuming a stopped download; resolves with the
   * state once the file is verified and in place. Rejects with a message to show ("Cancelled."
   * when cancelled; the .part stays for a later resume).
   */
  async download(id: unknown, opts: { signal?: AbortSignal; onProgress?: (s: LocalAiState) => void } = {}): Promise<LocalAiState> {
    const spec = this.spec(id)
    if (!spec) throw new Error('Unknown model.')
    const pc = { ...this.deps.pc(), avx2: await this.deps.processor().catch(() => null) }
    const block = localModelBlock(spec, pc)
    if (block) throw new Error(`${blockReason(spec, block, pc)}${block === 'memory' ? '.' : ''}`)
    if (this.active) {
      if (this.active.id === spec.id) return this.active.promise
      throw new Error('Another model is downloading.')
    }
    if ((await this.check(spec)) === 'ready') return this.state()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const dest = this.fileOf(spec)
    // A damaged file (the wrong size, or not a GGUF) is never opened again: it goes before the download.
    if ((await this.check(spec)) === 'damaged') await fsp.rm(dest, { force: true })
    const partSize = (await fsp.stat(`${dest}.part`).catch(() => null))?.size ?? 0
    const active: ActiveDownload = { id: spec.id, controller, done: partSize, promise: Promise.resolve(null as unknown as LocalAiState) }
    this.active = active
    const report = async (): Promise<void> => {
      this.deps.onChange?.()
      if (opts.onProgress) opts.onProgress(await this.state())
    }
    const testBase = spec.url ? new URL(spec.url).origin : null
    const sources = spec.url ? [spec.url] : localModelUrls(spec)
    const run = (async (): Promise<LocalAiState> => {
      try {
        await fsp.mkdir(this.dir, { recursive: true })
        await report()
        await downloadPinned({ url: sources[sources.length - 1], bytes: spec.bytes, sha256: spec.sha256 }, dest, {
          get: this.deps.get ?? electronGet(),
          signal: controller.signal,
          sources,
          allow: (u) => allowDownloadUrl(u, testBase),
          freeBytes: this.deps.freeBytes,
          stallMs: this.deps.download?.stallMs,
          retryDelaysMs: this.deps.download?.retryDelaysMs,
          onProgress: (p) => {
            active.done = p.received
            void report()
          }
        })
      } catch (err) {
        const failure = err instanceof DownloadFailure ? err : new DownloadFailure('other', err instanceof Error ? err.message : String(err))
        if (failure.kind === 'cancelled') throw new Error('Cancelled.')
        if (failure.kind === 'disk') throw new Error(diskMessage(spec))
        throw new Error(failure.message)
      } finally {
        opts.signal?.removeEventListener('abort', onAbort)
        if (this.active === active) this.active = null
        this.deps.onChange?.()
      }
      if ((await this.check(spec)) !== 'ready') {
        await fsp.rm(dest, { force: true })
        throw new Error(LOCAL_MESSAGES.damaged)
      }
      const state = await this.state()
      opts.onProgress?.(state)
      return state
    })()
    active.promise = run
    return run
  }

  /** Stops the download of `id` (its .part stays: Download continues it). */
  async cancel(id: unknown): Promise<void> {
    const spec = this.spec(id)
    if (!spec) throw new Error('Unknown model.')
    const active = this.active
    if (active?.id !== spec.id) return
    active.controller.abort()
    await active.promise.catch(() => undefined)
  }

  /** Deletes the model's file and any part, stopping the helper first when it has the file loaded. */
  async remove(id: unknown): Promise<LocalAiState> {
    const spec = this.spec(id)
    if (!spec) throw new Error('Unknown model.')
    if (this.active?.id === spec.id) await this.cancel(spec.id)
    const file = this.fileOf(spec)
    await this.deps.unload?.(file)
    await fsp.rm(file, { force: true })
    await fsp.rm(`${file}.part`, { force: true })
    await fsp.rm(`${file}.part.json`, { force: true })
    // A pinned Use of a model that is gone goes back to Automatic.
    if (this.settings().use === spec.id) this.save((s) => (s.use = 'auto'))
    this.deps.onChange?.()
    return this.state()
  }

  /** Automatic, or a downloaded model pinned. */
  async setUse(use: unknown): Promise<LocalAiState> {
    if (!isLocalModelUse(use)) throw new Error('Unknown choice.')
    if (use !== 'auto') {
      const spec = this.spec(use)
      if (!spec || (await this.check(spec)) !== 'ready') throw new Error('Only a downloaded model can be chosen.')
    }
    this.save((s) => (s.use = use))
    this.deps.onChange?.()
    return this.state()
  }

  /** Blends speeds measured on a finished request into models.json (new = 0.7 × old + 0.3 × measured, §9.8). */
  blendSpeed(id: LocalModelId, readTps: number, writeTps: number): void {
    const spec = this.spec(id)
    if (!spec) return
    const old = this.settings().speeds[id] ?? { read: spec.read, write: spec.write }
    const blend = (o: number, m: number): number => (inRange(m) ? Math.round(((1 - SPEED_BLEND) * o + SPEED_BLEND * m) * 100) / 100 : o)
    const next = { read: blend(old.read, readTps), write: blend(old.write, writeTps) }
    if (next.read === old.read && next.write === old.write && this.settings().speeds[id]) return
    this.save((s) => (s.speeds[id] = next))
    this.deps.onChange?.()
  }

  /** At startup: .part files (and their .part.json) untouched for 30 days are deleted. */
  async sweepStaleParts(now = Date.now()): Promise<string[]> {
    const removed: string[] = []
    for (const spec of this.specs()) {
      const part = `${this.fileOf(spec)}.part`
      const stat = await fsp.stat(part).catch(() => null)
      if (!stat || now - stat.mtimeMs < STALE_PART_MS) continue
      await fsp.rm(part, { force: true })
      await fsp.rm(`${part}.json`, { force: true })
      removed.push(part)
    }
    return removed
  }

  /** Quitting: a download stops and keeps its part. */
  stopDownloads(): void {
    this.active?.controller.abort()
  }
}

/* ---------- the app's store (the contract's functions) ---------- */

let store: LocalModelStore | null = null
let storeDeps: Partial<LocalModelDeps> = {}

/** The parts of the app's store that live elsewhere (localAiIpc: the helper's unload and the change event). */
export function configureLocalModels(deps: Partial<LocalModelDeps>): void {
  storeDeps = { ...storeDeps, ...deps }
  store = null
}

/** Free bytes on the drive of `dir` (its nearest existing parent). */
async function freeBytes(dir: string): Promise<number | null> {
  let at = dir
  for (;;) {
    const st = await fsp.statfs(at).catch(() => null)
    if (st) return Number(st.bavail) * Number(st.bsize)
    const up = path.dirname(at)
    if (up === at) return null
    at = up
  }
}

export function localModels(): LocalModelStore {
  store ??= new LocalModelStore(path.join(app.getPath('userData'), TEXT_MODELS_DIR), {
    catalog: () => (testCatalog() as TestModelSpec[] | null) ?? LOCAL_MODELS,
    pc: () => ({ totalMemBytes: os.totalmem(), freeMemBytes: os.freemem(), helper: false }),
    processor: async () => null,
    freeBytes,
    ...storeDeps
  })
  return store
}

export async function localAiState(): Promise<LocalAiState> {
  return localModels().state()
}

export async function downloadLocalModel(id: unknown, opts: { signal: AbortSignal; onProgress(s: LocalAiState): void }): Promise<LocalAiState> {
  return localModels().download(id, opts)
}

export async function removeLocalModel(id: unknown): Promise<LocalAiState> {
  return localModels().remove(id)
}

export async function setLocalModelUse(use: unknown): Promise<LocalAiState> {
  return localModels().setUse(use)
}

export async function blendSpeed(id: LocalModelId, readTps: number, writeTps: number): Promise<void> {
  localModels().blendSpeed(id, readTps, writeTps)
}
