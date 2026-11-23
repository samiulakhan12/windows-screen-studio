import fs from 'node:fs'
import path from 'node:path'
import { createProject } from '../src/shared/engine/project'
import type { CaptionSegment, Cover, NormRect, Project } from '../src/shared/types'
import { writePath, type CoverKey } from '../src/shared/privacy/coverPath'
import { rng } from './verticalFixtures'

/*
 * Fixtures of the auto-blur tests (docs/design/auto-blur.md §17.1): every old project file the
 * earlier guards keep, projects saved by waves 10 to 12, covers and paths. Literals or seeded only.
 */

export { rng }

export interface OldFixture {
  name: string
  raw: Record<string, unknown>
}

const load = (file: string): OldFixture[] => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))

export const words = (id: string, start: number, text: string): CaptionSegment => {
  const list = text.split(' ')
  return { id, start, end: start + list.length * 0.4, text, words: list.map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.35 })) }
}

export const base = (id: string, duration: number, over: { fps?: number; width?: number; height?: number; hasWebcam?: boolean } = {}): Project =>
  createProject({
    id,
    name: id,
    duration,
    width: over.width ?? 1920,
    height: over.height ?? 1080,
    hasWebcam: over.hasWebcam ?? false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: over.fps ?? 30 }
  })

/** Projects saved by waves 10, 11 and 12: cut styles and colour, a found chapter and a guide, bleeps, tracks and a pack. */
export function waveProjects(): OldFixture[] {
  const w10 = base('w10', 40)
  const w11 = base('w11', 60, { fps: 60 })
  const w12 = base('w12', 45, { fps: 60 })
  const segments = [words('k1', 1, 'Welcome to the billing page'), words('k2', 4, 'My card is 4917 6123 4567 eight nine zero four'), words('k3', 12, 'Click the Save button now')]
  return [
    {
      name: 'wave 10',
      raw: JSON.parse(
        JSON.stringify({
          ...w10,
          clips: [
            { id: 'a', start: 0.5, end: 18, speed: 1 },
            { id: 'b', start: 19, end: 40, speed: 1.5 }
          ],
          joins: { all: { kind: 'crossfade', duration: 0.3 } },
          grade: { screen: { look: 'vivid', contrast: 0.1 } },
          chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' },
          soundFx: { zoomIn: 'sfx:whoosh-soft', volume: 0.35 },
          shapes: [{ id: 'h1', start: 1, end: 9, kind: 'blur', x: 0.6, y: 0.1, w: 0.25, h: 0.08, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.6 }],
          transcript: { language: 'en', provider: 'local', model: 'speech-small', createdAt: '2026-11-01T09:00:00.000Z', segments },
          bleeps: [{ id: 'b1', start: 13.15, end: 13.55, word: 'save', sound: 'tone' }]
        })
      )
    },
    {
      name: 'wave 11',
      raw: JSON.parse(
        JSON.stringify({
          ...w11,
          chapters: [
            { id: 'ch1', t: 0, title: 'Intro' },
            { id: 'ch2', t: 30, title: 'Billing', auto: { by: 'find', from: ['page', 'pause'], name: 'sentence' } }
          ],
          guide: { title: 'How to export', intro: 'Three steps.', language: 'en', steps: [] },
          clipOf: { kind: 'moment', start: 12, end: 40, why: 'Opens with a question' }
        })
      )
    },
    {
      name: 'wave 12',
      raw: JSON.parse(
        JSON.stringify({
          ...w12,
          crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
          transcript: { language: 'en', provider: 'local', model: 'speech-small', createdAt: '2026-11-15T09:00:00.000Z', segments },
          captionTracks: [{ language: 'es', by: 'local', model: 'm', createdAt: '2026-11-15T09:30:00.000Z', segments: segments.map((s) => ({ id: s.id, text: `es ${s.text}`, src: 'x' })) }],
          bleeps: [{ id: 'b1', start: 5.15, end: 5.55, word: 'card', sound: 'tone', auto: true }],
          publish: { description: 'All about billing.' }
        })
      )
    }
  ]
}

/** Every old fixture: the earlier guards' files and waves 10 to 12's projects. */
export function oldFixtures(): OldFixture[] {
  return [...load('vertical-old-projects.json'), ...load('wave8-old-projects.json'), ...load('captions-old-projects.json'), ...waveProjects()]
}

/** A cover over `keys` (one key: a fixed box). */
export function coverOf(id: string, start: number, end: number, keys: readonly CoverKey[], over: Partial<Cover> = {}): Cover {
  return { id, start, end, path: writePath(keys), color: '#1c1c22', ...over }
}

export const key = (t: number, x: number, y: number, w: number, h: number): CoverKey => ({ t, x, y, w, h })

/** `n` seeded covers over `duration` with `keys` keys each, small boxes moving a little. */
export function seededCovers(seed: number, n: number, keys: number, duration: number, over: Partial<Cover> = {}): Cover[] {
  const r = rng(seed)
  const out: Cover[] = []
  for (let i = 0; i < n; i++) {
    const start = Math.round(r() * (duration - 2) * 1000) / 1000
    const end = Math.round((start + 0.05 + r() * 1.9) * 1000) / 1000
    let x = r() * 0.85
    let y = r() * 0.9
    const w = 0.02 + r() * 0.1
    const h = 0.01 + r() * 0.05
    const list: CoverKey[] = []
    for (let k = 0; k < keys; k++) {
      list.push(key(start + ((end - start) * k) / keys, x, y, w, h))
      x = Math.min(0.85, Math.max(0, x + (r() - 0.5) * 0.01))
      y = Math.min(0.9, Math.max(0, y + (r() - 0.5) * 0.01))
    }
    out.push(coverOf(`c${i}`, start, end, list, over))
  }
  return out
}

const EPS = 1e-6
export const inside = (inner: NormRect, outer: NormRect | null): boolean =>
  !!outer && inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS
