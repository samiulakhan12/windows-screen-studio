/**
 * AI on this PC as an AiClient (docs/design/smart-tools.md §9.6): each json(prompt) is one helper
 * request with the model a run uses now (Use, §9.3), the chat in the model's own format with the
 * user's text unable to make control tokens (chatFormat.ts), the answer forced into the task's
 * schema by a grammar (grammar.ts) and the room of §9.6 (budget.ts). The shared text tasks run on
 * it with the same prompts and validators as the services, in smaller pieces (limits). Progress
 * goes to the page that asked, by its request id, at most every 250 ms; a request expected to take
 * more than 10 s is a long job of the kind 'ai' (taskbar progress, Stop on the thumbnail, the PC
 * kept awake). An answer cut off at its room is tried once more with 1.5 times the room.
 */
import type { WebContents } from 'electron'
import { LOCAL_AI_CHANNELS, type LocalAiProgress } from '../../shared/api/localAi'
import type { AiTextRequest, AiTextTask, NamesRequest } from '../../shared/api/ai'
import { AiOutputError, NAME_CAPS, type TextLimits, type TextPrompt } from '../../shared/captions/transcriptText'
import { fitsContext, LOCAL_BUDGET, LOCAL_TRANSCRIPT_TOKENS, localLimits, localTokens, maxTokensFor, promptTokens, RETRY_ROOM, SCRIPT_MAX_TOKENS } from '../../shared/localAi/budget'
import { chatParts } from '../../shared/localAi/chatFormat'
import { MIN_ITEMS, schemaGrammar, STRING_BOUND_MAX } from '../../shared/localAi/grammar'
import { LOCAL_MESSAGES, localRunProblem } from '../../shared/localAi/messages'
import type { LocalModelSpec } from '../../shared/localAi/catalog'
import { SCRIPT_SCHEMA_NAME, SCRIPT_USER_START } from '../../shared/notes/scriptDraft'
import type { AiClient, TextEffort } from '../ai/types'
import { beginJob } from '../longJobs'
import { LlmEngine, llmHelperPath, type LlmAnswer } from './engine'
import { localModels } from './models'

/** A request expected to take longer than this is a long job (§9.2). */
export const LONG_JOB_S = 10
/** Progress to the page at most this often (§9.2). */
export const PROGRESS_EVERY_MS = 250

/** The text task of a prompt, by its schema's name (the prompts are the shared tasks' own). */
const TASK_OF: Readonly<Record<string, AiTextTask>> = {
  cleaned_captions: 'cleanup',
  translated_captions: 'translate',
  chapters: 'chapters',
  title: 'title',
  summary: 'summary',
  caption_marks: 'marks',
  names: 'names',
  youtube_description: 'youtube',
  linkedin_post: 'linkedin',
  x_post: 'xpost',
  help_article: 'article',
  release_notes: 'releaseNotes'
}

/** The tasks AI on this PC never runs (§9.7, decision 18): aiIpc refuses them first; this is the second guard. */
const NEVER_HERE: readonly AiTextTask[] = ['chapters', 'marks']

let engine: LlmEngine | null = null

/** The helper process of the app (one, §9.2); null in a build without the helper. */
export function localEngine(): LlmEngine | null {
  if (engine) return engine
  const helper = llmHelperPath()
  if (!helper) return null
  engine = new LlmEngine({ helper, dir: localModels().dir })
  return engine
}

/** The helper process if one was made (nothing is started). */
export function currentEngine(): LlmEngine | null {
  return engine
}

/** Tests: the engine to use instead (a fake helper's). */
export function setLocalEngine(next: LlmEngine | null): void {
  engine = next
}

/** The grammar caps of `prompt`: names, titles and chapter names bounded (§9.6); the names and chapters lists need one item. */
function grammarCaps(task: AiTextTask, kind: NamesRequest['kind'] | undefined): { string?: number; minItems: Readonly<Record<string, number>> } {
  if (task === 'names' && kind) {
    const cap = NAME_CAPS[kind]
    return cap <= STRING_BOUND_MAX ? { string: cap, minItems: MIN_ITEMS } : { minItems: MIN_ITEMS }
  }
  return { minItems: MIN_ITEMS }
}

/**
 * The client for one action of the page `ctx.sender` (aiIpc's aiText and draftScript): the model a
 * run uses now, checked, or a rejection with §9.5's or §9.9's message.
 */
export async function localTextClient(ctx: { sender: WebContents; requestId?: string }): Promise<AiClient & { limits(request: AiTextRequest): TextLimits }> {
  const store = localModels()
  const state = await store.state()
  const ready = state.models.filter((m) => m.state === 'ready').map((m) => m.id)
  const run = localRunProblem(state.use, ready, state.pc)
  if ('message' in run) throw new Error(run.message)
  const spec = store.specWithSpeeds(run.id)
  if (!spec) throw new Error(LOCAL_MESSAGES.damaged)
  await store.modelFile(run.id)
  const eng = localEngine()
  if (!eng) throw new Error(LOCAL_MESSAGES.notInBuild)
  return makeLocalClient({ engine: eng, spec, sender: ctx.sender, requestId: ctx.requestId, onSpeeds: (r, w) => store.blendSpeed(spec.id, r, w) })
}

