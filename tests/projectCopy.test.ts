import { createHash } from 'node:crypto'
import fsDefault, { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Duplicate in the main process (docs/design/vertical-video.md §4.7, tests 61-64), on real
 * folders: what is linked, copied and left out, project.json written last from the renderer's
 * copy, the source never written, the fallbacks (no links, a full drive, Cancel, a second copy),
 * the clean-up of copies a crash left half made, and the checks of the request.
 */

const h = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }))
h.root = mkdtempSync(path.join(tmpdir(), 'ssw-project-copy-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), on: () => undefined },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  dialog: {},
  shell: {},
  protocol: {},
  clipboard: {},
  BrowserWindow: class {}
}))

const MAIN = { id: 1, isDestroyed: () => false, sent: [] as [string, unknown][], send: (c: string, v: unknown) => MAIN.sent.push([c, v]) }
const OTHER = { id: 2, isDestroyed: () => false, send: () => undefined }
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: MAIN }) }))

const { COPYING_MARK, LINKED_MEDIA, copiedFile, duplicateProject, linkAllowed, removeAbandonedCopies, removeStaleCopies } = await import('../src/main/projectCopy')
const { registerProjectsIpc } = await import('../src/main/projectsIpc')
const { projectDir, projectsRoot } = await import('../src/main/projects')
const { createProject } = await import('../src/shared/engine/project')
type Project = import('../src/shared/types').Project

afterAll(() => rmSync(h.root, { recursive: true, force: true }))
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.OneDrive
})

const SOURCE = 'rec-20260101-090000'
/** 28 October 2026, 10:15:00 local time: the copy's folder is rec-20261028-101500. */
const NOW = new Date(2026, 9, 28, 10, 15, 0)
const NEW_ID = 'rec-20261028-101500'
const OLD = new Date('2026-01-01T09:30:00.123Z')

/** The files of a recording folder, with what Duplicate does with them. */
const MEDIA = ['screen.mp4', 'webcam.mp4', 'mic.m4a', 'system.m4a']
const COPIED = ['cursor.json', 'background.png', 'cursor.png', 'watermark-2.png', 'music-1.mp3', 'overlay-3.png', 'font-1.woff2', 'script.txt', '.cache/speech.json']
const LEFT_OUT = ['.cache/transcript-parts/part-1.json', 'screen.webm', 'native.mp4', 'webcam.webm', 'audio.webm', 'recording.json', 'desktop.ini', 'notes.txt', 'extra/inside.png', 'project.json.tmp']

function sourceProject(over: Partial<Project> = {}): Project {
  return {
    ...createProject({
      id: SOURCE,
      name: 'Cam',
      duration: 8,
      width: 1280,
      height: 720,
      hasWebcam: true,
      hasAudio: true,
      webcamOffset: 0,
      zooms: [],
      cursorValid: true,
      capture: { method: 'native', cursorInVideo: false, region: null }
    }),
    createdAt: '2026-01-01T09:00:00.000Z',
    ...over
  }
}

/** A recording folder holding every kind of file, with old file times; returns its path. */
function seedSource(id = SOURCE): string {
  rmSync(projectsRoot(), { recursive: true, force: true })
  const dir = projectDir(id)
  mkdirSync(path.join(dir, '.cache', 'transcript-parts'), { recursive: true })
  mkdirSync(path.join(dir, 'extra'), { recursive: true })
  for (const f of [...MEDIA, ...COPIED, ...LEFT_OUT]) writeFileSync(path.join(dir, f), `${f} bytes `.repeat(1 + f.length))
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(sourceProject(), null, 2))
  // A link to a file elsewhere, named like an asset: never followed.
  writeFileSync(path.join(h.root, 'secret.png'), 'not in the project')
  symlinkSync(path.join(h.root, 'secret.png'), path.join(dir, 'overlay-9.png'))
  for (const f of [...MEDIA, ...COPIED, ...LEFT_OUT, 'project.json']) utimesSync(path.join(dir, f), OLD, OLD)
  return dir
}

