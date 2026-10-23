import type { CursorShape } from '../../../shared/types'

type Ctx = CanvasRenderingContext2D

/**
 * Vector cursor sprites in the Windows style (white body, dark outline), drawn in
 * units of 1/24 of the cursor height with the hotspot at the origin.
 */
interface Sprite {
  /** Filled-and-outlined shapes. */
  body?: Path2D
  /** Thin strokes drawn with a light halo (I-beam, crosshair). */
  lines?: Path2D
  /** Inner detail lines drawn after the body. */
  detail?: Path2D
}

let sprites: Record<Exclude<CursorShape, 'wait'>, Sprite> | null = null

function buildSprites(): Record<Exclude<CursorShape, 'wait'>, Sprite> {
  const arrow = new Path2D('M0 0 L0 19 L4.6 14.6 L7.6 21.6 L10.8 20.2 L7.9 13.4 L14 13.4 Z')
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
  return {
    arrow: { body: arrow },
    pointer: { body: hand, detail: handDetail },
    text: { lines: ibeam },
    crosshair: { lines: cross },
    move: { body: move },
    'resize-ew': { body: ew },
    'resize-ns': { body: ns }
  }
}

/**
 * Draws the cursor `shape` with its hotspot at (x, y), `height` output pixels tall.
 * `t` animates the busy cursor.
 */
export function drawCursorSprite(ctx: Ctx, shape: CursorShape, x: number, y: number, height: number, alpha: number, t: number): void {
  sprites ??= buildSprites()
  const unit = height / 24
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.translate(x, y)
  ctx.scale(unit, unit)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (shape === 'wait') {
    drawBusy(ctx, unit, t)
    ctx.restore()
    return
  }
  const sprite = sprites[shape] ?? sprites.arrow
  if (sprite.body) {
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = 2.5 * unit
    ctx.shadowOffsetY = 1 * unit
    ctx.fillStyle = '#fff'
    ctx.fill(sprite.body)
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1.3
    ctx.strokeStyle = '#111'
    ctx.stroke(sprite.body)
  }
  if (sprite.detail) {
    ctx.lineWidth = 0.9
    ctx.stroke(sprite.detail)
  }
  if (sprite.lines) {
    ctx.shadowColor = 'rgba(0,0,0,0.3)'
    ctx.shadowBlur = 2 * unit
    ctx.lineWidth = 3.4
    ctx.strokeStyle = '#fff'
    ctx.stroke(sprite.lines)
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1.4
    ctx.strokeStyle = '#111'
    ctx.stroke(sprite.lines)
  }
  ctx.restore()
}

/** The Windows busy cursor: a ring with a spinning blue arc. */
function drawBusy(ctx: Ctx, unit: number, t: number): void {
  const r = 7
  ctx.shadowColor = 'rgba(0,0,0,0.3)'
  ctx.shadowBlur = 2.5 * unit
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.lineWidth = 4.2
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.stroke()
  ctx.shadowColor = 'transparent'
  const a = (t * Math.PI * 2) % (Math.PI * 2)
  ctx.beginPath()
  ctx.arc(0, 0, r, a, a + Math.PI * 0.6)
  ctx.lineWidth = 2.6
  ctx.strokeStyle = '#2f7de1'
  ctx.stroke()
}
