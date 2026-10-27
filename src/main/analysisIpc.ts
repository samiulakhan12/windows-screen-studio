/**
 * Analysis of a recording for smart editing: stretches where the picture does not change
 * (ffmpeg freezedetect on the screen proxy, inside the editor's crop: the part cropped away is
 * not seen, so it does not count). Used by smart speed to suggest speed-ups and cuts.
 *
 * The proxy is decoded once per file version and crop and the result kept, so changing the
 * minimum length in the editor never decodes it again. A run that hangs is killed after a time
 * proportional to the recording's length. A request that names no project finds nothing; an
 * analysis that cannot run or fails is reported with its reason (and not kept), so the editor
 * can say so and try again. A project's analysis stops when its editor closes or before it is
 * deleted (see ProjectProcesses).
 */
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { StillRange } from '../shared/api/projects'
import type { NormRect } from '../shared/types'
import { stopTranscription } from './ai/transcribe'
import { stopAudioAnalysisFor } from './audioAnalysis'
import { ffmpegPath } from './ffmpeg'
import { ProjectProcesses } from './projectProcesses'
import { projectDir } from './projects'
import { cropFilter } from './proxyArgs'
import { isAppUrl } from './security'

/** Shortest still stretch looked for: longer minimums are filtered from the same result. */
const DETECT_MIN = 0.5
const MAX_SECONDS = 3600
/** Frames whose mean difference stays below this (about -50 dB) count as the same picture. */
const NOISE = '-50dB'
/** Seconds between key frames of a 60 fps proxy (see proxyArgs). */
const KEY_INTERVAL = 0.25
/** Kept results (project files analysed, each crop apart). */
const CACHE_SIZE = 8

/**
 * ffmpeg arguments: the first video stream at 10 fps and 320 px wide is plenty to see change.
 * With `keyFramesOnly` only the key frames are decoded and compared (every 0.25 s in a 60 fps
 * proxy, see proxyArgs): decoding the frames fps=10 then drops was most of the work, about 9x
 * as much. fps=10 is left out then, as its copies of each key frame would look still. With a
 * `crop` (normalised, as the editor shows it) only the picture inside it is compared.
 */
export function freezeDetectArgs(file: string, minSeconds = DETECT_MIN, keyFramesOnly = false, crop: NormRect | null = null): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    ...(keyFramesOnly ? ['-skip_frame', 'nokey'] : []),
    '-i', file,
    '-map', '0:v:0',
    '-an', '-sn', '-dn',
    '-vf', `${keyFramesOnly ? '' : 'fps=10,'}${crop ? `${cropFilter(crop)},` : ''}scale=320:-2:flags=area,freezedetect=n=${NOISE}:d=${+minSeconds.toFixed(3)}`,
    '-f', 'null',
    '-'
  ]
}

const num = (s: string | undefined): number => (s === undefined ? NaN : Number(s))

/**
 * The crop a request names (cropOf in the editor): a rectangle of finite numbers inside the
 * frame, or null (the whole picture) for none and for anything else.
 */
function requestedCrop(crop: unknown): NormRect | null {
  if (!crop || typeof crop !== 'object') return null
  const { x, y, w, h } = crop as Partial<Record<keyof NormRect, unknown>>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return null
  if (!(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1 + 1e-6 && y + h <= 1 + 1e-6)) return null
  return { x, y, w, h }
}

/**
 * Still stretches from ffmpeg's log, relative to the start of the video. A freeze still
 * running when the video ends lasts to its end (the "Duration" ffmpeg printed, else
 * `fallbackEnd`). Ends are moved `endEarly` seconds back: with key frames only, the picture
 * changed somewhere after the key frame before the one ffmpeg reports.
 */
export function parseFreezeLog(log: string, fallbackEnd = NaN, endEarly = 0): StillRange[] {
  const header = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)(?:,\s*start:\s*(-?\d+(?:\.\d+)?))?/.exec(log)
  const offset = header && Number.isFinite(num(header[4])) ? num(header[4]) : 0
  const total = header ? Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3]) : fallbackEnd
  const out: StillRange[] = []
  let open: number | null = null
  for (const m of log.matchAll(/lavfi\.freezedetect\.freeze_(start|end):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/g)) {
    const t = Number(m[2]) - offset
    if (!Number.isFinite(t)) continue
    if (m[1] === 'start') open = t
    else if (open !== null) {
      if (t - endEarly > open) out.push({ start: Math.max(0, open), end: t - endEarly })
      open = null
    }
  }
  if (open !== null && Number.isFinite(total) && total > open) out.push({ start: Math.max(0, open), end: total })
  return out
}

const running = new ProjectProcesses()

