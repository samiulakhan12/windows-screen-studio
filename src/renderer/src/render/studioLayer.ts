/**
 * The Captions Studio caption layer (docs/design/captions-studio.md §9.7, §0.1, §0.2): the caption
 * showing at fc.t in a Studio look, laid out by studioLayout, placed by placeStudio and moved by the
 * motion engine's poses (captionPoses), drawn as word sprites; the boxes, bands, bubbles and marks
 * under and over them; and the gallery's thumbnails with the same code. Legacy looks never come
 * here (captionsLayer.ts draws them as before).
 *
 * Everything a frame shows is a function of time and content: layouts, placements and sprites are
 * cached by content (text, font, size, look, state, the clips), never by time, so preview, export
 * and any seek draw the same pixels. `ctx.filter` is never set on the frame: blur motion draws
 * pre-blurred sprites (wordSprites.ts blurredSprite) and glass a blurred copy made off the frame
 * (titleCardLayer.ts blurredFrameOf).
 *
 * The poses are read in these units (motion.ts, part P1): lengths (dx, dy, blur) in output px;
 * rotate in degrees; scale and scaleX as factors around the word's or the block's centre; alpha
 * 0..1 (a word's includes the opacity of words not yet spoken); reveal 0..1, the share shown from
 * the reading start (wipe; a typewriter's is the share of graphemes, k / n); fill 0..1, as
 * motion.ts defines it: the spoken fill or gradient sweep from the reading start, and for the other
 * marks (colour, glow, a sticker's colour, box and pill text) how far the spoken colour has come in;
 * mark 0..1, the share of an emphasis mark drawn (this layer times those itself,
 * emphasisProgress); weight 0..1, how far the word has turned to the spoken weight (a value above 1
 * is read as the weight itself). A MarkBox's x and w are the marked words' span from
 * its line's left edge (the fixed padding of §5.1 is added here). placeStudio's lines are as
 * placeChunk's: x the left edge of the text, y the middle of the line.
 */
import { CAPTION_FONT, CAPTION_SAFE, captionIndexAt, viewAt } from '../../../shared/captions/layout'
import { burnedSegments } from '../../../shared/captions/captionTracks'
import { speakerColors, textOn } from '../../../shared/captions/colors'
import { wordFace } from '../../../shared/captions/fontStack'
import { marksByCaption } from '../../../shared/captions/marks'
import { captionPoses, clipsKey, EASE, flashSafeChunks, seedOf, typewriterClip, type ChunkPose, type MarkBox, type WordPose } from '../../../shared/captions/motion'
import { replacedAt } from '../../../shared/captions/replaced'
import { speakersOf, STEM_SPEAKERS } from '../../../shared/captions/speakers'
import { captionObstacles, placeStudio, studioChunkAt, studioLayout, type CaptionObstacles, type StudioChunk, type StudioFace, type StudioLayout, type StudioLine, type StudioWordBox } from '../../../shared/captions/studioLayout'
import { STUDIO_BASE } from '../../../shared/captions/studioPresets'
import { prefixDrawsSame, scriptsIn, type ScriptTag, type StudioToken } from '../../../shared/captions/words'
import type { Rect } from '../../../shared/engine/layout'
import { isTall } from '../../../shared/engine/reframeData'
import { DEFAULT_ZOOM_SETTINGS } from '../../../shared/engine/zoom'
import { actionRects } from '../../../shared/render/actionRects'
import { TEXT_INSET } from '../../../shared/render/safeZones'
import type { CaptionMark, CaptionSegment, CaptionSettings, CaptionStudio, Clip, Project, StudioPosition } from '../../../shared/types'
import { catalogFontReady, catalogFontsFor, ensureCaptionFonts, fontGeneration, loadCatalogFont } from './fontLoader'
import type { FrameContext } from './frameContext'
import { blurredFrameOf, lowerThirdBoxes } from './titleCardLayer'
import { blurredSprite, STUDIO_SPRITES } from './wordSprites'

type Ctx = CanvasRenderingContext2D

/** A number per object (cache keys that follow an array or settings object without hashing it). */
const ids = new WeakMap<object, number>()
let nextId = 1
const idOf = (o: object | null | undefined): number => {
  if (!o) return 0
  let n = ids.get(o)
  if (n === undefined) ids.set(o, (n = nextId++))
  return n
}

/* ---------- measuring (widths at 100 px, scaled; keyed by face and font generation, §8.4) ---------- */

const MEASURE_PX = 100
const widths = new Map<string, number>()

/** The canvas font of a face at `px`. */
export const faceFont = (face: StudioFace, px: number): string => `${face.weight} ${px}px ${face.stack}`

/** Letter spacing of a face at `px` (canvas takes a length; the face's is in em). */
const spacing = (face: StudioFace, px: number): string => `${+(face.tracking * px).toFixed(3)}px`

function measureOn(ctx: Ctx): (text: string, px: number, face: StudioFace) => number {
  return (text, px, face) => {
    const key = `${fontGeneration()}|${face.stack}|${face.weight}|${face.tracking}|${text}`
    let w = widths.get(key)
    if (w === undefined) {
      ctx.save()
      ctx.font = faceFont(face, MEASURE_PX)
      ctx.letterSpacing = spacing(face, MEASURE_PX)
      w = ctx.measureText(text).width
      ctx.restore()
      if (widths.size > 20000) widths.clear()
      widths.set(key, w)
    }
    return (w * px) / MEASURE_PX
  }
}

/* ---------- the look a caption draws with ---------- */

/** Chat with no speaker in the whole transcript draws as Subtitle (§0.1). */
const subtitleOf = new WeakMap<CaptionStudio, CaptionStudio>()
function effectiveStudio(studio: CaptionStudio, segments: readonly CaptionSegment[]): CaptionStudio {
  if (studio.box.kind !== 'chat' || segments.some((s) => s.speaker)) return studio
  let out = subtitleOf.get(studio)
  if (!out) subtitleOf.set(studio, (out = { ...structuredClone(STUDIO_BASE as CaptionStudio), from: studio.from }))
  return out
}

/** The marks of each caption, made once per captionMarks array. */
const marksOf = new WeakMap<readonly CaptionMark[], ReadonlyMap<string, readonly CaptionMark[]>>()
const NO_MARKS: readonly CaptionMark[] = []
function captionMarks(project: Project, caption: string): readonly CaptionMark[] {
  const all = project.captionMarks
  if (!all?.length) return NO_MARKS
  let byCaption = marksOf.get(all)
  if (!byCaption) marksOf.set(all, (byCaption = marksByCaption(all)))
  return byCaption.get(caption) ?? NO_MARKS
}

/** The scripts of every burned-in caption (per transcript), for the font stacks. */
const scriptsOfSegments = new WeakMap<readonly CaptionSegment[], Set<ScriptTag>>()
function scriptsOf(segments: readonly CaptionSegment[]): Set<ScriptTag> {
  let s = scriptsOfSegments.get(segments)
  if (!s) scriptsOfSegments.set(segments, (s = scriptsIn(segments.map((x) => x.text))))
  return s
}

interface CachedLayout {
  key: string
  studio: CaptionStudio
  layout: StudioLayout
}

/** Captions are replaced (never changed in place) by an edit, so a caption object keeps its layout. */
const layouts = new WeakMap<CaptionSegment, CachedLayout>()

const areaKey = (area: Rect | null | undefined): string => (area ? `${area.x},${area.y},${area.w},${area.h}` : '')

/** The block area of a chunk with its box (the flash rule's "big chunk", §9.6). */
function chunkArea(studio: CaptionStudio, layout: StudioLayout, chunk: StudioChunk): number {
  const { padX, padY } = boxPads(studio, layout.px)
  return (chunk.width + padX * 2) * (chunk.height + padY * 2)
}

interface LayoutInput {
  ctx: Ctx
  project: Project
  seg: CaptionSegment
  studio: CaptionStudio
  w: number
  h: number
  area: Rect | null
  language: string | undefined
  scripts: Set<ScriptTag>
  showSpeaker: boolean
  spoken: boolean
}

/** The caption's Studio layout, flash-safe for these clips (cached by content, §9.1 rule 5). */
function layoutOf(i: LayoutInput): StudioLayout {
  const marks = captionMarks(i.project, i.seg.id)
  const clips = i.project.clips
  // The Digits choice (§0.2) changes the words' text, so it is part of the key.
  const digits = i.project.captions?.digits
  const key = [i.w, i.h, areaKey(i.area), fontGeneration(), clipsKey(clips), i.language ?? '', i.showSpeaker, i.spoken, digits ?? '', marks.map((m) => `${m.from}-${m.to}-${m.tone ?? 1}`).join(','), idOf(i.project.fonts)].join('|')
  const hit = layouts.get(i.seg)
  if (hit && hit.studio === i.studio && hit.key === key) return hit.layout
  const faceOf = (token: StudioToken, role: 'text' | 'emphasis'): StudioFace =>
    wordFace(i.studio, role, token.script, { language: i.language, scripts: i.scripts, fonts: i.project.fonts, downloaded: catalogFontReady })
  const raw = studioLayout(i.seg, i.studio, i.w, i.h, measureOn(i.ctx), { faceOf, area: i.area, marks, language: i.language, showSpeaker: i.showSpeaker, spoken: i.spoken, digits })
  const layout = raw.chunks.length ? flashSafeChunks(raw, clips, i.w * i.h, (c) => chunkArea(i.studio, raw, raw.chunks[c])) : raw
  layouts.set(i.seg, { key, studio: i.studio, layout })
  return layout
}

/* ---------- where the block goes ---------- */

/**
 * Today's anchors (placeChunk) for a Studio twin (§5.8): the block's top edge for 'top', its
 * centre for 'middle', its bottom edge for 'bottom', in the text area when there is one.
 */
