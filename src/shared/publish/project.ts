/**
 * What the copy pack keeps in project.json (docs/design/publish-pack.md §3): the YouTube description's
 * text saved with "Use for exports". Read when a project opens; absent stays absent.
 */
import type { ProjectPublish } from '../types'
import { plainText } from './text'
import { PACK_CAPS } from './prompts'

/** `raw` as a ProjectPublish: a cleaned, non-empty description of at most 3 000 characters; else undefined. */
export function readPublish(raw: unknown): ProjectPublish | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const description = plainText((raw as Record<string, unknown>).description, { max: PACK_CAPS.youtubeText, keepLinks: true })
  return description ? { description } : undefined
}
