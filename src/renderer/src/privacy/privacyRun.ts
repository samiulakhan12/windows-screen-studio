/**
 * Running Find from the editor (docs/design/auto-blur.md §2.5, §2.6, §5.1, §14.1, §14.5). The dialog's
 * choices are saved into the project first; the secrets said aloud are found here in the captions as
 * they are when Find starts (their signature recorded then, finding 14); main reads the screen; what
 * it found lands in one update through `afterGestures`, on the project as it is then, and only when
 * the answer is for this project and this request. *Stop*, *Stop Find and export* and leaving apply
 * what was found so far the same way. Polish's step gathers the same, and only listens when the
 * screen was already read with the same choices.
 */
import type { FindRequest, FindResult, PrivacyGathered, ReaderState } from '../../../shared/api/privacy'
import { compileNames } from '../../../shared/privacy/detect/names'
import { phoneRegions } from '../../../shared/privacy/detect/phones'
import { detectSaid, saidBleeps } from '../../../shared/privacy/detect/said'
import { readPrivacyPrefs } from '../../../shared/privacy/coverData'
import {
  captionsSig,
  FIND_KINDS,
  findChoices,
  findRecordOf,
  hasCaptions,
  outcomeOf,
  requestList,
  sameChoices,
  screenChecked,
  screenKinds,
  unfinished,
  withChoices,
  type FindChoices,
  type FindOutcome
} from '../../../shared/privacy/findState'
import { withFoundCovers } from '../../../shared/privacy/found'
import { SAID_KINDS } from '../../../shared/privacy/kinds'
import type { Bleep, FindRecord, PrivacyPrefs, PrivateKind, Project, Transcript } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import { currentUiInfo } from '../i18n/boot'
import { beginRun, currentRun, endRun, runFor } from './findRuns'
import { readerNow, setReaderState } from './readerState'

export type { FindChoices } from '../../../shared/privacy/findState'

let requests = 0
/** A request id main accepts (1-64 of [a-zA-Z0-9_-]), unique in this window. */
const newRequestId = (what: string): string => `${what}-${Date.now().toString(36)}-${(++requests).toString(36)}`

/** Settings' Private info preferences, or null. */
export async function readPrefs(): Promise<PrivacyPrefs | null> {
  try {
    return readPrivacyPrefs(await window.api.getPref('privacy'))
  } catch {
    return null
  }
}

/** The PC's region (from Windows' format locale, read in main) and the UI language. */
export function uiRegion(): { pc: string | null; language: string } {
  try {
    const info = currentUiInfo()
    const pc = /[-_]([A-Za-z]{2})\b/.exec(info.formatLocale)?.[1]?.toUpperCase() ?? null
    return { pc, language: info.language }
  } catch {
    return { pc: null, language: 'en' }
  }
}

/** The phone regions a run uses (§2.5): the PC's and the UI language's, always, then the ones added. */
export function runRegions(added: readonly string[]): string[] {
  const { pc, language } = uiRegion()
  return phoneRegions(pc, language, added)
}

/** The reader's state now, asked of main when the window has not heard it yet. */
async function readerState(): Promise<ReaderState | null> {
  const known = readerNow()
  if (known) return known
  try {
    const s = await window.api.readerState()
    setReaderState(s)
    return s
  } catch {
    return null
  }
}

/** What a run sends and listens for, from the choices, Settings' lists and the captions. */
function plan(project: Project, choices: FindChoices, prefs: PrivacyPrefs | null, captions: Transcript | null, listen: boolean): { kinds: PrivateKind[]; regions: string[]; names: string[]; neverHide: string[]; hits: ReturnType<typeof detectSaid>; sig: string | undefined } {
  const names = requestList(prefs?.names, choices.names)
  const neverHide = requestList(prefs?.neverHide, choices.neverHide)
  const regions = runRegions(choices.regions)
  const said = choices.kinds.filter((k) => SAID_KINDS.includes(k))
  const hits = listen && captions ? detectSaid(captions, { kinds: said, regions, names: compileNames(names, neverHide) }) : []
  return { kinds: screenKinds(project, choices.kinds), regions, names, neverHide, hits, sig: listen ? captionsSig(captions) : undefined }
}

