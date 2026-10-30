/**
 * The filmstrip's frames (E-07, docs/design/versions.md §3.1): one ffmpeg run that decodes only
 * the proxy's key frames, picks one every `interval` seconds and tiles them into one JPEG, kept in
 * the project's `.cache/` with its numbers. A matching cache is returned without running ffmpeg;
 * requests for the same proxy share one run; ffmpeg runs below normal priority, has a time limit,
 * and stops when the editor closes or the project is deleted (stopAnalyses).
 */
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { filmstripPlan, sanitizeFilmstripMeta, type FilmstripMeta, type FilmstripPlan } from '../shared/editor/filmstrip'
import { writeFileAtomicSync } from './atomicWrite'
import { ffmpegPath } from './ffmpeg'
import { ProjectProcesses } from './projectProcesses'
import { projectDir } from './projects'
import { isAppUrl } from './security'

const CACHE = '.cache'
export const FILMSTRIP_JPG = 'filmstrip.jpg'
export const FILMSTRIP_JSON = 'filmstrip.json'
/** Largest sheet read back (a 400-frame sheet is about 1 MB). */
const MAX_JPEG = 16 * 1024 * 1024
/** Frames between the proxy's key frames (proxyArgs.ts `-g 15`). */
const GOP = 15

/** ffmpeg arguments: key frames only, one every `plan.interval` s, scaled and tiled into `out` (§3.1). */
export function filmstripArgs(file: string, plan: FilmstripPlan, out: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-skip_frame', 'nokey',
    '-i', file,
    '-map', '0:v:0',
    '-an', '-sn', '-dn',
    '-vf', `fps=fps=${+(1 / plan.interval).toFixed(6)},scale=${plan.tileW}:${plan.tileH}:flags=area,showinfo,tile=${plan.cols}x${plan.rows}`,
    '-frames:v', '1',
    '-q:v', '5',
    '-y',
    out
  ]
}

/** Frames ffmpeg's showinfo filter printed ("[Parsed_showinfo_2 @ …] n:  12 pts: …"). */
export function countShowinfo(log: string): number {
  return (log.match(/Parsed_showinfo[^\n]*\bn:\s*\d+/g) ?? []).length
}

/** The cache key: the proxy's size and time and the plan's numbers. */
export const filmstripKey = (size: number, mtimeMs: number, plan: FilmstripPlan): string =>
  `${size}:${Math.round(mtimeMs)}:${plan.interval.toFixed(6)}:${plan.tileW}x${plan.tileH}:${plan.cols}x${plan.rows}`

const running = new ProjectProcesses()
const inFlight = new Map<string, Promise<{ meta: FilmstripMeta; jpeg: Uint8Array } | null>>()

/** Runs ffmpeg; the showinfo frame count, or an error. Killed after `timeoutMs`. */
function runFfmpeg(args: string[], id: string, timeoutMs: number): Promise<{ count: number } | { error: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      resolve({ error: `ffmpeg could not be started (${err instanceof Error ? err.message : String(err)})` })
      return
    }
    running.add(proc, id)
    // Below normal: the editor and playback keep the CPU.
    try {
      if (proc.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Not allowed on this system: runs at normal priority.
    }
    let count = 0
    let tail = ''
    let last = ''
    proc.stderr!.on('data', (d: Buffer) => {
      const lines = (tail + d.toString()).split('\n')
      tail = lines.pop() ?? ''
      for (const line of lines) {
        if (/Parsed_showinfo/.test(line)) count += countShowinfo(line)
        else if (line.trim()) last = line.trim()
      }
    })
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    const finish = (r: { count: number } | { error: string }): void => {
      clearTimeout(timer)
      running.delete(proc)
      resolve(r)
    }
    proc.on('error', (err) => finish({ error: `ffmpeg could not be started (${err.message})` }))
    proc.on('close', (code, signal) => {
      count += countShowinfo(tail)
      if (code === 0) finish({ count })
      else finish({ error: signal ? 'stopped' : `ffmpeg could not read the video (exit code ${code}${last ? `: ${last.slice(0, 200)}` : ''})` })
    })
  })
}

