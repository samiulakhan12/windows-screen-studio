/**
 * Pinned, resumable, verified downloads of speech models (docs/design/offline-captions.md §3.1):
 * Electron net (system proxies), redirects followed by hand to https hosts of Hugging Face only,
 * a .part file resumed with Range, SHA-256 computed while the bytes arrive, size and hash
 * checked against the pin, then an atomic rename. Workstream B's own module.
 */
import { app, net } from 'electron'
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import type { SpeechDownloadError } from '../../shared/api/speech'

/** Response of one GET: status, lower-case headers and the body. */
export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: AsyncIterable<Buffer>
}

/** One GET without following redirects (tests pass a fake). */
export type HttpGet = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<HttpResponse>

export interface Pin {
  url: string
  bytes: number
  sha256: string
}

export interface DownloadProgress {
  received: number
  total: number
  bytesPerSecond: number
}

export interface DownloadOptions {
  get: HttpGet
  signal: AbortSignal
  onProgress?: (p: DownloadProgress) => void
  /** Automatic retry `attempt` of `of` is waiting or running (the connection dropped); null once bytes flow again. */
  onRetry?: (retrying: { attempt: number; of: number } | null) => void
  /** Every byte is here: size and hash are being checked. */
  onVerifying?: () => void
  /** No byte for this long aborts the attempt (then retried). */
  stallMs?: number
  /** Automatic retries of network errors and stalls, each resuming (after 2, 5 and 15 s). */
  retries?: number
  retryDelaysMs?: readonly number[]
  /** Free bytes on the target's drive (fs.statfs); null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>
  /** The test hook's base (SSW_SPEECH_MODEL_BASE_URL, unpackaged only): its origin is allowed too. */
  testBase?: string | null
  /** Injectable for tests (EBUSY on rename). */
  rename?: (from: string, to: string) => Promise<void>
  /** Attempts of a rename blocked by a transient lock, and the wait between them. */
  renameAttempts?: number
  renameDelayMs?: number
}

export const DOWNLOAD = { stallMs: 60_000, retries: 3, retryDelaysMs: [2000, 5000, 15_000], maxRedirects: 5, spareBytes: 64 << 20, progressEveryMs: 250 } as const

/** Speed is averaged over this long. */
const SPEED_WINDOW_MS = 5000
/** Error codes Windows returns while antivirus or indexers briefly hold a new file (atomicWrite's set). */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Why a download stopped: one of SpeechDownloadError, or 'cancelled' (the .part is kept). */
export class DownloadFailure extends Error {
  constructor(
    readonly kind: SpeechDownloadError | 'cancelled',
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

/** Electron net.request GET: redirect 'manual', no credentials or cookies, User-Agent Flown/<version>. */
export function electronGet(): HttpGet {
  return (url, headers, signal) =>
    new Promise<HttpResponse>((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'))
      const request = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false, cache: 'no-store' })
      request.setHeader('User-Agent', `Flown/${app.getVersion()}`)
      for (const [k, v] of Object.entries(headers)) request.setHeader(k, v)
      const lower = (h: Record<string, string | string[]>): Record<string, string> => {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
        return out
      }
      const onAbort = (): void => request.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      request.on('redirect', (status, _method, redirectUrl, responseHeaders) => {
        // Followed by hand (downloadPinned checks the host): this request ends here.
        resolve({ status, headers: { ...lower(responseHeaders), location: redirectUrl }, body: (async function* () {})() })
        request.abort()
      })
      request.on('response', (response) => {
        const body = (async function* (): AsyncGenerator<Buffer> {
          const queue: Buffer[] = []
          let done = false
          let failed: Error | null = null
          let wake: (() => void) | null = null
          const poke = (): void => {
            wake?.()
            wake = null
          }
          response.on('data', (d: Buffer) => {
            queue.push(d)
            poke()
          })
          response.on('end', () => {
            done = true
            poke()
          })
          response.on('error', (e: Error) => {
            failed = e
            poke()
          })
          response.on('aborted', () => {
            failed = new Error('The connection was closed.')
            poke()
          })
          for (;;) {
            if (queue.length) yield queue.shift()!
            else if (failed) throw failed
            else if (done) return
            else await new Promise<void>((r) => (wake = r))
          }
        })()
        resolve({ status: response.statusCode, headers: lower(response.headers), body })
      })
      request.on('error', (err) => reject(err))
      request.on('abort', () => reject(new Error('aborted')))
      request.end()
    })
}

