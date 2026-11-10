/**
 * Free space before a large export starts (docs/design/output-and-languages.md §5.10): an editing
 * format, a WAV file or sound stems can need several GB. Main compares `estimateBytes` with the free
 * space of the target folder; below 1.2 × the estimate the export does not start and says why (error
 * code `disk-full`). Exports sized by their encoder (H.264, HEVC, AV1, VP9, GIF, M4A) without stems
 * are never held back.
 */
import { promises as fs } from 'node:fs'
import type { ExportJob } from '../shared/api/export'
import type { ExportFps } from '../shared/types'
import { fmt } from '../shared/i18n/fmt'
import { t } from '../shared/i18n/t'
import { estimateBytes } from '../shared/render/proFormats'

/** The free space an estimated export needs, as a multiple of its estimate. */
export const SPACE_MARGIN = 1.2

/** The upper estimate of the bytes `job` writes, its stems included (0 when its encoder sizes it). */
export function jobBytes(job: Pick<ExportJob, 'format' | 'codec' | 'alpha' | 'fps' | 'frames' | 'width' | 'height' | 'stems'>): number {
  const options = { format: job.format, codec: job.codec, alpha: job.alpha ? ('background' as const) : undefined, fps: job.fps as ExportFps }
  return estimateBytes(options, { width: job.width, height: job.height }, job.fps > 0 ? job.frames / job.fps : 0, job.stems?.stems.length ?? 0)
}

/** What `fs.statfs` gives that this check reads. */
type StatFs = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>

/**
 * Why `job` cannot start in `folder` (§5.10): "This export needs about {size} and the folder has {free}
 * free. …" when the folder has less than 1.2 × the estimate free; null when it has enough, when the
 * job is not estimated, or when the free space cannot be read (the export then runs as before).
 */
export async function spaceProblem(job: Parameters<typeof jobBytes>[0], folder: string, statfs: StatFs = (dir) => fs.statfs(dir)): Promise<string | null> {
  const need = jobBytes(job)
  if (!(need > 0)) return null
  const s = await statfs(folder).catch(() => null)
  if (!s) return null
  const free = Number(s.bavail) * Number(s.bsize)
  if (!Number.isFinite(free) || free >= need * SPACE_MARGIN) return null
  return t('errors.disk.space', { size: fmt.bytes(need), free: fmt.bytes(free) })
}
