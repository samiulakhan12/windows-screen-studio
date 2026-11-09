/**
 * The bundled helper ssw-llm.exe, one request at a time (docs/design/smart-tools.md §9.2): one
 * process at most, started on the first request with the speech helper's arguments (below-normal
 * priority, the app's pid watched), as a list, never through a shell, with a minimal environment
 * and `dir` (userData/text-models) as its working folder. Requests wait in order; Stop sends
 * `cancel` and kills the helper when no `cancelled` comes within the grace; no line for 120 s kills
 * it (reset when the PC resumes from sleep); a crash fails the request and the next one starts a
 * new process; after 120 s without a request the helper exits and gives its memory back. Every
 * stdout line is read strictly (readHelperLine): a line over 4 MB or one that does not parse ends
 * the job.
 *
 * Test hook (§22 test 104): SSW_LLM_HELPER is read only when the app is not packaged.
 */
import { app } from 'electron'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalAiProgress } from '../../shared/api/localAi'
import { LOCAL_CTX } from '../../shared/localAi/budget'
import { llmThreads, type LocalModelSpec } from '../../shared/localAi/catalog'
import type { ChatPart } from '../../shared/localAi/chatFormat'
import { LOCAL_MESSAGES } from '../../shared/localAi/messages'
import { cancelLine, LLM_PROTOCOL, loadLine, readHelperLine, runLine, type HelperEvent } from '../../shared/localAi/protocol'

/** Timings (§9.2), ms. */
export const LLM_TIMING = {
  /** No request for this long: the helper exits. */
  idleMs: 120_000,
  /** After `cancel`, the helper is killed when no `cancelled` came (the speech helper's cancelGraceMs). */
  graceMs: 2000,
  /** No stdout line for this long while a request runs: the helper is killed (the speech helper's stallMs). */
  stallMs: 120_000
} as const

/** Why a request failed, in §9.9's words; `code` for the caller (Stop is 'stopped'). */
export class LocalAiError extends Error {
  constructor(
    readonly code: 'stopped' | 'crashed' | 'stalled' | 'context' | 'model' | 'memory' | 'internal',
    message: string
  ) {
    super(message)
    this.name = 'LocalAiError'
  }
}

export interface LlmAnswer {
  text: string
  prompt: number
  output: number
  readMs: number
  writeMs: number
}

const STDERR_KEEP = 4096

interface Request {
  id: string
  spec: LocalModelSpec
  parts: readonly ChatPart[]
  grammar: string
  maxTokens: number
  signal: AbortSignal
  onProgress(p: LocalAiProgress): void
  resolve(r: LlmAnswer): void
  reject(e: Error): void
  onAbort?: () => void
}

/** The running helper. */
interface Helper {
  child: ChildProcess
  model: string
  loaded: boolean
  buffer: Buffer[]
  pending: number
  stderr: string
  exited: boolean
}

const isPackaged = (): boolean => {
  try {
    return !!app?.isPackaged
  } catch {
    return false
  }
}

/** The environment the helper gets: what the C runtime needs, nothing else (no keys, no proxies). */
export function llmEnv(platform: NodeJS.Platform = process.platform, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = platform === 'win32' ? ['SystemRoot', 'TEMP', 'TMP', 'PATH'] : ['PATH', 'LANG']
  const env: Record<string, string> = {}
  for (const k of keep) {
    const v = from[k] ?? (platform === 'win32' ? from[k.toUpperCase()] : undefined)
    if (v !== undefined) env[k] = v
  }
  return env
}

/**
 * How `helper` is started: the program with the speech helper's common arguments first (§9.1:
 * `--low-priority --parent-pid <pid>`), as a list; a .js/.cjs fake (tests, never in a packaged app)
 * runs under Node with the FAKE_LLM_* variables that steer it.
 */
