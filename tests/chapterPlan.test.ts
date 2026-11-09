/**
 * Choosing chapters (docs/design/smart-tools.md §7.1, §7.4; §22.1 tests 37, 38, 47, 48, 116 and
 * 117): the exact search against a brute force, the plans' outcomes, silent recordings, the user's
 * chapter standing in for 0:00, a one-topic narration, and the time it takes.
 */
import { describe, expect, it } from 'vitest'
import { chapterNames } from '../src/shared/chapters/names'
import { chapterLimits, chooseBoundaries, planChapters, type ChapterPlanInput } from '../src/shared/chapters/plan'
import { CHAPTER_RULES, type Candidate } from '../src/shared/chapters/signals'
import type { Chapter, Project } from '../src/shared/types'
import { chapterProject, endOf, oneTopic, scanOf, seeded, trackOf, type Said } from './chapterFixtures'

const ALL = { screen: true, pauses: true, words: true }
const plan = (project: Project, extra: Partial<ChapterPlanInput> = {}) => planChapters({ project, track: null, scan: null, speech: null, density: 'normal', use: ALL, ...extra })
const user = (t: number, title = `Mine ${t}`): Chapter => ({ id: `u${t}`, t, title })

/* ---------- test 37: chooseBoundaries ---------- */

const required = (c: Candidate): boolean => !!c.fixed || c.from[0] === 'start'

/** Every subset that keeps the rules, the best by (total, fewer, smaller largest chapter): the reference. */
function brute(cands: readonly Candidate[], L: number, m: number, n: number, cost: number): { total: number; count: number; widest: number } {
  const sorted = [...cands].sort((a, b) => a.v - b.v)
  const req = sorted.filter(required)
  const opt = sorted.filter((c) => !required(c))
  const cap = Math.max(n, req.length, 1)
  let best = { total: -Infinity, count: Infinity, widest: Infinity }
  for (let mask = 0; mask < 1 << opt.length; mask++) {
    const set = [...req, ...opt.filter((_, i) => mask & (1 << i))].sort((a, b) => a.v - b.v)
    if (set.length > cap) continue
    let ok = true
    let widest = 0
    for (let i = 1; i < set.length; i++) {
      const gap = set[i].v - set[i - 1].v
      if (gap < m - 1e-9 && !(required(set[i]) && required(set[i - 1]))) ok = false
      widest = Math.max(widest, gap)
    }
    const last = set[set.length - 1]
    if (!required(last) && L - last.v < m - 1e-9) ok = false
    if (!ok) continue
    widest = Math.max(widest, L - last.v)
    const total = set.filter((c) => !required(c)).reduce((a, c) => a + c.score - cost, 0)
    const better = total > best.total + 1e-9 || (total > best.total - 1e-9 && (set.length < best.count || (set.length === best.count && widest < best.widest - 1e-9)))
    if (better) best = { total, count: set.length, widest }
  }
  return best
}

function measure(chosen: readonly Candidate[], L: number, cost: number): { total: number; count: number; widest: number } {
  let widest = 0
  for (let i = 1; i < chosen.length; i++) widest = Math.max(widest, chosen[i].v - chosen[i - 1].v)
  widest = Math.max(widest, L - chosen[chosen.length - 1].v)
  return { total: chosen.filter((c) => !required(c)).reduce((a, c) => a + c.score - cost, 0), count: chosen.length, widest }
}

