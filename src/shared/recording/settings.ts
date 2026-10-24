/**
 * App-wide settings (userData/app-settings.json, see src/main/appSettings.ts): the recording
 * options chosen on Home. Pure validation shared by the main process and the renderer, so a
 * hand-edited or older file can never produce an invalid value.
 */
import { DEFAULT_HOTKEYS, sanitizeHotkeys, type Hotkeys } from './hotkeys'

export interface RecordingSettings {
  /** Screen capture frame rate; the editing proxy keeps it. */
  fps: 30 | 60
  /** Hide the desktop icons while recording (Windows; restored afterwards). */
  hideDesktopIcons: boolean
  /** Pause by itself after `idleSeconds` without mouse or keyboard input, and resume on the next input. */
  autoPause: boolean
  idleSeconds: number
  hotkeys: Hotkeys
}

export interface AppSettings {
  recording: RecordingSettings
}

/** Partial update of the recording settings (hotkeys may be given one at a time). */
export type RecordingSettingsPatch = Partial<Omit<RecordingSettings, 'hotkeys'>> & { hotkeys?: Partial<Hotkeys> }

export const IDLE_SECONDS = { min: 3, max: 120, default: 10 } as const

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  fps: 60,
  hideDesktopIcons: false,
  autoPause: false,
  idleSeconds: IDLE_SECONDS.default,
  hotkeys: { ...DEFAULT_HOTKEYS }
}

export function defaultAppSettings(): AppSettings {
  return { recording: { ...DEFAULT_RECORDING_SETTINGS, hotkeys: { ...DEFAULT_HOTKEYS } } }
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

export function sanitizeRecordingSettings(raw: unknown): RecordingSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RecordingSettings, unknown>>
  const d = DEFAULT_RECORDING_SETTINGS
  const idle = typeof r.idleSeconds === 'number' && Number.isFinite(r.idleSeconds) ? Math.round(r.idleSeconds) : d.idleSeconds
  return {
    fps: r.fps === 30 || r.fps === 60 ? r.fps : d.fps,
    hideDesktopIcons: bool(r.hideDesktopIcons, d.hideDesktopIcons),
    autoPause: bool(r.autoPause, d.autoPause),
    idleSeconds: Math.min(IDLE_SECONDS.max, Math.max(IDLE_SECONDS.min, idle)),
    hotkeys: sanitizeHotkeys(r.hotkeys)
  }
}

export function sanitizeAppSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { recording?: unknown }
  return { recording: sanitizeRecordingSettings(r.recording) }
}

/** `current` with `patch` applied, validated. */
export function applyRecordingPatch(current: RecordingSettings, patch: RecordingSettingsPatch): RecordingSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as RecordingSettingsPatch
  return sanitizeRecordingSettings({ ...current, ...p, hotkeys: { ...current.hotkeys, ...(p.hotkeys ?? {}) } })
}
