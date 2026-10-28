import { zonesFor, type SafeBox, type SafeChoice } from '../../../shared/render/safeZones'
import './safeZones.css'

/** One edge of the area the apps cover, in overlay px: horizontal (y fixed) or vertical (x fixed). */
export interface ZoneEdge {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** The side of the frame a box covers, for its label: the top bars, the button column on the right, the captions at the bottom. */
type Side = 'top' | 'right' | 'bottom'
const sideOf = (b: SafeBox): Side => (b.y <= 0 ? 'top' : b.y + b.h >= 1 && b.w >= 1 ? 'bottom' : 'right')

/** The label of every side when the three apps are shown together. */
export const ALL_LABEL = 'Buttons and captions (all three)'

/**
 * The area `boxes` cover together (normalised), as cells of the grid their edges make: the
 * covered cells (which never overlap, so a translucent fill is even over the union) and the
 * edges between a covered and an uncovered cell (the union's outline inside the frame; the
 * frame's own border is left out).
 */
export function zoneUnion(boxes: readonly SafeBox[]): { cells: { x: number; y: number; w: number; h: number }[]; edges: ZoneEdge[] } {
  const xs = [...new Set(boxes.flatMap((b) => [b.x, b.x + b.w]).concat(0, 1))].filter((v) => v >= 0 && v <= 1).sort((a, b) => a - b)
  const ys = [...new Set(boxes.flatMap((b) => [b.y, b.y + b.h]).concat(0, 1))].filter((v) => v >= 0 && v <= 1).sort((a, b) => a - b)
  const covered = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= xs.length - 1 || j >= ys.length - 1) return false
    const cx = (xs[i] + xs[i + 1]) / 2
    const cy = (ys[j] + ys[j + 1]) / 2
    return boxes.some((b) => cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h)
  }
  const cells: { x: number; y: number; w: number; h: number }[] = []
  const edges: ZoneEdge[] = []
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const on = covered(i, j)
      if (on) cells.push({ x: xs[i], y: ys[j], w: xs[i + 1] - xs[i], h: ys[j + 1] - ys[j] })
      // The right and lower sides of each cell, where coverage changes (not along the frame's border).
      if (i < xs.length - 2 && on !== covered(i + 1, j)) edges.push({ x1: xs[i + 1], y1: ys[j], x2: xs[i + 1], y2: ys[j + 1] })
      if (j < ys.length - 2 && on !== covered(i, j + 1)) edges.push({ x1: xs[i], y1: ys[j + 1], x2: xs[i + 1], y2: ys[j + 1] })
    }
  }
  return { cells, edges }
}

/** The labels to show: one per box for an app, one per side ("all three") for All three, each on the side's largest box. */
export function zoneLabels(choice: SafeChoice, boxes: readonly SafeBox[]): { box: SafeBox; side: Side; text: string }[] {
  if (choice !== 'all') return boxes.map((box) => ({ box, side: sideOf(box), text: box.label }))
  const bySide = new Map<Side, SafeBox>()
  for (const b of boxes) {
    const s = sideOf(b)
    const cur = bySide.get(s)
    if (!cur || b.w * b.h > cur.w * cur.h) bySide.set(s, b)
  }
  return [...bySide].map(([side, box]) => ({ box, side, text: ALL_LABEL }))
}

/**
 * Where TikTok, Reels and Shorts put their buttons and captions, shaded over the preview's CSS box
 * (docs/design/vertical-video.md §2.8, §7): DOM only, pointer-events none and aria-hidden, never
 * drawn on a canvas, so it can never reach an export, a thumbnail or the clipboard. The boxes are
 * drawn as their union (an even shade with a hatch and a dashed edge), one element per box so
 * each app's three (or the nine of All three) can be told apart; the legend under the preview
 * carries the same information for assistive technology.
 */
export function SafeZoneOverlay(props: { choice: SafeChoice; box: { w: number; h: number } }): JSX.Element {
  const { choice, box } = props
  const boxes = zonesFor(choice)
  const union = zoneUnion(boxes)
  const px = (r: { x: number; y: number; w: number; h: number }): string => `M${r.x * box.w} ${r.y * box.h}h${r.w * box.w}v${r.h * box.h}h${-r.w * box.w}z`
  const area = union.cells.map(px).join('')
  return (
    <div className="safe-zones" data-testid="safe-zones" data-platform={choice} aria-hidden="true">
      <svg className="safe-zones-paint" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`}>
        <defs>
          <pattern id="safe-zones-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
            <line x1="0" y1="0" x2="0" y2="8" />
          </pattern>
        </defs>
        <path className="safe-zones-shade" d={area} />
        <path className="safe-zones-hatch" d={area} fill="url(#safe-zones-hatch)" />
        {union.edges.map((e, i) => (
          <line key={i} className="safe-zones-edge" x1={e.x1 * box.w} y1={e.y1 * box.h} x2={e.x2 * box.w} y2={e.y2 * box.h} />
        ))}
      </svg>
      {boxes.map((b, i) => (
        <div key={i} className="safe-zone-box" data-label={b.label} style={{ left: b.x * box.w, top: b.y * box.h, width: b.w * box.w, height: b.h * box.h }} />
      ))}
      {zoneLabels(choice, boxes).map(({ box: b, side, text }, i) => (
        <span key={i} className="safe-zone-label" data-side={side} style={{ left: b.x * box.w, top: b.y * box.h, width: b.w * box.w, height: b.h * box.h }}>
          <span className="safe-zone-chip">{text}</span>
        </span>
      ))}
    </div>
  )
}
