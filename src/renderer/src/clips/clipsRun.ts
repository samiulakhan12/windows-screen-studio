/**
 * Running Short clips and Make a shorter version (docs/design/smart-tools.md §2.4, §8): whether
 * the recording needs captions first (speechHeard, §7.8), the moments, the screen read once per
 * recording with its progress, the names an AI gives (the `names` task, kind 'clip'), the space
 * the copies take, and the copies made one after another through Duplicate's own channel.
 */
import type { NamesRequest } from '../../../shared/api/ai'
import type { CopyCost, DuplicateProgress, SceneScan } from '../../../shared/api/projects'
import type { AudioLevels } from '../../../shared/audio/loudness'
import type { AudioSource } from '../../../shared/audio/settings'
import { CLIP_RULES, findMoments, type Moment, type MomentLength } from '../../../shared/clips/moments'
import { keptClipWords } from '../../../shared/clips/sentences'
import { cropOf } from '../../../shared/engine/crop'
import { planOf, videoDuration } from '../../../shared/engine/freeze'
import { privateLike } from '../../../shared/smart/privateText'
import { speechHeard } from '../../../shared/smart/speechHeard'
import type { CursorTrack, Project } from '../../../shared/types'

/** The words of §2.4. */
export const CLIPS_WORDS = {
  intro: 'The best moments to post on their own. Each one you make becomes a copy; this video stays as it is.',
  silent: 'No speech was found, so these are the moments with the most going on.',
  tooShort: 'Too short for clips: post the whole video.',
  nothing: 'Found no moment of 15 to 90 seconds to post on its own.',
  needsCaptions: 'Make captions first: clips are picked from what you say.',
  noScreen: 'Could not read the screen: moments come from what you say and do.',
  looking: 'Looking at the screen…',
  naming: (place: string): string => `Naming the clips with ${place}…`,
  linked: "The copies share this video's files: they take almost no space.",
  oneDrive: (each: string): string => `Each copy takes ${each}: files in a OneDrive folder cannot be shared.`,
  noRoom: (n: number, need: string, free: string): string => `${n === 1 ? 'This copy needs' : `These ${n} copies need`} ${need}; ${free} is free.`,
  making: (i: number, n: number): string => `Making copy ${i} of ${n}…`,
  shortNeedsCaptions: 'Make captions first: a shorter version keeps the sentences you say.',
  tooLittle: 'Not enough clear speech for a shorter version.'
} as const

/** Room left on the drive besides the copies (Duplicate's SPARE_BYTES, projectCopy.ts). */
export const SPARE_BYTES = 64 * 1024 * 1024
/** Longest narration sent to name a clip (§8.4). */
export const CLIP_WORDS_MAX = 1500
/** Longest AI name kept for a clip (§8.4). */
export const CLIP_NAME_MAX = 80

/** "1.2 GB", "85 MB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/**
 * The panel's line about disk space for `n` copies (§2.4) and whether they would not fit: `bytes`
 * is what one copy writes (copyCost), so `n` copies need n × bytes and 64 MB to spare.
 */
export function copySpace(cost: CopyCost, n: number): { text: string; blocked: boolean } {
  const need = cost.bytes * Math.max(1, n) + SPARE_BYTES
  if (need > cost.free) return { text: CLIPS_WORDS.noRoom(Math.max(1, n), sizeText(cost.bytes * Math.max(1, n)), sizeText(cost.free)), blocked: true }
  return { text: cost.linked ? CLIPS_WORDS.linked : CLIPS_WORDS.oneDrive(sizeText(cost.bytes)), blocked: false }
}

/**
 * What Find short clips shows for `project` (§2.4, §8.3): the moments; why there are none; or,
 * for a recording without captions in which speech is heard (speechHeard: 10 s or more), that
 * captions come first, unless `activityOnly` asks for the busiest stretches anyway.
 */
export function clipsFor(
  project: Project,
  ctx: { track: CursorTrack | null; scan: SceneScan | null; levels: Partial<Record<AudioSource, AudioLevels>> | null; focus?: string; length: MomentLength; activityOnly?: boolean }
): { moments: Moment[] } | { reason: 'too-short' | 'nothing' } | { needsCaptions: true } {
  if (!project.clips?.length || videoDuration(project.clips, planOf(project)) < CLIP_RULES.minVideo - 1e-6) return { reason: 'too-short' }
  if (!ctx.activityOnly && speechHeard(project, ctx.levels, ctx.track) === 'speech') return { needsCaptions: true }
  const found = findMoments(project, { track: ctx.track, scan: ctx.scan, length: ctx.length, ...(ctx.focus ? { focus: ctx.focus } : {}), ...(ctx.activityOnly ? { activityOnly: true } : {}) })
  return Array.isArray(found) ? { moments: found } : found
}

