import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CANCELLED, copyIntoFolder } from '../src/main/share/copyToFolder'
import { postToWebhook } from '../src/main/share/webhookPost'

const signal = (): AbortSignal => new AbortController().signal
const plenty = async (): Promise<number> => 1e12

describe('copyIntoFolder', () => {
  let dir: string
  let video: string
  let root: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-sharecopy-'))
    mkdirSync(path.join(dir, 'exports'))
    video = path.join(dir, 'exports', 'Demo.mp4')
    writeFileSync(video, Buffer.alloc(3 * 1024 * 1024, 7))
    root = path.join(dir, 'OneDrive')
    mkdirSync(root)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('copies into the Flown folder with progress, and never replaces a file', async () => {
    const seen: number[] = []
    let t = 0
    const first = await copyIntoFolder(video, root, 'OneDrive', { signal: signal(), freeBytes: plenty, onProgress: (f) => seen.push(f), now: () => (t += 1000) })
    expect(first).toEqual({ dest: path.join(root, 'Flown', 'Demo.mp4'), bytes: 3 * 1024 * 1024, already: false })
    expect(readFileSync(first.dest).equals(readFileSync(video))).toBe(true)
    expect(seen[0]).toBe(0)
    expect(seen[seen.length - 1]).toBe(1)
    expect(seen.some((f) => f > 0 && f < 1)).toBe(true)
    const second = await copyIntoFolder(video, root, 'OneDrive', { signal: signal(), freeBytes: plenty })
    expect(second.dest).toBe(path.join(root, 'Flown', 'Demo (2).mp4'))
    // No partial file is left behind.
    expect(readdirSync(path.join(root, 'Flown')).sort()).toEqual(['Demo (2).mp4', 'Demo.mp4'])
  })

  it('says it is already there when the video was exported into the folder', async () => {
    mkdirSync(path.join(root, 'Flown'))
    const inside = path.join(root, 'Flown', 'Clip.mp4')
    writeFileSync(inside, 'x')
    expect(await copyIntoFolder(inside, root, 'OneDrive', { signal: signal(), freeBytes: plenty })).toMatchObject({ already: true, dest: inside })
    expect(readdirSync(path.join(root, 'Flown'))).toEqual(['Clip.mp4'])
  })

  it('deletes the partial file when cancelled', async () => {
    const controller = new AbortController()
    const run = copyIntoFolder(video, root, 'OneDrive', { signal: controller.signal, freeBytes: plenty, onProgress: (f) => f > 0 && controller.abort() , now: () => Date.now() + Math.random() * 1e6 })
    await expect(run).rejects.toThrow(CANCELLED)
    expect(readdirSync(path.join(root, 'Flown'))).toEqual([])
  })

  it('refuses a name Flown does not export, a missing folder and too little space', async () => {
    const odd = path.join(dir, 'exports', 'notes.txt')
    writeFileSync(odd, 'x')
    await expect(copyIntoFolder(odd, root, 'OneDrive', { signal: signal(), freeBytes: plenty })).rejects.toThrow('its name')
    await expect(copyIntoFolder(video, path.join(dir, 'gone'), 'Dropbox', { signal: signal(), freeBytes: plenty })).rejects.toThrow('The Dropbox folder is not there any more.')
    await expect(copyIntoFolder(video, root, 'OneDrive', { signal: signal(), freeBytes: async () => 1000 })).rejects.toThrow('not enough space on the drive of OneDrive')
    expect(existsSync(path.join(root, 'Flown', 'Demo.mp4'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses a Flown folder that is a link to somewhere else', async () => {
    const elsewhere = path.join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, path.join(root, 'Flown'))
    await expect(copyIntoFolder(video, root, 'OneDrive', { signal: signal(), freeBytes: plenty })).rejects.toThrow('leads somewhere else')
    expect(readdirSync(elsewhere)).toEqual([])
  })
})

describe('postToWebhook', () => {
  let server: http.Server
  let origin: string
  let received: { path: string; body: string; type: string | undefined }[]
  let reply: (res: http.ServerResponse) => void
  beforeEach(async () => {
    received = []
    reply = (res) => res.writeHead(200).end('ok')
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push({ path: req.url ?? '', body, type: req.headers['content-type'] })
        reply(res)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  const SLACK = 'https://hooks.slack.com/services/T0001/B0002/secretPART'
  const deps = (over = {}): Parameters<typeof postToWebhook>[4] => ({ fetch: (url, init) => fetch(url, init), origin, ...over })

  it('posts JSON to the webhook path', async () => {
    await postToWebhook('slack', SLACK, ['New video: Demo (0:05)'], signal(), deps())
    expect(received).toEqual([{ path: '/services/T0001/B0002/secretPART', body: '{"text":"New video: Demo (0:05)"}', type: 'application/json' }])
  })

  it('checks the URL again before posting', async () => {
    await expect(postToWebhook('slack', 'https://example.com/services/x', ['x'], signal(), deps())).rejects.toThrow('incoming webhook')
    await expect(postToWebhook('discord', SLACK, ['x'], signal(), deps())).rejects.toThrow()
    expect(received).toEqual([])
  })

  it('never follows a redirect', async () => {
    reply = (res) => res.writeHead(302, { location: `${origin}/elsewhere` }).end()
    await expect(postToWebhook('slack', SLACK, ['x'], signal(), deps())).rejects.toThrow('Could not reach Slack')
    expect(received.map((r) => r.path)).toEqual(['/services/T0001/B0002/secretPART'])
  })

  it('turns statuses into messages without the URL', async () => {
    reply = (res) => res.writeHead(404).end('no_service')
    const err = await postToWebhook('slack', SLACK, ['x'], signal(), deps()).catch((e: Error) => e)
    expect((err as Error).message).toBe('This webhook no longer exists. Paste a new one in Settings › Share.')
    expect((err as Error).message).not.toContain('secretPART')
  })

  it('reads at most a little of a long answer', async () => {
    reply = (res) => {
      res.writeHead(200)
      res.end(Buffer.alloc(5 * 1024 * 1024, 97))
    }
    await expect(postToWebhook('slack', SLACK, ['x'], signal(), deps())).resolves.toBeUndefined()
  })

  it('gives up after the time limit', async () => {
    reply = () => undefined
    await expect(postToWebhook('slack', SLACK, ['x'], signal(), deps({ timeoutMs: 200 }))).rejects.toThrow('did not answer in 15 s')
  })

  it('says when the chat cannot be reached', async () => {
    await expect(postToWebhook('slack', SLACK, ['x'], signal(), deps({ origin: 'http://127.0.0.1:9' }))).rejects.toThrow('Could not reach Slack')
  })
})

describe('quitting during a copy', () => {
  it('deletes the partial file at once', async () => {
    const { removePartialCopies } = await import('../src/main/share/copyToFolder')
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-sharequit-'))
    try {
      const video = path.join(dir, 'Big.mp4')
      writeFileSync(video, Buffer.alloc(8 * 1024 * 1024, 1))
      const root = path.join(dir, 'Drive')
      mkdirSync(root)
      const controller = new AbortController()
      let partial = ''
      const run = copyIntoFolder(video, root, 'Drive', {
        signal: controller.signal,
        freeBytes: plenty,
        now: () => Date.now() + Math.random() * 1e6,
        onProgress: (f) => {
          if (f > 0 && !partial) {
            partial = readdirSync(path.join(root, 'Flown')).find((n) => n.includes('.partial-')) ?? 'none'
            removePartialCopies()
            controller.abort()
          }
        }
      })
      await expect(run).rejects.toThrow()
      expect(partial).toMatch(/^\.~Big\.partial-.*\.tmp$/)
      expect(readdirSync(path.join(root, 'Flown'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('claiming the name', () => {
  it('never replaces a file that appears while copying, and sweeps old partial files', async () => {
    const { claimName, partialName, STALE_PARTIAL_MS } = await import('../src/main/share/copyToFolder')
    const { utimesSync } = await import('node:fs')
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-shareclaim-'))
    try {
      const temp = partialName(path.join(dir, 'Demo.mp4'))
      expect(path.basename(temp)).toMatch(/^\.~Demo\.partial-\d+-[0-9a-z]+\.tmp$/)
      writeFileSync(temp, 'new')
      writeFileSync(path.join(dir, 'Demo.mp4'), 'theirs')
      expect(await claimName(temp, dir, 'Demo.mp4')).toBe(path.join(dir, 'Demo (2).mp4'))
      expect(readFileSync(path.join(dir, 'Demo.mp4'), 'utf8')).toBe('theirs')
      expect(readFileSync(path.join(dir, 'Demo (2).mp4'), 'utf8')).toBe('new')
      expect(existsSync(temp)).toBe(false)

      // A file that appears after the name was checked is still not replaced.
      const temp2 = partialName(path.join(dir, 'Demo.mp4'))
      writeFileSync(temp2, 'newer')
      let first = true
      const raced = await claimName(temp2, dir, 'Demo.mp4', (f) => (first ? ((first = false), false) : existsSync(f)))
      expect(raced).toBe(path.join(dir, 'Demo (3).mp4'))
      expect(readFileSync(path.join(dir, 'Demo.mp4'), 'utf8')).toBe('theirs')

      // A copy into the folder removes partial files a crash left there an hour ago, not newer ones.
      const root = path.join(dir, 'Drive')
      mkdirSync(path.join(root, 'Flown'), { recursive: true })
      const old = path.join(root, 'Flown', '.~Old.partial-1-abc.tmp')
      const fresh = path.join(root, 'Flown', '.~Fresh.partial-1-abd.tmp')
      writeFileSync(old, 'x')
      writeFileSync(fresh, 'x')
      const t = (Date.now() - STALE_PARTIAL_MS - 60_000) / 1000
      utimesSync(old, t, t)
      const video = path.join(dir, 'Demo.mp4')
      await copyIntoFolder(video, root, 'Drive', { signal: signal(), freeBytes: plenty })
      expect(existsSync(old)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
