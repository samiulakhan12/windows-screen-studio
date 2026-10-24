/**
 * App-wide settings (userData/app-settings.json, see src/main/appSettings.ts): the recording
 * options chosen on Home and the recording presets saved there. Pure validation shared by the
 * main process and the renderer, so a hand-edited or older file can never produce an invalid
 * value.
 */
import { DEFAULT_HOTKEYS, sanitizeHotkeys, type Hotkeys } from './hotkeys'

export interface RecordingSettings {
  /** Screen capture frame rate; the editing proxy keeps it. */
  fps: 30 | 60
  /** Seconds counted down before recording starts (0 = start at once). */
  countdown: number
  /** Hide the desktop icons while recording (Windows; restored afterwards). */
  hideDesktopIcons: boolean
  /** Pause by itself after `idleSeconds` without mouse or keyboard input, and resume on the next input. */
  autoPause: boolean
  idleSeconds: number
  hotkeys: Hotkeys
}

export interface AppSettings {
  recording: RecordingSettings
  /** Named recording setups saved on Home, in the order they were first saved. */
  presets: RecordingPreset[]
}

/** Partial update of the recording settings (hotkeys may be given one at a time). */
export type RecordingSettingsPatch = Partial<Omit<RecordingSettings, 'hotkeys'>> & { hotkeys?: Partial<Hotkeys> }

export const IDLE_SECONDS = { min: 3, max: 120, default: 10 } as const
/** Countdown lengths offered on Home (seconds; any whole number up to `max` is valid). */
export const COUNTDOWN_CHOICES: readonly number[] = [0, 3, 5, 10]
export const COUNTDOWN = { max: 10, default: 3 } as const

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  fps: 60,
  countdown: COUNTDOWN.default,
  hideDesktopIcons: false,
  autoPause: false,
  idleSeconds: IDLE_SECONDS.default,
  hotkeys: { ...DEFAULT_HOTKEYS }
}

export function defaultAppSettings(): AppSettings {
  return { recording: { ...DEFAULT_RECORDING_SETTINGS, hotkeys: { ...DEFAULT_HOTKEYS } }, presets: [] }
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const wholeIn = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback

export function sanitizeRecordingSettings(raw: unknown): RecordingSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RecordingSettings, unknown>>
  const d = DEFAULT_RECORDING_SETTINGS
  return {
    fps: r.fps === 30 || r.fps === 60 ? r.fps : d.fps,
    countdown: wholeIn(r.countdown, 0, COUNTDOWN.max, d.countdown),
    hideDesktopIcons: bool(r.hideDesktopIcons, d.hideDesktopIcons),
    autoPause: bool(r.autoPause, d.autoPause),
    idleSeconds: wholeIn(r.idleSeconds, IDLE_SECONDS.min, IDLE_SECONDS.max, d.idleSeconds),
    hotkeys: sanitizeHotkeys(r.hotkeys)
  }
}

export function sanitizeAppSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { recording?: unknown; presets?: unknown }
  return { recording: sanitizeRecordingSettings(r.recording), presets: sanitizePresets(r.presets) }
}

/** `current` with `patch` applied, validated. */
export function applyRecordingPatch(current: RecordingSettings, patch: RecordingSettingsPatch): RecordingSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as RecordingSettingsPatch
  return sanitizeRecordingSettings({ ...current, ...p, hotkeys: { ...current.hotkeys, ...(p.hotkeys ?? {}) } })
}

/* ---------- Recording presets ---------- */

/** What is recorded: a whole screen, an area of one, or a window. */
export type PresetSource = 'screen' | 'area' | 'window'

/** A camera or microphone as a preset remembers it: its id, and its name to find it again if the id changed. */
export interface PresetDevice {
  id: string
  label: string
}

/** The setup a preset restores (everything chosen on Home except the hotkeys and the picked screen or area). */
export interface PresetSetup {
  source: PresetSource
  fps: 30 | 60
  countdown: number
  autoPause: boolean
  idleSeconds: number
  hideDesktopIcons: boolean
  /** Record keyboard activity: shortcuts and when typing happened (never which keys). */
  captureKeys: boolean
  systemAudio: boolean
  /** null: no microphone, no camera. */
  mic: PresetDevice | null
  camera: PresetDevice | null
}

export interface RecordingPreset extends PresetSetup {
  id: string
  name: string
}

/** What saving a preset sends: a name and the setup (the main process gives it an id). */
export type RecordingPresetInput = PresetSetup & { name: string }

export const MAX_PRESETS = 20
export const PRESET_NAME_MAX = 40

const SOURCES: readonly PresetSource[] = ['screen', 'area', 'window']

/** A preset name as shown: control characters removed, spaces collapsed, at most PRESET_NAME_MAX characters. */
export function cleanPresetName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX).trim()
}

const sameName = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0

function sanitizeDevice(raw: unknown): PresetDevice | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as { id?: unknown; label?: unknown }
  if (typeof d.id !== 'string' || !d.id || d.id.length > 512) return null
  return { id: d.id, label: typeof d.label === 'string' ? d.label.slice(0, 200) : '' }
}

/** A preset's setup, every field validated (defaults for anything missing or malformed). */
export function sanitizePresetSetup(raw: unknown): PresetSetup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof PresetSetup, unknown>>
  const rec = sanitizeRecordingSettings(r)
  return {
    source: SOURCES.includes(r.source as PresetSource) ? (r.source as PresetSource) : 'screen',
    fps: rec.fps,
    countdown: rec.countdown,
    autoPause: rec.autoPause,
    idleSeconds: rec.idleSeconds,
    hideDesktopIcons: rec.hideDesktopIcons,
    captureKeys: bool(r.captureKeys, true),
    systemAudio: bool(r.systemAudio, true),
    mic: sanitizeDevice(r.mic),
    camera: sanitizeDevice(r.camera)
  }
}

