/**
 * The guide as a document (docs/design/smart-tools.md §5.6), built once and written as PDF, HTML,
 * a demo or Markdown: the title, the intro, the language and its words, the brand when used, and
 * for each included step its number in the guide's digits, label, section heading, title, *Type*
 * text, note, image and alt text, and the demo's hotspot; a bug report's Expected, Actual and
 * details; the demo's end screen. Every string is plain text: the builders escape it. Pure.
 */
import { planOf, videoDuration } from '../engine/freeze'
import { formatTimestamp } from '../render/chapters'
import type { GuideEnd, GuideStepEdit, Project } from '../types'
import { fill, GUIDE_WORDS, guideDigits, guideLanguage, guideNumber, type GuideWords } from './guideWords'
import { ringOf, shotRect } from './shots'
import type { GuideStep } from './steps'
import { shownTitles, stepIncluded, stepText } from './stepTitles'

export interface GuideImage {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
}

export interface GuideDoc {
  title: string
  intro?: string
  lang: string
  words: GuideWords
  digits: 'native' | 'western'
  brand?: { logo: GuideImage | null; colour: string | null }
  steps: { n: string; label: string; section?: string; title: string; type?: string; text?: string; image: GuideImage | null; alt: string; hotspot?: { x: number; y: number } }[]
  bug?: { expected: string; actual: string; actualImage: GuideImage | null; details: string[] }
  end?: GuideEnd
}

/** The image key of a bug report's Actual screenshot in the images given to buildGuideDoc. */
export const ACTUAL_KEY = 'actual'

/**
 * Each step's number as the guide shows it (§5.1, §5.6), '' for a step left out: 1, 2, 3 in the
 * guide's digits; from step badges, the badge's own label and, for a step between badges the user
 * included, the badge before it and a count ("3.1", "3.2").
 */
export function stepNumbers(project: Project, steps: readonly GuideStep[]): string[] {
  const language = guideLanguage(project)
  const digits = guideDigits(project, language)
  const edits = new Map((project.guide?.steps ?? []).map((e) => [e.key, e]))
  const badges = steps.some((s) => s.kind === 'badge')
  let n = 0
  let badge = '0'
  let sub = 0
  return steps.map((s) => {
    if (!stepIncluded(s, edits.get(s.key))) return ''
    if (!badges) return guideNumber(++n, language, digits)
    if (s.kind === 'badge') {
      badge = s.badge?.label || guideNumber(++n, language, digits)
      sub = 0
      return badge
    }
    return `${badge}.${guideNumber(++sub, language, digits)}`
  })
}

/** The bug report's detail lines when none were edited (§5.6): the recording date, the screen size and scale, the video's length. */
export function defaultDetails(project: Project, scale = 1): string[] {
  const language = guideLanguage(project)
  const digits = guideDigits(project, language)
  const w = GUIDE_WORDS[language]
  const at = new Date(project.createdAt)
  const date = Number.isNaN(at.getTime())
    ? ''
    : new Intl.DateTimeFormat(language === 'bn' ? 'bn-BD' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(at)
  const length = videoDuration(project.clips, planOf(project))
  const lines = [
    date ? fill(w.recordedOn, { date }) : '',
    fill(w.screen, { w: project.width, h: project.height, scale: `${Math.round((scale > 0 ? scale : 1) * 100)}%` }),
    fill(w.length, { time: formatTimestamp(length, length >= 3600) })
  ].filter(Boolean)
  return lines.map((l) => guideNumber(l, language, digits))
}

/** The bug report's detail lines as shown and saved: the edited ones (those not unticked), else the defaults. */
export function bugDetails(project: Project, scale = 1): string[] {
  const stored = project.guide?.details
  if (!stored) return defaultDetails(project, scale)
  return stored.filter((d) => !d.off && d.text.trim()).map((d) => d.text)
}

/** The demo's hotspot for a step (§6.1), as fractions of its demo image: the ring's place in the whole screen, or in the zoomed shot with *Zoom to the click in the demo*. */
export function demoHotspot(step: GuideStep, project: Project, edit: GuideStepEdit | undefined, scale = 1): { x: number; y: number } | undefined {
  const frame = { w: project.width, h: project.height }
  const crop = project.crop ?? null
  const { rect } = shotRect(step, frame, crop, scale, { whole: !edit?.demoZoom, rect: edit?.demoZoom ? edit.rect : undefined })
  const ring = ringOf(step, rect, rect.w, frame, crop, edit?.ring)
  if (!ring) return undefined
  return { x: ring.cx / rect.w, y: ring.cy / rect.h }
}

/**
 * The document of the guide (§5.6) from the project and its steps (findSteps), with each included
 * step's image by step key (ACTUAL_KEY: the bug report's Actual screenshot) and the brand kit's
 * logo and colour when it is used. `brand` null, or the guide's brand unticked: no brand.
 */
export function buildGuideDoc(project: Project, steps: readonly GuideStep[], images: ReadonlyMap<string, GuideImage>, brand: GuideDoc['brand'] | null): GuideDoc {
  const guide = project.guide ?? {}
  const language = guideLanguage(project)
  const words = GUIDE_WORDS[language]
  const digits = guideDigits(project, language)
  const edits = new Map((guide.steps ?? []).map((e) => [e.key, e]))
  const added = new Map((guide.added ?? []).map((a) => [a.key, a]))
  const ns = stepNumbers(project, steps)
  const titles = shownTitles(project, steps, ns)
  const out: GuideDoc['steps'] = []
  steps.forEach((s, i) => {
    const edit = edits.get(s.key)
    if (!ns[i]) return
    const title = titles[i].title
    const note = edit?.text ?? added.get(s.key)?.text ?? stepText(steps, i, project, !!edit?.full)
    const hotspot = demoHotspot(s, project, edit)
    out.push({
      n: ns[i],
      label: fill(words.step, { n: ns[i] }),
      ...(s.badge?.section ? { section: s.badge.section } : {}),
      title,
      ...(edit?.type?.trim() ? { type: edit.type } : {}),
      ...(note.trim() ? { text: note } : {}),
      image: images.get(s.key) ?? null,
      alt: fill(words.stepAlt, { n: ns[i], title }),
      ...(hotspot ? { hotspot } : {})
    })
  })
  const doc: GuideDoc = {
    title: guide.title?.trim() || project.name,
    ...(guide.intro?.trim() ? { intro: guide.intro } : {}),
    lang: language,
    words,
    digits,
    ...(brand && guide.brand !== false ? { brand } : {}),
    steps: out,
    ...(guide.end ? { end: guide.end } : {})
  }
  if (guide.kind === 'bug') {
    doc.bug = {
      expected: guide.expected ?? '',
      actual: guide.actual ?? '',
      actualImage: guide.actualAt !== undefined ? (images.get(ACTUAL_KEY) ?? null) : null,
      details: bugDetails(project)
    }
  }
  return doc
}
