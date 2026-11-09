/**
 * Tokens estimated from characters (docs/design/smart-tools.md §11.2): nothing is sent to count them.
 * The text is split by script and each run divided by its characters per token for the tokenizer's
 * family: OpenAI's o200k (OpenAI, Gemini and services), Claude's (o200k's count × 1.3: Anthropic's
 * newer tokenizer counts about 30% more), and Qwen's and Gemma's (AI on this PC). Letters and spaces
 * of Latin text are one run; digits, punctuation and JSON structure (what the prompts' data blocks
 * are made of) another, as they take far more tokens a character. A script not measured for a
 * family uses o200k's value. Pure.
 *
 * The ratios were measured with the tokenizers themselves (tiktoken's o200k_base, and the
 * tokenizer.json of Qwen3.5 2B and of Gemma 4 E2B) on screen-recording narration in English,
 * Bangla, Hindi, Arabic, Japanese, Chinese, Korean, Russian, Thai and mixed Bangla and English, and
 * on a caption JSON block; tests/fixtures/tokenSamples.json keeps the texts and their counts (§22
 * test 90). They replace the first table's CJK, Hangul and Thai values, which counted about a third
 * fewer tokens than the tokenizers do.
 */
import type { ScriptTag } from '../captions/words'
import type { AiProviderKind } from '../types'
import type { PriceEntry } from './prices'

export type TokenFamily = 'o200k' | 'claude' | 'qwen' | 'gemma'

/** o200k's characters per token by script; scripts not measured by their nearest kin. */
const O200K: Readonly<Record<ScriptTag, number>> = {
  latin: 5.0,
  cyrillic: 3.69,
  greek: 3.0,
  arabic: 3.2,
  hebrew: 3.2,
  devanagari: 2.88,
  tamil: 2.88,
  telugu: 2.88,
  bengali: 2.65,
  thai: 2.35,
  hangul: 1.54,
  han: 1.61,
  kana: 1.41,
  // Scripts Flown does not tell apart (Georgian, Ethiopic, emoji): counted generously.
  other: 1.5
}

/** Claude: o200k ÷ 1.3, to two decimals (§11.2). */
const claude = (r: number): number => Math.round((r / 1.3) * 100) / 100
const CLAUDE = Object.fromEntries(Object.entries(O200K).map(([k, v]) => [k, claude(v)])) as Record<ScriptTag, number>

export const TOKEN_RATIOS: Readonly<Record<TokenFamily, Partial<Record<ScriptTag, number>>>> = {
  o200k: O200K,
  claude: CLAUDE,
  qwen: { latin: 4.74, cyrillic: 4.14, arabic: 3.53, devanagari: 2.05, bengali: 1.99, thai: 3.59, hangul: 1.78, han: 1.86, kana: 2.42 },
  gemma: { latin: 4.52, cyrillic: 4.02, arabic: 2.99, devanagari: 3.86, bengali: 3.66, thai: 2.75, hangul: 1.65, han: 1.63, kana: 2.49 }
}

/** Characters per token of digits, punctuation and symbols (JSON structure, times, ids), by family. */
export const PUNCT_RATIOS: Readonly<Record<TokenFamily, number>> = { o200k: 1.66, claude: claude(1.66), qwen: 1.74, gemma: 1.83 }

/** What a character counts as: a script's letter, or digits and punctuation. */
export type TokenRun = ScriptTag | 'punct'

/** Characters per token of `run` for `family`: its own measure, else o200k's. */
export function tokenRatio(run: TokenRun, family: TokenFamily): number {
  if (run === 'punct') return PUNCT_RATIOS[family]
  return TOKEN_RATIOS[family][run] ?? O200K[run]
}

/** The family whose tokenizer a provider's model uses: Claude's for Claude, o200k for OpenAI, Gemini and services. */
export function tokenFamily(kind: AiProviderKind | 'local', model = ''): TokenFamily {
  if (kind === 'anthropic') return 'claude'
  if (kind === 'local') return /^qwen/i.test(model) ? 'qwen' : 'gemma'
  return 'o200k'
}

/** What code point `c` (not ASCII) counts as, by its Unicode block. */
function runOfCode(c: number): TokenRun {
  if (c < 0x0100) return c >= 0xc0 && c !== 0xd7 && c !== 0xf7 ? 'latin' : c === 0xa0 ? 'latin' : 'punct'
  if (c < 0x0370) return 'latin'
  if (c < 0x0400) return 'greek'
  if (c < 0x0530) return 'cyrillic'
  if (c >= 0x0590 && c < 0x0600) return 'hebrew'
  if (c >= 0x0600 && c < 0x0780) return 'arabic'
  if (c >= 0x08a0 && c < 0x0900) return 'arabic'
  // The dandas (। ॥) end Bangla and Hindi sentences alike: punctuation.
  if (c === 0x0964 || c === 0x0965) return 'punct'
  if (c >= 0x0900 && c < 0x0980) return 'devanagari'
  if (c >= 0x0980 && c < 0x0a00) return 'bengali'
  if (c >= 0x0b80 && c < 0x0c00) return 'tamil'
  if (c >= 0x0c00 && c < 0x0c80) return 'telugu'
  if (c >= 0x0e00 && c < 0x0e80) return 'thai'
  if (c >= 0x1100 && c < 0x1200) return 'hangul'
  if (c >= 0x1e00 && c < 0x1f00) return 'latin'
  if (c >= 0x1f00 && c < 0x2000) return 'greek'
  if (c >= 0x2000 && c < 0x2c00) return 'punct'
  if (c >= 0x3000 && c < 0x3040) return 'punct'
  if (c >= 0x3040 && c < 0x3100) return 'kana'
  if (c >= 0x3130 && c < 0x3190) return 'hangul'
  if (c >= 0x31f0 && c < 0x3200) return 'kana'
  if (c >= 0x3400 && c < 0x4dc0) return 'han'
  if (c >= 0x4e00 && c < 0xa000) return 'han'
  if (c >= 0xac00 && c < 0xd7b0) return 'hangul'
  if (c >= 0xf900 && c < 0xfb00) return 'han'
  if (c >= 0xfb1d && c < 0xfb50) return 'hebrew'
  if (c >= 0xfb50 && c < 0xfe00) return 'arabic'
  if (c >= 0xfe70 && c < 0xff00) return 'arabic'
  if (c >= 0xff00 && c < 0xff66) return 'punct'
  if (c >= 0xff66 && c < 0xffa0) return 'kana'
  if (c >= 0x20000 && c < 0x30000) return 'han'
  return 'other'
}

