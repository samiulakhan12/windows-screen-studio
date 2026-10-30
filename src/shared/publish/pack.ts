/**
 * The publishing copy pack (NW-13, docs/design/publish-pack.md): its items, the tone and length
 * that apply to all of them, the remembered choices, and when there is nothing to write from. Pure.
 */
import type { AiTextTask, PackTextTask } from '../api/ai'
import type { CaptionSegment, Project } from '../types'

/** The pack's items, in the order of the dialog's cards. Title and summary are the Captions tab's tasks. */
export type PublishKind = 'youtube' | 'linkedin' | 'xpost' | 'article' | 'releaseNotes' | 'title' | 'summary'

export const PUBLISH_KINDS: readonly PublishKind[] = ['youtube', 'linkedin', 'xpost', 'article', 'releaseNotes', 'title', 'summary']

/** The pack's own text tasks (the others reuse title and summary). */
export const PACK_TASKS: readonly PackTextTask[] = ['youtube', 'linkedin', 'xpost', 'article', 'releaseNotes']

export const isPackTask = (task: AiTextTask): task is PackTextTask => (PACK_TASKS as readonly string[]).includes(task)

/** The text task that writes item `kind` (the same id). */
export const taskOfKind = (kind: PublishKind): AiTextTask => kind

export const PUBLISH_LABELS: Record<PublishKind, string> = {
  youtube: 'YouTube description',
  linkedin: 'LinkedIn post',
  xpost: 'X post',
  article: 'Help-centre article',
  releaseNotes: 'Release notes',
  title: 'Title',
  summary: 'Summary'
}

export type PublishTone = 'friendly' | 'professional' | 'casual'
export type PublishLength = 'short' | 'normal'

export const PUBLISH_TONES: readonly { value: PublishTone; label: string }[] = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'professional', label: 'Professional' },
  { value: 'casual', label: 'Casual' }
]

export const PUBLISH_LENGTHS: readonly { value: PublishLength; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'normal', label: 'Normal' }
]

export const isTone = (v: unknown): v is PublishTone => PUBLISH_TONES.some((t) => t.value === v)
export const isLength = (v: unknown): v is PublishLength => PUBLISH_LENGTHS.some((l) => l.value === v)

/** The dialog's remembered choices (localStorage). */
export interface PublishPrefs {
  tone: PublishTone
  length: PublishLength
  /** The AI provider's id ('' = the first one). */
  provider: string
}

export const DEFAULT_PUBLISH_PREFS: PublishPrefs = { tone: 'friendly', length: 'normal', provider: '' }

/** Stored choices with anything unknown back to its default. */
export function readPublishPrefs(raw: unknown): PublishPrefs {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return {
    tone: isTone(r.tone) ? r.tone : DEFAULT_PUBLISH_PREFS.tone,
    length: isLength(r.length) ? r.length : DEFAULT_PUBLISH_PREFS.length,
    provider: typeof r.provider === 'string' && r.provider.length <= 200 ? r.provider : ''
  }
}

/** Fewest spoken words the pack writes from. */
export const PACK_MIN_WORDS = 8

/** Words in the captions. */
export function spokenWords(segments: readonly Pick<CaptionSegment, 'text'>[]): number {
  let n = 0
  for (const s of segments) n += s.text.split(/\s+/).filter(Boolean).length
  return n
}

/** Why there is nothing to write from: no sound, no captions yet, or too little speech; null when there is. */
export type PublishBlocker = 'no-sound' | 'no-captions' | 'too-little' | null

export function publishBlocker(project: Pick<Project, 'hasAudio' | 'transcript'>): PublishBlocker {
  const t = project.transcript
  if (!t) return project.hasAudio ? 'no-captions' : 'no-sound'
  return spokenWords(t.segments) < PACK_MIN_WORDS ? 'too-little' : null
}

export const BLOCKER_TEXT: Record<Exclude<PublishBlocker, null>, string> = {
  'no-sound': 'This recording has no sound, so there is nothing to write from.',
  'no-captions': 'No captions yet. The copy is written from what is said, so make the captions first.',
  'too-little': 'There is too little speech in the captions to write from.'
}

/** A short fingerprint of the captions' text: an item written from other captions is out of date. */
export function transcriptKey(segments: readonly Pick<CaptionSegment, 'text'>[]): string {
  let h = 2166136261
  let n = 0
  for (const s of segments) {
    for (let i = 0; i < s.text.length; i++) {
      h ^= s.text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h ^= 10
    h = Math.imul(h, 16777619)
    n++
  }
  return `${n}:${(h >>> 0).toString(36)}`
}
