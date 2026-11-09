/**
 * What the Guide panel runs (docs/design/smart-tools.md §5.3–§5.8): saving the guide as PDF, HTML,
 * a demo or Markdown (main shows the dialog and writes), copying it, writing its step titles and
 * tidying its notes with an AI (one store update each, so one undo step), blurring from the panel,
 * and the fonts a page embeds.
 */
import type { AiTextRequest, TextChoice } from '../../../shared/api/ai'
import type { GuideFormat } from '../../../shared/api/guide'
import type { EditStore } from '../../../shared/editor/editStore'
import { ACTUAL_KEY, buildGuideDoc, type GuideDoc, type GuideImage } from '../../../shared/guide/guideDoc'
import { withAiNotes, withAiTitles, withTypedBlur } from '../../../shared/guide/guideEdit'
import { EMBEDDED_FAMILY, guideFontWeights, guideHtml, guideText } from '../../../shared/guide/guideHtml'
import { guideMarkdown } from '../../../shared/guide/guideMarkdown'
import { blurBoxes, shotTime } from '../../../shared/guide/shots'
import type { GuideStep } from '../../../shared/guide/steps'
import { namesRequestForSteps } from '../../../shared/guide/stepTitles'
import { screenChanges } from '../../../shared/smart/screenChanges'
import type { SceneScan } from '../../../shared/api/projects'
import type { AiProviderKind, Project, Shape } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import { addShapeAt } from '../editor/playheadItems'
import type { Selection } from '../editor/selection'
import { BUNDLED_FONT_URLS } from '../render/catalogFonts'
import { encodeImage } from './guideStills'
import { namesWithPictures, pictureBatches } from './visionTitles'

/** What each format's pictures are (§5.5.5): JPEG 0.9 for the PDF, WebP 0.85 for HTML and the demo, PNG for Markdown. */
export const FORMAT_IMAGES: Record<GuideFormat, { mime: GuideImage['mime']; quality: number; maxWidth: number }> = {
  pdf: { mime: 'image/jpeg', quality: 0.9, maxWidth: 1600 },
  html: { mime: 'image/webp', quality: 0.85, maxWidth: 1600 },
  demo: { mime: 'image/webp', quality: 0.85, maxWidth: 1600 },
  markdown: { mime: 'image/png', quality: 1, maxWidth: 1600 }
}
/** *Make it smaller* (§5.5.5): WebP 0.75 at most 1280 px wide. */
export const SMALLER = { mime: 'image/webp' as const, quality: 0.75, maxWidth: 1280 }
/** An HTML guide or demo over this many bytes offers *Make it smaller*. */
export const BIG_FILE = 10 * 1000 * 1000
/** *Copy guide*'s pictures (§5.5.5): PNG at most 1200 px wide. */
export const COPY_IMAGES = { mime: 'image/png' as const, quality: 1, maxWidth: 1200 }

/** Characters Windows refuses in a file name, and control characters. */
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

/** The name the save dialog offers (§2.1): "<Title> guide", "<Title> demo" or "<Title> bug report", fit for a file name. */
export function guideFileName(project: Project, format: GuideFormat): string {
  const title = (project.guide?.title?.trim() || project.name).replace(BAD_NAME, ' ').replace(/\s+/g, ' ').trim()
  const what = project.guide?.kind === 'bug' ? 'bug report' : format === 'demo' ? 'demo' : 'guide'
  const name = `${title} ${what}`.replace(/^[. ]+|[. ]+$/g, '')
  return Array.from(name).slice(0, 120).join('').trim() || 'Guide'
}

/** The bundled Hind Siliguri a page embeds (§5.6): 400 and 600 for the PDF and for Bangla text, else none. */
export async function guideFonts(doc: GuideDoc, print: boolean): Promise<{ family: string; weight: number; woff2: Uint8Array }[]> {
  const out: { family: string; weight: number; woff2: Uint8Array }[] = []
  for (const weight of guideFontWeights(doc, print)) {
    const url = BUNDLED_FONT_URLS[`hind-siliguri-${weight}.woff2`]
    if (!url) continue
    const res = await fetch(url)
    if (!res.ok) continue
    out.push({ family: EMBEDDED_FAMILY, weight, woff2: new Uint8Array(await res.arrayBuffer()) })
  }
  return out
}

/** The brand kit's logo and first colour (§5.6), when the guide uses it and a kit has either; else null. */
export async function guideBrand(project: Project): Promise<GuideDoc['brand'] | null> {
  if (project.guide?.brand === false) return null
  try {
    const kit = await window.api.getBrandKit()
    const colour = kit.colors[0] ?? null
    let logo: GuideImage | null = null
    if (kit.logo?.file) {
      const bytes = await window.api.brandFile(kit.logo.file)
      const mime = bytes && bytes[0] === 0x89 ? 'image/png' : bytes && bytes[0] === 0xff ? 'image/jpeg' : bytes && bytes[0] === 0x52 ? 'image/webp' : null
      if (bytes && mime) {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }))
        logo = { bytes, mime, width: bitmap.width, height: bitmap.height }
        bitmap.close()
      }
    }
    return logo || colour ? { logo, colour } : null
  } catch {
    return null
  }
}

