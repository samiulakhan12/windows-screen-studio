import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateProject } from '../src/shared/engine/project'
import { DEFAULT_REFRAME, followApplies, isTall, readCopyOf, readReframe, reframeOn, tallAs, withoutFollow, withReframe } from '../src/shared/engine/reframeData'
import type { ReframeSettings } from '../src/shared/types'

/*
 * The follow settings and the copy's origin as stored (docs/design/vertical-video.md §4.2-4.4;
 * tests 1-3): sanitising, old projects loading exactly as before, turning following on, and when a
 * frame follows.
 */

describe('readReframe and readCopyOf (test 1)', () => {
  it('gives nothing for what is not a plain object', () => {
    for (const raw of [undefined, null, [], [{ mode: 'follow' }], 'follow', '', 0, false]) expect(readReframe(raw)).toBeUndefined()
  })

  it('never turns following on or moves captions for a damaged file; clamps numbers; keeps known values', () => {
    expect(readReframe({ mode: 'x' })?.mode).toBe('fit')
    expect(readReframe({ level: 9 })?.level).toBe(2)
    expect(readReframe({ band: 0 })?.band).toBe(0.2)
    expect(readReframe({ pace: 'fast' })?.pace).toBe('balanced')
    expect(readReframe({ appSafe: 'yes' })?.appSafe).toBe(false)
    expect(readReframe({ camera: 'side' })?.camera).toBe('top')
    const ok: ReframeSettings = { mode: 'follow', level: 1.4, camera: 'bottom', band: 0.27, pace: 'lively', appSafe: true, rest: { x: 0.3, y: 0.6 } }
    expect(readReframe(ok)).toEqual(ok)
  })

  it('keeps a rest point only with finite x and y, clamped', () => {
    expect(readReframe({ rest: { x: 2, y: Number.NaN } })).not.toHaveProperty('rest')
    expect(readReframe({ rest: { x: 2, y: 0.5 } })?.rest).toEqual({ x: 1, y: 0.5 })
    expect(readReframe({ rest: { x: Number.POSITIVE_INFINITY, y: 0.5 } })).not.toHaveProperty('rest')
  })

  it('is idempotent', () => {
    for (const raw of [{}, { mode: 'follow', level: 3, band: 0.1, rest: { x: -1, y: 4 } }, { mode: 'fit', camera: 'bubble', pace: 'calm', appSafe: true }]) {
      const once = readReframe(raw)
      expect(readReframe(once)).toEqual(once)
      expect(readReframe(JSON.parse(JSON.stringify(once)))).toEqual(once)
    }
  })

  it('readCopyOf: a bad id or a non-string name gives nothing; a 300-character name is cut to 200', () => {
    expect(readCopyOf({ id: 'rec-20261028-101500', name: 'Billing demo' })).toEqual({ id: 'rec-20261028-101500', name: 'Billing demo' })
    for (const raw of [{ id: '../x', name: 'a' }, { id: 'a\\b', name: 'a' }, { id: 'rec 1', name: 'a' }, { id: 'rec-1', name: 7 }, { id: 'rec-1' }, null, 'rec-1']) expect(readCopyOf(raw)).toBeUndefined()
    expect(readCopyOf({ id: 'rec-1', name: 'x'.repeat(300) })?.name).toBe('x'.repeat(200))
  })
})

describe('old projects load exactly as before (test 2)', () => {
  const OLD: { name: string; raw: Record<string, unknown>; keys: string[]; migrated: Record<string, unknown> }[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'vertical-old-projects.json'), 'utf8')
  )

  for (const f of OLD) {
    it(`${f.name}: no reframe or copyOf key, the same keys and JSON as the snapshot`, () => {
      const p = migrateProject(structuredClone(f.raw)) as unknown as Record<string, unknown>
      expect(p).not.toHaveProperty('reframe')
      expect(p).not.toHaveProperty('copyOf')
      expect(Object.keys(p)).toEqual(f.keys)
      // An early file without clips gets a made-up clip id; everything else is the snapshot's.
      if (!Array.isArray(f.raw.clips)) p.clips = [{ ...(p.clips as object[])[0], id: '(generated)' }]
      expect(JSON.stringify(p)).toBe(JSON.stringify(f.migrated))
    })
  }
})

