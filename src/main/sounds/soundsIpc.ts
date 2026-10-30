/**
 * The unwanted-sound finder's main-process side (docs/design/sound-finder.md §4.7, §7): ffmpeg
 * decodes a project's source to 16 kHz mono float samples, which the window that asked pulls chunk
 * by chunk (ffmpeg's output is paused while two chunks wait, so memory stays small whatever the
 * length), and the scores the editor made are kept in the project's .cache/sounds.json. Only the
 * app's own page may call; a stream belongs to the window that opened it.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { SOUNDS_CHANNELS, SOUNDS_STOPPED, SOUND_CHUNK_BYTES, type SoundStreamInfo } from '../../shared/api/sounds'
import { SOURCE_FILES, type AudioSource } from '../../shared/audio/settings'
import { readCacheEntry, SOUNDS_CACHE_FILE, SOUNDS_CACHE_MAX, type SoundCacheEntry } from '../../shared/audio/soundsCache'
import { writeFileAtomicSync } from '../atomicWrite'
import { ffmpegPath } from '../ffmpeg'
import { ProjectProcesses } from '../projectProcesses'
import { projectDir } from '../projects'
import { isAppUrl } from '../security'

/** Most streams a window may have open at once (one per source, with room for a retry). */
export const MAX_STREAMS = 4
/** A stream nobody read for this long is closed (its window stopped asking). */
export const IDLE_MS = 60_000
/** Chunks decoded ahead of the reader before ffmpeg is paused. */
const AHEAD = 2

const SOURCES: readonly AudioSource[] = ['mix', 'mic', 'system']

