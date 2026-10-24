import type { CursorShape } from '../../../shared/types'

type Ctx = CanvasRenderingContext2D

/**
 * Vector cursor sprites, drawn in units of 1/24 of the cursor height with the hotspot at
 * the origin, so they stay crisp at any size and zoom. Each theme is a full set (arrow,
 * hand, I-beam, crosshair, move, resize, busy):
 * - auto: the recorded shapes in the look the app always had (Windows-like);
 * - windows: Windows 11 (white arrow, thin black outline, soft shadow);
 * - mac: macOS (black arrow with a white border and a soft shadow);
 * - white / black: high-contrast sets with a heavy outline (drawn larger, see CURSOR_STYLE_SCALE).
 */
export type SpriteTheme = 'auto' | 'mac' | 'windows' | 'white' | 'black'

interface Sprite {
  /** Filled-and-outlined shapes. */
  body?: Path2D
  /** Thin strokes drawn with a halo (I-beam, crosshair). */
  lines?: Path2D
  /** Inner detail lines drawn after the body. */
  detail?: Path2D
}

type SpriteSet = Record<Exclude<CursorShape, 'wait'>, Sprite>

interface Theme {
  fill: string
  outline: string
  /**
   * Outline width in sprite units, drawn OUTSIDE the body (stroke 2x wide, then fill on
   * top), so a heavy outline never eats into the shape. 0 = the legacy centred stroke.
   */
  outlineWidth: number
  /** Legacy centred stroke (auto theme only). */
  centredStroke?: { color: string; width: number }
  shadow: { color: string; blur: number; y: number } | null
  /** I-beam / crosshair core and halo. */
  line: { core: string; coreWidth: number; halo: string; haloWidth: number }
  /** Hand detail lines. */
  detail: { color: string; width: number }
  busy: 'windows' | 'mac' | 'mono'
}

const THEMES: Record<SpriteTheme, Theme> = {
  auto: {
    fill: '#fff',
    outline: '#111',
    outlineWidth: 0,
    centredStroke: { color: '#111', width: 1.3 },
    shadow: { color: 'rgba(0,0,0,0.35)', blur: 2.5, y: 1 },
    line: { core: '#111', coreWidth: 1.4, halo: '#fff', haloWidth: 3.4 },
    detail: { color: '#111', width: 0.9 },
    busy: 'windows'
  },
  windows: {
    fill: '#fff',
    outline: '#000',
    outlineWidth: 0.85,
    shadow: { color: 'rgba(0,0,0,0.4)', blur: 1.6, y: 0.9 },
    line: { core: '#000', coreWidth: 1.25, halo: '#fff', haloWidth: 3.2 },
    detail: { color: '#000', width: 0.8 },
    busy: 'windows'
  },
  mac: {
    fill: '#000',
    outline: '#fff',
    outlineWidth: 1.35,
    shadow: { color: 'rgba(0,0,0,0.45)', blur: 3.2, y: 1.3 },
    line: { core: '#000', coreWidth: 1.5, halo: '#fff', haloWidth: 3.8 },
    detail: { color: '#fff', width: 0.85 },
    busy: 'mac'
  },
  white: {
    fill: '#fff',
    outline: '#000',
    outlineWidth: 1.6,
    shadow: null,
    line: { core: '#fff', coreWidth: 2, halo: '#000', haloWidth: 5 },
    detail: { color: '#000', width: 1.1 },
    busy: 'mono'
  },
  black: {
    fill: '#000',
    outline: '#fff',
    outlineWidth: 1.6,
    shadow: null,
    line: { core: '#000', coreWidth: 2, halo: '#fff', haloWidth: 5 },
    detail: { color: '#fff', width: 1.1 },
    busy: 'mono'
  }
}

let sets: Record<SpriteTheme, SpriteSet> | null = null

