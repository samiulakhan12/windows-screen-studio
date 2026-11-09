import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { countWords, estimateTokens, imageTokens, PUNCT_RATIOS, scriptChars, tokenFamily, TOKEN_RATIOS } from '../src/shared/ai/tokens'

/*
 * Tokens from characters (docs/design/smart-tools.md §11.2, §22 test 90): the estimate of English,
 * Bangla, Hindi, Arabic, Japanese and mixed narration (and Chinese, Korean, Russian, Thai and a
 * caption JSON block) is within 10% of what o200k, Qwen3.5's and Gemma 4's tokenizers count; Claude's
 * is 1.3 times o200k's. The texts and their counts are kept in tests/fixtures/tokenSamples.json.
 */

interface Sample {
  name: string
  text: string
  o200k: number
  qwen: number
  gemma: number
}
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tokenSamples.json'), 'utf8')) as { samples: Sample[] }

describe('tokens from characters (test 90)', () => {
  it('has the samples the design names', () => {
    const names = FIXTURE.samples.map((s) => s.name)
    for (const n of ['english', 'bangla', 'hindi', 'arabic', 'japanese', 'mixed', 'json']) expect(names).toContain(n)
  })

  for (const family of ['o200k', 'qwen', 'gemma'] as const) {
    it(`counts within 10% of ${family}'s tokenizer`, () => {
      for (const s of FIXTURE.samples) {
        const e = estimateTokens(s.text, family)
        expect(Math.abs(e - s[family]) / s[family], `${s.name}: ${e} for ${s[family]}`).toBeLessThanOrEqual(0.1)
      }
    })
  }

  it("Claude's count is 1.3 times o200k's", () => {
    for (const s of FIXTURE.samples) {
      const ratio = estimateTokens(s.text, 'claude') / estimateTokens(s.text, 'o200k')
      expect(ratio, s.name).toBeGreaterThan(1.27)
      expect(ratio, s.name).toBeLessThan(1.33)
    }
    expect(TOKEN_RATIOS.claude.bengali).toBeCloseTo(TOKEN_RATIOS.o200k.bengali! / 1.3, 1)
    expect(PUNCT_RATIOS.claude).toBeCloseTo(PUNCT_RATIOS.o200k / 1.3, 1)
  })

  it('splits text by script: Latin letters and spaces, digits and punctuation, the dandas as punctuation', () => {
    expect(Object.fromEntries(scriptChars('Hi, 42!'))).toEqual({ latin: 3, punct: 4 })
    expect(Object.fromEntries(scriptChars('আমি।'))).toEqual({ bengali: 3, punct: 1 })
    expect(Object.fromEntries(scriptChars('日本語のテキスト'))).toEqual({ han: 3, kana: 5 })
    expect(Object.fromEntries(scriptChars('😀'))).toEqual({ other: 1 })
    expect(estimateTokens('', 'o200k')).toBe(0)
  })

  it('names each provider kind its tokenizer family', () => {
    expect(tokenFamily('anthropic')).toBe('claude')
    expect(tokenFamily('openai')).toBe('o200k')
    expect(tokenFamily('gemini')).toBe('o200k')
    expect(tokenFamily('local', 'qwen3.5-2b')).toBe('qwen')
    expect(tokenFamily('local', 'gemma4-e2b')).toBe('gemma')
  })

  it('counts words by Intl.Segmenter where words are not spaced, by letters and digits elsewhere', () => {
    expect(countWords('Click “Export”, then pick report-2026.csv.')).toBe(5)
    expect(countWords('আমি এখন রিপোর্ট খুলছি।')).toBe(4)
    expect(countWords('今日はレポートを書きます')).toBeGreaterThanOrEqual(4)
    expect(countWords('   ')).toBe(0)
  })

  it("prices a picture by each provider's rule, or the price list's own", () => {
    expect(imageTokens('openai', { w: 768, h: 432 })).toBe(85 + 170 * 2)
    expect(imageTokens('openai', { w: 4096, h: 2048 })).toBe(85 + 170 * 6)
    expect(imageTokens('gemini', { w: 300, h: 200 })).toBe(258)
    expect(imageTokens('gemini', { w: 1536, h: 768 })).toBe(258 * 2)
    expect(imageTokens('anthropic', { w: 750, h: 400 })).toBe(400)
    expect(imageTokens('anthropic', { w: 3136, h: 1568 })).toBe(Math.ceil((1568 * 784) / 750))
    expect(imageTokens('openai', { w: 1024, h: 1024 }, { base: 10, perTile: 100, tile: 256 })).toBe(10 + 1600)
  })
})
