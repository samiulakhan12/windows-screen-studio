import type { SidecarKind } from '../render/exportBundle'

export interface ExportBundleApi {
  /**
   * Saves a file next to `anchor`, a file exported in this session (F-11): its subtitles, chapter
   * list, description (text) or thumbnail (PNG bytes). Main names it after `anchor` and checks the
   * content; resolves with the path written.
   */
  writeSidecar(anchor: string, kind: SidecarKind, content: string | Uint8Array): Promise<string>
}
