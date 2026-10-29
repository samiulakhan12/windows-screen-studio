/**
 * Makes the export bundle's files (F-11) and has main save them next to an exported file: the
 * captions as SRT / VTT, the chapter list, the description and the thumbnail. A file that fails is
 * reported and never fails the export itself.
 */
import { subtitleFile } from '../../../shared/captions/subtitles'
import { planOf, videoDuration } from '../../../shared/engine/freeze'
import { outputChapters } from '../../../shared/render/chapters'
import { chapterListText, descriptionText, partProject, sidecarName, type ChapterPart, type SidecarKind } from '../../../shared/render/exportBundle'
import type { Project } from '../../../shared/types'
import type { BatchExtras } from './exporter'

/**
 * What one file per chapter exports for `part`: the part's project (its clips and freezes give the
 * frames and the sound), drawn with the whole edit's scene. Captions, titles, overlays, the
 * background's clock and the cursor's loop home then run on the whole edit's clips, so the part
 * shows the same frames as that range of the whole export.
 */
export function partSource<S extends { project: Project }>(source: S, part: ChapterPart, last: boolean): S {
  return { ...source, project: partProject(source.project, part, last) }
}

export interface BundleRequest {
  /** The project as this file exports it (a part: its own clips). */
  project: Project
  kinds: readonly SidecarKind[]
  /** The description's first line. */
  title: string
  part?: { index: number; count: number; of: string }
  /** The thumbnail's PNG, drawn as the export draws it. */
  thumbnail: () => Promise<Uint8Array>
}

const baseName = (file: string): string => file.split(/[\\/]/).pop() ?? file

/** The text content of `kind`, or null for the thumbnail. */
export function sidecarText(kind: SidecarKind, req: BundleRequest): string | null {
  const { project } = req
  const plan = planOf(project)
  const length = videoDuration(project.clips, plan)
  if (kind === 'srt' || kind === 'vtt') return subtitleFile(project.transcript?.segments ?? [], project.clips, kind, plan)
  const chapters = outputChapters(project.chapters ?? [], project.clips, plan)
  if (kind === 'chapters') return chapterListText(chapters, length)
  if (kind === 'description') return descriptionText(req.title, length, chapters, req.part)
  return null
}

/** Saves every file of `req` next to `anchor`, one after another. */
export async function writeBundle(anchor: string, req: BundleRequest): Promise<BatchExtras | undefined> {
  if (!req.kinds.length) return undefined
  const saved: string[] = []
  const failed: string[] = []
  for (const kind of req.kinds) {
    try {
      const content = kind === 'thumbnail' ? await req.thumbnail() : sidecarText(kind, req)!
      saved.push(await window.api.writeSidecar(anchor, kind, content))
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split(/\n/)[0]
      failed.push(`${sidecarName(baseName(anchor), kind)}: ${reason}`)
    }
  }
  return { saved, failed }
}
