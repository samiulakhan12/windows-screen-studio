/**
 * The text reader helper as main runs it (docs/design/auto-blur.md §5.5, §10.4, §10.6): ssw-ocr.exe
 * started with `shell: false`, no window and below-normal priority, one JSON command a line on its
 * stdin and one answer a line on its stdout (src/shared/privacy/protocol.ts). Every command takes
 * the next number of one counter and every answer is matched to its command by that number,
 * whatever order answers come in.
 *
 * - Every stdout line is parsed strictly (`parseHelperEvent`); a line that does not parse is
 *   counted (`refusedLines`) and dropped, a line over 16 MB kills the helper. Nothing the helper
 *   says is ever logged: not its stderr (drained and dropped), not a refused line, not a parse
 *   error's message (V8 quotes its input). An exit is logged as its code and kind only.
 * - The helper writes a heartbeat every 2 s from its start; 20 s without any line kills it.
 * - At most 3 reads are unreleased at once (each holds its lines' crops in the helper until
 *   `careful` or `release`); a fourth waits here, and `careful` is answered as its own event, so no
 *   read waiting for a slot can block the careful pass that frees one (§5.6).
 * - When the helper dies, every command in flight fails with `crashed`; nothing is sent again.
 *   Starting it again, and from which read, is the caller's (the scan's) choice.
 *
 * Test hook: SSW_OCR_HELPER (a file) replaces the helper only when the app is not packaged; a
 * .cjs fake runs under Node (tests/fixtures/fake-ocr-helper.cjs).
 */
import { app } from 'electron'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FindFailure } from '../../shared/api/privacy'
import { WINDOWS_READER_ALLOWED } from '../../shared/privacy/readerCatalog'
import { isToolbarVisible } from '../recording/toolbarWindow'
import {
  commandLine,
  MAX_LINE,
  OCR_PROTOCOL,
  parseHelperEvent,
  type Box,
  type Candidate,
  type HelperCommand,
  type HelperEvent,
  type LookFrame,
  type ModelPin,
  type ReadResult,
  type ReadVariant,
  type TrackMatch
} from '../../shared/privacy/protocol'

/** Timings and limits (§10.4). */
export const HELPER_LIMITS = {
  /** No line (not even a heartbeat) for this long: the helper is killed. */
  silenceMs: 20_000,
  /** Reads answered and not yet released or re-read carefully. */
  unreleased: 3,
  /** After `stop`, the helper is killed when it has not ended. */
  stopGraceMs: 2000
} as const

/** Why a command failed: the helper's own error kinds, and what main saw happen to the helper. */
export type HelperFailure = Extract<HelperEvent, { error: string }>['error'] | 'crashed' | 'silent' | 'protocol' | 'missing'

export class HelperError extends Error {
  constructor(readonly kind: HelperFailure) {
    super(`ssw-ocr: ${kind}`)
    this.name = 'HelperError'
  }
}

