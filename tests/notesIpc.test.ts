import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fsm = require('node:fs') as typeof import('node:fs')
  const pathm = require('node:path') as typeof import('node:path')
  return {
    userData: fsm.mkdtempSync(pathm.join(os.tmpdir(), 'ssw-notes-ipc-')),
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    listeners: new Map<string, (...args: unknown[]) => void>(),
    sentToMain: [] as [string, unknown][],
    recording: false,
    /** What recordingIpc did, in order. */
    order: [] as string[],
    statuses: [] as any[],
    trackerOpts: null as any,
    idle: null as any,
    /** What prepareToolbar() was given last. */
    toolbarArgs: null as unknown[] | null,
    /** A window recording: where its window was (windowCursorMapping), what the tracker saw, and the track written. */
    windowMapping: null as any,
    rawTrack: null as any,
    cursorTrack: null as any
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => void) => h.listeners.set(channel, fn)
  },
  // What recordingIpc uses.
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: {
    getSources: async (o?: { types?: string[] }) =>
      [
        { id: 'screen:1:0', name: 'Screen 1', display_id: '1', thumbnail: { isEmpty: () => true } },
        { id: 'window:5:0', name: 'Browser', display_id: '', thumbnail: { isEmpty: () => true } }
      ].filter((s) => !o?.types || o.types.includes(s.id.split(':')[0]))
  },
  dialog: {},
  globalShortcut: {
    register: (a: string) => {
      h.order.push(`register(${a})`)
      return true
    },
    unregister: () => undefined,
    unregisterAll: () => undefined
  },
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
  },
  session: { defaultSession: { setDisplayMediaRequestHandler: () => undefined } },
  shell: {}
}))

const MAIN = { id: 1, isDestroyed: () => false, isCrashed: () => false, send: (c: string, v: unknown) => h.sentToMain.push([c, v]) }
const NOTES = { id: 2 }
const BAR = { id: 3 }
const OTHER = { id: 4 }

vi.mock('../src/main/windows', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, isVisible: () => false, hide: () => undefined, show: () => undefined, focus: () => undefined, webContents: MAIN }),
  loadRoute: () => undefined,
  allowPopup: () => undefined
}))
vi.mock('../src/main/recording/toolbarWindow', () => ({
  isToolbarSender: (wc: { id: number }) => wc.id === BAR.id,
  prepareToolbar: (...args: unknown[]) => {
    h.order.push('prepareToolbar')
    h.toolbarArgs = args
  },
  showToolbar: () => void h.order.push('showToolbar'),
  raiseToolbar: () => void h.order.push('raiseToolbar'),
  hideToolbar: () => undefined,
  closeToolbar: () => void h.order.push('closeToolbar'),
  sendToolbarStatus: (s: unknown) => void h.statuses.push(s),
  sendToolbarLevel: () => undefined,
  isToolbarVisible: () => false,
  toolbarAreas: () => [{ x: 0, y: 1000, width: 100, height: 40 }]
}))
vi.mock('../src/main/cursorTracker', () => ({
  CursorTracker: class {
    hookRunning = true
    active = false
    start(opts: unknown) {
      h.trackerOpts = opts
      this.active = true
    }
    stop() {
      this.active = false
    }
    setPaused() {}
    mark() {}
    collect() {
      return h.rawTrack ?? { samples: [], clicks: [], keys: [], bounds: null, scale: 1 }
    }
  }
}))
vi.mock('../src/main/recording/idleDetector', () => ({
  IdleDetector: class {
    watching = false
    activity = vi.fn()
    constructor(
      readonly ms: number,
      readonly callbacks: { onIdle: () => void; onActive: () => void }
    ) {
      h.idle = this
    }
    start() {
      this.watching = true
    }
    stop() {
      this.watching = false
    }
  }
}))
vi.mock('../src/main/hwEncoders', () => ({ detectH264Encoders: async () => ['libx264'] }))
vi.mock('../src/main/nativeCapture', () => ({ desktopIcons: async () => ({ ok: true }), desktopIconsSync: () => ({ ok: true }), holdDesktopIcons: async () => null }))
vi.mock('../src/main/recording/nativeVideo', () => ({
  defaultStartTimeoutMs: () => 1000,
  nativeAvailable: async () => false,
  startNativeVideo: () => undefined,
  stopNativeVideo: () => undefined,
  stopWindowWatch: () => undefined
}))
vi.mock('../src/main/recording/finalize', async () => ({ ...(await import('../src/main/recording/errors')), processRecording: async (m: { id: string }) => ({ id: m.id }) }))
vi.mock('../src/main/recording/proxyRunner', () => ({ isCancelled: () => false, killAllFfmpeg: () => undefined }))
vi.mock('../src/main/recording/regionWindow', () => ({
  pickRegionOnDisplay: async () => {
    h.order.push('pickRegion')
    return { region: null }
  }
}))
vi.mock('../src/main/recording/windowCapture', () => ({
  planWindowCapture: async () => ({ method: 'chromium', watch: null }),
  watchForChromium: async () => ({ watch: null }),
  WINDOW_NO_EFFECTS: 'no effects',
  windowCaptureSupport: async () => ({}),
  windowCursorMapping: () => ({ mapping: h.windowMapping, scale: null })
}))
vi.mock('../src/main/styleDefaults', () => ({ loadStyleDefaults: async () => null }))
vi.mock('../src/main/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/projects')>()),
  createProjectDir: async () => ({ id: 'r1', dir: h.userData }),
  writeManifest: async () => undefined,
  writeCursor: async (_id: string, track: unknown) => {
    h.cursorTrack = track
  },
  deleteProject: async () => undefined,
  projectsRoot: () => h.userData
}))

