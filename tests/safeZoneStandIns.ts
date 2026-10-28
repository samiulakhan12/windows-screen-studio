import type { Rect } from '../src/shared/engine/layout'

type SafeZones = typeof import('../src/shared/render/safeZones')

/*
 * Until parts P1 and P2 are merged, textArea and keepInArea (shared/render/safeZones.ts) are
 * contract stubs that throw 'not implemented'. Duplicate's tests mock the module with
 * withStandIns(real): only while a real function throws that do these stand-ins answer, with the
 * rules of §6.3 (a frame without a camera band) and §6.4; once the real functions are in, every
 * call goes to them.
 */
export function withStandIns(real: SafeZones): SafeZones {
  const orStandIn =
    <A extends unknown[], R>(f: (...args: A) => R, standIn: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return f(...args)
      } catch (err) {
        if ((err as Error).message !== 'not implemented') throw err
        return standIn(...args)
      }
    }
  const { COMMON_SAFE } = real
  return {
    ...real,
    textArea: orStandIn(real.textArea, (p, w, h) =>
      p.reframe?.appSafe && h >= 1.25 * w ? { x: COMMON_SAFE.x * w, y: COMMON_SAFE.y * h, w: COMMON_SAFE.w * w, h: COMMON_SAFE.h * h } : null
    ),
    keepInArea: orStandIn(real.keepInArea, (box: Rect, area: Rect, minScale = 0.6) => {
      const scale = Math.max(minScale, Math.min(1, area.w / box.w, area.h / box.h))
      const shift = (from: number, size: number, lo: number, room: number): number => {
        const s = size * scale
        const at = from + (size - s) / 2
        return s > room ? lo + (room - s) / 2 - at : Math.min(Math.max(at, lo), lo + room - s) - at
      }
      return { dx: shift(box.x, box.w, area.x, area.w), dy: shift(box.y, box.h, area.y, area.h), scale }
    })
  }
}
