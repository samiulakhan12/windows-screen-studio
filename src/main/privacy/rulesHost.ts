/// <reference types="electron-vite/node" />
/**
 * Main's side of the rules worker (docs/design/auto-blur.md §5.7, §10.3, D20): one worker, one read at
 * a time, 2 s a read. A read that takes longer ends the worker and answers 'timeout' (the scan counts
 * it as failed and covers its areas); the next read starts a new worker. Built by electron-vite, the
 * worker is its own chunk (`?nodeWorker`); run from source (the unit tests), it is bundled from its
 * source on first use.
 */
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { DetectOptions, Hit } from '../../shared/privacy/detect/detect'
import type { ReadLine, ReadResult } from '../../shared/privacy/protocol'
import type { RulesAnswer, RulesAsk } from './rulesWorker'
import createRulesWorker from './rulesWorker?nodeWorker'

/** The time the rules may take on one read (§10.3). */
export const RULES_LIMIT_MS = 2000

let bundled: string | null = null

/** The worker from its source, bundled once a process (only when the app was not built by electron-vite). */
function workerFromSource(): Worker {
  if (!bundled) {
    const load = createRequire(import.meta.url)
    const builder = 'esbuild'
    const esbuild = load(builder) as typeof import('esbuild')
    const out = path.join(os.tmpdir(), `flown-rules-worker-${process.pid}.mjs`)
    esbuild.buildSync({ entryPoints: [fileURLToPath(new URL('./rulesWorker.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' })
    process.once('exit', () => rmSync(out, { force: true }))
    bundled = out
  }
  return new Worker(bundled)
}

/** A new rules worker: electron-vite's chunk, or the source bundled. */
function defaultWorker(): Worker {
  return typeof createRulesWorker === 'function' ? createRulesWorker({}) : workerFromSource()
}

export interface RulesHostOptions {
  /** Starts a worker (tests give one of their own). */
  create?: () => Worker
  limitMs?: number
}

export class RulesHost {
  private worker: Worker | null = null
  private next = 1
  private queue: Promise<unknown> = Promise.resolve()
  private readonly create: () => Worker
  private readonly limitMs: number
  /** Workers started (a timeout ends one; the next read starts another). */
  started = 0

  constructor(options: RulesHostOptions = {}) {
    this.create = options.create ?? defaultWorker
    this.limitMs = options.limitMs ?? RULES_LIMIT_MS
  }

  /** The hits of one read, or 'timeout' when the rules took longer than the limit (or the worker failed). */
  async detect(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions): Promise<Hit[] | 'timeout'> {
    const a = await this.ask(lines, qr, options, false)
    return a === 'timeout' ? a : a.hits
  }

  /** The hits of one read and the lines careful-long reads again (§5.6), or 'timeout'. */
  detectCareful(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions): Promise<{ hits: Hit[]; careful: number[] } | 'timeout'> {
    return this.ask(lines, qr, options, true)
  }

  private ask(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions, careful: boolean): Promise<{ hits: Hit[]; careful: number[] } | 'timeout'> {
    const run = this.queue.then(() => this.once({ id: this.next++, lines: [...lines], qr: [...qr], options, careful }))
    this.queue = run.catch(() => undefined)
    return run
  }

  private once(m: RulesAsk): Promise<{ hits: Hit[]; careful: number[] } | 'timeout'> {
    if (!this.worker) {
      this.worker = this.create()
      this.started++
    }
    const worker = this.worker
    return new Promise((resolve) => {
      let settled = false
      const done = (v: { hits: Hit[]; careful: number[] } | 'timeout', end: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onError)
        if (end) {
          if (this.worker === worker) this.worker = null
          void worker.terminate().catch(() => undefined)
        }
        resolve(v)
      }
      const onMessage = (a: RulesAnswer): void => {
        if (a.id !== m.id) return
        done('failed' in a ? 'timeout' : { hits: a.hits, careful: a.careful }, 'failed' in a)
      }
      const onError = (): void => done('timeout', true)
      const timer = setTimeout(() => done('timeout', true), this.limitMs)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onError)
      worker.postMessage(m)
    })
  }

  /** Ends the worker. */
  close(): void {
    const w = this.worker
    this.worker = null
    if (w) void w.terminate().catch(() => undefined)
  }
}