const win = vi.hoisted(() => ({
  listeners: [] as (() => void)[],
  openRehearsal: vi.fn(() => !h.recording),
  closeRehearsal: vi.fn(),
  dismissNotes: vi.fn(),
  setNotesLook: vi.fn(),
  setNotesReport: vi.fn(),
  toggleNotesShown: vi.fn(),
  notesSettingsChanged: vi.fn(),
  // What recordingIpc calls.
  next: { shown: true } as { shown: boolean; notice?: string },
  status: null as null | { shown: boolean; playing: boolean },
  playing: false,
  /** Where the prepared recording's notes window shows. */
  rect: null as null | { x: number; y: number; width: number; height: number },
  area: vi.fn((_p: unknown, _at: number) => false),
  prepareRecordingNotes: vi.fn((_plan: unknown, _dir: string) => {
    h.order.push('prepareNotes')
    return win.next
  }),
  showNotes: vi.fn(() => void h.order.push('showNotes')),
  setNotesRecording: vi.fn((s: string) => void h.order.push(`notes:${s}`)),
  endRecordingNotes: vi.fn((restarting: boolean) => void h.order.push(`endNotes(${restarting})`)),
  discardKeptNotes: vi.fn(() => void h.order.push('discardKeptNotes')),
  closeNotes: vi.fn(() => void h.order.push('closeNotes')),
  hideNotesWhilePicking: vi.fn(() => {
    h.order.push('hideNotes')
    return () => void h.order.push('showNotesAgain')
  })
}))
vi.mock('../src/main/notes/notesWindow', async () => {
  const { notesStore } = await import('../src/main/notes/notesStore')
  return {
    ...win,
    isNotesSender: (wc: { id: number }) => wc.id === NOTES.id,
    notesView: () => ({ mode: 'rehearse' }),
    notesWindowInfo: () => null,
    notesSettingsNow: () => notesStore().get(),
    onNotesChange: (l: () => void) => win.listeners.push(l),
    notesStatus: () => win.status,
    recordingNotesRect: () => win.rect,
    notesPlaying: () => win.playing,
    notesAreaContains: (p: unknown, at: number) => win.area(p, at),
    notesHotkeyLabels: () => (win.status ? { notesToggle: 'Ctrl + Shift + F7' } : {}),
    notesHotkeyProblems: () => (win.status ? ['Ctrl + Shift + F6 (Notes: back) is used by another app'] : [])
  }
})

