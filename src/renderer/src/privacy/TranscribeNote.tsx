import type { Project } from '../../../shared/types'

/** The transcription choices' note that a service hears every secret (§2.13). Stub from the contracts step: part P5 draws it; until then nothing. */
export function TranscribeNote(props: { project: Project; place: 'service' | 'local' }): JSX.Element | null {
  void props
  return null
}
