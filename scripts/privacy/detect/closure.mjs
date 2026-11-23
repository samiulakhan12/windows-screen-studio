// Walk static ES imports from entry files (text only; nothing is executed). Usage: node closure.mjs <pkgRoot> <entry...>
import fs from 'node:fs'; import path from 'node:path'
const [root, ...entries] = process.argv.slice(2)
const seen = new Set(); const stack = entries.map((e) => path.resolve(root, e))
const RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g
while (stack.length) {
  const f = stack.pop(); if (seen.has(f)) continue; seen.add(f)
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(RE)) { const spec = m[1] ?? m[2]; if (!spec.startsWith('.')) { console.error('bare import', spec, 'in', f); continue } stack.push(path.resolve(path.dirname(f), spec)) }
}
let total = 0; const rows = [...seen].map((f) => { const s = fs.statSync(f).size; total += s; return [path.relative(root, f), s] }).sort()
for (const [f, s] of rows) console.log(s, f)
console.log('FILES', rows.length, 'BYTES', total)
