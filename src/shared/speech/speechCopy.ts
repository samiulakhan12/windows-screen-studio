/**
 * What the Captions tab, Settings › Captions on this PC and the editor's notices say about
 * captions made on this PC (docs/design/offline-captions.md §7). Pure text from plain data, like
 * notesCopy.ts and directorCopy.ts, so the copy is unit-tested (tests/speechCopy.test.ts) and the
 * components stay layout only. The main process's failure sentences are errors.ts; this file
 * holds the renderer's own, made where they are shown in the UI language (captions.local.*;
 * docs/design/output-and-languages.md §9.1). In the Captions tab a model is named by its tier first and its model
 * name once in brackets (tierLabel); bare model names appear only in Settings and the summary.
 */
import type { SpeechDownloadError, SpeechModelStatus, SpeechModelView, SpeechState } from '../api/speech'
import type { SoundDetector } from '../audio/voice'
import { isLanguageModel, memoryNeedMB, SPEECH_MODEL_REPO, SPEECH_TIER_NAMES, speechModel, type SpeechModelId, type SpeechTier } from './catalog'
import { localErrorMessage, modelBlockReason, quickerModel, tierLabel, UNAVAILABLE_REASONS } from './errors'
import { durationWords, sizeWords } from './estimate'
import { fmt } from '../i18n/fmt'
import { t, type MessageKey } from '../i18n/t'

/** "Standard": the tier of `id`. */
export const tierName = (id: SpeechModelId): string => SPEECH_TIER_NAMES[speechModel(id)!.tier]

/** The chip label of a tier ("Most accurate (slow)" for turbo: it is slower than real time). */
export const chipTier = (tier: SpeechTier): string => (tier === 'best' ? t('captions.local.tierSlow', { tier: SPEECH_TIER_NAMES.best }) : SPEECH_TIER_NAMES[tier])

/** A size as sizeWords writes it, split into its number and unit ("60", 'mb'). */
function sizeParts(bytes: number): { n: string; gb: boolean } {
  const words = sizeWords(bytes)
  return { n: words.replace(/ (?:GB|MB)$/, ''), gb: words.endsWith(' GB') }
}

/** "60 megabytes": a size as a screen reader reads it (decimal, like sizeWords). */
export function sizeSpoken(bytes: number): string {
  const { n, gb } = sizeParts(bytes)
  return t(gb ? 'captions.local.size.gigabytes' : 'captions.local.size.megabytes', { n })
}

/** "45 s", "20 min", "1 h 5 min": a recording's length in words. */
export function lengthWords(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  if (s < 60) return t('captions.local.length.seconds', { s: fmt.count(Math.max(1, Math.round(s))) })
  const m = Math.round(s / 60)
  if (m < 60) return t('captions.local.length.minutes', { m: fmt.count(m) })
  const h = Math.floor(m / 60)
  return m % 60 ? t('captions.local.length.hoursMinutes', { h: fmt.count(h), m: fmt.count(m % 60) }) : t('captions.local.length.hours', { h: fmt.count(h) })
}

/** "42 s", "3 min 10 s", "1 h 4 min": how long a finished job took. */
export function tookWords(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0
  if (s < 60) return t('captions.local.length.seconds', { s: fmt.count(s) })
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? t('captions.local.length.minutesSeconds', { m: fmt.count(m), s: fmt.count(s % 60) }) : t('captions.local.length.minutes', { m: fmt.count(m) })
  const h = Math.floor(m / 60)
  return m % 60 ? t('captions.local.length.hoursMinutes', { h: fmt.count(h), m: fmt.count(m % 60) }) : t('captions.local.length.hours', { h: fmt.count(h) })
}

/** "about 10 s left", "about 3 min left": the time left of a download or a job. */
export function leftWords(seconds: number): string {
  if (seconds < 60) return t('captions.local.leftSeconds', { s: fmt.count(Math.max(1, Math.round(seconds))) })
  return t('captions.local.left', { time: durationWords(seconds) })
}