function legacyAnchorOf(w: number, h: number, area: Rect | null): (position: CaptionSettings['position']) => number {
  const u = Math.min(w, h)
  const margin = CAPTION_SAFE * u
  const inset = TEXT_INSET * u
  return (position) => {
    if (position === 'top') return area ? Math.max(margin, area.y + inset) : margin
    if (position === 'middle') return area ? area.y + area.h / 2 : h / 2
    return area ? Math.min(h - margin * 1.25, area.y + area.h - inset) : h - margin * 1.25
  }
}

/** The frame each project is being drawn in (noted by the compositor before key presses ask where the caption is). */
const frames = new WeakMap<Project, FrameContext>()

/**
 * Notes the frame about to be drawn, so studioBlockAt (asked by the key presses, which are drawn
 * before the captions) places the block with the same obstacles the captions layer uses. Nothing
 * without a Studio look.
 */
export function noteStudioFrame(fc: FrameContext): void {
  if (fc.project.captions?.studio) frames.set(fc.project, fc)
}

interface CachedObstacles {
  key: string
  obstacles: CaptionObstacles
}
const obstacleCache = new WeakMap<CaptionSegment, CachedObstacles>()

/**
 * What a caption keeps clear of (§8.6), once per caption, frame size, area and project (the
 * camera's view reads its zooms, style, crop and follow settings, besides its camera, titles and
 * clips), and per frame's cursor, focus path and recording size.
 */
function obstaclesOf(ctx: Ctx, project: Project, seg: CaptionSegment, studio: CaptionStudio, w: number, h: number, area: Rect | null): CaptionObstacles | undefined {
  if (!studio.layout.avoid || studio.layout.place) return undefined
  const fc = frames.get(project)
  const withAction = !!fc && fc.w === w && fc.h === h
  const frame = withAction ? [idOf(fc!.scene.project), idOf(fc!.cursor), idOf(fc!.scene.focusPath), fc!.vw, fc!.vh].join(',') : 0
  const key = [w, h, areaKey(area), idOf(project), frame].join('|')
  const hit = obstacleCache.get(seg)
  if (hit && hit.key === key) return hit.obstacles
  const titles = lowerThirdBoxes(ctx, project, w, h, area).filter((b) => b.start < seg.end && b.end > seg.start)
  const action = withAction
    ? actionRects(fc!.scene, fc!.cursor.valid ? fc!.cursor : null, project.zoomSettings?.auto ?? DEFAULT_ZOOM_SETTINGS.auto, w, h, fc!.vw, fc!.vh, seg.start, seg.end, project.clips)
    : []
  // Key presses keep clear of the block themselves (captionBlockAt reports its edge, §8.5), so the
  // block does not also move for them.
  const obstacles = captionObstacles(project, seg, w, h, { titles, keys: null, action })
  obstacleCache.set(seg, { key, obstacles })
  return obstacles
}

/* ---------- what shows at t ---------- */

interface Shown {
  project: Project
  studio: CaptionStudio
  seg: CaptionSegment
  segments: readonly CaptionSegment[]
  index: number
  layout: StudioLayout
  ci: number
  chunk: StudioChunk
  placed: ReturnType<typeof placeStudio>
  /** The block's horizontal shift (chat bubbles go to their speaker's side). */
  shiftX: number
  spoken: boolean
  area: Rect | null
  /** The frame's size. */
  w: number
  h: number
}

/** The anchored keyword's chunk is hidden while its card shows (§10.1). */
function chunkReplaced(project: Project, t: number, seg: CaptionSegment, layout: StudioLayout, chunk: StudioChunk): boolean {
  const r = replacedAt(project, t)
  if (!r.chunks.length) return false
  for (const c of r.chunks) {
    if (c.caption !== seg.id) continue
    for (let k = chunk.first; k <= chunk.last; k++) if (layout.tokens[k]?.word === c.word) return true
  }
  return false
}

/** The caption chunk in the Studio look at source time `t`, placed; null when none shows. */
function shownAt(ctx: Ctx, project: Project, t: number, w: number, h: number, area: Rect | null): Shown | null {
  const settings = project.captions
  const look = settings?.studio
  if (!settings || !look || !settings.show) return null
  const segments = burnedSegments(project)
  if (!segments.length) return null
  const index = captionIndexAt(segments, t)
  if (index < 0) return null
  const seg = segments[index]
  if (replacedAt(project, t).captions.has(seg.id)) return null
  const studio = effectiveStudio(look, segments)
  const chat = studio.box.kind === 'chat'
  const language = settings.track ?? project.transcript?.language
  // A translated track has no word times: no spoken mark and no word motion (§9.1 rule 7).
  const spoken = !settings.track
  const layout = layoutOf({ ctx, project, seg, studio, w, h, area, language, scripts: scriptsOf(segments), showSpeaker: !!settings.showSpeaker && !chat, spoken })
  const ci = studioChunkAt(layout, t)
  if (ci < 0) return null
  const chunk = layout.chunks[ci]
  if (chunkReplaced(project, t, seg, layout, chunk)) return null
  const { placed, shiftX } = placeChunkOf(ctx, project, seg, studio, layout, chunk, w, h, area)
  return { project, studio, seg, segments, index, layout, ci, chunk, placed, shiftX, spoken, area, w, h }
}

/** Where a chunk of caption `seg` goes (§8.5, §8.6): its own position, the obstacles, a twin's legacy anchors; chat bubbles at their side. */
function placeChunkOf(ctx: Ctx, project: Project, seg: CaptionSegment, studio: CaptionStudio, layout: StudioLayout, chunk: StudioChunk, w: number, h: number, area: Rect | null): { placed: Shown['placed']; shiftX: number } {
  const forced = project.captionPlaces?.find((p) => p.caption === seg.id)?.position
  const placed = placeStudio(layout, chunk, studio, w, h, {
    area,
    obstacles: forced ? undefined : obstaclesOf(ctx, project, seg, studio, w, h, area),
    ...(forced ? { forced } : {}),
    ...(studio.layout.legacyAnchor ? { legacyAnchor: legacyAnchorOf(w, h, area) } : {})
  })
  return { placed, shiftX: studio.box.kind === 'chat' ? chatShift(placed, studio, layout, w, h, area, isYou(seg)) : 0 }
}

/**
 * Where word `word` (an index into studioWordTexts) of caption `caption` is drawn in the Studio
 * look, at rest, and the block and time of the chunk holding it, whether or not that chunk shows
 * (a keyword card takes the place of the chunk it replaces, an emoji sits above its word, §10.3).
 * Null on a legacy look or when the caption or word is not there.
 */
export function studioWordPlace(ctx: Ctx, project: Project, caption: string, word: number, w: number, h: number, area: Rect | null): { word: Rect; block: Rect; start: number; end: number; px: number } | null {
  const settings = project.captions
  const look = settings?.studio
  if (!settings || !look) return null
  const segments = burnedSegments(project)
  const seg = segments.find((s) => s.id === caption)
  if (!seg) return null
  const studio = effectiveStudio(look, segments)
  const language = settings.track ?? project.transcript?.language
  const layout = layoutOf({ ctx, project, seg, studio, w, h, area, language, scripts: scriptsOf(segments), showSpeaker: !!settings.showSpeaker && studio.box.kind !== 'chat', spoken: !settings.track })
  for (const chunk of layout.chunks) {
    for (const [li, line] of chunk.lines.entries()) {
      const box = line.words.find((b) => layout.tokens[b.token]?.word === word)
      if (!box) continue
      const { placed, shiftX } = placeChunkOf(ctx, project, seg, studio, layout, chunk, w, h, area)
      const s = { studio, layout, shiftX }
      const row = rowsOf(s, chunk, placed)[li]
      if (!row) return null
      return { word: { x: row.x + box.x, y: row.y - row.height / 2, w: box.w, h: row.height }, block: blockRect(s, chunk, placed), start: chunk.start, end: chunk.end, px: box.px }
    }
  }
  return null
}

/**
 * The Studio caption block at `t`, with the edge key presses keep clear of (§8.5), or null. Its
 * box is the block's as placed (its box padding included), before any motion.
 */
export function studioBlockAt(
  ctx: Ctx,
  project: Project,
  t: number,
  w: number,
  h: number,
  area?: Rect | null
): { position: StudioPosition | null; edge: 'top' | 'middle' | 'bottom'; top: number; bottom: number; box: Rect } | null {
  const s = shownAt(ctx, project, t, w, h, area ?? null)
  if (!s) return null
  const box = blockRect(s, s.chunk, s.placed)
  const forced = project.captionPlaces?.find((p) => p.caption === s.seg.id)?.position
  const position: StudioPosition | null = forced ?? (s.studio.layout.place ? null : s.studio.layout.position)
  return { position, edge: s.placed.edge, top: box.y, bottom: box.y + box.h, box }
}

/* ---------- geometry ---------- */

/** A line of a chunk as placed: its text's left edge, middle and width, and its row height. */
interface Row {
  line: StudioLine
  x: number
  y: number
  width: number
  height: number
}

function rowsOf(s: Pick<Shown, 'layout' | 'shiftX'>, chunk: StudioChunk, placed: Shown['placed']): Row[] {
  return chunk.lines.map((line, i) => {
    const p = placed.lines[i] ?? { x: 0, y: 0, width: line.width }
    return { line, x: p.x + s.shiftX, y: p.y, width: p.width, height: line.height || s.layout.lineHeight }
  })
}

/** The box's padding in px (none without a box; Stickers pad each word instead). */
function boxPads(studio: CaptionStudio, px: number): { padX: number; padY: number } {
  const k = studio.box.kind
  if (k === 'none' || k === 'word') return { padX: 0, padY: 0 }
  return { padX: studio.box.padX * px, padY: studio.box.padY * px }
}

