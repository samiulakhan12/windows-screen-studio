import type { CaptionObstacles, StudioChunk, StudioFace, StudioLayout, StudioMeasure, StudioWordBox } from '../src/shared/captions/studioLayout'
import type { ChunkPose, MarkBox, WordPose } from '../src/shared/captions/motion'
import type { StudioToken } from '../src/shared/captions/words'
import type { Rect } from '../src/shared/engine/layout'
import type { CaptionSegment, CaptionStudio, CounterGraphic, Project, StudioPosition } from '../src/shared/types'

/*
 * Hand-made stand-ins for the Captions Studio parts the drawing calls before those parts land
 * (docs/design/captions-studio.md §14.2: P2 tests its layers with vi.mock of motion.ts,
 * studioLayout.ts, replaced.ts and captionTracks.ts returning hand-made values). Each is small and
 * plain, so a test reads what the layer does with the values, not how the engine computes them;
 * `hooks` lets a test set the poses, the replaced words, the burned-in captions or a caption's
 * place for one frame.
 */

export interface Call {
  canvas: number
  name: string
  args: unknown[]
  font: unknown
  fill: unknown
  alpha: unknown
  /** The canvas's transform when the call was made: a, b, c, d, e, f. */
  matrix: number[]
}

export const calls: Call[] = []
/** Every property set on any canvas context (`filter` included): canvas id and name. */
export const sets: { canvas: number; name: string; value: unknown }[] = []
let canvases = 0

type M = [number, number, number, number, number, number]
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]

/** A canvas whose 2D context records its calls with the state they draw with (transform included). */
export function canvas(w = 300, h = 150): Record<string, unknown> & { id: number } {
  const id = ++canvases
  const c: Record<string, unknown> & { id: number } = { width: w, height: h, id }
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 }
  let matrix: M = [1, 0, 0, 1, 0, 0]
  const stack: { m: M; s: Record<string | symbol, unknown> }[] = []
  const ops: Record<string, (...a: number[]) => void> = {
    translate: (x, y) => void (matrix = mul(matrix, [1, 0, 0, 1, x, y])),
    scale: (x, y) => void (matrix = mul(matrix, [x, 0, 0, y, 0, 0])),
    rotate: (r) => void (matrix = mul(matrix, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])),
    transform: (a, b, cc, d, e, f) => void (matrix = mul(matrix, [a, b, cc, d, e, f])),
    setTransform: (a, b, cc, d, e, f) => void (matrix = [a, b, cc, d, e, f])
  }
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      // 10 units a character at 100 px, a narrow "1" (5): digits differ in width, as in most fonts.
      if (prop === 'measureText') return (text: string) => ({ width: [...String(text)].reduce((a, ch) => a + (ch === '1' ? 5 : 10), 0) * (parseFloat(String(target.font ?? '').split(' ')[1]) / 100 || 1), actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: matrix[0], b: matrix[1], c: matrix[2], d: matrix[3], e: matrix[4], f: matrix[5] })
      if (prop === 'getImageData')
        return (...args: number[]) => {
          calls.push({ canvas: id, name: 'getImageData', args, font: target.font, fill: target.fillStyle, alpha: target.globalAlpha, matrix: [...matrix] })
          return { data: new Uint8ClampedArray(Math.max(0, args[2] * args[3] * 4)) }
        }
      return (...args: unknown[]) => {
        if (prop === 'save') stack.push({ m: matrix, s: { ...target } })
        if (prop === 'restore') {
          const top = stack.pop()
          if (top) {
            matrix = top.m
            for (const k of Object.keys(target)) delete target[k]
            Object.assign(target, top.s)
          }
        }
        const op = ops[String(prop)]
        if (op) op(...(args as number[]))
        calls.push({ canvas: id, name: String(prop), args, font: target.font, fill: target.fillStyle, alpha: target.globalAlpha, matrix: [...matrix] })
      }
    },
    set(target, prop, value) {
      target[prop] = value
      sets.push({ canvas: id, name: String(prop), value })
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  return c
}

