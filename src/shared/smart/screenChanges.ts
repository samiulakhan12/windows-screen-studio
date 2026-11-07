/**
 * Where the screen changed and settled (docs/design/smart-tools.md §7.2), read from a scene scan:
 * the guide's steps without clicks and its typed-text marks (part P1), the chapters' screen and
 * page candidates (P2) and the clips' activity (P3). Pure.
 */
import type { SceneScan } from '../api/projects'
import type { ScrollEvent } from '../types'

/**
 * `change`: a sample whose changed share is at least this (%) is a change; `page`: at least this is
 * a page change; `settle`: the median of the samples in the next `settleS` seconds must be at most
 * this (the screen settled); `scrollGuard`: no scroll in this many seconds before it (scrolling
 * never settles, and its first sample could look like one).
 */
export const SCREEN_RULES = { change: 10, page: 30, settle: 3, settleS: 1.0, scrollGuard: 0.5 } as const

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The screen changes of `scan`, in time order: at sample i, `changed[i] ≥ 10`, the median of the
 * `ceil(1.0 / step)` samples after it at most 3, and no scroll event in the 0.5 s before it. A
 * change spread over samples in a row is one, at its first sample, with the largest share. `page`
 * when the share is at least 30.
 */
export function screenChanges(scan: SceneScan, scrolls?: readonly ScrollEvent[]): { t: number; share: number; page: boolean }[] {
  const n = Math.max(1, Math.ceil(SCREEN_RULES.settleS / (scan.step > 0 ? scan.step : 0.25) - 1e-9))
  const count = Math.min(scan.t.length, scan.changed.length)
  const scrollTimes = (scrolls ?? []).map((s) => s.t).filter(Number.isFinite).sort((a, b) => a - b)
  const scrolledBefore = (t: number): boolean => {
    // Any scroll in [t − scrollGuard, t].
    let lo = 0
    let hi = scrollTimes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (scrollTimes[mid] < t - SCREEN_RULES.scrollGuard) lo = mid + 1
      else hi = mid
    }
    return lo < scrollTimes.length && scrollTimes[lo] <= t
  }
  const out: { t: number; share: number; page: boolean }[] = []
  let last = -2
  for (let i = 0; i < count; i++) {
    const share = scan.changed[i]
    // A change, with a full settle window after it.
    if (!(share >= SCREEN_RULES.change) || i + n >= count) continue
    if (median(scan.changed.slice(i + 1, i + 1 + n)) > SCREEN_RULES.settle || scrolledBefore(scan.t[i])) continue
    if (last === i - 1 && out.length) {
      // The same change over two samples: one change, the larger share.
      const prev = out[out.length - 1]
      if (share > prev.share) prev.share = share
      prev.page = prev.share >= SCREEN_RULES.page
    } else out.push({ t: scan.t[i], share, page: share >= SCREEN_RULES.page })
    last = i
  }
  return out
}
