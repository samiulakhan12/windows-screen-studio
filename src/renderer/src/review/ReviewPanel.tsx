/**
 * Review mode's panel (E-02, docs/design/review-mode.md §4.3, §5): every automatic change in time
 * order, Keep or Remove each one (one undo step each), Keep all and Remove all of a kind (one
 * step each). Choosing an item jumps the preview there and plays a short stretch around it.
 * Statuses are read from the project (shared/review/review.ts), so undo shows right away.
 *
 * Not modal: the preview stays in view and the editor's shortcuts keep working, except the keys
 * the list uses while the focus is in it (N/P/arrows, Home/End, K, Delete), which it keeps.
 *
 * A long recording lists thousands of rows: a list longer than WINDOW_FROM draws only the rows near
 * the visible area, and the focused row (ReviewList), each row saying where it is in the whole list
 * (aria-posinset, aria-setsize); a row draws again only when what it shows changes (ReviewRow).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { shortcutIndex } from '../../../shared/editor/shortcuts'
import { planOf } from '../../../shared/engine/freeze'
import {
  actedMessage,
  bulkMessage,
  BUSY_WORDS,
  busyMessage,
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
  removeSteps,
  reviewItems,
  reviewProgress,
  reviewStatus,
  type ReviewItem,
  type ReviewKind,
  type ReviewStatus
} from '../../../shared/review/review'
import { inSlices } from '../../../shared/review/slices'
import { rowTimes } from '../../../shared/review/times'
import type { Project } from '../../../shared/types'
import { useEditor } from '../editor/context'
import { useKeymap } from '../editor/keymapContext'
import { playStretch } from './playStretch'
import { pageTasks } from './tasks'
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

  // A row of a long list far from the one in view is not drawn yet: it gets the focus once it is
  // (it is drawn as the focused row), and the focus scrolls it into view.
  const focusLater = useRef<string | null>(null)
  const focusKey = (key: string): void => {
    setActiveKey(key)
    const el = rows.current.get(key)
    focusLater.current = el ? null : key
    el?.focus()
  }
  useLayoutEffect(() => {
    const key = focusLater.current
    if (key === null) return
    focusLater.current = null
    if (key === activeKey) rows.current.get(key)?.focus()
  })

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
  const nextPending = (list: readonly ReviewItem[], after: readonly ReviewStatus[], index: number): string | null => {
    for (let k = 1; k <= list.length; k++) {
      const j = (index + k) % list.length
      if (after[j] === 'pending') return list[j].key
    }
    return list[index]?.key ?? null
  }

  const act = (item: ReviewItem, action: 'keep' | 'remove'): void => {
    const index = indexOf.get(item.key) ?? -1
    if (index < 0 || busy || reviewStatus(store.state, item) !== 'pending') return
    stopStretch()
    store.update((p) => (action === 'keep' ? keepItems(p, [item]) : removeItems(p, [item])))
    const after = list.map((i) => reviewStatus(store.state, i))
    const done = reviewProgress(after)
    say(actedMessage(action, done.reviewed, done.total))
    const next = nextPending(list, after, index)
    if (next) focusKey(next)
  }

  // Keep all and Remove all over more than BUSY_FROM rows (§4.3): the button says it is working and
  // the live region what it does, drawn before the work starts; then the work goes a slice of time
  // at a time (Remove all: removeSteps, one cut or speed-up a step), the page drawing in between, and
  // is one edit (one undo step) at the end, made from the project as it is then. Meanwhile the
  // panel's other Keep and Remove wait; closing the panel stops it, and nothing has changed then.
  const [busy, setBusy] = useState<'keep' | 'remove' | null>(null)
  const working = useRef<(() => void) | null>(null)
  useEffect(() => () => working.current?.(), [])

  /**
   * Keep or Remove `count` rows of `list` (of `kind` for Remove all) still to review, then `after`
   * (where the focus goes); the live region says what was done.
   */
  const bulk = (action: 'keep' | 'remove', kind: ReviewKind | undefined, count: number, after: (here: boolean) => void): void => {
    stopStretch()
    const targets = (p: Project): ReviewItem[] => latest.current.list.filter((i) => (!kind || i.kind === kind) && reviewStatus(p, i) === 'pending')
    const apply = (p: Project, items: readonly ReviewItem[]): Project => (action === 'keep' ? keepItems(p, items) : removeItems(p, items))
    if (count <= BUSY_FROM) {
      store.update((p) => apply(p, targets(p)))
      say(bulkMessage(action, count, kind))
      after(true)
      return
    }
    setBusy(action)
    say(busyMessage(action, count, kind))
    working.current = inSlices(
      () => store.state,
      (p) =>
        action === 'remove'
          ? removeSteps(p, targets(p))
          : (function* (): Generator<never, Project, undefined> {
              return keepItems(p, targets(p))
            })(),
      (base, next) => {
        working.current = null
        const done = targets(base).length
        store.update((p) => (p === base ? next : apply(p, targets(p))))
        setBusy(null)
        say(bulkMessage(action, done, kind))
        // The focus moves on only when it is still in the panel (or was dropped to the page).
        const el = document.activeElement
        after(!el || el === document.body || !!panelRef.current?.contains(el))
      },
      pageTasks()
    )
  }

  const keepAll = (): void => {
    const count = statuses.filter((s) => s === 'pending').length
    if (count === 0 || busy) return
    // Keep all turns disabled under the focus, which would drop to the page (Esc and the list's
    // keys would then miss the panel): the focus goes back to the row.
    bulk('keep', undefined, count, (here) => {
      const { list, active } = latest.current
      if (!list[active]) return
      if (here) focusKey(list[active].key)
    })
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
    if (!current || kindPending.length === 0 || busy) return
    bulk('remove', current.kind, kindPending.length, (here) => {
      const { list, active } = latest.current
      const after = list.map((i) => reviewStatus(store.state, i))
      const next = nextPending(list, after, active)
      if (next && here) focusKey(next)
      else if (next) setActiveKey(next)
    })
  }

  // The rows' handlers stay the same function from render to render, so a row draws again only
  // when what it shows changes (N redraws the two rows whose focus moved, not the whole list).
  const latest = useRef({ choose, act, list, indexOf, active })
  latest.current = { choose, act, list, indexOf, active }
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
          <ReviewList
            list={list}
            indexOf={indexOf}
            statuses={statuses}
            times={times}
            active={active}
            onKeyDown={onListKey}
            onChoose={onRowChoose}
            onAct={onRowAct}
            onFocusRow={setActiveKey}
            setRef={setRow}
          />
          <div className="review-foot">
            <button
              className="btn"
              data-testid="review-keep-all"
              disabled={reviewed === total}
              aria-disabled={busy ? 'true' : undefined}
              aria-busy={busy === 'keep' ? 'true' : undefined}
              onClick={keepAll}
            >
              {busy === 'keep' ? BUSY_WORDS.keep : 'Keep all'}
            </button>
            <button
              className="btn"
              data-testid="review-remove-kind"
              disabled={kindPending.length === 0 && busy !== 'remove'}
              aria-disabled={busy ? 'true' : undefined}
              aria-busy={busy === 'remove' ? 'true' : undefined}
              onClick={removeKind}
            >
              {busy === 'remove' ? BUSY_WORDS.remove : current ? KIND_WORDS[current.kind].all : 'Remove all'}
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

