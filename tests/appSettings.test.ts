import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { AppSettingsStore } from '../src/main/appSettings'
import { DEFAULT_HOTKEYS } from '../src/shared/recording/hotkeys'
import {
  applyRecordingPatch,
  DEFAULT_RECORDING_SETTINGS,
  defaultAppSettings,
  IDLE_SECONDS,
  sanitizeAppSettings,
  sanitizeRecordingSettings
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
  it('defaults: 60 fps, nothing automatic, the documented hotkeys', () => {
    expect(defaultAppSettings()).toEqual({
      recording: { fps: 60, hideDesktopIcons: false, autoPause: false, idleSeconds: 10, hotkeys: DEFAULT_HOTKEYS }
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
