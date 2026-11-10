'use strict'
/**
 * Review catalogues and the review pack's page (docs/design/output-and-languages.md §15.4).
 *
 * A review catalogue holds every English key: the language's text where it has one that parses with
 * English's placeholders (draft, reviewed or approved), English otherwise. When it is written for
 * review, each message starts with an invisible mark (Unicode tag characters) that names the mode,
 * the state and the key, which src/renderer/src/i18n/reviewOverlay.tsx reads to show keys over the
 * UI. Marks never reach a built catalogue: the catalogue checks refuse tag characters.
 */
const files = require('./files.cjs')
const { checkMessage } = require('./catalogue.cjs')

const MARK_START = '\u{e0001}'
const MARK_END = '\u{e007f}'
const STATE_LETTERS = { draft: 'd', reviewed: 'r', approved: 'a', english: 'e', stale: 's' }

/** The invisible mark of `key` in `state`; `labels` draws every key beside its text (the pack's screenshots). */
function reviewMark(key, state, labels) {
  const body = `${labels ? 'l' : 'h'}${STATE_LETTERS[state]}:${key}`
  return MARK_START + [...body].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('') + MARK_END
}

/**
 * The catalogue a review build shows, in the built format, with each message's state. `marks`:
 * null (no marks), 'hover' (the developer's review build) or 'labels' (the review pack).
 */
function reviewCatalogue({ lang, english, meta, translations, marks = null }) {
  const messages = {}
  const states = {}
  for (const [key, text] of Object.entries(english)) {
    const entry = translations[key]
    let state = 'english'
    let shown = text
    if (entry && typeof entry.text === 'string') {
      if (entry.sourceHash !== files.sourceHash(text)) state = 'stale'
      else if (!checkMessage(lang, text, meta[key], entry).some((p) => ['parse', 'plural-other', 'placeholders', 'tags'].includes(p.code))) {
        state = entry.state
        shown = entry.text
      }
    }
    states[key] = state
    messages[key] = marks ? reviewMark(key, state, marks === 'labels') + shown : shown
  }
  const latn = Object.keys(meta).filter((k) => meta[k]?.digits === 'latn').sort()
  const user = {}
  for (const k of Object.keys(meta).sort()) if (Array.isArray(meta[k]?.user) && meta[k].user.length) user[k] = [...meta[k].user]
  return { catalogue: { messages, latn, user }, states }
}

/** The marks of the developer's review build: only with FLOWN_I18N_REVIEW=1 (§15.4). */
const liveMarks = (env) => (env.FLOWN_I18N_REVIEW === '1' ? 'hover' : null)

/** The catalogue for main (common, errors and main) from a review catalogue. */
function mainPart(catalogue) {
  const keep = (k) => files.MAIN_NAMESPACES.includes(files.namespaceOf(k))
  return {
    messages: Object.fromEntries(Object.entries(catalogue.messages).filter(([k]) => keep(k))),
    latn: catalogue.latn.filter(keep),
    user: Object.fromEntries(Object.entries(catalogue.user).filter(([k]) => keep(k)))
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** The keys whose marks a screen's text holds, in order, without repeats. */
function keysOnScreen(text) {
  const out = []
  let at = text.indexOf(MARK_START)
  while (at !== -1) {
    const end = text.indexOf(MARK_END, at)
    if (end === -1) break
    const body = [...text.slice(at + MARK_START.length, end)].map((c) => String.fromCharCode(c.codePointAt(0) - 0xe0000)).join('')
    const key = body.slice(body.indexOf(':') + 1)
    if (key && !out.includes(key)) out.push(key)
    at = text.indexOf(MARK_START, end)
  }
  return out
}

/**
 * The review pack's page: each screen's picture, with its keys, English and the translation, and the
 * bn-XA pictures that show text too long or too tall. Plain HTML with no script, for reviewers who
 * open it from a folder.
 */
function packPage({ lang, screens, overflow = [], english, translations, states }) {
  const row = (key) => {
    const e = translations[key]
    return `<tr id="${escapeHtml(key)}"><td><code>${escapeHtml(key)}</code></td><td>${escapeHtml(english[key] ?? '')}</td><td lang="${escapeHtml(lang)}">${escapeHtml(e?.text ?? '')}</td><td>${escapeHtml(states[key] ?? 'english')}</td></tr>`
  }
  const section = (s) =>
    `<section id="screen-${escapeHtml(s.name)}"><h2>${escapeHtml(s.name)}</h2><img src="screens/${encodeURIComponent(s.name)}.png" alt="${escapeHtml(s.name)}" loading="lazy"><table><thead><tr><th>Key</th><th>English</th><th>${escapeHtml(lang)}</th><th>State</th></tr></thead><tbody>${s.keys.map(row).join('')}</tbody></table></section>`
  const overflowList = overflow.length ? `<h2 id="overflow">bn-XA: text that must fit at the Bangla sizes</h2>${overflow.map((n) => `<figure><img src="bn-XA/${encodeURIComponent(n)}.png" alt="${escapeHtml(n)}" loading="lazy"><figcaption>${escapeHtml(n)}</figcaption></figure>`).join('')}` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flown review pack: ${escapeHtml(lang)}</title>
<style>
body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; color: #111; background: #fff; }
img { max-width: 100%; border: 1px solid #ccc; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 32px; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: start; vertical-align: top; }
code { font-size: 12px; }
nav a { margin-inline-end: 12px; }
</style>
</head>
<body>
<h1>Flown review pack: ${escapeHtml(lang)}</h1>
<p>Each picture shows a screen with every text's key beside it. Find a key in the table under its picture, then correct it in the review sheet (translations/${escapeHtml(lang)}/review.csv).</p>
<nav>${screens.map((s) => `<a href="#screen-${escapeHtml(s.name)}">${escapeHtml(s.name)}</a>`).join('')}${overflow.length ? '<a href="#overflow">bn-XA</a>' : ''}</nav>
${screens.map(section).join('\n')}
${overflowList}
</body>
</html>
`
}

module.exports = { MARK_START, MARK_END, reviewMark, reviewCatalogue, liveMarks, mainPart, keysOnScreen, packPage, escapeHtml }
