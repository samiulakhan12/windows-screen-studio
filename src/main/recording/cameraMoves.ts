import { cornerSegments, isCorner, type CameraMove } from '../../shared/recording/cameraBubble'
import type { Corner, LayoutSegment } from '../../shared/types'
import type { RecordingManifest } from '../projects'
import { toSourceTime, type PauseSpan } from './trackMath'

/**
 * What a recording's manifest also says about its camera bubble: whether the camera follows it
 * (the "Camera follows the preview bubble" option when the recording was prepared), and the
 * corners it went to, in seconds of the recording. Kept up to date while recording, so a
 * recording recovered after a crash keeps them too. Older manifests have neither.
 */
type BubbleManifest = RecordingManifest & { cameraFollowsBubble?: unknown; cameraMoves?: unknown }

/** A corner the bubble went to, at epoch ms `at` (the bubble's start corner: before the recording). */
export interface BubbleMove {
  at: number
  corner: Corner
}

export function setCameraFollows(m: RecordingManifest, follows: boolean): void {
  Object.assign(m, { cameraFollowsBubble: follows })
}

/**
 * Stores the bubble's `moves` in the manifest in recording time: paused time left out, a move
 * while paused applying on resume, one before the start (the countdown) applying from 0, as
 * marks and cursor samples are timed.
 */
export function setCameraMoves(m: RecordingManifest, moves: readonly BubbleMove[], startedAt: number, pauses: PauseSpan[]): void {
  Object.assign(m, { cameraMoves: moves.map((v) => ({ t: Math.max(0, +toSourceTime(v.at, startedAt, pauses).toFixed(3)), corner: v.corner })) })
}

/** The bubble's moves a manifest holds, when the camera follows the bubble (none otherwise). */
export function cameraMovesOf(m: RecordingManifest): CameraMove[] {
  const b = m as BubbleManifest
  if (b.cameraFollowsBubble === false || !Array.isArray(b.cameraMoves)) return []
  return b.cameraMoves.filter(
    (v): v is CameraMove => !!v && typeof v === 'object' && typeof (v as CameraMove).t === 'number' && Number.isFinite((v as CameraMove).t) && isCorner((v as CameraMove).corner)
  )
}

/** The layout segments that put the camera where the bubble was (the project's corner elsewhere). */
export function bubbleLayouts(m: RecordingManifest, duration: number, defaultCorner: Corner): LayoutSegment[] {
  return cornerSegments(cameraMovesOf(m), duration, defaultCorner)
}
