/**
 * Click sounds (CursorSettings.clickSound).
 *
 * CONTRACT between the cursor builder (implements this module and the preview playback
 * with WebAudio) and the export builder (calls clickSoundJob() from the export audio
 * graph and mixes the clicks in). The sound itself is synthesised (no asset file), so
 * preview and export sound the same.
 */
import type { Clip, CursorTrack, Project } from '../types'

export interface ClickSoundJob {
  /** OUTPUT times (seconds, after cuts and speed changes) at which a click plays. */
  times: number[]
  /** Linear gain 0..1. */
  volume: number
}

/** Clicks to mix into the export, or null when click sounds are off or there are none. */
export function clickSoundJob(_project: Project, _cursor: CursorTrack, _clips: Clip[]): ClickSoundJob | null {
  return null
}

/**
 * ffmpeg lavfi source expression for ONE click (mono, 48 kHz), e.g. for
 * `-f lavfi -i "aevalsrc=...:d=0.06"`. Implemented by the cursor builder.
 */
export function clickSoundSource(): string {
  return 'aevalsrc=0:d=0.06:s=48000'
}
