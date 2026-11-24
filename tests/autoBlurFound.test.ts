import { describe, expect, it } from 'vitest'
import type { FindResult, FoundCover } from '../src/shared/api/privacy'
import { coverIndex, coversAt, containsOver } from '../src/shared/privacy/covers'
import { boxAt, coverSlack, drawnBox, pathKeys, writePath, type CoverKey } from '../src/shared/privacy/coverPath'
import { MAX_COVERS } from '../src/shared/privacy/coverData'
import { foundColour, foundCovers, groupExtras, hideLength, limitCovers, withFoundCovers } from '../src/shared/privacy/found'
import { COVER_DARK } from '../src/shared/privacy/kinds'
import { findNotices } from '../src/shared/privacy/notices'
import type { Box } from '../src/shared/privacy/protocol'
import type { Cover, FindRecord, Project, RejectedPlace } from '../src/shared/types'
import { base, coverOf, inside, key, rng, seededCovers } from './autoBlurFixtures'
import { HD, lookOf } from './autoBlurScanFixtures'

/*
 * Notifications, found covers and Find again (docs/design/auto-blur.md §5.10, §6.1, §6.13; §17.1 tests
 * 149-152, 234 and 235).
 */

const SLOW = process.env.CI ? 6 : 1
const cpuMs = (fn: () => void): number => {
  const t0 = process.cpuUsage()
  fn()
  const d = process.cpuUsage(t0)
  return (d.user + d.system) / 1000
}

const screen = { capture: { method: 'native' as const, cursorInVideo: true, region: null, target: 'screen' as const, fps: 30 } }
const ok = (found: FoundCover[], over: Partial<Extract<FindResult, { ok: true }>> = {}): Extract<FindResult, { ok: true }> => ({ ok: true, projectId: 'rec-1', requestId: 'r1', found, failedReads: 0, thinSpans: '', stopped: false, readTo: null, reader: 'pp-ocrv6-tiny+small-careful-long', ...over })
const fc = (group: string, start: number, end: number, keys: CoverKey[], over: Partial<FoundCover> = {}): FoundCover => ({ kind: 'email', score: 0.9, group, start, end, path: writePath(keys), color: '#202020', ...over })
const record = (kinds: FindRecord['kinds']): FindRecord => ({ at: '2026-11-23T12:00:00.000Z', kinds, listened: false, reader: 'pp-ocrv6-tiny+small-careful-long' })

/** Every input box at every input key is inside the drawn box of some output cover. */
function everyBoxKept(input: readonly Cover[], output: readonly Cover[], slack = 0.001): boolean {
  const index = coverIndex(output)
  for (const c of input)
    for (const k of pathKeys(c)) {
      if (k.t >= c.end) continue
      const t = Math.max(k.t, c.start)
      const box = boxAt(c, t)!
      if (!coversAt(index, t, slack).some((o) => inside(box, drawnBox(o, t, slack)))) return false
    }
  return true
}

