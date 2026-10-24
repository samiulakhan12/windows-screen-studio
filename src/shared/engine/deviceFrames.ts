import type { DeviceFrame, DeviceFrameKind, StyleSettings } from '../types'
import type { Rect } from './layout'

/**
 * Device chrome drawn around the recording (browser window, laptop, monitor, phone), as
 * plain geometry: the renderer paints the parts in order, so the frames are vectors that stay
 * crisp at any size. Every size is a multiple of `u`, the shorter side of the recording's
 * rectangle, so the chrome shrinks and moves with the card when the camera pulls back.
 */

export const FRAME_KINDS: DeviceFrameKind[] = ['none', 'browser', 'laptop', 'monitor', 'phone']
const THEMES: DeviceFrame['theme'][] = ['light', 'dark']

/** Corner radii: top-left, top-right, bottom-right, bottom-left. */
export type Radii = [number, number, number, number]

/** A solid colour or a linear gradient (output pixels, colour stops 0..1). */
export type Paint = string | { x0: number; y0: number; x1: number; y1: number; stops: [number, string][] }

export type FramePart =
  | { type: 'rrect'; rect: Rect; radii: Radii; fill: Paint }
  | { type: 'circle'; x: number; y: number; r: number; fill: Paint }
  /** One line of text centred on (x, y), shortened with an ellipsis to fit `maxWidth`. */
  | { type: 'text'; text: string; x: number; y: number; size: number; color: string; maxWidth: number }

export interface FrameDrawing {
  /** Bounding box of the chrome (the recording included). */
  outer: Rect
  /** Shapes that cast the card's shadow; the first is the body a border goes around. */
  outline: { rect: Rect; radii: Radii }[]
  /** Painted in order, under the recording. */
  parts: FramePart[]
  /** Corners of the recording itself. */
  screenRadii: Radii
}

/** Chrome around the recording, in multiples of the recording's shorter side. */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

// Browser: title bar height.
const BAR = 0.062
// Laptop: lid rim, black bezel (sides, top, bottom), base slab and how far it overhangs the lid.
const LID_RIM = 0.004
const LID_SIDE = 0.028
const LID_TOP = 0.042
const LID_BOTTOM = 0.05
const BASE_H = 0.034
const BASE_OVERHANG = 0.075
// Monitor: coloured rim, black bezel, stand neck and foot.
const MON_RIM = 0.008
const MON_BEZEL = 0.018
const NECK_H = 0.15
const FOOT_H = 0.024
// Phone: rim, black bezel (sides, top/bottom), side buttons.
const PHONE_RIM = 0.014
const PHONE_SIDE = 0.036
const PHONE_END = 0.075
const PHONE_BUTTON = 0.007

const INSETS: Record<DeviceFrameKind, Insets> = {
  none: NO_INSETS,
  browser: { top: BAR, right: 0, bottom: 0, left: 0 },
  laptop: {
    top: LID_RIM + LID_TOP,
    bottom: LID_BOTTOM + LID_RIM + BASE_H,
    left: LID_RIM + LID_SIDE + BASE_OVERHANG,
    right: LID_RIM + LID_SIDE + BASE_OVERHANG
  },
  monitor: { top: MON_RIM + MON_BEZEL, bottom: MON_RIM + MON_BEZEL + NECK_H + FOOT_H, left: MON_RIM + MON_BEZEL, right: MON_RIM + MON_BEZEL },
  phone: { top: PHONE_RIM + PHONE_END, bottom: PHONE_RIM + PHONE_END, left: PHONE_RIM + PHONE_SIDE + PHONE_BUTTON, right: PHONE_RIM + PHONE_SIDE + PHONE_BUTTON }
}

/** How much chrome a frame adds on each side of the recording (multiples of its shorter side). */
export const frameInsets = (kind: DeviceFrameKind): Insets => INSETS[kind] ?? NO_INSETS