/** A list longer than this draws only the rows near the visible area (§4.3). */
const WINDOW_FROM = 200
/** Keep all and Remove all over more rows than this show they are working before the work (§4.3). */
const BUSY_FROM = 200
/** The height of a row not measured yet (px) while none is; then the mean of those measured. */
const ROW_GUESS = 52
/** The space between rows (px), the list's gap. */
const ROW_GAP = 4
/** How far beyond the visible area rows are drawn (px), above and below. */
const OVERSCAN = 360

interface Sizes {
  byKey: Map<string, number>
  sum: number
}

/** Where each row starts (px) in the whole list, and where the list ends (the last entry, plus a gap). */
function placesOf(list: readonly ReviewItem[], sizes: Sizes): Float64Array {
  const guess = sizes.byKey.size > 0 ? sizes.sum / sizes.byKey.size : ROW_GUESS
  const tops = new Float64Array(list.length + 1)
  for (let k = 0; k < list.length; k++) tops[k + 1] = tops[k] + (sizes.byKey.get(list[k].key) ?? guess) + ROW_GAP
  return tops
}

/** The first row whose bottom is below `y`. */
function rowAt(tops: Float64Array, y: number): number {
  let lo = 0
  let hi = tops.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid + 1] - ROW_GAP > y) hi = mid
    else lo = mid + 1
  }
  return lo
}

interface ListProps {
  list: readonly ReviewItem[]
  indexOf: ReadonlyMap<string, number>
  statuses: readonly ReviewStatus[]
  times: readonly string[]
  active: number
  onKeyDown: (e: React.KeyboardEvent) => void
  onChoose: (key: string) => void
  onAct: (key: string, action: 'keep' | 'remove') => void
  onFocusRow: (key: string) => void
  setRef: (key: string, el: HTMLButtonElement | null) => void
}

/**
 * The rows. Up to WINDOW_FROM, all of them, as a list in the page's flow. A longer list draws the
 * rows near the visible area and the focused row, each at its place over a block the height of the
 * whole list (the scroll bar is the whole list's): rows drawn are measured, those not drawn yet
 * count as the mean height, and when rows above the view turn out taller or shorter the view keeps
 * its place on the focused row (else the first row in view).
 */
