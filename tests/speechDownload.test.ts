/**
 * Pinned, resumable, verified downloads (src/main/speech/download.ts) against a local HTTP
 * server: Range resume, restarts, the redirect allow-list, the hash check, cancel, stalls with
 * automatic retries, 403/404/5xx, a locked rename, free space and a full disk.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' }, net: {} }))

import { allowDownloadUrl, DownloadFailure, downloadPinned, type DownloadOptions, type HttpGet } from '../src/main/speech/download'

const BODY = randomBytes(300_000)
const SHA = createHash('sha256').update(BODY).digest('hex')
const requests: { path: string; range?: string }[] = []
let server: http.Server
let base: string
let dir: string

/** Serves BODY with Range support; the path picks a fault. */
function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url!, 'http://x')
  requests.push({ path: url.pathname, range: req.headers.range })
  const name = url.pathname.slice(1)
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
  const from = m ? Number(m[1]) : 0
  const send = (start: number, total = BODY.length, body = BODY): void => {
    if (start > 0) res.writeHead(206, { 'content-range': `bytes ${start}-${body.length - 1}/${total}`, 'content-length': body.length - start })
    else res.writeHead(200, { 'content-length': body.length })
    res.end(body.subarray(start))
  }
  switch (name) {
    case 'ok':
      return send(from)
    case 'norange':
      return send(0)
    case 'badtotal':
      return from > 0 ? send(from, BODY.length + 5) : send(0)
    case 'always-badtotal':
      res.writeHead(206, { 'content-range': `bytes ${from}-${BODY.length - 1}/${BODY.length + 5}` })
      return void res.end(BODY.subarray(from))
    case 'flip': {
      const copy = Buffer.from(BODY)
      copy[1000] ^= 1
      return send(from, BODY.length, copy)
    }
    case 'forbidden':
      res.writeHead(403)
      return void res.end()
    case 'missing':
      res.writeHead(404)
      return void res.end()
    case 'err500':
      res.writeHead(503)
      return void res.end()
    case 'redirect-ok':
      res.writeHead(302, { location: '/ok' })
      return void res.end()
    case 'redirect-evil':
      res.writeHead(302, { location: 'https://evil.example.com/model.bin' })
      return void res.end()
    case 'cut': {
      // The first request sends 100 000 bytes and then nothing (a stalled connection); later ones resume.
      if (requests.filter((r) => r.path === '/cut').length === 1) {
        res.writeHead(200, { 'content-length': BODY.length })
        res.write(BODY.subarray(0, 100_000))
        return
      }
      return send(from)
    }
    case 'drop': {
      // The first request is closed after 120 000 bytes (a dropped connection).
      if (requests.filter((r) => r.path === '/drop').length === 1) {
        res.writeHead(200, { 'content-length': BODY.length })
        res.write(BODY.subarray(0, 120_000), () => res.destroy())
        return
      }
      return send(from)
    }
    default:
      res.writeHead(500)
      res.end()
  }
}

/** A plain Node GET (the app uses Electron net; the contract is the same). */
const nodeGet: HttpGet = (url, headers, signal) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { headers, signal }, (res) => {
      const lower: Record<string, string> = {}
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) lower[k] = Array.isArray(v) ? v.join(', ') : v
      resolve({ status: res.statusCode ?? 0, headers: lower, body: res as AsyncIterable<Buffer> })
    })
    req.on('error', reject)
  })

beforeAll(async () => {
  server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})
beforeEach(() => {
  requests.length = 0
  dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-dl-'))
})

const pin = (name: string) => ({ url: `${base}/${name}`, bytes: BODY.length, sha256: SHA })
const opts = (over: Partial<DownloadOptions> = {}): DownloadOptions => ({ get: nodeGet, signal: new AbortController().signal, testBase: base, retryDelaysMs: [10, 10, 10], stallMs: 300, ...over })
const fail = async (p: Promise<unknown>): Promise<DownloadFailure> => {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(DownloadFailure)
    return err as DownloadFailure
  }
  throw new Error('expected a failure')
}

describe('allowDownloadUrl', () => {
  it('allows https Hugging Face hosts only, and the test base when given', () => {
    for (const u of ['https://huggingface.co/x', 'https://cdn-lfs.huggingface.co/x', 'https://us.aws.cdn.hf.co/x']) expect(allowDownloadUrl(new URL(u))).toBe(true)
    for (const u of ['http://huggingface.co/x', 'https://huggingface.co.evil.com/x', 'https://evilhuggingface.co/x', 'https://hf.co.evil/x', 'https://user:pw@huggingface.co/x', 'https://huggingface.co:8443/x', 'http://127.0.0.1:9/x'])
      expect(allowDownloadUrl(new URL(u))).toBe(false)
    expect(allowDownloadUrl(new URL('http://127.0.0.1:9/hf/x'), 'http://127.0.0.1:9/hf/')).toBe(true)
    expect(allowDownloadUrl(new URL('http://127.0.0.1:10/hf/x'), 'http://127.0.0.1:9/hf/')).toBe(false)
  })
})

