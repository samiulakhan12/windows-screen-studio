/**
 * The API keys main has read or saved this session (docs/design/smart-tools.md §16.5), so they can be
 * taken out wherever they might show: a log line (redactLine's `secrets`) or the message of a failed
 * request a gateway echoed the key into (scrubSecrets, before any AiError leaves main). Keys are only
 * held in memory, as main already holds them to make requests; nothing here writes or logs one.
 */

/** Shorter values are not registered: a short "key" would take ordinary words out of every line. */
const MIN_LENGTH = 8
/** Most values kept (the oldest dropped): 20 providers and services, with room for edits. */
const MAX_VALUES = 64

const values: string[] = []

/** Keeps `value` (an API key main read or saved) to be taken out of logs and error messages. */
export function registerSecret(value: string): void {
  if (typeof value !== 'string') return
  const v = value.trim()
  if (v.length < MIN_LENGTH) return
  const at = values.indexOf(v)
  if (at >= 0) values.splice(at, 1)
  values.push(v)
  if (values.length > MAX_VALUES) values.splice(0, values.length - MAX_VALUES)
}

/** Every value registered, longest first (so a key that contains another is taken out whole). */
export function secretValues(): readonly string[] {
  return [...values].sort((a, b) => b.length - a.length)
}

/** Forgets every value (tests). */
export function clearSecrets(): void {
  values.length = 0
}

/** The name and password of `scheme://user:password@host`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi

/** `message` with each registered value, and the credentials of any address, replaced by <secret>. */
export function scrubSecrets(message: string, secrets: readonly string[] = secretValues()): string {
  if (typeof message !== 'string' || !message) return message
  let out = message
  for (const s of secrets) if (s.length >= MIN_LENGTH && out.includes(s)) out = out.split(s).join('<secret>')
  return out.replace(URL_CREDENTIALS, '$1<secret>@')
}
