import type { CardBorder, ShadowStyle, StyleSettings } from '../types'
import { clamp } from './math'

/**
 * The recording card's border and shadow, resolved from a style with defaults (older
 * projects have none of these fields and keep the original soft drop shadow, no border).
 */

export const SHADOW_STYLES: ShadowStyle[] = ['soft', 'hard', 'glow']
export const BORDER_WIDTH = { min: 0, max: 24 } as const
/** Shadow colour when a hard or glow shadow has none of its own. */
export const DEFAULT_SHADOW_COLORS: Record<Exclude<ShadowStyle, 'soft'>, string> = { hard: '#111827', glow: '#8b5cf6' }
export const DEFAULT_BORDER: CardBorder = { width: 6, color: '#ffffff', glass: true }

const HEX = /^#[0-9a-f]{6}$/i

export interface CardLook {
  shadowStyle: ShadowStyle
  /** Colour of a hard or glow shadow. */
  shadowColor: string
  /** null when there is no border (absent or zero width). */
  border: CardBorder | null
}

export function cardLook(style: Pick<StyleSettings, 'shadowStyle' | 'shadowColor' | 'border'>): CardLook {
  const shadowStyle = SHADOW_STYLES.includes(style.shadowStyle as ShadowStyle) ? (style.shadowStyle as ShadowStyle) : 'soft'
  const shadowColor =
    typeof style.shadowColor === 'string' && HEX.test(style.shadowColor) ? style.shadowColor : shadowStyle === 'soft' ? '#000000' : DEFAULT_SHADOW_COLORS[shadowStyle]
  const b = style.border
  const width = b && typeof b.width === 'number' && Number.isFinite(b.width) ? clamp(b.width, BORDER_WIDTH.min, BORDER_WIDTH.max) : 0
  const border = b && width > 0 ? { width, color: typeof b.color === 'string' && HEX.test(b.color) ? b.color : '#ffffff', glass: b.glass === true } : null
  return { shadowStyle, shadowColor, border }
}

/** How a shadow of strength `shadow` (0..1) is drawn at scale `k` (1080p-referenced sizes). */
export type ShadowPaint =
  | { kind: 'blur'; color: string; blur: number; offsetX: number; offsetY: number }
  | { kind: 'solid'; color: string; offsetX: number; offsetY: number }

export function shadowPaint(look: CardLook, shadow: number, k: number): ShadowPaint | null {
  if (!(shadow > 0)) return null
  switch (look.shadowStyle) {
    case 'hard': {
      // A solid copy of the card, offset down and to the right.
      const d = Math.max(1, 26 * k * shadow)
      return { kind: 'solid', color: look.shadowColor, offsetX: d, offsetY: d }
    }
    case 'glow':
      return { kind: 'blur', color: withAlpha(look.shadowColor, Math.min(1, 0.35 + 0.65 * shadow)), blur: 110 * k * shadow, offsetX: 0, offsetY: 0 }
    default:
      // The original drop shadow (kept exactly, so older projects render as before).
      return { kind: 'blur', color: `rgba(0,0,0,${0.55 * shadow})`, blur: 70 * k * shadow, offsetX: 0, offsetY: 22 * k * shadow }
  }
}

/** How far a shadow reaches past the card (output px), to bound what a cached card layer must hold. */
export function shadowReach(paint: ShadowPaint | null): number {
  if (!paint) return 0
  const off = Math.max(Math.abs(paint.offsetX), Math.abs(paint.offsetY))
  return paint.kind === 'blur' ? paint.blur * 1.5 + off : off
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${+alpha.toFixed(3)})`
}