/** ffmpeg arguments decoding `file`'s first audio stream to 16 kHz mono float samples on stdout. */
export function soundDecodeArgs(file: string): string[] {
  return ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

interface Stream {
  id: number
  owner: number
  projectId: string
  proc: ChildProcess
  chunks: Buffer[]
  buffered: number
  ended: boolean
  error: string | null
  waiting: { resolve: (v: ArrayBuffer | null) => void; reject: (e: Error) => void } | null
  idle: ReturnType<typeof setTimeout> | null
  log: string
}

export interface SoundStreamsDeps {
  projectDir: (id: string) => string
  ffmpeg: () => string
  spawn?: typeof nodeSpawn
  idleMs?: number
}

/** The open streams and the cache file, behind the IPC handlers (tested with a fake ffmpeg). */
export class SoundStreams {
  private readonly streams = new Map<number, Stream>()
  private readonly processes = new ProjectProcesses()
  private readonly writes = new Map<string, Promise<void>>()
  private nextId = 1

  constructor(private readonly deps: SoundStreamsDeps) {}

  /** The project folder and source file named by untrusted arguments; throws a sentence when they are not valid. */
  private fileOf(projectId: unknown, source: unknown): { dir: string; file: string } {
    if (typeof projectId !== 'string' || typeof source !== 'string' || !(SOURCES as string[]).includes(source)) throw new Error('Invalid request')
    const dir = this.deps.projectDir(projectId)
    return { dir, file: path.join(dir, SOURCE_FILES[source as AudioSource]) }
  }

  /** Streams open for window `owner`. */
  openCount(owner: number): number {
    return [...this.streams.values()].filter((s) => s.owner === owner).length
  }

  async open(owner: number, projectId: unknown, source: unknown): Promise<SoundStreamInfo> {
    const { file } = this.fileOf(projectId, source)
    if (this.openCount(owner) >= MAX_STREAMS) throw new Error('Too many sounds are being read at once')
    const generation = this.processes.generation(projectId as string)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) throw new Error(`The recording's ${source === 'mic' ? 'microphone' : source === 'system' ? 'system sound' : 'sound'} file is missing`)
    // Stopped meanwhile (the editor closed): nothing new starts.
    if (this.processes.generation(projectId as string) !== generation) throw new Error(SOUNDS_STOPPED)
    const proc = (this.deps.spawn ?? nodeSpawn)(this.deps.ffmpeg(), soundDecodeArgs(file), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const s: Stream = { id: this.nextId++, owner, projectId: projectId as string, proc, chunks: [], buffered: 0, ended: false, error: null, waiting: null, idle: null, log: '' }
    this.processes.add(proc, s.projectId)
    this.streams.set(s.id, s)
    proc.stdout?.on('data', (d: Buffer) => {
      s.chunks.push(d)
      s.buffered += d.length
      if (s.buffered >= AHEAD * SOUND_CHUNK_BYTES) proc.stdout?.pause()
      this.serve(s)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      s.log = (s.log + d.toString()).slice(-2000)
    })
    proc.on('error', (err) => {
      s.error ??= `ffmpeg could not be started (${err.message})`
      this.serve(s)
    })
    proc.on('close', (code, signal) => {
      this.processes.delete(proc)
      if (code === 0) s.ended = true
      else if (this.processes.generation(s.projectId) !== generation || signal) s.error ??= SOUNDS_STOPPED
      else s.error ??= `Could not read the recording's sound (${s.log.trim().split('\n').pop() || `exit code ${code}`})`
      this.serve(s)
    })
    this.touch(s)
    return { stream: s.id, size: stat.size, mtimeMs: stat.mtimeMs }
  }

  /** The next chunk (whole samples), null at the end; rejects on a failure, a stop, or a stream of another window. */
  read(owner: number, stream: unknown): Promise<ArrayBuffer | null> {
    const s = typeof stream === 'number' ? this.streams.get(stream) : undefined
    if (!s || s.owner !== owner) return Promise.reject(new Error('No such sound stream'))
    if (s.waiting) return Promise.reject(new Error('A read of this sound stream is already waiting'))
    this.touch(s)
    return new Promise((resolve, reject) => {
      s.waiting = { resolve, reject }
      this.serve(s)
    })
  }

  /** Hands the waiting read what there is to hand: a full chunk, the rest at the end, or the error. */
  private serve(s: Stream): void {
    const w = s.waiting
    if (!w) return
    const done = s.ended || s.error !== null
    if (s.buffered < SOUND_CHUNK_BYTES && !done) return
    if (s.error !== null && s.buffered < SOUND_CHUNK_BYTES) {
      // What was decoded before a failure is not used: the scan fails as a whole.
      s.waiting = null
      w.reject(new Error(s.error))
      this.drop(s)
      return
    }
    const all = s.chunks.length === 1 ? s.chunks[0] : Buffer.concat(s.chunks)
    // Whole samples only; the bytes of a split sample wait for the next chunk.
    const take = Math.min(SOUND_CHUNK_BYTES, all.length - (all.length % 4))
    const out = new ArrayBuffer(take)
    new Uint8Array(out).set(all.subarray(0, take))
    const rest = all.subarray(take)
    s.chunks = rest.length > 0 ? [Buffer.from(rest)] : []
    s.buffered = rest.length
    s.waiting = null
    if (s.buffered < AHEAD * SOUND_CHUNK_BYTES) s.proc.stdout?.resume()
    if (take === 0 && s.ended) {
      w.resolve(null)
      this.drop(s)
      return
    }
    w.resolve(out)
  }

  private touch(s: Stream): void {
    if (s.idle) clearTimeout(s.idle)
    s.idle = setTimeout(() => this.drop(s, 'The sound stream was idle'), this.deps.idleMs ?? IDLE_MS)
    s.idle.unref?.()
  }

  /** Forgets a stream and stops its ffmpeg. */
  private drop(s: Stream, why = SOUNDS_STOPPED): void {
    if (!this.streams.has(s.id)) return
    this.streams.delete(s.id)
    if (s.idle) clearTimeout(s.idle)
    if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill('SIGKILL')
    const w = s.waiting
    s.waiting = null
    w?.reject(new Error(why))
  }

  close(owner: number, stream: unknown): void {
    const s = typeof stream === 'number' ? this.streams.get(stream) : undefined
    if (s && s.owner === owner) this.drop(s)
  }

  /** Closes every stream of window `owner` (it went away). */
  closeOwner(owner: number): void {
    for (const s of [...this.streams.values()]) if (s.owner === owner) this.drop(s)
  }

  /** Stops project `id`'s decoding (the editor closed, or the project is about to be deleted); resolves once ffmpeg let go of its files. */
  async stop(id: string): Promise<void> {
    await this.processes.stop(id)
    for (const s of [...this.streams.values()]) if (s.projectId === id) this.drop(s)
  }

  stopAll(): void {
    this.processes.stopAll()
    for (const s of [...this.streams.values()]) this.drop(s)
  }

  /* ---------- the cache ---------- */

  private async readCache(dir: string): Promise<Record<string, unknown>> {
    const file = path.join(dir, '.cache', SOUNDS_CACHE_FILE)
    const st = await fs.stat(file).catch(() => null)
    if (!st?.isFile() || st.size > SOUNDS_CACHE_MAX) return {}
    try {
      const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      return isObject(raw) && raw.version === 1 && isObject(raw.entries) ? raw.entries : {}
    } catch {
      return {}
    }
  }

  /** The stored entry of `source`, when it is well formed and the file still has its size and time. */
  async cached(projectId: unknown, source: unknown): Promise<SoundCacheEntry | null> {
    const { dir, file } = this.fileOf(projectId, source)
    const entry = readCacheEntry((await this.readCache(dir))[source as string])
    if (!entry) return null
    const st = await fs.stat(file).catch(() => null)
    return st?.isFile() && st.size === entry.size && st.mtimeMs === entry.mtimeMs ? entry : null
  }

  /** Stores `entry` for `source`: refused when malformed, when the file changed since, or when the file would grow too large. */
  async save(projectId: unknown, source: unknown, raw: unknown): Promise<void> {
    const { dir, file } = this.fileOf(projectId, source)
    const id = projectId as string
    // Work that started before a stop writes nothing (a folder being deleted gets no .cache).
    const generation = this.processes.generation(id)
    const entry = readCacheEntry(raw)
    if (!entry) throw new Error('Invalid sound scores')
    const st = await fs.stat(file).catch(() => null)
    if (!st?.isFile() || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) throw new Error('The recording changed while it was listened to')
    const prev = this.writes.get(id) ?? Promise.resolve()
    const next = prev.then(async () => {
      if (this.processes.generation(id) !== generation) return
      const entries = { ...(await this.readCache(dir)), [source as string]: entry }
      const text = JSON.stringify({ version: 1, entries })
      if (Buffer.byteLength(text) > SOUNDS_CACHE_MAX) throw new Error('The sound scores are too large to keep')
      await fs.mkdir(path.join(dir, '.cache'), { recursive: true })
      writeFileAtomicSync(path.join(dir, '.cache', SOUNDS_CACHE_FILE), text)
    })
    const settled = next.catch(() => undefined)
    this.writes.set(id, settled)
    void settled.then(() => {
      if (this.writes.get(id) === settled) this.writes.delete(id)
    })
    return next
  }
}

export const soundStreams = new SoundStreams({ projectDir, ffmpeg: ffmpegPath })

/** Stops project `id`'s listening (analysisIpc's stopAnalyses: the editor closed, or before a delete). */
export const stopSoundScans = (id: string): Promise<void> => soundStreams.stop(id).catch(() => undefined)

export function registerSoundsIpc(): void {
  const watched = new Set<number>()
  // Only the app's own page; each window's streams close with it.
  const fromApp = (e: IpcMainInvokeEvent): WebContents => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    const wc = e.sender
    if (!watched.has(wc.id)) {
      watched.add(wc.id)
      const id = wc.id
      wc.once('destroyed', () => {
        watched.delete(id)
        soundStreams.closeOwner(id)
      })
    }
    return wc
  }
  ipcMain.handle(SOUNDS_CHANNELS.cached, (e, id: unknown, source: unknown) => {
    fromApp(e)
    return soundStreams.cached(id, source)
  })
  ipcMain.handle(SOUNDS_CHANNELS.open, (e, id: unknown, source: unknown) => soundStreams.open(fromApp(e).id, id, source))
  ipcMain.handle(SOUNDS_CHANNELS.read, (e, stream: unknown) => soundStreams.read(fromApp(e).id, stream))
  ipcMain.handle(SOUNDS_CHANNELS.close, (e, stream: unknown) => soundStreams.close(fromApp(e).id, stream))
  ipcMain.handle(SOUNDS_CHANNELS.save, (e, id: unknown, source: unknown, entry: unknown) => {
    fromApp(e)
    return soundStreams.save(id, source, entry)
  })
  app.on('will-quit', () => soundStreams.stopAll())
}
