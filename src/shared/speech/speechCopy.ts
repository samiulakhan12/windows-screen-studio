/**
 * What the Captions tab, Settings › Captions on this PC and the editor's notices say about
 * captions made on this PC (docs/design/offline-captions.md §7). Pure text from plain data, like
 * notesCopy.ts and directorCopy.ts, so the copy is unit-tested (tests/speechCopy.test.ts) and the
 * components stay layout only. The main process's failure sentences are errors.ts; this file
 * holds the renderer's own. In the Captions tab a model is named by its tier first and its model
 * name once in brackets (tierLabel); bare model names appear only in Settings and the summary.
 */
import type { SpeechDownloadError, SpeechModelStatus, SpeechModelView, SpeechState } from '../api/speech'
import type { SoundDetector } from '../audio/voice'
import { formatTime } from '../engine/project'
import { isLanguageModel, memoryNeedMB, SPEECH_MODEL_REPO, SPEECH_TIER_NAMES, speechModel, type SpeechModelId, type SpeechTier } from './catalog'
import { localErrorMessage, modelBlockReason, quickerModel, tierLabel, UNAVAILABLE_REASONS } from './errors'
import { durationWords, sizeWords } from './estimate'

/** "Standard": the tier of `id`. */
export const tierName = (id: SpeechModelId): string => SPEECH_TIER_NAMES[speechModel(id)!.tier]

/** The chip label of a tier ("Most accurate (slow)" for turbo: it is slower than real time). */
export const chipTier = (tier: SpeechTier): string => (tier === 'best' ? `${SPEECH_TIER_NAMES.best} (slow)` : SPEECH_TIER_NAMES[tier])

/** "60 megabytes": a size as a screen reader reads it (decimal, like sizeWords). */
export function sizeSpoken(bytes: number): string {
  const words = sizeWords(bytes)
  return words.endsWith(' GB') ? words.replace(/ GB$/, ' gigabytes') : words.replace(/ MB$/, ' megabytes')
}

/** "60 megabyte": a size used as an adjective ("a 60 megabyte download"). */
const sizeAdjective = (bytes: number): string => sizeSpoken(bytes).replace(/s$/, '')

/** "45 s", "20 min", "1 h 5 min": a recording's length in words. */
export function lengthWords(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  if (s < 60) return `${Math.max(1, Math.round(s))} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** "42 s", "3 min 10 s", "1 h 4 min": how long a finished job took. */
export function tookWords(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** "about 10 s left", "about 3 min left": the time left of a download or a job. */
export function leftWords(seconds: number): string {
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))} s left`
  return `${durationWords(seconds)} left`
}

/** "21 of 60 MB": received and total in whole megabytes. */
export const ofMB = (received: number, total: number): string => `${Math.round(received / 1e6)} of ${Math.round(total / 1e6)} MB`