describe('chooseBoundaries (test 37)', () => {
  it('equals a brute-force search on 200 random small inputs', () => {
    const rand = seeded(37)
    for (let run = 0; run < 200; run++) {
      const L = 60 + Math.floor(rand() * 240)
      const m = 10 + Math.floor(rand() * 30)
      const n = 3 + Math.floor(rand() * 4)
      const cost = [2, 3, 3.5][Math.floor(rand() * 3)]
      const cands: Candidate[] = [{ t: 0, v: 0, score: 0, from: ['start'] }]
      const k = Math.floor(rand() * 9)
      for (let i = 0; i < k; i++) {
        const v = 1 + Math.floor(rand() * (L - 2) * 4) / 4
        cands.push({ t: v, v, score: Math.floor(rand() * 24) / 4, from: ['page'] })
      }
      for (let i = 0; i < Math.floor(rand() * 3); i++) {
        const v = 10 + Math.floor(rand() * (L - 10))
        cands.push({ t: v, v, score: 0, from: [], fixed: true })
      }
      const chosen = chooseBoundaries(cands, L, m, n, cost)
      const got = measure(chosen, L, cost)
      const want = brute(cands, L, m, n, cost)
      expect(got.total, `run ${run}`).toBeCloseTo(want.total, 9)
      expect(got.count, `run ${run}`).toBe(want.count)
      expect(got.widest, `run ${run}`).toBeCloseTo(want.widest, 9)
      // The rules, read off the answer.
      expect(chosen[0].v).toBe(0)
      for (const c of cands.filter((x) => x.fixed)) expect(chosen).toContain(c)
      for (const c of chosen.filter((x) => !required(x))) expect(c.score - cost).toBeGreaterThan(0)
      expect(chosen.length).toBeLessThanOrEqual(Math.max(n, cands.filter(required).length))
      for (let i = 1; i < chosen.length; i++) if (!(required(chosen[i]) && required(chosen[i - 1]))) expect(chosen[i].v - chosen[i - 1].v).toBeGreaterThanOrEqual(m - 1e-9)
    }
  })

  it('the first start at 0, each chapter at least m, at most N, only candidates above the cost', () => {
    const start: Candidate = { t: 0, v: 0, score: 0, from: ['start'] }
    const pages = [20, 40, 60, 80, 100, 120, 140].map((v) => ({ t: v, v, score: 3.5, from: ['page' as const] }))
    const weak = { t: 50, v: 50, score: 3, from: ['section' as const, 'pause' as const] }
    const chosen = chooseBoundaries([start, ...pages, weak], 160, 30, 4, 3)
    expect(chosen[0]).toBe(start)
    expect(chosen.length).toBeLessThanOrEqual(4)
    expect(chosen).not.toContain(weak)
    for (let i = 1; i < chosen.length; i++) expect(chosen[i].v - chosen[i - 1].v).toBeGreaterThanOrEqual(30)
    expect(160 - chosen[chosen.length - 1].v).toBeGreaterThanOrEqual(30)
  })

  it('fixed starts are kept even closer than m to each other', () => {
    const start: Candidate = { t: 0, v: 0, score: 0, from: ['start'] }
    const a: Candidate = { t: 40, v: 40, score: 0, from: [], fixed: true }
    const b: Candidate = { t: 45, v: 45, score: 0, from: [], fixed: true }
    const page: Candidate = { t: 60, v: 60, score: 9, from: ['page'] }
    // The page change is too near the second fixed start (m = 30): left out; both fixed kept.
    expect(chooseBoundaries([start, a, b, page], 200, 30, 6, 3)).toEqual([start, a, b])
  })

  it('ties go to fewer chapters, then to the more even lengths', () => {
    const start: Candidate = { t: 0, v: 0, score: 0, from: ['start'] }
    const one: Candidate = { t: 50, v: 50, score: 4, from: ['page'] }
    const two = [30, 70].map((v): Candidate => ({ t: v, v, score: 3.5, from: ['page'] }))
    // 30 and 70 together score as much as 50 alone (each too near 50 with m = 25).
    expect(chooseBoundaries([start, one, ...two], 100, 25, 5, 3)).toEqual([start, one])
    const at40: Candidate = { t: 40, v: 40, score: 4, from: ['page'] }
    const at45: Candidate = { t: 45, v: 45, score: 4, from: ['page'] }
    expect(chooseBoundaries([start, at40, at45], 90, 10, 5, 3)).toEqual([start, at45])
  })
})

/* ---------- test 38: plans ---------- */

