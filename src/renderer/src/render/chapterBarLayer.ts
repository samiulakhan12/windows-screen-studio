/**
 * Drawing the progress bar (docs/design/editing-polish.md §8): between the title cards and the
 * watermark, at the frame's video time.
 *
 * Contracts step: the exported signature of part P2 (§17.2). It returns at once without
 * `chapterBar.show` (every project from before); the stub draws nothing. Part P2 writes the body.
 */
import type { FrameContext } from './frameContext'

export function drawChapterBar(fc: FrameContext, video: number): void {
  if (!fc.project.chapterBar?.show) return
  void video
}
