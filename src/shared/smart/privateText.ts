/**
 * Private text a guide, a chapter name or a clip's title must never carry without the user seeing
 * it (docs/design/smart-tools.md §7.5, §12): links, email addresses and dotted names (the copy
 * pack's link check), and file paths. Shared by the offline namers, the AI answers' check
 * (validateNamesAnswer) and the guide's save check. Pure.
 */
import { notedPieces, NOTHING_SAID } from '../publish/check'

/** Format characters (zero-width joiners, bidi controls, soft hyphens): dropped before a path is looked for. */
const FORMAT = /[\p{Cf}\u00ad]/gu

/**
 * A Windows or home path: a drive letter and a slash ("C:\Users", "d:/notes"), a share
 * ("\\nas\share"), "~/" or "~\", or a "/Users/" or "/home/" folder. Read after NFKC, so full-width
 * letters, colons and slashes count too. "1/2", "and/or" and "Save/Export" are not paths.
 */
const PATHS = [
  /(?<![\p{L}\p{N}_])[a-z]:[\\/]/iu,
  /\\\\[^\\/\s]+[\\/]/u,
  /(?<![\p{L}\p{N}_])~[\\/]/u,
  /(?<![\p{L}\p{N}_.])[\\/](?:users|home)[\\/]/iu
]

/** Whether `text` holds a file path (§20.0). */
export function pathLike(text: string): boolean {
  const t = text.replace(FORMAT, '').normalize('NFKC')
  return PATHS.some((re) => re.test(t))
}

/**
 * Whether `text` holds anything private-like: a piece the link check reads as a link, an address or
 * a dotted name with nothing said (`linkLike` on each piece, through notedPieces), or a path.
 */
export function privateLike(text: string): boolean {
  return pathLike(text) || notedPieces(text, NOTHING_SAID).length > 0
}

/** Longest link a guide keeps (characters, as typed and as the parser writes it). */
const LINK_MAX = 300

/**
 * The demo's end-screen link (§4.2): a string of at most 300 characters, without spaces or control
 * characters, that the WHATWG parser reads as `https:` with a host and no user name or password;
 * its `href`, else null. Never a `javascript:` or any other scheme.
 */
export function readLinkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > LINK_MAX) return null
  if (/[\s\u0000-\u001f\u007f-\u009f\p{Cf}\u00ad]/u.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
  return url.href.length <= LINK_MAX ? url.href : null
}
