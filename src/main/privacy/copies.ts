/**
 * Copies made before Find (docs/design/auto-blur.md §2.12, §5.10): the projects made from this one
 * (`copyOf`), covering them with this project's covers and private bleeps as suggestions, and what a
 * copy lacks of its original's. Copies share the recording, so covers in source seconds carry over as
 * they are. A copy open in the editor is skipped (it can bring them over itself), and every write goes
 * through projectFileText.
 */
import path from 'node:path'
import type { CopyInfo, FindResult, OriginCovers } from '../../shared/api/privacy'
import { originCoversFor, withFoundCovers } from '../../shared/privacy/found'
import type { Bleep, FindRecord, Project, ProjectSummary } from '../../shared/types'
import { writeFileAtomicSync } from '../atomicWrite'
import { projectFileText } from '../projectFile'
import * as projects from '../projects'
import { noteProjectSaved } from '../search/searchIpc'

export interface CopiesDeps {
  listProjects?: () => Promise<ProjectSummary[]>
  readProject?: (id: string) => Promise<Project>
  /** Writes a copy's project.json (through projectFileText). */
  save?: (project: Project) => void
  /** Whether a project is open in an editor (Flown's one editor has the original open when this runs). */
  isOpen?: (id: string) => boolean
  random?: () => number
  now?: () => Date
}

function save(project: Project): void {
  writeFileAtomicSync(path.join(projects.projectDir(project.id), 'project.json'), projectFileText(project))
  noteProjectSaved(project)
}

const depsOf = (d: CopiesDeps): Required<CopiesDeps> => ({
  listProjects: d.listProjects ?? projects.listProjects,
  readProject: d.readProject ?? projects.readProject,
  save: d.save ?? save,
  isOpen: d.isOpen ?? (() => false),
  random: d.random ?? Math.random,
  now: d.now ?? (() => new Date())
})

/** The projects made from `projectId` (their `copyOf` names it). */
export async function listCopies(projectId: string, deps: CopiesDeps = {}): Promise<CopyInfo[]> {
  const d = depsOf(deps)
  const all = await d.listProjects()
  return all.filter((p) => p.copyOf?.id === projectId && p.id !== projectId).map((p) => ({ id: p.id, name: p.name, open: d.isOpen(p.id) }))
}

/**
 * Adds this project's covers and private bleeps to each copy listed, as suggestions (kinds, groups
 * and tiers kept; the copy's containment and removed places apply, withFoundCovers), with this
 * project's Find record. A copy that is not this project's, is open, or cannot be read is skipped;
 * `covered` counts the copies written.
 */
export async function coverCopies(projectId: string, copyIds: readonly string[], deps: CopiesDeps = {}): Promise<{ covered: number; skipped: string[] }> {
  const d = depsOf(deps)
  const skipped: string[] = []
  let covered = 0
  let original: Project
  try {
    original = await d.readProject(projectId)
  } catch {
    return { covered: 0, skipped: [...copyIds] }
  }
  const mine = new Set((await listCopies(projectId, deps)).map((c) => c.id))
  for (const id of copyIds) {
    if (!mine.has(id) || d.isOpen(id)) {
      skipped.push(id)
      continue
    }
    let copy: Project
    try {
      copy = await d.readProject(id)
    } catch {
      skipped.push(id)
      continue
    }
    const lacks = originCoversFor(original, copy)
    if (!lacks.covers.length && !lacks.bleeps.length) continue
    const record: FindRecord = original.privacy?.find ?? { at: d.now().toISOString(), kinds: [], listened: false }
    const result: Extract<FindResult, { ok: true }> = { ok: true, projectId: id, requestId: 'copies', found: lacks.covers, failedReads: 0, thinSpans: record.thin ?? '', stopped: false, readTo: null, reader: record.reader ?? '' }
    // Bleep ids stay unique in the copy.
    const taken = new Set((copy.bleeps ?? []).map((b) => b.id))
    const said: Bleep[] = lacks.bleeps.map((b) => {
      let bid = b.id
      while (taken.has(bid)) bid = `${b.id}-${Math.floor(d.random() * 1e6).toString(36)}`
      taken.add(bid)
      return { ...b, id: bid, auto: true }
    })
    const { project } = withFoundCovers(copy, result, said, record, d.random)
    try {
      d.save(project)
      covered++
    } catch {
      skipped.push(id)
    }
  }
  return { covered, skipped }
}

/** What a copy lacks of its original's covers and private bleeps (nothing for a project that is no copy, or whose original is gone). */
export async function originCovers(projectId: string, deps: CopiesDeps = {}): Promise<OriginCovers> {
  const d = depsOf(deps)
  const none: OriginCovers = { missing: 0, covers: [], bleeps: [] }
  try {
    const copy = await d.readProject(projectId)
    const from = copy.copyOf?.id
    if (!from || from === projectId) return none
    return originCoversFor(await d.readProject(from), copy)
  } catch {
    return none
  }
}
