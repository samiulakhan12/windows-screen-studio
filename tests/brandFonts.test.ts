import { describe, expect, it } from 'vitest'
import { checkFont, cleanFontName, fontFamily, fontNameFromFile, fontOf, fontStack, fontType, FONT_FILE_RE } from '../src/shared/render/fonts'
import { ANNOTATION_FONT } from '../src/shared/render/overlays'

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b)
const tag = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)))

describe('font files', () => {
  it('recognises TTF, OTF and WOFF2 by their first bytes', () => {
    expect(fontType(bytes(0, 1, 0, 0, 0, 12))).toBe('ttf')
    expect(fontType(tag('true'))).toBe('ttf')
    expect(fontType(tag('OTTO'))).toBe('otf')
    expect(fontType(tag('wOF2'))).toBe('woff2')
    expect(fontType(tag('wOFF'))).toBeNull()
    expect(fontType(tag('ttcf'))).toBeNull()
    expect(fontType(tag('<svg'))).toBeNull()
    expect(fontType(bytes(0, 1))).toBeNull()
  })

  it('refuses a file whose content does not match its extension', () => {
    expect(checkFont(tag('OTTO'), 'otf')).toBeNull()
    expect(checkFont(bytes(0, 1, 0, 0), 'otf')).toBeNull()
    expect(checkFont(tag('OTTO'), 'ttf')).toBeNull()
    expect(checkFont(tag('wOF2'), 'ttf')).toMatch(/named \.ttf but holds a WOFF2/)
    expect(checkFont(tag('OTTO'), 'woff2')).toMatch(/rename it to \.otf/)
    expect(checkFont(tag('GIF8'), 'ttf')).toMatch(/could not be read/)
  })

  it('accepts only font-<n> file names', () => {
    expect(FONT_FILE_RE.test('font-1.ttf')).toBe(true)
    expect(FONT_FILE_RE.test('font-12.WOFF2')).toBe(true)
    for (const bad of ['font-0.ttf', 'font-1.woff', '../font-1.ttf', 'font-1.ttf/x', 'font.ttf', 'font-1.ttf.exe']) expect(FONT_FILE_RE.test(bad)).toBe(false)
  })
})

describe('font stacks', () => {
  const fonts = [{ id: 'f1', name: 'Segoe UI', file: 'font-1.ttf' }]

  it('puts the project font under its own family before the old stack', () => {
    expect(fontStack(fonts, 'f1', ANNOTATION_FONT)).toBe(`"FlownFont-f1", ${ANNOTATION_FONT}`)
    expect(fontFamily('f1')).toBe('FlownFont-f1')
  })

  it('falls back to the old stack for no font, an unknown one or a bad id', () => {
    expect(fontStack(fonts, undefined, ANNOTATION_FONT)).toBe(ANNOTATION_FONT)
    expect(fontStack(fonts, 'f2', ANNOTATION_FONT)).toBe(ANNOTATION_FONT)
    expect(fontStack(undefined, 'f1', ANNOTATION_FONT)).toBe(ANNOTATION_FONT)
    expect(fontStack(fonts, '"); x', ANNOTATION_FONT)).toBe(ANNOTATION_FONT)
    expect(fontOf(fonts, 5)).toBeNull()
  })

  it('names a font from its file', () => {
    expect(fontNameFromFile('brand-sans_bold.ttf')).toBe('brand sans bold')
    expect(fontNameFromFile('.ttf')).toBe('Font')
    expect(cleanFontName(` a\u0000b ${'x'.repeat(100)}`).length).toBe(60)
  })
})
