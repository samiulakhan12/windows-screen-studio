#!/usr/bin/env node
// Drafts one namespace's translations with an AI service (docs/design/output-and-languages.md §15.3).
// For a person on their own PC with their own key, at development time only: it is not part of the
// app, never ships, and the app never calls it. Drafts are only drafts: two reviewers correct and
// approve every string before anything ships (translations/README.md).
//
//   FLOWN_DRAFT_API_KEY=<your key> node scripts/i18n/draft.mjs --lang bn --ns export \
//     --service-name "<service, as named in translations/README.md>" --service-url <…/chat/completions> \
//     --model <model> [--shots <folder of the guard tour's screenshots>]
//
// Before it sends anything:
// - translations/README.md must name the service on the language's row (its terms must allow
//   commercial use of its output);
// - the service URL must be https (a service on this PC may use http://127.0.0.1 or localhost).
// It sends one namespace's English messages, their descriptions, placeholders, plural categories and
// length limits, the glossary rows and, with --shots, the screenshots of the screens they appear on.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { draftRequest, parseDraftReply, applyDrafts, chatService, serviceNamed } = require('./lib/draft.cjs')

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const fail = (msg) => {
  console.error(`i18n draft: ${msg}`)
  process.exit(1)
}
const root = path.resolve(option('--root') ?? files.ROOT)
const lang = option('--lang')
const ns = option('--ns')
const serviceName = option('--service-name')
const url = option('--service-url')
const model = option('--model')
const shots = option('--shots')
const apiKey = process.env.FLOWN_DRAFT_API_KEY

if (!lang || !files.LANGUAGES.includes(lang)) fail(`give --lang, one of ${files.LANGUAGES.join(', ')}.`)
if (!ns || !files.namespacesOf(root).includes(ns)) fail('give --ns, one of the English namespaces.')
if (!serviceName || !url || !model) fail('give --service-name, --service-url and --model.')
if (!apiKey) fail('set FLOWN_DRAFT_API_KEY to your own key for the service.')
let host
try {
  const u = new URL(url)
  host = u.hostname
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost'))) fail('the service URL must be https.')
} catch {
  fail('the service URL is not a URL.')
}
const readme = fs.readFileSync(path.join(root, files.TRANSLATIONS_DIR, 'README.md'), 'utf8')
if (!serviceNamed(readme, lang, serviceName)) fail(`translations/README.md does not name "${serviceName}" for ${lang}. Check that its terms allow commercial use of its output, name it there, then draft.`)

const en = files.readEnglish(root)
const screens = {}
if (shots) {
  for (const f of fs.existsSync(shots) ? fs.readdirSync(shots) : []) if (f.endsWith('.png')) screens[f.slice(0, -4)] = path.join(shots, f)
}
const request = draftRequest({ lang, ns, english: en.messages, meta: en.meta, glossary: files.readGlossary(root), screens })
if (!request.keys.length) fail(`the namespace ${ns} has no English messages.`)
console.log(`i18n draft: asking ${serviceName} (${host}) for ${request.keys.length} ${lang} message(s) of ${ns}, with ${request.images.length} screenshot(s).`)
const service = chatService({ url, apiKey, model, readFile: (f) => fs.readFileSync(f) })
let drafts
try {
  drafts = parseDraftReply(await service(request), request.keys)
} catch (err) {
  fail(err.message)
}
const result = applyDrafts({ lang, english: en.messages, meta: en.meta, glossary: files.readGlossary(root), reviewers: files.readReviewers(root), existing: files.readTranslations(root, lang), drafts, serviceName })
files.writeTranslations(root, lang, result.entries, Object.keys(en.messages))
console.log(`i18n draft: ${result.written.length} draft(s) written, ${result.noted.length} with a note from the checks, ${result.kept.length} reviewed or approved string(s) kept, ${request.keys.length - Object.keys(drafts).length} not answered.`)
