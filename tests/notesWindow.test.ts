import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fsm = require('node:fs') as typeof import('node:fs')
  const pathm = require('node:path') as typeof import('node:path')
  return {
    userData: fsm.mkdtempSync(pathm.join(os.tmpdir(), 'ssw-notes-win-')),
    /** Every call on every fake window, in order: "<id>:<method>". */
    log: [] as string[],
    windows: [] as any[],
    shortcuts: new Map<string, () => void>(),
    /** Accelerators another app owns. */
    owned: new Set<string>(),
    screenEvents: new Map<string, () => void>(),
    displays: [] as any[],
    /** getBounds() after the first show returns this instead (mixed-DPI misplacement), once. */
    misplace: null as null | { x: number; y: number; width: number; height: number },
    mainFocus: 0
  }
})

vi.mock('electron', () => {
  let nextId = 1
  class FakeWebContents {
    readonly id = nextId++
    readonly events = new Map<string, () => void>()
    readonly sent: [string, unknown][] = []
    destroyed = false
    on(event: string, cb: () => void) {
      this.events.set(event, cb)
      return this
    }
    send(channel: string, value: unknown) {
      this.sent.push([channel, structuredClone(value)])
    }
    isDestroyed = () => this.destroyed
    isCrashed = () => false
  }
  class BrowserWindow {
    readonly tag: string
    readonly options: any
    readonly webContents: FakeWebContents
    readonly events = new Map<string, ((...a: unknown[]) => void)[]>()
    bounds: { x: number; y: number; width: number; height: number }
    visible = false
    destroyed = false
    constructor(options: any) {
      this.options = options
      this.tag = `w${h.windows.length + 1}`
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      this.webContents = new FakeWebContents()
      h.windows.push(this)
      h.log.push(`${this.tag}:new`)
    }
    private record(what: string) {
      h.log.push(`${this.tag}:${what}`)
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      this.events.set(event, [...(this.events.get(event) ?? []), cb])
      return this
    }
    once(event: string, cb: (...a: unknown[]) => void) {
      return this.on(event, cb)
    }
    emit(event: string) {
      for (const cb of this.events.get(event) ?? []) cb()
    }
    setContentProtection(v: boolean) {
      this.record(`setContentProtection(${v})`)
    }
    setAlwaysOnTop(v: boolean, level?: string) {
      this.record(`setAlwaysOnTop(${v},${level})`)
    }
    setBounds(r: any) {
      this.record('setBounds')
      this.bounds = { ...r }
    }
    getBounds() {
      if (h.misplace && this.visible) {
        const m = h.misplace
        h.misplace = null
        this.bounds = { ...m }
      }
      return { ...this.bounds }
    }
    show() {
      this.record('show')
      this.visible = true
    }
    showInactive() {
      this.record('showInactive')
      this.visible = true
    }
    hide() {
      this.record('hide')
      this.visible = false
    }
    focus() {
      this.record('focus')
    }
    moveTop() {
      this.record('moveTop')
    }
    isVisible = () => this.visible
    isDestroyed = () => this.destroyed
    destroy() {
      if (this.destroyed) return
      this.record('destroy')
      this.destroyed = true
      this.webContents.destroyed = true
      this.visible = false
      this.emit('closed')
    }
  }
  return {
    app: { getPath: () => h.userData, isPackaged: false },
    BrowserWindow,
    globalShortcut: {
      register: (a: string, cb: () => void) => {
        if (h.owned.has(a)) return false
        h.shortcuts.set(a, cb)
        return true
      },
      unregister: (a: string) => void h.shortcuts.delete(a)
    },
    screen: {
      getPrimaryDisplay: () => h.displays[0],
      getAllDisplays: () => h.displays,
      getDisplayMatching: () => h.displays[0],
      on: (event: string, cb: () => void) => h.screenEvents.set(event, cb)
    }
  }
})

vi.mock('../src/main/windows', () => ({
  preloadPath: '/preload.js',
  loadRoute: (win: { tag: string }, route: string) => h.log.push(`${win.tag}:load(${route})`),
  getMainWindow: () => ({ isDestroyed: () => false, isVisible: () => true, show: () => undefined, focus: () => void h.mainFocus++ })
}))

