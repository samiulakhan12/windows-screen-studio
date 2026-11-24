/**
 * Test 69's harness (docs/design/output-and-languages.md §10.3 rule 1, §21.8, §23.1): every row of
 * scripts/i18n/log/*.json, its English message formatted by the app's own t() with the row's sample
 * values, equals the literal it replaced; plurals are checked at the counts 0, 1, 2 and 1000. The
 * extraction parts add their log files at S3; until then there are none, and the codemod's own test
 * (tests/i18nExtract.test.ts) proves the harness catches a message that drifted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { t, type MessageKey } from '../src/shared/i18n/t'

type Row = { key: string; file: string; line: number; english: string | string[]; sample: object | object[] }
const extract = require('../scripts/i18n/lib/extract.cjs') as { logProblems(rows: Row[], format: (key: string, values: Record<string, unknown>) => string): string[] }

const LOG_DIR = path.join(__dirname, '..', 'scripts', 'i18n', 'log')

/**
 * Question 17 of docs/design/auto-blur.md §0, answered (a) by the owner on 23 November 2026: these three
 * messages now read as §0 words them, and the log keeps the literal they replaced. Each formats as its
 * old literal only while it holds exactly its new wording, so any other change still fails.
 */
const Q17: Record<string, [now: string, then: string]> = {
  'text.shape.blur.title': ['Blur (always fully applied; blurred text can sometimes be read back)', 'Blur private content (always fully applied)'],
  'text.shape.pixelate.title': ['Pixelate (always fully applied; pixelated text can sometimes be read back)', 'Pixelate private content (always fully applied)'],
  'text.calloutSection.privacyNote': ['Blur and pixelate are fully on for their whole time. Text under them can sometimes be read back; a cover hides it completely.', 'Blur and pixelate are fully on for their whole time, so nothing they hide shows.']
}
const format = (key: string, values: Record<string, unknown>): string => {
  const text = t(key as MessageKey, values as Record<string, string | number>)
  const q = Q17[key]
  return q && text === q[0] ? q[1] : text
}
const logs = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.json')).sort() : []

describe('test 69: the extraction logs give back the English they replaced', () => {
  it('has a log folder for the parts', () => {
    expect(fs.existsSync(path.join(LOG_DIR, 'README.md'))).toBe(true)
  })

  for (const file of logs) {
    it(`every row of ${file}`, () => {
      const rows = JSON.parse(fs.readFileSync(path.join(LOG_DIR, file), 'utf8')) as Row[]
      expect(Array.isArray(rows)).toBe(true)
      expect(extract.logProblems(rows, format)).toEqual([])
    })
  }
})
