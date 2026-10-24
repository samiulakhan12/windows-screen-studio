import type { Selection } from './selection'

export interface TrackSlotProps {
  /** Pixels per second of source time. */
  px: number
  /** Source-time window that is rendered (items outside it may be skipped). */
  win: { start: number; end: number }
  duration: number
  selection: Selection
  onSelect: (sel: Selection) => void
}

/** Timeline track of camera layout segments (shown only for recordings with a camera). */
export function LayoutTrack(props: TrackSlotProps): JSX.Element | null {
  void props
  return null
}

/** Its row label in the timeline's label column, or null when the track is hidden. */
export function LayoutTrackLabel(): JSX.Element | null {
  return null
}
