'use strict'
/**
 * Drafts by an AI service, at development time only (docs/design/output-and-languages.md §15.3). A
 * person runs scripts/i18n/draft.mjs on their own PC with their own key; the app never calls it.
 *
 * - The request holds only one namespace's English messages with their descriptions, placeholders,
 *   the plural categories the language needs, the length limits, the glossary rows and, when given,
 *   the guard tour's screenshots of fixture projects: never a user's data.
 * - It asks for ICU messages with the placeholders unchanged, only `other` in Bangla and Hindi plurals,
 *   and whole sentences in the language's own word order.
 * - Each draft is written with `state: "draft"`, the English `sourceHash` and the service's name; a
 *   draft that fails the catalogue checks keeps the checks' message as its note and is never dropped.
 *   A reviewed or approved string of today's English is never replaced.
 */
const path = require('node:path')
const files = require('./files.cjs')
const { checkMessage } = require('./catalogue.cjs')
const { loadTs } = require('./tsload.cjs')

const icu = loadTs(path.join(__dirname, '..', '..', '..', 'src', 'shared', 'i18n', 'icu.ts'))

const LANGUAGE_NAMES = { bn: 'Bangla (Bangladesh standard forms)', es: 'Spanish', hi: 'Hindi' }
/** What each language's drafts must follow beyond the glossary. */
const LANGUAGE_RULES = {
  bn: [
    'Write standard Bangla as used in Bangladesh: Bangla Academy spelling, address the user as আপনি, no Sadhu bhasha, end sentences with the dari (।).',
    'Use the English loanword in Bangla script where that is the common word (এক্সপোর্ট, আনডু, কপি, ক্লিপ, জুম), as the glossary says.',
    'Plurals hold only the "other" category: {count, plural, other {...}}.'
  ],
  hi: ['Write standard Hindi in Devanagari.', 'Plurals hold only the "other" category: {count, plural, other {...}}.'],
  es: ['Write neutral Latin American Spanish; address the user as tú.']
}

/** The plural categories a language's messages may use (§9.3): only "other" in Bangla and Hindi. */
const pluralCategories = (lang) => (lang === 'bn' || lang === 'hi' ? ['other'] : new Intl.PluralRules(lang).resolvedOptions().pluralCategories)

/**
 * The request for one namespace: the system text, the user text (JSON of the messages) and the
 * screenshots to attach. `screens` maps a screen name to an image file the caller may attach.
 */
function draftRequest({ lang, ns, english, meta, glossary, screens = {} }) {
  const items = []
  const wanted = new Set()
  for (const [key, text] of Object.entries(english)) {
    if (files.namespaceOf(key) !== ns) continue
    const m = meta[key] ?? {}
    const item = { key, english: text, description: m.description ?? '', placeholders: [...icu.argumentsOf(icu.parseIcu(text))].sort() }
    if (m.maxLength) item.maxLength = m.maxLength
    if (m.dnt?.length) item.keepUnchanged = m.dnt
    if (m.digits === 'latn') item.latinDigits = true
    if (key.endsWith('.whole')) item.wholeSentence = true
    if (m.screen) {
      item.screen = m.screen
      if (screens[m.screen]) wanted.add(m.screen)
    }
    items.push(item)
  }
  const glossaryRows = glossary.map((g) => ({ term: g.term, partOfSpeech: g['part of speech'] ?? '', note: g.note ?? '', keepUnchanged: !!g.dnt, [lang]: g[lang] ?? '' }))
  const system = [
    `You translate the user interface of Flown, a screen recorder and video editor for Windows, from English into ${LANGUAGE_NAMES[lang] ?? lang}.`,
    'Each message is ICU MessageFormat. Keep every placeholder ({name}) exactly as it is, keep the rich tags <kbd>, <b>, <em> and <link>, never add #, {x, number}, HTML or quotes around braces.',
    `Plural categories you may use: ${pluralCategories(lang).join(', ')}; always include "other".`,
    'Keep every term listed in keepUnchanged exactly as written. Where latinDigits is true, write numbers with Latin digits.',
    'A message marked wholeSentence is a full sentence: write it in the natural word order of the language.',
    'Stay within maxLength characters where it is given. Use the glossary for every term it lists.',
    ...(LANGUAGE_RULES[lang] ?? []),
    'Answer with one JSON object that maps each key to its translated message, and nothing else.'
  ].join('\n')
  const user = JSON.stringify({ language: lang, namespace: ns, glossary: glossaryRows, messages: items }, null, 2)
  return { system, user, keys: items.map((i) => i.key), images: [...wanted].sort().map((s) => ({ screen: s, file: screens[s] })) }
}

/** The service's answer as key → text, keeping only the asked keys with string values. */
function parseDraftReply(text, keys) {
  const body = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '')
  let raw
  try {
    raw = JSON.parse(body)
  } catch {
    throw new Error('The service did not answer with a JSON object of messages.')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The service did not answer with a JSON object of messages.')
  const out = {}
  for (const key of keys) if (typeof raw[key] === 'string' && raw[key].trim()) out[key] = raw[key].normalize('NFC')
  return out
}

/**
 * The language's entries with the drafts in. Missing, draft and stale entries take the new draft;
 * reviewed and approved strings of today's English stay. A draft that fails the checks keeps their
 * message as its note.
 */
function applyDrafts({ lang, english, meta, glossary = [], reviewers = [], existing, drafts, serviceName }) {
  const entries = { ...existing }
  const written = []
  const kept = []
  const noted = []
  for (const [key, text] of Object.entries(drafts)) {
    if (!(key in english)) continue
    const hash = files.sourceHash(english[key])
    const before = existing[key]
    if (before && before.state !== 'draft' && before.sourceHash === hash) {
      kept.push(key)
      continue
    }
    const entry = { text, state: 'draft', sourceHash: hash, draftedWith: serviceName }
    const problems = checkMessage(lang, english[key], meta[key], entry, glossary, reviewers).filter((p) => p.level === 'error')
    if (problems.length) {
      entry.note = problems.map((p) => p.message).join('; ')
      noted.push(key)
    }
    entries[key] = entry
    written.push(key)
  }
  return { entries, written, kept, noted }
}

/**
 * A service that speaks the common chat-completions protocol at `url` (…/chat/completions), with
 * the person's own key. Images go as data URLs. `fetchImpl` is replaceable for tests.
 */
function chatService({ url, apiKey, model, readFile, fetchImpl = fetch }) {
  return async (request) => {
    const content = [{ type: 'text', text: request.user }]
    for (const img of request.images) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${readFile(img.file).toString('base64')}` } })
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: request.system }, { role: 'user', content }] })
    })
    if (!res.ok) throw new Error(`The service answered ${res.status}.`)
    const json = await res.json()
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('The service sent no message.')
    return text
  }
}

/** True when translations/README.md names `service` on the language's row (§15.3: the service is named before it is used). */
function serviceNamed(readme, lang, service) {
  const row = readme.split(/\r?\n/).find((l) => l.startsWith('|') && l.includes(`(\`${lang}\`)`))
  return !!row && !!service && row.toLowerCase().includes(service.toLowerCase())
}

module.exports = { pluralCategories, draftRequest, parseDraftReply, applyDrafts, chatService, serviceNamed }
