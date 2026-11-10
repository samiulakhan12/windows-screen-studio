'use strict'
/**
 * The catalogue checks (docs/design/output-and-languages.md §16.2). English: every key used exists, no
 * key is unused, every message parses and is NFC, every key has its meta entry, and every `merge`
 * group has its `.whole` message. Each translation: it parses with English's placeholders and rich
 * tags; plurals keep `other` and only the language's categories (no number word in a Bangla or Hindi
 * `one`); no `#`, `{x, number}` or quoted braces; the do-not-translate terms unchanged; NFC, no bidi
 * or other control characters, no HTML; Latin digits where the meta says `digits: 'latn'`; within
 * `maxLength` graphemes; English's blank lines kept; no stray Latin words or `???` in Bangla or Hindi;
 * reviewers listed for the language and two different people; and a current `sourceHash`.
 *
 * Messages are parsed with the app's own parser (src/shared/i18n/icu.ts), so the checks and the
 * runtime agree on what a message is.
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const files = require('./files.cjs')
const { loadTs } = require('./tsload.cjs')

const icu = loadTs(path.join(__dirname, '..', '..', '..', 'src', 'shared', 'i18n', 'icu.ts'))

/** Rich tags a message may hold (RichTag). */
const RICH_TAGS = ['kbd', 'b', 'em', 'link']
/** Bidi controls (embeddings, overrides, isolates, marks); ZWJ and ZWNJ are allowed. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
/** Other characters no message holds: C0/C1 controls but the line feed, tag characters, BOM, replacement character. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\ufeff\ufffd\u{e0000}-\u{e007f}]/u
/** Native digits of the scripts Flown may show (Bengali, Devanagari, Arabic-Indic, Extended Arabic-Indic). */
const NATIVE_DIGITS = /[০-৯०-९٠-٩۰-۹]/u
/** Number words and digits a Bangla or Hindi `one` branch must not hold instead of `{n}` (§9.3). */
const ONE_WORDS = { bn: ['একটি', 'একটা', 'এক', '১'], hi: ['एक', '१'] }
/** Languages whose text has no Latin words of its own (§16.2). */
const NON_LATIN = new Set(['bn', 'hi'])
const STATES = new Set(['draft', 'reviewed', 'approved'])

const problem = (code, message, level = 'error') => ({ code, message, level })

let graphemer = null
/** Grapheme count, as a reader counts letters. */
function graphemes(s) {
  graphemer ??= new Intl.Segmenter('und', { granularity: 'grapheme' })
  let n = 0
  for (const _ of graphemer.segment(s)) n++
  return n
}