/** "21 of 60 MB": received and total in whole megabytes. */
export const ofMB = (received: number, total: number): string => t('captions.local.ofMB', { received: fmt.count(Math.round(received / 1e6)), total: fmt.count(Math.round(total / 1e6)) })

/** A getter for each of SPEECH_COPY's sentences, by its message key. */
const words = <K extends string>(keys: Readonly<Record<K, MessageKey>>): Readonly<Record<K, string>> => {
  const out = {} as Record<K, string>
  for (const k of Object.keys(keys) as K[]) Object.defineProperty(out, k, { get: () => t(keys[k]), enumerable: true })
  return out
}

/** The fixed sentences, in the UI language (each read when it is shown). */
export const SPEECH_COPY = Object.assign(
  words({
    checking: 'captions.local.checking',
    localOption: 'captions.local.localOption',
    localOnly: 'captions.local.localOnly',
    qualityLabel: 'captions.local.qualityLabel',
    manageModels: 'captions.local.manageModels',
    compatibleBuild: 'captions.local.compatibleBuild',
    languageHint: 'captions.local.languageHint',
    languageHintDone: 'captions.local.languageHintDone',
    consentTitle: 'captions.local.consentTitle',
    smallPrint: 'captions.local.smallPrint',
    preferCloud: 'captions.local.preferCloud',
    checkAgain: 'captions.local.checkAgain',
    downloadNote: 'captions.local.downloadNote',
    verifying: 'captions.local.verifying',
    cancel: 'common.action.cancel',
    readyHint: 'captions.local.readyHint',
    generate: 'captions.local.generate',
    generateAgain: 'captions.local.generateAgain',
    chooseAnother: 'captions.local.chooseAnother',
    useProvider: 'captions.local.useProvider',
    tryAgain: 'common.action.tryAgain',
    runningNote: 'captions.local.runningNote',
    workingOutLeft: 'captions.local.workingOutLeft',
    cloudErrorOffer: 'captions.local.cloudErrorOffer',
    useLocal: 'captions.timing.useLocal',
    intro: 'captions.local.intro',
    noSound: 'captions.local.noSound',
    downloadBar: 'captions.local.downloadBar',
    jobBar: 'captions.local.jobBar',
    /** Settings › Captions on this PC. */
    settingsTitle: 'captions.local.settingsTitle',
    settingsLead: 'captions.local.settingsLead',
    settingsRadios: 'captions.local.settingsRadios',
    recommended: 'captions.local.recommended',
    downloaded: 'captions.local.downloaded',
    checkingRow: 'captions.local.checkingRow',
    damaged: 'captions.local.damaged',
    downloadAgain: 'captions.local.downloadAgain',
    continue: 'captions.local.continue',
    delete: 'common.action.delete',
    remove: 'common.action.remove',
    inUse: 'captions.local.inUse',
    showFolder: 'captions.local.showFolder',
    aiProvidersNoKey: 'captions.local.aiProvidersNoKey',
    /** About › Third-party notices. */
    notices: 'captions.local.notices',
    noticesLoading: 'common.state.loading',
    /** The editor's notices while another tab is open. */
    jobFailedNotice: 'captions.local.jobFailedNotice',
    downloadFailedNotice: 'captions.local.downloadFailedNotice',
    /** The Bangla model (docs/design/offline-captions.md §14). */
    banglaConsentTitle: 'captions.local.banglaConsentTitle',
    banglaHint: 'captions.local.banglaHint',
    banglaDetect: 'captions.local.banglaDetect',
    chooseBengali: 'captions.local.chooseBengali',
    banglaOffer: 'captions.local.banglaOffer',
    banglaAgain: 'captions.local.banglaAgain',
    /** The offer while the Bangla model downloads or is checked (started elsewhere): it only shows that download. */
    banglaShowDownload: 'captions.local.banglaShowDownload',
    /**
     * Bengali chosen with an AI provider: the Bangla model on this PC is offered, never switched to
     * by itself. Only what was measured (§14.1: about 4 in 5 words right, no punctuation); no
     * provider was measured on Bangla, so it is not compared with one.
     */
    banglaForKeyUsers: 'captions.local.banglaForKeyUsers',
    useBanglaModel: 'captions.local.useBanglaModel',
    readyHintBangla: 'captions.local.readyHintBangla'
  }),
  {
    offline: (size: string): string => t('captions.local.offline', { size }),
    noticesFailed: (message: string): string => t('captions.local.noticesFailed', { message: message.replace(/[.\s]+$/, '') })
  }
) as {
  readonly [K in
    | 'checking' | 'localOption' | 'localOnly' | 'qualityLabel' | 'manageModels' | 'compatibleBuild' | 'languageHint' | 'languageHintDone' | 'consentTitle' | 'smallPrint'
    | 'preferCloud' | 'checkAgain' | 'downloadNote' | 'verifying' | 'cancel' | 'readyHint' | 'generate' | 'generateAgain' | 'chooseAnother' | 'useProvider' | 'tryAgain'
    | 'runningNote' | 'workingOutLeft' | 'cloudErrorOffer' | 'useLocal' | 'intro' | 'noSound' | 'downloadBar' | 'jobBar' | 'settingsTitle' | 'settingsLead' | 'settingsRadios'
    | 'recommended' | 'downloaded' | 'checkingRow' | 'damaged' | 'downloadAgain' | 'continue' | 'delete' | 'remove' | 'inUse' | 'showFolder' | 'licenceLine' | 'aiProvidersNoKey'
    | 'notices' | 'noticesLoading' | 'jobFailedNotice' | 'downloadFailedNotice' | 'banglaConsentTitle' | 'banglaHint' | 'banglaDetect' | 'chooseBengali' | 'banglaOffer'
    | 'banglaAgain' | 'banglaShowDownload' | 'banglaForKeyUsers' | 'useBanglaModel' | 'readyHintBangla']: string
} & { offline(size: string): string; noticesFailed(message: string): string }

