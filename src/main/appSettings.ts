/**
 * App-wide settings, stored as JSON in userData/app-settings.json: the recording options
 * chosen on Home (frame rate, hotkeys, auto-pause, desktop icons) and a little app state that
 * must survive a crash (whether the desktop icons are hidden by us and still need restoring).
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
  sanitizeAppSettings,
  type AppSettings,
  type RecordingSettings,
  type RecordingSettingsPatch
} from '../shared/recording/settings'
import { writeFileAtomicSync } from './atomicWrite'

const FILE_VERSION = 1

interface StoredFile {
  version: number
  recording: RecordingSettings
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
    const data: StoredFile = { version: FILE_VERSION, recording: settings.recording, ...(iconsHidden ? { desktopIconsHidden: true } : {}) }
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
