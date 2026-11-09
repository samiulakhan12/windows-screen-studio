/**
 * Reading the screen once per recording (docs/design/smart-tools.md §7.2): one ffmpeg pass over
 * screen.mp4 gives, at each sample, the share of the picture that changed since the sample before
 * (blackframe on the difference of two frames) and the still stretches (freezedetect), inside the
 * editor's crop as still detection reads it. Find chapters, the guide and short clips read it.
 *
 * Kept in memory (8 results) and in the project's `.cache/scenes.json`, keyed by the file's size,
 * its modified time and the crop, so a second run and a copy of the project (which keeps the file's
 * time) are instant. Requests for the same file share one run. A run has a time limit (a minute
 * plus the recording's length), stops when the editor closes or the project is deleted
 * (stopAnalyses), and a failure is never kept: the next request runs again.
 */
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SMART_PROJECT_CHANNELS, type SceneScan } from '../shared/api/projects'
import type { NormRect } from '../shared/types'
import { writeFileAtomicSync } from './atomicWrite'
import { ffmpegPath } from './ffmpeg'
import { ProjectProcesses } from './projectProcesses'
import { projectDir } from './projects'
import { cropFilter } from './proxyArgs'
import { isAppUrl } from './security'

/** Samples a second when every frame is decoded (§7.2). */
const SAMPLE_FPS = 4
/** From this frame rate up, the key frames alone are 0.25 s apart or closer and are read instead. */
const KEY_FRAMES_FROM = 60
/** Frames between the proxy's key frames (proxyArgs.ts `-g 15`, at the video's own rate). */
const GOP = 15
/** Kept results (project files read, each crop apart). */
const CACHE_SIZE = 8
/** Results kept in one project's scenes.json (each crop apart). */
const FILE_ENTRIES = 4
/** Longest scenes.json read back. */
const MAX_CACHE_BYTES = 16 * 1024 * 1024
/** Most samples a scan keeps: 4 hours at 8 a second. */
const MAX_SAMPLES = 4 * 3600 * 8
/** Most still stretches a scan keeps. */
const MAX_STILLS = 20_000
/** Longest log of interesting lines kept from one run. */
const MAX_LOG = 24 * 1024 * 1024
/** Least time between two progress events (ms). */
const PROGRESS_MS = 250
export const SCENES_CACHE_DIR = '.cache'
export const SCENES_FILE = 'scenes.json'

/** Whether a recording at `fps` is read from its key frames alone. */
const keyFramesOnly = (fps: number | undefined): fps is number => typeof fps === 'number' && Number.isFinite(fps) && fps >= KEY_FRAMES_FROM

/**
 * ffmpeg arguments for one scan of `file` (§7.2). At `fps` 60 or more only the key frames are
 * decoded (`-skip_frame nokey`, 0.25 s apart or closer); at any other rate, or an unknown one, every
 * frame is decoded and sampled with `fps=4`. The crop is still detection's (cropFilter), after the
 * sampling and before the scale.
 */
export function sceneScanArgs(file: string, fps: number | undefined, crop: NormRect | null): string[] {
  const keyFrames = keyFramesOnly(fps)
  const chain = `${keyFrames ? '' : `fps=${SAMPLE_FPS},`}${crop ? `${cropFilter(crop)},` : ''}scale=320:-2:flags=area,split=2[a][b]`
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    ...(keyFrames ? ['-skip_frame', 'nokey'] : []),
    '-i', file,
    '-an', '-sn', '-dn',
    '-filter_complex', `[0:v:0]${chain};[a]freezedetect=n=-50dB:d=0.5[fa];[b]format=gray,tblend=all_mode=difference,blackframe=amount=0:threshold=8[fb]`,
    '-map', '[fa]', '-f', 'null', '-',
    '-map', '[fb]', '-f', 'null', '-'
  ]
}

/** Seconds between samples of a recording at `fps`: its key frames' spacing at 60 fps and above, else 0.25. */
export function sceneStep(fps: number | undefined): number {
  return keyFramesOnly(fps) ? GOP / fps : 1 / SAMPLE_FPS
}

const BLACKFRAME = /\bpblack:(\d+(?:\.\d+)?)\b.*?\bt:(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/
const FREEZE = /lavfi\.freezedetect\.freeze_(start|end):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/
const HEADER = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)(?:,\s*start:\s*(-?\d+(?:\.\d+)?))?/

