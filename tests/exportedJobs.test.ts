/**
 * The jobs main keeps of this session's exports (docs/design/output-and-languages.md §8.1): the
 * timeline step over the recordings renders Music and Effects with the export's own job.
 */
import { describe, expect, it } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'
import { exportJobOf, rememberExportJob } from '../src/main/exportedJobs'

const job = (n: number): ExportJob => ({ outputPath: `C:\\v\\${n}.mp4`, frames: n } as ExportJob)

describe('rememberExportJob', () => {
  it('keeps the last four exports, the newest replacing an earlier one of the same file', () => {
    for (let n = 1; n <= 5; n++) rememberExportJob(`/v/${n}.mp4`, job(n))
    expect(exportJobOf('/v/1.mp4')).toBeUndefined()
    expect(exportJobOf('/v/2.mp4')?.frames).toBe(2)
    expect(exportJobOf('/v/5.mp4')?.frames).toBe(5)
    rememberExportJob('/v/2.mp4', job(20))
    rememberExportJob('/v/6.mp4', job(6))
    expect(exportJobOf('/v/2.mp4')?.frames).toBe(20)
    expect(exportJobOf('/v/3.mp4')).toBeUndefined()
  })
})
