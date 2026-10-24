import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isExportTempFile, LeftoverLog, removeSyncWithRetries, removeWithRetries, settledWithin, sweepTempDir } from '../src/main/exportCleanup'
import { partialPath, tempStem } from '../src/main/exportJob'

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-export-cleanup-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

describe('removeWithRetries (audit-B-1)', () => {
  it('retries while Windows reports the file in use, then deletes it', async () => {
    const calls: string[] = []
    let fails = 3
    const rm = async (f: string): Promise<void> => {
      calls.push(f)
      if (fails-- > 0) throw err(calls.length % 2 ? 'EBUSY' : 'EPERM')
    }
    expect(await removeWithRetries('C:\\v\\.a.partial-1-x.mp4', { rm, delayMs: 1 })).toBe(true)
    expect(calls).toHaveLength(4)
  })
  it('gives up after the last attempt, and at once on other errors', async () => {
    let n = 0
    const locked = async (): Promise<void> => {
      n++
      throw err('EBUSY')
    }
    expect(await removeWithRetries('x', { rm: locked, attempts: 3, delayMs: 1 })).toBe(false)
    expect(n).toBe(3)
    n = 0
    expect(await removeWithRetries('x', { rm: async () => void (n++, (() => { throw err('EIO') })()), delayMs: 1 })).toBe(false)
    expect(n).toBe(1)
    expect(await removeWithRetries('x', { rm: async () => { throw err('ENOENT') } })).toBe(true)
  })
  it('has a blocking variant for quitting', () => {
    let n = 0
    expect(removeSyncWithRetries('x', { delayMs: 1, rmSync: () => { if (n++ < 2) throw err('EBUSY') } })).toBe(true)
    expect(n).toBe(3)
    expect(removeSyncWithRetries('x', { attempts: 2, delayMs: 1, rmSync: () => { throw err('EPERM') } })).toBe(false)
  })
})

describe('settledWithin', () => {
  it('waits for every promise, rejected ones included, but not past the timeout', async () => {
    let done = false
    const slow = new Promise((r) => setTimeout(r, 30)).then(() => (done = true))
    await settledWithin([Promise.reject(new Error('killed')), slow, null], 1000)
    expect(done).toBe(true)
    const t0 = Date.now()
    await settledWithin([new Promise(() => undefined)], 20)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('isExportTempFile', () => {
  it("matches only the export's own temporary names", () => {
    expect(isExportTempFile(partialPath('/home/me/Videos/My clip.v2.mp4'))).toBe(true)
    expect(isExportTempFile(partialPath('/home/me/Videos/Demo.gif'))).toBe(true)
    expect(isExportTempFile(partialPath('/home/me/Videos/no extension'))).toBe(true)
    expect(isExportTempFile(`${tempStem('/tmp')}.mkv`)).toBe(true)
    expect(isExportTempFile(`${tempStem('/tmp')}.png`)).toBe(true)
    expect(isExportTempFile('/home/me/Videos/Demo.mp4')).toBe(false)
    expect(isExportTempFile('/home/me/Videos/.Demo.partial.mp4')).toBe(false)
    expect(isExportTempFile('relative/.a.partial-1-x.mp4')).toBe(false)
    expect(isExportTempFile('/tmp/screen-studio-gif-12.mkv')).toBe(false)
  })
})

describe('LeftoverLog (audit-B-1: clean up at the next start)', () => {
  it('keeps the files of running exports on disk and deletes leftovers at the next start', async () => {
    const logFile = path.join(dir, 'export-leftovers.json')
    const partial = partialPath(path.join(dir, 'Demo.mp4'))
    const gif = `${tempStem(dir)}.mkv`
    const userFile = path.join(dir, 'Demo.mp4')
    for (const f of [partial, gif, userFile]) writeFileSync(f, 'x')

    const running = new LeftoverLog(logFile)
    running.add([partial, gif])
    expect(JSON.parse(readFileSync(logFile, 'utf8'))).toEqual([partial, gif])
    // The app crashes here. A tampered log naming a user file must not delete it.
    writeFileSync(logFile, JSON.stringify([partial, gif, userFile, 42]))

    const next = new LeftoverLog(logFile)
    expect((await next.sweep()).sort()).toEqual([partial, gif].sort())
    expect(existsSync(partial) || existsSync(gif)).toBe(false)
    expect(existsSync(userFile)).toBe(true)
    expect(JSON.parse(readFileSync(logFile, 'utf8'))).toEqual([])
  })
  it('keeps a file that is still locked for the start after', async () => {
    const logFile = path.join(dir, 'locked.json')
    const partial = partialPath(path.join(dir, 'Locked.mp4'))
    writeFileSync(logFile, JSON.stringify([partial]))
    const log = new LeftoverLog(logFile)
    expect(await log.sweep(async () => false)).toEqual([])
    expect(JSON.parse(readFileSync(logFile, 'utf8'))).toEqual([partial])
    log.remove([partial])
    expect(JSON.parse(readFileSync(logFile, 'utf8'))).toEqual([])
  })
  it('ignores a missing or unreadable log', async () => {
    expect(await new LeftoverLog(path.join(dir, 'none.json')).sweep()).toEqual([])
    writeFileSync(path.join(dir, 'bad.json'), '{oops')
    expect(await new LeftoverLog(path.join(dir, 'bad.json')).sweep()).toEqual([])
  })
})

describe('sweepTempDir', () => {
  it("deletes only stale GIF intermediates of processes that no longer exist", async () => {
    const tmp = mkdtempSync(path.join(dir, 'temp-'))
    const names = {
      dead: 'screen-studio-gif-99999991-abc.mkv',
      deadPalette: 'screen-studio-gif-99999991-abc.png',
      alive: 'screen-studio-gif-424242-def.mkv',
      fresh: 'screen-studio-gif-99999992-ghi.mkv',
      mine: `screen-studio-gif-${process.pid}-jkl.mkv`,
      other: 'something-else.mkv'
    }
    const old = (Date.now() - 3600_000) / 1000
    for (const [key, name] of Object.entries(names)) {
      writeFileSync(path.join(tmp, name), 'x')
      if (key !== 'fresh') utimesSync(path.join(tmp, name), old, old)
    }
    const deleted = await sweepTempDir(tmp, { isAlive: (pid) => pid === 424242 })
    expect(deleted.map((f) => path.basename(f)).sort()).toEqual([names.dead, names.deadPalette].sort())
    for (const key of ['alive', 'fresh', 'mine', 'other'] as const) expect(existsSync(path.join(tmp, names[key]))).toBe(true)
  })
})
