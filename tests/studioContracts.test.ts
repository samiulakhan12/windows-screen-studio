import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PREF_KEYS } from '../src/shared/api/prefs'
import { CATALOG_FONTS, catalogFont, catalogId, fontSources, GOOGLE_FONTS_COMMIT, NOTO_EMOJI_COMMIT } from '../src/shared/captions/fontCatalog'
import { EMOJI_KEYS, EMOJI_LIST } from '../src/shared/captions/emojiList'
import { readCaptionStudio } from '../src/shared/captions/studioData'
import { GRADIENTS, LEGACY_TILES, LINE_LENGTHS, SPEAKER_PALETTE, STUDIO_BASE, STUDIO_PRESETS, studioPreset, THEMES } from '../src/shared/captions/studioPresets'
import { COMMANDS } from '../src/shared/editor/commands'
import { DEFAULT_POLISH_OPTIONS, planPolish, polishAvailability, POLISH_STEPS } from '../src/shared/editor/polish'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import type { CaptionStudio, CursorTrack, Project } from '../src/shared/types'

/*
 * The contracts of Captions Studio (docs/design/captions-studio.md §14.0, §0): the font catalogue
 * against the committed files, the gallery's looks against the readers, the design's lists and
 * the contrast rule of §7.2, the emoji list against its generator, and the commands, preferences
 * and Polish step the parts build on.
 */

const ROOT = path.join(__dirname, '..')
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/* ---------- the font catalogue (§6, §0.1, §0.2, §0.3) ---------- */

