/**
 * The export dialog's Codec, Background and Frame rate rows (docs/design/output-and-languages.md §2.1),
 * Choice groups like the dialog's other rows. Part P5 writes them; the stubs render nothing.
 */
import type { ExportOptions } from '../../../shared/render/exportPresets'
import type { RowsState } from '../../../shared/render/exportRows'

interface RowProps {
  rows: RowsState
  options: ExportOptions
  onChange: (o: ExportOptions) => void
}

/** The Codec row, or null when the format has no codec choice. Part P5. */
export function CodecRow(props: RowProps): JSX.Element | null {
  void props
  return null
}

/** The Background row (MOV and WebM), or null. Part P5. */
export function BackgroundRow(props: RowProps): JSX.Element | null {
  void props
  return null
}

/** The Frame rate row with 24, 25, 30, 60 and 120 fps. Part P5. */
export function FrameRateRow(props: RowProps): JSX.Element {
  void props
  return <></>
}
