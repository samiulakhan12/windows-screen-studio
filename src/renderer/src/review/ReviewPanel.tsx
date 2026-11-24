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
 *
 * Captions Studio's emphasis and text fixes are group rows (docs/design/captions-studio.md §11.8):
 * Keep and Remove on the row do all of it, and a disclosure (aria-expanded) lists its single items,
 * each with its own Keep and Remove (K and Delete on one of them act on it). Each is one undo step.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { shortcutIndex } from '../../../shared/editor/shortcuts'
import { planOf } from '../../../shared/engine/freeze'
import {
  actedMessage,
  bulkMessage,
  busyMessage,
  busyWord,
  itemAccessibleName,
  kindAll,
  kindChip,
  progressText,
  reviewEmpty,
  reviewHint,
  reviewTitle,
  staleMessage,
  statusWord,
  stillBusyMessage,
  stoppedMessage,
  waitMessage
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
import { heldInSlices, type Work } from '../../../shared/review/slices'
import { rowTimes } from '../../../shared/review/times'
import { doneCounts, doneReviewing, privacyKinds, privacyOrder, privateRowKind, peekStill, privateRowView, type PrivateRowView } from '../../../shared/review/privacyReview'
import { itemKey } from '../../../shared/editor/multiSelect'
import { kindTitle, PRIVACY_COPY } from '../../../shared/privacy/copy'
import { PRIVATE_KINDS } from '../../../shared/privacy/kinds'
import { readToTime, unfinished } from '../../../shared/privacy/findState'
import type { PrivateKind, Project } from '../../../shared/types'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import { useEditor } from '../editor/context'
import { useGroup } from '../editor/groupContext'
import { keepVersionBefore } from '../versions/autoVersion'
import { useKeymap } from '../editor/keymapContext'
import { playStretch } from './playStretch'
import { pageTasks } from './tasks'
import './review.css'
import { FindProgressLine } from '../privacy/readerState'
import { FindResultLine } from '../privacy/FindLine'
import { runFor, subscribeRuns } from '../privacy/findRuns'
import { CopiesOffer } from '../privacy/CopiesOffer'
import { clearPeek, listenBleep, peekCovers, peekNow, peekWhileReviewing, usePeek } from '../privacy/peek'
import { onPrivateReview, takePrivateReview } from '../privacy/reviewRequest'
import '../privacy/privacyPanel.css'

export function ReviewPanel({
  onClose,
  onNotice,
  flush
}: {
  onClose: () => void
  /** Shows a notice in the editor (said once the panel is gone). */
  onNotice?: (text: string) => void
  /** Writes the editor's project to project.json now (the copies offer: main reads this project's file, auto-blur §5.10). */
  flush?: () => unknown
}): JSX.Element {
  const services = useEditor()
  const { store, player } = services
  const group = useGroup()
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
  const full = useMemo(() => (shown.at === project ? shown.list : mergeSnapshot(shown.list, project)), [shown, project])
  // Auto-blur's private items (docs/design/auto-blur.md §2.7): Review opened on them (the Private info
  // section's, Find's and the export note's *Review*) lists them alone, Check rows first, each by
  // start, in the order they were first listed (kept there as they are reviewed); the kind filter
  // narrows them to one kind. *Show all changes* lists every change again.
  const [privateOnly, setPrivateOnly] = useState(() => takePrivateReview())
  const [kindFilter, setKindFilter] = useState<PrivateKind | 'all'>('all')
  const rank = useRef(new Map<string, number>())
  useEffect(
    () =>
      onPrivateReview(() => {
        takePrivateReview()
        rank.current = new Map()
        setPrivateOnly(true)
      }),
    []
  )
  const list = useMemo(() => {
    if (!privateOnly) return full
    const shownRows = full.filter((i) => i.kind === 'private' && (kindFilter === 'all' || privateRowKind(i) === kindFilter))
    const fresh = shownRows.filter((i) => !rank.current.has(i.key))
    for (const i of privacyOrder(fresh, project)) rank.current.set(i.key, rank.current.size)
    return shownRows.sort((a, b) => (rank.current.get(a.key) ?? 0) - (rank.current.get(b.key) ?? 0))
  }, [full, privateOnly, kindFilter, project])
  const statuses = useMemo(() => list.map((i) => reviewStatus(project, i)), [list, project])
  const { reviewed, total } = useMemo(() => reviewProgress(statuses), [statuses])
  /** Where each row is in the list, by key. */
  const indexOf = useMemo(() => new Map(list.map((i, k) => [i.key, k])), [list])
  const plan = planOf(project)
  // Every row's time, in one pass over the clips, kept for the same clips and plan (times.ts).
  const times = useMemo(() => rowTimes(list, project.clips, plan), [list, project.clips, plan])
  // Group rows' items as they show (time and status), by the group's key.
  const groups = useMemo(() => {
    const out = new Map<string, PartView[]>()
    for (const i of list) {
      if (!i.parts) continue
      const at = rowTimes(i.parts, project.clips, plan)
      out.set(
        i.key,
        i.parts.map((p, k) => ({ key: p.key, title: p.title, time: at[k], status: reviewStatus(project, p), ...(p.kind === 'private' ? { badges: (privateRowView(project, p)?.badges ?? []).map((b) => t(b)) } : {}) }))
      )
    }
    return out
  }, [list, project, plan])
  // The group rows whose items are shown.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  const [activeKey, setActiveKey] = useState<string | null>(() => list.find((_, i) => statuses[i] === 'pending')?.key ?? list[0]?.key ?? null)
  const active = (activeKey !== null ? indexOf.get(activeKey) : undefined) ?? 0
  // What the live region says. Each message is a new node, so the same words twice (Keep, Ctrl+Z,
  // Keep) are read out twice; messages said before the page shows the first are said together
  // (Remove all done, then the Keep that waited for it), so none is lost.
  const [said, setSaid] = useState({ text: '', n: 0 })
  const saying = useRef<string[]>([])
  /** Once the panel is closing, where what it says goes instead (the editor's notice). */
  const sayAfter = useRef<string[] | null>(null)
  /** Whether Remove all kept its automatic version during this opening of the panel (E-12). */
  const versionKept = useRef(false)
  const say = (text: string): void => {
    if (sayAfter.current) return void sayAfter.current.push(text)
    saying.current.push(text)
    const all = saying.current.join(' ')
    setSaid((s) => ({ text: all, n: s.n + 1 }))
  }
  useLayoutEffect(() => {
    saying.current = []
  })
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
  // (it is drawn as the focused row), on the first render where it is the focused item; a render
  // before that (the project's change after Remove all is drawn before the focused item's) leaves
  // it waiting. Each move asks the list to bring the row fully into view once its rows are
  // measured (`reveal`), also when the row has the focus already (End on the last row).
  const focusLater = useRef<string | null>(null)
  const [reveal, setReveal] = useState(1)
  const focusKey = (key: string): void => {
    setActiveKey(key)
    setReveal((r) => r + 1)
    const el = rows.current.get(key)
    focusLater.current = el ? null : key
    el?.focus()
  }
  /** Makes `key` the focused item without moving the focus (it is elsewhere); a focus waiting for another row is dropped. */
  const pick = useCallback((key: string) => {
    if (focusLater.current !== key) focusLater.current = null
    setActiveKey(key)
  }, [])
  /**
   * Shows or hides a group row's items, the group becoming the focused row (its keys and buttons go
   * with it, and a long list keeps it drawn). A click hands the focus back to the editor once
   * released (focus.ts installFocusRelease); the list's keys need it in the panel, so it comes back
   * to the toggle after that, as it does to a clicked row (choose).
   */
  const onToggle = useCallback(
    (key: string, toggle: HTMLButtonElement | null) => {
      setOpen((was) => {
        const next = new Set(was)
        if (!next.delete(key)) next.add(key)
        return next
      })
      pick(key)
      window.setTimeout(() => {
        const el = document.activeElement
        if (toggle && toggle.isConnected !== false && (!el || el === document.body)) toggle.focus()
      }, 0)
    },
    [pick]
  )
  useLayoutEffect(() => {
    const key = focusLater.current
    if (key !== null && !indexOf.has(key)) focusLater.current = null
    if (key === null || key !== activeKey) return
    const el = rows.current.get(key)
    if (!el) return
    focusLater.current = null
    el.focus()
  })
  /**
   * Where the focus is as Keep all or Remove all ends (§4.3), its edit just made: on the page, on
   * the footer's buttons (the one pressed) or in a row it reviewed (a button it took away), the
   * focus moves on (`moves`); on a control chosen meanwhile, in a row still to review (`row`, its
   * key) or Close, or out of the panel, it stays where the user put it.
   */
  const focusAfterWork = (): { moves: boolean; row?: string } => {
    const el = document.activeElement
    if (!el || el === document.body) return { moves: true }
    if (!(el instanceof HTMLElement) || !panelRef.current?.contains(el)) return { moves: false }
    const key = el.closest<HTMLElement>('li[data-key]')?.dataset.key
    if (key !== undefined) {
      const { list, indexOf } = latest.current
      const k = indexOf.get(key)
      return k !== undefined && reviewStatus(store.state, list[k]) === 'pending' ? { moves: false, row: key } : { moves: true }
    }
    return { moves: !!el.closest('.review-foot') }
  }

  /** Jumps the preview to the item and plays a short stretch around it. */
  const play = (item: ReviewItem): void => {
    stopStretch()
    const p = store.state
    stopRef.current = playStretch(player, () => store.state.clips, previewStretch(p.clips, item.start, item.end))
  }

  /**
   * Holds the playhead still inside a peeked private row's first cover (auto-blur §2.8): the
   * magnified view is drawn from the frame at the playhead, so it shows what is under the row only
   * there. Nothing when no cover of the row is inside the edit.
   */
  const park = (coverIds: readonly string[]): void => {
    const t = peekStill(store.state, coverIds)
    if (t === null) return
    stopStretch()
    if (player.moving) player.pause()
    player.seek(t)
  }

  const choose = (item: ReviewItem): void => {
    focusKey(item.key)
    // With Peek while reviewing on, a private row is held still inside its first cover instead of played (§2.8).
    const still = peekNow().review && item.kind === 'private' ? privateRowView(store.state, item)?.coverIds : undefined
    if (still?.length) park(still)
    else play(item)
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

  /**
   * Keep or Remove one row (one undo step), say so, and move on to the next row to review. One that
   * waited for Keep all or Remove all (`waited`, see ask) moved on when it was asked for, so it
   * leaves the focus where it is now, and says so when that reviewed its row meanwhile.
   */
  const act = (item: ReviewItem, action: 'keep' | 'remove', waited = false): void => {
    const index = indexOf.get(item.key) ?? -1
    if (index < 0) return
    const status = reviewStatus(store.state, item)
    if (status !== 'pending') {
      if (waited) say(staleMessage(action, status))
      return
    }
    stopStretch()
    store.update((p) => (action === 'keep' ? keepItems(p, [item]) : removeItems(p, [item])))
    const after = list.map((i) => reviewStatus(store.state, i))
    const done = reviewProgress(after)
    say(item.kind === 'private' && action === 'remove' ? t(PRIVACY_COPY.review.uncovered) : actedMessage(action, done.reviewed, done.total))
    if (waited) return
    if (kindEmptied(after)) return
    const next = nextPending(list, after, index)
    if (next) focusKey(next)
  }

  /**
   * With one kind of private item shown and none of it left to review, the list says so and the focus
   * goes to the kind filter (finding 34); true when it went there.
   */
  const filterRef = useRef<HTMLSelectElement>(null)
  const kindEmptied = (after: readonly ReviewStatus[]): boolean => {
    if (!privateOnly || kindFilter === 'all' || after.includes('pending')) return false
    filterRef.current?.focus()
    return true
  }

  /**
   * A row's Keep or Remove (K, Delete, its buttons). While Keep all or Remove all works it waits,
   * in turn with the undo and redo asked for meanwhile (the store is held), and is done once that is
   * done, as if pressed then (§4.3): the live region says it waits, and the focus moves on at once
   * as after a Keep or Remove, to the next row still to review once what waits is done (not one the
   * work or another waiting Keep or Remove reviews), so K then Delete keeps one row and removes the next.
   */
  const waiting = useRef(new Set<string>())
  const ask = (item: ReviewItem, action: 'keep' | 'remove'): void => {
    if (!store.held) return act(item, action)
    const index = indexOf.get(item.key) ?? -1
    if (index < 0 || reviewStatus(store.state, item) !== 'pending') return
    stopStretch()
    if (busy) say(waitMessage(action, busy.action))
    const key = item.key
    waiting.current.add(key)
    store.whenFree(() => {
      waiting.current.delete(key)
      const { list, indexOf, act } = latest.current
      const k = indexOf.get(key)
      if (k !== undefined) act(list[k], action, true)
    })
    const stays = (i: ReviewItem, k: number): boolean =>
      statuses[k] === 'pending' && !waiting.current.has(i.key) && !(busy && (busy.action === 'keep' || busy.kind === i.kind))
    for (let k = 1; k < list.length; k++) {
      const j = (index + k) % list.length
      if (stays(list[j], j)) return focusKey(list[j].key)
    }
  }

  /**
   * Keep or Remove one item inside a group row (one undo step), say so, and move the focus on to the
   * next item of the group still to review (else the group's row). One asked while Keep all or
   * Remove all works waits for it, as a row's does.
   */
  const actPart = (groupKey: string, partKey: string, action: 'keep' | 'remove', waited = false): void => {
    const { list, indexOf } = latest.current
    const k = indexOf.get(groupKey)
    const part = k !== undefined ? list[k].parts?.find((p) => p.key === partKey) : undefined
    if (!part) return
    const status = reviewStatus(store.state, part)
    if (status !== 'pending') {
      if (waited) say(staleMessage(action, status))
      return
    }
    stopStretch()
    // Pressed (a click may come while another row is the focused one), the group becomes the focused
    // row: a long list keeps it drawn, so the focus moved into it below is not lost, and its keys reach it.
    if (!waited) pick(groupKey)
    store.update((p) => (action === 'keep' ? keepItems(p, [part]) : removeItems(p, [part])))
    const done = reviewProgress(list.map((i) => reviewStatus(store.state, i)))
    say(part.kind === 'private' && action === 'remove' ? t(PRIVACY_COPY.review.uncovered) : actedMessage(action, done.reviewed, done.total))
    if (waited) return
    const parts = list[k!].parts ?? []
    const from = parts.findIndex((p) => p.key === partKey)
    const next = [...parts.slice(from + 1), ...parts.slice(0, from)].find((p) => reviewStatus(store.state, p) === 'pending')
    const button = next ? panelRef.current?.querySelector<HTMLButtonElement>(`[data-member-key="${CSS.escape(next.key)}"] button`) : null
    if (button) button.focus()
    else focusKey(groupKey)
  }
  const askPart = (groupKey: string, partKey: string, action: 'keep' | 'remove'): void => {
    if (!store.held) return actPart(groupKey, partKey, action)
    stopStretch()
    if (busy) say(waitMessage(action, busy.action))
    store.whenFree(() => latest.current.actPart(groupKey, partKey, action, true))
  }

  // Keep all and Remove all over more than BUSY_FROM rows (§4.3): the button says it is working and
  // the live region what it does and what waits for it, drawn before the work starts; then the work
  // goes a slice of time at a time (Remove all: removeSteps, one cut or speed-up a step), the page
  // drawing in between, and is one edit (one undo step) at the end, made from the project as it is
  // then. Meanwhile the store is held: undo and redo, and the rows' Keep and Remove (ask), wait and
  // are done in order after it, as if pressed once it was done (Ctrl+Z undoes it, never the step
  // before). Closing the panel stops it with nothing of it done, and the editor's notice says so:
  // what waited is then done as if it had been made (an undo for it does nothing; the Keep before
  // it stays), and what that says goes in the same notice. Leaving the editor waits for it instead.
  const [busy, setBusy] = useState<{ action: 'keep' | 'remove'; count: number; kind?: ReviewKind } | null>(null)
  const working = useRef<{ work: Work; action: 'keep' | 'remove'; kind?: ReviewKind } | null>(null)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  useEffect(
    () => () => {
      const w = working.current
      if (!w) return
      working.current = null
      const said = [stoppedMessage(w.action, w.kind)]
      sayAfter.current = said
      w.work.stop()
      noticeRef.current?.(said.join(' '))
    },
    []
  )

  /**
   * Keep or Remove `count` rows of `list` (of `kind` for Remove all) still to review, then `after`
   * (where the focus goes, from where it is: focusAfterWork); the live region says what was done.
   */
  const bulk = (action: 'keep' | 'remove', kind: ReviewKind | undefined, count: number, after: (at: { moves: boolean; row?: string }) => void, sliced = false): void => {
    stopStretch()
    const targets = (p: Project): ReviewItem[] => latest.current.list.filter((i) => (!kind || i.kind === kind) && reviewStatus(p, i) === 'pending')
    const apply = (p: Project, items: readonly ReviewItem[]): Project => (action === 'keep' ? keepItems(p, items) : removeItems(p, items))
    // E-12: Remove all keeps the edit before it as a version once it is made (docs/design/versions.md
    // §2.4); Keep all changes no footage, and work stopped (the panel closed) keeps none.
    // One version per opening of the panel: it holds the edit before the whole pass, so a pass over
    // every kind never crowds out older automatic versions such as "Before Polish in one click".
    const commit = (fn: (p: Project) => Project): void => {
      const before = store.state
      store.update(fn)
      if (action === 'remove' && store.state !== before && !versionKept.current) {
        versionKept.current = true
        void keepVersionBefore(before, 'review')
      }
    }
    // What is said counts a group row as its items still to review ("Removed 38 emphasis."); `count`
    // (rows) only decides whether the work runs in slices.
    const units = (p: Project, items: readonly ReviewItem[]): number => items.reduce((n, i) => n + (i.parts ? i.parts.filter((x) => reviewStatus(p, x) === 'pending').length : 1), 0)
    // Auto-blur's Keep all … covered and Uncover all … always go through heldInSlices (§14.1).
    if (count <= BUSY_FROM && !sliced) {
      let done = 0
      commit((p) => {
        const items = targets(p)
        done = units(p, items)
        return apply(p, items)
      })
      say(bulkMessage(action, done, kind))
      after({ moves: true })
      return
    }
    const todo = units(store.state, targets(store.state))
    setBusy({ action, count: todo, kind })
    say(busyMessage(action, todo, kind))
    const work = heldInSlices(
      store,
      (p) =>
        action === 'remove'
          ? removeSteps(p, targets(p))
          : (function* (): Generator<never, Project, undefined> {
              return keepItems(p, targets(p))
            })(),
      (base, next) => {
        working.current = null
        const done = units(base, targets(base))
        commit((p) => (p === base ? next : apply(p, targets(p))))
        setBusy(null)
        say(bulkMessage(action, done, kind))
        // The focus moves on only from where the work left it, not from a control chosen meanwhile.
        after(focusAfterWork())
      },
      pageTasks()
    )
    working.current = { work, action, kind }
  }

  /** Pressed while Keep all or Remove all works: says it still works (the buttons are aria-disabled). */
  const stillBusy = (): boolean => {
    if (busy) say(stillBusyMessage(busy.action, busy.count, busy.kind))
    return !!busy
  }

  const keepAll = (): void => {
    if (stillBusy()) return
    const count = statuses.filter((s) => s === 'pending').length
    if (count === 0) return
    // Keep all turns disabled under the focus, which would drop to the page (Esc and the list's
    // keys would then miss the panel): the focus goes back to the row.
    bulk('keep', undefined, count, (at) => {
      const { list, active } = latest.current
      if (!list[active]) return
      if (at.moves) focusKey(list[active].key)
    })
  }

  useLayoutEffect(() => {
    // A focus waiting for its row (focusLater) goes there once it is drawn; the focused item's row
    // here would be the one it moves on from (Remove all done, the focus on a row's Remove it took).
    if (!focusWasIn.current || focusLater.current !== null) return
    focusWasIn.current = false
    const el = document.activeElement
    if (el && el !== document.body && !(el instanceof HTMLButtonElement && el.disabled)) return
    ;((list[active] && rows.current.get(list[active].key)) || closeRef.current)?.focus()
  })

  const current = list[active]
  const kind = current?.kind
  const kindPending = useMemo(() => (kind ? list.filter((i, k) => i.kind === kind && statuses[k] === 'pending') : []), [list, statuses, kind])
  const removeKind = (): void => {
    if (stillBusy() || !current || kindPending.length === 0) return
    // Uncover all private items asks first, its focus on Cancel (auto-blur §2.7).
    if (current.kind === 'private') return askUncover(kindPending.length, () => removeKindNow())
    removeKindNow()
  }
  const removeKindNow = (): void => {
    if (stillBusy() || !current || kindPending.length === 0) return
    bulk('remove', current.kind, kindPending.length, (at) => {
      // A control in a row still to review, chosen meanwhile, keeps the focus, its row the focused
      // one. Else on to the next row to review after the focused one, which is the one pressed from
      // unless another was chosen meanwhile: that one stays when it is still to review.
      if (at.row !== undefined) return pick(at.row)
      const { list, active } = latest.current
      const after = list.map((i) => reviewStatus(store.state, i))
      if (at.moves && latest.current.kindEmptied(after)) return
      const next = after[active] === 'pending' ? list[active].key : nextPending(list, after, active)
      if (next && at.moves) focusKey(next)
      else if (next) pick(next)
    })
  }

  /* ---------- auto-blur's private items (docs/design/auto-blur.md §2.7, §2.8, §11) ---------- */

  const peek = usePeek()
  const runningNow = (): boolean => !!runFor(project.id)
  const running = useSyncExternalStore(subscribeRuns, runningNow, runningNow)
  const record = project.privacy?.find
  const hasPrivate = full.some((i) => i.kind === 'private')
  // What each private row and place shows besides its title: badges, places, the lost area, what Peek and Listen act on.
  const views = useMemo(() => {
    const out = new Map<string, PrivateRowView>()
    for (const i of list) {
      if (i.kind !== 'private') continue
      const v = privateRowView(project, i)
      if (v) out.set(i.key, v)
    }
    return out
  }, [list, project])
  // The kinds the filter offers: those waiting now and those of the rows listed.
  const kinds = useMemo(() => {
    const have = new Set<PrivateKind>(privacyKinds(project))
    for (const i of full) {
      const k = i.kind === 'private' ? privateRowKind(i) : null
      if (k) have.add(k)
    }
    return PRIVATE_KINDS.filter((k) => have.has(k))
  }, [full, project])
  const privatePending = list.filter((i, k) => i.kind === 'private' && statuses[k] === 'pending').length
  const toKeep = useMemo(() => doneCounts(project), [project])

  // Review closing stops Peek and Listen (§2.8).
  useEffect(() => () => clearPeek(), [])
  // *Peek while reviewing*: the selected private row is peeked, the next one as the focus moves on.
  const activeCovers = current?.kind === 'private' ? (views.get(current.key)?.coverIds ?? []) : []
  const activeCoversKey = activeCovers.join(',')
  useEffect(() => {
    if (!peek.review) return
    peekCovers(activeCovers.length ? activeCovers : null)
    // And holds the playhead still inside it, as K, Delete and V move on without playing (§2.8).
    if (activeCovers.length) park(activeCovers)
    // The covers' ids, not the array: a new array of the same ids peeks nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek.review, activeCoversKey])
  /** Whether Peek shows exactly these covers now. */
  const peekedAt = (ids: readonly string[]): boolean => Array.isArray(peek.ids) && ids.length > 0 && peek.ids.length === ids.length && ids.every((id) => (peek.ids as readonly string[]).includes(id))

  // The confirms of Uncover all and Done reviewing (§2.7): inline in the panel, their focus on Cancel.
  const [confirm, setConfirm] = useState<{ text: string; detail?: string; action: string; run: () => void; back: HTMLElement | null } | null>(null)
  const activeEl = (): HTMLElement | null => {
    const el = typeof document !== 'undefined' ? document.activeElement : null
    return el instanceof HTMLElement ? el : null
  }
  const askUncover = (count: number, run: () => void): void =>
    setConfirm({ text: t(PRIVACY_COPY.review.uncoverConfirm, { count, n: fmt.count(count) }), action: t(PRIVACY_COPY.review.uncoverConfirmAction), run, back: activeEl() })
  const closeConfirm = (go: boolean): void => {
    const c = confirm
    setConfirm(null)
    if (!c) return
    if (go) c.run()
    else c.back?.focus()
  }

  /** After a private bulk action: the filter when the kind shown has nothing left, else on to the focused row. */
  const afterPrivate = (at: { moves: boolean }): void => {
    const { list, active } = latest.current
    const after = list.map((i) => reviewStatus(store.state, i))
    if (at.moves && latest.current.kindEmptied(after)) return
    if (at.moves && list[active]) focusKey(list[active].key)
  }
  /** *Keep all … covered* of the kind shown (one undo step, through heldInSlices). */
  const keepKind = (): void => {
    if (stillBusy() || privatePending === 0) return
    bulk('keep', 'private', privatePending, afterPrivate, true)
  }
  /** *Uncover all …* of the kind shown, asked first; it keeps a version first, as Remove all does. */
  const uncoverKind = (): void => {
    if (stillBusy() || privatePending === 0) return
    askUncover(privatePending, () => latest.current.bulk('remove', 'private', privatePending, afterPrivate, true))
  }
  /** *Done reviewing*: every waiting private suggestion kept, in one undo step through heldInSlices, after its confirm. */
  const done = (): void => {
    if (stillBusy() || toKeep.waiting === 0) return
    const n = toKeep.waiting
    const detail = toKeep.check > 0 ? t(PRIVACY_COPY.review.doneCheck, { count: toKeep.check, n: fmt.count(toKeep.check) }) : undefined
    setConfirm({
      text: t(PRIVACY_COPY.review.doneConfirm, { count: n, n: fmt.count(n) }),
      ...(detail ? { detail } : {}),
      action: t(PRIVACY_COPY.review.doneKeep),
      back: activeEl(),
      run: () => {
        stopStretch()
        setBusy({ action: 'keep', count: n })
        const work = heldInSlices(
          store,
          (p) =>
            (function* (): Generator<never, Project, undefined> {
              return doneReviewing(p)
            })(),
          (base, next) => {
            working.current = null
            store.update((p) => (p === base ? next : doneReviewing(p)))
            setBusy(null)
            say(bulkMessage('keep', n))
            afterPrivate(focusAfterWork())
          },
          pageTasks()
        )
        working.current = { work, action: 'keep' }
      }
    })
  }
  const findAgain = (): void => group.command('findPrivate')
  const togglePrivate = (only: boolean): void => {
    rank.current = new Map()
    setPrivateOnly(only)
    if (!only) setKindFilter('all')
  }
  const onPeekRow = useCallback((key: string) => {
    const v = latest.current.views.get(key)
    if (!v || !v.coverIds.length) return
    const on = !latest.current.peekedAt(v.coverIds)
    peekCovers(on ? v.coverIds : null)
    // Peek's magnified view shows the frame at the playhead: it is held inside the row's first cover (§2.8).
    if (on) latest.current.park(v.coverIds)
  }, [])
  const onListenRow = useCallback((key: string) => {
    const v = latest.current.views.get(key)
    if (!v?.bleepId) return
    listenBleep(latest.current.listen === v.bleepId ? null : v.bleepId)
  }, [])
  const onSelectRow = useCallback((key: string) => {
    const v = latest.current.views.get(key)
    if (!v || !v.coverIds.length) return
    const keys = v.coverIds.map((id) => itemKey('cover', id))
    latest.current.group.select(keys, keys[0])
  }, [])
  /** A place's own stretch (§2.7). */
  const onPlayPart = useCallback((groupKey: string, partKey: string) => {
    const { list, indexOf } = latest.current
    const k = indexOf.get(groupKey)
    const part = k !== undefined ? list[k].parts?.find((p) => p.key === partKey) : undefined
    if (part) latest.current.play(part)
  }, [])

  // The rows' handlers stay the same function from render to render, so a row draws again only
  // when what it shows changes (N redraws the two rows whose focus moved, not the whole list).
  const latest = useRef({ choose, act, ask, actPart, askPart, list, indexOf, active, kindEmptied, bulk, views, peekedAt, listen: peek.listen, group, play, park })
  latest.current = { choose, act, ask, actPart, askPart, list, indexOf, active, kindEmptied, bulk, views, peekedAt, listen: peek.listen, group, play, park }
  const onRowChoose = useCallback((key: string) => {
    const { list, indexOf, choose } = latest.current
    const k = indexOf.get(key)
    if (k !== undefined) choose(list[k])
  }, [])
  const onRowAct = useCallback((key: string, action: 'keep' | 'remove') => {
    const { list, indexOf, ask } = latest.current
    const k = indexOf.get(key)
    if (k !== undefined) ask(list[k], action)
  }, [])
  const onPartAct = useCallback((groupKey: string, partKey: string, action: 'keep' | 'remove') => latest.current.askPart(groupKey, partKey, action), [])
  const setRow = useCallback((key: string, el: HTMLButtonElement | null) => {
    if (el) rows.current.set(key, el)
    else rows.current.delete(key)
  }, [])

  const onListKey = (e: React.KeyboardEvent): void => {
    const key = listKey(e, shortcuts, current)
    if (!key) return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat && !key.again) return
    // K and Delete on an item inside a group row act on that item.
    const member = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-member-key]') : null
    const owner = member?.closest<HTMLElement>('li[data-key]')?.dataset.key
    if (member && owner && (key.action === 'keep' || key.action === 'remove')) return askPart(owner, member.dataset.memberKey ?? '', key.action)
    if (key.action === 'next') move(active + 1)
    else if (key.action === 'previous') move(active - 1)
    else if (key.action === 'first') move(0)
    else if (key.action === 'last') move(list.length - 1)
    // V turns Peek while reviewing on and off (auto-blur §2.8); the list gives it only on a private row.
    else if (key.action === 'peek') peekWhileReviewing(!peek.review)
    else if (current) ask(current, key.action)
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
      } else if (current && peek.review && current.kind === 'private') {
        // Moving to a row held it still while Peek while reviewing is on (§2.8): Space plays its stretch.
        play(current)
      } else if (current) choose(current)
      return
    }
    // Enter and Space press the focused button here (the editor would play or pause instead).
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement) e.stopPropagation()
  }

  return (
    <aside ref={panelRef} className="review-panel" role="region" aria-label={reviewTitle()} data-testid="review-panel" onKeyDown={onPanelKey}>
      <div className="review-head">
        <h2>{reviewTitle()}</h2>
        <button
          ref={closeRef}
          className="btn ghost icon-btn"
          title={t('review.panel.close')}
          aria-label={t('review.panel.close')}
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
      {/* Find private info's progress line (docs/design/auto-blur.md §2.6). */}
      <FindProgressLine projectId={project.id} />
      {(hasPrivate || privateOnly || !!record || running) && (
        <div className="review-private" data-testid="review-private">
          {confirm && <ReviewConfirm text={confirm.text} detail={confirm.detail} action={confirm.action} onAnswer={closeConfirm} />}
          <FindResultLine projectId={project.id} />
          {record && !running && unfinished(record) && (
            <p className="review-private-line" data-testid="review-unfinished">
              <span>{t(PRIVACY_COPY.review.unfinished, { time: readToTime(project) })}</span>{' '}
              <button type="button" className="link" onClick={findAgain} data-testid="review-find-again">
                {t(PRIVACY_COPY.review.findAgain)}
              </button>
            </p>
          )}
          {record && !running && !unfinished(record) && (
            <button type="button" className="link" onClick={findAgain} data-testid="review-find-again">
              {t(PRIVACY_COPY.review.findAgain)}
            </button>
          )}
          {hasPrivate && (
            <div className="review-private-tools">
              <label className="check">
                <input type="checkbox" checked={!privateOnly} onChange={(e) => togglePrivate(!e.target.checked)} data-testid="review-show-all" />
                <span>{t('privacy.review.showAll')}</span>
              </label>
              {privateOnly && kinds.length > 0 && (
                <label className="review-kind-filter">
                  <span>{t(PRIVACY_COPY.review.filter)}</span>
                  <select ref={filterRef} value={kindFilter} onChange={(e) => setKindFilter(e.target.value as PrivateKind | 'all')} data-testid="review-kind-filter">
                    <option value="all">{t(PRIVACY_COPY.review.filterAll)}</option>
                    {kinds.map((k) => (
                      <option key={k} value={k}>
                        {t(kindTitle(k))}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className="btn small"
                aria-pressed={peek.review}
                title={t(PRIVACY_COPY.review.peekAllHint)}
                aria-describedby="review-peek-all-hint"
                onClick={() => peekWhileReviewing(!peek.review)}
                data-testid="review-peek-all"
              >
                {t(PRIVACY_COPY.review.peekAll)}
              </button>
              <span id="review-peek-all-hint" className="sr-only">
                {t(PRIVACY_COPY.review.peekAllHint)}
              </span>
            </div>
          )}
          {privateOnly && kindFilter !== 'all' && (
            <div className="review-private-tools">
              {privatePending === 0 ? (
                <p className="review-private-line" role="status" data-testid="review-empty-kind">
                  {t(PRIVACY_COPY.review.emptyKind)}
                </p>
              ) : (
                <>
                  <button type="button" className="btn small" aria-disabled={busy ? 'true' : undefined} onClick={keepKind} data-testid="review-keep-kind">
                    {t(PRIVACY_COPY.review.keepKind, { kind: kindFilter })}
                  </button>
                  <button type="button" className="btn small" aria-disabled={busy ? 'true' : undefined} onClick={uncoverKind} data-testid="review-uncover-kind">
                    {t(PRIVACY_COPY.review.uncoverKind, { kind: kindFilter })}
                  </button>
                </>
              )}
            </div>
          )}
          {toKeep.waiting > 0 && (
            <button type="button" className="btn small" aria-disabled={busy ? 'true' : undefined} onClick={done} data-testid="review-done">
              {t(PRIVACY_COPY.review.done)}
            </button>
          )}
          <CopiesOffer services={services} {...(flush ? { flush } : {})} />
        </div>
      )}
      {total > 0 && (
        <div className="review-progress">
          <span data-testid="review-progress">{progressText(reviewed, total)}</span>
          <div className="review-bar" role="progressbar" aria-label={t('review.panel.reviewed')} aria-valuemin={0} aria-valuemax={total} aria-valuenow={reviewed}>
            <div style={{ width: `${(reviewed / total) * 100}%` }} />
          </div>
        </div>
      )}
      {total === 0 ? (
        <p className="review-empty">{reviewEmpty()}</p>
      ) : (
        <>
          <p className="review-hint">{reviewHint()}</p>
          <ReviewList
            list={list}
            indexOf={indexOf}
            statuses={statuses}
            times={times}
            active={active}
            reveal={reveal}
            onKeyDown={onListKey}
            onChoose={onRowChoose}
            onAct={onRowAct}
            onFocusRow={pick}
            setRef={setRow}
            groups={groups}
            open={open}
            onToggle={onToggle}
            onPartAct={onPartAct}
            views={views}
            peeked={peek.ids}
            listened={peek.listen}
            onPeek={onPeekRow}
            onListen={onListenRow}
            onSelectCovers={onSelectRow}
            onPlayPart={onPlayPart}
          />
          <div className="review-foot">
            <button
              className="btn"
              data-testid="review-keep-all"
              disabled={reviewed === total}
              aria-disabled={busy ? 'true' : undefined}
              aria-busy={busy?.action === 'keep' ? 'true' : undefined}
              onClick={keepAll}
            >
              {busy?.action === 'keep' ? busyWord('keep') : t('review.panel.keepAll')}
            </button>
            <button
              className="btn"
              data-testid="review-remove-kind"
              disabled={kindPending.length === 0 && busy?.action !== 'remove'}
              aria-disabled={busy ? 'true' : undefined}
              aria-busy={busy?.action === 'remove' ? 'true' : undefined}
              onClick={removeKind}
            >
              {busy?.action === 'remove' ? busyWord('remove') : current ? kindAll(current.kind) : t('common.action.removeAll')}
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

export interface Sizes {
  byKey: Map<string, number>
  sum: number
}

/**
 * Where each row starts (px) in the whole list, and where the list ends (the last entry, plus a gap).
 * A row not measured yet is placed at the mean of those measured, group rows left out: one with its
 * items shown can be thousands of pixels tall, which would make every other row's guess as tall.
 */
export function placesOf(list: readonly ReviewItem[], sizes: Sizes): Float64Array {
  let sum = sizes.sum
  let count = sizes.byKey.size
  for (const i of list) {
    const size = i.parts ? sizes.byKey.get(i.key) : undefined
    if (size === undefined) continue
    sum -= size
    count--
  }
  const guess = count > 0 ? sum / count : ROW_GUESS
  const tops = new Float64Array(list.length + 1)
  for (let k = 0; k < list.length; k++) tops[k + 1] = tops[k] + (sizes.byKey.get(list[k].key) ?? guess) + ROW_GAP
  return tops
}

/** Scrolls `list` the least that brings `row` fully into view (from its top when it is taller than the view). */
function bringIntoView(list: HTMLElement, row: Element): void {
  const r = row.getBoundingClientRect()
  const top = list.getBoundingClientRect().top + list.clientTop
  const bottom = top + list.clientHeight
  if (r.top < top) list.scrollTop -= top - r.top
  else if (r.bottom > bottom) list.scrollTop += Math.min(r.top - top, r.bottom - bottom)
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

/** An item inside a group row, as it shows. */
interface PartView {
  key: string
  title: string
  time: string
  status: ReviewStatus
  /** A private place's badges (auto-blur §2.7), as shown. */
  badges?: string[]
}

interface ListProps {
  list: readonly ReviewItem[]
  indexOf: ReadonlyMap<string, number>
  statuses: readonly ReviewStatus[]
  times: readonly string[]
  active: number
  /** Changes when the focused row is moved to (a key, a click, Keep or Remove): it is then brought fully into view, once its rows are measured. */
  reveal: number
  onKeyDown: (e: React.KeyboardEvent) => void
  onChoose: (key: string) => void
  onAct: (key: string, action: 'keep' | 'remove') => void
  onFocusRow: (key: string) => void
  setRef: (key: string, el: HTMLButtonElement | null) => void
  /** Group rows' items, by the group's key, and the groups whose items are shown. */
  groups: ReadonlyMap<string, PartView[]>
  open: ReadonlySet<string>
  onToggle: (key: string, toggle: HTMLButtonElement | null) => void
  onPartAct: (groupKey: string, partKey: string, action: 'keep' | 'remove') => void
  /** Auto-blur's private rows (§2.7): what each shows besides its title, what Peek and Listen show now, and their buttons. */
  views: ReadonlyMap<string, PrivateRowView>
  peeked: readonly string[] | 'all' | null
  listened: string | null
  onPeek: (key: string) => void
  onListen: (key: string) => void
  onSelectCovers: (key: string) => void
  onPlayPart: (groupKey: string, partKey: string) => void
}

/** Whether Peek shows exactly `ids` now. */
const peekedNow = (peeked: readonly string[] | 'all' | null, ids: readonly string[]): boolean => Array.isArray(peeked) && ids.length > 0 && peeked.length === ids.length && ids.every((id) => peeked.includes(id))

/**
 * The rows. Up to WINDOW_FROM, all of them, as a list in the page's flow. A longer list draws the
 * rows near the visible area and the focused row, each at its place over a block the height of the
 * whole list (the scroll bar is the whole list's): rows drawn are measured, those not drawn yet
 * count as the mean height, and when rows above the view turn out taller or shorter the view keeps
 * its place on the focused row (else the first row in view; a view at the end of the list stays at
 * its end), judged from where the last frame had scrolled to: the block takes its new height only
 * after that is read, so a shorter list has not pulled the scroll position back yet. A row moved to
 * (`reveal`) is then brought fully into view once the rows drawn are all measured.
 */
function ReviewList({ list, indexOf, statuses, times, active, reveal, onKeyDown, onChoose, onAct, onFocusRow, setRef, groups, open, onToggle, onPartAct, views, peeked, listened, onPeek, onListen, onSelectCovers, onPlayPart }: ListProps): JSX.Element {
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
  // The last `reveal` done, and the block's height last set (setting it again would have the page work out its style anew).
  const revealed = useRef(0)
  const height = useRef('')

  useLayoutEffect(() => {
    const el = ul.current
    if (!windowed || !el) return
    const read = (): void => {
      const top = el.scrollTop
      const height = el.clientHeight
      setView((v) => (v.top === top && v.height === height ? v : { top, height }))
    }
    read()
    const watch = new ResizeObserver(read)
    watch.observe(el)
    return () => watch.disconnect()
  }, [windowed])

  useLayoutEffect(() => {
    const el = ul.current
    if (!el) return
    const focused = list[active]?.key
    if (!places) {
      placed.current = null
      height.current = ''
      if (reveal !== revealed.current) {
        revealed.current = reveal
        const row = el.children[active]
        if (row) bringIntoView(el, row)
      }
      return
    }
    // Where the last frame had scrolled to: the block still has the height it had then (it takes its
    // new one below), so the browser has not clamped this to a shorter list.
    const top = el.scrollTop
    let to = top
    const before = placed.current
    if (before && before.places !== places) {
      const bottom = top + el.clientHeight
      const a = before.active
      const inView = a < before.list.length && before.places[a] < bottom && before.places[a + 1] - ROW_GAP > top
      const at = inView ? a : rowAt(before.places, top)
      const now = before.list[at] ? indexOf.get(before.list[at].key) : undefined
      if (now !== undefined) to = top + places[now] - before.places[at]
      // A view at the end of the list (the scroll bar dragged to the bottom) stays at its end, unless
      // that would take the focused row, in view, out of it.
      if (bottom >= before.places[before.list.length] - ROW_GAP - 1) {
        const end = Math.max(0, places[n] - ROW_GAP - el.clientHeight)
        const f = inView ? now : undefined
        if (f === undefined || (places[f] >= end - 0.5 && places[f + 1] - ROW_GAP <= end + el.clientHeight + 0.5)) to = end
      }
    }
    const tall = `${places[n] - ROW_GAP}px`
    if (tall !== height.current) {
      height.current = tall
      el.style.setProperty('--review-list-height', tall)
    }
    if (Math.abs(to - el.scrollTop) > 0.5) el.scrollTop = to
    placed.current = { list, places, active }
    let changed = false
    let row: Element | null = null
    for (const child of el.children) {
      const key = (child as HTMLElement).dataset.key
      if (!key) continue
      if (key === focused) row = child
      const size = child.getBoundingClientRect().height
      const was = sizes.current.byKey.get(key)
      if (was !== undefined && Math.abs(was - size) < 0.25) continue
      sizes.current.byKey.set(key, size)
      sizes.current.sum += size - (was ?? 0)
      changed = true
    }
    if (changed) setMeasured((m) => m + 1)
    else if (reveal !== revealed.current && row) {
      revealed.current = reveal
      bringIntoView(el, row)
    }
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
      parts={groups.get(list[k].key)}
      expanded={open.has(list[k].key)}
      onToggle={onToggle}
      onPartAct={onPartAct}
      view={views.get(list[k].key)}
      isPeeked={peekedNow(peeked, views.get(list[k].key)?.coverIds ?? [])}
      isListened={!!listened && views.get(list[k].key)?.bleepId === listened}
      onPeek={onPeek}
      onListen={onListen}
      onSelectCovers={onSelectCovers}
      onPlayPart={onPlayPart}
    />
  )

  if (!places) {
    return (
      <ul ref={ul} className="review-list" aria-label={t('review.panel.list')} onKeyDown={onKeyDown}>
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
      aria-label={t('review.panel.list')}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop
        setView((v) => (v.top === top ? v : { ...v, top }))
      }}
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
  /** A group row's items (Captions Studio's emphasis and text fixes), whether they are shown, and their Keep and Remove. */
  parts?: readonly PartView[]
  expanded: boolean
  onToggle: (key: string, toggle: HTMLButtonElement | null) => void
  onPartAct: (groupKey: string, partKey: string, action: 'keep' | 'remove') => void
  /** A private row's view (auto-blur §2.7), whether Peek and Listen show it now, and their buttons. */
  view?: PrivateRowView
  isPeeked: boolean
  isListened: boolean
  onPeek: (key: string) => void
  onListen: (key: string) => void
  onSelectCovers: (key: string) => void
  onPlayPart: (groupKey: string, partKey: string) => void
}

/** One row: drawn again only when what it shows changes (its props are values and stable handlers). */
const ReviewRow = memo(function ReviewRow({
  itemKey,
  kind,
  title,
  detail,
  time,
  status,
  isActive,
  pos,
  size,
  top,
  onChoose,
  onAct,
  onFocusRow,
  setRef,
  parts,
  expanded,
  onToggle,
  onPartAct,
  view,
  isPeeked,
  isListened,
  onPeek,
  onListen,
  onSelectCovers,
  onPlayPart
}: RowProps): JSX.Element {
  const ref = useCallback((el: HTMLButtonElement | null) => setRef(itemKey, el), [setRef, itemKey])
  const toggleRef = useRef<HTMLButtonElement>(null)
  const partsId = `review-parts-${itemKey.replace(/[^A-Za-z0-9_-]/g, '-')}`
  // Auto-blur's private rows read *Keep covered* and *Uncover* (§2.7); every other kind as before.
  const isPrivate = kind === 'private'
  const keepLabel = (forTitle: string): string => (isPrivate ? t(PRIVACY_COPY.review.keepRow, { title: forTitle }) : t('review.row.keep', { title: forTitle }))
  const removeLabel = (forTitle: string): string => (isPrivate ? t(PRIVACY_COPY.review.uncoverRow, { title: forTitle }) : t('review.row.remove', { title: forTitle }))
  const keepText = isPrivate ? t(PRIVACY_COPY.review.keep) : t('common.action.keep')
  const removeText = isPrivate ? t(PRIVACY_COPY.review.uncover) : t('common.action.remove')
  const infoId = `review-info-${itemKey.replace(/[^A-Za-z0-9_-]/g, '-')}`
  const info = view && (view.places > 1 || view.area || view.badges.length > 0)
  return (
    <li
      className={`review-row ${status}${isActive ? ' active' : ''}${parts ? ' group' : ''}`}
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
        aria-describedby={info ? infoId : undefined}
        onClick={() => onChoose(itemKey)}
        onFocus={() => onFocusRow(itemKey)}
      >
        <span className={`review-chip kind-${kind}`} aria-hidden="true">
          {kindChip(kind)}
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
          <button className="btn" tabIndex={isActive ? 0 : -1} aria-label={keepLabel(title)} data-testid="review-keep" onClick={() => onAct(itemKey, 'keep')}>
            {keepText}
          </button>
          <button className="btn" tabIndex={isActive ? 0 : -1} aria-label={removeLabel(title)} data-testid="review-remove" onClick={() => onAct(itemKey, 'remove')}>
            {removeText}
          </button>
        </span>
      ) : (
        <ReviewMark status={status} />
      )}
      {view && info && (
        <span className="review-private-info" id={infoId} data-testid="review-private-info">
          {view.places > 1 && <span>{t(PRIVACY_COPY.review.places, { count: view.places, n: fmt.count(view.places) })}</span>}
          {view.area && <span>{t(PRIVACY_COPY.review.area, view.area)}</span>}
          {view.badges.map((b) => (
            <span key={b} className="review-badge" data-testid="review-badge">
              {t(b)}
            </span>
          ))}
        </span>
      )}
      {view && (view.coverIds.length > 0 || view.bleepId) && (
        <span className="review-private-actions">
          {view.coverIds.length > 0 && (
            <button className="btn small" tabIndex={isActive ? 0 : -1} data-testid="review-select" onClick={() => onSelectCovers(itemKey)}>
              {t(PRIVACY_COPY.review.select)}
            </button>
          )}
          {view.coverIds.length > 0 && (
            <button className="btn small" tabIndex={isActive ? 0 : -1} aria-pressed={isPeeked} aria-label={t(PRIVACY_COPY.review.peekRow, { title })} data-testid="review-peek" onClick={() => onPeek(itemKey)}>
              {t(PRIVACY_COPY.review.peek)}
            </button>
          )}
          {view.bleepId && (
            <button className="btn small" tabIndex={isActive ? 0 : -1} aria-pressed={isListened} aria-label={t(PRIVACY_COPY.review.listenRow, { title })} data-testid="review-listen" onClick={() => onListen(itemKey)}>
              {t(PRIVACY_COPY.review.listen)}
            </button>
          )}
        </span>
      )}
      {parts && (
        <button
          className="btn ghost review-toggle"
          tabIndex={isActive ? 0 : -1}
          aria-expanded={expanded}
          aria-controls={partsId}
          aria-label={t(expanded ? 'review.row.hideParts' : 'review.row.showParts', { count: parts.length, n: fmt.count(parts.length), title })}
          data-testid="review-toggle"
          ref={toggleRef}
          onClick={() => onToggle(itemKey, toggleRef.current)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={expanded ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
          </svg>
        </button>
      )}
      {parts && expanded && (
        <ul id={partsId} className="review-parts" aria-label={title}>
          {parts.map((p) => (
            <li key={p.key} className={`review-part ${p.status}`} data-member-key={p.key} data-testid="review-part" data-status={p.status}>
              {isPrivate ? (
                // A place plays its own stretch (auto-blur §2.7).
                <button type="button" className="review-text review-part-play" tabIndex={isActive ? 0 : -1} onClick={() => onPlayPart(itemKey, p.key)} data-testid="review-part-play">
                  <span className="review-title">{p.title}</span>
                  <span className="review-meta">
                    {p.time} · {statusWord(p.status)}
                  </span>
                  {p.badges?.map((b) => (
                    <span key={b} className="review-badge">
                      {b}
                    </span>
                  ))}
                </button>
              ) : (
                <span className="review-text">
                  <span className="review-title">{p.title}</span>
                  <span className="review-meta">
                    {p.time} · {statusWord(p.status)}
                  </span>
                </span>
              )}
              {p.status === 'pending' ? (
                <span className="review-actions">
                  <button className="btn" tabIndex={isActive ? 0 : -1} aria-label={keepLabel(p.title)} data-testid="review-part-keep" onClick={() => onPartAct(itemKey, p.key, 'keep')}>
                    {keepText}
                  </button>
                  <button className="btn" tabIndex={isActive ? 0 : -1} aria-label={removeLabel(p.title)} data-testid="review-part-remove" onClick={() => onPartAct(itemKey, p.key, 'remove')}>
                    {removeText}
                  </button>
                </span>
              ) : (
                <ReviewMark status={p.status} />
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
})

/** Kept (with a tick) or Removed, where Keep and Remove were. */
function ReviewMark({ status }: { status: ReviewStatus }): JSX.Element {
  return (
    <span className={`review-mark ${status}`}>
      {status === 'kept' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12l5 5 9-10" />
        </svg>
      )}
      {status === 'kept' ? t('review.mark.kept') : t('review.mark.removed')}
    </span>
  )
}

/**
 * The confirms of auto-blur's Uncover all and Done reviewing (docs/design/auto-blur.md §2.7, §11): a
 * small alert dialog in the panel, its focus first on Cancel (the button that changes nothing); Esc
 * is Cancel and stays in the panel.
 */
function ReviewConfirm({ text, detail, action, onAnswer }: { text: string; detail?: string; action: string; onAnswer: (go: boolean) => void }): JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus()
  }, [])
  return (
    <div
      className="review-confirm"
      role="alertdialog"
      aria-labelledby="review-confirm-text"
      aria-describedby={detail ? 'review-confirm-detail' : undefined}
      data-testid="review-confirm"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onAnswer(false)
      }}
    >
      <p id="review-confirm-text">{text}</p>
      {detail && <p id="review-confirm-detail">{detail}</p>}
      <div className="review-confirm-actions">
        <button ref={cancel} type="button" className="btn" onClick={() => onAnswer(false)} data-testid="review-confirm-cancel">
          {t('common.action.cancel')}
        </button>
        <button type="button" className="btn primary" onClick={() => onAnswer(true)} data-testid="review-confirm-go">
          {action}
        </button>
      </div>
    </div>
  )
}