describe('the font catalogue', () => {
  const bundled = CATALOG_FONTS.filter((f) => f.bundled)

  it('has every font of §6, the fonts of the approved looks and the nine Bangla families, with unique ids', () => {
    const ids = CATALOG_FONTS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    // §6.1 (14 families in 17 files), §6.2, §6.3, §6.4.
    for (const id of ['montserrat', 'inter-tight', 'poppins', 'anton', 'bebas-neue', 'oswald', 'nunito', 'outfit', 'bangers', 'luckiest-guy', 'permanent-marker', 'caveat', 'jetbrains-mono', 'instrument-serif', 'instrument-serif-italic']) expect(ids, id).toContain(id)
    for (const id of ['noto-sans-bengali', 'noto-sans-devanagari', 'noto-sans-arabic', 'noto-sans-hebrew', 'noto-sans-thai', 'baloo-da-2', 'noto-color-emoji']) expect(ids, id).toContain(id)
    for (const id of ['noto-sans-sc', 'noto-sans-tc', 'noto-sans-jp', 'noto-sans-kr']) expect(catalogFont(id)?.bundled, id).toBe(false)
    // §0.1: the fonts the eleven approved looks draw with.
    for (const id of ['archivo-black', 'lilita-one', 'press-start-2p', 'rubik', 'playfair-display', 'fredoka']) expect(catalogFont(id)?.bundled, id).toBe(true)
    // §0.2: all nine Bangla families, with the weights the owner listed.
    const bangla = CATALOG_FONTS.filter((f) => f.coverage.includes('bengali')).map((f) => f.family)
    expect(new Set(bangla)).toEqual(new Set(['Noto Sans Bengali', 'Baloo Da 2', 'Hind Siliguri', 'Anek Bangla', 'Noto Serif Bengali', 'Tiro Bangla', 'Galada', 'Atma', 'Mina']))
    expect(catalogFont('hind-siliguri')!.weights).toEqual([400, 600, 700])
    expect(catalogFont('atma')!.weights).toEqual([500, 700])
    expect(catalogFont('mina')!.weights).toEqual([400, 700])
    expect(catalogFont('anek-bangla')!.stretch).toEqual({ min: 75, max: 125 })
    expect(catalogFont('tiro-bangla-italic')!.italic).toBe(true)
  })

  it("pins the design's files: the upstream TTFs of §6 by bytes and SHA-256", () => {
    const pins: Record<string, [number, string]> = {
      'ofl/montserrat/Montserrat[wght].ttf': [744936, '0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7'],
      'ofl/poppins/Poppins-ExtraBold.ttf': [154836, 'f2ab17c1a63a0ecc12c2461848fc8a469395e3cd2d641803e889c643d9f958e1'],
      'ofl/notosansbengali/NotoSansBengali[wdth,wght].ttf': [463668, 'dcd42978094e584a849c84a51450eeac40c8826057d566ea6d4b9627a403a05a'],
      '2D/fonts/Noto-COLRv1.ttf': [5038236, 'b8e25ea68db82f9e4d0aee921f4420be2be39887bd5c893a2ad98710531f9d0c'],
      'ofl/notosansjp/NotoSansJP[wght].ttf': [9589900, 'c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f']
    }
    const files = CATALOG_FONTS.flatMap((f) => f.files)
    for (const [p, [bytes, hash]] of Object.entries(pins)) expect(files.find((x) => x.path === p), p).toMatchObject({ bytes, sha256: hash })
    // §6.1 + §6.2 + §6.3 sum to the design's totals.
    const sixOne = ['montserrat', 'inter-tight', 'poppins', 'anton', 'bebas-neue', 'oswald', 'nunito', 'outfit', 'bangers', 'luckiest-guy', 'permanent-marker', 'caveat', 'jetbrains-mono', 'instrument-serif', 'instrument-serif-italic']
    const total = (ids: string[]): number => ids.flatMap((id) => catalogFont(id)!.files).reduce((n, x) => n + x.bytes, 0)
    expect(total(sixOne)).toBe(3_560_344)
    expect(total(['noto-sans-bengali', 'noto-sans-devanagari', 'noto-sans-arabic', 'noto-sans-hebrew', 'noto-sans-thai', 'baloo-da-2'])).toBe(2_733_084)
    for (const f of files) {
      expect(f.sha256, f.path).toMatch(/^[0-9a-f]{64}$/)
      expect(f.bytes, f.path).toBeGreaterThan(1000)
    }
  })

  it('every bundled file is committed as a WOFF2 matching its pin, and nothing else is in resources/fonts', () => {
    const dir = path.join(ROOT, 'resources', 'fonts')
    const expected = new Set<string>()
    for (const f of bundled)
      for (const x of f.files) {
        expect(x.woff2, `${f.id} ${x.path}`).toBeDefined()
        const bytes = readFileSync(path.join(dir, x.woff2!.file))
        expect(bytes.length, x.woff2!.file).toBe(x.woff2!.bytes)
        expect(sha256(bytes), x.woff2!.file).toBe(x.woff2!.sha256)
        expect(bytes.toString('latin1', 0, 4)).toBe('wOF2')
        // The WOFF2 holds a font exactly as big as the pinned TTF (its tables, kept byte for byte).
        expect(bytes.readUInt32BE(16), x.woff2!.file).toBe(x.bytes)
        expected.add(x.woff2!.file)
      }
    expect(new Set(readdirSync(dir).filter((f) => f.endsWith('.woff2')))).toEqual(expected)
    expect(readdirSync(dir).sort()).toEqual([...expected, 'FONTS.md', 'LICENSES'].sort())
    expect(readdirSync(path.join(dir, 'LICENSES')).sort()).toEqual(['Apache-2.0.txt', 'OFL-1.1.txt'])
    // Downloaded fonts are not bundled and have no WOFF2.
    for (const f of CATALOG_FONTS.filter((x) => !x.bundled)) for (const x of f.files) expect(x.woff2).toBeUndefined()
  })

  it('downloads only from the pinned commits, with [ and ] written %5B and %5D', () => {
    const jp = catalogFont('noto-sans-jp')!
    expect(fontSources(jp)).toEqual([`https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf`])
    expect(fontSources(catalogFont('noto-color-emoji')!)).toEqual([`https://raw.githubusercontent.com/googlefonts/noto-emoji/${NOTO_EMOJI_COMMIT}/2D/fonts/Noto-COLRv1.ttf`])
    for (const f of CATALOG_FONTS)
      for (const x of f.files)
        for (const url of fontSources(f, x)) expect(url.startsWith(`https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/`) || url.startsWith(`https://raw.githubusercontent.com/googlefonts/noto-emoji/${NOTO_EMOJI_COMMIT}/`), url).toBe(true)
  })

  it('names licences, partners that exist and Apache-2.0 only for Luckiest Guy and Permanent Marker', () => {
    for (const f of CATALOG_FONTS) {
      if (f.partner) expect(catalogFont(f.partner), `${f.id} partner`).toBeDefined()
      expect(f.coverage.length, f.id).toBeGreaterThan(0)
      expect(f.copyright.length, f.id).toBeGreaterThan(5)
    }
    expect(CATALOG_FONTS.filter((f) => f.licence === 'Apache-2.0').map((f) => f.id).sort()).toEqual(['luckiest-guy', 'permanent-marker'])
    expect(catalogId('cat:montserrat')).toBe('montserrat')
    expect(catalogId('cat:nope')).toBeNull()
    expect(catalogId('montserrat')).toBeNull()
    // The notices name every bundled family.
    const notice = readFileSync(path.join(ROOT, 'resources', 'notices', '34-caption-fonts.txt'), 'utf8')
    for (const f of CATALOG_FONTS) expect(notice, f.family).toContain(f.family)
    expect(notice).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(notice).toContain('Apache License')
  })
})

