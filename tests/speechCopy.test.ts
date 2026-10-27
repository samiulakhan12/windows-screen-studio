import { describe, expect, it } from 'vitest'
import type { SpeechDownloadError, SpeechModelView, SpeechState, SpeechUnavailable } from '../src/shared/api/speech'
import type { SoundDetector } from '../src/shared/audio/voice'
import { SPEECH_MODELS, SPEECH_TIER_NAMES, speechModel, type SpeechModelId } from '../src/shared/speech/catalog'
import { UNAVAILABLE_REASONS } from '../src/shared/speech/errors'
import * as copy from '../src/shared/speech/speechCopy'

/* The renderer's copy for captions on this PC (docs/design/offline-captions.md §7). */

const view = (id: SpeechModelId, status: SpeechModelView['status'] = { state: 'missing' }, over: Partial<SpeechModelView> = {}): SpeechModelView => {
  const s = speechModel(id)!
  return { id, tier: s.tier, name: s.name, bytes: s.bytes, rtf4: s.rtf4, ramMB: s.ramMB, wer: s.wer, partSeconds: s.partSeconds, license: s.license, status, inUse: false, allowed: true, ...over }
}
const ids = SPEECH_MODELS.map((m) => m.id)

/** Every sentence of the Captions tab that names a model also names its tier, first. */
function namesTierFirst(text: string): void {
  for (const m of SPEECH_MODELS) {
    const at = text.indexOf(m.name)
    if (at < 0) continue
    const tier = SPEECH_TIER_NAMES[m.tier]
    expect(text.indexOf(tier), text).toBeGreaterThanOrEqual(0)
    expect(text.indexOf(tier), text).toBeLessThan(at)
  }
}

describe('the Captions tab names a model by its tier first', () => {
  it('every sentence that names a model also names its tier', () => {
    for (const id of ids) {
      namesTierFirst(copy.consentBody(id, 1200, 180))
      namesTierFirst(copy.downloadButton(id).label)
      namesTierFirst(copy.downloadButton(id).name)
      namesTierFirst(copy.useInstalledLabel(id))
      namesTierFirst(copy.downloadBusyLine(id, 'whisper-base'))
      namesTierFirst(copy.downloadingLine(id, { state: 'downloading', received: 21e6, total: 60e6, bytesPerSecond: 4.2e6 }))
      namesTierFirst(copy.downloadFailed(id, { state: 'failed', received: 0, total: 0, error: 'missing', message: '' }, null).text)
      namesTierFirst(copy.memoryWarning(id, 1e6) ?? '')
      namesTierFirst(copy.downloadAgainLabel(id))
      namesTierFirst(copy.useTierLabel(id))
      namesTierFirst(copy.chipLabel(view(id)).label)
    }
  })

  it('the consent card with the tier, the size and the estimate', () => {
    expect(copy.consentBody('whisper-base', 1200, 157)).toBe(
      'Free and private: the sound never leaves this PC, and no key or account is needed. Flown first downloads the speech model for Standard (Whisper base) once (60 MB, from Hugging Face) and checks it before use. Then this 20 min recording takes about 3 min.'
    )
    expect(copy.downloadButton('whisper-base')).toEqual({ label: 'Download 60 MB and make captions', name: 'Download Standard (Whisper base), 60 megabytes, and make captions' })
    expect(copy.downloadButton('whisper-tiny').label).toBe('Download 44 MB and make captions')
    expect(copy.useInstalledLabel('whisper-base')).toBe('Make them now with Standard (downloaded)')
  })

  it('chips carry their size or "Downloaded" in the visible label and the accessible name', () => {
    expect(copy.chipLabel(view('whisper-tiny'))).toEqual({ label: 'Fast · 44 MB', name: 'Fast, 44 megabyte download' })
    expect(copy.chipLabel(view('whisper-base', { state: 'installed' }))).toEqual({ label: 'Standard · Downloaded', name: 'Standard, downloaded' })
    expect(copy.chipLabel(view('whisper-small')).label).toBe('Accurate · 190 MB')
    expect(copy.chipLabel(view('whisper-turbo', { state: 'installed' })).label).toBe('Most accurate (slow) · Downloaded')
  })

  it('the estimate line, the slow-PC lines and the purposes', () => {
    expect(copy.estimateLine(view('whisper-base', { state: 'installed' }), 157)).toBe('Downloaded · about 3 min for this recording')
    expect(copy.estimateLine(view('whisper-small'), 580)).toBe('190 MB download · about 10 min for this recording')
    expect(copy.slowerLine(2255)).toBe('Slower than playing the recording: about 38 min for this one.')
    expect(copy.SPEECH_COPY.compatibleBuild).toBe("This PC's processor runs the speech engine in a slower mode, so captions take longer. Fast is suggested.")
    for (const tier of ['fast', 'standard', 'accurate', 'best'] as const) {
      expect(copy.tierPurpose(tier).length).toBeGreaterThan(10)
      expect(copy.tierPurpose(tier, true).length).toBeGreaterThan(10)
    }
    expect(copy.tierPurpose('best')).toBe('Most accurate, but slower than playing the recording on most PCs.')
    expect(copy.tierPurpose('best', true)).toBe('Most accurate, but slower than real time on most PCs.')
  })
})

