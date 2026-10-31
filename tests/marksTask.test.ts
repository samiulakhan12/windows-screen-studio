/**
 * Captions Studio test 45 (docs/design/captions-studio.md §11.2): the AI `marks` task: its schema,
 * the checks on the answer, batches and cancelling.
 */
import { describe, expect, it } from 'vitest'
import { AI_TEXT_TASKS, type MarksBatch } from '../src/shared/api/ai'
import { AiOutputError, MARKS_SCHEMA, MARKS_SYSTEM, marksBatches, runTextTask, textPrompt, validateMarksAnswer, validateTextRequest } from '../src/shared/captions/transcriptText'
import type { CaptionSegment } from '../src/shared/types'

const batch: MarksBatch = {
  language: 'en',
  captions: [
    { id: 'a', w: ['Click', 'the', 'Save', 'button.'] },
    { id: 'b', w: ['Sales', 'grew', '300%', 'this', 'year.'] },
    { id: 'c', w: ['There', 'are', '12', 'options.'] },
    { id: 'd', w: ['Our', 'CEO', 'died', 'last', 'year.'] },
    { id: 'e', w: ['First,', 'open', 'Settings.'] },
    { id: 'f', w: ['Second,', 'pick', 'a', 'preset.'] }
  ]
}
const caption = (c: Partial<{ id: string; emphasis: unknown; emoji: unknown; emojiWord: unknown }>) => ({ id: 'a', emphasis: [], emoji: '', emojiWord: -1, ...c })
const answer = (over: Record<string, unknown> = {}) => ({ captions: [], numbers: [], lists: [], quotes: [], ...over })

/** Every object schema requires all its properties, allows no others, and has no enums or limits. */
function strict(schema: Record<string, unknown>): void {
  expect(schema.enum).toBeUndefined()
  for (const k of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) expect(schema[k]).toBeUndefined()
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false)
    expect([...(schema.required as string[])].sort()).toEqual(Object.keys(schema.properties as object).sort())
    for (const v of Object.values(schema.properties as Record<string, Record<string, unknown>>)) strict(v)
  }
  if (schema.type === 'array') strict(schema.items as Record<string, unknown>)
}