import { checkAnyHotkey, registerNotesIpc, type HotkeyContext } from '../src/main/notes/notesIpc'
import { notesStore } from '../src/main/notes/notesStore'
import { DEFAULT_HOTKEYS, DEFAULT_NOTES_HOTKEYS } from '../src/shared/recording/hotkeys'

const appUrl = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
const event = (sender: { id: number }, url = appUrl) => ({ sender, senderFrame: { url } })
const invoke = (channel: string, e: object, ...args: unknown[]) => Promise.resolve().then(() => h.handlers.get(channel)!(e, ...args))
const send = (channel: string, e: object, ...args: unknown[]) => h.listeners.get(channel)!(e, ...args)

registerNotesIpc()

beforeEach(() => {
  win.openRehearsal.mockClear()
  win.closeRehearsal.mockClear()
  win.dismissNotes.mockClear()
  win.setNotesLook.mockClear()
  win.setNotesReport.mockClear()
  win.toggleNotesShown.mockClear()
  win.notesSettingsChanged.mockClear()
  h.recording = false
})

describe('Home channels answer the main window only', () => {
  it('notes:get', async () => {
    await expect(invoke('notes:get', event(MAIN))).resolves.toMatchObject({ settings: { wpm: 130 }, support: { hiddenFromCapture: true }, window: null })
    await expect(invoke('notes:get', event(NOTES))).rejects.toThrow('Not allowed')
    // The main window's webContents at another URL (it navigated away) is refused too.
    await expect(invoke('notes:get', event(MAIN, 'https://example.com/'))).rejects.toThrow('Not allowed')
  })

  it('notes:update from another page is rejected and saves nothing', async () => {
    await expect(invoke('notes:update', event(NOTES), { text: 'evil' })).rejects.toThrow('Not allowed')
    await expect(invoke('notes:update', event(BAR), { text: 'evil' })).rejects.toThrow('Not allowed')
    expect(notesStore().get().text).toBe('')
    const state = (await invoke('notes:update', event(MAIN), { text: 'Hello\r\nworld', wpm: 151 })) as { settings: { text: string; wpm: number } }
    expect(state.settings).toMatchObject({ text: 'Hello\nworld', wpm: 150 })
    expect(win.notesSettingsChanged).toHaveBeenCalledTimes(1)
  })

  it('notes:rehearse: refused during a recording, and from other pages', async () => {
    await expect(invoke('notes:rehearse', event(NOTES), true)).rejects.toThrow('Not allowed')
    expect(win.openRehearsal).not.toHaveBeenCalled()
    h.recording = true
    await expect(invoke('notes:rehearse', event(MAIN), true)).rejects.toThrow('Finish the recording first.')
    h.recording = false
    await expect(invoke('notes:rehearse', event(MAIN), true)).resolves.toBeTruthy()
    expect(win.openRehearsal).toHaveBeenCalledTimes(2)
    await invoke('notes:rehearse', event(MAIN), false)
    expect(win.closeRehearsal).toHaveBeenCalledTimes(1)
    // Only a real `true` opens it.
    await invoke('notes:rehearse', event(MAIN), 'yes')
    expect(win.openRehearsal).toHaveBeenCalledTimes(2)
  })

  it('notes:state goes to Home only when it changed', () => {
    h.sentToMain.length = 0
    notesStore().update({ fontSize: 40 })
    win.listeners[0]()
    win.listeners[0]()
    expect(h.sentToMain.filter(([c]) => c === 'notes:state')).toHaveLength(1)
    expect(h.sentToMain[0][1]).toMatchObject({ settings: { fontSize: 40 } })
  })
})

