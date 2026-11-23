/**
 * Long lines (docs/design/auto-blur.md §10.3): the rules read a line in windows of 512 characters that
 * overlap by 256, longer than the longest match any rule needs, and a hit that touches a window's edge
 * is extended on the full line to the end of its token run, so a 900-character JWT or signed URL is
 * covered whole. Pure.
 */
import { rawSpan, type CleanLine } from './clean'
import type { Hit } from './score'
import { TOKEN_CHAR } from './tables'

export const WINDOW = 512
export const WINDOW_STEP = 256

/** The windows a line is read in: the whole line when it has 512 characters or fewer. */
export function lineWindows(text: string): { start: number; text: string }[] {
  if (text.length <= WINDOW) return [{ start: 0, text }]
  const out: { start: number; text: string }[] = []
  for (let start = 0; ; start += WINDOW_STEP) {
    out.push({ start, text: text.slice(start, start + WINDOW) })
    if (start + WINDOW >= text.length) break
  }
  return out
}

/** A window of a cleaned line: its text and views sliced, its map kept for the raw indices. */
export function windowOf(line: CleanLine, start: number, length: number): CleanLine {
  if (start === 0 && length >= line.text.length) return line
  const end = Math.min(line.text.length, start + length)
  return {
    text: line.text.slice(start, end),
    map: line.map.subarray(start, end + 1),
    digit: line.digit.slice(start, end),
    prefix: line.prefix.slice(start, end),
    url: line.url.slice(start, end),
    label: line.label.slice(start, end)
  }
}

/** The cleaned index of a raw index (the first cleaned character at or after it). */
function cleanedAt(line: CleanLine, raw: number): number {
  let lo = 0
  let hi = line.text.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (line.map[mid] < raw) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Hits of a line read in windows, each own span that touches an inner window edge extended on the
 * full line to the end of its token run (both ways). Hits of other lines pass unchanged; the window
 * edges are those lineWindows gives for the line's cleaned text.
 */
export function extendAtEdges(hits: Hit[], line: CleanLine, lineIndex?: number, variant?: number): Hit[] {
  const windows = lineWindows(line.text)
  if (windows.length < 2) return hits
  const starts = new Set(windows.slice(1).map((w) => w.start))
  const ends = new Set(windows.slice(0, -1).map((w) => w.start + w.text.length))
  const token = (i: number): boolean => i >= 0 && i < line.text.length && TOKEN_CHAR.test(line.text[i])
  return hits.map((h) => {
    let changed = false
    const spans = h.spans.map((sp) => {
      if ((lineIndex !== undefined && sp.line !== lineIndex) || (variant !== undefined && sp.variant !== variant)) return sp
      let s = cleanedAt(line, sp.start)
      let e = cleanedAt(line, sp.end)
      if (!starts.has(s) && !ends.has(e)) return sp
      if (starts.has(s)) while (token(s - 1)) s--
      if (ends.has(e)) while (token(e)) e++
      const [start, end] = rawSpan(line, s, e)
      if (start === sp.start && end === sp.end) return sp
      changed = true
      return { ...sp, start, end }
    })
    return changed ? { ...h, spans } : h
  })
}