/** The 2D context of a recording canvas. */
export const contextOf = (c: Record<string, unknown>): never => (c.getContext as (t: string) => never)("2d")

/** The text each sprite canvas was painted with (fillText and strokeText calls by canvas). */
export function spriteTexts(): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const c of calls) if (c.name === 'fillText' || c.name === 'strokeText') out.set(c.canvas, [...(out.get(c.canvas) ?? []), String(c.args[0])])
  return out
}

/* ---------- what the tests steer ---------- */

export const hooks: {
  /** The poses of a frame (else identity, with the spoken mark on the word being spoken). */
  poses?: (layout: StudioLayout, chunk: number, t: number) => { chunk: ChunkPose; words: WordPose[]; mark: MarkBox | null; out?: { chunk: number; pose: ChunkPose } }
  replaced?: (project: Project, t: number) => { captions: ReadonlySet<string>; chunks: readonly { caption: string; word: number }[] }
  burned?: (project: Project) => readonly CaptionSegment[]
  place?: (project: Project, caption: string, position: 'top' | 'middle' | 'bottom') => 'top' | 'middle' | 'bottom'
  /** Recorded calls of the fakes. */
  log: { name: string; args: unknown[] }[]
} = { log: [] }

export const IDLE_CHUNK: ChunkPose = { alpha: 1, dx: 0, dy: 0, scale: 1, scaleX: 1, rotate: 0, blur: 0, reveal: 1 }
export const idleWord = (token: number): WordPose => ({ token, dx: 0, dy: 0, scale: 1, scaleX: 1, rotate: 0, alpha: 1, blur: 0, reveal: 1, fill: 0, weight: 0, mark: 0 })

/* ---------- words.ts ---------- */

export const fakeWords = {
  scriptsIn: () => new Set(['latin']),
  prefixDrawsSame: () => true,
  scriptOf: (text: string) => (/\p{Script=Bengali}/u.test(text) ? 'bengali' : 'latin'),
  mainScript: () => ({ script: 'latin', share: 1 }),
  studioTokens: () => []
}

/* ---------- fontStack.ts ---------- */

export const fakeFontStack = {
  wordFace: (studio: CaptionStudio, role: 'text' | 'emphasis', script: string): StudioFace => {
    const font = role === 'emphasis' ? (studio.emphasis.font ?? studio.text.font) : studio.text.font
    const bn = script === 'bengali' ? studio.text.scripts?.bengali : undefined
    return { stack: `"FlownCat-${(bn?.font ?? font).replace('cat:', '')}"`, weight: bn?.weight ?? (role === 'emphasis' ? studio.emphasis.weight : studio.text.weight), tracking: studio.text.tracking }
  },
  clampWeight: (_font: string, weight: number) => weight,
  studioFontStack: () => '"FlownCat-inter-tight"',
  coverageNeeded: () => [],
  partnerFor: (f: string) => f,
  scriptLineHeight: (_s: string, l: number) => l,
  trackingFor: (_s: string, t: number) => t
}

/* ---------- colors.ts ---------- */

export const fakeColors = {
  textOn: (bg: string) => (bg.toLowerCase() === '#ffffff' || bg.toLowerCase() === '#ffe14d' ? '#111111' : '#ffffff'),
  speakerColors: (_s: CaptionStudio, n: number) => ['#ffffff', '#5ce1e6', '#ffe14d'].slice(0, n),
  contrastRatio: () => 21,
  over: (c: string) => c,
  staticContrast: () => ({ worst: 21, colour: '#ffffff', against: '#000000' }),
  measuredContrast: () => 21,
  contrastFix: (s: CaptionStudio) => s,
  withTheme: (s: CaptionStudio) => s,
  brandTheme: () => null
}

/* ---------- marks.ts ---------- */

