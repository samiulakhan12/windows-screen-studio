/**
 * The part of a canvas 2D context that shared drawing code (wallpapers, animated gradients)
 * uses. A real CanvasRenderingContext2D satisfies it; shared code compiles without DOM types
 * and unit tests can pass a recording stand-in.
 */
export interface Gradient2D {
  addColorStop(offset: number, color: string): void
}

export interface Draw2D {
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  globalAlpha: number
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient2D
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient2D
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, start: number, end: number): void
  fill(): void
  stroke(): void
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  scale(x: number, y: number): void
}

/** "#rrggbb" with an alpha, as rgba() (for gradients that fade a colour out). */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** Fills the frame with a CSS-style linear gradient (0deg points up, 90deg right). */
export function fillLinear(ctx: Draw2D, w: number, h: number, angle: number, stops: string[]): void {
  const a = ((angle - 90) * Math.PI) / 180
  const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))
  const dx = (Math.cos(a) * len) / 2
  const dy = (Math.sin(a) * len) / 2
  const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy)
  stops.forEach((c, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

/**
 * A soft round glow of `color` centred at (x, y) (fractions of the frame), fading out over
 * `r` times the frame's longer side, so it stays round whatever the frame's shape.
 */
export function softBlob(ctx: Draw2D, w: number, h: number, x: number, y: number, r: number, color: string, alpha = 1): void {
  const cx = x * w
  const cy = y * h
  const radius = Math.max(1e-3, r * Math.max(w, h))
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
  g.addColorStop(0, rgba(color, alpha))
  g.addColorStop(0.5, rgba(color, alpha * 0.55))
  g.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}