describe('plans (test 38)', () => {
  it('29 s gives too-short', () => {
    const scan = scanOf(29, { 15: 60 })
    expect(plan(chapterProject({ duration: 29 }), { scan })).toEqual({ ok: false, reason: 'too-short' })
    expect(CHAPTER_RULES.minVideo).toBe(30)
  })

  it('no candidate above the cost gives nothing', () => {
    // A screen change (1.5) alone is not enough at Normal.
    expect(plan(chapterProject({ duration: 120 }), { scan: scanOf(120, { 40: 15 }) })).toEqual({ ok: false, reason: 'nothing' })
    expect(plan(chapterProject({ duration: 120 }))).toEqual({ ok: false, reason: 'nothing' })
  })

  it('user chapters every 40 s give already', () => {
    const chapters = Array.from({ length: 15 }, (_, i) => user(i * 40))
    const at: Record<number, number> = {}
    for (let t = 20; t < 600; t += 40) at[t] = 60
    expect(plan(chapterProject({ duration: 600, chapters }), { scan: scanOf(600, at) })).toEqual({ ok: false, reason: 'already' })
  })

  it('a 2-chapter result is applied with youtube false; three with youtube true', () => {
    const two = plan(chapterProject({ duration: 60 }), { scan: scanOf(60, { 30: 60 }) })
    expect(two).toEqual({ ok: true, starts: [{ t: 0, from: ['start'] }, { t: 30, from: ['page'] }], youtube: false })
    const three = plan(chapterProject({ duration: 120 }), { scan: scanOf(120, { 40: 60, 80: 70 }) })
    expect(three).toEqual({ ok: true, starts: [{ t: 0, from: ['start'] }, { t: 40, from: ['page'] }, { t: 80, from: ['page'] }], youtube: true })
  })

  it('judges in video time: a candidate inside a cut is dropped, and a cut shortens the video', () => {
    const p = chapterProject({ duration: 120 })
    const clips = [
      { id: 'a', start: 0, end: 50, speed: 1 },
      { id: 'b', start: 70, end: 120, speed: 1 }
    ]
    const out = plan({ ...p, clips }, { scan: scanOf(120, { 30: 60, 60: 60, 90: 60 }) })
    expect(out.ok && out.starts.map((s) => s.t)).toEqual([0, 30, 90])
    // The video is 100 s long: N = 3, m = 10.
    expect(chapterLimits(100, 'normal')).toEqual({ n: 3, m: 10, cost: 3 })
  })

  it('N and m by density (§7.1)', () => {
    expect(chapterLimits(120, 'normal')).toMatchObject({ n: 3, m: 10 })
    expect(chapterLimits(600, 'normal').n).toBe(7)
    expect(chapterLimits(600, 'normal').m).toBeCloseTo(36, 9)
    expect(chapterLimits(3600, 'normal').n).toBe(12)
    expect(chapterLimits(3600, 'normal').m).toBeCloseTo(216, 9)
    expect(chapterLimits(600, 'fewer')).toMatchObject({ n: 4, cost: 3.5 })
    expect(chapterLimits(600, 'more')).toMatchObject({ n: 10, cost: 2 })
  })
})

/* ---------- test 47: silent recordings ---------- */

describe('silent recordings (test 47)', () => {
  it('page changes alone give chapters, named "Intro", "Part 2" and "Part 3"', () => {
    const project = chapterProject({ duration: 120 })
    const out = plan(project, { scan: scanOf(120, { 40: 62, 80: 73 }) })
    expect(out.ok && out.starts.map((s) => s.t)).toEqual([0, 40, 80])
    expect(out.ok && chapterNames(project, out.starts)).toEqual([
      { title: 'Intro', name: 'number' },
      { title: 'Part 2', name: 'number' },
      { title: 'Part 3', name: 'number' }
    ])
  })

  it('screen changes with idle gaps alone give none at Normal and some at More', () => {
    // Screen changes of 15% at 40 s and 80 s, each right after 5 s without input.
    const scan = scanOf(120, { 40: 15, 80: 15 })
    const busy: number[] = []
    for (let t = 1; t < 120; t += 1) if (!(t > 35 && t < 40) && !(t > 75 && t < 80)) busy.push(t)
    const track = trackOf([...busy, 40.05, 80.05].sort((a, b) => a - b))
    expect(plan(chapterProject({ duration: 120 }), { scan, track })).toEqual({ ok: false, reason: 'nothing' })
    const more = plan(chapterProject({ duration: 120 }), { scan, track, density: 'more' })
    expect(more.ok && more.starts.map((s) => [Math.round(s.t), s.from])).toEqual([
      [0, ['start']],
      [40, ['screen', 'idle']],
      [80, ['screen', 'idle']]
    ])
  })

  it('Split at turns kinds off; title cards always count', () => {
    const scan = scanOf(120, { 40: 62, 80: 73 })
    expect(plan(chapterProject({ duration: 120 }), { scan, use: { screen: false, pauses: true, words: true } })).toEqual({ ok: false, reason: 'nothing' })
    const titles = [{ id: 'c1', start: 60, end: 63, title: 'Billing', style: 'centered' as const, background: 'blur' as const }]
    const out = plan(chapterProject({ duration: 120, titles }), { scan, use: { screen: false, pauses: false, words: false } })
    expect(out.ok && out.starts.map((s) => [s.t, s.from])).toEqual([
      [0, ['start']],
      [60, ['card']]
    ])
  })
})

/* ---------- test 116: the user's chapter standing in for 0:00 ---------- */

