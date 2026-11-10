/**
 * Tests 36, 41 and 43 (docs/design/output-and-languages.md §23.1, §8.1, §8.2, §8.6): the timeline
 * plans of "This export" and "The original recordings", and their rates.
 */
import { describe, expect, it } from 'vitest'
import { editToVideo, planOf, videoDuration } from '../src/shared/engine/freeze'
import { checkTimelinePlan } from '../src/shared/interchange/planCheck'
import { exportTimeline, recordingsTimeline, timelineRate, type TimelineEvent, type TimelinePlan } from '../src/shared/interchange/timelinePlan'
import { joinPlan } from '../src/shared/render/joins'
import type { Project } from '../src/shared/types'
import { longMedia, longProject, timelineProject } from './timelineFixtures'

const trackNamed = (plan: TimelinePlan, name: string) => plan.tracks.find((t) => t.name === name)!

/** Clip starts in video time, worked out from the engine's own maps (not the builder's walk). */
function clipStarts(project: Project): number[] {
  const plan = planOf(project)
  let edit = 0
  return project.clips.map((c) => {
    const v = editToVideo(plan, edit)
    edit += (c.end - c.start) / c.speed
    return v
  })
}

describe('test 36: recordingsTimeline over 1,000 clips', () => {
  for (const [label, fps, imported] of [
    ['a 30 fps capture', 30, false],
    ['a 60 fps capture', 60, false],
    ['a 25 fps imported video', 25, true]
  ] as const) {
    it(`cuts, speeds, holds and dissolves on their frames for ${label}`, () => {
      const project = longProject(fps, imported ? { source: { kind: 'import', fileName: 'talk.mov', bytes: 1, container: 'mov', videoCodec: 'h264', audioCodec: 'aac', width: 2560, height: 1440, rotation: 0, fps: 25, importedAt: '' } } : {})
      const media = longMedia(project, fps)
      const plan = recordingsTimeline(project, 60, media)
      expect(checkTimelinePlan(plan)).toBeNull()
      const freeze = planOf(project)
      expect(plan.fps).toBe(60)
      expect(plan.frames).toBe(Math.round(videoDuration(project.clips, freeze) * 60))

      // V1 runs from 0 to the video's last frame without a gap or an overlap.
      const v1 = trackNamed(plan, 'Screen')
      expect(v1.kind).toBe('video')
      expect(v1.enabled).toBe(true)
      expect(v1.events[0].recIn).toBe(0)
      expect(v1.events[v1.events.length - 1].recOut).toBe(plan.frames)
      for (let i = 1; i < v1.events.length; i++) expect(v1.events[i].recIn).toBe(v1.events[i - 1].recOut)

      // Three pause freezes: three holds of one frame each at speed 0, their lengths in frames.
      const holds = v1.events.filter((e) => e.speed === 0)
      expect(holds).toHaveLength(3)
      for (const h of holds) expect(h.srcOut).toBe(h.srcIn + 1)
      expect(holds.map((h) => h.recOut - h.recIn)).toEqual([150, 60, 180])
      // The hold at the edit's end shows the last frame before it.
      expect(holds[2].srcIn).toBe(Math.round(project.clips[999].end * fps) - 1)
      expect(holds[2].recOut).toBe(plan.frames)

      // Every record edge is the exact video time rounded once: each clip starts on its own frame.
      const starts = clipStarts(project)
      const byStart = new Map(v1.events.map((e) => [e.recIn, e]))
      project.clips.forEach((c, k) => {
        // The clip after the hold at its start begins after the hold.
        const at = k === 500 ? Math.round((starts[k] + 1) * 60) : Math.round(starts[k] * 60)
        const e = byStart.get(at)
        expect(e, `clip ${k}`).toBeDefined()
        expect(e!.speed).toBe(c.speed)
        // Source frames on the screen's own grid.
        expect(e!.srcIn).toBe(Math.round(c.start * fps))
        if (k !== 100) expect(e!.srcOut).toBe(Math.round(c.end * fps))
      })

      // Crossfades become dissolves on the event after the cut; the dip into clip 10 and the hard cut into clip 20 do not.
      const windows = joinPlan(project).filter((w) => w.kind === 'crossfade')
      const dissolves = v1.events.filter((e) => e.dissolve !== undefined)
      expect(dissolves.length).toBe(windows.length)
      expect(windows.length).toBeGreaterThan(990)
      const length = new Map(windows.map((w) => [Math.round(w.from * 60), Math.round((w.to - w.from) * 60)]))
      for (const e of dissolves) expect(e.dissolve).toBe(length.get(e.recIn))
      expect(byStart.get(Math.round(starts[10] * 60))!.dissolve).toBeUndefined()
      expect(byStart.get(Math.round(starts[20] * 60))!.dissolve).toBeUndefined()
      expect(byStart.get(Math.round(starts[11] * 60))!.dissolve).toBe(12)

      // The size is the screen recording's; V2 is the camera, turned off, on its own 30 fps grid.
      expect([plan.width, plan.height]).toEqual([2560, 1440])
      const v2 = trackNamed(plan, 'Camera')
      expect(v2.kind).toBe('video')
      expect(v2.enabled).toBe(false)
      const cam = v2.events.find((e) => e.speed === 1 && e.recIn === Math.round(starts[7] * 60))!
      expect(cam.srcIn).toBe(Math.round(project.clips[7].start * 30))
      expect(cam.srcOut).toBe(Math.round(project.clips[7].end * 30))

      // The recording's sound is cut like V1, with a gap at each pause freeze and none elsewhere.
      const a1 = trackNamed(plan, 'Recording')
      expect(a1.kind).toBe('audio')
      expect(a1.role).toBe('dialogue')
      const gaps: [number, number][] = []
      for (let i = 1; i < a1.events.length; i++) if (a1.events[i].recIn !== a1.events[i - 1].recOut) gaps.push([a1.events[i - 1].recOut, a1.events[i].recIn])
      expect(gaps).toEqual(holds.slice(0, 2).map((h) => [h.recIn, h.recOut]))
      expect(a1.events[a1.events.length - 1].recOut).toBe(holds[2].recIn)
      // Its source frames on its own 30 fps grid.
      const sound = new Map(a1.events.map((e) => [e.recIn, e]))
      project.clips.forEach((c, k) => {
        if (k === 500) return
        const e = sound.get(Math.round(starts[k] * 60))!
        expect(e.srcIn).toBe(Math.round(c.start * 30))
        if (k !== 100) expect(e.srcOut).toBe(Math.round(c.end * 30))
      })

      // Music: one event from 0 to the end at 0 dB.
      const music = trackNamed(plan, 'Music')
      expect(music.role).toBe('music')
      expect(music.events).toEqual([{ media: 'music', recIn: 0, recOut: plan.frames, srcIn: 0, srcOut: Math.round((plan.frames * 30) / 60), speed: 1 }])
    })
  }

  it('splits a clip at a pause freeze inside it and keeps the source continuous across the hold', () => {
    const project = longProject(60)
    const plan = recordingsTimeline(project, 60, longMedia(project, 60))
    const v1 = trackNamed(plan, 'Screen').events
    const i = v1.findIndex((e) => e.speed === 0)
    const [before, hold, after] = [v1[i - 1], v1[i], v1[i + 1]]
    const at = project.freezes![0].at
    expect(before.srcOut).toBe(Math.round(at * 60))
    expect(hold.srcIn).toBe(Math.round(at * 60))
    expect(after.srcIn).toBe(Math.round(at * 60))
    expect(after.speed).toBe(before.speed)
  })

  it('holds the picture of a continue freeze while the sound and the camera play on', () => {
    const project = timelineProject({
      hasWebcam: true,
      clips: [{ id: 'a', start: 0, end: 10, speed: 1 }],
      freezes: [{ id: 'c', at: 2, length: 3, sound: 'continue' }]
    })
    const media = { screen: { fps: 30, frames: 600, width: 1920, height: 1080, audio: false, video: true }, camera: { fps: 30, frames: 600, audio: false, video: true }, voice: { fps: 30, frames: 600, audio: true, video: false } }
    const plan = recordingsTimeline(project, 30, media)
    expect(trackNamed(plan, 'Screen').events).toEqual<TimelineEvent[]>([
      { media: 'screen', recIn: 0, recOut: 60, srcIn: 0, srcOut: 60, speed: 1 },
      { media: 'screen', recIn: 60, recOut: 150, srcIn: 60, srcOut: 61, speed: 0 },
      { media: 'screen', recIn: 150, recOut: 300, srcIn: 150, srcOut: 300, speed: 1 }
    ])
    expect(trackNamed(plan, 'Camera').events).toEqual([{ media: 'camera', recIn: 0, recOut: 300, srcIn: 0, srcOut: 300, speed: 1 }])
    expect(trackNamed(plan, 'Voice').events).toEqual([{ media: 'voice', recIn: 0, recOut: 300, srcIn: 0, srcOut: 300, speed: 1 }])
  })

  it('starts the camera where it starts and stops it where it stops (webcamOffset)', () => {
    const project = timelineProject({ hasWebcam: true, webcamOffset: 1, clips: [{ id: 'a', start: 0, end: 10, speed: 2 }] })
    const media = { screen: { fps: 30, frames: 300, width: 1920, height: 1080, audio: false, video: true }, camera: { fps: 30, frames: 240, audio: false, video: true } }
    const plan = recordingsTimeline(project, 30, media)
    // Camera time = screen time - 1 s; at 2x the camera's first second of video starts at video 0.5 s and its last at 4.5 s.
    expect(trackNamed(plan, 'Camera').events).toEqual([{ media: 'camera', recIn: 15, recOut: 135, srcIn: 0, srcOut: 240, speed: 2 }])
  })

  it('caps the sequence of a screen larger than MAX_EXPORT_SIDE and names V1, V2 and the sound tracks', () => {
    const project = longProject(60)
    const plan = recordingsTimeline(project, 30, { ...longMedia(project, 60, { width: 5120, height: 1440 }), recording: undefined, voice: { fps: 30, frames: 1000, audio: true, video: false }, system: { fps: 30, frames: 1000, audio: true, video: false } })
    expect([plan.width, plan.height]).toEqual([4096, 1152])
    expect(plan.tracks.map((t) => [t.kind, t.name, t.role ?? null, t.enabled])).toEqual([
      ['video', 'Screen', null, true],
      ['video', 'Camera', null, false],
      ['audio', 'Voice', 'dialogue', true],
      ['audio', 'System sound', 'effects', true],
      ['audio', 'Music', 'music', true]
    ])
    expect(plan.pictureOnly).toBe(false)
    expect(checkTimelinePlan(plan)).toBeNull()
  })
})

