import type { Project } from '../../../shared/types'

/** The guide's lines when Find has not checked the video, or did not finish (§2.11). Stub from the contracts step: part P5 draws them; until then nothing. */
export function NotCheckedNote(props: { project: Project; place: 'send' | 'save' }): JSX.Element | null {
  void props
  return null
}