const graphemer = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The kept narration of each moment (bleeped words masked), at most 1,500 graphemes from its start (§8.4). */
export function namesRequestForMoments(project: Project, moments: readonly Moment[]): NamesRequest {
  const words = keptClipWords(project)
  const items: NamesRequest['items'] = []
  moments.forEach((m, i) => {
    const text = words
      .filter((w) => w.start >= m.start - 1e-6 && w.start < m.end - 1e-6)
      .map((w) => w.text)
      .join(' ')
      .trim()
    if (!text) return
    const g = [...graphemer.segment(text)]
    items.push({ id: String(i), text: g.length > CLIP_WORDS_MAX ? g.slice(0, CLIP_WORDS_MAX).map((s) => s.segment).join('') : text })
  })
  const language = project.transcript?.language
  return { kind: 'clip', ...(language ? { language } : {}), items }
}

/**
 * The moments with the names an AI gave them (§8.4): each answer by its moment's index, one line
 * of 1 to 80 characters; a name in which privateLike finds anything (a link, an address, a path)
 * is dropped for the offline title, whether or not it was said.
 */
export function withAiTitles(moments: readonly Moment[], answer: readonly { id: string; name: string }[]): Moment[] {
  const out = [...moments]
  for (const a of answer) {
    const i = Number(a.id)
    if (!Number.isInteger(i) || i < 0 || i >= out.length || typeof a.name !== 'string') continue
    const name = a.name.replace(/\s+/g, ' ').trim()
    if (!name || name.length > CLIP_NAME_MAX || privateLike(name)) continue
    out[i] = { ...out[i], title: name }
  }
  return out
}

/** The run was stopped: nothing more is made. */
export const stopped = (): DOMException => new DOMException('Short clips was stopped.', 'AbortError')

/** "Error invoking remote method 'x': Error: message" -> "message". */
export const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/**
 * The screen of `project` read (main keeps it after the first time), its progress given; null when
 * it could not be read. Stop stops waiting (the scan finishes in the background and is kept).
 */
export async function readScreen(project: Project, signal: AbortSignal, onProgress: (fraction: number | null) => void): Promise<SceneScan | null> {
  onProgress(null)
  const off = window.api.onSceneProgress((p) => {
    if (p.id === project.id && !signal.aborted) onProgress(p.fraction)
  })
  let abort: (() => void) | null = null
  try {
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

/** Every message a failed copy shows starts with this (duplicateFlow.ts). */
const FAILED = 'Could not make the copy: '

/** A copy that failed: what was made before it stays (`made`). */
export class ClipCopyError extends Error {
  constructor(
    message: string,
    readonly made: { id: string; name: string }[]
  ) {
    super(message)
  }
}

/**
 * Makes `copies` (each still carrying the source's id) one after another through Duplicate
 * (duplicateProject, its progress and cancel): Duplicate makes one copy at a time. Stop removes
 * the copy being made (cancelled, or deleted if it finished meanwhile) and keeps those finished.
 * A failure (a refusal such as "a copy is already being made") stops with its message; the copies
 * made before it stay. The save is flushed first; the copies are built from the editor's state, so
 * they hold its latest edits either way.
 */
export async function makeClipCopies(
  copies: readonly Project[],
  deps: { sourceId: string; flush(): Promise<boolean>; signal: AbortSignal; onProgress(i: number, n: number, p: DuplicateProgress | null): void }
): Promise<{ made: { id: string; name: string }[]; stopped: boolean }> {
  const { sourceId, signal } = deps
  const made: { id: string; name: string }[] = []
  await deps.flush()
  for (let i = 0; i < copies.length; i++) {
    if (signal.aborted) return { made, stopped: true }
    deps.onProgress(i, copies.length, null)
    const off = window.api.onDuplicateProgress((p) => {
      if (!signal.aborted) deps.onProgress(i, copies.length, p)
    })
    try {
      const making = window.api.duplicateProject(sourceId, copies[i])
      const result = await new Promise<{ id: string; name: string } | null>((resolve, reject) => {
        const onAbort = (): void => {
          window.api.cancelDuplicate()
          // Finished all the same as Stop was pressed: the user asked for no more.
          making.then((m) => window.api.deleteProject(m.id)).catch(() => undefined)
          resolve(null)
        }
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        making.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
      })
      if (!result) return { made, stopped: true }
      made.push({ id: result.id, name: result.name })
    } catch (err) {
      const message = ipcMessage(err)
      throw new ClipCopyError(message.startsWith(FAILED) ? message : `${FAILED}${message}`, made)
    } finally {
      off()
    }
  }
  deps.onProgress(copies.length, copies.length, null)
  return { made, stopped: false }
}