import { notesStore } from '../src/main/notes/notesStore'
import * as notes from '../src/main/notes/notesWindow'
import { NOTES_FILE } from '../src/main/notes/notesStore'
import { execFileSync } from 'node:child_process'
import { ffmpegPath } from '../src/main/ffmpeg'
import * as projects from '../src/main/projects'
import { SCRIPT_FILE, readScriptFile } from '../src/main/projects'
import { processRecording } from '../src/main/recording/finalize'

const D1 = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const DEFAULT_RECT = { x: 680, y: 8, width: 560, height: 240 }
const screenPlan = (captured = D1.bounds): notes.RecordingNotesPlan => ({ kind: 'screen', display: D1 as never, captured })
const g = globalThis as { __SSW_CAPTURE_EXCLUSION__?: boolean }

const last = (): any => h.windows[h.windows.length - 1]
const calls = (win: any): string[] => h.log.filter((l) => l.startsWith(`${win.tag}:`)).map((l) => l.slice(win.tag.length + 1))
const views = (win: any): any[] => win.webContents.sent.filter(([c]: [string]) => c === 'notes:view').map(([, v]: [string, unknown]) => v)
const commands = (win: any): unknown[] => win.webContents.sent.filter(([c]: [string]) => c === 'notes:command').map(([, v]: [string, unknown]) => v)
let recDir = ''

function setNotes(patch: object): void {
  notesStore().update({ text: 'Intro\n\n- Open Settings', showWhileRecording: true, keepWithRecording: true, placement: null, width: 560, height: 240, ...patch })
}

/** Prepares a recording with notes and shows them as the countdown does. */
function startRecording(plan = screenPlan()): any {
  expect(notes.prepareRecordingNotes(plan, recDir)).toEqual({ shown: true })
  const win = last()
  win.emit('ready-to-show')
  notes.showNotes()
  notes.setNotesRecording('countdown')
  return win
}

beforeEach(() => {
  h.displays = [D1]
  h.log.length = 0
  h.owned.clear()
  h.misplace = null
  recDir = fs.mkdtempSync(path.join(h.userData, 'rec-'))
  setNotes({})
})

afterEach(() => {
  notes.endRecordingNotes(false)
  notes.closeNotes()
  delete g.__SSW_CAPTURE_EXCLUSION__
  vi.useRealTimers()
})

