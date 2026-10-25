/**
 * The automatic camera director (docs/design/camera-director.md): one click builds the camera
 * track of a recording with a webcam. The full camera for an intro and an outro while the
 * person talks before and after the demo; the bubble during the demo, in a corner kept clear of
 * the cursor and the action (measured where the compositor draws them); the camera hidden in long
 * silences; the face centred by a static webcam framing (faceFraming.ts). What it writes is
 * project data only (layout segments marked `auto`, the framing and Project.director), so the
 * preview and the export draw it alike through drawFrame.
 *
 * Plan and apply are split as in smartSpeed.ts: planDirector is pure and cheap enough to run
 * while the Camera tab is open (the panel shows the plan before it is applied);
 * applyDirectorPlan writes it, inside one store.update (one undo step), recomputed there from the
 * latest project. Segments the user placed are never written over: their layout changes are
 * locked; their camera positions (corner-only segments, from the live bubble or "Move camera
 * here") keep their corner, and what the director puts inside one is cut out of it (`cutOut`),
 * so removing the director's segments gives the position back whole (withoutDirected).
 *
 * CONTRACT (workstream A): signatures are frozen; bodies are to be written. planDirector's stub
 * returns an empty plan so the Camera panel can be built against it.
 */
import type { Range } from '../audio/activity'
import type { DirectorSpeech } from '../audio/speech'
import type { SmoothedTrack } from '../engine/cursor'
import { FACE, type FramingOutcome } from '../render/faceFraming'
import type { CameraLayout, Corner, CursorTrack, DirectorSettings, LayoutSegment, Project } from '../types'

/** What the director reads of a project. */
export type DirectorProject = Pick<
  Project,
  'duration' | 'clips' | 'layouts' | 'webcam' | 'style' | 'zooms' | 'zoomSettings' | 'width' | 'height' | 'hasWebcam' | 'capture' | 'cursor' | 'watermark' | 'director'
>

export interface DirectorInput {
  project: DirectorProject
  cursor: CursorTrack
  /** The drawn cursor's path (new SmoothedTrack(samples, duration, cursor.smoothing)); built here when absent. Pass the editor's (Editor.tsx) to share it. */
  cursorPath?: SmoothedTrack
  /** The zoom camera's focus path (focusPathFor); built here when absent. */
  focusPath?: SmoothedTrack
  /** When the person talks (speech.ts), or null when the recording has no sound, or it could not be measured. */
  speech: DirectorSpeech | null
  /** Ids of new segments (tests inject a counter; default: like layouts.ts ids, prefixed 'a'). */
  newId?: () => string
}

export type DirectorPartKind = 'intro' | 'outro' | 'hidden' | 'corner'

/** Why the director made a part (shown in the Camera panel's list). */
export type DirectorReason =
  | { kind: 'talk-before' }
  | { kind: 'talk-after' }
  /** A silence of `seconds` (output). */
  | { kind: 'silent'; seconds: number }
  /** The bubble left `avoided`, where the cursor and the action were. */
  | { kind: 'cursor'; avoided: Corner }

/** One change the director makes: an intro, an outro, a hidden part or a bubble corner. */
export interface DirectorPart {
  kind: DirectorPartKind
  layout: CameraLayout
  /** The bubble's corner (corner parts), or the large camera's. */
  corner?: Corner
  /** Output seconds (what the viewer sees). */
  outStart: number
  outEnd: number
  /** Source seconds, from its first written segment's start to its last one's end. */
  start: number
  end: number
  /** Ids of the segments written for it (more than one when a camera position of the user's cuts it). */
  ids: string[]
  reason: DirectorReason
}

/** What the panel says about a plan. */
export type DirectorNote =
  /** The camera is hidden (webcam.show false): nothing to direct. */
  | 'camera-hidden'
  /** No speech is known (no sound recorded, or it could not be measured): no intro, outro or hiding. */
  | 'no-sound'
  /** Sound, but under SPEECH.minTotal of talking: no intro, outro or hiding. */
  | 'no-speech'
  /** Speech from the mixed track (no microphone stem): sounds from the PC count as talking. */
  | 'mixed-sound'
  /** The transcript's word timings decided or refined the speech. */
  | 'transcript'
  /** No mouse or keyboard data (cursor.valid false): no corner moves; the demo is found from zooms only. */
  | 'no-input'
  /** Nothing deliberate happens (no input, no zooms): no intro or outro. */
  | 'no-demo'
  /** The user's camera positions are kept (and the bubble is not moved elsewhere: corners 'keep'). */
  | 'kept-positions'
  /** The user's own layout changes cover nearly all the video (95% or more). */
  | 'all-yours'
  /** Nothing to change. */
  | 'nothing'

