#!/usr/bin/env node
/**
 * Prints where Flown's price list (resources/ai-prices.json, docs/design/smart-tools.md §11.4) differs
 * from LiteLLM's price file (MIT, credited in the notices), to keep the list up to date by hand from
 * each provider's own price page before each release. It changes nothing: it reads the two lists and
 * prints each price that differs by more than the tolerance, and each model LiteLLM does not know.
 *
 *   node scripts/check-ai-prices.mjs [--litellm <file>] [--tolerance 0.01]
 *
 * Without --litellm it reads LiteLLM's file from GitHub (redirects refused, 30 MB at most). The
 * exit status is 1 when Flown's own list is malformed, else 0.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const MAX_BYTES = 30 * 1024 * 1024

/** How LiteLLM names a service's models. */
const PREFIX = { openai: '', anthropic: '', gemini: 'gemini/', groq: 'groq/', together: 'together_ai/', openrouter: 'openrouter/', azure: 'azure/' }

/** LiteLLM's key of `model` of `service`, or null for a service it does not list. */
export function litellmKey(service, model) {
  return Object.prototype.hasOwnProperty.call(PREFIX, service) ? `${PREFIX[service]}${model}` : null
}

const perMillion = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6 * 1e6) / 1e6 : undefined)
const perMinute = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 60 * 1e6) / 1e6 : undefined)

/**
 * The differences between `list` (Flown's price list) and `litellm` (LiteLLM's file, parsed): each
 * `{ service, model, field, ours, theirs }` past `tolerance` (a share: 0.01 is 1%), and each entry
 * LiteLLM does not know as `{ service, model, missing: true }`. Prefix entries are not compared.
 */
export function comparePrices(list, litellm, tolerance = 0.01) {
  const out = []
  for (const e of list.models ?? []) {
    if (e.prefix) continue
    const key = litellmKey(e.service, e.model)
    const theirs = key ? litellm[key] : undefined
    if (!theirs || typeof theirs !== 'object') {
      out.push({ service: e.service, model: e.model, missing: true })
      continue
    }
    const fields = {
      input: perMillion(theirs.input_cost_per_token),
      output: perMillion(theirs.output_cost_per_token),
      perMinute: perMinute(theirs.input_cost_per_second) ?? (typeof theirs.input_cost_per_audio_per_second === 'number' ? perMinute(theirs.input_cost_per_audio_per_second) : undefined)
    }
    for (const field of ['input', 'output', 'perMinute']) {
      const ours = e[field]
      const other = fields[field]
      if (ours === undefined || other === undefined) continue
      const scale = Math.max(Math.abs(ours), Math.abs(other), 1e-12)
      if (Math.abs(ours - other) / scale > tolerance) out.push({ service: e.service, model: e.model, field, ours, theirs: other })
    }
  }
  return out
}

/** A line for each difference. */
export function describe(diffs) {
  return diffs.map((d) => (d.missing ? `${d.service} ${d.model}: not in LiteLLM's file` : `${d.service} ${d.model} ${d.field}: ours ${d.ours}, LiteLLM ${d.theirs}`))
}

async function readLitellm(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const res = await fetch(LITELLM_URL, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error('LiteLLM’s file is too large')
  return JSON.parse(text)
}

async function main(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let list
  try {
    list = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'ai-prices.json'), 'utf8'))
    if (list.version !== 1 || list.currency !== 'USD' || !Array.isArray(list.models)) throw new Error('not a price list')
  } catch (err) {
    console.error(`resources/ai-prices.json: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }
  const litellm = await readLitellm(at('--litellm'))
  const tolerance = Number(at('--tolerance') ?? 0.01)
  const lines = describe(comparePrices(list, litellm, Number.isFinite(tolerance) ? tolerance : 0.01))
  console.log(lines.length ? lines.join('\n') : `No differences (prices of ${list.updated}).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
