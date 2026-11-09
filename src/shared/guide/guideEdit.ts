/**
 * Edits of the step-by-step guide (docs/design/smart-tools.md §5, §17): each one a new project for
 * one store update, so one user action is one undo step. The stored guide is always what
 * readGuideSettings reads back (strings cut to GUIDE_LIMITS), an edit that changes nothing returns
 * the same project, and a guide left with nothing in it is removed, so a project the guide was
 * opened on and not edited saves to the same bytes. Pure.
 */
import { newShapeId } from '../editor/shapes'
import type { AiProviderKind, GuideSettings, GuideStepEdit, NormRect, Project, Shape } from '../types'
import { readGuideSettings } from './guideData'
import type { GuideStep } from './steps'

type Via = AiProviderKind | 'local'
type Patch = Partial<Omit<GuideStepEdit, 'key'>>

/** `project` with `guide` as read back (absent when nothing is left); the same project when it does not change. */
function withGuide(project: Project, guide: GuideSettings | undefined): Project {
  const next = readGuideSettings(guide, project.duration)
  if (JSON.stringify(next) === JSON.stringify(project.guide)) return project
  if (!next) {
    if (!('guide' in project)) return project
    const { guide: _gone, ...rest } = project
    void _gone
    return rest as Project
  }
  return { ...project, guide: next }
}

/** `edit` with `patch` applied: an undefined or false value removes its field. */
function patched(edit: GuideStepEdit, patch: Patch): GuideStepEdit {
  const out: Record<string, unknown> = { ...edit }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || (v as unknown) === false) delete out[k]
    else out[k] = v
  }
  return out as unknown as GuideStepEdit
}

/** The edits with `key`'s replaced by `edit` (or removed, for null), in their order. */
function replaceEdit(steps: readonly GuideStepEdit[] | undefined, key: string, edit: GuideStepEdit | null): GuideStepEdit[] {
  const list = (steps ?? []).filter((e) => e.key !== key)
  if (edit && Object.keys(edit).length > 1) list.push(edit)
  return list
}

/**
 * The step `key` edited by hand (§17): `patch` merged into its edit (an undefined or false value
 * removes the field), or its edit removed for null. A title typed by hand clears `ai`; a note typed
 * by hand clears `textAi`.
 */
export function withStepEdit(project: Project, key: string, patch: Patch | null): Project {
  const guide = project.guide ?? {}
  const old = guide.steps?.find((e) => e.key === key) ?? { key }
  let edit: GuideStepEdit | null = null
  if (patch) {
    const p: Patch = { ...patch }
    if ('title' in p && !('ai' in p)) p.ai = undefined
    if ('text' in p && !('textAi' in p)) p.textAi = undefined
    edit = patched(old, p)
  }
  return withGuide(project, { ...guide, steps: replaceEdit(guide.steps, key, edit) })
}

/** A step added by hand at source time `t` with `title` (§2.1, *Add a step at the playhead*), keyed 'a' + its time in ms (the next free one). */
export function withAddedStep(project: Project, t: number, title: string): Project {
  const guide = project.guide ?? {}
  const taken = new Set((guide.added ?? []).map((a) => a.key))
  let ms = Math.max(0, Math.round(t * 1000))
  while (taken.has(`a${ms}`)) ms++
  return withGuide(project, { ...guide, added: [...(guide.added ?? []), { key: `a${ms}`, t, title }] })
}

/** A step added by hand removed, with its edit. */
export function withoutAddedStep(project: Project, key: string): Project {
  const guide = project.guide ?? {}
  return withGuide(project, { ...guide, added: (guide.added ?? []).filter((a) => a.key !== key), steps: replaceEdit(guide.steps, key, null) })
}

/** Write titles' answer (§5.3) in one update: each title stored with `ai` set to who wrote it. */
export function withAiTitles(project: Project, titles: readonly { key: string; title: string }[], via: Via): Project {
  const guide = project.guide ?? {}
  let steps = guide.steps ?? []
  for (const { key, title } of titles) {
    const old = steps.find((e) => e.key === key) ?? { key }
    steps = replaceEdit(steps, key, patched(old, { title, ai: via }))
  }
  return withGuide(project, { ...guide, steps })
}

/** Tidy notes' answer (§5.4) in one update: each note stored with `textAi` set. */
export function withAiNotes(project: Project, notes: readonly { key: string; text: string }[], via: Via): Project {
  const guide = project.guide ?? {}
  let steps = guide.steps ?? []
  for (const { key, text } of notes) {
    const old = steps.find((e) => e.key === key) ?? { key }
    steps = replaceEdit(steps, key, patched(old, { text, textAi: via }))
  }
  return withGuide(project, { ...guide, steps })
}

/** *Use offline titles* (§5.3): every title an AI wrote removed, in one update. */
export function withoutAiTitles(project: Project): Project {
  const guide = project.guide
  if (!guide?.steps?.some((e) => e.ai)) return project
  return withGuide(project, { ...guide, steps: guide.steps.map((e) => (e.ai ? patched(e, { title: undefined, ai: undefined }) : e)) })
}

/** The guide's own fields (title, intro, kind, language, steps source, brand, end screen, bug report): an undefined value removes one. */
export function withGuideFields(project: Project, patch: Partial<Omit<GuideSettings, 'steps' | 'added'>>): Project {
  const out: Record<string, unknown> = { ...(project.guide ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return withGuide(project, out as GuideSettings)
}

/**
 * *Blur the typed text* (§5.5.8): one blur shape over `box` (fractions of the recorded frame) from
 * the start of the step's typing to `until` (the next settled page change after the marked step, or
 * the end of the video), in one update.
 */
export function withTypedBlur(project: Project, step: GuideStep, until: number, box: NormRect): Project {
  const start = Math.max(0, step.typing?.t ?? step.t)
  const end = Math.min(project.duration, Math.max(start + 0.1, until))
  const shape: Shape = {
    id: newShapeId(),
    kind: 'blur',
    start,
    end,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    color: '#000000',
    strokeWidth: 6,
    fill: false,
    opacity: 1,
    strength: 0.5
  }
  return { ...project, shapes: [...(project.shapes ?? []), shape] }
}
