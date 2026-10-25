/**
 * One request to an AI provider with a time limit, cancellation and retries: rate limits,
 * overloaded or failing servers and network errors are tried again after a backoff (what the
 * provider asked for, else 1 s, 2 s, 4 s); anything else fails at once with a message the user
 * can act on (see shared/captions/transcriptErrors). The SDKs' own retries are turned off so
 * every provider behaves the same way.
 */
import { AiOutputError } from '../../shared/captions/transcriptText'
import { describeFailure, retryDelay, type Failure, type FailureInfo } from '../../shared/captions/transcriptErrors'

/** A failed request, with its kind; the message is meant for the user. */
export class AiError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message)
    this.name = 'AiError'
  }
}

export const cancelled = (): AiError => new AiError({ kind: 'cancelled', retryable: false, message: 'Cancelled.' })

/** Waits `ms`, or rejects as cancelled when `signal` aborts first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled())
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelled())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface CallOptions {
  /** Cancels the call (the user, or the project closing). */
  signal: AbortSignal
  /** Longest wait for one attempt. */
  timeoutMs: number
  /** Attempts in all (default 4). */
  attempts?: number
  /** The provider's name as shown ("OpenAI"). */
  provider: string
  model?: string
  /** Reads an SDK error (anything the request threw that is not ours). */
  toFailure: (err: unknown) => FailureInfo
}

/** Runs `fn` (given a signal that aborts on cancel or time-out) until it succeeds or fails for good. */
export async function callWithRetry<T>(fn: (signal: AbortSignal) => Promise<T>, o: CallOptions): Promise<T> {
  const attempts = o.attempts ?? 4
  for (let attempt = 1; ; attempt++) {
    if (o.signal.aborted) throw cancelled()
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), o.timeoutMs)
    let failure: Failure
    try {
      return await fn(AbortSignal.any([o.signal, timeout.signal]))
    } catch (err) {
      if (o.signal.aborted) throw cancelled()
      if (err instanceof AiError || err instanceof AiOutputError) throw err
      const info: FailureInfo = timeout.signal.aborted ? { timeout: true } : o.toFailure(err)
      failure = describeFailure(info, o.provider, o.model)
    } finally {
      clearTimeout(timer)
    }
    if (!failure.retryable || attempt >= attempts) throw new AiError(failure)
    await sleep(retryDelay(attempt, failure.retryAfter), o.signal)
  }
}

/** Seconds from a retry-after header value (seconds or an HTTP date); undefined when absent. */
export function retryAfterSeconds(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  if (Number.isFinite(n)) return Math.max(0, n)
  const t = Date.parse(value)
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : undefined
}

/** Whether `err` is a failed connection (fetch's TypeError, a socket error code) rather than an answer. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown; cause?: { code?: unknown } }).code ?? (err as { cause?: { code?: unknown } }).cause?.code
  return (
    (err.name === 'TypeError' && /fetch failed|network/i.test(err.message)) ||
    (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_\w+)$/.test(code))
  )
}
