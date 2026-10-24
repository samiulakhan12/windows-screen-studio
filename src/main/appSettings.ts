/**
 * App-wide settings, stored as JSON in userData/app-settings.json: the recording options
 * chosen on Home (frame rate, countdown, hotkeys, auto-pause, desktop icons), the recording
 * presets saved there, and a little app state that must survive a crash (whether the desktop
 * icons are hidden by us and still need restoring).
 *
 * Reads happen once (small file, synchronous); every change is written at once through
 * writeFileAtomicSync (temporary file + rename, retried while Windows briefly locks it), so a
 * crash never leaves a truncated file. A missing, unreadable or malformed file means defaults.
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  applyRecordingPatch,
  defaultAppSettings,
  deletePreset,
  sanitizeAppSettings,
  savePreset,
  type AppSettings,
  type RecordingPreset,
  type RecordingSettings,
  type RecordingSettingsPatch
} from '../shared/recording/settings'
import { writeFileAtomicSync } from './atomicWrite'

const FILE_VERSION = 1

let idCounter = 0
const newPresetId = (): string => `p${Date.now().toString(36)}${(idCounter++).toString(36)}`

interface StoredFile {
  version: number
  recording: RecordingSettings
  /** Absent while none were saved. */
  presets?: RecordingPreset[]
  /** Set while the desktop icons are hidden for a recording; cleared once they are shown again. */
  desktopIconsHidden?: boolean
}

export class AppSettingsStore {
  private value: AppSettings | null = null
  private iconsHidden = false

  constructor(readonly file: string) {}

  private load(): AppSettings {
    if (this.value) return this.value
    let raw: Partial<StoredFile> | null = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredFile>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring unreadable app settings:', err)
    }
    this.value = raw ? sanitizeAppSettings(raw) : defaultAppSettings()
    this.iconsHidden = raw?.desktopIconsHidden === true
    return this.value
  }

  /** A copy of the current settings. */
  get(): AppSettings {
    return structuredClone(this.load())
  }

  get recording(): RecordingSettings {
    return this.get().recording
  }

  /** Applies a validated patch to the recording settings, saves and returns the result. */
  updateRecording(patch: RecordingSettingsPatch): AppSettings {
    const current = this.load()
    const next: AppSettings = { ...current, recording: applyRecordingPatch(current.recording, patch) }
    this.write(next, this.iconsHidden)
    this.value = next
    return this.get()
  }

  /**
   * Saves a recording preset (validated; one with the same name is replaced) and returns the
   * settings. Throws with a message to show when it has no name or there is no room for it.
   */
  savePreset(input: unknown): AppSettings {
    const current = this.load()
    const next: AppSettings = { ...current, presets: savePreset(current.presets, input, newPresetId()) }
    this.write(next, this.iconsHidden)
    this.value = next
    return this.get()
  }

  /** Deletes the recording preset with id `id` (nothing when there is none) and returns the settings. */
  deletePreset(id: unknown): AppSettings {
    const current = this.load()
    const presets = deletePreset(current.presets, id)
    if (presets.length === current.presets.length) return this.get()
    const next: AppSettings = { ...current, presets }
    this.write(next, this.iconsHidden)
    this.value = next
    return this.get()
  }

  /** True when the desktop icons were hidden by a recording and not shown again (e.g. after a crash). */
  get desktopIconsHidden(): boolean {
    this.load()
    return this.iconsHidden
  }

  /** Remembers whether the icons are hidden; throws when it cannot be saved. */
  setDesktopIconsHidden(hidden: boolean): void {
    const current = this.load()
    if (hidden === this.iconsHidden) return
    this.write(current, hidden)
    this.iconsHidden = hidden
  }

  private write(settings: AppSettings, iconsHidden: boolean): void {
    const data: StoredFile = {
      version: FILE_VERSION,
      recording: settings.recording,
      ...(settings.presets.length ? { presets: settings.presets } : {}),
      ...(iconsHidden ? { desktopIconsHidden: true } : {})
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomicSync(this.file, JSON.stringify(data, null, 2), { attempts: 4 })
  }
}

let store: AppSettingsStore | null = null

/** The app's settings store (userData/app-settings.json). */
export function appSettings(): AppSettingsStore {
  store ??= new AppSettingsStore(path.join(app.getPath('userData'), 'app-settings.json'))
  return store
}
