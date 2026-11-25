import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { dragAnnotationTimes } from '../../../shared/editor/annotations'
import { deleteCovers, moveCoverTime, setCoverEnds } from '../../../shared/editor/coverEdit'
import { followsText } from '../../../shared/editor/coverGroup'
import { itemKey, toggleKey, type ItemKey } from '../../../shared/editor/multiSelect'
import { sameSpan } from '../../../shared/editor/snapping'
import { overlaps } from '../../../shared/editor/timelineScale'
import { pathKeys } from '../../../shared/privacy/coverPath'
import { kindTitle, PRIVACY_COPY } from '../../../shared/privacy/copy'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import type { Cover, PrivateKind } from '../../../shared/types'
import { useEditor } from '../editor/context'
import { releaseFocus } from '../editor/focus'
import { useGroup } from '../editor/groupContext'
import type { TrackSlotProps } from '../editor/LayoutTrack'
import { followPointer } from '../editor/pointer'
import { CoverGlyph } from './CoverShapeButton'
import './covers.css'

const NO_COVERS: Cover[] = []

/** One bar of the row: a cover, or a group's covers that overlap in time (§2.3). */
export interface CoverBar {
  key: string
  ids: string[]
  start: number
  end: number
  kind: PrivateKind | undefined
  /** A suggestion waits for review in it; one is a Check suggestion; one covers a lost area. */
  waiting: boolean
  check: boolean
  lost: boolean
  /** Where its path changes (each key inside it), source seconds. */
  keys: number[]
}

/** A span Find read less often (§5.4): a mark under the row. */
export interface ThinMark {
  start: number
  end: number
}

/** The row's bars (§2.3), by start: each cover, with the covers of one group that overlap in time joined into one bar. */
export function coverBars(covers: readonly Cover[]): CoverBar[] {
  const lone: CoverBar[] = []
  const groups = new Map<string, Cover[]>()
  const barOf = (cs: Cover[]): CoverBar => ({
    key: cs.map((c) => c.id).join('+'),
    ids: cs.map((c) => c.id),
    start: Math.min(...cs.map((c) => c.start)),
    end: Math.max(...cs.map((c) => c.end)),
    kind: cs[0].kind,
    waiting: cs.some((c) => !!c.found),
    check: cs.some((c) => c.found === 'check'),
    lost: cs.some((c) => !!c.lost),
    keys: cs.flatMap((c) => pathKeys(c).map((k) => k.t).filter((x) => x > c.start && x < c.end))
  })
  for (const c of covers) {
    if (!c.group) lone.push(barOf([c]))
    else groups.set(c.group, [...(groups.get(c.group) ?? []), c])
  }
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.start - b.start)
    let run: Cover[] = []
    let end = -Infinity
    for (const c of sorted) {
      if (run.length && c.start >= end) {
        lone.push(barOf(run))
        run = []
      }
      run.push(c)
      end = Math.max(run.length > 1 ? end : -Infinity, c.end)
    }
    if (run.length) lone.push(barOf(run))
  }
  return lone.sort((a, b) => a.start - b.start || a.end - b.end || (a.key < b.key ? -1 : 1))
}

/** The spans of the last Find's `thin` ("start end;…"). */
export function thinMarks(thin: string | undefined): ThinMark[] {
  if (!thin) return []
  const out: ThinMark[] = []
  for (const pair of thin.split(';')) {
    const [a, b] = pair.split(' ').map(Number)
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push({ start: a, end: b })
  }
  return out
}

/** A bar's accessible name (§2.3, §11): a list of fields (kind, start, end, whether it waits or is to check), and the places it joins. */
export function barName(bar: CoverBar): string {
  const span = { start: fmt.clock(bar.start), end: fmt.clock(bar.end) }
  const base = !bar.kind
    ? t(PRIVACY_COPY.track.itemMine, span)
    : bar.check
      ? t(PRIVACY_COPY.track.itemCheck, { ...span, kind: t(kindTitle(bar.kind)) })
      : bar.waiting
        ? t(PRIVACY_COPY.track.itemWaiting, { ...span, kind: t(kindTitle(bar.kind)) })
        : t(PRIVACY_COPY.track.item, { ...span, kind: t(kindTitle(bar.kind)) })
  return bar.ids.length > 1 ? `${base} · ${t(PRIVACY_COPY.track.group, { count: bar.ids.length, n: fmt.count(bar.ids.length) })}` : base
}

