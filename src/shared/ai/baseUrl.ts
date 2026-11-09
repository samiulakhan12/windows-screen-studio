/**
 * A service's base URL (docs/design/smart-tools.md §10.2, §0 decision 6): parsed with the WHATWG URL
 * parser, https only, or plain http for a service on this PC (localhost, 127.0.0.0/8, [::1]); no
 * name and password, query or fragment; at most 300 characters; the path kept without a trailing
 * slash. The host shown and stored is the ASCII form (an internationalised name in its xn-- form),
 * which is where the key and the text go. Pure.
 */

export type BaseUrlResult = { ok: true; baseUrl: string; origin: string; host: string; loopback: boolean } | { ok: false; message: string }

/** Longest base URL taken. */
export const BASE_URL_MAX = 300

/** An Azure OpenAI resource name: 2 to 63 lowercase letters, digits and hyphens, not starting with a hyphen. */
export const AZURE_RESOURCE_RE = /^[a-z0-9][a-z0-9-]{1,62}$/

export const BASE_URL_MESSAGES = {
  empty: 'Enter the address of the service.',
  long: `The address is too long (at most ${BASE_URL_MAX} characters).`,
  invalid: 'This is not a web address. It starts with https://.',
  https: 'Use an https:// address. Plain http:// is only for a service on this PC.',
  credentials: 'Remove the name and password from the address.',
  query: 'Remove the part after ?',
  fragment: 'Remove the part after #',
  azure: 'A resource name has 2 to 63 lowercase letters, digits and hyphens, and starts with a letter or digit.'
} as const

const fail = (message: string): BaseUrlResult => ({ ok: false, message })

/**
 * Whether `host` names this PC: `localhost`, an IPv4 address in 127.0.0.0/8, or `[::1]` (with or
 * without its brackets). A port after the host is ignored. As the URL parser writes it: lowercase,
 * IPv4 in dotted decimal.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end < 0) return false
    return h.slice(1, end) === '::1'
  }
  if (h === '::1') return true
  const colon = h.lastIndexOf(':')
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(h.slice(colon + 1))) return false
    h = h.slice(0, colon)
  }
  if (h === 'localhost') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  return !!m && m.slice(1).every((n) => Number(n) <= 255)
}

/** `raw`, a base URL the user typed, checked and normalised; or why it cannot be used. */
export function readBaseUrl(raw: string): BaseUrlResult {
  if (typeof raw !== 'string') return fail(BASE_URL_MESSAGES.invalid)
  const text = raw.trim()
  if (!text) return fail(BASE_URL_MESSAGES.empty)
  if (text.length > BASE_URL_MAX) return fail(BASE_URL_MESSAGES.long)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return fail(BASE_URL_MESSAGES.invalid)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail(BASE_URL_MESSAGES.https)
  if (!url.hostname) return fail(BASE_URL_MESSAGES.invalid)
  if (url.username || url.password || /^[a-z]+:\/\/[^/?#]*@/i.test(text)) return fail(BASE_URL_MESSAGES.credentials)
  // A bare "?" or "#" leaves url.search and url.hash empty: the text tells.
  if (url.search || text.includes('?')) return fail(BASE_URL_MESSAGES.query)
  if (url.hash || text.includes('#')) return fail(BASE_URL_MESSAGES.fragment)
  const loopback = isLoopbackHost(url.hostname)
  if (url.protocol === 'http:' && !loopback) return fail(BASE_URL_MESSAGES.https)
  const path = url.pathname.replace(/\/+$/, '')
  const baseUrl = `${url.protocol}//${url.host}${path}`
  if (baseUrl.length > BASE_URL_MAX) return fail(BASE_URL_MESSAGES.long)
  return { ok: true, baseUrl, origin: url.origin, host: url.host, loopback }
}

/** The base URL of Azure OpenAI resource `resource`: https://<name>.openai.azure.com/openai/v1. */
export function azureBaseUrl(resource: string): BaseUrlResult {
  const name = typeof resource === 'string' ? resource.trim() : ''
  if (!AZURE_RESOURCE_RE.test(name)) return fail(BASE_URL_MESSAGES.azure)
  return readBaseUrl(`https://${name}.openai.azure.com/openai/v1`)
}

/** The resource name of an Azure OpenAI base URL, or null for any other address. */
export function azureResource(baseUrl: string): string | null {
  const m = /^https:\/\/([a-z0-9][a-z0-9-]{1,62})\.openai\.azure\.com\/openai\/v1$/.exec(baseUrl)
  return m ? m[1] : null
}