describe('turning following on, and when a frame follows (test 3)', () => {
  it('reframeOn: the defaults in a tall frame; the bubble and no app-safe text in a square one; existing settings keep everything but the mode', () => {
    expect(reframeOn({}, 1080, 1920)).toEqual(DEFAULT_REFRAME)
    expect(reframeOn({}, 1080, 1080)).toEqual({ ...DEFAULT_REFRAME, camera: 'bubble', appSafe: false })
    const mine: ReframeSettings = { mode: 'fit', level: 1.7, camera: 'bottom', band: 0.45, pace: 'calm', appSafe: false, rest: { x: 0.1, y: 0.9 } }
    expect(reframeOn({ reframe: mine }, 1080, 1920)).toEqual({ ...mine, mode: 'follow' })
  })

  it('followApplies: 9:16 and 4:3-square cases of §5.1', () => {
    const on = { reframe: { ...DEFAULT_REFRAME } }
    expect(followApplies(on, 1080, 1920, 1920, 1080)).toBe(true)
    expect(followApplies(on, 1920, 1080, 1920, 1080)).toBe(false)
    expect(followApplies(on, 1080, 1080, 1440, 1080)).toBe(true)
    expect(followApplies(on, 1080, 1080, 1200, 1080)).toBe(false)
    expect(followApplies({ reframe: { ...DEFAULT_REFRAME, mode: 'fit' } }, 1080, 1920, 1920, 1080)).toBe(false)
    expect(followApplies({}, 1080, 1920, 1920, 1080)).toBe(false)
  })

  it('withoutFollow returns the same object without reframe; withReframe merges into the defaults', () => {
    const p = migrateProject({ id: 'p', duration: 4, width: 1920, height: 1080 })
    expect(withoutFollow(p)).toBe(p)
    const q = withReframe(p, { pace: 'lively' })
    expect(q.reframe).toEqual({ ...DEFAULT_REFRAME, pace: 'lively' })
    const r = withoutFollow(q)
    expect(r).not.toHaveProperty('reframe')
    expect(r).toEqual(p)
    expect(q.reframe).toEqual({ ...DEFAULT_REFRAME, pace: 'lively' })
  })
})

describe('the preview is tall exactly when the export is', () => {
  it('a 4:5 preview a pixel short of 1.25 is made tall, as its 1080 x 1350 export', () => {
    expect(isTall(403, 503)).toBe(false)
    expect(tallAs(403, 503, 1080, 1350)).toBe(504)
    expect(tallAs(1080, 1348, 1080, 1350)).toBe(1350)
    // A frame just wide of the line stays wide when rounding takes its picture over it.
    expect(tallAs(400, 500, 1000, 1249)).toBe(499)
  })

  it('keeps the preview canvas tall or wide as its output, never above its size, for every pane and display scale', () => {
    let checked = 0
    for (const out of [{ width: 1080, height: 1350 }, { width: 1080, height: 1920 }, { width: 1920, height: 1080 }, { width: 1080, height: 1080 }, { width: 1000, height: 1249 }, { width: 1000, height: 1250 }]) {
      for (const dpr of [1, 1.1, 1.25, 1.5, 1.75, 2]) {
        for (let pane = 120; pane <= 1400; pane += 7) {
          for (const [availW, availH] of [[pane, 2000], [2000, pane]]) {
            // PreviewStage's sizing: the pane's box at the output's ratio, then its backing pixels.
            const ratio = out.width / out.height
            let w = availW
            let h = w / ratio
            if (h > availH) {
              h = availH
              w = h * ratio
            }
            w = Math.floor(w)
            h = Math.floor(h)
            const k = Math.min(1, out.width / (w * dpr), out.height / (h * dpr))
            const bw = Math.max(2, Math.round(w * dpr * k))
            const bh = tallAs(bw, Math.max(2, Math.round(h * dpr * k)), out.width, out.height)
            expect(isTall(bw, bh), `${out.width}x${out.height} in ${availW}x${availH} at ${dpr}`).toBe(isTall(out.width, out.height))
            expect(bh).toBeLessThanOrEqual(out.height)
            expect(Math.abs(bh / bw - out.height / out.width)).toBeLessThan(0.02)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })
})
