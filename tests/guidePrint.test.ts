/**
 * Printing a guide to PDF (docs/design/smart-tools.md §5.7, §16 rule 11): test 27 of §22.1, with
 * Electron's window and session faked.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  root: '',
  windows: [] as { options: Record<string, unknown>; loaded: string[]; destroyed: boolean; printed: unknown[] }[],
  filter: null as ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null,
  permission: null as ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | null,
  check: null as (() => boolean) | null,
  partitions: [] as string[],
  /** What the next load and print do. */
  behave: { load: 'ok' as 'ok' | 'fail' | 'hang', print: 'ok' as 'ok' | 'fail' | 'hang' },
  seenDuringLoad: [] as boolean[]
}))
h.root = mkdtempSync(path.join(tmpdir(), 'w11-print-'))

vi.mock('electron', () => {
  class BrowserWindow {
    rec: (typeof h.windows)[number]
    webContents: { printToPDF: (o: unknown) => Promise<Buffer> }
    constructor(options: Record<string, unknown>) {
      this.rec = { options, loaded: [], destroyed: false, printed: [] }
      h.windows.push(this.rec)
      this.webContents = {
        printToPDF: (o: unknown) => {
          this.rec.printed.push(o)
          if (h.behave.print === 'fail') return Promise.reject(new Error('print failed'))
          if (h.behave.print === 'hang') return new Promise<Buffer>(() => undefined)
          return Promise.resolve(Buffer.from('%PDF-1.7\n'))
        }
      }
    }
    loadFile(file: string): Promise<void> {
      this.rec.loaded.push(file)
      h.seenDuringLoad.push(existsSync(file))
      if (h.behave.load === 'fail') return Promise.reject(new Error('load failed'))
      if (h.behave.load === 'hang') return new Promise<void>(() => undefined)
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return this.rec.destroyed
    }
    destroy(): void {
      this.rec.destroyed = true
    }
  }
  return {
    app: { getPath: (name: string) => require('node:path').join(h.root, name) },
    BrowserWindow,
    session: {
      fromPartition: (p: string) => {
        h.partitions.push(p)
        return {
          webRequest: { onBeforeRequest: (fn: typeof h.filter) => (h.filter = fn) },
          setPermissionRequestHandler: (fn: typeof h.permission) => (h.permission = fn),
          setPermissionCheckHandler: (fn: typeof h.check) => (h.check = fn)
        }
      }
    }
  }
})

const { printGuidePdf, sweepGuidePrint, printRequestAllowed, PRINT_DIR, PRINT_PARTITION } = await import('../src/main/guide/printPdf')
const DIR = path.join(h.root, 'userData', PRINT_DIR)
afterAll(() => rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => {
  h.windows.length = 0
  h.seenDuringLoad.length = 0
  h.behave = { load: 'ok', print: 'ok' }
})

const left = (): string[] => (existsSync(DIR) ? readdirSync(DIR) : [])

describe('test 27: printGuidePdf', () => {
  it('a hidden, sandboxed window with scripts off, no preload and the in-memory partition', async () => {
    const pdf = await printGuidePdf('<!DOCTYPE html><title>x</title>', { page: 'A4', steps: 3 })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const w = h.windows[0]
    expect(w.options.show).toBe(false)
    const prefs = w.options.webPreferences as Record<string, unknown>
    expect(prefs).toMatchObject({ sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, partition: 'guide-print', webgl: false, spellcheck: false })
    expect(prefs.preload).toBeUndefined()
    expect(PRINT_PARTITION).toBe('guide-print')
    expect(PRINT_PARTITION.startsWith('persist:')).toBe(false)
    expect(h.partitions).toContain('guide-print')
    expect(w.destroyed).toBe(true)
  })

  it('the options ask for a tagged PDF with an outline, the CSS page size and backgrounds', async () => {
    await printGuidePdf('<p>x</p>', { page: 'Letter', steps: 1 })
    expect(h.windows[0].printed[0]).toEqual({ printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true, pageSize: 'Letter' })
  })

  it('the temporary file is userData/tmp/guide-print/guide-*.html, there while loading, deleted after success', async () => {
    await printGuidePdf('<p>x</p>', { page: 'A4', steps: 1 })
    const loaded = h.windows[0].loaded[0]
    expect(path.dirname(loaded)).toBe(DIR)
    expect(path.basename(loaded)).toMatch(/^guide-[0-9a-f]+\.html$/)
    expect(h.seenDuringLoad).toEqual([true])
    expect(existsSync(loaded)).toBe(false)
    expect(left()).toEqual([])
  })

  it('the request filter allows only the temporary file and data:, and every permission is refused', async () => {
    h.behave.load = 'hang'
    const ac = new AbortController()
    const running = printGuidePdf('<p>x</p>', { page: 'A4', steps: 1, signal: ac.signal })
    await vi.waitFor(() => expect(h.windows.length).toBe(1))
    await vi.waitFor(() => expect(h.windows[0].loaded.length).toBe(1))
    const file = h.windows[0].loaded[0]
    const ask = (url: string): boolean => {
      let cancel = true
      h.filter!({ url }, (r) => (cancel = r.cancel))
      return !cancel
    }
    expect(ask(pathToFileURL(file).href)).toBe(true)
    expect(ask('data:image/png;base64,AAAA')).toBe(true)
    expect(ask('https://example.com/x.png')).toBe(false)
    expect(ask('http://127.0.0.1/')).toBe(false)
    expect(ask(pathToFileURL(path.join(DIR, 'other.html')).href)).toBe(false)
    expect(ask(pathToFileURL('/etc/passwd').href)).toBe(false)
    let granted = true
    h.permission!(null, 'media', (ok) => (granted = ok))
    expect(granted).toBe(false)
    expect(h.check!()).toBe(false)
    ac.abort()
    await expect(running).rejects.toThrow(/cancelled/)
    // Cancel closes the window and deletes the file; the file is no longer allowed.
    expect(h.windows[0].destroyed).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(printRequestAllowed(pathToFileURL(file).href)).toBe(false)
  })

  it('the temporary file is deleted after a failure', async () => {
    h.behave.print = 'fail'
    await expect(printGuidePdf('<p>x</p>', { page: 'A4', steps: 1 })).rejects.toThrow('print failed')
    expect(h.windows[0].destroyed).toBe(true)
    expect(left()).toEqual([])
    h.behave = { load: 'fail', print: 'ok' }
    await expect(printGuidePdf('<p>x</p>', { page: 'A4', steps: 1 })).rejects.toThrow('load failed')
    expect(left()).toEqual([])
  })

  it('sweepGuidePrint removes leftovers at start, and nothing else', async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(path.join(DIR, 'guide-0a1b2c.html'), 'x')
    writeFileSync(path.join(DIR, 'guide-ff.html'), 'x')
    writeFileSync(path.join(DIR, 'keep.txt'), 'x')
    expect((await sweepGuidePrint(DIR)).sort()).toEqual(['guide-0a1b2c.html', 'guide-ff.html'])
    expect(left()).toEqual(['keep.txt'])
    expect(await sweepGuidePrint(path.join(h.root, 'missing'))).toEqual([])
    rmSync(path.join(DIR, 'keep.txt'))
  })
})
