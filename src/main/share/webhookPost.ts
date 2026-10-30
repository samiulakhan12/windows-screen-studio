/**
 * Posts a short message to a chat webhook (F-22, docs/design/share.md §2.5): the URL is checked
 * again right before, HTTPS to the service's own host, no redirects followed, a 15 s time limit,
 * at most 16 KB of the answer read (and never shown). Errors name the service, never the URL.
 * `fetch` is Electron's net.fetch in the app (the system proxy), Node's in tests.
 */
import { parseWebhookUrl, postFailure, SHARE_LIMITS, webhookBody, type WebhookService } from '../../shared/share/webhooks'

export type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>

export interface PostDeps {
  fetch: FetchLike
  /** Test origin (http://127.0.0.1:port) the checked URL's path is sent to instead; unpackaged builds only. */
  origin?: string
  timeoutMs?: number
}

/** Reads at most `max` bytes of a response, then stops reading. */
async function drain(res: Response, max: number): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) return
  let read = 0
  try {
    while (read < max) {
      const { done, value } = await reader.read()
      if (done) return
      read += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Posts `lines` to the webhook `url`; throws a message to show. */
export async function postToWebhook(service: WebhookService, url: string, lines: readonly string[], signal: AbortSignal, deps: PostDeps): Promise<void> {
  const checked = parseWebhookUrl(url)
  if (checked.service !== service) throw new Error(postFailure(service, 'network'))
  const body = webhookBody(service, lines)
  let target = checked.url
  if (deps.origin) {
    const u = new URL(checked.url)
    target = `${deps.origin.replace(/\/+$/, '')}${u.pathname}${u.search}`
  }
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? SHARE_LIMITS.postTimeoutMs)
  const both = AbortSignal.any([signal, timeout])
  let res: Response
  try {
    res = await deps.fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'manual', signal: both })
  } catch {
    if (signal.aborted) throw new Error('Cancelled.')
    throw new Error(postFailure(service, timeout.aborted ? 'timeout' : 'network'))
  }
  await drain(res, SHARE_LIMITS.responseBytes).catch(() => undefined)
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new Error(postFailure(service, 'redirect'))
  if (res.status < 200 || res.status >= 300) throw new Error(postFailure(service, res.status))
}
