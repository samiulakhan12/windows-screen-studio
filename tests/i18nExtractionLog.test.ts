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
const logs = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.json')).sort() : []

describe('test 69: the extraction logs give back the English they replaced', () => {
  it('has a log folder for the parts', () => {
    expect(fs.existsSync(path.join(LOG_DIR, 'README.md'))).toBe(true)
  })

  for (const file of logs) {
    it(`every row of ${file}`, () => {
      const rows = JSON.parse(fs.readFileSync(path.join(LOG_DIR, file), 'utf8')) as Row[]
      expect(Array.isArray(rows)).toBe(true)
      expect(extract.logProblems(rows, (key, values) => t(key as MessageKey, values as Record<string, string | number>))).toEqual([])
    })
  }
})
