/**
 * Model lists from a provider or service (docs/design/smart-tools.md §10.4), read the same way for
 * all: GET with the key in a header, redirects refused, 20 s, at most 4 MB, at most 2,000 ids, each
 * a model name of at most 100 characters (others skipped). The key only is sent, never project text.
 * Failures are AiErrors in the words every request uses, with any key scrubbed from them.
 */
import { describeFailure } from '../../shared/captions/transcriptErrors'
import type { ListedModel } from '../../shared/api/ai'
import { AiError, certificateFailure } from './request'
import { scrubSecrets } from './secrets'

export const MODEL_LIST_TIMEOUT_MS = 20_000
export const MODEL_LIST_MAX_BYTES = 4 * 1024 * 1024
export const MODEL_LIST_MAX_IDS = 2000
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/

/** A redirect a request was refused (redirect: 'error'): the service sent the request elsewhere. */
export const REDIRECT_MESSAGE = 'The service answered with a redirect to another address, which Flown does not follow (unexpected redirect).'

/** Whether `err` (or its cause) is fetch's refusal of a redirect. */
export function isRedirectError(err: unknown): boolean {
  for (let e = err as { message?: unknown; cause?: unknown } | undefined, i = 0; e && i < 4; e = e.cause as typeof e, i++) {
    if (typeof e.message === 'string' && /unexpected redirect|redirect mode is set to error/i.test(e.message)) return true
  }
  return false
}

/** The body of `res` as text, or null past `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const length = Number(res.headers.get('content-length'))
  if (Number.isFinite(length) && length > max) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const fail = (message: string): AiError => new AiError({ kind: 'other', retryable: false, message: scrubSecrets(message) })

/** GETs `url` with `headers` through `fetchFn` and returns its JSON; throws an AiError to show. */
export async function fetchModelJson(url: string, headers: Record<string, string>, signal: AbortSignal, fetchFn: typeof fetch, provider: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetchFn(url, { method: 'GET', headers, redirect: 'error', signal })
  } catch (err) {
    if (signal.aborted) {
      const reason = signal.reason as { name?: unknown } | undefined
      throw new AiError(describeFailure(reason?.name === 'TimeoutError' ? { timeout: true } : { cancelled: true }, provider))
    }
    if (isRedirectError(err)) throw fail(`${provider}: ${REDIRECT_MESSAGE}`)
    const certificate = certificateFailure(err)
    if (certificate) throw new AiError(describeFailure(certificate, provider))
    if (err instanceof Error && !/fetch failed/i.test(err.message)) throw fail(err.message)
    throw new AiError(describeFailure({ network: true }, provider))
  }
  if (res.status >= 300 && res.status < 400) throw fail(`${provider}: ${REDIRECT_MESSAGE}`)
  let text: string | null
  try {
    text = await readCapped(res, MODEL_LIST_MAX_BYTES)
  } catch (err) {
    if (signal.aborted) throw new AiError(describeFailure({ timeout: true }, provider))
    throw fail(`Could not read the list of models from ${provider}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (text === null) throw fail(`The list of models from ${provider} is too large (over 4 MB).`)
  if (!res.ok) {
    let message = text.slice(0, 300)
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown }
      const m = typeof body.error === 'string' ? body.error : typeof body.error?.message === 'string' ? body.error.message : typeof body.message === 'string' ? body.message : null
      if (m) message = m
    } catch {
      // Not JSON: the text as it is.
    }
    throw new AiError({ ...describeFailure({ status: res.status, message }, provider), message: scrubSecrets(describeFailure({ status: res.status, message }, provider).message) })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw fail(`${provider} answered the list of models with something that is not JSON.`)
  }
}

/** The models of a list's entries (`{ id }` objects or bare ids): valid ids once each, at most 2,000; `extra` adds a service's own fields. */
export function readListedIds(entries: readonly unknown[], extra: (entry: unknown) => Omit<ListedModel, 'id'> = () => ({}), idOf: (entry: unknown) => unknown = (e) => (e && typeof e === 'object' ? (e as { id?: unknown }).id : e)): ListedModel[] {
  const out: ListedModel[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (out.length >= MODEL_LIST_MAX_IDS) break
    const id = idOf(entry)
    if (typeof id !== 'string' || id.length > 100 || !MODEL_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, ...extra(entry) })
  }
  return out
}

/** Refused before sending: a request to an address the key was not entered for. */
export const OTHER_ORIGIN_MESSAGE = 'Flown refused to send this request to another address than the service’s.'

/**
 * A fetch for one service: every request must go to `origin` (scheme, host and port) and may not be
 * redirected (`redirect: 'error'`; a cross-origin redirect would forward an api-key header).
 */
export function noRedirectFetch(origin: string, base: typeof fetch = globalThis.fetch): typeof fetch {
  const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url: URL
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    } catch {
      return Promise.reject(new Error(OTHER_ORIGIN_MESSAGE))
    }
    if (url.origin !== origin) return Promise.reject(new RefusedRequest(OTHER_ORIGIN_MESSAGE))
    return base(input, { ...init, redirect: 'error' }).catch((err: unknown) => {
      throw isRedirectError(err) ? new RefusedRequest(REDIRECT_MESSAGE) : err
    })
  }
  return wrapped as typeof fetch
}

/** A request Flown refused to make or follow (another origin, a redirect): never tried again. */
export class RefusedRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefusedRequest'
  }
}
