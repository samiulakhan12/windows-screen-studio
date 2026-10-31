import type { SidecarKind } from '../render/exportBundle'

export interface ExportBundleApi {
  /**
   * Saves a file next to `anchor`, a file exported in this session (F-11): its subtitles, chapter
   * list, description (text) or thumbnail (PNG bytes). Main names it after `anchor` and checks the
   * content; resolves with the path written. `language` names a translated caption track's
   * subtitles ("Demo.bn.srt", Captions Studio §11.10); absent: the spoken language's, as before.
   */
  writeSidecar(anchor: string, kind: SidecarKind, content: string | Uint8Array, language?: string): Promise<string>
}