/** The images of `doc`'s steps and Actual in `kind`'s form. */
async function convertImages(images: ReadonlyMap<string, GuideImage>, kind: { mime: GuideImage['mime']; quality: number; maxWidth: number }, signal?: AbortSignal): Promise<Map<string, GuideImage>> {
  const out = new Map<string, GuideImage>()
  for (const [key, image] of images) {
    if (signal?.aborted) break
    out.set(key, await encodeImage(image, kind.mime, kind.quality, kind.maxWidth))
  }
  return out
}

/**
 * Saves the guide as `format` (§5.8): the document built from the project and its steps with each
 * step's picture in the format's form, written by main after its own save or folder dialog. Null
 * when the dialog was cancelled. `smaller`: the HTML guide or demo again at WebP 0.75, 1280 px.
 */
export async function saveGuide(
  format: GuideFormat,
  deps: { project: Project; steps: readonly GuideStep[]; images: ReadonlyMap<string, GuideImage>; page: 'A4' | 'Letter'; signal: AbortSignal; smaller?: boolean }
): Promise<{ path: string; bytes: number } | null> {
  const kind = deps.smaller && (format === 'html' || format === 'demo') ? SMALLER : FORMAT_IMAGES[format]
  const images = await convertImages(deps.images, kind, deps.signal)
  if (deps.signal.aborted) return null
  const doc = buildGuideDoc(deps.project, deps.steps, images, await guideBrand(deps.project))
  const name = guideFileName(deps.project, format)
  if (format === 'markdown') {
    const md = guideMarkdown(doc)
    const bytes = [...doc.steps.flatMap((s) => (s.image ? [s.image.bytes] : [])), ...(doc.bug?.actualImage ? [doc.bug.actualImage.bytes] : [])]
    return window.api.saveGuide({ format, name, markdown: md.markdown, images: bytes })
  }
  const print = format === 'pdf'
  const html = guideHtml(doc, { demo: format === 'demo', print, fonts: await guideFonts(doc, print), ...(print ? { page: deps.page } : {}) })
  if (deps.signal.aborted) return null
  return window.api.saveGuide({ format, name, html, ...(print ? { page: deps.page } : {}) })
}

/** *Copy guide* (§5.8): the guide's HTML (PNG pictures at most 1200 px wide, no script, no fonts) and plain text on the clipboard; how many pictures went. */
export async function copyGuide(deps: { project: Project; steps: readonly GuideStep[]; images: ReadonlyMap<string, GuideImage> }): Promise<{ images: number }> {
  const images = await convertImages(deps.images, COPY_IMAGES)
  const doc = buildGuideDoc(deps.project, deps.steps, images, null)
  await window.api.copyGuide({ html: guideHtml(doc, { demo: false, print: false, clipboard: true, fonts: [] }), text: guideText(doc) })
  return { images: doc.steps.filter((s) => s.image).length + (doc.bug?.actualImage ? 1 : 0) }
}

/** Who a result made with `choice` says wrote it (the "AI" chip's provenance). */
const viaOf = (choice: TextChoice): AiProviderKind | 'local' => choice.kind