describe('the recording window', () => {
  it('never takes focus, stays on top and out of the taskbar, with no frame to snap', () => {
    notes.prepareRecordingNotes(screenPlan(), recDir)
    expect(last().options).toMatchObject({
      ...DEFAULT_RECT,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      resizable: false,
      thickFrame: false,
      transparent: false,
      frame: false,
      movable: true,
      show: false,
      backgroundColor: '#0e0e11',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: '/preload.js' }
    })
  })

  it('is protected before its page loads and before it is shown; never show(), focus() or moveTop()', () => {
    const win = startRecording()
    notes.setNotesRecording('recording')
    notes.toggleNotesShown()
    notes.toggleNotesShown()
    notes.notesHotkey('notesToggle')
    const c = calls(win)
    expect(c.indexOf('setContentProtection(true)')).toBeGreaterThan(-1)
    expect(c.indexOf('setContentProtection(true)')).toBeLessThan(c.indexOf('load(/notes)'))
    expect(c.indexOf('setContentProtection(true)')).toBeLessThan(c.indexOf('showInactive'))
    expect(c).toContain('setAlwaysOnTop(true,screen-saver)')
    expect(c).not.toContain('show')
    expect(c).not.toContain('focus')
    expect(c).not.toContain('moveTop')
  })

  it('is shown only once ready, and showing it again is idempotent', () => {
    notes.prepareRecordingNotes(screenPlan(), recDir)
    const win = last()
    notes.showNotes()
    expect(calls(win)).not.toContain('showInactive')
    win.emit('ready-to-show')
    expect(calls(win).filter((c) => c === 'showInactive')).toHaveLength(1)
    // Countdown statuses arrive every second.
    notes.showNotes()
    notes.showNotes()
    expect(calls(win).filter((c) => c === 'showInactive')).toHaveLength(1)
  })

  it('is put back where it belongs when Electron misplaced it on the first show (mixed DPI)', () => {
    notes.prepareRecordingNotes(screenPlan(), recDir)
    const win = last()
    win.emit('ready-to-show')
    h.misplace = { ...DEFAULT_RECT, width: 840, height: 360 }
    notes.showNotes()
    expect(calls(win).slice(-1)).toEqual(['setBounds'])
    expect(win.bounds).toEqual(DEFAULT_RECT)
  })

  it('a 1 DIP difference is left alone', () => {
    notes.prepareRecordingNotes(screenPlan(), recDir)
    const win = last()
    win.emit('ready-to-show')
    h.misplace = { ...DEFAULT_RECT, x: DEFAULT_RECT.x + 1 }
    const before = calls(win).filter((c) => c === 'setBounds').length
    notes.showNotes()
    expect(calls(win).filter((c) => c === 'setBounds').length).toBe(before)
  })

  it('reloads its page when it crashed, and sends the view again', () => {
    const win = startRecording()
    win.webContents.events.get('render-process-gone')()
    expect(calls(win).filter((c) => c === 'load(/notes)')).toHaveLength(2)
    const sent = views(win).length
    win.webContents.events.get('did-finish-load')()
    expect(views(win).length).toBe(sent + 1)
  })

  it('follows the recording: countdown, recording, paused; one new take per recording', () => {
    const win = startRecording()
    const first = views(win).at(-1)
    expect(first).toMatchObject({ mode: 'record', recording: 'countdown', shown: true, locked: false })
    notes.setNotesRecording('countdown')
    notes.setNotesRecording('recording')
    notes.setNotesRecording('paused')
    expect(views(win).map((v) => v.recording).slice(-3)).toEqual(['countdown', 'recording', 'paused'])
    expect(views(win).at(-1).take).toBe(first.take)
    // Restarting: the same window, a new take.
    notes.endRecordingNotes(true)
    notes.prepareRecordingNotes(screenPlan(), recDir)
    expect(last()).toBe(win)
    expect(views(win).at(-1).take).toBe(first.take + 1)
  })

  it('end: hidden and kept when restarting, destroyed otherwise; hotkeys released either way', () => {
    const win = startRecording()
    expect([...h.shortcuts.keys()].sort()).toEqual(['Ctrl+Shift+F6', 'Ctrl+Shift+F7', 'Ctrl+Shift+F8'])
    notes.endRecordingNotes(true)
    expect(win.destroyed).toBe(false)
    expect(win.visible).toBe(false)
    expect(h.shortcuts.size).toBe(0)
    notes.prepareRecordingNotes(screenPlan(), recDir)
    expect(h.shortcuts.size).toBe(3)
    notes.endRecordingNotes(false)
    expect(win.destroyed).toBe(true)
    expect(h.shortcuts.size).toBe(0)
    expect(notes.notesStatus()).toBeNull()
  })

  it('the bar hides and shows it; a hotkey while hidden only shows it again', () => {
    const win = startRecording()
    notes.toggleNotesShown()
    expect(win.visible).toBe(false)
    expect(notes.notesStatus()).toEqual({ shown: false, playing: false })
    expect(views(win).at(-1).shown).toBe(false)
    h.shortcuts.get('Ctrl+Shift+F7')!()
    expect(win.visible).toBe(true)
    expect(calls(win).slice(-1)).toEqual(['showInactive'])
    expect(commands(win)).toEqual([])
    // Shown: hotkeys reach the page.
    h.shortcuts.get('Ctrl+Shift+F7')!()
    h.shortcuts.get('Ctrl+Shift+F6')!()
    h.shortcuts.get('Ctrl+Shift+F8')!()
    expect(commands(win)).toEqual(['toggle', 'back', 'forward'])
  })

  it('its close button hides it while recording', () => {
    const win = startRecording()
    notes.dismissNotes()
    expect(win.visible).toBe(false)
    expect(win.destroyed).toBe(false)
  })

  it('clicks over the notes are not content, judged by when they happened', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000)
    startRecording()
    const inside = { x: DEFAULT_RECT.x + 10, y: DEFAULT_RECT.y + 10 }
    expect(notes.notesAreaContains(inside, 10_100)).toBe(true)
    expect(notes.notesAreaContains({ x: 10, y: 500 }, 10_100)).toBe(false)
    vi.setSystemTime(12_000)
    notes.toggleNotesShown()
    expect(notes.notesAreaContains(inside, 12_100)).toBe(true)
    expect(notes.notesAreaContains(inside, 12_500)).toBe(false)
    // A new recording starts with no history.
    notes.endRecordingNotes(false)
    notes.prepareRecordingNotes(screenPlan(), recDir)
    expect(notes.notesAreaContains(inside, 11_000)).toBe(false)
  })

  it('a drag is remembered where it ended', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(20_000)
    const win = startRecording()
    win.bounds = { x: 100, y: 500, width: 560, height: 240 }
    vi.setSystemTime(21_000)
    win.emit('moved')
    expect(notes.notesAreaContains({ x: 110, y: 510 }, 21_100)).toBe(true)
    expect(notes.notesAreaContains({ x: DEFAULT_RECT.x + 300, y: 20 }, 21_500)).toBe(false)
    expect(notes.notesSettingsNow().placement).toMatchObject({ displayId: '1' })
  })

  it('reports drive the bar and auto-pause: playing only while shown and not at the end', () => {
    startRecording()
    const changed = vi.fn()
    const off = notes.onNotesChange(changed)
    notes.setNotesReport({ playing: true, ended: false, block: 0 })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(notes.notesPlaying()).toBe(true)
    expect(notes.notesStatus()).toEqual({ shown: true, playing: true })
    // The block alone changes nothing the bar shows.
    notes.setNotesReport({ playing: true, ended: false, block: 1 })
    expect(changed).toHaveBeenCalledTimes(1)
    notes.setNotesReport({ playing: true, ended: true, block: 1 })
    expect(notes.notesPlaying()).toBe(false)
    notes.setNotesReport({ playing: true, ended: false, block: 1 })
    notes.toggleNotesShown()
    expect(notes.notesPlaying()).toBe(false)
    off()
  })

  it('hotkeys another app owns are reported, and kept out of the labels', () => {
    h.owned.add('Ctrl+Shift+F7')
    const win = startRecording()
    expect(notes.notesHotkeyProblems()).toEqual([expect.stringContaining('Notes: play / pause')])
    expect(notes.notesHotkeyLabels()).toEqual({ notesBack: 'Ctrl + Shift + F6', notesForward: 'Ctrl + Shift + F8' })
    expect(views(win).at(-1)).toMatchObject({ problems: [expect.stringContaining('used by another app')], hotkeys: { notesBack: 'Ctrl + Shift + F6' } })
  })

  it('is placed again when the displays change', () => {
    const win = startRecording()
    h.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 0, width: 1280, height: 680 } }]
    h.screenEvents.get('display-metrics-changed')!()
    expect(win.bounds).toEqual({ x: 360, y: 8, width: 560, height: 240 })
    h.displays = [D1]
    h.screenEvents.get('display-removed')!()
    expect(win.bounds).toEqual(DEFAULT_RECT)
  })

  it('is not used without text, or when switched off', () => {
    setNotes({ text: '  \n' })
    expect(notes.prepareRecordingNotes(screenPlan(), recDir)).toEqual({ shown: false })
    setNotes({ showWhileRecording: false })
    expect(notes.prepareRecordingNotes(screenPlan(), recDir)).toEqual({ shown: false })
    expect(h.windows.filter((w) => !w.destroyed)).toHaveLength(0)
    expect(h.shortcuts.size).toBe(0)
  })
})

