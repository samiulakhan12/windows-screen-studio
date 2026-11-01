/**
 * Fonts per word (docs/design/captions-studio.md §6.5, §6.6, §0.2): the face a word draws with, the
 * fallback chain, weights clamped to what a font has, partners for missing letters, and the
 * per-script rules. A canvas font string carries one weight for its whole stack, so each word gets
 * its own face: the font that draws the word's script goes first, and the weight is clamped
 * against that font (a Bangla word in Bold Pop draws in Baloo Da 2 at 800, an English word in
 * Montserrat at 900). Pure.
 */
import type { CaptionStudio, ProjectFont } from '../types'
import { catalogFamily, catalogFont, catalogId, type FontCoverage } from './fontCatalog'
import { CAPTION_FONT } from './layout'
import type { StudioFace } from './studioLayout'
import type { ScriptTag } from './words'

/** The family a brand font is registered under for Studio looks, with its real weights (§6.7). */
export const studioBrandFamily = (id: string): string => `FlownFontW-${id}`

/** The emoji font, always after the text fonts (§6.6 rule 4). */
const EMOJI = 'cat:noto-color-emoji'

/** The bundled script fonts of §6.2 by script (rule 3), and Bangla's default (§0.2: any other look). */
const SCRIPT_FONTS: Partial<Record<ScriptTag, string>> = {
  bengali: 'cat:noto-sans-bengali',
  devanagari: 'cat:noto-sans-devanagari',
  arabic: 'cat:noto-sans-arabic',
  hebrew: 'cat:noto-sans-hebrew',
  thai: 'cat:noto-sans-thai'
}

/** Coverage a catalogue font needs to draw a script itself. */
const COVERAGE_OF: Partial<Record<ScriptTag, FontCoverage[]>> = {
  latin: ['latin'],
  cyrillic: ['cyrillic'],
  greek: ['greek'],
  bengali: ['bengali'],
  devanagari: ['devanagari'],
  arabic: ['arabic'],
  hebrew: ['hebrew'],
  thai: ['thai'],
  han: ['han-sc', 'han-tc', 'japanese', 'korean'],
  kana: ['japanese'],
  hangul: ['korean']
}

/** Windows fonts by script (rule 5): every Windows 10 and 11 PC has them. */
const WINDOWS_FONTS: Partial<Record<ScriptTag, string[]>> = {
  tamil: ['Nirmala UI'],
  telugu: ['Nirmala UI'],
  bengali: ['Nirmala UI'],
  devanagari: ['Nirmala UI'],
  thai: ['Leelawadee UI'],
  han: ['Microsoft YaHei UI', 'Microsoft JhengHei UI', 'Yu Gothic UI', 'Malgun Gothic'],
  kana: ['Yu Gothic UI'],
  hangul: ['Malgun Gothic']
}

/** The CJK font of a caption language (§6.4): its catalogue download and the Windows font until then. */
function cjkFont(script: ScriptTag, language: string | undefined): { id: string; windows: string } {
  const lang = (language ?? '').toLowerCase()
  if (script === 'kana' || lang === 'ja' || lang.startsWith('ja-')) return { id: 'noto-sans-jp', windows: 'Yu Gothic UI' }
  if (script === 'hangul' || lang === 'ko' || lang.startsWith('ko-')) return { id: 'noto-sans-kr', windows: 'Malgun Gothic' }
  if (/^zh-(hant|tw|hk|mo)/.test(lang)) return { id: 'noto-sans-tc', windows: 'Microsoft JhengHei UI' }
  return { id: 'noto-sans-sc', windows: 'Microsoft YaHei UI' }
}

/** A family quoted for a CSS font stack. */
const quote = (family: string): string => `'${family.replace(/'/g, '')}'`

/** The family of a look font ('cat:<id>', a brand font id, 'system'), or null for the default caption font. */
function familyOf(font: string, fonts: readonly ProjectFont[] | undefined): string | null {
  const id = catalogId(font)
  if (id) return catalogFamily(id)
  if (font !== 'system' && fonts?.some((f) => f.id === font)) return studioBrandFamily(font)
  return null
}

