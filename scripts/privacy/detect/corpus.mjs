// Usage: node corpus.mjs <repo> <tlds.ts> <metadata.max.json>. Counts hits per rule on text with no planted secrets.
import fs from 'node:fs'; import path from 'node:path'
import { detectLine, loadTlds, loadPhoneMeta } from './rules.mjs'
const [repo, tf, mf] = process.argv.slice(2)
const tlds = loadTlds(tf); const phone = loadPhoneMeta(mf)
function walk(dir, exts, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, exts, out); else if (exts.some((x) => e.name.endsWith(x))) out.push(p) } return out }
const sources = {
  ui: () => walk(path.join(repo, 'src/shared/i18n/messages/en'), ['.json']).filter((f) => !f.endsWith('.meta.json')).flatMap((f) => { const vals = []; const rec = (o) => { for (const v of Object.values(o)) typeof v === 'string' ? vals.push(v) : v && typeof v === 'object' && rec(v) }; rec(JSON.parse(fs.readFileSync(f, 'utf8'))); return vals.flatMap((v) => v.split('\n')) }),
  docs: () => walk(path.join(repo, 'docs'), ['.md']).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')),
  src: () => walk(path.join(repo, 'src'), ['.ts', '.tsx']).filter((f) => !/i18n[\/\\]built|emojiData|tlds\.ts|twemoji|numberData|bleepWords/.test(f)).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')),
  tests: () => walk(path.join(repo, 'tests'), ['.ts', '.tsx']).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n'))
}
let seed = 99; const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
const pick = (cls, n) => Array.from({ length: n }, () => cls[Math.floor(r() * cls.length)]).join('')
const HEX = '0123456789abcdef', AN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', B64 = AN + '+/'
sources.ids = () => Array.from({ length: 5000 }, (_, i) => [`commit ${pick(HEX, 40)}`, `id: ${pick(HEX, 8)}-${pick(HEX, 4)}-${pick(HEX, 4)}-${pick(HEX, 4)}-${pick(HEX, 12)}`, `sha256:${pick(HEX, 64)}`, `integrity sha512-${pick(B64, 86)}==`, `build ${pick(AN, 24)}`][i % 5])
sources.numbers = () => Array.from({ length: 5000 }, (_, i) => [`Order ${pick('0123456789', 10)} shipped`, `Invoice INV-${pick('0123456789', 8)}`, `Total ${pick('123456789', 1)}${pick('0123456789', 3)}.${pick('0123456789', 2)}`, `Ticket #${pick('0123456789', 7)}`, `Ref ${pick('0123456789', 4)} ${pick('0123456789', 4)} ${pick('0123456789', 4)} ${pick('0123456789', 4)}`][i % 5])
const sel = process.argv[5] ? process.argv[5].split(',') : Object.keys(sources)
for (const name of sel) {
  const lines = sources[name]().map((l) => l.slice(0, 2000))
  for (const opt of [{}, { randomStrings: true }]) {
    const counts = new Map(); const ex = new Map(); let hitLines = 0
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < lines.length; i++) {
      const hits = detectLine(lines[i], { above: lines[i - 1], regions: ['US', 'BD'], tlds, phone, names: [], options: opt }).filter((h) => h.score >= 0.5)
      if (hits.length) hitLines++
      for (const h of hits) { const k = h.rule.replace(/:.*/, ''); counts.set(k, (counts.get(k) || 0) + 1); if (!ex.has(k)) ex.set(k, []); if (ex.get(k).length < 3) ex.get(k).push(h.text.length > 44 ? h.text.slice(0, 20) + '…' + h.text.slice(-8) : h.text) }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    console.log(`\n[${name}] lines=${lines.length} randomStrings=${!!opt.randomStrings} hits=${total} linesWithHits=${hitLines} per10kLines=${(1e4 * total / lines.length).toFixed(1)} time=${ms.toFixed(0)}ms (${(1000 * ms / lines.length).toFixed(1)}us/line)`)
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}  e.g. ${JSON.stringify(ex.get(k))}`)
  }
}
