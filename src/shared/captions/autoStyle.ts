/**
 * Auto style (docs/design/captions-studio.md §11.6): the look new captions get for the frame's
 * shape and whether the camera leads, and the gate that never replaces a look picked by hand. Pure.
 */
import { cameraBoxShown, outputSize, sceneCameraBox } from '../engine/layout'
import { isTall } from '../engine/reframeData'
import type { CaptionSettings, CaptionStudio, Project } from '../types'
import { captionsOf, DEFAULT_CAPTIONS, withPreset } from './settings'
import { studioPreset } from './studioPresets'
import { estimatedShare } from './transcriptTiming'

/** The camera leads when its box covers this share of the frame (§11.6)… */
const CAMERA_SHARE = 0.2
/** …for at least this share of the viewing time. */
const CAMERA_TIME = 0.5
/** Faster speech than this (words a minute) gets 4 words a chunk in Bold Pop. */
const FAST_SPEECH = 190
/** Most samples taken to decide whether the camera leads. */
const SAMPLES = 600

/** The reasons shown in the notice and in Review (§11.6). */
export const AUTO_STYLE_REASONS = {
  brand: "Your brand kit's caption style",
  tallCamera: 'Bold Pop: you are on camera in a tall video',
  tallScreen: 'Clean Short: a screen recording for phones',
  squareCamera: 'Highlight Box: a square video for feeds',
  squareScreen: 'Clean Short: a square screen recording',
  speakers: 'Subtitle with names and a colour per speaker',
  wide: 'Subtitle: clean subtitles for a long video'
} as const

/** The legacy fields a project still on the default compares, apart from show, showSpeaker, track and font. */
const DEFAULT_KEYS = ['preset', 'position', 'size', 'color', 'highlightColor', 'background', 'maxLines'] as const

/** Whether automation may change the look (no `picked`; a Studio look set by automation, or the default legacy look). */
export function autoStyleAllowed(project: Project): boolean {
  const c = project.captions
  if (!c) return true
  if (c.picked) return false
  if (c.studio) return true
  return DEFAULT_KEYS.every((k) => c[k] === DEFAULT_CAPTIONS[k])
}

/** A square-ish frame (1:1): not tall, and no wider than 5:4. */
const isSquare = (w: number, h: number): boolean => !isTall(w, h) && w <= h * 1.25

/** The frame's shape as the caption automation reads it: tall (9:16, 4:5), square (up to 5:4) or wide. */
export function frameShape(frame: { w: number; h: number }): 'tall' | 'square' | 'wide' {
  return isTall(frame.w, frame.h) ? 'tall' : isSquare(frame.w, frame.h) ? 'square' : 'wide'
}

/** The output frame, 1080 px on its shorter side, a caption look is chosen for. */
export function captionFrame(project: Pick<Project, 'style' | 'width' | 'height'>): { w: number; h: number } {
  const f = outputSize(project.style?.aspectRatio ?? 'auto', project.width || 1920, project.height || 1080, 1080)
  return { w: f.width, h: f.height }
}

/** The camera covers at least 20% of the frame, or a camera-only or large-camera layout shows, for half the viewing time. */
export function cameraLed(project: Project, frame: { w: number; h: number }): boolean {
  if (!project.hasWebcam || !project.webcam?.show) return false
  const clips = project.clips.length ? project.clips : [{ start: 0, end: project.duration, speed: 1 }]
  const total = clips.reduce((n, c) => n + Math.max(0, c.end - c.start) / (c.speed || 1), 0)
  if (!(total > 0)) return false
  const step = Math.max(0.25, total / SAMPLES)
  const area = frame.w * frame.h
  let led = 0
  let all = 0
  for (const c of clips) {
    const speed = c.speed || 1
    for (let v = step / 2; v < (c.end - c.start) / speed; v += step) {
      const t = c.start + v * speed
      all += step
      const layout = (project.layouts ?? []).find((l) => l.start <= t && t < l.end)?.layout
      if (layout === 'camera-only' || layout === 'camera-large') {
        led += step
        continue
      }
      if (layout === 'screen-only') continue
      const box = sceneCameraBox(project, frame.w, frame.h, project.width, project.height, t)
      if (cameraBoxShown(box) && (box.rect.w * box.rect.h) / area >= CAMERA_SHARE) led += step
    }
  }
  return all > 0 && led / all >= CAMERA_TIME
}

/** Words a minute over the captions' time. */
function wordsPerMinute(project: Project): number {
  let words = 0
  let seconds = 0
  for (const s of project.transcript?.segments ?? []) {
    words += s.text.split(/\s+/).filter(Boolean).length
    seconds += Math.max(0, s.end - s.start)
  }
  return seconds > 0 ? (words / seconds) * 60 : 0
}

/** Distinct speakers named on the captions (NW-09). */
function speakerCount(project: Project): number {
  return new Set((project.transcript?.segments ?? []).map((s) => s.speaker?.trim().toLowerCase()).filter(Boolean)).size
}

