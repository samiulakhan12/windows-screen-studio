import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { displayTime } from '../../../shared/editor/clips'
import { boxAt } from '../../../shared/privacy/coverPath'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { t } from '../../../shared/i18n/t'
import type { Cover, NormRect, Project } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import { useGroup } from '../editor/groupContext'
import { usePeek, type PeekState } from './peek'
import type { SceneView } from './stubProps'
import './covers.css'

/** The magnified view's scale against the preview's (§2.8): twice it, at most eight times, never past the recording's own pixels. */
export const INSET_MIN = 2
export const INSET_MAX = 8
/** The box's height the magnified view aims for, px. */
const INSET_TEXT = 32

/**
 * The cover the magnified view shows at source time `t` (§2.8): the selected cover when it is
 * peeked and active, else the first peeked cover active then; null when nothing is peeked there.
 */
export function insetCover(project: Pick<Project, 'covers'>, peek: Pick<PeekState, 'ids'>, selected: string | null, t: number): Cover | null {
  if (peek.ids === null) return null
  const peeked = (c: Cover): boolean => peek.ids === 'all' || (peek.ids as readonly string[]).includes(c.id)
  const active = (project.covers ?? []).filter((c) => peeked(c) && t >= c.start && t < c.end)
  return active.find((c) => c.id === selected) ?? active[0] ?? null
}

/**
 * Where the magnified view cuts the raw frame and how large it draws it (§2.8): the cover's box in
 * the recording's pixels with a margin of half its height, clipped to the frame; drawn at twice the
 * preview's scale (`previewScale`: preview pixels per recording pixel) or more, so the box shows at
 * least 32 px high, at most 8× the preview's scale, and never more than one canvas pixel per
 * recording pixel.
 */
export function insetGeometry(box: NormRect, frame: { w: number; h: number }, previewScale: number): { sx: number; sy: number; sw: number; sh: number; scale: number } {
  const bx = box.x * frame.w
  const by = box.y * frame.h
  const bw = box.w * frame.w
  const bh = box.h * frame.h
  const m = bh / 2
  const sx = Math.max(0, Math.floor(bx - m))
  const sy = Math.max(0, Math.floor(by - m))
  const sw = Math.min(frame.w, Math.ceil(bx + bw + m)) - sx
  const sh = Math.min(frame.h, Math.ceil(by + bh + m)) - sy
  const ps = previewScale > 0 && Number.isFinite(previewScale) ? previewScale : 1
  // Large enough that the box shows at least INSET_TEXT px high (text 12 px high in 1080p reads), within 2× to 8× the preview's scale.
  const want = Math.max(INSET_MIN * ps, INSET_TEXT / Math.max(1, bh))
  const scale = Math.min(1, Math.min(INSET_MAX * ps, want))
  return { sx, sy, sw: Math.max(1, sw), sh: Math.max(1, sh), scale }
}

/**
 * The magnified view of what is under a peeked cover (docs/design/auto-blur.md §2.8, §8.5): its own
 * preview-only canvas, drawn from the player's raw frame at the playhead, under Peek's banner. Never
 * part of a scene, so no export, thumbnail or guide shot can draw it.
 */
export function PeekInset(props: { services: EditorServices; view: SceneView }): JSX.Element | null {
  const { store, player } = props.services
  const peek = usePeek()
  const project = useSyncExternalStore(store.subscribe, () => store.state)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [key, setKey] = useState('')
  useEffect(() => {
    const check = (): void => setKey(player.moving ? 'moving' : `${player.time}`)
    check()
    return player.subscribe(check)
  }, [player])
  const at = displayTime(project.clips, player.time)
  const single = useGroup().single
  const selected = single?.startsWith('cover:') ? single.slice(6) : null
  const cover = player.moving ? null : insetCover(project, peek, selected, at)
  const box = cover ? boxAt(cover, at) : null
  const video = player.screen
  const frame = { w: video.videoWidth || project.width, h: video.videoHeight || project.height }
  // Preview pixels per recording pixel: the drawn picture's width over the (cropped) recording's.
  const crop = project.crop
  const shownW = frame.w * (crop ? crop.w : 1)
  const geo = box ? insetGeometry(box, frame, props.view.screen.w / Math.max(1, shownW)) : null

  useEffect(() => {
    const c = canvas.current
    if (!c || !geo) return
    const w = Math.max(1, Math.round(geo.sw * geo.scale))
    const h = Math.max(1, Math.round(geo.sh * geo.scale))
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    const ctx = c.getContext('2d')
    if (!ctx || video.readyState < 2) return
    ctx.imageSmoothingEnabled = true
    try {
      ctx.drawImage(video, geo.sx, geo.sy, geo.sw, geo.sh, 0, 0, w, h)
    } catch {
      // A frame not ready yet: drawn on the next stop.
    }
  })
  void key
  if (!cover || !geo) return null
  return (
    <div className="cover-peek-inset" data-testid="peek-inset">
      <canvas ref={canvas} role="img" aria-label={t(PRIVACY_COPY.peek.inset)} data-scale={geo.scale} />
    </div>
  )
}
