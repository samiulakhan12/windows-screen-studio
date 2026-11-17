/**
 * Test 72 (docs/design/output-and-languages.md §9.5, §9.6), part X5: decisions that read English text
 * now go by codes and flags.
 *
 * - For every English message main produces for an export (ffmpeg.ts's KNOWN_ERRORS and its other
 *   failures through toIpcError, renameError's, validateJob's and the soundtrack's), the decision by
 *   code (errorCodeOf, refusedForGood) equals the decision exporter.ts made with its regex
 *   NOT_ENCODER_RELATED, kept below only to compare. So does it for the page's own failures to load or
 *   read a recording (media.ts), which carry their code themselves.
 * - Under en-XA the messages change and the codes, so the decisions, do not.
 * - Home's source refresh still decides on SOURCE_GONE and on both texts of recordingIpc.ts, and the
 *   recording side's text Home shows is marked lang="en" only in a translated UI.
 * exportIpc.test.ts checks the codes export:start and export:finish record.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ExportJob } from '../src/shared/api/export'
import { setCatalogue, t } from '../src/shared/i18n/t'
import { describeFfmpegError, ffmpegErrorCode, FfmpegFailure } from '../src/main/ffmpeg'
import { errorCodeOf, ExportFailure, ffmpegText, renameError, resolveSoundInputs, toIpcError, validateJob } from '../src/main/exportJob'
import { failureCode, refusedForGood } from '../src/shared/render/exportPlan'
import { EFFECT_SOURCES } from '../src/shared/audio/soundLibrary'

const pseudo = require('../scripts/i18n/lib/pseudo.cjs') as {
  pseudoCatalogue(locale: string, english: Record<string, string>, meta: Record<string, object>): { dir: 'ltr' | 'rtl'; messages: Record<string, string>; latn: string[]; user: Record<string, string[]> }
}
const files = require('../scripts/i18n/lib/files.cjs') as { readEnglish(): { messages: Record<string, string>; meta: Record<string, object> } }

/** exporter.ts's rule before §9.6: failures another encoder cannot fix, told by their English words. */
const NOT_ENCODER_RELATED = /disk is full|permission|in use|another app|read-only|missing|could not be read|could not load|could not read|could not save|could not write|not chosen|invalid export|export size|no sound/i

const ROOT = path.resolve(__dirname, '..')
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow its DOM types.
const MEDIA = '../src/renderer/src/editor/media'
const english = (): void => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
/** en-XA: every message bracketed and longer, as the pseudo-locale build makes it (§16.3). */
function enXA(): void {
  const { messages, meta } = files.readEnglish()
  const c = pseudo.pseudoCatalogue('en-XA', messages, meta)
  setCatalogue({ language: 'es', messages: c.messages, latn: c.latn, user: c.user, formatLocale: 'en-US', dir: c.dir })
}
afterEach(english)

/** ffmpeg's last lines for each failure ffmpeg.ts knows, and one it does not. */
const STDERR = [
  'av_interleaved_write_frame(): No space left on device',
  'C:\\Users\\me\\Videos\\Demo.mp4: Permission denied',
  'The process cannot access the file because it is being used by another process.',
  'C:\\Users\\me\\AppData\\Local\\Temp\\music.wav: No such file or directory',
  'Cannot allocate memory',
  'screen.mp4: Invalid data found when processing input',
  'Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height'
]

/** Every ffmpeg failure main reports for an export, as ffmpeg.ts makes it. */
function ffmpegFailures(): FfmpegFailure[] {
  return [
    ...STDERR.map((s) => new FfmpegFailure(describeFfmpegError(s), `ffmpeg exited with code 1\n${s}`, ffmpegErrorCode(s))),
    new FfmpegFailure('Could not start the video encoder.', 'spawn C:\\Flown\\ffmpeg.exe ENOENT'),
    new FfmpegFailure('The video encoder was stopped.', 'ffmpeg stopped (SIGKILL)\n'),
    new FfmpegFailure('The video encoder stopped unexpectedly.', 'ffmpeg was stopped (SIGSEGV)\n'),
    new FfmpegFailure('The video encoder finished early.', 'write EPIPE')
  ]
}

const errno = (code: string | undefined): NodeJS.ErrnoException => Object.assign(new Error(`${code ?? 'odd'}: failed`), code ? { code } : {})
const RENAME_CODES = ['EBUSY', 'EPERM', 'EACCES', 'ENOSPC', 'EROFS', 'EXDEV', 'ENOENT', undefined]