/** The catalogue coverage of a look font; brand fonts and the system font are taken to draw Latin only. */
function coverageOf(font: string): readonly FontCoverage[] {
  const id = catalogId(font)
  return id ? (catalogFont(id)?.coverage ?? ['latin']) : ['latin']
}

/** Whether a look font draws `script` itself (then no script font goes before it). */
function draws(font: string, script: ScriptTag): boolean {
  const need = COVERAGE_OF[script]
  if (!need) return false
  const have = coverageOf(font)
  return need.some((c) => have.includes(c))
}

/** `weight` clamped to the weights `font` has ('cat:<id>'): the nearest file (the heavier on a tie), or the range (§6.5). Other fonts: 1..1000. */
export function clampWeight(font: string, weight: number): number {
  const w = Number.isFinite(weight) ? weight : 400
  const id = catalogId(font)
  const f = id ? catalogFont(id) : undefined
  if (!f) return Math.min(1000, Math.max(1, w))
  const ws = f.weights
  if (!Array.isArray(ws)) {
    const r = ws as { min: number; max: number }
    return Math.min(r.max, Math.max(r.min, w))
  }
  let best = ws[0]
  for (const x of ws) if (Math.abs(x - w) < Math.abs(best - w) || (Math.abs(x - w) === Math.abs(best - w) && x > best)) best = x
  return best
}

/** Languages and the coverage they need beyond Latin (§6.6). */
const LANGUAGE_NEEDS: Record<string, FontCoverage> = {
  vi: 'vietnamese',
  ru: 'cyrillic',
  uk: 'cyrillic',
  be: 'cyrillic',
  bg: 'cyrillic',
  sr: 'cyrillic',
  mk: 'cyrillic',
  kk: 'cyrillic',
  el: 'greek',
  pl: 'latin-ext',
  tr: 'latin-ext',
  cs: 'latin-ext',
  sk: 'latin-ext',
  sl: 'latin-ext',
  hr: 'latin-ext',
  hu: 'latin-ext',
  ro: 'latin-ext',
  lt: 'latin-ext',
  lv: 'latin-ext',
  et: 'latin-ext',
  az: 'latin-ext'
}

/** The coverage a caption needs beyond Latin (§6.6): vi Vietnamese; ru and uk Cyrillic; pl, tr and any Latin letter outside Latin-1 Latin ext; Greek letters Greek. */
export function coverageNeeded(language: string | undefined, text: string): string[] {
  const out = new Set<string>()
  const base = (language ?? '').toLowerCase().split(/[-_]/)[0]
  const byLang = LANGUAGE_NEEDS[base]
  if (byLang) out.add(byLang)
  if (/[\p{Script=Cyrillic}]/u.test(text)) out.add('cyrillic')
  if (/[\p{Script=Greek}]/u.test(text)) out.add('greek')
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c > 0xff && /\p{Script=Latin}/u.test(ch)) {
      // Vietnamese letters (Latin Extended Additional, U+1EA0–U+1EF9) need the Vietnamese set, others Latin ext.
      out.add(c >= 0x1ea0 && c <= 0x1ef9 ? 'vietnamese' : 'latin-ext')
    }
  }
  return [...out]
}

/** The look's font, or its partner when it lacks what `needs` asks for (§6.6); partners of partners until one has it, else Inter Tight. */
export function partnerFor(font: string, needs: string[]): string {
  const lacks = (f: string): boolean => {
    const have = coverageOf(f)
    return needs.some((n) => !have.includes(n as FontCoverage))
  }
  if (!catalogId(font) || !needs.length || !lacks(font)) return font
  let f = font
  const seen = new Set<string>([f])
  while (lacks(f)) {
    const partner = catalogFont(catalogId(f)!)?.partner
    const next = partner ? `cat:${partner}` : 'cat:inter-tight'
    if (seen.has(next)) return next
    seen.add(next)
    f = next
  }
  return f
}

