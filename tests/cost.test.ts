import { describe, expect, it } from 'vitest'
import { aboutTime, confirmText, costLineText, costPart, costSentence, CONFIRM_LOCAL_S, estimateScript, estimateText, estimateTranscription, needsConfirm, usageText, type CostEstimate } from '../src/shared/ai/cost'
import { BUNDLED_PRICE_LIST, confirmList, newerList, parsePriceList, readOpenRouterPrice, type PriceList } from '../src/shared/ai/prices'
import { estimateTokens } from '../src/shared/ai/tokens'
import type { AiTextRequest, TextChoice } from '../src/shared/api/ai'
import { DEFAULT_TEXT_LIMITS, textPrompts } from '../src/shared/captions/transcriptText'
import type { CaptionSegment } from '../src/shared/types'

/*
 * The cost up front (docs/design/smart-tools.md §11, §22 tests 91, 92, 100, 133 and 134): output
 * estimates per task, the words of each part of the line, when a click asks first, OpenRouter's
 * prices, and a downloaded price list that can raise an estimate but never lower a confirm.
 */

const seg = (i: number, text: string): CaptionSegment => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2.5, text })
const SEGMENTS = Array.from({ length: 40 }, (_, i) => seg(i, `Now click the Export button and choose the report number ${i}.`))
const CAPTION_TOKENS = (family: 'o200k' | 'claude' = 'o200k'): number => estimateTokens(SEGMENTS.map((s) => s.text).join('\n'), family)

const OPENAI: TextChoice = { id: 'ai1', label: 'OpenAI', kind: 'openai', model: 'gpt-4.1', place: 'OpenAI', pictures: true }
const PRICED: TextChoice = { ...OPENAI, model: 'gpt-6.1-sol' }
const CLAUDE: TextChoice = { id: 'ai2', label: 'Claude', kind: 'anthropic', model: 'claude-opus-5-5', place: 'Claude', pictures: true }
const LOCAL: TextChoice = { id: 'local', label: 'On this PC', kind: 'local', model: '', place: 'this PC', pictures: false }
const service = (host: string, model: string, free = false): TextChoice => ({ id: 'svc1', label: host, kind: 'openai', model, host, place: host, ...(free ? { free: true as const } : {}), pictures: true })

const target = (choice: TextChoice, extra: Partial<Parameters<typeof estimateText>[1]> = {}): Parameters<typeof estimateText>[1] => ({
  choice,
  limits: DEFAULT_TEXT_LIMITS,
  prices: BUNDLED_PRICE_LIST,
  confirmPrices: BUNDLED_PRICE_LIST,
  ...extra
})
const req = (r: Partial<AiTextRequest> & { task: AiTextRequest['task'] }): AiTextRequest => ({ segments: SEGMENTS, ...r })
const out = (r: AiTextRequest, choice: TextChoice = OPENAI): [number, number] => estimateText(r, target(choice)).outputTokens

