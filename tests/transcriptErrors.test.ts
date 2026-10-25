import { describe, expect, it } from 'vitest'
import { describeFailure, retryDelay } from '../src/shared/captions/transcriptErrors'

describe('describeFailure', () => {
  const kind = (info: Parameters<typeof describeFailure>[0]): string => describeFailure(info, 'OpenAI', 'whisper-1').kind

  it('tells key, quota, rate limit, model and server problems apart', () => {
    expect(kind({ status: 401, message: 'Incorrect API key provided: sk-ab***yz' })).toBe('auth')
    // Gemini answers a bad key with 400 INVALID_ARGUMENT / API_KEY_INVALID.
    expect(kind({ status: 400, code: 'INVALID_ARGUMENT API_KEY_INVALID', message: 'API key not valid. Please pass a valid API key.' })).toBe('auth')
    expect(kind({ status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' })).toBe('quota')
    expect(kind({ status: 400, code: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' })).toBe('quota')
    expect(kind({ status: 402, code: 'billing_error' })).toBe('quota')
    expect(kind({ status: 429, code: 'rate_limit_exceeded' })).toBe('rate-limit')
    expect(kind({ status: 403 })).toBe('auth')
    expect(kind({ status: 404 })).toBe('not-found')
    expect(kind({ status: 413 })).toBe('too-large')
    expect(kind({ status: 529, code: 'overloaded_error' })).toBe('server')
    expect(kind({ status: 500 })).toBe('server')
    expect(kind({ network: true })).toBe('network')
    expect(kind({ timeout: true })).toBe('timeout')
    expect(kind({ cancelled: true })).toBe('cancelled')
    expect(kind({ message: 'weird' })).toBe('other')
  })

  it('retries only what may pass on a second try', () => {
    const retry = (info: Parameters<typeof describeFailure>[0]): boolean => describeFailure(info, 'X').retryable
    expect([retry({ status: 429 }), retry({ status: 503 }), retry({ network: true }), retry({ timeout: true })]).toEqual([true, true, true, true])
    expect([retry({ status: 401 }), retry({ status: 400 }), retry({ status: 429, code: 'insufficient_quota' }), retry({ cancelled: true })]).toEqual([false, false, false, false])
  })

  it("retries Gemini's per-minute limit, worded like running out of quota, and not its per-day one", () => {
    const message = 'You exceeded your current quota, please check your plan and billing details.'
    const minute = describeFailure({ status: 429, code: 'RESOURCE_EXHAUSTED GenerateRequestsPerMinutePerProjectPerModel-FreeTier', message, retryAfter: 17 }, 'Google Gemini')
    expect(minute).toMatchObject({ kind: 'rate-limit', retryable: true, retryAfter: 17 })
    const day = describeFailure({ status: 429, code: 'RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier', message, retryAfter: 17 }, 'Google Gemini')
    expect(day).toMatchObject({ kind: 'quota', retryable: false })
  })

  it('never repeats the provider message for key problems, and names the model', () => {
    const f = describeFailure({ status: 401, message: 'Incorrect API key provided: sk-proj-abcdef' }, 'OpenAI')
    expect(f.message).not.toContain('sk-')
    expect(f.message).toMatch(/did not accept the API key/)
    expect(describeFailure({ status: 404 }, 'Google Gemini', 'gemini-x').message).toContain('“gemini-x”')
    expect(describeFailure({ status: 400, message: 'a'.repeat(500) }, 'X').message.length).toBeLessThan(260)
  })
})

describe('retryDelay', () => {
  it("uses the provider's retry-after (capped), else doubles with jitter", () => {
    expect(retryDelay(1, 3)).toBe(3000)
    expect(retryDelay(1, 600)).toBe(30000)
    expect(retryDelay(1, undefined, () => 0.5)).toBe(1000)
    expect(retryDelay(3, undefined, () => 0.5)).toBe(4000)
    expect(retryDelay(10, undefined, () => 0.5)).toBe(16000)
    expect(retryDelay(2, undefined, () => 0)).toBe(1500)
  })
})
