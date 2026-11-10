/**
 * Projects and media facts for the timeline tests (docs/design/output-and-languages.md §23.1 tests
 * 36–44): a small project whose golden files are kept in tests/fixtures/timelines, and a long one of
 * 1,000 clips at mixed speeds with pause freezes and crossfades.
 */
import { createProject } from '../src/shared/engine/project'
import type { TimelinePlan, TimelineSource } from '../src/shared/interchange/timelinePlan'
import type { Clip, Freeze, Project } from '../src/shared/types'

export function timelineProject(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p6f1c',
    name: 'Demo',
    duration: 20,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
  })
  return { ...p, createdAt: '2026-11-01T00:00:00.000Z', ...over }
}

/**
 * The golden files' project: four clips (one at 2x, one at 0.5x), a pause freeze of 1 s inside the
 * third clip, a crossfade into the last clip, a camera half a second late, and three chapters, one
 * of them named in Bangla and one with characters XML must escape.
 */
export function goldenProject(): Project {
  return timelineProject({
    name: 'Demo & "Tour" <1>',
    hasWebcam: true,
    webcamOffset: 0.5,
    audioStems: { mic: true, system: true },
    clips: [
      { id: 'a', start: 0, end: 4, speed: 1 },
      { id: 'b', start: 5, end: 9, speed: 2 },
      { id: 'c', start: 10, end: 12, speed: 0.5 },
      { id: 'd', start: 14, end: 18, speed: 1 }
    ],
    freezes: [{ id: 'f1', at: 11, length: 1, sound: 'pause' }],
    joins: { cuts: [{ clip: 'd', kind: 'crossfade', duration: 0.5 }] },
    chapters: [
      { id: 'h1', t: 0, title: 'Intro' },
      { id: 'h2', t: 5.5, title: 'ভূমিকা' },
      { id: 'h3', t: 15, title: 'Settings <page> & "more"' }
    ]
  })
}

/** Media facts for the golden recordings timeline. */
export const GOLDEN_MEDIA: TimelinePlan['media'] = {
  screen: { fps: 60, frames: 1200, width: 1920, height: 1080, audio: false, video: true },
  camera: { fps: 30, frames: 585, width: 1280, height: 720, audio: false, video: true },
  voice: { fps: 30, frames: 600, audio: true, video: false },
  system: { fps: 30, frames: 600, audio: true, video: false },
  music: { fps: 30, frames: 540, audio: true, video: false }
}

/** The golden files' paths: Windows paths with a space, a Bangla folder and a #. */
export const GOLDEN_EXPORT_PATHS = {
  video: 'C:\\Users\\রহিম\\Videos\\Demo #1.mp4',
  voice: 'C:\\Users\\রহিম\\Videos\\Demo #1 - Voice.wav',
  system: 'C:\\Users\\রহিম\\Videos\\Demo #1 - System sound.wav',
  music: 'C:\\Users\\রহিম\\Videos\\Demo #1 - Music.wav'
} as const

export const GOLDEN_RECORDING_PATHS = {
  screen: 'C:\\Users\\রহিম\\Videos\\Demo #1 media\\Screen.mp4',
  camera: 'C:\\Users\\রহিম\\Videos\\Demo #1 media\\Camera.mp4',
  voice: 'C:\\Users\\রহিম\\Videos\\Demo #1 media\\Voice.wav',
  system: 'C:\\Users\\রহিম\\Videos\\Demo #1 media\\System sound.wav',
  music: 'C:\\Users\\রহিম\\Videos\\Demo #1 media\\Music.wav'
} as const

const SPEEDS = [1, 1.5, 0.75, 2, 1.25, 0.5, 3, 1, 4, 0.25]

/**
 * 1,000 clips at mixed speeds (each 1.3–2.9 s of source with 0.4–1.1 s cut between them), three
 * pause freezes (inside a clip, at a clip's start, at the edit's end), crossfades at every cut but
 * a dip into clip 10 and a hard cut into clip 20.
 */
export function longProject(captureFps: number, extra: Partial<Project> = {}): Project {
  const clips: Clip[] = []
  let t = 0.25
  for (let i = 0; i < 1000; i++) {
    const length = 1.3 + ((i * 37) % 17) / 10
    clips.push({ id: `k${i}`, start: Math.round(t * 1000) / 1000, end: Math.round((t + length) * 1000) / 1000, speed: SPEEDS[i % SPEEDS.length] })
    t += length + 0.4 + ((i * 13) % 8) / 10
  }
  const duration = Math.ceil(t + 1)
  const freezes: Freeze[] = [
    { id: 'f-mid', at: Math.round(((clips[100].start + clips[100].end) / 2) * 1000) / 1000, length: 2.5, sound: 'pause' },
    { id: 'f-cut', at: clips[500].start, length: 1, sound: 'pause' },
    { id: 'f-end', at: clips[999].end, length: 3, sound: 'pause' }
  ]
  return timelineProject({
    name: 'Long tour',
    duration,
    clips,
    freezes,
    joins: {
      all: { kind: 'crossfade', duration: 0.2 },
      cuts: [
        { clip: 'k10', kind: 'dip', duration: 0.6 },
        { clip: 'k20', kind: 'cut' }
      ]
    },
    capture: { method: 'native', cursorInVideo: false, region: null, fps: captureFps },
    ...extra
  })
}

/** Media facts for a long project whose screen recording runs at `fps`. */
export function longMedia(project: Project, fps: number, size = { width: 2560, height: 1440 }): TimelinePlan['media'] {
  const screen: TimelineSource = { fps, frames: Math.round(project.duration * fps), ...size, audio: false, video: true }
  return {
    screen,
    camera: { fps: 30, frames: Math.round((project.duration - 1) * 30), width: 1280, height: 720, audio: false, video: true },
    recording: { fps: 30, frames: Math.round(project.duration * 30), audio: true, video: false },
    music: { fps: 30, frames: 30 * 60 * 120, audio: true, video: false }
  }
}