/** Every file under `dir` (symlinks as links): bytes' hash, size, time and inode. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string): void => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const p = path.join(rel, name)
      const st = lstatSync(path.join(dir, p))
      if (st.isDirectory()) walk(p)
      else out[p] = st.isSymbolicLink() ? 'link' : `${createHash('sha256').update(readFileSync(path.join(dir, p))).digest('hex')} ${st.size} ${st.mtimeMs} ${st.ino}`
    }
  }
  walk('')
  return out
}

/** The editor's copy: the renderer's projectCopy result, still carrying the source's id. */
const rendererCopy = (over: Partial<Project> = {}): Project => ({
  ...sourceProject(),
  name: '  Cam (vertical)  ',
  style: { ...sourceProject().style, aspectRatio: '9:16' },
  reframe: { mode: 'follow', level: 1, camera: 'top', band: 0.32, pace: 'balanced', appSafe: true },
  // Ignored: main decides both.
  createdAt: '1999-01-01T00:00:00.000Z',
  copyOf: { id: 'rec-elsewhere', name: 'Not the source' },
  ...over
})

const folders = (): string[] => readdirSync(projectsRoot()).sort()
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: refused`), { code })

beforeEach(() => {
  MAIN.sent = []
})

describe('copiedFile', () => {
  it('links the recording media, copies the allow-listed files, leaves out everything else', () => {
    for (const f of LINKED_MEDIA) expect(copiedFile(f)).toBe('link')
    for (const f of COPIED) expect(copiedFile(f)).toBe('copy')
    for (const f of [...LEFT_OUT, 'project.json', '.copying', '.cache', 'overlay-0.png', '../screen.mp4', 'sub/screen.mp4']) expect(copiedFile(f)).toBeNull()
  })
})

describe('linkAllowed', () => {
  it('refuses roots inside a OneDrive folder, compared by path', () => {
    const root = path.join(h.root, 'Videos', 'Flown')
    expect(linkAllowed(root, {})).toBe(true)
    expect(linkAllowed(root, { OneDrive: h.root })).toBe(false)
    expect(linkAllowed(root, { OneDriveConsumer: path.join(h.root, 'Videos') })).toBe(false)
    expect(linkAllowed(root, { OneDriveCommercial: root })).toBe(false)
    // A folder whose name only starts the same is another folder.
    expect(linkAllowed(root, { OneDrive: path.join(h.root, 'Vid') })).toBe(true)
    expect(linkAllowed(root, { OneDrive: path.join(h.root, 'Other'), OneDriveConsumer: '' })).toBe(true)
  })
})

describe('making a copy (test 61)', () => {
  it('links the media, copies the other files with their times, and leaves out the rest', async () => {
    const src = seedSource()
    const result = await duplicateProject(SOURCE, rendererCopy(), { now: NOW })
    expect(result).toEqual({ id: NEW_ID, name: 'Cam (vertical)', linked: true })
    const dst = projectDir(NEW_ID)
    for (const f of MEDIA) {
      expect(statSync(path.join(dst, f)).ino).toBe(statSync(path.join(src, f)).ino)
    }
    for (const f of COPIED) {
      const a = statSync(path.join(src, f))
      const b = statSync(path.join(dst, f))
      expect(b.ino).not.toBe(a.ino)
      expect(readFileSync(path.join(dst, f))).toEqual(readFileSync(path.join(src, f)))
      expect(Math.trunc(b.mtimeMs)).toBe(Math.trunc(a.mtimeMs))
    }
    for (const f of [...LEFT_OUT, 'overlay-9.png', COPYING_MARK]) expect(existsSync(path.join(dst, f)), f).toBe(false)
    expect(readdirSync(path.join(dst, '.cache'))).toEqual(['speech.json'])
    expect(readdirSync(dst).sort()).toEqual([...MEDIA, ...COPIED.filter((f) => !f.includes('/')), '.cache', 'project.json'].sort())
  })
})

describe('project.json and the source folder (test 62)', () => {
  it('is written last, from the copy, with the new id, the time it was made and the original from disk', async () => {
    const src = seedSource()
    const before = snapshot(src)
    const order: string[] = []
    const dst = projectDir(NEW_ID)
    const promises = fsDefault.promises
    const link = promises.link.bind(promises)
    const copyFile = promises.copyFile.bind(promises)
    const renameSync = fsDefault.renameSync.bind(fsDefault)
    vi.spyOn(promises, 'link').mockImplementation(async (from, to) => {
      expect(existsSync(path.join(dst, COPYING_MARK))).toBe(true)
      order.push(`link ${path.basename(String(to))}`)
      return link(from, to)
    })
    vi.spyOn(promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      expect(existsSync(path.join(dst, COPYING_MARK))).toBe(true)
      order.push(`copy ${path.basename(String(to))}`)
      return copyFile(from, to, mode)
    })
    vi.spyOn(fsDefault, 'renameSync').mockImplementation((from, to) => {
      order.push(`write ${path.basename(String(to))}`)
      expect(existsSync(path.join(dst, COPYING_MARK))).toBe(true)
      return renameSync(from, to)
    })
    await duplicateProject(SOURCE, rendererCopy(), { now: NOW })
    expect(order.at(-1)).toBe('write project.json')
    expect(order.filter((o) => o.startsWith('link'))).toHaveLength(4)
    expect(order.filter((o) => o.startsWith('copy'))).toHaveLength(COPIED.length)
    expect(existsSync(path.join(dst, COPYING_MARK))).toBe(false)

    const written = JSON.parse(readFileSync(path.join(dst, 'project.json'), 'utf8')) as Project
    expect(written.id).toBe(NEW_ID)
    expect(written.createdAt).toBe(NOW.toISOString())
    expect(written.name).toBe('Cam (vertical)')
    expect(written.copyOf).toEqual({ id: SOURCE, name: 'Cam' })
    expect(written.style.aspectRatio).toBe('9:16')
    expect(written.reframe).toEqual(rendererCopy().reframe)
    // Saved as the editor saves (projects:save).
    expect(readFileSync(path.join(dst, 'project.json'), 'utf8')).toBe(JSON.stringify(written, null, 2))
    // The original is as it was: no file written, added or touched.
    expect(snapshot(src)).toEqual(before)
  })

  it('names a copy whose name is blank "Untitled recording" and cuts a long one', async () => {
    seedSource()
    expect((await duplicateProject(SOURCE, rendererCopy({ name: '   ' }), { now: NOW })).name).toBe('Untitled recording')
    const second = await duplicateProject(SOURCE, rendererCopy({ name: 'x'.repeat(300) }), { now: NOW })
    expect(second.id).toBe(`${NEW_ID}-2`)
    expect(second.name).toBe('x'.repeat(120))
  })
})

describe('when links cannot be made, the drive is full, or the copy is stopped (test 63)', () => {
  const sizeOf = (dir: string, files: string[]): number => files.reduce((n, f) => n + statSync(path.join(dir, f)).size, 0)

  it('copies the media when linking fails (EXDEV), with progress at most 10 times a second', async () => {
    const src = seedSource()
    vi.spyOn(fsDefault.promises, 'link').mockRejectedValue(errno('EXDEV'))
    const copyFile = fsDefault.promises.copyFile.bind(fsDefault.promises)
    // Slow enough to make progress worth throttling.
    vi.spyOn(fsDefault.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      await new Promise((r) => setTimeout(r, 30))
      return copyFile(from, to, mode)
    })
    const events: { done: number; total: number; at: number }[] = []
    const result = await duplicateProject(SOURCE, rendererCopy(), { now: NOW, onProgress: (p) => events.push({ ...p, at: Date.now() }) })
    expect(result.linked).toBe(false)
    const dst = projectDir(NEW_ID)
    for (const f of MEDIA) {
      expect(statSync(path.join(dst, f)).ino).not.toBe(statSync(path.join(src, f)).ino)
      expect(readFileSync(path.join(dst, f))).toEqual(readFileSync(path.join(src, f)))
    }
    const total = sizeOf(src, [...MEDIA, ...COPIED])
    expect(events[0]).toMatchObject({ done: 0, total })
    expect(events.at(-1)).toMatchObject({ done: total, total })
    for (let i = 1; i < events.length; i++) expect(events[i].done).toBeGreaterThanOrEqual(events[i - 1].done)
    // At most one event per 100 ms besides the first and the last.
    expect(events.length).toBeLessThanOrEqual(3 + Math.ceil((events.at(-1)!.at - events[0].at) / 100))
    expect(events.length).toBeLessThan(13)
    for (let i = 1; i < events.length - 1; i++) expect(events[i].at - events[i - 1].at).toBeGreaterThanOrEqual(99)
  })

  it('copies the media under a OneDrive folder, links counting as done at once otherwise', async () => {
    const src = seedSource()
    process.env.OneDrive = h.root
    const events: { done: number; total: number }[] = []
    const result = await duplicateProject(SOURCE, rendererCopy(), { now: NOW, onProgress: (p) => events.push(p) })
    expect(result.linked).toBe(false)
    expect(statSync(path.join(projectDir(NEW_ID), 'screen.mp4')).ino).not.toBe(statSync(path.join(src, 'screen.mp4')).ino)
    expect(events[0].done).toBe(0)

    delete process.env.OneDrive
    const linkedEvents: { done: number; total: number }[] = []
    expect((await duplicateProject(SOURCE, rendererCopy(), { now: NOW, onProgress: (p) => linkedEvents.push(p) })).linked).toBe(true)
    expect(linkedEvents[0]).toEqual({ done: sizeOf(src, MEDIA), total: sizeOf(src, [...MEDIA, ...COPIED]) })
  })

  it('rejects with the sizes when the drive is too full, before copying, and leaves no folder', async () => {
    seedSource()
    vi.spyOn(fsDefault.promises, 'link').mockRejectedValue(errno('EPERM'))
    vi.spyOn(fsDefault.promises, 'statfs').mockResolvedValue({ bavail: 12_000, bsize: 4096 } as never)
    const copyFile = vi.spyOn(fsDefault.promises, 'copyFile')
    await expect(duplicateProject(SOURCE, rendererCopy(), { now: NOW })).rejects.toThrow(/^there is not enough free space on this drive \(it needs 0\.1 GB, 0\.0 GB is free\)\.$/)
    expect(copyFile).not.toHaveBeenCalled()
    expect(folders()).toEqual([SOURCE])
  })

  it('removes the new folder when the copy is cancelled midway', async () => {
    seedSource()
    const abort = new AbortController()
    const copyFile = fsDefault.promises.copyFile.bind(fsDefault.promises)
    vi.spyOn(fsDefault.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      abort.abort()
      return copyFile(from, to, mode)
    })
    const made = duplicateProject(SOURCE, rendererCopy(), { now: NOW, signal: abort.signal })
    await expect(made).rejects.toMatchObject({ name: 'AbortError' })
    // A small file being copied finishes; no other one starts.
    expect(fsDefault.promises.copyFile).toHaveBeenCalledTimes(1)
    expect(folders()).toEqual([SOURCE])
  })

  /** A 20 MiB screen recording that cannot be linked, each read of it slowed by `ms`; counts its reads and whether its files were closed. */
  function slowLargeMedium(ms: number, onRead: (n: number) => void = () => undefined): { reads: () => number; open: () => number } {
    const src = projectDir(SOURCE)
    writeFileSync(path.join(src, 'screen.mp4'), Buffer.alloc(20 * 1024 * 1024, 7))
    utimesSync(path.join(src, 'screen.mp4'), OLD, OLD)
    vi.spyOn(fsDefault.promises, 'link').mockRejectedValue(errno('EXDEV'))
    let reads = 0
    let open = 0
    const realOpen = fsDefault.promises.open.bind(fsDefault.promises)
    vi.spyOn(fsDefault.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode)
      if (path.basename(String(file)) !== 'screen.mp4') return handle
      open++
      const { read, close } = handle
      return Object.assign(handle, {
        read: async (...args: unknown[]) => {
          await new Promise((r) => setTimeout(r, ms))
          onRead(++reads)
          return (read as (...a: unknown[]) => unknown).apply(handle, args)
        },
        close: async () => {
          open--
          return close.call(handle)
        }
      })
    })
    return { reads: () => reads, open: () => open }
  }

  it('copies a large medium piece by piece, with progress within it, the same bytes and the same times', async () => {
    const src = seedSource()
    const medium = slowLargeMedium(40)
    const events: { done: number; total: number }[] = []
    expect((await duplicateProject(SOURCE, rendererCopy(), { now: NOW, onProgress: (p) => events.push(p) })).linked).toBe(false)
    const dst = projectDir(NEW_ID)
    const [a, b] = [statSync(path.join(src, 'screen.mp4')), statSync(path.join(dst, 'screen.mp4'))]
    expect(b.ino).not.toBe(a.ino)
    expect(readFileSync(path.join(dst, 'screen.mp4')).equals(readFileSync(path.join(src, 'screen.mp4')))).toBe(true)
    expect(Math.trunc(b.mtimeMs)).toBe(Math.trunc(a.mtimeMs))
    expect(medium.reads()).toBeGreaterThan(1)
    expect(medium.open()).toBe(0)
    const total = events[0].total
    expect(events.some((e) => e.done > 0.1 * total && e.done < 0.9 * total)).toBe(true)
  })

  it('stops a large medium midway on Cancel: the files are closed and the folder removed before it would have finished', async () => {
    seedSource()
    const abort = new AbortController()
    // Five pieces of 4 MiB; Cancel during the second.
    const medium = slowLargeMedium(40, (n) => n === 2 && abort.abort())
    await expect(duplicateProject(SOURCE, rendererCopy(), { now: NOW, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(medium.reads()).toBe(2)
    expect(medium.open()).toBe(0)
    expect(folders()).toEqual([SOURCE])
    // The next copy is not refused.
    vi.restoreAllMocks()
    expect((await duplicateProject(SOURCE, rendererCopy(), { now: NOW })).id).toBe(NEW_ID)
  })

  /** fs.rm as Windows answers while another program (an antivirus scan, OneDrive) holds the file `held`: everything else in the folder goes, then it fails. */
  function holdFile(held: string): void {
    const rm = fsDefault.promises.rm.bind(fsDefault.promises)
    const keepOnlyHeld = async (dir: string): Promise<void> => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name)
        if (held.startsWith(p + path.sep)) await keepOnlyHeld(p)
        else if (p !== held) await rm(p, { recursive: true, force: true })
      }
    }
    vi.spyOn(fsDefault.promises, 'rm').mockImplementation(async (target, opts) => {
      const p = path.resolve(String(target))
      if (p === held) throw errno('EBUSY')
      if (!held.startsWith(p + path.sep)) return rm(target, opts)
      await keepOnlyHeld(p)
      throw errno('EBUSY')
    })
  }

  it('keeps the marker of a cancelled copy it could not remove (a file held by another program), so the next start removes it', async () => {
    seedSource()
    // Under OneDrive the media are copied, and the sync client or a scan may hold one just written.
    process.env.OneDrive = h.root
    const abort = new AbortController()
    const dst = projectDir(NEW_ID)
    const copyFile = fsDefault.promises.copyFile.bind(fsDefault.promises)
    vi.spyOn(fsDefault.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      abort.abort()
      await copyFile(from, to, mode)
      holdFile(path.resolve(String(to)))
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(duplicateProject(SOURCE, rendererCopy(), { now: NOW, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    // Not a project and not listed, but still marked as a half-made copy.
    expect(readdirSync(dst)).toHaveLength(2)
    expect(existsSync(path.join(dst, COPYING_MARK))).toBe(true)
    expect(existsSync(path.join(dst, 'project.json'))).toBe(false)
    // The file is let go; the next start removes the folder.
    vi.restoreAllMocks()
    expect(await removeAbandonedCopies()).toBe(1)
    expect(folders()).toEqual([SOURCE])
  })

  /** fs.readdir as Windows lists a folder on NTFS: by name. */
  function listByName(): void {
    const readdir = fsDefault.promises.readdir.bind(fsDefault.promises) as (...args: unknown[]) => Promise<unknown[]>
    const nameOf = (e: unknown): string => (typeof e === 'string' ? e : (e as { name: string }).name)
    vi.spyOn(fsDefault.promises, 'readdir').mockImplementation((async (...args: unknown[]) =>
      (await readdir(...args)).sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0))) as never)
  }

  it('on Cancel removes all but a held file, the files after it included (the half-copied screen.mp4), and keeps the marker', async () => {
    seedSource()
    // Under OneDrive the media are copied: mic.m4a before screen.mp4, and the sync client or a scan holds it.
    process.env.OneDrive = h.root
    listByName()
    const abort = new AbortController()
    const dst = projectDir(NEW_ID)
    const copyFile = fsDefault.promises.copyFile.bind(fsDefault.promises)
    vi.spyOn(fsDefault.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      await copyFile(from, to, mode)
      if (path.basename(String(to)) === 'mic.m4a') holdFile(path.resolve(String(to)))
    })
    // Cancel during the second piece of screen.mp4.
    slowLargeMedium(5, (n) => n === 2 && abort.abort())
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(duplicateProject(SOURCE, rendererCopy(), { now: NOW, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(readdirSync(dst).sort()).toEqual([COPYING_MARK, 'mic.m4a'])
    vi.restoreAllMocks()
    expect(await removeAbandonedCopies()).toBe(1)
    expect(folders()).toEqual([SOURCE])
  })

  it('keeps the marker of a half-made copy it could not remove at a sweep, and removes the folder at the next one', async () => {
    rmSync(projectsRoot(), { recursive: true, force: true })
    const dir = projectDir('rec-held')
    mkdirSync(path.join(dir, '.cache'), { recursive: true })
    for (const f of ['screen.mp4', 'mic.m4a', '.cache/speech.json']) writeFileSync(path.join(dir, f), 'x')
    writeFileSync(path.join(dir, COPYING_MARK), JSON.stringify({ source: SOURCE, startedAt: '2020-01-01T00:00:00.000Z' }))
    holdFile(path.join(dir, 'mic.m4a'))
    listByName()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await removeStaleCopies(NOW.getTime())).toBe(0)
    // Only the held file stays meanwhile, with the marker.
    expect(readdirSync(dir).sort()).toEqual([COPYING_MARK, 'mic.m4a'])
    vi.restoreAllMocks()
    expect(await removeStaleCopies(NOW.getTime())).toBe(1)
    expect(folders()).toEqual([])
  })

  it('refuses a second copy while one is being made', async () => {
    seedSource()
    let release = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    const copyFile = fsDefault.promises.copyFile.bind(fsDefault.promises)
    vi.spyOn(fsDefault.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      await gate
      return copyFile(from, to, mode)
    })
    const first = duplicateProject(SOURCE, rendererCopy(), { now: NOW })
    await expect(duplicateProject(SOURCE, rendererCopy(), { now: NOW })).rejects.toThrow('a copy is already being made.')
    release()
    expect((await first).id).toBe(NEW_ID)
    expect(folders()).toEqual([SOURCE, NEW_ID])
  })

  it('cleans up copies a crash left half made: marked, more than an hour old, without project.json or raw files', async () => {
    rmSync(projectsRoot(), { recursive: true, force: true })
    const now = NOW.getTime()
    const hour = 3600_000
    const folder = (id: string, mark: string | null, files: string[] = [], mtime?: number): void => {
      const dir = projectDir(id)
      mkdirSync(dir, { recursive: true })
      for (const f of files) writeFileSync(path.join(dir, f), 'x')
      if (mark !== null) writeFileSync(path.join(dir, COPYING_MARK), mark)
      if (mtime !== undefined) utimesSync(dir, new Date(mtime), new Date(mtime))
    }
    const marker = (ago: number): string => JSON.stringify({ source: SOURCE, startedAt: new Date(now - ago).toISOString() })
    folder('rec-stale', marker(2 * hour), ['screen.mp4'])
    folder('rec-recent', marker(hour / 2), ['screen.mp4'])
    folder('rec-finished', marker(2 * hour), ['project.json'])
    folder('rec-recording', marker(2 * hour), ['screen.webm'])
    folder('rec-unmarked', null, [], now - 2 * hour)
    folder('rec-garbled-old', '{not json', [], now - 2 * hour)
    folder('rec-garbled-new', '{not json', [], now - 60_000)
    expect(await removeStaleCopies(now)).toBe(2)
    expect(folders()).toEqual(['rec-finished', 'rec-garbled-new', 'rec-recent', 'rec-recording', 'rec-unmarked'])
  })

  it('at start-up removes every copy left half made, however recent (a quit cut it short); never a project or a recording', async () => {
    rmSync(projectsRoot(), { recursive: true, force: true })
    const folder = (id: string, mark: string | null, files: string[] = []): void => {
      const dir = projectDir(id)
      mkdirSync(dir, { recursive: true })
      for (const f of files) writeFileSync(path.join(dir, f), 'x')
      if (mark !== null) writeFileSync(path.join(dir, COPYING_MARK), mark)
    }
    const marker = JSON.stringify({ source: SOURCE, startedAt: new Date(Date.now() - 30_000).toISOString() })
    folder('rec-quit', marker, ['screen.mp4', 'webcam.mp4'])
    folder('rec-garbled', '{not json', ['screen.mp4'])
    folder('rec-finished', marker, ['project.json'])
    folder('rec-recording', marker, ['screen.webm'])
    folder('rec-unmarked', null, ['screen.mp4'])
    expect(await removeAbandonedCopies()).toBe(2)
    expect(folders()).toEqual(['rec-finished', 'rec-recording', 'rec-unmarked'])
    // The app does this as it starts, after the projects' IPC is set up and before its window opens.
    const main = readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')
    const at = main.indexOf('removeAbandonedCopies()')
    expect(at).toBeGreaterThan(main.indexOf('registerProjectsIpc()'))
    expect(at).toBeLessThan(main.indexOf('openMainWindow()\n'))
  })

  it('cleans them up before making a copy', async () => {
    seedSource()
    const stale = projectDir('rec-20200101-000000')
    mkdirSync(stale)
    writeFileSync(path.join(stale, COPYING_MARK), JSON.stringify({ source: SOURCE, startedAt: '2020-01-01T00:00:00.000Z' }))
    await duplicateProject(SOURCE, rendererCopy(), { now: NOW })
    expect(folders()).toEqual([SOURCE, NEW_ID])
  })
})

describe('the request (test 64)', () => {
  it('rejects a bad source id, a copy of another project and a non-project, and makes no folder', async () => {
    seedSource()
    for (const id of ['../x', '..\\x', '', 'rec/../x']) await expect(duplicateProject(id, rendererCopy({ id }), { now: NOW })).rejects.toThrow()
    await expect(duplicateProject(SOURCE, rendererCopy({ id: 'rec-other' }), { now: NOW })).rejects.toThrow('Not allowed')
    for (const raw of [null, 'project', 3, [], { name: 'no id' }]) await expect(duplicateProject(SOURCE, raw, { now: NOW })).rejects.toThrow()
    await expect(duplicateProject('rec-missing', rendererCopy({ id: 'rec-missing' }), { now: NOW })).rejects.toThrow("some of the recording's files could not be read.")
    expect(folders()).toEqual([SOURCE])
  })

  it('answers only the main window at the app page, and sends it the progress', async () => {
    seedSource()
    registerProjectsIpc()
    const duplicate = h.handlers.get('projects:duplicate')!
    const cancel = h.handlers.get('projects:duplicateCancel')!
    const appUrl = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
    const event = (sender: object, url = appUrl) => ({ sender, senderFrame: { url } })
    await expect(duplicate(event(OTHER), SOURCE, rendererCopy())).rejects.toThrow('Not allowed')
    await expect(duplicate(event(MAIN, 'https://example.com/'), SOURCE, rendererCopy())).rejects.toThrow('Not allowed')
    await expect(duplicate(event(MAIN, pathToFileURL(path.join(h.root, 'index.html')).href), SOURCE, rendererCopy())).rejects.toThrow('Not allowed')
    expect(() => cancel(event(OTHER))).toThrow('Not allowed')
    expect(folders()).toEqual([SOURCE])

    const result = (await duplicate(event(MAIN), SOURCE, rendererCopy())) as { id: string }
    expect(folders()).toEqual([SOURCE, result.id].sort())
    expect(MAIN.sent.length).toBeGreaterThan(0)
    expect(MAIN.sent.every(([channel]) => channel === 'projects:duplicateProgress')).toBe(true)
  })

  it('stops the running copy on Cancel from the main window', async () => {
    seedSource()
    registerProjectsIpc()
    const duplicate = h.handlers.get('projects:duplicate')!
    const cancel = h.handlers.get('projects:duplicateCancel')!
    const appUrl = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
    const event = { sender: MAIN, senderFrame: { url: appUrl } }
    const copyFile = fsDefault.promises.copyFile.bind(fsDefault.promises)
    vi.spyOn(fsDefault.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      cancel(event)
      return copyFile(from, to, mode)
    })
    await expect(duplicate(event, SOURCE, rendererCopy())).rejects.toMatchObject({ name: 'AbortError' })
    expect(folders()).toEqual([SOURCE])
  })
})

/* ---------- the hard-link contract (test 64, source scan) ---------- */

const LINKED_NAMES = /['"`](screen\.mp4|webcam\.mp4|mic\.m4a|system\.m4a)['"`]|SOURCE_FILES/
/**
 * Calls that write into a file. A rename or a link onto a medium's name is not one, nor is
 * writeFileAtomicSync (a temporary file and a rename): they only change this folder's entry, which
 * is how the contract has a medium replaced.
 */
const WRITES = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|truncateSync|truncate|copyFileSync|copyFile|cpSync|cp|openSync|open)\s*\(/g

/**
 * Places in `source` that open a recording medium for writing: a write whose arguments name one
 * (a literal, SOURCE_FILES, or a variable made from them in the same file). Opening for reading is fine.
 */
function linkedWrites(source: string): string[] {
  const tainted = new Set<string>()
  const assigns = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^\n;]+)/g)]
  for (let changed = true; changed; ) {
    changed = false
    for (const [, name, value] of assigns) {
      if (tainted.has(name)) continue
      if (LINKED_NAMES.test(value) || [...tainted].some((t) => new RegExp(`\\b${t.replace(/\$/g, '\\$')}\\b`).test(value))) {
        tainted.add(name)
        changed = true
      }
    }
  }
  const out: string[] = []
  for (const m of source.matchAll(WRITES)) {
    // The argument list, up to its closing parenthesis.
    let depth = 1
    let i = (m.index ?? 0) + m[0].length
    const start = i
    for (; i < source.length && depth > 0; i++) depth += source[i] === '(' ? 1 : source[i] === ')' ? -1 : 0
    const args = source.slice(start, i - 1)
    if (/^open(Sync)?$/.test(m[1]) && !/,\s*['"`](w|a|r\+)/.test(args)) continue
    if (LINKED_NAMES.test(args) || [...tainted].some((t) => new RegExp(`\\b${t.replace(/\$/g, '\\$')}\\b`).test(args))) out.push(`${m[1]}(${args.slice(0, 80)})`)
  }
  return out
}

describe('media are never opened for writing outside the recording (test 64)', () => {
  it('finds such writes', () => {
    expect(linkedWrites("const out = path.join(dir, 'screen.mp4')\nawait fs.writeFile(out, data)")).toHaveLength(1)
    expect(linkedWrites('writeFileSync(path.join(dir, SOURCE_FILES.mic), text)')).toHaveLength(1)
    expect(linkedWrites("const a = path.join(dir, 'webcam.mp4')\nconst b = a\nawait fs.appendFile(b, data)")).toHaveLength(1)
    expect(linkedWrites("const h = await fs.open(path.join(dir, 'system.m4a'), 'r+')")).toHaveLength(1)
    expect(linkedWrites("const h = await fs.open(path.join(dir, 'system.m4a'), 'r')\nawait fs.readFile(path.join(dir, 'screen.mp4'))")).toEqual([])
    expect(linkedWrites("await fs.writeFile(path.join(dir, 'cursor.json'), text)")).toEqual([])
  })

  it('lets a module replace a medium by name, as the contract asks', () => {
    // A rename or a link only changes this folder's entry; the other project keeps its data.
    expect(linkedWrites("await fs.writeFile(tmp, data)\nawait fs.rename(tmp, path.join(dir, 'screen.mp4'))")).toEqual([])
    expect(linkedWrites("const out = path.join(dir, 'mic.m4a')\nrenameSync(tmp, out)")).toEqual([])
    expect(linkedWrites("writeFileAtomicSync(path.join(dir, 'system.m4a'), text)")).toEqual([])
    expect(linkedWrites("await fs.link(path.join(src, 'webcam.mp4'), path.join(dir, 'webcam.mp4'))")).toEqual([])
    // Copying over one writes into the shared file.
    expect(linkedWrites("await fs.copyFile(tmp, path.join(dir, 'screen.mp4'))")).toHaveLength(1)
  })

  it('in no module of src/main outside recording/ and projectCopy.ts', () => {
    const main = path.join(__dirname, '../src/main')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (p !== path.join(main, 'recording')) walk(p)
        } else if (/\.ts$/.test(e.name) && p !== path.join(main, 'projectCopy.ts')) files.push(p)
      }
    }
    walk(main)
    expect(files.length).toBeGreaterThan(40)
    const found = files.flatMap((f) => linkedWrites(readFileSync(f, 'utf8')).map((w) => `${path.relative(main, f)}: ${w}`))
    expect(found).toEqual([])
  })
})
