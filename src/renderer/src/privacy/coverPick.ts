/**
 * A new cover's colour from the recording (docs/design/auto-blur.md §8.4): a hidden `<video>` of the
 * project's screen.mp4 is sought to the time asked for, and the 2 px ring just outside the box is
 * read there (raw, before the grade). The user's covers, *Turn into a cover*, and the guide's *Blur
 * an area…* (at the step's own shot time, never the paused frame) take it. Settings' *Colour of new
 * covers* can name a chip instead. Anything that fails gives Dark.
 */
import { mediaUrl } from '../../../shared/mediaUrl'
import { readPrivacyPrefs } from '../../../shared/privacy/coverData'
import { COVER_COLOURS, COVER_DARK } from '../../../shared/privacy/kinds'
import { coverColourOf, ringColour, RING_PX } from '../../../shared/render/coverColour'
import type { NormRect, PrivacyPrefs } from '../../../shared/types'

/** How long a seek may take before the pick gives up (Dark). */
const SEEK_MS = 4000

/** The hidden video of each project's screen, kept for the session (one at a time is read). */
const videos = new Map<string, { video: HTMLVideoElement; queue: Promise<unknown> }>()

function videoOf(projectId: string): { video: HTMLVideoElement; queue: Promise<unknown> } {
  let v = videos.get(projectId)
  if (!v) {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = mediaUrl(projectId, 'screen.mp4')
    v = { video, queue: Promise.resolve() }
    // One project's video at a time: an older project's is let go.
    for (const [id, old] of videos) {
      old.video.removeAttribute('src')
      old.video.load?.()
      videos.delete(id)
    }
    videos.set(projectId, v)
  }
  return v
}

/** HTMLMediaElement.HAVE_NOTHING: no metadata yet. */
const HAVE_NOTHING = 0

/**
 * Waits for `video` to show source time `t` (seeked), or gives up after SEEK_MS. A video without its
 * metadata yet (a project's hidden video, just made) takes a time set then as where to start, and no
 * seek happens, so the seek waits for the metadata: otherwise the first pick of a session (the
 * guide's *Blur an area…*) timed out and gave Dark.
 */
function seekTo(video: HTMLVideoElement, t: number): Promise<boolean> {
  return new Promise((done) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const seek = (): void => {
      video.currentTime = Math.max(0, t)
    }
    const finish = (ok: boolean): void => {
      if (timer !== null) clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      video.removeEventListener('loadedmetadata', seek)
      done(ok)
    }
    const onSeeked = (): void => finish(true)
    const onError = (): void => finish(false)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    timer = setTimeout(() => finish(false), SEEK_MS)
    if (video.readyState === HAVE_NOTHING) video.addEventListener('loadedmetadata', seek, { once: true })
    else seek()
  })
}

/** The ring around `box` (normalised) in the frame at `t`: its pixels cut with RING_PX around the box. */
async function ringAt(projectId: string, t: number, box: NormRect): Promise<{ color: string; spread: number } | null> {
  const v = videoOf(projectId)
  const run = v.queue.then(async () => {
    if (!(await seekTo(v.video, t))) return null
    const vw = v.video.videoWidth
    const vh = v.video.videoHeight
    if (!(vw > 0 && vh > 0)) return null
    // Only the box and its ring are read back.
    const x0 = Math.max(0, Math.floor(box.x * vw) - RING_PX)
    const y0 = Math.max(0, Math.floor(box.y * vh) - RING_PX)
    const x1 = Math.min(vw, Math.ceil((box.x + box.w) * vw) + RING_PX)
    const y1 = Math.min(vh, Math.ceil((box.y + box.h) * vh) + RING_PX)
    const w = x1 - x0
    const h = y1 - y0
    if (w <= 0 || h <= 0) return null
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(v.video, x0, y0, w, h, 0, 0, w, h)
    const pixels = ctx.getImageData(0, 0, w, h).data
    return ringColour(pixels, w, h, { x: box.x * vw - x0, y: box.y * vh - y0, w: box.w * vw, h: box.h * vh })
  })
  v.queue = run.catch(() => undefined)
  return run
}

/** Settings' *Colour of new covers* (§2.14): 'ring' (the default) or a chip. */
async function colourPref(): Promise<PrivacyPrefs['colour']> {
  try {
    return readPrivacyPrefs(await window.api.getPref('privacy'))?.colour
  } catch {
    return undefined
  }
}

/**
 * The colour a new cover over `box` (normalised to the whole recorded frame) takes at source time
 * `t` of project `projectId`: the preference's chip, else the median of the ring just outside the
 * box in the frame there (Dark when the ring is mixed or the frame cannot be read).
 */
export async function ringColourAt(projectId: string, t: number, box: NormRect): Promise<string> {
  const pref = await colourPref()
  if (pref && pref !== 'ring') return COVER_COLOURS[pref]
  try {
    const ring = await ringAt(projectId, t, box)
    return ring ? coverColourOf(ring, pref) : COVER_DARK
  } catch {
    return COVER_DARK
  }
}

/** The ring around `box` read from `video` as it shows now (the preview's own element, paused there), or null. */
function ringFromElement(video: HTMLVideoElement, box: NormRect): { color: string; spread: number } | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!(vw > 0 && vh > 0) || typeof document === 'undefined') return null
  const x0 = Math.max(0, Math.floor(box.x * vw) - RING_PX)
  const y0 = Math.max(0, Math.floor(box.y * vh) - RING_PX)
  const x1 = Math.min(vw, Math.ceil((box.x + box.w) * vw) + RING_PX)
  const y1 = Math.min(vh, Math.ceil((box.y + box.h) * vh) + RING_PX)
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    ctx.drawImage(video, x0, y0, w, h, 0, 0, w, h)
    return ringColour(ctx.getImageData(0, 0, w, h).data, w, h, { x: box.x * vw - x0, y: box.y * vh - y0, w: box.w * vw, h: box.h * vh })
  } catch {
    return null
  }
}

/**
 * The colour a cover made now over `box` at source time `t` takes (*Add cover*, the *Cover* tool,
 * *Turn into a cover*): the preference's chip; else the ring in the paused frame when the preview
 * shows `t` (its own element, read at once); else the ring at `t` from the hidden video.
 */
export async function coverColourNow(services: { store: { state: { id: string } }; player: { screen: HTMLVideoElement; moving: boolean } }, t: number, box: NormRect): Promise<string> {
  const pref = await colourPref()
  if (pref && pref !== 'ring') return COVER_COLOURS[pref]
  const screen = services.player.screen
  const paused = !services.player.moving && !screen.seeking && screen.readyState >= 2 && Math.abs(screen.currentTime - t) < 0.05
  const ring = paused ? ringFromElement(screen, box) : null
  if (ring) return coverColourOf(ring, pref)
  return ringColourAt(services.store.state.id, t, box)
}
