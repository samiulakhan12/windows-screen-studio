/**
 * The app's log (X-03, docs/design/hands-off.md §2.5): the main process's console lines, redacted
 * (src/shared/diagnostics/redact.ts) and kept in userData/logs/main.log. At most LOG.maxBytes per
 * file; when the next write would pass it, main.log becomes main.1.log (replacing the older one),
 * so the log never takes more than twice that. Lines are buffered and appended every
 * LOG.flushMs; the rest is written synchronously when the app quits.
 */
import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'
import { redactLine, type RedactRoots } from '../shared/diagnostics/redact'

export const LOG = {
  /** Largest size of one log file. */
  maxBytes: 1024 * 1024,
  /** How often buffered lines are appended. */
  flushMs: 500,
  /** Longest entry kept, in characters. */
  lineMax: 2000
} as const

export const LOG_FILE = 'main.log'
export const OLD_LOG_FILE = 'main.1.log'

type Level = 'log' | 'info' | 'warn' | 'error'
const LABEL: Record<Level, string> = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' }

export class AppLog {
  private pending: string[] = []
  private size: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(
    readonly dir: string,
    private readonly roots: RedactRoots,
    private readonly limits: { maxBytes: number; flushMs: number; lineMax: number } = LOG,
    private readonly now: () => Date = () => new Date(),
    /** The home folder and the account name, taken out wherever they are left (redactLine). */
    private readonly names: readonly string[] = []
  ) {}

  get file(): string {
    return path.join(this.dir, LOG_FILE)
  }

  /** Keeps one entry (console arguments, as console prints them), redacted and capped. */
  write(level: Level, args: unknown[]): void {
    let text: string
    try {
      text = format(...args)
    } catch {
      text = String(args[0])
    }
    if (text.length > this.limits.lineMax) text = `${text.slice(0, this.limits.lineMax)}…`
    this.pending.push(`${this.now().toISOString()} ${LABEL[level]} ${redactLine(text, this.roots, this.names)}\n`)
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.limits.flushMs)
  }

  private take(): string {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    let chunk = this.pending.join('')
    this.pending = []
    // A burst larger than a whole file keeps its end.
    if (Buffer.byteLength(chunk) > this.limits.maxBytes) chunk = chunk.slice(chunk.length - Math.floor(this.limits.maxBytes / 4))
    return chunk
  }

  private sizeNow(): number {
    if (this.size === null) {
      try {
        this.size = fs.statSync(this.file).size
      } catch {
        this.size = 0
      }
    }
    return this.size
  }

  /** Rotates first when `bytes` more would pass the cap. */
  private rotateFor(bytes: number): void {
    if (this.sizeNow() + bytes <= this.limits.maxBytes || this.size === 0) return
    try {
      fs.renameSync(this.file, path.join(this.dir, OLD_LOG_FILE))
    } catch {
      // Another process has it open: start the file again instead.
      try {
        fs.truncateSync(this.file, 0)
      } catch {
        // Nothing more to do: the next write tries again.
      }
    }
    this.size = 0
  }

  /** Appends what is buffered. */
  flush(): Promise<void> {
    const chunk = this.take()
    if (!chunk) return this.chain
    this.chain = this.chain.then(async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true })
        const bytes = Buffer.byteLength(chunk)
        this.rotateFor(bytes)
        await fs.promises.appendFile(this.file, chunk, 'utf8')
        this.size = this.sizeNow() + bytes
      } catch {
        // The log is a help, never a reason to fail.
      }
    })
    return this.chain
  }

  /** Writes what is buffered now (quitting). */
  flushSync(): void {
    const chunk = this.take()
    if (!chunk) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const bytes = Buffer.byteLength(chunk)
      this.rotateFor(bytes)
      fs.appendFileSync(this.file, chunk, 'utf8')
      this.size = this.sizeNow() + bytes
    } catch {
      // As flush().
    }
  }

  /** The last `n` lines of the log (older file first), redacted again. */
  async recent(n: number): Promise<string[]> {
    await this.flush()
    const read = (name: string): Promise<string> => fs.promises.readFile(path.join(this.dir, name), 'utf8').catch(() => '')
    const text = (await read(OLD_LOG_FILE)) + (await read(LOG_FILE))
    return text
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-n)
      .map((l) => redactLine(l.slice(0, this.limits.lineMax + 64), this.roots, this.names))
  }
}

let current: AppLog | null = null

/** The running app's log, once started. */
export const appLog = (): AppLog | null => current

/**
 * Starts the log in `dir` and tees console.log/info/warn/error into it (the console still prints
 * as before). Call once, as early as possible.
 */
export function startAppLog(dir: string, roots: RedactRoots, names: readonly string[] = []): AppLog {
  if (current) return current
  const log = new AppLog(dir, roots, LOG, () => new Date(), names)
  current = log
  for (const level of ['log', 'info', 'warn', 'error'] as Level[]) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      log.write(level, args)
    }
  }
  return log
}
