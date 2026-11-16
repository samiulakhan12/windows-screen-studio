#!/usr/bin/env node
// Part X7's right-to-left styles (docs/design/output-and-languages.md §13.1, §21.8): lists every
// physical left or right in our stylesheets against scripts/i18n/rtl-sites.json (what stays physical,
// with its reason; the containers that keep left to right; the rules only a right-to-left page uses).
//
//   node scripts/i18n/rtl-sites.mjs [--root <dir>] [--check] [--convert]
//
// --convert is the codemod: it turns every physical declaration that has a logical form and is not
// kept into that form (margin-left to margin-inline-start, left to inset-inline-start, text-align:
// left to start, a shorthand's two sides to its -block and -inline pair, …), in place, and lists what
// is left for a hand edit. In a left-to-right page each computes to the same box.
// --check exits 1 when a physical declaration is neither converted nor kept, a kept entry matches
// nothing, a listed container lacks direction: ltr, or a :dir() rule is missing from the list or
// unlisted. Test 76 runs the same check.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { checkRtlSites, convertStylesheet, readRtlSites, stylesheetsOf } = require('./lib/rtlSites.cjs')

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const root = path.resolve(rootAt === -1 ? files.ROOT : args[rootAt + 1])
const sites = readRtlSites(root)

if (args.includes('--convert')) {
  for (const file of stylesheetsOf(root)) {
    const abs = path.join(root, file)
    const r = convertStylesheet(file, fs.readFileSync(abs, 'utf8'), sites.kept)
    if (r.changed.length) fs.writeFileSync(abs, r.css)
    for (const c of r.changed) console.log(`i18n rtl: ${file}:${c.line} ${c.rule} { ${c.prop}: ${c.value} } -> { ${c.to} }`)
    for (const l of r.left) console.log(`i18n rtl: left for a hand edit: ${file}:${l.line} ${l.rule} { ${l.prop}: ${l.value} }`)
  }
}

const r = checkRtlSites(root, sites)
const keptDecls = sites.kept.reduce((n, k) => n + k.props.length, 0)
console.log(`i18n rtl: ${r.files.length} stylesheets; ${keptDecls} physical declarations kept in ${sites.kept.length} rules, ${sites.ltr.length} left-to-right containers, ${sites.rtl.length} right-to-left rules.`)
for (const s of r.unlisted) console.log(`i18n rtl: physical and not kept: ${s.file}:${s.line} ${s.rule} { ${s.prop}: ${s.value} }`)
for (const k of r.stale) console.log(`i18n rtl: kept entry matches nothing: ${k.file} ${k.rule} { ${k.prop} }`)
for (const k of r.unknownReason) console.log(`i18n rtl: kept entry with an unknown reason: ${k.file} ${k.rule} (${k.reason})`)
for (const k of r.mirrorMissing) console.log(`i18n rtl: kept entry's mirror is not a listed rtl rule: ${k.file} ${k.rule} -> ${k.mirror}`)
for (const l of r.ltrMissing) console.log(`i18n rtl: container without direction: ltr: ${l.file} ${l.rule}`)
for (const x of r.rtlMissing) console.log(`i18n rtl: right-to-left rule missing: ${x.file} ${x.rule}`)
for (const x of r.rtlUnlisted) console.log(`i18n rtl: :dir() rule not listed: ${x.file} ${x.rule}`)
const problems = r.unlisted.length + r.stale.length + r.unknownReason.length + r.mirrorMissing.length + r.ltrMissing.length + r.rtlMissing.length + r.rtlUnlisted.length
if (args.includes('--check')) process.exit(problems ? 1 : 0)