export const fakeMarks = {
  marksByCaption: (marks: readonly { caption: string }[] | undefined) => {
    const m = new Map<string, unknown[]>()
    for (const k of marks ?? []) m.set(k.caption, [...(m.get(k.caption) ?? []), k])
    return m
  }
}

/* ---------- studioLayout.ts: one line per chunk, `words` words a chunk ---------- */

const tall = (w: number, h: number): boolean => h >= 1.25 * w

export const fakeStudioLayout = {
  studioMetrics: (studio: CaptionStudio, w: number, h: number) => {
    const px = studio.text.size * (tall(w, h) ? studio.text.tall : 1) * Math.min(w, h)
    return { px, lineHeight: px * studio.text.lineHeight, maxWidth: w * 0.84, maxChars: 40, tall: tall(w, h) }
  },
  studioLayout: (
    seg: CaptionSegment,
    studio: CaptionStudio,
    w: number,
    h: number,
    measure: StudioMeasure,
    opts: { faceOf: (t: StudioToken, role: 'text' | 'emphasis') => StudioFace; marks?: readonly { from: number; to: number; tone?: 2 }[]; showSpeaker?: boolean }
  ): StudioLayout => {
    hooks.log.push({ name: 'studioLayout', args: [seg.id, w, h] })
    const px = studio.text.size * (tall(w, h) ? studio.text.tall : 1) * Math.min(w, h)
    const texts = seg.text.split(/\s+/).filter(Boolean)
    const span = (seg.end - seg.start) / Math.max(1, texts.length)
    const tokens: StudioToken[] = texts.map((text, i) => {
      const word = seg.words?.[i]
      return { text: studio.text.case === 'upper' ? text.toUpperCase() : text, start: word ? word.start : seg.start + i * span, end: word ? word.end : seg.start + (i + 1) * span, word: i, gap: i > 0, dir: 'l', script: /\p{Script=Bengali}/u.test(text) ? 'bengali' : 'latin' }
    })
    const emphasis = tokens.map((t) => {
      const m = opts.marks?.find((k) => t.word >= k.from && t.word <= k.to)
      return (m ? (m.tone === 2 ? 2 : 1) : 0) as 0 | 1 | 2
    })
    const per = studio.layout.chunk === 'phrase' ? tokens.length : Math.max(1, studio.layout.words)
    const chunks: StudioChunk[] = []
    for (let i = 0; i < tokens.length; i += per) {
      const words: StudioWordBox[] = []
      let x = 0
      for (let k = i; k < Math.min(tokens.length, i + per); k++) {
        const role = emphasis[k] ? 'emphasis' : 'text'
        const face = opts.faceOf(tokens[k], role)
        const size = emphasis[k] ? px * studio.emphasis.scale : px
        if (k > i) x += measure(' ', size, face)
        const wd = measure(tokens[k].text, size, face)
        words.push({ token: k, text: tokens[k].text, x, w: wd, px: size, face, role, ...(emphasis[k] === 2 ? { tone: 2 as const } : {}) })
        x += wd
      }
      const height = px * studio.text.lineHeight
      chunks.push({ start: tokens[i].start, end: 0, lines: [{ words, width: x, height, px }], first: i, last: Math.min(tokens.length, i + per) - 1, width: x, height })
    }
    chunks.forEach((c, i) => {
      c.start = i === 0 ? seg.start : c.start
      c.end = i + 1 < chunks.length ? chunks[i + 1].start : seg.end
    })
    return { tokens, chunks, px, lineHeight: px * studio.text.lineHeight, rtl: false, dirs: tokens.map(() => 'l'), emphasis }
  },
  breakPhrases: () => [],
  studioChunkAt: (layout: StudioLayout, t: number): number => {
    let i = -1
    layout.chunks.forEach((c, k) => {
      if (c.start <= t) i = k
    })
    return i
  },
  /** §8.5's anchors (no obstacles), and the edge of §8.5 for key presses. */
  placeStudio: (layout: StudioLayout, chunk: StudioChunk, studio: CaptionStudio, w: number, h: number, opts: { forced?: 'top' | 'bottom' }) => {
    hooks.log.push({ name: 'placeStudio', args: [chunk.first, opts.forced ?? null] })
    const u = Math.min(w, h)
    const isTall = tall(w, h)
    const height = chunk.lines.reduce((a, l) => a + l.height, 0)
    const position: StudioPosition = opts.forced ?? studio.layout.position
    let top: number
    if (position === 'top') top = isTall ? 0.13 * h : 0.06 * u
    else if (position === 'upper') top = (isTall ? 0.3 : 0.25) * h - height / 2
    else if (position === 'middle') top = (isTall ? 0.45 : 0.5) * h - height / 2
    else if (position === 'lower') top = (isTall ? 0.66 : 0.8) * h - height / 2
    else top = (isTall ? 0.74 * h : h - 0.075 * u) - height
    let y = top
    const lines = chunk.lines.map((l) => {
      const out = { x: (w - l.width) / 2, y: y + l.height / 2, width: l.width }
      y += l.height
      return out
    })
    const padX = studio.box.kind === 'none' ? 0 : studio.box.padX * layout.px
    const padY = studio.box.kind === 'none' ? 0 : studio.box.padY * layout.px
    const box = { x: (w - chunk.width) / 2 - padX, y: top - padY, w: chunk.width + padX * 2, h: height + padY * 2 }
    const edge: 'top' | 'middle' | 'bottom' = position === 'top' || position === 'upper' ? 'top' : position === 'middle' ? 'middle' : 'bottom'
    return { lines, top, height, box, edge }
  },
  captionObstacles: (_p: Project, _s: CaptionSegment, _w: number, _h: number, given: { titles: readonly { box: Rect }[]; keys: Rect | null; action: readonly { t: number; rect: Rect }[] }): CaptionObstacles => ({
    camera: [],
    titles: given.titles.map((t) => t.box),
    keys: given.keys,
    action: given.action
  }),
  blockEdge: (position: StudioPosition | null) => (position === 'top' || position === 'upper' ? 'top' : position === 'middle' || !position ? 'middle' : 'bottom')
}

