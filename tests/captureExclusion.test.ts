import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ packaged: false }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    }
  },
  BrowserWindow: class {},
  screen: {}
}))

import { bubbleSupported } from '../src/main/recording/cameraBubbleWindow'
import { captureExclusionSupported } from '../src/main/recording/captureExclusion'

const g = globalThis as { __SSW_CAPTURE_EXCLUSION__?: unknown }

afterEach(() => {
  delete g.__SSW_CAPTURE_EXCLUSION__
  h.packaged = false
})

describe('captureExclusionSupported', () => {
  it('Windows needs 10 version 2004 (build 19041) or later', () => {
    expect(captureExclusionSupported('win32', '10.0.19041')).toBe(true)
    expect(captureExclusionSupported('win32', '10.0.18363')).toBe(false)
    expect(captureExclusionSupported('win32', '10.0.22631')).toBe(true)
    expect(captureExclusionSupported('win32', '6.3.9600')).toBe(false)
    expect(captureExclusionSupported('win32', 'garbage')).toBe(false)
  })

  it('other platforms: yes', () => {
    expect(captureExclusionSupported('darwin', '23.0.0')).toBe(true)
    expect(captureExclusionSupported('linux', '6.1.0')).toBe(true)
  })

  it('bubbleSupported is the same function', () => {
    expect(bubbleSupported).toBe(captureExclusionSupported)
  })

  it('unpackaged builds let e2e tests pretend to be an older Windows', () => {
    g.__SSW_CAPTURE_EXCLUSION__ = false
    expect(captureExclusionSupported('linux', '6.1.0')).toBe(false)
    expect(captureExclusionSupported()).toBe(false)
    expect(bubbleSupported()).toBe(false)
  })

  it('a packaged app ignores the hook', () => {
    h.packaged = true
    g.__SSW_CAPTURE_EXCLUSION__ = false
    expect(captureExclusionSupported('linux', '6.1.0')).toBe(true)
  })
})
