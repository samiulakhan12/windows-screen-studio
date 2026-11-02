/**
 * The action on screen over a caption's time (docs/design/captions-studio.md §8.6): the cursor
 * every 0.1 s, clicks and typing places, in output pixels after zoom and pan, padded by 0.08 u,
 * cut time skipped. Captions and graphics keep clear of it. Pure.
 */
import { cursorAt } from '../engine/cursor'
import { frameView, type ViewScene } from '../engine/frameView'
import type { Rect } from '../engine/layout'
import { toOutput } from '../engine/outputPoint'
import { outputToSource, sourceToOutput } from '../engine/timeline'
import { typingSessionsOf } from '../engine/zoom'
import type { AutoZoomSettings, Clip, CursorTrack } from '../types'
import { viewingTime } from './overlays'

/** Seconds of viewing time between two cursor samples; each sample stands for this much time (§8.6 rule 2). */
export const ACTION_STEP = 0.1
/** Padding around each point of action, as a fraction of the frame's shorter side. */
const PAD = 0.08

/**
 * The action between source times `t0` and `t1` (§8.6 rule 1), each `{ t, rect }` with `t` in
 * source seconds: the cursor every 0.1 s of viewing time, each click, and the place typed into at
 * every 0.1 s a typing session overlaps, mapped through the frame's camera and screen rectangle
 * (exactly where the cursor layer draws them) and padded by 0.08 u. Time in cuts is skipped.
 * Without cursor data (an imported video, a window recording) there is no action.
 */
export function actionRects(scene: ViewScene, cursor: CursorTrack | null, zoom: AutoZoomSettings, w: number, h: number, vw: number, vh: number, t0: number, t1: number, clips: Clip[]): { t: number; rect: Rect }[] {
  if (!cursor || !cursor.valid || !cursor.samples.length || !(t1 > t0)) return []
  const pad = PAD * Math.min(w, h)
  const at = (t: number, x: number, y: number): { t: number; rect: Rect } => {
    const { layout, cam } = frameView(scene, w, h, vw, vh, t)
    const p = toOutput(layout.screen, cam)(x, y)
    return { t, rect: { x: p.x - pad, y: p.y - pad, w: pad * 2, h: pad * 2 } }
  }
  const out: { t: number; rect: Rect }[] = []
  // Samples every 0.1 s of viewing time, so a cut is skipped and a 2× clip is sampled as it plays.
  const v0 = clips.length ? viewingTime(clips, t0) : t0
  const v1 = clips.length ? viewingTime(clips, t1) : t1
  const times: number[] = []
  for (let k = 0; v0 + k * ACTION_STEP <= v1 + 1e-9; k++) {
    const t = clips.length ? outputToSource(clips, v0 + k * ACTION_STEP).time : v0 + k * ACTION_STEP
    if (t >= t0 - 1e-9 && t <= t1 + 1e-9) times.push(t)
  }
  for (const t of times) {
    const c = cursorAt(cursor.samples, t)
    if (c) out.push(at(t, c.x, c.y))
  }
  // Clicks inside the time that are not cut.
  const shown = (t: number): boolean => !clips.length || sourceToOutput(clips, t) !== null
  for (const c of cursor.clicks) if (c.t >= t0 && c.t <= t1 && shown(c.t)) out.push(at(c.t, c.x, c.y))
  // The place typed into, while a typing session overlaps the time.
  for (const s of typingSessionsOf(cursor, zoom)) {
    if (s.t1 < t0 || s.t0 > t1) continue
    for (const t of times) if (t >= s.t0 && t <= s.t1) out.push(at(t, s.place.x, s.place.y))
  }
  return out.sort((a, b) => a.t - b.t)
}