/**
 * Stored presets, validated: entries without a usable id or name are dropped, as are repeated
 * ids and names (the first is kept), and anything past MAX_PRESETS.
 */
export function sanitizePresets(raw: unknown): RecordingPreset[] {
  if (!Array.isArray(raw)) return []
  const out: RecordingPreset[] = []
  for (const item of raw) {
    if (out.length >= MAX_PRESETS) break
    if (!item || typeof item !== 'object') continue
    const { id, name } = item as { id?: unknown; name?: unknown }
    const clean = cleanPresetName(name)
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || !clean) continue
    if (out.some((p) => p.id === id || sameName(p.name, clean))) continue
    out.push({ id, name: clean, ...sanitizePresetSetup(item) })
  }
  return out
}

/**
 * The presets with `input` saved: a preset of the same name (ignoring case) is replaced, keeping
 * its place and id; otherwise it is added with `newId`. Throws when the name is empty or there
 * is no room left.
 */
export function savePreset(presets: readonly RecordingPreset[], input: unknown, newId: string): RecordingPreset[] {
  const name = cleanPresetName((input as { name?: unknown } | null)?.name)
  if (!name) throw new Error('Give the preset a name.')
  const setup = sanitizePresetSetup(input)
  const i = presets.findIndex((p) => sameName(p.name, name))
  if (i >= 0) return presets.map((p, k) => (k === i ? { id: p.id, name, ...setup } : p))
  if (presets.length >= MAX_PRESETS) throw new Error(`You can keep up to ${MAX_PRESETS} presets: delete one to save another.`)
  return [...presets, { id: newId, name, ...setup }]
}

/** The presets without the one with id `id` (unchanged when there is none). */
export function deletePreset(presets: readonly RecordingPreset[], id: unknown): RecordingPreset[] {
  return presets.filter((p) => p.id !== id)
}

/** The recording options a preset sets in the app settings. */
export function presetRecordingPatch(p: PresetSetup): RecordingSettingsPatch {
  return { fps: p.fps, countdown: p.countdown, autoPause: p.autoPause, idleSeconds: p.idleSeconds, hideDesktopIcons: p.hideDesktopIcons }
}

/** Whether the current setup is exactly what preset `p` sets up (devices compared by id). */
export function presetMatches(p: PresetSetup, setup: PresetSetup): boolean {
  return (
    p.source === setup.source &&
    p.fps === setup.fps &&
    p.countdown === setup.countdown &&
    p.autoPause === setup.autoPause &&
    // The idle time only counts while auto-pause is on (it is not shown otherwise).
    (!p.autoPause || p.idleSeconds === setup.idleSeconds) &&
    p.hideDesktopIcons === setup.hideDesktopIcons &&
    p.captureKeys === setup.captureKeys &&
    p.systemAudio === setup.systemAudio &&
    (p.mic?.id ?? null) === (setup.mic?.id ?? null) &&
    (p.camera?.id ?? null) === (setup.camera?.id ?? null)
  )
}

/** A connected camera or microphone, as the browser lists it. */
export interface ConnectedDevice {
  deviceId: string
  label: string
  groupId?: string
}

export interface ResolvedDevice {
  /** Device id to use, or null for none. */
  id: string | null
  /** Set when the preset's device is not connected and another one (or none) is used instead. */
  missing: { wanted: string; fallback: string | null } | null
}

/**
 * The device to use for a preset's `wanted` device among `devices` (pickable ones only): the
 * same id, else the same name (ids can change, e.g. after clearing browser data), else the
 * default one: the device behind the system default (`defaultAlias`, matched by group), or
 * the first one. Null `wanted` means none.
 */
export function resolvePresetDevice(wanted: PresetDevice | null, devices: readonly ConnectedDevice[], defaultAlias?: ConnectedDevice | null): ResolvedDevice {
  if (!wanted) return { id: null, missing: null }
  const hit = devices.find((d) => d.deviceId === wanted.id) ?? (wanted.label ? devices.find((d) => d.label === wanted.label) : undefined)
  if (hit) return { id: hit.deviceId, missing: null }
  const fallback = (defaultAlias?.groupId ? devices.find((d) => d.groupId === defaultAlias.groupId) : undefined) ?? devices[0] ?? null
  return { id: fallback?.deviceId ?? null, missing: { wanted: wanted.label, fallback: fallback ? fallback.label : null } }
}

/** One line about a preset's device that is not connected: what is used instead. */
export function missingDeviceNotice(kind: 'microphone' | 'camera', missing: NonNullable<ResolvedDevice['missing']>): string {
  const name = missing.wanted ? `“${missing.wanted}”` : ''
  const which = `The preset's ${kind}${name ? ` ${name}` : ''} is not connected`
  if (missing.fallback === null) return `${which}, so the recording has no ${kind}.`
  return `${which}, so the default ${kind}${missing.fallback ? ` (“${missing.fallback}”)` : ''} is used.`
}

/** A short description of a preset: "Area · 30 fps · mic · camera". */
export function presetSummary(p: PresetSetup): string {
  const parts: string[] = [p.source === 'screen' ? 'Screen' : p.source === 'area' ? 'Area' : 'Window', `${p.fps} fps`]
  if (p.mic) parts.push('mic')
  if (p.systemAudio) parts.push('system audio')
  if (p.camera) parts.push('camera')
  if (p.countdown !== COUNTDOWN.default) parts.push(p.countdown ? `${p.countdown} s countdown` : 'no countdown')
  if (p.autoPause) parts.push('auto-pause')
  return parts.join(' · ')
}