/**
 * A scan from ffmpeg's log (§7.2): each blackframe line is a sample at its `t:`, whose changed share
 * is `100 − pblack` (whole numbers 0..100); freezedetect's start and end lines are the still
 * stretches, one still running at the end lasting to the end (the length ffmpeg printed, else
 * `duration`). Times are relative to the start of the video; samples come out in time order, one per
 * time. Lines it does not know are skipped.
 */
export function parseSceneLog(log: string, duration: number, step: number): SceneScan {
  const header = HEADER.exec(log)
  const offset = header && header[4] !== undefined && Number.isFinite(Number(header[4])) ? Number(header[4]) : 0
  const printed = header ? Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3]) : NaN
  const total = Number.isFinite(printed) && printed > 0 ? printed : duration
  const samples = new Map<number, number>()
  const stills: { start: number; end: number }[] = []
  let open: number | null = null
  for (const line of log.split('\n')) {
    const b = /blackframe/i.test(line) ? BLACKFRAME.exec(line) : null
    if (b) {
      const t = Number(b[2]) - offset
      const pblack = Number(b[1])
      if (!Number.isFinite(t) || t < -1e-6 || !Number.isFinite(pblack) || samples.size >= MAX_SAMPLES) continue
      samples.set(+Math.max(0, t).toFixed(6), Math.round(Math.min(100, Math.max(0, 100 - pblack))))
      continue
    }
    const f = FREEZE.exec(line)
    if (!f) continue
    const t = Number(f[2]) - offset
    if (!Number.isFinite(t)) continue
    if (f[1] === 'start') open = Math.max(0, t)
    else if (open !== null) {
      if (t > open && stills.length < MAX_STILLS) stills.push({ start: open, end: t })
      open = null
    }
  }
  if (open !== null && Number.isFinite(total) && total > open && stills.length < MAX_STILLS) stills.push({ start: open, end: total })
  const times = [...samples.keys()].sort((a, b) => a - b)
  return { step: step > 0 && Number.isFinite(step) ? step : 1 / SAMPLE_FPS, t: times, changed: times.map((t) => samples.get(t)!), stills }
}

/** The crop a request names: a rectangle of finite numbers inside the frame, or null (the whole picture) for none and anything else. */
function requestedCrop(crop: unknown): NormRect | null {
  if (!crop || typeof crop !== 'object') return null
  const { x, y, w, h } = crop as Partial<Record<keyof NormRect, unknown>>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return null
  if (!(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1 + 1e-6 && y + h <= 1 + 1e-6)) return null
  return { x, y, w, h }
}

/** The key a scan is kept under: the file's size and modified time (whole ms), the way it is sampled, and the crop. */
export function sceneCacheKey(size: number, mtimeMs: number, crop: NormRect | null, fps?: number): string {
  const sampling = keyFramesOnly(fps) ? `key${+sceneStep(fps).toFixed(6)}` : `fps${SAMPLE_FPS}`
  return `v1:${size}:${Math.round(mtimeMs)}:${sampling}:${crop ? cropFilter(crop) : ''}`
}

/** A scan read back from scenes.json, checked: null for anything malformed. */
export function readSceneScan(raw: unknown): SceneScan | null {
  if (!raw || typeof raw !== 'object') return null
  const { step, t, changed, stills } = raw as Partial<Record<keyof SceneScan, unknown>>
  if (typeof step !== 'number' || !(step > 0 && step <= 10)) return null
  if (!Array.isArray(t) || !Array.isArray(changed) || t.length !== changed.length || t.length > MAX_SAMPLES) return null
  let last = -Infinity
  for (let i = 0; i < t.length; i++) {
    const ti: unknown = t[i]
    const ci: unknown = changed[i]
    if (typeof ti !== 'number' || !Number.isFinite(ti) || ti < 0 || ti <= last) return null
    if (typeof ci !== 'number' || !Number.isInteger(ci) || ci < 0 || ci > 100) return null
    last = ti
  }
  if (!Array.isArray(stills) || stills.length > MAX_STILLS) return null
  const outStills: { start: number; end: number }[] = []
  for (const s of stills as unknown[]) {
    const r = s as { start?: unknown; end?: unknown } | null
    if (!r || typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end) || !(r.start >= 0 && r.end > r.start)) return null
    outStills.push({ start: r.start, end: r.end })
  }
  return { step, t: [...(t as number[])], changed: [...(changed as number[])], stills: outStills }
}

