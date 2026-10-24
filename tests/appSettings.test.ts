import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { AppSettingsStore } from '../src/main/appSettings'
import { DEFAULT_HOTKEYS } from '../src/shared/recording/hotkeys'
import {
  applyRecordingPatch,
  cleanPresetName,
  COUNTDOWN,
  DEFAULT_RECORDING_SETTINGS,
  defaultAppSettings,
  deletePreset,
  IDLE_SECONDS,
  MAX_PRESETS,
  missingDeviceNotice,
  presetInUse,
  presetMatches,
  presetNamed,
  presetRecordingPatch,
  presetSummary,
  resolvePresetDevice,
  sanitizeAppSettings,
  sanitizePresets,
  sanitizePresetSetup,
  sanitizeRecordingSettings,
  savePreset,
  type PresetSetup,
  type RecordingPreset
} from '../src/shared/recording/settings'

const dirs: string[] = []
function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-settings-'))
  dirs.push(dir)
  return path.join(dir, 'nested', 'app-settings.json')
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('recording settings validation', () => {
  it('defaults: 60 fps, a 3 s countdown, nothing automatic, the documented hotkeys, no presets', () => {
    expect(defaultAppSettings()).toEqual({
      recording: { fps: 60, countdown: 3, hideDesktopIcons: false, autoPause: false, idleSeconds: 10, hotkeys: DEFAULT_HOTKEYS },
      presets: []
    })
    // A copy every time: callers may mutate it.
    expect(defaultAppSettings().recording.hotkeys).not.toBe(DEFAULT_HOTKEYS)
  })

  it('repairs malformed values field by field', () => {
    expect(sanitizeRecordingSettings({ fps: 24, hideDesktopIcons: 'yes', autoPause: true, idleSeconds: 1, hotkeys: { stop: 'A' } })).toEqual({
      ...DEFAULT_RECORDING_SETTINGS,
      autoPause: true,
      idleSeconds: IDLE_SECONDS.min
    })
    expect(sanitizeRecordingSettings({ fps: 30, idleSeconds: 9999.4 }).idleSeconds).toBe(IDLE_SECONDS.max)
    expect(sanitizeRecordingSettings({ idleSeconds: 7.6 }).idleSeconds).toBe(8)
    expect(sanitizeRecordingSettings({ idleSeconds: Number.NaN }).idleSeconds).toBe(10)
    // The countdown: whole seconds from 0 (off) to 10; older files have none (3 s, as before).
    expect(sanitizeRecordingSettings({}).countdown).toBe(COUNTDOWN.default)
    expect(sanitizeRecordingSettings({ countdown: 0 }).countdown).toBe(0)
    expect(sanitizeRecordingSettings({ countdown: 4.6 }).countdown).toBe(5)
    expect(sanitizeRecordingSettings({ countdown: 60 }).countdown).toBe(10)
    expect(sanitizeRecordingSettings({ countdown: -2 }).countdown).toBe(0)
    expect(sanitizeRecordingSettings({ countdown: '5' }).countdown).toBe(3)
    expect(sanitizeAppSettings(null)).toEqual(defaultAppSettings())
    expect(sanitizeAppSettings({ recording: 'x' })).toEqual(defaultAppSettings())
  })

  it('applies patches, including one hotkey at a time', () => {
    const next = applyRecordingPatch(DEFAULT_RECORDING_SETTINGS, { fps: 30, hotkeys: { mark: 'alt+m' } })
    expect(next).toEqual({ ...DEFAULT_RECORDING_SETTINGS, fps: 30, hotkeys: { ...DEFAULT_HOTKEYS, mark: 'Alt+M' } })
    // Unknown fields are dropped.
    expect(applyRecordingPatch(next, { bogus: 1 } as never)).toEqual(next)
  })
})