/* ---------- motion.ts ---------- */

export const fakeMotion = {
  EASE: { out: (p: number) => 1 - (1 - p) ** 3, outQuart: (p: number) => 1 - (1 - p) ** 4, inCubic: (p: number) => p ** 3, outExpo: (p: number) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)), emphDecel: (p: number) => p, emphAccel: (p: number) => p },
  back: (p: number) => p,
  spring: (p: number) => p,
  seedOf: (key: string) => {
    let h = 0x811c9dc5
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
    return h
  },
  clipsKey: (clips: readonly { start: number; end: number; speed: number }[]) => clips.map((c) => `${c.start}-${c.end}-${c.speed}`).join(','),
  captionPoses: (layout: StudioLayout, chunk: number, t: number, _clips: unknown, studio: CaptionStudio) => {
    hooks.log.push({ name: 'captionPoses', args: [chunk, t] })
    if (hooks.poses) return hooks.poses(layout, chunk, t)
    const c = layout.chunks[chunk]
    let spoken = -1
    for (let i = c.first; i <= c.last; i++) if (layout.tokens[i].start <= t) spoken = i
    // As motion.ts defines `fill`: the sweep for the fill and gradient marks (spoken words stay
    // filled), else the spoken colour's crossfade share (the word being spoken only).
    const sweep = studio.spoken === 'fill' || studio.spoken === 'gradient'
    const fill = (i: number): number => (sweep ? (i < spoken ? 1 : i === spoken ? 0.5 : 0) : i === spoken ? 1 : 0)
    return { chunk: IDLE_CHUNK, words: Array.from({ length: c.last - c.first + 1 }, (_, k) => ({ ...idleWord(c.first + k), fill: fill(c.first + k) })), mark: null }
  },
  itemPose: (start: number, end: number, t: number) => {
    hooks.log.push({ name: 'itemPose', args: [start, end, t] })
    return t >= start && t < end ? IDLE_CHUNK : null
  },
  counterValue: (g: CounterGraphic, t: number) => {
    hooks.log.push({ name: 'counterValue', args: [g.id, t] })
    return g.from + (g.to - g.from) * Math.max(0, Math.min(1, (t - g.start) / g.countFor))
  },
  listWindows: (g: { start: number; end: number }) => [{ start: g.start, end: g.end }],
  calmed: (m: unknown) => m,
  flashSafeChunks: (layout: StudioLayout) => layout,
  typewriterClip: (word: { graphemes: number; width: number }, k: number) => (word.width * k) / Math.max(1, word.graphemes)
}