describe('what comes back, per task (test 91)', () => {
  it('clean-up: the captions × 1.0 to × 1.15, + 12 a caption', () => {
    const t = CAPTION_TOKENS()
    expect(out(req({ task: 'cleanup' }))).toEqual([Math.round(t + 12 * 40), Math.round(t * 1.15 + 12 * 40)])
  })

  it("translate: the captions × (the source's characters per token ÷ the target's) × 0.9 to × 1.2, + 12 a caption", () => {
    const t = CAPTION_TOKENS()
    const [lo, hi] = out(req({ task: 'translate', targetLanguage: 'Bengali' }))
    // English to Bangla: Bangla takes more tokens a character, so more come back than went.
    expect(lo).toBeGreaterThan(t * 0.9 * 1.4 + 480)
    expect((hi - 480) / (lo - 480)).toBeCloseTo(1.2 / 0.9, 2)
    // English to Spanish: about as many tokens as went.
    const [slo, shi] = out(req({ task: 'translate', targetLanguage: 'Spanish' }))
    expect((slo - 480) / (t * 0.9)).toBeGreaterThan(0.85)
    expect((shi - 480) / (t * 1.2)).toBeLessThan(1.15)
    expect(out(req({ task: 'translate', targetLanguage: 'bn' }))).toEqual([lo, hi])
  })

  it('chapters, title, summary, names, marks and the copy pack', () => {
    expect(out(req({ task: 'chapters' }))).toEqual([25, 25 * 2])
    const long = [seg(0, 'Intro.'), { ...seg(1, 'The end.'), end: 600 }]
    expect(out({ task: 'chapters', segments: long })).toEqual([25, 125])
    expect(out(req({ task: 'title' }))).toEqual([15, 40])
    expect(out(req({ task: 'summary' }))).toEqual([80, 300])
    const items = [1, 2, 3].map((i) => ({ id: `k${i}`, text: `Step ${i}: click Export.` }))
    expect(out({ task: 'names', segments: [], names: { kind: 'step', items } })).toEqual([24, 75])
    expect(out({ task: 'names', segments: [], names: { kind: 'note', items } })).toEqual([90, 270])
    expect(out(req({ task: 'marks' }))).toEqual([200, 800])
    expect(out(req({ task: 'youtube', length: 'normal' }))).toEqual([450, 900])
    expect(out(req({ task: 'youtube', length: 'short' }))).toEqual([225, 450])
    expect(out(req({ task: 'linkedin' }))).toEqual([250, 500])
    expect(out(req({ task: 'xpost' }))).toEqual([60, 90])
    expect(out(req({ task: 'article' }))).toEqual([900, 2000])
    expect(out(req({ task: 'releaseNotes', length: 'short' }))).toEqual([200, 500])
  })

  it('thinking widens only the high end: 500 a request for a low-effort task, 2,000 for a medium one', () => {
    const title = req({ task: 'title' })
    const plain = estimateText(title, target({ ...CLAUDE, model: 'claude-3-haiku' })).outputTokens
    const thinking = estimateText(title, target(CLAUDE)).outputTokens
    expect(thinking[0]).toBe(plain[0])
    expect(thinking[1]).toBe(plain[1] + 500)
    const many = Array.from({ length: 200 }, (_, i) => seg(i, `Caption number ${i} says something about the report.`))
    const cleanup: AiTextRequest = { task: 'cleanup', segments: many }
    const e = estimateText(cleanup, target(CLAUDE))
    const requests = textPrompts(cleanup).length
    expect(requests).toBe(2)
    expect(e.outputTokens[1] - estimateText(cleanup, target({ ...CLAUDE, model: 'claude-3-haiku' })).outputTokens[1]).toBe(2000 * requests)
  })

  it('counts the requests and the words sent; input is ±25% of the prompts, ±40% for a service', () => {
    const e = estimateText(req({ task: 'summary' }), target(PRICED))
    expect(e.requests).toBe(1)
    expect(e.words).toBe(40 * 11)
    const prompt = textPrompts(req({ task: 'summary' }))[0]
    const mid = estimateTokens(prompt.system, 'o200k') + estimateTokens(prompt.user, 'o200k') + estimateTokens(JSON.stringify(prompt.schema), 'o200k')
    expect(e.inputTokens).toEqual([Math.round(mid * 0.75), Math.round(mid * 1.25)])
    expect(estimateText(req({ task: 'summary' }), target(service('api.groq.com', 'openai/gpt-oss-20b'))).inputTokens).toEqual([Math.round(mid * 0.6), Math.round(mid * 1.4)])
  })

  it('Draft script: the notes × 1.0 to × 2.0; transcription by the minute', () => {
    const notes = 'Open the report. Pick last month. Export as CSV. Share it with the team.'
    const n = estimateTokens(notes, 'o200k')
    expect(estimateScript(notes, target(OPENAI)).outputTokens).toEqual([n, n * 2])
    const t = estimateTranscription(600, { kind: 'openai', model: 'whisper-1', prices: BUNDLED_PRICE_LIST })
    expect(t.usd).toEqual([0.06, 0.06])
    expect(estimateTranscription(600, { kind: 'gemini', model: 'gemini-3.8-flash', prices: BUNDLED_PRICE_LIST }).usd![1]).toBeGreaterThan(0)
    expect(estimateTranscription(600, { kind: 'openai', model: 'some-new-transcriber', prices: BUNDLED_PRICE_LIST }).usd).toBeNull()
  })

  it('a usage calibration multiplies the estimate', () => {
    const r = req({ task: 'summary' })
    const base = estimateText(r, target(PRICED))
    const cal = estimateText(r, target(PRICED, { calibration: { input: 1.5, output: 0.5 } }))
    expect(Math.abs(cal.inputTokens[1] - base.inputTokens[1] * 1.5)).toBeLessThanOrEqual(1)
    // gpt-6.1-sol thinks: 300 + 500 at the high end, halved.
    expect(cal.outputTokens).toEqual([40, 400])
  })
})

