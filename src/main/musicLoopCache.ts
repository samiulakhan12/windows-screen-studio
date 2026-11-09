/**
 * Users' own looping Opus, M4A and AAC music decoded once into the project's .cache/ (docs/design/
 * editing-polish.md §0 decision 2, §10.4), so the export loops it without a glitch.
 *
 * The export loops music with ffmpeg's `-stream_loop -1`. On Opus and AAC that puts a glitch at
 * every loop point (the codec's priming and end padding meet there); WAV, FLAC, MP3 and Vorbis loop
 * cleanly. So a looping file of another kind is decoded once with the app's ffmpeg into
 * `.cache/music-<n>.<first 16 hex of its SHA-256>.flac` (16-bit FLAC loops exactly), and the export
 * reads that with the same `-stream_loop -1`: the graph around it is unchanged, the project file is
 * never changed, and the cache is used again until the music changes.
 *
 * Only when the music is shorter than the video (else it never loops), and never more than the
 * output's length (`-t`). The free space is checked first; the decode runs with an argument list
 * (no shell) on file names built here, under the export's cancel signal and a timeout; a partial
 * file is deleted. Making a new cache deletes the project's older ones. Duplicate never copies
 * `.cache/` (projectCopy.ts copiedFile), and versions never keep it.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { MUSIC_FILE_RE } from '../shared/audio/settings'

/** The project's cache folder (also the speech and sound finders'). */
export const MUSIC_CACHE_DIR = '.cache'
/** A decoded copy of a music pick: the pick's name, the first 16 hex of its SHA-256, .flac. */
export const MUSIC_CACHE_RE = /^music(?:-[1-9][0-9]{0,8})?\.[0-9a-f]{16}\.flac$/
/** A decode that did not finish. */
const PARTIAL_RE = /^music(?:-[1-9][0-9]{0,8})?\.[0-9a-f]{16}\.flac\.partial$/
/** Room left on the drive besides the decoded copy (projectCopy.ts keeps the same). */
export const CACHE_SPARE_BYTES = 64 * 1024 * 1024
/** Bytes per second and channel of the copy: 16-bit samples, at most 48 kHz. */
const BYTES_PER_CHANNEL_SECOND = 48000 * 2
/** Longest wait for ffmpeg to read the music's header. */
const PROBE_TIMEOUT_MS = 30_000
const LOG_CAP = 16_000

export const MUSIC_CACHE_COPY = {
  cancelled: 'The export was cancelled.',
  failed: 'The background music could not be prepared for looping. Choose it again in the Audio panel, or turn Loop off.',
  timedOut: 'Preparing the background music for looping took too long. Try the export again.',
  space: (mb: number): string => `There is not enough free space to prepare the background music for the export: about ${mb} MB more is needed. Free some space and export again.`
}

export interface LoopableOptions {
  /** Seconds of the export: the copy is never longer. */
  seconds: number
  /** The export's cancel signal: kills the decode. */
  signal: AbortSignal
  timeoutMs: number
  /** Free bytes on the drive of `dir` (tests); default fs.statfs. */
  freeBytes?: (dir: string) => Promise<number | null>
}

/** The codec of an Ogg file from its first page: 'vorbis', 'opus', 'flac' or null (another, or not Ogg). */
export async function oggCodec(file: string): Promise<'vorbis' | 'opus' | 'flac' | null> {
  const h = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(282)
    const { bytesRead } = await h.read(buf, 0, buf.length, 0)
    if (bytesRead < 28 || buf.toString('latin1', 0, 4) !== 'OggS') return null
    // The first page holds the codec's identification packet, after the segment table.
    const at = 27 + buf[26]
    const head = buf.subarray(at, Math.min(bytesRead, at + 8)).toString('latin1')
    if (head.startsWith('\x01vorbis')) return 'vorbis'
    if (head.startsWith('OpusHead')) return 'opus'
    if (head.startsWith('\x7fFLAC')) return 'flac'
    return null
  } finally {
    await h.close()
  }
}

/** Whether ffmpeg's -stream_loop loops `file` cleanly: WAV, FLAC, MP3 and Vorbis do; Opus and AAC (M4A) do not. */
export async function loopsCleanly(file: string): Promise<boolean> {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.mp3' || ext === '.wav' || ext === '.flac') return true
  if (ext === '.ogg') {
    const codec = await oggCodec(file).catch(() => null)
    return codec === 'vorbis' || codec === 'flac'
  }
  return false
}

/** The first 16 hex digits of a file's SHA-256 (read as a stream). */
async function hashOf(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex').slice(0, 16)
}

/** Seconds and channels of the first audio stream, from ffmpeg's log ("Duration: 00:01:02.50", "Audio: opus, 48000 Hz, stereo"). */
export function parseMusicProbe(log: string): { seconds: number | null; channels: number } {
  const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(log)
  const s = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : NaN
  const a = /Audio:[^\n]*?,\s*\d+ Hz,\s*([^,\n]+)/.exec(log)
  const layout = a?.[1].trim() ?? ''
  const n = /^(\d+) channels/.exec(layout)
  const known: Record<string, number> = { mono: 1, stereo: 2, '2.1': 3, quad: 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 }
  const channels = n ? Number(n[1]) : (known[layout.replace(/\(.*\)$/, '')] ?? 2)
  return { seconds: Number.isFinite(s) && s > 0 ? s : null, channels: Math.min(8, Math.max(1, channels)) }
}