describe('every state has its copy', () => {
  it('downloading, retrying, stopped', () => {
    expect(copy.downloadingLine('whisper-base', { state: 'downloading', received: 21e6, total: 60e6, bytesPerSecond: 4.2e6 })).toBe(
      'Downloading Standard (Whisper base)… 21 of 60 MB · 4.2 MB/s · about 9 s left'
    )
    expect(copy.retryingLine({ attempt: 2, of: 3 })).toBe('The connection dropped: trying again (2 of 3)…')
    expect(copy.stoppedLine({ received: 21e6, total: 60e6 })).toBe('Download stopped at 21 of 60 MB.')
    expect(copy.deletePartLabel(21e6)).toBe('Delete the 21 MB downloaded')
    expect(copy.continueDownload).toBe('Continue download and make captions')
    expect(copy.downloadBusyLine('whisper-base', 'whisper-tiny')).toBe('Standard (Whisper base) is downloading, and one speech model downloads at a time: download Fast once it is done.')
  })

  it('every download failure', () => {
    const fail = (error: SpeechDownloadError, received = 0, status?: number, message = ''): ReturnType<typeof copy.downloadFailed> =>
      copy.downloadFailed('whisper-base', { state: 'failed', received, total: 60e6, error, status, message }, 1e9)
    expect(fail('network', 21e6).text).toBe(
      'The speech model could not be downloaded: Flown could not reach huggingface.co. Check the internet connection; the 21 MB already here are kept.'
    )
    expect(fail('network').text).toBe('The speech model could not be downloaded: Flown could not reach huggingface.co. Check the internet connection.')
    expect(fail('http', 0, 500).text).toBe('The speech model could not be downloaded: Hugging Face answered with an error (HTTP 500). Try again later.')
    expect(fail('refused').text).toContain('(HTTP 403). A proxy or firewall may be blocking it.')
    expect(fail('missing')).toEqual({
      text: 'The speech model could not be downloaded: Standard (Whisper base) is no longer where this version of Flown downloads it from. Updating Flown fixes this.',
      action: 'choose-tier'
    })
    expect(fail('mismatch').text).toBe('The speech model could not be downloaded: The downloaded file was not the expected one, so it was deleted and not used.')
    // Still too little space: Check again reads it again; once there is room, Try again downloads (UI-1).
    expect(copy.downloadFailed('whisper-base', { state: 'failed', received: 0, total: 60e6, error: 'disk', message: '' }, 50e6)).toEqual({
      text: 'The speech model could not be downloaded: Not enough free space: the model needs 60 MB and the disk has 50 MB free.',
      action: 'check-again'
    })
    expect(fail('disk')).toEqual({
      text: 'The speech model could not be downloaded: There was not enough free space: the model needs 60 MB. The disk now has 1.0 GB free.',
      action: 'try-again'
    })
    // What is already here counts: 40 of 60 MB received needs 20 MB and the spare.
    expect(copy.downloadFailed('whisper-base', { state: 'failed', received: 40e6, total: 60e6, error: 'disk', message: '' }, 100e6).action).toBe('try-again')
    // The free space cannot be read: reading it again would not help, so Try again.
    expect(copy.downloadFailed('whisper-base', { state: 'failed', received: 0, total: 60e6, error: 'disk', message: '' }, null)).toEqual({
      text: 'The speech model could not be downloaded: Not enough free space: the model needs 60 MB.',
      action: 'try-again'
    })
    expect(fail('other', 0, undefined, 'Boom.').text).toBe('The speech model could not be downloaded: Boom.')
    for (const e of ['network', 'http', 'refused', 'mismatch', 'other'] as const) expect(fail(e).action).toBe('try-again')
  })

  it('ready, running, cancelled, done', () => {
    expect(copy.SPEECH_COPY.readyHint).toBe('Runs on this PC: nothing is uploaded and it costs nothing.')
    expect(copy.memoryWarning('whisper-base', 1e6)).toBeNull()
    expect(copy.memoryWarning('whisper-small', 10e9)).toBeNull()
    expect(copy.memoryWarning('whisper-small', 400e6)).toBe('Accurate needs about 626 MB of free memory; this PC has 400 MB free right now. Close other apps or choose Standard.')
    expect(copy.phaseLine('loading')).toBe('Loading the speech model…')
    expect(copy.phaseLine('preparing')).toBe('Preparing the sound…')
    expect(copy.phaseLine('transcribing', 510, 1200)).toBe('Making captions on this PC… 8:30 of 20:00')
    expect(copy.phaseLine('finishing')).toBe('Finishing…')
    expect(copy.phaseLine('stopping')).toBe('Stopping…')
    expect(copy.announceLine('transcribing', 2)).toBe('Making captions on this PC: 50 percent')
    expect(copy.barText(0.42, 180)).toBe('42 percent, about 3 min left')
    expect(copy.heardLine(' four score ')).toBe('Heard: “four score”')
    expect(copy.resumedLine(3, 6)).toBe('Continuing: 3 of 6 parts were already done.')
    expect(copy.cancelledLine(1, 3)).toBe('Stopped. 1 of 3 parts are kept: Generate captions continues from there.')
    expect(copy.doneLine({ count: 12, model: 'whisper-tiny', language: 'English', detected: true, took: 42 })).toBe(
      '12 captions made on this PC with Whisper tiny (English, detected) in 42 s. Nothing was uploaded.'
    )
    expect(copy.doneLine({ count: 12, model: 'whisper-tiny', language: 'English', detected: false, took: 190 })).toBe(
      '12 captions made on this PC with Whisper tiny (English) in 3 min 10 s. Nothing was uploaded.'
    )
    expect(copy.doneLine({ count: 1, model: 'whisper-base', language: 'German' })).toBe('1 caption made on this PC with Whisper base (German).')
    expect(copy.notLanguage('English')).toBe('Not English?')
    expect(copy.readyNotice(12, 42)).toBe('Captions ready: 12 captions made on this PC in 42 s. Undo removes them.')
    expect(copy.badgeTitle('download', 0.35)).toBe('Captions: downloading the speech model, 35 %')
    expect(copy.badgeTitle('verify', null)).toBe('Captions: checking the download')
    expect(copy.badgeTitle('job', 0.42)).toBe('Captions: making captions, 42 %')
  })

  it('every reason the engine is unavailable', () => {
    for (const reason of Object.keys(UNAVAILABLE_REASONS) as SpeechUnavailable[]) {
      expect(copy.unavailableLine(reason)).toBe(`Captions on this PC are not available here: ${UNAVAILABLE_REASONS[reason]}.`)
      expect(copy.engineLine({ available: false, build: null, threads: 1, reason })).toBe(`Speech engine: not available (${UNAVAILABLE_REASONS[reason]})`)
    }
    expect(copy.engineLine({ available: true, build: 'standard', threads: 3 })).toBe('Speech engine: ready')
    expect(copy.engineLine({ available: true, build: 'compatible', threads: 3 })).toBe('Speech engine: ready (compatible mode for this processor: slower)')
  })

  it('Settings rows', () => {
    const state = { memory: { total: 4 * 2 ** 30, free: 1e9 }, engine: { available: true, build: 'standard', threads: 3 } } as Pick<SpeechState, 'memory' | 'engine'>
    expect(copy.rowTitle(view('whisper-base'))).toBe('Whisper base · Standard')
    expect(copy.rowFacts(view('whisper-base'), 47)).toBe('60 MB download · under 1 min per 10 minutes of recording on this PC · about 399 MB of memory')
    expect(copy.rowFacts(view('whisper-base', undefined, { measured: { rtf: 0.1, threads: 3 } }), 60)).toContain('on this PC (measured on this PC)')
    expect(copy.rowStatus(view('whisper-base', { state: 'downloading', received: 20e6, total: 60e6, bytesPerSecond: 4.2e6 }), null)).toBe('Downloading… 33 % · 20 of 60 MB · 4.2 MB/s')
    expect(copy.rowStatus(view('whisper-base', { state: 'stopped', received: 20e6, total: 60e6 }), null)).toBe('Stopped at 20 of 60 MB')
    expect(copy.rowStatus(view('whisper-base', { state: 'verifying' }), null)).toBe('Checking…')
    expect(copy.rowStatus(view('whisper-base', { state: 'installed' }), null)).toBe('Downloaded')
    expect(copy.rowStatus(view('whisper-base', { state: 'damaged' }), null)).toBe('Damaged')
    expect(copy.rowStatus(view('whisper-base', { state: 'failed', received: 0, total: 0, error: 'refused', message: '' }), null)).toMatch(/^Download failed: Hugging Face or your network refused/)
    expect(copy.rowDownload(view('whisper-small'))).toEqual({ label: 'Download 190 MB', name: 'Download Whisper small, 190 megabytes' })
    expect(copy.removeQuestion(view('whisper-small'))).toBe('Remove Whisper small? It frees 190 MB. Captions you already made stay.')
    expect(copy.removeName(view('whisper-small'))).toBe('Remove Whisper small, frees 190 megabytes')
    expect(copy.blockedLine(view('whisper-turbo', undefined, { allowed: false }), state)).toBe('Needs about 1.1 GB of memory and a PC with 8 GB in all; this one has 4 GB.')
    expect(copy.blockedLine(view('whisper-turbo', undefined, { allowed: false, reason: 'Why.' }), state)).toBe('Why.')
    expect(copy.blockedLine(view('whisper-base'), state)).toBeNull()
    expect(copy.diskFooter({ used: 60e6, free: 120e9 })).toBe('Speech models use 60 MB · 120 GB free on this drive')
    expect(copy.detectorLine({ available: false, reason: 'The helper is missing.' })).toBe('Speech detector: not available on this PC (the helper is missing), so these use sound levels instead.')
    expect(copy.SPEECH_COPY.licenceLine).toBe('Whisper by OpenAI (MIT licence), converted by the whisper.cpp project · huggingface.co/ggerganov/whisper.cpp (5359861)')
  })

  it('every detector of the Clip tab', () => {
    const all: SoundDetector[] = ['speech', 'mixed', 'guard', 'level']
    for (const d of all) expect(copy.detectorStatus(d, false).length).toBeGreaterThan(20)
    expect(copy.detectorStatus('speech', true)).toBe('Listening for your voice: typing, clicks and room noise on the microphone do not count. Sound your PC plays still counts.')
    expect(copy.detectorStatus('speech', false)).toBe('Listening for your voice: typing, clicks and room noise on the microphone do not count.')
  })

  it('sizes and times are inserted in words', () => {
    expect(copy.sizeSpoken(59_707_625)).toBe('60 megabytes')
    expect(copy.sizeSpoken(1.2e9)).toBe('1.2 gigabytes')
    expect(copy.lengthWords(45)).toBe('45 s')
    expect(copy.lengthWords(1200)).toBe('20 min')
    expect(copy.lengthWords(3900)).toBe('1 h 5 min')
    expect(copy.tookWords(3840)).toBe('1 h 4 min')
    expect(copy.leftWords(10)).toBe('about 10 s left')
    expect(copy.leftWords(170)).toBe('about 3 min left')
    expect(copy.SPEECH_COPY.offline('60 MB')).toBe('This PC is offline. Connect to download the speech model (60 MB); once downloaded, captions work offline.')
    expect(copy.diskLine('whisper-small', 50e6)).toBe('Not enough free space: the model needs 190 MB and the disk has 50 MB free.')
    expect(copy.SPEECH_COPY.noticesFailed('Not found.')).toBe('The third-party notices could not be shown: Not found')
  })
})

