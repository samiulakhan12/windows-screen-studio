// Runs every tests/e2e/*.e2e.cjs file sequentially; exits non-zero if any fails.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const only = process.argv.slice(2)
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.e2e.cjs'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort()
let failed = 0
for (const f of files) {
  console.log(`\n=== ${f}`)
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}
console.log(`\n${files.length - failed}/${files.length} e2e files passed`)
process.exit(failed ? 1 : 0)