/* ---------- the gallery's looks (§5, §0.1, §0.2) ---------- */

/** WCAG relative luminance and contrast, and alpha compositing (written here, independent of colors.ts). */
const lin = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const rgb = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const hex = (a: number[]): string => '#' + a.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
const lum = (h: string): number => {
  const [r, g, b] = rgb(h).map(lin)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
const over = (c: string, alpha: number, under: string): string => hex(rgb(c).map((v, i) => v * alpha + rgb(under)[i] * (1 - alpha)))
const WHITE = '#ffffff'
const BLACK = '#000000'

/**
 * The static contrast rule of §7.2: every text colour that can be drawn against its surround over
 * any video (a box at its alpha over white and black, else an outline of 0.04 em or more at its
 * alpha, else the video); upcoming words at their opacity; text on spoken and emphasis boxes and
 * markers against them; hollow words against their halo. The worst pair.
 */
function worstContrast(s: CaptionStudio): { worst: number; what: string } {
  const t = s.theme
  const surrounds = (box: string, alpha: number): string[] => [over(box, alpha, WHITE), over(box, alpha, BLACK)]
  const around = s.box.kind !== 'none' ? surrounds(t.box, s.box.alpha) : s.edge.outline >= 0.04 ? surrounds(t.outline, s.edge.outlineAlpha) : [WHITE, BLACK]
  const pairs: [string, string, string][] = []
  const onSurround = (what: string, colour: string, alpha = 1): void => {
    for (const bg of around) pairs.push([what, alpha < 1 ? over(colour, alpha, bg) : colour, bg])
  }
  const words = t.fill ? t.fill.stops : [t.text]
  for (const c of words) onSurround('text', c)
  if (s.motion.upcoming > 0 && s.motion.upcoming < 1) for (const c of t.upcoming ? [t.upcoming] : words) onSurround('upcoming', c, s.motion.upcoming)
  if (t.upcoming && s.motion.upcoming > 0) onSurround('upcoming', t.upcoming, s.motion.upcoming)
  if (s.edge.hollow) pairs.push(['hollow', t.text, over(BLACK, 0.6, WHITE)])
  const onBox = (what: string, text: string | undefined, box: string): void => void pairs.push([what, text ?? (ratio('#111111', box) >= ratio(WHITE, box) ? '#111111' : WHITE), box])
  if (['color', 'glow', 'weight', 'fill'].includes(s.spoken)) onSurround('spoken', t.spoken)
  if (s.spoken === 'box' || s.spoken === 'pill') onBox('spoken box', t.spokenText, t.spoken)
  if (s.spoken === 'gradient') for (const c of t.gradient ?? []) onSurround('gradient', c)
  for (const [what, colour] of [['emphasis', t.emphasis], ['emphasis2', t.emphasis2]] as const) {
    if (!colour) continue
    if (s.emphasis.mark === 'marker' || s.emphasis.mark === 'box') onBox(`${what} box`, t.emphasisText, colour)
    else if (s.emphasis.mark === 'circle') onSurround(what, t.emphasisText ?? t.text)
    else onSurround(what, colour)
  }
  if (s.box.kind === 'chat' && t.youBox) for (const bg of surrounds(t.youBox, s.box.alpha)) pairs.push(['you', t.youText ?? t.text, bg])
  let worst = Infinity
  let what = ''
  for (const [w, a, b] of pairs) {
    const r = ratio(a, b)
    if (r < worst) {
      worst = r
      what = `${w} ${a} on ${b}`
    }
  }
  return { worst, what }
}

describe('the gallery looks', () => {
  const LONG = ['subtitle', 'karaoke-fill', 'glass', 'highlighter', 'editorial', 'typewriter', 'terminal', 'news']
  const SHORT = ['bold-pop', 'clean-short', 'text-box', 'weight-shift', 'one-word', 'comic', 'stacked', 'highlight-box', 'neon', 'outline', 'handwritten']
  const APPROVED_LONG = ['bubble-speech', 'chat', 'cinema', 'gold', 'circle']
  const APPROVED_SHORT = ['gradient', 'stickers', 'spotlight-word', 'retro-pixel', 'block-3d', 'bubble-round']

  it('are the 19 looks of §5.3–5.4 and the 11 of §0.1, in their groups, with unique ids and names', () => {
    expect(STUDIO_PRESETS.map((p) => p.id)).toEqual([...LONG, ...APPROVED_LONG, ...SHORT, ...APPROVED_SHORT])
    for (const id of [...LONG, ...APPROVED_LONG]) expect(studioPreset(id)!.group, id).toBe('long')
    for (const id of [...SHORT, ...APPROVED_SHORT]) expect(studioPreset(id)!.group, id).toBe('short')
    expect(new Set(STUDIO_PRESETS.map((p) => p.name)).size).toBe(STUDIO_PRESETS.length)
    for (const p of STUDIO_PRESETS) {
      expect(p.look.from, p.id).toBe(p.id)
      expect(LEGACY_TILES.map((t) => t.preset), p.id).toContain(p.fallback)
      expect(p.description.length, p.id).toBeGreaterThan(10)
    }
    expect(LEGACY_TILES.map((t) => t.preset)).toEqual(['clean', 'boxed', 'karaoke', 'minimal', 'bold'])
    expect(studioPreset('nope')).toBeUndefined()
  })

  it('read back unchanged through readCaptionStudio; Subtitle is STUDIO_BASE', () => {
    for (const p of STUDIO_PRESETS) expect(readCaptionStudio(JSON.parse(JSON.stringify(p.look))), p.id).toEqual(p.look)
    expect(STUDIO_BASE).toEqual(studioPreset('subtitle')!.look)
  })

  it('draw with bundled catalogue fonts only, and keep the design values that define them', () => {
    for (const p of STUDIO_PRESETS) {
      const fonts = [p.look.text.font, p.look.emphasis.font, p.look.text.scripts?.bengali?.font].filter((f): f is string => !!f)
      for (const f of fonts) expect(catalogFont(catalogId(f) ?? '')?.bundled, `${p.id} ${f}`).toBe(true)
    }
    const v = (id: string): CaptionStudio => studioPreset(id)!.look
    expect(v('subtitle').text).toMatchObject({ font: 'cat:inter-tight', weight: 600, lineHeight: 1.28, size: 0.05, tall: 1.07 })
    expect(v('subtitle').layout).toMatchObject({ chunk: 'phrase', lines: 2, chars: 42, tallChars: 26, position: 'bottom' })
    expect(v('bold-pop')).toMatchObject({ spoken: 'color', text: { font: 'cat:montserrat', weight: 900, case: 'upper', size: 0.085, tall: 1.26 }, theme: { spoken: '#39e508', emphasis2: '#ff6ad5' }, layout: { chunk: 'words', words: 3, lines: 1 }, motion: { enter: 'pop', tilt: 3, tiltOn: 'emphasis' } })
    expect(v('editorial').emphasis).toMatchObject({ font: 'cat:instrument-serif-italic', scale: 1.6 })
    expect(v('one-word').layout).toMatchObject({ chunk: 'word', position: 'middle', fit: 0.8 })
    expect(v('stacked').layout).toMatchObject({ chunk: 'stack', words: 6, lines: 4, fit: 0.7 })
    expect(v('weight-shift')).toMatchObject({ spoken: 'weight', text: { weight: 400, spokenWeight: 700, case: 'lower' } })
    expect(v('stickers')).toMatchObject({ spoken: 'box', box: { kind: 'word' }, motion: { wordTilt: [-4, 3], spokenScale: 1.12 }, text: { font: 'cat:lilita-one' } })
    expect(v('retro-pixel')).toMatchObject({ text: { font: 'cat:press-start-2p' }, theme: { split: ['#ff004c', '#00e5ff'] } })
    expect(v('block-3d')).toMatchObject({ text: { font: 'cat:rubik', weight: 900, case: 'upper' }, edge: { extrude: { steps: 6 } } })
    expect(v('gold').theme.fill).toEqual({ stops: ['#fff3c4', '#f5c84c', '#b7862b', '#f9e08a'], axis: 'down' })
    expect(v('gradient').theme.fill).toEqual({ stops: ['#ff3dcb', '#ff8a00'], axis: 'across' })
    expect(v('circle').emphasis.mark).toBe('circle')
    expect(v('chat').box.kind).toBe('chat')
    expect(v('bubble-speech').box.kind).toBe('bubble')
    expect(v('spotlight-word')).toMatchObject({ spoken: 'glow', motion: { spokenScale: 1.28 } })
    expect(v('cinema').theme.text).toBe('#ffe680')
  })

  it('give Bangla words the fonts of §0.2', () => {
    const bengali = (id: string): string | undefined => studioPreset(id)!.look.text.scripts?.bengali?.font
    const expected: Record<string, string> = {
      'bold-pop': 'cat:baloo-da-2',
      'karaoke-fill': 'cat:hind-siliguri',
      'highlight-box': 'cat:noto-sans-bengali',
      glass: 'cat:hind-siliguri',
      stacked: 'cat:anek-bangla',
      neon: 'cat:mina',
      handwritten: 'cat:galada',
      comic: 'cat:atma',
      editorial: 'cat:noto-serif-bengali',
      gold: 'cat:noto-serif-bengali',
      subtitle: 'cat:hind-siliguri',
      news: 'cat:hind-siliguri'
    }
    for (const p of STUDIO_PRESETS) expect(bengali(p.id), p.id).toBe(expected[p.id] ?? 'cat:noto-sans-bengali')
    expect(studioPreset('bold-pop')!.look.text.scripts!.bengali).toEqual({ font: 'cat:baloo-da-2', weight: 800 })
    expect(studioPreset('stacked')!.look.text.scripts!.bengali).toEqual({ font: 'cat:anek-bangla', weight: 800, width: 75 })
    for (const id of ['karaoke-fill', 'neon', 'comic', 'editorial', 'gold']) expect(studioPreset(id)!.look.text.scripts!.bengali!.weight, id).toBe(700)
    // Every Bangla font has Bangla letters.
    for (const p of STUDIO_PRESETS) expect(catalogFont(catalogId(bengali(p.id)!)!)!.coverage, p.id).toContain('bengali')
  })

  it('pass the static contrast rule of §7.2 with their own themes (4.5:1)', () => {
    for (const p of STUDIO_PRESETS) {
      const { worst, what } = worstContrast(p.look)
      expect(worst, `${p.id}: ${what}`).toBeGreaterThanOrEqual(4.5)
    }
    // The rule finds the failures the research published, and the approved mock-ups' own colours.
    expect(ratio('#a6a6a6', '#e7e5e7')).toBeCloseTo(1.94, 2)
    expect(ratio(WHITE, '#ff1745')).toBeCloseTo(3.85, 2)
    expect(worstContrast({ ...studioPreset('chat')!.look, theme: { ...studioPreset('chat')!.look.theme, youBox: '#2f7bff' } }).worst).toBeLessThan(4.5)
    expect(worstContrast({ ...studioPreset('bubble-round')!.look, theme: { ...studioPreset('bubble-round')!.look.theme, text: '#ff8fc1' } }).worst).toBeLessThan(4.5)
    expect(worstContrast({ ...studioPreset('block-3d')!.look, theme: { ...studioPreset('block-3d')!.look.theme, outline: '#7a1b3a' } }).worst).toBeLessThan(4.5)
  })

  it('have the themes, gradients, speaker palette and line lengths of §7 and §2.6', () => {
    expect(THEMES.map((t) => t.name)).toEqual(['Classic', 'Lime', 'Cyan', 'Sunset', 'Candy', 'Mono', 'Ink (dark on light)'])
    for (const t of THEMES) expect(t.theme.glow, t.id).toBe(t.theme.spoken)
    expect(THEMES.find((t) => t.id === 'ink')!.theme).toMatchObject({ text: '#111111', spoken: '#1d4ed8', emphasis: '#b91c1c', outline: '#ffffff', box: '#ffffff' })
    for (const g of GRADIENTS) for (const c of g.stops) expect(ratio(c, BLACK), `${g.id} ${c}`).toBeGreaterThanOrEqual(4.5)
    expect(SPEAKER_PALETTE).toEqual(['#ffffff', '#ffe14d', '#5ce1e6', '#8be28b', '#ff9fb2', '#c4a7ff'])
    for (const c of SPEAKER_PALETTE) expect(ratio(c, BLACK), c).toBeGreaterThanOrEqual(10)
    expect(LINE_LENGTHS).toEqual({ short: { chars: 24, tallChars: 16 }, medium: { chars: 32, tallChars: 20 }, long: { chars: 42, tallChars: 26 } })
  })
})

/* ---------- the emoji list (§11.3) ---------- */

describe('the emoji list', () => {
  it('equals what scripts/build-emoji-data.mjs generates from its pinned inputs', async () => {
    const script = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'build-emoji-data.mjs')).href)) as { generate(): Promise<Record<string, string>>; EMOJI_TEST: { file: string; bytes: number; sha256: string } }
    const files = await script.generate()
    for (const [file, text] of Object.entries(files)) expect(readFileSync(path.join(ROOT, file), 'utf8') === text, file).toBe(true)
    const test = readFileSync(path.join(ROOT, script.EMOJI_TEST.file))
    expect(test.length).toBe(671_655)
    expect(sha256(test)).toBe('8f3735cda1f92a779d78af67cf86066bb1f07143dc22f2ac29394d9bc57ab21a')
  })

  it('lists the fully-qualified emoji the bundled font draws, keyed without FE0F', () => {
    expect(EMOJI_LIST.length).toBeGreaterThan(3000)
    expect(EMOJI_KEYS.size).toBe(EMOJI_LIST.length)
    for (const k of ['1f525', '1f4a1', '1f680', '1f4c8', '2764', '1f1e7-1f1e9', '1f3f3-200d-1f308']) expect(EMOJI_KEYS.has(k), k).toBe(true)
    for (const e of EMOJI_LIST) expect(e.key).not.toMatch(/fe0f/)
  })
})