/** The block's rectangle with the box padding. */
function blockRect(s: Pick<Shown, 'studio' | 'layout' | 'shiftX'>, chunk: StudioChunk, placed: Shown['placed']): Rect {
  const rows = rowsOf(s, chunk, placed)
  if (!rows.length) return { ...placed.box, x: placed.box.x + s.shiftX }
  const { padX, padY } = boxPads(s.studio, s.layout.px)
  const x0 = Math.min(...rows.map((r) => r.x)) - padX
  const x1 = Math.max(...rows.map((r) => r.x + r.width)) + padX
  const y0 = rows[0].y - rows[0].height / 2 - padY
  const y1 = rows[rows.length - 1].y + rows[rows.length - 1].height / 2 + padY
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** "You" (NW-09's microphone speaker) chats on the right. */
const isYou = (seg: CaptionSegment): boolean => seg.speaker === STEM_SPEAKERS.mic

/** Chat bubbles sit on their speaker's side: You on the right, others on the left (§0.1). */
function chatShift(placed: Shown['placed'], studio: CaptionStudio, layout: StudioLayout, w: number, h: number, area: Rect | null, you: boolean): number {
  if (!placed.lines.length) return 0
  const margin = CAPTION_SAFE * Math.min(w, h)
  const left = area ? Math.max(margin, area.x) : margin
  const right = area ? Math.min(w - margin, area.x + area.w) : w - margin
  const padX = studio.box.padX * layout.px
  const x0 = Math.min(...placed.lines.map((l) => l.x)) - padX
  const x1 = Math.max(...placed.lines.map((l) => l.x + l.width)) + padX
  return you ? right - x1 : left - x0
}

/* ---------- word sprites (§9.7) ---------- */

/** How a word sprite is painted: everything that changes its pixels (its key is this, as text). */
interface WordPaint {
  text: string
  font: string
  spacing: string
  dir: 'ltr' | 'rtl'
  px: number
  /** Paint scale (the spoken word's grown size, so it stays crisp while it holds). */
  scale: number
  /** A colour, or gradient stops ('across' runs over the whole line: from, to are the word's share of it). */
  fill: string | { stops: readonly string[]; axis: 'across' | 'down'; from: number; to: number }
  /** Outline's words not filled yet: a thin stroke in the text colour over a dark halo. */
  hollow: boolean
  outline: { width: number; color: string } | null
  shadow: { x: number; y: number; blur: number; color: string } | null
  glow: { radius: number; color: string } | null
  extrude: { steps: number; x: number; y: number; color: string } | null
  split: { d: number; left: string; right: string } | null
  sticker: { fill: string; border: number; borderColor: string; padX: number; padY: number; radius: number; shadow: { x: number; y: number; blur: number; color: string } | null } | null
  /** Extra room for blur motion. */
  blurRoom: boolean
  /** The line height a 'down' gradient spans. */
  lineHeight: number
}

/** `hex` (#rrggbb) at `alpha`. */
const rgba = (hex: string, alpha: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${+Math.max(0, Math.min(1, alpha)).toFixed(4)})`
}

/** Room around a word for its edge, shadow, glow, extrusion, split and sticker (§9.7), px at paint scale. */
function padOf(p: WordPaint): number {
  const em = p.px * p.scale
  let pad = 0.15 * em + (p.outline ? p.outline.width / 2 : 0)
  if (p.shadow) pad += Math.max(Math.abs(p.shadow.x), Math.abs(p.shadow.y)) + 2 * p.shadow.blur
  if (p.glow) pad += p.glow.radius * 1.5
  if (p.extrude) pad += p.extrude.steps * Math.max(Math.abs(p.extrude.x), Math.abs(p.extrude.y))
  if (p.split) pad += p.split.d
  if (p.sticker) pad += Math.max(p.sticker.padX, p.sticker.padY) + p.sticker.border + (p.sticker.shadow ? Math.max(Math.abs(p.sticker.shadow.x), Math.abs(p.sticker.shadow.y)) + 2 * p.sticker.shadow.blur : 0)
  if (p.blurRoom) pad += 0.2 * em
  return Math.ceil(pad)
}

interface Sprite {
  canvas: HTMLCanvasElement
  key: string
  /** Where the word's left edge and line middle are in the canvas, px. */
  ox: number
  oy: number
  scale: number
}

/** Draws only the shadow of what `paint` draws (the glyphs themselves far out of the canvas). */
function shadowOnly(c: Ctx, color: string, dx: number, dy: number, blur: number, paint: (x: number) => void): void {
  const far = 100000
  c.save()
  c.shadowColor = color
  c.shadowBlur = blur
  c.shadowOffsetX = dx + far
  c.shadowOffsetY = dy
  paint(-far)
  c.restore()
}

/** Paints a word with its left edge at x = 0 and its line middle at y = 0, at its paint scale. */
function paintWord(c: Ctx, p: WordPaint, width: number): void {
  const em = p.px * p.scale
  const w = width * p.scale
  c.font = p.font
  c.letterSpacing = p.spacing
  c.direction = p.dir
  c.textAlign = p.dir === 'rtl' ? 'right' : 'left'
  c.textBaseline = 'middle'
  c.lineJoin = 'round'
  c.miterLimit = 2
  // A right-to-left word is anchored at its right edge, so it covers [0, w] either way.
  const tx = p.dir === 'rtl' ? w : 0
  const text = (x: number, y: number): void => c.fillText(p.text, tx + x, y)
  const stroke = (x: number, y: number): void => c.strokeText(p.text, tx + x, y)
  if (p.sticker) {
    // Stickers (§0.1): a rounded sticker with a dark border and a hard offset shadow.
    const k = p.sticker
    const bx = -k.padX
    const by = -em * 0.62 - k.padY
    const bw = w + k.padX * 2
    const bh = em * 1.24 + k.padY * 2
    const r = Math.min(k.radius, bh / 2)
    if (k.shadow) {
      c.save()
      c.fillStyle = k.shadow.color
      if (k.shadow.blur > 0) {
        c.shadowColor = k.shadow.color
        c.shadowBlur = k.shadow.blur
      }
      c.beginPath()
      c.roundRect(bx + k.shadow.x, by + k.shadow.y, bw, bh, r)
      c.fill()
      c.restore()
    }
    c.fillStyle = k.fill
    c.beginPath()
    c.roundRect(bx, by, bw, bh, r)
    c.fill()
    if (k.border > 0) {
      c.lineWidth = k.border
      c.strokeStyle = k.borderColor
      c.stroke()
    }
  }
  // The shadow under the whole word (extrusion and outline included): soft, or a hard copy.
  if (p.shadow) {
    const sh = p.shadow
    c.save()
    c.fillStyle = sh.color
    c.strokeStyle = sh.color
    if (p.outline) c.lineWidth = p.outline.width
    const all = (x: number, y: number): void => {
      if (p.extrude) for (let i = p.extrude.steps; i >= 1; i--) text(x + p.extrude.x * i, y + p.extrude.y * i)
      if (p.outline && !p.hollow) stroke(x, y)
      if (p.hollow) {
        c.lineWidth = Math.max(1, em * 0.07)
        stroke(x, y)
      } else text(x, y)
    }
    if (sh.blur > 0) shadowOnly(c, sh.color, sh.x, sh.y, sh.blur, (x) => all(x, 0))
    else all(sh.x, sh.y)
    c.restore()
  }
  if (p.extrude) {
    // 3D Block (§0.1): steps of copies in a darker shade, the deepest first.
    const ex = p.extrude
    c.save()
    c.fillStyle = ex.color
    c.strokeStyle = ex.color
    if (p.outline) c.lineWidth = p.outline.width
    for (let i = ex.steps; i >= 1; i--) {
      if (p.outline) stroke(ex.x * i, ex.y * i)
      text(ex.x * i, ex.y * i)
    }
    c.restore()
  }
  if (p.split && p.outline && !p.hollow) {
    // Retro Pixel (§0.1): the dark edge under the colour split, so the split shows beside the letters as in the mock-up.
    c.save()
    c.strokeStyle = p.outline.color
    c.lineWidth = p.outline.width
    stroke(-p.split.d, 0)
    stroke(p.split.d, 0)
    c.restore()
  }
  if (p.split) {
    // Retro Pixel (§0.1): a static colour split, never moving.
    c.save()
    c.fillStyle = p.split.left
    text(-p.split.d, 0)
    c.fillStyle = p.split.right
    text(p.split.d, 0)
    c.restore()
  }
  if (p.hollow) {
    c.save()
    c.lineWidth = Math.max(1, em * 0.07)
    c.strokeStyle = typeof p.fill === 'string' ? p.fill : p.fill.stops[0]
    stroke(0, 0)
    c.restore()
    return
  }
  if (p.outline && !p.split) {
    c.save()
    c.strokeStyle = p.outline.color
    c.lineWidth = p.outline.width
    stroke(0, 0)
    c.restore()
  }
  c.save()
  if (typeof p.fill === 'string') c.fillStyle = p.fill
  else {
    const f = p.fill
    let g: CanvasGradient
    if (f.axis === 'down') {
      // Gold (§0.1): from the top of the line to its bottom.
      const half = (em * Math.max(1, p.lineHeight)) / 2
      g = c.createLinearGradient(0, -half, 0, half)
    } else {
      // Gradient (§0.1): across the whole line, this word showing its share of it, in reading direction.
      const lineW = w / Math.max(1e-6, f.to - f.from)
      const x0 = -f.from * lineW
      g = p.dir === 'rtl' ? c.createLinearGradient(x0 + lineW, 0, x0, 0) : c.createLinearGradient(x0, 0, x0 + lineW, 0)
    }
    f.stops.forEach((stop, i) => g.addColorStop(f.stops.length === 1 ? 0 : i / (f.stops.length - 1), stop))
    c.fillStyle = g
  }
  if (p.glow) {
    // Layers of glow (§5.4 Neon: 0.10, 0.36 and 0.94 em at α 1, 0.8 and 0.5, scaled to the look's radius).
    for (const [r, a] of [
      [0.94, 0.5],
      [0.36, 0.8],
      [0.1, 1]
    ] as const) {
      c.save()
      c.shadowColor = rgba(p.glow.color, a)
      c.shadowBlur = (p.glow.radius * r) / 0.94
      text(0, 0)
      c.restore()
    }
  }
  text(0, 0)
  c.restore()
}

/** The sprite of a word painted as `p` (cached by content), or null without a canvas. */
function spriteOf(p: WordPaint, key: string, width: number): Sprite | null {
  const pad = padOf(p)
  const em = p.px * p.scale
  const cw = width * p.scale + pad * 2
  const ch = Math.ceil(em * 1.4 + pad * 2)
  const canvas = STUDIO_SPRITES.get(key, cw, ch, (c) => {
    c.translate(pad, ch / 2)
    paintWord(c, p, width)
  })
  return canvas ? { canvas, key, ox: pad, oy: ch / 2, scale: p.scale } : null
}

/* ---------- a word's paints in its states ---------- */

type WordState = 'base' | 'upcoming' | 'lit'

interface WordInfo {
  token: StudioToken
  box: StudioWordBox
  /** 0: not emphasised; 1, 2: the tone. */
  emphasis: 0 | 1 | 2
  /** Its colour: the speaker's (§7.4), else the text colour. */
  textColor: string
  /** Its share of its line, for a gradient across the line. */
  from: number
  to: number
  dir: 'ltr' | 'rtl'
}

/** Bangla outlines are thinner than Latin (§0.2: 2.5 px at 30 px). */
const BENGALI_OUTLINE_MAX = 0.04

/** The paint of word `wi` in `state` (§9.3, §0.1, §0.2). */
function paintOf(studio: CaptionStudio, wi: WordInfo, state: WordState): WordPaint {
  const { theme, edge, box } = studio
  const em = wi.box.px
  const bengali = wi.token.script === 'bengali'
  const spokenMark = studio.spoken
  const lit = state === 'lit'
  const emph = wi.emphasis > 0
  const emphColor = wi.emphasis === 2 ? (theme.emphasis2 ?? theme.emphasis) : theme.emphasis
  const markOnBox = studio.emphasis.mark === 'marker' || studio.emphasis.mark === 'box'
  // The spoken word grows (Stickers 1.12, Spotlight Word 1.28; at most 1.14 for Bangla, §0.2): it is painted at that size.
  const grow = lit && studio.motion.spokenScale && !studio.motion.calm ? Math.max(1, Math.min(studio.motion.spokenScale, bengali ? 1.14 : 1.3)) : 1
  let face = wi.box.face
  if (lit && spokenMark === 'weight' && !emph) face = { ...face, weight: studio.text.spokenWeight ?? Math.min(900, face.weight + 300) }
  let fill: WordPaint['fill'] = wi.textColor
  if (state === 'upcoming' && theme.upcoming) fill = theme.upcoming
  if (theme.fill && !emph) fill = { stops: theme.fill.stops, axis: theme.fill.axis, from: wi.from, to: wi.to }
  if (emph) fill = markOnBox ? (theme.emphasisText ?? textOn(emphColor)) : studio.emphasis.mark === 'circle' ? (theme.emphasisText ?? wi.textColor) : emphColor
  const boxedSpoken = spokenMark === 'box' || spokenMark === 'pill'
  if (lit && !emph) {
    if (spokenMark === 'gradient' && theme.gradient?.length) fill = { stops: theme.gradient, axis: 'across', from: 0, to: 1 }
    else if (boxedSpoken) fill = theme.spokenText ?? textOn(theme.spoken)
    else if (spokenMark !== 'weight' && spokenMark !== 'none' && spokenMark !== 'underline') fill = theme.spoken
  }
  const hollow = !!edge.hollow && !lit && !emph
  const outlineEm = Math.min(edge.outline, bengali ? BENGALI_OUTLINE_MAX : Infinity)
  // No outline on words over a marker or box (the mark is their background), nor on the spoken box.
  const onMark = (emph && markOnBox) || (lit && boxedSpoken && box.kind !== 'word')
  const outline = !hollow && !onMark && outlineEm > 0 && edge.outlineAlpha > 0 ? { width: 2 * outlineEm * em * grow, color: rgba(theme.outline, edge.outlineAlpha) } : null
  const sh = edge.shadow
  const shadow = hollow
    ? { x: 0, y: 0, blur: 0.1 * em * grow, color: rgba('#000000', 0.6) }
    : sh && sh.alpha > 0 && !onMark
      ? { x: sh.x * em * grow, y: sh.y * em * grow, blur: sh.blur * em * grow, color: rgba(theme.shadow, sh.alpha) }
      : null
  const glow = lit && spokenMark === 'glow' && edge.glow > 0 ? { radius: edge.glow * em * grow, color: theme.glow } : null
  const ex = edge.extrude
  const extrude = ex && ex.steps > 0 ? { steps: ex.steps, x: ex.x * em * grow, y: ex.y * em * grow, color: (lit && !emph ? theme.spokenExtrude : undefined) ?? theme.extrude ?? theme.shadow } : null
  const split = edge.split && theme.split ? { d: edge.split * em * grow, left: theme.split[0], right: theme.split[1] } : null
  const sticker =
    box.kind === 'word'
      ? {
          fill: rgba(lit ? theme.spoken : theme.box, box.alpha),
          border: box.border * em * grow,
          borderColor: theme.border ?? '#111111',
          padX: box.padX * em * grow,
          padY: box.padY * em * grow,
          radius: box.radius * em * grow,
          shadow: box.shadow && box.shadow.alpha > 0 ? { x: box.shadow.x * em * grow, y: box.shadow.y * em * grow, blur: box.shadow.blur * em * grow, color: rgba(theme.shadow, box.shadow.alpha) } : null
        }
      : null
  const m = studio.motion
  return {
    text: wi.box.text,
    font: faceFont(face, em * grow),
    spacing: spacing(face, em * grow),
    dir: wi.dir,
    px: em,
    scale: grow,
    fill,
    hollow,
    outline,
    shadow,
    glow,
    extrude,
    split,
    sticker,
    blurRoom: m.word === 'blur' || m.emphasis === 'blur' || m.enter === 'blur' || m.exit === 'blur',
    lineHeight: studio.text.lineHeight
  }
}

interface CachedPaint {
  studio: CaptionStudio
  color: string
  gen: number
  paints: Partial<Record<WordState, { paint: WordPaint; key: string }>>
}
/** Each word box's paints, made once per look, colour and font generation (no key is made per frame). */
const paintCache = new WeakMap<StudioWordBox, CachedPaint>()
function paintFor(studio: CaptionStudio, wi: WordInfo, state: WordState): { paint: WordPaint; key: string } {
  const gen = fontGeneration()
  let hit = paintCache.get(wi.box)
  if (!hit || hit.studio !== studio || hit.color !== wi.textColor || hit.gen !== gen) paintCache.set(wi.box, (hit = { studio, color: wi.textColor, gen, paints: {} }))
  let p = hit.paints[state]
  if (!p) {
    const paint = paintOf(studio, wi, state)
    p = hit.paints[state] = { paint, key: `${JSON.stringify(paint)}|${wi.box.w.toFixed(3)}|${gen}` }
  }
  return p
}

/* ---------- drawing a chunk ---------- */

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4

/** A pose that moves nothing: the word is drawn at whole pixels (§9.7). */
const atRest = (p: { dx: number; dy: number; scale: number; scaleX: number; rotate: number; blur: number }): boolean =>
  near(p.dx, 0) && near(p.dy, 0) && near(p.scale, 1) && near(p.scaleX, 1) && near(p.rotate, 0) && p.blur < 0.05

/** Applies a pose's transform around (cx, cy). */
function transformAround(c: Ctx, cx: number, cy: number, p: { dx: number; dy: number; scale: number; scaleX: number; rotate: number }): void {
  c.translate(cx + p.dx, cy + p.dy)
  if (p.rotate) c.rotate((p.rotate * Math.PI) / 180)
  c.scale(p.scale * p.scaleX, p.scale)
  c.translate(-cx, -cy)
}

/** The pre-blurred levels blur motion crossfades between (§9.7), em. */
const BLUR_LEVELS = [0, 0.04, 0.08, 0.16]

/** Draws `sprite` with its word's left edge at x and its line middle at y, blurred by `blur` px. */
function drawSprite(c: Ctx, sprite: Sprite, x: number, y: number, blur: number, em: number, exact: boolean): void {
  const s = 1 / sprite.scale
  const dx = x - sprite.ox * s
  const dy = y - sprite.oy * s
  const w = sprite.canvas.width * s
  const h = sprite.canvas.height * s
  if (blur < 0.05) {
    if (exact && sprite.scale === 1) c.drawImage(sprite.canvas, Math.round(dx), Math.round(dy))
    else c.drawImage(sprite.canvas, dx, dy, w, h)
    return
  }
  const levels = BLUR_LEVELS.map((l) => l * em)
  let i = 0
  while (i + 2 < levels.length && blur > levels[i + 1]) i++
  const f = Math.max(0, Math.min(1, (blur - levels[i]) / (levels[i + 1] - levels[i])))
  const a = c.globalAlpha
  const at = (level: number, alpha: number): void => {
    if (alpha <= 0.002) return
    const img = level === 0 ? sprite.canvas : blurredSprite(STUDIO_SPRITES, sprite.key, sprite.canvas, levels[level] * sprite.scale)
    if (!img) return
    c.globalAlpha = a * alpha
    c.drawImage(img, dx, dy, w, h)
  }
  at(i, 1 - f)
  at(i + 1, f)
  c.globalAlpha = a
}

/** Clips to the share `reveal` of [x, x + w] from the reading start (`dir`). */
function clipReveal(c: Ctx, x: number, y: number, w: number, h: number, reveal: number, dir: 'ltr' | 'rtl'): void {
  const r = Math.max(0, Math.min(1, reveal)) * w
  c.beginPath()
  if (dir === 'rtl') c.rect(x + w - r, y, r, h)
  else c.rect(x, y, r, h)
  c.clip()
}

interface ChunkDraw {
  s: Shown
  chunk: StudioChunk
  placed: Shown['placed']
  pose: ChunkPose
  words: readonly WordPose[]
  mark: MarkBox | null
  t: number
  /** Word motion and spoken marks show (not on a chunk being handed over). */
  live: boolean
  /** The band is drawn by the caller (it stays while News Bar pushes its chunks, §5.3). */
  noBand: boolean
}

/** The caption's speaker colour (§7.4), or null. */
const paletteOf = new WeakMap<readonly CaptionSegment[], Map<CaptionStudio, { names: string[]; colours: string[] }>>()
function speakerColour(s: Shown): string | null {
  if (!s.studio.speakerColors || !s.seg.speaker) return null
  let byStudio = paletteOf.get(s.segments)
  if (!byStudio) paletteOf.set(s.segments, (byStudio = new Map()))
  let p = byStudio.get(s.studio)
  if (!p) {
    const names = speakersOf(s.segments).map((x) => x.name)
    byStudio.set(s.studio, (p = { names, colours: speakerColors(s.studio, names.length) }))
  }
  return p.colours[p.names.indexOf(s.seg.speaker)] ?? null
}

/** The words of a chunk with what their paints need, at their places. */
function wordInfos(s: Shown, rows: Row[]): { info: WordInfo; row: Row; x: number }[] {
  const out: { info: WordInfo; row: Row; x: number }[] = []
  const colour = speakerColour(s) ?? (s.studio.box.kind === 'chat' && isYou(s.seg) ? (s.studio.theme.youText ?? s.studio.theme.text) : s.studio.theme.text)
  for (const row of rows) {
    const lineW = Math.max(1e-6, row.line.width)
    for (const box of row.line.words) {
      const token = s.layout.tokens[box.token]
      if (!token) continue
      const emphasis = (s.layout.emphasis[box.token] ?? 0) as 0 | 1 | 2
      const dir: 'ltr' | 'rtl' = (s.layout.dirs[box.token] ?? token.dir) === 'r' ? 'rtl' : 'ltr'
      out.push({ info: { token, box, emphasis, textColor: colour, from: box.x / lineW, to: (box.x + box.w) / lineW, dir }, row, x: row.x + box.x })
    }
  }
  return out
}

/** cubic-bezier(0.3, 0, 0.2, 1) (§9.3 wipe), solved by bisection: pure. */
function wipeEase(p: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  const bez = (a: number, b: number, u: number): number => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (bez(0.3, 0.2, mid) < p) lo = mid
    else hi = mid
  }
  return bez(0, 1, (lo + hi) / 2)
}

/** The emphasis mark's progress (§9.4, §5.3): the wipe timing for marker, box and underline; 0.3 s for the circle (§0.1). Viewing time. */
function emphasisProgress(studio: CaptionStudio, token: StudioToken, t: number, clips: Clip[]): number {
  const speed = Math.max(0.5, studio.motion.speed || 1)
  const circle = studio.emphasis.mark === 'circle'
  const early = circle ? 0 : 0.06
  const word = viewAt(clips, token.end) - viewAt(clips, token.start)
  const d = Math.max(0.06, (circle ? 0.3 : Math.min(0.35, Math.max(0.06, word))) / speed)
  const p = Math.max(0, Math.min(1, (viewAt(clips, t) - (viewAt(clips, token.start) - early)) / d))
  return circle ? EASE.out(p) : wipeEase(p)
}

/** The hand-drawn circle around a word (§0.1 Circle): the mock-up's path, nudged by the word's seed (never random). Returns its approximate length. */
function circlePath(c: Ctx, x: number, y: number, w: number, em: number, lineH: number, seed: number): number {
  const L = x - em * 0.57
  const T = y - lineH / 2 - em * 0.36
  const W = w + em * 1.14
  const H = lineH + em * 0.72
  // -1..1 by the seed's bits: the same path for this word in every frame.
  const j = (k: number): number => (((seed >>> ((k * 3) % 30)) & 7) - 3.5) / 3.5
  const P = (px: number, py: number, k: number): [number, number] => [L + ((px + j(k) * 2) / 100) * W, T + ((py + j(k + 1) * 2) / 40) * H]
  const pts = [P(8, 22, 0), P(10, 6, 1), P(88, 2, 2), P(94, 18, 3), P(98, 34, 4), P(20, 40, 5), P(6, 26, 6), P(2, 18, 7), P(30, 6, 8), P(60, 8, 9)]
  c.beginPath()
  c.moveTo(pts[0][0], pts[0][1])
  c.bezierCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1])
  c.bezierCurveTo(pts[4][0], pts[4][1], pts[5][0], pts[5][1], pts[6][0], pts[6][1])
  c.bezierCurveTo(pts[7][0], pts[7][1], pts[8][0], pts[8][1], pts[9][0], pts[9][1])
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return len * 0.8
}

/** Draws a chunk's boxes, marks and words with their poses (the caller applies the chunk pose). */
function drawChunk(c: Ctx, d: ChunkDraw, frame: FrameContext | null): void {
  const { s, chunk, placed } = d
  const { studio } = s
  const rows = rowsOf(s, chunk, placed)
  const clips = s.project.clips
  drawBoxes(c, d, rows, frame)
  const words = wordInfos(s, rows)
  const poseOf = new Map<number, WordPose>()
  if (d.live) for (const p of d.words) poseOf.set(p.token, p)
  // The spoken box, pill or underline under the words (§9.3); Stickers colour their own sticker instead.
  const mark = d.live && s.spoken && d.mark && d.mark.alpha > 0.002 ? d.mark : null
  if (mark && (studio.spoken === 'box' || studio.spoken === 'pill' || studio.spoken === 'underline') && studio.box.kind !== 'word') drawSpokenMark(c, studio, rows, mark, s.layout.px)
  const emphMark = studio.emphasis.mark
  if (emphMark === 'marker' || emphMark === 'box')
    for (const { info, row, x } of words) {
      if (!info.emphasis || info.token.word < 0) continue
      const pr = emphasisProgress(studio, info.token, d.t, clips)
      if (pr > 0.002) drawEmphasisBox(c, studio, info, row, x, pr)
    }
  // A word grown or moving past its size (the spoken sticker, a popping word) is drawn over its neighbours.
  const above = (w: { info: WordInfo }): boolean => (poseOf.get(w.info.box.token)?.scale ?? 1) > 1.001
  for (const { info, row, x } of words) if (!above({ info })) drawWord(c, d, info, row, x, info.token.word < 0 ? undefined : poseOf.get(info.box.token))
  for (const { info, row, x } of words) if (above({ info })) drawWord(c, d, info, row, x, poseOf.get(info.box.token))
  // Over the words: the emphasis underline and circle, drawn on with their timing.
  if (emphMark === 'underline' || emphMark === 'circle')
    for (const { info, row, x } of words) {
      if (!info.emphasis || info.token.word < 0) continue
      const pr = emphasisProgress(studio, info.token, d.t, clips)
      if (pr > 0.002) drawEmphasisLine(c, s, info, row, x, pr)
    }
  if (studio.motion.word === 'typewriter' && d.live) drawCaret(c, d, words, poseOf)
}

/** The boxes behind a chunk: per line, per chunk, glass, band, bubble or chat (§4.1, §0.1), drawn live. */
function drawBoxes(c: Ctx, d: ChunkDraw, rows: Row[], frame: FrameContext | null): void {
  const { s } = d
  const { studio, layout } = s
  const box = studio.box
  if (box.kind === 'none' || box.kind === 'word' || !rows.length) return
  if (box.kind === 'band' && d.noBand) return
  const px = layout.px
  const padX = box.padX * px
  const padY = box.padY * px
  const fill = rgba(chatBoxColour(s), box.alpha)
  const shadow = box.shadow && box.shadow.alpha > 0 ? box.shadow : null
  const filled = (path: () => void): void => {
    c.save()
    if (shadow) {
      c.shadowColor = rgba(studio.theme.shadow, shadow.alpha)
      c.shadowBlur = shadow.blur * px
      c.shadowOffsetX = shadow.x * px
      c.shadowOffsetY = shadow.y * px
    }
    c.fillStyle = fill
    path()
    c.fill()
    c.restore()
    if (box.border > 0 && box.kind !== 'glass') {
      c.save()
      c.lineWidth = box.border * px
      c.strokeStyle = studio.theme.border ?? 'rgba(255, 255, 255, 0.28)'
      path()
      c.stroke()
      c.restore()
    }
  }
  if (box.kind === 'line' || box.kind === 'glass') {
    const gap = (box.gap ?? 0) * px
    const glass = box.kind === 'glass' ? glassFrame(frame) : null
    for (const r of rows) {
      const h = r.height + padY * 2 - gap
      const rect = { x: r.x - padX, y: r.y - r.height / 2 - padY + gap / 2, w: r.width + padX * 2, h }
      const radius = Math.min(box.radius * px, h / 2)
      if (box.kind === 'glass') drawGlass(c, rect, radius, studio, fill, px, glass)
      else
        filled(() => {
          c.beginPath()
          c.roundRect(rect.x, rect.y, rect.w, rect.h, radius)
        })
    }
    return
  }
  const block = blockRect(s, d.chunk, d.placed)
  if (box.kind === 'band') {
    const r = bandRect(s, block)
    filled(() => {
      c.beginPath()
      c.roundRect(r.x, r.y, r.w, r.h, Math.min(box.radius * px, r.h / 2))
    })
    return
  }
  if (box.kind === 'chunk') {
    filled(() => {
      c.beginPath()
      c.roundRect(block.x, block.y, block.w, block.h, Math.min(box.radius * px, block.h / 2))
    })
    return
  }
  if (box.kind === 'bubble') {
    // Speech Bubble (§0.1): its tail points at the camera bubble, down without one.
    const target = cameraCentre(s, frame)
    filled(() => bubblePath(c, block, Math.min(box.radius * px, block.h / 2), (box.tail ?? 0) * px, target))
    return
  }
  // Chat (§0.1): a bubble with the speaker's name above the text; the corner on the speaker's side is sharp.
  const you = isYou(s.seg)
  const nameH = s.seg.speaker ? px * 0.69 * 1.35 : 0
  const rect = { x: block.x, y: block.y - nameH, w: block.w, h: block.h + nameH }
  const r = Math.min(box.radius * px, rect.h / 2)
  const sharp = Math.min(r, px * 0.25)
  filled(() => {
    c.beginPath()
    c.roundRect(rect.x, rect.y, rect.w, rect.h, you ? [r, r, sharp, r] : [r, r, r, sharp])
  })
  if (s.seg.speaker) {
    c.save()
    const face = chunkFace(d.chunk)
    c.font = `700 ${px * 0.69}px ${face?.stack ?? CAPTION_FONT}`
    c.textBaseline = 'middle'
    c.textAlign = 'left'
    c.direction = 'ltr'
    c.globalAlpha *= 0.7
    c.fillStyle = you ? (studio.theme.youText ?? studio.theme.text) : studio.theme.text
    c.fillText(s.seg.speaker, rect.x + padX, rect.y + padY + nameH / 2)
    c.restore()
  }
}

const chunkFace = (chunk: StudioChunk): StudioFace | null => chunk.lines[0]?.words[0]?.face ?? null

/** News Bar's band (§5.3): from 0.05 to 0.95 of the frame's width, as high as the block. */
const bandRect = (s: Shown, block: Rect): Rect => ({ x: s.w * 0.05, y: block.y, w: s.w * 0.9, h: block.h })

/** The box colour of a chunk: Chat's "You" bubble has its own. */
function chatBoxColour(s: Shown): string {
  if (s.studio.box.kind === 'chat' && isYou(s.seg)) return s.studio.theme.youBox ?? s.studio.theme.box
  return s.studio.theme.box
}

/** The camera bubble's centre when it shows, for Speech Bubble's tail (§0.1); null: the tail points down. */
function cameraCentre(s: Shown, frame: FrameContext | null): { x: number; y: number } | null {
  const cam = frame?.layout.camera
  if (!frame || !cam || !s.project.webcam?.show || cam.opacity <= 0.01) return null
  return { x: cam.rect.x + cam.rect.w / 2, y: cam.rect.y + cam.rect.h / 2 }
}

/** A rounded bubble with a tail of `tail` px pointing at `target` (straight down without one). */
function bubblePath(c: Ctx, r: Rect, radius: number, tail: number, target: { x: number; y: number } | null): void {
  c.beginPath()
  c.roundRect(r.x, r.y, r.w, r.h, radius)
  if (tail <= 0) return
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const to = target ?? { x: cx, y: r.y + r.h + tail * 4 }
  const dx = to.x - cx
  const dy = to.y - cy
  const half = Math.min(tail * 0.55, Math.min(r.w, r.h) / 4)
  const inset = Math.min(radius + half, Math.min(r.w, r.h) / 2)
  // On the side facing the target, its base slid toward the target, clear of the corners; the tip leans toward it.
  if (Math.abs(dx) / Math.max(1, r.w) > Math.abs(dy) / Math.max(1, r.h)) {
    const dir = dx > 0 ? 1 : -1
    const sx = dx > 0 ? r.x + r.w : r.x
    const by = Math.max(r.y + inset, Math.min(r.y + r.h - inset, to.y))
    c.moveTo(sx - dir, by - half)
    c.lineTo(sx + dir * tail, by + Math.max(-half, Math.min(half, (to.y - by) * 0.3)))
    c.lineTo(sx - dir, by + half)
  } else {
    const dir = dy > 0 ? 1 : -1
    const sy = dy > 0 ? r.y + r.h : r.y
    const bx = Math.max(r.x + inset, Math.min(r.x + r.w - inset, to.x))
    c.moveTo(bx - half, sy - dir)
    c.lineTo(bx + Math.max(-half, Math.min(half, (to.x - bx) * 0.3)), sy + dir * tail)
    c.lineTo(bx + half, sy - dir)
  }
  c.closePath()
}

/** The frame's blurred copy for glass (once per frame, whatever number of pills uses it). */
const glassFrames = new WeakMap<FrameContext, { canvas: HTMLCanvasElement | null; w: number; h: number }>()
function glassFrame(frame: FrameContext | null): { canvas: HTMLCanvasElement | null; w: number; h: number } | null {
  if (!frame || typeof document === 'undefined') return null
  let g = glassFrames.get(frame)
  if (!g) glassFrames.set(frame, (g = { canvas: blurredFrameOf(frame.ctx, 256), w: frame.w, h: frame.h }))
  return g
}

/** Frosted glass behind a line (§9.7, §5.3): the blurred frame clipped to the pill, the tint, a top highlight and a light border. */
function drawGlass(c: Ctx, rect: Rect, radius: number, studio: CaptionStudio, tint: string, px: number, glass: { canvas: HTMLCanvasElement | null; w: number; h: number } | null): void {
  c.save()
  c.beginPath()
  c.roundRect(rect.x, rect.y, rect.w, rect.h, radius)
  c.clip()
  if (glass?.canvas) {
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'low'
    c.drawImage(glass.canvas, 0, 0, glass.canvas.width, glass.canvas.height, 0, 0, glass.w, glass.h)
  }
  c.fillStyle = tint
  c.fillRect(rect.x, rect.y, rect.w, rect.h)
  c.fillStyle = 'rgba(255, 255, 255, 0.18)'
  c.fillRect(rect.x, rect.y, rect.w, Math.max(1, 0.015 * px))
  c.restore()
  if (studio.box.border > 0) {
    c.save()
    c.lineWidth = studio.box.border * px
    c.strokeStyle = studio.theme.border ?? 'rgba(255, 255, 255, 0.28)'
    c.beginPath()
    c.roundRect(rect.x, rect.y, rect.w, rect.h, radius)
    c.stroke()
    c.restore()
  }
}

/** The spoken box, pill or underline over the marked words' span (§5.1: padding 0.15 / 0.09 em). */
function drawSpokenMark(c: Ctx, studio: CaptionStudio, rows: Row[], mark: MarkBox, px: number): void {
  const row = rows[mark.line]
  if (!row) return
  const em = row.line.px || px
  const x = row.x + mark.x
  c.save()
  c.globalAlpha *= mark.alpha
  c.fillStyle = studio.theme.spoken
  c.strokeStyle = studio.theme.spoken
  if (studio.spoken === 'underline') {
    // 0.075 em high, 0.14 em below the baseline, round ends.
    c.lineCap = 'round'
    c.lineWidth = 0.075 * em
    const y = row.y + em * 0.32 + 0.14 * em
    c.beginPath()
    c.moveTo(x, y)
    c.lineTo(x + mark.w, y)
    c.stroke()
  } else {
    const padX = 0.15 * em
    const padY = 0.09 * em
    const h = row.height + padY * 2
    const radius = studio.spoken === 'pill' ? h / 2 : 0.125 * em
    c.beginPath()
    c.roundRect(x - padX, row.y - row.height / 2 - padY, mark.w + padX * 2, h, Math.min(radius, h / 2))
    c.fill()
  }
  c.restore()
}

/** The emphasis marker or box behind an emphasised word (§5.1), drawn on in its reading direction. */
function drawEmphasisBox(c: Ctx, studio: CaptionStudio, info: WordInfo, row: Row, x: number, progress: number): void {
  const em = info.box.px
  const colour = info.emphasis === 2 ? (studio.theme.emphasis2 ?? studio.theme.emphasis) : studio.theme.emphasis
  c.save()
  if (studio.emphasis.mark === 'marker') {
    // 0.62 em high, centred 0.08 em below the line's middle, 0.08 em past each side, skewed −6°, radius 0.06 em, α 0.92.
    const h = 0.62 * em
    const rect = { x: x - 0.08 * em, y: row.y + 0.08 * em - h / 2, w: info.box.w + 0.16 * em, h }
    const slack = em
    clipReveal(c, rect.x - slack, rect.y - slack, rect.w + 2 * slack, rect.h + 2 * slack, (rect.w * progress + slack) / (rect.w + 2 * slack), info.dir)
    c.globalAlpha *= 0.92
    c.fillStyle = colour
    c.translate(rect.x + rect.w / 2, rect.y + rect.h / 2)
    c.transform(1, 0, Math.tan((-6 * Math.PI) / 180), 1, 0, 0)
    c.beginPath()
    c.roundRect(-rect.w / 2, -rect.h / 2, rect.w, rect.h, 0.06 * em)
    c.fill()
  } else {
    const padX = 0.15 * em
    const padY = 0.09 * em
    const h = row.height + padY * 2
    const rect = { x: x - padX, y: row.y - row.height / 2 - padY, w: info.box.w + padX * 2, h }
    clipReveal(c, rect.x, rect.y, rect.w, rect.h, progress, info.dir)
    c.fillStyle = colour
    c.beginPath()
    c.roundRect(rect.x, rect.y, rect.w, rect.h, Math.min(0.125 * em, h / 2))
    c.fill()
  }
  c.restore()
}

/** The emphasis underline (§5.1) or the hand-drawn circle (§0.1), drawn on over the word. */
function drawEmphasisLine(c: Ctx, s: Shown, info: WordInfo, row: Row, x: number, progress: number): void {
  const em = info.box.px
  const studio = s.studio
  c.save()
  c.strokeStyle = info.emphasis === 2 ? (studio.theme.emphasis2 ?? studio.theme.emphasis) : studio.theme.emphasis
  c.lineCap = 'round'
  c.lineJoin = 'round'
  if (studio.emphasis.mark === 'underline') {
    c.lineWidth = 0.075 * em
    const y = row.y + em * 0.32 + 0.14 * em
    const from = info.dir === 'rtl' ? x + info.box.w : x
    const to = info.dir === 'rtl' ? x + info.box.w * (1 - progress) : x + info.box.w * progress
    c.beginPath()
    c.moveTo(from, y)
    c.lineTo(to, y)
    c.stroke()
  } else {
    // The mock-up's 3 px stroke at 28 px.
    c.lineWidth = Math.max(1, em * 0.107)
    const len = circlePath(c, x, row.y, info.box.w, em, row.height, seedOf(`${s.seg.id}|${info.token.word}`))
    if (progress < 1) c.setLineDash([len * progress, len * 2])
    c.stroke()
  }
  c.restore()
}

/** Measured prefix advances of a word (cached), for the typewriter in scripts where a prefix draws the same (§9.3). */
const advances = new Map<string, number[]>()
const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
function prefixAdvances(c: Ctx, info: WordInfo): { n: number; adv?: number[] } {
  const parts = graphemes ? [...graphemes.segment(info.box.text)].map((g) => g.segment) : Array.from(info.box.text)
  const n = parts.length
  if (!prefixDrawsSame(info.token.script)) return { n }
  const font = faceFont(info.box.face, info.box.px)
  const key = `${fontGeneration()}|${font}|${info.box.face.tracking}|${info.box.text}`
  let adv = advances.get(key)
  if (!adv) {
    c.save()
    c.font = font
    c.letterSpacing = spacing(info.box.face, info.box.px)
    adv = []
    let acc = ''
    for (const p of parts) {
      acc += p
      adv.push(c.measureText(acc).width)
    }
    c.restore()
    if (advances.size > 4000) advances.clear()
    advances.set(key, adv)
  }
  return { n, adv }
}

/** The typewriter's clip width of a word whose reveal is `reveal` (k / n graphemes): whole letters only (§9.3). */
function typewriterAdvance(c: Ctx, info: WordInfo, reveal: number): number {
  const { n, adv } = prefixAdvances(c, info)
  const k = Math.max(0, Math.min(n, Math.round(reveal * n)))
  return typewriterClip({ graphemes: n, ...(adv ? { prefixAdvances: adv } : {}), width: info.box.w }, k)
}

/** The typewriter caret (§5.3): 0.55 × 1 em after the last shown letter while letters appear, then blinking 0.53 s on, 0.53 s off. */
function drawCaret(c: Ctx, d: ChunkDraw, words: { info: WordInfo; row: Row; x: number }[], poses: Map<number, WordPose>): void {
  let last: { info: WordInfo; row: Row; x: number; reveal: number } | null = null
  for (const w of words) {
    if (w.info.token.word < 0 || w.info.token.start > d.t) continue
    last = { ...w, reveal: poses.get(w.info.box.token)?.reveal ?? 1 }
  }
  if (!last) return
  const em = last.info.box.px
  const typing = last.reveal < 0.999
  if (!typing && Math.floor(viewAt(d.s.project.clips, d.t) / 0.53) % 2 === 1) return
  const clip = typing ? typewriterAdvance(c, last.info, last.reveal) : last.info.box.w
  const x = last.info.dir === 'rtl' ? last.x + last.info.box.w - clip - 0.55 * em - 0.06 * em : last.x + clip + 0.06 * em
  c.save()
  c.fillStyle = d.s.studio.theme.text
  c.fillRect(x, last.row.y - em / 2, 0.55 * em, em)
  c.restore()
}

const STILL: WordPose = { token: -1, dx: 0, dy: 0, scale: 1, scaleX: 1, rotate: 0, alpha: 1, blur: 0, reveal: 1, fill: 0, weight: 0, mark: 0 }

/** One word with its pose: the base sprite, and the lit sprite crossfaded or swept over it (§9.3, §9.7). */
function drawWord(c: Ctx, d: ChunkDraw, info: WordInfo, row: Row, x: number, pose: WordPose | undefined): void {
  const { s } = d
  const { studio } = s
  const em = info.box.px
  const label = info.token.word < 0
  const started = info.token.start <= d.t
  const mark = studio.spoken
  // Speaker labels and emphasised words take no spoken mark; a translated track has none (§9.1 rules 7, 8).
  const spokenOn = d.live && s.spoken && !label && info.emphasis === 0
  const p = pose ?? STILL
  let lit = 0
  let sweep = 0
  if (spokenOn) {
    if (mark === 'fill' || mark === 'gradient') {
      // Estimated words: the fill becomes a whole-word colour change (§9.1 rule 7).
      if (info.token.estimated) lit = started ? 1 : 0
      else sweep = Math.max(0, Math.min(1, p.fill))
    } else if (mark === 'weight') {
      const from = info.box.face.weight
      const to = studio.text.spokenWeight ?? Math.min(900, from + 300)
      lit = Math.max(0, Math.min(1, p.weight > 1 ? (p.weight - from) / Math.max(1, to - from) : p.weight))
    } else if ((mark === 'box' || mark === 'pill') && studio.box.kind !== 'word') lit = d.mark && info.box.token >= d.mark.first && info.box.token <= d.mark.last ? d.mark.alpha : 0
    // Colour, glow and a sticker's colour: the crossfade share motion.ts gives in `fill`.
    else if (mark !== 'none' && mark !== 'underline') lit = Math.max(0, Math.min(1, p.fill))
  }
  const baseState: WordState = !started && studio.theme.upcoming && !label ? 'upcoming' : 'base'
  const basePaint = paintFor(studio, info, baseState)
  const base = spriteOf(basePaint.paint, basePaint.key, info.box.w)
  const litPaint = lit > 0.002 || sweep > 0.002 ? paintFor(studio, info, 'lit') : null
  const litSprite = litPaint ? spriteOf(litPaint.paint, litPaint.key, info.box.w) : null
  const alpha = label ? 1 : p.alpha
  if (alpha <= 0.002) return
  const blur = (label ? 0 : p.blur) + d.pose.blur
  const rest = atRest({ ...p, blur })
  c.save()
  c.globalAlpha *= alpha
  if (!label && !atRest(p)) transformAround(c, x + info.box.w / 2, row.y, p)
  // Wipe and typewriter reveal the whole shaped word by clipping it in its reading direction (§9.3).
  const reveal = label ? 1 : Math.max(0, Math.min(1, p.reveal))
  if (reveal < 0.999) {
    const typewriter = (info.emphasis ? studio.motion.emphasis : studio.motion.word) === 'typewriter'
    const clipW = typewriter ? typewriterAdvance(c, info, reveal) : info.box.w * reveal
    const slack = em * 2
    clipReveal(c, x - slack, row.y - em * 2, info.box.w + 2 * slack, em * 4, (clipW + slack) / (info.box.w + 2 * slack), info.dir)
  }
  if (base && litSprite && lit > 0.002) {
    // A crossfade: colour, glow, weight, a sticker's colour or the text on a spoken box.
    if (lit < 0.998) drawSprite(c, base, x, row.y, blur, em, rest)
    c.globalAlpha *= lit
    drawSprite(c, litSprite, x, row.y, blur, em, rest)
  } else {
    if (base) drawSprite(c, base, x, row.y, blur, em, rest)
    if (litSprite && sweep > 0.002) {
      // The fill sweeps over the word in its reading direction (§9.3).
      c.save()
      const slack = em * 2
      const share = sweep >= 0.999 ? 1 : (info.box.w * sweep + slack) / (info.box.w + 2 * slack)
      clipReveal(c, x - slack, row.y - em * 2, info.box.w + 2 * slack, em * 4, share, info.dir)
      drawSprite(c, litSprite, x, row.y, blur, em, rest)
      c.restore()
    }
  }
  c.restore()
}

/* ---------- the layer ---------- */

const IDLE: ChunkPose = { alpha: 1, dx: 0, dy: 0, scale: 1, scaleX: 1, rotate: 0, blur: 0, reveal: 1 }

/** Applies a chunk pose around the block's centre: its transform, alpha and reveal (a wipe from the reading start). */
function withChunkPose(c: Ctx, s: Shown, block: Rect, pose: ChunkPose, draw: () => void): void {
  if (pose.alpha <= 0.002) return
  c.save()
  c.globalAlpha *= pose.alpha
  if (!atRest({ ...pose, blur: 0 })) transformAround(c, block.x + block.w / 2, block.y + block.h / 2, pose)
  if (pose.reveal < 0.999) {
    const r = s.studio.box.kind === 'band' ? bandRect(s, block) : block
    clipReveal(c, r.x, r.y - r.h, r.w, r.h * 3, pose.reveal, s.layout.rtl ? 'rtl' : 'ltr')
  }
  draw()
  c.restore()
}

/** Draws the shown chunk, and the outgoing one during a hand-over (§9.3), with their poses. */
function drawShown(c: Ctx, s: Shown, t: number, frame: FrameContext | null): void {
  const next = s.segments[s.index + 1]
  const poses = captionPoses(s.layout, s.ci, t, s.project.clips, s.studio, Math.min(s.w, s.h), next ? next.start : null, { spoken: s.spoken })
  const block = blockRect(s, s.chunk, s.placed)
  const band = s.studio.box.kind === 'band'
  c.save()
  if (band) {
    // News Bar: the band stays while its chunks push through it (§5.3); it wipes in with the chunk.
    const r = bandRect(s, block)
    const fill = rgba(s.studio.theme.box, s.studio.box.alpha)
    const bandOnly: ChunkPose = { ...IDLE, alpha: poses.out ? 1 : poses.chunk.alpha, reveal: poses.out ? 1 : poses.chunk.reveal }
    withChunkPose(c, s, block, bandOnly, () => {
      c.fillStyle = fill
      c.beginPath()
      c.roundRect(r.x, r.y, r.w, r.h, Math.min(s.studio.box.radius * s.layout.px, r.h / 2))
      c.fill()
    })
    c.beginPath()
    c.rect(r.x, r.y, r.w, r.h)
    c.clip()
  }
  if (poses.out) {
    const out = s.layout.chunks[poses.out.chunk]
    if (out) {
      // Placed as it was while it showed (the same obstacles, its caption's own position), so the push does not jump.
      const { placed, shiftX } = placeChunkOf(c, s.project, s.seg, s.studio, s.layout, out, s.w, s.h, s.area)
      const shownOut: Shown = { ...s, chunk: out, placed, shiftX }
      const pose = poses.out.pose
      withChunkPose(c, shownOut, blockRect(shownOut, out, placed), band ? { ...pose, reveal: 1 } : pose, () =>
        drawChunk(c, { s: shownOut, chunk: out, placed, pose, words: [], mark: null, t, live: false, noBand: band }, frame)
      )
    }
  }
  withChunkPose(c, s, block, band ? { ...poses.chunk, reveal: poses.out ? 1 : poses.chunk.reveal } : poses.chunk, () =>
    drawChunk(c, { s, chunk: s.chunk, placed: s.placed, pose: poses.chunk, words: poses.words, mark: poses.mark, t, live: true, noBand: band }, frame)
  )
  c.restore()
}

/** The captions of fc.t in a Studio look (drawCaptionsLayer calls it when captions.studio is set). */
export function drawStudioCaptions(fc: FrameContext): void {
  const { ctx, w, h, t, project } = fc
  if (!project.captions?.studio || !project.captions.show) return
  ensureCaptionFonts(project)
  frames.set(project, fc)
  const s = shownAt(ctx, project, t, w, h, fc.textArea)
  if (s) drawShown(ctx, s, t, fc)
}

/* ---------- gallery thumbnails (§2.5) ---------- */

/** The sample caption every thumbnail shows, with its word times (seconds of a 2.4 s loop). */
export const SAMPLE_CAPTION: CaptionSegment = {
  id: 'sample',
  start: 0,
  end: 2.4,
  text: 'Make every word count today',
  words: [
    { text: 'Make', start: 0, end: 0.38 },
    { text: 'every', start: 0.4, end: 0.78 },
    { text: 'word', start: 0.8, end: 1.28 },
    { text: 'count', start: 1.3, end: 1.78 },
    { text: 'today', start: 1.8, end: 2.3 }
  ]
}
/**
 * The Bangla sample (§0.2, from the approved bangla.html): the gallery shows it when the captions
 * are Bangla, with "শেয়ার" spoken at the still thumbnail's time.
 */
export const SAMPLE_CAPTION_BN: CaptionSegment = {
  id: 'sample-bn',
  start: 0,
  end: 2.4,
  text: 'আপনার ভিডিও শেয়ার করার জন্য তৈরি',
  words: [
    { text: 'আপনার', start: 0, end: 0.38 },
    { text: 'ভিডিও', start: 0.4, end: 0.78 },
    { text: 'শেয়ার', start: 0.8, end: 1.28 },
    { text: 'করার', start: 1.3, end: 1.6 },
    { text: 'জন্য', start: 1.62, end: 1.95 },
    { text: 'তৈরি', start: 1.97, end: 2.3 }
  ]
}

/** The sample a thumbnail shows for the captions' language: Bangla for 'bn', else English. */
interface Sample {
  seg: CaptionSegment
  language: 'en' | 'bn'
  scripts: Set<ScriptTag>
}
const SAMPLE_EN: Sample = { seg: SAMPLE_CAPTION, language: 'en', scripts: new Set<ScriptTag>(['latin']) }
const SAMPLE_BN: Sample = { seg: SAMPLE_CAPTION_BN, language: 'bn', scripts: new Set<ScriptTag>(['bengali']) }
const sampleOf = (language: string | undefined): Sample => (language?.toLowerCase().split(/[-_]/)[0] === 'bn' ? SAMPLE_BN : SAMPLE_EN)

/** The still thumbnail's time: "word" is being spoken (§2.5). */
export const SAMPLE_STILL_T = 1.0
/** The loop an animated thumbnail plays (§2.5), seconds. */
export const SAMPLE_LOOP = 2.4

/** The sample's text size (§2.5): 18 px, One Word 28 px; Stacked's smallest line 18 px. */
const SAMPLE_PX = 18
const SAMPLE_PX_ONE_WORD = 28

/** A project holding only the sample caption (no clips: viewing time is source time). */
const sampleProjects = { en: new WeakMap<CaptionStudio, Project>(), bn: new WeakMap<CaptionStudio, Project>() }
function sampleProject(studio: CaptionStudio, sample: Sample = SAMPLE_EN): Project {
  const cache = sampleProjects[sample.language]
  let p = cache.get(studio)
  if (!p) {
    p = {
      id: 'caption-sample',
      clips: [],
      fonts: [],
      transcript: { language: sample.language, segments: [sample.seg] },
      captions: { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'shadow', maxLines: 2, studio }
    } as unknown as Project
    cache.set(studio, p)
  }
  return p
}

/** The look's text size in `frame` (§8.4: size × tall in tall frames × the shorter side). */
const lookPx = (studio: CaptionStudio, frame: { w: number; h: number }): number => studio.text.size * (isTall(frame.w, frame.h) ? studio.text.tall : 1) * Math.min(frame.w, frame.h)

/** The sample laid out in `frame`'s shape scaled by `k`, in a room `room` px wide. */
function sampleLayout(ctx: Ctx, studio: CaptionStudio, frame: { w: number; h: number }, k: number, room: number, sample: Sample): { layout: StudioLayout; vw: number; vh: number; area: Rect } {
  const vw = frame.w * k
  const vh = frame.h * k
  const area: Rect = { x: vw / 2 - room / 2, y: 0, w: room, h: vh }
  const layout = layoutOf({ ctx, project: sampleProject(studio, sample), seg: sample.seg, studio, w: vw, h: vh, area, language: sample.language, scripts: sample.scripts, showSpeaker: false, spoken: true })
  return { layout, vw, vh, area }
}

/**
 * A gallery thumbnail at the sample scale of §2.5: the look's first chunk of "Make every word
 * count today", chunked by its own rules for the project's frame shape (`frame`), drawn with the
 * real word sprites at 18 px (One Word 28 px; Stacked's smallest line 18 px) in a room 84% of the
 * tile wide, at most three lines, centred on the dark grey picture. `tile` and the returned size
 * are in the units `ctx` draws in (CSS px when the caller scales the canvas by its pixel ratio).
 * `language`: the captions' language; 'bn' draws the Bangla sample of §0.2 (SAMPLE_CAPTION_BN) in
 * the look's Bangla font.
 */
export function drawStudioSample(ctx: Ctx, studio: CaptionStudio, frame: { w: number; h: number }, tile: { w: number; h: number }, t: number, language?: string): { textPx: number } {
  const sample = sampleOf(language)
  // Its fonts start loading; fontGeneration() then changes, and sprites (keyed by it) are painted
  // again: a thumbnail drawn again after that shows the font.
  for (const id of catalogFontsFor(sampleProject(studio, sample))) void loadCatalogFont(id)
  ctx.save()
  const bg = ctx.createLinearGradient(0, 0, tile.w, tile.h)
  bg.addColorStop(0, '#2a2d34')
  bg.addColorStop(1, '#3b3f48')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, tile.w, tile.h)
  const target = studio.layout.chunk === 'word' ? SAMPLE_PX_ONE_WORD : SAMPLE_PX
  const full = lookPx(studio, frame)
  const room = tile.w * 0.84
  let k = full > 0 ? target / full : 1
  let { layout, vw, vh, area } = sampleLayout(ctx, studio, frame, k, room, sample)
  const smallest = (l: StudioLayout): number => {
    const sizes = (l.chunks[0]?.lines ?? []).flatMap((line) => line.words.map((wd) => wd.px)).filter((v) => v > 0)
    return sizes.length ? Math.min(...sizes) : target
  }
  // Stacked keeps its line ratios with the smallest line at the sample size.
  if (studio.layout.chunk === 'stack' && smallest(layout) < target - 0.01) {
    k *= target / smallest(layout)
    ;({ layout, vw, vh, area } = sampleLayout(ctx, studio, frame, k, room, sample))
  }
  let textPx = target
  if (layout.chunks.length) {
    const first = layout.chunks[0]
    // At most three lines; words that still do not fit are left out.
    const chunk: StudioChunk = first.lines.length > 3 ? { ...first, lines: first.lines.slice(0, 3) } : first
    const project = sampleProject(studio, sample)
    const placed = placeStudio(layout, chunk, studio, vw, vh, { area })
    const s: Shown = { project, studio, seg: sample.seg, segments: [sample.seg], index: 0, layout, ci: 0, chunk, placed, shiftX: 0, spoken: true, area, w: vw, h: vh }
    const block = blockRect(s, chunk, placed)
    textPx = smallest(layout)
    ctx.translate(Math.round(tile.w / 2 - (block.x + block.w / 2)), Math.round(tile.h / 2 - (block.y + block.h / 2)))
    const poses = captionPoses(layout, 0, t, [], studio, Math.min(vw, vh), null, { spoken: true })
    withChunkPose(ctx, s, block, poses.chunk, () => drawChunk(ctx, { s, chunk, placed, pose: poses.chunk, words: poses.words, mark: poses.mark, t, live: true, noBand: false }, null))
  }
  ctx.restore()
  return { textPx }
}
