/**
 * The copy pack's items for this session (docs/design/publish-pack.md §2.7, §4.6): what each card
 * shows, kept per project until the app quits, and the runner that writes them, at most two
 * requests at a time, each one stoppable. Answers are cleaned again here before they are shown.
 */
import { useSyncExternalStore } from 'react'
import type { AiTextRequest, AiTextResult } from '../../../shared/api/ai'
import { PUBLISH_KINDS, taskOfKind, type PublishKind, type PublishLength, type PublishTone } from '../../../shared/publish/pack'
import { CancelledError, createQueue } from '../../../shared/publish/queue'
import { plainText } from '../../../shared/publish/text'
import { tagsText } from '../../../shared/publish/youtube'
import type { CaptionSegment } from '../../../shared/types'
import { ipcMessage } from '../editor/captionItems'

export type ItemStatus = 'idle' | 'waiting' | 'writing' | 'done' | 'error'

export interface PackItem {
  status: ItemStatus
  /** The text shown and copied (the user may edit it). Empty until written. */
  text: string
  /** The YouTube tags as edited text ("a, b, c"). */
  tags: string
  /** Why the last run failed (status 'error'). */
  error: string | null
  /** The captions' fingerprint (transcriptKey) the text was written from. */
  writtenFrom: string | null
}

export type PackItems = Readonly<Record<PublishKind, PackItem>>

const EMPTY: PackItem = { status: 'idle', text: '', tags: '', error: null, writtenFrom: null }
const emptyItems = (): PackItems => Object.fromEntries(PUBLISH_KINDS.map((k) => [k, EMPTY])) as unknown as PackItems

/** Longest text kept in a card (the provider's caps are lower; edits can add a little). */
const MAX_CARD_TEXT = 25_000

const sessions = new Map<string, PackItems>()
const listeners = new Set<() => void>()

export function packItems(projectId: string): PackItems {
  let s = sessions.get(projectId)
  if (!s) {
    s = emptyItems()
    sessions.set(projectId, s)
  }
  return s
}

function patch(projectId: string, kind: PublishKind, change: Partial<PackItem>): void {
  const items = packItems(projectId)
  sessions.set(projectId, { ...items, [kind]: { ...items[kind], ...change } })
  for (const l of [...listeners]) l()
}

/** The user's edit of a card's text or tags. */
export function editItem(projectId: string, kind: PublishKind, change: Partial<Pick<PackItem, 'text' | 'tags'>>): void {
  patch(projectId, kind, change)
}

export function usePackItems(projectId: string): PackItems {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => packItems(projectId)
  )
}

/* ---------- writing ---------- */

/** What a run sends besides the item: the provider, the captions and the choices. */
export interface WriteContext {
  providerId: string
  segments: CaptionSegment[]
  tone: PublishTone
  length: PublishLength
  context?: { title?: string; chapters?: string[] }
  /** transcriptKey(segments). */
  key: string
}

/** Text requests go out two at a time (§2.1). */
const queue = createQueue(2)
let seq = 0
/** The job of each item now: a stopped or replaced job's late answer is dropped. */
const current = new Map<string, string>()
const slot = (projectId: string, kind: PublishKind): string => `${projectId}\u0000${kind}`

/** The text a card shows for `result`, cleaned again (the user's own links are kept from here on). */
export function cardText(result: AiTextResult): { text: string; tags: string } {
  const keep = { keepLinks: true }
  switch (result.task) {
    case 'title':
      return { text: plainText(result.text, { ...keep, max: 150, oneLine: true }), tags: '' }
    case 'youtube':
      return { text: plainText(result.text, { ...keep, max: MAX_CARD_TEXT }), tags: tagsText(result.tags.map((t) => plainText(t, { ...keep, max: 30, oneLine: true })).filter(Boolean)) }
    case 'summary':
    case 'linkedin':
    case 'xpost':
    case 'article':
    case 'releaseNotes':
      return { text: plainText(result.text, { ...keep, max: MAX_CARD_TEXT }), tags: '' }
    default:
      return { text: '', tags: '' }
  }
}

/** Writes item `kind` (stopping a run of it already queued or running). */
export function writeItem(projectId: string, kind: PublishKind, ctx: WriteContext): Promise<void> {
  const id = `pub-${++seq}`
  const key = slot(projectId, kind)
  const before = current.get(key)
  if (before) queue.cancel(before)
  current.set(key, id)
  const mine = (): boolean => current.get(key) === id
  const had = packItems(projectId)[kind]
  patch(projectId, kind, { status: 'waiting', error: null })
  const task = taskOfKind(kind)
  const request: AiTextRequest = { task, segments: ctx.segments }
  if (task !== 'title' && task !== 'summary') {
    request.tone = ctx.tone
    request.length = ctx.length
    if (ctx.context) request.context = ctx.context
  }
  return queue
    .add({
      id,
      run: (signal) => {
        if (mine()) patch(projectId, kind, { status: 'writing' })
        signal.addEventListener('abort', () => void window.api.cancelAiText(id).catch(() => undefined))
        return window.api.aiText(ctx.providerId, request, id)
      }
    })
    .then(
      (result) => {
        if (!mine()) return
        current.delete(key)
        if (!result || typeof result !== 'object' || result.task !== task) {
          patch(projectId, kind, { status: 'error', error: 'The provider answered something else; try again.' })
          return
        }
        const { text, tags } = cardText(result)
        if (!text) {
          patch(projectId, kind, { status: 'error', error: 'The provider wrote nothing; try again.' })
          return
        }
        patch(projectId, kind, { status: 'done', text, tags, error: null, writtenFrom: ctx.key })
      },
      (err: unknown) => {
        if (!mine()) return
        current.delete(key)
        // Stopped: back to what the card had.
        if (err instanceof CancelledError) patch(projectId, kind, { status: had.text ? 'done' : 'idle', error: null })
        else patch(projectId, kind, { status: 'error', error: ipcMessage(err) })
      }
    )
}

/** Stops item `kind` of `projectId`, waiting or running. */
export function stopItem(projectId: string, kind: PublishKind): void {
  const id = current.get(slot(projectId, kind))
  if (id) queue.cancel(id)
}

/** Stops every item of `projectId`. */
export function stopAll(projectId: string): void {
  for (const kind of PUBLISH_KINDS) stopItem(projectId, kind)
}

/** Whether `status` is a run in progress. */
export const isRunning = (status: ItemStatus): boolean => status === 'waiting' || status === 'writing'
