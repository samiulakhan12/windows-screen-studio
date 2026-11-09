/**
 * Running Find chapters (docs/design/smart-tools.md §7.8), from the Text tab, the palette, and the
 * Captions tab's Suggest chapters (§7.6.1): the words or not, the screen read once per recording,
 * a provider's suggested starts when asked, the plan, the names (offline, or by the `names` task),
 * and the found chapters applied in one update with the notice of §2.3.
 */
import { LOCAL_TEXT_ID, type AiProviderInfo, type TextChoice } from '../../../shared/api/ai'
import type { SceneScan } from '../../../shared/api/projects'
import type { AudioLevels } from '../../../shared/audio/loudness'
import { speechFromLevels, speechLevelSource } from '../../../shared/audio/speech'
import { spokenSegments } from '../../../shared/captions/subtitles'
import { withFoundChapters } from '../../../shared/chapters/chapterAuto'
import { chapterNames, namesRequestForChapters, weakName, withAiNames } from '../../../shared/chapters/names'
import { pendingChapters } from '../../../shared/chapters/pending'
import { planChapters } from '../../../shared/chapters/plan'
import { CHAPTER_RULES } from '../../../shared/chapters/signals'
import { cropOf } from '../../../shared/engine/crop'
import { planOf, videoDuration } from '../../../shared/engine/freeze'
import { effectiveTrack } from '../../../shared/engine/inputTrack'
import type { EditStore } from '../../../shared/editor/editStore'
import { speechHeard } from '../../../shared/smart/speechHeard'
import type { ChapterOrigin, CursorTrack, Project } from '../../../shared/types'
import { choiceOf, LOCAL_CHOICE } from '../ai/textChoices'
import { loadAudioAnalysis } from './audioAnalysis'

export interface FindChapterOptions {
  density: 'fewer' | 'normal' | 'more'
  use: { screen: boolean; pauses: boolean; words: boolean }
  /** 'offline', a provider's or service's id, or 'local'. */
  names: string
  /** A provider's id: Suggest chapters with its suggestions (§7.6.1). */
  split?: string
}

/** Find chapters is built: the Captions tab's Suggest chapters runs through it (§7.6.1). */
export const FIND_CHAPTERS_BUILT: boolean = true

/** The words of §2.3. */
export const FIND_WORDS = {
  tooShort: 'Too short for chapters: YouTube needs at least 30 seconds.',
  nothing: 'Found no clear place to split: no change of screen or new section.',
  already: 'Your chapters already split the video: found no more.',
  noScreen: 'Could not read the screen: chapters come from pauses and what you say.',
  needsCaptions: 'Make captions first: chapter names come from what you say.',
  firstAtZero: 'YouTube needs the first chapter at 0:00.',
  looking: 'Looking at the screen…',
  asking: (place: string): string => `Asking ${place}…`,
  naming: (place: string): string => `Naming the chapters with ${place}…`,
  finding: 'Finding chapters…'
} as const

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * The notice after a run that added `count` found chapters, `all` chapters in the video then (§2.3):
 * the honest count, and why YouTube would not use them yet; `screenFailed` says the screen could
 * not be read.
 */
export function foundNotice(count: number, all: number, youtube: boolean, firstAtZero: boolean, screenFailed: boolean): string {
  const parts = [all < 3 ? `Found ${plural(count, 'chapter')}. YouTube needs at least 3: add one by hand to use them there.` : `Found ${plural(count, 'chapter')}. Review lists them: keep or remove each one.`]
  if (all >= 3 && !youtube && !firstAtZero) parts.push(FIND_WORDS.firstAtZero)
  if (screenFailed) parts.push(FIND_WORDS.noScreen)
  return parts.join(' ')
}

/** The run was stopped: nothing changes. */
const stopped = (): DOMException => new DOMException('Find chapters was stopped.', 'AbortError')

/** The text choice of a provider's or service's id, or On this PC. */
async function choiceFor(id: string): Promise<TextChoice> {
  if (id === LOCAL_TEXT_ID) return LOCAL_CHOICE
  const providers: AiProviderInfo[] = await window.api.listAiProviders().catch(() => [])
  const info = providers.find((p) => p.id === id)
  if (!info) throw new Error('That AI provider is gone: choose another in the Find chapters options.')
  return choiceOf(info)
}

/** Who made an AI result, as ChapterOrigin says it (§10.6: a service as 'openai' with its host). */
const viaOf = (choice: TextChoice): Pick<ChapterOrigin, 'via' | 'host'> => (choice.kind === 'local' ? { via: 'local' } : { via: choice.kind, ...(choice.host ? { host: choice.host } : {}) })