/** The fixed sentences. */
export const SPEECH_COPY = {
  checking: 'Checking this PC…',
  localOption: 'On this PC (free, private)',
  localOnly: 'Captions are made on this PC: free, and nothing is uploaded.',
  qualityLabel: 'Quality',
  manageModels: 'Manage speech models…',
  compatibleBuild: "This PC's processor runs the speech engine in a slower mode, so captions take longer. Fast is suggested.",
  languageHint: 'Smaller models make more mistakes in languages other than English. If accuracy matters, choose Accurate.',
  languageHintDone: 'Smaller models make more mistakes in languages other than English. If these captions need many fixes, try Accurate.',
  consentTitle: 'Make captions on this PC',
  smallPrint: 'Whisper by OpenAI, MIT licence · huggingface.co/ggerganov/whisper.cpp',
  preferCloud: 'Prefer the cloud? Use your own OpenAI or Gemini key…',
  checkAgain: 'Check again',
  offline: (size: string): string => `This PC is offline. Connect to download the speech model (${size}); once downloaded, captions work offline.`,
  downloadNote: 'Captions start as soon as it is here. You can keep editing.',
  verifying: 'Checking the download…',
  cancel: 'Cancel',
  readyHint: 'Runs on this PC: nothing is uploaded and it costs nothing.',
  generate: 'Generate captions',
  generateAgain: 'Generate captions again',
  chooseAnother: 'Choose another tier',
  useProvider: 'Use an AI provider instead',
  tryAgain: 'Try again',
  runningNote: 'You can keep editing. Closing this recording stops the captions; Generate captions continues from there next time.',
  workingOutLeft: 'Working out the time left…',
  cloudErrorOffer: 'Or make them on this PC: free, and nothing is uploaded.',
  useLocal: 'Use On this PC',
  intro:
    "Captions put what you say on the video, so it is understood with the sound off. Flown makes them from the recording's sound: free on this PC, or with an AI provider of your choice. You can then fix the text, restyle them, translate them and export them as subtitles.",
  noSound: 'This recording has no sound to transcribe.',
  downloadBar: 'Speech model download',
  jobBar: 'Captions made',
  /** Settings › Captions on this PC. */
  settingsTitle: 'Captions on this PC',
  settingsLead:
    'Make captions without an API key. The speech model runs on this PC, so the sound never leaves it and nothing is billed. Each model is downloaded once from Hugging Face and checked before it is used.',
  settingsRadios: 'Model used for new captions',
  recommended: 'Recommended',
  downloaded: 'Downloaded',
  checkingRow: 'Checking…',
  damaged: 'Damaged',
  downloadAgain: 'Download again',
  continue: 'Continue',
  delete: 'Delete',
  remove: 'Remove',
  inUse: 'In use: captions are being made with it.',
  showFolder: 'Show folder',
  licenceLine: `Whisper by OpenAI (MIT licence), converted by the whisper.cpp project · huggingface.co/${SPEECH_MODEL_REPO.repo} (${SPEECH_MODEL_REPO.commit.slice(0, 7)})`,
  aiProvidersNoKey: 'No key? Captions can also be made on this PC, free and offline (see Captions on this PC below).',
  /** About › Third-party notices. */
  notices: 'Third-party notices',
  noticesLoading: 'Loading…',
  noticesFailed: (message: string): string => `The third-party notices could not be shown: ${message.replace(/[.\s]+$/, '')}`,
  /** The editor's notices while another tab is open. */
  jobFailedNotice: 'Captions could not be made: open the Captions tab for details.',
  downloadFailedNotice: 'The speech model could not be downloaded: open the Captions tab for details.',
  /** The Bangla model (docs/design/offline-captions.md §14). */
  banglaConsentTitle: 'Make Bangla captions on this PC',
  banglaHint: 'For Bangla, choose Bangla: it makes far fewer mistakes.',
  banglaDetect: 'Speaking Bangla? Choose Bengali to use the Bangla model.',
  chooseBengali: 'Choose Bengali',
  banglaOffer:
    'Bangla captions: the Bangla model gets about 4 in 5 words right, where the other tiers get most Bangla words wrong. It runs on this PC and works offline once downloaded.',
  banglaAgain: 'Make them again with Bangla (downloaded)',
  /** Bengali chosen with an AI provider: the Bangla model on this PC is offered, never switched to by itself. */
  banglaForKeyUsers: 'For Bangla, the Bangla model on this PC makes far fewer mistakes, free and offline.',
  useBanglaModel: 'Use the Bangla model',
  readyHintBangla: 'Runs on this PC with the Bangla model: nothing is uploaded and it costs nothing.'
} as const

/** "The Bangla model is not offered on this PC: Needs about 1.3 GB of memory …". */
export const banglaBlockedLine = (reason: string): string => `The Bangla model is not offered on this PC: ${reason}`

/** The consent card's title for `id` (the Bangla model's names its language). */
export const consentTitle = (id: SpeechModelId): string => (isLanguageModel(speechModel(id)) ? SPEECH_COPY.banglaConsentTitle : SPEECH_COPY.consentTitle)

/** The consent card's small print: where the model comes from and its licence. */
export function smallPrint(id: SpeechModelId): string {
  const spec = speechModel(id)!
  if (!spec.repo) return SPEECH_COPY.smallPrint
  return `${spec.name}, ${spec.license.name} licence · huggingface.co/${spec.repo.repo}`
}

/** Settings' licence line of a model (the Whisper models share SPEECH_COPY.licenceLine). */
export function licenceLine(id: SpeechModelId): string {
  const spec = speechModel(id)!
  if (!spec.repo) return SPEECH_COPY.licenceLine
  return `${spec.name} (${spec.license.name} licence) by ${spec.license.holder} · huggingface.co/${spec.repo.repo} (${spec.repo.commit.slice(0, 7)})`
}

