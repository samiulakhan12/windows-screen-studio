/**
 * Motion graphics on the video (docs/design/captions-studio.md §10): keyword pop-ups, emoji,
 * number counters and list cards, drawn after annotations and before captions, on the captions'
 * clock (fc.t is the sound time in a continue freeze, §9.1 rule 6), so an emoji stays with its
 * word and a counter keeps counting with the speech.
 *
 * Poses come from the motion engine (itemPose, counterValue, listWindows: pure functions of time).
 * A graphic placed automatically is placed once per graphic, frame size, caption layout, camera,
 * action and clips (placeGraphic), so it never moves while it shows; a dragged one stays where the
 * user put it. Cards, emoji and texts are sprites in the Studio LRU; a counter's digits are drawn
 * live in fixed cells. Nothing is drawn, and nothing is called on the frame, without graphics.
 */
import { burnedSegments } from '../../../shared/captions/captionTracks'
import { textOn } from '../../../shared/captions/colors'
import { emojiEntry } from '../../../shared/captions/emojiList'
import { catalogFamily, catalogId } from '../../../shared/captions/fontCatalog'
import { clampWeight } from '../../../shared/captions/fontStack'
import { CAPTION_FONT, captionIndexAt, viewAt } from '../../../shared/captions/layout'
import { clipsKey, counterValue, EASE, itemPose, listWindows, seedOf, type ChunkPose } from '../../../shared/captions/motion'
import { captionObstacles } from '../../../shared/captions/studioLayout'
import { STUDIO_BASE } from '../../../shared/captions/studioPresets'
import type { Rect } from '../../../shared/engine/layout'
import { isTall } from '../../../shared/engine/reframeData'
import { DEFAULT_ZOOM_SETTINGS } from '../../../shared/engine/zoom'
import { actionRects } from '../../../shared/render/actionRects'
import { counterText, GRAPHIC_DEFAULTS, graphicCandidates, placeGraphic } from '../../../shared/render/graphics'
import { graphicDrawn } from '../../../shared/render/popSound'
import { fontOf } from '../../../shared/render/fonts'
import type { CaptionStudio, CounterGraphic, Graphic, KeywordGraphic, ListGraphic, Project } from '../../../shared/types'
import { captionBlockAt } from './captionsLayer'
import { ensureCaptionFonts, fontGeneration, studioBrandFamily } from './fontLoader'
import type { FrameContext } from './frameContext'
import { studioWordPlace } from './studioLayer'
import { STUDIO_SPRITES } from './wordSprites'

type Ctx = CanvasRenderingContext2D

/* ---------- fonts and colours ---------- */

/** After a graphic's font: the bundled script fonts and the colour emoji face (§6.6), then the caption font. */
const FALLBACK = ['noto-sans-bengali', 'noto-sans-devanagari', 'noto-sans-arabic', 'noto-sans-hebrew', 'noto-sans-thai', 'noto-color-emoji'].map((id) => `"${catalogFamily(id)}"`).join(', ')

/** The look graphics take their font and colours from: the Studio look, else Subtitle's. */
const lookOf = (project: Project): CaptionStudio => project.captions?.studio ?? (STUDIO_BASE as CaptionStudio)

/** A graphic's font reference: its own, else the look's text font. */
const fontRef = (project: Project, g: Graphic): string => g.font ?? lookOf(project).text.font

/** The canvas font stack of a font reference: a catalogue font, a brand font (FlownFontW-, §6.7), else the caption font. */
function stackOf(project: Project, ref: string): string {
  const cat = catalogId(ref)
  if (cat) return `"${catalogFamily(cat)}", ${FALLBACK}, ${CAPTION_FONT}`
  if (fontOf(project.fonts, ref)) return `"${studioBrandFamily(ref)}", ${FALLBACK}, ${CAPTION_FONT}`
  return `${FALLBACK}, ${CAPTION_FONT}`
}

/** A weight the font has (§6.5): clamped for catalogue fonts. */
const weightOf = (ref: string, weight: number): number => (catalogId(ref) ? clampWeight(ref, weight) : weight)