/** The `names` request sent, the run named so Stop (`signal`) stops the provider's own request (cancelAiText). */
async function askNames(choice: TextChoice, request: AiTextRequest, signal: AbortSignal, requestId: string): Promise<{ id: string; name: string }[]> {
  const stop = (): void => void window.api.cancelAiText(requestId).catch(() => undefined)
  signal.addEventListener('abort', stop)
  try {
    const result = await window.api.aiText(choice.id, { ...request, requestId }, requestId)
    if (result.task !== 'names') throw new Error('The AI provider answered another task.')
    return result.names
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** Where a run wrote, for its notice. */
const wroteWhere = (choice: TextChoice): string => (choice.kind === 'local' ? 'on this PC' : `with ${choice.place}`)

/**
 * *Write titles* (§5.3): the `names` task with `kind: 'step'` for the included steps not edited by
 * hand that have words near them; with `pictures` (part P6, §5.3.1: the JPEG of each picture the
 * user left ticked in the send viewer), each beside its item, and the steps with a picture and no
 * words too, at most 50 pictures a request. The answers, as validated in main, are written in one
 * update with `ai` set. A step the user titled meanwhile keeps its title; steps without words or a
 * picture keep their offline titles.
 */
export async function writeStepTitles(deps: { store: EditStore<Project>; steps: readonly GuideStep[]; choice: TextChoice; pictures: ReadonlyMap<string, Uint8Array> | null; signal: AbortSignal; requestId: string }): Promise<{ notice: string }> {
  const names = deps.pictures?.size ? namesWithPictures(deps.store.state, deps.steps, deps.pictures) : namesRequestForSteps(deps.store.state, deps.steps, 'step')
  if (!names.items.length) return { notice: 'Nothing was said near these steps.' }
  const answer: { id: string; name: string }[] = []
  let failed: unknown = null
  for (const batch of pictureBatches(names)) {
    try {
      answer.push(...(await askNames(deps.choice, { task: 'names', segments: [], names: batch }, deps.signal, deps.requestId)))
    } catch (err) {
      // A later request failing keeps what the earlier ones wrote; the first failing fails the run.
      if (deps.signal.aborted || !answer.length) throw err
      failed = err
      break
    }
    if (deps.signal.aborted) break
  }
  if (deps.signal.aborted) return { notice: 'Stopped. Nothing was changed.' }
  const edits = new Map((deps.store.state.guide?.steps ?? []).map((e) => [e.key, e]))
  const titles = answer.filter((n) => {
    const e = edits.get(n.id)
    return e?.title === undefined || !!e.ai
  })
  if (!titles.length) return { notice: 'Nothing was changed.' }
  deps.store.update((p) => withAiTitles(p, titles.map((n) => ({ key: n.id, title: n.name })), viaOf(deps.choice)))
  const wrote = `Wrote ${titles.length} ${titles.length === 1 ? 'title' : 'titles'} ${wroteWhere(deps.choice)}.`
  return { notice: failed ? `${wrote} The rest failed: ${failed instanceof Error ? failed.message : String(failed)}` : wrote }
}

/**
 * *Tidy notes* (§5.4): the `names` task with `kind: 'note'`, each step's full words and title; one
 * or two short sentences each, written in one update with `textAi` set. A note the user wrote
 * meanwhile is kept.
 */
export async function tidyNotes(deps: { store: EditStore<Project>; steps: readonly GuideStep[]; choice: TextChoice; signal: AbortSignal; requestId: string }): Promise<{ notice: string }> {
  const names = namesRequestForSteps(deps.store.state, deps.steps, 'note')
  if (!names.items.length) return { notice: 'Nothing was said to make notes from.' }
  const answer = await askNames(deps.choice, { task: 'names', segments: [], names }, deps.signal, deps.requestId)
  if (deps.signal.aborted) return { notice: 'Stopped. Nothing was changed.' }
  const before = new Map((deps.store.state.guide?.steps ?? []).map((e) => [e.key, e]))
  const notes = answer.filter((n) => {
    const e = before.get(n.id)
    return e?.text === undefined || !!e.textAi
  })
  if (!notes.length) return { notice: 'Nothing was changed.' }
  deps.store.update((p) => withAiNotes(p, notes.map((n) => ({ key: n.id, text: n.name })), viaOf(deps.choice)))
  return { notice: `Tidied ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} ${wroteWhere(deps.choice)}.` }
}

/**
 * *Blur an area…* (§5.5.8): a blur shape over a box 30% × 10% of the frame on the step's place,
 * starting one frame before the step's shot (so the privacy layer always covers the shot's frame),
 * selected so the user drags it over what to hide; the playhead goes to the shot's time. One update.
 */
export function blurArea(services: EditorServices, step: GuideStep, opts: { after: boolean; scale: number; onSelect(sel: Selection): void }): Shape {
  const p = services.store.state
  const fps = p.capture?.fps ?? 60
  const t = shotTime(step, p.clips, fps, opts.after)
  const { area } = blurBoxes(step, { w: p.width, h: p.height }, opts.scale)
  const shape = addShapeAt(services, 'blur', null, { at: t - 1 / fps, box: area, onSelect: opts.onSelect })
  services.player.seek(t)
  return shape
}

/**
 * *Blur the typed text* (§5.5.8): one blur over the typing place of `typing`'s step, from its
 * typing's start to the next settled page change after the marked step's shot (or the end of the
 * video). One update.
 */
export function blurTypedText(store: EditStore<Project>, typing: GuideStep, marked: { t: number }, scan: SceneScan | null, scale: number): void {
  const p = store.state
  const { typed } = blurBoxes(typing, { w: p.width, h: p.height }, scale)
  if (!typed) return
  const page = scan ? screenChanges(scan).find((c) => c.page && c.t > marked.t) : undefined
  const until = page ? page.t : p.duration
  store.update((q) => withTypedBlur(q, typing, until, typed))
}

/** The key of the bug report's Actual screenshot among the images. */
export { ACTUAL_KEY }
