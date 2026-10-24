// windows-10: when system audio (WASAPI loopback) cannot start, Chromium rejects the whole
// getDisplayMedia request. The recording must go ahead without system audio, and say so.
import { describe, expect, it, vi } from 'vitest'
import { captureDisplay } from '../src/shared/recording/displayCapture'

const domError = (name: string, message = name): Error => Object.assign(new Error(message), { name })

describe('captureDisplay', () => {
  it('captures without system audio when loopback cannot start', async () => {
    const request = vi.fn(async (audio: boolean) => {
      if (audio) throw domError('NotReadableError', 'Could not start audio source')
      return 'video-only stream'
    })
    expect(await captureDisplay(request, true)).toEqual({ stream: 'video-only stream', systemAudioFailed: true })
    expect(request.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  it('asks once when everything works', async () => {
    const request = vi.fn(async () => 'stream')
    expect(await captureDisplay(request, true)).toEqual({ stream: 'stream', systemAudioFailed: false })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('still fails clearly when the screen itself cannot be captured', async () => {
    const request = vi.fn(async () => {
      throw domError('NotReadableError')
    })
    await expect(captureDisplay(request, true)).rejects.toThrow(/screen could not be captured/)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not retry a refusal, or a request without system audio', async () => {
    const refused = vi.fn(async () => {
      throw domError('NotAllowedError')
    })
    await expect(captureDisplay(refused, true)).rejects.toThrow(/blocked/)
    expect(refused).toHaveBeenCalledTimes(1)
    const noAudio = vi.fn(async () => {
      throw domError('AbortError')
    })
    await expect(captureDisplay(noAudio, false)).rejects.toThrow(/could not start/)
    expect(noAudio).toHaveBeenCalledTimes(1)
  })
})
