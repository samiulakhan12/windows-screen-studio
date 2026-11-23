#!/usr/bin/env node
// The static check of the text rules' patterns (docs/design/auto-blur.md §10.3, test 224). It parses
// a JavaScript regular expression and refuses two shapes that can backtrack without bound:
//   - nested unbounded quantifiers: an unbounded repetition (`*`, `+`, `{n,}`) holding another one,
//     such as `(a+)+` or `(\w+\s?)*`;
//   - a quantified alternation whose branches can match the same text: a repetition holding an
//     alternation of which two branches can begin with the same character, or one can match nothing,
//     such as `(a|a)*`.
// It is a guard, not a proof: the rules worker's time limit (2 s a read) is the guarantee, and test
// 104 runs every pattern on 64 KB adversarial strings.
//
//   node scripts/privacy/regexCheck.mjs '<pattern>' [flags]   # exit 1 when refused
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ---------- parsing ---------- */

const QUANT_BRACES = /^\{(\d+)(,(\d*))?\}/

/** The pattern as a tree: alt, seq, group, quant and atoms (char, class, escape, any, assert, backref). */
export function parse(source) {
  let i = 0
  const s = source
  function alt() {
    const branches = [seq()]
    while (s[i] === '|') {
      i++
      branches.push(seq())
    }
    return branches.length === 1 ? branches[0] : { type: 'alt', branches }
  }
  function seq() {
    const items = []
    while (i < s.length && s[i] !== '|' && s[i] !== ')') {
      let atom = term()
      for (;;) {
        const q = quantifier()
        if (!q) break
        atom = { type: 'quant', min: q.min, max: q.max, body: atom }
      }
      items.push(atom)
    }
    return { type: 'seq', items }
  }
  function quantifier() {
    const c = s[i]
    let q = null
    if (c === '*') q = { min: 0, max: Infinity, len: 1 }
    else if (c === '+') q = { min: 1, max: Infinity, len: 1 }
    else if (c === '?') q = { min: 0, max: 1, len: 1 }
    else if (c === '{') {
      const m = QUANT_BRACES.exec(s.slice(i))
      if (m) q = { min: Number(m[1]), max: m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : Number(m[1]), len: m[0].length }
    }
    if (!q) return null
    i += q.len
    if (s[i] === '?') i++ // lazy
    return q
  }
  function escape() {
    // s[i] === '\\'
    const start = i
    i++
    const c = s[i]
    if ((c === 'p' || c === 'P') && s[i + 1] === '{') {
      i = s.indexOf('}', i) + 1
    } else if (c === 'u' && s[i + 1] === '{') {
      i = s.indexOf('}', i) + 1
    } else if (c === 'u') i += 5
    else if (c === 'x') i += 3
    else if (c === 'c') i += 2
    else if (c === 'k' && s[i + 1] === '<') i = s.indexOf('>', i) + 1
    else if (/[1-9]/.test(c)) {
      while (/[0-9]/.test(s[i])) i++
      return { type: 'backref', src: s.slice(start, i) }
    } else i++
    const src = s.slice(start, i)
    if (src === '\\b' || src === '\\B') return { type: 'assert', src }
    if (src.startsWith('\\k')) return { type: 'backref', src }
    return { type: 'escape', src }
  }
  function charClass() {
    const start = i
    i++
    if (s[i] === '^') i++
    if (s[i] === ']') i++ // ']' first is literal outside 'u' mode; '[]' is handled by the scan below
    while (i < s.length && s[i] !== ']') {
      if (s[i] === '\\') i += s[i + 1] === 'p' || s[i + 1] === 'P' || (s[i + 1] === 'u' && s[i + 2] === '{') ? s.indexOf('}', i) - i + 1 : 2
      else i++
    }
    i++
    return { type: 'class', src: s.slice(start, i) }
  }
  function term() {
    const c = s[i]
    if (c === '(') {
      i++
      let kind = 'capture'
      if (s[i] === '?') {
        if (s.startsWith('?:', i)) (kind = 'group'), (i += 2)
        else if (s.startsWith('?=', i)) (kind = 'look'), (i += 2)
        else if (s.startsWith('?!', i)) (kind = 'look'), (i += 2)
        else if (s.startsWith('?<=', i)) (kind = 'look'), (i += 3)
        else if (s.startsWith('?<!', i)) (kind = 'look'), (i += 3)
        else if (s.startsWith('?<', i)) (kind = 'capture'), (i = s.indexOf('>', i) + 1)
        else throw new Error(`unknown group at ${i}`)
      }
      const body = alt()
      if (s[i] !== ')') throw new Error(`unclosed group at ${i}`)
      i++
      return { type: 'group', kind, body }
    }
    if (c === '[') return charClass()
    if (c === '\\') return escape()
    i++
    if (c === '.') return { type: 'any', src: '.' }
    if (c === '^' || c === '$') return { type: 'assert', src: c }
    return { type: 'char', src: c }
  }
  const tree = alt()
  if (i !== s.length) throw new Error(`unexpected '${s[i]}' at ${i}`)
  return tree
}

