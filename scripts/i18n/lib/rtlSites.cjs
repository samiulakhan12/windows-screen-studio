'use strict'
/**
 * Right-to-left styles (docs/design/output-and-languages.md §13, part X7): every physical left or
 * right in our stylesheets, read with postcss.
 *
 * A declaration is physical when it names a side or a corner (`margin-left`, `left`, `border-right`,
 * `border-top-left-radius`, `text-align: left`, `float: right`), when a shorthand gives the two sides
 * different values (`padding: 0 4px 0 10px`, `inset: 0 auto 0 0`, `border-radius: 0 3px 3px 0`), or
 * when it moves or paints along the x axis with no logical form (`translateX`, `background-position:
 * right`, a gradient to the right). The codemod turns each one with a logical form into it
 * (`margin-inline-start`, `inset-inline-start`, `text-align: start`, `padding-inline: 10px 4px`, …),
 * which computes to the same box in a left-to-right page (§13.1).
 *
 * `scripts/i18n/rtl-sites.json` lists what stays as it is, with its reason (`kept`: the time axis, the
 * preview's picture, the window's own buttons, …), the containers that keep left to right in a
 * right-to-left page (`ltr`), and the rules that apply only there (`rtl`, `:dir(rtl)`). Test 76
 * (`tests/i18nRtlStyles.test.ts`) requires the list and the stylesheets to agree. The other account's
 * stylesheets (pending.json) are theirs and not read (§9.5); `i18n/scripts.css` is part P6's.
 */
const fs = require('node:fs')
const path = require('node:path')
const postcss = require('postcss')
const files = require('./files.cjs')
const { matchesAny } = require('./scan.cjs')

const SITES_FILE = 'rtl-sites.json'
/** Stylesheets no part X7 rule reads: P6's script tokens (§12). */
const NOT_X7 = Object.freeze(['src/renderer/src/i18n/scripts.css'])

/** Every stylesheet under src/ that is ours and X7's, as repository paths. */
function stylesheetsOf(root = files.ROOT) {
  const pending = files.readPending(root)
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.name.endsWith('.css')) out.push(path.relative(root, abs).split(path.sep).join('/'))
    }
  }
  walk(path.join(root, 'src'))
  return out.filter((f) => !NOT_X7.includes(f) && !matchesAny(f, pending.files)).sort()
}

/** The list of what stays physical, the left-to-right containers and the right-to-left rules. */
function readRtlSites(root = files.ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, files.TOOLS_DIR, SITES_FILE), 'utf8'))
}

