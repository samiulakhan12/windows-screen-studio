/**
 * The protocol of the bundled helper ssw-llm (docs/design/smart-tools.md §9.1): JSON lines on its
 * stdin (`load`, `run`, `cancel`) and stdout (`loaded`, `read`, `write`, `done`, `cancelled`,
 * `error`). native/llm implements the other side. Every stdout line is untrusted input: capped,
 * parsed and checked field by field; a line that is not one of these events ends the job.
 */
import type { ChatPart } from './chatFormat'

export const LLM_PROTOCOL = {
  /** Longest stdout line read, bytes. */
  lineMax: 4 << 20,
  /** Longest answer (`done.text`), bytes of UTF-8. */
  textMax: 256 * 1024,
  /** Sampling (§9.6): the same input gives the same draft. */
  temperature: 0.2,
  topP: 0.9,
  seed: 1
} as const

export type HelperErrorCode = 'context' | 'model' | 'memory' | 'internal'

export type HelperEvent =
  | { ev: 'loaded'; ms: number; ctxTrain: number }
  | { ev: 'read'; id: string; done: number; total: number }
  | { ev: 'write'; id: string; tokens: number }
  | { ev: 'done'; id: string; text: string; prompt: number; output: number; readMs: number; writeMs: number }
  | { ev: 'cancelled'; id: string }
  | { ev: 'error'; id?: string; code: HelperErrorCode; message: string }

const ID = /^[A-Za-z0-9_-]{1,64}$/
const CODES: readonly HelperErrorCode[] = ['context', 'model', 'memory', 'internal']
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e12
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length

/**
 * One stdout line as an event, or null: a line over 4 MB, bad JSON, not an object, an unknown
 * `ev`, a missing or wrong field, or a `done` whose text is over 256 KB. Fields other than the
 * event's own are dropped.
 */
export function readHelperLine(line: string): HelperEvent | null {
  if (typeof line !== 'string' || line.length > LLM_PROTOCOL.lineMax || utf8Bytes(line) > LLM_PROTOCOL.lineMax) return null
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(v)) return null
  switch (v.ev) {
    case 'loaded':
      return count(v.ms) && count(v.ctxTrain) ? { ev: 'loaded', ms: v.ms, ctxTrain: v.ctxTrain } : null
    case 'read':
      return isId(v.id) && count(v.done) && count(v.total) && v.done <= v.total ? { ev: 'read', id: v.id, done: v.done, total: v.total } : null
    case 'write':
      return isId(v.id) && count(v.tokens) ? { ev: 'write', id: v.id, tokens: v.tokens } : null
    case 'done':
      if (!isId(v.id) || typeof v.text !== 'string' || !count(v.prompt) || !count(v.output) || !count(v.readMs) || !count(v.writeMs)) return null
      if (utf8Bytes(v.text) > LLM_PROTOCOL.textMax) return null
      return { ev: 'done', id: v.id, text: v.text, prompt: v.prompt, output: v.output, readMs: v.readMs, writeMs: v.writeMs }
    case 'cancelled':
      return isId(v.id) ? { ev: 'cancelled', id: v.id } : null
    case 'error': {
      if (!CODES.includes(v.code as HelperErrorCode) || typeof v.message !== 'string') return null
      if (v.id !== undefined && !isId(v.id)) return null
      const message = v.message.slice(0, 500)
      return v.id === undefined ? { ev: 'error', code: v.code as HelperErrorCode, message } : { ev: 'error', id: v.id as string, code: v.code as HelperErrorCode, message }
    }
    default:
      return null
  }
}

/** The `load` line (§9.1): `mmap` off, which saved 0.77 GB on CPUs. */
export function loadLine(model: string, ctx: number, threads: number): string {
  return JSON.stringify({ op: 'load', model, ctx, threads, mmap: false })
}

/** The `run` line of one request, with Flown's fixed sampling. */
export function runLine(id: string, parts: readonly ChatPart[], grammar: string, maxTokens: number): string {
  if (!ID.test(id)) throw new Error('Invalid request id.')
  return JSON.stringify({
    op: 'run',
    id,
    parts: parts.map((p) => ({ t: p.t, special: p.special })),
    grammar,
    maxTokens,
    temperature: LLM_PROTOCOL.temperature,
    topP: LLM_PROTOCOL.topP,
    seed: LLM_PROTOCOL.seed
  })
}

/** The `cancel` line. */
export function cancelLine(id: string): string {
  return JSON.stringify({ op: 'cancel', id })
}