/** ASCII letters, spaces, tabs and line breaks: Latin letters; every other ASCII character punctuation. */
const ASCII_LETTER = new Uint8Array(128)
for (let c = 0; c < 128; c++) ASCII_LETTER[c] = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32 || c === 9 || c === 10 || c === 13 ? 1 : 0

/** Characters of `text` by what they count as (code points). */
export function scriptChars(text: string): Map<TokenRun, number> {
  const counts = new Map<TokenRun, number>()
  let latin = 0
  let punct = 0
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c < 0x80) {
      if (ASCII_LETTER[c]) latin++
      else punct++
      continue
    }
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
        i++
      }
    }
    const run = runOfCode(c)
    if (run === 'latin') latin++
    else if (run === 'punct') punct++
    else counts.set(run, (counts.get(run) ?? 0) + 1)
  }
  if (latin) counts.set('latin', latin)
  if (punct) counts.set('punct', punct)
  return counts
}

/** About how many tokens `text` takes with `family`'s tokenizer. */
export function estimateTokens(text: string, family: TokenFamily): number {
  if (!text) return 0
  let tokens = 0
  for (const [run, n] of scriptChars(text)) tokens += n / tokenRatio(run, family)
  return Math.ceil(tokens)
}

/** Characters per token of `text` as a whole for `family` (its runs blended); Latin's for no text. */
export function blendedRatio(text: string, family: TokenFamily): number {
  let chars = 0
  let tokens = 0
  for (const [run, n] of scriptChars(text)) {
    chars += n
    tokens += n / tokenRatio(run, family)
  }
  return tokens > 0 ? chars / tokens : tokenRatio('latin', family)
}

/**
 * The pixel size of a JPEG (the pictures sent for titles, §5.3.1) from its first frame header (SOF0
 * to SOF15, not DHT, JPG or DAC), walking the markers from the start; null when it cannot be read.
 */
export function jpegSize(data: Uint8Array): { w: number; h: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
  for (let i = 2; i + 9 < data.length; ) {
    if (data[i] !== 0xff) return null
    const marker = data[i + 1]
    // Fill bytes before a marker.
    if (marker === 0xff) {
      i++
      continue
    }
    const len = (data[i + 2] << 8) | data[i + 3]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (data[i + 5] << 8) | data[i + 6]
      const w = (data[i + 7] << 8) | data[i + 8]
      return w > 0 && h > 0 ? { w, h } : null
    }
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

/** Tiles of `tile` px covering `w` × `h`. */
const tiles = (w: number, h: number, tile: number): number => Math.ceil(w / tile) * Math.ceil(h / tile)

/**
 * Tokens one picture of `size` takes (§5.3.1, §11.2): the price list's own rule for the model when
 * it has one (`base` plus `perTile` for each `tile`-pixel tile); else each provider's published rule:
 * OpenAI and services 85 + 170 a 512 px tile after fitting 2048 px and then 768 px on the short side;
 * Gemini 258 a 768 px tile (one for a picture of 384 px or less); Claude width × height ÷ 750 after
 * fitting 1568 px.
 */
export function imageTokens(kind: AiProviderKind, size: { w: number; h: number }, rule?: PriceEntry['imageTokens']): number {
  let w = Math.max(1, Math.round(size.w))
  let h = Math.max(1, Math.round(size.h))
  if (rule) return Math.ceil(rule.base + rule.perTile * tiles(w, h, rule.tile))
  if (kind === 'gemini') return w <= 384 && h <= 384 ? 258 : 258 * tiles(w, h, 768)
  if (kind === 'anthropic') {
    const s = Math.min(1, 1568 / Math.max(w, h))
    return Math.ceil((Math.round(w * s) * Math.round(h * s)) / 750)
  }
  const fit = Math.min(1, 2048 / Math.max(w, h))
  w *= fit
  h *= fit
  const short = Math.min(1, 768 / Math.min(w, h))
  return 85 + 170 * tiles(Math.round(w * short), Math.round(h * short), 512)
}

/** Scripts written without spaces between words: their words need a segmenter. */
const UNSPACED = /[฀-๿぀-ヿ㐀-䶿一-鿿豈-﫿က-႟຀-໿ក-៿]/
/** A run of letters, marks or digits (a word, where words are spaced). */
const WORD_RUN = /[\p{L}\p{M}\p{N}]+(?:['’.\-_][\p{L}\p{M}\p{N}]+)*/gu

let segmenter: Intl.Segmenter | null = null

/** Words of `text`: by Intl.Segmenter where a script is written without spaces, else runs of letters and digits. */
export function countWords(text: string): number {
  if (!text) return 0
  if (UNSPACED.test(text) && typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' })
    let n = 0
    for (const s of segmenter.segment(text)) if (s.isWordLike) n++
    return n
  }
  return text.match(WORD_RUN)?.length ?? 0
}
