import type { Project } from '../../../shared/types'

/** The export dialog's note above *Export* (§2.12). Stub from the contracts step: part P5 draws it; until then nothing. */
export function PrivacyExportNote(props: { project: Project; onReview: () => void; onFind: () => void; onWait: (waiting: boolean) => void; onStopAndExport: () => void }): JSX.Element | null {
  void props
  return null
}