/* ---------- commands, preferences and Polish (§2.14, §4.6, §11.8) ---------- */

describe('commands, preferences and the Polish step', () => {
  it('has the seven Captions commands, without keys', () => {
    const ids = ['captionsGreat', 'captionStyles', 'captionEmphasis', 'captionGraphics', 'captionTidy', 'captionLanguage', 'saveCaptionStyle']
    for (const id of ids) {
      const c = COMMANDS.find((x) => x.id === id)
      expect(c, id).toMatchObject({ category: 'Captions' })
      expect(c!.keywords!.length, id).toBeGreaterThan(5)
      expect(DEFAULT_KEYMAP[id as keyof typeof DEFAULT_KEYMAP], id).toEqual([])
    }
    expect(COMMANDS.find((x) => x.id === 'captionStyles')!.title).toBe('Caption styles…')
    expect(COMMANDS.find((x) => x.id === 'captionLanguage')!.title).toBe('Add a caption language…')
  })

  it('has the four preference keys', () => {
    for (const k of ['captionPresets', 'captionsGreat', 'captionCleanup', 'captionWordList'] as const) expect(PREF_KEYS).toContain(k)
  })

  it('runs Caption look after Captions and before the director, skipped without captions', () => {
    expect(POLISH_STEPS.indexOf('captionLook')).toBe(POLISH_STEPS.indexOf('captions') + 1)
    expect(POLISH_STEPS.indexOf('director')).toBe(POLISH_STEPS.indexOf('captionLook') + 1)
    expect(DEFAULT_POLISH_OPTIONS.captionLook).toBe(true)
    const project = { transcript: undefined, hasAudio: false, clips: [], zooms: [], titles: [], webcam: { show: false }, hasWebcam: false, audio: { muted: false, volume: 1 } } as unknown as Project
    const recorded = { valid: true, samples: [], clicks: [] } as unknown as CursorTrack
    expect(polishAvailability(project, recorded, { hasCameraFile: false, transcribers: [], transcribing: false }).captionLook).toBe('no-captions')
    const steps = (options: typeof DEFAULT_POLISH_OPTIONS) =>
      planPolish({ project, recorded, sound: null, transcript: null, speech: null, framing: { status: 'skipped' }, preset: null, newId: () => 'x' } as unknown as Parameters<typeof planPolish>[0], options).summary.steps
    expect(steps({ ...DEFAULT_POLISH_OPTIONS, zoom: false, silences: false, captions: false, director: false }).find((s) => s.step === 'captionLook')).toEqual({ step: 'captionLook', status: 'skipped', reason: 'no-captions' })
    expect(steps({ ...DEFAULT_POLISH_OPTIONS, zoom: false, silences: false, captions: false, director: false, captionLook: false }).find((s) => s.step === 'captionLook')).toEqual({ step: 'captionLook', status: 'skipped', reason: 'off' })
  })
})
