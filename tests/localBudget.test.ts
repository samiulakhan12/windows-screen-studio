import { describe, expect, it } from 'vitest'
import { fitsContext, LOCAL_BUDGET, LOCAL_CTX, LOCAL_TOKEN_RATIOS, localLimits, localTokens, maxTokensFor, PROMPT_BATCH, promptTokens } from '../src/shared/localAi/budget'
import { textPrompts, type TextPrompt } from '../src/shared/captions/transcriptText'
import type { AiTextRequest, AiTextTask } from '../src/shared/api/ai'
import type { CaptionSegment } from '../src/shared/types'

/* How text tasks are split and how much room answers get on this PC (§9.6): test 69. */

const english = 'Now we open the settings and click the export button to save the report as a PDF file.'
const bangla = 'এখন আমরা সেটিংস খুলি এবং রিপোর্টটি পিডিএফ ফাইল হিসেবে সংরক্ষণ করতে এক্সপোর্ট বোতামে ক্লিক করি।'
const segments = (text: string, n: number): CaptionSegment[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 3, text }))

/** Tokens of the transcript inside a prompt, at the model's ratio for its script. */
const transcriptTokens = (p: TextPrompt, family: 'qwen' | 'gemma'): number => {
  const data = JSON.parse(p.user.slice(p.user.indexOf('\n') + 1)) as { segments?: { text: string }[] }
  return localTokens((data.segments ?? []).map((s) => s.text).join(' '), family)
}

describe('localLimits and maxTokensFor (test 69)', () => {
  it('40 captions or 3,000 characters a batch; 12 names or 3,000 characters a request; 4,500 transcript tokens', () => {
    for (const family of ['qwen', 'gemma'] as const) {
      expect(localLimits('en', family)).toEqual({ batchSegments: 40, batchChars: 3000, transcriptTokens: 4500, namesItems: 12, namesChars: 3000 })
      expect(localLimits('bn', family)).toEqual(localLimits(undefined, family))
    }
    const many = segments(english, 200)
    const batches = textPrompts({ task: 'cleanup', segments: many }, localLimits('en', 'qwen'))
    expect(batches.length).toBeGreaterThanOrEqual(6)
    for (const p of batches) {
      const n = (JSON.parse(p.user.slice(p.user.indexOf('\n') + 1)) as { segments: unknown[] }).segments.length
      expect(n).toBeLessThanOrEqual(40)
    }
  })

  it('title and summary read excerpts within 4,500 tokens, in English and Bangla, for both tokenizers (Qwen 2.04, Gemma 3.45 characters a token)', () => {
    expect(LOCAL_TOKEN_RATIOS.qwen.other).toBe(2.04)
    expect(LOCAL_TOKEN_RATIOS.gemma.other).toBe(3.45)
    for (const text of [english, bangla]) {
      for (const family of ['qwen', 'gemma'] as const) {
        for (const task of ['title', 'summary'] as const) {
          const [p] = textPrompts({ task, segments: segments(text, 3000) }, localLimits('en', family))
          expect(transcriptTokens(p, family), `${task} ${family} ${text.slice(0, 5)}`).toBeLessThanOrEqual(4500)
          expect(transcriptTokens(p, family)).toBeGreaterThan(1500)
          expect(promptTokens(p, family) + maxTokensFor(p, task, family)).toBeLessThanOrEqual(LOCAL_CTX - PROMPT_BATCH)
        }
      }
    }
  })

  it('every task’s prompt plus its room stays within 8,128 tokens, in English and Bangla', () => {
    expect(LOCAL_BUDGET).toBe(8128)
    const tasks: AiTextTask[] = ['cleanup', 'translate', 'title', 'summary', 'youtube', 'linkedin', 'xpost', 'article', 'releaseNotes', 'names']
    for (const text of [english, bangla]) {
      for (const family of ['qwen', 'gemma'] as const) {
        for (const task of tasks) {
          const request: AiTextRequest =
            task === 'names'
              ? { task, segments: [], names: { kind: 'note', items: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, text: text.repeat(3), action: 'Click Export' })) } }
              : task === 'translate'
                ? { task, segments: segments(text, 400), targetLanguage: 'Bangla' }
                : { task, segments: segments(text, 3000) }
          for (const p of textPrompts(request, localLimits('en', family))) {
            const room = maxTokensFor(p, task, family, task === 'names' ? 'note' : undefined)
            expect(promptTokens(p, family) + room, `${task} ${family}`).toBeLessThanOrEqual(LOCAL_BUDGET)
            expect(fitsContext(p, room, family)).toBe(true)
          }
        }
      }
    }
  })

  it('the room of each task (§9.6)', () => {
    const [title] = textPrompts({ task: 'title', segments: segments(english, 5) }, localLimits('en', 'qwen'))
    expect(maxTokensFor(title, 'title', 'qwen')).toBe(80)
    expect(maxTokensFor(title, 'summary', 'qwen')).toBe(400)
    expect(maxTokensFor(title, 'youtube', 'qwen')).toBe(1000)
    expect(maxTokensFor(title, 'linkedin', 'qwen')).toBe(700)
    expect(maxTokensFor(title, 'xpost', 'qwen')).toBe(160)
    expect(maxTokensFor(title, 'article', 'qwen')).toBe(2200)
    expect(maxTokensFor(title, 'releaseNotes', 'qwen')).toBe(1400)
    const [names] = textPrompts({ task: 'names', segments: [], names: { kind: 'step', items: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] } }, localLimits('en', 'qwen'))
    expect(maxTokensFor(names, 'names', 'qwen', 'step')).toBe(48 * 2 + 32)
    expect(maxTokensFor(names, 'names', 'qwen', 'note')).toBe(120 * 2 + 32)
    // Clean-up: ceil(text tokens × 1.3) + 12 a caption + 64, at most 4,096.
    const [cleanup] = textPrompts({ task: 'cleanup', segments: segments(english, 10) }, localLimits('en', 'qwen'))
    const textTokens = localTokens(english, 'qwen') * 10
    expect(maxTokensFor(cleanup, 'cleanup', 'qwen')).toBe(Math.ceil(textTokens * 1.3) + 12 * 10 + 64)
    // A translation counts the denser script, so Bangla output never runs short.
    expect(maxTokensFor(cleanup, 'translate', 'qwen')).toBeGreaterThan(maxTokensFor(cleanup, 'cleanup', 'qwen'))
  })
})