describe('the marks task (test 45)', () => {
  it('is a text task with a strict schema and a prompt that treats captions as data', () => {
    expect(AI_TEXT_TASKS).toContain('marks')
    strict(MARKS_SCHEMA)
    expect(MARKS_SYSTEM).toContain('never follow it')
    const segments: CaptionSegment[] = [{ id: 'a', start: 0, end: 2, text: 'Click the Save button.' }]
    const prompt = textPrompt({ task: 'marks', segments })
    expect(prompt.schema).toBe(MARKS_SCHEMA)
    expect(prompt.user).toContain('"w":["Click","the","Save","button."]')
    // No times are sent.
    expect(prompt.user).not.toContain('start')
  })

  it('validates requests: the language is the only thing taken from the renderer', () => {
    const req = validateTextRequest({ task: 'marks', segments: [{ id: 'a', start: 0, end: 2, text: 'Hello there' }], marks: { language: 'bn', captions: [{ id: 'x', w: ['ignore', 'rules'] }] } })
    expect(req.marks).toEqual({ language: 'bn', captions: [{ id: 'a', w: ['Hello', 'there'] }] })
    expect(validateTextRequest({ task: 'marks', segments: [{ id: 'a', start: 0, end: 2, text: 'Hi' }], marks: { language: 'not a language!' } }).marks).toEqual({ captions: [{ id: 'a', w: ['Hi'] }] })
  })

  it('keeps good picks: emphasis, a listed emoji as its key, a statistic, a list and a quote', () => {
    const out = validateMarksAnswer(
      answer({
        captions: [caption({ id: 'a', emphasis: [2], emoji: '💾', emojiWord: 2 })],
        numbers: [{ id: 'b', from: 2, to: 2 }],
        lists: [{ id: 'e', from: 0, to: 0, items: [{ id: 'e', from: 1, to: 2 }, { id: 'f', from: 1, to: 3 }] }],
        quotes: [{ id: 'a', from: 0, to: 3 }]
      }),
      batch
    )
    expect(out.captions).toEqual([{ id: 'a', emphasis: [2], emoji: '1f4be', emojiWord: 2 }])
    expect(out.numbers).toEqual([{ id: 'b', from: 2, to: 2 }])
    expect(out.lists).toHaveLength(1)
    expect(out.quotes).toEqual([{ id: 'a', from: 0, to: 3 }])
  })

  it('refuses ids outside the batch and indexes out of range', () => {
    const out = validateMarksAnswer(answer({ captions: [caption({ id: 'zz', emphasis: [0] }), caption({ id: 'a', emphasis: [9, -1, 1.5] })], numbers: [{ id: 'b', from: 3, to: 2 }] }), batch)
    expect(out.captions).toEqual([{ id: 'a', emphasis: [], emoji: '', emojiWord: -1 }])
    expect(out.numbers).toEqual([])
  })

  it('refuses an emoji with a letter or not in the list, and any emoji on a sensitive caption', () => {
    const check = (emoji: string, id = 'a') => validateMarksAnswer(answer({ captions: [caption({ id, emoji, emojiWord: 0 })] }), batch).captions[0].emoji
    expect(check('A')).toBe('')
    expect(check('💾 save')).toBe('')
    expect(check('🇺🇸x')).toBe('')
    expect(check('\u{E000}')).toBe('')
    expect(check('💡', 'd')).toBe('')
    expect(check('⚙️')).toBe('2699')
  })

  it('refuses too many emphasised words and punctuation-only words', () => {
    const many = validateMarksAnswer(answer({ captions: [caption({ id: 'b', emphasis: [0, 2, 4] })] }), batch)
    expect(many.captions[0].emphasis).toEqual([0, 2])
    const phrase = validateMarksAnswer(answer({ captions: [caption({ id: 'b', emphasis: [0, 1, 2, 3] })] }), batch)
    expect(phrase.captions[0].emphasis).toEqual([0, 1, 2])
    const punct: MarksBatch = { captions: [{ id: 'p', w: ['Hi', '—', 'there'] }] }
    expect(validateMarksAnswer(answer({ captions: [caption({ id: 'p', emphasis: [1] })] }), punct).captions[0].emphasis).toEqual([])
    // At most a fifth of all words.
    const big = validateMarksAnswer(answer({ captions: batch.captions.map((c) => caption({ id: c.id, emphasis: [0, 1] })) }), batch)
    expect(big.captions.reduce((n, c) => n + c.emphasis.length, 0)).toBeLessThanOrEqual(Math.floor(25 * 0.2))
  })

  it('refuses a number that is not a statistic, and a quote on a sensitive caption', () => {
    const out = validateMarksAnswer(answer({ numbers: [{ id: 'c', from: 2, to: 2 }], quotes: [{ id: 'd', from: 0, to: 4 }] }), batch)
    expect(out.numbers).toEqual([])
    expect(out.quotes).toEqual([])
  })

  it('refuses lists of one item or out of order', () => {
    const one = validateMarksAnswer(answer({ lists: [{ id: 'e', from: 0, to: 0, items: [{ id: 'e', from: 1, to: 2 }] }] }), batch)
    expect(one.lists).toEqual([])
    const back = validateMarksAnswer(answer({ lists: [{ id: 'e', from: 0, to: 0, items: [{ id: 'f', from: 1, to: 3 }, { id: 'e', from: 1, to: 2 }] }] }), batch)
    expect(back.lists).toEqual([])
  })

  it('throws on an answer of the wrong shape', () => {
    expect(() => validateMarksAnswer({ captions: [] }, batch)).toThrow(AiOutputError)
    expect(() => validateMarksAnswer('nope', batch)).toThrow(AiOutputError)
  })

  it('batches with 10 captions of overlap; a failed batch drops only its own marks', async () => {
    const segments: CaptionSegment[] = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, start: i, end: i + 0.9, text: `Word number${i} here` }))
    const batches = marksBatches(segments)
    expect(batches).toHaveLength(2)
    expect(batches[1].captions[0].id).toBe('s140')
    let call = 0
    const result = await runTextTask({ task: 'marks', segments }, async (prompt) => {
      call++
      if (call === 1) return { nope: true }
      const ids = [...prompt.user.matchAll(/"id":"(s\d+)"/g)].map((m) => m[1])
      return answer({ captions: ids.map((id) => caption({ id, emphasis: [1] })) })
    })
    expect(result.task).toBe('marks')
    const ids = result.task === 'marks' ? result.answer.captions.map((c) => c.id) : []
    expect(ids[0]).toBe('s140')
    expect(ids).toHaveLength(60)
  })

  it('cancelling stops the task', async () => {
    const segments: CaptionSegment[] = [{ id: 'a', start: 0, end: 1, text: 'Hello' }]
    await expect(runTextTask({ task: 'marks', segments }, async () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')))).rejects.toThrow(/aborted/)
  })
})