/** `p` with the private bleeps of a run that only listened, and its record. */
function withSaid(p: Project, said: readonly Bleep[], record: FindRecord): Project {
  const out: Project = { ...p, privacy: { ...(p.privacy ?? {}), find: record } }
  if (said.length) out.bleeps = [...(p.bleeps ?? []), ...said]
  return out
}

/** Whether a FindResult is the answer to this request of this project (§5.1). */
const answers = (r: FindResult, projectId: string, requestId: string): boolean => r.projectId === projectId && r.requestId === requestId

/**
 * *Find* (§2.5): saves the dialog's choices into the project (one edit, only when they changed),
 * finds the secrets said aloud in the captions as they are now (their signature recorded now), asks
 * main to read the screen when the reader is downloaded, and applies what it found in one update
 * through `afterGestures` (finding 16), only on the project and request it asked for (§5.1). One run
 * at a time: 'busy' when one goes on.
 */
export async function startFind(services: EditorServices, choices: FindChoices): Promise<'done' | 'stopped' | 'busy' | 'failed'> {
  const { store } = services
  const start = store.state
  const projectId = start.id
  if (currentRun()) return 'busy'
  choices = { ...choices, kinds: FIND_KINDS.filter((k) => choices.kinds.includes(k)) }
  // 1. The choices, saved into the project first (§2.5: remembered per project).
  const captions = hasCaptions(start)
  const privacy = withChoices(start.privacy, choices, captions)
  if (!sameChoices(start.privacy, privacy)) store.update((p) => (p.id === projectId ? { ...p, privacy: withChoices(p.privacy, choices, hasCaptions(p)) } : p))
  // 2. What is said, as the captions are now; the screen, when the reader is there.
  const listen = choices.listen && captions
  const prefs = await readPrefs()
  const { kinds, regions, names, neverHide, hits, sig } = plan(start, choices, prefs, start.transcript ?? null, listen)
  const reader = await readerState()
  const screen = reader?.status === 'ready' && kinds.length > 0
  if (!screen && !listen) return 'failed'
  const requestId = newRequestId('find')
  let finished!: () => void
  const landed = new Promise<void>((resolve) => (finished = resolve))
  const began = beginRun({
    projectId,
    requestId,
    by: 'find',
    stop: async () => {
      await window.api.stopFind(projectId).catch(() => undefined)
      await landed
    }
  })
  if (!began) return 'busy'
  let outcome: FindOutcome | null = null
  try {
    let result: Extract<FindResult, { ok: true }> | null = null
    if (screen) {
      const request: FindRequest = { projectId, requestId, kinds, regions, names, neverHide }
      const r = await window.api.findPrivate(request)
      // An answer for another project or request changes nothing (§5.1).
      if (!answers(r, projectId, requestId)) return 'failed'
      if (!r.ok) {
        outcome = { ok: false, reason: r.reason }
        return r.reason === 'busy' ? 'busy' : 'failed'
      }
      result = r
    }
    // 3. One update, on the project as it is once no drag is open (finding 16).
    await new Promise<void>((resolve) =>
      store.afterGestures(() => {
        if (store.state.id === projectId) {
          store.update((p) => {
            const { bleeps: said, unplaced } = saidBleeps(hits, p.bleeps, Math.random)
            const record = findRecordOf({ at: new Date().toISOString(), kinds: result ? kinds : choices.kinds, listened: listen, captionsSig: sig, result, saidIds: said.map((b) => b.id) })
            if (!result) {
              const next = withSaid(p, said, record)
              outcome = outcomeOf(p, next, said, { result: null, unplaced, suppressed: 0 })
              return next
            }
            const merged = withFoundCovers(p, result, said, record, Math.random)
            outcome = outcomeOf(p, merged.project, said, { result, unplaced, suppressed: merged.suppressed })
            return merged.project
          })
        }
        resolve()
      })
    )
    return result?.stopped ? 'stopped' : 'done'
  } catch {
    outcome = { ok: false, reason: 'failed' }
    return 'failed'
  } finally {
    endRun(requestId, outcome)
    finished()
  }
}

