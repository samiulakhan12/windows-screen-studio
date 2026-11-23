/**
 * Find private info's channels (docs/design/auto-blur.md §10.7): Find, Stop, Follow, the text under a
 * cover, Cover this text everywhere, the copies, and the listed names. A stub from the contracts step:
 * part P4 fills it with scan.ts. Until then every request is checked (its sender first, then its
 * fields) and answered as failed, and nothing reads a project's recording. The listed names are kept
 * for the logs already (names.ts).
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { PRIVACY_CHANNELS, validateCopiesRequest, validateEverywhereRequest, validateFindRequest, validateFollowRequest, validateUnderCoverRequest, type CopyInfo, type EverywhereResult, type FindResult, type FollowResult, type OriginCovers, type UnderCoverResult } from '../../shared/api/privacy'
import { fmt } from '../../shared/i18n/fmt'
import { t } from '../../shared/i18n/t'
import type { NotificationCopy } from '../../shared/jobs/longJobs'
import { readProject } from '../projects'
import { isAppUrl } from '../security'
import { setPrivateNames } from './names'

const fromApp = (e: IpcMainInvokeEvent): void => {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

const PROJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/

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

export function registerFindIpc(): void {
  ipcMain.handle(PRIVACY_CHANNELS.find, (e, raw: unknown): FindResult => {
    fromApp(e)
    const request = validateFindRequest(raw)
    if (!request) throw new Error('Invalid request')
    return { ok: false, projectId: request.projectId, requestId: request.requestId, reason: 'failed' }
  })
  ipcMain.handle(PRIVACY_CHANNELS.stopFind, (e, projectId: unknown) => {
    fromApp(e)
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error('Invalid request')
  })
  ipcMain.handle(PRIVACY_CHANNELS.follow, async (e, raw: unknown): Promise<FollowResult> => {
    fromApp(e)
    const duration = await durationOf(raw)
    const request = duration === null ? null : validateFollowRequest(raw, duration)
    if (!request) throw new Error('Invalid request')
    return { ok: false, projectId: request.projectId, requestId: request.requestId, reason: 'failed' }
  })
  ipcMain.handle(PRIVACY_CHANNELS.underCover, async (e, raw: unknown): Promise<UnderCoverResult> => {
    fromApp(e)
    const duration = await durationOf(raw)
    const request = duration === null ? null : validateUnderCoverRequest(raw, duration)
    if (!request) throw new Error('Invalid request')
    return { ok: false, reason: 'failed' }
  })
  ipcMain.handle(PRIVACY_CHANNELS.everywhere, (e, raw: unknown): EverywhereResult => {
    fromApp(e)
    const request = validateEverywhereRequest(raw)
    if (!request) throw new Error('Invalid request')
    return { ok: false, projectId: request.projectId, requestId: request.requestId, reason: 'failed' }
  })
  ipcMain.handle(PRIVACY_CHANNELS.copies, (e, projectId: unknown): CopyInfo[] => {
    fromApp(e)
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error('Invalid request')
    return []
  })
  ipcMain.handle(PRIVACY_CHANNELS.coverCopies, (e, raw: unknown): { covered: number; skipped: string[] } => {
    fromApp(e)
    const request = validateCopiesRequest(raw)
    if (!request) throw new Error('Invalid request')
    return { covered: 0, skipped: [...request.copyIds] }
  })
  ipcMain.handle(PRIVACY_CHANNELS.originCovers, (e, projectId: unknown): OriginCovers => {
    fromApp(e)
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error('Invalid request')
    return { missing: 0, covers: [], bleeps: [] }
  })
  ipcMain.handle(PRIVACY_CHANNELS.names, (e, names: unknown) => {
    fromApp(e)
    if (!Array.isArray(names) || names.length > 400 || !names.every((n) => typeof n === 'string' && n.length <= 80)) throw new Error('Invalid request')
    setPrivateNames(names)
  })
}
