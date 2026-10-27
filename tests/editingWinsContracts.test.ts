import { describe, expect, it } from 'vitest'
import { PREF_KEYS } from '../src/shared/api/prefs'
import { outputTimeAt } from '../src/shared/editor/clips'
import { COMMAND_IDS, commandInfo, PALETTE_COMMANDS, type CommandId } from '../src/shared/editor/commands'
import { DEFAULT_POLISH_OPTIONS, POLISH_STEPS, readPolishOptions } from '../src/shared/editor/polish'
import { checkShortcut, chordFromEvent, DEFAULT_KEYMAP, findConflicts, matchShortcut, shortcutIndex, type KeyInput } from '../src/shared/editor/shortcuts'
import { cropOf, cropPixels, cropView, FULL_FRAME, MIN_CROP_PX, readCrop, visibleSize } from '../src/shared/engine/crop'
import {
  editToVideo,
  FREEZE,
  FREEZE_EPS,
  freezeKeepRanges,
  MAX_FREEZES,
  NO_FREEZES,
  pictureTime,
  planOf,
  videoDuration,
  videoFrames,
  videoTimeAt,
  videoToEdit,
  videoToSource
} from '../src/shared/engine/freeze'
import { clampFreezes, readFreezes } from '../src/shared/engine/freezeData'
import { createProject, migrateCursor, migrateProject } from '../src/shared/engine/project'
import { exportFrameTimes, outputDuration, outputToSource } from '../src/shared/engine/timeline'
import type { Clip, Freeze } from '../src/shared/types'

/** A project.json as a build before this wave saved it (no crop, no freezes). */
const OLD = {
  version: 2,
  id: 'rec-old',
  name: 'Before wave 6',
  createdAt: '2026-01-02T03:04:05.000Z',
  duration: 12,
  width: 1280,
  height: 720,
  hasWebcam: false,
  hasAudio: true,
  webcamOffset: 0,
  capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 },
  clips: [
    { id: 'c0', start: 0, end: 4, speed: 1 },
    { id: 'c1', start: 6, end: 12, speed: 2 }
  ],
  zooms: [{ id: 'z1', start: 1, end: 3, scale: 2, focus: 'cursor', auto: true }],
  autoZoom: true,
  annotations: [],
  style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' },
  cursor: { show: true, size: 1.4, smoothing: 0.6, clickEffect: true, hideWhenIdle: true },
  webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
  effects: { motionBlur: 0.5, keystrokes: { show: true, position: 'bottom', size: 0.035 } },
  audio: { volume: 1, muted: false },
  shapes: [],
  spotlights: [],
  layouts: [],
  titles: [],
  chapters: [
    { id: 'h1', t: 2, title: 'Intro' },
    { id: 'h2', t: 7, title: 'Demo' }
  ]
}

/** What migrateProject made of OLD before this wave (captured from the previous commit). */
const OLD_MIGRATED =
  '{"version":2,"id":"rec-old","name":"Before wave 6","createdAt":"2026-01-02T03:04:05.000Z","duration":12,"width":1280,"height":720,' +
  '"hasWebcam":false,"hasAudio":true,"webcamOffset":0,"capture":{"method":"native","cursorInVideo":false,"region":null,"target":"screen","fps":60},' +
  '"clips":[{"id":"c0","start":0,"end":4,"speed":1},{"id":"c1","start":6,"end":12,"speed":2}],' +
  '"zooms":[{"id":"z1","start":1,"end":3,"scale":2,"focus":"cursor","auto":true}],"autoZoom":true,"annotations":[],' +
  '"style":{"background":{"type":"gradient","preset":"aurora"},"padding":0.07,"cornerRadius":14,"shadow":0.6,"aspectRatio":"auto"},' +
  '"cursor":{"show":true,"size":1.4,"smoothing":0.6,"clickEffect":true,"hideWhenIdle":true},' +
  '"webcam":{"show":false,"corner":"bottom-right","size":0.24,"shape":"circle"},' +
  '"effects":{"motionBlur":0.5,"keystrokes":{"show":true,"position":"bottom","size":0.035}},"audio":{"volume":1,"muted":false},' +
  '"shapes":[],"spotlights":[],"layouts":[],"titles":[],"chapters":[{"id":"h1","t":2,"title":"Intro"},{"id":"h2","t":7,"title":"Demo"}]}'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const freeze = (id: string, at: number, length = 3, sound: Freeze['sound'] = 'pause'): Freeze => ({ id, at, length, sound })