/** The purpose of each tier, under the chips (`settings`: Settings' wording for Most accurate). */
export function tierPurpose(tier: SpeechTier, settings = false): string {
  switch (tier) {
    case 'fast':
      return 'Quickest; for slower PCs. Less accurate with accents and noise.'
    case 'standard':
      return 'Recommended for most recordings.'
    case 'accurate':
      return 'More accurate, also for other languages; about 3.7 times slower than Standard.'
    case 'best':
      return settings ? 'Most accurate, but slower than real time on most PCs.' : 'Most accurate, but slower than playing the recording on most PCs.'
    case 'bangla':
      return settings
        ? 'Bangla only: used whenever the spoken language is Bengali, never for other languages. Far fewer mistakes in Bangla than the other models.'
        : 'Made for Bangla: far fewer mistakes than the other tiers, which get most Bangla words wrong.'
  }
}

/* ---------- the Captions tab ---------- */

/** A quality chip: its visible label and its accessible name ("Fast · 44 MB" / "Fast, 44 megabyte download"). */
export function chipLabel(m: Pick<SpeechModelView, 'tier' | 'bytes' | 'status'>): { label: string; name: string } {
  const tier = chipTier(m.tier)
  if (m.status.state === 'installed') return { label: `${tier} · ${SPEECH_COPY.downloaded}`, name: `${tier}, downloaded` }
  return { label: `${tier} · ${sizeWords(m.bytes)}`, name: `${tier}, ${sizeAdjective(m.bytes)} download` }
}

/** "Downloaded · about 3 min for this recording" / "190 MB download · about 10 min for this recording". */
export function estimateLine(m: Pick<SpeechModelView, 'bytes' | 'status'>, seconds: number): string {
  const what = m.status.state === 'installed' ? SPEECH_COPY.downloaded : `${sizeWords(m.bytes)} download`
  return `${what} · ${durationWords(seconds)} for this recording`
}

/** "Slower than playing the recording: about 38 min for this one." */
export const slowerLine = (seconds: number): string => `Slower than playing the recording: ${durationWords(seconds)} for this one.`

/** The consent card's body (for the Bangla model: why it is recommended for Bangla). */
export function consentBody(id: SpeechModelId, recordingSeconds: number, estimate: number): string {
  const spec = speechModel(id)!
  const then = `Then this ${lengthWords(recordingSeconds)} recording takes ${durationWords(estimate)}.`
  if (isLanguageModel(spec))
    return `Recommended for Bangla: the Bangla model gets about 4 in 5 words right, where the other tiers get most Bangla words wrong. Free and private: it runs on this PC and works offline once downloaded; the sound never leaves this PC. Flown first downloads it once (${sizeWords(spec.bytes)}, from Hugging Face) and checks it before use. ${then}`
  return `Free and private: the sound never leaves this PC, and no key or account is needed. Flown first downloads the speech model for ${tierLabel(id)} once (${sizeWords(spec.bytes)}, from Hugging Face) and checks it before use. ${then}`
}

/** The consent card's one primary button: visible text and accessible name ("Download Bangla model (539 MB) and make captions" for the Bangla model). */
export function downloadButton(id: SpeechModelId): { label: string; name: string } {
  const spec = speechModel(id)!
  return {
    label: isLanguageModel(spec) ? `Download ${tierName(id)} model (${sizeWords(spec.bytes)}) and make captions` : `Download ${sizeWords(spec.bytes)} and make captions`,
    name: `Download ${tierName(id)} (${spec.name}), ${sizeSpoken(spec.bytes)}, and make captions`
  }
}

/** "Make them now with Standard (downloaded)". */
export const useInstalledLabel = (id: SpeechModelId): string => `Make them now with ${tierName(id)} (downloaded)`

/** Not enough space for a download. */
export const diskLine = (id: SpeechModelId, free: number): string => `Not enough free space: the model needs ${sizeWords(speechModel(id)!.bytes)} and the disk has ${sizeWords(free)} free.`

/** Why `id` cannot be downloaded now: the main process downloads one speech model at a time. */
export const downloadBusyLine = (busy: SpeechModelId, id: SpeechModelId): string =>
  `${tierLabel(busy)} is downloading, and one speech model downloads at a time: download ${tierName(id)} once it is done.`

/** Free space a download of `id` needs: the bytes not here yet and the 64 MiB the main process keeps spare (download.ts). */
export const downloadSpaceNeeded = (id: SpeechModelId, received = 0): number => Math.max(0, speechModel(id)!.bytes - received) + 64 * 2 ** 20

