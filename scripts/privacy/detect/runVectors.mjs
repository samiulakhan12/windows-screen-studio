// Usage: node runVectors.mjs <vectors.json> <tlds.ts> <metadata.max.json>
import fs from 'node:fs'
import { detectLine, detectSpoken, loadTlds, loadPhoneMeta } from './rules.mjs'
const [vf, tf, mf] = process.argv.slice(2)
const V = JSON.parse(fs.readFileSync(vf, 'utf8'))
const tlds = loadTlds(tf)
const phone = loadPhoneMeta(mf)
const CLASSES = { A: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', a: 'abcdefghijklmnopqrstuvwxyz0123456789', H: '0123456789abcdef', U: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', D: '0123456789', L: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', B: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', S: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+' }
function rng(seed) { let x = seed >>> 0; return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32) }
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h }
function expander(id) {
  const cache = new Map(); const r = rng(V.seed ^ hash(id))
  return (str) => str.replace(/«([^»]*)»/g, (_, body) => {
    if (cache.has(body)) return cache.get(body)
    let out = ''
    for (const item of body.split('|')) {
      if (item.startsWith('=')) out += item.slice(1)
      else { const cls = CLASSES[item[0]]; const n = Number(item.slice(1)); for (let i = 0; i < n; i++) out += cls[Math.floor(r() * cls.length)] }
    }
    cache.set(body, out); return out
  })
}
const tier = (s) => (s >= 0.85 ? 'auto' : s >= 0.5 ? 'check' : 'drop')
let pass = 0, fail = 0
for (const v of V.screen) {
  const ex = expander(v.id)
  const text = ex(v.text)
  const hits = detectLine(text, { above: v.above ? ex(v.above) : undefined, left: v.left, recovery: v.recovery, regions: v.regions ?? ['US', 'BD'], tlds, phone, names: v.names ?? [], options: v.options ?? {} }).filter((h) => tier(h.score) !== 'drop')
  const want = v.expect.map((e) => ({ ...e, text: ex(e.text) }))
  const problems = []
  for (const w of want) { const h = hits.find((h) => h.text === w.text); if (!h) problems.push(`missing ${w.kind} "${w.text}"`); else if (h.kind !== w.kind || tier(h.score) !== w.tier) problems.push(`got ${h.kind}/${tier(h.score)}(${h.score},${h.rule}) want ${w.kind}/${w.tier}`) }
  for (const h of hits) if (!want.some((w) => w.text === h.text)) problems.push(`extra ${h.kind}/${h.rule}/${h.score} "${h.text}"`)
  if (problems.length) { fail++; console.log('FAIL', v.id, '|', text, '|', problems.join('; ')) } else pass++
}
for (const v of V.speech) {
  const toks = v.words.replace(/<pause ([\d.]+)>/g, '<pause:$1>').split(/\s+/).filter(Boolean)
  const words = []; let t = 0
  for (const tok of toks) { if (tok === '||') continue; const p = /^<pause:([\d.]+)>$/.exec(tok); if (p) { t += Number(p[1]); continue } words.push({ text: tok, start: t, end: t + 0.35 }); t += 0.4 }
  const found = detectSpoken(words).map((f) => ({ kind: f.kind, words: words.slice(f.first, f.last + 1).map((w) => w.text).join(' '), rule: f.rule }))
  const problems = []
  for (const w of v.expect) if (!found.some((f) => f.kind === w.kind && f.words === w.words)) problems.push(`missing ${w.kind} "${w.words}"`)
  for (const f of found) if (!v.expect.some((w) => w.kind === f.kind && w.words === f.words)) problems.push(`extra ${f.kind}/${f.rule} "${f.words}"`)
  if (problems.length) { fail++; console.log('FAIL', v.id, '|', problems.join('; ')) } else pass++
}
console.log(`vectors: ${pass} passed, ${fail} failed, ${V.screen.length} screen + ${V.speech.length} speech`)