/**
 * Whether a download may go to `url`: https on huggingface.co, *.huggingface.co or *.hf.co; in
 * an app that is not packaged also the origin of SSW_SPEECH_MODEL_BASE_URL (http://127.0.0.1 for
 * tests). Pure apart from the test hook.
 */
export function allowDownloadUrl(url: URL, testBase: string | null = null): boolean {
  if (testBase) {
    try {
      if (url.origin === new URL(testBase).origin) return true
    } catch {
      // A malformed hook allows nothing extra.
    }
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
  const host = url.hostname.toLowerCase()
  return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co')
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

const sizeOf = async (file: string): Promise<number> => (await fs.stat(file).catch(() => null))?.size ?? 0

async function hashPrefix(file: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk)
}

/** `bytes S-E/T` of a 206. */
function contentRange(v: string | undefined): { start: number; total: number } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(v?.trim() ?? '')
  return m ? { start: Number(m[1]), total: Number(m[3]) } : null
}

/** One attempt hit a network error or a stall: retried. */
class Retryable extends Error {}

async function renameWithRetries(from: string, to: string, opts: DownloadOptions): Promise<void> {
  const rename = opts.rename ?? fs.rename
  const attempts = opts.renameAttempts ?? 5
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to)
    } catch (err) {
      if (!TRANSIENT.has((err as NodeJS.ErrnoException).code ?? '') || i >= attempts) throw err
      await new Promise((r) => setTimeout(r, (opts.renameDelayMs ?? 200) * i))
    }
  }
}