/** Grabbable edge width of a bar: never more than a quarter of it (as the other rows). */
const edgeWidth = (w: number): number => Math.max(3, Math.min(8, w * 0.25))

/** Marks at least this far apart (px): where the path changes. */
const MARK_GAP = 4

type Item = { type: 'bar'; bar: CoverBar } | { type: 'thin'; mark: ThinMark }

/**
 * The Covers row of the timeline (docs/design/auto-blur.md §2.3, §11), shown only with a cover:
 * a bar per cover (a group's overlapping covers as one bar with a count), dashed while waiting for
 * review, with the warning edge when to check and hatched over a lost area, thin marks where a path
 * changes, and the spans Find read less often under it. One tab stop with roving focus; selection
 * follows focus. Dragging an end changes it (one undo step per drag); dragging the middle moves a
 * cover with one key, and a cover that follows text says privacy.cover.timeKept.
 */
export function CoverTrack({ px, win, duration, selection, onSelect, scrub, snap, multi }: TrackSlotProps): JSX.Element | null {
  const { store, player } = useEditor()
  const group = useGroup()
  const covers = useSyncExternalStore(store.subscribe, () => store.state.covers) ?? NO_COVERS
  const thin = useSyncExternalStore(store.subscribe, () => store.state.privacy?.find?.thin)
  const fps = useSyncExternalStore(store.subscribe, () => store.state.capture?.fps ?? 60)
  const bars = useMemo(() => coverBars(covers), [covers])
  const marks = useMemo(() => thinMarks(thin), [thin])
  const items = useMemo<Item[]>(
    () => [...bars.map((bar): Item => ({ type: 'bar', bar })), ...marks.map((mark): Item => ({ type: 'thin', mark }))].sort((a, b) => (a.type === 'bar' ? a.bar.start : a.mark.start) - (b.type === 'bar' ? b.bar.start : b.mark.start)),
    [bars, marks]
  )
  const [focused, setFocused] = useState(0)
  const rowRef = useRef<HTMLDivElement>(null)
  /** A key moved the tab stop to an item that was not drawn yet: the render that draws it focuses it. */
  const focusNext = useRef(false)
  const pxRef = useRef(px)
  pxRef.current = px
  const drags = useRef(0)
  const current = Math.min(focused, Math.max(0, items.length - 1))
  // The focus follows the tab stop (§11). The row draws only the items inside the timeline's
  // window, the tab stop and the selected ones, so the item a key moves to may be drawn first by
  // the render that makes it the tab stop; each drawn item carries its index among all the items.
  useEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    rowRef.current?.querySelector<HTMLElement>(`[data-item-index="${current}"]`)?.focus()
  })
  if (!covers.length) return null

  const selected = new Set<string>()
  if (selection?.kind === 'cover') selected.add(selection.id)
  for (const k of group.group.keys) if (k.startsWith('cover:')) selected.add(k.slice(6))
  const keysOf = (bar: CoverBar): ItemKey[] => bar.ids.map((id) => itemKey('cover', id))

  /** Selects a bar's covers: one cover is the single selection, a group's bar every cover of it (§2.3). */
  const selectBar = (bar: CoverBar): void => {
    const keys = keysOf(bar)
    if (keys.length === 1) onSelect({ kind: 'cover', id: bar.ids[0] })
    else group.select(keys, keys[0])
  }

  /**
   * Moves the focus, the tab stop and the selection to item i together (finding 36). The item is
   * found by its own index, never by its place among the drawn items: with the timeline zoomed in,
   * the bars outside its window are not drawn (second review, finding [6]). One not drawn yet is
   * focused by the render that makes it the tab stop, which always draws it.
   */
  const focusItem = (i: number): void => {
    const n = Math.max(0, Math.min(items.length - 1, i))
    setFocused(n)
    const el = rowRef.current?.querySelector<HTMLElement>(`[data-item-index="${n}"]`)
    if (el) el.focus()
    else focusNext.current = true
    const it = items[n]
    if (it?.type === 'bar') selectBar(it.bar)
  }

  /** Shift+Left and Shift+Right: the end nearer the playhead moves by one frame (§2.3). */
  const nudgeEnd = (bar: CoverBar, dir: -1 | 1): void => {
    const frame = 1 / (fps > 0 ? fps : 60)
    const nearStart = Math.abs(player.time - bar.start) <= Math.abs(player.time - bar.end)
    store.update((p) => {
      let q = p
      for (const id of bar.ids) {
        const c = q.covers?.find((x) => x.id === id)
        if (!c) continue
        if (nearStart && c.start === bar.start) q = setCoverEnds(q, id, c.start + dir * frame, c.end)
        else if (!nearStart && c.end === bar.end) q = setCoverEnds(q, id, c.start, c.end + dir * frame)
      }
      return q
    }, `cover-end-key:${bar.key}`)
  }

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const it = items[current]
    if (!it) return
    let handled = true
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      if (e.shiftKey && it.type === 'bar') nudgeEnd(it.bar, dir)
      else focusItem(current + dir)
    } else if (e.key === 'Home') focusItem(0)
    else if (e.key === 'End') focusItem(items.length - 1)
    else if (e.key === 'Enter') {
      if (it.type === 'thin') player.seek(it.mark.start)
      else if (e.ctrlKey || e.metaKey) {
        const r = toggleKey(group.group.keys, group.single, keysOf(it.bar)[0], group.group.anchor)
        group.select(r.keys, r.anchor)
      } else selectBar(it.bar)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (it.type !== 'bar') return
      store.update((p) => deleteCovers(p, it.bar.ids))
      group.notice(t(PRIVACY_COPY.cover.uncovered))
      // The item that takes its place (the one after it, or before it at the end) becomes the tab
      // stop: it takes the focus once drawn, and the selection with it.
      const next = items[current + 1] ?? items[current - 1]
      if (next?.type === 'bar') selectBar(next.bar)
      else group.select([], null)
      focusNext.current = true
    } else if (e.key === 'Escape') rowRef.current?.focus()
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const dragMode = (e: ReactPointerEvent): 'move' | 'start' | 'end' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const edge = edgeWidth(r.width)
    if (e.clientX - r.left < edge) return 'start'
    if (r.right - e.clientX < edge) return 'end'
    return 'move'
  }

  const onBarDown = (bar: CoverBar, index: number) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const mode = dragMode(e)
    if (multi?.press(e, keysOf(bar)[0], mode)) return
    setFocused(index)
    selectBar(bar)
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
    const p0 = store.state
    const initial = { start: bar.start, end: bar.end }
    const sx = e.clientX
    const s = snap.begin(e, { exclude: bar.ids.map((id) => ({ owner: `cover:${id}` })) })
    const followed = bar.ids.some((id) => {
      const c = p0.covers?.find((x) => x.id === id)
      return !!c && followsText(c)
    })
    const mergeKey = `cover-drag:${bar.key}:${++drags.current}`
    let moved = false
    let warned = false
    store.beginGesture()
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) <= 3) return
        moved = true
        if (mode === 'move' && followed) {
          // A cover that follows text keeps its times (§2.3): its ends can still be dragged.
          if (!warned) group.notice(t(PRIVACY_COPY.cover.timeKept))
          warned = true
          return
        }
        const times = s.span(ev, initial, mode, (ev.clientX - sx) / pxRef.current, (d) => dragAnnotationTimes(initial, mode, d, duration))
        store.update((p) => {
          let q = p
          for (const id of bar.ids) {
            const c0 = p0.covers?.find((x) => x.id === id)
            const now = q.covers?.find((x) => x.id === id)
            if (!c0 || !now) continue
            if (mode === 'move') {
              const next = moveCoverTime(q, id, c0.start + (times.start - initial.start) - now.start)
              if (next) q = next
            } else if (mode === 'start' && c0.start === initial.start) {
              if (!sameSpan(now, { start: times.start, end: now.end })) q = setCoverEnds(q, id, times.start, now.end)
            } else if (mode === 'end' && c0.end === initial.end) {
              if (!sameSpan(now, { start: now.start, end: times.end })) q = setCoverEnds(q, id, now.start, times.end)
            }
          }
          return q
        }, mergeKey)
      },
      () => {
        store.endGesture()
        // A plain click shows the cover on the preview.
        if (!moved && (player.time < bar.start || player.time >= bar.end)) player.seek(bar.start + Math.min(0.5, (bar.end - bar.start) / 2))
      }
    )
  }

  const onBackgroundDown = (e: ReactPointerEvent): void => {
    if (multi?.background(e, 'covers')) return
    if (e.button !== 0) return
    onSelect(null)
    scrub(e)
  }

  return (
    <div
      ref={rowRef}
      className="tl-track cover-track"
      data-testid="cover-track"
      role="listbox"
      aria-label={t(PRIVACY_COPY.track.title)}
      aria-multiselectable="true"
      tabIndex={-1}
      onPointerDown={onBackgroundDown}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) => {
        if (it.type === 'thin') {
          const name = t(PRIVACY_COPY.track.thin, { start: fmt.clock(it.mark.start), end: fmt.clock(it.mark.end) })
          if (!overlaps(it.mark, win) && i !== current) return null
          return (
            <div
              key={`thin:${it.mark.start}`}
              data-cover-item=""
              data-item-index={i}
              role="option"
              aria-selected={false}
              aria-label={name}
              title={name}
              tabIndex={i === current ? 0 : -1}
              className="cover-thin-mark"
              style={{ left: it.mark.start * px, width: Math.max(2, (it.mark.end - it.mark.start) * px) }}
              onFocus={() => setFocused(i)}
              onPointerDown={(e) => {
                e.stopPropagation()
                if (e.button === 0) player.seek(it.mark.start)
              }}
            />
          )
        }
        const bar = it.bar
        const on = bar.ids.some((id) => selected.has(id))
        if (!overlaps(bar, win) && !on && i !== current) return null
        const w = Math.max(2, (bar.end - bar.start) * px)
        const name = barName(bar)
        // Where the path changes, at most one mark every MARK_GAP px.
        const ticks: number[] = []
        let last = -Infinity
        for (const k of [...bar.keys].sort((a, b) => a - b)) {
          const x = (k - bar.start) * px
          if (x - last < MARK_GAP) continue
          ticks.push(x)
          last = x
        }
        const inGroup = bar.ids.some((id) => group.keys.has(itemKey('cover', id)))
        return (
          <div
            key={bar.key}
            data-cover-item=""
            data-item-index={i}
            data-cover={bar.ids[0]}
            data-start={bar.start}
            data-end={bar.end}
            role="option"
            aria-selected={on}
            aria-label={name}
            title={name}
            tabIndex={i === current ? 0 : -1}
            className={`seg cover-seg${bar.waiting ? ' waiting' : ''}${bar.check ? ' check' : ''}${bar.lost ? ' lost' : ''}${on ? ' selected' : ''}${inGroup ? ' in-group' : ''}`}
            style={{ left: bar.start * px, width: w, ['--edge' as string]: `${edgeWidth(w)}px` }}
            onFocus={() => setFocused(i)}
            onPointerDown={onBarDown(bar, i)}
          >
            <span className="edge left" />
            {w > 22 && (
              <span className="seg-icon">
                <CoverGlyph size={13} />
              </span>
            )}
            {bar.ids.length > 1 && (
              <span className="cover-count-badge" aria-hidden="true">
                {fmt.count(bar.ids.length)}
              </span>
            )}
            {ticks.map((x) => (
              <span key={x} className="cover-key-mark" style={{ left: x }} aria-hidden="true" />
            ))}
            <span className="edge right" />
          </div>
        )
      })}
    </div>
  )
}

/** Its row label in the timeline's label column, shown with the row. */
export function CoverTrackLabel(): JSX.Element | null {
  const { store } = useEditor()
  const has = useSyncExternalStore(store.subscribe, () => !!store.state.covers?.length)
  if (!has) return null
  return (
    <div className="tl-label cover-label" title={t(PRIVACY_COPY.track.title)}>
      <CoverGlyph size={16} />
    </div>
  )
}