function buildSets(): Record<SpriteTheme, SpriteSet> {
  const hand = new Path2D(
    'M-1.6 1.6 A1.6 1.6 0 0 1 1.6 1.6 L1.6 8.5 A1.5 1.5 0 0 1 4.6 8.5 L4.6 9.3 A1.4 1.4 0 0 1 7.4 9.3 L7.4 10.4 ' +
      'A1.3 1.3 0 0 1 10 10.4 L10 15.5 Q10 21 6 21.5 L0.5 21.5 Q-1.5 21.5 -3 19 L-6.4 13.6 A1.5 1.5 0 0 1 -4 12 L-1.6 14.5 Z'
  )
  const handDetail = new Path2D('M1.6 9.6 L1.6 13 M4.6 9.8 L4.6 13.2 M7.4 10.8 L7.4 13.5')
  const ibeam = new Path2D('M-3.5 -9 Q0 -9.2 0 -7.5 Q0 -9.2 3.5 -9 M0 -7.5 L0 7.5 M-3.5 9 Q0 9.2 0 7.5 Q0 9.2 3.5 9 M-2 0 L2 0')
  const cross = new Path2D('M-9 0 L-2 0 M2 0 L9 0 M0 -9 L0 -2 M0 2 L0 9')
  const move = new Path2D(
    'M0 -10 L3 -7 L1 -7 L1 -1 L7 -1 L7 -3 L10 0 L7 3 L7 1 L1 1 L1 7 L3 7 L0 10 L-3 7 L-1 7 L-1 1 L-7 1 L-7 3 ' +
      'L-10 0 L-7 -3 L-7 -1 L-1 -1 L-1 -7 L-3 -7 Z'
  )
  const ew = new Path2D('M-10 0 L-6 -4 L-6 -1.3 L6 -1.3 L6 -4 L10 0 L6 4 L6 1.3 L-6 1.3 L-6 4 Z')
  const ns = new Path2D('M0 -10 L-4 -6 L-1.3 -6 L-1.3 6 L-4 6 L0 10 L4 6 L1.3 6 L1.3 -6 L4 -6 Z')
  const common = { pointer: { body: hand, detail: handDetail }, text: { lines: ibeam }, crosshair: { lines: cross }, move: { body: move }, 'resize-ew': { body: ew }, 'resize-ns': { body: ns } }
  const set = (arrow: string): SpriteSet => ({ arrow: { body: new Path2D(arrow) }, ...common })
  return {
    // The arrow the app always drew.
    auto: set('M0 0 L0 19 L4.6 14.6 L7.6 21.6 L10.8 20.2 L7.9 13.4 L14 13.4 Z'),
    // Windows 11: slimmer, the tail leaves the notch at a steep angle.
    windows: set('M0 0 L0 17.4 L4.1 13.6 L6.9 20 L9.5 18.9 L6.8 12.7 L12.4 12.7 Z'),
    // macOS: a broad head and a short, steep tail with a squared end.
    mac: set('M0 0 L0 17.8 L4.2 13.9 L6.7 19.9 L9.8 18.7 L7.3 12.9 L12.8 12.9 Z'),
    // High contrast: a chunky head and a wide tail that stays readable when small.
    white: set('M0 0 L0 17.8 L4.4 13.7 L7.1 19.9 L10.3 18.5 L7.7 12.6 L13.2 12.6 Z'),
    black: set('M0 0 L0 17.8 L4.4 13.7 L7.1 19.9 L10.3 18.5 L7.7 12.6 L13.2 12.6 Z')
  }
}

export interface SpriteOptions {
  theme?: SpriteTheme
  /** Rotation (radians, clockwise) about the hotspot. */
  angle?: number
  /** Draw the drop shadow (off for trail ghosts). Default true. */
  shadow?: boolean
  /**
   * A trail ghost: only the body colour (no outline, details or shadow), so overlapping
   * ghosts blend into one smooth streak instead of a stack of outlines.
   */
  ghost?: boolean
}

/**
 * Draws the cursor `shape` with its hotspot at (x, y), `height` output pixels tall.
 * `t` animates the busy cursor.
 */
