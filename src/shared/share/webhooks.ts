/**
 * Chat webhooks for "Share without a server" (F-22, docs/design/share.md §2.5): which URLs are
 * accepted (Slack, Discord and Microsoft Teams incoming webhooks on their own hosts, HTTPS only),
 * how one is shown masked, the short message posted, each service's request body, and the
 * messages for a failed post. Pure: main checks and posts, the page only shows the results.
 */

export type WebhookService = 'slack' | 'discord' | 'teams'

export const WEBHOOK_SERVICES: Record<WebhookService, { label: string }> = {
  slack: { label: 'Slack' },
  discord: { label: 'Discord' },
  teams: { label: 'Microsoft Teams' }
}

export const SHARE_LIMITS = {
  /** Longest webhook URL accepted. */
  urlLength: 1024,
  /** Longest name of a chat or a folder. */
  labelLength: 60,
  /** Chats and picked folders kept. */
  maxHooks: 10,
  maxFolders: 8,
  /** Longest title in a message (then "…"). */
  titleLength: 120,
  /** Largest request body. */
  bodyBytes: 4096,
  /** Most of a response read. */
  responseBytes: 16 * 1024,
  /** Longest wait for a post. */
  postTimeoutMs: 15_000
} as const

const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']

export const WEBHOOK_HELP =
  'Paste an incoming webhook from Slack, Discord or Microsoft Teams (it starts with https://hooks.slack.com/, https://discord.com/api/webhooks/ or https://….webhook.office.com/).'

/** The service of a URL's host, or null when the host is not one of theirs. */
function serviceOf(u: URL): WebhookService | null {
  const host = u.hostname
  const p = u.pathname
  if (host === 'hooks.slack.com') return /^\/services\/[A-Za-z0-9_/-]+$/.test(p) ? 'slack' : null
  if (DISCORD_HOSTS.includes(host)) return /^\/api(\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(p) ? 'discord' : null
  // <tenant>.webhook.office.com: one label before, nothing else.
  if (/^[a-z0-9-]+\.webhook\.office\.com$/.test(host)) return /^\/webhookb2\/[A-Za-z0-9@/_.-]+$/.test(p) ? 'teams' : null
  return null
}

/**
 * A pasted webhook URL, checked: HTTPS, the service's own host and path shape, the default port,
 * no user name, password or fragment, printable ASCII. Throws a message to show.
 */
export function parseWebhookUrl(raw: unknown): { service: WebhookService; url: string } {
  if (typeof raw !== 'string') throw new Error(WEBHOOK_HELP)
  const text = raw.trim()
  if (!text || text.length > SHARE_LIMITS.urlLength || !/^[\x21-\x7e]+$/.test(text)) throw new Error(WEBHOOK_HELP)
  let u: URL
  try {
    u = new URL(text)
  } catch {
    throw new Error(WEBHOOK_HELP)
  }
  if (u.protocol !== 'https:') throw new Error('Only https:// webhooks are accepted.')
  if (u.username || u.password || u.port || u.hash) throw new Error(WEBHOOK_HELP)
  const service = serviceOf(u)
  if (!service) throw new Error(WEBHOOK_HELP)
  return { service, url: u.toString() }
}

/** "hooks.slack.com/…/AbCd": the host and the last 4 characters, what the page may show. */
export function maskWebhook(url: string): string {
  try {
    const u = new URL(url)
    const tail = u.pathname.replace(/\/+$/, '').slice(-4)
    return `${u.hostname}/…/${tail}`
  } catch {
    return '…'
  }
}

/** "2:31", "1:02:03" */
export function lengthText(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** A title on one line: control characters out, spaces collapsed, at most `max` characters. */
export function cleanTitle(title: unknown, max: number = SHARE_LIMITS.titleLength): string {
  const s = (typeof title === 'string' ? title : '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return 'Untitled'
  const chars = [...s]
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : s
}

/** Where a shared copy went, for the message: "OneDrive › Flown", and its link when one is known. */
export interface SharePlace {
  text: string
  link?: string
}

/** Only an https link without spaces may go into a message. */
const safeLink = (link: string | undefined): string | null => {
  if (!link || link.length > 2048 || !/^https:\/\/[\x21-\x7e]+$/.test(link)) return null
  try {
    return new URL(link).protocol === 'https:' ? link : null
  } catch {
    return null
  }
}

/**
 * The message, as plain lines: "New video: Demo (2:31)", then where it was saved or its link.
 * Never a local path, never the file.
 */
export function shareMessage(meta: { title: string; seconds: number }, place?: SharePlace | null): string[] {
  const lines = [`New video: ${cleanTitle(meta.title)} (${lengthText(meta.seconds)})`]
  const link = safeLink(place?.link)
  if (link) lines.push(`Link: ${link}`)
  else if (place?.text) lines.push(`Saved to ${cleanTitle(place.text, 80)}`)
  return lines
}

export const TEST_MESSAGE = ['Flown is connected. Videos you share will be posted here.']

const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/**
 * Discord's inline markdown and mentions as plain text (mentions are also off in allowed_mentions).
 * Every line starts with Flown's own words, so line-start markdown (# heading, - list) cannot occur.
 */
const discordEscape = (s: string): string => s.replace(/([\\*_~`|[\]])/g, '\\$1').replace(/@/g, '@\u200b')
const teamsEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\*_~`[\]#])/g, '\\$1')

/** The JSON body for `service`; links stay clickable, everything else is plain text. */
export function webhookBody(service: WebhookService, lines: readonly string[]): string {
  const esc = service === 'slack' ? slackEscape : service === 'discord' ? discordEscape : teamsEscape
  const text = lines
    .map((line) => {
      const m = /^Link: (https:\/\/\S+)$/.exec(line)
      if (!m) return esc(line)
      // A link is left as is (it was checked: https, no spaces); Slack needs only < > & escaped.
      return `Link: ${service === 'discord' ? m[1] : slackEscape(m[1])}`
    })
    .join(service === 'teams' ? '\n\n' : '\n')
  const body = service === 'discord' ? { content: text, allowed_mentions: { parse: [] } } : { text }
  const json = JSON.stringify(body)
  if (new TextEncoder().encode(json).byteLength > SHARE_LIMITS.bodyBytes) throw new Error('The message is too long.')
  return json
}

/** The message for a failed post; names the service, never the URL. */
export function postFailure(service: WebhookService, what: number | 'timeout' | 'network' | 'redirect'): string {
  const name = WEBHOOK_SERVICES[service].label
  if (what === 'timeout') return `${name} did not answer in ${SHARE_LIMITS.postTimeoutMs / 1000} s.`
  if (what === 'network') return `Could not reach ${name}. Check the connection.`
  if (what === 'redirect') return `${name} sent the message somewhere else, so it was not posted.`
  if (what === 404 || what === 410) return 'This webhook no longer exists. Paste a new one in Settings › Share.'
  if (what === 401 || what === 403) return `${name} refused the message: the webhook may have been turned off.`
  if (what === 429) return `${name} is busy. Try again in a minute.`
  if (what >= 500) return `${name} had a problem (${what}). Try again later.`
  return `${name} did not accept the message (${what}).`
}
