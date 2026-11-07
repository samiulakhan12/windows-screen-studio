/**
 * The full-size screenshot viewer (docs/design/smart-tools.md §2.1.2, §5.3.1). Part P1 writes it
 * (P6 adds its send form); the contracts' stub closes at once.
 */
import { useEffect } from 'react'
import type { GuideStepEdit } from '../../../shared/types'
import type { GuideImage } from '../../../shared/guide/guideDoc'

export function ShotViewer(props: {
  shots: readonly { key: string; label: string; image: GuideImage }[]
  index: number
  mode: 'view' | 'check' | 'send'
  place?: string
  onClose(result?: { send: readonly string[] }): void
  onBlur(key: string): void
  onAdjust(key: string, edit: Pick<GuideStepEdit, 'rect' | 'ring'> | null): void
}): JSX.Element {
  const { onClose } = props
  useEffect(() => onClose(), [onClose])
  return <></>
}
