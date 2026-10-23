import type { ExportFormat, ExportSettings } from '../types'

export interface ExportJob {
  width: number
  height: number
  fps: number
  format: ExportFormat
  quality: ExportSettings['quality']
  /** Audio source (proxy file) and trim window; omitted when there is no audio. */
  audio?: { start: number; end: number }
  outputPath: string
}

export interface ExportApi {
  chooseExportPath(defaultName: string, format: ExportFormat): Promise<string | null>
  exportStart(projectId: string, job: ExportJob): Promise<void>
  exportFrame(frame: Uint8Array): Promise<void>
  exportFinish(): Promise<void>
  exportCancel(): Promise<void>
  showItemInFolder(path: string): Promise<void>
}