/** The Whisper models' licence line (Settings), with the pinned repository and commit. */
Object.defineProperty(SPEECH_COPY, 'licenceLine', {
  get: () => t('captions.local.licenceLine', { repo: SPEECH_MODEL_REPO.repo, commit: SPEECH_MODEL_REPO.commit.slice(0, 7) }),
  enumerable: true
})

/** "The Bangla model is not offered on this PC: Needs about 1.3 GB of memory …". */
export const banglaBlockedLine = (reason: string): string => t('captions.local.banglaBlocked', { reason })

/** The consent card's title for `id` (the Bangla model's names its language). */
export const consentTitle = (id: SpeechModelId): string => (isLanguageModel(speechModel(id)) ? SPEECH_COPY.banglaConsentTitle : SPEECH_COPY.consentTitle)

/** The consent card's small print: where the model comes from and its licence. */
export function smallPrint(id: SpeechModelId): string {
  const spec = speechModel(id)!
  if (!spec.repo) return SPEECH_COPY.smallPrint
  return t('captions.local.smallPrintModel', { model: spec.name, licence: spec.license.name, repo: spec.repo.repo })
}

/** Settings' licence line of a model (the Whisper models share SPEECH_COPY.licenceLine). */
export function licenceLine(id: SpeechModelId): string {
  const spec = speechModel(id)!
  if (!spec.repo) return SPEECH_COPY.licenceLine
  return t('captions.local.licenceLineModel', { model: spec.name, licence: spec.license.name, holder: spec.license.holder, repo: spec.repo.repo, commit: spec.repo.commit.slice(0, 7) })
}

