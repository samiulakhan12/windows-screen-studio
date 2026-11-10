'use strict'
/**
 * Where the i18n tools find things, and how they read them (docs/design/output-and-languages.md §9.2):
 * the English namespaces and their meta files, the translations, the reviewers, the glossary and the
 * tools' own settings. Every function takes the repository root, so tests run on fixture trees.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { parseCsv } = require('./csv.cjs')

/** The repository this checkout is. */
const ROOT = path.resolve(__dirname, '..', '..', '..')

const MESSAGES_DIR = 'src/shared/i18n/messages/en'
const BUILT_DIR = 'src/shared/i18n/built'
const TRANSLATIONS_DIR = 'translations'
const TOOLS_DIR = 'scripts/i18n'

/** The namespaces main carries (§9.1, test 86). */
const MAIN_NAMESPACES = Object.freeze(['common', 'errors', 'main'])
/** Namespaces outside the core: a language ships without them fully approved (§9.2, §0 decision 7). */
const NOT_CORE = Object.freeze(['commands', 'review', 'smart', 'recording'])
/** The other account's namespace: a language is a preview until it is approved (§0 decision 11). */
const RECORDING_NAMESPACE = 'recording'
/** The UI languages a catalogue can be built for (UiLanguage without English). */
const LANGUAGES = Object.freeze(['bn', 'es', 'hi'])

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** The English namespaces, from the files in messages/en (`<ns>.json` beside `<ns>.meta.json`), sorted. */
function namespacesOf(root = ROOT) {
  return fs
    .readdirSync(path.join(root, MESSAGES_DIR))
    .filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
}

/** True for a core namespace (§9.2). */
const isCore = (ns) => !NOT_CORE.includes(ns)

/** The namespace of a full key ('codecs.hevc.title' → 'codecs'). */
const namespaceOf = (key) => key.slice(0, key.indexOf('.'))

/**
 * The English catalogue: every message and meta entry by full key, the namespace of each key, and
 * the raw files (for problems that point at a file).
 */
function readEnglish(root = ROOT) {
  const messages = {}
  const meta = {}
  const files = {}
  for (const ns of namespacesOf(root)) {
    const file = path.join(root, MESSAGES_DIR, `${ns}.json`)
    const metaFile = path.join(root, MESSAGES_DIR, `${ns}.meta.json`)
    const own = readJson(file)
    const ownMeta = fs.existsSync(metaFile) ? readJson(metaFile) : null
    files[ns] = { file, metaFile, hasMeta: ownMeta !== null }
    for (const [k, v] of Object.entries(own)) messages[`${ns}.${k}`] = v
    for (const [k, v] of Object.entries(ownMeta ?? {})) meta[`${ns}.${k}`] = v
  }
  return { messages, meta, files }
}

/** The first 12 hex digits of SHA-256 of an English message: a translation of another text is stale (§9.2). */
const sourceHash = (english) => crypto.createHash('sha256').update(english, 'utf8').digest('hex').slice(0, 12)

/** The languages with a translations folder. */
function translationLanguages(root = ROOT) {
  const dir = path.join(root, TRANSLATIONS_DIR)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[a-z]{2,3}$/.test(d.name))
    .map((d) => d.name)
    .sort()
}

/** A language's translation entries by full key (`translations/<lang>/<ns>.json`). */
function readTranslations(root, lang) {
  const dir = path.join(root, TRANSLATIONS_DIR, lang)
  const out = {}
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue
    const ns = f.slice(0, -'.json'.length)
    for (const [k, v] of Object.entries(readJson(path.join(dir, f)))) out[`${ns}.${k}`] = v
  }
  return out
}

/** Writes a language's entries back, one file per namespace, keys in English order, two-space JSON. */
function writeTranslations(root, lang, entries, englishKeys) {
  const dir = path.join(root, TRANSLATIONS_DIR, lang)
  fs.mkdirSync(dir, { recursive: true })
  const byNs = {}
  const order = new Map(englishKeys.map((k, i) => [k, i]))
  for (const key of Object.keys(entries).sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))) {
    const ns = namespaceOf(key)
    ;(byNs[ns] ??= {})[key.slice(ns.length + 1)] = entries[key]
  }
  for (const [ns, list] of Object.entries(byNs)) fs.writeFileSync(path.join(dir, `${ns}.json`), `${JSON.stringify(list, null, 2)}\n`)
}

/** The people who may review and approve (`translations/reviewers.json`, §15.1). */
function readReviewers(root = ROOT) {
  const file = path.join(root, TRANSLATIONS_DIR, 'reviewers.json')
  if (!fs.existsSync(file)) return []
  const raw = readJson(file)
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.reviewers) ? raw.reviewers : []
  return list.filter((r) => r && typeof r.id === 'string' && r.id && Array.isArray(r.languages))
}

/** The glossary rows (`translations/glossary.csv`, §15.2): term, part of speech, note, do-not-translate, then one column per language. */
function readGlossary(root = ROOT) {
  const file = path.join(root, TRANSLATIONS_DIR, 'glossary.csv')
  if (!fs.existsSync(file)) return []
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  const [head, ...body] = rows
  if (!head) return []
  return body
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => {
      const row = {}
      head.forEach((h, i) => {
        row[h.trim()] = (r[i] ?? '').trim()
      })
      return { ...row, dnt: /^(yes|true|1|x)$/i.test(row['do-not-translate'] ?? '') }
    })
}

/** The scanner's settings, exceptions and pending files (§16.1). */
const readConfig = (root = ROOT) => readJson(path.join(root, TOOLS_DIR, 'config.json'))
const readOptionalJson = (file, empty) => (fs.existsSync(file) ? readJson(file) : empty)
const readAllow = (root = ROOT) => readOptionalJson(path.join(root, TOOLS_DIR, 'allow.json'), { files: [], texts: [], sites: [] })
const readPending = (root = ROOT) => readOptionalJson(path.join(root, TOOLS_DIR, 'pending.json'), { files: [] })

/** Repository-relative path with forward slashes. */
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/')

/** Every file under `dir` (absolute) whose name passes `keep`, sorted. */
function walk(dir, keep) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p, keep))
    else if (keep(p)) out.push(p)
  }
  return out.sort()
}

/** The app's source files the scanner reads: TypeScript and TSX under src/, declarations left out. */
const sourceFiles = (root = ROOT) => walk(path.join(root, 'src'), (p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts'))

module.exports = {
  ROOT,
  MESSAGES_DIR,
  BUILT_DIR,
  TRANSLATIONS_DIR,
  TOOLS_DIR,
  MAIN_NAMESPACES,
  NOT_CORE,
  RECORDING_NAMESPACE,
  LANGUAGES,
  readJson,
  namespacesOf,
  isCore,
  namespaceOf,
  readEnglish,
  sourceHash,
  translationLanguages,
  readTranslations,
  writeTranslations,
  readReviewers,
  readGlossary,
  readConfig,
  readAllow,
  readPending,
  rel,
  walk,
  sourceFiles
}