/** "Downloading Standard (Whisper base)… 21 of 60 MB · 4.2 MB/s · about 10 s left". */
export function downloadingLine(id: SpeechModelId, status: Extract<SpeechModelStatus, { state: 'downloading' }>): string {
  const parts = [`Downloading ${tierLabel(id)}… ${ofMB(status.received, status.total)}`]
  if (status.bytesPerSecond > 0) {
    parts.push(`${(status.bytesPerSecond / 1e6).toFixed(1)} MB/s`)
    parts.push(leftWords(Math.max(0, status.total - status.received) / status.bytesPerSecond))
  }
  return parts.join(' · ')
}

/** "The connection dropped: trying again (2 of 3)…". */
export const retryingLine = (retrying: { attempt: number; of: number }): string => `The connection dropped: trying again (${retrying.attempt} of ${retrying.of})…`

/** "Download stopped at 21 of 60 MB." */
export const stoppedLine = (status: { received: number; total: number }): string => `Download stopped at ${ofMB(status.received, status.total)}.`
export const continueDownload = 'Continue download and make captions'
/** "Delete the 21 MB downloaded". */
export const deletePartLabel = (received: number): string => `Delete the ${sizeWords(received)} downloaded`

/** The button a failed download offers. */
export type DownloadFailAction = 'try-again' | 'check-again' | 'choose-tier'

/** "The speech model could not be downloaded: {reason}" and the button(s) for it. */
export function downloadFailed(id: SpeechModelId, status: Extract<SpeechModelStatus, { state: 'failed' }>, free: number | null): { text: string; action: DownloadFailAction } {
  const reason = ((): { text: string; action: DownloadFailAction } => {
    switch (status.error as SpeechDownloadError) {
      case 'network':
        return {
          text:
            status.received > 0
              ? `Flown could not reach huggingface.co. Check the internet connection; the ${sizeWords(status.received)} already here are kept.`
              : 'Flown could not reach huggingface.co. Check the internet connection.',
          action: 'try-again'
        }
      case 'http':
        return { text: `Hugging Face answered with an error (HTTP ${status.status ?? '?'}). Try again later.`, action: 'try-again' }
      case 'refused':
        return { text: 'Hugging Face or your network refused the download (HTTP 403). A proxy or firewall may be blocking it.', action: 'try-again' }
      case 'missing':
        return { text: `${tierLabel(id)} is no longer where this version of Flown downloads it from. Updating Flown fixes this.`, action: 'choose-tier' }
      case 'mismatch':
        return { text: 'The downloaded file was not the expected one, so it was deleted and not used.', action: 'try-again' }
      case 'disk': {
        // The main process keeps this failure until a new download starts: Check again only while
        // the disk is still too full, then Try again (also when the free space cannot be read).
        const size = sizeWords(speechModel(id)!.bytes)
        if (free === null) return { text: `Not enough free space: the model needs ${size}.`, action: 'try-again' }
        if (free < downloadSpaceNeeded(id, status.received)) return { text: diskLine(id, free), action: 'check-again' }
        return { text: `There was not enough free space: the model needs ${size}. The disk now has ${sizeWords(free)} free.`, action: 'try-again' }
      }
      default:
        return { text: status.message || 'Something went wrong.', action: 'try-again' }
    }
  })()
  return { text: `The speech model could not be downloaded: ${reason.text}`, action: reason.action }
}

/** The memory warning of Accurate, Most accurate and Bangla, or null when there is enough free memory. */
export function memoryWarning(id: SpeechModelId, freeBytes: number): string | null {
  const spec = speechModel(id)!
  if (spec.tier !== 'accurate' && spec.tier !== 'best' && spec.tier !== 'bangla') return null
  const need = memoryNeedMB(spec) * 1e6
  if (!(freeBytes < need)) return null
  const quicker = quickerModel(id)
  const what = `${tierName(id)} needs about ${sizeWords(need)} of free memory; this PC has ${sizeWords(freeBytes)} free right now.`
  // The Bangla model has no quicker tier: the others get most Bangla words wrong.
  if (isLanguageModel(spec)) return `${what} Close other apps first.`
  return `${what} Close other apps or choose ${quicker ? SPEECH_TIER_NAMES[quicker.tier] : 'a quicker tier'}.`
}

/** The running job's phase. */
export type LocalPhase = 'loading' | 'preparing' | 'transcribing' | 'finishing' | 'stopping'