export function drawCursorSprite(ctx: Ctx, shape: CursorShape, x: number, y: number, height: number, alpha: number, t: number, opts: SpriteOptions = {}): void {
  sets ??= buildSets()
  const themeId = opts.theme ?? 'auto'
  const theme = THEMES[themeId]
  const withShadow = opts.shadow !== false && theme.shadow !== null
  const unit = height / 24
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.translate(x, y)
  if (opts.angle) ctx.rotate(opts.angle)
  ctx.scale(unit, unit)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (shape === 'wait') {
    if (!opts.ghost) drawBusy(ctx, theme, unit, t, withShadow)
    ctx.restore()
    return
  }
  const sprite = sets[themeId][shape] ?? sets[themeId].arrow
  if (opts.ghost) {
    if (sprite.body) {
      ctx.fillStyle = theme.fill
      ctx.fill(sprite.body)
    }
    if (sprite.lines) {
      ctx.lineWidth = theme.line.coreWidth
      ctx.strokeStyle = theme.line.core
      ctx.stroke(sprite.lines)
    }
    ctx.restore()
    return
  }
  const shadowOn = (): void => {
    if (!withShadow || !theme.shadow) return
    ctx.shadowColor = theme.shadow.color
    ctx.shadowBlur = theme.shadow.blur * unit
    ctx.shadowOffsetY = theme.shadow.y * unit
  }
  const shadowOff = (): void => {
    ctx.shadowColor = 'transparent'
  }
  if (sprite.body) {
    if (theme.centredStroke) {
      shadowOn()
      ctx.fillStyle = theme.fill
      ctx.fill(sprite.body)
      shadowOff()
      ctx.lineWidth = theme.centredStroke.width
      ctx.strokeStyle = theme.centredStroke.color
      ctx.stroke(sprite.body)
    } else {
      shadowOn()
      ctx.lineWidth = theme.outlineWidth * 2
      ctx.strokeStyle = theme.outline
      ctx.stroke(sprite.body)
      shadowOff()
      ctx.fillStyle = theme.fill
      ctx.fill(sprite.body)
    }
  }
  if (sprite.detail) {
    ctx.lineWidth = theme.detail.width
    ctx.strokeStyle = theme.detail.color
    ctx.stroke(sprite.detail)
  }
  if (sprite.lines) {
    if (withShadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.3)'
      ctx.shadowBlur = 2 * unit
    }
    ctx.lineWidth = theme.line.haloWidth
    ctx.strokeStyle = theme.line.halo
    ctx.stroke(sprite.lines)
    shadowOff()
    ctx.lineWidth = theme.line.coreWidth
    ctx.strokeStyle = theme.line.core
    ctx.stroke(sprite.lines)
  }
  ctx.restore()
}

/** Busy cursors: the Windows ring with a spinning blue arc, the macOS spinning wheel, or a plain high-contrast ring. */
function drawBusy(ctx: Ctx, theme: Theme, unit: number, t: number, shadow: boolean): void {
  const r = 7
  const a = (t * Math.PI * 2) % (Math.PI * 2)
  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.3)'
    ctx.shadowBlur = 2.5 * unit
  }
  if (theme.busy === 'mac') {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.shadowColor = 'transparent'
    const colors = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de']
    const n = colors.length
    for (let i = 0; i < n; i++) {
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.arc(0, 0, r - 0.9, a + (i / n) * Math.PI * 2, a + ((i + 1) / n) * Math.PI * 2 + 0.02)
      ctx.closePath()
      ctx.fillStyle = colors[i]
      ctx.fill()
    }
    ctx.beginPath()
    ctx.arc(0, 0, r - 0.9, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fill()
    return
  }
  const mono = theme.busy === 'mono'
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.lineWidth = mono ? 5.6 : 4.2
  ctx.strokeStyle = mono ? theme.outline : 'rgba(255,255,255,0.95)'
  ctx.stroke()
  ctx.shadowColor = 'transparent'
  if (mono) {
    ctx.lineWidth = 2.8
    ctx.strokeStyle = theme.fill
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.arc(0, 0, r, a, a + Math.PI * 0.6)
  ctx.lineWidth = mono ? 2.8 : 2.6
  ctx.strokeStyle = mono ? theme.outline : '#2f7de1'
  ctx.stroke()
}

/**
 * A custom cursor image with its top-left corner (the hotspot) at (x, y), `height` output
 * pixels tall (width follows the image's aspect ratio).
 */
export function drawCursorImage(
  ctx: Ctx,
  image: CanvasImageSource,
  aspect: number,
  x: number,
  y: number,
  height: number,
  alpha: number,
  opts: Pick<SpriteOptions, 'angle' | 'shadow'> = {}
): void {
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.translate(x, y)
  if (opts.angle) ctx.rotate(opts.angle)
  if (opts.shadow !== false) {
    ctx.shadowColor = 'rgba(0,0,0,0.3)'
    ctx.shadowBlur = height * 0.08
    ctx.shadowOffsetY = height * 0.035
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, height * aspect, height)
  ctx.restore()
}
