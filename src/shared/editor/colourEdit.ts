/**
 * Editing the colour of the screen and the camera (docs/design/editing-polish.md §2.5, §16): each
 * one project out, so one action is one undo step. A grade is kept tidy: a slider at 0 and a look
 * at its full strength are not written, a grade left with nothing is deleted, and a project left
 * with no grade has no `grade` at all, as before wave 10. Values go through the reader
 * (readColorGrade), so what is stored is always what a load would read back.
 *
 * Auto colour's record (`grade.auto`) belongs to Review mode: settleGrade drops it when the camera
 * grade is then changed by hand, as an edit by hand keeps an automatic zoom.
 */
import { GRADE_SLIDERS, readColorGrade, readColorLut } from '../render/gradeData'
import { SCREEN_LOOKS } from '../render/looks'
import type { ColorGrade, ColorLut, LookId, Project, ProjectGrade } from '../types'

type Which = 'screen' | 'camera'

/** `project` with `grade` as its colour (an empty one deleted). */
export function withProjectGrade(project: Project, grade: ProjectGrade): Project {
  const tidy: ProjectGrade = {}
  if (grade.screen) tidy.screen = grade.screen
  if (grade.camera) tidy.camera = grade.camera
  if (grade.auto) tidy.auto = grade.auto
  if (Object.keys(tidy).length) return { ...project, grade: tidy }
  if (!('grade' in project)) return project
  const { grade: _gone, ...rest } = project
  return rest
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** A grade as stored: read back through the reader, with its sliders at 0 and a full-strength look left out. */
function tidyGrade(g: ColorGrade, which: Which): ColorGrade | undefined {
  const read = readColorGrade(g, which)
  if (!read) return undefined
  const out: ColorGrade = { ...read }
  for (const key of GRADE_SLIDERS) if (out[key] === 0) delete out[key]
  if (out.exposure === 0) delete out.exposure
  if (!out.look || out.lookStrength === 1) delete out.lookStrength
  if (out.lut && out.lut.strength === 1) {
    const { strength: _s, ...lut } = out.lut
    out.lut = lut
  }
  return Object.keys(out).length ? out : undefined
}

/** `project` with the grade of `which` set to `g` (deleted when undefined); `project` itself when nothing changes. */
function put(project: Project, which: Which, g: ColorGrade | undefined): Project {
  const before = project.grade?.[which]
  const after = g ? tidyGrade(g, which) : undefined
  if (same(before, after)) return project
  return withProjectGrade(project, { ...project.grade, [which]: after })
}

/** `project` with `patch` merged into the grade of `which` (an undefined field is removed); null: Reset colour. */
export function withGrade(project: Project, which: Which, patch: Partial<ColorGrade> | null): Project {
  if (patch === null) return put(project, which, undefined)
  const next: ColorGrade = { ...project.grade?.[which] }
  for (const [key, value] of Object.entries(patch) as [keyof ColorGrade, unknown][]) {
    if (value === undefined) delete next[key]
    else (next as Record<string, unknown>)[key] = value
  }
  return put(project, which, next)
}

/** `project` with one control of `which` back at its default (a look also loses its strength). */
export function resetSlider(project: Project, which: Which, key: keyof ColorGrade): Project {
  const g = project.grade?.[which]
  if (!g || !(key in g)) return project
  const next: ColorGrade = { ...g }
  delete next[key]
  if (key === 'look') delete next.lookStrength
  return put(project, which, next)
}

/**
 * `project` with the look of `which` (null: None). Choosing another look starts it at full
 * strength; `strength` (0..1) sets it. The screen takes only Natural, Vivid and Mono.
 */
export function withLook(project: Project, which: Which, look: LookId | null, strength?: number): Project {
  const g: ColorGrade = { ...project.grade?.[which] }
  if (look === null) {
    delete g.look
    delete g.lookStrength
    return put(project, which, g)
  }
  if (which === 'screen' && !SCREEN_LOOKS.includes(look)) return project
  if (g.look !== look) delete g.lookStrength
  g.look = look
  if (strength !== undefined) g.lookStrength = strength
  return put(project, which, g)
}

/** `project` with the LUT of `which` (null: Remove); the reference is read as a load would. */
export function withLut(project: Project, which: Which, lut: ColorLut | null): Project {
  const g: ColorGrade = { ...project.grade?.[which] }
  if (lut === null) delete g.lut
  else {
    const read = readColorLut(lut)
    if (!read) return project
    g.lut = read
  }
  return put(project, which, g)
}

/**
 * `next` with Auto colour's record dropped when the camera grade was changed by hand; `next`
 * itself when nothing applies. Auto colour writes a new record with each run, so the same record
 * on both sides with another camera grade is an edit by hand.
 */
export function settleGrade(next: Project, prev: Project): Project {
  const auto = next.grade?.auto
  if (!auto || next.grade === prev.grade) return next
  if (prev.grade?.auto !== auto) return next
  if (same(next.grade?.camera, prev.grade?.camera)) return next
  const { auto: _gone, ...rest } = next.grade!
  return withProjectGrade(next, rest)
}