describe('AppSettingsStore', () => {
  it('starts from defaults without a file and saves changes atomically', () => {
    const file = tempFile()
    const store = new AppSettingsStore(file)
    expect(store.get()).toEqual(defaultAppSettings())
    expect(fs.existsSync(file)).toBe(false)
    const saved = store.updateRecording({ fps: 30, autoPause: true, idleSeconds: 5 })
    expect(saved.recording).toMatchObject({ fps: 30, autoPause: true, idleSeconds: 5 })
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    // No presets saved: none written.
    expect(onDisk).toEqual({ version: 1, recording: saved.recording })
    // No temporary file left behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['app-settings.json'])
    // A new store (next app start) reads it back.
    expect(new AppSettingsStore(file).get()).toEqual(saved)
  })

  it('hands out copies, so callers cannot change the stored settings', () => {
    const store = new AppSettingsStore(tempFile())
    const a = store.get()
    a.recording.fps = 30
    a.recording.hotkeys.stop = 'F1'
    expect(store.recording.fps).toBe(60)
    expect(store.recording.hotkeys.stop).toBe(DEFAULT_HOTKEYS.stop)
  })

  it('remembers hidden desktop icons across restarts until they are shown again', () => {
    const file = tempFile()
    const store = new AppSettingsStore(file)
    store.updateRecording({ hideDesktopIcons: true })
    store.setDesktopIconsHidden(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).desktopIconsHidden).toBe(true)
    // E.g. the app crashed while recording.
    const next = new AppSettingsStore(file)
    expect(next.desktopIconsHidden).toBe(true)
    expect(next.recording.hideDesktopIcons).toBe(true)
    next.setDesktopIconsHidden(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).desktopIconsHidden).toBeUndefined()
    expect(new AppSettingsStore(file).desktopIconsHidden).toBe(false)
    // Changing a setting keeps the icon state.
    next.setDesktopIconsHidden(true)
    next.updateRecording({ fps: 30 })
    expect(new AppSettingsStore(file).desktopIconsHidden).toBe(true)
  })

  it('treats a corrupt or hand-edited file as defaults (field by field)', () => {
    const file = tempFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(new AppSettingsStore(file).get()).toEqual(defaultAppSettings())
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    fs.writeFileSync(file, JSON.stringify({ version: 1, recording: { fps: 30, hotkeys: { stop: 'Ctrl+C', mark: 'ctrl+alt+m' } }, desktopIconsHidden: 'yes' }))
    const s = new AppSettingsStore(file)
    expect(s.recording.fps).toBe(30)
    expect(s.recording.hotkeys).toEqual({ ...DEFAULT_HOTKEYS, mark: 'Ctrl+Alt+M' })
    expect(s.desktopIconsHidden).toBe(false)
  })

  it('throws when the settings cannot be written, keeping the previous value', () => {
    const file = tempFile()
    const store = new AppSettingsStore(file)
    // A directory where the file should be: the rename fails.
    fs.mkdirSync(file, { recursive: true })
    expect(() => store.updateRecording({ fps: 30 })).toThrow()
    expect(store.recording.fps).toBe(60)
  })
})

const SETUP: PresetSetup = {
  source: 'area',
  fps: 30,
  countdown: 5,
  autoPause: true,
  idleSeconds: 8,
  hideDesktopIcons: true,
  captureKeys: false,
  systemAudio: false,
  mic: { id: 'mic-usb', label: 'USB Mic' },
  camera: { id: 'cam-1', label: 'Webcam' }
}

