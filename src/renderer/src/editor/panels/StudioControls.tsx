/**
 * Look › Text, Colours, Layout, Motion, Emphasis and Speakers (docs/design/captions-studio.md
 * §2.6, §2.7). Every change is one undo step and sets `picked`; the first on a legacy look makes
 * its Studio twin in the same step.
 *
 * CONTRACT (part P3): signatures are frozen; bodies are to be written.
 */
import type { Project } from '../../../../shared/types'

/** The body of a frozen signature part P3 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P3)`)
}

export function TextControls(props: { project: Project }): JSX.Element {
  return notImplemented('TextControls', props)
}

export function ColourControls(props: { project: Project }): JSX.Element {
  return notImplemented('ColourControls', props)
}

export function LayoutControls(props: { project: Project }): JSX.Element {
  return notImplemented('LayoutControls', props)
}

export function MotionControls(props: { project: Project }): JSX.Element {
  return notImplemented('MotionControls', props)
}

export function EmphasisControls(props: { project: Project }): JSX.Element {
  return notImplemented('EmphasisControls', props)
}

/** With NW-09's ShowSpeakerToggle. */
export function SpeakerControls(props: { project: Project }): JSX.Element {
  return notImplemented('SpeakerControls', props)
}
