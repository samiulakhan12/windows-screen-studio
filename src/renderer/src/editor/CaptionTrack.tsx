import type { TrackSlotProps } from './LayoutTrack'

/** Timeline track of the transcript's captions (shown once the recording has a transcript). */
export function CaptionTrack(props: TrackSlotProps): JSX.Element | null {
  void props
  return null
}

/** Its row label in the timeline's label column, or null when the track is hidden. */
export function CaptionTrackLabel(): JSX.Element | null {
  return null
}