describe('recording presets validation', () => {
  it('keeps a valid preset as it is', () => {
    const p: RecordingPreset = { id: 'p1', name: 'Tutorial', ...SETUP }
    expect(sanitizePresets([p])).toEqual([p])
    expect(sanitizeAppSettings({ presets: [p] }).presets).toEqual([p])
  })

  it('repairs a preset field by field and drops unusable ones', () => {
    const [p] = sanitizePresets([
      { id: 'p1', name: '  Bug\nreport  ', source: 'galaxy', fps: 24, countdown: 99, autoPause: 'yes', idleSeconds: 1, mic: { id: 42 }, camera: { id: 'c', label: 7 } }
    ])
    expect(p).toEqual({
      id: 'p1',
      name: 'Bug report',
      source: 'screen',
      fps: 60,
      countdown: 10,
      autoPause: false,
      idleSeconds: IDLE_SECONDS.min,
      hideDesktopIcons: false,
      captureKeys: true,
      systemAudio: true,
      mic: null,
      camera: { id: 'c', label: '' }
    })
    // No id, a bad id, no name, not an object, repeated ids or names (ignoring case): dropped.
    const list = sanitizePresets([
      null,
      'x',
      { name: 'No id' },
      { id: 'a b', name: 'Bad id' },
      { id: 'p2', name: '   ' },
      { id: 'p3', name: 'Demo' },
      { id: 'p3', name: 'Other' },
      { id: 'p4', name: 'DEMO' },
      { id: 'p5', name: 'Last' }
    ])
    expect(list.map((x) => [x.id, x.name])).toEqual([
      ['p3', 'Demo'],
      ['p5', 'Last']
    ])
    expect(sanitizePresets('nope')).toEqual([])
    expect(sanitizeAppSettings({ recording: {}, presets: { 0: SETUP } }).presets).toEqual([])
  })

  it('keeps at most MAX_PRESETS presets and names of at most 40 characters', () => {
    const many = Array.from({ length: MAX_PRESETS + 5 }, (_, i) => ({ id: `p${i}`, name: `Preset ${i}` }))
    expect(sanitizePresets(many)).toHaveLength(MAX_PRESETS)
    expect(cleanPresetName('x'.repeat(100))).toHaveLength(40)
    expect(cleanPresetName(' a \t  b ')).toBe('a b')
    expect(cleanPresetName(12)).toBe('')
  })

  it('saves a new preset, replaces one of the same name in place, refuses a nameless one or one too many', () => {
    let list = savePreset([], { name: 'Tutorial', ...SETUP }, 'id1')
    expect(list).toEqual([{ id: 'id1', name: 'Tutorial', ...SETUP }])
    list = savePreset(list, { name: 'Quick', ...SETUP, fps: 60 }, 'id2')
    list = savePreset(list, { name: 'tutorial ', ...SETUP, countdown: 0 }, 'id3')
    expect(list.map((p) => [p.id, p.name, p.countdown])).toEqual([
      ['id1', 'tutorial', 0],
      ['id2', 'Quick', 5]
    ])
    expect(() => savePreset(list, { ...SETUP, name: '  ' }, 'x')).toThrow(/name/)
    expect(() => savePreset(list, null, 'x')).toThrow(/name/)
    const full = Array.from({ length: MAX_PRESETS }, (_, i) => ({ id: `p${i}`, name: `P${i}`, ...SETUP }))
    expect(() => savePreset(full, { name: 'One more', ...SETUP }, 'x')).toThrow(/up to 20/)
    // Replacing still works when full.
    expect(savePreset(full, { name: 'P3', ...SETUP, fps: 60 }, 'x')[3]).toMatchObject({ id: 'p3', fps: 60 })
    // Whatever is sent is validated.
    expect(savePreset([], { name: 'Odd', fps: 120, source: 'tv', mic: 'x' }, 'id9')[0]).toMatchObject({ fps: 60, source: 'screen', mic: null })
  })

  it('deletes by id', () => {
    const list = [{ id: 'a', name: 'A', ...SETUP }, { id: 'b', name: 'B', ...SETUP }]
    expect(deletePreset(list, 'a').map((p) => p.id)).toEqual(['b'])
    expect(deletePreset(list, 'zzz')).toEqual(list)
    expect(deletePreset(list, 5)).toEqual(list)
  })

  it('a preset sets the recording options, and matches the setup it saved', () => {
    expect(presetRecordingPatch(SETUP)).toEqual({ fps: 30, countdown: 5, autoPause: true, idleSeconds: 8, hideDesktopIcons: true })
    expect(applyRecordingPatch(DEFAULT_RECORDING_SETTINGS, presetRecordingPatch(SETUP))).toMatchObject({ fps: 30, countdown: 5, autoPause: true, idleSeconds: 8 })
    expect(presetMatches(SETUP, { ...SETUP, mic: { id: 'mic-usb', label: 'renamed' } })).toBe(true)
    expect(presetMatches(SETUP, { ...SETUP, mic: null })).toBe(false)
    expect(presetMatches(SETUP, { ...SETUP, source: 'screen' })).toBe(false)
    expect(presetMatches(SETUP, { ...SETUP, countdown: 3 })).toBe(false)
    // The idle time only matters with auto-pause on.
    expect(presetMatches({ ...SETUP, autoPause: false }, { ...SETUP, autoPause: false, idleSeconds: 30 })).toBe(true)
    expect(presetMatches(SETUP, { ...SETUP, idleSeconds: 30 })).toBe(false)
    expect(sanitizePresetSetup(SETUP)).toEqual(SETUP)
    expect(presetSummary(SETUP)).toBe('Area · 30 fps · mic · camera · 5 s countdown · auto-pause')
    expect(presetSummary({ ...SETUP, source: 'window', mic: null, camera: null, systemAudio: true, countdown: 0, autoPause: false })).toBe('Window · 30 fps · system audio · no countdown')
  })
})