/** The parsed message, or the parser's complaint. */
function parse(text) {
  try {
    return { nodes: icu.parseIcu(text), error: null }
  } catch (err) {
    return { nodes: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Walks every node of a parsed message. */
function eachNode(nodes, fn) {
  for (const n of nodes) {
    fn(n)
    if (n.kind === 'plural' || n.kind === 'select') for (const o of Object.values(n.options)) eachNode(o, fn)
    else if (n.kind === 'tag') eachNode(n.children, fn)
  }
}

/** The rich tags of a message, sorted, with repeats. */
function tagsOf(nodes) {
  const out = []
  eachNode(nodes, (n) => n.kind === 'tag' && out.push(n.name))
  return out.sort()
}

/** The text a translator wrote, without the message's syntax: every text node. */
function textOf(nodes) {
  const out = []
  eachNode(nodes, (n) => n.kind === 'text' && out.push(n.value))
  return out.join('\n')
}

/** Graphemes of the longest way through the message's options (placeholders not counted). */
function longest(nodes) {
  let total = 0
  for (const n of nodes) {
    if (n.kind === 'text') total += graphemes(n.value)
    else if (n.kind === 'tag') total += longest(n.children)
    else if (n.kind === 'plural' || n.kind === 'select') total += Math.max(0, ...Object.values(n.options).map(longest))
  }
  return total
}

const blankLines = (s) => (s.match(/\n[ \t]*\n/g) ?? []).length
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Do-not-translate terms of an English message: its meta's `dnt`, and the glossary's terms marked so that it holds. */
function dntTerms(english, meta, glossary) {
  const terms = new Set(meta?.dnt ?? [])
  for (const row of glossary ?? []) {
    if (!row.dnt || !row.term) continue
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(row.term)}($|[^\\p{L}\\p{N}])`, 'u').test(english)) terms.add(row.term)
  }
  return [...terms].sort((a, b) => b.length - a.length)
}

/** Problems shared by English and translations: syntax Flown's messages never use (§9.3). */
function syntaxProblems(text, nodes) {
  const out = []
  if (/'[{}#]/.test(text)) out.push(problem('quote', "holds '{, '} or '#, which ICU reads as quoting"))
  let pound = false
  let number = false
  eachNode(nodes, (n) => {
    if (n.kind === 'pound') pound = true
    if (n.kind === 'arg' && n.format === 'number') number = true
  })
  if (pound) out.push(problem('pound', 'uses # in a plural; show the number formatted by code as {n}'))
  if (number) out.push(problem('number', 'uses {x, number}; numbers are formatted by code and passed as strings'))
  return out
}

/**
 * The problems of one translation. `english` is the English message, `meta` its meta entry,
 * `translated` the translation entry, `glossary` the glossary rows and `reviewers` the people of
 * reviewers.json. A stale translation gives a problem of level 'stale', not an error.
 */
function checkMessage(lang, english, meta, translated, glossary = [], reviewers = []) {
  const out = []
  const text = translated?.text
  if (typeof text !== 'string' || !text.trim()) return [problem('empty', 'has no text')]
  if (!STATES.has(translated.state)) out.push(problem('state', `has the state ${JSON.stringify(translated.state)}; it must be draft, reviewed or approved`))

  // Characters first: they need no parse.
  if (text.normalize('NFC') !== text) out.push(problem('nfc', 'is not in NFC'))
  if (BIDI.test(text)) out.push(problem('bidi', 'holds a bidi control character'))
  if (CONTROL.test(text)) out.push(problem('control', 'holds a control, tag or replacement character'))
  const withoutTags = text.replace(new RegExp(`</?(${RICH_TAGS.join('|')})>`, 'g'), '')
  if (withoutTags.includes('<') || /&[#a-z0-9]+;/i.test(withoutTags)) out.push(problem('html', 'holds HTML or a < outside the four rich tags'))
  if (meta?.digits === 'latn' && NATIVE_DIGITS.test(text)) out.push(problem('digits', 'holds native digits in a technical line (digits: latn)'))
  if (blankLines(text) !== blankLines(english)) out.push(problem('blank-lines', `has ${blankLines(text)} blank line(s) where English has ${blankLines(english)}`))

  const own = parse(text)
  const en = parse(english)
  if (own.error) {
    out.push(problem(/without other/.test(own.error) ? 'plural-other' : 'parse', `does not parse: ${own.error}`))
  } else {
    out.push(...syntaxProblems(text, own.nodes))
    if (en.nodes) {
      const want = [...icu.argumentsOf(en.nodes)].sort()
      const got = [...icu.argumentsOf(own.nodes)].sort()
      const missing = want.filter((a) => !got.includes(a))
      const extra = got.filter((a) => !want.includes(a))
      if (missing.length) out.push(problem('placeholders', `lacks the placeholder(s) ${missing.map((a) => `{${a}}`).join(', ')}`))
      if (extra.length) out.push(problem('placeholders', `has placeholder(s) English does not: ${extra.map((a) => `{${a}}`).join(', ')}`))
      if (tagsOf(own.nodes).join() !== tagsOf(en.nodes).join()) out.push(problem('tags', `has the rich tags <${tagsOf(own.nodes).join('>, <')}> where English has <${tagsOf(en.nodes).join('>, <')}>`))
    }
    const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
    eachNode(own.nodes, (n) => {
      if (n.kind !== 'plural') return
      for (const [cat, branch] of Object.entries(n.options)) {
        if (/^=\d+$/.test(cat)) continue
        if (!categories.includes(cat)) out.push(problem('plural-category', `has the plural category "${cat}", which ${lang} does not use (${categories.join(', ')})`))
        if (cat === 'one' && ONE_WORDS[lang]) {
          const words = textOf(branch)
          if (ONE_WORDS[lang].some((w) => words.includes(w))) out.push(problem('plural-one', `has a "one" branch with a number word or digit instead of {n}; in ${lang} it also shows for 0`))
        }
      }
    })
    if (meta?.maxLength && longest(own.nodes) > meta.maxLength) out.push(problem('length', `is ${longest(own.nodes)} graphemes long; its control fits ${meta.maxLength}`))
    const dnt = dntTerms(english, meta, glossary)
    for (const term of dnt) if (!text.includes(term)) out.push(problem('dnt', `drops or changes the term "${term}", which stays untranslated`))
    if (NON_LATIN.has(lang)) {
      let rest = textOf(own.nodes)
      for (const term of dnt) rest = rest.split(term).join(' ')
      const latin = rest.match(/[A-Za-z]+/g)
      if (latin) out.push(problem('latin', `has Latin letters (${[...new Set(latin)].slice(0, 5).join(', ')}) outside the terms that stay untranslated`))
    }
  }
  if (NON_LATIN.has(lang) && /\?{2,}/.test(text)) out.push(problem('question', 'has a run of "?", the remains of a broken encoding'))

  // Who reviewed and approved it.
  const listed = (id) => reviewers.some((r) => r.id === id && Array.isArray(r.languages) && r.languages.includes(lang))
  if (translated.state === 'reviewed' || translated.state === 'approved') {
    if (!translated.reviewedBy) out.push(problem('reviewer', 'is marked reviewed without a reviewer'))
    else if (!listed(translated.reviewedBy)) out.push(problem('reviewer', `names the reviewer "${translated.reviewedBy}", who is not listed for ${lang} in translations/reviewers.json`))
  }
  if (translated.state === 'approved') {
    if (!translated.approvedBy) out.push(problem('approver', 'is marked approved without an approver'))
    else if (!listed(translated.approvedBy)) out.push(problem('approver', `names the approver "${translated.approvedBy}", who is not listed for ${lang} in translations/reviewers.json`))
    if (translated.approvedBy && translated.approvedBy === translated.reviewedBy) out.push(problem('same-person', 'was approved by the person who reviewed it'))
  }
  if (translated.sourceHash !== files.sourceHash(english)) out.push(problem('stale', 'was made for an earlier English text', 'stale'))
  return out
}

/** The merge groups of the English meta: group → its keys and its `.whole` key (§9.3). */
function mergeGroups(meta) {
  const groups = new Map()
  for (const [key, m] of Object.entries(meta)) {
    if (!m?.merge) continue
    const group = key.slice(0, key.lastIndexOf('.'))
    const g = groups.get(group) ?? { group, keys: [], whole: `${group}.whole` }
    g.keys.push(key)
    groups.set(group, g)
  }
  return groups
}

/**
 * The problems of the English catalogue. `messages` and `meta` are by full key; `usedKeys` is what
 * the code uses (usedKeysOf): `.called` the keys t() and <T> are given, `.has(key)` whether the code
 * uses a key by name or by a key template.
 */
function checkEnglish(messages, meta, usedKeys) {
  const out = []
  const at = (key, p) => ({ key, ...p })
  for (const [key, text] of Object.entries(messages)) {
    if (typeof text !== 'string') {
      out.push(at(key, problem('parse', 'is not a string')))
      continue
    }
    const { nodes, error } = parse(text)
    if (error) out.push(at(key, problem('parse', `does not parse: ${error}`)))
    else out.push(...syntaxProblems(text, nodes).map((p) => at(key, p)))
    if (text.normalize('NFC') !== text) out.push(at(key, problem('nfc', 'is not in NFC')))
    if (BIDI.test(text) || CONTROL.test(text)) out.push(at(key, problem('control', 'holds a bidi, control, tag or replacement character')))
    const m = meta[key]
    if (!m || typeof m.description !== 'string' || !m.description.trim()) out.push(at(key, problem('meta', 'has no meta entry with a description')))
    if (usedKeys && !usedKeys.has(key)) out.push(at(key, problem('unused', 'is not used by any code')))
  }
  for (const key of Object.keys(meta)) if (!(key in messages)) out.push(at(key, problem('meta-orphan', 'has a meta entry but no message')))
  for (const key of usedKeys?.called ?? []) if (!(key in messages)) out.push(at(key, problem('missing-key', 'is used by the code but English does not have it')))
  for (const g of mergeGroups(meta).values()) if (!(g.whole in messages)) out.push(at(g.group, problem('merge-whole', `is a merge group without its whole-sentence message ${g.whole}`)))
  return out
}

/** The merge groups per namespace, for the build's report (§9.3, test 85). */
function mergeReport(meta) {
  const out = {}
  for (const g of mergeGroups(meta).values()) {
    const ns = files.namespaceOf(g.group)
    out[ns] = (out[ns] ?? 0) + 1
  }
  return out
}

/* ---------- what the code uses ---------- */

const T_FUNCTIONS = new Set(['t', 'tParts', 'tNodes'])

/**
 * The keys the source under src/ uses: `called` (literal keys given to t(), tParts(), tNodes() or
 * <T k>), `mentioned` (string literals equal to an English key, as in key tables) and `patterns`
 * (key templates such as `codecs.codec.${c}.label`, where the head names a namespace).
 */
function usedKeysOf(root = files.ROOT, english = files.readEnglish(root).messages) {
  const keys = new Set(Object.keys(english))
  const namespaces = new Set(files.namespacesOf(root))
  const called = new Set()
  const mentioned = new Set()
  const patterns = []
  for (const abs of files.sourceFiles(root)) {
    if (abs.includes(`${path.sep}i18n${path.sep}messages${path.sep}`)) continue
    const text = fs.readFileSync(abs, 'utf8')
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (keys.has(node.text)) mentioned.add(node.text)
        const p = node.parent
        const isTArg = p && ts.isCallExpression(p) && p.arguments[0] === node && ts.isIdentifier(p.expression) && T_FUNCTIONS.has(p.expression.text)
        const isTk = p && ts.isJsxAttribute(p) && p.name.getText(sf) === 'k'
        if ((isTArg || isTk) && namespaces.has(node.text.split('.')[0])) called.add(node.text)
      } else if (ts.isTemplateExpression(node)) {
        const head = node.head.text
        const ns = head.split('.')[0]
        if (head.includes('.') && namespaces.has(ns)) {
          const re = [escapeRe(head), ...node.templateSpans.map((s) => escapeRe(s.literal.text))].join('[^]+?')
          patterns.push(new RegExp(`^${re}$`))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return {
    called,
    mentioned,
    patterns,
    has: (key) => called.has(key) || mentioned.has(key) || patterns.some((re) => re.test(key))
  }
}

module.exports = { RICH_TAGS, ONE_WORDS, graphemes, parse, checkMessage, checkEnglish, mergeGroups, mergeReport, usedKeysOf, dntTerms }
