'use strict'
/**
 * The formatter call sites (docs/design/output-and-languages.md §10.5, §11, part X6): every place our
 * code formats a number, size, time, date or list with one of today's helpers instead of `fmt`. Built
 * on the TypeScript compiler API, like the scanner. It finds
 *
 * - `helper`: a use of one of the helpers `fmt`'s English profile replaces (§11.2): a call, or the
 *   function handed on by name (`format={formatLevel}`). The helpers' own definitions are not uses;
 * - `locale`: toLocaleString / toLocaleDateString / toLocaleTimeString with no locale, `undefined`, or
 *   one of the locales the English profile names ('en-US', 'en-GB').
 *
 * `scripts/i18n/fmt-sites.json` lists every site X6 moved to `fmt` and every use left as it is, with
 * the reason (text that must stay ASCII or English: exported files, AI prompts, logs, the recording
 * side's own helper). Test 73 (`tests/i18nFmtSites.test.ts`) requires the list and the tree to agree.
 * The other account's files (pending.json) are theirs and not listed (§9.5).
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const files = require('./files.cjs')
const { matchesAny } = require('./scan.cjs')

/** Today's helpers, by name, that `fmt` replaces in the UI (§10.5's list, formatTime at our sites, and the rest of §11.2). */
const HELPERS = Object.freeze([
  'formatTime',
  'formatClock',
  'formatDuration',
  'formatBytes',
  'sizeText',
  'clockTime',
  'formatTick',
  'formatLevel',
  'formatRate',
  'zoomText',
  'lengthText',
  'versionTime',
  'usedAgo',
  'listPhrase'
])
const HELPER_SET = new Set(HELPERS)
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'])
/** Locales the English profile names: a call with one of these formats as `fmt` does in English. */
const ENGLISH_LOCALES = new Set(['en-US', 'en-GB'])
/** fmt itself: the English profile is today's helpers, moved. */
const FMT_FILE = 'src/shared/i18n/fmt.ts'

const scriptKind = (file) => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

/** The name a declaration gives, when `id` is that name (not a use). */
function isDeclarationName(id) {
  const p = id.parent
  if (!p) return false
  if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isBindingElement(p)) && p.name === id) return true
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true
  if (ts.isJsxAttribute(p) && p.name === id) return true
  return false
}

/** The helper whose definition holds `node` (a site inside a helper is the helper itself), or null. */
function enclosingHelper(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name && HELPER_SET.has(n.name.text)) return n.name.text
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) && HELPER_SET.has(n.parent.name.text)) return n.parent.name.text
  }
  return null
}

/** The expression a site shows in the inventory: the whole call, or the name handed on. */
function siteExpression(id) {
  const p = id.parent
  if (ts.isCallExpression(p) && p.expression === id) return p
  return id
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/** The formatter sites of one file: `{ file, line, kind, helper, text }` in the order they are written. */
function sitesOf(file, text) {
  if (file === FMT_FILE) return []
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const out = []
  const add = (node, kind, helper) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    out.push({ file, line, kind, helper, text: oneLine(node.getText(sf)).slice(0, 160) })
  }
  const visit = (node) => {
    if (ts.isIdentifier(node) && HELPER_SET.has(node.text) && !isDeclarationName(node) && enclosingHelper(node) !== node.text) {
      add(siteExpression(node), 'helper', node.text)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LOCALE_METHODS.has(node.expression.name.text) && !enclosingHelper(node)) {
      const first = node.arguments[0]
      const none = !first || (ts.isIdentifier(first) && first.text === 'undefined')
      const english = !!first && ts.isStringLiteral(first) && ENGLISH_LOCALES.has(first.text)
      if (none || english) add(node, 'locale', node.expression.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Every formatter site in the tree's own files (the other account's, pending.json, left out). */
function sitesOfTree(root = files.ROOT) {
  const pending = files.readPending(root)
  const out = []
  for (const abs of files.sourceFiles(root)) {
    const file = files.rel(root, abs)
    if (matchesAny(file, pending.files)) continue
    out.push(...sitesOf(file, fs.readFileSync(abs, 'utf8')))
  }
  return out
}

/** scripts/i18n/fmt-sites.json. */
const readFmtSites = (root = files.ROOT) => JSON.parse(fs.readFileSync(path.join(root, files.TOOLS_DIR, 'fmt-sites.json'), 'utf8'))

/**
 * The tree against fmt-sites.json: `unlisted` are sites the tree has and the list does not keep (a
 * formatter call not moved to fmt, nor kept with a reason); `stale` are kept entries no site matches.
 * A kept entry matches the sites of its file whose kind, helper and text are its own, as many as its
 * `count` (1 by default), so line numbers may move as the parts edit the files.
 */
function compareSites(sites, list) {
  const kept = (list.kept ?? []).map((k) => ({ ...k, left: k.count ?? 1 }))
  const unlisted = []
  for (const s of sites) {
    const k = kept.find((e) => e.left > 0 && e.file === s.file && e.kind === s.kind && e.helper === s.helper && e.text === s.text)
    if (k) k.left--
    else unlisted.push(s)
  }
  const stale = kept.filter((k) => k.left > 0).map(({ left, ...k }) => ({ ...k, missing: left }))
  return { unlisted, stale }
}

/** How often `needle` occurs in `text`. */
function occurrences(text, needle) {
  let n = 0
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) n++
  return n
}

/**
 * Moved sites whose call is not in their file: for each file and each `now` call, the file must hold
 * it at least as often as the list names it. Line numbers are where the calls were at S3a; the parts
 * after it move lines, so they are not compared.
 */
function missingSites(list, root = files.ROOT) {
  const want = new Map()
  for (const s of list.sites ?? []) {
    const key = `${s.file}\u0000${s.now}`
    want.set(key, { file: s.file, now: s.now, n: (want.get(key)?.n ?? 0) + 1 })
  }
  const missing = []
  const texts = new Map()
  for (const w of want.values()) {
    const abs = path.join(root, w.file)
    if (!texts.has(w.file)) texts.set(w.file, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '')
    const have = occurrences(texts.get(w.file), w.now)
    if (have < w.n) missing.push({ file: w.file, now: w.now, listed: w.n, found: have })
  }
  return missing
}

/** The whole check of scripts/i18n/fmt-sites.mjs and test 73: unlisted formatter calls, stale kept entries, moved calls not found. */
function checkFmtSites(root = files.ROOT) {
  const list = readFmtSites(root)
  return { ...compareSites(sitesOfTree(root), list), missing: missingSites(list, root) }
}

module.exports = { HELPERS, ENGLISH_LOCALES, sitesOf, sitesOfTree, readFmtSites, compareSites, missingSites, checkFmtSites }
