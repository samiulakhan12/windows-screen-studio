'use strict'
/**
 * The review sheet (docs/design/output-and-languages.md §15.4): one CSV row per message for reviewers
 * who work in Excel, and its import back into translations/<lang>/<ns>.json.
 *
 * - Export writes a UTF-8 byte-order mark (without it Excel on Windows reads UTF-8 as ANSI), the
 *   columns key, English, description, screen, draft, final, state, reviewer, approver, note, and the
 *   stale strings first. A cell that starts with =, +, - or @ (or an apostrophe) gets an apostrophe in
 *   front, so no cell is ever a formula; the import removes it again.
 * - Import refuses a file that is not valid UTF-8 or holds U+FFFD, and any row whose Bangla or Hindi
 *   text has a run of ?, has no letter of the language's script where English has letters, or starts
 *   with # or a formula's remains. Then every changed row goes through the catalogue checks; the
 *   person importing is recorded as reviewer or approver with the date, and never as both for one
 *   string. Nothing is written unless every row passes.
 */
const files = require('./files.cjs')
const { parseCsv, formatCsv } = require('./csv.cjs')
const { checkMessage } = require('./catalogue.cjs')

const COLUMNS = ['key', 'English', 'description', 'screen', 'draft', 'final', 'state', 'reviewer', 'approver', 'note']
const BOM = '\ufeff'
/** Letters of each language's own script, which a translated row must hold where English has letters. */
const SCRIPT = { bn: /[\u0980-\u09ff]/u, hi: /[\u0900-\u097f]/u }
const FORMULA_START = /^[=+\-@']/

/** A cell as written: an apostrophe before anything Excel would read as a formula (or an apostrophe). */
const guard = (v) => (FORMULA_START.test(v) ? `'${v}` : v)
/** The cell's text again. */
const unguard = (v) => (v.startsWith("'") ? v.slice(1) : v)

/** The sheet of `lang`: every English key, stale translations first, then English order. */
function exportSheet({ lang, english, meta, translations, screenLink = (screen) => (screen ? `pack/${screen}.png` : '') }) {
  const keys = Object.keys(english)
  const stale = (k) => translations[k] && translations[k].sourceHash !== files.sourceHash(english[k])
  const ordered = [...keys.filter(stale), ...keys.filter((k) => !stale(k))]
  const rows = [COLUMNS]
  for (const key of ordered) {
    const e = translations[key]
    const m = meta[key] ?? {}
    rows.push(
      [key, english[key], m.description ?? '', screenLink(m.screen), e?.text ?? '', e?.text ?? '', e ? (stale(key) ? 'stale' : e.state) : '', e?.reviewedBy ?? '', e?.approvedBy ?? '', e?.note ?? ''].map((v) =>
        guard(String(v))
      )
    )
  }
  return BOM + formatCsv(rows)
}

/** Decodes the sheet's bytes, refusing anything that is not clean UTF-8. */
function decodeSheet(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('The sheet is not UTF-8. Save it from Excel as "CSV UTF-8 (Comma delimited)" and import it again.')
  }
  if (text.includes('\ufffd')) throw new Error('The sheet holds U+FFFD replacement characters, so some text was lost on the way. Save it from Excel as "CSV UTF-8 (Comma delimited)" and import it again.')
  return text
}

/** Why a translated row looks damaged, or null. */
function damage(lang, english, final) {
  if (/\?{2,}/.test(final) && !/\?{2,}/.test(english)) return 'has a run of "?" (the text lost its letters on the way)'
  if (/^#/.test(final)) return 'starts with # (a spreadsheet error, such as #NAME?)'
  if (/^[=+@]/.test(final)) return 'starts with a formula'
  if (SCRIPT[lang] && /\p{L}/u.test(english) && !SCRIPT[lang].test(final)) return `has no letter of the language's script`
  return null
}

/**
 * Reads a returned sheet into the language's entries. `by` is the person importing (listed in
 * reviewers.json for `lang`), `date` today's date. Returns the new entries, the keys that changed
 * and the rows refused; when any row is refused, the entries are the old ones.
 */
function importSheet({ lang, bytes, english, meta, translations, reviewers, glossary = [], by, date }) {
  const listed = reviewers.some((r) => r.id === by && Array.isArray(r.languages) && r.languages.includes(lang))
  if (!listed) throw new Error(`"${by}" is not listed for ${lang} in translations/reviewers.json, so their review cannot be recorded.`)
  const rows = parseCsv(decodeSheet(bytes))
  const [head, ...body] = rows
  if (!head || COLUMNS.some((c, i) => head[i] !== c)) throw new Error(`The sheet's columns are not ${COLUMNS.join(', ')}.`)
  const out = { ...translations }
  const changed = []
  const refused = []
  for (const r of body) {
    if (r.length === 1 && r[0] === '') continue
    const cell = Object.fromEntries(COLUMNS.map((c, i) => [c, unguard(r[i] ?? '')]))
    const key = cell.key
    if (!(key in english)) {
      refused.push({ key, reason: 'English has no such key' })
      continue
    }
    const before = translations[key]
    const final = cell.final
    const state = cell.state === 'stale' ? (before?.state ?? 'draft') : cell.state
    if (!final && !state) continue
    // Unchanged rows stay as they are.
    if (before && final === before.text && (cell.state === 'stale' || state === before.state) && cell.note === (before.note ?? '')) continue
    const why = damage(lang, english[key], final)
    if (why) {
      refused.push({ key, reason: why })
      continue
    }
    if (!['draft', 'reviewed', 'approved'].includes(state)) {
      refused.push({ key, reason: `has the state "${cell.state}"; use draft, reviewed or approved` })
      continue
    }
    const next = { ...(before ?? {}), text: final, state, sourceHash: files.sourceHash(english[key]) }
    if (cell.note) next.note = cell.note
    else delete next.note
    if (state === 'reviewed') {
      next.reviewedBy = by
      next.reviewedAt = date
      delete next.approvedBy
      delete next.approvedAt
    } else if (state === 'approved') {
      if (next.reviewedBy === by) {
        refused.push({ key, reason: `was reviewed by ${by}, who cannot also approve it` })
        continue
      }
      next.approvedBy = by
      next.approvedAt = date
    } else {
      delete next.reviewedBy
      delete next.reviewedAt
      delete next.approvedBy
      delete next.approvedAt
    }
    const problems = checkMessage(lang, english[key], meta[key], next, glossary, reviewers).filter((p) => p.level === 'error')
    if (problems.length) {
      refused.push({ key, reason: problems.map((p) => p.message).join('; ') })
      continue
    }
    out[key] = next
    changed.push(key)
  }
  return refused.length ? { entries: translations, changed: [], refused } : { entries: out, changed, refused }
}

module.exports = { COLUMNS, exportSheet, importSheet, decodeSheet, guard, unguard }
