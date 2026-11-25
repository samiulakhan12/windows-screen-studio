/**
 * Find private info's channels (docs/design/auto-blur.md §5.1, §10.7): Find, Stop, Follow, the text
 * under a cover, Cover this text everywhere, the copies, and the listed names. Every handler checks
 * its sender first, then validates the request before main touches anything; main finds every file
 * itself from the project id.
 *
 * One Find runs in Flown at a time (D25): a second, for this project or another, is answered busy.
 * Follow and Everywhere share Find's helper and go ahead of its reads (scan.ts). Find belongs to the
 * open editor: stopAnalyses (the editor closing, the project being deleted) and the page going away
 * stop it and forget the texts it kept. Its job is an analysis job (Restart now waits for it), and
 * it ends with main.jobs.privacyDone for Windows to show when Flown's window has no focus.
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { PRIVACY_CHANNELS, validateCopiesRequest, validateEverywhereRequest, validateFindRequest, validateFollowRequest, validateUnderCoverRequest, type CopyInfo, type EverywhereResult, type FindProgress, type FindResult, type FollowResult, type FoundCover, type OriginCovers, type UnderCoverResult } from '../../shared/api/privacy'
import { fmt } from '../../shared/i18n/fmt'
import { t } from '../../shared/i18n/t'
import type { NotificationCopy } from '../../shared/jobs/longJobs'
import { ffmpegPath } from '../ffmpeg'
import { beginJob } from '../longJobs'
import { readProject } from '../projects'
import { isToolbarVisible } from '../recording/toolbarWindow'
import { isAppUrl } from '../security'
import { coverCopies, listCopies, originCovers, type CopiesDeps } from './copies'
import { setPrivateNames } from './names'
import { HelperError, OcrHelper } from './readerHelper'
import { recordDecodeSpeed, startReader } from './readerModels'
import { coverEverywhere, followCover, forgetReads, forgetUnder, runFind, ScanUnavailable, setReaderStart, underCover, type ScanDeps, type ScanHelper } from './scan'

const fromApp = (e: IpcMainInvokeEvent): void => {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

const PROJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/

/** The recording's length, read by main from the project's own file (the request's times are checked against it). */
async function durationOf(raw: unknown): Promise<number | null> {
  const id = raw && typeof raw === 'object' ? (raw as { projectId?: unknown }).projectId : undefined
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) return null
  try {
    return (await readProject(id)).duration
  } catch {
    return null
  }
}

/** The notification Find's job ends with when Flown's window does not have the focus (§2.6): `count` private items wait in Review. */
export function privacyDoneNotice(count: number): NotificationCopy {
  return { title: t('main.jobs.privacyDone', { count, n: fmt.count(count) }), body: '', actions: [] }
}

/** Private items in a result: one a Review group (§2.12). */
export const privateCount = (found: readonly FoundCover[]): number => new Set(found.map((f) => f.group)).size

export interface ReaderStartDeps {
  /** Checks the pinned files, starts the helper and opens them (readerModels' startReader). */
  startReader?: (ffmpeg: string) => Promise<ScanHelper>
  /** Starts the helper with nothing open (OcrHelper.start). */
  startHelper?: () => Promise<ScanHelper>
  ffmpeg?: () => string
}

/**
 * How the scan starts the text reader (§5.1, §5.9), given to it by registerFindIpc. With `models`,
 * the pinned files are checked and opened (startReader): files missing or refused end the run as
 * `reader`, a helper that is missing or does not run here as `helper`. Without models (*Follow what
 * is under it* when there is no reader), the helper is opened with no files: it then knows the
 * bundled ffmpeg, which its look pass and follow sessions need, and holds no reader, which it
 * answers with error `model`; that answer is expected here, and any other ends the helper.
 */
export function readerStart(deps: ReaderStartDeps = {}): (models: boolean) => Promise<ScanHelper> {
  const ffmpeg = deps.ffmpeg ?? ffmpegPath
  const withModels = deps.startReader ?? ((f: string) => startReader(f))
  const bare = deps.startHelper ?? (() => OcrHelper.start())
  return async (models) => {
    if (models) {
      try {
        return await withModels(ffmpeg())
      } catch (err) {
        throw new ScanUnavailable(err instanceof HelperError && err.kind === 'model' ? 'reader' : 'helper')
      }
    }
    let helper: ScanHelper
    try {
      helper = await bare()
    } catch {
      throw new ScanUnavailable('helper')
    }
    try {
      await helper.open([], ffmpeg())
    } catch (err) {
      if (!(err instanceof HelperError && err.kind === 'model')) {
        helper.kill()
        throw new ScanUnavailable('helper')
      }
    }
    return helper
  }
}

