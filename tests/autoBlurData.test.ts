import { describe, expect, it } from 'vitest'
import { bleepKey, DEFAULT_CLEANUP, tidyCaptions } from '../src/shared/captions/cleanup'
import { spokenSegments } from '../src/shared/captions/subtitles'
import { readBleeps } from '../src/shared/captions/studioData'
import { cropProject, rectToCrop } from '../src/shared/engine/crop'
import { migrateProject } from '../src/shared/engine/project'
import { readShape } from '../src/shared/engine/shapeData'
import {
  LEGACY_PREFIX,
  MAX_COVERS,
  MAX_KEYS,
  MAX_LEGACY_SHAPES,
  hidesSomething,
  isPrivateBleep,
  legacyPieces,
  mergeCovers,
  privateBleepWord,
  privateGroupOf,
  privateItems,
  privateKindOf,
  readCovers,
  readPrivacy,
  readPrivacyPrefs,
  thumbCovers,
  thumbTime,
  widenShort,
  withLegacyShapes
} from '../src/shared/privacy/coverData'
import { MAX_KEYS_PER_COVER, boxAt, coverSlack, drawnBox, parsePath, pathKeys, simplifyKeys, stepKeys, writePath, type CoverKey, type Placement } from '../src/shared/privacy/coverPath'
import { containsOver, coverIndex, coversAt } from '../src/shared/privacy/covers'
import { COVER_DARK } from '../src/shared/privacy/kinds'
import type { Bleep, Cover, NormRect, Project } from '../src/shared/types'
import { base, coverOf, inside, key, oldFixtures, rng, seededCovers, words } from './autoBlurFixtures'

/*
 * The contracts' data rules of auto-blur (docs/design/auto-blur.md §4, §17.1 tests 1-7, 10-13, 186-190
 * and 193-195): migration, the readers on hostile input, paths and their union keys, private bleeps,
 * the legacy shapes, the crop view, the cover index, containment, merging and the count of private
 * items. Each numbered test is its own test and fails without the code of its rule.
 */

/** On a shared machine timings are noisy: CI multiplies the budgets by 6 (§13.1). */
const SLOW = process.env.CI ? 6 : 1

/**
 * The processor time `fn` takes in this process, in ms: the work itself, which another test file
 * running beside this one on the shared machine does not stretch as it stretches the wall clock.
 */
function cpuMs(fn: () => void): number {
  const t0 = process.cpuUsage()
  fn()
  const d = process.cpuUsage(t0)
  return (d.user + d.system) / 1000
}

/** The fastest of `n` runs of `fn`, in ms of processor time. */
function fastest(n: number, fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < n; i++) best = Math.min(best, cpuMs(fn))
  return best
}

/** The fastest times of `small` and `large`, run in turn after a warm-up, so the machine's noise touches both alike. */
function paired(runs: number, small: () => void, large: () => void): [number, number] {
  small()
  large()
  let a = Infinity
  let b = Infinity
  for (let i = 0; i < runs; i++) {
    a = Math.min(a, cpuMs(small))
    b = Math.min(b, cpuMs(large))
  }
  return [a, b]
}

/**
 * paired() in up to `rounds` rounds, stopping at the first whose times keep `large` within `ratio`
 * times `small` plus `slack` ms: a test file running beside this one shares the processor's caches
 * for a while, which stretches the larger input's work more than the smaller's. The best round's
 * times (by their ratio) come back; the bound itself is the test's.
 */
function scaling(rounds: number, runs: number, small: () => void, large: () => void, ratio: number, slack: number): [number, number] {
  let best: [number, number] = [Infinity, Infinity]
  for (let r = 0; r < rounds; r++) {
    const [a, b] = paired(runs, small, large)
    if (b - ratio * a < best[1] - ratio * best[0] || !Number.isFinite(best[0])) best = [a, b]
    if (b <= ratio * a + slack) break
  }
  return best
}

/** Every input box at every input key (from the cover's start on) is inside the drawn box of some output cover. */
function everyBoxKept(input: readonly Cover[], output: readonly Cover[], slack = 0.001): boolean {
  const index = coverIndex(output)
  for (const c of input) {
    for (const k of pathKeys(c)) {
      if (k.t >= c.end) continue
      const t = Math.max(k.t, c.start)
      const box = boxAt(c, t)!
      if (!coversAt(index, t, slack).some((o) => inside(box, drawnBox(o, t, slack)))) return false
    }
  }
  return true
}

