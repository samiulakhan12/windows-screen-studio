import type { SafeChoice } from '../../../shared/render/safeZones'

/**
 * Where TikTok, Reels and Shorts put their buttons and captions, shaded over the preview's CSS box
 * (docs/design/vertical-video.md §2.8, §7): DOM only, pointer-events none and aria-hidden, never
 * drawn on a canvas, so it can never reach an export, a thumbnail or the clipboard.
 *
 * CONTRACT (part P3): the props are frozen; the body is to be written.
 */
export function SafeZoneOverlay(props: { choice: SafeChoice; box: { w: number; h: number } }): JSX.Element {
  void props
  throw new Error('not implemented')
}
