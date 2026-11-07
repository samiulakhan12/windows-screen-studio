/**
 * Make a shorter version (docs/design/smart-tools.md §2.4, §8.6). Part P3 writes it; the contracts'
 * stub closes at once.
 */
import { useEffect } from 'react'
import type { CursorTrack, Project } from '../../../shared/types'

export function ShortVersionDialog(props: { project: Project; cursor: CursorTrack; vw: number; vh: number; onClose(): void; onOpen(id: string): void }): JSX.Element {
  const { onClose } = props
  useEffect(() => onClose(), [onClose])
  return <></>
}