function job(extra: Partial<ExportJob> = {}): ExportJob {
  return { width: 1280, height: 720, fps: 60, frames: 60, format: 'mp4', quality: 'high', video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' }, outputPath: 'C:\\out\\Demo.mp4', ...extra }
}

/** validateJob's and the soundtrack's refusals, each with the error main throws. */
async function jobRefusals(): Promise<unknown[]> {
  const caught = async (run: () => unknown): Promise<unknown> => {
    try {
      await run()
    } catch (e) {
      return e
    }
    throw new Error('expected a refusal')
  }
  const effect = EFFECT_SOURCES[0].id
  const audio = { clips: [{ sourceStart: 0, sourceEnd: 1, speed: 1 }], volume: 1 } as unknown as NonNullable<ExportJob['audio']>
  return [
    await caught(() => validateJob(job({ width: 1281 }))),
    await caught(() => validateJob(job({ quality: 'best' as never }))),
    await caught(() => validateJob(job({ format: 'm4a', video: { kind: 'none' } }))),
    await caught(() => resolveSoundInputs(job({ music: { file: 'music-1.opus', volume: 1, loop: false, fadeIn: 0, fadeOut: 0, duration: null } }), '/p', async () => false, [])),
    await caught(() => resolveSoundInputs(job({ music: { file: '../x.opus', volume: 1, loop: false, fadeIn: 0, fadeOut: 0, duration: null } }), '/p', async () => false, [])),
    await caught(() => resolveSoundInputs(job({ audio: { ...audio, stems: { mic: 0.5 } } }), '/p', async () => false, ['mic'])),
    await caught(() => resolveSoundInputs(job({ audio: { ...audio, stems: { mic: 0.5, system: 1 } } }), '/p', async () => false, ['mic', 'system'])),
    await caught(() => resolveSoundInputs(job({ audio: { ...audio, stems: { system: 0.5 } } }), '/p', async (f) => !f.endsWith('system.m4a'), ['system'])),
    await caught(() => resolveSoundInputs(job({ effects: [{ id: effect, times: [1], gain: 1 }] }), '/p', async () => false, [], { soundDir: '/library' })),
    await caught(() => resolveSoundInputs(job({ effects: [{ id: 'nope', times: [1], gain: 1 }] }), '/p', async () => true, [], { soundDir: '/library' }))
  ]
}

/** media.ts's failures for a video element that cannot load or read a recording: the page's own, in an export's frame loop. */
async function pageReadFailures(): Promise<Error[]> {
  const media = (await import(/* @vite-ignore */ MEDIA)) as { whenReady(v: unknown): Promise<void>; seekTo(v: unknown, at: number): Promise<void> }
  const failing = async (start: (v: EventTarget) => Promise<void>): Promise<Error> => {
    const v = Object.assign(new EventTarget(), { readyState: 0, seeking: false, currentTime: 0, duration: 10, error: { message: 'PIPELINE_ERROR_READ' } })
    const p = start(v)
    v.dispatchEvent(new Event('error'))
    return p.then(
      () => {
        throw new Error('expected a failure')
      },
      (e: Error) => e
    )
  }
  return [await failing((v) => media.whenReady(v)), await failing((v) => media.seekTo(v, 2))]
}

const messageOf = (e: unknown): string => toIpcError(e).message
const oldDecision = (e: unknown): boolean => NOT_ENCODER_RELATED.test(messageOf(e))
const newDecision = (e: unknown): boolean => refusedForGood(errorCodeOf(e))

describe('test 72: an export stops or tries the next encoder by code, as it did by words', () => {
  it('ffmpeg failures: KNOWN_ERRORS and the encoder’s own, through toIpcError', () => {
    const all = ffmpegFailures()
    for (const f of all) expect({ message: messageOf(f), stops: newDecision(f) }).toEqual({ message: messageOf(f), stops: oldDecision(f) })
    // The known ones are coded by what went wrong; the rest are the encoder's, so the next one is tried.
    expect(all.map((f) => f.code)).toEqual(['disk-full', 'permission', 'in-use', 'missing-input', 'encoder', 'unreadable', 'encoder', 'encoder', 'encoder', 'encoder', 'encoder'])
    // toIpcError keeps ffmpeg's English sentence in English and its log after a blank line.
    expect(messageOf(all[0])).toBe(`The disk is full.\n\nffmpeg exited with code 1\n${STDERR[0]}`)
  })

  it('renameError, for every file system code', () => {
    for (const code of RENAME_CODES) {
      const e = renameError(errno(code), 'C:\\out\\Demo.mp4')
      expect(e).toBeInstanceOf(ExportFailure)
      expect({ code, stops: newDecision(e) }).toEqual({ code, stops: oldDecision(e) })
      expect(newDecision(e)).toBe(true)
    }
    expect((renameError(errno('EBUSY'), 'x.mp4') as ExportFailure).code).toBe('in-use')
    expect((renameError(errno('ENOSPC'), 'x.mp4') as ExportFailure).code).toBe('disk-full')
  })

  it('validateJob’s and the soundtrack’s refusals', async () => {
    const refusals = await jobRefusals()
    expect(refusals).toHaveLength(10)
    for (const e of refusals) expect({ message: messageOf(e), stops: newDecision(e) }).toEqual({ message: messageOf(e), stops: oldDecision(e) })
    expect(refusals.map(errorCodeOf)).toEqual(['invalid-job', 'invalid-job', 'no-sound', 'missing-input', 'invalid-job', 'missing-input', 'missing-input', 'missing-input', 'missing-input', 'invalid-job'])
  })

  it('a failure without a code, a file system one and a cancel', () => {
    // Unknown and encoder failures try the next route; so does one of the page's own (no code at all).
    expect(refusedForGood('unknown')).toBe(false)
    expect(refusedForGood('encoder')).toBe(false)
    expect(refusedForGood(null)).toBe(false)
    expect(errorCodeOf(new Error('ffmpeg exited'))).toBe('unknown')
    // The fixed IPC check stays English in every language (allow.json) and is coded as before.
    expect(errorCodeOf(new Error('Invalid export settings'))).toBe('invalid-job')
    // Node's own (English) errors: a denied or read-only folder stops, as its words did.
    for (const code of ['EACCES', 'EROFS', 'EBUSY', 'ENOENT', 'EPERM']) {
      const e = errno(code)
      e.message = { EACCES: 'EACCES: permission denied, open', EROFS: 'EROFS: read-only file system, open', EBUSY: 'EBUSY: resource busy or locked', ENOENT: 'ENOENT: no such file or directory', EPERM: 'EPERM: operation not permitted' }[code]!
      expect({ code, stops: newDecision(e) }).toEqual({ code, stops: oldDecision(e) })
    }
    // A cancel stops at once (§9.6's list); the renderer's own abort check runs before any code, as before.
    expect(refusedForGood('cancelled')).toBe(true)
  })

  it('under en-XA the messages change and the codes do not', async () => {
    const before = [...ffmpegFailures(), ...RENAME_CODES.map((c) => renameError(errno(c), 'x.mp4')), ...(await jobRefusals())]
    const codes = before.map(errorCodeOf)
    const messages = before.map(messageOf)
    enXA()
    const after = [...ffmpegFailures(), ...RENAME_CODES.map((c) => renameError(errno(c), 'x.mp4')), ...(await jobRefusals())]
    expect(after.map(errorCodeOf)).toEqual(codes)
    expect(after.map(newDecision)).toEqual(before.map(newDecision))
    // Every coded message is in the UI language now; the English rule would no longer find them.
    const shown = after.map(messageOf)
    for (let i = 0; i < shown.length; i++) if (messages[i] !== 'Invalid export settings') expect(shown[i]).not.toBe(messages[i])
    expect(ffmpegText(ffmpegFailures()[0])).toBe(t('errors.diskFull'))
    expect(t('errors.diskFull').startsWith('[')).toBe(true)
  })

  it('the page’s own failures to load or read a recording stop the export, by their code as by their words', async () => {
    const failures = await pageReadFailures()
    expect(failures.map((e) => e.message)).toEqual(['Could not load video (PIPELINE_ERROR_READ)', 'Could not read video (PIPELINE_ERROR_READ)'])
    for (const e of failures) expect({ message: e.message, stops: refusedForGood(failureCode(e)) }).toEqual({ message: e.message, stops: NOT_ENCODER_RELATED.test(e.message) })
    expect(failures.map(failureCode)).toEqual(['unreadable', 'unreadable'])
    // The page's other failures (a WebCodecs encoder's) carry no code and try the next route, as their words did.
    const encoder = new Error("The graphics card's encoder failed: Encoder creation error.")
    expect(refusedForGood(failureCode(encoder))).toBe(NOT_ENCODER_RELATED.test(encoder.message))
    // Under en-XA the words change and the code does not.
    enXA()
    const shown = await pageReadFailures()
    expect(shown.map(failureCode)).toEqual(['unreadable', 'unreadable'])
    for (let i = 0; i < shown.length; i++) expect(shown[i].message).not.toBe(failures[i].message)
  })

  it('ffmpeg.ts’s English sentences have their own messages, equal in English', () => {
    for (const f of ffmpegFailures()) expect(ffmpegText(f)).toBe(f.message)
    expect(ffmpegText(new FfmpegFailure('The export was cancelled.', 'cancelled', 'cancelled'))).toBe(t('errors.export.cancelled'))
  })
})

describe('test 72: the recording side’s text in our panels', () => {
  const home = readFileSync(path.join(ROOT, 'src/renderer/src/views/Home.tsx'), 'utf8')

  it('Home refreshes the sources for SOURCE_GONE and for both texts of recordingIpc.ts, as today', () => {
    expect(home).toContain('if (state.message === SOURCE_GONE || /no longer available/.test(state.message)) void refreshSources(sourceKind)')
    const ipc = readFileSync(path.join(ROOT, 'src/main/recordingIpc.ts'), 'utf8').split('\n')
    const texts = [ipc[203], ipc[204]].map((l) => /'([^']+)'/.exec(l)?.[1])
    expect(texts).toEqual(['The selected screen is no longer available. Pick another one.', 'The window you picked is no longer available (it may have been closed). Pick another one.'])
    for (const text of texts) expect(/no longer available/.test(text!)).toBe(true)
  })

  it('friendlyError’s text is wrapped in lang="en" only in a translated UI', () => {
    expect(home).toContain(`{uiLanguage() === 'en' ? problem.message : <span lang="en">{problem.message}</span>}`)
    expect(home).toContain(`const recordingLang = uiLanguage() === 'en' ? undefined : 'en'`)
    expect(home).toContain('<span lang={recordingLang}>{error.message}</span>')
  })
})