/** The purpose of each tier, under the chips (`settings`: Settings' wording for Most accurate). */
export function tierPurpose(tier: SpeechTier, settings = false): string {
  switch (tier) {
    case 'fast':
      return t('captions.local.purpose.fast')
    case 'standard':
      return t('captions.local.purpose.standard')
    case 'accurate':
      return t('captions.local.purpose.accurate')
    case 'best':
      return settings ? t('captions.local.purpose.bestSettings') : t('captions.local.purpose.best')
    case 'bangla':
      return settings ? t('captions.local.purpose.banglaSettings') : t('captions.local.purpose.bangla')
  }
}

/* ---------- the Captions tab ---------- */

/** A quality chip: its visible label and its accessible name ("Fast · 44 MB" / "Fast, 44 megabyte download"). */
export function chipLabel(m: Pick<SpeechModelView, 'tier' | 'bytes' | 'status'>): { label: string; name: string } {
  const tier = chipTier(m.tier)
  if (m.status.state === 'installed') return { label: t('captions.local.chip.downloaded', { tier }), name: t('captions.local.chip.downloadedName', { tier }) }
  const { n, gb } = sizeParts(m.bytes)
  return { label: t('captions.local.chip.size', { tier, size: sizeWords(m.bytes) }), name: t(gb ? 'captions.local.chip.gigabyteName' : 'captions.local.chip.megabyteName', { tier, n }) }
}

/** "Downloaded · about 3 min for this recording" / "190 MB download · about 10 min for this recording". */
export function estimateLine(m: Pick<SpeechModelView, 'bytes' | 'status'>, seconds: number): string {
  const time = durationWords(seconds)
  return m.status.state === 'installed' ? t('captions.local.estimateDownloaded', { time }) : t('captions.local.estimate', { size: sizeWords(m.bytes), time })
}

/** "Slower than playing the recording: about 38 min for this one." */
export const slowerLine = (seconds: number): string => t('captions.local.slower', { time: durationWords(seconds) })

/** The consent card's body (for the Bangla model: why it is recommended for Bangla). */
export function consentBody(id: SpeechModelId, recordingSeconds: number, estimate: number): string {
  const spec = speechModel(id)!
  const values = { size: sizeWords(spec.bytes), length: lengthWords(recordingSeconds), time: durationWords(estimate) }
  if (isLanguageModel(spec)) return t('captions.local.consentBangla', values)
  return t('captions.local.consent', { ...values, model: tierLabel(id) })
}

/** The consent card's one primary button: visible text and accessible name ("Download Bangla model (539 MB) and make captions" for the Bangla model). */
export function downloadButton(id: SpeechModelId): { label: string; name: string } {
  const spec = speechModel(id)!
  const values = { tier: tierName(id), model: spec.name, size: sizeWords(spec.bytes), spoken: sizeSpoken(spec.bytes) }
  return {
    label: isLanguageModel(spec) ? t('captions.local.downloadLanguageModel', values) : t('captions.local.downloadSize', values),
    // The visible words come first, in order (WCAG 2.5.3 Label in Name: "Download Bangla model …" works as a voice command).
    name: isLanguageModel(spec) ? t('captions.local.downloadLanguageModelName', values) : t('captions.local.downloadTierName', values)
  }
}

/** "Make them now with Standard (downloaded)". */
export const useInstalledLabel = (id: SpeechModelId): string => t('captions.local.useInstalled', { tier: tierName(id) })

/** Not enough space for a download. */
export const diskLine = (id: SpeechModelId, free: number): string => t('captions.local.disk', { size: sizeWords(speechModel(id)!.bytes), free: sizeWords(free) })

/** Why `id` cannot be downloaded now: the main process downloads one speech model at a time. */
export const downloadBusyLine = (busy: SpeechModelId, id: SpeechModelId): string => t('captions.local.downloadBusy', { busy: tierLabel(busy), tier: tierName(id) })

/** Free space a download of `id` needs: the bytes not here yet and the 64 MiB the main process keeps spare (download.ts). */
export const downloadSpaceNeeded = (id: SpeechModelId, received = 0): number => Math.max(0, speechModel(id)!.bytes - received) + 64 * 2 ** 20