let scanDeps: ScanDeps = {}
let copiesDeps: CopiesDeps = {}

/** How the scan and the copies run (tests; the text reader reaches the scan through readerStart). */
export function setFindDeps(scan: ScanDeps, copies: CopiesDeps = {}): void {
  scanDeps = scan
  copiesDeps = copies
}

interface Run {
  projectId: string
  /** The Follow's, text-under-a-cover's or Everywhere's request it answers (Find's own run has none). */
  requestId?: string
  controller: AbortController
  done: Promise<unknown>
}

/** The one Find in Flown, and the Follow, text-under-a-cover and Everywhere runs. */
let find: Run | null = null
const others = new Set<Run>()
/** One Follow or Everywhere at a time (they share the helper with Find). */
let following = false

/** Stops `stop` when the page that asked goes away, and forgets the texts kept. */
function watchSender(sender: WebContents | undefined, stop: () => void): () => void {
  if (!sender || typeof sender.once !== 'function') return () => undefined
  const gone = (): void => {
    stop()
    forgetReads()
  }
  sender.once('render-process-gone', gone)
  sender.once('destroyed', gone)
  return () => {
    sender.removeListener('render-process-gone', gone)
    sender.removeListener('destroyed', gone)
  }
}

const sendTo =
  (sender: WebContents | undefined) =>
  (p: FindProgress): void => {
    if (sender && typeof sender.isDestroyed === 'function' && !sender.isDestroyed()) sender.send(PRIVACY_CHANNELS.findProgress, p)
  }

/** The scan's dependencies in the app: the recording state, and this PC's decode speed kept for the next estimate (§5.11). */
const deps = (): ScanDeps => ({ recording: isToolbarVisible, recordDecode: recordDecodeSpeed, ...scanDeps })

/** Runs `work` as one of the other runs of `projectId`, for request `requestId`: stopped by its own Stop, and by Find's. */
async function other<T>(projectId: string, requestId: string, sender: WebContents | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const unwatch = watchSender(sender, () => controller.abort())
  const run: Run = { projectId, requestId, controller, done: Promise.resolve() }
  others.add(run)
  try {
    const done = work(controller.signal)
    run.done = done.catch(() => undefined)
    return await done
  } finally {
    others.delete(run)
    unwatch()
  }
}

/**
 * Stops Find and the other runs of a project, forgets the texts kept, and waits until they have let
 * go (stopAnalyses: the editor closed, or the project is about to be deleted).
 */
export async function stopFindFor(projectId: string): Promise<void> {
  const runs = [find, ...others].filter((r): r is Run => !!r && r.projectId === projectId)
  for (const r of runs) r.controller.abort()
  forgetReads()
  await Promise.all(runs.map((r) => r.done.catch(() => undefined)))
}

/** Whether a Find runs now (tests). */
export const findRunning = (): boolean => find !== null