const known = (low: number, high: number): CostEstimate => ({ requests: 1, words: 8200, pictures: 0, inputTokens: [1, 2], outputTokens: [1, 2], usd: [low, high], price: { entry: { input: 2, output: 10 }, updated: '2026-11-07' } })

describe("the line's words and the confirm (test 92)", () => {
  it("each part of §11.5's table", () => {
    expect(costPart(known(0.001, 0.009))).toBe('under US$0.01')
    expect(costPart(known(0.02, 0.035))).toBe('about US$0.03')
    expect(costPart(known(0.02, 0.05))).toBe('US$0.02 to US$0.05')
    expect(costPart({ ...known(0, 0), usd: null, unknown: 'no-price' })).toBe('cost unknown')
    expect(costPart(known(0, 0))).toBe('no cost')
    expect(costPart({ ...known(0, 0), seconds: [180, 240] })).toBe('about 4 minutes')
    expect(costPart({ ...known(0, 0), seconds: [20, 38] })).toBe('about 40 seconds')
    expect(aboutTime(60 * 60 * 2)).toBe('about 2 hours')
  })

  it('the line: what is sent and where once, then each action; the full form with the model and the date', () => {
    const group = costLineText(
      [
        { label: 'Fix', estimate: known(0.04, 0.06) },
        { label: 'Chapters', estimate: known(0.015, 0.025) },
        { label: 'Title', estimate: known(0.001, 0.005) }
      ],
      'OpenAI',
      'captions',
      'gpt-6.1-sol',
      false
    )
    expect(group).toBe('Sends about 8,200 words of captions to OpenAI · Fix about US$0.05 · Chapters about US$0.02 · Title under US$0.01')
    expect(costLineText([{ label: 'Translate', estimate: known(0.02, 0.035) }], 'OpenAI', 'captions', 'gpt-6.1-sol', true)).toBe(
      'Sends about 8,200 words of captions to OpenAI · About US$0.03 (gpt-6.1-sol, prices of 7 November 2026)'
    )
    expect(costLineText([{ label: 'Translate', estimate: { ...known(0, 0), usd: null, unknown: 'no-price' } }], 'api.groq.com', '', 'llama-4-scout', true)).toBe(
      'Sends about 8,200 words to api.groq.com · Cost unknown for llama-4-scout: add its prices in Settings'
    )
    expect(costLineText([{ label: 'Translate', estimate: known(0, 0) }], 'Ollama on this PC', '', 'llama3', true)).toBe('Sends about 8,200 words to Ollama on this PC · No cost')
    expect(costLineText([{ label: 'Translate', estimate: { ...known(0, 0), seconds: [200, 240] } }], 'this PC', 'captions', '', true)).toBe('Stays on this PC · About 4 minutes')
  })

  it("each button's own sentence", () => {
    expect(costSentence(known(0.015, 0.025), 'OpenAI', 'your captions')).toBe('About US$0.02; sends your captions to OpenAI.')
    expect(costSentence({ ...known(0, 0), seconds: [200, 240] }, 'this PC')).toBe('About 4 minutes; stays on this PC.')
  })

  it('asks above the amount set: US$1.40 at US$1 but not at US$5; US$0.05 at Always ask; nothing at Never', () => {
    const big = known(0.9, 1.4)
    const small = known(0.03, 0.05)
    expect(needsConfirm(big, '1', false)).toBe(true)
    expect(needsConfirm(big, '5', false)).toBe(false)
    expect(needsConfirm(small, 'always', false)).toBe(true)
    expect(needsConfirm(small, '0.1', false)).toBe(false)
    expect(needsConfirm(known(0.05, 0.11), '0.1', false)).toBe(true)
    for (const e of [big, small, { ...big, usd: null, unknown: 'no-price' as const }]) expect(needsConfirm(e, 'never', false)).toBe(false)
    expect(needsConfirm(known(0, 0), 'always', false)).toBe(false)
    expect(confirmText(big, 'claude-opus-5-5')).toEqual({ text: 'This costs up to about US$1.40 with claude-opus-5-5. Run it?', action: 'Run' })
  })

  it('on this PC, asks over 10 minutes', () => {
    const run = (s: number): CostEstimate => ({ ...known(0, 0), seconds: [s / 2, s] })
    expect(needsConfirm(run(CONFIRM_LOCAL_S + 1), '1', false)).toBe(true)
    expect(needsConfirm(run(CONFIRM_LOCAL_S), '1', false)).toBe(false)
    expect(confirmText(run(25 * 60), '').text).toBe('This takes about 25 minutes on this PC. You can keep editing meanwhile. Start?')
  })

  it('after a run: the cost of the tokens reported', () => {
    expect(usageText({ input: 10_000, output: 2_400 }, { entry: { input: 2, output: 10 } })).toBe('Cost about US$0.04 (12,400 tokens).')
    expect(usageText({ input: 100, output: 20 }, { entry: { input: 2, output: 10 } })).toBe('Cost under US$0.01 (120 tokens).')
    expect(usageText({ input: 100, output: 20 }, null)).toBe('It used 120 tokens.')
    expect(usageText(null, null)).toBe('')
  })
})