/** Runs ffmpeg (an argument list, no shell) under `signal` and a timeout; its log, or a readable failure. */
function runFfmpeg(ffmpeg: string, args: string[], signal: AbortSignal, timeoutMs: number, okCodes: readonly number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(MUSIC_CACHE_COPY.cancelled))
      return
    }
    const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let log = ''
    let ended: 'timeout' | 'cancel' | null = null
    proc.stderr.on('data', (d: Buffer) => {
      if (log.length < LOG_CAP) log += d.toString().slice(0, LOG_CAP - log.length)
    })
    const stop = (why: 'timeout' | 'cancel'): void => {
      ended ??= why
      proc.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const onAbort = (): void => stop('cancel')
    signal.addEventListener('abort', onAbort, { once: true })
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    proc.on('error', () => {
      done()
      reject(new Error(MUSIC_CACHE_COPY.failed))
    })
    proc.on('close', (code) => {
      done()
      if (ended === 'cancel') reject(new Error(MUSIC_CACHE_COPY.cancelled))
      else if (ended === 'timeout') reject(new Error(MUSIC_CACHE_COPY.timedOut))
      else if (code !== null && okCodes.includes(code)) resolve(log)
      else reject(Object.assign(new Error(MUSIC_CACHE_COPY.failed), { detail: log.slice(-4000) }))
    })
  })
}

/** Seconds and channels of `file` (ffmpeg reads its header; no output). */
async function probe(ffmpeg: string, file: string, opts: LoopableOptions): Promise<{ seconds: number | null; channels: number }> {
  // ffmpeg asks for an output and exits with 1 after printing the input's details.
  const log = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], opts.signal, Math.min(opts.timeoutMs, PROBE_TIMEOUT_MS), [0, 1])
  return parseMusicProbe(log)
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Deletes the project's decoded copies other than `keep`, and decodes left unfinished. */
async function pruneCaches(dir: string, keep: string): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(names.filter((n) => n !== keep && (MUSIC_CACHE_RE.test(n) || PARTIAL_RE.test(n))).map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => undefined)))
}

/**
 * Renames the finished copy, trying again for a moment while another app holds it (on Windows an
 * antivirus scan, the indexer or OneDrive can open a file ffmpeg just closed; as importVideo's
 * renameCopy). A cancelled export stops trying.
 */
async function renameRetrying(from: string, to: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 150 * attempt))
      if (signal.aborted) throw new Error(MUSIC_CACHE_COPY.cancelled)
    }
  }
}

/** Seconds as ffmpeg reads them. */
const sec = (v: number): string => String(Math.max(0, +v.toFixed(6)))

/**
 * The path the export reads for the project's music file `file` (a music pick's name) when it
 * loops for `opts.seconds`: the file itself when it loops cleanly or never loops, else its decoded
 * copy in `.cache/` (made now when there is none).
 */
export async function loopableMusic(projectDir: string, file: string, ffmpeg: string, opts: LoopableOptions): Promise<string> {
  if (!MUSIC_FILE_RE.test(file)) throw new Error('Invalid export settings')
  const source = path.join(projectDir, file)
  if (await loopsCleanly(source)) return source
  if (opts.signal.aborted) throw new Error(MUSIC_CACHE_COPY.cancelled)
  const dir = path.join(projectDir, MUSIC_CACHE_DIR)
  const name = `${path.basename(file, path.extname(file))}.${await hashOf(source)}.flac`
  const target = path.join(dir, name)
  if (await fs.stat(target).then((s) => s.isFile(), () => false)) return target
  const info = await probe(ffmpeg, source, opts)
  // Music at least as long as the video never loops: it is read as it is.
  if (info.seconds !== null && info.seconds >= opts.seconds - 1e-3) return source
  await fs.mkdir(dir, { recursive: true })
  const length = Math.min(opts.seconds, info.seconds ?? opts.seconds)
  const need = Math.ceil(length * BYTES_PER_CHANNEL_SECOND * info.channels) + CACHE_SPARE_BYTES
  const free = await (opts.freeBytes ?? defaultFreeBytes)(dir)
  if (free !== null && free < need) throw new Error(MUSIC_CACHE_COPY.space(Math.max(1, Math.ceil((need - free) / 1e6))))
  const partial = path.join(dir, `${name}.partial`)
  try {
    await runFfmpeg(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', source, '-t', sec(opts.seconds), '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'flac', '-sample_fmt', 's16', '-f', 'flac', partial],
      opts.signal,
      opts.timeoutMs
    )
    // A copy that filled the whole export means the music never loops in it (its header's length
    // was missing or short): it is read as it is, and no copy cut short is kept for a longer export.
    const made = await probe(ffmpeg, partial, opts)
    if (made.seconds === null || made.seconds >= opts.seconds - 1e-3) {
      await fs.rm(partial, { force: true })
      return source
    }
    await renameRetrying(partial, target, opts.signal)
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => undefined)
    throw err
  }
  await pruneCaches(dir, name)
  return target
}
