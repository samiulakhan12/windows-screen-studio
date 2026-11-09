import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * How far the estimates were off (docs/design/smart-tools.md §11.6, §22 test 93): per (kind or host,
 * model, task) the ratios of reported to estimated tokens blend 0.7 × old + 0.3 × new and stay within
 * 0.5..2.0; ai-usage.json holds no text; at most 200 entries, the oldest dropped.
 */

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => { throw new Error('no userData in tests') } } }))
const { calibration, noteUsage, recordUsage, usageKey, usageRatios, useUsageFile, USAGE_LIMITS } = await import('../src/main/ai/usage')
const { estimateText } = await import('../src/shared/ai/cost')
const { BUNDLED_PRICE_LIST } = await import('../src/shared/ai/prices')
const { DEFAULT_TEXT_LIMITS, textPrompts } = await import('../src/shared/captions/transcriptText')

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'))
  file = path.join(dir, 'ai-usage.json')
  useUsageFile(file)
})
afterEach(() => {
  useUsageFile(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('usage calibration (test 93)', () => {
  it('blends the ratios 0.7 old + 0.3 new', async () => {
    const key = usageKey('openai', 'gpt-6.1-sol', 'summary')!
    expect(calibration(key)).toEqual({ input: 1, output: 1 })
    await recordUsage(key, { input: 1000, output: 100 }, { input: 1500, output: 50 })
    expect(calibration(key).input).toBeCloseTo(0.7 + 0.3 * 1.5, 10)
    expect(calibration(key).output).toBeCloseTo(0.7 + 0.3 * 0.5, 10)
    const after1 = calibration(key)
    await recordUsage(key, { input: 1000, output: 100 }, { input: 1000, output: 100 })
    expect(calibration(key).input).toBeCloseTo(0.7 * after1.input + 0.3, 10)
    // Read back from the file by a new session.
    useUsageFile(file)
    expect(calibration(key).input).toBeCloseTo(0.7 * after1.input + 0.3, 10)
  })

  it('clamps to 0.5..2.0', async () => {
    const key = usageKey('api.groq.com', 'llama-4-scout', 'title')!
    for (let i = 0; i < 30; i++) await recordUsage(key, { input: 10, output: 10 }, { input: 1000, output: 0 })
    expect(calibration(key)).toEqual({ input: USAGE_LIMITS.max, output: USAGE_LIMITS.min })
  })

  it('holds no text: keys are a kind or host, a model and a task, nothing else', async () => {
    expect(usageKey('openai', 'gpt-6.1-sol', 'cleaned_captions')).toBe('openai|gpt-6.1-sol|cleaned_captions')
    expect(usageKey('localhost:11434', 'llama3.2:3b', 'names')).toBe('localhost:11434|llama3.2:3b|names')
    expect(usageKey('openai', 'my secret captions here', 'title')).toBeNull()
    expect(usageKey('openai', 'gpt', 'Click Export now')).toBeNull()
    await recordUsage('openai|gpt|Click Export now', { input: 10, output: 10 }, { input: 10, output: 10 })
    expect(fs.existsSync(file)).toBe(false)
    const prompt = { name: 'title', system: 'Write a title.', user: 'Captions: the quarterly salary figures for Sam', schema: { type: 'object' } }
    noteUsage('openai', 'gpt-6.1-sol', prompt, '{"title":"Salary figures for Sam"}', { input: 30, output: 12 })
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true))
    const text = fs.readFileSync(file, 'utf8')
    expect(text).not.toMatch(/salary|Sam|quarterly|Captions/i)
    expect(Object.keys(JSON.parse(text).entries)).toEqual(['openai|gpt-6.1-sol|title'])
  })

  it('the ratios kept are what later estimates of the same provider, model and task are multiplied by (ai:usage)', async () => {
    const segments = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2.5, text: `Now click the Export button and choose report ${i}.` }))
    const request = { task: 'cleanup' as const, segments }
    const choice = { id: 'ai1', label: 'OpenAI', kind: 'openai' as const, model: 'gpt-6.1-sol', place: 'OpenAI' }
    const target = { choice, limits: DEFAULT_TEXT_LIMITS, prices: BUNDLED_PRICE_LIST, confirmPrices: BUNDLED_PRICE_LIST }
    expect(usageRatios()).toEqual({})
    // A model that reports twice the tokens estimated, run after run, through the prompt main sends.
    const prompt = textPrompts(request)[0]
    for (let i = 0; i < 12; i++) noteUsage('openai', 'gpt-6.1-sol', prompt, '{"segments":[]}', { input: 1e6, output: 1e6 })
    await vi.waitFor(() => expect(calibration('openai|gpt-6.1-sol|cleaned_captions')).toEqual({ input: USAGE_LIMITS.max, output: USAGE_LIMITS.max }))
    const ratios = usageRatios()
    expect(Object.keys(ratios)).toEqual(['openai|gpt-6.1-sol|cleaned_captions'])
    expect(ratios['openai|gpt-6.1-sol|cleaned_captions']).toEqual({ input: USAGE_LIMITS.max, output: USAGE_LIMITS.max })
    // No dates, nothing else.
    expect(Object.keys(ratios['openai|gpt-6.1-sol|cleaned_captions'])).toEqual(['input', 'output'])
    const plain = estimateText(request, target)
    const kept = estimateText(request, { ...target, usage: ratios })
    expect(Math.abs(kept.inputTokens[1] - plain.inputTokens[1] * 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(kept.outputTokens[1] - plain.outputTokens[1] * 2)).toBeLessThanOrEqual(1)
  })

  it('keeps at most 200 entries, the oldest dropped', async () => {
    for (let i = 0; i < 205; i++) await recordUsage(usageKey('openai', `model-${i}`, 'title')!, { input: 10, output: 10 }, { input: 12, output: 8 }, new Date(Date.UTC(2026, 0, 1, 0, 0, i)))
    const entries = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).entries)
    expect(entries).toHaveLength(200)
    expect(entries).not.toContain('openai|model-0|title')
    expect(entries).not.toContain('openai|model-4|title')
    expect(entries).toContain('openai|model-5|title')
    expect(entries).toContain('openai|model-204|title')
  })
})
