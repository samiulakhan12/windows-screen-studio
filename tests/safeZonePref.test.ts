import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SAFE_ZONES, type SafeBox, type SafeChoice, type SafePlatform } from '../src/shared/render/safeZones'

/*
 * The safe-zone preview (docs/design/vertical-video.md §2.8, §7, test 57): the per-user preference
 * in localStorage ('editor-safe-zones'), read as off unless it holds a known choice and kept for
 * the session when storage is blocked, as waveformPref.ts does; and the overlay's geometry: the
 * union of the boxes (an even shade, its outline) and the labels, one per box or one per side for
 * All three.
 */

interface Pref {
  safeZoneChoice: () => SafeChoice | 'off'
  setSafeZoneChoice: (v: SafeChoice | 'off') => void
  toggleSafeZones: () => void
  useSafeZoneChoice: () => SafeChoice | 'off'
}
interface Overlay {
  SafeZoneOverlay: (props: { choice: SafeChoice; box: { w: number; h: number } }) => unknown
  zoneUnion: (boxes: readonly SafeBox[]) => { cells: { x: number; y: number; w: number; h: number }[]; edges: { x1: number; y1: number; x2: number; y2: number }[] }
  zoneLabels: (choice: SafeChoice, boxes: readonly SafeBox[]) => { box: SafeBox; side: string; text: string }[]
  ALL_LABEL: string
}

// The boxes zonesFor gives (the table's, every platform's for All three).
vi.mock('../src/shared/render/safeZones', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/shared/render/safeZones')>()
  const zonesFor = (c: SafeChoice): SafeBox[] => (c === 'all' ? (Object.keys(m.SAFE_ZONES) as SafePlatform[]) : [c]).flatMap((p) => m.SAFE_ZONES[p].boxes.map((b) => ({ ...b })))
  return { ...m, zonesFor }
})

let stored: Map<string, string>
let blocked: boolean
vi.stubGlobal('localStorage', {
  getItem: (k: string) => {
    if (blocked) throw new Error('SecurityError')
    return stored.get(k) ?? null
  },
  setItem: (k: string, v: string) => {
    if (blocked) throw new Error('QuotaExceededError')
    stored.set(k, String(v))
  }
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PREF = '../src/renderer/src/editor/safeZonePref'
const OVERLAY = '../src/renderer/src/editor/SafeZoneOverlay'
/** A fresh copy of the module (its session state reset). */
const loadPref = async (): Promise<Pref> => {
  vi.resetModules()
  return (await import(/* @vite-ignore */ PREF)) as Pref
}

beforeEach(() => {
  stored = new Map()
  blocked = false
})

describe('safe-zone preference (test 57)', () => {
  it('is off when nothing or something unknown is stored', async () => {
    const pref = await loadPref()
    expect(pref.safeZoneChoice()).toBe('off')
    for (const v of ['on', 'true', '', 'TikTok', 'all ', '{"x":1}']) {
      stored.set('editor-safe-zones', v)
      expect(pref.safeZoneChoice(), v).toBe('off')
    }
  })

  it('reads and stores each choice under editor-safe-zones', async () => {
    const pref = await loadPref()
    for (const v of ['all', 'tiktok', 'reels', 'shorts', 'off'] as const) {
      pref.setSafeZoneChoice(v)
      expect(stored.get('editor-safe-zones')).toBe(v)
      expect(pref.safeZoneChoice()).toBe(v)
    }
    stored.set('editor-safe-zones', 'reels')
    expect((await loadPref()).safeZoneChoice()).toBe('reels')
  })

  it('never stores an unknown value', async () => {
    const pref = await loadPref()
    pref.setSafeZoneChoice('phone' as SafeChoice)
    expect(stored.get('editor-safe-zones')).toBe('off')
  })

  it('blocked storage reads as off and keeps a choice for the session', async () => {
    blocked = true
    const pref = await loadPref()
    expect(pref.safeZoneChoice()).toBe('off')
    pref.setSafeZoneChoice('shorts')
    expect(pref.safeZoneChoice()).toBe('shorts')
    // Stored again once storage works: the stored value wins.
    blocked = false
    pref.setSafeZoneChoice('tiktok')
    expect(stored.get('editor-safe-zones')).toBe('tiktok')
    stored.set('editor-safe-zones', 'reels')
    expect(pref.safeZoneChoice()).toBe('reels')
  })

  it('G turns All three on, and back on it shows the app last chosen', async () => {
    const pref = await loadPref()
    pref.toggleSafeZones()
    expect(pref.safeZoneChoice()).toBe('all')
    pref.setSafeZoneChoice('reels')
    pref.toggleSafeZones()
    expect(pref.safeZoneChoice()).toBe('off')
    pref.toggleSafeZones()
    expect(pref.safeZoneChoice()).toBe('reels')
    // Stored by an earlier session: G off and on keeps it.
    stored.set('editor-safe-zones', 'shorts')
    const next = await loadPref()
    next.toggleSafeZones()
    next.toggleSafeZones()
    expect(next.safeZoneChoice()).toBe('shorts')
  })

  it('tells its subscribers (useSafeZoneChoice) when it changes', async () => {
    let subscribe: ((l: () => void) => () => void) | null = null
    vi.doMock('react', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      useSyncExternalStore: (s: (l: () => void) => () => void, get: () => unknown) => {
        subscribe = s
        return get()
      }
    }))
    const pref = await loadPref()
    expect(pref.useSafeZoneChoice()).toBe('off')
    const heard = vi.fn()
    const off = subscribe!(heard)
    pref.setSafeZoneChoice('tiktok')
    expect(heard).toHaveBeenCalledTimes(1)
    expect(pref.useSafeZoneChoice()).toBe('tiktok')
    off()
    pref.setSafeZoneChoice('off')
    expect(heard).toHaveBeenCalledTimes(1)
    vi.doUnmock('react')
  })
})

