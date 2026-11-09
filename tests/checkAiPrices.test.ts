import { describe, expect, it } from 'vitest'
// @ts-expect-error A plain ES module script, without types.
import { comparePrices, describe as describeDiffs, litellmKey } from '../scripts/check-ai-prices.mjs'

/*
 * The price list is kept up to date by hand, checked against LiteLLM's price file (docs/design/
 * smart-tools.md §11.4): the script prints each price that differs and each model LiteLLM does not know.
 */

type Diff = { service: string; model: string; field?: string; ours?: number; theirs?: number; missing?: true }
const compare = comparePrices as (list: unknown, litellm: unknown, tolerance?: number) => Diff[]

describe('scripts/check-ai-prices.mjs', () => {
  it("names each service's models as LiteLLM does", () => {
    expect(litellmKey('openai', 'gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(litellmKey('gemini', 'gemini-3.8-flash')).toBe('gemini/gemini-3.8-flash')
    expect(litellmKey('groq', 'openai/gpt-oss-20b')).toBe('groq/openai/gpt-oss-20b')
    expect(litellmKey('nowhere', 'm')).toBeNull()
  })

  it('prints the prices that differ past the tolerance, and the models LiteLLM does not know', () => {
    const list = {
      version: 1,
      updated: '2026-11-07',
      currency: 'USD',
      models: [
        { service: 'openai', model: 'gpt-6.1-sol', input: 2, output: 10 },
        { service: 'openai', model: 'whisper-1', perMinute: 0.006 },
        { service: 'groq', model: 'openai/gpt-oss-20b', input: 0.075, output: 0.3 },
        { service: 'openai', model: 'gpt-6', prefix: true, input: 1, output: 1 },
        { service: 'anthropic', model: 'claude-new', input: 1, output: 5 }
      ]
    }
    const litellm = {
      'gpt-6.1-sol': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000012 },
      'whisper-1': { input_cost_per_second: 0.0001 },
      'groq/openai/gpt-oss-20b': { input_cost_per_token: 0.0000000752, output_cost_per_token: 0.0000003 }
    }
    const diffs = compare(list, litellm)
    expect(diffs).toEqual([
      { service: 'openai', model: 'gpt-6.1-sol', field: 'output', ours: 10, theirs: 12 },
      { service: 'anthropic', model: 'claude-new', missing: true }
    ])
    expect((describeDiffs as (d: Diff[]) => string[])(diffs)).toEqual(['openai gpt-6.1-sol output: ours 10, LiteLLM 12', "anthropic claude-new: not in LiteLLM's file"])
  })
})
