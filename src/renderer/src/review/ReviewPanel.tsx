/**
 * Review mode's panel (E-02, docs/design/review-mode.md §4.3, §5): every automatic change in time
 * order, Keep or Remove each one (one undo step each), Keep all and Remove all of a kind (one
 * step each). Choosing an item jumps the preview there and plays a short stretch around it.
 * Statuses are read from the project (shared/review/review.ts), so undo shows right away.
 *
 * Not modal: the preview stays in view and the editor's shortcuts keep working, except the keys
 * the list uses while the focus is in it (N/P/arrows, Home/End, K, Delete), which it keeps.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { shortcutIndex } from '../../../shared/editor/shortcuts'
import { planOf } from '../../../shared/engine/freeze'
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
import { listKey } from '../../../shared/review/keys'
import { previewStretch } from '../../../shared/review/preview'
import {
  keepItems,
  mergeSnapshot,
  removeItems,
  reviewItems,
  reviewProgress,
  reviewStatus,
  type ReviewItem,
  type ReviewKind,
  type ReviewStatus
} from '../../../shared/review/review'
import { rowTimes } from '../../../shared/review/times'
import { useEditor } from '../editor/context'
import { useKeymap } from '../editor/keymapContext'
import { playStretch } from './playStretch'
import './review.css'

export function ReviewPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const shortcuts = useMemo(() => shortcutIndex(keymap), [keymap])
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // What the panel has shown (and the state it was last merged with): reviewed items stay in the
  // list, marked, until it closes. It follows every state the store takes, in turn (two edits
  // before one render too), so a row whose record goes with no choice made keeps how it read in the
  // first state without it (mergeSnapshot).
  const [shown, setShown] = useState(() => ({ at: store.state, list: reviewItems(store.state) }))
  useEffect(() => {
    const follow = (): void => {
      const p = store.state
      setShown((s) => (s.at === p ? s : { at: p, list: mergeSnapshot(s.list, p) }))
    }
    follow()
    return store.subscribe(follow)
  }, [store])
  const list = useMemo(() => (shown.at === project ? shown.list : mergeSnapshot(shown.list, project)), [shown, project])
  const statuses = useMemo(() => list.map((i) => reviewStatus(project, i)), [list, project])
  const { reviewed, total } = useMemo(() => reviewProgress(statuses), [statuses])
  /** Where each row is in the list, by key. */
  const indexOf = useMemo(() => new Map(list.map((i, k) => [i.key, k])), [list])
  const plan = planOf(project)
  // Every row's time, in one pass over the clips, kept for the same clips and plan (times.ts).
  const times = useMemo(() => rowTimes(list, project.clips, plan), [list, project.clips, plan])

  const [activeKey, setActiveKey] = useState<string | null>(() => list.find((_, i) => statuses[i] === 'pending')?.key ?? list[0]?.key ?? null)
  const active = (activeKey !== null ? indexOf.get(activeKey) : undefined) ?? 0
  // What the live region says. Each message is a new node, so the same words twice (Keep, Ctrl+Z,
  // Keep) are read out twice.
  const [said, setSaid] = useState({ text: '', n: 0 })
  const say = (text: string): void => setSaid((s) => ({ text, n: s.n + 1 }))
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const stopRef = useRef<(() => void) | null>(null)

  // Undo and redo (the editor's Ctrl+Z, Ctrl+Y) can take a row in or out of review under the focus:
  // its Keep and Remove buttons go, or a footer button turns disabled, and the focus would drop to
  // the page, taking the panel's keys (Escape, N, K, Delete) with it. When the focus was in the
  // panel as the project changed and is on the page once the change is shown, or still on a button
  // the change disabled (Chromium drops it from there only at its next rendering update, after
  // this), it goes back to the focused item's row (else Close). Keep, Remove and the footer move it
  // first themselves.
  const focusWasIn = useRef(false)
  useEffect(
    () =>
      store.subscribe(() => {
        focusWasIn.current ||= !!panelRef.current?.contains(document.activeElement)
      }),
    [store]
  )

  const stopStretch = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
  }, [])
  useEffect(() => stopStretch, [stopStretch])

  // The Inspector under the panel is out of reach while it is open (Tab never lands on hidden controls).
  useEffect(() => {
    const under = document.querySelector('.editor-body > .inspector')
    if (!under || under.hasAttribute('inert')) return
    under.setAttribute('inert', '')
    return () => under.removeAttribute('inert')
  }, [])

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
    // A click hands the focus back to the editor once released (focus.ts installFocusRelease); the
    // list's keys need it on the row, so it comes back after that.
    window.setTimeout(() => {
      const el = document.activeElement
      if (!el || el === document.body) rows.current.get(item.key)?.focus()
    }, 0)
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
    const index = indexOf.get(item.key) ?? -1
    if (index < 0 || reviewStatus(store.state, item) !== 'pending') return
    stopStretch()
    store.update((p) => (action === 'keep' ? keepItems(p, [item]) : removeItems(p, [item])))
    const after = list.map((i) => reviewStatus(store.state, i))
    const done = reviewProgress(after)
    say(actedMessage(action, done.reviewed, done.total))
    const next = nextPending(after, index)
    if (next) focusKey(next)
  }

  const keepAll = (): void => {
    const count = statuses.filter((s) => s === 'pending').length
    if (count === 0) return
    stopStretch()
    store.update((p) => keepItems(p, list))
    say(bulkMessage('keep', count))
    // Keep all turns disabled under the focus, which would drop to the page (Esc and the list's
    // keys would then miss the panel): the focus goes back to the row.
    focusKey(list[active].key)
  }

  useLayoutEffect(() => {
    if (!focusWasIn.current) return
    focusWasIn.current = false
    const el = document.activeElement
    if (el && el !== document.body && !(el instanceof HTMLButtonElement && el.disabled)) return
    ;((list[active] && rows.current.get(list[active].key)) || closeRef.current)?.focus()
  })

  const current = list[active]
  const kind = current?.kind
  const kindPending = useMemo(() => (kind ? list.filter((i, k) => i.kind === kind && statuses[k] === 'pending') : []), [list, statuses, kind])
  const removeKind = (): void => {
    if (!current || kindPending.length === 0) return
    stopStretch()
    store.update((p) => removeItems(p, kindPending))
    say(bulkMessage('remove', kindPending.length, current.kind))
    const after = list.map((i) => reviewStatus(store.state, i))
    const next = nextPending(after, active)
    if (next) focusKey(next)
  }

  // The rows' handlers stay the same function from render to render, so a row draws again only
  // when what it shows changes (N redraws the two rows whose focus moved, not the whole list).
  const latest = useRef({ choose, act, list, indexOf })
  latest.current = { choose, act, list, indexOf }
  const onRowChoose = useCallback((key: string) => {
    const { list, indexOf, choose } = latest.current
    const k = indexOf.get(key)
    if (k !== undefined) choose(list[k])
  }, [])
  const onRowAct = useCallback((key: string, action: 'keep' | 'remove') => {
    const { list, indexOf, act } = latest.current
    const k = indexOf.get(key)
    if (k !== undefined) act(list[k], action)
  }, [])
  const setRow = useCallback((key: string, el: HTMLButtonElement | null) => {
    if (el) rows.current.set(key, el)
    else rows.current.delete(key)
  }, [])

  const onListKey = (e: React.KeyboardEvent): void => {
    const key = listKey(e, shortcuts)
    if (!key) return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat && !key.again) return
    if (key.action === 'next') move(active + 1)
    else if (key.action === 'previous') move(active - 1)
    else if (key.action === 'first') move(0)
    else if (key.action === 'last') move(list.length - 1)
    else if (current) act(current, key.action)
  }

  const onPanelKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      stopStretch()
      onClose()
      return
    }
    // Space on an item stops what is playing (§4.3), else chooses the item. Its own press on key up
    // is held back: it would start the stretch over again.
    if (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && e.target instanceof HTMLElement && e.target.classList.contains('review-item')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (player.moving) {
        stopStretch()
        player.pause()
      } else if (current) choose(current)
      return
    }
    // Enter and Space press the focused button here (the editor would play or pause instead).
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement) e.stopPropagation()
  }

  return (
    <aside ref={panelRef} className="review-panel" role="region" aria-label={REVIEW_TITLE} data-testid="review-panel" onKeyDown={onPanelKey}>
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
            {list.map((item, k) => (
              <ReviewRow
                key={item.key}
                itemKey={item.key}
                kind={item.kind}
                title={item.title}
                detail={item.detail}
                time={times[k]}
                status={statuses[k]}
                isActive={k === active}
                onChoose={onRowChoose}
                onAct={onRowAct}
                onFocusRow={setActiveKey}
                setRef={setRow}
              />
            ))}
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
        <span key={said.n}>{said.text}</span>
      </div>
    </aside>
  )
}

