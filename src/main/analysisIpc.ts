/**
 * Analysis of a recording for smart editing: stretches where the picture does not change
 * (ffmpeg freezedetect on the screen proxy). Used by smart speed to suggest speed-ups and cuts.
 *
 * The proxy is decoded once per file version and the result kept, so changing the minimum
 * length in the editor never decodes it again. A run that hangs is killed after a time
 * proportional to the recording's length. A request that names no project finds nothing; an
 * analysis that cannot run or fails is reported with its reason (and not kept), so the editor
 * can say so and try again.
 */
import { app, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { StillRange } from '../shared/api/projects'
import { ffmpegPath } from './ffmpeg'
import { projectDir } from './projects'

/** Shortest still stretch looked for: longer minimums are filtered from the same result. */
const DETECT_MIN = 0.5
const MAX_SECONDS = 3600
/** Frames whose mean difference stays below this (about -50 dB) count as the same picture. */
const NOISE = '-50dB'
/** Kept results (project files analysed). */
const CACHE_SIZE = 8

/** ffmpeg arguments: the first video stream at 10 fps and 320 px wide is plenty to see change. */
export function freezeDetectArgs(file: string, minSeconds = DETECT_MIN): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-i', file,
    '-map', '0:v:0',
    '-an', '-sn', '-dn',
    '-vf', `fps=10,scale=320:-2:flags=area,freezedetect=n=${NOISE}:d=${+minSeconds.toFixed(3)}`,
    '-f', 'null',
    '-'
  ]
}

const num = (s: string | undefined): number => (s === undefined ? NaN : Number(s))

/**
 * Still stretches from ffmpeg's log, relative to the start of the video. A freeze still
 * running when the video ends lasts to its end (the "Duration" ffmpeg printed, else
 * `fallbackEnd`).
 */
export function parseFreezeLog(log: string, fallbackEnd = NaN): StillRange[] {
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
      if (t > open) out.push({ start: Math.max(0, open), end: t })
      open = null
    }
  }
  if (open !== null && Number.isFinite(total) && total > open) out.push({ start: Math.max(0, open), end: total })
  return out
}

const running = new Set<ChildProcess>()

/** Runs ffmpeg on `file`: its log, or why it failed, was killed or took longer than `timeoutMs`. */
function runFreezeDetect(file: string, timeoutMs: number): Promise<{ log: string } | { error: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath(), freezeDetectArgs(file), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      resolve({ error: `ffmpeg could not be started (${err instanceof Error ? err.message : String(err)})` })
      return
    }
    running.add(proc)
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
 * Stretches of at least `minSeconds` where screen.mp4 of project `id` barely changes; none for
 * an `id` that is not a project id. Rejects with a short reason when the analysis cannot run
 * or fails.
 */
export async function detectStill(id: unknown, minSeconds: unknown): Promise<StillRange[]> {
  let dir: string
  try {
    if (typeof id !== 'string') return []
    dir = projectDir(id)
  } catch {
    return []
  }
  const min = typeof minSeconds === 'number' && Number.isFinite(minSeconds) ? Math.min(Math.max(minSeconds, DETECT_MIN), MAX_SECONDS) : DETECT_MIN
  const file = path.join(dir, 'screen.mp4')
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error('the video file is missing')
  let duration = NaN
  try {
    const project = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')) as { duration?: unknown }
    if (typeof project.duration === 'number' && Number.isFinite(project.duration)) duration = project.duration
  } catch {
    // The length printed by ffmpeg is used instead.
  }
  const key = `${id}\n${stat.size}\n${stat.mtimeMs}`
  let result = cache.get(key)
  if (!result) {
    // About a minute, plus as long again as the recording: decoding is far faster than real time.
    const timeoutMs = 60_000 + (Number.isFinite(duration) ? Math.min(duration, 4 * 3600) : 3600) * 1000
    const run = runFreezeDetect(file, timeoutMs).then((r) => {
      if ('log' in r) return parseFreezeLog(r.log, duration)
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

export function registerAnalysisIpc(): void {
  ipcMain.handle('projects:detectStill', (_e, id: unknown, minSeconds: unknown) => detectStill(id, minSeconds))
  // An analysis must not outlive the app.
  app.on('will-quit', () => {
    for (const proc of running) proc.kill('SIGKILL')
  })
}