describe('test 41: exportTimeline', () => {
  const project = timelineProject({
    clips: [
      { id: 'a', start: 0, end: 10, speed: 1 },
      { id: 'b', start: 12, end: 20, speed: 2 }
    ],
    chapters: [
      { id: 'c1', t: 0, title: 'Intro' },
      { id: 'c2', t: 14, title: '' },
      { id: 'c3', t: 19.99, title: 'Too late' }
    ]
  })
  const exported = { fps: 30, frames: 420, width: 1920, height: 1080 }

  it('puts the video on V1 and the stems under it, picture only', () => {
    const plan = exportTimeline(project, exported, ['music', 'voice', 'system'])
    expect(checkTimelinePlan(plan)).toBeNull()
    expect(plan.pictureOnly).toBe(true)
    expect([plan.fps, plan.frames, plan.width, plan.height]).toEqual([30, 420, 1920, 1080])
    expect(plan.tracks.map((t) => [t.kind, t.name, t.role ?? null])).toEqual([
      ['video', 'Video', null],
      ['audio', 'Voice', 'dialogue'],
      ['audio', 'System sound', 'effects'],
      ['audio', 'Music', 'music']
    ])
    expect(plan.tracks[0].events).toEqual([{ media: 'video', recIn: 0, recOut: 420, srcIn: 0, srcOut: 420, speed: 1 }])
    for (const t of plan.tracks.slice(1)) expect(t.events).toEqual([{ media: t.events[0].media, recIn: 0, recOut: 420, srcIn: 0, srcOut: 420, speed: 1 }])
    expect(plan.media.video).toMatchObject({ fps: 30, frames: 420, width: 1920, height: 1080, video: true })
    expect(Object.keys(plan.media).sort()).toEqual(['music', 'system', 'video', 'voice'])
  })

  it('without stems: no audio tracks and the video keeps its own sound', () => {
    const plan = exportTimeline(project, exported, [])
    expect(plan.pictureOnly).toBe(false)
    expect(plan.tracks).toHaveLength(1)
    expect(plan.tracks[0].kind).toBe('video')
    expect(plan.media.video!.audio).toBe(true)
  })

  it('places the chapter markers in timeline frames, an unnamed one as "Chapter n"', () => {
    const plan = exportTimeline(project, exported, [])
    // Chapter 2 at source 14 s: 10 s of clip a, then (14 - 12) / 2 = 1 s into clip b.
    expect(plan.markers).toEqual([
      { frame: 0, name: 'Intro', chapter: true },
      { frame: 330, name: 'Chapter 2', chapter: true }
    ])
  })

  it('keeps a long project name within the plan limit, never inside a surrogate pair', () => {
    const plan = exportTimeline({ ...project, name: `${'a'.repeat(499)}😀tail` }, exported, [])
    expect(plan.name).toBe('a'.repeat(499))
    expect(checkTimelinePlan(plan)).toBeNull()
  })
})