describe('projects from before this wave', () => {
  it('come out of migrateProject exactly as before: no crop, no freezes', () => {
    const p = migrateProject(clone(OLD))
    expect(JSON.stringify(p)).toBe(OLD_MIGRATED)
    expect('crop' in p).toBe(false)
    expect('freezes' in p).toBe(false)
    expect(JSON.stringify(migrateProject(clone(p)))).toBe(OLD_MIGRATED)
  })

  it('a new project has neither key either', () => {
    const p = createProject({
      id: 'x', name: 'x', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: true,
      capture: { method: 'native', cursorInVideo: false, region: null }
    })
    const m = migrateProject(clone(p))
    expect('crop' in m).toBe(false)
    expect('freezes' in m).toBe(false)
  })

  it('plan to NO_FREEZES and have no crop, so every map is the identity', () => {
    const p = migrateProject(clone(OLD))
    expect(planOf(p)).toBe(NO_FREEZES)
    expect(planOf({ clips: p.clips, freezes: [] })).toBe(NO_FREEZES)
    expect(Object.isFrozen(NO_FREEZES) && Object.isFrozen(NO_FREEZES.holds) && Object.isFrozen(NO_FREEZES.stills)).toBe(true)
    expect(NO_FREEZES).toEqual({ holds: [], stills: [], added: 0, inactive: [] })
    expect(cropOf(p)).toBeNull()
    expect(visibleSize(p)).toEqual({ width: 1280, height: 720 })
    const track = migrateCursor({ samples: [{ t: 0, x: 0.5, y: 0.5 }], clicks: [], valid: true })
    const view = cropView(p, track)
    expect(view.project).toBe(p)
    expect(view.cursor).toBe(track)
    expect(view.crop).toBeNull()
  })
})