/** The rule of §11.6 that applies, without the brand kit and the gate. */
function rule(project: Project, frame: { w: number; h: number }): { tile: string; reason: string; edit?: (s: CaptionStudio) => CaptionStudio; speakers?: true } {
  const tall = isTall(frame.w, frame.h)
  if (tall) {
    if (!cameraLed(project, frame)) return { tile: 'clean-short', reason: AUTO_STYLE_REASONS.tallScreen }
    const fast = wordsPerMinute(project) > FAST_SPEECH
    const guessed = estimatedShare(project.transcript?.segments ?? []) > 0.5
    return {
      tile: 'bold-pop',
      reason: AUTO_STYLE_REASONS.tallCamera,
      edit: (s) => ({
        ...s,
        ...(guessed ? { spoken: 'none' as const, motion: { ...s.motion, word: 'none' as const } } : {}),
        layout: { ...s.layout, ...(fast ? { words: 4 } : {}) }
      })
    }
  }
  if (isSquare(frame.w, frame.h)) {
    if (cameraLed(project, frame)) return { tile: 'highlight-box', reason: AUTO_STYLE_REASONS.squareCamera, edit: (s) => ({ ...s, layout: { ...s.layout, chunk: 'words', words: 5, lines: 2 } }) }
    return { tile: 'clean-short', reason: AUTO_STYLE_REASONS.squareScreen, edit: (s) => ({ ...s, layout: { ...s.layout, chunk: 'words', words: 4 } }) }
  }
  if (speakerCount(project) >= 2) return { tile: 'subtitle', reason: AUTO_STYLE_REASONS.speakers, edit: (s) => ({ ...s, speakerColors: true }), speakers: true }
  return { tile: 'subtitle', reason: AUTO_STYLE_REASONS.wide }
}

/** Languages without capitals or spaces that keep 24 / 16 characters a line (§11.6). */
const SHORT_LINES = new Set(['zh', 'ja', 'th'])

/** The changes every automatic look gets: script rules, the brand body font, Lower in tall frames. */
function adapt(studio: CaptionStudio, project: Project, frame: { w: number; h: number }): CaptionStudio {
  let s = studio
  const lang = (project.transcript?.language ?? '').toLowerCase().split(/[-_]/)[0]
  if (SHORT_LINES.has(lang)) s = { ...s, text: { ...s.text, case: 'asis' }, layout: { ...s.layout, chars: 24, tallChars: 16 } }
  // A brand kit's body font (applyBrandKitToNew writes it to captions.font) becomes the text's font.
  const font = project.captions?.font
  if (font) {
    const emphasisFollows = !s.emphasis.font || s.emphasis.font === s.text.font
    s = { ...s, text: { ...s.text, font }, emphasis: emphasisFollows ? { ...s.emphasis, ...(s.emphasis.font ? { font } : {}) } : s.emphasis }
  }
  if (isTall(frame.w, frame.h) && s.layout.position === 'bottom') s = { ...s, layout: { ...s.layout, position: 'lower' } }
  return s
}

/** The tile Auto style picks for the project, its look and the reason shown; null when the gate says no. */
export function autoStyle(project: Project, frame: { w: number; h: number }, brand?: CaptionStudio | null): { tile: string; studio: CaptionStudio; reason: string } | null {
  if (!autoStyleAllowed(project)) return null
  if (brand) return { tile: 'brand', studio: { ...structuredClone(brand), from: 'brand' }, reason: AUTO_STYLE_REASONS.brand }
  const r = rule(project, frame)
  const preset = studioPreset(r.tile)
  if (!preset) return null
  const look: CaptionStudio = { ...structuredClone(preset.look), from: r.tile }
  return { tile: r.tile, studio: adapt(r.edit ? r.edit(look) : look, project, frame), reason: r.reason }
}

/** The caption settings with an automatic look: its fallback preset for older builds, never `picked` (§11.6). */
export function withAutoLook(settings: CaptionSettings, pick: { tile: string; studio: CaptionStudio }, speakers?: boolean): CaptionSettings {
  const fallback = studioPreset(pick.tile)?.fallback ?? 'clean'
  const { picked: _picked, ...rest } = withPreset(settings, fallback)
  void _picked
  const place = settings.studio?.layout.place
  const studio = place ? { ...pick.studio, layout: { ...pick.studio.layout, place: { ...place } } } : pick.studio
  return { ...rest, studio, ...(speakers ? { showSpeaker: true as const } : {}) }
}

/** The settings Auto style gives the project, or null when the gate says no (shared by the first captions, the planner and Polish). */
export function autoStyleSettings(project: Project, frame: { w: number; h: number }, brand?: CaptionStudio | null): { settings: CaptionSettings; tile: string; reason: string } | null {
  const pick = autoStyle(project, frame, brand)
  if (!pick) return null
  const speakers = !brand && pick.reason === AUTO_STYLE_REASONS.speakers
  return { settings: withAutoLook(captionsOf(project), pick, speakers), tile: pick.tile, reason: pick.reason }
}

/** `next` with Auto style's look when it is the project's first transcript (`transcribe`, Polish's captions step); no record. */
export function autoStyleOnFirstCaptions(prev: Project, next: Project, frame: { w: number; h: number }, brand?: CaptionStudio | null): Project {
  if (prev.transcript?.segments.length || !next.transcript?.segments.length) return next
  const auto = autoStyleSettings(next, frame, brand)
  return auto ? { ...next, captions: auto.settings } : next
}

/** The tile with the gallery's "Suggested" badge (§2.5): Karaoke Fill in a wide camera-led project, else Auto style's pick. */
export function suggestedTile(project: Project, frame: { w: number; h: number }): string {
  const tall = isTall(frame.w, frame.h)
  if (!tall && !isSquare(frame.w, frame.h) && cameraLed(project, frame)) return 'karaoke-fill'
  return rule(project, frame).tile
}
