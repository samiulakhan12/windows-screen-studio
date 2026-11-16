#!/usr/bin/env node
// The string scanner (docs/design/output-and-languages.md §16.1): every UI text in src/ comes from a
// message key. Findings in config.json's failFor files fail; the rest of the tree is a report until
// step S4 sets "scan": "fail"; the other account's files (pending.json) are listed as pending. The
// words rule (tables, copy and sentences made of pieces, step S4b) follows config.json's "words",
// "fail" since S4b's integration (--words overrides it).
//
//   node scripts/i18n/scan.mjs [--root <dir>] [--mode report|fail] [--words report|fail] [--verbose] [--json]
//
// Exits 1 when a finding fails.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { scanTree } = require('./lib/scan.cjs')
const files = require('./lib/files.cjs')

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const root = path.resolve(option('--root') ?? files.ROOT)
const mode = option('--mode')
const result = scanTree(root, { mode, wordsMode: option('--words') })
const line = (f) => `  ${f.file}:${f.line}  ${f.kind}  ${JSON.stringify(f.text)}`

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  if (result.failures.length) {
    console.error(`scan: ${result.failures.length} UI text(s) without a key:`)
    for (const f of result.failures) console.error(line(f))
  }
  if (result.report.length) {
    const byFile = new Map()
    for (const f of result.report) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1)
    console.log(`scan: report: ${result.report.length} text(s) in ${byFile.size} file(s) still to extract (they fail once config.json says "scan": "fail").`)
    if (args.includes('--verbose')) for (const f of result.report) console.log(line(f))
  }
  if (result.words.length) {
    const count = (kind) => result.words.filter((f) => f.kind === kind).length
    console.log(`scan: words report: ${count('table')} table text(s), ${count('copy')} copy text(s) and ${count('fragment')} sentence(s) in pieces in ${new Set(result.words.map((f) => f.file)).size} file(s) (they fail once config.json says "words": "fail").`)
    if (args.includes('--verbose')) for (const f of result.words) console.log(line(f))
  }
  if (result.pending.length) console.log(`scan: pending: ${result.pending.length} text(s) in the other account's files (pending.json), not failures.`)
  console.log(`scan: ${result.files} file(s) read, ${result.failures.length} failing.`)
}
process.exit(result.failures.length ? 1 : 0)