export function llmCommand(helper: string, packaged = isPackaged()): { file: string; args: string[]; env: Record<string, string> } {
  const args = ['--low-priority', '--parent-pid', String(process.pid)]
  const env = llmEnv()
  if (!packaged && /\.(c|m)?js$/i.test(helper)) {
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('FAKE_LLM_') && v !== undefined) env[k] = v
    return { file: process.execPath, args: [helper, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { file: helper, args, env }
}

export class LlmEngine {
  private readonly helper: string
  private readonly dir: string
  private readonly spawnFn: typeof nodeSpawn
  private readonly idleMs: number
  private readonly graceMs: number
  private readonly stallMs: number
  private proc: Helper | null = null
  private readonly queue: Request[] = []
  private current: Request | null = null
  private counter = 0
  private idleTimer: NodeJS.Timeout | null = null
  private stallTimer: NodeJS.Timeout | null = null
  private graceTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(opts: { helper: string; dir: string; spawn?: typeof nodeSpawn; idleMs?: number; graceMs?: number; stallMs?: number }) {
    this.helper = opts.helper
    this.dir = opts.dir
    this.spawnFn = opts.spawn ?? nodeSpawn
    this.idleMs = opts.idleMs ?? LLM_TIMING.idleMs
    this.graceMs = opts.graceMs ?? LLM_TIMING.graceMs
    this.stallMs = opts.stallMs ?? LLM_TIMING.stallMs
  }

  /** Whether a request runs or waits. */
  get busy(): boolean {
    return !!this.current || this.queue.length > 0
  }

  /** The model file the running helper has (or is loading), or null. */
  get loadedModel(): string | null {
    return this.proc && !this.proc.exited ? this.proc.model : null
  }

  /** Whether the helper has said `loaded` for loadedModel (until then most of its memory is not taken yet). */
  get loadFinished(): boolean {
    return !!this.proc && !this.proc.exited && this.proc.loaded
  }

  /**
   * Runs one request: its turn in the queue ("waiting"), the model loaded when it is not
   * ("loading"), the prompt read ("reading") and the answer written ("writing"). Rejects with a
   * LocalAiError (Stop: 'stopped', "Stopped.").
   */
  run(req: {
    spec: LocalModelSpec
    parts: readonly ChatPart[]
    grammar: string
    maxTokens: number
    signal: AbortSignal
    onProgress(p: LocalAiProgress): void
  }): Promise<LlmAnswer> {
    if (this.disposed) return Promise.reject(new LocalAiError('stopped', LOCAL_MESSAGES.stopped))
    if (req.signal.aborted) return Promise.reject(new LocalAiError('stopped', LOCAL_MESSAGES.stopped))
    return new Promise<LlmAnswer>((resolve, reject) => {
      const r: Request = { spec: req.spec, parts: req.parts, grammar: req.grammar, maxTokens: req.maxTokens, signal: req.signal, onProgress: req.onProgress, id: `r${++this.counter}`, resolve, reject }
      r.onAbort = () => this.abort(r)
      req.signal.addEventListener('abort', r.onAbort, { once: true })
      this.queue.push(r)
      this.clearIdle()
      if (this.current) req.onProgress({ phase: 'waiting', done: 0, total: 0 })
      this.pump()
    })
  }

  /** The PC woke from sleep: the time it slept never makes a running request look frozen. */
  resetWatchdogs(): void {
    if (this.current) this.armStall()
  }

  /** Stops the helper (Remove, the last editor closed): a running request ends as Stop does; waiting ones start a new helper. */
  async unload(): Promise<void> {
    this.clearIdle()
    const proc = this.proc
    if (!proc || proc.exited) return
    if (this.current) this.finish(this.current, new LocalAiError('stopped', LOCAL_MESSAGES.stopped), false)
    await this.stopProcess(proc)
    this.pump()
  }

  /** Stops everything for good (the app quits). */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const r of this.queue.splice(0)) this.finish(r, new LocalAiError('stopped', LOCAL_MESSAGES.stopped), false)
    if (this.current) this.finish(this.current, new LocalAiError('stopped', LOCAL_MESSAGES.stopped), false)
    this.clearIdle()
    if (this.proc) await this.stopProcess(this.proc)
  }

  // ------------------------------------------------------------------------------- internals

  private modelPath(spec: LocalModelSpec): string {
    return path.join(this.dir, spec.file)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private armIdle(): void {
    this.clearIdle()
    const proc = this.proc
    if (!proc || proc.exited || this.busy) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.busy && this.proc === proc) void this.stopProcess(proc)
    }, this.idleMs)
  }

  /** The watchdog: reset by every line while a request runs. */
  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = null
    const r = this.current
    if (!r) return
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      if (this.current !== r) return
      const proc = this.proc
      this.finish(r, new LocalAiError('stalled', LOCAL_MESSAGES.stalled))
      if (proc) this.kill(proc)
    }, this.stallMs)
  }

  /** Ends `r` once: its promise settles and (unless `next` is false) the next request starts. */
  private finish(r: Request, outcome: Error | LlmAnswer, next = true): void {
    if (r.onAbort) r.signal.removeEventListener('abort', r.onAbort)
    r.onAbort = undefined
    const i = this.queue.indexOf(r)
    if (i >= 0) this.queue.splice(i, 1)
    if (this.current === r) {
      this.current = null
      if (this.stallTimer) clearTimeout(this.stallTimer)
      if (this.graceTimer) clearTimeout(this.graceTimer)
      this.stallTimer = null
      this.graceTimer = null
    }
    if (outcome instanceof Error) r.reject(outcome)
    else r.resolve(outcome)
    if (next) queueMicrotask(() => this.pump())
  }

  /** Stop for `r`: a waiting request ends at once; the running one gets `cancel`, then a kill after the grace. */
  private abort(r: Request): void {
    if (this.current !== r) {
      this.finish(r, new LocalAiError('stopped', LOCAL_MESSAGES.stopped))
      return
    }
    const proc = this.proc
    if (!proc || proc.exited || !proc.loaded) {
      // Loading cannot be stopped by a line: the helper goes, and the model loads again next time.
      this.finish(r, new LocalAiError('stopped', LOCAL_MESSAGES.stopped))
      if (proc) this.kill(proc)
      return
    }
    this.write(proc, cancelLine(r.id))
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      if (this.current !== r) return
      this.finish(r, new LocalAiError('stopped', LOCAL_MESSAGES.stopped))
      this.kill(proc)
    }, this.graceMs)
  }

  private pump(): void {
    if (this.current || this.disposed) return
    const r = this.queue.shift()
    if (!r) {
      this.armIdle()
      return
    }
    this.current = r
    this.clearIdle()
    const model = this.modelPath(r.spec)
    let proc = this.proc
    if (proc && !proc.exited && proc.model !== model) {
      // Another model: this helper goes (one model a process).
      this.kill(proc)
      this.proc = null
      proc = null
    }
    if (!proc || proc.exited) {
      try {
        proc = this.start(model)
      } catch (err) {
        this.finish(r, new LocalAiError('crashed', `${LOCAL_MESSAGES.crashed} (${err instanceof Error ? err.message : String(err)})`))
        return
      }
    }
    this.armStall()
    if (proc.loaded) this.send(proc, r)
    else r.onProgress({ phase: 'loading', done: 0, total: 0, secondsLeft: Math.ceil(r.spec.loadS + this.estimate(r, 0, null)) })
  }

  /** Seconds the rest of `r` takes: the prompt still to read and the room still to write, at the model's speeds (§9.8). */
  private estimate(r: Request, written: number, read: { done: number; total: number } | null): number {
    const readS = read ? (read.total - read.done) / Math.max(1, r.spec.read) : 0
    const writeS = Math.max(0, r.maxTokens - written) / Math.max(0.1, r.spec.write)
    return readS + writeS
  }

  private send(proc: Helper, r: Request): void {
    this.write(proc, runLine(r.id, r.parts, r.grammar, r.maxTokens))
  }

  private write(proc: Helper, line: string): void {
    const stdin = proc.child.stdin
    if (proc.exited || !stdin || stdin.destroyed || stdin.writableEnded) return
    stdin.write(`${line}\n`)
  }

  private start(model: string): Helper {
    const cmd = llmCommand(this.helper)
    const child = this.spawnFn(cmd.file, cmd.args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: this.dir, env: cmd.env })
    const proc: Helper = { child, model, loaded: false, buffer: [], pending: 0, stderr: '', exited: false }
    this.proc = proc
    child.stdin?.on('error', () => undefined)
    child.stdout?.on('data', (d: Buffer) => this.onData(proc, d))
    child.stderr?.on('data', (d: Buffer) => {
      proc.stderr = (proc.stderr + d.toString()).slice(-STDERR_KEEP)
    })
    child.on('error', () => this.onExit(proc))
    child.on('close', () => this.onExit(proc))
    this.write(proc, loadLine(model, LOCAL_CTX, llmThreads(os.cpus().length)))
    return proc
  }

  /** Splits stdout into lines; a line over the cap ends the job. */
  private onData(proc: Helper, chunk: Buffer): void {
    if (proc.exited) return
    if (this.proc === proc && this.current) this.armStall()
    let start = 0
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, i)
      start = i + 1
      if (proc.pending + piece.length > LLM_PROTOCOL.lineMax) return this.protocolError(proc)
      proc.buffer.push(piece)
      const line = Buffer.concat(proc.buffer).toString('utf8').replace(/\r$/, '')
      proc.buffer = []
      proc.pending = 0
      if (line.trim()) this.onLine(proc, line)
      if (proc.exited || this.proc !== proc) return
    }
    const rest = chunk.subarray(start)
    if (proc.pending + rest.length > LLM_PROTOCOL.lineMax) return this.protocolError(proc)
    if (rest.length) {
      proc.buffer.push(Buffer.from(rest))
      proc.pending += rest.length
    }
  }

  /** A line that is too long or not an event: the request fails and the helper goes. */
  private protocolError(proc: Helper): void {
    const r = this.current
    if (r && this.proc === proc) this.finish(r, new LocalAiError('crashed', LOCAL_MESSAGES.crashed))
    this.kill(proc)
  }

  private onLine(proc: Helper, line: string): void {
    const e: HelperEvent | null = readHelperLine(line)
    if (!e) return this.protocolError(proc)
    if (this.proc !== proc) return
    const r = this.current
    if (e.ev === 'loaded') {
      proc.loaded = true
      if (r) this.send(proc, r)
      return
    }
    if (e.ev === 'error' && e.id === undefined) {
      // A load failed (or a line was refused): the request fails and the helper goes.
      if (r) this.finish(r, errorFor(e.code, e.message))
      this.kill(proc)
      return
    }
    if (!r || e.id !== r.id) return
    switch (e.ev) {
      case 'read':
        r.onProgress({ phase: 'reading', done: e.done, total: e.total, secondsLeft: Math.ceil(this.estimate(r, 0, e)) })
        return
      case 'write':
        r.onProgress({ phase: 'writing', done: Math.min(e.tokens, r.maxTokens), total: r.maxTokens, secondsLeft: Math.ceil(this.estimate(r, e.tokens, null)) })
        return
      case 'done':
        this.finish(r, { text: e.text, prompt: e.prompt, output: e.output, readMs: e.readMs, writeMs: e.writeMs })
        return
      case 'cancelled':
        this.finish(r, new LocalAiError('stopped', LOCAL_MESSAGES.stopped))
        return
      case 'error':
        this.finish(r, errorFor(e.code, e.message))
        return
    }
  }

  private onExit(proc: Helper): void {
    if (proc.exited) return
    proc.exited = true
    if (this.proc !== proc) return
    this.proc = null
    const r = this.current
    // A crash (or Windows ending it for memory) while a request runs: it fails; the next starts a new helper.
    if (r) this.finish(r, new LocalAiError('crashed', LOCAL_MESSAGES.crashed))
    else this.armIdle()
  }

  /** Kills `proc` and lets go of it at once (its request, if any, was already ended by the caller): the next request starts a new helper. */
  private kill(proc: Helper): void {
    if (proc.exited) return
    proc.exited = true
    if (this.proc === proc) this.proc = null
    try {
      proc.child.stdin?.end()
    } catch {
      // Already closed.
    }
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL')
  }

  /** Closes the helper's stdin (it exits within a second) and kills it after the grace. */
  private stopProcess(proc: Helper): Promise<void> {
    if (proc.exited) return Promise.resolve()
    if (this.proc === proc) this.proc = null
    proc.exited = true
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL')
        resolve()
      }, this.graceMs)
      proc.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        proc.child.stdin?.end()
      } catch {
        proc.child.kill('SIGKILL')
      }
    })
  }
}

/** An `error` line in §9.9's words. */
function errorFor(code: string, message: string): LocalAiError {
  switch (code) {
    case 'context':
      return new LocalAiError('context', LOCAL_MESSAGES.tooLong)
    case 'model':
      return new LocalAiError('model', LOCAL_MESSAGES.damaged)
    case 'memory':
      return new LocalAiError('memory', LOCAL_MESSAGES.crashed)
    default:
      void message
      return new LocalAiError('internal', LOCAL_MESSAGES.crashed)
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
 * ssw-llm.exe (beside the speech helpers); in development native/bin/ssw-llm[.exe]. SSW_LLM_HELPER
 * (a file: a fake helper for tests) replaces it only when the app is not packaged.
 */
export function llmHelperPath(): string | null {
  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, 'native', 'ssw-llm.exe')
    return isFile(exe) ? exe : null
  }
  const override = process.env.SSW_LLM_HELPER
  if (override) return isFile(override) ? override : null
  const dev = path.join(app.getAppPath(), 'native', 'bin', process.platform === 'win32' ? 'ssw-llm.exe' : 'ssw-llm')
  return isFile(dev) ? dev : null
}
