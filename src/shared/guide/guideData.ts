/**
 * Reading the stored step-by-step guide (Project.guide) and a clip copy's origin (Project.clipOf):
 * docs/design/smart-tools.md §4.2. Strings are cut to GUIDE_LIMITS, keys and boxes checked, times
 * clamped into the recording, and every field that cannot be read dropped; an object with nothing
 * left reads as undefined, so an absent field stays absent and a saved project loads to the same
 * bytes. Pure; one rule for loading a project and for the Guide panel's edits.
 */
import type { AiProviderKind, ClipOrigin, GuideAddedStep, GuideEnd, GuideSettings, GuideStepEdit } from '../types'
import { readLinkUrl } from '../smart/privateText'

/** Longest texts kept (characters), and the most details, step edits and added steps. */
export const GUIDE_LIMITS = {
  title: 120,
  intro: 2000,
  expected: 2000,
  actual: 2000,
  detail: 120,
  details: 8,
  stepTitle: 120,
  stepText: 1000,
  stepType: 200,
  endHeading: 120,
  endLabel: 40,
  edits: 1000,
  added: 200
} as const

/** Longest `why` of a clip's origin. */
const WHY_MAX = 120

const EDIT_KEY = /^[cktsb]\d{1,9}$/
const ADDED_KEY = /^a\d{1,9}$/
const VIA: readonly (AiProviderKind | 'local')[] = ['openai', 'gemini', 'anthropic', 'local']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const EPS = 1e-9

/** At most `max` code points (a surrogate pair is never split). */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  return Array.from(text).slice(0, max).join('')
}

/** One line: every control character (line breaks too) becomes a space; cut to `max`. */
const oneLine = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? cut(v.replace(/[\u0000-\u001f\u007f]+/g, ' '), max) : undefined)

/** A note: line breaks kept (CRLF read as one), every other control character a space; cut to `max`. */
const note = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? cut(v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' '), max) : undefined

/** `{ [key]: value }`, or nothing when the value is absent. */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }))

const clampTime = (t: number, duration: number): number => Math.min(Math.max(0, t), Math.max(0, finite(duration) ? duration : Infinity))

/** Adjust's crop: four finite numbers inside the frame, at least 0.05 wide and high; else undefined. */
function readRect(v: unknown): GuideStepEdit['rect'] {
  if (!isObj(v) || !finite(v.x) || !finite(v.y) || !finite(v.w) || !finite(v.h)) return undefined
  const { x, y, w, h } = v
  if (x < 0 || y < 0 || w < 0.05 || h < 0.05 || x + w > 1 + EPS || y + h > 1 + EPS) return undefined
  return { x, y, w, h }
}

/** Adjust's ring: two finite numbers in 0..1; else undefined. */
function readPoint(v: unknown): GuideStepEdit['ring'] {
  if (!isObj(v) || !finite(v.x) || !finite(v.y) || v.x < 0 || v.x > 1 || v.y < 0 || v.y > 1) return undefined
  return { x: v.x, y: v.y }
}

const readVia = (v: unknown): GuideStepEdit['ai'] => (VIA.includes(v as AiProviderKind) ? (v as GuideStepEdit['ai']) : undefined)
const flag = (v: unknown): true | undefined => (v === true ? true : undefined)

/** One step's edit, or null when its key is bad or it holds nothing. */
function readStepEdit(v: unknown): GuideStepEdit | null {
  if (!isObj(v) || typeof v.key !== 'string' || !EDIT_KEY.test(v.key)) return null
  const edit: GuideStepEdit = {
    key: v.key,
    ...opt('title', oneLine(v.title, GUIDE_LIMITS.stepTitle)),
    ...opt('text', note(v.text, GUIDE_LIMITS.stepText)),
    ...opt('type', oneLine(v.type, GUIDE_LIMITS.stepType)),
    ...opt('full', flag(v.full)),
    ...opt('hidden', flag(v.hidden)),
    ...opt('after', flag(v.after)),
    ...opt('whole', flag(v.whole)),
    ...opt('demoZoom', flag(v.demoZoom)),
    ...opt('rect', readRect(v.rect)),
    ...opt('ring', readPoint(v.ring)),
    ...opt('ai', readVia(v.ai)),
    ...opt('textAi', readVia(v.textAi))
  }
  return Object.keys(edit).length > 1 ? edit : null
}