/** Scripts written with joined letters or vowel signs around them: letter spacing 0 (§6.6). */
const NO_TRACKING: ReadonlySet<ScriptTag> = new Set(['arabic', 'hebrew', 'bengali', 'devanagari', 'tamil', 'telugu'])

/** The line height raised for a script (§6.6, §0.2: Arabic and Hebrew 1.5, Bangla and the Indic scripts 1.4, Thai 1.45). */
export function scriptLineHeight(script: ScriptTag, lineHeight: number): number {
  if (script === 'arabic' || script === 'hebrew') return Math.max(lineHeight, 1.5)
  if (script === 'bengali' || script === 'devanagari' || script === 'tamil' || script === 'telugu') return Math.max(lineHeight, 1.4)
  if (script === 'thai') return Math.max(lineHeight, 1.45)
  return lineHeight
}

/** The letter spacing for a script (0 in joined scripts and with vowel signs, §6.6). */
export function trackingFor(script: ScriptTag, tracking: number): number {
  return NO_TRACKING.has(script) ? 0 : tracking
}

/** Largest a Bangla word grows, emphasised or spoken (§0.2: colour, size ×1.14 at most and weight, never case). */
export const BANGLA_SCALE_MAX = 1.14
/**
 * Thickest Bangla outline outside the glyph, em (§0.2: "about 0.08 em, 2.5 px at 30 px" is the
 * whole stroke; half of it lies outside the letter): joined letters stay clear.
 */
export const BANGLA_OUTLINE_MAX = 0.042

/** How much bigger a word of `script` may draw than its text (emphasis scale, spoken scale). */
export function scriptScale(script: ScriptTag, scale: number): number {
  return script === 'bengali' ? Math.min(scale, BANGLA_SCALE_MAX) : scale
}

/** The outline (em) a word of `script` draws with. */
export function scriptOutline(script: ScriptTag, outline: number): number {
  return script === 'bengali' ? Math.min(outline, BANGLA_OUTLINE_MAX) : outline
}

/** The font that draws `script` first when the look's font lacks it (rule 1), with its weight and width; null when none goes first. */
function scriptFirst(
  studio: CaptionStudio,
  role: 'text' | 'emphasis',
  font: string,
  weight: number,
  script: ScriptTag,
  ctx: { language?: string; downloaded: (id: string) => boolean }
): { font: string; weight: number; width?: number } | { windows: string } | null {
  if (draws(font, script)) return null
  if (script === 'bengali') {
    // §0.2: the look's own Bangla font (emphasised words at the heavier of both weights), else Noto Sans Bengali.
    const own = studio.text.scripts?.bengali
    if (own && catalogId(own.font)) return { font: own.font, weight: role === 'emphasis' ? Math.max(own.weight, studio.emphasis.weight) : own.weight, ...(own.width ? { width: own.width } : {}) }
    return { font: SCRIPT_FONTS.bengali!, weight }
  }
  if (script === 'devanagari') {
    const lang = (ctx.language ?? '').toLowerCase().split(/[-_]/)[0]
    if ((lang === 'hi' || lang === 'mr') && weight >= 600 && weight <= 800) return { font: 'cat:poppins', weight }
    return { font: SCRIPT_FONTS.devanagari!, weight }
  }
  const own = SCRIPT_FONTS[script]
  if (own) return { font: own, weight }
  if (script === 'han' || script === 'kana' || script === 'hangul') {
    const cjk = cjkFont(script, ctx.language)
    return ctx.downloaded(cjk.id) ? { font: `cat:${cjk.id}`, weight } : { windows: cjk.windows }
  }
  const windows = WINDOWS_FONTS[script]
  return windows ? { windows: windows[0] } : null
}

/**
 * The font stack of §6.6 for words of `script` in a caption with `scripts`, `first` going before the
 * look's font; `bengali` is the look's Bangla font (§0.2), which draws the Bangla of a mixed word
 * ('Windows-এ') as it draws the Bangla words around it.
 */