describe('the notes window channels answer that window only', () => {
  it('notes:getView', async () => {
    await expect(invoke('notes:getView', event(NOTES))).resolves.toEqual({ mode: 'rehearse' })
    await expect(invoke('notes:getView', event(MAIN))).resolves.toBeNull()
    await expect(invoke('notes:getView', event(BAR))).resolves.toBeNull()
  })

  it('notes:report from another webContents is ignored; values are sanitised', () => {
    send('notes:report', event(BAR), { playing: true, ended: false, block: 2 })
    send('notes:report', event(MAIN), { playing: true, ended: false, block: 2 })
    expect(win.setNotesReport).not.toHaveBeenCalled()
    send('notes:report', event(NOTES), { playing: 'yes', ended: true, block: -3.5, extra: 1 })
    expect(win.setNotesReport).toHaveBeenCalledWith({ playing: false, ended: true, block: 0 })
    send('notes:report', event(NOTES), { playing: true, block: 4.7 })
    expect(win.setNotesReport).toHaveBeenLastCalledWith({ playing: true, ended: false, block: 4 })
  })

  it('notes:look passes only the four look fields, from the notes window only', () => {
    send('notes:look', event(OTHER), { wpm: 200 })
    expect(win.setNotesLook).not.toHaveBeenCalled()
    send('notes:look', event(NOTES), { wpm: 200, text: 'injected', width: 'big', fontSize: 40 })
    expect(win.setNotesLook).toHaveBeenCalledWith({ wpm: 200, fontSize: 40 })
  })

  it('notes:dismiss', () => {
    send('notes:dismiss', event(MAIN))
    send('notes:dismiss', event(BAR))
    expect(win.dismissNotes).not.toHaveBeenCalled()
    send('notes:dismiss', event(NOTES))
    expect(win.dismissNotes).toHaveBeenCalledTimes(1)
  })
})

describe('the recording bar channel', () => {
  it('notes:toggleShown answers the bar only', async () => {
    await invoke('notes:toggleShown', event(MAIN))
    await invoke('notes:toggleShown', event(NOTES))
    expect(win.toggleNotesShown).not.toHaveBeenCalled()
    await invoke('notes:toggleShown', event(BAR))
    expect(win.toggleNotesShown).toHaveBeenCalledTimes(1)
  })
})

describe('checkAnyHotkey', () => {
  const ctx = (o: Partial<HotkeyContext> = {}): HotkeyContext => ({
    recording: { ...DEFAULT_HOTKEYS },
    notes: { ...DEFAULT_NOTES_HOTKEYS },
    busy: false,
    tryRegister: () => true,
    ...o
  })

  it('refuses a notes hotkey equal to a recording hotkey, and the reverse', () => {
    expect(checkAnyHotkey('notesBack', 'Ctrl+Shift+2', ctx())).toEqual({ ok: false, message: 'Ctrl + Shift + 2 is already the hotkey for Stop.' })
    expect(checkAnyHotkey('stop', 'Ctrl+Shift+F6', ctx())).toEqual({ ok: false, message: 'Ctrl + Shift + F6 is already the hotkey for Notes: back.' })
    expect(checkAnyHotkey('notesToggle', 'Ctrl+Shift+F8', ctx())).toEqual({ ok: false, message: 'Ctrl + Shift + F8 is already the hotkey for Notes: forward.' })
  })

  it('accepts the six actions; anything else is unknown; invalid ones are explained', () => {
    for (const action of ['stop', 'pause', 'mark', 'notesToggle', 'notesBack', 'notesForward']) expect(checkAnyHotkey(action, 'Ctrl+Alt+K', ctx()).ok).toBe(true)
    expect(checkAnyHotkey('notesUp', 'Ctrl+Alt+K', ctx())).toEqual({ ok: false, message: 'Unknown hotkey.' })
    expect(checkAnyHotkey('notesBack', 'Ctrl+C', ctx()).ok).toBe(false)
  })

  it('asks other apps only outside a recording, and never for the current accelerator', () => {
    const tryRegister = vi.fn(() => false)
    expect(checkAnyHotkey('notesBack', 'Ctrl+Alt+K', ctx({ tryRegister }))).toEqual({ ok: false, message: 'Ctrl + Alt + K is already used by another app.' })
    expect(checkAnyHotkey('notesBack', 'Ctrl+Shift+F6', ctx({ tryRegister })).ok).toBe(true)
    expect(checkAnyHotkey('notesBack', 'Ctrl+Alt+K', ctx({ tryRegister, busy: true })).ok).toBe(true)
    expect(tryRegister).toHaveBeenCalledTimes(1)
    const throwing = () => {
      throw new Error('bad')
    }
    expect(checkAnyHotkey('pause', 'Ctrl+Alt+K', ctx({ tryRegister: throwing }))).toEqual({ ok: false, message: 'Ctrl + Alt + K cannot be used as a hotkey.' })
  })
})