const isPackaged = (): boolean => {
  try {
    return !!app?.isPackaged
  } catch {
    return false
  }
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The helper of this build, or null when it is missing: packaged, process.resourcesPath/native/
 * ssw-ocr.exe; in development native/bin/ssw-ocr[.exe]. SSW_OCR_HELPER (a file) replaces it only
 * when the app is not packaged.
 */
export function helperPath(): string | null {
  if (isPackaged()) {
    const exe = path.join(process.resourcesPath, 'native', 'ssw-ocr.exe')
    return isFile(exe) ? exe : null
  }
  const override = process.env.SSW_OCR_HELPER
  if (override) return isFile(override) ? override : null
  const dev = path.join(app.getAppPath(), 'native', 'bin', process.platform === 'win32' ? 'ssw-ocr.exe' : 'ssw-ocr')
  return isFile(dev) ? dev : null
}

/** The environment the helper gets: what the C runtime needs, nothing else (no keys, no proxies). */
export function helperEnv(platform: NodeJS.Platform = process.platform, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = platform === 'win32' ? ['SystemRoot', 'TEMP', 'TMP', 'PATH'] : ['PATH', 'LANG']
  const env: Record<string, string> = {}
  for (const k of keep) {
    const v = from[k] ?? (platform === 'win32' ? from[k.toUpperCase()] : undefined)
    if (v !== undefined) env[k] = v
  }
  return env
}

/** How `helper` is started: `--low-priority`, as a list; a .js/.cjs fake (tests, never packaged) runs under Node with the SSW_OCR_* variables that steer it. */
export function helperCommand(helper: string, packaged = isPackaged()): { file: string; args: string[]; env: Record<string, string> } {
  const args = ['--low-priority']
  const env = helperEnv()
  if (!packaged && /\.(c|m)?js$/i.test(helper)) {
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('SSW_OCR_') && k !== 'SSW_OCR_HELPER' && v !== undefined) env[k] = v
    return { file: process.execPath, args: [helper, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { file: helper, args, env }
}

export interface HelperDeps {
  /** The helper to run (helperPath() when absent). */
  path?: string | null
  spawn?: typeof nodeSpawn
  /** Sets a process's priority (os.setPriority when absent). */
  setPriority?: (pid: number, priority: number) => void
  silenceMs?: number
  /** Called with each line main writes about the helper: its exit code and kind, counts. Never its output. */
  log?: (line: string) => void
  /** Also open the reader: `start` then refuses a helper of another protocol (test 94). */
  open?: { pins: ModelPin[]; ffmpeg: string; reader?: 'paddle' | 'windows' }
}

export interface FollowSession {
  readonly id: number
  track(track: number, t: number, parts: readonly Box[]): Promise<void>
  match(t: number, tracks: readonly { track: number; parts: readonly number[]; candidates: readonly Candidate[] }[]): Promise<TrackMatch[]>
  close(): Promise<void>
}

type Waiter = { resolve(e: HelperEvent): void; reject(err: HelperError): void; onLook?: (f: LookFrame[]) => void }

type Bare<O extends HelperCommand['op']> = Omit<Extract<HelperCommand, { op: O }>, 'op' | 'id'>

export class OcrHelper {
  private nextId = 0
  private readonly waiters = new Map<number, Waiter>()
  /** Reads answered whose crops the helper still holds. */
  private readonly unreleased = new Set<number>()
  /** Reads waiting here for a slot, in order. */
  private readonly queued: { id: number; send(): void; drop(err: HelperError): void }[] = []
  private buffer: Buffer[] = []
  private pending = 0
  private refused = 0
  private silenceTimer: NodeJS.Timeout | null = null
  private gone = false
  private exitCode: number | null = null
  readonly exited: Promise<number | null>

  private constructor(
    private readonly child: ChildProcess,
    private readonly silenceMs: number,
    private readonly log: (line: string) => void
  ) {
    this.exited = new Promise((resolve) => {
      const done = (code: number | null): void => {
        if (this.gone) return
        this.gone = true
        this.exitCode = code
        if (this.silenceTimer) clearTimeout(this.silenceTimer)
        this.log(`privacy: text reader ended (code ${code === null ? 'none' : code})`)
        if (this.refused) this.log(`privacy: ${this.refused} text reader lines refused`)
        this.failAll(new HelperError('crashed'))
        resolve(code)
      }
      child.on('exit', (code) => done(code))
      child.on('error', () => done(null))
    })
    child.stdin?.on('error', () => undefined)
    // Drained and dropped: nothing the helper says reaches a log.
    child.stderr?.on('data', () => undefined)
    child.stdout?.on('data', (d: Buffer) => this.onData(d))
    this.armSilence()
  }

  /** Starts the helper (and opens the reader when `deps.open` is given). */
  static async start(deps: HelperDeps = {}): Promise<OcrHelper> {
    const file = deps.path === undefined ? helperPath() : deps.path
    if (!file) throw new HelperError('missing')
    const cmd = helperCommand(file)
    const spawn = deps.spawn ?? nodeSpawn
    let child: ChildProcess
    try {
      child = spawn(cmd.file, cmd.args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: cmd.env })
    } catch {
      throw new HelperError('missing')
    }
    const setPriority = deps.setPriority ?? ((pid: number, p: number) => os.setPriority(pid, p))
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        // The helper lowers its own priority too (--low-priority).
      }
    }
    const helper = new OcrHelper(child, deps.silenceMs ?? HELPER_LIMITS.silenceMs, deps.log ?? (() => undefined))
    if (deps.open) {
      try {
        await helper.open(deps.open.pins, deps.open.ffmpeg, deps.open.reader)
      } catch (err) {
        helper.kill()
        throw err
      }
    }
    return helper
  }

  /** Lines the helper wrote that were not one of the protocol's events. */
  get refusedLines(): number {
    return this.refused
  }

  /** The helper's process id (tests and the job's bookkeeping). */
  get pid(): number | undefined {
    return this.child.pid
  }

  private armSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    if (this.gone) return
    this.silenceTimer = setTimeout(() => {
      this.log('privacy: text reader silent for 20 s, ended')
      this.failAll(new HelperError('silent'))
      this.kill()
    }, this.silenceMs)
  }

  private onData(chunk: Buffer): void {
    if (this.gone) return
    this.armSilence()
    let start = 0
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, i)
      start = i + 1
      if (this.pending + piece.length > MAX_LINE) return this.tooLong()
      this.buffer.push(piece)
      const line = Buffer.concat(this.buffer).toString('utf8').replace(/\r$/, '')
      this.buffer = []
      this.pending = 0
      if (line.trim()) this.onLine(line)
      if (this.gone) return
    }
    const rest = chunk.subarray(start)
    if (this.pending + rest.length > MAX_LINE) return this.tooLong()
    if (rest.length) {
      this.buffer.push(Buffer.from(rest))
      this.pending += rest.length
    }
  }

  private tooLong(): void {
    this.refused++
    this.buffer = []
    this.pending = 0
    this.log('privacy: text reader wrote a line over 16 MB, ended')
    this.failAll(new HelperError('crashed'))
    this.kill()
  }

  private onLine(line: string): void {
    const e = parseHelperEvent(line)
    if (!e) {
      this.refused++
      return
    }
    if ('alive' in e) return
    const w = this.waiters.get(e.id)
    if (!w) return
    if ('look' in e) {
      w.onLook?.(e.look)
      if (!e.done) return
    }
    this.waiters.delete(e.id)
    if ('error' in e) w.reject(new HelperError(e.error))
    else w.resolve(e)
  }

  private failAll(err: HelperError): void {
    for (const [id, w] of [...this.waiters]) {
      this.waiters.delete(id)
      w.reject(err)
    }
    for (const q of this.queued.splice(0)) q.drop(err)
    this.unreleased.clear()
  }

  private write(c: HelperCommand): void {
    const stdin = this.child.stdin
    if (this.gone || !stdin || stdin.destroyed || stdin.writableEnded) return
    stdin.write(`${commandLine(c)}\n`)
  }

  private id(): number {
    return ++this.nextId
  }

  /** Sends `c` and waits for its answer. */
  private ask(c: HelperCommand, onLook?: (f: LookFrame[]) => void): Promise<HelperEvent> {
    if (this.gone) return Promise.reject(new HelperError('crashed'))
    return new Promise((resolve, reject) => {
      this.waiters.set(c.id, { resolve, reject, onLook })
      this.write(c)
    })
  }

  /** Opens the reader: the pins (checked by main first), ffmpeg's path, and which reader. */
  async open(pins: ModelPin[], ffmpeg: string, reader: 'paddle' | 'windows' = 'paddle'): Promise<void> {
    // The Windows reader stays closed until it passes decision 8's check (§5.13).
    if (reader === 'windows' && !WINDOWS_READER_ALLOWED) throw new HelperError('bad-command')
    const e = await this.ask({ op: 'open', id: this.id(), protocol: OCR_PROTOCOL, reader, models: pins, ffmpeg })
    if (!('opened' in e) || e.opened.protocol !== OCR_PROTOCOL) {
      this.log('privacy: text reader of another protocol, ended')
      this.kill()
      throw new HelperError('protocol')
    }
  }

  /** The look pass over [from, to]; `onFrames` gets each batch. */
  async look(req: Bare<'look'>, onFrames: (f: LookFrame[]) => void, signal: AbortSignal): Promise<void> {
    const id = this.id()
    const onAbort = (): void => this.cancel(id)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ask({ op: 'look', id, ...req }, onFrames)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** One read; waits here while 3 reads are unreleased. Its crops stay in the helper until `careful` or `release`. */
  read(req: Bare<'read'>, signal: AbortSignal): Promise<{ id: number; result: ReadResult }> {
    const id = this.id()
    if (this.gone) return Promise.reject(new HelperError('crashed'))
    return new Promise((resolve, reject) => {
      let sent = false
      const onAbort = (): void => this.cancel(id)
      signal.addEventListener('abort', onAbort, { once: true })
      const finish = (): void => signal.removeEventListener('abort', onAbort)
      const send = (): void => {
        sent = true
        this.unreleased.add(id)
        this.ask({ op: 'read', id, ...req }).then(
          (e) => {
            finish()
            if ('read' in e) resolve({ id, result: e.read })
            else {
              this.free(id)
              reject(new HelperError('bad-command'))
            }
          },
          (err: HelperError) => {
            finish()
            // A failed read holds no crops.
            this.free(id)
            reject(err)
          }
        )
      }
      const drop = (err: HelperError): void => {
        finish()
        reject(err)
      }
      if (signal.aborted) return drop(new HelperError('cancelled'))
      if (this.unreleased.size < HELPER_LIMITS.unreleased) send()
      else this.queued.push({ id, send, drop })
      void sent
    })
  }

  /** Frees read `id`'s slot and sends the next waiting read. */
  private free(id: number): void {
    this.unreleased.delete(id)
    while (this.unreleased.size < HELPER_LIMITS.unreleased && this.queued.length) this.queued.shift()!.send()
  }

  /** The careful pass on `lines` of read `readId` (the small recogniser), ahead of any queued read; frees the read's crops. */
  async careful(readId: number, lines: readonly number[]): Promise<ReadVariant[][]> {
    try {
      const e = await this.ask({ op: 'careful', id: this.id(), read: readId, lines: [...lines] })
      return 'careful' in e ? e.careful : []
    } finally {
      this.free(readId)
    }
  }

  /** Frees read `readId`'s crops (no line of it is read again). */
  release(readId: number): void {
    this.write({ op: 'release', id: this.id(), read: readId })
    this.free(readId)
  }

  /** Opens a follow session over [from, to] walked in direction `dir`. */
  async followOpen(req: Bare<'followOpen'>, signal: AbortSignal): Promise<FollowSession> {
    const id = this.id()
    const onAbort = (): void => this.cancel(id)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ask({ op: 'followOpen', id, ...req })
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    return {
      id,
      track: async (track, t, parts) => {
        await this.ask({ op: 'track', id: this.id(), session: id, track, t, parts: parts.map((p) => [p[0], p[1], p[2], p[3]] as Box) })
      },
      match: async (t, tracks) => {
        const e = await this.ask({ op: 'match', id: this.id(), session: id, t, tracks: tracks.map((x) => ({ track: x.track, parts: [...x.parts], candidates: x.candidates.map((c) => ({ ...c })) })) })
        return 'matched' in e ? e.matched : []
      },
      close: async () => {
        await this.ask({ op: 'closeSession', id: this.id(), session: id }).catch(() => undefined)
      }
    }
  }

  /** Cancels command `id`: a read still waiting here is dropped and never sent; otherwise the helper stops it. */
  cancel(id: number): void {
    const i = this.queued.findIndex((q) => q.id === id)
    if (i >= 0) {
      this.queued.splice(i, 1)[0].drop(new HelperError('cancelled'))
      return
    }
    if (this.waiters.has(id)) this.write({ op: 'cancel', id: this.id(), target: id })
  }

  /** While Flown records (§5.11): the helper stops at its next tile or frame. */
  pause(): void {
    this.write({ op: 'pause', id: this.id() })
  }

  resume(): void {
    this.write({ op: 'resume', id: this.id() })
  }

  /** Asks the helper to end, and kills it when it has not within the grace. */
  async stop(): Promise<void> {
    if (this.gone) return
    this.write({ op: 'stop', id: this.id() })
    const timer = setTimeout(() => this.kill(), HELPER_LIMITS.stopGraceMs)
    await this.exited
    clearTimeout(timer)
  }

  kill(): void {
    try {
      this.child.stdin?.end()
    } catch {
      // Already closed.
    }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }

  /** The exit code once the helper has ended (null while it runs or when it was killed). */
  get code(): number | null {
    return this.exitCode
  }
}