/** One step added by hand, or null. Its time is clamped into the recording. */
function readAdded(v: unknown, duration: number): GuideAddedStep | null {
  if (!isObj(v) || typeof v.key !== 'string' || !ADDED_KEY.test(v.key) || !finite(v.t) || typeof v.title !== 'string') return null
  return { key: v.key, t: clampTime(v.t, duration), title: oneLine(v.title, GUIDE_LIMITS.stepTitle)!, ...opt('text', note(v.text, GUIDE_LIMITS.stepText)) }
}

/** The demo's end screen: a heading, a label, and a link readLinkUrl accepts; else undefined. */
function readEnd(v: unknown): GuideEnd | undefined {
  if (!isObj(v) || typeof v.heading !== 'string') return undefined
  const url = readLinkUrl(v.url)
  return { heading: oneLine(v.heading, GUIDE_LIMITS.endHeading)!, ...opt('label', oneLine(v.label, GUIDE_LIMITS.endLabel)), ...opt('url', url ?? undefined) }
}

/** Entries by key, the last of a repeated key winning, at most `max` (the last ones). */
function byKey<T extends { key: string }>(raw: unknown, read: (v: unknown) => T | null, max: number): T[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = new Map<string, T>()
  for (const v of raw) {
    const e = read(v)
    if (!e) continue
    out.delete(e.key)
    out.set(e.key, e)
  }
  const list = [...out.values()]
  return list.length ? list.slice(-max) : undefined
}

/**
 * Project.guide as stored, or undefined when it is not an object or nothing readable is left
 * (§4.2). `duration`: the recording's length, which added steps' times and `actualAt` are clamped
 * into (absent: not clamped above). Idempotent.
 */
export function readGuideSettings(raw: unknown, duration?: number): GuideSettings | undefined {
  if (!isObj(raw)) return undefined
  const d = finite(duration) ? duration : Infinity
  const details = Array.isArray(raw.details)
    ? raw.details
        .filter((x): x is Obj => isObj(x) && typeof x.text === 'string')
        .slice(0, GUIDE_LIMITS.details)
        .map((x) => ({ text: oneLine(x.text, GUIDE_LIMITS.detail)!, ...opt('off', flag(x.off)) }))
    : undefined
  const out: GuideSettings = {
    ...opt('title', oneLine(raw.title, GUIDE_LIMITS.title)),
    ...opt('intro', note(raw.intro, GUIDE_LIMITS.intro)),
    ...opt('kind', raw.kind === 'bug' ? ('bug' as const) : undefined),
    ...opt('expected', note(raw.expected, GUIDE_LIMITS.expected)),
    ...opt('actual', note(raw.actual, GUIDE_LIMITS.actual)),
    ...opt('actualAt', finite(raw.actualAt) ? clampTime(raw.actualAt, d) : undefined),
    ...opt('details', details?.length ? details : undefined),
    ...opt('language', raw.language === 'en' || raw.language === 'bn' ? (raw.language as 'en' | 'bn') : undefined),
    ...opt('from', raw.from === 'badges' ? ('badges' as const) : undefined),
    ...opt('brand', raw.brand === false ? (false as const) : undefined),
    ...opt('end', readEnd(raw.end)),
    ...opt('steps', byKey(raw.steps, readStepEdit, GUIDE_LIMITS.edits)),
    ...opt('added', byKey(raw.added, (v) => readAdded(v, d), GUIDE_LIMITS.added))
  }
  return Object.keys(out).length ? out : undefined
}

/** Project.clipOf as stored (§4.2): a known kind, finite `start < end`, `why` one line of at most 120 characters; else undefined. */
export function readClipOrigin(raw: unknown): ClipOrigin | undefined {
  if (!isObj(raw) || (raw.kind !== 'moment' && raw.kind !== 'short') || !finite(raw.start) || !finite(raw.end) || !(raw.start < raw.end)) return undefined
  return { kind: raw.kind, start: raw.start, end: raw.end, ...opt('why', oneLine(raw.why, WHY_MAX)) }
}
