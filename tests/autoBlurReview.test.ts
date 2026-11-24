import { describe, expect, it } from 'vitest'
import { keepItems, mergeSnapshot, pendingCount, removeItems, reviewItems, reviewStatus, type ReviewItem } from '../src/shared/review/review'
import { mergePrivateRow, parsePrivateKey, privacyKeep, privacyKinds, privacyOrder, privacyPendingCount, privacyRemove, privacyReviewItems, privacyStatus, privateRowView } from '../src/shared/review/privacyReview'
import { privateBleepWord } from '../src/shared/privacy/coverData'
import { PRIVATE_KINDS } from '../src/shared/privacy/kinds'
import { t } from '../src/shared/i18n/t'
import type { Bleep, Cover, PrivateKind, Project } from '../src/shared/types'
import { base, coverOf, key } from './autoBlurFixtures'

/*
 * Review's private rows (docs/design/auto-blur.md §2.7, §14.3; §17.1 tests 161-163 and 243): one
 * row per group of found covers or private bleeps, its places as parts, its status read from the
 * project, Keep covered and Uncover through part P1's cover edits, the Check-first order and the
 * kinds' whole sentences. Pure.
 */

const found = (id: string, start: number, end: number, x: number, y: number, over: Partial<Cover> = {}): Cover => coverOf(id, start, end, [key(start, x, y, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'g1', ...over })
const said = (id: string, start: number, end: number, kind: PrivateKind, group: string, auto = true): Bleep => ({ id, start, end, word: privateBleepWord(kind, group), sound: 'tone', ...(auto ? { auto: true as const } : {}) })
const project = (covers: Cover[], bleeps: Bleep[] = []): Project => ({ ...base('rv', 300), covers, ...(bleeps.length ? { bleeps } : {}) })
const rowOf = (p: Project, group: string): ReviewItem => privacyReviewItems(p).find((r) => parsePrivateKey(r.key)?.group === group)!

describe('auto-blur P5: Review rows', () => {
  it('161. privacyReviewItems: one row per group with its places as parts; titles with the kind’s title, times, place and the largest lost area’s size; badges; privacyOrder puts Check rows first', () => {
    const p = project(
      [
        found('a1', 42, 50, 0.8, 0.05),
        found('a2', 100, 120, 0.1, 0.8, { lost: true, path: '100 0.1 0.5 0.5 0.4;110 0.1 0.6 0.4 0.3' }),
        found('a3', 180, 190, 0.4, 0.4, { missed: true }),
        found('b1', 10, 20, 0.4, 0.4, { kind: 'key', group: 'g2', found: 'check', thin: true }),
        // The user's own cover and Cover this text everywhere's (no `found`) are not rows.
        coverOf('mine', 5, 6, [key(5, 0.1, 0.1, 0.1, 0.1)]),
        coverOf('txt', 7, 8, [key(7, 0.1, 0.1, 0.1, 0.1)], { kind: 'text', group: 'g3' })
      ],
      [said('s1', 30, 32, 'card', 'g4')]
    )
    const rows = privacyReviewItems(p)
    expect(rows.map((r) => r.key).sort()).toEqual(['private:card:g4', 'private:email:g1', 'private:key:g2'])
    const email = rowOf(p, 'g1')
    // Its title: the kind's title and the first start to the last end, in the video's time.
    expect(email.title).toBe('Email address · 0:42.0–3:10.0')
    expect([email.start, email.end]).toEqual([42, 190])
    // Its detail: where its first cover is on screen.
    expect(email.detail).toBe('Top right of the screen')
    // Its places are its parts, each with where it is and its own times.
    expect(email.parts!.map((x) => x.title)).toEqual(['Top right of the screen · 0:42.0–0:50.0', 'Bottom of the screen · 1:40.0–2:00.0', 'Middle of the screen · 3:00.0–3:10.0'])
    expect(email.parts!.map((x) => [x.start, x.end])).toEqual([
      [42, 50],
      [100, 120],
      [180, 190]
    ])
    // One cover: no parts.
    expect(rowOf(p, 'g2').parts).toBeUndefined()
    // The row's view: its places, the largest lost area's share and length, and its badges.
    const v = privateRowView(p, email)!
    expect(v.places).toBe(3)
    expect(v.area).toEqual({ percent: '20%', time: '0:20.0' })
    expect(v.badges.map((b) => t(b))).toEqual(['Covers an area', 'Not found again'])
    expect(privateRowView(p, rowOf(p, 'g2'))!.badges.map((b) => t(b))).toEqual(['Check', 'Read less often here'])
    const spoken = rowOf(p, 'g4')
    expect(spoken.detail).toBe('Said aloud')
    expect(privateRowView(p, spoken)!.badges.map((b) => t(b))).toEqual(['Said aloud'])
    // Check rows first, then by start; any other row after them.
    const other: ReviewItem = { key: 'zoom:z', kind: 'zoom', start: 0, end: 1, title: 'z', detail: '' }
    expect(privacyOrder([email, spoken, other, rowOf(p, 'g2')], p).map((r) => r.key)).toEqual(['private:key:g2', 'private:card:g4', 'private:email:g1', 'zoom:z'])
    // reviewItems lists them with every other row, by time.
    expect(reviewItems(p).filter((r) => r.kind === 'private')).toHaveLength(3)
  })

  it('162. privacyKeep and privacyRemove take ReviewItems and act on a row’s or a part’s covers and bleeps; Remove writes rejected paths', () => {
    const p = project([found('a1', 10, 20, 0.1, 0.1), found('a2', 30, 40, 0.5, 0.5), found('b1', 50, 60, 0.4, 0.4, { kind: 'key', group: 'g2' })], [said('s1', 70, 72, 'phone', 'g9')])
    const email = rowOf(p, 'g1')
    // A part: that cover only, kept (found dropped), the rest still waiting.
    const one = privacyKeep(p, [email.parts![0]])
    expect(one.covers!.find((c) => c.id === 'a1')!.found).toBeUndefined()
    expect(one.covers!.find((c) => c.id === 'a2')!.found).toBe('auto')
    expect(privacyStatus(one, email.parts![0])).toBe('kept')
    expect(privacyStatus(one, email)).toBe('pending')
    // A row: every cover of it.
    const both = privacyKeep(p, [email])
    expect(both.covers!.filter((c) => c.group === 'g1').every((c) => !c.found)).toBe(true)
    expect(privacyStatus(both, email)).toBe('kept')
    // A said row: its private bleep is the user's.
    const spoken = rowOf(p, 'g9')
    expect(privacyKeep(p, [spoken]).bleeps![0].auto).toBeUndefined()
    // Remove of a part: that cover gone, its path remembered for its kind.
    const gone = privacyRemove(p, [email.parts![1]])
    expect(gone.covers!.map((c) => c.id)).toEqual(['a1', 'b1'])
    expect(gone.privacy!.rejected).toEqual([{ kind: 'email', start: 30, end: 40, path: p.covers![1].path }])
    expect(privacyStatus(gone, email.parts![1])).toBe('removed')
    // Remove of a row: all its covers, and a said row's bleep.
    const row = privacyRemove(p, [rowOf(p, 'g2'), spoken])
    expect(row.covers!.map((c) => c.id)).toEqual(['a1', 'a2'])
    expect(row.bleeps).toBeUndefined()
    expect(row.privacy!.rejected!.map((r) => r.kind)).toEqual(['key'])
    expect(privacyStatus(row, rowOf(p, 'g2'))).toBe('removed')
    // Through Review's Keep and Remove: one project out, pending items only.
    expect(keepItems(p, [email]).covers!.filter((c) => c.group === 'g1').every((c) => !c.found)).toBe(true)
    expect(removeItems(p, [email]).covers!.map((c) => c.id)).toEqual(['b1'])
    // Nothing to do: the project itself.
    expect(privacyKeep(both, [email])).toBe(both)
    // The panel keeps an uncovered place, marked, while the row is still pending (mergeSnapshot).
    const shown = mergeSnapshot([email], gone)
    expect(shown[0].parts!.map((x) => reviewStatus(gone, x))).toEqual(['pending', 'removed'])
    expect(mergePrivateRow(email, undefined)).toBe(email)
  })

  it('163. privacyPendingCount counts without making rows; reviewStatus over 2,000 private groups runs in under 20 ms (×6 on CI) through privacyIndex', () => {
    const covers: Cover[] = []
    for (let i = 0; i < 2000; i++) covers.push(found(`c${i}`, (i % 280) + 1, (i % 280) + 2, (i % 4) * 0.2, 0.1, { group: `g${i}`, kind: PRIVATE_KINDS[i % 10], found: i % 3 ? 'auto' : 'check' }))
    const p = project(covers)
    const rows = privacyReviewItems(p)
    expect(rows).toHaveLength(2000)
    expect(privacyPendingCount(p)).toBe(2000)
    expect(pendingCount(p)).toBe(2000)
    // Kept groups are no longer counted.
    expect(privacyPendingCount(privacyKeep(p, rows.slice(0, 500)))).toBe(1500)
    // The statuses of every row, read from the project, as the panel reads them on every change.
    const limit = process.env.CI ? 120 : 20
    let best = Infinity
    for (let round = 0; round < 5 && best >= limit; round++) {
      const q = { ...p, covers: [...p.covers!] }
      const t0 = performance.now()
      const statuses = rows.map((r) => reviewStatus(q, r))
      best = Math.min(best, performance.now() - t0)
      expect(statuses.every((s) => s === 'pending')).toBe(true)
    }
    expect(best).toBeLessThan(limit)
    // Counting is cheaper than making the rows (no titles, no times): it never waits on them.
    let countMs = Infinity
    for (let round = 0; round < 5; round++) {
      const q = { ...p, covers: [...p.covers!] }
      const t0 = performance.now()
      privacyPendingCount(q)
      countMs = Math.min(countMs, performance.now() - t0)
    }
    expect(countMs).toBeLessThan(limit)
  })

  it('243. Kind sentences: keepKind and uncoverKind give a whole sentence for every kind id', () => {
    for (const kind of PRIVATE_KINDS) {
      const keep = t('privacy.review.keepKind', { kind })
      const uncover = t('privacy.review.uncoverKind', { kind })
      expect(keep, kind).toMatch(/^Keep all .+ covered$/)
      expect(uncover, kind).toMatch(/^Uncover all .+$/)
      // Never the select's fallback: every kind has its own sentence.
      expect(keep, kind).not.toBe('Keep all of this kind covered')
      expect(uncover, kind).not.toBe('Uncover all of this kind')
    }
    expect(t('privacy.review.keepKind', { kind: 'email' })).toBe('Keep all email addresses covered')
    expect(t('privacy.review.uncoverKind', { kind: 'card' })).toBe('Uncover all card and bank numbers')
    // The kinds present, in the kinds' order, for the kind filter.
    const p = project([found('a', 1, 2, 0.1, 0.1, { kind: 'phone', group: 'x' }), found('b', 3, 4, 0.1, 0.1, { kind: 'password', group: 'y' })])
    expect(privacyKinds(p)).toEqual(['password', 'phone'])
  })
})