const running = new ProjectProcesses()

/** Runs ffmpeg for project `id`: its log of samples and stills, or why it failed, was stopped or took longer than `timeoutMs`. */
function runScan(args: string[], id: string, timeoutMs: number, onTime: (t: number) => void): Promise<{ log: string } | { error: string }> {
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
    // Keep the interesting lines only.
    let log = ''
    let tail = ''
    let last = ''
    const take = (line: string): void => {
      if (/blackframe|freezedetect|Duration:/.test(line)) {
        if (log.length < MAX_LOG) log += `${line}\n`
        const b = /blackframe/.test(line) ? BLACKFRAME.exec(line) : null
        if (b) onTime(Number(b[2]))
      } else if (line.trim()) last = line.trim()
    }
    proc.stderr!.on('data', (d: Buffer) => {
      const lines = (tail + d.toString()).split('\n')
      tail = lines.pop() ?? ''
      for (const line of lines) take(line)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    const finish = (result: { log: string } | { error: string }): void => {
      clearTimeout(timer)
      running.delete(proc)
      if ('error' in result) console.warn(`Reading the screen failed: ${result.error}${last ? ` (${last.slice(0, 300)})` : ''}`)
      resolve(result)
    }
    proc.on('error', (err) => finish({ error: `ffmpeg could not be started (${err.message})` }))
    proc.on('close', (code, signal) => {
      if (tail) take(tail)
      if (code === 0) finish({ log })
      else if (timedOut) finish({ error: 'reading the screen took too long and was stopped' })
      else if (signal) finish({ error: 'reading the screen was stopped' })
      else finish({ error: `ffmpeg could not read the video (exit code ${code})` })
    })
  })
}

/** `dir`/.cache, made when missing; never a link. */
async function cacheDir(dir: string): Promise<string> {
  const cache = path.join(dir, SCENES_CACHE_DIR)
  const st = await fs.lstat(cache).catch(() => null)
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error('the cache folder is not a folder')
  if (!st) await fs.mkdir(cache)
  return cache
}

/** The entries of `dir`'s scenes.json, checked; none when it is missing, too big, a link or malformed. */
async function readCacheFile(dir: string): Promise<{ key: string; scan: SceneScan }[]> {
  try {
    const folder = await fs.lstat(path.join(dir, SCENES_CACHE_DIR))
    if (folder.isSymbolicLink() || !folder.isDirectory()) return []
    const file = path.join(dir, SCENES_CACHE_DIR, SCENES_FILE)
    const st = await fs.lstat(file)
    if (!st.isFile() || st.size > MAX_CACHE_BYTES) return []
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { v?: unknown; scans?: unknown } | null
    if (raw?.v !== 1 || !Array.isArray(raw.scans)) return []
    const out: { key: string; scan: SceneScan }[] = []
    for (const e of (raw.scans as unknown[]).slice(0, FILE_ENTRIES)) {
      const entry = e as { key?: unknown; scan?: unknown } | null
      const scan = readSceneScan(entry?.scan)
      if (entry && typeof entry.key === 'string' && scan) out.push({ key: entry.key, scan })
    }
    return out
  } catch {
    return []
  }
}

/** Keeps `scan` under `key` in `dir`'s scenes.json, newest first; a failure to write is only logged. */
async function writeCacheFile(dir: string, key: string, scan: SceneScan): Promise<void> {
  try {
    const cache = await cacheDir(dir)
    const others = (await readCacheFile(dir)).filter((e) => e.key !== key)
    const scans = [{ key, scan }, ...others].slice(0, FILE_ENTRIES)
    writeFileAtomicSync(path.join(cache, SCENES_FILE), JSON.stringify({ v: 1, scans }))
  } catch (err) {
    console.warn('The screen reading could not be kept:', err)
  }
}

interface Run {
  result: Promise<SceneScan>
  /** Progress listeners of the requests waiting for it. */
  listeners: Set<(fraction: number) => void>
}

/** Runs by project folder and key, oldest first; a failed one is removed. */
const cache = new Map<string, Run>()

