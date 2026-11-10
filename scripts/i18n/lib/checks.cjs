'use strict'
/**
 * Every i18n check in one run (docs/design/output-and-languages.md §16.2, §16.4), for
 * scripts/i18n/check.mjs, predist step 5 and CI: the scanner, the English catalogue, the reviewers'
 * record, the glossary, every translation, and the built catalogues against what the translations give.
 */
const fs = require('node:fs')
const path = require('node:path')
const files = require('./files.cjs')
const { scanTree } = require('./scan.cjs')
const { checkEnglish, checkMessage, usedKeysOf } = require('./catalogue.cjs')
const { buildCatalogues } = require('./build.cjs')

const AGREEMENTS = ['licence', 'assignment', 'contract']
const GLOSSARY_HEAD = ['term', 'part of speech', 'note', 'do-not-translate']

/** Problems of translations/reviewers.json: each person needs an id, a name, languages, the kind of agreement and the date signed. */
function reviewerProblems(root) {
  const file = path.join(root, files.TRANSLATIONS_DIR, 'reviewers.json')
  if (!fs.existsSync(file)) return []
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return [`translations/reviewers.json is not JSON (${err.message})`]
  }
  const list = Array.isArray(raw) ? raw : raw?.reviewers
  if (!Array.isArray(list)) return ['translations/reviewers.json has no list of reviewers']
  const out = []
  const ids = new Set()
  list.forEach((r, i) => {
    const at = `translations/reviewers.json: reviewer ${i + 1}`
    if (!r || typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) out.push(`${at} needs an id (lower-case letters, digits and -)`)
    else if (ids.has(r.id)) out.push(`${at} repeats the id ${r.id}`)
    else ids.add(r.id)
    if (!r || typeof r.name !== 'string' || !r.name.trim()) out.push(`${at} needs a name`)
    if (!r || !Array.isArray(r.languages) || !r.languages.length || r.languages.some((l) => !files.LANGUAGES.includes(l))) out.push(`${at} needs languages among ${files.LANGUAGES.join(', ')}`)
    if (!r || !AGREEMENTS.includes(r.agreement)) out.push(`${at} needs the kind of agreement (${AGREEMENTS.join(', ')})`)
    if (!r || typeof r.signed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.signed)) out.push(`${at} needs the date the agreement was signed (YYYY-MM-DD)`)
  })
  return out
}

/** Problems of translations/glossary.csv's columns. */
function glossaryProblems(root) {
  const file = path.join(root, files.TRANSLATIONS_DIR, 'glossary.csv')
  if (!fs.existsSync(file)) return []
  const head = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/)[0].split(',').map((h) => h.trim())
  const missing = [...GLOSSARY_HEAD, ...files.LANGUAGES].filter((h) => !head.includes(h))
  return missing.length ? [`translations/glossary.csv lacks the column(s) ${missing.join(', ')}`] : []
}

/**
 * Runs every check. `report` keeps the scanner's findings outside failFor a report whatever
 * config.json says. Returns the errors (any one fails the run), the warnings and short notes.
 */
function runChecks(root = files.ROOT, { report = false } = {}) {
  const errors = []
  const warnings = []
  const notes = []
  const config = files.readConfig(root)

  // 1. The scanner.
  const scan = scanTree(root, { mode: report ? 'report' : config.scan })
  for (const f of scan.failures) errors.push(`${f.file}:${f.line}: UI text without a key (${f.kind}): ${JSON.stringify(f.text)}`)
  if (scan.report.length) notes.push(`scan: ${scan.report.length} text(s) in ${new Set(scan.report.map((f) => f.file)).size} file(s) still to extract`)
  if (scan.pending.length) notes.push(`scan: ${scan.pending.length} text(s) pending in the other account's files`)

  // 2. English.
  const en = files.readEnglish(root)
  for (const [ns, f] of Object.entries(en.files)) if (!f.hasMeta) errors.push(`${files.MESSAGES_DIR}/${ns}.meta.json is missing`)
  for (const p of checkEnglish(en.messages, en.meta, usedKeysOf(root, en.messages))) errors.push(`English ${p.key}: ${p.message}`)
  notes.push(`English: ${Object.keys(en.messages).length} message(s) in ${Object.keys(en.files).length} namespace(s)`)

  // 3. The reviewers and the glossary.
  errors.push(...reviewerProblems(root), ...glossaryProblems(root))

  // 4. Translations.
  const reviewers = files.readReviewers(root)
  const glossary = files.readGlossary(root)
  for (const lang of files.translationLanguages(root)) {
    if (!files.LANGUAGES.includes(lang)) {
      errors.push(`translations/${lang}: Flown has no UI language "${lang}"`)
      continue
    }
    const entries = files.readTranslations(root, lang)
    let stale = 0
    for (const [key, entry] of Object.entries(entries)) {
      if (!(key in en.messages)) {
        warnings.push(`${lang} ${key}: English no longer has this key; it is left out`)
        continue
      }
      for (const p of checkMessage(lang, en.messages[key], en.meta[key], entry, glossary, reviewers)) {
        if (p.level === 'stale') stale++
        else errors.push(`${lang} ${key}: ${p.message}`)
      }
    }
    if (stale) warnings.push(`${lang}: ${stale} translation(s) are stale (English changed); they are left out until approved again`)
    notes.push(`${lang}: ${Object.keys(entries).length} translation(s)`)
  }

  // 5. The built catalogues.
  const built = buildCatalogues(root)
  const dir = path.join(root, files.BUILT_DIR)
  const present = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  for (const [name, text] of Object.entries(built.files)) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) errors.push(`${files.BUILT_DIR}/${name} is missing: run npm run i18n:build`)
    else if (fs.readFileSync(file, 'utf8') !== text) errors.push(`${files.BUILT_DIR}/${name} differs from what the translations give: run npm run i18n:build`)
  }
  for (const name of present) if (!(name in built.files)) errors.push(`${files.BUILT_DIR}/${name} should not be there: its language does not ship`)
  return { errors, warnings, notes, scan }
}

module.exports = { runChecks, reviewerProblems, glossaryProblems }