/** The style's device frame with valid fields, or null for none (absent, 'none' or unknown). */
export function frameOf(style: Pick<StyleSettings, 'frame'>): DeviceFrame | null {
  const f = style.frame
  if (!f || typeof f !== 'object' || f.kind === 'none' || !FRAME_KINDS.includes(f.kind)) return null
  const theme = THEMES.includes(f.theme) ? f.theme : 'light'
  return typeof f.title === 'string' ? { kind: f.kind, theme, title: f.title } : { kind: f.kind, theme }
}

/** The text in the browser frame's address bar: its own title, else the project's name. */
export function frameTitle(style: Pick<StyleSettings, 'frame'>, projectName: string): string {
  const own = style.frame?.title
  return (typeof own === 'string' && own.trim() ? own : projectName).trim()
}

/** Device frames draw their own bezel: a card border only goes around a bare recording or a browser window. */
export const frameTakesBorder = (frame: DeviceFrame | null): boolean => !frame || frame.kind === 'browser'

/** Device frames set the recording's corners themselves; the corner radius applies to bare recordings and browser windows. */
export const frameUsesRadius = (frame: DeviceFrame | null): boolean => !frame || frame.kind === 'browser'

const clampRadius = (r: number, rect: Rect): number => Math.max(0, Math.min(r, rect.w / 2, rect.h / 2))
const all = (r: number): Radii => [r, r, r, r]
const expand = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 })

/** Corners of the recording for a frame (`radius`: the style's corner radius in output pixels). */
export function screenRadii(frame: DeviceFrame | null, screen: Rect, radius: number): Radii {
  const u = Math.min(screen.w, screen.h)
  switch (frame?.kind) {
    case 'browser': {
      const r = clampRadius(radius, screen)
      return [0, 0, r, r]
    }
    case 'laptop':
      return all(0.01 * u)
    case 'monitor':
      return all(0.005 * u)
    case 'phone':
      return all(0.075 * u)
    default:
      return all(clampRadius(radius, screen))
  }
}

/** The recording's largest corner radius (what layers clipping to the recording use). */
export const screenCornerRadius = (frame: DeviceFrame | null, screen: Rect, radius: number): number => Math.max(...screenRadii(frame, screen, radius))

/**
 * The chrome of `frame` around a recording drawn at `screen` (output pixels). `radius` is the
 * style's corner radius in output pixels (browser windows use it); `title` is the address bar text.
 */
export function deviceFrameDrawing(frame: DeviceFrame, screen: Rect, opts: { radius: number; title: string }): FrameDrawing {
  const u = Math.min(screen.w, screen.h)
  const ins = frameInsets(frame.kind)
  const outer = { x: screen.x - ins.left * u, y: screen.y - ins.top * u, w: screen.w + (ins.left + ins.right) * u, h: screen.h + (ins.top + ins.bottom) * u }
  const dark = frame.theme === 'dark'
  const radii = screenRadii(frame, screen, opts.radius)
  switch (frame.kind) {
    case 'browser':
      return { outer, ...browser(screen, u, dark, opts.radius, opts.title), screenRadii: radii }
    case 'laptop':
      return { outer, ...laptop(screen, u, dark), screenRadii: radii }
    case 'monitor':
      return { outer, ...monitor(screen, u, dark), screenRadii: radii }
    case 'phone':
      return { outer, ...phone(screen, u, dark), screenRadii: radii }
    default:
      return { outer, outline: [{ rect: screen, radii }], parts: [], screenRadii: radii }
  }
}

type Chrome = Pick<FrameDrawing, 'outline' | 'parts'>

const vertical = (r: Rect, stops: [number, string][]): Paint => ({ x0: 0, y0: r.y, x1: 0, y1: r.y + r.h, stops })
const horizontal = (r: Rect, stops: [number, string][]): Paint => ({ x0: r.x, y0: 0, x1: r.x + r.w, y1: 0, stops })

const TRAFFIC_LIGHTS = ['#ff5f57', '#febc2e', '#28c840']

