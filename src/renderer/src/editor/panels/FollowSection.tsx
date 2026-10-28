import type { Project } from '../../../../shared/types'

/**
 * Style › Vertical framing (docs/design/vertical-video.md §2.5): Follow the action, how close,
 * Movement, the camera band, where the view rests, Hold the view here and Keep text clear of app
 * buttons; or, in a frame that cannot follow while a 9:16 one could, the "Making a Short?" callout.
 *
 * CONTRACT (part P3): the props are frozen; the body is to be written.
 */
export function FollowSection(props: { project: Project; vw: number; vh: number; onMakeVertical(): void }): JSX.Element {
  void props
  throw new Error('not implemented')
}