describe('older Windows', () => {
  beforeEach(() => {
    g.__SSW_CAPTURE_EXCLUSION__ = false
  })

  it('notes over what is recorded stay hidden, with a notice; no window, no hotkeys', () => {
    const count = h.windows.length
    const result = notes.prepareRecordingNotes(screenPlan(), recDir)
    expect(result).toEqual({ shown: false, notice: notes.NOTES_NOTICE.screen })
    expect(result.notice).toMatch(/^Your notes stay hidden in this recording/)
    expect(h.windows.length).toBe(count)
    expect(h.shortcuts.size).toBe(0)
    expect(notes.prepareRecordingNotes({ kind: 'window', display: null, captured: null }, recDir)).toEqual({ shown: false, notice: notes.NOTES_NOTICE.window })
  })

  it('notes off the recorded area are shown, locked in place', () => {
    const win = startRecording({ kind: 'area', display: D1 as never, captured: { x: 0, y: 300, width: 800, height: 600 } })
    expect(win.options.movable).toBe(false)
    expect(views(win).at(-1).locked).toBe(true)
    // The grip cannot grow it into the capture.
    notes.setNotesLook({ width: 1200, height: 720, wpm: 150 })
    expect(win.bounds).toEqual(DEFAULT_RECT)
    expect(notes.notesSettingsNow()).toMatchObject({ width: 560, height: 240, wpm: 150 })
  })

  it('rehearsal still works', () => {
    expect(notes.openRehearsal()).toBe(true)
    expect(last().options.movable).toBe(true)
  })
})

