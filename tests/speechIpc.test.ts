/**
 * The speech:* IPC handlers (src/main/speech/speechIpc.ts): every one refuses a sender that is
 * not the app page, ids are catalog ids only (paths and URLs refused), the state the renderer
 * gets, speech:changed sent only to app windows and at most 4 times a second, and the hardened
 * projects:detectStill / projects:stopAnalysis (export:analyzeAudio is in exportIpc.test.ts).
 */
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SpeechState } from '../src/shared/api/speech'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-speech-ipc-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appEvents: new Map<string, () => void>(),
  sent: [] as { url: string; channel: string; state: unknown }[],
  opened: [] as string[],
  windows: [] as { url: string }[]
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => require('node:path').resolve(__dirname, '..'),
    getPath: (name: string) => require('node:path').join(h.root, name),
    getVersion: () => '0.0.0-test',
    on: (event: string, fn: () => void) => h.appEvents.set(event, fn)
  },
  net: {},
  powerMonitor: { on: () => undefined },
  shell: { openPath: async (p: string) => (h.opened.push(p), '') },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  BrowserWindow: {
    getAllWindows: () =>
      h.windows.map((w) => ({
        isDestroyed: () => false,
        webContents: { getURL: () => w.url, send: (channel: string, state: unknown) => h.sent.push({ url: w.url, channel, state }) }
      }))
  }
}))

import { registerAnalysisIpc } from '../src/main/analysisIpc'
import { resetHelperSelection } from '../src/main/speech/helper'
import { notifySpeechChanged } from '../src/main/speech/service'
import { CHANGED_EVERY_MS, registerSpeechIpc, throttle } from '../src/main/speech/speechIpc'
import { resetSpeechDetector } from '../src/main/speech/vad'

const APP_URL = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
const appEvent = { senderFrame: { url: APP_URL } }
const EVIL = [{}, { senderFrame: null }, { senderFrame: { url: 'https://example.com/' } }, { senderFrame: { url: pathToFileURL('/tmp/evil/index.html').href } }]
const invoke = async (channel: string, event: unknown, ...args: unknown[]): Promise<unknown> => h.handlers.get(channel)!(event, ...args)

beforeAll(() => {
  process.env.SSW_SPEECH_HELPER = path.resolve(__dirname, 'fixtures/fake-speech-helper.cjs')
  registerSpeechIpc()
  registerAnalysisIpc()
})
afterEach(() => vi.useRealTimers())
afterAll(() => {
  delete process.env.SSW_SPEECH_HELPER
  rmSync(h.root, { recursive: true, force: true })
})

describe('speech IPC', () => {
  const channels: [string, unknown[]][] = [
    ['speech:state', []],
    ['speech:download', ['whisper-tiny']],
    ['speech:cancelDownload', ['whisper-tiny', true]],
    ['speech:remove', ['whisper-tiny']],
    ['speech:setDefault', ['whisper-tiny']],
    ['speech:showFolder', []],
    ['projects:detectStill', ['rec', 1]],
    ['projects:stopAnalysis', ['rec']]
  ]

  it('every handler refuses a sender that is not the app page', async () => {
    for (const [channel, args] of channels) {
      expect(h.handlers.has(channel)).toBe(true)
      for (const evil of EVIL) await expect(invoke(channel, evil, ...args)).rejects.toThrow('Not allowed')
    }
    expect(h.opened).toEqual([])
  })

  it('takes catalog ids only: paths, URLs and unknown ids are refused', async () => {
    for (const channel of ['speech:download', 'speech:cancelDownload', 'speech:remove', 'speech:setDefault']) {
      for (const bad of ['../../x', 'https://huggingface.co/x', 'C:\\Windows\\x', 'ggml-tiny-q8_0.bin', 'whisper-huge', 42, null, { id: 'whisper-tiny' }]) {
        await expect(invoke(channel, appEvent, bad)).rejects.toThrow('Unknown speech model.')
      }
    }
  })

  it('returns the state: the engine (probed), the detector, every model in catalog order, the default, disk, memory', async () => {
    const state = (await invoke('speech:state', appEvent)) as SpeechState
    expect(state.engine).toMatchObject({ available: true, build: 'host', threads: 3 })
    expect(state.detector.available).toBe(true)
    expect(state.models.map((m) => m.id)).toEqual(['whisper-tiny', 'whisper-base', 'whisper-small', 'whisper-turbo'])
    expect(state.models.every((m) => m.status.state === 'missing' && !m.inUse)).toBe(true)
    expect(state.defaultModel).toBe('whisper-base')
    expect(state.disk.used).toBe(0)
    expect(state.memory.total).toBe(os.totalmem())
    expect(state.cores).toBe(4)
    // Structured-clonable as Electron sends it.
    expect(structuredClone(state)).toEqual(state)
  })

  it('reports why the engine is unavailable when the helper is missing', async () => {
    const saved = process.env.SSW_SPEECH_HELPER
    process.env.SSW_SPEECH_HELPER = '/nonexistent/helper'
    resetHelperSelection()
    resetSpeechDetector()
    try {
      const state = (await invoke('speech:state', appEvent)) as SpeechState
      expect(state.engine).toMatchObject({ available: false, build: null, reason: 'missing' })
      expect(state.detector.available).toBe(false)
    } finally {
      process.env.SSW_SPEECH_HELPER = saved
      resetHelperSelection()
      resetSpeechDetector()
    }
  })

  it('setDefault refuses a model that is not downloaded; remove of a missing model is harmless', async () => {
    await expect(invoke('speech:setDefault', appEvent, 'whisper-small')).rejects.toThrow(/downloaded/)
    await invoke('speech:remove', appEvent, 'whisper-small')
    await invoke('speech:cancelDownload', appEvent, 'whisper-small', 'yes')
  })

  it('showFolder opens the fixed models folder', async () => {
    await invoke('speech:showFolder', appEvent)
    expect(h.opened).toEqual([path.join(h.root, 'userData', 'speech-models')])
  })

  it('speech:changed goes to app windows only, at most 4 times a second, the last state always', async () => {
    h.windows = [{ url: APP_URL }, { url: 'https://example.com/' }]
    h.sent = []
    for (let i = 0; i < 20; i++) notifySpeechChanged()
    await new Promise((r) => setTimeout(r, CHANGED_EVERY_MS + 300))
    expect(h.sent.length).toBe(1)
    expect(h.sent.every((s) => s.url === APP_URL && s.channel === 'speech:changed')).toBe(true)
    expect((h.sent[0].state as SpeechState).models).toHaveLength(4)
    h.windows = []
  })
})

describe('throttle', () => {
  it('folds a burst into calls at most every interval', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const t = throttle(send, 250)
    for (let i = 0; i < 10; i++) t()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++) t()
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(2)
  })
})

