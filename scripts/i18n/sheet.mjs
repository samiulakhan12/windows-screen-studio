#!/usr/bin/env node
// The review sheet (docs/design/output-and-languages.md §15.4).
//
//   node scripts/i18n/sheet.mjs export --lang bn [--out <file>]
//     writes translations/bn/review.csv (UTF-8 with a byte-order mark, so Excel reads Bangla), stale
//     strings first. Reviewers correct the "final" column, set "state", and save with Excel's
//     "CSV UTF-8 (Comma delimited)".
//   node scripts/i18n/sheet.mjs import --lang bn --file <csv> --by <reviewer id> [--date YYYY-MM-DD]
//     checks every changed row, records the person and the date, and writes translations/bn/*.json.
//     Writes nothing when the file or any row is refused, and says why.
//
// Both take --root <dir> (the repository by default).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { exportSheet, importSheet } = require('./lib/sheet.cjs')

const [command, ...args] = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const root = path.resolve(option('--root') ?? files.ROOT)
const lang = option('--lang')
const fail = (msg) => {
  console.error(`i18n sheet: ${msg}`)
  process.exit(1)
}
if (!lang || !files.LANGUAGES.includes(lang)) fail(`give --lang, one of ${files.LANGUAGES.join(', ')}.`)
const en = files.readEnglish(root)
const translations = files.readTranslations(root, lang)

if (command === 'export') {
  const out = path.resolve(option('--out') ?? path.join(root, files.TRANSLATIONS_DIR, lang, 'review.csv'))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, exportSheet({ lang, english: en.messages, meta: en.meta, translations }))
  console.log(`i18n sheet: wrote ${path.relative(root, out)} (${Object.keys(en.messages).length} row(s)). Save it from Excel as "CSV UTF-8 (Comma delimited)".`)
} else if (command === 'import') {
  const file = option('--file')
  const by = option('--by')
  if (!file || !by) fail('give --file <csv> and --by <your id in translations/reviewers.json>.')
  const date = option('--date') ?? new Date().toISOString().slice(0, 10)
  let result
  try {
    result = importSheet({ lang, bytes: fs.readFileSync(path.resolve(file)), english: en.messages, meta: en.meta, translations, reviewers: files.readReviewers(root), glossary: files.readGlossary(root), by, date })
  } catch (err) {
    fail(err.message)
  }
  if (result.refused.length) {
    for (const r of result.refused) console.error(`i18n sheet: ${r.key}: ${r.reason}`)
    fail(`${result.refused.length} row(s) refused; nothing was written. Correct them and import again.`)
  }
  files.writeTranslations(root, lang, result.entries, Object.keys(en.messages))
  console.log(`i18n sheet: ${result.changed.length} string(s) recorded for ${lang} by ${by} on ${date}.`)
} else {
  fail('use "export" or "import".')
}