function browser(s: Rect, u: number, dark: boolean, radius: number, title: string): Chrome {
  const barH = BAR * u
  const win = { x: s.x, y: s.y - barH, w: s.w, h: s.h + barH }
  // The bar's rounding never reaches down into the recording.
  const r = clampRadius(radius, win)
  const rt = Math.min(r, barH)
  const bar = { x: s.x, y: s.y - barH, w: s.w, h: barH }
  const cy = bar.y + barH / 2
  const parts: FramePart[] = [
    { type: 'rrect', rect: bar, radii: [rt, rt, 0, 0], fill: vertical(bar, dark ? [[0, '#2c2c31'], [1, '#232327']] : [[0, '#f7f7f8'], [1, '#e9e9ec']]) },
    // Hairline between the bar and the page.
    { type: 'rrect', rect: { x: s.x, y: s.y - Math.max(0.75, u * 0.0012), w: s.w, h: Math.max(0.75, u * 0.0012) }, radii: all(0), fill: dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.12)' }
  ]
  const dotR = barH * 0.115
  const step = barH * 0.36
  const x0 = s.x + barH * 0.5
  TRAFFIC_LIGHTS.forEach((fill, i) => parts.push({ type: 'circle', x: x0 + i * step, y: cy, r: dotR, fill }))
  // The address field is centred, clear of the window buttons.
  const side = x0 + 2 * step + dotR + barH * 0.35 - s.x
  const fieldW = Math.min(s.w * 0.46, s.w - side * 2)
  const fieldH = barH * 0.58
  if (fieldW > barH * 1.5) {
    const field = { x: s.x + (s.w - fieldW) / 2, y: cy - fieldH / 2, w: fieldW, h: fieldH }
    parts.push({ type: 'rrect', rect: field, radii: all(fieldH * 0.3), fill: dark ? '#3a3a41' : '#ffffff' })
    if (title) parts.push({ type: 'text', text: title, x: field.x + fieldW / 2, y: cy, size: barH * 0.32, color: dark ? '#d4d4d8' : '#52525b', maxWidth: fieldW - fieldH })
  }
  return { outline: [{ rect: win, radii: [rt, rt, r, r] }], parts }
}

function laptop(s: Rect, u: number, dark: boolean): Chrome {
  const bezel = { x: s.x - LID_SIDE * u, y: s.y - LID_TOP * u, w: s.w + LID_SIDE * 2 * u, h: s.h + (LID_TOP + LID_BOTTOM) * u }
  const lid = expand(bezel, LID_RIM * u)
  const lidRadii: Radii = [0.035 * u, 0.035 * u, 0.012 * u, 0.012 * u]
  const base = { x: lid.x - BASE_OVERHANG * u, y: lid.y + lid.h, w: lid.w + BASE_OVERHANG * 2 * u, h: BASE_H * u }
  const baseRadii: Radii = [0.003 * u, 0.003 * u, 0.028 * u, 0.028 * u]
  const notchW = 0.15 * u
  const notch = { x: base.x + (base.w - notchW) / 2, y: base.y, w: notchW, h: 0.011 * u }
  const camY = bezel.y + (LID_TOP * u) / 2
  return {
    outline: [
      { rect: lid, radii: lidRadii },
      { rect: base, radii: baseRadii }
    ],
    parts: [
      { type: 'rrect', rect: lid, radii: lidRadii, fill: dark ? '#3a3b40' : '#c9ccd2' },
      { type: 'rrect', rect: bezel, radii: lidRadii.map((r) => Math.max(0, r - LID_RIM * u)) as Radii, fill: '#0b0b0d' },
      { type: 'circle', x: s.x + s.w / 2, y: camY, r: 0.0055 * u, fill: '#1c1c22' },
      { type: 'circle', x: s.x + s.w / 2, y: camY, r: 0.0022 * u, fill: '#2f3b52' },
      {
        type: 'rrect',
        rect: base,
        radii: baseRadii,
        fill: vertical(base, dark ? [[0, '#5a5c62'], [0.45, '#3d3f44'], [1, '#26272b']] : [[0, '#eef0f3'], [0.45, '#d3d6db'], [1, '#a9adb4']])
      },
      { type: 'rrect', rect: notch, radii: [0, 0, 0.008 * u, 0.008 * u], fill: dark ? '#2b2c30' : '#b9bcc3' }
    ]
  }
}

