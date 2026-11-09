/**
 * Running Short clips (docs/design/smart-tools.md §2.4, §8; §22.1 tests 54 and 56): captions first
 * when speech is heard without them, unless Use activity only; the copies made one after another,
 * Stop removing the one being made and keeping the finished, a refusal stopping with its message;
 * the narration sent to name clips and the names kept. window.api is a fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopyCost, DuplicateProgress } from '../src/shared/api/projects'
import type { AudioLevels } from '../src/shared/audio/loudness'
import type { Moment } from '../src/shared/clips/moments'
import type { Project } from '../src/shared/types'
import { clipProject, scanOf, steadyTalk, trackOf } from './clipFixtures'

const fake = vi.hoisted(() => ({
  calls: [] as { sourceId: string; name: string }[],
  pending: [] as { resolve(v: { id: string; name: string; linked: boolean }): void; reject(e: unknown): void }[],
  progress: null as ((p: { done: number; total: number }) => void) | null,
  cancelled: 0,
  deleted: [] as string[]
}))
vi.stubGlobal('window', {
  api: {
    duplicateProject: (sourceId: string, copy: { name: string }) =>
      new Promise((resolve, reject) => {
        fake.calls.push({ sourceId, name: copy.name })
        fake.pending.push({ resolve, reject })
      }),
    onDuplicateProgress: (l: (p: { done: number; total: number }) => void) => {
      fake.progress = l
      return () => void (fake.progress = null)
    },
    cancelDuplicate: () => void fake.cancelled++,
    deleteProject: async (id: string) => void fake.deleted.push(id)
  }
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUN = '../src/renderer/src/clips/clipsRun'
type Made = { made: { id: string; name: string }[]; stopped: boolean }
const run = (await import(/* @vite-ignore */ RUN)) as {
  makeClipCopies(copies: readonly Project[], deps: { sourceId: string; flush(): Promise<boolean>; signal: AbortSignal; onProgress(i: number, n: number, p: DuplicateProgress | null): void }): Promise<Made>
  clipsFor(project: Project, ctx: Record<string, unknown>): { moments: Moment[] } | { reason: string } | { needsCaptions: true }
  namesRequestForMoments(project: Project, moments: readonly Moment[]): { kind: string; language?: string; items: { id: string; text: string }[] }
  withAiTitles(moments: readonly Moment[], answer: readonly { id: string; name: string }[]): Moment[]
  copySpace(cost: CopyCost, n: number): { text: string; blocked: boolean }
  ClipCopyError: new (...a: unknown[]) => Error & { made: { id: string; name: string }[] }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const copies = (n: number): Project[] => Array.from({ length: n }, (_, i) => ({ ...clipProject({ duration: 60 }), name: `Clip ${i + 1} (clip)` }))

beforeEach(() => {
  fake.calls.length = 0
  fake.pending.length = 0
  fake.cancelled = 0
  fake.deleted.length = 0
})

describe('makeClipCopies (test 56)', () => {
  it('flushes the save, then makes them one after another, with each copy’s progress', async () => {
    const order: string[] = []
    const progress: [number, number, DuplicateProgress | null][] = []
    const out = run.makeClipCopies(copies(3), {
      sourceId: 'clips',
      flush: async () => {
        order.push('flush')
        return true
      },
      signal: new AbortController().signal,
      onProgress: (i, n, p) => progress.push([i, n, p])
    })
    await tick()
    expect(order).toEqual(['flush'])
    // Only the first is being made.
    expect(fake.calls.map((c) => c.name)).toEqual(['Clip 1 (clip)'])
    fake.progress!({ done: 5, total: 10 })
    fake.pending[0].resolve({ id: 'n1', name: 'Clip 1 (clip)', linked: true })
    await tick()
    expect(fake.calls).toHaveLength(2)
    fake.pending[1].resolve({ id: 'n2', name: 'Clip 2 (clip)', linked: true })
    await tick()
    fake.pending[2].resolve({ id: 'n3', name: 'Clip 3 (clip)', linked: true })
    expect(await out).toEqual({ made: [{ id: 'n1', name: 'Clip 1 (clip)' }, { id: 'n2', name: 'Clip 2 (clip)' }, { id: 'n3', name: 'Clip 3 (clip)' }], stopped: false })
    expect(fake.calls.every((c) => c.sourceId === 'clips')).toBe(true)
    expect(progress).toContainEqual([0, 3, { done: 5, total: 10 }])
    expect(progress[0]).toEqual([0, 3, null])
    expect(progress[progress.length - 1]).toEqual([3, 3, null])
  })

  it('Stop removes the copy being made and keeps the finished ones', async () => {
    const ctrl = new AbortController()
    const out = run.makeClipCopies(copies(3), { sourceId: 'clips', flush: async () => true, signal: ctrl.signal, onProgress: () => undefined })
    await tick()
    fake.pending[0].resolve({ id: 'n1', name: 'Clip 1 (clip)', linked: true })
    await tick()
    ctrl.abort()
    expect(await out).toEqual({ made: [{ id: 'n1', name: 'Clip 1 (clip)' }], stopped: true })
    expect(fake.cancelled).toBe(1)
    // The one being made finished all the same: it is removed.
    fake.pending[1].resolve({ id: 'n2', name: 'Clip 2 (clip)', linked: true })
    await tick()
    expect(fake.deleted).toEqual(['n2'])
    expect(fake.calls).toHaveLength(2)
  })

  it('a refusal stops with its message; the copies made stay', async () => {
    const out = run.makeClipCopies(copies(2), { sourceId: 'clips', flush: async () => false, signal: new AbortController().signal, onProgress: () => undefined })
    await tick()
    fake.pending[0].resolve({ id: 'n1', name: 'Clip 1 (clip)', linked: true })
    await tick()
    fake.pending[1].reject(new Error("Error invoking remote method 'projects:duplicate': Error: a copy is already being made."))
    const err = (await out.then(() => null, (e: unknown) => e)) as Error & { made: unknown }
    expect(err).toBeInstanceOf(run.ClipCopyError)
    expect(err.message).toBe('Could not make the copy: a copy is already being made.')
    expect(err.made).toEqual([{ id: 'n1', name: 'Clip 1 (clip)' }])
    expect(fake.deleted).toEqual([])
  })
})

/** Speech (power 0.1) for `seconds` from 1 s, with the speech detector's ranges, over `length` s. */
function levels(seconds: number, length = 120): AudioLevels {
  const window = 0.05
  const power = new Float32Array(Math.round(length / window)).fill(1e-9)
  for (let i = Math.round(1 / window); i < Math.round((1 + seconds) / window); i++) power[i] = 0.1
  return { window, power, speech: [{ start: 1, end: 1 + seconds }] }
}

describe('captions first (test 54)', () => {
  const clicks = Array.from({ length: 12 }, (_, i) => ({ t: 50 + i * 0.8, x: 0.5, y: 0.5, button: 'left' as const }))
  const ctx = { track: trackOf({ clicks }), scan: scanOf(120, { 40: 60, 80: 70 }), length: 'any' }

  it('speech heard without captions: Make captions first, unless Use activity only', () => {
    const p = clipProject({ duration: 120 })
    expect(run.clipsFor(p, { ...ctx, levels: { mix: levels(12) } })).toEqual({ needsCaptions: true })
    const busiest = run.clipsFor(p, { ...ctx, levels: { mix: levels(12) }, activityOnly: true }) as { moments: Moment[] }
    expect(busiest.moments.length).toBeGreaterThan(0)
    expect(busiest.moments.every((m) => m.silent)).toBe(true)
  })

  it('less than 10 s of speech, or no sound: the busiest stretches', () => {
    const p = clipProject({ duration: 120 })
    expect((run.clipsFor(p, { ...ctx, levels: { mix: levels(8) } }) as { moments: Moment[] }).moments[0].silent).toBe(true)
    expect((run.clipsFor(p, { ...ctx, levels: null }) as { moments: Moment[] }).moments[0].silent).toBe(true)
  })

  it('with captions: moments from what is said; a video under 45 s is too short whatever is heard', () => {
    const p = clipProject({ said: steadyTalk(20, { every: 5 }), duration: 110 })
    expect((run.clipsFor(p, { ...ctx, levels: { mix: levels(30) } }) as { moments: Moment[] }).moments[0].silent).toBe(false)
    expect(run.clipsFor(clipProject({ duration: 44 }), { ...ctx, levels: { mix: levels(30, 44) } })).toEqual({ reason: 'too-short' })
  })
})

describe('names with AI (§8.4)', () => {
  const moment = (start: number, end: number, title: string): Moment => ({ start, end, seconds: end - start, score: 1, reasons: [], first: '', title, silent: false })

  it('sends each moment’s kept words (bleeped words masked) as a clip item, at most 1,500 characters', () => {
    const p = clipProject({
      said: [
        { t: 1, text: 'We open the damn billing page.' },
        { t: 30, text: 'Then we export the report.' }
      ],
      duration: 60,
      bleeps: [{ id: 'b', start: 1 + 3 * 0.35 - 0.05, end: 1 + 3 * 0.35 + 0.33, word: 'damn', sound: 'tone' }]
    })
    const request = run.namesRequestForMoments(p, [moment(0, 20, 'A'), moment(20, 50, 'B'), moment(50, 60, 'C')])
    expect(request.kind).toBe('clip')
    expect(request.language).toBe('en')
    expect(request.items.map((i) => i.id)).toEqual(['0', '1'])
    expect(request.items[0].text).not.toContain('damn')
    expect(request.items[1].text).toBe('Then we export the report.')
    const long = clipProject({ said: Array.from({ length: 60 }, (_, i) => ({ t: 1 + i * 5, text: 'Billing reports list every invoice for each customer account today.' })), duration: 310 })
    const one = run.namesRequestForMoments(long, [moment(0, 310, 'All')])
    expect(one.items[0].text.length).toBe(1500)
  })

  it('keeps names of 1 to 80 characters with nothing private-like; others keep their offline title', () => {
    const list = [moment(0, 20, 'Offline one'), moment(20, 40, 'Offline two'), moment(40, 60, 'Offline three'), moment(60, 80, 'Offline four')]
    const named = run.withAiTitles(list, [
      { id: '0', name: '  Set up billing  ' },
      { id: '1', name: 'See https://example.com/x' },
      { id: '2', name: 'x'.repeat(81) },
      { id: '3', name: 'Open C:\\Users\\sam\\report.pdf' },
      { id: '9', name: 'Nobody' }
    ])
    expect(named.map((m) => m.title)).toEqual(['Set up billing', 'Offline two', 'Offline three', 'Offline four'])
  })
})