/** The phase line ("Making captions on this PC… 8:30 of 20:00"). */
export function phaseLine(phase: LocalPhase, at?: number, duration?: number): string {
  switch (phase) {
    case 'loading':
      return 'Loading the speech model…'
    case 'preparing':
      return 'Preparing the sound…'
    case 'transcribing':
      return at !== undefined && duration !== undefined ? `Making captions on this PC… ${formatTime(at, false)} of ${formatTime(duration, false)}` : 'Making captions on this PC…'
    case 'finishing':
      return 'Finishing…'
    case 'stopping':
      return 'Stopping…'
  }
}

/** What the hidden live region says: the phase, and the share done in steps of 25 %. */
export function announceLine(phase: LocalPhase, quarter: number): string {
  const name = phaseLine(phase).replace(/…$/, '')
  return quarter > 0 && phase === 'transcribing' ? `${name}: ${quarter * 25} percent` : name
}

/** "42 percent, about 3 min left": the progress bar's text. */
export const barText = (share: number, left: number | null): string => `${Math.round(share * 100)} percent${left === null ? '' : `, ${leftWords(left)}`}`

/** "Heard: “…”" with the newest words. */
export const heardLine = (preview: string): string => `Heard: “${preview.trim()}”`

/** "Continuing: 3 of 6 parts were already done." */
export const resumedLine = (resumed: number, parts: number): string => `Continuing: ${resumed} of ${parts} parts were already done.`

/** "Stopped. 3 of 6 parts are kept: Generate captions continues from there." */
export const cancelledLine = (kept: number, parts: number): string => `Stopped. ${kept} of ${parts} parts are kept: Generate captions continues from there.`

/** "Download again (60 MB)", "Use Fast": the button an error offers. */
export const downloadAgainLabel = (id: SpeechModelId): string => `Download again (${sizeWords(speechModel(id)!.bytes)})`
export const useTierLabel = (id: SpeechModelId): string => `Use ${tierName(id)}`

/** The summary of captions made on this PC. */
export function doneLine(opts: { count: number; model: string; language: string | null; detected?: boolean; took?: number }): string {
  const name = speechModel(opts.model)?.name ?? opts.model
  const n = `${opts.count} ${opts.count === 1 ? 'caption' : 'captions'}`
  const lang = opts.language ? ` (${opts.language}${opts.detected ? ', detected' : ''})` : ''
  if (opts.took === undefined) return `${n} made on this PC with ${name}${lang}.`
  return `${n} made on this PC with ${name}${lang} in ${tookWords(opts.took)}. Nothing was uploaded.`
}

/** "Not English?" */
export const notLanguage = (language: string): string => `Not ${language}?`

/** "Captions ready: 12 captions made on this PC in 42 s. Undo removes them." */
export const readyNotice = (count: number, took: number): string => `Captions ready: ${count} ${count === 1 ? 'caption' : 'captions'} made on this PC in ${tookWords(took)}. Undo removes them.`

/** The Captions tab's ring while a download or a job of this project runs. */
export function badgeTitle(phase: 'download' | 'verify' | 'job', share: number | null): string {
  const pct = share === null ? '' : `, ${Math.round(share * 100)} %`
  if (phase === 'download') return `Captions: downloading the speech model${pct}`
  if (phase === 'verify') return 'Captions: checking the download'
  return `Captions: making captions${pct}`
}

/** "Captions on this PC are not available here: …." */
export const unavailableLine = (reason: keyof typeof UNAVAILABLE_REASONS | undefined): string => localErrorMessage('unavailable', { reason })

/* ---------- Settings ---------- */

/** "Whisper base · Standard"; "Bengali.AI Whisper medium · Bangla only" for the Bangla model. */
export const rowTitle = (m: Pick<SpeechModelView, 'name' | 'tier'>): string => `${m.name} · ${SPEECH_TIER_NAMES[m.tier]}${m.tier === 'bangla' ? ' only' : ''}`

/** "60 MB download · about 1 min per 10 minutes of recording on this PC · about 399 MB of memory". */
export function rowFacts(m: SpeechModelView, per10Seconds: number): string {
  const measured = m.measured ? ' (measured on this PC)' : ''
  return `${sizeWords(m.bytes)} download · ${durationWords(per10Seconds)} per 10 minutes of recording on this PC${measured} · about ${sizeWords(memoryNeedMB(m) * 1e6)} of memory`
}

/** A row's status text in Settings. */
export function rowStatus(m: SpeechModelView, free: number | null): string | null {
  const s = m.status
  switch (s.state) {
    case 'missing':
      return null
    case 'downloading':
      return s.retrying ? retryingLine(s.retrying) : `Downloading… ${s.total > 0 ? Math.floor((s.received / s.total) * 100) : 0} % · ${ofMB(s.received, s.total)}${s.bytesPerSecond > 0 ? ` · ${(s.bytesPerSecond / 1e6).toFixed(1)} MB/s` : ''}`
    case 'verifying':
      return SPEECH_COPY.checkingRow
    case 'stopped':
      return `Stopped at ${ofMB(s.received, s.total)}`
    case 'installed':
      return SPEECH_COPY.downloaded
    case 'damaged':
      return SPEECH_COPY.damaged
    case 'failed':
      return `Download failed: ${downloadFailed(m.id, s, free).text.replace(/^The speech model could not be downloaded: /, '')}`
  }
}

/** "Download 60 MB" with its accessible name. */
export const rowDownload = (m: Pick<SpeechModelView, 'name' | 'bytes'>): { label: string; name: string } => ({
  label: `Download ${sizeWords(m.bytes)}`,
  name: `Download ${m.name}, ${sizeSpoken(m.bytes)}`
})

/** The inline Remove question. */
export const removeQuestion = (m: Pick<SpeechModelView, 'name' | 'bytes'>): string => `Remove ${m.name}? It frees ${sizeWords(m.bytes)}. Captions you already made stay.`
/** "Remove Whisper small, frees 190 megabytes". */
export const removeName = (m: Pick<SpeechModelView, 'name' | 'bytes'>): string => `Remove ${m.name}, frees ${sizeSpoken(m.bytes)}`

/** Why a row cannot be downloaded (the view's reason, else the catalog's). */
export function blockedLine(m: SpeechModelView, state: Pick<SpeechState, 'memory' | 'engine'>): string | null {
  if (m.allowed) return null
  if (m.reason) return m.reason
  const spec = speechModel(m.id)!
  return modelBlockReason(state.engine.build === 'compatible' && spec.needsStandardBuild ? 'processor' : 'memory', spec, state.memory.total)
}

/** "Speech engine: ready" / "… (compatible mode for this processor: slower)" / "not available (…)". */
export function engineLine(engine: SpeechState['engine']): string {
  if (!engine.available) return `Speech engine: not available (${UNAVAILABLE_REASONS[engine.reason ?? 'failed']})`
  return engine.build === 'compatible' ? 'Speech engine: ready (compatible mode for this processor: slower)' : 'Speech engine: ready'
}

/** The speech detector's line. */
export function detectorLine(detector: SpeechState['detector']): string {
  if (detector.available)
    return 'Speech detector: built in (Silero VAD). Remove silences, Smart speed, music ducking and the camera director listen for speech, so typing and fans do not count as sound.'
  const why = (detector.reason ?? 'it did not start').replace(/[.\s]+$/, '')
  return `Speech detector: not available on this PC (${why.charAt(0).toLowerCase()}${why.slice(1)}), so these use sound levels instead.`
}

/** "Speech models use 60 MB · 120 GB free on this drive". */
export const diskFooter = (disk: SpeechState['disk']): string => `Speech models use ${sizeWords(disk.used)}${disk.free === null ? '' : ` · ${sizeWords(disk.free)} free on this drive`}`

/* ---------- Clip and Audio tabs ---------- */

/** The Clip tab's line on what counts as sound (`systemStem`: the recording kept PC sound apart). */
export function detectorStatus(detector: SoundDetector, systemStem: boolean): string {
  switch (detector) {
    case 'speech':
      return `Listening for your voice: typing, clicks and room noise on the microphone do not count.${systemStem ? ' Sound your PC plays still counts.' : ''}`
    case 'mixed':
      return 'Listening for speech and any other sound: this recording has no separate microphone track.'
    case 'guard':
      return 'No speech was found on the microphone, so sound levels are used.'
    case 'level':
      return 'Listening for any sound: the speech detector is not available, so typing counts as sound too.'
  }
}

/** Hints when the voice counts (the speech detector ran on the microphone). */
export const SILENCES_VOICE_HINT = 'Cuts or speeds up the pauses in your talking, keeping a little of the silence next to the sound so no word is clipped.'
export const IDLE_VOICE_HINT =
  'Speeds up or cuts the parts where nothing happens: the picture stays still, you are not talking and your PC plays no sound, and you did not move, click, scroll or type.'
export const DUCKING_VOICE_HINT = 'How far the music dips while you talk or your PC plays sound.'