const rgba = (hex: string, alpha: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${+Math.max(0, Math.min(1, alpha)).toFixed(4)})`
}

/** The graphic's text size in px: a fraction of the shorter side, larger in tall frames (§10.1). */
const sizeOf = (g: Graphic, w: number, h: number): number => g.size * Math.min(w, h) * (isTall(w, h) ? GRAPHIC_DEFAULTS[g.kind].tall : 1)

/* ---------- measuring ---------- */

const widths = new Map<string, number>()
function measure(ctx: Ctx, text: string, font: string): number {
  const key = `${fontGeneration()}|${font}|${text}`
  let w = widths.get(key)
  if (w === undefined) {
    ctx.save()
    ctx.font = font
    w = ctx.measureText(text).width
    ctx.restore()
    if (widths.size > 5000) widths.clear()
    widths.set(key, w)
  }
  return w
}

const DIGIT = /\p{Nd}/u

/** A counter's digit cell: as wide as the font's widest digit of its locale (§10.1). */
function cellWidth(ctx: Ctx, font: string, g: CounterGraphic): number {
  const digits = new Set<string>()
  for (let d = 0; d <= 9; d++) for (const ch of counterText(g, d).text) if (DIGIT.test(ch)) digits.add(ch)
  for (const d of '0123456789') digits.add(d)
  let max = 0
  for (const d of digits) max = Math.max(max, measure(ctx, d, font))
  return max
}

/** A counter's text width with its digits in cells. */
function counterWidth(ctx: Ctx, font: string, text: string, cell: number): number {
  let w = 0
  for (const ch of text) w += DIGIT.test(ch) ? cell : measure(ctx, ch, font)
  return w
}

/* ---------- the shapes of the kinds (§10.1) ---------- */

interface Shape {
  /** The graphic's box at rest, centred on the origin, px. */
  w: number
  h: number
  /** Its text size, px. */
  px: number
}

interface ListRow {
  text: string
  at: number
}

/** The list card's metrics: item size, title size, row height, padding and width (§10.1). */
function listMetrics(g: ListGraphic, w: number, h: number): { px: number; titlePx: number; row: number; padX: number; padY: number; width: number; titleH: number } {
  const px = sizeOf(g, w, h)
  const titlePx = px * 1.1
  return { px, titlePx, row: px * 1.7, padX: px * 0.9, padY: px * 0.75, width: (isTall(w, h) ? 0.8 : 0.42) * w, titleH: g.title ? titlePx * 1.6 : 0 }
}

/** The card height of a list showing `n` items. */
const listHeight = (m: ReturnType<typeof listMetrics>, n: number): number => m.padY * 2 + m.titleH + m.row * n

/** The box of a graphic at rest (a list card at its full height, for its place over its whole time). */
function shapeOf(ctx: Ctx, project: Project, g: Graphic, w: number, h: number): Shape {
  const px = sizeOf(g, w, h)
  const look = lookOf(project)
  const ref = fontRef(project, g)
  if (g.kind === 'emoji') return { w: px * 1.25, h: px * 1.25, px }
  if (g.kind === 'keyword') {
    const font = `${weightOf(ref, look.emphasis.weight)} ${px}px ${stackOf(project, ref)}`
    const tw = measure(ctx, keywordText(g, look), font)
    const pad = g.look === 'card' || g.look === 'tag' ? { x: 0.4 * px, y: 0.25 * px } : { x: 0.15 * px, y: 0.1 * px }
    return { w: tw + pad.x * 2, h: px * 1.25 + pad.y * 2, px }
  }
  if (g.kind === 'counter') {
    const font = counterFont(project, g, px)
    const cell = cellWidth(ctx, font, g)
    const tw = Math.max(counterWidth(ctx, font, counterText(g, g.from).text, cell), counterWidth(ctx, font, counterText(g, g.to).text, cell))
    const labelW = g.label ? measure(ctx, g.label.toLocaleUpperCase(), labelFont(project, g, px)) : 0
    return { w: Math.max(tw, labelW) + px * 0.8, h: px * 1.15 + (g.label ? px * 0.45 * 1.6 : 0) + px * 0.5, px }
  }
  const m = listMetrics(g, w, h)
  return { w: m.width, h: listHeight(m, g.items.length), px: m.px }
}

/** A keyword's text: in capitals when the look writes in capitals. */
const keywordText = (g: KeywordGraphic, look: CaptionStudio): string => (look.text.case === 'upper' ? g.text.toLocaleUpperCase() : look.text.case === 'lower' ? g.text.toLocaleLowerCase() : g.text)

const counterFont = (project: Project, g: CounterGraphic, px: number): string => {
  const ref = fontRef(project, g)
  return `${weightOf(ref, 800)} ${px}px ${stackOf(project, ref)}`
}
const labelFont = (project: Project, g: Graphic, px: number): string => {
  const ref = fontRef(project, g)
  return `${weightOf(ref, 700)} ${px * 0.45}px ${stackOf(project, ref)}`
}

/* ---------- where a graphic goes (§10.3) ---------- */

/** The frame each project's graphics were last drawn in (hit tests use its action and camera). */
const frames = new WeakMap<Project, FrameContext>()

interface Placed {
  /** The centre and the placement's shrink. */
  x: number
  y: number
  scale: number
}

const placeCache = new WeakMap<Graphic, { key: string; place: Placed }>()

/** A number per object, for cache keys. */
const ids = new WeakMap<object, number>()
let nextId = 1
const idOf = (o: object | null | undefined): number => {
  if (!o) return 0
  let n = ids.get(o)
  if (n === undefined) ids.set(o, (n = nextId++))
  return n
}

/** The union of rects, or null. */
function union(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The caption blocks shown over [start, end]: at each caption's (and chunk's) start inside it (§10.3 obstacle 1). */
function captionRects(ctx: Ctx, project: Project, start: number, end: number, w: number, h: number, area: Rect | null): Rect[] {
  const segs = burnedSegments(project)
  if (!segs.length || !project.captions?.show) return []
  const times = new Set<number>([start + 1e-3])
  for (const s of segs) if (s.end > start && s.start < end) times.add(Math.max(start, s.start) + 1e-3)
  const out: Rect[] = []
  for (const t of times) {
    if (captionIndexAt(segs, t) < 0) continue
    const block = captionBlockAt(ctx, project, t, w, h, area)
    if (block) out.push({ x: 0, y: block.top, w, h: block.bottom - block.top })
  }
  return out
}

/**
 * Where graphic `g` is centred (§10.3): a dragged one where the user put it (kept inside the
 * frame); else the first free candidate, shrunk, or the least overlap, computed once per graphic,
 * frame size, caption layout, camera, action and clips, so it never moves while it shows.
 */
function placeOf(ctx: Ctx, project: Project, g: Graphic, shape: Shape, w: number, h: number, area: Rect | null, before: readonly { g: Graphic; rect: Rect }[]): Placed {
  if (g.place !== 'auto') {
    const x = Math.max(shape.w / 2, Math.min(w - shape.w / 2, g.place.x * w))
    const y = Math.max(shape.h / 2, Math.min(h - shape.h / 2, g.place.y * h))
    return { x, y, scale: 1 }
  }
  const fc = frames.get(project)
  const withAction = !!fc && fc.w === w && fc.h === h
  const anchorKey = g.kind === 'keyword' || g.kind === 'emoji' ? JSON.stringify(g.anchor ?? null) : ''
  const key = [w, h, area ? `${area.x},${area.y},${area.w},${area.h}` : '', fontGeneration(), clipsKey(project.clips), idOf(project.transcript), idOf(project.captions), idOf(project.captionPlaces), idOf(project.layouts), idOf(project.webcam), withAction ? idOf(fc!.cursor) : 0, anchorKey, before.map((b) => `${b.rect.x | 0},${b.rect.y | 0}`).join(';')].join('|')
  const hit = placeCache.get(g)
  if (hit && hit.key === key) return hit.place
  const seg = { id: `graphic:${g.id}`, start: g.start, end: g.end, text: '' }
  const cam = captionObstacles(project, seg, w, h, { titles: [], keys: null, action: [] }).camera
  const action = withAction ? actionRects(fc!.scene, fc!.cursor.valid ? fc!.cursor : null, project.zoomSettings?.auto ?? DEFAULT_ZOOM_SETTINGS.auto, w, h, fc!.vw, fc!.vh, g.start, g.end, project.clips).map((a) => a.rect) : []
  // A keyword that replaces its chunk takes the chunk's place (§10.1, §10.3).
  const replacing = g.kind === 'keyword' && g.anchor && g.replace !== false ? (studioWordPlace(ctx, project, g.anchor.caption, g.anchor.from, w, h, area)?.block ?? undefined) : undefined
  const candidates = graphicCandidates(g.kind, w, h, { camera: union(cam), action: union(action) }, replacing)
  const inset = 0.06 * Math.min(w, h)
  const room = area ?? { x: inset, y: inset, w: w - inset * 2, h: h - inset * 2 }
  const others = before.filter((b) => b.g.start < g.end && b.g.end > g.start).map((b) => b.rect)
  const captions = replacing ? [] : captionRects(ctx, project, g.start, g.end, w, h, area)
  const place = placeGraphic({ w: shape.w, h: shape.h }, candidates, room, { captions, camera: cam, action, safe: [], graphics: others })
  placeCache.set(g, { key, place })
  return place
}

/* ---------- what shows at t ---------- */

interface Shown {
  g: Graphic
  shape: Shape
  place: Placed
  pose: ChunkPose
  /** The window it shows in (a list card's current one). */
  start: number
  end: number
}

/** The window of `g` showing at `t` (a list card's windows, §10.1), or null. */
function windowAt(g: Graphic, t: number, project: Project): { start: number; end: number } | null {
  if (g.kind === 'list') {
    for (const win of listWindows(g, project.clips)) if (t >= win.start && t < win.end) return win
    return null
  }
  return t >= g.start && t < g.end ? { start: g.start, end: g.end } : null
}

/** Every graphic's shape and place, in order (each keeps clear of those placed before it), once per graphics, frame and what placement reads. */
const placements = new WeakMap<readonly Graphic[], { key: string; map: Map<Graphic, { shape: Shape; place: Placed }> }>()
function placementsOf(ctx: Ctx, project: Project, w: number, h: number, area: Rect | null): Map<Graphic, { shape: Shape; place: Placed }> {
  const graphics = project.graphics ?? []
  const fc = frames.get(project)
  const key = [w, h, area ? `${area.x},${area.y},${area.w},${area.h}` : '', fontGeneration(), clipsKey(project.clips), idOf(project.transcript), idOf(project.captions), idOf(project.captionPlaces), idOf(project.layouts), idOf(project.webcam), idOf(project.fonts), fc && fc.w === w && fc.h === h ? idOf(fc.cursor) : 0].join('|')
  const hit = placements.get(graphics)
  if (hit && hit.key === key) return hit.map
  const map = new Map<Graphic, { shape: Shape; place: Placed }>()
  const before: { g: Graphic; rect: Rect }[] = []
  for (const g of graphics) {
    if (!graphicDrawn(project, g)) continue
    const shape = shapeOf(ctx, project, g, w, h)
    const place = placeOf(ctx, project, g, shape, w, h, area, before)
    map.set(g, { shape, place })
    before.push({ g, rect: { x: place.x - (shape.w * place.scale) / 2, y: place.y - (shape.h * place.scale) / 2, w: shape.w * place.scale, h: shape.h * place.scale } })
  }
  placements.set(graphics, { key, map })
  return map
}

/** The graphics showing at `t`, placed, with their poses, in drawing order. */
function graphicsAt(ctx: Ctx, project: Project, t: number, w: number, h: number, area: Rect | null): Shown[] {
  const graphics = project.graphics
  if (!graphics?.length) return []
  const calm = !!project.captions?.studio?.motion.calm
  const u = Math.min(w, h)
  const out: Shown[] = []
  let placed: Map<Graphic, { shape: Shape; place: Placed }> | null = null
  for (const g of graphics) {
    if (!graphicDrawn(project, g)) continue
    const win = windowAt(g, t, project)
    if (!win) continue
    const pose = itemPose(win.start, win.end, t, project.clips, g.enter, g.exit, u, calm)
    if (!pose || pose.alpha <= 0.002) continue
    placed ??= placementsOf(ctx, project, w, h, area)
    const p = placed.get(g)
    if (p) out.push({ g, shape: p.shape, place: p.place, pose, start: win.start, end: win.end })
  }
  return out
}

/** Where each graphic shows at `t` (hit tests in the preview): its box at rest, placed. */
export function graphicRects(ctx: CanvasRenderingContext2D, project: Project, t: number, w: number, h: number): { id: string; rect: Rect }[] {
  const area = frames.get(project)?.textArea ?? null
  return graphicsAt(ctx, project, t, w, h, area).map((s) => {
    const sw = s.shape.w * s.place.scale
    const sh = s.shape.h * s.place.scale
    return { id: s.g.id, rect: { x: s.place.x - sw / 2, y: s.place.y - sh / 2, w: sw, h: sh } }
  })
}

/* ---------- drawing ---------- */

/** A sprite of `w` x `h` (centred on the origin when painted), cached by its key. */
function sprite(key: string, w: number, h: number, pad: number, paint: (c: Ctx) => void): { canvas: HTMLCanvasElement; ox: number; oy: number } | null {
  const cw = Math.ceil(w + pad * 2)
  const ch = Math.ceil(h + pad * 2)
  const canvas = STUDIO_SPRITES.get(`graphic|${fontGeneration()}|${key}`, cw, ch, (c) => {
    c.translate(cw / 2, ch / 2)
    paint(c)
  })
  return canvas ? { canvas, ox: cw / 2, oy: ch / 2 } : null
}

/** A card's soft shadow (§10.1 cards: 0 0.22 em 0.55 em at α 0.45, as the mock-ups' cards). */
const cardShadow = (c: Ctx, px: number): void => {
  c.shadowColor = 'rgba(0, 0, 0, 0.45)'
  c.shadowBlur = px * 0.55
  c.shadowOffsetY = px * 0.22
}

/** Draws a graphic with its pose around its place. */
function drawShown(c: Ctx, project: Project, s: Shown, t: number, w: number, h: number, area: Rect | null): void {
  const { g, place, pose } = s
  c.save()
  c.globalAlpha *= pose.alpha
  let cx = place.x
  let cy = place.y
  if (g.kind === 'emoji' && g.anchor) {
    // Above its word while that word's chunk shows (§10.3); free otherwise.
    const at = studioWordPlace(c, project, g.anchor.caption, g.anchor.from, w, h, area)
    if (at && t >= at.start && t < at.end) {
      cx = at.word.x + at.word.w / 2
      cy = at.word.y - 0.15 * at.px - s.shape.h / 2
    }
  }
  if (g.kind === 'emoji' && !project.captions?.studio?.motion.calm && g.enter.strength > 0) {
    // A seeded bob of ±0.04 em at 0.8 Hz while shown (off with calm motion or strength 0).
    const phase = ((seedOf(g.id) % 1000) / 1000) * Math.PI * 2
    cy += Math.sin(2 * Math.PI * 0.8 * (viewAt(project.clips, t) - viewAt(project.clips, s.start)) + phase) * 0.04 * s.shape.px
  }
  c.translate(cx + pose.dx, cy + pose.dy)
  if (pose.rotate) c.rotate((pose.rotate * Math.PI) / 180)
  c.scale(place.scale * pose.scale * pose.scaleX, place.scale * pose.scale)
  if (pose.reveal < 0.999) {
    c.beginPath()
    c.rect(-s.shape.w / 2 - s.shape.px, -s.shape.h, (s.shape.w + 2 * s.shape.px) * Math.max(0, pose.reveal), s.shape.h * 2)
    c.clip()
  }
  if (g.kind === 'keyword') drawKeyword(c, project, g, s.shape)
  else if (g.kind === 'emoji') drawEmoji(c, g, s.shape)
  else if (g.kind === 'counter') drawCounter(c, project, g, s.shape, t)
  else drawList(c, project, g, s, t, w, h)
  c.restore()
}

function drawKeyword(c: Ctx, project: Project, g: KeywordGraphic, shape: Shape): void {
  const look = lookOf(project)
  const theme = look.theme
  const px = shape.px
  const ref = fontRef(project, g)
  const font = `${weightOf(ref, look.emphasis.weight)} ${px}px ${stackOf(project, ref)}`
  const text = keywordText(g, look)
  // Card: the look's box with the emphasis colour; Plain: outlined text; Outline: hollow; Tag: a pill in the spoken colour.
  const box = g.accent ?? (g.look === 'tag' ? theme.spoken : theme.box)
  const ink = g.color ?? (g.look === 'card' ? theme.emphasis : g.look === 'tag' ? (theme.spokenText ?? textOn(box)) : theme.text)
  const key = JSON.stringify([g.look, text, font, box, ink, theme.outline, shape.w, shape.h])
  const sp = sprite(key, shape.w, shape.h, px * 0.8, (k) => {
    k.font = font
    k.textAlign = 'center'
    k.textBaseline = 'middle'
    k.lineJoin = 'round'
    if (g.look === 'card' || g.look === 'tag') {
      k.save()
      cardShadow(k, px)
      k.fillStyle = rgba(box, g.look === 'card' ? 0.85 : 1)
      k.beginPath()
      k.roundRect(-shape.w / 2, -shape.h / 2, shape.w, shape.h, g.look === 'tag' ? shape.h / 2 : Math.min(px * 0.3, shape.h / 2))
      k.fill()
      k.restore()
    }
    if (g.look === 'plain') {
      k.lineWidth = 0.16 * px
      k.strokeStyle = theme.outline
      k.strokeText(text, 0, 0)
    }
    if (g.look === 'outline') {
      k.save()
      k.shadowColor = 'rgba(0, 0, 0, 0.6)'
      k.shadowBlur = 0.1 * px
      k.lineWidth = Math.max(1, 0.07 * px)
      k.strokeStyle = ink
      k.strokeText(text, 0, 0)
      k.restore()
      return
    }
    k.fillStyle = ink
    k.fillText(text, 0, 0)
  })
  if (sp) c.drawImage(sp.canvas, -sp.ox, -sp.oy)
}

function drawEmoji(c: Ctx, g: Graphic & { kind: 'emoji' }, shape: Shape): void {
  const entry = emojiEntry(g.emoji)
  if (!entry) return
  const px = shape.px
  const font = `400 ${px}px "${catalogFamily('noto-color-emoji')}"`
  const sp = sprite(JSON.stringify(['emoji', entry.text, px]), shape.w, shape.h, px * 0.2, (k) => {
    k.font = font
    k.textAlign = 'center'
    k.textBaseline = 'middle'
    k.fillText(entry.text, 0, 0)
  })
  if (sp) c.drawImage(sp.canvas, -sp.ox, -sp.oy)
}

/** A counter (§10.1): the card a sprite, the number live in fixed digit cells, the label under it. */
function drawCounter(c: Ctx, project: Project, g: CounterGraphic, shape: Shape, t: number): void {
  const look = lookOf(project)
  const px = shape.px
  const box = g.accent ?? look.theme.box
  const ink = g.color ?? look.theme.spoken
  const sp = sprite(JSON.stringify(['counter', box, shape.w, shape.h, g.label ?? '', labelFont(project, g, px), look.theme.text]), shape.w, shape.h, px * 0.9, (k) => {
    k.save()
    cardShadow(k, px)
    k.fillStyle = rgba(box, 0.85)
    k.beginPath()
    k.roundRect(-shape.w / 2, -shape.h / 2, shape.w, shape.h, Math.min(px * 0.3, shape.h / 2))
    k.fill()
    k.restore()
    if (g.label) {
      k.font = labelFont(project, g, px)
      k.textAlign = 'center'
      k.textBaseline = 'middle'
      k.letterSpacing = `${(px * 0.45 * 0.15).toFixed(2)}px`
      k.fillStyle = rgba(look.theme.text, 0.7)
      k.fillText(g.label.toLocaleUpperCase(), 0, shape.h / 2 - px * 0.25 - px * 0.45 * 0.8)
    }
  })
  if (sp) c.drawImage(sp.canvas, -sp.ox, -sp.oy)
  const font = counterFont(project, g, px)
  const cell = cellWidth(c, font, g)
  const { text } = counterText(g, counterValue(g, t, project.clips))
  const full = Math.max(counterWidth(c, font, counterText(g, g.to).text, cell), counterWidth(c, font, text, cell))
  const y = -shape.h / 2 + px * 0.25 + px * 0.575
  // Right-aligned in the final number's width, so digits never move as they change.
  let x = full / 2 - counterWidth(c, font, text, cell)
  c.save()
  c.font = font
  c.textBaseline = 'middle'
  c.textAlign = 'center'
  c.fillStyle = ink
  for (const ch of text) {
    const cw = DIGIT.test(ch) ? cell : measure(c, ch, font)
    c.fillText(ch, x + cw / 2, y)
    x += cw
  }
  c.restore()
}

/** A list card (§10.1): the card grows to fit (0.18 s), each item rises in at its time (0.22 s). */
function drawList(c: Ctx, project: Project, g: ListGraphic, s: Shown, t: number, w: number, h: number): void {
  const m = listMetrics(g, w, h)
  const clips = project.clips
  const now = viewAt(clips, t)
  const items: ListRow[] = g.items.filter((i) => i.at <= t + 1e-9)
  const progress = (at: number, d: number): number => Math.max(0, Math.min(1, (now - viewAt(clips, at)) / d))
  // The height eases from the items before the newest to all of them.
  const newest = items.at(-1)
  const grow = newest ? EASE.out(progress(newest.at, 0.18)) : 1
  const height = listHeight(m, Math.max(0, items.length - 1)) + m.row * (items.length ? grow : 0)
  const accent = g.accent ?? '#5b2dff'
  const top = -s.shape.h / 2
  const left = -m.width / 2
  c.save()
  // The card: a light panel (the mock-ups' list card), its height growing; a sprite per height in whole px.
  const ch = Math.max(m.padY * 2, Math.round(height))
  const card = sprite(JSON.stringify(['list-card', m.width, ch]), m.width, ch, m.px * 0.9, (k) => {
    cardShadow(k, m.px)
    k.fillStyle = 'rgba(255, 255, 255, 0.96)'
    k.beginPath()
    k.roundRect(-m.width / 2, -ch / 2, m.width, ch, Math.min(m.px * 0.75, ch / 2))
    k.fill()
  })
  if (card) c.drawImage(card.canvas, -card.ox, top + ch / 2 - card.oy)
  const ref = fontRef(project, g)
  const stack = stackOf(project, ref)
  const itemWeight = weightOf(ref, 600)
  c.textBaseline = 'middle'
  c.textAlign = 'left'
  if (g.title) {
    c.font = `${weightOf(ref, itemWeight + 200)} ${m.titlePx}px ${stack}`
    c.fillStyle = accent
    c.fillText(g.title, left + m.padX, top + m.padY + m.titleH / 2)
  }
  items.forEach((item, i) => {
    const p = EASE.out(progress(item.at, 0.22))
    const y = top + m.padY + m.titleH + m.row * (i + 0.5) + (1 - p) * 0.4 * m.px
    c.save()
    c.globalAlpha *= p
    const r = m.px * 0.72
    const mx = left + m.padX + r
    if (g.marker === 'bullet') {
      c.fillStyle = accent
      c.beginPath()
      c.arc(mx, y, r * 0.4, 0, Math.PI * 2)
      c.fill()
    } else {
      c.fillStyle = accent
      c.beginPath()
      c.arc(mx, y, r, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = '#ffffff'
      if (g.marker === 'check') {
        c.strokeStyle = '#ffffff'
        c.lineWidth = r * 0.28
        c.lineCap = 'round'
        c.lineJoin = 'round'
        c.beginPath()
        c.moveTo(mx - r * 0.45, y + r * 0.02)
        c.lineTo(mx - r * 0.1, y + r * 0.36)
        c.lineTo(mx + r * 0.48, y - r * 0.32)
        c.stroke()
      } else {
        c.font = `800 ${m.px * 0.8}px ${stack}`
        c.textAlign = 'center'
        c.fillText(listNumber(i + 1, project), mx, y)
        c.textAlign = 'left'
      }
    }
    c.font = `${itemWeight} ${m.px}px ${stack}`
    c.fillStyle = '#1c2030'
    c.fillText(item.text, mx + r + m.px * 0.5, y, m.width - (mx + r + m.px * 0.5 - left) - m.padX)
    c.restore()
  })
  c.restore()
}

/** A list number in the captions' digits (§0.2: Bangla ০–৯ when the captions ask for them). */
function listNumber(n: number, project: Project): string {
  const lang = project.captions?.track ?? project.transcript?.language ?? 'en'
  if (project.captions?.digits === 'native') {
    try {
      return new Intl.NumberFormat(lang, { useGrouping: false }).format(n)
    } catch {
      return String(n)
    }
  }
  return String(n)
}

/** Motion graphics of fc.t, on the captions' clock (§9.1 rule 6); nothing without graphics. */
export function drawGraphicsLayer(fc: FrameContext): void {
  const { project } = fc
  if (!project.graphics?.length) return
  ensureCaptionFonts(project)
  frames.set(project, fc)
  for (const s of graphicsAt(fc.ctx, project, fc.t, fc.w, fc.h, fc.textArea)) drawShown(fc.ctx, project, s, fc.t, fc.w, fc.h, fc.textArea)
}
