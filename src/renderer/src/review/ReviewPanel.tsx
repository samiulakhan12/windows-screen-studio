/**
 * Review mode's panel (E-02, docs/design/review-mode.md §4.3, §5): every automatic change in time
 * order, Keep or Remove each one (one undo step each), Keep all and Remove all of a kind (one
 * step each). Choosing an item jumps the preview there and plays a short stretch around it.
 * Statuses are read from the project (shared/review/review.ts), so undo shows right away.
 *
 * Not modal: the preview stays in view and the editor's shortcuts keep working, except the keys
 * the list uses while the focus is in it (N/P/arrows, Home/End, K, Delete), which it keeps.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { planOf, videoTimeAt } from '../../../shared/engine/freeze'
import { formatTime } from '../../../shared/engine/project'
import {
  actedMessage,
  bulkMessage,
  itemAccessibleName,
  KIND_WORDS,
  progressText,
  REVIEW_EMPTY,
  REVIEW_HINT,
  REVIEW_TITLE
} from '../../../shared/review/copy'
import { previewStretch } from '../../../shared/review/preview'
import { keepItems, mergeSnapshot, removeItems, reviewItems, reviewProgress, reviewStatus, type ReviewItem, type ReviewStatus } from '../../../shared/review/review'
import { useEditor } from '../editor/context'
import { playStretch } from './playStretch'
import './review.css'

export function ReviewPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { store, player } = useEditor()
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // What the panel has shown: reviewed items stay in the list, marked, until it closes.
  const [shown, setShown] = useState<ReviewItem[]>(() => reviewItems(store.state))
  const list = useMemo(() => mergeSnapshot(shown, reviewItems(project)), [shown, project])
  useEffect(() => {
    if (list.length !== shown.length) setShown(list)
  }, [list, shown.length])
  const statuses = useMemo(() => list.map((i) => reviewStatus(project, i)), [list, project])
  const { reviewed, total } = reviewProgress(statuses)
  const plan = planOf(project)

  const [activeKey, setActiveKey] = useState<string | null>(() => list.find((_, i) => statuses[i] === 'pending')?.key ?? list[0]?.key ?? null)
  const active = Math.max(0, list.findIndex((i) => i.key === activeKey))
  const [said, setSaid] = useState('')
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const closeRef = useRef<HTMLButtonElement>(null)
  const stopRef = useRef<(() => void) | null>(null)

  const stopStretch = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
  }, [])
  useEffect(() => stopStretch, [stopStretch])

  // The focus starts on the first item to review (else the first, else Close).
  useEffect(() => {
    const first = activeKey ? rows.current.get(activeKey) : null
    ;(first ?? closeRef.current)?.focus()
    // Only when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const focusKey = (key: string): void => {
    setActiveKey(key)
    rows.current.get(key)?.focus()
  }

  /** Jumps the preview to the item and plays a short stretch around it. */
  const play = (item: ReviewItem): void => {
    stopStretch()
    const p = store.state
    stopRef.current = playStretch(player, () => store.state.clips, previewStretch(p.clips, item.start, item.end))
  }

  const choose = (item: ReviewItem): void => {
    focusKey(item.key)
    play(item)
  }

  const move = (to: number): void => {
    if (list.length === 0) return
    const i = Math.max(0, Math.min(list.length - 1, to))
    choose(list[i])
  }

  /** The next item still to review after `index` (wrapping), else the same one. */
  const nextPending = (after: readonly ReviewStatus[], index: number): string | null => {
    for (let k = 1; k <= list.length; k++) {
      const j = (index + k) % list.length
      if (after[j] === 'pending') return list[j].key
    }
    return list[index]?.key ?? null
  }

  const act = (item: ReviewItem, action: 'keep' | 'remove'): void => {
    const index = list.indexOf(item)
    if (index < 0 || reviewStatus(store.state, item) !== 'pending') return
    stopStretch()
    store.update((p) => (action === 'keep' ? keepItems(p, [item]) : removeItems(p, [item])))
    const after = list.map((i) => reviewStatus(store.state, i))
    const done = reviewProgress(after)
    setSaid(actedMessage(action, done.reviewed, done.total))
    const next = nextPending(after, index)
    if (next) focusKey(next)
  }

  const keepAll = (): void => {
    const count = statuses.filter((s) => s === 'pending').length
    if (count === 0) return
    stopStretch()
    store.update((p) => keepItems(p, list))
    setSaid(bulkMessage('keep', count))
  }

  const current = list[active]
  const kindPending = current ? list.filter((i, k) => i.kind === current.kind && statuses[k] === 'pending') : []
  const removeKind = (): void => {
    if (!current || kindPending.length === 0) return
    stopStretch()
    store.update((p) => removeItems(p, kindPending))
    setSaid(bulkMessage('remove', kindPending.length, current.kind))
    const after = list.map((i) => reviewStatus(store.state, i))
    const next = nextPending(after, active)
    if (next) focusKey(next)
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const key = e.key
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (key === 'ArrowDown' || key === 'n' || key === 'N') {
      handled()
      if (!e.repeat || key === 'ArrowDown') move(active + 1)
    } else if (key === 'ArrowUp' || key === 'p' || key === 'P') {
      handled()
      if (!e.repeat || key === 'ArrowUp') move(active - 1)
    } else if (key === 'Home') {
      handled()
      move(0)
    } else if (key === 'End') {
      handled()
      move(list.length - 1)
    } else if (key === 'k' || key === 'K') {
      handled()
      if (current && !e.repeat) act(current, 'keep')
    } else if (key === 'Delete' || key === 'Backspace') {
      handled()
      if (current && !e.repeat) act(current, 'remove')
    }
  }

  const onPanelKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      stopStretch()
      onClose()
      return
    }
    // Enter and Space press the focused button here (the editor would play or pause instead).
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement) e.stopPropagation()
  }

  const timeOf = (item: ReviewItem): string => formatTime(videoTimeAt(project.clips, plan, item.start))

  return (
    <aside className="review-panel" role="region" aria-label={REVIEW_TITLE} data-testid="review-panel" onKeyDown={onPanelKey}>
      <div className="review-head">
        <h2>{REVIEW_TITLE}</h2>
        <button
          ref={closeRef}
          className="btn ghost icon-btn"
          title="Close review"
          aria-label="Close review"
          onClick={() => {
            stopStretch()
            onClose()
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {total > 0 && (
        <div className="review-progress">
          <span data-testid="review-progress">{progressText(reviewed, total)}</span>
          <div className="review-bar" role="progressbar" aria-label="Reviewed" aria-valuemin={0} aria-valuemax={total} aria-valuenow={reviewed}>
            <div style={{ width: `${(reviewed / total) * 100}%` }} />
          </div>
        </div>
      )}
      {total === 0 ? (
        <p className="review-empty">{REVIEW_EMPTY}</p>
      ) : (
        <>
          <p className="review-hint">{REVIEW_HINT}</p>
          <ul className="review-list" aria-label="Automatic changes" onKeyDown={onListKey}>
            {list.map((item, k) => {
              const status = statuses[k]
              const isActive = k === active
              const time = timeOf(item)
              return (
                <li key={item.key} className={`review-row ${status}${isActive ? ' active' : ''}`} data-testid="review-row" data-key={item.key} data-status={status}>
                  <button
                    ref={(el) => {
                      if (el) rows.current.set(item.key, el)
                      else rows.current.delete(item.key)
                    }}
                    className="review-item"
                    tabIndex={isActive ? 0 : -1}
                    aria-current={isActive ? 'true' : undefined}
                    aria-label={itemAccessibleName(item, time, status)}
                    onClick={() => choose(item)}
                    onFocus={() => setActiveKey(item.key)}
                  >
                    <span className={`review-chip kind-${item.kind}`} aria-hidden="true">
                      {KIND_WORDS[item.kind].chip}
                    </span>
                    <span className="review-text" aria-hidden="true">
                      <span className="review-title">{item.title}</span>
                      <span className="review-meta">
                        {item.detail} · {time}
                      </span>
                    </span>
                  </button>
                  {status === 'pending' ? (
                    <span className="review-actions">
                      <button className="btn" tabIndex={isActive ? 0 : -1} aria-label={`Keep: ${item.title}`} data-testid="review-keep" onClick={() => act(item, 'keep')}>
                        Keep
                      </button>
                      <button className="btn" tabIndex={isActive ? 0 : -1} aria-label={`Remove: ${item.title}`} data-testid="review-remove" onClick={() => act(item, 'remove')}>
                        Remove
                      </button>
                    </span>
                  ) : (
                    <span className={`review-mark ${status}`}>
                      {status === 'kept' && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M5 12l5 5 9-10" />
                        </svg>
                      )}
                      {status === 'kept' ? 'Kept' : 'Removed'}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="review-foot">
            <button className="btn" data-testid="review-keep-all" disabled={reviewed === total} onClick={keepAll}>
              Keep all
            </button>
            <button className="btn" data-testid="review-remove-kind" disabled={kindPending.length === 0} onClick={removeKind}>
              {current ? KIND_WORDS[current.kind].all : 'Remove all'}
            </button>
          </div>
        </>
      )}
      <div className="sr-only" role="status" aria-live="polite" data-testid="review-said">
        {said}
      </div>
    </aside>
  )
}