/** A stretch of the output timeline by what it shows, for the panel's plan strip. */
export interface DirectorStripItem {
  /** Output seconds. */
  start: number
  end: number
  /** 'yours': a segment the user placed (a layout change, or a camera position). */
  state: 'intro' | 'outro' | 'hidden' | 'bubble' | 'yours'
  /** The bubble's corner ('bubble'). */
  corner?: Corner
}

/** A plan of the director: what applying it writes, and what the panel shows about it. */
export interface DirectorPlan {
  /** The complete new list of layout segments: the user's (camera positions cut where needed) and the director's, sorted, ids kept where unchanged. */
  layouts: LayoutSegment[]
  /** The director's changes, in time order. */
  parts: DirectorPart[]
  /** The options it was made with (resolved, as directorSettingsOf gives them). */
  settings: DirectorSettings
  /** The user's segments kept as they are: layout changes, and camera positions. */
  kept: { changes: number; positions: number }
  notes: DirectorNote[]
  /** Against the director's segments in the project now (by layout, corner, marks and times). */
  diff: { added: number; removed: number; unchanged: number }
  /** Applying would change no segment (the framing aside). */
  upToDate: boolean
  /** Share (0..1) of the output with the camera visible. */
  cameraShare: number
  /** Highest zoom face framing may use: FACE.largeCameraZoom when the result shows the camera large (camera only, large camera, side by side), else FACE.maxZoom. */
  framingCap: number
  /** Source ranges where the result shows the camera (faces are sampled there: faceSampleTimes). */
  cameraShown: Range[]
  /** The whole output timeline by state. */
  strip: DirectorStripItem[]
}

/**
 * The plan for `input` with `settings` (directorSettingsOf). Pure and deterministic: the same
 * project, cursor, speech and settings give the same plan, ids included (a segment equal to one
 * in the project keeps its id). Lengths are planned in output seconds; segments are written in
 * source seconds. With the camera hidden or no webcam, an empty plan with 'camera-hidden'.
 */
export function planDirector(input: DirectorInput, settings: DirectorSettings): DirectorPlan {
  // Stub of the contract: an empty plan (nothing to change), so the UI can be built against it.
  const layouts = input.project.layouts ?? []
  return {
    layouts,
    parts: [],
    settings,
    kept: { changes: 0, positions: 0 },
    notes: ['nothing'],
    diff: { added: 0, removed: 0, unchanged: layouts.filter((s) => s.auto).length },
    upToDate: true,
    cameraShare: 1,
    framingCap: FACE.maxZoom,
    cameraShown: [],
    strip: []
  }
}

/**
 * `layouts` without the director's segments: every `auto` segment dropped, and each run of a
 * camera position's pieces and the director's cut-outs (touching, same corner) joined back into
 * one corner-only segment, with the id of its first piece of the user's (else of its first
 * cut-out, which the director gave the position's id when it covered it whole). The exact inverse
 * of what planDirector writes: withoutDirected(plan.layouts) equals the base it planned on.
 */
export function withoutDirected(layouts: readonly LayoutSegment[] | undefined): LayoutSegment[] {
  return notImplemented(layouts)
}

/** A layout the director writes over a source range (before it is cut into camera positions). */
export interface DirectedRun {
  start: number
  end: number
  layout: CameraLayout
  corner?: Corner
}

/**
 * `runs` (source seconds, sorted, not overlapping the user's layout changes) written over `base`
 * (no director's segments): in free time each becomes an `auto` segment; inside a camera position
 * P it is cut out of P ({ auto, cutOut, corner: P.corner }), and P keeps the pieces before and
 * after (a piece shorter than LAYOUT_TRANSITION before, or 2 * LAYOUT_TRANSITION after, joins the
 * cut-out, as layoutInStay does). P's id stays on its first remaining piece, else on its first
 * cut-out; other pieces get new ids. Touching auto segments alike are joined. Sorted.
 */
export function spliceDirected(base: readonly LayoutSegment[], runs: readonly DirectedRun[], newId: () => string): LayoutSegment[] {
  return notImplemented(base, runs, newId)
}

/**
 * The project with `plan` applied, as one edit: its layouts; Project.director = plan.settings
 * with `framed`; and, for a 'framed' outcome while the director may frame (the option on), the
 * webcam's zoom, cropX and cropY (unless within FACE.nearZoom / nearCrop of the current ones).
 * `framed` is the framing written now, else kept only while the webcam still shows it. Returns
 * `project` itself when nothing changes, so store.update adds no undo step.
 */
export function applyDirectorPlan(project: Project, plan: DirectorPlan, framing: FramingOutcome): Project {
  return notImplemented(project, plan, framing)
}

/**
 * "Remove automatic changes": the project without the director's segments (withoutDirected), its
 * framing reset (zoom, cropX, cropY removed) only while it is still the director's, and
 * `director.framed` dropped (the options stay). `project` itself when there is nothing to remove.
 */
export function clearDirected(project: Project): Project {
  return notImplemented(project)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