/** Polls whether Flown records (every 2 s) and pauses the helper while it does (§5.11): `onWaiting` gets true and false as it turns. Returns the stop. */
export function pauseWhileRecording(helper: Pick<OcrHelper, 'pause' | 'resume'>, recording: () => boolean, onWaiting: (waiting: boolean) => void, everyMs = 2000): () => void {
  let paused = false
  const check = (): void => {
    let now = false
    try {
      now = recording()
    } catch {
      now = false
    }
    if (now === paused) return
    paused = now
    if (now) helper.pause()
    else helper.resume()
    onWaiting(now)
  }
  check()
  const timer = setInterval(check, everyMs)
  return () => {
    clearInterval(timer)
    if (paused) {
      paused = false
      helper.resume()
      onWaiting(false)
    }
  }
}

/** Whether Flown records now: its recording toolbar is up (read, as updatesIpc's busyReason reads it). */
export function flownRecording(): boolean {
  return isToolbarVisible()
}

/**
 * What ends a Find, from what the helper did (§2.6): `tooLarge`, the files refused (`reader`, the
 * state then `damaged`), no helper that runs here (`helper`), a recording ffmpeg cannot read
 * (`video`), the helper ending or going silent (`crashed`: the scan starts it once more, and only a
 * second death ends Find), anything else `failed`.
 */
export function findFailureOf(err: unknown): FindFailure {
  if (!(err instanceof HelperError)) return 'failed'
  switch (err.kind) {
    case 'tooLarge':
      return 'tooLarge'
    case 'model':
      return 'reader'
    case 'missing':
    case 'protocol':
      return 'helper'
    case 'video':
      return 'video'
    case 'crashed':
    case 'silent':
      return 'crashed'
    default:
      return 'failed'
  }
}