function stackFor(
  font: string,
  script: ScriptTag,
  first: ReturnType<typeof scriptFirst>,
  ctx: { language?: string; scripts: Set<ScriptTag>; fonts?: readonly ProjectFont[]; downloaded: (id: string) => boolean },
  bengali: string | undefined
): string {
  const families: string[] = []
  const add = (f: string | null): void => {
    if (f && !families.includes(f)) families.push(f)
  }
  // 1. The script's font, when the look's font lacks the script.
  if (first) add('font' in first ? familyOf(first.font, ctx.fonts) : first.windows)
  // 2. The look's font (or its partner, chosen by the caller).
  add(familyOf(font, ctx.fonts))
  // 3. The other bundled script fonts, for the other scripts of the caption.
  for (const s of ctx.scripts) {
    if (s === script) continue
    const f = s === 'bengali' && bengali && catalogId(bengali) ? bengali : SCRIPT_FONTS[s]
    if (f) add(familyOf(f, ctx.fonts))
    if (s === 'han' || s === 'kana' || s === 'hangul') {
      const cjk = cjkFont(s, ctx.language)
      if (ctx.downloaded(cjk.id)) add(catalogFamily(cjk.id))
    }
  }
  // 4. The colour emoji, after the text fonts.
  add(catalogFamily(catalogId(EMOJI)!))
  // 5. The language's Windows fonts.
  for (const s of [script, ...ctx.scripts]) for (const w of WINDOWS_FONTS[s] ?? []) add(w)
  if (ctx.scripts.has('han') || script === 'han') add(cjkFont('han', ctx.language).windows)
  add('Segoe UI')
  return [...families.map(quote), CAPTION_FONT].join(', ')
}

/** The look's font for `role` with its partner for the caption's letters (rule 2), and its weight. */
function lookFont(studio: CaptionStudio, role: 'text' | 'emphasis', ctx: { language?: string; scripts: Set<ScriptTag> }): { font: string; weight: number } {
  const font = role === 'emphasis' ? (studio.emphasis.font ?? studio.text.font) : studio.text.font
  const weight = role === 'emphasis' ? studio.emphasis.weight : studio.text.weight
  const needs = coverageNeeded(ctx.language, '')
  if (ctx.scripts.has('cyrillic') && !needs.includes('cyrillic')) needs.push('cyrillic')
  if (ctx.scripts.has('greek') && !needs.includes('greek')) needs.push('greek')
  return { font: partnerFor(font, needs), weight }
}

/**
 * The face a word of `script` draws with (§6.5): the font that draws its script first (the look's
 * Bangla font for Bangla, §0.2), the weight clamped against that font, the letter spacing of the
 * script, and the font's width when the look asks for one (Stacked's Anek Bangla at 75).
 */
export function wordFace(
  studio: CaptionStudio,
  role: 'text' | 'emphasis',
  script: ScriptTag,
  ctx: { language?: string; scripts: Set<ScriptTag>; fonts?: readonly ProjectFont[]; downloaded: (id: string) => boolean }
): StudioFace {
  const look = lookFont(studio, role, ctx)
  const first = scriptFirst(studio, role, look.font, look.weight, script, ctx)
  const drawn = first && 'font' in first ? first : null
  const weight = clampWeight(drawn ? drawn.font : look.font, drawn ? drawn.weight : look.weight)
  return {
    stack: stackFor(look.font, script, first, ctx, studio.text.scripts?.bengali?.font),
    weight,
    tracking: trackingFor(script, studio.text.tracking),
    ...(drawn?.width ? { stretch: drawn.width } : {})
  }
}

/** The font stack of §6.6 for the look's text or emphasis, for the caption's main script. */
export function studioFontStack(
  studio: CaptionStudio,
  role: 'text' | 'emphasis',
  ctx: { language?: string; scripts: Set<ScriptTag>; main: { script: ScriptTag; share: number }; fonts?: readonly ProjectFont[]; downloaded: (id: string) => boolean }
): string {
  const look = lookFont(studio, role, ctx)
  return stackFor(look.font, ctx.main.script, scriptFirst(studio, role, look.font, look.weight, ctx.main.script, ctx), ctx, studio.text.scripts?.bengali?.font)
}