describe('the Bangla model (docs/design/offline-captions.md §14.4)', () => {
  const bn: SpeechModelId = 'whisper-bn-medium'

  it('recommends it with why, that it works offline, its size and the time for this recording', () => {
    expect(copy.consentTitle(bn)).toBe('Make Bangla captions on this PC')
    expect(copy.consentTitle('whisper-base')).toBe('Make captions on this PC')
    expect(copy.consentBody(bn, 1200, 1724)).toBe(
      'Recommended for Bangla: the Bangla model gets about 4 in 5 words right, where the other tiers get most Bangla words wrong. Free and private: it runs on this PC and works offline once downloaded; the sound never leaves this PC. Flown first downloads it once (539 MB, from Hugging Face) and checks it before use. Then this 20 min recording takes about 29 min.'
    )
    expect(copy.downloadButton(bn)).toEqual({ label: 'Download Bangla model (539 MB) and make captions', name: 'Download Bangla (Bengali.AI Whisper medium), 539 megabytes, and make captions' })
    expect(copy.smallPrint(bn)).toBe('Bengali.AI Whisper medium, Apache-2.0 licence · huggingface.co/winshades/bengaliai-whisper-medium-ggml')
    expect(copy.smallPrint('whisper-base')).toBe(copy.SPEECH_COPY.smallPrint)
  })

  it('its chip, purpose and the lines around it', () => {
    expect(copy.chipLabel(view(bn))).toEqual({ label: 'Bangla · 539 MB', name: 'Bangla, 539 megabyte download' })
    expect(copy.chipLabel(view(bn, { state: 'installed' }))).toEqual({ label: 'Bangla · Downloaded', name: 'Bangla, downloaded' })
    expect(copy.tierPurpose('bangla')).toBe('Made for Bangla: far fewer mistakes than the other tiers, which get most Bangla words wrong.')
    expect(copy.tierPurpose('bangla', true)).toBe('Bangla only: used whenever the spoken language is Bengali, never for other languages. Far fewer mistakes in Bangla than the other models.')
    expect(copy.SPEECH_COPY.banglaHint).toBe('For Bangla, choose Bangla: it makes far fewer mistakes.')
    expect(copy.SPEECH_COPY.banglaDetect).toBe('Speaking Bangla? Choose Bengali to use the Bangla model.')
    expect(copy.banglaBlockedLine('Needs about 1.3 GB of memory and a PC with 8 GB in all; this one has 4 GB.')).toBe(
      'The Bangla model is not offered on this PC: Needs about 1.3 GB of memory and a PC with 8 GB in all; this one has 4 GB.'
    )
    expect(copy.SPEECH_COPY.banglaOffer).toContain('works offline once downloaded')
    expect(copy.SPEECH_COPY.banglaAgain).toBe('Make them again with Bangla (downloaded)')
    expect(copy.SPEECH_COPY.readyHintBangla).toBe('Runs on this PC with the Bangla model: nothing is uploaded and it costs nothing.')
  })

  it('warns about memory without offering a quicker tier, and names it in Settings as Bangla only', () => {
    expect(copy.memoryWarning(bn, 900e6)).toBe('Bangla needs about 1.3 GB of free memory; this PC has 900 MB free right now. Close other apps first.')
    expect(copy.memoryWarning(bn, 2e9)).toBeNull()
    expect(copy.memoryWarning('whisper-small', 300e6)).toBe('Accurate needs about 626 MB of free memory; this PC has 300 MB free right now. Close other apps or choose Standard.')
    expect(copy.rowTitle(view(bn))).toBe('Bengali.AI Whisper medium · Bangla only')
    expect(copy.rowTitle(view('whisper-turbo'))).toBe('Whisper large-v3 turbo · Most accurate')
    expect(copy.licenceLine(bn)).toBe(
      'Bengali.AI Whisper medium (Apache-2.0 licence) by Bengali.AI (the tugstugi team), fine-tuned from OpenAI Whisper; converted to ggml by WinShades · huggingface.co/winshades/bengaliai-whisper-medium-ggml (11cf5cb)'
    )
    expect(copy.licenceLine('whisper-base')).toBe(copy.SPEECH_COPY.licenceLine)
    expect(copy.rowDownload(view(bn))).toEqual({ label: 'Download 539 MB', name: 'Download Bengali.AI Whisper medium, 539 megabytes' })
    expect(copy.downloadingLine(bn, { state: 'downloading', received: 21e6, total: 539e6, bytesPerSecond: 0 })).toBe('Downloading Bangla (Bengali.AI Whisper medium)… 21 of 539 MB')
  })
})