interface RowProps {
  itemKey: string
  kind: ReviewKind
  title: string
  detail: string
  time: string
  status: ReviewStatus
  isActive: boolean
  onChoose: (key: string) => void
  onAct: (key: string, action: 'keep' | 'remove') => void
  onFocusRow: (key: string) => void
  setRef: (key: string, el: HTMLButtonElement | null) => void
}

/** One row: drawn again only when what it shows changes (its props are values and stable handlers). */
const ReviewRow = memo(function ReviewRow({ itemKey, kind, title, detail, time, status, isActive, onChoose, onAct, onFocusRow, setRef }: RowProps): JSX.Element {
  const ref = useCallback((el: HTMLButtonElement | null) => setRef(itemKey, el), [setRef, itemKey])
  return (
    <li className={`review-row ${status}${isActive ? ' active' : ''}`} data-testid="review-row" data-key={itemKey} data-status={status}>
      <button
        ref={ref}
        className="review-item"
        tabIndex={isActive ? 0 : -1}
        aria-current={isActive ? 'true' : undefined}
        aria-label={itemAccessibleName({ title, kind, detail }, time, status)}
        onClick={() => onChoose(itemKey)}
        onFocus={() => onFocusRow(itemKey)}
      >
        <span className={`review-chip kind-${kind}`} aria-hidden="true">
          {KIND_WORDS[kind].chip}
        </span>
        <span className="review-text" aria-hidden="true">
          <span className="review-title">{title}</span>
          <span className="review-meta">
            {time} · {detail}
          </span>
        </span>
      </button>
      {status === 'pending' ? (
        <span className="review-actions">
          <button className="btn" tabIndex={isActive ? 0 : -1} aria-label={`Keep: ${title}`} data-testid="review-keep" onClick={() => onAct(itemKey, 'keep')}>
            Keep
          </button>
          <button className="btn" tabIndex={isActive ? 0 : -1} aria-label={`Remove: ${title}`} data-testid="review-remove" onClick={() => onAct(itemKey, 'remove')}>
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
})
