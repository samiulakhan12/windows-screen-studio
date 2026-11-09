import { describe, expect, it } from 'vitest'
import { MIN_ITEMS, schemaGrammar, STRING_BOUND_MAX } from '../src/shared/localAi/grammar'
import { MARKS_SCHEMA, NAMES_SCHEMA } from '../src/shared/captions/transcriptText'
import { everySchema } from './localAiFixtures'

/*
 * The answer's grammar (docs/design/smart-tools.md §9.6): test 68's shape here; llama.cpp's own
 * parser accepts every task's grammar in tests/llmHelper.test.ts (the real helper).
 */

describe('schemaGrammar (test 68)', () => {
  it('makes a grammar for every task schema, whose root starts the answer with {', () => {
    const all = everySchema()
    expect(all.length).toBeGreaterThanOrEqual(13)
    for (const { name, schema } of all) {
      const g = schemaGrammar(schema, { minItems: MIN_ITEMS })
      const root = /^root ::= (\S+)$/m.exec(g)?.[1]
      expect(root, name).toBeTruthy()
      const body = new RegExp(`^${root!.replace(/[-]/g, '\\-')} ::= (.*)$`, 'm').exec(g)?.[1]
      expect(body?.startsWith('"{"'), `${name}: ${body}`).toBe(true)
      // Keys in the schema's order, every one required.
      for (const key of Object.keys((schema as { properties: object }).properties)) expect(g).toContain(`"\\"${key}\\""`)
    }
  })

  it('bounds strings only for caps of 100 or fewer', () => {
    const at = (cap?: number): string => schemaGrammar(NAMES_SCHEMA, { string: cap, minItems: MIN_ITEMS })
    expect(at(80)).toContain('char{0,80}')
    expect(at(STRING_BOUND_MAX)).toContain(`char{0,${STRING_BOUND_MAX}}`)
    expect(at(101)).not.toMatch(/char\{0,/)
    expect(at(300)).not.toMatch(/char\{0,/)
    expect(at()).not.toMatch(/char\{0,/)
    expect(at(80)).toMatch(/"name\\""\s+ws ":" ws string-bounded/)
  })

  it('needs one item in names and chapters; other lists may be empty', () => {
    const names = schemaGrammar(NAMES_SCHEMA, { minItems: MIN_ITEMS })
    const namesList = /^names-\d+ ::= (.*)$/m.exec(names)?.[1] ?? ''
    expect(namesList).not.toContain(')?')
    expect(namesList.startsWith('"[" ws names-item')).toBe(true)
    const withoutMin = schemaGrammar(NAMES_SCHEMA)
    expect(/^names-\d+ ::= (.*)$/m.exec(withoutMin)?.[1]).toContain(')?')
    const marks = schemaGrammar(MARKS_SCHEMA, { minItems: MIN_ITEMS })
    expect(/^numbers-\d+ ::= (.*)$/m.exec(marks)?.[1]).toContain(')?')
  })

  it('refuses a schema it cannot express exactly', () => {
    expect(() => schemaGrammar({ type: 'object', properties: { a: { type: 'string' } }, required: [] })).toThrow(/required/)
    expect(() => schemaGrammar({ type: 'object', properties: { a: { type: 'null' } }, required: ['a'] })).toThrow()
    expect(() => schemaGrammar({ type: 'array', items: { type: 'string' } })).toThrow()
  })

  it('JSON strings: any character but a quote, a backslash or a control character, or an escape (Bangla passes the class)', () => {
    const g = schemaGrammar(NAMES_SCHEMA)
    expect(g).toContain('char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" ( ["\\\\/bfnrt] | "u" [0-9a-fA-F]{4} )')
    expect(g).toContain('ws ::= | " " | "\\n" [ \\t]{0,8}')
  })
})