function ReviewList({ list, indexOf, statuses, times, active, onKeyDown, onChoose, onAct, onFocusRow, setRef }: ListProps): JSX.Element {
  const n = list.length
  const windowed = n > WINDOW_FROM
  const ul = useRef<HTMLUListElement>(null)
  const [view, setView] = useState({ top: 0, height: 600 })
  const sizes = useRef<Sizes>({ byKey: new Map(), sum: 0 })
  // Counts the rows measured taller or shorter than they were placed, so the places are worked out again.
  const [measured, setMeasured] = useState(0)
  const places = useMemo(() => (windowed ? placesOf(list, sizes.current) : null), [windowed, list, measured])
  // What the last frame placed: to keep what is in view where it was.
  const placed = useRef<{ list: readonly ReviewItem[]; places: Float64Array; active: number } | null>(null)

  useLayoutEffect(() => {
    const el = ul.current
    if (!windowed || !el) return
    const read = (): void => setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }))
    read()
    const watch = new ResizeObserver(read)
    watch.observe(el)
    return () => watch.disconnect()
  }, [windowed])

  useLayoutEffect(() => {
    const el = ul.current
    if (!places || !el) {
      placed.current = null
      return
    }
    const before = placed.current
    if (before && before.places !== places) {
      const top = el.scrollTop
      const bottom = top + el.clientHeight
      const a = before.active
      const inView = a < before.list.length && before.places[a] < bottom && before.places[a + 1] - ROW_GAP > top
      const at = inView ? a : rowAt(before.places, top)
      const now = before.list[at] ? indexOf.get(before.list[at].key) : undefined
      const moved = now === undefined ? 0 : places[now] - before.places[at]
      if (Math.abs(moved) > 0.5) el.scrollTop = top + moved
    }
    placed.current = { list, places, active }
    let changed = false
    for (const row of el.children) {
      const key = (row as HTMLElement).dataset.key
      if (!key) continue
      const height = row.getBoundingClientRect().height
      const was = sizes.current.byKey.get(key)
      if (was !== undefined && Math.abs(was - height) < 0.25) continue
      sizes.current.byKey.set(key, height)
      sizes.current.sum += height - (was ?? 0)
      changed = true
    }
    if (changed) setMeasured((m) => m + 1)
  })

  const row = (k: number): JSX.Element => (
    <ReviewRow
      key={list[k].key}
      itemKey={list[k].key}
      kind={list[k].kind}
      title={list[k].title}
      detail={list[k].detail}
      time={times[k]}
      status={statuses[k]}
      isActive={k === active}
      pos={k + 1}
      size={n}
      top={places ? places[k] : undefined}
      onChoose={onChoose}
      onAct={onAct}
      onFocusRow={onFocusRow}
      setRef={setRef}
    />
  )

  if (!places) {
    return (
      <ul ref={ul} className="review-list" aria-label="Automatic changes" onKeyDown={onKeyDown}>
        {list.map((_, k) => row(k))}
      </ul>
    )
  }
  const first = rowAt(places, view.top - OVERSCAN)
  let last = rowAt(places, view.top + view.height + OVERSCAN)
  if (places[last] > view.top + view.height + OVERSCAN && last > first) last--
  const drawn: number[] = []
  if (active < first) drawn.push(active)
  for (let k = first; k <= last; k++) drawn.push(k)
  if (active > last) drawn.push(active)
  return (
    <ul
      ref={ul}
      className="review-list windowed"
      aria-label="Automatic changes"
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop
        setView((v) => (v.top === top ? v : { ...v, top }))
      }}
      style={{ '--review-list-height': `${places[n] - ROW_GAP}px` } as React.CSSProperties}
    >
      {drawn.map(row)}
    </ul>
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
  /** Where the row is in the whole list, from 1, and how many there are (aria-posinset, aria-setsize). */
  pos: number
  size: number
  /** Its place (px) in a long list (ReviewList), else undefined (in the flow). */
  top: number | undefined
  onChoose: (key: string) => void
  onAct: (key: string, action: 'keep' | 'remove') => void
  onFocusRow: (key: string) => void
  setRef: (key: string, el: HTMLButtonElement | null) => void
}

/** One row: drawn again only when what it shows changes (its props are values and stable handlers). */
const ReviewRow = memo(function ReviewRow({ itemKey, kind, title, detail, time, status, isActive, pos, size, top, onChoose, onAct, onFocusRow, setRef }: RowProps): JSX.Element {
  const ref = useCallback((el: HTMLButtonElement | null) => setRef(itemKey, el), [setRef, itemKey])
  return (
    <li
      className={`review-row ${status}${isActive ? ' active' : ''}`}
      data-testid="review-row"
      data-key={itemKey}
      data-status={status}
      aria-posinset={pos}
      aria-setsize={size}
      style={top === undefined ? undefined : { top }}
    >
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