/** A value's top-level words: split at spaces outside parentheses and quotes. */
function wordsOf(value) {
  const out = []
  let depth = 0
  let quote = null
  let word = ''
  for (const ch of value.trim()) {
    if (quote) {
      word += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    if (/\s/.test(ch) && depth === 0) {
      if (word) out.push(word)
      word = ''
      continue
    }
    word += ch
  }
  if (word) out.push(word)
  return out
}

/** The rule a declaration sits in, as one line: its at-rules and selectors, spaces collapsed. */
function rulePathOf(decl) {
  const parts = []
  for (let n = decl.parent; n && n.type !== 'root'; n = n.parent) {
    if (n.type === 'rule') parts.unshift(n.selector.replace(/\s+/g, ' ').trim())
    else if (n.type === 'atrule') parts.unshift(`@${n.name} ${n.params.replace(/\s+/g, ' ').trim()}`)
  }
  return parts.join(' ')
}

const SIDE = { left: 'start', right: 'end' }
const CORNER_BLOCK = { top: 'start', bottom: 'end' }
/** The shorthands whose four values run top, right, bottom, left, and their logical pairs. */
const BOX = {
  margin: ['margin-block', 'margin-inline'],
  padding: ['padding-block', 'padding-inline'],
  inset: ['inset-block', 'inset-inline'],
  'border-width': ['border-block-width', 'border-inline-width'],
  'border-style': ['border-block-style', 'border-inline-style'],
  'border-color': ['border-block-color', 'border-inline-color']
}
const pair = (a, b) => (a === b ? a : `${a} ${b}`)

/** border-radius's four corners (top-left, top-right, bottom-right, bottom-left) from its words. */
function cornersOf(words) {
  const [a, b = a, c = a, d = b] = words
  return [a, b, c, d]
}

/** A transform that moves along the x axis: translateX, or translate/translate3d with a first value other than 0. */
function movesAlongX(value) {
  if (/\btranslateX\(\s*(?!0(?:px|%)?\s*\))/i.test(value)) return true
  const m = /\btranslate(?:3d)?\(\s*([^,\s)]+)/i.exec(value)
  return !!m && !/^0(?:px|%)?$/.test(m[1])
}

/** A gradient along the x axis: `to left`, `to right` or a horizontal angle. */
const gradientAlongX = (value) => /linear-gradient\(\s*(?:to\s+(?:left|right)\b|-?(?:90|270)deg\b)/i.test(value)

/** A side keyword in a value, outside url(…) and quotes. */
const namesSide = (value) => /\b(?:left|right)\b/.test(value.replace(/url\([^)]*\)/g, '').replace(/(["']).*?\1/g, ''))

/**
 * Whether the declaration `prop: value` is physical, and its logical form: `{ kind, logical }` with
 * `logical` the declarations that replace it (null when it has no logical form), or null when the
 * declaration is the same in both directions.
 */
function physicalOf(prop, value) {
  const p = prop.toLowerCase()
  const v = value.trim()
  let m
  if ((m = /^(margin|padding)-(left|right)$/.exec(p))) return { kind: 'side', logical: [{ prop: `${m[1]}-inline-${SIDE[m[2]]}`, value: v }] }
  if ((m = /^scroll-(margin|padding)-(left|right)$/.exec(p))) return { kind: 'side', logical: [{ prop: `scroll-${m[1]}-inline-${SIDE[m[2]]}`, value: v }] }
  if ((m = /^border-(left|right)(-(?:width|style|color))?$/.exec(p))) return { kind: 'side', logical: [{ prop: `border-inline-${SIDE[m[1]]}${m[2] ?? ''}`, value: v }] }
  if ((m = /^(left|right)$/.exec(p))) return { kind: 'side', logical: [{ prop: `inset-inline-${SIDE[m[1]]}`, value: v }] }
  if ((m = /^border-(top|bottom)-(left|right)-radius$/.exec(p))) return { kind: 'corner', logical: [{ prop: `border-${CORNER_BLOCK[m[1]]}-${SIDE[m[2]]}-radius`, value: v }] }
  if (p === 'text-align' || p === 'float' || p === 'clear') {
    const side = /^(left|right)$/i.exec(v)
    if (!side) return namesSide(v) ? { kind: 'keyword', logical: null } : null
    const to = side[1].toLowerCase()
    return { kind: 'keyword', logical: [{ prop: p, value: p === 'text-align' ? SIDE[to] : `inline-${SIDE[to]}` }] }
  }
  if (BOX[p]) {
    const w = wordsOf(v)
    if (w.length !== 4 || w[1] === w[3]) return null
    const [block, inline] = BOX[p]
    return { kind: 'shorthand', logical: [{ prop: block, value: pair(w[0], w[2]) }, { prop: inline, value: pair(w[3], w[1]) }] }
  }
  if (p === 'border-radius') {
    if (v.includes('/')) return null
    const [tl, tr, br, bl] = cornersOf(wordsOf(v))
    if (tl === tr && bl === br) return null
    return {
      kind: 'shorthand',
      logical: [
        { prop: 'border-start-start-radius', value: tl },
        { prop: 'border-start-end-radius', value: tr },
        { prop: 'border-end-end-radius', value: br },
        { prop: 'border-end-start-radius', value: bl }
      ]
    }
  }
  if ((p === 'transform' || p === 'translate') && (p === 'translate' ? !/^0(?:px|%)?(?:\s|$)/.test(v) && v !== 'none' : movesAlongX(v))) return { kind: 'translate', logical: null }
  if ((p === 'background-position' || p === 'background-position-x' || p === 'mask-position') && namesSide(v)) return { kind: 'position', logical: null }
  if ((p === 'background' || p === 'background-image' || p === 'mask' || p === 'mask-image') && (gradientAlongX(v) || (p === 'background' && namesSide(v))))
    return { kind: 'gradient', logical: null }
  return null
}

/** The physical declarations of one stylesheet: `{ file, rule, prop, value, line, kind, logical }`. */
function physicalSites(file, css) {
  const out = []
  postcss.parse(css, { from: file }).walkDecls((decl) => {
    const found = physicalOf(decl.prop, decl.value)
    if (found) out.push({ file, rule: rulePathOf(decl), prop: decl.prop, value: decl.value, line: decl.source.start.line, ...found })
  })
  return out
}

/** The rules of one stylesheet, by rule path, with their declarations. */
function rulesOf(file, css) {
  const out = new Map()
  postcss.parse(css, { from: file }).walkRules((rule) => {
    const decls = rule.nodes.filter((n) => n.type === 'decl').map((d) => ({ prop: d.prop, value: d.value }))
    const key = rulePathOf({ parent: rule })
    out.set(key, [...(out.get(key) ?? []), ...decls])
  })
  return out
}

/** Whether `site` is one of the kept entries. */
const keptBy = (kept, site) => kept.find((k) => k.file === site.file && k.rule === site.rule && k.props.includes(site.prop))

/**
 * The tree against the list:
 * - `unlisted`: physical declarations neither converted nor kept;
 * - `stale`: kept entries (or one of their properties) that match no declaration;
 * - `ltrMissing`: listed containers without `direction: ltr`;
 * - `rtlMissing`: listed right-to-left rules that are gone, or whose selector does not ask for `:dir(rtl)`;
 * - `rtlUnlisted`: `:dir()` rules that are not listed (every rule that applies only in one direction is);
 * - `mirrorMissing`: kept entries whose `mirror` rule is not listed in `rtl`;
 * - `files`: the stylesheets read.
 */
function checkRtlSites(root = files.ROOT, sites = readRtlSites(root)) {
  const sheets = stylesheetsOf(root)
  const out = { unlisted: [], stale: [], ltrMissing: [], rtlMissing: [], rtlUnlisted: [], mirrorMissing: [], unknownReason: [], files: sheets }
  const found = []
  const rules = new Map()
  for (const file of sheets) {
    const css = fs.readFileSync(path.join(root, file), 'utf8')
    found.push(...physicalSites(file, css))
    rules.set(file, rulesOf(file, css))
  }
  for (const s of found) if (!keptBy(sites.kept, s)) out.unlisted.push(s)
  for (const k of sites.kept) {
    if (!sites.reasons[k.reason]) out.unknownReason.push(k)
    for (const prop of k.props) if (!found.some((s) => s.file === k.file && s.rule === k.rule && s.prop === prop)) out.stale.push({ ...k, prop })
    if (k.mirror && !sites.rtl.some((r) => r.file === k.file && r.rule === k.mirror)) out.mirrorMissing.push(k)
  }
  for (const l of sites.ltr) {
    const decls = rules.get(l.file)?.get(l.rule) ?? []
    if (!decls.some((d) => d.prop === 'direction' && d.value.trim() === 'ltr')) out.ltrMissing.push(l)
  }
  for (const r of sites.rtl) if (!rules.get(r.file)?.has(r.rule) || !r.rule.includes(':dir(rtl)')) out.rtlMissing.push(r)
  for (const [file, byRule] of rules)
    for (const rule of byRule.keys()) if (rule.includes(':dir(') && !sites.rtl.some((r) => r.file === file && r.rule === rule)) out.rtlUnlisted.push({ file, rule })
  return out
}

/**
 * The codemod: `css` with every physical declaration that has a logical form and is not kept turned
 * into it, in place, keeping the stylesheet's formatting. Returns the new text, what changed, and the
 * physical declarations left for a hand edit (no logical form, not kept).
 */
function convertStylesheet(file, css, kept) {
  const ast = postcss.parse(css, { from: file })
  const changed = []
  const left = []
  ast.walkDecls((decl) => {
    const found = physicalOf(decl.prop, decl.value)
    if (!found) return
    const site = { file, rule: rulePathOf(decl), prop: decl.prop, value: decl.value, line: decl.source.start.line }
    if (keptBy(kept, site)) return
    if (!found.logical) {
      left.push(site)
      return
    }
    for (const l of found.logical) decl.cloneBefore({ prop: l.prop, value: l.value })
    decl.remove()
    changed.push({ ...site, to: found.logical.map((l) => `${l.prop}: ${l.value}`).join('; ') })
  })
  return { css: changed.length ? ast.toString() : css, changed, left }
}

module.exports = { SITES_FILE, NOT_X7, stylesheetsOf, readRtlSites, wordsOf, physicalOf, physicalSites, checkRtlSites, convertStylesheet }
