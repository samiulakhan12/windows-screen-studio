/**
 * One request to an AI provider with a time limit, cancellation and retries: rate limits,
 * overloaded or failing servers and network errors are tried again after a backoff (what the
 * provider asked for, else 1 s, 2 s, 4 s); anything else fails at once with a message the user
 * can act on (see shared/captions/transcriptErrors). The SDKs' own retries are turned off so
 * every provider behaves the same way.
 */
import { AiOutputError } from '../../shared/captions/transcriptText'
import { describeFailure, retryDelay, type Failure, type FailureInfo } from '../../shared/captions/transcriptErrors'
import { scrubSecrets } from './secrets'

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

/** Why `o.signal` stopped the call: a caller's time limit (AbortSignal.timeout) is a time-out, anything else a cancel. */
const stopped = (o: CallOptions): AiError =>
  (o.signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError' ? new AiError(describeFailure({ timeout: true }, o.provider, o.model)) : cancelled()

/** `err` with any API key it repeats taken out of its message (smart-tools.md §10.3, §16.5): a gateway may echo the request's key. */
function scrubbed(err: AiError): AiError {
  const message = scrubSecrets(err.failure.message)
  return message === err.failure.message ? err : new AiError({ ...err.failure, message })
}

/**
 * Runs `fn` (given a signal that aborts on cancel or time-out) until it succeeds or fails for good.
 * Every failure message is passed through scrubSecrets before it leaves, so a key a provider or a
 * gateway echoed back never reaches the renderer.
 */
export async function callWithRetry<T>(fn: (signal: AbortSignal) => Promise<T>, o: CallOptions): Promise<T> {
  const attempts = o.attempts ?? 4
  for (let attempt = 1; ; attempt++) {
    if (o.signal.aborted) throw stopped(o)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), o.timeoutMs)
    let failure: Failure
    try {
      return await fn(AbortSignal.any([o.signal, timeout.signal]))
    } catch (err) {
      if (o.signal.aborted) throw stopped(o)
      if (err instanceof AiError) throw scrubbed(err)
      if (err instanceof AiOutputError) throw err
      const info: FailureInfo = timeout.signal.aborted ? { timeout: true } : o.toFailure(err)
      failure = describeFailure(info, o.provider, o.model)
      failure = { ...failure, message: scrubSecrets(failure.message) }
    } finally {
      clearTimeout(timer)
    }
    if (!failure.retryable || attempt >= attempts) throw new AiError(failure)
    await sleep(retryDelay(attempt, failure.retryAfter), o.signal).catch(() => {
      throw stopped(o)
    })
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

/** The codes of a certificate refused in the handshake: self-signed, expired, from an issuer this PC does not trust, or for another name. */
const CERTIFICATE_RE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/

/**
 * A request refused in the handshake because the address's certificate is not trusted (a company's
 * TLS inspection, a proxy or a server on the network with its own certificate): named, and never
 * tried again, as trying again cannot help and the connection is fine. Null for anything else.
 */
export function certificateFailure(err: unknown): FailureInfo | null {
  for (let e = err as { code?: unknown; cause?: unknown } | null | undefined, i = 0; e && typeof e === 'object' && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.code === 'string' && CERTIFICATE_RE.test(e.code)) return { message: `its certificate is not trusted on this PC (${e.code}), so nothing was sent.` }
  }
  return null
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