describe('preset devices', () => {
  const mics = [
    { deviceId: 'mic-a', label: 'Built-in', groupId: 'g1' },
    { deviceId: 'mic-b', label: 'Headset', groupId: 'g2' }
  ]
  const usb = { id: 'mic-usb', label: 'USB Mic' }

  it('uses the same device, or the same-named one when its id changed', () => {
    expect(resolvePresetDevice({ id: 'mic-b', label: 'Headset' }, mics)).toEqual({ id: 'mic-b', missing: null })
    expect(resolvePresetDevice({ id: 'old-id', label: 'Headset' }, mics)).toEqual({ id: 'mic-b', missing: null })
    expect(resolvePresetDevice(null, mics)).toEqual({ id: null, missing: null })
  })

  it('falls back to the default device, with a notice, when the preset\'s is not connected', () => {
    // The system default (the "default" alias) is the headset.
    const r = resolvePresetDevice(usb, mics, { deviceId: 'default', label: 'Default - Headset', groupId: 'g2' })
    expect(r).toEqual({ id: 'mic-b', missing: { wanted: 'USB Mic', fallback: 'Headset' } })
    expect(missingDeviceNotice('microphone', r.missing!)).toBe('The preset\'s microphone “USB Mic” is not connected, so the default microphone (“Headset”) is used.')
    // Without a default alias: the first one.
    expect(resolvePresetDevice(usb, mics).id).toBe('mic-a')
    // Nothing connected: none, and the notice says so.
    const none = resolvePresetDevice({ id: 'cam', label: '' }, [])
    expect(none).toEqual({ id: null, missing: { wanted: '', fallback: null } })
    expect(missingDeviceNotice('camera', none.missing!)).toBe('The preset\'s camera is not connected, so the recording has no camera.')
  })
})

