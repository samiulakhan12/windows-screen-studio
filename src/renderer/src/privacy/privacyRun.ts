/**
 * Running Find from the editor (docs/design/auto-blur.md §16.5). The contracts step writes the
 * Polish seam only: part P5 fills it and adds startFind and stopAndApply.
 */
import type { PrivacyGathered } from '../../../shared/api/privacy'
import type { Project, Transcript } from '../../../shared/types'

/** Polish's *Find private info* step (§14.5): what Find found for `project`, or null. Stub: null (the step finds nothing). */
export function gatherPrivacy(project: Project, captions: Transcript | null, signal: AbortSignal): Promise<PrivacyGathered | null> {
  void project
  void captions
  void signal
  return Promise.resolve(null)
}
