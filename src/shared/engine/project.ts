import type { CaptureInfo, CursorSettings, CursorTrack, Project, ZoomSegment } from '../types'
import { DEFAULT_ZOOM_SETTINGS } from './zoom'
import { fullClip, normalizeClips } from './timeline'

export const PROJECT_VERSION = 2

export const DEFAULT_EFFECTS: Project['effects'] = {
  motionBlur: 0.5,
  keystrokes: { show: true, position: 'bottom', size: 0.035 }
}

/** Defaults for the optional cursor look fields (older projects simply lack them). */
export const DEFAULT_CURSOR_EXTRAS: Required<Pick<CursorSettings, 'style' | 'highlight' | 'clickStyle' | 'clickColor' | 'clickSound' | 'clickSoundVolume' | 'loopHome' | 'tilt' | 'trail'>> = {
  style: 'auto',
  highlight: { enabled: false, color: '#facc15', size: 1, opacity: 0.35 },
  clickStyle: 'ripple',
  clickColor: '#ffffff',
  clickSound: false,
  clickSoundVolume: 0.6,
  loopHome: false,
  tilt: false,
  trail: false
}

export const DEFAULT_AUDIO: Project['audio'] = { volume: 1, muted: false }

export function createProject(init: {
  id: string
  name: string
  duration: number
  width: number
  height: number
  hasWebcam: boolean
  hasAudio: boolean
  webcamOffset: number
  zooms: ZoomSegment[]
  cursorValid: boolean
  capture: CaptureInfo
}): Project {
  return {
    version: 2,
    id: init.id,
    name: init.name,
    createdAt: new Date().toISOString(),
    duration: init.duration,
    width: init.width,
    height: init.height,
    hasWebcam: init.hasWebcam,
    hasAudio: init.hasAudio,
    webcamOffset: init.webcamOffset,
    capture: init.capture,
    clips: [fullClip(init.duration)],
    zooms: init.zooms,
    autoZoom: true,
    zoomSettings: structuredClone(DEFAULT_ZOOM_SETTINGS),
    annotations: [],
    shapes: [],
    spotlights: [],
    style: {
      background: { type: 'gradient', preset: 'aurora' },
      padding: 0.07,
      cornerRadius: 14,
      shadow: 0.6,
      aspectRatio: 'auto'
    },
    cursor: {
      // The synthetic cursor only makes sense when the OS cursor is not in the pixels.
      show: init.cursorValid && !init.capture.cursorInVideo,
      size: 1.4,
      smoothing: 0.6,
      clickEffect: true,
      hideWhenIdle: true,
      ...DEFAULT_CURSOR_EXTRAS
    },
    webcam: { show: init.hasWebcam, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: structuredClone(DEFAULT_EFFECTS),
    audio: { ...DEFAULT_AUDIO }
  }
}

type AnyProject = Omit<Project, 'version'> & { version: number; trim?: { start: number; end: number } }

/**
 * Upgrades a project.json of any earlier version to the current schema.
 * Missing fields get defaults, so hand-edited or partial files still open.
 */
export function migrateProject(raw: unknown): Project {
  const p = raw as AnyProject
  if (!p || typeof p !== 'object' || typeof p.id !== 'string') throw new Error('Not a project file')
  const duration = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0.1
  const clips =
    Array.isArray(p.clips) && p.clips.length
      ? p.clips
      : [{ ...fullClip(duration), start: p.trim?.start ?? 0, end: p.trim?.end ?? duration }]
  const { trim: _legacyTrim, ...rest } = p
  void _legacyTrim
  return {
    ...rest,
    version: 2,
    duration,
    capture: p.capture ?? { method: 'chromium', cursorInVideo: true, region: null },
    clips: normalizeClips(clips, duration),
    zooms: Array.isArray(p.zooms) ? p.zooms : [],
    annotations: Array.isArray(p.annotations) ? p.annotations : [],
    shapes: Array.isArray(p.shapes) ? p.shapes : [],
    spotlights: Array.isArray(p.spotlights) ? p.spotlights : [],
    effects: {
      ...DEFAULT_EFFECTS,
      ...p.effects,
      keystrokes: { ...DEFAULT_EFFECTS.keystrokes, ...p.effects?.keystrokes }
    },
    audio: { ...DEFAULT_AUDIO, ...p.audio }
  }
}

/** Older cursor.json files have no keys/shapes arrays. */
export function migrateCursor(raw: unknown): CursorTrack {
  const c = (raw ?? {}) as Partial<CursorTrack>
  return {
    samples: Array.isArray(c.samples) ? c.samples : [],
    clicks: Array.isArray(c.clicks) ? c.clicks : [],
    keys: Array.isArray(c.keys) ? c.keys : [],
    shapes: Array.isArray(c.shapes) ? c.shapes : [],
    scale: typeof c.scale === 'number' && c.scale > 0 ? c.scale : 1,
    ...(Array.isArray(c.marks) ? { marks: c.marks.filter((m) => Number.isFinite(m?.t)) } : {}),
    ...(Array.isArray(c.typing) ? { typing: c.typing.filter((b) => Number.isFinite(b?.t) && Number.isFinite(b?.end)) } : {}),
    valid: !!c.valid
  }
}

/** Seconds -> "m:ss.t" */
export function formatTime(seconds: number, withTenths = true): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  const whole = Math.floor(rest)
  const base = `${m}:${whole.toString().padStart(2, '0')}`
  return withTenths ? `${base}.${Math.floor((rest - whole) * 10)}` : base
}
