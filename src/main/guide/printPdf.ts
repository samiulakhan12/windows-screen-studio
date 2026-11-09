/**
 * Printing a guide to PDF (docs/design/smart-tools.md §5.7, §16 rule 11): the page is written to a
 * temporary file in `userData/tmp/guide-print/` (a page loaded from a data URL over 2 MiB fails),
 * loaded in a hidden window that is sandboxed, runs no script, has no preload and its own
 * in-memory session, whose requests other than that file and `data:` are refused, as is every
 * permission; printed with Chromium's tagged PDF and document outline; and the window closed and
 * the file deleted in a `finally`. Leftovers of a crash are swept at start.
 */
import { app, BrowserWindow, session } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRINT_PARTITION = 'guide-print'
export const PRINT_DIR = 'tmp/guide-print'

/** The longest a print may take: 60 s plus 1 s a step (§5.7). */
const BASE_LIMIT_MS = 60_000
const PER_STEP_MS = 1000
const TEMP_FILE = /^guide-[0-9a-f]+\.html$/

/** The temporary files the print session may load, by path. */
const allowed = new Set<string>()
let guarded = false

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Whether the print session may load `url`: the temporary file being printed, or a `data:` URL of the page. */
export function printRequestAllowed(url: string): boolean {
  if (url.startsWith('data:')) return true
  if (!url.startsWith('file:')) return false
  try {
    const file = fileURLToPath(url)
    for (const f of allowed) if (samePath(f, file)) return true
  } catch {
    return false
  }
  return false
}

/** The print session (in memory: no `persist:`), refusing every other request and every permission. */
function printSession(): Electron.Session {
  const ses = session.fromPartition(PRINT_PARTITION)
  if (!guarded) {
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !printRequestAllowed(details.url) }))
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    guarded = true
  }
  return ses
}

/** `work` within `ms`, or rejected when the time is up or `signal` aborts (`onStop` runs then). */
function within<T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined, onStop: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (message: string): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      onStop()
      reject(new Error(message))
    }
    const aborted = (): void => stop('Saving the PDF was cancelled.')
    const timer = setTimeout(() => stop('Printing the guide took too long.'), ms)
    if (signal?.aborted) return aborted()
    signal?.addEventListener('abort', aborted, { once: true })
    work.then(
      (v) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/** The PDF of the guide's print HTML (guideHtml with `print`), on `page`-size paper. */
export async function printGuidePdf(html: string, opts: { page: 'A4' | 'Letter'; steps: number; signal?: AbortSignal }): Promise<Buffer> {
  const dir = path.join(app.getPath('userData'), PRINT_DIR)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `guide-${randomBytes(12).toString('hex')}.html`)
  let win: BrowserWindow | null = null
  const close = (): void => {
    if (win && !win.isDestroyed()) win.destroy()
  }
  const limit = BASE_LIMIT_MS + PER_STEP_MS * Math.max(0, Math.min(10_000, Math.floor(opts.steps) || 0))
  try {
    await fs.writeFile(file, html, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    allowed.add(file)
    printSession()
    win = new BrowserWindow({
      show: false,
      width: 820,
      height: 1160,
      webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, partition: PRINT_PARTITION, webgl: false, spellcheck: false }
    })
    const started = Date.now()
    await within(win.loadFile(file), limit, opts.signal, close)
    const left = Math.max(1000, limit - (Date.now() - started))
    const pdf = await within(
      win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true, pageSize: opts.page }),
      left,
      opts.signal,
      close
    )
    return Buffer.from(pdf)
  } finally {
    close()
    allowed.delete(file)
    await fs.rm(file, { force: true }).catch(() => undefined)
  }
}

/** Deletes the `guide-*.html` files a crash or a kill left in `dir` (§5.7); the names deleted. */
export async function sweepGuidePrint(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const removed: string[] = []
  for (const name of names) {
    if (!TEMP_FILE.test(name)) continue
    if (await fs.rm(path.join(dir, name), { force: true }).then(() => true, () => false)) removed.push(name)
  }
  return removed
}