describe('rehearsal', () => {
  it('a focusable window shown with show(), holding the notes hotkeys', () => {
    expect(notes.openRehearsal()).toBe(true)
    const win = last()
    expect(win.options).toMatchObject({ focusable: true, movable: true, resizable: false, thickFrame: false })
    const c = calls(win)
    expect(c.indexOf('setContentProtection(true)')).toBeLessThan(c.indexOf('load(/notes)'))
    win.emit('ready-to-show')
    expect(calls(win)).toContain('show')
    expect(h.shortcuts.size).toBe(3)
    expect(notes.notesView()).toMatchObject({ mode: 'rehearse', recording: null, shown: true, locked: false })
    expect(notes.notesWindowInfo()).toEqual({ mode: 'rehearse', shown: true, playing: false })
    // The bar's controls do nothing to a rehearsal.
    notes.toggleNotesShown()
    expect(win.visible).toBe(true)
    expect(notes.notesStatus()).toBeNull()
  })

  it('its close button closes it, releases the hotkeys and focuses Home', () => {
    notes.openRehearsal()
    const win = last()
    const focus = h.mainFocus
    notes.dismissNotes()
    expect(win.destroyed).toBe(true)
    expect(h.shortcuts.size).toBe(0)
    expect(h.mainFocus).toBe(focus + 1)
    expect(notes.notesWindowInfo()).toBeNull()
  })

  it('closed from Home: no focus change', () => {
    notes.openRehearsal()
    const focus = h.mainFocus
    notes.closeRehearsal()
    expect(h.mainFocus).toBe(focus)
  })

  it('is refused while a recording runs, and starting one closes it for a new, unfocusable window', () => {
    notes.openRehearsal()
    const rehearsal = last()
    rehearsal.emit('ready-to-show')
    notes.prepareRecordingNotes(screenPlan(), recDir)
    expect(rehearsal.destroyed).toBe(true)
    const rec = last()
    expect(rec).not.toBe(rehearsal)
    expect(rec.options.focusable).toBe(false)
    expect(rec.options).toMatchObject({ x: rehearsal.options.x, y: rehearsal.options.y })
    expect(notes.openRehearsal()).toBe(false)
    notes.endRecordingNotes(false)
    expect(notes.openRehearsal()).toBe(true)
  })

  it('is hidden while an area is picked, then shown again', () => {
    notes.openRehearsal()
    const win = last()
    win.emit('ready-to-show')
    const again = notes.hideNotesWhilePicking()
    expect(win.visible).toBe(false)
    again()
    expect(win.visible).toBe(true)
  })

  it('takes a changed hotkey at once, and its new size', () => {
    notes.openRehearsal()
    const win = last()
    notesStore().update({ hotkeys: { notesToggle: 'Ctrl+Alt+P' }, width: 700 })
    notes.notesSettingsChanged()
    expect([...h.shortcuts.keys()].sort()).toEqual(['Ctrl+Alt+P', 'Ctrl+Shift+F6', 'Ctrl+Shift+F8'])
    expect(win.bounds).toEqual({ x: 610, y: 8, width: 700, height: 240 })
    expect(views(win).at(-1).hotkeys.notesToggle).toBe('Ctrl + Alt + P')
  })

  it('the grip keeps the top-left corner and clamps the size; sent only when something changed', () => {
    notes.openRehearsal()
    const win = last()
    win.bounds = { x: 1500, y: 100, width: 560, height: 240 }
    notes.setNotesLook({ width: 5000, height: 50 })
    // At most 1200 wide, and within the work area: moved left as little as needed.
    expect(win.bounds).toEqual({ x: 1920 - 1200, y: 100, width: 1200, height: 140 })
    const sent = views(win).length
    notes.setNotesLook({})
    notes.notesSettingsChanged()
    expect(views(win).length).toBe(sent)
  })
})

