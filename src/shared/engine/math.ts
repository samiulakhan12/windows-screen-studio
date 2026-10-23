export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const easeInOutCubic = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3)

/** Index of the last element whose `t` is <= `time` (or -1). Array must be sorted by `t`. */
export function lowerIndex<T extends { t: number }>(items: T[], time: number): number {
  let lo = 0
  let hi = items.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].t <= time) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}