describe('auto-blur contracts: data', () => {
  it('1. Migration: every old fixture migrates to the same keys and bytes, without covers or privacy; ~cover: shapes are dropped on load; reading again changes nothing', () => {
    for (const f of oldFixtures()) {
      const once = migrateProject(structuredClone(f.raw))
      expect(once, f.name).not.toHaveProperty('covers')
      expect(once, f.name).not.toHaveProperty('privacy')
      const twice = migrateProject(JSON.parse(JSON.stringify(once)))
      if (Array.isArray(f.raw.clips)) expect(twice, f.name).toEqual(once)
      // The same file with the legacy shapes an older Flown kept: they are dropped, the rest read as before.
      const raw = structuredClone(f.raw) as Record<string, unknown>
      const legacy = [
        { id: `${LEGACY_PREFIX}c1:0:p`, kind: 'pixelate', start: 0, end: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#1c1c22', strokeWidth: 0, fill: true, opacity: 1, strength: 1 },
        { id: `${LEGACY_PREFIX}c1:0:r`, kind: 'rect', start: 0, end: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#1c1c22', strokeWidth: 0, fill: true, opacity: 1, strength: 1 }
      ]
      raw.shapes = [...(Array.isArray(raw.shapes) ? raw.shapes : []), ...legacy]
      const withLegacy = migrateProject(raw)
      expect(withLegacy.shapes, f.name).toEqual(once.shapes)
      expect({ ...withLegacy, clips: once.clips }, f.name).toEqual(once)
    }
  })

  it('2. readCovers on hostile input: limits held, nothing thrown, unknown fields dropped; 4,001 keys become one union key; 2,001 covers become 2,000 keeping every box; 2,000 × 150 keys fit 200,000 keys', () => {
    const good = { id: 'a', start: 1, end: 3, path: '1 0.1 0.1 0.2 0.1', color: '#123456' }
    const hostile: unknown[] = [
      null,
      7,
      'x',
      [],
      { ...good, id: undefined },
      { ...good, id: 5 },
      { ...good, start: 3, end: 3 },
      { ...good, start: Number.NaN },
      { ...good, path: '1e0 0.1 0.1 0.2 0.1' },
      { ...good, path: '1 0.1 0.1 0.2 0.1;1 0.1 0.1 0.2 0.1' },
      { ...good, path: '2 0.1 0.1 0.2 0.1;1 0.2 0.2 0.2 0.1' },
      { ...good, path: 'NaN 0 0 0 0' },
      { ...good, path: '' },
      { ...good, path: '1 0.1 0.1 0.2' },
      good,
      { ...good, color: 'red' }
    ]
    let read: Cover[] | undefined
    expect(() => (read = readCovers(hostile, 10))).not.toThrow()
    // Only `good` (once: its id repeats) is read.
    expect(read).toEqual([{ id: 'a', start: 1, end: 3, path: '1 0.1 0.1 0.2 0.1', color: '#123456' }])
    // Boxes past the frame are clamped; an unreadable colour is Dark; unknown and invalid fields dropped; valid ones kept.
    const [c] = readCovers([{ id: 'b', start: -2, end: 50, path: '0 -0.5 0.9 3 0.5', color: '#ABCDEF', found: 'maybe', kind: 'secret', group: 'a b', lost: 1, extra: 1, __proto__: { x: 1 } }], 10)!
    expect(c).toEqual({ id: 'b', start: 0, end: 10, path: '0 0 0.9 1 0.1', color: COVER_DARK })
    const [d] = readCovers([{ id: 'd', start: 1, end: 2, path: '1 0.1 0.1 0.2 0.1', color: '#abcdef', found: 'check', kind: 'email', group: 'g-1', lost: true, thin: true, missed: true }], 10)!
    expect(d).toEqual({ id: 'd', start: 1, end: 2, path: '1 0.1 0.1 0.2 0.1', color: '#abcdef', found: 'check', kind: 'email', group: 'g-1', lost: true, thin: true, missed: true })
    // 4,001 keys: one key holding their union.
    const many: CoverKey[] = Array.from({ length: MAX_KEYS_PER_COVER + 1 }, (_v, i) => key(i * 0.01, 0.1 + (i % 7) * 0.01, 0.2, 0.05, 0.05))
    const [u] = readCovers([{ id: 'u', start: 0, end: 50, path: writePath(many) }], 60)!
    expect(pathKeys(u)).toHaveLength(1)
    for (const k of many) expect(inside(k, pathKeys(u)[0])).toBe(true)
    // 2,001 covers: 2,000, every input box at every input key inside an output's drawn box (finding 20).
    const input = seededCovers(201, MAX_COVERS + 1, 3, 600)
    const out = readCovers(JSON.parse(JSON.stringify(input)), 600)!
    expect(out).toHaveLength(MAX_COVERS)
    expect(everyBoxKept(input, out)).toBe(true)
    // 2,000 covers of 150 keys: at most 200,000 keys, every box kept, no cover cut to one key while a longer one keeps more.
    const long = seededCovers(202, MAX_COVERS, 150, 600)
    const cut = readCovers(JSON.parse(JSON.stringify(long)), 600)!
    const counts = cut.map((x) => pathKeys(x).length)
    expect(counts.reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(MAX_KEYS)
    // Keys whose times round to the same millisecond are one key when written: the counts before the limit.
    const folded = long.map((x) => parsePath(writePath(pathKeys(x)))!.length)
    const most = Math.max(...counts)
    cut.forEach((_x, i) => {
      // A cover that was cut keeps at least half of the most any cover keeps: the longest were cut first.
      if (counts[i] < folded[i]) expect(counts[i]).toBeGreaterThanOrEqual(Math.floor(most / 2))
    })
    expect(counts.some((n, i) => n === 1 && folded[i] > 1)).toBe(false)
    expect(everyBoxKept(long, cut)).toBe(true)
  })

  it('3. readCovers is linear: 2,000 covers with 100 keys each read in under 150 ms, and twice the covers take at most 2.2 times as long', () => {
    const two = JSON.parse(JSON.stringify(seededCovers(301, MAX_COVERS, 100, 3600)))
    const one = two.slice(0, MAX_COVERS / 2)
    const [tOne, tTwo] = scaling(5, 11, () => readCovers(one, 3600), () => readCovers(two, 3600), 2.2, 2)
    expect(tTwo).toBeLessThan(150 * SLOW)
    expect(tTwo).toBeLessThanOrEqual(2.2 * tOne + 2)
  })

  it('4. Paths: writePath rounds outward; parsePath refuses exponents, NaN, Infinity, decreasing times and empty keys; boxAt holds a box until the next key; drawnBox at a key with slack is the union of both boxes; coverSlack(60) is 0.009333…', () => {
    const r = rng(401)
    for (let i = 0; i < 10000; i++) {
      const x = r() * 0.9
      const y = r() * 0.9
      const w = r() * (1 - x)
      const h = r() * (1 - y)
      const t = r() * 1000
      const [k] = parsePath(writePath([key(t, x, y, w, h)]))!
      expect(k.x <= x && k.y <= y && k.x + k.w >= x + w - 1e-12 && k.y + k.h >= y + h - 1e-12 && k.t <= t).toBe(true)
    }
    // Writing what was read changes nothing.
    const once = writePath([key(0.0166, 0.1001, 0.2, 0.30000000000000004, 0.1), key(1.5, 0.3, 0.3, 0.1, 0.1)])
    expect(writePath(parsePath(once)!)).toBe(once)
    for (const bad of ['1e3 0 0 0.1 0.1', 'NaN 0 0 0.1 0.1', 'Infinity 0 0 0.1 0.1', '0 0 0 0.1 0.1;0 0 0 0.1 0.1', '1 0 0 0.1 0.1;0.5 0 0 0.1 0.1', '0 0 0 0.1 0.1;', ';0 0 0 0.1 0.1', '0 0 0 0.1', '+1 0 0 0.1 0.1', '.5 0 0 0.1 0.1', '0  0 0 0.1 0.1', ''])
      expect(parsePath(bad), bad).toBeNull()
    const c = coverOf('p', 1, 5, [key(1, 0.1, 0.1, 0.1, 0.1), key(3, 0.5, 0.5, 0.1, 0.1)])
    expect(boxAt(c, 0.99)).toBeNull()
    expect(boxAt(c, 1)).toEqual({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 })
    expect(boxAt(c, 2.999)).toEqual({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 })
    expect(boxAt(c, 3)).toEqual({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 })
    expect(boxAt(c, 5)).toBeNull()
    const u = drawnBox(c, 3, coverSlack(60))!
    expect(u.x).toBeCloseTo(0.1, 12)
    expect(u.x + u.w).toBeCloseTo(0.6, 12)
    expect(drawnBox(c, 3.02, coverSlack(60))).toEqual({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 })
    expect(drawnBox(c, 5.009, coverSlack(60))).toEqual({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 })
    expect(drawnBox(c, 5.011, coverSlack(60))).toBeNull()
    expect(coverSlack(60)).toBeCloseTo(0.009333333333, 9)
  })

  it('5. readPrivacy and readPrivacyPrefs: 6 regions keep 5; lower-case or three-letter regions dropped; 201 names keep 200; an 81-character name dropped; names NFC and one line; __proto__ and constructor ignored; 5,001 rejected places keep 5,000', () => {
    const names = Array.from({ length: 201 }, (_v, i) => `Name ${i}`)
    const raw = JSON.parse(
      JSON.stringify({
        kinds: ['email', 'bogus', 'card'],
        regions: ['BD', 'GB', 'us', 'USA', 'IN', 'ES', 'FR', 'DE'],
        names: [...names.slice(0, 3), 'x'.repeat(81), 'Line\nbreak', 'Café', ...names.slice(3)],
        neverHide: ['Flown'],
        listen: false,
        rejected: Array.from({ length: 5001 }, (_v, i) => ({ kind: 'email', start: 1, end: 2, path: `1 0.${i % 9} 0.1 0.1 0.1` })),
        find: { at: '2026-11-20T10:00:00.000Z', kinds: ['email'], listened: true, failed: 2, readTo: 50, thin: '1 2;3 4', saidIds: ['b1'], junk: 1 }
      })
    )
    raw.__proto__evil = 1
    Object.defineProperty(raw, '__proto__', { value: { polluted: true }, enumerable: true })
    raw.constructor = 'x'
    const p = readPrivacy(raw, 60)!
    expect(Object.keys(p).sort()).toEqual(['find', 'kinds', 'listen', 'names', 'neverHide', 'regions', 'rejected'])
    expect(p.kinds).toEqual(['email', 'card'])
    expect(p.regions).toEqual(['BD', 'GB', 'IN', 'ES', 'FR'])
    expect(p.names).toHaveLength(200)
    expect(p.names).not.toContain('x'.repeat(81))
    expect(p.names).not.toContain('Line\nbreak')
    expect(p.names).toContain('Café')
    expect(p.rejected).toHaveLength(5000)
    expect(p.find).toEqual({ at: '2026-11-20T10:00:00.000Z', kinds: ['email'], listened: true, failed: 2, readTo: 50, thin: '1 2;3 4', saidIds: ['b1'] })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // Idempotent.
    expect(readPrivacy(JSON.parse(JSON.stringify(p)), 60)).toEqual(p)
    const prefs = readPrivacyPrefs({ ...raw, colour: 'ring', showCovers: false, other: 1 })!
    expect(prefs.regions).toEqual(['BD', 'GB', 'IN', 'ES', 'FR'])
    expect(prefs.names).toHaveLength(200)
    expect(prefs).toMatchObject({ colour: 'ring', showCovers: false })
    expect(prefs).not.toHaveProperty('other')
    expect(prefs).not.toHaveProperty('rejected')
    expect(readPrivacyPrefs({ showCovers: true, colour: 'pink' })).toEqual({})
    expect(readPrivacyPrefs('x')).toBeNull()
    expect(readPrivacyPrefs(JSON.parse(JSON.stringify(prefs)))).toEqual(prefs)
    expect(readPrivacy(undefined, 60)).toBeUndefined()
  })

  it("6. Private bleeps: privateBleepWord('card') is ':card'; isPrivateBleep is true for it and false for every fixture bleep; no bleepKey of 10,000 caption words in en, bn, es and hi starts with ':'; readBleeps keeps ':card' through a read and write", () => {
    expect(privateBleepWord('card', '')).toBe(':card')
    expect(isPrivateBleep({ word: ':card' })).toBe(true)
    for (const f of oldFixtures()) for (const b of migrateProject(structuredClone(f.raw)).bleeps ?? []) expect(isPrivateBleep(b), f.name).toBe(false)
    const alphabets = ['abcdefghijklmnopqrstuvwxyz0123456789', 'অআইঈউঊএঐওঔকখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়ৎংঃঁািীুূৃেৈোৌ্০১২৩৪৫৬৭৮৯', 'abcdefghijklmnñopqrstuvwxyzáéíóúü', 'अआइईउऊएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह़ािीुूृेैोौ्०१२३४५६७८९']
    const r = rng(601)
    for (let i = 0; i < 10000; i++) {
      const a = alphabets[i % 4]
      let w = ''
      const n = 1 + Math.floor(r() * 9)
      for (let k = 0; k < n; k++) w += a[Math.floor(r() * a.length)]
      // Punctuation a caption word may carry, a colon in front among them.
      const word = [':', '"', '(', ''][i % 4] + w + [':', '.', ',', '!'][Math.floor(r() * 4)]
      expect(bleepKey(word).startsWith(':')).toBe(false)
    }
    const read = readBleeps([{ id: 'p1', start: 1, end: 1.5, word: ':card', sound: 'tone', auto: true }], 10)!
    expect(read[0].word).toBe(':card')
    expect(readBleeps(JSON.parse(JSON.stringify(read)), 10)).toEqual(read)
  })

  it('7. Legacy shapes: no covers gives the same object; a 3-key path gives pixelate (strength 1) then filled opaque rectangle pieces read by readShape, overlapping by the slack; more than 4 pieces merge into 4; 2,500 covers give at most 4,000 shapes; migrateProject drops them all', () => {
    const p = base('legacy', 30)
    expect(withLegacyShapes(p)).toBe(p)
    expect(withLegacyShapes({ ...p, covers: [] })).toEqual({ ...p, covers: [] })
    const three = coverOf('c1', 1, 9, [key(1, 0.1, 0.1, 0.1, 0.05), key(4, 0.5, 0.5, 0.1, 0.05), key(6, 0.7, 0.1, 0.1, 0.05)], { color: '#334455' })
    const out = withLegacyShapes({ ...p, covers: [three] })
    const legacy = out.shapes!.filter((s) => s.id.startsWith(LEGACY_PREFIX))
    expect(legacy.length).toBe(6)
    for (let i = 0; i < legacy.length; i += 2) {
      expect(legacy[i]).toMatchObject({ kind: 'pixelate', strength: 1, opacity: 1 })
      expect(legacy[i + 1]).toMatchObject({ kind: 'rect', fill: true, opacity: 1, color: '#334455' })
      expect(readShape(legacy[i])).not.toBeNull()
      expect(readShape(legacy[i + 1])).not.toBeNull()
    }
    const slack = coverSlack(30)
    const pieces = legacyPieces(three, slack)
    expect(pieces).toHaveLength(3)
    for (let i = 0; i + 1 < pieces.length; i++) expect(pieces[i].end - pieces[i + 1].start).toBeCloseTo(2 * slack, 9)
    expect(pieces[0].start).toBeCloseTo(1 - slack, 9)
    expect(pieces[2].end).toBeCloseTo(9 + slack, 9)
    // Seven far-apart keys: four pieces, the last taking the rest.
    const seven = coverOf('c7', 0, 14, Array.from({ length: 7 }, (_v, i) => key(i * 2, (i % 2) * 0.6, (i % 3) * 0.3, 0.05, 0.05)))
    const four = legacyPieces(seven, slack)
    expect(four).toHaveLength(4)
    for (const k of pathKeys(seven)) expect(four.some((q) => inside(k, q.box) && q.start <= k.t && q.end > k.t)).toBe(true)
    // 2,500 covers: at most 4,000 shapes, every cover's boxes still under a legacy box.
    const crowd = seededCovers(701, 2500, 6, 1200)
    const shapes = withLegacyShapes({ ...p, duration: 1200, covers: crowd }).shapes!.filter((s) => s.id.startsWith(LEGACY_PREFIX))
    expect(shapes.length).toBeLessThanOrEqual(MAX_LEGACY_SHAPES)
    for (const c of crowd.slice(0, 200))
      for (const k of pathKeys(c)) {
        const t = Math.max(k.t, c.start)
        if (t >= c.end) continue
        expect(shapes.some((s) => s.kind === 'rect' && s.start <= t && s.end > t && inside(k, s))).toBe(true)
      }
    // migrateProject drops them all.
    const back = migrateProject(JSON.parse(JSON.stringify(out)))
    expect(back.shapes!.some((s) => s.id.startsWith(LEGACY_PREFIX))).toBe(false)
    expect(back.covers).toEqual([three])
  })

  it('10. Crop: cropProject maps every key through rectToCrop; the same covers array gives the same mapped array; without a crop the covers are unchanged; a cover wholly outside the crop is left out of the view only; project.covers is never changed', () => {
    const crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    const covers = [
      coverOf('in', 0, 5, [key(0, 0.2, 0.2, 0.1, 0.1), key(2, 0.3, 0.25, 0.1, 0.1)]),
      coverOf('out', 0, 5, [key(0, 0.8, 0.8, 0.1, 0.1)]),
      coverOf('edge', 0, 5, [key(0, 0.55, 0.15, 0.1, 0.1)])
    ]
    const before = JSON.stringify(covers)
    const p = { ...base('crop', 10), crop, covers }
    const view = cropProject(p)
    expect(view.covers!.map((c) => c.id)).toEqual(['in', 'edge'])
    view.covers!.forEach((v) => {
      const src = covers.find((c) => c.id === v.id)!
      pathKeys(src).forEach((k, i) => {
        const want = rectToCrop(crop, { x: k.x, y: k.y, w: k.w, h: k.h })
        const got = pathKeys(v)[i]
        expect(inside(want, got)).toBe(true)
        expect(got.w - want.w).toBeLessThan(0.001)
        expect(got.t).toBe(k.t)
      })
    })
    // The same list maps to the same array (a new project object around it too).
    expect(cropProject({ ...p, name: 'other' }).covers).toBe(view.covers)
    expect(JSON.stringify(covers)).toBe(before)
    expect(p.covers).toBe(covers)
    const plain = { ...base('plain', 10), covers }
    expect(cropProject(plain)).toBe(plain)
  })

  it('11. Cover index: coversAt equals a brute-force scan for 2,000 random covers at 10,000 times with slack, in under 0.02 ms a call', () => {
    const covers = seededCovers(1101, 2000, 2, 600)
    const index = coverIndex(covers)
    expect(coverIndex(covers)).toBe(index)
    const r = rng(1102)
    const slack = coverSlack(30)
    const times = Array.from({ length: 10000 }, () => r() * 610 - 5)
    for (const t of times) {
      const brute = covers.filter((c) => c.start <= t + slack && c.end > t - slack)
      expect(coversAt(index, t, slack)).toEqual(brute)
    }
    const ms = fastest(3, () => {
      for (const t of times) coversAt(index, t, slack)
    })
    expect(ms / times.length).toBeLessThan(0.02 * SLOW)
  })

  it('12. containsOver: a path inside an existing cover at every key is contained; one that leaves it at one key is not; overlap alone is not', () => {
    const slack = coverSlack(30)
    const outer = coverOf('o', 1, 9, [key(1, 0.1, 0.1, 0.4, 0.2), key(5, 0.3, 0.1, 0.4, 0.2)])
    const inner = coverOf('i', 2, 8, [key(2, 0.15, 0.12, 0.1, 0.05), key(4, 0.2, 0.12, 0.1, 0.05), key(6, 0.4, 0.12, 0.1, 0.05)])
    expect(containsOver(outer, inner, slack)).toBe(true)
    const leaves = coverOf('l', 2, 8, [key(2, 0.15, 0.12, 0.1, 0.05), key(4, 0.45, 0.12, 0.1, 0.05), key(6, 0.4, 0.12, 0.1, 0.05)])
    expect(containsOver(outer, leaves, slack)).toBe(false)
    const overlaps = coverOf('v', 2, 8, [key(2, 0.05, 0.05, 0.2, 0.1)])
    expect(containsOver(outer, overlaps, slack)).toBe(false)
    const longer = coverOf('t', 0, 8, [key(0, 0.15, 0.12, 0.1, 0.05)])
    expect(containsOver(outer, longer, slack)).toBe(false)
  })

  it('13. mergeCovers: 20,000 found items to 2,000 in under 300 ms, twice the items (to twice the limit) in at most 2.3 times as long; every input box at every input key is inside an output cover', () => {
    const items = seededCovers(1301, 20000, 2, 3600, { found: 'auto', kind: 'email' })
    const twice = seededCovers(1302, 40000, 2, 7200, { found: 'auto', kind: 'email' })
    let out: Cover[] = []
    // Twice the items to twice the limit: the same work per item, so a quadratic step shows as a ratio over 2.
    const [t1, t2] = scaling(5, 7, () => (out = mergeCovers(items, 2000)), () => mergeCovers(twice, 4000), 2.3, 5)
    expect(out).toHaveLength(2000)
    expect(t1).toBeLessThan(300 * SLOW)
    expect(t2).toBeLessThanOrEqual(2.3 * t1 + 5)
    expect(everyBoxKept(items, out)).toBe(true)
    // Its timed rounds and the check of every box take about 3.3 s alone on the build machine, so the
    // whole test runs past vitest's 5 s default when other tests share the processor; its own limits
    // above are what it checks.
  }, 60_000)

  it('186. Union keys at step 2: a 60 fps path placed on analysed frames moving 30 px a frame pair covers the planted box of every source frame through drawnBox; without the union keys the odd frames fail', () => {
    const fps = 60
    const W = 1920
    const planted = (f: number): NormRect => ({ x: (100 + f * 15) / W, y: 0.4, w: 200 / W, h: 0.03 })
    const placements: Placement[] = []
    for (let f = 0; f <= 120; f += 2) placements.push({ t: f / fps, box: planted(f) })
    const keys = stepKeys(placements, fps)
    const cover = coverOf('s', 0, 121 / fps, keys)
    const without = coverOf('n', 0, 121 / fps, placements.map((p) => ({ t: p.t, ...p.box })))
    const slack = coverSlack(fps)
    let oddMissed = 0
    for (let f = 0; f <= 120; f++) {
      expect(inside(planted(f), drawnBox(cover, f / fps, slack)), `frame ${f}`).toBe(true)
      if (!inside(planted(f), drawnBox(without, f / fps, slack))) {
        oddMissed++
        expect(f % 2).toBe(1)
      }
    }
    expect(oddMissed).toBeGreaterThan(50)
  })

  it('187. Union keys at step 4, starts and ends: at 120 fps every source frame is covered; text that appears on an unanalysed frame is covered from it, text that leaves on one is covered to it', () => {
    const fps = 120
    const planted = (f: number): NormRect => ({ x: 0.1 + f * 0.002, y: 0.5, w: 0.1, h: 0.02 })
    // The text shows from frame 6 (unanalysed) to frame 93 (unanalysed), the look pass reading every fourth frame.
    const first = 6
    const last = 93
    const placements: Placement[] = []
    // The walk's first key: the first source frame after the last frame proven without text (frame 4), the union with the box moved back.
    placements.push({ t: (4 + 1) / fps, box: { ...planted(first), x: planted(4).x, w: planted(first).x + planted(first).w - planted(4).x } })
    for (let f = 8; f <= 92; f += 4) placements.push({ t: f / fps, box: planted(f) })
    const keys = stepKeys(placements, fps)
    // It ends one analysed frame after the first frame without a match (frame 96), so 93 is covered.
    const cover = coverOf('s', (4 + 1) / fps - 0.0005, 100 / fps, keys)
    const slack = coverSlack(fps)
    for (let f = first; f <= last; f++) {
      const box = f <= 92 ? planted(Math.min(f, 92)) : planted(92)
      expect(inside(box, drawnBox(cover, f / fps, slack)), `frame ${f}`).toBe(true)
    }
  })

  it('188. simplifyKeys: 2,000 covers of 150 keys fit 200,000 keys; the longest paths are merged first; every input box at every input time is inside an output drawn box', () => {
    const covers = [...seededCovers(1881, 1990, 150, 600), ...seededCovers(1882, 10, 600, 600).map((c, i) => ({ ...c, id: `long${i}` }))]
    const out = simplifyKeys(covers, MAX_KEYS)
    const counts = out.map((c) => pathKeys(c).length)
    expect(counts.reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(MAX_KEYS)
    // The ten longest were halved first: none of them keeps more than the most of the others.
    const longest = Math.max(...counts.slice(0, 1990))
    for (const n of counts.slice(1990)) expect(n).toBeLessThanOrEqual(longest + 1)
    expect(Math.min(...counts)).toBeGreaterThan(1)
    expect(everyBoxKept(covers, out)).toBe(true)
    // Under the limit: the same covers.
    const few = seededCovers(1883, 5, 3, 60)
    expect(simplifyKeys(few, MAX_KEYS)).toEqual(few)
  })

  it('189. Short covers are widened, never dropped: a 16.7 ms cover and one clamped to 0.01 s at the end read as at least 0.02 s inside the recording and survive a write and a read', () => {
    const covers = readCovers(
      [
        { id: 'one', start: 3, end: 3.0167, path: '3 0.1 0.1 0.1 0.1' },
        { id: 'end', start: 9.99, end: 12, path: '9.99 0.1 0.1 0.1 0.1' }
      ],
      10
    )!
    expect(covers.map((c) => c.id)).toEqual(['one', 'end'])
    for (const c of covers) {
      expect(c.end - c.start).toBeGreaterThanOrEqual(0.02 - 1e-9)
      expect(c.start).toBeGreaterThanOrEqual(0)
      expect(c.end).toBeLessThanOrEqual(10)
    }
    expect(covers[1].end).toBe(10)
    expect(readCovers(JSON.parse(JSON.stringify(covers)), 10)).toEqual(covers)
    const w = widenShort({ id: 'x', start: 0, end: 0.005, path: '0 0 0 0.1 0.1', color: COVER_DARK }, 10)
    expect(w.start).toBe(0)
    expect(w.end).toBeGreaterThanOrEqual(0.02)
  })

  it('190. privateItems: a group of found covers, a user cover and a group of private bleeps are three items; ordinary bleeps are none; blur and pixelate shapes are weak only', () => {
    const covers = [
      coverOf('a', 1, 2, [key(1, 0.1, 0.1, 0.1, 0.1)], { found: 'check', kind: 'email', group: 'g1' }),
      coverOf('b', 5, 6, [key(5, 0.1, 0.1, 0.1, 0.1)], { found: 'auto', kind: 'email', group: 'g1' }),
      coverOf('mine', 3, 4, [key(3, 0.5, 0.5, 0.1, 0.1)])
    ]
    const bleeps: Bleep[] = [
      { id: 's1', start: 7, end: 7.5, word: privateBleepWord('card', 'k3v9q2m8xa'), sound: 'tone', auto: true },
      { id: 's2', start: 8, end: 8.5, word: privateBleepWord('card', 'k3v9q2m8xa'), sound: 'tone', auto: true },
      { id: 'o1', start: 9, end: 9.3, word: 'damn', sound: 'tone' }
    ]
    const shapes = [
      { id: 'h1', start: 0, end: 1, kind: 'blur' as const, x: 0, y: 0, w: 0.1, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.5 },
      { id: 'h2', start: 0, end: 1, kind: 'pixelate' as const, x: 0, y: 0, w: 0.1, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.5 },
      { id: 'h3', start: 0, end: 1, kind: 'rect' as const, x: 0, y: 0, w: 0.1, h: 0.1, color: '#000000', strokeWidth: 4, fill: false, opacity: 1, strength: 0.5 }
    ]
    expect(privateItems({ covers, bleeps, shapes })).toEqual({ items: 3, waiting: 2, check: 1, said: 1, weak: 2 })
    expect(privateItems({ bleeps: [bleeps[2]], shapes: [] })).toEqual({ items: 0, waiting: 0, check: 0, said: 0, weak: 0 })
  })

  it('193. Home thumbnails: thumbTime is the one time both sides use; thumbCovers(project, t − 0.1, t + 0.1) holds a cover active only 0.05 s before t', () => {
    expect(thumbTime(60)).toBe(1)
    expect(thumbTime(4)).toBeCloseTo(0.6, 12)
    const t = thumbTime(60)
    const p: Project = { ...base('thumb', 60), covers: [coverOf('c', t - 0.2, t - 0.05, [key(t - 0.2, 0.2, 0.2, 0.1, 0.1)]), coverOf('far', 30, 31, [key(30, 0.5, 0.5, 0.1, 0.1)])] }
    const boxes = thumbCovers(p, t - 0.1, t + 0.1)
    expect(boxes).toHaveLength(1)
    expect(inside({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, boxes[0])).toBe(true)
    // A blur shape active in the window counts too; a bleep alone hides something but gives no box.
    const shaped: Project = { ...base('thumb2', 60), shapes: [{ id: 'h', start: 0, end: 0.95, kind: 'pixelate', x: 0.6, y: 0.6, w: -0.1, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.5 }] }
    expect(thumbCovers(shaped, t - 0.1, t + 0.1)).toEqual([{ x: 0.5, y: 0.6, w: 0.1, h: 0.1 }])
    const bleeped: Project = { ...base('thumb3', 60), bleeps: [{ id: 'b', start: 0.5, end: 1, word: 'x', sound: 'tone' }] }
    expect(thumbCovers(bleeped, t - 0.1, t + 0.1)).toEqual([])
    expect(hidesSomething(bleeped)).toBe(true)
  })

  it('194. readBleeps keeps private bleeps first when it cuts at 2,000; a project with no private bleep is cut exactly as before', () => {
    const plain = Array.from({ length: 2100 }, (_v, i) => ({ id: `b${i}`, start: i * 0.5, end: i * 0.5 + 0.3, word: 'word', sound: 'tone' }))
    const cut = readBleeps(plain, 2000)!
    expect(cut).toHaveLength(2000)
    expect(cut[cut.length - 1].id).toBe('b1999')
    const late = [...plain, ...Array.from({ length: 10 }, (_v, i) => ({ id: `p${i}`, start: 1040 + i, end: 1040.4 + i, word: `:card:g${i}`, sound: 'tone', auto: true }))]
    const kept = readBleeps(late, 2000)!
    expect(kept).toHaveLength(2000)
    expect(kept.filter(isPrivateBleep)).toHaveLength(10)
    // In time order, the rest the earliest.
    expect(kept.map((b) => b.start)).toEqual([...kept.map((b) => b.start)].sort((a, b) => a - b))
    expect(kept.filter((b) => !isPrivateBleep(b)).map((b) => b.id)).toEqual(plain.slice(0, 1990).map((b) => b.id))
  })

  it('Tidy captions with bleeping keeps private bleeps first when it cuts at 2,000, as readBleeps does; a project with no private bleep is cut as before (second review, finding [22])', () => {
    // A long project at the limit: 1,999 ordinary bleeps, then Find's private bleep over a card said at 3,500 s.
    const ordinary: Bleep[] = Array.from({ length: 1999 }, (_v, i) => ({ id: `o${i}`, start: 100 + i * 1.4, end: 100 + i * 1.4 + 0.3, word: 'gosh', sound: 'tone' }))
    const swear = words('k1', 10, 'well this is fucking broken')
    const card = words('k2', 3500, 'my card number is 4917 6123 4567 8904')
    const w = card.words!
    const priv: Bleep = { id: 'pb-1', start: w[4].start - 0.05, end: w[7].end + 0.05, word: ':card:k3v9q2m8xa', sound: 'tone', auto: true }
    const project: Project = { ...base('limit', 3600), transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [swear, card] }, bleeps: [...ordinary, priv] }
    // Tidy with Standard bleeping finds the swear word at 10 s, earlier than every other bleep.
    const out = tidyCaptions(project, { ...DEFAULT_CLEANUP, bleep: 'standard', words: [] })
    const kept = out.project.bleeps!
    expect(kept).toHaveLength(2000)
    expect(kept.filter(isPrivateBleep).map((b) => b.id)).toEqual(['pb-1'])
    expect(kept.map((b) => b.start)).toEqual([...kept.map((b) => b.start)].sort((a, b) => a - b))
    expect(spokenSegments(out.project)[1].text).toBe('my card number is •••• •••• •••• ••••.')
    // The new bleep is kept and counted; the latest ordinary one makes room.
    expect(out.bleeped).toBe(1)
    expect(kept.some((b) => b.id === 'o1998')).toBe(false)
    // Without a private bleep, the earliest 2,000 as before.
    const plain = tidyCaptions({ ...project, bleeps: [...ordinary, { id: 'o-last', start: 3400, end: 3400.3, word: 'gosh', sound: 'tone' }] }, { ...DEFAULT_CLEANUP, bleep: 'standard', words: [] })
    expect(plain.project.bleeps!.map((b) => b.id)).toEqual(readBleeps([...plain.project.bleeps!], 3600)!.map((b) => b.id))
    expect(plain.project.bleeps!.some((b) => b.id === 'o-last')).toBe(false)
  })

  it("195. Private bleep words: privateBleepWord, privateKindOf and privateGroupOf round-trip through readBleeps' lower-casing; ':' + kind alone reads with no group; no caption word's bleepKey parses as one", () => {
    const word = privateBleepWord('phone', 'K3V9Q2M8XA')
    expect(word).toBe(':phone:k3v9q2m8xa')
    const [b] = readBleeps([{ id: 'x', start: 1, end: 2, word: word.toUpperCase(), sound: 'tone' }], 10)!
    expect(privateKindOf(b)).toBe('phone')
    expect(privateGroupOf(b)).toBe('k3v9q2m8xa')
    expect(privateKindOf({ word: ':email' })).toBe('email')
    expect(privateGroupOf({ word: ':email' })).toBeNull()
    expect(privateKindOf({ word: ':bogus:abc' })).toBeNull()
    expect(privateKindOf({ word: 'card' })).toBeNull()
    for (const f of oldFixtures()) {
      const p = migrateProject(structuredClone(f.raw))
      for (const s of p.transcript?.segments ?? []) for (const w of s.words ?? [words('x', 0, s.text)].flatMap((x) => x.words!)) expect(privateKindOf({ word: bleepKey(w.text) })).toBeNull()
    }
  })
})
