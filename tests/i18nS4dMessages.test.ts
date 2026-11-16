/**
 * Step S4b: the sentences main's import graph makes for captions on this PC, AI failures and pinned
 * downloads are whole errors messages (docs/design/output-and-languages.md §9.3, §9.6). English
 * stays as it was; in a translated UI the Captions tab still finds which button to offer from the
 * message main sends (localErrorCode reads the UI language's messages).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { describeFailure } from '../src/shared/captions/transcriptErrors'
import { t } from '../src/shared/i18n/t'
import { localErrorCode, localErrorMessage, type LocalCaptionsError } from '../src/shared/speech/errors'
import { cancelledError } from '../src/shared/jobs/longJobs'
import { uiEnglish, uiPseudo } from './pseudoUi'

afterEach(uiEnglish)

const SAMPLES: [LocalCaptionsError, Parameters<typeof localErrorMessage>[1]][] = [
  ['unavailable', { reason: 'missing' }],
  ['unavailable', { reason: 'cpu' }],
  ['unavailable', { reason: 'blocked' }],
  ['unavailable', {}],
  ['no-model', { model: 'whisper-tiny' }],
  ['damaged', { model: 'whisper-turbo' }],
  ['crashed', { part: 2, parts: 3 }],
  ['crashed', {}],
  ['memory', { model: 'whisper-small' }],
  ['memory', { model: 'whisper-tiny' }],
  ['stalled', {}],
  ['protocol', {}],
  ['language', { language: 'xx' }],
  ['blocked', { model: 'whisper-turbo', block: 'processor' }],
  ['blocked', { model: 'whisper-turbo', block: 'memory' }],
  ['outdated', { model: 'whisper-bn-medium' }]
]

describe('S4b: captions on this PC in a translated UI', () => {
  for (const locale of ['en-XA', 'bn-XA'] as const) {
    it(`${locale}: each failure main words in the UI language reads back as its code, with or without Electron's prefix`, () => {
      const english = SAMPLES.map(([code, params]) => localErrorMessage(code, params))
      uiPseudo(locale)
      for (const [i, [code, params]] of SAMPLES.entries()) {
        const message = localErrorMessage(code, params)
        expect(message).not.toBe(english[i])
        expect(localErrorCode(message)).toBe(code)
        expect(localErrorCode(`Error invoking remote method 'ai:transcribe': Error: ${message}`)).toBe(code)
      }
      // Other failures in that UI are none of these, and neither is a cancel.
      for (const other of [t('errors.cancelled'), cancelledError().message, t('errors.aiFailure.network', { provider: 'OpenAI' }), ''])
        expect(localErrorCode(other)).toBeNull()
    })
  }

  it('English keeps today’s sentences, and a translated UI still reads English ones (a catalogue missing a key)', () => {
    expect(localErrorMessage('crashed', { part: 2, parts: 3 })).toBe('The speech engine stopped unexpectedly. The parts already done are kept: Generate captions again continues from part 2 of 3.')
    expect(localErrorMessage('unavailable', { reason: 'cpu' })).toBe("Captions on this PC are not available here: this PC's processor cannot run the speech model.")
    const english = SAMPLES.map(([code, params]) => [code, localErrorMessage(code, params)] as const)
    uiPseudo('bn-XA')
    for (const [code, message] of english) expect(localErrorCode(message)).toBe(code)
  })
})

describe('S4b: AI failures keep today’s English', () => {
  it('each shape is one whole message', () => {
    const cases: [Parameters<typeof describeFailure>[0], string | undefined, string][] = [
      [{ certificate: 'SELF_SIGNED_CERT_IN_CHAIN' }, undefined, 'OpenAI failed: its certificate is not trusted on this PC (SELF_SIGNED_CERT_IN_CHAIN), so nothing was sent.'],
      [{ status: 403 }, 'gpt-4o', 'OpenAI refused the request: this key has no access to the model “gpt-4o”.'],
      [{ status: 403 }, undefined, 'OpenAI refused the request: this key has no access to that API.'],
      [{ status: 404 }, 'gpt-4o', 'OpenAI does not know the model “gpt-4o”. Check the model name in Settings → AI providers.'],
      [{ status: 404 }, undefined, 'OpenAI does not know the model. Check the model name in Settings → AI providers.'],
      [{ status: 400, message: '  bad   input ' }, undefined, 'OpenAI rejected the request: bad input'],
      [{ status: 400 }, undefined, 'OpenAI rejected the request.'],
      [{ message: 'socket hang up' }, undefined, 'OpenAI failed: socket hang up'],
      [{}, undefined, 'OpenAI failed.'],
      [{ status: 503 }, undefined, 'OpenAI had a problem answering (HTTP 503). Try again in a moment.']
    ]
    for (const [info, model, english] of cases) expect(describeFailure(info, 'OpenAI', model).message).toBe(english)
    expect(describeFailure({ certificate: 'CERT_HAS_EXPIRED' }, 'OpenAI')).toMatchObject({ kind: 'other', retryable: false })
  })
})
