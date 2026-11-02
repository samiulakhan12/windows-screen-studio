/**
 * What the copy pack keeps in project.json (docs/design/publish-pack.md §3): the YouTube description's
 * text saved with "Use for exports". Read when a project opens; absent stays absent.
 */
import type { ProjectPublish } from '../types'
import { descriptionBody } from './youtube'

/** `raw` as a ProjectPublish: a non-empty description as the dialog saves it (descriptionBody); else undefined. */
export function readPublish(raw: unknown): ProjectPublish | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const description = descriptionBody((raw as Record<string, unknown>).description)
  return description ? { description } : undefined
}