describe('safe-zone overlay geometry', async () => {
  const { SafeZoneOverlay, zoneUnion, zoneLabels, ALL_LABEL } = (await import(/* @vite-ignore */ OVERLAY)) as Overlay
  const all = (Object.keys(SAFE_ZONES) as SafePlatform[]).flatMap((p) => [...SAFE_ZONES[p].boxes])
  const covered = (cells: { x: number; y: number; w: number; h: number }[], x: number, y: number): number =>
    cells.filter((c) => x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h).length

  it('covers exactly the union of the boxes, each point once (an even shade)', () => {
    for (const boxes of [all, [...SAFE_ZONES.tiktok.boxes], [...SAFE_ZONES.shorts.boxes]]) {
      const { cells } = zoneUnion(boxes)
      for (let i = 0; i < 2000; i++) {
        const x = ((i * 0.6180339887) % 1) * 0.998 + 0.001
        const y = ((i * 0.7548776662) % 1) * 0.998 + 0.001
        const inside = boxes.some((b) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h)
        const onEdge = boxes.some((b) => [b.x, b.x + b.w].some((v) => Math.abs(v - x) < 1e-6) || [b.y, b.y + b.h].some((v) => Math.abs(v - y) < 1e-6))
        if (!onEdge) expect(covered(cells, x, y), `${x}, ${y}`).toBe(inside ? 1 : 0)
      }
    }
  })

  it('outlines the union inside the frame: the deepest top bar, not the shallower ones inside it', () => {
    const { edges } = zoneUnion(all)
    const horizontal = edges.filter((e) => e.y1 === e.y2)
    // The top bars of all three end at 0.11 (Reels); 0.08 (TikTok, Shorts) lies inside the union.
    expect(horizontal.some((e) => e.y1 === 0.11 && e.x1 < 0.5 && e.x2 > 0.5 - 1e-9)).toBe(true)
    expect(horizontal.some((e) => e.y1 === 0.08)).toBe(false)
    // The bottom zones start at 0.78; none of the frame's own border is drawn.
    expect(horizontal.some((e) => e.y1 === 0.78)).toBe(true)
    expect(edges.every((e) => !(e.x1 === e.x2 && (e.x1 === 0 || e.x1 === 1)) && !(e.y1 === e.y2 && (e.y1 === 0 || e.y1 === 1)))).toBe(true)
    // The button columns' left edge: TikTok and Shorts at 0.86.
    expect(edges.some((e) => e.x1 === 0.86 && e.x2 === 0.86)).toBe(true)
  })

  it('labels each box of one app, and each side once for All three', () => {
    expect(zoneLabels('tiktok', SAFE_ZONES.tiktok.boxes).map((l) => [l.side, l.text])).toEqual([
      ['top', 'Tabs and search'],
      ['right', 'Like, comment, share'],
      ['bottom', 'Name, caption and sound']
    ])
    const labels = zoneLabels('all', all)
    expect(ALL_LABEL).toBe('Buttons and captions (all three)')
    expect(labels.map((l) => l.side).sort()).toEqual(['bottom', 'right', 'top'])
    expect(labels.every((l) => l.text === ALL_LABEL)).toBe(true)
  })

  it('is DOM over the preview: aria-hidden, one element per box, labels as chips', () => {
    interface El {
      type: unknown
      props: Record<string, unknown>
    }
    const flat = (node: unknown, out: El[] = []): El[] => {
      if (Array.isArray(node)) node.forEach((n) => flat(n, out))
      else if (node && typeof node === 'object' && 'props' in node) {
        out.push(node as El)
        flat((node as El).props.children, out)
      }
      return out
    }
    const text = (node: unknown): string =>
      typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'props' in node ? text((node as El).props.children) : ''
    const root = SafeZoneOverlay({ choice: 'all', box: { w: 405, h: 720 } }) as El
    expect(root.props).toMatchObject({ 'data-testid': 'safe-zones', 'data-platform': 'all', 'aria-hidden': 'true' })
    const els = flat(root)
    const boxes = els.filter((e) => e.props.className === 'safe-zone-box')
    expect(boxes).toHaveLength(9)
    // TikTok's like column: x 0.86, y 0.38 of a 405 × 720 preview.
    expect(boxes[1].props.style).toEqual({ left: 0.86 * 405, top: 0.38 * 720, width: 0.14 * 405, height: 0.42 * 720 })
    expect(els.filter((e) => e.props.className === 'safe-zone-chip').map(text)).toEqual([ALL_LABEL, ALL_LABEL, ALL_LABEL])
    // Nothing is a canvas: the overlay can never reach an export.
    expect(els.some((e) => e.type === 'canvas')).toBe(false)
    const tiktok = flat(SafeZoneOverlay({ choice: 'tiktok', box: { w: 405, h: 720 } }))
    expect(tiktok.filter((e) => e.props.className === 'safe-zone-box')).toHaveLength(3)
    expect(tiktok.filter((e) => e.props.className === 'safe-zone-chip').map(text)).toEqual(['Tabs and search', 'Like, comment, share', 'Name, caption and sound'])
  })
})