/** *Stop*, *Stop Find and export* and leaving during Find (§2.6, §2.12): Find stops, and what it found is applied (one undo step) before this resolves. */
export async function stopAndApply(services: EditorServices): Promise<void> {
  const run = runFor(services.store.state.id)
  if (run) await run.stop()
}

/**
 * Polish's *Find private info* step (§14.5): what Find finds for `project`, applied by Polish in its
 * one update. It listens to the run's captions (`captions`); when the project's last Find already
 * read the whole screen with the same kinds and reader, it only listens. Null when the reader is not
 * downloaded or another Find runs.
 */
export async function gatherPrivacy(project: Project, captions: Transcript | null, signal: AbortSignal): Promise<PrivacyGathered | null> {
  const reader = await readerState()
  if (reader?.status !== 'ready' || signal.aborted) return null
  const prefs = await readPrefs()
  const choices = findChoices(project, prefs)
  const listen = !!captions?.segments.length && project.privacy?.listen !== false
  const { kinds, regions, names, neverHide, hits, sig } = plan(project, choices, prefs, captions, listen)
  const { bleeps: said, unplaced } = saidBleeps(hits, project.bleeps, Math.random)
  const at = new Date().toISOString()
  const saidCount = outcomeOf(project, project, said, { result: null, unplaced, suppressed: 0 }).said
  // The screen is already read with these choices: only the new captions are listened to.
  if (screenChecked(project, choices.kinds)) {
    const prev = project.privacy!.find!
    const record: FindRecord = { ...prev, at, listened: prev.listened || listen }
    if (listen && sig) record.captionsSig = sig
    const ids = [...(prev.saidIds ?? []), ...said.map((b) => b.id)].slice(0, 2000)
    if (ids.length) record.saidIds = ids
    return { covers: project.covers, said, privacy: { ...(project.privacy ?? {}), find: record }, found: saidCount, check: 0, listenedOnly: true, unfinished: false }
  }
  const requestId = newRequestId('polish')
  let finished!: () => void
  const landed = new Promise<void>((resolve) => (finished = resolve))
  if (!beginRun({ projectId: project.id, requestId, by: 'polish', stop: async () => { await window.api.stopFind(project.id).catch(() => undefined); await landed } })) return null
  const stop = (): void => void window.api.stopFind(project.id).catch(() => undefined)
  signal.addEventListener('abort', stop)
  let outcome: FindOutcome | null = null
  try {
    const r = await window.api.findPrivate({ projectId: project.id, requestId, kinds, regions, names, neverHide })
    if (!answers(r, project.id, requestId) || signal.aborted) return null
    if (!r.ok) {
      outcome = { ok: false, reason: r.reason }
      // The screen was not read: what was said is still bleeped; the summary says to Find again.
      return { covers: project.covers, said, privacy: { ...(project.privacy ?? {}) }, found: saidCount, check: 0, listenedOnly: false, unfinished: true }
    }
    const record = findRecordOf({ at, kinds, listened: listen, captionsSig: sig, result: r, saidIds: said.map((b) => b.id) })
    const merged = withFoundCovers(project, r, said, record, Math.random)
    const done = outcomeOf(project, merged.project, said, { result: r, unplaced, suppressed: merged.suppressed })
    outcome = done
    return { covers: merged.project.covers, said, privacy: merged.project.privacy ?? {}, found: done.found, check: done.check, listenedOnly: false, unfinished: unfinished(record) }
  } catch {
    return null
  } finally {
    signal.removeEventListener('abort', stop)
    endRun(requestId, outcome)
    finished()
  }
}