describe('auto-blur P4: notices and found covers', () => {
  it('149. findNotices: a toast in the bottom right for 5 s is found; one lasting 40 s, one in the middle, one in a window recording and one in an imported video are not; stacked toasts (finding 5) give each box and the union', () => {
    const toast: Box = [1440, 864, 448, 160]
    const at = (t: number, times: number[]): boolean => times.some((x) => Math.abs(t - x) < 1e-6)
    // Slides in over two frames at 10 s, goes at 15 s.
    const five = lookOf(HD, 30, 60, (_i, t) => (at(t, [10]) ? { changed: [[1664, 864, 224, 160]] } : at(t, [10 + 1 / 30, 15, 15 + 1 / 30]) ? { changed: [toast] } : {}))
    const found = findNotices(five, screen)
    expect(found).toHaveLength(1)
    expect(found[0].box).toEqual(toast)
    expect(found[0].start).toBeCloseTo(10, 4)
    expect(found[0].end).toBeCloseTo(15 + 2 / 30, 4)
    expect(found[0].stacked).toBe(false)
    // Showing at the recording's end: found, to the end.
    const toEnd = lookOf(HD, 30, 60, (_i, t) => (at(t, [50]) ? { changed: [toast] } : {}))
    expect(findNotices(toEnd, screen).map((n) => [n.start, n.end])).toEqual([[50, expect.closeTo(60, 4)]])
    // Too long, in the middle, a window recording, an imported video.
    const forty = lookOf(HD, 30, 60, (_i, t) => (at(t, [5, 45]) ? { changed: [toast] } : {}))
    expect(findNotices(forty, screen)).toEqual([])
    const middle = lookOf(HD, 30, 60, (_i, t) => (at(t, [10, 15]) ? { changed: [[736, 448, 448, 160]] } : {}))
    expect(findNotices(middle, screen)).toEqual([])
    expect(findNotices(five, { capture: { ...screen.capture, target: 'window' } })).toEqual([])
    expect(findNotices(five, { capture: { ...screen.capture, target: 'area', region: { x: 0, y: 0, w: 0.5, h: 0.5 } } })).toEqual([])
    expect(findNotices(five, { ...screen, source: { kind: 'import' } as unknown as Project['source'] })).toEqual([])
    // Two stacked: each box, and their union while both show.
    const low: Box = [1440, 928, 448, 96]
    const high: Box = [1440, 832, 448, 96]
    const stacked = lookOf(HD, 30, 60, (_i, t) => (at(t, [20, 26]) ? { changed: [low] } : at(t, [21, 27]) ? { changed: [high] } : {}))
    const s = findNotices(stacked, screen)
    expect(s.filter((n) => !n.stacked).map((n) => n.box)).toEqual([low, high])
    const union = s.filter((n) => n.stacked)
    expect(union).toHaveLength(1)
    expect(union[0].box).toEqual([1440, 832, 448, 192])
    expect(union[0].start).toBeCloseTo(21, 4)
    expect(union[0].end).toBeCloseTo(26 + 1 / 30, 4)
  })

  it('Stacked toasts sliding in from the edge, the second sharing a row of tiles with the first, are found each from the frame it starts sliding in, once, and their union while both show (found end to end: the first toast took in the second sliding in beside it, took its slide for its own changes, and no toast was found)', () => {
    // Two toasts slide in from the right edge over six analysed frames each, 0.33 s apart, rest 2.2 s and slide out; their shadows share the row of tiles at 64-96.
    const W = 1920
    const slide = (top: number, start: number, end: number) => (t: number): Box | null => {
      const f = Math.round((t - start) * 30)
      const g = Math.round((t - end) * 30)
      if (f < 0 || g > 6) return null
      const shown = f < 6 ? f + 1 : g < 0 ? 6 : 6 - g
      return shown > 0 ? [W - 64 * shown, top, 64 * shown, 96] : null
    }
    const a = slide(0, 0.3, 2.7)
    const b = slide(64, 0.6, 3.0)
    const look = lookOf(HD, 30, 4, (_i, t) => {
      const ra = Math.round((t - 0.3) * 30)
      const rb = Math.round((t - 0.6) * 30)
      const ga = Math.round((t - 2.7) * 30)
      const gb = Math.round((t - 3.0) * 30)
      const changed: Box[] = []
      // A region changes while it slides (in or out).
      if ((ra >= 0 && ra < 6) || (ga >= 0 && ga <= 6)) changed.push(a(t) ?? [W - 64, 0, 64, 96])
      if ((rb >= 0 && rb < 6) || (gb >= 0 && gb <= 6)) changed.push(b(t) ?? [W - 64, 64, 64, 96])
      return changed.length ? { changed } : {}
    })
    const found = findNotices(look, screen)
    const own = found.filter((x) => !x.stacked)
    expect(own.map((x) => x.box)).toEqual([[W - 384, 0, 384, 96], [W - 384, 64, 384, 96]])
    expect(own[0].start).toBeCloseTo(0.3, 4)
    expect(own[1].start).toBeCloseTo(0.6, 4)
    expect(own[0].end).toBeGreaterThan(2.7 + 6 / 30 - 1e-6)
    expect(own[1].end).toBeGreaterThan(3.0 + 6 / 30 - 1e-6)
    const union = found.filter((x) => x.stacked)
    expect(union.map((x) => x.box)).toEqual([[W - 384, 0, 384, 160]])
  })

  it('150. foundCovers: groups by group key, scores to tiers, colours from rings', () => {
    const a = key(1, 0.1, 0.1, 0.2, 0.05)
    const covers = foundCovers(
      ok([
        fc('g1', 1, 3, [a]),
        fc('g1', 2.5, 4, [key(2.5, 0.15, 0.1, 0.2, 0.05)]),
        fc('g1', 20, 22, [key(20, 0.1, 0.1, 0.2, 0.05)], { score: 0.6 }),
        fc('g2', 1, 3, [key(1, 0.6, 0.6, 0.1, 0.05)], { score: 0.6, color: '#AABBCC' }),
        fc('g3', 1, 3, [key(1, 0.6, 0.1, 0.1, 0.05)], { score: 0.3 }),
        fc('g4', 5, 6, [key(5, 0.3, 0.3, 0.1, 0.05)], { color: 'red', kind: 'key' })
      ]),
      HD,
      rng(150)
    )
    // g1's two touching places are one cover with the union path; its later place is another cover of g1.
    const g1 = covers.filter((c) => c.group === 'g1')
    expect(g1).toHaveLength(2)
    expect(g1[0].start).toBe(1)
    expect(g1[0].end).toBe(4)
    expect(inside({ x: 0.1, y: 0.1, w: 0.25, h: 0.05 }, boxAt(g1[0], 2.6))).toBe(true)
    expect(boxAt(g1[0], 1.5)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.05 })
    expect(g1[0].found).toBe('auto')
    expect(g1[1].found).toBe('check')
    // Tiers from scores: 0.85 and up Auto, 0.5 up to it Check, under it nothing.
    expect(covers.find((c) => c.group === 'g2')!.found).toBe('check')
    expect(covers.some((c) => c.group === 'g3')).toBe(false)
    // Colours: the ring main read, lower case; anything else Dark.
    expect(covers.find((c) => c.group === 'g2')!.color).toBe('#aabbcc')
    expect(covers.find((c) => c.group === 'g4')!.color).toBe(COVER_DARK)
    expect(covers.find((c) => c.group === 'g4')!.kind).toBe('key')
    expect(new Set(covers.map((c) => c.id)).size).toBe(covers.length)
    // Main's colour from a line's ring: the ring, or Dark for a mixed one (spread over 24).
    expect(foundColour('#334455', 5)).toBe('#334455')
    expect(foundColour('#334455', 40)).toBe(COVER_DARK)
    expect(foundColour('nonsense', 0)).toBe(COVER_DARK)
  })

  it('151. withFoundCovers: containment drops duplicates, overlap does not; missed set and cleared; user covers untouched; Find again never covers less anywhere; with 2,000 existing covers, 5,000 rejected paths and 2,000 new ones it runs in under 400 ms (×6 on CI)', () => {
    const E = coverOf('E', 1, 5, [key(1, 0.1, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'gE' })
    const M = coverOf('M', 10, 12, [key(10, 0.6, 0.6, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'gM' })
    const M2 = coverOf('M2', 20, 25, [key(20, 0.6, 0.1, 0.2, 0.05)], { found: 'check', kind: 'email', group: 'gM2', missed: true })
    const K = coverOf('K', 30, 35, [key(30, 0.3, 0.8, 0.3, 0.05)], { found: 'auto', kind: 'key', group: 'gK' })
    const late = coverOf('L', 90, 95, [key(90, 0.3, 0.3, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'gL' })
    const U = coverOf('U', 0, 100, [key(0, 0.4, 0.4, 0.2, 0.1)])
    const project: Project = { ...base('rec-1', 100), covers: [E, M, M2, K, late, U] }
    const result = ok(
      [
        fc('n1', 2, 4, [key(2, 0.12, 0.11, 0.1, 0.03)]),
        fc('n2', 2, 4, [key(2, 0.25, 0.1, 0.2, 0.05)]),
        fc('n3', 21, 24, [key(21, 0.62, 0.11, 0.1, 0.03)])
      ],
      { stopped: true, readTo: 80 }
    )
    const { project: next } = withFoundCovers(project, result, [], record(['email']), rng(151))
    const byId = new Map(next.covers!.map((c) => [c.id, c]))
    // n1 is inside E: dropped. n2 only overlaps E: added.
    expect(next.covers!.filter((c) => c.group === 'n1')).toHaveLength(0)
    expect(next.covers!.filter((c) => c.group === 'n2')).toHaveLength(1)
    // Missed: M was not found again; M2 was, so its mark goes; K's kind was not looked for; L lies past where the stopped run read to.
    expect(byId.get('M')!.missed).toBe(true)
    expect(byId.get('M2')!.missed).toBeUndefined()
    expect(byId.get('E')!.missed).toBeUndefined()
    expect(byId.get('K')!.missed).toBeUndefined()
    expect(byId.get('L')!.missed).toBeUndefined()
    // The user's cover is the same object.
    expect(byId.get('U')).toBe(U)
    // Never less: every cover before is held by the cover of its id after.
    for (const c of project.covers!) expect(containsOver(byId.get(c.id)!, c, coverSlack(60)), c.id).toBe(true)
    expect(next.privacy?.find).toEqual(record(['email']))

    // The budget: 2,000 existing covers, 5,000 removed places, 2,000 new ones.
    const existing = seededCovers(1511, 2000, 3, 3600, { found: 'auto', kind: 'email', group: 'old' })
    const rejected: RejectedPlace[] = seededCovers(1512, 5000, 3, 3600).map((c) => ({ kind: 'email', start: c.start, end: c.end, path: c.path }))
    const fresh = seededCovers(1513, 2000, 3, 3600).map((c, i) => fc(`g${i}`, c.start, c.end, [...pathKeys(c)]))
    const big: Project = { ...base('rec-2', 3600), covers: existing, privacy: { rejected } }
    let best = Infinity
    let out: Project | null = null
    for (let r = 0; r < 5 && best >= 400 * SLOW; r++) best = Math.min(best, cpuMs(() => (out = withFoundCovers(big, ok(fresh), [], record(['email']), rng(r)).project)))
    expect(best).toBeLessThan(400 * SLOW)
    expect(everyBoxKept(existing, out!.covers!)).toBe(true)
  })

  it('152. limitCovers keeps at most 2,000 covers without uncovering anything, and twice the input takes at most 2.3 times as long (finding 7)', () => {
    const small = seededCovers(1521, 20000, 2, 3600, { found: 'auto', kind: 'email' })
    const large = seededCovers(1522, 40000, 2, 7200, { found: 'auto', kind: 'email' })
    let out: Cover[] = []
    let pair: [number, number] = [Infinity, Infinity]
    for (let r = 0; r < 5; r++) {
      out = limitCovers(small)
      limitCovers(large)
      const a = Math.min(cpuMs(() => (out = limitCovers(small))), cpuMs(() => limitCovers(small)))
      const b = Math.min(cpuMs(() => limitCovers(large)), cpuMs(() => limitCovers(large)))
      if (b - 2.3 * a < pair[1] - 2.3 * pair[0] || !Number.isFinite(pair[0])) pair = [a, b]
      if (b <= 2.3 * a + 5) break
    }
    expect(out.length).toBeLessThanOrEqual(MAX_COVERS)
    expect(everyBoxKept(small, out)).toBe(true)
    expect(pair[1]).toBeLessThanOrEqual(2.3 * pair[0] + 5)
    // Under the limits nothing changes.
    const few = seededCovers(1523, 50, 3, 100)
    expect(limitCovers(few)).toEqual(few)
  })

  it('234. Hiding the length: two names of 9 and 11 characters in one font get covers of the same width with the random part fixed at 0; every place of one group gets the same extra', () => {
    const cw = 10
    const padH = 10
    const nine: Box = [100, 50, 9 * cw + 2 * padH, 34]
    const eleven: Box = [100, 50, 11 * cw + 2 * padH, 34]
    const a = hideLength(nine, cw, padH, 0, HD)
    const b = hideLength(eleven, cw, padH, 0, HD)
    expect(a[2]).toBe(b[2])
    expect(a[2]).toBe(12 * cw + 2 * padH)
    // Widened equally on both sides, held in the frame.
    expect(a[0] + a[2] / 2).toBeCloseTo(nine[0] + nine[2] / 2, 6)
    const edge = hideLength([1900, 50, 9 * cw + 2 * padH, 34], cw, padH, 2, HD)
    expect(edge[0] + edge[2]).toBe(1920)
    expect(edge[2]).toBe(14 * cw + 2 * padH)
    // The extra: 0, 1 or 2 character widths, once a group.
    const seq = [0.1, 0.9, 0.5, 0.2]
    let i = 0
    const extra = groupExtras(() => seq[i++ % seq.length])
    expect([extra('g1'), extra('g2'), extra('g1'), extra('g3'), extra('g2')]).toEqual([0, 2, 0, 1, 2])
    expect(hideLength(nine, cw, padH, extra('g1'), HD)).toEqual(hideLength(nine, cw, padH, extra('g1'), HD))
  })

  it('235. Removed paths suppress only what they hold (D21): uncovering one email that scrolled through a list does not stop a different email shown later in the same area from being suggested; a new path inside the removed one at every key is suppressed and counted', () => {
    // The removed email scrolled up through a list from 10 s to 12 s.
    const scrolled: CoverKey[] = []
    for (let k = 0; k <= 20; k++) scrolled.push(key(10 + k * 0.1, 0.3, 0.8 - k * 0.03, 0.25, 0.05))
    const removed: RejectedPlace = { kind: 'email', start: 10, end: 12, path: writePath(scrolled) }
    const project: Project = { ...base('rec-1', 60), privacy: { rejected: [removed] } }
    const inner: CoverKey[] = scrolled.slice(5, 15).map((k) => ({ ...k, x: k.x + 0.02, w: 0.1 }))
    const result = ok([
      // Another email later in the same area: suggested.
      fc('later', 30, 32, [key(30, 0.3, 0.5, 0.25, 0.05)]),
      // The same path inside the removed one at every key: suppressed.
      fc('same', 10.5, 11.4, inner),
      // A phone number there: a removed email never suppresses another kind.
      fc('phone', 10.5, 11.4, inner, { kind: 'phone' }),
      // Leaves the removed path at one key: suggested.
      fc('out', 10.5, 11.4, [...inner.slice(0, 5), { ...inner[5], y: 0.1 }, ...inner.slice(6)])
    ])
    const { project: next, suppressed } = withFoundCovers(project, result, [], record(['email', 'phone']), rng(235))
    expect(suppressed).toBe(1)
    expect(next.privacy?.find?.suppressed).toBe(1)
    expect(next.covers!.map((c) => c.group).sort()).toEqual(['later', 'out', 'phone'])
    expect(next.privacy?.rejected).toEqual([removed])
  })

  it('foundCovers keeps two places of one text apart when their boxes only cross: a list showing one email on two rows, one of them lost over the list for a moment, stays two covers, never one box over every row between them (found end to end: the lists of A16 were covered over their whole column)', () => {
    const upper = [key(0, 0.01, 0.1, 0.15, 0.03)]
    // The lower row's walk was lost over the whole list from 1 s to 1.2 s.
    const lower = [key(0, 0.01, 0.6, 0.15, 0.03), key(1, 0, 0, 0.3, 1), key(1.2, 0.01, 0.6, 0.15, 0.03)]
    const covers = foundCovers(ok([fc('g1', 0, 2, upper), fc('g1', 0, 2, lower)]), HD, rng(7))
    expect(covers).toHaveLength(2)
    expect(covers.some((c) => JSON.stringify(boxAt(c, 0.5)) === JSON.stringify({ x: 0.01, y: 0.1, w: 0.15, h: 0.03 }))).toBe(true)
    expect(covers.some((c) => JSON.stringify(boxAt(c, 0.5)) === JSON.stringify({ x: 0.01, y: 0.6, w: 0.15, h: 0.03 }))).toBe(true)
    // Every input box is still drawn.
    expect(covers.some((c) => JSON.stringify(boxAt(c, 1.1)) === JSON.stringify({ x: 0, y: 0, w: 0.3, h: 1 }))).toBe(true)
  })
})