describe('kept with the recording', () => {
  it('writes script.txt when keepWithRecording, and finalize reads it back', async () => {
    startRecording()
    const file = path.join(recDir, SCRIPT_FILE)
    await vi.waitFor(() => expect(fs.existsSync(file) && fs.readFileSync(file, 'utf8')).toBe('Intro\n\n- Open Settings'))
    await expect(readScriptFile(recDir)).resolves.toEqual({ text: 'Intro\n\n- Open Settings' })
  })

  it('writes nothing when it is off', async () => {
    setNotes({ keepWithRecording: false })
    startRecording()
    await new Promise((r) => setTimeout(r, 20))
    expect(fs.existsSync(path.join(recDir, SCRIPT_FILE))).toBe(false)
    await expect(readScriptFile(recDir)).resolves.toBeUndefined()
  })

  it('readScriptFile cleans and caps what it reads', async () => {
    fs.writeFileSync(path.join(recDir, SCRIPT_FILE), `a\r\nb${'x'.repeat(60_000)}`)
    const script = await readScriptFile(recDir)
    expect(script?.text.startsWith('a\nb')).toBe(true)
    expect(script?.text.length).toBe(50_000)
    fs.writeFileSync(path.join(recDir, SCRIPT_FILE), ' \n ')
    await expect(readScriptFile(recDir)).resolves.toBeUndefined()
  })
})

const ffmpeg = ffmpegPath()
describe.skipIf(ffmpeg === 'ffmpeg' || !fs.existsSync(ffmpeg))('a processed recording keeps its script (real ffmpeg)', () => {
  it('finalize copies script.txt into project.script; without it there is none', async () => {
    const T0 = 1_700_000_000_000
    for (const withScript of [true, false]) {
      const { id, dir } = await projects.createProjectDir(new Date(T0))
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=60:duration=1', '-c:v', 'libx264', path.join(dir, 'native.mp4')])
      const m: projects.RecordingManifest = {
        version: 1,
        id,
        createdAt: new Date(T0).toISOString(),
        status: 'processing',
        error: null,
        method: 'native',
        sourceKind: 'screen',
        region: null,
        startedAt: T0,
        width: 320,
        height: 240,
        hasAudio: false,
        hasWebcam: false,
        webcamFps: 30,
        webcamOffset: 0,
        audioOffset: 0,
        duration: 1
      }
      await projects.writeManifest(m)
      if (withScript) await projects.writeScriptFile(dir, 'Intro\r\n\n- Open Settings')
      const project = await processRecording(m, () => undefined)
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))
      if (withScript) {
        expect(project.script).toEqual({ text: 'Intro\n\n- Open Settings' })
        expect(saved.script).toEqual({ text: 'Intro\n\n- Open Settings' })
        // Kept: not an intermediate.
        expect(fs.existsSync(path.join(dir, SCRIPT_FILE))).toBe(true)
      } else {
        expect(project.script).toBeUndefined()
        expect(saved.script).toBeUndefined()
      }
    }
  }, 60_000)
})

describe('the store during a recording', () => {
  it('changes from the window are held until the recording ends', () => {
    vi.useFakeTimers()
    startRecording()
    const file = path.join(h.userData, NOTES_FILE)
    const before = fs.readFileSync(file, 'utf8')
    notes.setNotesLook({ wpm: 200 })
    vi.advanceTimersByTime(1000)
    expect(notes.notesSettingsNow().wpm).toBe(200)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    notes.endRecordingNotes(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).wpm).toBe(200)
  })
})