/** A speed in megabytes a second with one decimal ("4.2 MB/s"). */
const speedOf = (bytesPerSecond: number): string => t('captions.local.speed', { mbps: fmt.number(bytesPerSecond / 1e6, { min: 1, max: 1 }) })

/** "Downloading Standard (Whisper base)… 21 of 60 MB · 4.2 MB/s · about 10 s left". */
export function downloadingLine(id: SpeechModelId, status: Extract<SpeechModelStatus, { state: 'downloading' }>): string {
  const parts = [t('captions.local.downloading', { model: tierLabel(id), done: ofMB(status.received, status.total) })]
  if (status.bytesPerSecond > 0) {
    parts.push(speedOf(status.bytesPerSecond))
    parts.push(leftWords(Math.max(0, status.total - status.received) / status.bytesPerSecond))
  }
  return parts.join(' · ')
}

/** "The connection dropped: trying again (2 of 3)…". */
export const retryingLine = (retrying: { attempt: number; of: number }): string => t('captions.local.retrying', { attempt: fmt.count(retrying.attempt), of: fmt.count(retrying.of) })

/** "Download stopped at 21 of 60 MB." */
export const stoppedLine = (status: { received: number; total: number }): string => t('captions.local.stoppedAt', { done: ofMB(status.received, status.total) })
/** The button that continues a stopped download (read when shown). */
export const continueDownload = (): string => t('captions.local.continueDownload')
/** "Delete the 21 MB downloaded". */
export const deletePartLabel = (received: number): string => t('captions.local.deletePart', { size: sizeWords(received) })

/** The button a failed download offers. */
export type DownloadFailAction = 'try-again' | 'check-again' | 'choose-tier'

/** "The speech model could not be downloaded: {reason}" and the button(s) for it. */
export function downloadFailed(id: SpeechModelId, status: Extract<SpeechModelStatus, { state: 'failed' }>, free: number | null): { text: string; action: DownloadFailAction } {
  const reason = downloadFailReason(id, status, free)
  return { text: t('captions.local.downloadFailed', { reason: reason.text }), action: reason.action }
}

/** Why a download failed and the button for it (Settings shows the reason after "Download failed: "). */
function downloadFailReason(id: SpeechModelId, status: Extract<SpeechModelStatus, { state: 'failed' }>, free: number | null): { text: string; action: DownloadFailAction } {
  switch (status.error as SpeechDownloadError) {
    case 'network':
      return {
        text: status.received > 0 ? t('captions.local.fail.networkKept', { size: sizeWords(status.received) }) : t('captions.local.fail.network'),
        action: 'try-again'
      }
    case 'http':
      return { text: t('captions.local.fail.http', { status: status.status === undefined ? '?' : String(status.status) }), action: 'try-again' }
    case 'refused':
      return { text: t('captions.local.fail.refused'), action: 'try-again' }
    case 'missing':
      return { text: t('captions.local.fail.missing', { model: tierLabel(id) }), action: 'choose-tier' }
    case 'mismatch':
      return { text: t('captions.local.fail.mismatch'), action: 'try-again' }
    case 'disk': {
      // The main process keeps this failure until a new download starts: Check again only while
      // the disk is still too full, then Try again (also when the free space cannot be read).
      const size = sizeWords(speechModel(id)!.bytes)
      if (free === null) return { text: t('captions.local.fail.disk', { size }), action: 'try-again' }
      if (free < downloadSpaceNeeded(id, status.received)) return { text: diskLine(id, free), action: 'check-again' }
      return { text: t('captions.local.fail.diskWas', { size, free: sizeWords(free) }), action: 'try-again' }
    }
    default:
      return { text: status.message || t('captions.local.fail.other'), action: 'try-again' }
  }
}