describe("OpenRouter's prices (test 133)", () => {
  const OR = (model: string): TextChoice => service('openrouter.ai', model)
  it('"-1" is unknown and never "under US$0.01"; "0"/"0" is no cost; a missing price unknown', () => {
    const r = req({ task: 'title' })
    const varies = estimateText(r, target(OR('openrouter/auto'), { live: readOpenRouterPrice({ pricing: { prompt: '-1', completion: '-1' } }) }))
    expect(varies).toMatchObject({ usd: null, unknown: 'varies' })
    expect(costLineText([{ label: 'Title', estimate: varies }], 'openrouter.ai', '', 'openrouter/auto', true)).toBe(
      'Sends about 440 words to openrouter.ai · Cost unknown for openrouter/auto: it picks a model for each request'
    )
    expect(costPart(varies)).not.toMatch(/under/)
    // A router model is "varies" even before the list was loaded.
    expect(estimateText(r, target(OR('openrouter/auto'))).unknown).toBe('varies')
    const free = estimateText(r, target(OR('meta/llama-free'), { live: readOpenRouterPrice({ pricing: { prompt: '0', completion: '0' } }) }))
    expect(free.usd).toEqual([0, 0])
    expect(costPart(free)).toBe('no cost')
    expect(estimateText(r, target(OR('meta/unlisted'))).unknown).toBe('no-price')
    const priced = estimateText(r, target(OR('openai/gpt-6.1-sol'), { live: { input: 2, output: 10 } }))
    expect(priced.usd![1]).toBeGreaterThan(0)
  })

  it('an unknown cost asks once per model in a session', () => {
    const e = estimateText(req({ task: 'title' }), target(OR('openrouter/auto')))
    expect(needsConfirm(e, '1', false)).toBe(true)
    expect(needsConfirm(e, '1', true)).toBe(false)
    expect(confirmText(e, 'openrouter/auto').text).toBe('Flown does not know what this costs with openrouter/auto. Run it?')
  })
})

