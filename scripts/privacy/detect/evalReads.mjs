// Scores the rules end to end on real OCR reads of the evaluation set.
// Usage: node evalReads.mjs <truth.json> <reads.json> <tlds.ts> <metadata.max.json> [regions=US,GB,BD]
// An item is FOUND when hits cover >= 50% of its area, COVERED when padded hits cover all of it.
import fs from 'node:fs'
import { detectLine, loadTlds, loadPhoneMeta, LABELS, PEM_END } from './rules.mjs'
const RECOVERY = LABELS.recovery
const [tf, rf, tl, mf, regArg] = process.argv.slice(2)
const truth = JSON.parse(fs.readFileSync(tf, 'utf8'))
const reads = JSON.parse(fs.readFileSync(rf, 'utf8'))
const tlds = loadTlds(tl)
const phone = loadPhoneMeta(mf)
const regions = (regArg || 'US,GB,BD').split(',')
const tier = (s) => (s >= 0.85 ? 'auto' : s >= 0.5 ? 'check' : 'drop')

const xOverlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) / Math.max(1, Math.min(a[2] - a[0], b[2] - b[0]))
const PAD = (h) => Math.max(3, 0.35 * h)

function frameHits(frame) {
  const lines = frame.lines.map((l) => ({ bbox: l.bbox, text: l.variants[0].text, spans: l.variants[0].spans })).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
  const h = (l) => l.bbox[3] - l.bbox[1]
  // the line directly above in the same column
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    let best = null
    for (let j = 0; j < lines.length; j++) {
      const A = lines[j]
      if (A.bbox[3] > L.bbox[1] + 2 || L.bbox[1] - A.bbox[3] > 2.2 * h(L)) continue
      if (xOverlap(A.bbox, L.bbox) < 0.3 && Math.abs(A.bbox[0] - L.bbox[0]) > h(L)) continue
      if (!best || A.bbox[3] > best.bbox[3]) best = A
    }
    L.above = best
    L.below = null
  }
  for (const L of lines) if (L.above && (!L.above.below || L.above.below.bbox[1] > L.bbox[1])) L.above.below = L
  const rects = []
  const rectOf = (L, s, e) => {
    const x0 = L.spans[s] ? L.spans[s][0] : L.bbox[0]
    const x1 = L.spans[e - 1] ? L.spans[e - 1][1] : L.bbox[2]
    const p = PAD(h(L))
    return [Math.max(0, x0 - p), Math.max(0, L.bbox[1] - p), Math.min(frame.width ?? 1e9, x1 + p), L.bbox[3] + p]
  }
  for (const L of lines) {
    // the boxes to the left on the same row (nearest last), the second line above, and a recovery-codes block above
    const left = lines.filter((o) => o !== L && o.bbox[0] < L.bbox[0] && o.bbox[2] <= L.bbox[0] + 0.6 * h(L) && Math.abs((o.bbox[1] + o.bbox[3]) / 2 - (L.bbox[1] + L.bbox[3]) / 2) < 0.6 * h(L)).sort((a, b) => a.bbox[0] - b.bbox[0]).map((o) => o.text)
    let recovery = false
    let prose = 0
    for (let a = L.above, k = 0; a && k < 8; a = a.above, k++) { if (RECOVERY.test(a.text)) { recovery = true; break } if (a.text.split(/\s+/).length > 6 && ++prose > 1) break }
    L.recovery = recovery
    const hits = detectLine(L.text, { above: L.above?.text, above2: L.above?.above?.text, left, recovery, regions, tlds, phone, names: truth.listedNames, options: {} }).filter((x) => tier(x.score) !== 'drop')
    for (const x of hits) rects.push({ r: rectOf(L, x.start, x.end), kind: x.kind, rule: x.rule, tier: tier(x.score), text: x.text })
    // frame rule 1: a PEM private key block runs from its BEGIN line to its END line (or 60 lines)
    if (hits.some((x) => x.rule === 'private-key')) {
      let n = L.below
      let k = 0
      while (n && k++ < 60) {
        const r0 = rectOf(n, 0, n.text.length)
        rects.push({ r: [Math.min(r0[0], L.bbox[0] - PAD(h(L))), r0[1], Math.max(r0[2], L.bbox[2] + PAD(h(L))), r0[3]], kind: 'key', rule: 'private-key-block', tier: 'auto', text: n.text })
        if (PEM_END.test(n.text)) break
        n = n.below
      }
    }
  }
  // recovery codes in a grid: boxes on the row of a box in a recovery block
  for (const L of lines) {
    if (L.recovery) continue
    const rowmate = lines.find((o) => o.recovery && o !== L && Math.abs((o.bbox[1] + o.bbox[3]) / 2 - (L.bbox[1] + L.bbox[3]) / 2) < 0.6 * h(L))
    if (!rowmate) continue
    for (const x of detectLine(L.text, { recovery: true, regions, tlds, phone, names: [], options: {} }).filter((x) => x.rule === 'recovery-code')) rects.push({ r: rectOf(L, x.start, x.end), kind: 'code', rule: 'recovery-code-grid', tier: 'auto', text: x.text })
  }
  // frame rule 4: a key that runs to the right edge of its block continues at the left of the line below
  for (const L of lines) {
    const B = L.below
    if (!B) continue
    const blockRight = Math.max(...lines.filter((o) => xOverlap(o.bbox, L.bbox) > 0.3 && Math.abs(o.bbox[1] - L.bbox[1]) < 12 * h(L)).map((o) => o.bbox[2]))
    if (L.bbox[2] < blockRight - 1.2 * h(L) || Math.abs(B.bbox[0] - L.bbox[0]) > 2.5 * h(L)) continue
    const hits = detectLine(L.text, { regions, tlds, phone, names: [], options: {} }).filter((x) => x.kind === 'key' && x.end >= L.text.replace(/[\s.,;"'`]+$/, '').length)
    const cont = /^\s*[A-Za-z0-9_+/=.-]{4,}/.exec(B.text)
    if (cont && /^\s*[A-Za-z]+[.,:;]?$/.test(cont[0])) continue // a word, not the rest of a token
    if (hits.length && cont) rects.push({ r: rectOf(B, 0, cont[0].length), kind: 'key', rule: hits[0].rule + '+continued', tier: tier(hits[0].score), text: cont[0].trim() })
  }
  // frame rule 2: a token wrapped onto the next line: last token of a line + first token of the line below
  for (const L of lines) {
    const B = L.below
    if (!B) continue
    const a = /[A-Za-z0-9_+/=.-]{6,}$/.exec(L.text)
    const b = /^[A-Za-z0-9_+/=.-]{4,}/.exec(B.text.trimStart())
    if (!a || !b) continue
    const blockRight = Math.max(...lines.filter((o) => xOverlap(o.bbox, L.bbox) > 0.3 && Math.abs(o.bbox[1] - L.bbox[1]) < 12 * h(L)).map((o) => o.bbox[2]))
    if (L.bbox[2] < blockRight - 1.2 * h(L)) continue
    if (Math.abs(B.bbox[0] - L.bbox[0]) > 2.5 * h(L)) continue
    const alone = (s) => detectLine(s, { regions, tlds, phone, names: [], options: {} }).some((x) => x.kind === 'key')
    if (alone(a[0]) || alone(b[0])) continue
    const joined = a[0] + b[0]
    const hits = detectLine(joined, { regions, tlds, phone, names: [], options: {} }).filter((x) => x.kind === 'key' && x.rule !== 'labelled-assignment' && x.start < a[0].length && x.end > a[0].length)
    for (const x of hits) {
      rects.push({ r: rectOf(L, a.index + x.start, L.text.length), kind: 'key', rule: x.rule + '+wrap', tier: tier(x.score), text: a[0] })
      const off = B.text.length - B.text.trimStart().length
      rects.push({ r: rectOf(B, off, off + Math.min(b[0].length, x.end - a[0].length)), kind: 'key', rule: x.rule + '+wrap', tier: tier(x.score), text: b[0] })
    }
  }
  return rects
}

const inside = (x, y, r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]
function coverage(itemRect, rects) {
  const [x, y, w, hh] = itemRect
  let n = 0
  let c = 0
  for (let i = 0.5; i < w; i += 2)
    for (let j = 0.5; j < hh; j += 2) {
      n++
      if (rects.some((r) => inside(x + i, y + j, r.r))) c++
    }
  return n ? c / n : 0
}

const byKind = {}
const misses = []
const falseHits = []
let offCovered = 0
let offTotal = 0
for (const f of truth.frames) {
  const rf2 = reads.frames.find((x) => x.file === f.file)
  if (!rf2) continue
  const rects = frameHits({ ...rf2, width: f.width })
  for (const item of f.items) {
    if (item.kind === 'qr') continue // QR codes are classed by the reader, not by text rules
    if (!item.on) {
      offTotal++
      const cov = Math.max(...item.rects.map((r) => coverage(r, rects)))
      if (cov >= 0.5) offCovered++
      continue
    }
    const k = (byKind[item.kind] ??= { n: 0, found: 0, covered: 0 })
    k.n++
    const covs = item.rects.map((r) => coverage(r, rects))
    const area = item.rects.reduce((s, r) => s + r[2] * r[3], 0)
    const covArea = item.rects.reduce((s, r, i) => s + covs[i] * r[2] * r[3], 0) / area
    if (covArea >= 0.5) k.found++
    if (covs.every((c) => c >= 0.999)) k.covered++
    else misses.push(`${item.kind} ${item.id} cov=${covArea.toFixed(2)} "${item.text.slice(0, 50)}"`)
  }
  for (const r of rects) {
    const onAny = f.items.some((it) => it.on && it.rects.some((q) => !(r.r[2] < q[0] || r.r[0] > q[0] + q[2] || r.r[3] < q[1] || r.r[1] > q[1] + q[3])))
    if (!onAny) falseHits.push(`${f.file} ${r.rule}/${r.tier} "${r.text.slice(0, 40)}"`)
  }
}
let N = 0
let F = 0
let C = 0
console.log(`reads=${rf.split('/').pop()} regions=${regions}`)
for (const [k, v] of Object.entries(byKind)) {
  N += v.n
  F += v.found
  C += v.covered
  console.log(`  ${k.padEnd(11)} n=${String(v.n).padStart(3)} found=${v.found} covered=${v.covered}`)
}
console.log(`TOTAL text items n=${N} found=${F} (${((100 * F) / N).toFixed(1)}%) covered=${C} (${((100 * C) / N).toFixed(1)}%)`)
console.log(`off items (ordinary/address/dots/random) covered >=50%: ${offCovered} of ${offTotal}; hits touching no planted item: ${falseHits.length}`)
console.log('MISSES:\n  ' + misses.join('\n  '))
console.log('FALSE HITS:\n  ' + falseHits.join('\n  '))
