/**
 * Requests and schemas of every text task, for the tests of AI on this PC's grammar
 * (tests/localGrammar.test.ts, tests/llmHelper.test.ts).
 */
import { AI_TEXT_TASKS, type AiTextRequest } from '../src/shared/api/ai'
import { textPrompts } from '../src/shared/captions/transcriptText'
import { SCRIPT_SCHEMA } from '../src/shared/notes/scriptDraft'

const seg = { id: 's1', start: 0, end: 2, text: 'Click Export.' }
/** One request of every task, as the text tools send them. */
export function everyTaskRequest(): AiTextRequest[] {
  return AI_TEXT_TASKS.map((task) =>
    task === 'names'
      ? { task, segments: [], names: { kind: 'step', items: [{ id: 'a', text: 'Click Export', action: 'click' }] } }
      : task === 'translate'
        ? { task, segments: [seg], targetLanguage: 'Bangla' }
        : { task, segments: [seg] }
  ) as AiTextRequest[]
}

/** Every schema a text task or Draft script sends. */
export function everySchema(): { name: string; schema: Record<string, unknown> }[] {
  const out = new Map<string, Record<string, unknown>>()
  for (const r of everyTaskRequest()) for (const p of textPrompts(r)) out.set(p.name, p.schema)
  out.set('spoken_script', SCRIPT_SCHEMA as unknown as Record<string, unknown>)
  return [...out].map(([name, schema]) => ({ name, schema }))
}