/* ---------- replaced.ts, captionTracks.ts ---------- */

const NOTHING = { captions: new Set<string>(), chunks: [] }
export const fakeReplaced = {
  replacedAt: (project: Project, t: number) => (hooks.replaced ? hooks.replaced(project, t) : NOTHING)
}

/** The real identity paths (`real`: the module itself, from vi.mock's importOriginal), with the hooks' values when a test sets them. */
export function fakeCaptionTracks(real: typeof import('../src/shared/captions/captionTracks')): Record<string, unknown> {
  return {
    ...real,
    burnedSegments: (project: Project) => {
      const out = hooks.burned ? hooks.burned(project) : real.burnedSegments(project)
      hooks.log.push({ name: 'burnedSegments', args: [project, out] })
      return out
    },
    placeOf: (project: Project, caption: string, position: 'top' | 'middle' | 'bottom') => {
      const out = hooks.place ? hooks.place(project, caption, position) : real.placeOf(project, caption, position)
      hooks.log.push({ name: 'placeOf', args: [caption, position, out] })
      return out
    }
  }
}

/* ---------- actionRects.ts, graphics.ts ---------- */

export const fakeActionRects = {
  actionRects: (...args: unknown[]) => {
    hooks.log.push({ name: 'actionRects', args })
    return []
  }
}

export const fakeGraphics = (real: typeof import('../src/shared/render/graphics')): Record<string, unknown> => {
  return {
    ...real,
    graphicCandidates: (_kind: string, w: number, h: number, _avoid: unknown, replacing?: Rect) => (replacing ? [{ x: replacing.x + replacing.w / 2, y: replacing.y + replacing.h / 2 }] : [{ x: w * 0.5, y: h * 0.3 }]),
    placeGraphic: (_box: unknown, candidates: readonly { x: number; y: number }[]) => {
      hooks.log.push({ name: 'placeGraphic', args: [candidates[0]] })
      return { ...candidates[0], scale: 1 }
    },
    counterText: (g: CounterGraphic, value: number) => {
      const n = value.toFixed(g.decimals)
      return { text: `${g.prefix}${n}${g.suffix}`, cells: n.replace(/\D/g, '').length }
    }
  }
}

/* ---------- a frame ---------- */

/** A frame context for a layer, on a recording canvas of the frame's size. */
export function frameOf(project: Project, t: number, w = 1920, h = 1080, extra: Record<string, unknown> = {}): { fc: never; id: number } {
  const c = canvas(w, h)
  const fc = {
    ctx: contextOf(c),
    w,
    h,
    t,
    k: Math.min(w, h) / 1080,
    scene: { project },
    project,
    cursor: { valid: false, samples: [], clicks: [] },
    focus: null,
    vw: w,
    vh: h,
    rect: { x: 0, y: 0, w, h },
    radius: 0,
    cam: { scale: 1, x: 0.5, y: 0.5 },
    layout: { screen: { x: 0, y: 0, w, h }, camera: null, moving: false },
    following: false,
    textArea: null,
    fxGain: 1,
    screen: null,
    toOut: (x: number, y: number) => ({ x: x * w, y: y * h }),
    ...extra
  }
  return { fc: fc as never, id: c.id }
}
