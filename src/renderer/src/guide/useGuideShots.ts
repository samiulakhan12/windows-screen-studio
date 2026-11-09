/**
 * The Guide panel's screenshots (docs/design/smart-tools.md §5.5.6): made in step order in the
 * background while the panel is open, kept in memory (at most 300 shots or 256 MB, the oldest
 * dropped), and made again only for shots whose plan changed (time, view, crop, ring, or a blur or
 * pixelate shape covering their time). Closing the panel stops the pass and frees them.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { cropView } from '../../../shared/engine/crop'
import { SmoothedTrack } from '../../../shared/engine/cursor'
import { focusPathFor } from '../../../shared/engine/zoom'
import type { GuideImage } from '../../../shared/guide/guideDoc'
import { guideProject, type ShotPlan } from '../../../shared/guide/shots'
import { mediaUrl } from '../../../shared/mediaUrl'
import type { CursorTrack, Project } from '../../../shared/types'
import type { ThumbnailInput } from '../editor/exporter'
import { renderGuideStills } from './guideStills'

/** The most shots kept, and their bytes (§5.5.6). */
export const SHOT_CAP = { count: 300, bytes: 256 << 20 }
/** How long the plans must stay still before a pass starts (edits come in bursts). */
const SETTLE_MS = 250

interface Kept {
  sig: string
  image: GuideImage
}

/** The export-path input a shot pass draws from: the guide's project, its scene and the recording. */
export function stillsInput(project: Project, track: CursorTrack): ThumbnailInput {
  const drawn = guideProject(project)
  const view = cropView(drawn, track)
  const scene = {
    project: view.project,
    cursor: view.cursor,
    cursorPath: new SmoothedTrack(view.cursor.samples, drawn.duration, drawn.cursor.smoothing),
    focusPath: focusPathFor(view.cursor.samples, drawn.duration),
    ...(view.crop ? { crop: view.crop } : {})
  }
  return {
    project: drawn,
    scene,
    screenUrl: mediaUrl(project.id, 'screen.mp4'),
    webcamUrl: null,
    background: null,
    settings: { format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' },
    time: 0
  }
}

/**
 * The pictures of `plans` for a Save or Copy (§5.5.6): the ones `made` already (made for the plan as it
 * is now), and the rest made now (a demo's shots just after the format changed, a shot being made
 * again after an edit, one dropped past SHOT_CAP), so nothing is saved without its picture. `failed`:
 * why the rest could not be made.
 */
export async function shotsFor(
  project: Project,
  track: CursorTrack,
  plans: readonly ShotPlan[],
  made: ReadonlyMap<string, GuideImage>,
  signal: AbortSignal
): Promise<{ images: Map<string, GuideImage>; failed: string | null }> {
  const images = new Map<string, GuideImage>()
  const missing = plans.filter((p) => {
    const image = made.get(p.key)
    if (image) images.set(p.key, image)
    return !image
  })
  if (!missing.length) return { images, failed: null }
  try {
    const shots = missing.map((s) => ({ key: s.key, t: s.t, rect: s.rect, ring: s.ring, arrow: s.arrow }))
    for await (const { key, image } of renderGuideStills(stillsInput(project, track), shots, { mime: 'image/png', quality: 1, maxWidth: 1600, signal })) images.set(key, image)
    return { images, failed: null }
  } catch (err) {
    return { images, failed: err instanceof Error ? err.message : String(err) }
  }
}

/** Drops the oldest shots past SHOT_CAP. */
function trim(cache: Map<string, Kept>): void {
  let bytes = 0
  for (const k of cache.values()) bytes += k.image.bytes.byteLength
  for (const key of cache.keys()) {
    if (cache.size <= SHOT_CAP.count && bytes <= SHOT_CAP.bytes) break
    bytes -= cache.get(key)!.image.bytes.byteLength
    cache.delete(key)
  }
}

/**
 * The shots of `plans` as they are made: by plan key, the image of its current plan (a shot whose
 * plan changed is left out until made again), and how many are made and still to make. Plans are
 * made in their order. `enabled` false stops the pass.
 */
export function useGuideShots(project: Project, track: CursorTrack, plans: readonly ShotPlan[], enabled = true): { images: ReadonlyMap<string, GuideImage>; ready: number; total: number; failed: string | null } {
  const cache = useRef(new Map<string, Kept>())
  const [version, setVersion] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)
  const sigs = plans.map((p) => `${p.key}=${p.sig}`).join('|')
  const latest = useRef({ project, track, plans })
  latest.current = { project, track, plans }

  useEffect(() => {
    if (!enabled) return
    const stale = latest.current.plans.filter((p) => cache.current.get(p.key)?.sig !== p.sig)
    if (!stale.length) return
    const ac = new AbortController()
    const timer = setTimeout(() => {
      void (async () => {
        const { project: p, track: tr } = latest.current
        try {
          const shots = stale.map((s) => ({ key: s.key, t: s.t, rect: s.rect, ring: s.ring, arrow: s.arrow }))
          const bySig = new Map(stale.map((s) => [s.key, s.sig]))
          for await (const { key, image } of renderGuideStills(stillsInput(p, tr), shots, { mime: 'image/png', quality: 1, maxWidth: 1600, signal: ac.signal })) {
            if (ac.signal.aborted) return
            cache.current.delete(key)
            cache.current.set(key, { sig: bySig.get(key)!, image })
            trim(cache.current)
            setVersion((v) => v + 1)
          }
          setFailed(null)
        } catch (err) {
          if (!ac.signal.aborted) setFailed(err instanceof Error ? err.message : String(err))
        }
      })()
    }, SETTLE_MS)
    return () => {
      clearTimeout(timer)
      ac.abort()
    }
  }, [sigs, enabled])

  // Closing the panel frees them.
  useEffect(() => () => cache.current.clear(), [])

  const images = useMemo(() => {
    const out = new Map<string, GuideImage>()
    for (const p of plans) {
      const kept = cache.current.get(p.key)
      if (kept && kept.sig === p.sig) out.set(p.key, kept.image)
    }
    return out
    // `version` changes as shots arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigs, version])
  return { images, ready: images.size, total: plans.length, failed }
}
