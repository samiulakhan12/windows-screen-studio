/**
 * Runs Make my captions great (docs/design/captions-studio.md §11.8): gathers the slow input first
 * (the AI marks, cancellable), then one sealed update of the planner: one undo step.
 *
 * Also the inputs Make my captions great, Polish's Caption look and the first captions share: the
 * saved options (prefs captionsGreat, captionCleanup, captionWordList) and the brand kit's look.
 */
import type { AiProviderInfo, AiTextRequest, MarksAnswer } from '../../../shared/api/ai'
import { textHash } from '../../../shared/captions/captionTracks'
import { readCleanupChoices, readWordList, type CleanupChoices, type WordListEntry } from '../../../shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS, greatNotice, planCaptionsGreat, readGreatOptions, type GreatOptions, type GreatSummary } from '../../../shared/captions/great'
import { readCaptionStudio } from '../../../shared/captions/studioData'
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
 * The brand kit's caption style, or null. The kit gains `captionStyle` (Captions Studio part P3,
 * §4.6); a kit without one, or one that cannot be read, gives null.
 */
export async function loadBrandLook(): Promise<CaptionStudio | null> {
  try {
    const kit = (await window.api.getBrandKit()) as unknown as { captionStyle?: unknown }
    return readCaptionStudio(kit.captionStyle) ?? null
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

/** The AI marks for the project's captions from `provider`, with a hash of each caption's text as it was sent. */
async function requestMarks(project: Project, provider: string): Promise<{ answer: MarksAnswer; sent: Map<string, string> }> {
  const segments = project.transcript?.segments ?? []
  const language = project.transcript?.language
  const request: AiTextRequest = { task: 'marks', segments, marks: { ...(language ? { language } : {}), captions: [] } }
  const sent = new Map(segments.map((s) => [s.id, textHash(s.text)]))
  // TODO(phase B): pass a requestId and call cancelAiText on Cancel once the publishing pack has merged.
  const result = await window.api.aiText(provider, request)
  if (result.task !== 'marks') throw new Error('The AI provider answered another task.')
  return { answer: result.answer, sent }
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

const NOTHING: Omit<GreatSummary, 'providerFailed'> = { style: null, emphasised: 0, emoji: 0, counters: 0, lists: 0, keywords: 0, lowerThirds: 0, chapters: 0, quotes: 0, tidied: 0, bleeped: 0 }

export async function runCaptionsGreat(deps: { store: EditStore<Project>; frame: { w: number; h: number }; options: GreatOptions; signal: AbortSignal; undo?: string }): Promise<{ notice: string } | null> {
  const { store, frame, options, signal } = deps
  const start = store.getSnapshot()
  if (!start.transcript?.segments.length) return null
  const inputs = await loadGreatInputs()
  if (signal.aborted) return null
  let marks: MarksAnswer | undefined
  let marksVia: AiProviderInfo['kind'] | undefined
  let providerFailed = false
  if (options.provider) {
    try {
      const [asked, kind] = await Promise.all([requestMarks(start, options.provider), providerKind(options.provider)])
      if (signal.aborted) return null
      marks = stillValid(asked.answer, asked.sent, store.getSnapshot())
      marksVia = kind
    } catch {
      if (signal.aborted) return null
      // The offline picks are used, and the notice says so (§2.8).
      providerFailed = true
    }
  }
  if (signal.aborted) return null
  let summary: GreatSummary | null = null
  let changed = false
  // One undo step, planned from the project as it is now (polish-in-one-click decision 3).
  store.seal()
  store.update((p) => {
    const out = planCaptionsGreat({ project: p, frame, brand: inputs.brand, cleanup: inputs.cleanup, words: inputs.words, by: 'great', ...(marks ? { marks } : {}), ...(marksVia ? { marksVia } : {}) }, options)
    summary = out.summary
    changed = out.project !== p
    return out.project
  })
  store.seal()
  if (!summary) return null
  const failed = providerFailed ? { providerFailed: true as const } : {}
  return { notice: greatNotice(changed ? { ...(summary as GreatSummary), ...failed } : { ...NOTHING, ...failed }, deps.undo) }
}
