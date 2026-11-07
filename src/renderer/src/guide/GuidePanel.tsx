/**
 * The Guide panel (docs/design/smart-tools.md §2.1): steps, screenshots, titles and notes, and
 * saving a guide, a click-through demo or a bug report. Part P1 writes it; the contracts' stub shows
 * the panel's place and closes.
 */
import type { CursorTrack, Project } from '../../../shared/types'
import { StubPanel } from '../smart/StubPanel'

export function GuidePanel(props: { project: Project; cursor: CursorTrack; start: 'guide' | 'demo' | 'bug'; onClose(): void; onNotice(message: string): void }): JSX.Element {
  const title = props.start === 'demo' ? 'Click-through demo' : props.start === 'bug' ? 'Bug report' : 'Step-by-step guide'
  return <StubPanel title={title} testId="guide-panel" onClose={props.onClose} />
}