/** Downloads `pin` to `dest` (through `dest`.part); resolves once the verified file is in place. */
export async function downloadPinned(pin: Pin, dest: string, opts: DownloadOptions): Promise<void> {
  const part = `${dest}.part`
  const meta = `${dest}.part.json`
  const dir = dest.replace(/[\\/][^\\/]*$/, '')
  const retries = opts.retries ?? DOWNLOAD.retries
  const delays = opts.retryDelaysMs ?? DOWNLOAD.retryDelaysMs
  const stallMs = opts.stallMs ?? DOWNLOAD.stallMs
  const cancelled = (): DownloadFailure => new DownloadFailure('cancelled', 'Cancelled.')
  if (!allowDownloadUrl(new URL(pin.url), opts.testBase ?? null)) throw new DownloadFailure('other', 'The download address is not allowed.')

  let have = await sizeOf(part)
  if (have > pin.bytes) {
    await fs.rm(part, { force: true })
    have = 0
  }
  const free = opts.freeBytes ? await opts.freeBytes(dir).catch(() => null) : null
  if (free !== null && free < pin.bytes - have + DOWNLOAD.spareBytes) {
    throw new DownloadFailure('disk', `Not enough free space: ${Math.ceil((pin.bytes - have) / 1e6)} MB are needed.`)
  }

  // Speed over the last few seconds, and progress at most every progressEveryMs.
  const samples: { t: number; bytes: number }[] = []
  let lastSent = 0
  const report = (received: number, force = false): void => {
    const now = Date.now()
    samples.push({ t: now, bytes: received })
    while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift()
    if (!force && now - lastSent < DOWNLOAD.progressEveryMs) return
    lastSent = now
    const first = samples[0]
    const bytesPerSecond = now > first.t ? Math.max(0, ((received - first.bytes) * 1000) / (now - first.t)) : 0
    opts.onProgress?.({ received, total: pin.bytes, bytesPerSecond })
  }
  const writeMeta = (received: number, id = dest): Promise<void> =>
    fs.writeFile(meta, JSON.stringify({ version: 1, id: id.replace(/^.*[\\/]/, ''), bytes: pin.bytes, sha256: pin.sha256, received, updatedAt: new Date().toISOString() })).catch(() => undefined)

  let restarted = false
  let attempt = 0
  for (;;) {
    if (opts.signal.aborted) throw cancelled()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal.addEventListener('abort', onAbort, { once: true })
    let stallTimer: NodeJS.Timeout | null = null
    let stalled = false
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        controller.abort()
      }, stallMs)
    }
    try {
      have = await sizeOf(part)
      if (have > pin.bytes) {
        await fs.rm(part, { force: true })
        have = 0
      }
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {}
      armStall()
      let url = pin.url
      let res: HttpResponse
      for (let hop = 0; ; hop++) {
        try {
          res = await opts.get(url, headers, controller.signal)
        } catch (err) {
          if (opts.signal.aborted) throw cancelled()
          throw new Retryable(stalled ? 'No data arrived for a minute.' : err instanceof Error ? err.message : String(err))
        }
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
          if (hop >= DOWNLOAD.maxRedirects) throw new DownloadFailure('other', 'The download was redirected too many times.')
          let next: URL
          try {
            next = new URL(res.headers.location, url)
          } catch {
            throw new DownloadFailure('other', 'The download was redirected to an invalid address.')
          }
          if (!allowDownloadUrl(next, opts.testBase ?? null)) throw new DownloadFailure('other', `The download was redirected to a host that is not allowed (${next.host}).`)
          url = next.href
          continue
        }
        break
      }
      res = res!
      if (res.status === 403) throw new DownloadFailure('refused', 'Hugging Face or the network refused the download (HTTP 403).', 403)
      if (res.status === 404 || res.status === 410) throw new DownloadFailure('missing', `The model is no longer at its address (HTTP ${res.status}).`, res.status)
      if (res.status >= 500) throw Object.assign(new Retryable(`The server answered with HTTP ${res.status}.`), { status: res.status })
      let append = false
      if (res.status === 206) {
        const range = contentRange(res.headers['content-range'])
        if (!range || range.start !== have || range.total !== pin.bytes) {
          if (restarted) throw new DownloadFailure('other', 'The server sent a different file than expected.')
          restarted = true
          await fs.rm(part, { force: true })
          continue
        }
        append = true
      } else if (res.status === 416) {
        if (restarted) throw new DownloadFailure('other', 'The server could not continue the download.', 416)
        restarted = true
        await fs.rm(part, { force: true })
        continue
      } else if (res.status !== 200) {
        throw new DownloadFailure('http', `The server answered with HTTP ${res.status}.`, res.status)
      }

      const hash = createHash('sha256')
      let received = 0
      if (append) {
        await hashPrefix(part, hash)
        received = have
      }
      const out = createWriteStream(part, { flags: append ? 'a' : 'w' })
      let writeError: NodeJS.ErrnoException | null = null
      out.on('error', (e) => (writeError = e))
      try {
        for await (const chunk of res.body) {
          if (writeError) break
          armStall()
          if (received === have && attempt > 0) opts.onRetry?.(null)
          received += chunk.length
          if (received > pin.bytes) throw new DownloadFailure('mismatch', 'The downloaded file is larger than expected.')
          hash.update(chunk)
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r).once('error', () => r()))
          report(received)
        }
      } catch (err) {
        await new Promise<void>((r) => out.end(r))
        if (err instanceof DownloadFailure) throw err
        if (opts.signal.aborted) throw cancelled()
        throw new Retryable(stalled ? 'No data arrived for a minute.' : err instanceof Error ? err.message : String(err))
      }
      await new Promise<void>((r) => out.end(r))
      if (writeError) {
        const code = (writeError as NodeJS.ErrnoException).code
        if (code === 'ENOSPC' || code === 'EDQUOT') throw new DownloadFailure('disk', 'The disk is full.')
        throw new DownloadFailure('other', `The download could not be saved (${(writeError as Error).message}).`)
      }
      report(received, true)
      await writeMeta(received)
      if (opts.signal.aborted) throw cancelled()
      if (received < pin.bytes) {
        if (stalled) throw new Retryable('No data arrived for a minute.')
        throw new Retryable('The connection closed before the whole file arrived.')
      }

      opts.onVerifying?.()
      if (received !== pin.bytes || hash.digest('hex') !== pin.sha256) {
        await fs.rm(part, { force: true })
        await fs.rm(meta, { force: true })
        throw new DownloadFailure('mismatch', 'The downloaded file was not the expected one, so it was deleted.')
      }
      const fd = await fs.open(part, 'r+')
      try {
        await fd.sync()
      } finally {
        await fd.close()
      }
      await renameWithRetries(part, dest, opts)
      await fs.rm(meta, { force: true })
      return
    } catch (err) {
      if (!(err instanceof Retryable)) {
        if (err instanceof DownloadFailure) throw err
        if (opts.signal.aborted) throw cancelled()
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOSPC' || code === 'EDQUOT') throw new DownloadFailure('disk', 'The disk is full.')
        throw new DownloadFailure('other', err instanceof Error ? err.message : String(err))
      }
      if (attempt >= retries) {
        const status = (err as { status?: number }).status
        throw status ? new DownloadFailure('http', err.message, status) : new DownloadFailure('network', err.message)
      }
      attempt++
      opts.onRetry?.({ attempt, of: retries })
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0, opts.signal)
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
      opts.signal.removeEventListener('abort', onAbort)
    }
  }
}
