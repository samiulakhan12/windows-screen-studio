#!/usr/bin/env node
// The extraction codemod (docs/design/output-and-languages.md §10.2): proposes keys for the UI text
// of the files given, for a person to read and apply by hand. It never changes a source file, never
// commits, and reads only the files given.
//
//   node scripts/i18n/extract.mjs --ns <namespace> --files <file>[,<file>…] [--out <dir>] [--root <dir>]
//
// Writes, under --out (scripts/i18n/extract/ by default, not committed):
// - extract.patch: the source changes as a unified diff;
// - proposal.json: the messages and meta entries to add to src/shared/i18n/messages/en/<ns>.json and
//   <ns>.meta.json, the rows for the part's scripts/i18n/log/<part>.json (test 69), and what is left
//   for a hand edit, with the reason.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { extractSource, applyEdits } = require('./lib/extract.cjs')

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const fail = (msg) => {
  console.error(`i18n extract: ${msg}`)
  process.exit(1)
}
const root = path.resolve(option('--root') ?? files.ROOT)
const ns = option('--ns')
const list = (option('--files') ?? '').split(',').map((f) => f.trim()).filter(Boolean)
const out = path.resolve(option('--out') ?? path.join(root, files.TOOLS_DIR, 'extract'))
if (!ns || !files.namespacesOf(root).includes(ns)) fail('give --ns, one of the English namespaces.')
if (!list.length) fail('give --files, a comma-separated list of files under src/.')

const english = files.readEnglish(root).messages
const taken = new Set(Object.keys(english))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-extract-'))
const proposal = { namespace: ns, messages: {}, meta: {}, log: [], manual: [] }
let patch = ''
try {
  for (const rel of list) {
    const file = rel.split(path.sep).join('/')
    const abs = path.resolve(root, file)
    if (!abs.startsWith(path.join(root, 'src') + path.sep) || !/\.(ts|tsx)$/.test(file) || !fs.existsSync(abs)) fail(`${file} is not a TypeScript file under src/.`)
    const text = fs.readFileSync(abs, 'utf8')
    const r = extractSource({ file, text, ns, taken, english })
    Object.assign(proposal.messages, r.messages)
    Object.assign(proposal.meta, r.meta)
    proposal.log.push(...r.log)
    proposal.manual.push(...r.manual)
    if (!r.edits.length) continue
    for (const [side, body] of [['a', text], ['b', applyEdits(file, text, r)]]) {
      fs.mkdirSync(path.dirname(path.join(tmp, side, file)), { recursive: true })
      fs.writeFileSync(path.join(tmp, side, file), body)
    }
    const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '--', path.join('a', file), path.join('b', file)], { cwd: tmp, encoding: 'utf8' })
    patch += diff.stdout.replace(/^diff --git a\/a\/(\S+) b\/b\/\S+$/gm, 'diff --git a/$1 b/$1').replace(/^--- a\/a\//gm, '--- a/').replace(/^\+\+\+ b\/b\//gm, '+++ b/')
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'extract.patch'), patch)
fs.writeFileSync(path.join(out, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`)
console.log(`i18n extract: ${Object.keys(proposal.messages).length} message(s) proposed in ${ns}, ${proposal.manual.length} place(s) left for a hand edit.`)
console.log(`i18n extract: read ${path.relative(root, path.join(out, 'extract.patch'))} and ${path.relative(root, path.join(out, 'proposal.json'))}; nothing else was changed.`)