/** The screen of `project` read (kept by main after the first time), its progress shown; null when it could not be read. */
async function readScreen(project: Project, signal: AbortSignal, onProgress: (text: string, fraction: number | null) => void): Promise<SceneScan | null> {
  onProgress(FIND_WORDS.looking, null)
  const off = window.api.onSceneProgress((p) => {
    if (p.id === project.id && !signal.aborted) onProgress(`${FIND_WORDS.looking} ${Math.round(p.fraction * 100)}%`, p.fraction)
  })
  let abort: (() => void) | null = null
  try {
    // Stop stops waiting; the scan finishes in the background and is kept for the next run.
    return await Promise.race([
      window.api.detectScenes(project.id, cropOf(project)),
      new Promise<never>((_, reject) => {
        abort = () => reject(stopped())
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    ])
  } catch (err) {
    if (signal.aborted) throw stopped()
    console.warn('Could not read the screen:', err)
    return null
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    off()
  }
}

/**
 * Finds chapters in the project of `store` (§7.8) and applies them in one update: the chapters
 * found replace those an earlier run found that are still pending; the user's stay. Without
 * captions, when speech is heard and words are wanted (or an AI is to suggest from them), says
 * captions are needed instead and changes nothing. Rejects when stopped (nothing changes; the AI
 * request is cancelled) or when an AI request fails. `weak` is the id of the first found chapter
 * whose name is weak, for the focus.
 */
export async function runFindChapters(deps: {
  store: EditStore<Project>
  recorded: CursorTrack
  options: FindChapterOptions
  signal: AbortSignal
  requestId: string
  onProgress(text: string, fraction: number | null): void
}): Promise<{ notice: string; weak: string | null } | { needsCaptions: true }> {
  const { store, recorded, options, signal, requestId, onProgress } = deps
  const check = (): void => {
    if (signal.aborted) throw stopped()
  }
  const cancel = (): void => void window.api.cancelAiText(requestId).catch(() => undefined)
  signal.addEventListener('abort', cancel, { once: true })
  try {
    check()
    let project = store.state
    // Too short for chapters: nothing is read or sent.
    if (!project.clips?.length || videoDuration(project.clips, planOf(project)) < CHAPTER_RULES.minVideo - 1e-9) return { notice: FIND_WORDS.tooShort, weak: null }
    const hasWords = !!project.transcript?.segments.some((s) => s.text.trim())

    // 1. Words or not: the levels the silence tools read, only when they are needed.
    const source = speechLevelSource(project)
    let levels: AudioLevels | undefined
    if (source && (!hasWords || options.use.pauses)) {
      levels = (await loadAudioAnalysis(project.id, [source]))[source]
      check()
    }
    // An AI suggests from the captions; with words wanted and speech heard, names come from them.
    if (!hasWords && (options.split || (options.use.words && speechHeard(project, levels && source ? { [source]: levels } : null, recorded) === 'speech'))) return { needsCaptions: true }

    // 2. The screen, read once per recording; the speech detector's ranges for a recording without captions.
    const scan = options.use.screen ? await readScreen(project, signal, onProgress) : null
    check()
    const speech = !hasWords && levels?.speech ? speechFromLevels(levels, effectiveTrack(recorded, project)) : null

    // 3. A provider's suggested starts (§7.6.1).
    let ai: { t: number; title: string }[] | undefined
    let splitChoice: TextChoice | null = null
    if (options.split) {
      splitChoice = await choiceFor(options.split)
      onProgress(FIND_WORDS.asking(splitChoice.place), null)
      const result = await window.api.aiText(options.split, { task: 'chapters', segments: [...spokenSegments(store.state)], requestId }, requestId)
      check()
      ai = result.task === 'chapters' ? result.chapters : []
    }

    // 4. The plan, on the project as it is now.
    onProgress(FIND_WORDS.finding, null)
    project = store.state
    const plan = planChapters({ project, track: effectiveTrack(recorded, project), scan, speech, density: options.density, use: options.use, ...(ai ? { ai } : {}) })
    const screenFailed = options.use.screen && !scan
    if (!plan.ok) {
      const why = plan.reason === 'too-short' ? FIND_WORDS.tooShort : plan.reason === 'already' ? FIND_WORDS.already : FIND_WORDS.nothing
      return { notice: screenFailed && plan.reason !== 'too-short' ? `${why} ${FIND_WORDS.noScreen}` : why, weak: null }
    }

    // 5. The names: offline (an AI's suggested title where it suggested the start), then an AI's for the chapters with words when asked.
    const offline = chapterNames(project, plan.starts)
    const madeBy: (TextChoice | null)[] = offline.map((n) => (n.name === 'ai' ? splitChoice : null))
    let names: { title: string; name: ChapterOrigin['name'] }[] = offline
    if (options.names !== 'offline') {
      const namesChoice = await choiceFor(options.names)
      const request = namesRequestForChapters(
        project,
        plan.starts.map((s) => s.t)
      )
      if (request.items.length) {
        onProgress(FIND_WORDS.naming(namesChoice.place), null)
        const result = await window.api.aiText(options.names, { task: 'names', names: request, segments: [], requestId }, requestId)
        check()
        if (result.task === 'names') {
          const named = withAiNames(offline, result.names)
          named.forEach((n, i) => {
            if (n.ai) madeBy[i] = namesChoice
          })
          names = named
        }
      }
    }

    // 6. One update; the notice; the focus on the first weak name.
    const found = plan.starts.map((s, i) => {
      const by = madeBy[i] ?? (s.from.includes('ai') ? splitChoice : null)
      const origin: ChapterOrigin = { by: 'find', from: s.from, name: names[i].name, ...(by ? viaOf(by) : {}) }
      return { t: s.t, title: names[i].title, origin }
    })
    check()
    store.update((p) => withFoundChapters(p, found))
    const after = store.state
    const weak = pendingChapters(after)
      .filter((c) => c.auto && weakName(c.auto.name))
      .sort((a, b) => a.t - b.t)[0]
    const chapters = after.chapters ?? []
    const firstAtZero = chapters.some((c) => Math.abs(c.t - (after.clips[0]?.start ?? 0)) < 0.05)
    return { notice: foundNotice(found.length, chapters.length, plan.youtube, firstAtZero, screenFailed), weak: weak?.id ?? null }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
