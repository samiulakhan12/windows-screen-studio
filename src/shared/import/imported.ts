/**
 * Whether a project was imported from a video file, read defensively (project.json may be edited
 * by hand), and the sentences the editor shows where a feature needs the cursor, clicks or keys
 * Flown records (docs/design/import-video.md §4.7).
 */
import type { ImportedSource, Project } from '../types'

const text = (v: unknown, max = 260): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** The project's import record, cleaned; null for a recorded project (or a stored value that is not one). */
export function importedSource(project: Pick<Project, 'source'> | null | undefined): ImportedSource | null {
  const s = project?.source as unknown
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  const r = s as Record<string, unknown>
  if (r.kind !== 'import') return null
  const rotation = r.rotation === 90 || r.rotation === 180 || r.rotation === 270 ? r.rotation : 0
  return {
    kind: 'import',
    fileName: text(r.fileName) ?? '',
    bytes: count(r.bytes) ?? 0,
    container: text(r.container, 80) ?? '',
    videoCodec: text(r.videoCodec, 40) ?? '',
    audioCodec: text(r.audioCodec, 40),
    width: count(r.width) ?? 0,
    height: count(r.height) ?? 0,
    rotation,
    fps: count(r.fps),
    ...(typeof r.hdr === 'boolean' ? { hdr: r.hdr } : {}),
    importedAt: text(r.importedAt, 40) ?? ''
  }
}

export const isImported = (project: Pick<Project, 'source'> | null | undefined): boolean => importedSource(project) !== null

/** What the editor says about features an imported video cannot have. */
export const IMPORTED_COPY = {
  cursor: 'This video was imported, so Flown has no cursor data for it. The smooth cursor, click effects and click sounds are off; a cursor in the video stays as it was.',
  /** Followed by orPress's "(or press Z)". */
  autoZoom: 'This video was imported, so there are no clicks or typing to zoom on. Add zooms yourself: double-click the zoom track',
  keystrokes: 'This video was imported, so no keyboard shortcuts were recorded.',
  camera: 'This video was imported, so it has no separate camera.',
  noCursor: 'This video was imported, so it has no cursor data'
} as const
