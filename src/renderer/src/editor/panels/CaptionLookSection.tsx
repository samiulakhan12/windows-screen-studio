/**
 * Captions › Look (docs/design/captions-studio.md §2.4–2.7): Make my captions great, the gallery,
 * the name line, Save as my style and the Text, Colours, Layout, Motion, Emphasis and Speakers
 * sections.
 *
 * CONTRACT (part P3): the signature is frozen; the body is to be written.
 */
import type { Project } from '../../../../shared/types'

/** The body of a frozen signature part P3 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P3)`)
}

export function CaptionLookSection(props: { project: Project; vw: number; vh: number; onGreat(): void; greatBusy: boolean; onGreatCancel(): void }): JSX.Element {
  return notImplemented('CaptionLookSection', props)
}
