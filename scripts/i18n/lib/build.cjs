'use strict'
/**
 * The built catalogues (docs/design/output-and-languages.md §9.2, §15.6): what ships of each
 * language, and which languages the picker offers.
 *
 * - A string ships when it is `approved`, its `sourceHash` matches today's English, `reviewedBy` and
 *   `approvedBy` are both set, differ, and are both listed in translations/reviewers.json for the
 *   language, and it passes the catalogue checks. Everything else shows in English, string by string.
 * - A language ships (shipped.json) when 95% of its keys outside the other account's `recording`
 *   namespace and 100% of the core namespaces (their `.whole` messages included) ship; it is a
 *   preview while `recording` is not fully approved (§0 decision 11).
 * - `<lang>.json` holds every namespace for the renderer, `<lang>.main.json` main's three; both carry
 *   `latn` (keys whose numbers stay Latin) and `user` (placeholders holding the user's text), from the
 *   English meta files, which never ship themselves.
 * - Only shipped languages get built files, so a partly approved language adds nothing to the app.
 */
const files = require('./files.cjs')
const { checkMessage, mergeGroups, mergeReport } = require('./catalogue.cjs')

/** Share of keys that must ship, and the namespaces held to all of them. */
const SHIP_SHARE = 0.95

/** Why a translation does not ship, or null when it does. */
function shipBlocker(lang, key, entry, english, meta, glossary, reviewers) {
  if (!entry) return 'not translated'
  if (entry.state !== 'approved') return `state ${entry.state}`
  if (entry.sourceHash !== files.sourceHash(english)) return 'stale'
  if (!entry.reviewedBy || !entry.approvedBy) return 'reviewer or approver missing'
  if (entry.reviewedBy === entry.approvedBy) return 'approved by its own reviewer'
  const listed = (id) => reviewers.some((r) => r.id === id && Array.isArray(r.languages) && r.languages.includes(lang))
  if (!listed(entry.reviewedBy) || !listed(entry.approvedBy)) return 'reviewer or approver not listed for the language'
  const errors = checkMessage(lang, english, meta, entry, glossary, reviewers).filter((p) => p.level === 'error')
  if (errors.length) return `fails the checks (${errors.map((p) => p.code).join(', ')})`
  return null
}

/**
 * One language's shipping strings and how complete it is. `english` and `meta` are by full key,
 * `translations` the language's entries by full key.
 */
function buildLanguage(lang, { english, meta, translations, reviewers, glossary = [] }) {
  const messages = {}
  const dropped = []
  for (const [key, text] of Object.entries(english)) {
    const why = shipBlocker(lang, key, translations[key], text, meta[key], glossary, reviewers)
    if (why === null) messages[key] = translations[key].text
    else if (translations[key]) dropped.push({ key, reason: why })
  }
  const keys = Object.keys(english)
  const counted = keys.filter((k) => files.namespaceOf(k) !== files.RECORDING_NAMESPACE)
  const core = keys.filter((k) => files.isCore(files.namespaceOf(k)))
  const recording = keys.filter((k) => files.namespaceOf(k) === files.RECORDING_NAMESPACE)
  const share = counted.length ? counted.filter((k) => k in messages).length / counted.length : 0
  const coreMissing = core.filter((k) => !(k in messages))
  const wholeMissing = [...mergeGroups(meta).values()].map((g) => g.whole).filter((w) => files.isCore(files.namespaceOf(w)) && !(w in messages))
  // The whole-sentence messages of core namespaces are core keys: listed apart for the report.
  const ships = share >= SHIP_SHARE && coreMissing.length === 0
  const preview = recording.length === 0 || recording.some((k) => !(k in messages))
  return { language: lang, messages, dropped, share, coreMissing, wholeMissing, ships, preview }
}

/** The built file of `messages`: the messages with the keys' `latn` and `user` from the meta, keys in English order. */
function builtFile(messages, meta, keep = () => true) {
  const latn = Object.keys(meta)
    .filter((k) => keep(k) && meta[k]?.digits === 'latn')
    .sort()
  const user = {}
  for (const k of Object.keys(meta).sort()) if (keep(k) && Array.isArray(meta[k]?.user) && meta[k].user.length) user[k] = [...meta[k].user]
  const own = {}
  for (const k of Object.keys(messages)) if (keep(k)) own[k] = messages[k]
  return { messages: own, latn, user }
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/**
 * Everything the build writes, by file name under src/shared/i18n/built/, and its report: each
 * language's completeness and the merge groups per namespace.
 */
function buildCatalogues(root = files.ROOT) {
  const en = files.readEnglish(root)
  const reviewers = files.readReviewers(root)
  const glossary = files.readGlossary(root)
  const out = {}
  const languages = []
  for (const lang of files.translationLanguages(root)) {
    const built = buildLanguage(lang, { english: en.messages, meta: en.meta, translations: files.readTranslations(root, lang), reviewers, glossary })
    languages.push(built)
    if (!built.ships) continue
    out[`${lang}.json`] = json(builtFile(built.messages, en.meta))
    out[`${lang}.main.json`] = json(builtFile(built.messages, en.meta, (k) => files.MAIN_NAMESPACES.includes(files.namespaceOf(k))))
  }
  const order = (l) => (files.LANGUAGES.includes(l) ? files.LANGUAGES.indexOf(l) : 99)
  const shipped = languages
    .filter((l) => l.ships)
    .sort((a, b) => order(a.language) - order(b.language) || a.language.localeCompare(b.language))
    .map((l) => ({ language: l.language, preview: l.preview }))
  out['shipped.json'] = json(shipped)
  return { files: out, languages, merge: mergeReport(en.meta) }
}

module.exports = { SHIP_SHARE, shipBlocker, buildLanguage, builtFile, buildCatalogues }
