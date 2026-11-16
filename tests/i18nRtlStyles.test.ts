import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/*
 * Test 76 (docs/design/output-and-languages.md §13, §23.1; part X7): our stylesheets name sides by
 * their logical form, so panels mirror in a right-to-left page; what stays physical is listed in
 * scripts/i18n/rtl-sites.json with its reason; the timeline, its ruler, the preview and the transport
 * keep direction: ltr; and every rule that applies only in a right-to-left page asks for :dir(rtl), so
 * none of them matches in English. The layout half runs in the app (tests/e2e/languages-rtl.e2e.cjs:
 * under ar-XB the inspector's labels start on the right and the time axis keeps its direction), and
 * the English half is the English guard (test 10).
 */

type Decl = { prop: string; value: string }
type Site = { file: string; rule: string; prop: string; value: string; line: number; kind: string; logical: Decl[] | null }
type Kept = { file: string; rule: string; props: string[]; reason: string; mirror?: string }
type Listed = { file: string; rule: string; reason: string }
type Sites = { reasons: Record<string, string>; ltr: Listed[]; rtl: Listed[]; kept: Kept[] }
type Check = {
  unlisted: Site[]
  stale: (Kept & { prop: string })[]
  ltrMissing: Listed[]
  rtlMissing: Listed[]
  rtlUnlisted: { file: string; rule: string }[]
  mirrorMissing: Kept[]
  unknownReason: Kept[]
  files: string[]
}
const lib = require('../scripts/i18n/lib/rtlSites.cjs') as {
  stylesheetsOf(root?: string): string[]
  readRtlSites(root?: string): Sites
  physicalOf(prop: string, value: string): { kind: string; logical: Decl[] | null } | null
  physicalSites(file: string, css: string): Site[]
  checkRtlSites(root?: string, sites?: Sites): Check
  convertStylesheet(file: string, css: string, kept: Kept[]): { css: string; changed: unknown[]; left: Site[] }
}
const ROOT = path.resolve(__dirname, '..')
const sites = lib.readRtlSites(ROOT)

/* ---------- a left-to-right page: what each logical declaration computes to ---------- */

const SIDES = ['top', 'right', 'bottom', 'left'] as const
/** A value's top-level words (spaces outside parentheses). */
function words(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let word = ''
  for (const ch of value.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (/\s/.test(ch) && depth === 0) {
      if (word) out.push(word)
      word = ''
    } else word += ch
  }
  if (word) out.push(word)
  return out
}
const BOX: Record<string, (side: string) => string> = {
  margin: (s) => `margin-${s}`,
  padding: (s) => `padding-${s}`,
  inset: (s) => s,
  'border-width': (s) => `border-${s}-width`,
  'border-style': (s) => `border-${s}-style`,
  'border-color': (s) => `border-${s}-color`
}
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const

/** The physical longhands one declaration sets in a left-to-right page, as `prop: value` lines. */
function ltrLonghands(prop: string, value: string): string[] {
  const p = prop.toLowerCase()
  const v = value.trim()
  const box = Object.keys(BOX).find((b) => p === b)
  if (box) {
    const w = words(v)
    const [t, r = t, b = t, l = r] = w
    return SIDES.map((s, i) => `${BOX[box](s)}: ${[t, r, b, l][i]}`)
  }
  let m = /^(margin|padding|inset|border)-(block|inline)(-(?:width|style|color))?$/.exec(p)
  if (m) {
    const w = words(v)
    const [first, second = first] = w
    const [a, b] = m[2] === 'block' ? ['top', 'bottom'] : ['left', 'right']
    const name = (side: string): string => (m![1] === 'inset' ? side : `${m![1]}-${side}${m![3] ?? ''}`)
    return [`${name(a)}: ${first}`, `${name(b)}: ${second}`]
  }
  m = /^(margin|padding|inset|border)-(block|inline)-(start|end)(-(?:width|style|color))?$/.exec(p)
  if (m) {
    const side = m[2] === 'block' ? (m[3] === 'start' ? 'top' : 'bottom') : m[3] === 'start' ? 'left' : 'right'
    return [`${m[1] === 'inset' ? side : `${m[1]}-${side}${m[4] ?? ''}`}: ${v}`]
  }
  m = /^border-(start|end)-(start|end)-radius$/.exec(p)
  if (m) return [`border-${m[1] === 'start' ? 'top' : 'bottom'}-${m[2] === 'start' ? 'left' : 'right'}-radius: ${v}`]
  if (p === 'border-radius') {
    const [a, b = a, c = a, d = b] = words(v)
    return CORNERS.map((corner, i) => `border-${corner}-radius: ${[a, b, c, d][i]}`)
  }
  if (p === 'text-align') return [`text-align: ${v === 'start' ? 'left' : v === 'end' ? 'right' : v}`]
  if (p === 'float' || p === 'clear') return [`${p}: ${v === 'inline-start' ? 'left' : v === 'inline-end' ? 'right' : v}`]
  return [`${p}: ${v}`]
}
const longhandsOf = (decls: Decl[]): string[] => decls.flatMap((d) => ltrLonghands(d.prop, d.value)).sort()

