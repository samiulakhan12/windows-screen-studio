'use strict'
/**
 * Pseudo-locales for development (docs/design/output-and-languages.md §16.3, §12.3, §13.4). Each keeps
 * a message's placeholders, plurals, selects and rich tags and changes only its text:
 *
 * - `en-XA`: accented look-alike letters in brackets, padded to at least 40% longer, so text that
 *   was missed (still plain ASCII) or cut off shows in the guard tour;
 * - `bn-XA`: Bengali syllables with reph, chandrabindu, below-base forms and conjuncts, about 30%
 *   longer, so text that does not fit in height or width at the Bangla sizes shows before any
 *   translation exists;
 * - `ar-XB`: each text reversed inside right-to-left marks, with the page right to left, to see the
 *   layout mirror.
 */
const path = require('node:path')
const { loadTs } = require('./tsload.cjs')

const icu = loadTs(path.join(__dirname, '..', '..', '..', 'src', 'shared', 'i18n', 'icu.ts'))

const PSEUDO_LOCALES = ['en-XA', 'bn-XA', 'ar-XB']

/**
 * The UI language each pseudo-locale stands in for in its catalogue folder, where FLOWN_I18N_PSEUDO
 * (src/main/i18n.ts, PSEUDO_LOCALES, development builds only) starts Flown in it: Bangla's sizes for
 * bn-XA, and a language with no font of its own for the others.
 */
const PSEUDO_SLOT = Object.freeze({ 'en-XA': 'es', 'bn-XA': 'bn', 'ar-XB': 'es' })

/** Prints parsed ICU nodes back to message source, quoting what ICU would read as syntax. */
function printIcu(nodes, inPlural = false) {
  let out = ''
  for (const n of nodes) {
    if (n.kind === 'text') {
      out += n.value.replace(/'/g, "''").replace(inPlural ? /[{}<#]/g : /[{}<]/g, (c) => `'${c}'`)
    } else if (n.kind === 'arg') out += n.format ? `{${n.name}, ${n.format}}` : `{${n.name}}`
    else if (n.kind === 'pound') out += '#'
    else if (n.kind === 'tag') out += `<${n.name}>${printIcu(n.children, inPlural)}</${n.name}>`
    else {
      const offset = n.kind === 'plural' && n.offset ? ` offset:${n.offset}` : ''
      const options = Object.entries(n.options)
        .map(([k, v]) => `${k} {${printIcu(v, n.kind === 'plural' || inPlural)}}`)
        .join(' ')
      out += `{${n.name}, ${n.kind},${offset} ${options}}`
    }
  }
  return out
}

/** Maps every text node of a message with `fn`, keeping its structure. */
function mapText(nodes, fn) {
  return nodes.map((n) => {
    if (n.kind === 'text') return { ...n, value: fn(n.value) }
    if (n.kind === 'tag') return { ...n, children: mapText(n.children, fn) }
    if (n.kind === 'plural' || n.kind === 'select') {
      const options = {}
      for (const [k, v] of Object.entries(n.options)) options[k] = mapText(v, fn)
      return { ...n, options }
    }
    return n
  })
}

/** Letters of the longest way through a message's text. */
function textLength(nodes) {
  let total = 0
  for (const n of nodes) {
    if (n.kind === 'text') total += [...n.value].length
    else if (n.kind === 'tag') total += textLength(n.children)
    else if (n.kind === 'plural' || n.kind === 'select') total += Math.max(0, ...Object.values(n.options).map(textLength))
  }
  return total
}

const ACCENTED = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'ĕ', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'ĩ', j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ɱ',
  n: 'ñ', o: 'ō', p: 'ƥ', q: 'ʠ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ű', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ď', E: 'Ē', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Ĩ', J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ṁ',
  N: 'Ñ', O: 'Ō', P: 'Ƥ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ű', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž'
}

/**
 * Bengali syllables that test the script's height and joins: reph (র্ক), chandrabindu (ঁ), below-base
 * forms (ক্র, ু, ৃ) and conjuncts (ক্ষ, ন্ত্র, স্থ). One per letter, by its code, so the output is stable.
 */
const BENGALI = ['র্ক', 'কাঁ', 'ক্র', 'পু', 'তৃ', 'ক্ষ', 'ন্ত্র', 'স্থ', 'গুঁ', 'র্দ্র', 'মৃ', 'শ্রী', 'জ্ঞ', 'হুঁ', 'প্লু', 'দ্ধ']

/** The pseudo text of one text node in `locale`. */
function pseudoText(locale, s) {
  if (locale === 'en-XA') return s.replace(/[A-Za-z]/g, (c) => ACCENTED[c])
  if (locale === 'bn-XA') {
    // Each Latin word: one syllable per letter and three more per ten, rounded up (about +30%).
    return s.replace(/[A-Za-z]+/g, (word) => {
      const count = word.length + Math.ceil(word.length * 0.3)
      let out = ''
      for (let i = 0; i < count; i++) out += BENGALI[(word.charCodeAt(i % word.length) + i) % BENGALI.length]
      return out
    })
  }
  if (locale === 'ar-XB') return [...s].reverse().join('')
  throw new Error(`Unknown pseudo-locale ${locale}`)
}

/** The pseudo message of `english` in `locale` (en-XA, bn-XA or ar-XB). */
function pseudoMessage(locale, english) {
  const nodes = icu.parseIcu(english)
  const mapped = mapText(nodes, (s) => pseudoText(locale, s))
  if (locale === 'en-XA') {
    const len = textLength(nodes)
    const pad = Math.max(1, Math.ceil(len * 0.4) - 3)
    return `[${printIcu(mapped)} ${'·'.repeat(pad)}]`
  }
  if (locale === 'ar-XB') return `\u200f${printIcu(mapped)}\u200f`
  return printIcu(mapped)
}

/** The direction of a pseudo-locale's page. */
const pseudoDir = (locale) => (locale === 'ar-XB' ? 'rtl' : 'ltr')

/** A whole pseudo catalogue in the built format, with its direction. */
function pseudoCatalogue(locale, english, meta) {
  const messages = {}
  for (const [key, text] of Object.entries(english)) messages[key] = pseudoMessage(locale, text)
  const latn = Object.keys(meta).filter((k) => meta[k]?.digits === 'latn').sort()
  const user = {}
  for (const k of Object.keys(meta).sort()) if (Array.isArray(meta[k]?.user) && meta[k].user.length) user[k] = [...meta[k].user]
  return { locale, dir: pseudoDir(locale), messages, latn, user }
}

module.exports = { PSEUDO_LOCALES, PSEUDO_SLOT, BENGALI, printIcu, mapText, pseudoMessage, pseudoDir, pseudoCatalogue }