/** The memory warning of Accurate, Most accurate and Bangla, or null when there is enough free memory. */
export function memoryWarning(id: SpeechModelId, freeBytes: number): string | null {
  const spec = speechModel(id)!
  if (spec.tier !== 'accurate' && spec.tier !== 'best' && spec.tier !== 'bangla') return null
  const need = memoryNeedMB(spec) * 1e6
  if (!(freeBytes < need)) return null
  const quicker = quickerModel(id)
  const values = { tier: tierName(id), need: sizeWords(need), free: sizeWords(freeBytes) }
  // The Bangla model has no quicker tier: the others get most Bangla words wrong.
  if (isLanguageModel(spec)) return t('captions.local.memory.closeApps', values)
  return quicker ? t('captions.local.memory.chooseTier', { ...values, quicker: SPEECH_TIER_NAMES[quicker.tier] }) : t('captions.local.memory.chooseQuicker', values)
}

/** The running job's phase. */
export type LocalPhase = 'loading' | 'preparing' | 'transcribing' | 'finishing' | 'stopping'

/** The phase line ("Making captions on this PC… 8:30 of 20:00"). */
export function phaseLine(phase: LocalPhase, at?: number, duration?: number): string {
  switch (phase) {
    case 'loading':
      return t('captions.local.phase.loading')
    case 'preparing':
      return t('captions.local.phase.preparing')
    case 'transcribing':
      return at !== undefined && duration !== undefined ? t('captions.local.phase.transcribingAt', { at: fmt.clock(at, 'whole'), duration: fmt.clock(duration, 'whole') }) : t('captions.local.phase.transcribing')
    case 'finishing':
      return t('captions.local.phase.finishing')
    case 'stopping':
      return t('captions.local.phase.stopping')
  }
}

/** The phase's name as the live region says it: its line without the dots ("Loading the speech model"). */
function phaseName(phase: LocalPhase): string {
  switch (phase) {
    case 'loading':
      return t('captions.local.phaseName.loading')
    case 'preparing':
      return t('captions.local.phaseName.preparing')
    case 'transcribing':
      return t('captions.local.phaseName.transcribing')
    case 'finishing':
      return t('captions.local.phaseName.finishing')
    case 'stopping':
      return t('captions.local.phaseName.stopping')
  }
}

/** What the hidden live region says: the phase, and the share done in steps of 25 %. */
export function announceLine(phase: LocalPhase, quarter: number): string {
  return quarter > 0 && phase === 'transcribing' ? t('captions.local.announcePercent', { percent: fmt.count(quarter * 25) }) : phaseName(phase)
}

/** "42 percent, about 3 min left": the progress bar's text. */
export const barText = (share: number, left: number | null): string => {
  const percent = fmt.count(Math.round(share * 100))
  return left === null ? t('captions.local.barPercent', { percent }) : t('captions.local.barPercentLeft', { percent, left: leftWords(left) })
}

/** "Heard: “…”" with the newest words. */
export const heardLine = (preview: string): string => t('captions.local.heard', { words: preview.trim() })

/** "Continuing: 3 of 6 parts were already done." */
export const resumedLine = (resumed: number, parts: number): string => t('captions.local.resumed', { done: fmt.count(resumed), parts: fmt.count(parts) })

/** "Stopped. 3 of 6 parts are kept: Generate captions continues from there." */
export const cancelledLine = (kept: number, parts: number): string => t('captions.local.cancelled', { kept: fmt.count(kept), parts: fmt.count(parts) })

/** "Download again (60 MB)", "Use Fast": the button an error offers. */
export const downloadAgainLabel = (id: SpeechModelId): string => t('captions.local.downloadAgainSize', { size: sizeWords(speechModel(id)!.bytes) })
export const useTierLabel = (id: SpeechModelId): string => t('captions.local.useTier', { tier: tierName(id) })

