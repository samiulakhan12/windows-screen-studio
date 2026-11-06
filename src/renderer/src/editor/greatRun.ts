/**
 * Runs Make my captions great (docs/design/captions-studio.md §11.8): gathers the slow input first
 * (the AI marks, cancellable), plans a step at a time with the editor free between the steps
 * (§9.8; Cancel still changes nothing), then one sealed update of the plan: one undo step.
 *
 * Also the inputs Make my captions great, Polish's Caption look and the first captions share: the
 * saved options (prefs captionsGreat, captionCleanup, captionWordList) and the brand kit's look.
 */
import type { AiProviderInfo, AiTextRequest, MarksAnswer } from '../../../shared/api/ai'
import { textHash } from '../../../shared/captions/captionTracks'
import { readCleanupChoices, readWordList, tidyCaptions, type CleanupChoices, type WordListEntry } from '../../../shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS, greatNotice, planCaptionsGreat, planCaptionsGreatSteps, readGreatOptions, type GreatInput, type GreatOptions, type GreatSummary } from '../../../shared/captions/great'
import { readCaptionStudio } from '../../../shared/captions/studioData'
import type { BrandKit } from '../../../shared/editor/brandKit'
import type { EditStore } from '../../../shared/editor/editStore'
import type { CaptionStudio, Project } from '../../../shared/types'

/** The saved choices the caption automation uses. */
export interface GreatInputs {
  great: GreatOptions
  cleanup: CleanupChoices
  words: readonly WordListEntry[]
  brand: CaptionStudio | null
}

/** A pref, or null when it cannot be read (automation then uses the defaults). */
async function pref(key: 'captionsGreat' | 'captionCleanup' | 'captionWordList'): Promise<unknown> {
  try {
    return await window.api.getPref(key)
  } catch {
    return null
  }
}

/**
 * The brand kit's caption style, or null: the look of its `captionStyle` ({ name, look }, §4.6);
 * a kit without one, or one that cannot be read, gives null.
 */
export async function loadBrandLook(): Promise<CaptionStudio | null> {
  try {
    const kit: BrandKit | null = await window.api.getBrandKit()
    return readCaptionStudio(kit?.captionStyle?.look) ?? null
  } catch {
    return null
  }
}

/* ---------- the saved options (prefs captionsGreat, §2.8) ---------- */

let greatOptions: GreatOptions = { ...DEFAULT_GREAT_OPTIONS }
let greatRead: Promise<GreatOptions> | null = null
const greatListeners = new Set<() => void>()

const setGreatOptions = (next: GreatOptions): void => {
  greatOptions = next
  for (const l of [...greatListeners]) l()
}

/** The saved options, read from the prefs once, or again when `fresh` (other places save them too); the defaults when they cannot be read. */
export function loadGreatOptions(fresh = false): Promise<GreatOptions> {
  if (fresh) greatRead = null
  greatRead ??= (async () => {
    const raw = await pref('captionsGreat')
    if (raw === null) greatRead = null
    else setGreatOptions(readGreatOptions(raw))
    return greatOptions
  })()
  return greatRead
}

/** The options as last read or saved (the button's hint and the run use them). */
export const currentGreatOptions = (): GreatOptions => greatOptions

export function onGreatOptions(listener: () => void): () => void {
  greatListeners.add(listener)
  return () => greatListeners.delete(listener)
}

/** Saves the options (read back through readGreatOptions): used at once, kept in the prefs. */
export async function saveGreatOptions(next: GreatOptions): Promise<void> {
  const o = readGreatOptions(next)
  greatRead = Promise.resolve(o)
  setGreatOptions(o)
  await window.api.setPref('captionsGreat', o)
}

/** The saved options, Clean up choices, word list and brand look, read once per run. */
export async function loadGreatInputs(): Promise<GreatInputs> {
  const [great, cleanup, words, brand] = await Promise.all([pref('captionsGreat'), pref('captionCleanup'), pref('captionWordList'), loadBrandLook()])
  return { great: readGreatOptions(great), cleanup: readCleanupChoices(cleanup), words: readWordList(words), brand }
}

/** Numbers the marks requests, so each has its own request id. */
let marksSeq = 0

/**
 * The AI marks for the project's captions from `provider`, with a hash of each caption's text as it
 * was when asked. The provider reads the captions as the planner's tidy step leaves them
 * ("twenty five" as "25"), so its word indexes name the words the planner picks from. The request
 * is named, so Cancel (`signal`) stops the provider's own request too (cancelAiText).
 */
