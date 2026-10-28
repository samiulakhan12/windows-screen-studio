/**
 * Redaction of log lines and diagnostics (X-03, docs/design/hands-off.md §2.5). Keys and tokens
 * become <secret>, e-mail addresses <email>; a path inside one of the app's own folders keeps only
 * its place under that folder (<userData>\logs\main.log), and every other absolute path becomes
 * <path>, so the user's name (part of every home folder) never appears. Pure.
 */

/** The app's own folders by label ("userData", "projects", "app"); paths inside them stay readable. */
export type RedactRoots = Readonly<Record<string, string>>

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A root as a pattern matching either separator, any case (Windows paths are case-insensitive). */
function rootPattern(root: string): RegExp | null {
  const trimmed = root.replace(/[\\/]+$/, '')
  if (trimmed.length < 3) return null
  const body = trimmed
    .split(/[\\/]+/)
    .map(escape)
    .join('[\\\\/]+')
  // Only a whole folder name: "C:\\Flown" must not match "C:\\Flown2".
  return new RegExp(`${body}(?=$|[\\\\/\\s"'<>|:;,)\\]])`, 'gi')
}

/** A path segment that may hold single spaces ("John Smith"): a name never leaks half-redacted. */
const SEG = `[^\\\\/\\s"'<>|*?:\\r\\n]+(?: [^\\\\/\\s"'<>|*?:\\r\\n]+)*`
const WIN_PATH = new RegExp(`\\b[A-Za-z]:[\\\\/](?:${SEG}[\\\\/]?)*`, 'g')
const UNC_PATH = new RegExp(`\\\\\\\\${SEG}(?:\\\\${SEG})*\\\\?`, 'g')
const POSIX_PATH = /(^|[\s"'(=,[])(\/[^\s"'<>,)\]]+)/g
const FILE_URL = /file:\/\/\/?(?=[A-Za-z]:|\/)[^\s"')]+/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

const SECRETS: [RegExp, string][] = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, '<secret>'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '<secret>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<secret>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <secret>'],
  [/\b(api[_-]?key|x-goog-api-key|x-api-key|key|token|access[_-]?token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)(?!<secret>|Bearer\b|Basic\b)[^\s"'&,;]+/gi, '$1$2<secret>'],
  // Any long run of key-like characters (hashes, keys of providers not listed above).
  [/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}/g, '<secret>']
]

/** `line` with secrets, e-mail addresses and paths outside `roots` taken out. */
export function redactLine(line: string, roots: RedactRoots = {}): string {
  let out = line
  const ordered = Object.entries(roots)
    .filter(([, dir]) => typeof dir === 'string' && dir.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
  for (const [label, dir] of ordered) {
    const re = rootPattern(dir)
    if (re) out = out.replace(re, `<${label}>`)
  }
  out = out.replace(FILE_URL, 'file://<path>')
  out = out.replace(UNC_PATH, '<path>')
  out = out.replace(WIN_PATH, '<path>')
  out = out.replace(POSIX_PATH, (_m, lead: string) => `${lead}<path>`)
  out = out.replace(EMAIL, '<email>')
  for (const [re, to] of SECRETS) out = out.replace(re, to)
  return out
}
