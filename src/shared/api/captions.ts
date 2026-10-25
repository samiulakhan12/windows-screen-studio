import type { SubtitleFormat } from '../captions/subtitles'

export interface CaptionsApi {
  /**
   * Asks where to save a subtitle file (`defaultName` without extension) and writes `content`
   * there; the main process checks the content (shared/captions/subtitles validSubtitle) and the
   * chosen path. Resolves to the saved file, or null when the dialog was cancelled.
   */
  saveCaptions(defaultName: string, format: SubtitleFormat, content: string): Promise<string | null>
}