async function requestMarks(project: Project, provider: string, tidy: { cleanup: CleanupChoices; words: readonly WordListEntry[] } | null, signal: AbortSignal): Promise<{ answer: MarksAnswer; sent: Map<string, string> }> {
  const own = project.transcript?.segments ?? []
  const segments = tidy ? (tidyCaptions(project, { ...tidy.cleanup, ai: false, bleep: 'off', words: tidy.words }).project.transcript?.segments ?? own) : own
  const language = project.transcript?.language
  const request: AiTextRequest = { task: 'marks', segments, marks: { ...(language ? { language } : {}), captions: [] } }
  const sent = new Map(own.map((s) => [s.id, textHash(s.text)]))
  const id = `captions-great-${++marksSeq}`
  const stop = (): void => void window.api.cancelAiText(id).catch(() => undefined)
  signal.addEventListener('abort', stop)
  try {
    const result = await window.api.aiText(provider, request, id)
    if (result.task !== 'marks') throw new Error('The AI provider answered another task.')
    return { answer: result.answer, sent }
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** The answer without captions whose text changed while it was asked (a hash of the text is compared). */
function stillValid(answer: MarksAnswer, sent: ReadonlyMap<string, string>, project: Project): MarksAnswer {
  const now = new Map((project.transcript?.segments ?? []).map((s) => [s.id, textHash(s.text)]))
  const same = (id: string): boolean => sent.get(id) !== undefined && sent.get(id) === now.get(id)
  return {
    captions: answer.captions.filter((c) => same(c.id)),
    numbers: answer.numbers.filter((n) => same(n.id)),
    lists: answer.lists.filter((l) => same(l.id) && l.items.every((i) => same(i.id))),
    quotes: answer.quotes.filter((q) => same(q.id))
  }
}

/** The provider's kind (the automatic items' `auto.via`), or undefined. */
async function providerKind(id: string): Promise<AiProviderInfo['kind'] | undefined> {
  try {
    return (await window.api.listAiProviders()).find((p) => p.id === id)?.kind
  } catch {
    return undefined
  }
}

/**
 * A planner's steps run with a moment between them, so the editor draws, plays and takes Cancel
 * while a long project is planned (§9.8): the result, or null when `signal` is aborted meanwhile.
 */
export async function planInSteps<T>(steps: Generator<void, T, void>, signal: AbortSignal): Promise<T | null> {
  for (let r = steps.next(); ; r = steps.next()) {
    if (r.done) return r.value
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (signal.aborted) return null
  }
}

const NOTHING: Omit<GreatSummary, 'providerFailed'> = { style: null, emphasised: 0, emoji: 0, counters: 0, lists: 0, keywords: 0, lowerThirds: 0, chapters: 0, quotes: 0, tidied: 0, bleeped: 0 }

export async function runCaptionsGreat(deps: { store: EditStore<Project>; frame: { w: number; h: number }; options: GreatOptions; signal: AbortSignal; undo?: string }): Promise<{ notice: string } | null> {
  const { store, frame, options, signal } = deps
  const start = store.getSnapshot()
  if (!start.transcript?.segments.length) return null
  const inputs = await loadGreatInputs()
  if (signal.aborted) return null
  let asked: { answer: MarksAnswer; sent: Map<string, string> } | undefined
  let marksVia: AiProviderInfo['kind'] | undefined
  let providerFailed = false
  if (options.provider) {
    try {
      const [answer, kind] = await Promise.all([requestMarks(start, options.provider, options.tidy ? inputs : null, signal), providerKind(options.provider)])
      if (signal.aborted) return null
      asked = answer
      marksVia = kind
    } catch {
      if (signal.aborted) return null
      // The offline picks are used, and the notice says so (§2.8).
      providerFailed = true
    }
  }
  if (signal.aborted) return null
  /** The planner's input for `project`: the AI's marks of captions not edited since they were asked. */
  const input = (project: Project): GreatInput => {
    const marks = asked ? stillValid(asked.answer, asked.sent, project) : undefined
    return { project, frame, brand: inputs.brand, cleanup: inputs.cleanup, words: inputs.words, by: 'great', ...(marks ? { marks } : {}), ...(marksVia ? { marksVia } : {}) }
  }
  // Planned from the project as it is now, a step at a time (§9.8).
  const from = store.getSnapshot()
  const planned = await planInSteps(planCaptionsGreatSteps(input(from), options), signal)
  if (!planned) return null
  let summary: GreatSummary | null = null
  let changed = false
  // One undo step (polish-in-one-click decision 3); planned again at once from an edit made meanwhile.
  store.seal()
  store.update((p) => {
    const out = p === from ? planned : planCaptionsGreat(input(p), options)
    summary = out.summary
    changed = out.project !== p
    return out.project
  })
  store.seal()
  if (!summary) return null
  const failed = providerFailed ? { providerFailed: true as const } : {}
  return { notice: greatNotice(changed ? { ...(summary as GreatSummary), ...failed } : { ...NOTHING, ...failed }, deps.undo) }
}