describe('crop: readCrop and cropOf', () => {
  it('drops anything that is not a rectangle of finite numbers', () => {
    for (const bad of [undefined, null, 'x', 7, [], {}, { x: 0, y: 0, w: 0.5 }, { x: Number.NaN, y: 0, w: 0.5, h: 0.5 }, { x: '0', y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: Infinity, h: 0.5 }]) {
      expect(readCrop(bad, 1280, 720), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('keeps a crop inside the frame exactly, and clips one that reaches out', () => {
    expect(readCrop({ x: 0, y: 0, w: 1, h: 0.933333 }, 1280, 720)).toEqual({ x: 0, y: 0, w: 1, h: 0.933333 })
    expect(readCrop({ x: 0.1, y: 0.2, w: 0.3, h: 0.4, extra: 1 }, 1280, 720)).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
    expect(readCrop({ x: -0.25, y: 0, w: 0.75, h: 1 }, 1280, 720)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 })
    expect(readCrop({ x: 0.5, y: 0.5, w: 0.75, h: 0.75 }, 1280, 720)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  })

  it('drops a crop under MIN_CROP_PX (less half a pixel) on a side', () => {
    expect(MIN_CROP_PX).toBe(64)
    expect(readCrop({ x: 0.5, y: 0.5, w: 0.02, h: 0.5 }, 1280, 720)).toBeUndefined()
    expect(readCrop({ x: 0, y: 0, w: 63.4 / 1280, h: 0.5 }, 1280, 720)).toBeUndefined()
    expect(readCrop({ x: 0, y: 0, w: 63.6 / 1280, h: 0.5 }, 1280, 720)).toBeDefined()
    expect(readCrop({ x: 0, y: 0, w: 0.5, h: 63.4 / 720 }, 1280, 720)).toBeUndefined()
    // A recording smaller than MIN_CROP_PX cannot be cropped on that axis.
    expect(readCrop({ x: 0, y: 0, w: 1, h: 0.5 }, 50, 720)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 })
    expect(readCrop({ x: 0.1, y: 0, w: 0.9, h: 0.5 }, 50, 720)).toBeUndefined()
  })

  it('drops a crop whose every edge is within half a pixel of the frame (no crop)', () => {
    expect(readCrop({ x: 0, y: 0, w: 1, h: 1 }, 1280, 720)).toBeUndefined()
    expect(readCrop({ x: 0.0001, y: 0, w: 0.9999, h: 1 }, 1280, 720)).toBeUndefined()
    expect(readCrop({ x: -1, y: -1, w: 3, h: 3 }, 1280, 720)).toBeUndefined()
    expect(readCrop({ x: 0, y: 0, w: 1, h: 1 - 0.4 / 720 }, 1280, 720)).toBeUndefined()
    expect(readCrop({ x: 0, y: 0, w: 1, h: 1 - 0.6 / 720 }, 1280, 720)).toBeDefined()
  })

  it('uses 1% of a side when the size is unknown', () => {
    expect(readCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, 0, 0)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
    expect(readCrop({ x: 0, y: 0, w: 0.005, h: 0.5 }, Number.NaN, 720)).toBeUndefined()
    expect(readCrop({ x: 0, y: 0, w: 1, h: 1 }, 0, 0)).toBeUndefined()
  })

  it('is idempotent', () => {
    const inputs = [
      { x: 0, y: 0, w: 1, h: 0.933333 },
      { x: -0.1, y: 0.2, w: 0.6, h: 0.9 },
      { x: 0.3, y: 0.7, w: 0.9, h: 0.1 },
      { x: 0.123456789, y: 0.0987654321, w: 0.7654321, h: 0.6 },
      { x: 0.1, y: 0.1, w: 0.7, h: 0.7 }
    ]
    for (const raw of inputs) {
      const once = readCrop(raw, 1920, 1080)
      expect(once, JSON.stringify(raw)).toBeDefined()
      expect(readCrop(once, 1920, 1080)).toEqual(once)
    }
  })

  it('migrateProject keeps a valid crop and drops a whole-frame or broken one', () => {
    expect(migrateProject({ ...clone(OLD), crop: { x: 0, y: 0, w: 1, h: 0.933333 } }).crop).toEqual({ x: 0, y: 0, w: 1, h: 0.933333 })
    expect('crop' in migrateProject({ ...clone(OLD), crop: { x: 0, y: 0, w: 1, h: 1 } })).toBe(false)
    expect('crop' in migrateProject({ ...clone(OLD), crop: 'all' })).toBe(false)
  })

  it('cropOf snaps the crop to the project pixels; null without one', () => {
    expect(cropOf({ width: 1920, height: 1080 })).toBeNull()
    expect(cropOf({ width: 1920, height: 1080, crop: { x: 0.10003, y: 0, w: 0.5, h: 1 } })).toEqual({ x: 192 / 1920, y: 0, w: 0.5, h: 1 })
    expect(cropPixels(null, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 })
    expect(cropPixels({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 1919, 1079)).toEqual({ x: 192, y: 108, w: 959, h: 539 })
    expect(visibleSize({ width: 1280, height: 720, crop: { x: 0, y: 0, w: 1, h: 672 / 720 } })).toEqual({ width: 1280, height: 672 })
    expect(FULL_FRAME).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(Object.isFrozen(FULL_FRAME)).toBe(true)
  })
})

describe('freezes: readFreezes', () => {
  it('reads nothing from anything but a list, and no key from an empty result', () => {
    for (const bad of [undefined, null, 'x', 3, {}, { 0: freeze('a', 1) }]) expect(readFreezes(bad, 10)).toBeUndefined()
    expect(readFreezes([], 10)).toBeUndefined()
    expect(readFreezes([null, 3, 'f', [], {}], 10)).toBeUndefined()
    expect('freezes' in migrateProject({ ...clone(OLD), freezes: [] })).toBe(false)
    expect('freezes' in migrateProject({ ...clone(OLD), freezes: 'none' })).toBe(false)
  })

  it('keeps a valid freeze as it is, with only its own fields', () => {
    expect(readFreezes([{ id: 'a', at: 2, length: 3, sound: 'pause' }], 10)).toEqual([{ id: 'a', at: 2, length: 3, sound: 'pause' }])
    const [f] = readFreezes([{ id: 'b', at: 2, length: 1.5, sound: 'continue', extra: true }], 10)!
    expect(f).toEqual({ id: 'b', at: 2, length: 1.5, sound: 'continue' })
    expect(Object.keys(f)).toEqual(['id', 'at', 'length', 'sound'])
  })

  it('drops entries without a 1..64 character id or a finite anchor', () => {
    const list = [
      { at: 1 },
      { id: '', at: 1 },
      { id: 'x'.repeat(65), at: 1 },
      { id: 7, at: 1 },
      { id: 'nan', at: Number.NaN },
      { id: 'str', at: '1' },
      { id: 'x'.repeat(64), at: 4 }
    ]
    expect(readFreezes(list, 10)?.map((f) => f.id)).toEqual(['x'.repeat(64)])
  })

  it('clamps the anchor into the recording, rounded to 1 ms', () => {
    const at = (v: number, duration = 10): number | undefined => readFreezes([freeze('a', v)], duration)?.[0].at
    expect(at(-1)).toBe(0)
    expect(at(99)).toBe(10)
    expect(at(2.0004)).toBe(2)
    expect(at(2.0006)).toBe(2.001)
    // A recording end that is not whole milliseconds stays the end.
    expect(at(99, 10.0006)).toBe(10.0006)
  })

  it('rounds the length to tenths within [0.5, 30]; not a number: the default', () => {
    const length = (v: unknown): number | undefined => readFreezes([{ id: 'a', at: 1, length: v, sound: 'pause' }], 10)?.[0].length
    expect(FREEZE).toEqual({ min: 0.5, max: 30, step: 0.1, default: 3 })
    expect(length(0.2)).toBe(0.5)
    expect(length(31)).toBe(30)
    expect(length(2.345)).toBe(2.3)
    expect(length(7.25)).toBe(7.3)
    expect(length(Number.NaN)).toBe(3)
    expect(length('4')).toBe(3)
    expect(length(undefined)).toBe(3)
  })

  it("keeps 'continue'; any other sound is 'pause'", () => {
    const sound = (v: unknown): string | undefined => readFreezes([{ id: 'a', at: 1, length: 3, sound: v }], 10)?.[0].sound
    expect(sound('continue')).toBe('continue')
    expect(sound('pause')).toBe('pause')
    expect(sound('x')).toBe('pause')
    expect(sound(undefined)).toBe('pause')
  })

  it('sorts by anchor and keeps the first of two anchors closer than FREEZE_EPS, or of two equal ids', () => {
    expect(FREEZE_EPS).toBeCloseTo(1 / 120, 12)
    expect(readFreezes([freeze('b', 5), freeze('a', 2)], 10)?.map((f) => f.id)).toEqual(['a', 'b'])
    expect(readFreezes([freeze('a', 2), freeze('b', 2.005)], 10)?.map((f) => f.id)).toEqual(['a'])
    expect(readFreezes([freeze('late', 2.005), freeze('early', 2)], 10)?.map((f) => f.id)).toEqual(['early'])
    expect(readFreezes([freeze('x', 2), freeze('y', 2)], 10)?.map((f) => f.id)).toEqual(['x'])
    expect(readFreezes([freeze('a', 2), freeze('b', 2.009)], 10)?.map((f) => f.id)).toEqual(['a', 'b'])
    expect(readFreezes([freeze('a', 1), freeze('a', 5)], 10)).toEqual([freeze('a', 1)])
  })

  it(`keeps at most MAX_FREEZES (${MAX_FREEZES})`, () => {
    const many = Array.from({ length: 250 }, (_, i) => freeze(`f${i}`, i * 0.1))
    const read = readFreezes(many, 100)!
    expect(read).toHaveLength(MAX_FREEZES)
    expect(read[MAX_FREEZES - 1].id).toBe(`f${MAX_FREEZES - 1}`)
  })

  it('is idempotent, and migrateProject reads freezes with these rules', () => {
    const messy = [freeze('c', 9.99999, 31, 'continue'), { id: 'b', at: -3, length: 0.26, sound: 'loud' }, freeze('a', 4.0004, 2.345), freeze('d', 4.003), null]
    const once = readFreezes(messy, 10)
    expect(once).toEqual([freeze('b', 0, 0.5), freeze('a', 4, 2.3), freeze('c', 10, 30, 'continue')])
    expect(readFreezes(once, 10)).toEqual(once)
    expect(migrateProject({ ...clone(OLD), duration: 10, freezes: messy }).freezes).toEqual(once)
  })

  it('clampFreezes keeps the same list when nothing changes, else applies the rules again', () => {
    const list = [freeze('a', 2), freeze('b', 8)]
    expect(clampFreezes(list, 10)).toBe(list)
    expect(clampFreezes(list, 5)).toEqual([freeze('a', 2), freeze('b', 5)])
    expect(clampFreezes([freeze('a', 6), freeze('b', 8)], 5)).toEqual([freeze('a', 5)])
    expect(clampFreezes([], 5)).toBeUndefined()
  })
})

describe('freezes: the plan and maps without freezes', () => {
  const clips: Clip[] = [
    { id: 'a', start: 0, end: 4, speed: 1 },
    { id: 'b', start: 6, end: 10, speed: 2 }
  ]

  it('are the identity', () => {
    expect(planOf({ clips })).toBe(NO_FREEZES)
    expect(videoDuration(clips, NO_FREEZES)).toBe(outputDuration(clips))
    const frames = videoFrames(clips, NO_FREEZES, 60)
    expect(frames.times).toEqual(exportFrameTimes(clips, 60))
    expect(frames.pictures).toBe(frames.times)
    expect(frames.held).toBeNull()
    for (const t of [0, 1.5, 4, 5, 6, 7.25, 10, 11]) {
      expect(videoTimeAt(clips, NO_FREEZES, t), `t = ${t}`).toBe(outputTimeAt(clips, t))
      expect(pictureTime(clips, NO_FREEZES, t)).toBe(t)
    }
    for (const o of [0, 2.5, 4, 5.9, 6]) {
      expect(editToVideo(NO_FREEZES, o)).toBe(o)
      expect(videoToEdit(NO_FREEZES, o)).toEqual({ edit: o, hold: null, elapsed: 0 })
      expect(videoToSource(clips, NO_FREEZES, o)).toEqual({ ...outputToSource(clips, o), hold: null })
    }
  })

  it('freezeKeepRanges keeps a quarter second on each side of every anchor', () => {
    expect(freezeKeepRanges(undefined)).toEqual([])
    expect(freezeKeepRanges([freeze('a', 5)])).toEqual([{ start: 4.75, end: 5.25 }])
  })
})

/** A keydown as the browser reports it. */
const ev = (key: string, code: string, mods: Partial<Pick<KeyInput, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {}): KeyInput => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('commands and keys of this wave', () => {
  const NEW: [CommandId, string, string, string[]][] = [
    ['polish', 'Edit', 'Polish in one click…', ['Shift+P']],
    ['toggleWaveform', 'Timeline', 'Audio waveform on the timeline', []],
    ['toggleSnapping', 'Timeline', 'Snapping', ['N']],
    ['shuttleReverse', 'Playback', 'Play backwards (again: faster)', ['J']],
    ['shuttlePause', 'Playback', 'Pause', ['K']],
    ['shuttleForward', 'Playback', 'Play forward (again: faster)', ['L']],
    ['previewSpeedUp', 'Playback', 'Faster preview speed', ['>']],
    ['previewSpeedDown', 'Playback', 'Slower preview speed', ['<']],
    ['cropRecording', 'Edit', 'Crop the recording…', ['C']],
    ['resetCrop', 'Edit', 'Show the whole recording (reset crop)', []],
    ['cropTaskbar', 'Edit', 'Crop out the taskbar', []],
    ['freezeFrame', 'Add', 'Freeze frame at playhead', ['F']],
    ['toggleFreezeSound', 'Edit', 'Freeze frame: pause or keep the sound', []]
  ]

  it('are in the palette with their titles, categories and default keys', () => {
    const ids = PALETTE_COMMANDS.map((c) => c.id)
    for (const [id, category, title, keys] of NEW) {
      expect(ids, id).toContain(id)
      expect(commandInfo(id).category, id).toBe(category)
      expect(commandInfo(id).title, id).toBe(title)
      expect(DEFAULT_KEYMAP[id], id).toEqual(keys)
    }
    // The two view toggles show their state; nothing new repeats or works while typing.
    expect(NEW.filter(([id]) => commandInfo(id).toggle).map(([id]) => id)).toEqual(['toggleWaveform', 'toggleSnapping'])
    expect(NEW.filter(([id]) => commandInfo(id).repeat || commandInfo(id).inText || commandInfo(id).hidden)).toEqual([])
  })

  it('sit where the designs put them', () => {
    const after = (id: CommandId): CommandId => COMMAND_IDS[COMMAND_IDS.indexOf(id) + 1]
    expect(after('smartSpeed')).toBe('polish')
    expect(COMMAND_IDS.slice(COMMAND_IDS.indexOf('prevChapter') + 1, COMMAND_IDS.indexOf('prevChapter') + 6)).toEqual([
      'shuttleReverse', 'shuttlePause', 'shuttleForward', 'previewSpeedUp', 'previewSpeedDown'
    ])
    expect(COMMAND_IDS.slice(COMMAND_IDS.indexOf('timelineFit') + 1, COMMAND_IDS.indexOf('timelineFit') + 3)).toEqual(['toggleWaveform', 'toggleSnapping'])
  })

  it('leave the default keymap without conflicts, with valid, non-reserved keys', () => {
    expect(findConflicts(DEFAULT_KEYMAP).size).toBe(0)
    for (const [id, , , keys] of NEW) for (const a of keys) expect(checkShortcut(a, id), `${id}: ${a}`).toEqual({ ok: true, accelerator: a })
  })

  it('bind the nine keys to their commands, and leave the chords around them as they were', () => {
    const index = shortcutIndex(DEFAULT_KEYMAP)
    const run = (e: KeyInput): CommandId | null => {
      const chord = chordFromEvent(e)
      return chord ? matchShortcut(index, chord) : null
    }
    expect(run(ev('P', 'KeyP', { shiftKey: true }))).toBe('polish')
    expect(run(ev('n', 'KeyN'))).toBe('toggleSnapping')
    expect(run(ev('j', 'KeyJ'))).toBe('shuttleReverse')
    expect(run(ev('k', 'KeyK'))).toBe('shuttlePause')
    expect(run(ev('l', 'KeyL'))).toBe('shuttleForward')
    expect(run(ev('>', 'Period', { shiftKey: true }))).toBe('previewSpeedUp')
    expect(run(ev('<', 'Comma', { shiftKey: true }))).toBe('previewSpeedDown')
    expect(run(ev('c', 'KeyC'))).toBe('cropRecording')
    expect(run(ev('f', 'KeyF'))).toBe('freezeFrame')
    // Around them: plain P stays free, the palette keeps Ctrl+K and Ctrl+Shift+P, Ctrl+C stays copy.
    expect(run(ev('p', 'KeyP'))).toBeNull()
    expect(run(ev('P', 'KeyP', { ctrlKey: true, shiftKey: true }))).toBe('commandPalette')
    expect(run(ev('k', 'KeyK', { ctrlKey: true }))).toBe('commandPalette')
    expect(run(ev('c', 'KeyC', { ctrlKey: true }))).toBeNull()
    expect(run(ev('F11', 'F11'))).toBeNull()
  })
})

describe('the polish preference', () => {
  it("is a known preference key, read back sanitised", () => {
    expect(PREF_KEYS).toContain('polish')
    expect(POLISH_STEPS).toEqual(['style', 'zoom', 'silences', 'captions', 'director'])
    for (const bad of [undefined, null, 'x', [], 3]) expect(readPolishOptions(bad)).toEqual(DEFAULT_POLISH_OPTIONS)
    const raw = { styleId: 'studio', zoom: false, silences: 'yes', silenceAction: 4, captions: false, captionsProvider: '', director: false, extra: 1 }
    const read = readPolishOptions(raw)
    expect(read).toEqual({ styleId: 'studio', zoom: false, silences: true, silenceAction: 4, captions: false, captionsProvider: null, director: false })
    expect(readPolishOptions(read)).toEqual(read)
    expect(readPolishOptions({ silenceAction: 3, styleId: 'x'.repeat(65) })).toEqual(DEFAULT_POLISH_OPTIONS)
  })
})