describe('the recording hooks (recordingIpc)', async () => {
  // Auto-pause on, so the idle detector runs.
  fs.writeFileSync(path.join(h.userData, 'app-settings.json'), JSON.stringify({ version: 1, recording: { autoPause: true, idleSeconds: 3 } }))
  const { registerRecordingIpc, closeRecordingWindows, disposeRecording } = await import('../src/main/recordingIpc')
  registerRecordingIpc()
  const home = event(MAIN)
  const request = { sourceId: 'screen:1:0', region: null, systemAudio: false, captureKeys: true }
  const status = (token: string, state: string) => invoke('recording:status', home, token, { state, elapsed: 0 })
  const start = async (o: object = {}) => {
    h.order.length = 0
    const plan = (await invoke('recording:prepare', home, { ...request, ...o })) as { token: string; notesNotice?: string }
    return plan
  }
  const end = async (token: string) => {
    await invoke('recording:cancel', home, token, false)
  }

  it('prepare: the notes before the bar and before any hotkey; the screen as what is captured', async () => {
    win.next = { shown: true }
    const plan = await start()
    expect(h.order.indexOf('prepareNotes')).toBeLessThan(h.order.indexOf('prepareToolbar'))
    expect(h.order.indexOf('prepareNotes')).toBeLessThan(h.order.indexOf('register(Ctrl+Shift+2)'))
    expect(win.prepareRecordingNotes).toHaveBeenLastCalledWith({ kind: 'screen', display: expect.objectContaining({ id: 1 }), captured: { x: 0, y: 0, width: 1920, height: 1080 } }, h.userData)
    expect(plan.notesNotice).toBeUndefined()
    await end(plan.token)
  })

  it('prepare: the bar is placed clear of the notes', async () => {
    win.rect = { x: 680, y: 8, width: 560, height: 240 }
    const plan = await start({ region: { x: 0, y: 0.125, w: 1, h: 0.875 } })
    expect(h.toolbarArgs).toEqual([expect.objectContaining({ id: 1 }), { x: 0, y: 135, width: 1920, height: 945 }, [{ x: 680, y: 8, width: 560, height: 240 }]])
    await end(plan.token)
    // Without notes there is nothing to keep clear of.
    win.rect = null
    const again = await start()
    expect(h.toolbarArgs).toEqual([expect.objectContaining({ id: 1 }), null, []])
    await end(again.token)
  })

  it('prepare: an area is captured by its rectangle; the notice reaches the plan', async () => {
    win.next = { shown: false, notice: 'hidden on this Windows' }
    const plan = await start({ region: { x: 0, y: 0.5, w: 0.5, h: 0.5 } })
    expect(win.prepareRecordingNotes).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'area', captured: { x: 0, y: 540, width: 960, height: 540 } }), h.userData)
    expect(plan.notesNotice).toBe('hidden on this Windows')
    await end(plan.token)
    win.next = { shown: true }
    const again = await start()
    expect(again.notesNotice).toBeUndefined()
    await end(again.token)
  })

  it('the countdown shows the notes before the bar; pause and resume follow; the bar shows them', async () => {
    win.status = { shown: true, playing: false }
    const { token } = await start()
    h.order.length = 0
    await status(token, 'countdown')
    expect(h.order).toEqual(['showNotes', 'notes:countdown', 'showToolbar', 'raiseToolbar'])
    expect(h.statuses.at(-1)).toMatchObject({
      notes: { shown: true, playing: false },
      hotkeys: { stop: 'Ctrl + Shift + 2', notesToggle: 'Ctrl + Shift + F7' },
      hotkeyProblems: [expect.stringContaining('Notes: back')]
    })
    await invoke('recording:started', home, token, { method: 'chromium', startedAt: Date.now(), width: 1920, height: 1080, hasAudio: false, hasWebcam: false, webcamFps: 30 })
    await status(token, 'recording')
    await status(token, 'paused')
    await status(token, 'recording')
    expect(h.order.filter((o) => o.startsWith('notes:'))).toEqual(['notes:countdown', 'notes:recording', 'notes:paused', 'notes:recording'])
    // A change in the notes (hidden from the bar) reaches the bar.
    win.status = { shown: false, playing: false }
    const sent = h.statuses.length
    win.listeners.forEach((l) => l())
    expect(h.statuses.length).toBe(sent + 1)
    expect(h.statuses.at(-1).notes).toEqual({ shown: false, playing: false })
    // Notes shown (or moved) after the bar: the bar goes back above them.
    h.order.length = 0
    win.listeners.forEach((l) => l())
    expect(h.order).toEqual(['raiseToolbar'])
    await end(token)
    win.status = null
  })

  it('the tracker ignores the notes hotkeys and asks the notes area with the event time', async () => {
    win.status = { shown: true, playing: false }
    const { token } = await start()
    await status(token, 'countdown')
    await invoke('recording:started', home, token, { method: 'chromium', startedAt: Date.now(), width: 1920, height: 1080, hasAudio: false, hasWebcam: false, webcamFps: 30 })
    expect(h.trackerOpts.ignoreKeys).toEqual(expect.arrayContaining(['Ctrl + Shift + 2', 'Ctrl + Shift + F7']))
    win.area.mockImplementation((_p, at) => at === 1234)
    expect(h.trackerOpts.isOwnPoint({ x: 500, y: 500 }, 1234)).toBe(true)
    expect(h.trackerOpts.isOwnPoint({ x: 500, y: 500 }, 1235)).toBe(false)
    expect(win.area).toHaveBeenLastCalledWith({ x: 500, y: 500 }, 1235)
    // The bar's places still count, whatever the time.
    expect(h.trackerOpts.isOwnPoint({ x: 10, y: 1010 }, 1)).toBe(true)
    await end(token)
    win.status = null
  })

  it('auto-pause waits while the notes scroll', async () => {
    const { token } = await start()
    await status(token, 'countdown')
    await invoke('recording:started', home, token, { method: 'chromium', startedAt: Date.now(), width: 1920, height: 1080, hasAudio: false, hasWebcam: false, webcamFps: 30 })
    await status(token, 'recording')
    const commands = () => h.sentToMain.filter(([c]) => c === 'recorder:command').map(([, v]) => v)
    h.sentToMain.length = 0
    win.playing = true
    h.idle.callbacks.onIdle()
    expect(h.idle.activity).toHaveBeenCalledTimes(1)
    expect(commands()).toEqual([])
    win.playing = false
    h.idle.callbacks.onIdle()
    expect(commands()).toEqual(['pause'])
    await end(token)
  })

  it('a window recording keeps the cursor on the window over the notes and the bar, where the helper says it is off the window', async () => {
    const T = Date.now()
    const R = { x: 0, y: 0, width: 1920, height: 1080 }
    // The helper reports the cursor off the recorded window for the whole take.
    h.windowMapping = { poses: [{ at: T - 1000, dip: R, physical: R, cursorOver: false }], out: { width: 1920, height: 1080 } }
    h.rawTrack = {
      samples: [
        { at: T + 500, x: 960, y: 100 }, // over the notes
        { at: T + 1500, x: 50, y: 1010 }, // over the bar (toolbarAreas)
        { at: T + 2500, x: 960, y: 700 } // over another window
      ],
      clicks: [],
      keys: [],
      bounds: null,
      scale: 1
    }
    win.area.mockImplementation((p, at) => at === T + 500 && (p as { y: number }).y < 300)
    const { token } = await start({ sourceId: 'window:5:0' })
    await invoke('recording:started', home, token, { method: 'chromium', startedAt: T, width: 1920, height: 1080, hasAudio: false, hasWebcam: false, webcamFps: 30 })
    await expect(invoke('recording:save', home, token, { startedAt: T, duration: 5, webcamOffset: 0, audioOffset: 0 })).resolves.toBe('r1')
    const at = (t: number) => h.cursorTrack.samples.find((s: { t: number }) => Math.abs(s.t - t) < 1e-6)
    expect(win.area).toHaveBeenCalledWith(expect.objectContaining({ x: 960, y: 100 }), T + 500)
    expect(at(0.5).x).toBeCloseTo(0.5, 9)
    expect(at(0.5).y).toBeCloseTo(100 / 1080, 9)
    expect(at(1.5).x).toBeCloseTo(50 / 1920, 9)
    expect(at(2.5).y).toBeGreaterThan(1)
    win.area.mockImplementation(() => false)
    h.windowMapping = null
    h.rawTrack = null
  })

  it('a restarted take that cannot be prepared closes the notes window kept for it', async () => {
    const first = await start()
    await invoke('recording:cancel', home, first.token, true)
    h.order.length = 0
    await expect(invoke('recording:prepare', home, { ...request, region: { x: 0, y: 0, w: 0.001, h: 0.001 } })).rejects.toThrow(/too small/)
    expect(h.order).toEqual(['discardKeptNotes'])
    // A second prepare refused while a recording runs closes nothing.
    const second = await start()
    h.order.length = 0
    await expect(invoke('recording:prepare', home, request)).rejects.toThrow(/already in progress/)
    expect(h.order).not.toContain('discardKeptNotes')
    await end(second.token)
  })

  it('the end closes the notes, or keeps them for a restarted take', async () => {
    const first = await start()
    await invoke('recording:cancel', home, first.token, true)
    expect(h.order.at(-1)).toBe('endNotes(true)')
    const second = await start()
    await status(second.token, 'idle')
    expect(h.order.at(-1)).toBe('endNotes(false)')
  })

  it('picking an area hides a rehearsal window meanwhile', async () => {
    h.order.length = 0
    await invoke('recording:pickRegion', home, 'screen:1:0')
    expect(h.order).toEqual(['hideNotes', 'pickRegion', 'showNotesAgain'])
  })

  it('a recording hotkey may not take a notes hotkey; a changed recording hotkey reaches the notes window', async () => {
    await expect(invoke('settings:checkHotkey', home, 'stop', 'Ctrl+Shift+F6')).resolves.toEqual({ ok: false, message: 'Ctrl + Shift + F6 is already the hotkey for Notes: back.' })
    await expect(invoke('settings:checkHotkey', home, 'notesBack', 'Ctrl+Shift+F9')).resolves.toEqual({ ok: false, message: 'Ctrl + Shift + F9 is already the hotkey for Pause / resume.' })
    await invoke('settings:updateRecording', home, { hotkeys: { mark: 'Ctrl+Shift+F7' } })
    expect(win.notesSettingsChanged).toHaveBeenCalled()
    expect(notesStore().get().hotkeys.notesToggle).toBe('')
  })

  it('closing the main window closes the notes; quitting writes what the store held', () => {
    h.order.length = 0
    closeRecordingWindows()
    expect(h.order).toEqual(['closeToolbar', 'closeNotes'])
    const release = vi.spyOn(notesStore(), 'release')
    disposeRecording()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
