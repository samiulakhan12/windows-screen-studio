/**
 * The strict .cube parser (docs/design/editing-polish.md §9.5, §14 rule 1). LUT files are
 * untrusted: main parses one before it copies it into a project (src/main/lutImport.ts), and the
 * renderer parses it again, after checking its SHA-256, before it draws with it. One linear pass
 * with fixed caps: at most 16 MiB, lines of at most 1,024 characters, a 3D table of at most 65³
 * entries and a shaper of at most 65,536, numbers of at most 16 in size, ranges whose span is at
 * least 1e-6 (a smaller one would make the shader's scale infinite). No eval, and no regular
 * expression that can backtrack badly. A rejection names the line and the reason.
 *
 * Accepted: Adobe's and Resolve's keywords (TITLE, LUT_3D_SIZE, LUT_1D_SIZE, DOMAIN_MIN,
 * DOMAIN_MAX, LUT_1D_INPUT_RANGE, LUT_3D_INPUT_RANGE, and LUT_IN_VIDEO_RANGE / LUT_OUT_VIDEO_RANGE,
 * which are ignored), case-insensitive, each at most once and only before the data; a BOM; CRLF;
 * tabs; `#` comments. The data is exactly LUT_1D_SIZE + LUT_3D_SIZE³ lines of three numbers, the
 * shaper first, red changing fastest, and nothing after it.
 */

export const CUBE_LIMITS = {
  /** Largest file read, in bytes (a 65³ file is 7–10 MiB of text). */
  maxBytes: 16 * 1024 * 1024,
  /** Longest line, in characters (without its line break). */
  maxLine: 1024,
  size3d: { min: 2, max: 65 },
  size1d: { min: 2, max: 65536 },
  /** Largest number in absolute value. */
  maxAbs: 16,
  /** Smallest span of a range on each channel. */
  minSpan: 1e-6,
  /** Longest TITLE, in characters, and how much of it is kept (shown as plain text). */
  titleMax: 256,
  titleShown: 80
} as const

export interface CubeLut {
  /** TITLE without controls and bidi overrides, at most 80 characters; '' without one. */
  title: string
  /** LUT_3D_SIZE (N). */
  size: number
  /** N³ RGB triples, red fastest, then green, then blue. */
  data: Float32Array
  /** Resolve's 1D shaper, applied first: `size` RGB triples over the input range min..max. */
  shaper: { size: number; data: Float32Array; min: number; max: number } | null
  /** The 3D table's input range per channel (DOMAIN_MIN / DOMAIN_MAX or LUT_3D_INPUT_RANGE); default 0..1. */
  domainMin: [number, number, number]
  domainMax: [number, number, number]
}

/** Why a .cube file cannot be used; `line` is 1-based (0: the file as a whole). */
export class CubeError extends Error {
  readonly line: number
  constructor(line: number, reason: string) {
    super(line > 0 ? `This LUT could not be used: line ${line.toLocaleString('en-US')} ${reason}.` : `This LUT could not be used: ${reason}.`)
    this.name = 'CubeError'
    this.line = line
  }
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d{1,3})?$/
const NUM = '([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d{1,3})?)'
/** A plain line of data (the fast path; anything else goes through the checks that name the problem). */
const DATA_LINE = new RegExp(`^[ \\t]*${NUM}[ \\t]+${NUM}[ \\t]+${NUM}[ \\t]*\\r?$`)
const INTEGER = /^\d{1,6}$/
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g
const KEYWORD_START = /^[A-Za-z_]/
const NOT_A_NUMBER = /^(nan|inf|infinity)$/i
const SPACE = /[ \t]+/

/** A keyword as shown in an error: letters, digits and underscores only, at most 40. */
const shown = (word: string): string => word.replace(/[^A-Za-z0-9_]/g, '?').slice(0, 40)

function number(token: string, line: number): number {
  if (!NUMBER.test(token)) throw new CubeError(line, `has "${shown(token)}", which is not a number`)
  const v = Number(token)
  if (!Number.isFinite(v)) throw new CubeError(line, 'has a number too large to use')
  if (Math.abs(v) > CUBE_LIMITS.maxAbs) throw new CubeError(line, `has ${token}, larger than ${CUBE_LIMITS.maxAbs}`)
  return v
}