describe('the preset in use', () => {
  const laptop = { deviceId: 'mic-laptop', label: 'Laptop Mic', groupId: 'g0' }
  const podcast: RecordingPreset = { id: 'p1', name: 'Podcast', ...SETUP, mic: { id: 'mic-usb', label: 'USB Mic' } }
  const headset: RecordingPreset = { id: 'p2', name: 'Headset', ...SETUP, mic: { id: 'mic-headset', label: 'Headset Mic' } }
  const presets = [podcast, headset]
  // Neither microphone is plugged in: both presets fall back to the laptop's, the setup in use.
  const asUsed = (p: PresetSetup): PresetSetup => {
    const id = resolvePresetDevice(p.mic, [laptop]).id
    return { ...p, mic: id ? { id, label: '' } : null }
  }
  const setup: PresetSetup = { ...SETUP, mic: { id: 'mic-laptop', label: 'Laptop Mic' } }
  const matches = (p: RecordingPreset): boolean => presetMatches(asUsed(p), setup)

  it('is the one picked last when several resolve to the same setup', () => {
    expect(presets.every(matches)).toBe(true)
    expect(presetInUse(presets, matches, 'p2')).toBe(headset)
    expect(presetInUse(presets, matches, 'p1')).toBe(podcast)
  })

  it('is the first match when nothing was picked, the picked one is gone or no longer matches', () => {
    expect(presetInUse(presets, matches, null)).toBe(podcast)
    expect(presetInUse(presets, matches, 'deleted')).toBe(podcast)
    const other: RecordingPreset = { ...headset, fps: 60 }
    expect(presetInUse([podcast, other], matches, 'p2')).toBe(podcast)
    expect(presetInUse([other], matches, 'p2')).toBeNull()
    expect(presetInUse([], matches, 'p2')).toBeNull()
  })

  it('finds a preset by name as saving does: ignoring case, after cleaning', () => {
    expect(presetNamed(presets, 'headset')).toBe(headset)
    expect(presetNamed(presets, '  Podcast \n')).toBe(podcast)
    expect(presetNamed(presets, 'Other')).toBeUndefined()
    expect(presetNamed(presets, '   ')).toBeUndefined()
  })
})

describe('AppSettingsStore presets', () => {
  it('saves, replaces and deletes presets, kept across restarts and validated', () => {
    const file = tempFile()
    const store = new AppSettingsStore(file)
    const a = store.savePreset({ name: 'Tutorial', ...SETUP })
    expect(a.presets).toHaveLength(1)
    const id = a.presets[0].id
    expect(id).toMatch(/^[\w-]+$/)
    store.savePreset({ name: 'Quick bug', ...SETUP, source: 'window', mic: null })
    // Same name: replaced in place, same id.
    const b = store.savePreset({ name: 'TUTORIAL', ...SETUP, fps: 60 })
    expect(b.presets.map((p) => [p.id === id, p.name, p.fps])).toEqual([
      [true, 'TUTORIAL', 60],
      [false, 'Quick bug', 30]
    ])
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk.presets).toEqual(b.presets)
    // The next start reads them back; the recording options are untouched by presets.
    const again = new AppSettingsStore(file)
    expect(again.get().presets).toEqual(b.presets)
    expect(again.recording).toEqual(DEFAULT_RECORDING_SETTINGS)
    // Refused: nothing changes on disk.
    expect(() => again.savePreset({ name: '' })).toThrow(/name/)
    expect(new AppSettingsStore(file).get().presets).toHaveLength(2)
    again.deletePreset(id)
    expect(new AppSettingsStore(file).get().presets.map((p) => p.name)).toEqual(['Quick bug'])
    again.deletePreset('missing')
    again.deletePreset(again.get().presets[0].id)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).presets).toBeUndefined()
  })

  it('hands out copies of the presets', () => {
    const store = new AppSettingsStore(tempFile())
    store.savePreset({ name: 'Mine', ...SETUP })
    const got = store.get()
    got.presets[0].name = 'Changed'
    got.presets.length = 0
    expect(store.get().presets[0].name).toBe('Mine')
  })

  it('reads presets from a hand-edited file, dropping the broken ones', () => {
    const file = tempFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, recording: { fps: 30 }, presets: [{ id: 'ok', name: 'Fine', ...SETUP }, { id: 'bad' }, 42] }))
    const s = new AppSettingsStore(file)
    expect(s.get().presets).toEqual([{ id: 'ok', name: 'Fine', ...SETUP }])
    expect(s.recording.fps).toBe(30)
  })
})
