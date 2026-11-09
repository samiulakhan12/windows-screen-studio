import { describe, expect, it } from 'vitest'
import { cancelLine, LLM_PROTOCOL, loadLine, readHelperLine, runLine } from '../src/shared/localAi/protocol'

/* The helper's lines read strictly (docs/design/smart-tools.md §9.1): test 64. */

describe('readHelperLine (test 64)', () => {
  it('reads each event', () => {
    expect(readHelperLine('{"ev":"loaded","ms":1840,"ctxTrain":131072}')).toEqual({ ev: 'loaded', ms: 1840, ctxTrain: 131072 })
    expect(readHelperLine('{"ev":"read","id":"r7","done":512,"total":1478}')).toEqual({ ev: 'read', id: 'r7', done: 512, total: 1478 })
    expect(readHelperLine('{"ev":"write","id":"r7","tokens":48}')).toEqual({ ev: 'write', id: 'r7', tokens: 48 })
    expect(readHelperLine('{"ev":"done","id":"r7","text":"{\\"a\\":1}","prompt":1478,"output":212,"readMs":11700,"writeMs":38200}')).toEqual({
      ev: 'done',
      id: 'r7',
      text: '{"a":1}',
      prompt: 1478,
      output: 212,
      readMs: 11700,
      writeMs: 38200
    })
    expect(readHelperLine('{"ev":"cancelled","id":"r7"}')).toEqual({ ev: 'cancelled', id: 'r7' })
    expect(readHelperLine('{"ev":"error","id":"r7","code":"context","message":"too long"}')).toEqual({ ev: 'error', id: 'r7', code: 'context', message: 'too long' })
    // A load failure belongs to no request.
    expect(readHelperLine('{"ev":"error","code":"model","message":"bad file"}')).toEqual({ ev: 'error', code: 'model', message: 'bad file' })
    // Extra fields are dropped.
    expect(readHelperLine('{"ev":"cancelled","id":"r7","x":"y"}')).toEqual({ ev: 'cancelled', id: 'r7' })
  })

  it('an unknown event, bad JSON, a non-object, a missing or wrong field gives null', () => {
    for (const line of [
      '{"ev":"shell","cmd":"x"}',
      'not json',
      '{"ev":"done"',
      '[1,2]',
      '"done"',
      'null',
      '{"ev":"read","id":"r7","done":5}',
      '{"ev":"read","id":"r7","done":9,"total":5}',
      '{"ev":"write","id":"r 7","tokens":1}',
      '{"ev":"write","id":"r7","tokens":-1}',
      '{"ev":"write","id":"r7","tokens":1.5}',
      '{"ev":"done","id":"r7","text":5,"prompt":1,"output":1,"readMs":1,"writeMs":1}',
      '{"ev":"error","id":"r7","code":"shell","message":"x"}',
      '{"ev":"error","id":7,"code":"model","message":"x"}'
    ]) {
      expect(readHelperLine(line), line).toBeNull()
    }
  })

  it('a line over 4 MB gives null, and a done text over 256 KB', () => {
    const pad = 'x'.repeat(LLM_PROTOCOL.lineMax)
    expect(readHelperLine(`{"ev":"cancelled","id":"r7","pad":"${pad}"}`)).toBeNull()
    const big = 'y'.repeat(LLM_PROTOCOL.textMax + 1)
    expect(readHelperLine(JSON.stringify({ ev: 'done', id: 'r7', text: big, prompt: 1, output: 1, readMs: 1, writeMs: 1 }))).toBeNull()
    // 256 KB counted in UTF-8 bytes: Bangla takes three a letter.
    const bangla = 'ক'.repeat(Math.floor(LLM_PROTOCOL.textMax / 3) + 1)
    expect(readHelperLine(JSON.stringify({ ev: 'done', id: 'r7', text: bangla, prompt: 1, output: 1, readMs: 1, writeMs: 1 }))).toBeNull()
    const fits = 'y'.repeat(LLM_PROTOCOL.textMax)
    expect(readHelperLine(JSON.stringify({ ev: 'done', id: 'r7', text: fits, prompt: 1, output: 1, readMs: 1, writeMs: 1 }))?.ev).toBe('done')
  })
})

describe('the lines Flown writes', () => {
  it('load with mmap off; run with the fixed sampling; cancel', () => {
    expect(JSON.parse(loadLine('C:\\m\\a.gguf', 8192, 4))).toEqual({ op: 'load', model: 'C:\\m\\a.gguf', ctx: 8192, threads: 4, mmap: false })
    const run = JSON.parse(runLine('r7', [{ t: '<|im_start|>', special: true }, { t: 'hi', special: false }], 'root ::= "{}"', 400))
    expect(run).toEqual({ op: 'run', id: 'r7', parts: [{ t: '<|im_start|>', special: true }, { t: 'hi', special: false }], grammar: 'root ::= "{}"', maxTokens: 400, temperature: 0.2, topP: 0.9, seed: 1 })
    expect(JSON.parse(cancelLine('r7'))).toEqual({ op: 'cancel', id: 'r7' })
    expect(() => runLine('r 7', [], '', 1)).toThrow()
    // One line each: a newline in the text is escaped.
    expect(runLine('r1', [{ t: 'a\nb', special: false }], 'g', 1)).not.toContain('\n')
  })
})