/** `dir`/.cache, made when missing; never a link. */
async function cacheDir(dir: string): Promise<string> {
  const cache = path.join(dir, CACHE)
  const st = await fs.lstat(cache).catch(() => null)
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error('the cache folder is not a folder')
  if (!st) await fs.mkdir(cache)
  return cache
}

async function readCached(cache: string, key: string): Promise<{ meta: FilmstripMeta; jpeg: Uint8Array } | null> {
  try {
    const meta = sanitizeFilmstripMeta(JSON.parse(await fs.readFile(path.join(cache, FILMSTRIP_JSON), 'utf8')))
    if (!meta || meta.key !== key) return null
    const jpg = path.join(cache, FILMSTRIP_JPG)
    const st = await fs.lstat(jpg)
    if (!st.isFile() || st.size > MAX_JPEG) return null
    return { meta, jpeg: new Uint8Array(await fs.readFile(jpg)) }
  } catch {
    return null
  }
}

/**
 * The frames sheet of project `id` and its numbers, from the cache or made now; null when it
 * cannot be made (no proxy, ffmpeg failed or was stopped: logged).
 */
export async function getFilmstrip(id: unknown): Promise<{ meta: FilmstripMeta; jpeg: Uint8Array } | null> {
  if (typeof id !== 'string') return null
  const dir = projectDir(id)
  const generation = running.generation(id)
  const file = path.join(dir, 'screen.mp4')
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) return null
  let project: { duration?: unknown; width?: unknown; height?: unknown; capture?: { fps?: unknown } }
  try {
    project = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'))
  } catch {
    return null
  }
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)
  const duration = num(project.duration, 1)
  const fps = num(project.capture?.fps, 60)
  const plan = filmstripPlan(duration, num(project.width, 16), num(project.height, 9), GOP / fps)
  const key = filmstripKey(stat.size, stat.mtimeMs, plan)
  const flightKey = `${dir}\n${key}`
  const shared = inFlight.get(flightKey)
  if (shared) return shared
  const work = (async () => {
    const cache = await cacheDir(dir)
    const cached = await readCached(cache, key)
    if (cached) return cached
    // Stopped while the files were looked at (the editor closed, the project is being deleted).
    if (running.generation(id) !== generation) return null
    const part = path.join(cache, '.filmstrip-part.jpg')
    const timeoutMs = 60_000 + Math.min(duration, 4 * 3600) * 250
    const r = await runFfmpeg(filmstripArgs(file, plan, part), id, timeoutMs)
    if ('error' in r || r.count === 0) {
      await fs.rm(part, { force: true }).catch(() => undefined)
      if ('error' in r && r.error !== 'stopped') console.warn(`The filmstrip could not be made: ${r.error}`)
      return null
    }
    const meta: FilmstripMeta = { v: 1, key, interval: plan.interval, count: Math.min(r.count, plan.cols * plan.rows), cols: plan.cols, tileW: plan.tileW, tileH: plan.tileH }
    await fs.rename(part, path.join(cache, FILMSTRIP_JPG))
    // The numbers last: until they are written, the sheet is not used.
    writeFileAtomicSync(path.join(cache, FILMSTRIP_JSON), JSON.stringify(meta))
    const jpeg = await fs.readFile(path.join(cache, FILMSTRIP_JPG))
    return jpeg.length > MAX_JPEG ? null : { meta, jpeg: new Uint8Array(jpeg) }
  })()
    .catch((err: unknown) => {
      console.warn('The filmstrip could not be made:', err)
      return null
    })
    .finally(() => inFlight.delete(flightKey))
  inFlight.set(flightKey, work)
  return work
}

/** Stops project `id`'s filmstrip run; resolves once ffmpeg has let go of the video. */
export const stopFilmstrip = (id: string): Promise<void> => running.stop(id)

export function registerFilmstripIpc(): void {
  // Only the app's own page may start work on a project's files (as projects:detectStill).
  ipcMain.handle('filmstrip:get', (e: IpcMainInvokeEvent, id: unknown) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return getFilmstrip(id)
  })
  app.on('will-quit', () => running.stopAll())
}