/** The summary's message: without a language, with the chosen one, or with the one heard. */
const DONE_KEYS: Readonly<Record<'plain' | 'language' | 'detected', MessageKey>> = {
  plain: 'captions.local.done',
  language: 'captions.local.doneLanguage',
  detected: 'captions.local.doneDetected'
}
/** The same with the time it took. */
const DONE_TOOK_KEYS: Readonly<Record<'plain' | 'language' | 'detected', MessageKey>> = {
  plain: 'captions.local.doneTook',
  language: 'captions.local.doneTookLanguage',
  detected: 'captions.local.doneTookDetected'
}

/** The summary of captions made on this PC. */
export function doneLine(opts: { count: number; model: string; language: string | null; detected?: boolean; took?: number }): string {
  const values = { count: opts.count, n: fmt.count(opts.count), model: speechModel(opts.model)?.name ?? opts.model, language: opts.language ?? '' }
  const which = opts.language ? (opts.detected ? 'detected' : 'language') : 'plain'
  if (opts.took === undefined) return t(DONE_KEYS[which], values)
  return t(DONE_TOOK_KEYS[which], { ...values, took: tookWords(opts.took) })
}

/** "Not English?" */
export const notLanguage = (language: string): string => t('captions.local.notLanguage', { language })

/** "Captions ready: 12 captions made on this PC in 42 s. Undo removes them." */
export const readyNotice = (count: number, took: number): string => t('captions.local.ready', { count, n: fmt.count(count), took: tookWords(took) })

/** The Captions tab's ring while a download or a job of this project runs. */
export function badgeTitle(phase: 'download' | 'verify' | 'job', share: number | null): string {
  const percent = share === null ? null : fmt.count(Math.round(share * 100))
  if (phase === 'download') return percent === null ? t('captions.local.badge.downloading') : t('captions.local.badge.downloadingPercent', { percent })
  if (phase === 'verify') return t('captions.local.badge.verifying')
  return percent === null ? t('captions.local.badge.making') : t('captions.local.badge.makingPercent', { percent })
}

/** "Captions on this PC are not available here: …." */
export const unavailableLine = (reason: keyof typeof UNAVAILABLE_REASONS | undefined): string => localErrorMessage('unavailable', { reason })

/* ---------- Settings ---------- */

/** "Whisper base · Standard"; "Bengali.AI Whisper medium · Bangla only" for the Bangla model. */
export const rowTitle = (m: Pick<SpeechModelView, 'name' | 'tier'>): string =>
  m.tier === 'bangla' ? t('captions.local.rowTitleOnly', { model: m.name, tier: SPEECH_TIER_NAMES[m.tier] }) : t('captions.local.rowTitle', { model: m.name, tier: SPEECH_TIER_NAMES[m.tier] })

/** "60 MB download · about 1 min per 10 minutes of recording on this PC · about 399 MB of memory". */
export function rowFacts(m: SpeechModelView, per10Seconds: number): string {
  const values = { size: sizeWords(m.bytes), time: durationWords(per10Seconds), memory: sizeWords(memoryNeedMB(m) * 1e6) }
  return m.measured ? t('captions.local.rowFactsMeasured', values) : t('captions.local.rowFacts', values)
}

/** A row's status text in Settings. */
export function rowStatus(m: SpeechModelView, free: number | null): string | null {
  const s = m.status
  switch (s.state) {
    case 'missing':
      return null
    case 'downloading': {
      if (s.retrying) return retryingLine(s.retrying)
      const values = { percent: fmt.count(s.total > 0 ? Math.floor((s.received / s.total) * 100) : 0), done: ofMB(s.received, s.total) }
      return s.bytesPerSecond > 0 ? t('captions.local.rowDownloadingSpeed', { ...values, speed: speedOf(s.bytesPerSecond) }) : t('captions.local.rowDownloading', values)
    }
    case 'verifying':
      return SPEECH_COPY.checkingRow
    case 'stopped':
      return t('captions.local.rowStopped', { done: ofMB(s.received, s.total) })
    case 'installed':
      return SPEECH_COPY.downloaded
    case 'damaged':
      return SPEECH_COPY.damaged
    case 'failed':
      return t('captions.local.rowFailed', { reason: downloadFailReason(m.id, s, free).text })
  }
}

