#!/usr/bin/env node
// Every i18n check (docs/design/output-and-languages.md §16.2, §16.4): the string scanner, the English
// catalogue (keys used and unused, syntax, NFC, meta entries, merge groups), the reviewers' record and
// the glossary, every translation, and the built catalogues against the translations. Run by
// `npm run i18n:check`, by CI and by scripts/predist.mjs (step 5).
//
//   node scripts/i18n/check.mjs [--root <dir>] [--report]
//
// --report keeps the scanner's findings outside config.json's failFor a report, as before step S4;
// without it the scanner follows config.json ("scan": "report" or "fail"), and its words rule
// (tables, copy and sentences made of pieces, step S4b) config.json's "words". Exits 1 on any error.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { runChecks } = require('./lib/checks.cjs')

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const root = path.resolve(rootAt === -1 ? files.ROOT : args[rootAt + 1])
const { errors, warnings, notes } = runChecks(root, { report: args.includes('--report') })

for (const n of notes) console.log(`i18n check: ${n}.`)
for (const w of warnings) console.warn(`i18n check: warning: ${w}.`)
for (const e of errors) console.error(`i18n check: ${e}`)
if (errors.length) {
  console.error(`i18n check: ${errors.length} problem(s).`)
  process.exit(1)
}
console.log('i18n check: every check passed.')
