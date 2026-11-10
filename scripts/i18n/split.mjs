#!/usr/bin/env node
// Splits the extraction between the parts X1-X7 (docs/design/output-and-languages.md §10.5, §21.8):
// writes scripts/i18n/parts.json from the merged tree at step S2, with each part's namespaces and
// files, the files two rules claim and the files with UI text no rule claims. The lead settles both
// lists before S3 starts. X6 works by formatter call line (scripts/i18n/fmt-sites.json), not by file.
//
//   node scripts/i18n/split.mjs [--root <dir>] [--check]
//
// --check writes nothing and exits 1 when a file is claimed twice or not at all.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { splitParts, candidatesOf } = require('./lib/split.cjs')

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const root = path.resolve(rootAt === -1 ? files.ROOT : args[rootAt + 1])
const split = splitParts(candidatesOf(root))
for (const [id, p] of Object.entries(split.parts)) console.log(`i18n split: ${id} (${p.title}): ${p.files.length} file(s).`)
for (const c of split.conflicts) console.log(`i18n split: claimed by ${c.parts.join(' and ')}: ${c.file}`)
for (const f of split.unclaimed) console.log(`i18n split: claimed by no part: ${f}`)
if (args.includes('--check')) process.exit(split.conflicts.length || split.unclaimed.length ? 1 : 0)
const out = path.join(root, files.TOOLS_DIR, 'parts.json')
fs.writeFileSync(out, `${JSON.stringify(split, null, 2)}\n`)
console.log(`i18n split: wrote ${path.relative(root, out)}; settle the ${split.conflicts.length} conflict(s) and ${split.unclaimed.length} unclaimed file(s) before S3.`)