describe('the first start (test 116)', () => {
  const scan = scanOf(600, { 180: 62, 360: 70 })

  it('a user chapter at 0:03 stands in for the 0:00 start: no found chapter before it, youtube false', () => {
    const out = plan(chapterProject({ duration: 600, chapters: [user(3)] }), { scan })
    expect(out).toEqual({ ok: true, starts: [{ t: 180, from: ['page'] }, { t: 360, from: ['page'] }], youtube: false })
  })

  it('one at 0:00 gives youtube true', () => {
    const out = plan(chapterProject({ duration: 600, chapters: [user(0)] }), { scan })
    expect(out).toEqual({ ok: true, starts: [{ t: 180, from: ['page'] }, { t: 360, from: ['page'] }], youtube: true })
  })

  it('one at 0:25 in a 10-minute video does not stand in: 0:00 is a start', () => {
    const out = plan(chapterProject({ duration: 600, chapters: [user(25)] }), { scan })
    expect(out).toEqual({ ok: true, starts: [{ t: 0, from: ['start'] }, { t: 180, from: ['page'] }, { t: 360, from: ['page'] }], youtube: true })
  })

  it('a candidate within 2 s of 0:00 merges into it and lends it its signals', () => {
    const titles = [{ id: 'c1', start: 1, end: 4, title: 'Welcome', style: 'big' as const, background: 'blur' as const }]
    const out = plan(chapterProject({ duration: 600, titles }), { scan })
    expect(out.ok && out.starts[0]).toEqual({ t: 0, from: ['start', 'card'] })
  })
})

/* ---------- test 117: one topic ---------- */

describe('one topic (test 117)', () => {
  it('a one-topic narration with cue words after pauses and no screen change gives nothing at Normal', () => {
    const { said, duration } = oneTopic()
    expect(said.filter((s) => /^(Now|So|Let's) /.test(s.text))).toHaveLength(19)
    expect(plan(chapterProject({ duration, said }))).toEqual({ ok: false, reason: 'nothing' })
  })

  it('one page change and a "moving on" sentence give exactly one split there', () => {
    const { said, duration } = oneTopic()
    const i = 30
    const changed: Said[] = said.map((s, k) => (k === i ? { t: s.t, text: 'Moving on, the invoices of the account.' } : s))
    // The sentences after it keep their times (the new one is no longer).
    expect(endOf(changed[i].t, changed[i].text)).toBeLessThan(changed[i + 1].t)
    const at = changed[i].t
    const out = plan(chapterProject({ duration, said: changed }), { scan: scanOf(duration, { [Math.round(at * 4) / 4 - 0.5]: 62 }) })
    expect(out.ok && out.starts.map((s) => s.t)).toEqual([0, at])
    expect(out.ok && out.starts[1].from).toEqual(['page', 'section', 'pause'])
  })
})

/* ---------- test 48: performance ---------- */

describe('performance (test 48)', () => {
  const slack = process.env.CI ? 6 : 1

  it('plans a 1-hour recording (600 sentences, 14,400 samples) in under 200 ms, the search in under 50 ms', () => {
    const rand = seeded(48)
    const said: Said[] = []
    const vocab = ['invoice', 'billing', 'export', 'settings', 'report', 'account', 'team', 'seats', 'plan', 'page', 'menu', 'button', 'file', 'chart', 'filter']
    for (let i = 0; i < 600; i++) {
      const words = Array.from({ length: 10 }, (_, k) => (k % 3 === 1 ? 'the' : vocab[Math.floor(rand() * vocab.length)]))
      if (i % 7 === 0) words[0] = 'Now'
      said.push({ t: i * 6 + 0.5, text: `${words.join(' ')}.` })
    }
    const at: Record<number, number> = {}
    for (let k = 0; k < 14_400; k++) if (rand() < 0.02) at[(k + 1) * 0.25] = 10 + Math.floor(rand() * 70)
    const scan = scanOf(3600, at)
    expect(scan.t).toHaveLength(14_400)
    const busy: number[] = []
    for (let t = 0.5; t < 3600; t += 0.5 + rand() * 6) busy.push(t)
    const project = chapterProject({ duration: 3600, said })
    plan(project, { scan, track: trackOf(busy) })
    const t0 = performance.now()
    const out = plan(project, { scan, track: trackOf(busy) })
    const planMs = performance.now() - t0
    expect(out.ok).toBe(true)
    expect(planMs).toBeLessThan(200 * slack)

    // The search alone: 400 candidates, N = 12.
    const cands: Candidate[] = [{ t: 0, v: 0, score: 0, from: ['start'] }]
    for (let i = 0; i < 400; i++) {
      const v = 2 + rand() * 3590
      cands.push({ t: v, v, score: 3 + rand() * 3, from: ['page'] })
    }
    chooseBoundaries(cands, 3600, 216, 12, 3)
    const t1 = performance.now()
    const chosen = chooseBoundaries(cands, 3600, 216, 12, 3)
    expect(performance.now() - t1).toBeLessThan(50 * slack)
    expect(chosen.length).toBeLessThanOrEqual(12)
  })
})
