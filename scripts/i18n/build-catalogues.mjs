#!/usr/bin/env node
// Builds the catalogues that ship (docs/design/output-and-languages.md §9.2, §15.6) from translations/:
// src/shared/i18n/built/<lang>.json and <lang>.main.json for each language that ships, and
// shipped.json, the languages the picker offers. Only approved, current strings reviewed and
// approved by two different listed people ship; the rest shows in English, string by string.
// Prints each language's completeness and the merge groups per namespace.
//
//   node scripts/i18n/build-catalogues.mjs [--root <dir>] [--check]
//
// --check writes nothing and exits 1 when the committed built files differ from what the
// translations give (or a built file is there that should not be).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { buildCatalogues } = require('./lib/build.cjs')

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const root = path.resolve(rootAt === -1 ? files.ROOT : args[rootAt + 1])
const check = args.includes('--check')
const dir = path.join(root, files.BUILT_DIR)
const { files: wanted, languages, merge } = buildCatalogues(root)

for (const l of languages) {
  const pct = (l.share * 100).toFixed(1)
  const state = l.ships ? (l.preview ? 'ships as a preview' : 'ships') : 'does not ship'
  console.log(`i18n build: ${l.language}: ${Object.keys(l.messages).length} string(s) ship, ${pct}% of its keys, ${l.coreMissing.length} core key(s) missing, ${l.wholeMissing.length} whole sentence(s) missing: ${state}.`)
  const reasons = new Map()
  for (const d of l.dropped) reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1)
  for (const [reason, n] of reasons) console.log(`  left out: ${n} (${reason})`)
}
const groups = Object.entries(merge)
console.log(groups.length ? `i18n build: merge groups: ${groups.map(([ns, n]) => `${ns} ${n}`).join(', ')}.` : 'i18n build: merge groups: none.')

const present = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
if (check) {
  const problems = []
  for (const [name, text] of Object.entries(wanted)) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) problems.push(`${name} is missing`)
    else if (fs.readFileSync(file, 'utf8') !== text) problems.push(`${name} differs from what the translations give`)
  }
  for (const name of present) if (!(name in wanted)) problems.push(`${name} should not be there (its language does not ship)`)
  for (const p of problems) console.error(`i18n build: ${files.BUILT_DIR}/${p}.`)
  if (problems.length) {
    console.error('i18n build: run npm run i18n:build and commit the result.')
    process.exit(1)
  }
  console.log('i18n build: the built catalogues match the translations.')
} else {
  fs.mkdirSync(dir, { recursive: true })
  for (const name of present) if (!(name in wanted)) fs.rmSync(path.join(dir, name))
  for (const [name, text] of Object.entries(wanted)) fs.writeFileSync(path.join(dir, name), text)
  console.log(`i18n build: wrote ${Object.keys(wanted).length} file(s) to ${files.BUILT_DIR}.`)
}