function numbers(tokens: readonly string[], count: number, line: number, what: string): number[] {
  if (tokens.length !== count) throw new CubeError(line, `has ${tokens.length} ${tokens.length === 1 ? 'number' : 'numbers'} for ${what}, not ${count}`)
  return tokens.map((t) => number(t, line))
}

function size(tokens: readonly string[], line: number, range: { min: number; max: number }, what: string): number {
  if (tokens.length !== 1 || !INTEGER.test(tokens[0])) throw new CubeError(line, `has no whole number for ${what}`)
  const n = Number(tokens[0])
  if (n < range.min || n > range.max) throw new CubeError(line, `sets ${what} to ${n.toLocaleString('en-US')}, outside ${range.min}..${range.max.toLocaleString('en-US')}`)
  return n
}

function span(min: readonly number[], max: readonly number[], line: number): void {
  for (let c = 0; c < min.length; c++) if (!(max[c] - min[c] >= CUBE_LIMITS.minSpan)) throw new CubeError(line, 'has a range narrower than 0.000001')
}

/** The line holding byte `at` (1-based). */
function lineOfByte(bytes: Uint8Array, at: number): number {
  let n = 1
  for (let i = 0; i < at; i++) if (bytes[i] === 10) n++
  return n
}

/** Parses a .cube file, or throws a CubeError naming the line and the reason. */
export function parseCube(bytes: Uint8Array): CubeLut {
  if (bytes.length > CUBE_LIMITS.maxBytes) throw new CubeError(0, 'the file is larger than 16 MB')
  const nul = bytes.indexOf(0)
  if (nul >= 0) throw new CubeError(lineOfByte(bytes, nul), 'has a NUL character')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CubeError(0, 'it is not UTF-8 text')
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let title = ''
  let size3 = 0
  let size1 = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  let shaperMin = 0
  let shaperMax = 1
  const seen = new Set<string>()
  let table: Float32Array | null = null
  let shaper: Float32Array | null = null
  let rows = 0
  let total = 0
  let lineNo = 0
  let start = 0
  while (start <= text.length) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    lineNo++
    let line = text.slice(start, end)
    start = end + 1
    if (line.length > CUBE_LIMITS.maxLine + 1 || (line.length === CUBE_LIMITS.maxLine + 1 && !line.endsWith('\r')))
      throw new CubeError(lineNo, `is longer than ${CUBE_LIMITS.maxLine.toLocaleString('en-US')} characters`)
    if (table && rows >= size1 && rows < total) {
      const m = DATA_LINE.exec(line)
      if (m) {
        const r = Number(m[1])
        const g = Number(m[2])
        const b = Number(m[3])
        if (Math.abs(r) <= CUBE_LIMITS.maxAbs && Math.abs(g) <= CUBE_LIMITS.maxAbs && Math.abs(b) <= CUBE_LIMITS.maxAbs) {
          const k = (rows - size1) * 3
          table[k] = r
          table[k + 1] = g
          table[k + 2] = b
          rows++
          if (end === text.length) break
          continue
        }
      }
    }
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (end === text.length) break
      continue
    }
    // A keyword line; "NaN" and "Infinity" are numbers the data may not hold, so they are read as data and refused there.
    if (KEYWORD_START.test(trimmed) && !NOT_A_NUMBER.test(trimmed.split(SPACE, 1)[0])) {
      const keyword = trimmed.split(SPACE, 1)[0].toUpperCase()
      if (table) throw new CubeError(lineNo, `has the keyword ${shown(keyword)} after the data`)
      if (seen.has(keyword)) throw new CubeError(lineNo, `repeats ${shown(keyword)}`)
      seen.add(keyword)
      if (keyword === 'TITLE') {
        const rest = trimmed.slice(5).trim()
        const close = rest.indexOf('"', 1)
        if (!rest.startsWith('"') || close < 0) throw new CubeError(lineNo, 'has a TITLE without quotes')
        const after = rest.slice(close + 1).trim()
        if (after !== '' && !after.startsWith('#')) throw new CubeError(lineNo, 'has text after the TITLE')
        const raw = rest.slice(1, close)
        if (raw.length > CUBE_LIMITS.titleMax) throw new CubeError(lineNo, `has a TITLE longer than ${CUBE_LIMITS.titleMax} characters`)
        title = [...raw.replace(UNSAFE_TEXT, '')].slice(0, CUBE_LIMITS.titleShown).join('')
      } else {
        const hash = trimmed.indexOf('#')
        const tokens = (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim().split(SPACE).slice(1)
        switch (keyword) {
          case 'LUT_3D_SIZE':
            size3 = size(tokens, lineNo, CUBE_LIMITS.size3d, 'LUT_3D_SIZE')
            break
          case 'LUT_1D_SIZE':
            size1 = size(tokens, lineNo, CUBE_LIMITS.size1d, 'LUT_1D_SIZE')
            break
          case 'DOMAIN_MIN':
          case 'DOMAIN_MAX': {
            if (seen.has('LUT_3D_INPUT_RANGE')) throw new CubeError(lineNo, "sets the table's range twice")
            const v = numbers(tokens, 3, lineNo, keyword) as [number, number, number]
            if (keyword === 'DOMAIN_MIN') domainMin = v
            else domainMax = v
            if (seen.has('DOMAIN_MIN') && seen.has('DOMAIN_MAX')) span(domainMin, domainMax, lineNo)
            break
          }
          case 'LUT_3D_INPUT_RANGE': {
            if (seen.has('DOMAIN_MIN') || seen.has('DOMAIN_MAX')) throw new CubeError(lineNo, "sets the table's range twice")
            const [lo, hi] = numbers(tokens, 2, lineNo, keyword)
            span([lo], [hi], lineNo)
            domainMin = [lo, lo, lo]
            domainMax = [hi, hi, hi]
            break
          }
          case 'LUT_1D_INPUT_RANGE': {
            const [lo, hi] = numbers(tokens, 2, lineNo, keyword)
            span([lo], [hi], lineNo)
            shaperMin = lo
            shaperMax = hi
            break
          }
          case 'LUT_IN_VIDEO_RANGE':
          case 'LUT_OUT_VIDEO_RANGE':
            break
          default:
            throw new CubeError(lineNo, `has the unknown keyword ${shown(keyword)}`)
        }
      }
      if (end === text.length) break
      continue
    }
    // A line of data.
    if (!table) {
      if (!size3) throw new CubeError(lineNo, 'has data before LUT_3D_SIZE')
      if (seen.has('DOMAIN_MIN') !== seen.has('DOMAIN_MAX')) throw new CubeError(lineNo, 'has data after only one of DOMAIN_MIN and DOMAIN_MAX')
      table = new Float32Array(size3 * size3 * size3 * 3)
      shaper = size1 ? new Float32Array(size1 * 3) : null
      total = size1 + size3 * size3 * size3
    }
    if (rows >= total) throw new CubeError(lineNo, `is one more line of data than the ${total.toLocaleString('en-US')} the sizes give`)
    const hash = trimmed.indexOf('#')
    const tokens = (hash >= 0 ? trimmed.slice(0, hash).trim() : trimmed).split(SPACE)
    if (tokens.length !== 3) throw new CubeError(lineNo, `has ${tokens.length} ${tokens.length === 1 ? 'number' : 'numbers'}, not 3`)
    const r = number(tokens[0], lineNo)
    const g = number(tokens[1], lineNo)
    const b = number(tokens[2], lineNo)
    if (rows < size1) {
      shaper![rows * 3] = r
      shaper![rows * 3 + 1] = g
      shaper![rows * 3 + 2] = b
    } else {
      const k = (rows - size1) * 3
      table[k] = r
      table[k + 1] = g
      table[k + 2] = b
    }
    rows++
    if (end === text.length) break
  }
  if (!size3) throw new CubeError(0, 'it has no LUT_3D_SIZE')
  if (!table || rows < total) throw new CubeError(lineNo, `ends after ${rows.toLocaleString('en-US')} of ${(total || size1 + size3 ** 3).toLocaleString('en-US')} lines of data`)
  return {
    title,
    size: size3,
    data: table,
    shaper: shaper ? { size: size1, data: shaper, min: shaperMin, max: shaperMax } : null,
    domainMin,
    domainMax
  }
}