/* ---------- first characters and empty matches ---------- */

/** The characters a first-character set is tested on: ASCII and a sample of the scripts and symbols OCR returns. */
const SAMPLE = [
  ...Array.from({ length: 128 }, (_v, c) => String.fromCharCode(c)),
  ...'éñÑóüøθАаক্অ়ািहक中•—– ​©€ـ।ÁÍÚ'
]

const nullable = (n) => {
  switch (n.type) {
    case 'alt':
      return n.branches.some(nullable)
    case 'seq':
      return n.items.every(nullable)
    case 'group':
      return n.kind === 'look' || nullable(n.body)
    case 'quant':
      return n.min === 0 || nullable(n.body)
    case 'assert':
      return true
    case 'backref':
      return true
    default:
      return false
  }
}

/** The sample characters an atom matches, as a set of their indices. */
function atomSet(n, flags) {
  const f = flags.replace(/[gyd]/g, '')
  const src = n.type === 'any' ? '[^\\n\\r\\u2028\\u2029]' : n.src
  let re
  try {
    re = new RegExp(`^(?:${src})$`, f)
  } catch {
    return new Set(SAMPLE.map((_c, k) => k))
  }
  const out = new Set()
  SAMPLE.forEach((c, k) => {
    if (re.test(c)) out.add(k)
  })
  return out
}

/** The sample characters a node can begin with. */
function first(n, flags) {
  switch (n.type) {
    case 'alt': {
      const out = new Set()
      for (const b of n.branches) for (const k of first(b, flags)) out.add(k)
      return out
    }
    case 'seq': {
      const out = new Set()
      for (const item of n.items) {
        for (const k of first(item, flags)) out.add(k)
        if (!nullable(item)) break
      }
      return out
    }
    case 'group':
      return n.kind === 'look' ? new Set() : first(n.body, flags)
    case 'quant':
      return n.max === 0 ? new Set() : first(n.body, flags)
    case 'assert':
      return new Set()
    case 'backref':
      return new Set(SAMPLE.map((_c, k) => k))
    default:
      return atomSet(n, flags)
  }
}

/* ---------- the check ---------- */

/** Every node under `n`, itself included. */
function* walk(n) {
  yield n
  if (n.type === 'alt') for (const b of n.branches) yield* walk(b)
  else if (n.type === 'seq') for (const x of n.items) yield* walk(x)
  else if (n.type === 'group' || n.type === 'quant') yield* walk(n.body)
}

/** The problems of one pattern: [] when it passes. */
export function checkPattern(pattern, flags) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern)
  const f = pattern instanceof RegExp ? pattern.flags : flags ?? ''
  let tree
  try {
    tree = parse(source)
  } catch (err) {
    return [`cannot be read: ${err.message}`]
  }
  const problems = []
  for (const q of walk(tree)) {
    if (q.type !== 'quant') continue
    if (q.max === Infinity) {
      for (const inner of walk(q.body)) {
        if (inner.type === 'quant' && inner.max === Infinity) {
          problems.push('nested unbounded quantifiers')
          break
        }
      }
    }
    if (q.max > 1) {
      for (const inner of walk(q.body)) {
        if (inner.type !== 'alt') continue
        const sets = inner.branches.map((b) => first(b, f))
        let overlap = inner.branches.some(nullable)
        for (let a = 0; a < sets.length && !overlap; a++) for (let b = a + 1; b < sets.length && !overlap; b++) for (const k of sets[a]) if (sets[b].has(k)) overlap = true
        if (overlap) {
          problems.push('a quantified alternation whose branches can match the same text')
          break
        }
      }
    }
  }
  return [...new Set(problems)]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pattern, flags = ''] = process.argv.slice(2)
  if (pattern === undefined) {
    console.error('usage: node scripts/privacy/regexCheck.mjs <pattern> [flags]')
    process.exit(2)
  }
  const problems = checkPattern(pattern, flags)
  if (problems.length) {
    console.error(`regexCheck: refused: ${problems.join('; ')}`)
    process.exit(1)
  }
  console.log('regexCheck: passes')
}
