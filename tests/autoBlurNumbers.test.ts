import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The numbered tests of docs/design/auto-blur.md §17.1: each number names one test, once. The
 * contracts step wrote 1 to 40 and 186 to 197 (test 20 is the equivalence guard's sections,
 * tests/autoBlurEquivalence.test.ts); the parts add theirs under their own numbers.
 */

const DIR = __dirname
const CONTRACTS = [...Array.from({ length: 40 }, (_v, i) => i + 1), ...Array.from({ length: 12 }, (_v, i) => 186 + i)]

/** Every `it('<n>. …'` of the auto-blur test files, with the file it is in. */
function numbered(): { n: number; file: string }[] {
  const out: { n: number; file: string }[] = []
  for (const file of fs.readdirSync(DIR).filter((f) => /^autoBlur.*\.test\.ts$/.test(f))) {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8')
    for (const m of text.matchAll(/\bit\(\s*(['"`])(\d+)\. /g)) out.push({ n: Number(m[2]), file })
  }
  return out
}

describe('auto-blur contracts: test numbers', () => {
  it('every contracts test (1 to 40, 186 to 197) exists exactly once, and no number names two tests', () => {
    const all = numbered()
    const count = new Map<number, string[]>()
    for (const { n, file } of all) count.set(n, [...(count.get(n) ?? []), file])
    for (const [n, files] of count) expect(files, `test ${n}`).toHaveLength(1)
    for (const n of CONTRACTS) {
      if (n === 20) continue
      expect(count.get(n), `test ${n}`).toHaveLength(1)
    }
    // Test 20 is the guard's own: its sections, in its file alone.
    const guard = fs.readFileSync(path.join(DIR, 'autoBlurEquivalence.test.ts'), 'utf8')
    expect(guard.match(/describe\('test 20: /g)?.length ?? 0).toBeGreaterThanOrEqual(8)
    expect(count.has(20)).toBe(false)
  })
})