/** Runs ffmpeg on `file` of project `id`: its log, or why it failed, was killed or took longer than `timeoutMs`. */
function runFreezeDetect(file: string, id: string, timeoutMs: number, keyFramesOnly: boolean, crop: NormRect | null): Promise<{ log: string } | { error: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath(), freezeDetectArgs(file, DETECT_MIN, keyFramesOnly, crop), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      resolve({ error: `ffmpeg could not be started (${err instanceof Error ? err.message : String(err)})` })
      return
    }
    running.add(proc, id)
    // Keep the interesting lines only: the log of a long recording is mostly noise.
    let log = ''
    let tail = ''
    let last = ''
    proc.stderr!.on('data', (d: Buffer) => {
      const lines = (tail + d.toString()).split('\n')
      tail = lines.pop() ?? ''
      for (const line of lines) {
        if (/freezedetect|Duration:/.test(line)) {
          if (log.length < 2_000_000) log += `${line}\n`
        } else if (line.trim()) last = line.trim()
      }
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    const finish = (result: { log: string } | { error: string }): void => {
      clearTimeout(timer)
      running.delete(proc)
      if ('error' in result) console.warn(`Still detection failed: ${result.error}${last ? ` (${last.slice(0, 300)})` : ''}`)
      resolve(result)
    }
    proc.on('error', (err) => finish({ error: `ffmpeg could not be started (${err.message})` }))
    proc.on('close', (code, signal) => {
      if (code === 0) finish({ log: log + tail })
      else if (timedOut) finish({ error: 'the analysis took too long and was stopped' })
      else if (signal) finish({ error: 'the analysis was stopped' })
      else finish({ error: `ffmpeg could not read the video (exit code ${code})` })
    })
  })
}

const cache = new Map<string, Promise<StillRange[]>>()

/**
 * Stretches of at least `minSeconds` where screen.mp4 of project `id` barely changes inside
 * `crop` (the whole picture without one); none for an `id` that is not a project id. Rejects
 * with a short reason when the analysis cannot run or fails.
 */
export async function detectStill(id: unknown, minSeconds: unknown, crop?: unknown): Promise<StillRange[]> {
  let dir: string
  try {
    if (typeof id !== 'string') return []
    dir = projectDir(id)
  } catch {
    return []
  }
  const generation = running.generation(id)
  const min = typeof minSeconds === 'number' && Number.isFinite(minSeconds) ? Math.min(Math.max(minSeconds, DETECT_MIN), MAX_SECONDS) : DETECT_MIN
  const inside = requestedCrop(crop)
  const file = path.join(dir, 'screen.mp4')
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error('the video file is missing')
  let duration = NaN
  // A 30 fps proxy has a key frame only every 0.5 s (as long as the shortest still looked for): all its frames are decoded.
  let keyFramesOnly = true
  try {
    const project = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')) as { duration?: unknown; capture?: { fps?: unknown } }
    if (typeof project.duration === 'number' && Number.isFinite(project.duration)) duration = project.duration
    keyFramesOnly = project.capture?.fps !== 30
  } catch {
    // The length printed by ffmpeg is used instead.
  }
  // Each crop is analysed apart: what changes outside it does not count inside it.
  const key = `${id}\n${stat.size}\n${stat.mtimeMs}\n${inside ? cropFilter(inside) : ''}`
  let result = cache.get(key)
  if (!result) {
    // Stopped while the file was being looked at (the editor closed, the project is being deleted).
    if (running.generation(id) !== generation) throw new Error('the analysis was stopped')
    // About a minute, plus as long again as the recording: decoding is far faster than real time.
    const timeoutMs = 60_000 + (Number.isFinite(duration) ? Math.min(duration, 4 * 3600) : 3600) * 1000
    const run = runFreezeDetect(file, id, timeoutMs, keyFramesOnly, inside).then((r) => {
      if ('log' in r) return parseFreezeLog(r.log, duration, keyFramesOnly ? KEY_INTERVAL : 0)
      // A failure is not kept: the next request runs the analysis again.
      if (cache.get(key) === run) cache.delete(key)
      throw new Error(r.error)
    })
    cache.set(key, run)
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
    result = run
  }
  return (await result).filter((r) => r.end - r.start >= min - 1e-6)
}

/** Stops project `id`'s still detection; resolves once ffmpeg has let go of the video. */
export const stopStillDetection = (id: string): Promise<void> => running.stop(id)

/**
 * Stops every analysis reading project `id`'s files (still detection, sound levels, a
 * transcription) and waits until they have let go of them: the editor closed, or the project is
 * about to be deleted.
 */
export async function stopAnalyses(id: string): Promise<void> {
  await Promise.all([stopStillDetection(id), stopAudioAnalysisFor(id), stopTranscription(id)])
}

export function registerAnalysisIpc(): void {
  // Only the app's own page may start or stop work on a project's files.
  const fromApp = (e: IpcMainInvokeEvent): void => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
  }
  ipcMain.handle('projects:detectStill', (e, id: unknown, minSeconds: unknown, crop: unknown) => {
    fromApp(e)
    return detectStill(id, minSeconds, crop)
  })
  ipcMain.handle('projects:stopAnalysis', (e, id: unknown) => {
    fromApp(e)
    return typeof id === 'string' ? stopAnalyses(id) : undefined
  })
  // An analysis must not outlive the app.
  app.on('will-quit', () => running.stopAll())
}
