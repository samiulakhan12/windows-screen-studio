/**
 * Cancels carry a code, not words (docs/design/output-and-languages.md §9.6, step S4b): main throws
 * or rejects a stopped job with the cancel code (CANCELLED_ERROR, its error's name, which Electron
 * hands to the renderer before the message) and errors.cancelled in the UI language; the renderer
 * decides by the code. Each of main's cancel paths here runs in a translated UI (the en-XA
 * pseudo-locale), and its rejection, as the renderer receives it, is a cancel both in that UI and in
 * a renderer that shows English. The renderer's own deciders are held in their tests
 * (captionItems, speechModelsSection, localAiSection, captionsBadge), the transcription and captions
 * on this PC in aiProviders and localClient, and AI on this PC's download in localModels.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '../src/shared/i18n/t'
import { CANCELLED_ERROR, isCancelled } from '../src/shared/jobs/longJobs'
import { ipcRejection, uiEnglish, uiPseudo } from './pseudoUi'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' }, net: {} }))

import { callWithRetry } from '../src/main/ai/request'
import { describeFailure } from '../src/shared/captions/transcriptErrors'
import { downloadPinned, type HttpGet } from '../src/main/speech/download'
import { SpeechModelStore } from '../src/main/speech/models'
import { postToWebhook } from '../src/main/share/webhookPost'

afterEach(uiEnglish)

/** The rejection of `p`. */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (err) {
    return err as Error
  }
  throw new Error('it did not reject')
}

/**
 * `err`, made in a translated UI, says errors.cancelled in that UI and carries the cancel code: as
 * the renderer receives it over `channel` it is a cancel in that UI and in an English one.
 */
function expectCancel(err: Error, channel: string): void {
  expect(err.message).toBe(t('errors.cancelled'))
  expect(err.message).not.toBe('Cancelled.')
  expect(err.name).toBe(CANCELLED_ERROR)
  const received = ipcRejection(channel, err)
  expect(isCancelled(received)).toBe(true)
  uiEnglish()
  expect(isCancelled(received)).toBe(true)
  // The words alone, without the code, never read as a cancel.
  expect(isCancelled(new Error(`Error invoking remote method '${channel}': Error: ${err.message}`))).toBe(false)
}

/** A request that never answers until it is stopped. */
const hang = (s: AbortSignal): Promise<never> => new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))

describe('S4b: main’s cancels carry the code in a translated UI', () => {
  it('an AI request (request.ts): stopped while it waits for the service', async () => {
    uiPseudo()
    const c = new AbortController()
    setTimeout(() => c.abort(), 20)
    const err = await rejectionOf(callWithRetry(hang, { provider: 'OpenAI', toFailure: () => ({ network: true }), timeoutMs: 10_000, attempts: 2, signal: c.signal }))
    expectCancel(err, 'ai:text')
  })

  it('an AI failure read as a cancel (transcriptErrors.ts) says errors.cancelled in the UI language', () => {
    uiPseudo()
    const f = describeFailure({ cancelled: true }, 'OpenAI')
    expect(f).toMatchObject({ kind: 'cancelled', retryable: false, message: t('errors.cancelled') })
    expect(f.message).not.toBe('Cancelled.')
  })

  it('a pinned download (download.ts): stopped while the bytes arrive', async () => {
    uiPseudo()
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-s4d-'))
    try {
      const c = new AbortController()
      const get: HttpGet = async (_url, _h, signal) => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from('partial')
          await hang(signal)
        })()
      })
      setTimeout(() => c.abort(), 30)
      const err = await rejectionOf(downloadPinned({ url: 'https://huggingface.co/x/model.bin', bytes: 1000, sha256: 'a'.repeat(64) }, path.join(dir, 'model.bin'), { get, signal: c.signal, freeBytes: async () => null }))
      expectCancel(err, 'speech:download')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a speech model download (speech/models.ts): Cancel in Settings or the Captions tab', async () => {
    uiPseudo()
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-s4d-'))
    try {
      const slow: HttpGet = async (_url, _h, signal) => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from('partial')
          await hang(signal)
        })()
      })
      const s = new SpeechModelStore(dir, { get: slow, freeBytes: async () => null, baseUrl: 'http://127.0.0.1:1/hf/' })
      const p = s.download('whisper-base')
      await vi.waitFor(() => expect(s.downloading).toBe(true))
      await s.cancelDownload('whisper-base', false)
      expectCancel(await rejectionOf(p), 'speech:download')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a post to a chat (webhookPost.ts): stopped by Cancel on the share', async () => {
    uiPseudo()
    const c = new AbortController()
    const fetch = ((_url: string, init: { signal: AbortSignal }) => hang(init.signal)) as unknown as Parameters<typeof postToWebhook>[4]['fetch']
    setTimeout(() => c.abort(), 20)
    const err = await rejectionOf(postToWebhook('slack', 'https://hooks.slack.com/services/T0001/B0002/secretPART', ['x'], c.signal, { fetch }))
    expectCancel(err, 'share:start')
  })
})
