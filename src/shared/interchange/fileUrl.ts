/**
 * Paths and text inside timeline files (docs/design/output-and-languages.md §8.6, §18.3): file URLs
 * percent-encoded with the drive letter kept, XML text and attributes escaped with the characters
 * XML 1.0 forbids dropped, ASCII names for EDL. Pure. Shared by the three writers (fcpxml.ts,
 * xmeml.ts, edl.ts), so a project, chapter or file name can never break out of its place or make a
 * timeline file unreadable.
 */

/** A surrogate that is not part of a pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
/**
 * Characters XML 1.0 forbids anywhere in a document: C0 controls other than tab, newline and
 * carriage return, U+FFFE and U+FFFF, and lone surrogates.
 */
const FORBIDDEN = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]|${LONE_SURROGATE.source}`, 'g')

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

/** Text for an XML element: `&`, `<`, `>`, `"` and `'` escaped, the characters XML 1.0 forbids dropped. */
export function xmlText(s: string): string {
  return s.replace(FORBIDDEN, '').replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/**
 * Text for an XML attribute: as xmlText, with newlines, carriage returns and tabs written as
 * character references, so a reader's attribute normalisation keeps them (a newline is `&#10;`).
 */
export function xmlAttr(s: string): string {
  return xmlText(s).replace(/[\n\r\t]/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** One path segment, UTF-8 percent-encoded (spaces, `#`, `%`, `?` and every non-ASCII letter included); a lone surrogate becomes U+FFFD so encoding never throws. */
const segment = (s: string): string => encodeURIComponent(s.replace(LONE_SURROGATE, '\uFFFD'))
const segments = (rest: string): string => rest.split(/[\\/]+/).map(segment).join('/')

/**
 * A path as a file URL. Windows paths keep their drive letter: 'file:///C:/Users/…' for FCPXML,
 * 'file://localhost/C:/…' for Premiere XML (Premiere's own form). A network path (`\\server\share\…`)
 * names its server as the host; an absolute POSIX path (tests on Linux) is written from the root.
 */
export function fileUrl(windowsPath: string, form: 'fcpxml' | 'xmeml'): string {
  const host = form === 'xmeml' ? 'localhost' : ''
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+(.*)$/.exec(windowsPath)
  if (unc) return `file://${segment(unc[1])}/${segments(unc[2])}`
  const drive = /^([A-Za-z]):[\\/]*(.*)$/.exec(windowsPath)
  if (drive) return `file://${host}/${drive[1].toUpperCase()}:/${segments(drive[2])}`
  return `file://${host}/${segments(windowsPath.replace(/^[\\/]+/, ''))}`
}

/**
 * `s` in printable ASCII for an EDL (§8.5): accents taken off their letters (é → e), every other
 * character outside U+0020–U+007E dropped, spaces collapsed. A name with no ASCII letter left becomes
 * `fallback` (a Bangla chapter title becomes "Chapter 2"; FCPXML and xmeml keep it whole).
 */
export function asciiName(s: string, fallback: string): string {
  const ascii = s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\u0020-\u007e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return /[A-Za-z]/.test(ascii) ? ascii : fallback
}
