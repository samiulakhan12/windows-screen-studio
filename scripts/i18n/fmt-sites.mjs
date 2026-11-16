#!/usr/bin/env node
// Part X6's formatter call sites (docs/design/output-and-languages.md §10.5, §11.2): lists every place
// our files still format a number, size, time, date or list with one of today's helpers instead of
// fmt, against scripts/i18n/fmt-sites.json (the calls moved to fmt, and those kept with a reason).
//
//   node scripts/i18n/fmt-sites.mjs [--root <dir>] [--check]
//
// --check exits 1 when a formatter call is neither moved nor kept, a kept entry matches nothing, or a
// moved call is no longer in its file. Test 73 runs the same check.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { checkFmtSites, readFmtSites } = require('./lib/fmtSites.cjs')

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const root = path.resolve(rootAt === -1 ? files.ROOT : args[rootAt + 1])
const list = readFmtSites(root)
const { unlisted, stale, missing } = checkFmtSites(root)
console.log(`i18n fmt sites: ${list.sites.length} moved to fmt, ${list.kept.length} kept with a reason.`)
for (const s of unlisted) console.log(`i18n fmt sites: not moved and not kept: ${s.file}:${s.line} ${s.text}`)
for (const k of stale) console.log(`i18n fmt sites: kept entry matches nothing: ${k.file} ${k.text}`)
for (const m of missing) console.log(`i18n fmt sites: moved call not found: ${m.file} ${m.now} (listed ${m.listed}, found ${m.found})`)
if (args.includes('--check')) process.exit(unlisted.length || stale.length || missing.length ? 1 : 0)