/**
 * How much of the picture changes at each sample of screen.mp4 of project `id`, and where it stays
 * still, inside `crop` (the whole picture without one): from the cache, or read now with one ffmpeg
 * pass. `onProgress` gets the share of the recording read (0..1), at most every 250 ms, while this
 * request waits for a run. Rejects with a short reason when `id` names no project, the video is
 * missing, or the scan fails or is stopped.
 */
export async function detectScenes(id: unknown, crop: unknown, onProgress?: (fraction: number) => void): Promise<SceneScan> {
  if (typeof id !== 'string') throw new Error('the video file is missing')
  let dir: string
  try {
    dir = projectDir(id)
  } catch {
    throw new Error('the video file is missing')
  }
  const generation = running.generation(id)
  const inside = requestedCrop(crop)
  const file = path.join(dir, 'screen.mp4')
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error('the video file is missing')
  let duration = NaN
  let fps: number | undefined
  try {
    const project = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')) as { duration?: unknown; capture?: { fps?: unknown } } | null
    if (typeof project?.duration === 'number' && Number.isFinite(project.duration) && project.duration > 0) duration = project.duration
    const rate = project?.capture?.fps
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) fps = rate
  } catch {
    // The length printed by ffmpeg is used, and every frame is decoded.
  }
  const key = sceneCacheKey(stat.size, stat.mtimeMs, inside, fps)
  const memoKey = `${dir}\n${key}`
  let run = cache.get(memoKey)
  if (!run) {
    // Stopped while the file was being looked at (the editor closed, the project is being deleted).
    if (running.generation(id) !== generation) throw new Error('reading the screen was stopped')
    const listeners = new Set<(fraction: number) => void>()
    const work = async (): Promise<SceneScan> => {
      const kept = (await readCacheFile(dir)).find((e) => e.key === key)
      if (kept) return kept.scan
      if (running.generation(id) !== generation) throw new Error('reading the screen was stopped')
      // About a minute, plus as long again as the recording: one pass is far faster than real time.
      const timeoutMs = 60_000 + (Number.isFinite(duration) ? Math.min(duration, 4 * 3600) : 3600) * 1000
      let lastSent = 0
      const onTime = (t: number): void => {
        if (!Number.isFinite(duration) || !listeners.size) return
        const now = Date.now()
        if (now - lastSent < PROGRESS_MS) return
        lastSent = now
        const fraction = Math.min(1, Math.max(0, t / duration))
        for (const l of [...listeners]) l(fraction)
      }
      const r = await runScan(sceneScanArgs(file, fps, inside), id, timeoutMs, onTime)
      if ('error' in r) throw new Error(r.error)
      const scan = parseSceneLog(r.log, duration, sceneStep(fps))
      // Kept on disk only when the run was not stopped in the meantime.
      if (running.generation(id) === generation) await writeCacheFile(dir, key, scan)
      return scan
    }
    const result = work()
    const mine: Run = { result, listeners }
    run = mine
    // A failure is not kept: the next request runs again.
    result.catch(() => {
      if (cache.get(memoKey) === mine) cache.delete(memoKey)
    })
    cache.set(memoKey, mine)
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  }
  if (!onProgress) return run.result
  run.listeners.add(onProgress)
  try {
    return await run.result
  } finally {
    run.listeners.delete(onProgress)
  }
}

/** Stops project `id`'s scene scan and waits until ffmpeg has let go of the video. */
export const stopSceneScan = (id: string): Promise<void> => running.stop(id)

/** Only the app's own page. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

/** Sends a scan's progress to the page that asked, while it is there. */
function progressTo(sender: WebContents, id: string): (fraction: number) => void {
  return (fraction) => {
    try {
      if (!sender.isDestroyed()) sender.send(SMART_PROJECT_CHANNELS.sceneProgress, { id, fraction })
    } catch {
      // The page went away: nothing to tell.
    }
  }
}

export function registerSceneIpc(): void {
  ipcMain.handle(SMART_PROJECT_CHANNELS.detectScenes, (e, id: unknown, crop: unknown) => {
    fromApp(e)
    return detectScenes(id, crop, typeof id === 'string' ? progressTo(e.sender, id) : undefined)
  })
  // A scan must not outlive the app.
  app.on('will-quit', () => running.stopAll())
}
