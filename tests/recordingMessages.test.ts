import { describe, expect, it } from 'vitest'
import { RecordingError } from '../src/main/recording/errors'
import { friendlyMessage, nativeEndedMessage, rendererGoneDialog } from '../src/main/recording/userMessages'

const errno = (code: string, message = `${code}: something, open 'C:\\Users\\me\\Videos\\x\\screen.webm'`) =>
  Object.assign(new Error(message), { code })

describe('friendlyMessage (audit-C-2)', () => {
  it('keeps messages that are already meant for the user', () => {
    expect(friendlyMessage(new RecordingError('The selected screen is no longer available.'))).toBe('The selected screen is no longer available.')
  })

  it('never shows raw Node errors for common file problems', () => {
    const folder = 'C:\\Users\\me\\Videos\\Screen Studio for Windows'
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOSPC', 'EROFS', 'ENOENT', 'EMFILE', 'EIO']) {
      const text = friendlyMessage(errno(code), folder)
      expect(text, code).not.toMatch(/screen\.webm|resource busy|open '/)
      expect(text.length, code).toBeGreaterThan(10)
    }
    expect(friendlyMessage(errno('EPERM'), folder)).toContain(folder)
    expect(friendlyMessage(errno('EPERM'), folder)).toMatch(/Controlled folder access/)
    expect(friendlyMessage(errno('EBUSY'))).toMatch(/in use by another program/)
    expect(friendlyMessage(errno('ENOSPC'))).toMatch(/disk is full/)
    expect(friendlyMessage(errno('EIO'))).toBe('Could not save the recording (EIO).')
  })

  it('falls back to a generic sentence for empty errors', () => {
    expect(friendlyMessage(undefined)).toBe('Something went wrong while saving the recording.')
  })
})

describe('nativeEndedMessage (windows-1)', () => {
  it('explains why the recording stopped and that the footage was kept', () => {
    expect(nativeEndedMessage({ reason: 'closed' })).toMatch(/disconnected or turned off.*kept/)
    expect(nativeEndedMessage({ reason: 'crashed', error: new Error('access violation') })).toMatch(/failed unexpectedly.*kept/)
  })
})

describe('rendererGoneDialog (audit-A-3)', () => {
  it('blames the recorder only when a recording was running', () => {
    expect(rendererGoneDialog({ recording: true, kept: true, processing: false })).toEqual({
      message: 'The recorder stopped unexpectedly.',
      detail: 'What was recorded until then has been kept. Recover it from “Unfinished recordings” on the home screen.'
    })
    expect(rendererGoneDialog({ recording: true, kept: false, processing: false }).detail).toMatch(/had not started/)
  })

  it('describes an editor or export crash accurately', () => {
    const editor = rendererGoneDialog({ recording: false, kept: false, processing: false })
    expect(editor.message).not.toMatch(/recorder/i)
    expect(editor.detail).toMatch(/export/)
    const processing = rendererGoneDialog({ recording: false, kept: false, processing: true })
    expect(processing.detail).toMatch(/still being prepared/)
  })
})
