/** Projects for Short clips' tests (smart-tools.md §8): narrated recordings with timed words, cuts, speeds and freezes. */
import type { SceneScan } from '../src/shared/api/projects'
import { createProject } from '../src/shared/engine/project'
import type { CaptionSegment, Clip, CursorTrack, Project } from '../src/shared/types'

/** A sentence said at `t`: its words `per` seconds apart (each word 0.8 × per long). */
export interface Said {
  t: number
  text: string
  per?: number
}

/** One caption per sentence, with its words' times. */
export function segmentsOf(said: readonly Said[], prefix = 's'): CaptionSegment[] {
  return said.map((s, i) => {
    const per = s.per ?? 0.35
    const texts = s.text.split(' ').filter(Boolean)
    const words = texts.map((text, k) => ({ text, start: s.t + k * per, end: s.t + k * per + per * 0.8 }))
    return { id: `${prefix}${i}`, start: s.t, end: words[words.length - 1].end, text: s.text, words }
  })
}

export function clipProject(opts: { said?: readonly Said[]; duration: number; clips?: Clip[]; language?: string; id?: string; name?: string } & Partial<Project>): Project {
  const { said = [], duration, clips, language = 'en', id = 'clips', name = 'Billing tour', ...over } = opts
  const p = createProject({
    id,
    name,
    duration,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  const segments = segmentsOf(said)
  return {
    ...p,
    createdAt: '2026-11-01T00:00:00.000Z',
    clips: clips ?? [{ id: 'k0', start: 0, end: duration, speed: 1 }],
    ...(segments.length ? { transcript: { language, provider: 'local', model: 'm', createdAt: '', segments } } : {}),
    ...over
  }
}

/** `n` sentences of about `words` words, one every `every` seconds from `from`. */
export function steadyTalk(n: number, opts: { from?: number; every?: number; words?: number; text?: (i: number) => string } = {}): Said[] {
  const { from = 1, every = 5, words = 8 } = opts
  const filler = ['we', 'look', 'at', 'the', 'report', 'page', 'and', 'its', 'totals', 'today', 'again', 'here']
  return Array.from({ length: n }, (_, i) => ({
    t: from + i * every,
    text: opts.text ? opts.text(i) : `${Array.from({ length: words - 1 }, (_, k) => filler[(i + k) % filler.length]).join(' ')} item${i}.`
  }))
}

export const NO_TRACK: CursorTrack = { samples: [], clicks: [], keys: [], valid: true }

export function trackOf(over: Partial<CursorTrack>): CursorTrack {
  return { ...NO_TRACK, ...over }
}

/** A scene scan of `L` seconds sampled every 0.25 s, still except for changes of the given share (%) at the given times. */
export function scanOf(L: number, changes: Record<number, number> = {}): SceneScan {
  const step = 0.25
  const t: number[] = []
  const changed: number[] = []
  for (let i = 0; i * step < L; i++) {
    t.push(i * step)
    changed.push(0)
  }
  for (const [at, share] of Object.entries(changes)) changed[Math.round(Number(at) / step)] = share
  return { step, t, changed, stills: [] }
}