/** The client itself (exported for tests: a fake engine and page). */
export function makeLocalClient(deps: {
  engine: Pick<LlmEngine, 'run' | 'loadedModel'>
  spec: LocalModelSpec
  sender: Pick<WebContents, 'send' | 'isDestroyed'>
  requestId?: string
  onSpeeds?: (readTps: number, writeTps: number) => void
  beginJob?: typeof beginJob
}): AiClient & { limits(request: AiTextRequest): TextLimits } {
  const { spec } = deps
  const family = spec.family
  let kind: NamesRequest['kind'] | undefined

  /** Progress to the page, by request id, at most every 250 ms (a new phase at once). */
  let lastSent = 0
  let lastPhase = ''
  const progress = (p: LocalAiProgress): void => {
    const now = Date.now()
    if (p.phase === lastPhase && now - lastSent < PROGRESS_EVERY_MS) return
    lastSent = now
    lastPhase = p.phase
    if (!deps.sender.isDestroyed()) deps.sender.send(LOCAL_AI_CHANNELS.progress, { ...p, ...(deps.requestId ? { requestId: deps.requestId } : {}) })
  }

  /** One helper request, as a long job when it is expected to take more than 10 s. */
  const ask = async (prompt: TextPrompt, task: AiTextTask | 'script', maxTokens: number, signal: AbortSignal): Promise<LlmAnswer> => {
    const caps = task === 'script' ? { minItems: {} } : grammarCaps(task, kind)
    const grammar = schemaGrammar(prompt.schema, caps)
    const parts = chatParts(family, prompt.system, prompt.user)
    const loaded = deps.engine.loadedModel?.endsWith(spec.file) ?? false
    const expected = (loaded ? 0 : spec.loadS) + promptTokens(prompt, family) / Math.max(1, spec.read) + maxTokens / Math.max(0.1, spec.write)
    const local = new AbortController()
    const stop = (): void => local.abort()
    if (signal.aborted) stop()
    signal.addEventListener('abort', stop, { once: true })
    const job = expected > LONG_JOB_S ? (deps.beginJob ?? beginJob)({ kind: 'ai', onStop: stop }) : null
    try {
      const answer = await deps.engine.run({
        spec,
        parts,
        grammar,
        maxTokens,
        signal: local.signal,
        onProgress: (p) => {
          progress(p)
          if (job) job.update({ fraction: p.total > 0 ? p.done / p.total : null })
        }
      })
      void job?.end({ kind: 'done' })
      if (answer.readMs > 0 && answer.writeMs > 0 && answer.prompt >= 64 && answer.output >= 16) {
        deps.onSpeeds?.((answer.prompt * 1000) / answer.readMs, (answer.output * 1000) / answer.writeMs)
      }
      return answer
    } catch (err) {
      void job?.end(local.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }

  return {
    model: spec.id,
    test: async () => `${spec.title} · ${spec.name}`,
    limits(request: AiTextRequest): TextLimits {
      kind = request.names?.kind
      return localLimits(request.names?.language ?? request.marks?.language, family)
    },
    async json(prompt: TextPrompt, opts: { signal: AbortSignal; effort: TextEffort }): Promise<unknown> {
      const script = prompt.name === SCRIPT_SCHEMA_NAME
      const task: AiTextTask | 'script' = script ? 'script' : TASK_OF[prompt.name]
      if (!task) throw new Error(LOCAL_MESSAGES.crashed)
      if (task !== 'script' && NEVER_HERE.includes(task)) throw new Error('Not available on this PC: choose an AI service for this.')
      if (prompt.images?.length) throw new Error('AI on this PC does not read pictures.')
      let room: number
      if (task === 'script') {
        // Draft script: the notes within 4,500 prompt tokens, else they are too long for this PC (§9.6).
        const notes = prompt.user.startsWith(SCRIPT_USER_START) ? prompt.user.slice(SCRIPT_USER_START.length) : prompt.user
        if (localTokens(notes, family) > LOCAL_TRANSCRIPT_TOKENS) throw new Error(LOCAL_MESSAGES.notesTooLong)
        room = SCRIPT_MAX_TOKENS
      } else room = maxTokensFor(prompt, task, family, kind)
      if (!fitsContext(prompt, Math.min(room, 16), family)) throw new Error(task === 'script' ? LOCAL_MESSAGES.notesTooLong : LOCAL_MESSAGES.tooLong)
      room = Math.min(room, LOCAL_BUDGET - promptTokens(prompt, family))
      let answer = await ask(prompt, task, room, opts.signal)
      if (cutOff(answer, room)) {
        // Cut off at its room: once more with 1.5 times the room (§9.6), within the context.
        const more = Math.min(Math.ceil(room * RETRY_ROOM), LOCAL_BUDGET - promptTokens(prompt, family))
        if (more > room) {
          room = more
          answer = await ask(prompt, task, room, opts.signal)
        }
      }
      try {
        return JSON.parse(answer.text) as unknown
      } catch {
        throw new AiOutputError(cutOff(answer, room) ? 'it was cut off' : 'it was not JSON')
      }
    }
  }
}

/** Whether `answer` stopped at its room with JSON that does not parse. */
function cutOff(answer: LlmAnswer, room: number): boolean {
  if (answer.output < room) return false
  try {
    JSON.parse(answer.text)
    return false
  } catch {
    return true
  }
}