describe('test 43: rates', () => {
  it('a 120 fps export gives a 60 fps timeline over half its frames; 24 and 25 stay exact', () => {
    expect([24, 25, 30, 60, 120].map(timelineRate)).toEqual([24, 25, 30, 60, 60])
    const project = timelineProject()
    const at120 = exportTimeline(project, { fps: 120, frames: 2400, width: 1920, height: 1080 }, ['voice'])
    expect(at120.fps).toBe(60)
    expect(at120.frames).toBe(1200)
    expect(at120.tracks[0].events[0]).toEqual({ media: 'video', recIn: 0, recOut: 1200, srcIn: 0, srcOut: 2400, speed: 1 })
    expect(at120.media.video!.fps).toBe(120)
    expect(at120.media.voice).toEqual({ fps: 60, frames: 1200, audio: true, video: false })
    for (const fps of [24, 25] as const) {
      const plan = exportTimeline(project, { fps, frames: 20 * fps, width: 1920, height: 1080 }, [])
      expect([plan.fps, plan.frames]).toEqual([fps, 20 * fps])
      expect(checkTimelinePlan(plan)).toBeNull()
    }
    const recordings = recordingsTimeline(project, 120, { screen: { fps: 60, frames: 1200, width: 1920, height: 1080, audio: false, video: true } })
    expect([recordings.fps, recordings.frames]).toEqual([60, 1200])
    const at25 = recordingsTimeline(project, 25, { screen: { fps: 60, frames: 1200, width: 1920, height: 1080, audio: false, video: true } })
    expect([at25.fps, at25.frames]).toEqual([25, 500])
    expect(at25.tracks[0].events).toEqual([{ media: 'screen', recIn: 0, recOut: 500, srcIn: 0, srcOut: 1200, speed: 1 }])
  })

  it('an odd number of 120 fps frames never reaches past the video', () => {
    const plan = exportTimeline(timelineProject(), { fps: 120, frames: 2401, width: 1920, height: 1080 }, [])
    expect(plan.frames).toBe(1200)
    expect(plan.tracks[0].events[0].srcOut).toBe(2400)
  })
})
