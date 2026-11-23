/**
 * The names the user lists to hide (docs/design/auto-blur.md §10.6, finding 24): Settings' list and
 * the open project's, which the renderer sends with `privacy:names` whenever they change. They are
 * taken out of every log line and of the diagnostics report, and join secretValues() so a failed
 * request's message never carries one either. Held in memory only.
 */

/** Most names held: Settings' 200 and the open project's 200. */
const MAX_NAMES = 400
const MAX_NAME = 80
/** Shorter entries would take ordinary words out of every line. */
const MIN_NAME = 3

let names: string[] = []

/** Every name held, longest first: leading and trailing '*' removed, entries under 3 characters left out. */
export function privateNames(): string[] {
  return [...names]
}

/** Replaces the names held with `raw` (an array of strings; anything else clears them). */
export function setPrivateNames(raw: unknown): void {
  if (!Array.isArray(raw)) {
    names = []
    return
  }
  const out = new Set<string>()
  for (const v of raw.slice(0, MAX_NAMES)) {
    if (typeof v !== 'string' || v.length > MAX_NAME || /[\r\n\u0000-\u001f\u2028\u2029]/.test(v)) continue
    const name = v.normalize('NFC').trim().replace(/^\*+|\*+$/g, '').trim()
    if (name.length >= MIN_NAME) out.add(name)
  }
  names = [...out].sort((a, b) => b.length - a.length)
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `line` with every name held replaced by <secret>, in any case, longest first. */
export function redactPrivateNames(line: string, list: readonly string[] = names): string {
  if (!list.length || typeof line !== 'string' || !line) return line
  let out = line
  for (const name of list) {
    if (out.toLowerCase().includes(name.toLowerCase())) out = out.replace(new RegExp(escape(name), 'giu'), '<secret>')
  }
  return out
}
