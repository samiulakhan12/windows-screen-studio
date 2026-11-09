/**
 * Titles from the screenshots (docs/design/smart-tools.md §5.3.1, §0 decision 10, part P6). With
 * *Also send the screenshots* ticked (a service or built-in provider only, never On this PC, off
 * until ticked for each run), Write titles sends each step's own shot beside its item, after the
 * user has seen in the send viewer exactly the pictures that go and the cost in the line above.
 *
 * - The pictures are the guide's own shots (zoomed, ring drawn, every blur and pixelate shape
 *   applied: guideStills draws them by the export's path), scaled to at most 768 px on the longer
 *   side and encoded as JPEG at quality 0.8 here; a whole-screen step's whole-screen shot alike.
 *   What the viewer shows is these bytes themselves, so what is seen is what goes.
 * - Steps that may show what was typed start unticked; an unticked picture is never sent.
 * - At most 200 pictures in all; a request carries at most 50 (AI_LIMITS.names), so a long guide is
 *   several requests under the one cost line, written in one update.
 * - A step with a picture and nothing said near it goes with its action and no words; the answer
 *   is checked in main as every names answer is (privateLike refuses).
 */
import { AI_LIMITS, type NamesRequest } from '../../../shared/api/ai'
import { jpegSize } from '../../../shared/ai/tokens'
import type { GuideImage } from '../../../shared/guide/guideDoc'
import type { GuideStep } from '../../../shared/guide/steps'
import { namesRequestForSteps, shownTitles, stepAction, stepIncluded } from '../../../shared/guide/stepTitles'
import type { Project } from '../../../shared/types'

/** How a picture goes (§5.3.1): JPEG at quality 0.8, at most 768 px on the longer side. */
export const PICTURE = { mime: 'image/jpeg' as const, quality: 0.8, longest: 768 }
/** Qualities tried in turn when a picture comes out over the 512 KB a request takes. */
const LOWER_QUALITIES = [0.7, 0.6, 0.5, 0.4]

/** JPEG by its first bytes (FF D8 FF). */
const isJpeg = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

/** The size a picture of `w` × `h` goes at: at most 768 px on the longer side, never larger than it is. */
export function pictureSize(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, PICTURE.longest / Math.max(1, w, h))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

/**
 * `image` as the JPEG that goes (§5.3.1): drawn at pictureSize with high-quality smoothing and
 * encoded at quality 0.8 (lower only when it would pass 512 KB); null when it cannot be made small
 * enough or is not a JPEG then (that step's picture is left out).
 */
export async function pictureJpeg(image: GuideImage): Promise<Uint8Array | null> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(image.bytes)], { type: image.mime }))
  try {
    const size = pictureSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = size.w
    canvas.height = size.h
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not create a drawing surface')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, size.w, size.h)
    for (const quality of [PICTURE.quality, ...LOWER_QUALITIES]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, PICTURE.mime, quality))
      if (!blob) return null
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!isJpeg(bytes)) return null
      if (bytes.byteLength <= AI_LIMITS.names.image) return bytes
    }
    return null
  } finally {
    bitmap.close()
  }
}

/**
 * The pictures Write titles would send for `steps` (the steps it may title, in their order): each
 * step's shot in `images` as the JPEG that goes, ticked unless the step is marked *May show what you
 * typed* (`typed`: the marked step's key → the typing step's). Steps without a shot are left out;
 * at most 200 in all.
 */
export async function picturesToSend(steps: readonly GuideStep[], images: ReadonlyMap<string, GuideImage>, typed: ReadonlyMap<string, string>): Promise<{ key: string; jpeg: Uint8Array; ticked: boolean }[]> {
  const out: { key: string; jpeg: Uint8Array; ticked: boolean }[] = []
  for (const step of steps) {
    if (out.length >= AI_LIMITS.names.images) break
    const image = images.get(step.key)
    if (!image) continue
    const jpeg = await pictureJpeg(image)
    if (jpeg) out.push({ key: step.key, jpeg, ticked: !typed.has(step.key) })
  }
  return out
}

/**
 * The steps whose screenshots may go (§5.3.1): included, not titled by hand (an AI's title may be
 * written again; a step added by hand with its own title keeps it), and not key presses, whose
 * "Press …" titles are complete and show no ring.
 */
export function pictureSteps(project: Project, steps: readonly GuideStep[]): GuideStep[] {
  const edits = new Map((project.guide?.steps ?? []).map((e) => [e.key, e]))
  const titles = shownTitles(project, steps, steps.map((_, i) => String(i + 1)))
  return steps.filter((s, i) => stepIncluded(s, edits.get(s.key)) && s.kind !== 'keys' && !(titles[i].own && !titles[i].ai))
}

/**
 * Write titles' request with `pictures` (key → the JPEG of each picture the user left ticked): the
 * steps with words near them as without pictures, each with its picture; then, in step order, each
 * step with a picture and nothing said near it, with its action and no words. At most 200 pictures.
 */
export function namesWithPictures(project: Project, steps: readonly GuideStep[], pictures: ReadonlyMap<string, Uint8Array>): NamesRequest {
  const names = namesRequestForSteps(project, steps, 'step')
  const said = new Map(names.items.map((i) => [i.id, i]))
  const allowed = new Set(pictureSteps(project, steps).map((s) => s.key))
  const items: NamesRequest['items'] = []
  let sent = 0
  for (const step of steps) {
    const item = said.get(step.key)
    const picture = allowed.has(step.key) && sent < AI_LIMITS.names.images ? pictures.get(step.key) : undefined
    if (picture) sent++
    if (item) items.push(picture ? { ...item, image: picture } : item)
    else if (picture) items.push({ id: step.key, text: '', action: stepAction(step), image: picture })
  }
  return { ...names, items }
}

/** `names` as requests of at most 50 pictures each (AI_LIMITS.names.imagesPerRequest), the items in order; one without pictures as it is. */
export function pictureBatches(names: NamesRequest): NamesRequest[] {
  const out: NamesRequest[] = []
  let items: NamesRequest['items'] = []
  let pictures = 0
  for (const item of names.items) {
    if (item.image && pictures >= AI_LIMITS.names.imagesPerRequest) {
      out.push({ ...names, items })
      items = []
      pictures = 0
    }
    items.push(item)
    if (item.image) pictures++
  }
  if (items.length || !out.length) out.push({ ...names, items })
  return out
}

/** A picture that goes, as the send viewer shows it: its own bytes and size. */
export function pictureImage(jpeg: Uint8Array): GuideImage {
  const size = jpegSize(jpeg) ?? { w: PICTURE.longest, h: Math.round((PICTURE.longest * 9) / 16) }
  return { bytes: jpeg, mime: 'image/jpeg', width: size.w, height: size.h }
}
