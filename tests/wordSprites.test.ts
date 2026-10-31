import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Test 24 (docs/design/captions-studio.md §16.1, §9.7): the word sprite cache. The byte cap evicts
 * the oldest sprite; canvases of evicted sprites are reused, not reallocated; keys are content, so
 * the same key gives the same canvas without painting again; spriteCap is 64 MB at 1920x1080 and
 * 256 MB at 3840x2160.
 */

interface FakeCanvas {
  id: number
  width: number
  height: number
  getContext(type: string, opts?: unknown): unknown
  modes: unknown[]
}
let made = 0
function fakeCanvas(): FakeCanvas {
  const c: FakeCanvas = {
    id: made++,
    width: 300,
    height: 150,
    modes: [],
    getContext(_type, opts) {
      c.modes.push(opts)
      return { canvas: c }
    }
  }
  return c
}
vi.stubGlobal('document', { createElement: () => fakeCanvas() })

type Paint = (c: unknown) => void
interface Cache {
  setCap(n: number): void
  setReadFrequently(on: boolean): void
  get(key: string, w: number, h: number, paint: Paint): FakeCanvas | null
  clear(): void
  bytes(): number
}
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const SPRITES = '../src/renderer/src/render/wordSprites'
const { SpriteCache, spriteCap } = (await import(/* @vite-ignore */ SPRITES)) as { SpriteCache: new (cap: number) => Cache; spriteCap(w: number, h: number): number }

const MB = 1024 * 1024

describe('SpriteCache (test 24)', () => {
  beforeEach(() => {
    made = 0
  })

  it('paints a key once and returns the same canvas for it again', () => {
    const cache = new SpriteCache(MB)
    const paint = vi.fn()
    const a = cache.get('word|Hello|800|76px|base', 100, 40, paint)
    const b = cache.get('word|Hello|800|76px|base', 100, 40, paint)
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(paint).toHaveBeenCalledTimes(1)
    expect(cache.bytes()).toBe(100 * 40 * 4)
  })

  it('keys are content: another state or text is another sprite', () => {
    const cache = new SpriteCache(MB)
    const paint = vi.fn()
    const base = cache.get('Hello|base', 100, 40, paint)
    const lit = cache.get('Hello|lit', 100, 40, paint)
    expect(lit).not.toBe(base)
    expect(paint).toHaveBeenCalledTimes(2)
    // Asked again in any order, nothing is painted again.
    cache.get('Hello|base', 100, 40, paint)
    cache.get('Hello|lit', 100, 40, paint)
    expect(paint).toHaveBeenCalledTimes(2)
  })

  it('the byte cap evicts the oldest sprite first (least recently used)', () => {
    // Three 100 x 100 sprites hold 120,000 bytes; the cap holds two.
    const cache = new SpriteCache(100 * 100 * 4 * 2)
    const paint = vi.fn()
    cache.get('a', 100, 100, paint)
    cache.get('b', 100, 100, paint)
    cache.get('a', 100, 100, paint) // a is now the most recent
    cache.get('c', 100, 100, paint) // evicts b, the oldest
    expect(cache.bytes()).toBe(80_000)
    expect(paint).toHaveBeenCalledTimes(3)
    cache.get('a', 100, 100, paint)
    expect(paint).toHaveBeenCalledTimes(3)
    cache.get('b', 100, 100, paint)
    expect(paint).toHaveBeenCalledTimes(4)
  })

  it('reuses the canvases of evicted sprites instead of making new ones', () => {
    const cache = new SpriteCache(100 * 100 * 4)
    const first = cache.get('a', 100, 100, () => {})!
    const second = cache.get('b', 50, 50, () => {})!
    // b evicted a and took its canvas, resized.
    expect(second).toBe(first)
    expect([second.width, second.height]).toEqual([50, 50])
    for (let i = 0; i < 20; i++) cache.get(`w${i}`, 100, 100, () => {})
    expect(made).toBeLessThanOrEqual(2)
  })

  it('a lower cap evicts at once; clear empties the cache', () => {
    const cache = new SpriteCache(10 * MB)
    for (let i = 0; i < 5; i++) cache.get(`k${i}`, 100, 100, () => {})
    expect(cache.bytes()).toBe(200_000)
    cache.setCap(100_000)
    expect(cache.bytes()).toBeLessThanOrEqual(100_000)
    cache.clear()
    expect(cache.bytes()).toBe(0)
  })

  it('a sprite larger than the cap is drawn but not kept', () => {
    const cache = new SpriteCache(1000)
    const paint = vi.fn()
    expect(cache.get('big', 100, 100, paint)).not.toBeNull()
    expect(cache.bytes()).toBe(0)
  })

  it('sprite contexts follow the target raster mode', () => {
    const cache = new SpriteCache(MB)
    cache.setReadFrequently(true)
    const c = cache.get('x', 10, 10, () => {})!
    expect(c.modes.at(-1)).toEqual({ willReadFrequently: true })
  })

  it('spriteCap: 64 MB at 1920x1080 and below, 256 MB at 3840x2160, in between by pixels', () => {
    expect(spriteCap(1920, 1080)).toBe(64 * MB)
    expect(spriteCap(1080, 1920)).toBe(64 * MB)
    expect(spriteCap(1280, 720)).toBe(64 * MB)
    expect(spriteCap(3840, 2160)).toBe(256 * MB)
    expect(spriteCap(2160, 3840)).toBe(256 * MB)
    expect(spriteCap(7680, 4320)).toBe(256 * MB)
    expect(spriteCap(2560, 1440)).toBe(Math.round((64 * MB * 2560 * 1440) / (1920 * 1080)))
  })
})