/* ---------- a scratch tree for the checker ---------- */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function scratchTree(stylesheets: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-rtl-'))
  temps.push(root)
  fs.mkdirSync(path.join(root, 'scripts', 'i18n'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts/i18n/pending.json'), path.join(root, 'scripts/i18n/pending.json'))
  for (const [file, css] of Object.entries(stylesheets)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), css)
  }
  return root
}
const readTree = (files: string[]): Record<string, string> => Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]))

describe('test 76: right-to-left styles', () => {
  it('reads every stylesheet of ours: the X7 list of parts.json, without the other account’s or i18n/scripts.css', () => {
    const parts = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/i18n/parts.json'), 'utf8')) as { parts: Record<string, { files: string[] }> }
    expect(lib.stylesheetsOf(ROOT)).toEqual([...parts.parts.X7.files].sort())
    expect(lib.stylesheetsOf(ROOT)).not.toContain('src/renderer/src/i18n/scripts.css')
    expect(lib.stylesheetsOf(ROOT).some((f) => f.includes('/recorder/') || f.includes('/views/Toolbar.'))).toBe(false)
  })

  it('every physical left and right is converted or kept with its reason, and the list matches the stylesheets', () => {
    const r = lib.checkRtlSites(ROOT, sites)
    expect(r.unlisted.map((s) => `${s.file}:${s.line} ${s.rule} { ${s.prop}: ${s.value} }`)).toEqual([])
    expect(r.stale).toEqual([])
    expect(r.unknownReason).toEqual([])
    expect(r.mirrorMissing).toEqual([])
    expect(r.rtlMissing).toEqual([])
    expect(r.rtlUnlisted).toEqual([])
    expect(r.ltrMissing).toEqual([])
    for (const k of sites.kept) expect(Object.keys(sites.reasons)).toContain(k.reason)
  })

  it('the timeline, its ruler, the preview and the transport keep direction: ltr', () => {
    const ltr = sites.ltr.map((l) => `${l.file} ${l.rule}`)
    expect(ltr).toEqual(
      expect.arrayContaining([
        'src/renderer/src/editor/editor.css .timeline',
        'src/renderer/src/editor/editor.css .transport',
        'src/renderer/src/editor/editor.css .canvas-wrap'
      ])
    )
    // The ruler is inside the timeline (Timeline.tsx renders .tl-ruler in .timeline) and sets no direction of its own.
    const timeline = fs.readFileSync(path.join(ROOT, 'src/renderer/src/editor/Timeline.tsx'), 'utf8')
    expect(timeline.indexOf('className="timeline"')).toBeGreaterThan(-1)
    expect(timeline.indexOf('className="tl-ruler"')).toBeGreaterThan(timeline.indexOf('className="timeline"'))
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/src/editor/editor.css'), 'utf8')
    expect(/\.tl-ruler\s*\{[^}]*direction/.test(css)).toBe(false)
    // Nothing kept for the time axis sits outside those containers' stylesheets' time-axis rules.
    for (const k of sites.kept.filter((x) => x.reason === 'timeline')) expect(k.file).toMatch(/src\/renderer\/src\/editor\//)
  })

  it('no rule of the inspector’s panels keeps a physical side, so their labels start on the right in a right-to-left page', () => {
    const panels = sites.kept.filter((k) => k.file.includes('/editor/panels/'))
    // What the panels' stylesheets keep belongs to the timeline (their tracks), the preview (a callout's
    // tip), a centred label or a play sign.
    for (const k of panels) expect(['timeline', 'preview', 'centred', 'glyph']).toContain(k.reason)
    for (const rule of ['.inspector', '.insp-tabs', '.insp-tabs button.active::before', '.item-list button']) {
      expect(sites.kept.some((k) => k.file.endsWith('/editor/editor.css') && k.rule === rule)).toBe(false)
    }
    const editorCss = fs.readFileSync(path.join(ROOT, 'src/renderer/src/editor/editor.css'), 'utf8')
    expect(editorCss).toMatch(/\.inspector \{[^}]*border-inline-start: 1px solid var\(--border-subtle\)/)
    expect(editorCss).toMatch(/\.insp-tabs \{[^}]*border-inline-end: 1px solid var\(--border-subtle\)/)
  })

  it('every right-to-left rule asks for :dir(rtl), so none of them matches in English, and none asks for :dir(ltr)', () => {
    for (const r of sites.rtl) expect(r.rule).toContain(':dir(rtl)')
    for (const file of lib.stylesheetsOf(ROOT)) expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).not.toMatch(/:dir\(\s*ltr\s*\)/)
    // A mirrored move keeps its English value and names the rule that gives the other one.
    for (const k of sites.kept.filter((x) => x.reason === 'mirrored')) expect(sites.rtl.map((r) => r.rule)).toContain(k.mirror)
  })

  it('each logical form the codemod writes computes to the same longhands as the declaration it replaced, in a left-to-right page', () => {
    const cases: [string, string][] = [
      ['margin-left', 'var(--space-1)'],
      ['margin-right', 'auto'],
      ['padding-left', 'calc(52px + 68px + var(--space-3) * 2)'],
      ['padding-right', '40px'],
      ['border-left', '2px solid var(--border-default)'],
      ['border-right', '1px solid var(--border-subtle)'],
      ['border-left-color', '#5eead4'],
      ['border-right-color', 'transparent'],
      ['left', '-35%'],
      ['right', '6px'],
      ['text-align', 'left'],
      ['text-align', 'right'],
      ['float', 'left'],
      ['clear', 'right'],
      ['border-top-left-radius', '2px'],
      ['border-top-right-radius', '2px'],
      ['border-bottom-left-radius', '2px'],
      ['border-bottom-right-radius', '2px'],
      ['padding', '0 4px 0 10px'],
      ['padding', 'var(--space-2) 10px var(--space-2) var(--space-2)'],
      ['padding', '2px var(--space-4) 2px 0'],
      ['margin', '0 0 2px 54px'],
      ['margin', '-8px 0 0 -8px'],
      ['inset', '0 auto 0 0'],
      ['border-width', '1px 2px 3px 4px'],
      ['border-radius', '0 3px 3px 0'],
      ['border-radius', '6px 0 0 6px'],
      ['border-radius', '4px 8px'],
      ['border-radius', '1px 2px 3px']
    ]
    for (const [prop, value] of cases) {
      const found = lib.physicalOf(prop, value)
      expect(found, `${prop}: ${value}`).not.toBeNull()
      expect(found!.logical, `${prop}: ${value}`).not.toBeNull()
      expect(longhandsOf(found!.logical!), `${prop}: ${value}`).toEqual(longhandsOf([{ prop, value }]))
      expect(found!.logical!.every((d) => !/(^|-)(left|right)(-|$)/.test(d.prop) && !/^(left|right)$/.test(d.value)), `${prop}: ${value}`).toBe(true)
    }
  })

  it('reads as physical only what differs between the two directions', () => {
    for (const [prop, value] of [
      ['padding', '0 8px'],
      ['margin', '0 calc(-1 * var(--space-3))'],
      ['margin', '2px 0 2px 0'],
      ['inset', '0'],
      ['inset', '30% 20px auto'],
      ['border-radius', '4px 4px 50% 50%'],
      ['text-align', 'center'],
      ['text-align', 'start'],
      ['float', 'none'],
      ['transform', 'translateY(-50%)'],
      ['transform', 'translate(0, -2px)'],
      ['transform', 'rotate(90deg)'],
      ['background', 'linear-gradient(180deg, #000, #fff)'],
      ['margin-inline-start', '4px']
    ] as const)
      expect(lib.physicalOf(prop, value), `${prop}: ${value}`).toBeNull()
    for (const [prop, value] of [
      ['transform', 'translateX(14px)'],
      ['transform', 'translate(-50%, -50%)'],
      ['background-position', 'right 10px center'],
      ['background', 'linear-gradient(90deg, rgba(10, 10, 16, 0.42), rgba(10, 10, 16, 0))'],
      ['background', 'linear-gradient(to right, red, blue)']
    ] as const) {
      const found = lib.physicalOf(prop, value)
      expect(found, `${prop}: ${value}`).not.toBeNull()
      expect(found!.logical, `${prop}: ${value}`).toBeNull()
    }
  })

  it('the codemod converts in place, keeps what is listed and leaves a move with no logical form for a hand edit', () => {
    const css = `.a {\n  margin-left: 4px;\n  padding: 0 4px 0 10px;\n}\n\n.b {\n  left: 0; /* kept */\n}\n\n.c {\n  transform: translateX(4px);\n}\n`
    const r = lib.convertStylesheet('src/x.css', css, [{ file: 'src/x.css', rule: '.b', props: ['left'], reason: 'timeline' }])
    expect(r.css).toBe(`.a {\n  margin-inline-start: 4px;\n  padding-block: 0;\n  padding-inline: 10px 4px;\n}\n\n.b {\n  left: 0; /* kept */\n}\n\n.c {\n  transform: translateX(4px);\n}\n`)
    expect(r.left.map((s) => `${s.rule} ${s.prop}`)).toEqual(['.c transform'])
  })

  it('fails on the stylesheets as they were before X7: physical sides, no direction: ltr, and an unlisted :dir() rule', () => {
    const files = ['src/renderer/src/editor/editor.css', 'src/renderer/src/styles.css']
    const now = readTree(files)
    const sitesFor = (): Sites => ({
      ...sites,
      kept: sites.kept.filter((k) => files.includes(k.file)),
      ltr: sites.ltr.filter((l) => files.includes(l.file)),
      rtl: sites.rtl.filter((x) => files.includes(x.file))
    })
    // Today's two stylesheets pass on their own.
    const passing = lib.checkRtlSites(scratchTree(now), sitesFor())
    expect([passing.unlisted, passing.stale, passing.ltrMissing, passing.rtlMissing, passing.rtlUnlisted].flat()).toEqual([])
    // The inspector's border back on the left, the timeline without its direction, a :dir() rule nobody listed.
    const before = {
      ...now,
      'src/renderer/src/editor/editor.css': now['src/renderer/src/editor/editor.css']
        .replace('border-inline-start: 1px solid var(--border-subtle);\n  background: var(--surface-1);\n  display: flex;\n  min-height: 0;', 'border-left: 1px solid var(--border-subtle);\n  background: var(--surface-1);\n  display: flex;\n  min-height: 0;')
        .replace(/(\.timeline \{\n)  direction: ltr;\n/, '$1'),
      'src/renderer/src/styles.css': `${now['src/renderer/src/styles.css']}\n.brand:dir(rtl) {\n  gap: 4px;\n}\n`
    }
    expect(before['src/renderer/src/editor/editor.css']).not.toBe(now['src/renderer/src/editor/editor.css'])
    const failing = lib.checkRtlSites(scratchTree(before), sitesFor())
    expect(failing.unlisted.map((s) => `${s.rule} ${s.prop}`)).toEqual(['.inspector border-left'])
    expect(failing.ltrMissing.map((l) => l.rule)).toEqual(['.timeline'])
    expect(failing.rtlUnlisted.map((x) => x.rule)).toEqual(['.brand:dir(rtl)'])
  })
})
