#!/usr/bin/env node
// Step S4b's inventory (docs/design/output-and-languages.md §9.1, §9.3, §16.1): every word table, copy
// text and sentence in pieces the scanner's words rule finds still in English, with the three disjoint
// groups of files for the builders, written to scripts/i18n/s4b-sites.json.
//
//   node scripts/i18n/s4b-sites.mjs [--root <dir>] [--check]
//
// --check writes nothing and exits 1 when the file differs from what the tree gives.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { INVENTORY, inventoryJson } = require('./lib/s4bSites.cjs')

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const root = path.resolve(rootAt === -1 ? files.ROOT : args[rootAt + 1])
const text = inventoryJson(root)
const inv = JSON.parse(text)
const file = path.join(root, INVENTORY)
console.log(`i18n s4b sites: ${inv.counts.sites} site(s) in ${inv.counts.files} file(s): ${inv.counts.tables} table, ${inv.counts.copy} copy, ${inv.counts.fragments} fragment.`)
for (const [g, v] of Object.entries(inv.groups)) console.log(`i18n s4b sites: group ${g}: ${v.files.length} file(s), ${v.sites} site(s).`)
if (args.includes('--check')) {
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text
  if (!same) console.error(`i18n s4b sites: ${INVENTORY} differs from the tree: run node scripts/i18n/s4b-sites.mjs`)
  process.exit(same ? 0 : 1)
}
fs.writeFileSync(file, text)
console.log(`i18n s4b sites: wrote ${INVENTORY}.`)