describe('downloadPinned', () => {
  it('downloads, verifies and renames into place, reporting progress', async () => {
    const dest = path.join(dir, 'model.bin')
    const seen: number[] = []
    await downloadPinned(pin('ok'), dest, opts({ onProgress: (p) => seen.push(p.received) }))
    expect(readFileSync(dest).equals(BODY)).toBe(true)
    expect(existsSync(`${dest}.part`) || existsSync(`${dest}.part.json`)).toBe(false)
    expect(seen[seen.length - 1]).toBe(BODY.length)
  })

  it('resumes a .part with Range and a 206', async () => {
    const dest = path.join(dir, 'model.bin')
    writeFileSync(`${dest}.part`, BODY.subarray(0, 100_000))
    await downloadPinned(pin('ok'), dest, opts())
    expect(requests).toEqual([{ path: '/ok', range: 'bytes=100000-' }])
    expect(readFileSync(dest).equals(BODY)).toBe(true)
  })

  it('a 200 to a Range request starts over', async () => {
    const dest = path.join(dir, 'model.bin')
    writeFileSync(`${dest}.part`, Buffer.alloc(50_000, 7))
    await downloadPinned(pin('norange'), dest, opts())
    expect(readFileSync(dest).equals(BODY)).toBe(true)
  })

  it('a wrong total starts over once, then fails', async () => {
    const dest = path.join(dir, 'model.bin')
    writeFileSync(`${dest}.part`, BODY.subarray(0, 1000))
    await downloadPinned(pin('badtotal'), dest, opts())
    expect(requests.map((r) => r.range)).toEqual(['bytes=1000-', undefined])
    expect(readFileSync(dest).equals(BODY)).toBe(true)

    const dest2 = path.join(dir, 'model2.bin')
    writeFileSync(`${dest2}.part`, BODY.subarray(0, 1000))
    writeFileSync(path.join(dir, 'x'), '')
    requests.length = 0
    const f = await fail(downloadPinned(pin('always-badtotal'), dest2, opts()))
    expect(f.kind).toBe('other')
  })

  it('follows a redirect inside the allowed hosts; one off the list or plain http without the test hook fails', async () => {
    await downloadPinned(pin('redirect-ok'), path.join(dir, 'a.bin'), opts())
    expect((await fail(downloadPinned(pin('redirect-evil'), path.join(dir, 'b.bin'), opts()))).kind).toBe('other')
    // Packaged: no test base, so the plain-http address is refused before any request.
    requests.length = 0
    expect((await fail(downloadPinned(pin('ok'), path.join(dir, 'c.bin'), opts({ testBase: null })))).kind).toBe('other')
    expect(requests).toEqual([])
  })

  it('a hash mismatch deletes the .part', async () => {
    const dest = path.join(dir, 'model.bin')
    const f = await fail(downloadPinned(pin('flip'), dest, opts()))
    expect(f.kind).toBe('mismatch')
    expect(existsSync(dest) || existsSync(`${dest}.part`) || existsSync(`${dest}.part.json`)).toBe(false)
  })

  it('cancel keeps the .part', async () => {
    const dest = path.join(dir, 'model.bin')
    const controller = new AbortController()
    const p = downloadPinned(pin('cut'), dest, opts({ signal: controller.signal, stallMs: 60_000 }))
    await new Promise((r) => setTimeout(r, 200))
    controller.abort()
    expect((await fail(p)).kind).toBe('cancelled')
    expect(statSync(`${dest}.part`).size).toBe(100_000)
    expect(JSON.parse(readFileSync(`${dest}.part.json`, 'utf8'))).toMatchObject({ version: 1, bytes: BODY.length, sha256: SHA, received: 100_000 })
  })

  it('a stall retries and resumes, reporting retrying 1 of 3 meanwhile', async () => {
    const dest = path.join(dir, 'model.bin')
    const retries: unknown[] = []
    await downloadPinned(pin('cut'), dest, opts({ onRetry: (r) => retries.push(r) }))
    expect(retries[0]).toEqual({ attempt: 1, of: 3 })
    expect(requests.map((r) => r.range)).toEqual([undefined, 'bytes=100000-'])
    expect(readFileSync(dest).equals(BODY)).toBe(true)
  })

  it('a dropped connection retries and resumes', async () => {
    const dest = path.join(dir, 'model.bin')
    await downloadPinned(pin('drop'), dest, opts())
    expect(requests[1].range).toMatch(/^bytes=\d+-$/)
    expect(readFileSync(dest).equals(BODY)).toBe(true)
  })

  it('403 is refused and 404 missing, neither retried; 5xx is retried, then http', async () => {
    const r = await fail(downloadPinned(pin('forbidden'), path.join(dir, 'a.bin'), opts()))
    expect([r.kind, r.status]).toEqual(['refused', 403])
    const m = await fail(downloadPinned(pin('missing'), path.join(dir, 'b.bin'), opts()))
    expect([m.kind, m.status]).toEqual(['missing', 404])
    expect(requests).toHaveLength(2)
    requests.length = 0
    const e = await fail(downloadPinned(pin('err500'), path.join(dir, 'c.bin'), opts()))
    expect([e.kind, e.status]).toEqual(['http', 503])
    expect(requests).toHaveLength(4)
  })

  it('a rename blocked by EBUSY (antivirus) is retried', async () => {
    const dest = path.join(dir, 'model.bin')
    let tries = 0
    const rename = async (from: string, to: string): Promise<void> => {
      if (++tries < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      const { promises } = await import('node:fs')
      await promises.rename(from, to)
    }
    await downloadPinned(pin('ok'), dest, opts({ rename, renameDelayMs: 1 }))
    expect(tries).toBe(3)
    expect(readFileSync(dest).equals(BODY)).toBe(true)
  })

  it('too little space is refused before any request; a full disk fails as disk', async () => {
    const f = await fail(downloadPinned(pin('ok'), path.join(dir, 'a.bin'), opts({ freeBytes: async () => 1000 })))
    expect(f.kind).toBe('disk')
    expect(requests).toEqual([])
    if (process.platform === 'linux' && existsSync('/dev/full')) {
      const dest = path.join(dir, 'full.bin')
      symlinkSync('/dev/full', `${dest}.part`)
      expect((await fail(downloadPinned(pin('norange'), dest, opts()))).kind).toBe('disk')
    }
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})
