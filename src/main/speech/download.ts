/**
 * Pinned, resumable, verified downloads of speech models (docs/design/offline-captions.md §3.1):
 * Electron net (system proxies), redirects followed by hand to https hosts of Hugging Face only,
 * a .part file resumed with Range, SHA-256 computed while the bytes arrive, size and hash
 * checked against the pin, then an atomic rename. Workstream B's own module (it may change).
 */

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
  /** No byte for this long aborts the attempt (then retried). */
  stallMs?: number
  /** Automatic retries of network errors and stalls, each resuming (after 2, 5 and 15 s). */
  retries?: number
  /** Free bytes on the target's drive (fs.statfs); null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>
}

export const DOWNLOAD = { stallMs: 60_000, retries: 3, retryDelaysMs: [2000, 5000, 15_000], maxRedirects: 5, spareBytes: 64 << 20, progressEveryMs: 250 } as const

/** Electron net.request GET: redirect 'manual', no credentials or cookies, User-Agent Flown/<version>. */
export function electronGet(): HttpGet {
  throw new Error('electronGet: not implemented yet (workstream B)')
}

/**
 * Whether a download may go to `url`: https on huggingface.co, *.huggingface.co or *.hf.co; in
 * an app that is not packaged also the origin of SSW_SPEECH_MODEL_BASE_URL (http://127.0.0.1 for
 * tests). Pure apart from the test hook.
 */
export function allowDownloadUrl(url: URL, testBase: string | null = null): boolean {
  void url
  void testBase
  return false
}

/** Downloads `pin` to `dest` (through `dest`.part); resolves once the verified file is in place. */
export async function downloadPinned(pin: Pin, dest: string, opts: DownloadOptions): Promise<void> {
  void pin
  void dest
  void opts
  throw new Error('downloadPinned: not implemented yet (workstream B)')
}