export function registerFindIpc(): void {
  setReaderStart(readerStart())
  ipcMain.handle(PRIVACY_CHANNELS.find, async (e, raw: unknown): Promise<FindResult> => {
    fromApp(e)
    const request = validateFindRequest(raw)
    if (!request) throw new Error('Invalid request')
    const tag = { projectId: request.projectId, requestId: request.requestId }
    if (find) return { ok: false, ...tag, reason: 'busy' }
    const controller = new AbortController()
    const run: Run = { projectId: request.projectId, controller, done: Promise.resolve() }
    find = run
    const job = beginJob({ kind: 'analysis', stoppable: true, onStop: () => controller.abort() })
    const unwatch = watchSender(e.sender, () => controller.abort())
    try {
      const done = runFind(request, sendTo(e.sender), controller.signal, deps())
      run.done = done.catch(() => undefined)
      const result = await done
      await job.end(result.ok ? { kind: 'done', notice: privacyDoneNotice(privateCount(result.found)), ...(result.stopped ? { stopped: true } : {}) } : { kind: 'failed', message: '' }).catch(() => undefined)
      return result
    } catch {
      await job.end({ kind: 'failed', message: '' }).catch(() => undefined)
      return { ok: false, ...tag, reason: 'failed' }
    } finally {
      if (find === run) find = null
      unwatch()
    }
  })
  ipcMain.handle(PRIVACY_CHANNELS.stopFind, (e, projectId: unknown, requestId?: unknown) => {
    fromApp(e)
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error('Invalid request')
    if (requestId !== undefined && requestId !== null) {
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error('Invalid request')
      // A Follow's or an Everywhere's Stop, or its dialog closing: that run alone stops, and the text
      // read under the cover for it is forgotten. A Find of the project goes on, with the reads it
      // keeps for Everywhere (second review, finding [20]).
      for (const r of others) if (r.projectId === projectId && r.requestId === requestId) r.controller.abort()
      forgetUnder(requestId)
      return
    }
    // Find's Stop, Polish's and leaving the editor: every run of the project stops; what Find found so
    // far comes back through its own request; the texts kept are forgotten.
    for (const r of [find, ...others]) if (r && r.projectId === projectId) r.controller.abort()
    forgetReads()
  })
  ipcMain.handle(PRIVACY_CHANNELS.follow, async (e, raw: unknown): Promise<FollowResult> => {
    fromApp(e)
    const duration = await durationOf(raw)
    const request = duration === null ? null : validateFollowRequest(raw, duration)
    if (!request) throw new Error('Invalid request')
    if (following) return { ok: false, projectId: request.projectId, requestId: request.requestId, reason: 'busy' }
    following = true
    try {
      return await other(request.projectId, request.requestId, e.sender, (signal) => followCover(request, signal, deps()))
    } finally {
      following = false
    }
  })
  ipcMain.handle(PRIVACY_CHANNELS.underCover, async (e, raw: unknown): Promise<UnderCoverResult> => {
    fromApp(e)
    const duration = await durationOf(raw)
    const request = duration === null ? null : validateUnderCoverRequest(raw, duration)
    if (!request) throw new Error('Invalid request')
    return other(request.projectId, request.requestId, e.sender, (signal) => underCover(request, signal, deps()))
  })
  ipcMain.handle(PRIVACY_CHANNELS.everywhere, async (e, raw: unknown): Promise<EverywhereResult> => {
    fromApp(e)
    const request = validateEverywhereRequest(raw)
    if (!request) throw new Error('Invalid request')
    // Like Follow, it goes ahead of a running Find's reads on the one helper; one of the two at a time.
    if (following) return { ok: false, projectId: request.projectId, requestId: request.requestId, reason: 'busy' }
    following = true
    try {
      return await other(request.projectId, request.requestId, e.sender, (signal) => coverEverywhere(request, sendTo(e.sender), signal, deps()))
    } finally {
      following = false
    }
  })
  ipcMain.handle(PRIVACY_CHANNELS.copies, async (e, projectId: unknown): Promise<CopyInfo[]> => {
    fromApp(e)
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error('Invalid request')
    return listCopies(projectId, copiesDeps).catch(() => [])
  })
  ipcMain.handle(PRIVACY_CHANNELS.coverCopies, async (e, raw: unknown): Promise<{ covered: number; skipped: string[] }> => {
    fromApp(e)
    const request = validateCopiesRequest(raw)
    if (!request) throw new Error('Invalid request')
    return coverCopies(request.projectId, request.copyIds, copiesDeps).catch(() => ({ covered: 0, skipped: [...request.copyIds] }))
  })
  ipcMain.handle(PRIVACY_CHANNELS.originCovers, async (e, projectId: unknown): Promise<OriginCovers> => {
    fromApp(e)
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error('Invalid request')
    return originCovers(projectId, copiesDeps)
  })
  ipcMain.handle(PRIVACY_CHANNELS.names, (e, names: unknown) => {
    fromApp(e)
    if (!Array.isArray(names) || names.length > 400 || !names.every((n) => typeof n === 'string' && n.length <= 80)) throw new Error('Invalid request')
    setPrivateNames(names)
  })
}
