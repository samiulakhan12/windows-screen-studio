/**
 * The Short clips panel (docs/design/smart-tools.md §2.4): the best 15 to 90 second moments, each
 * made into a copy. Part P3 writes it; the contracts' stub shows the panel's place and closes.
 */
import type { CursorTrack, Project } from '../../../shared/types'
import { StubPanel } from '../smart/StubPanel'

export function ShortClipsPanel(props: { project: Project; cursor: CursorTrack; vw: number; vh: number; onClose(): void; onOpen(id: string): void }): JSX.Element {
  return <StubPanel title="Short clips" testId="clips-panel" onClose={props.onClose} />
}
