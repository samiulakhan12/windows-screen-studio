// Usage: node speechFp.mjs <repo>. Reads prose as if spoken (0.4 s a word) and counts spoken-rule hits.
import fs from 'node:fs'; import path from 'node:path'
import { detectSpoken } from './rules.mjs'
const repo = process.argv[2]
function walk(dir, exts, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, exts, out); else if (exts.some((x) => e.name.endsWith(x))) out.push(p) } return out }
const paras = walk(path.join(repo, 'docs'), ['.md']).flatMap((f) => fs.readFileSync(f, 'utf8').split(/\n\s*\n/)).map((p) => p.replace(/[`*|#>_\[\]()]/g, ' '))
let words = 0; const counts = new Map(); const ex = new Map()
const t0 = Date.now()
for (const p of paras) {
  const ws = p.split(/\s+/).filter(Boolean).map((w, i) => ({ text: w, start: i * 0.4, end: i * 0.4 + 0.35 }))
  words += ws.length
  for (const f of detectSpoken(ws)) { counts.set(f.rule, (counts.get(f.rule) || 0) + 1); if (!ex.has(f.rule)) ex.set(f.rule, []); if (ex.get(f.rule).length < 4) ex.get(f.rule).push(ws.slice(Math.max(0, f.first - 4), f.last + 1).map((w) => w.text).join(' ').slice(0, 90)) }
}
console.log(`paragraphs=${paras.length} words=${words} time=${Date.now() - t0}ms`)
for (const [k, n] of counts) console.log(`  ${k}: ${n} (${(n / (words / 1e4)).toFixed(2)} per 10k words) e.g. ${JSON.stringify(ex.get(k))}`)