describe('price list safety (test 134)', () => {
  const list = (models: unknown[], updated: string): PriceList => parsePriceList({ version: 1, updated, currency: 'USD', models }, '2026-11-20')!
  const bundled = list([{ service: 'openai', model: 'gpt-6.1-sol', input: 2, output: 10 }, { service: 'groq', model: 'openai/gpt-oss-20b', input: 0.075, output: 0.3 }], '2026-11-07')
  const r = req({ task: 'summary' })

  it('the confirm uses the higher of the bundled and downloaded prices; a downloaded 0 is ignored where the bundled list has one', () => {
    const lowered = list([{ service: 'openai', model: 'gpt-6.1-sol', input: 0, output: 1 }], '2026-11-19')
    const shown = newerList(bundled, lowered)
    expect(shown).toBe(lowered)
    const confirm = confirmList(bundled, lowered)
    expect(confirm.updated).toBe('2026-11-19')
    const e = estimateText(r, target(PRICED, { prices: shown, confirmPrices: confirm }))
    const safe = estimateText(r, target(PRICED))
    // The high end (what a confirm uses) never drops below the bundled prices'.
    expect(e.usd![1]).toBeCloseTo(safe.usd![1], 10)
    expect(e.usd![0]).toBeLessThan(safe.usd![0])
    const raised = confirmList(bundled, list([{ service: 'openai', model: 'gpt-6.1-sol', input: 4, output: 20 }], '2026-11-19'))
    expect(estimateText(r, target(PRICED, { confirmPrices: raised })).usd![1]).toBeCloseTo(safe.usd![1] * 2, 10)
    expect(needsConfirm(estimateText(r, target(PRICED, { prices: shown, confirmPrices: confirm })), '0.1', false)).toBe(needsConfirm(safe, '0.1', false))
  })

  it("a Groq preset whose host was edited is priced as Other address; Ollama on another port is not no cost", () => {
    expect(estimateText(r, target(service('api.groq.com', 'openai/gpt-oss-20b'), { prices: bundled, confirmPrices: bundled })).usd![1]).toBeGreaterThan(0)
    expect(estimateText(r, target(service('groq.example.com', 'openai/gpt-oss-20b'), { prices: bundled, confirmPrices: bundled })).unknown).toBe('no-price')
    expect(estimateText(r, target(service('localhost:11434', 'llama3', true))).usd).toEqual([0, 0])
    const moved = estimateText(r, target(service('localhost:11435', 'llama3', true)))
    expect(moved.usd).toBeNull()
    expect(costPart(moved)).toBe('cost unknown')
  })

  it("the user's own prices win over everything", () => {
    const own = estimateText(r, target(service('groq.example.com', 'm'), { own: { input: 1, output: 1 } }))
    expect(own.usd![0]).toBeGreaterThan(0)
    expect(costLineText([{ label: 'Summary', estimate: own }], 'groq.example.com', '', 'm', true)).toMatch(/\(m, your prices\)$/)
  })
})

describe('on this PC: time, never money', () => {
  it('estimates seconds from the speeds measured, else the defaults', () => {
    const r = req({ task: 'summary' })
    const e = estimateText(r, target(LOCAL, { speed: { read: 400, write: 10 } }))
    expect(e.seconds![1]).toBeGreaterThan(e.seconds![0])
    expect(e.seconds![1]).toBeCloseTo(8 + e.inputTokens[1] / 400 + e.outputTokens[1] / 10, 6)
    expect(estimateText(r, target(LOCAL)).seconds![1]).toBeGreaterThan(e.seconds![1])
    expect(costPart(e)).toMatch(/^about \d+ (seconds|minutes?)$/)
  })
})

describe('performance (test 100)', () => {
  it('estimates 20,000 captions in under 20 ms (× 6 on CI), and remembers the request', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => seg(i, `Caption ${i}: now we open the settings and change the export folder.`))
    const run = (r: AiTextRequest): number => {
      const t0 = performance.now()
      estimateText(r, target(PRICED))
      return performance.now() - t0
    }
    // Warm the code paths once on another request (as the app has by the time the line shows).
    run({ task: 'summary', segments: many.slice(0, 100) })
    const first = run({ task: 'summary', segments: many })
    expect(first).toBeLessThan(20 * 6)
    const r: AiTextRequest = { task: 'cleanup', segments: many }
    const cold = run(r)
    expect(cold).toBeLessThan(20 * 6)
    const warm = run(r)
    expect(warm).toBeLessThan(Math.max(2, cold / 5))
  })
})