function monitor(s: Rect, u: number, dark: boolean): Chrome {
  const bezel = expand(s, MON_BEZEL * u)
  const body = expand(bezel, MON_RIM * u)
  const neckW = 0.13 * u
  const footW = 0.36 * u
  const footY = body.y + body.h + NECK_H * u
  // The neck starts a little under the body so no seam shows between them.
  const neck = { x: s.x + (s.w - neckW) / 2, y: body.y + body.h - 0.01 * u, w: neckW, h: NECK_H * u + 0.01 * u }
  const foot = { x: s.x + (s.w - footW) / 2, y: footY, w: footW, h: FOOT_H * u }
  const footRadii: Radii = [0.006 * u, 0.006 * u, 0.012 * u, 0.012 * u]
  const bodyRadii = all(0.02 * u)
  return {
    outline: [
      { rect: body, radii: bodyRadii },
      { rect: neck, radii: all(0) },
      { rect: foot, radii: footRadii }
    ],
    parts: [
      { type: 'rrect', rect: neck, radii: all(0), fill: horizontal(neck, dark ? [[0, '#202124'], [0.5, '#36383c'], [1, '#202124']] : [[0, '#c4c7cd'], [0.5, '#eceef1'], [1, '#c4c7cd']]) },
      { type: 'rrect', rect: foot, radii: footRadii, fill: vertical(foot, dark ? [[0, '#3a3c40'], [1, '#1c1d20']] : [[0, '#eceef1'], [1, '#c4c7cd']]) },
      { type: 'rrect', rect: body, radii: bodyRadii, fill: dark ? '#1a1a1d' : '#e4e5e9' },
      { type: 'rrect', rect: bezel, radii: all(0.012 * u), fill: '#0a0a0b' }
    ]
  }
}

function phone(s: Rect, u: number, dark: boolean): Chrome {
  const bezel = { x: s.x - PHONE_SIDE * u, y: s.y - PHONE_END * u, w: s.w + PHONE_SIDE * 2 * u, h: s.h + PHONE_END * 2 * u }
  const body = expand(bezel, PHONE_RIM * u)
  const bodyR = 0.13 * u
  const button = (left: boolean, at: number, len: number): FramePart => ({
    type: 'rrect',
    rect: { x: left ? body.x - PHONE_BUTTON * u : body.x + body.w - 0.002 * u, y: body.y + body.h * at, w: (PHONE_BUTTON + 0.002) * u, h: body.h * len },
    radii: all(0.003 * u),
    fill: dark ? '#2a2b2f' : '#c3c6cc'
  })
  const islandW = 0.26 * u
  const islandH = 0.036 * u
  const island = { x: s.x + (s.w - islandW) / 2, y: bezel.y + (PHONE_END * u - islandH) / 2, w: islandW, h: islandH }
  const lensX = island.x + islandW - islandH / 2
  const lensY = island.y + islandH / 2
  return {
    outline: [{ rect: body, radii: all(bodyR) }],
    parts: [
      button(true, 0.2, 0.07),
      button(true, 0.29, 0.07),
      button(false, 0.24, 0.11),
      {
        type: 'rrect',
        rect: body,
        radii: all(bodyR),
        fill: { x0: body.x, y0: body.y, x1: body.x + body.w, y1: body.y + body.h, stops: dark ? [[0, '#3a3b40'], [0.5, '#1b1b1e'], [1, '#2e2f33']] : [[0, '#f4f5f7'], [0.5, '#cfd2d8'], [1, '#eef0f2']] }
      },
      { type: 'rrect', rect: bezel, radii: all(bodyR - PHONE_RIM * u), fill: '#050506' },
      { type: 'rrect', rect: island, radii: all(islandH / 2), fill: '#18181c' },
      { type: 'circle', x: lensX, y: lensY, r: islandH * 0.3, fill: '#0e1a2b' },
      { type: 'circle', x: lensX - islandH * 0.08, y: lensY - islandH * 0.08, r: islandH * 0.09, fill: '#3b5b8a' }
    ]
  }
}