/** "Download 60 MB" with its accessible name. */
export const rowDownload = (m: Pick<SpeechModelView, 'name' | 'bytes'>): { label: string; name: string } => ({
  label: t('captions.local.rowDownload', { size: sizeWords(m.bytes) }),
  name: t('captions.local.rowDownloadName', { model: m.name, spoken: sizeSpoken(m.bytes) })
})

/** The inline Remove question. */
export const removeQuestion = (m: Pick<SpeechModelView, 'name' | 'bytes'>): string => t('captions.local.removeQuestion', { model: m.name, size: sizeWords(m.bytes) })
/** "Remove Whisper small, frees 190 megabytes". */
export const removeName = (m: Pick<SpeechModelView, 'name' | 'bytes'>): string => t('captions.local.removeName', { model: m.name, spoken: sizeSpoken(m.bytes) })

/** Why a row cannot be downloaded (the view's reason, else the catalog's). */
export function blockedLine(m: SpeechModelView, state: Pick<SpeechState, 'memory' | 'engine'>): string | null {
  if (m.allowed) return null
  if (m.reason) return m.reason
  const spec = speechModel(m.id)!
  return modelBlockReason(state.engine.build === 'compatible' && spec.needsStandardBuild ? 'processor' : 'memory', spec, state.memory.total)
}

/** "Speech engine: ready" / "… (compatible mode for this processor: slower)" / "not available (…)". */
export function engineLine(engine: SpeechState['engine']): string {
  if (!engine.available) return t('captions.local.engineUnavailable', { reason: UNAVAILABLE_REASONS[engine.reason ?? 'failed'] })
  return engine.build === 'compatible' ? t('captions.local.engineCompatible') : t('captions.local.engineReady')
}

/** The speech detector's line. */
export function detectorLine(detector: SpeechState['detector']): string {
  if (detector.available) return t('captions.local.detectorReady')
  const why = (detector.reason ?? t('errors.vad.didNotStart')).replace(/[.।\s]+$/, '')
  return t('captions.local.detectorUnavailable', { reason: fmt.inSentence(why.charAt(0)) + why.slice(1) })
}

/** "Speech models use 60 MB · 120 GB free on this drive". */
export const diskFooter = (disk: SpeechState['disk']): string =>
  disk.free === null ? t('captions.local.diskFooter', { used: sizeWords(disk.used) }) : t('captions.local.diskFooterFree', { used: sizeWords(disk.used), free: sizeWords(disk.free) })

/* ---------- Clip and Audio tabs ---------- */

/** The Clip tab's line on what counts as sound (`systemStem`: the recording kept PC sound apart). */
export function detectorStatus(detector: SoundDetector, systemStem: boolean): string {
  switch (detector) {
    case 'speech':
      return systemStem ? t('captions.local.listen.voiceSystem') : t('captions.local.listen.voice')
    case 'mixed':
      return t('captions.local.listen.mixed')
    case 'guard':
      return t('captions.local.listen.guard')
    case 'level':
      return t('captions.local.listen.level')
  }
}

/** Hints when the voice counts (the speech detector ran on the microphone), read when shown. */
export const silencesVoiceHint = (): string => t('captions.local.hint.silences')
export const idleVoiceHint = (): string => t('captions.local.hint.idle')
export const duckingVoiceHint = (): string => t('captions.local.hint.ducking')

/**
 * The Clip tab's two hints as English constants, for ClipPanel.tsx until it calls silencesVoiceHint()
 * and idleVoiceHint() (ClipPanel is step S4b group d's file); the same English as those messages.
 */
export const SILENCES_VOICE_HINT = 'Cuts or speeds up the pauses in your talking, keeping a little of the silence next to the sound so no word is clipped.'
export const IDLE_VOICE_HINT =
  'Speeds up or cuts the parts where nothing happens: the picture stays still, you are not talking and your PC plays no sound, and you did not move, click, scroll or type.'
