/**
 * The timeline's gesture controller for selecting several items (E-06, docs/design/multi-select.md
 * §4.2, §4.3, §4.8): Ctrl+click toggles, Shift+click extends a run on one track, a drag of a member
 * (or a Ctrl/Shift drag) moves the whole group, Shift or Ctrl+drag on empty track space draws a box,
 * and a Ctrl+press on a kind that cannot join keeps the group with a notice.
 *
 * Each block handler calls `press` on its first line, each empty-space handler `background`, each
 * non-groupable press `refuse`; a call that returns false leaves the press to today's handler, so a
 * press without Ctrl or Shift works exactly as before. Built once (stable identity), reading the
 * group, the store and the timeline's refs through `get()`, like the snapping controller.
 */
import { useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { groupAccepts, groupMovePlan, groupSnapPoints, moveGroup, type StopReason } from '../../../shared/editor/groupMove'
import {
  extendTo,
  parseItemKey,
  projectItems,
  rectsHit,
  toggleKey,
  trackOfKind,
  unionKeys,
  type ItemKey,
  type ItemTrack,
  type KeyRect
} from '../../../shared/editor/multiSelect'
import { REFUSAL_TEXT, stopNotice, type RefusedKind } from '../../../shared/editor/multiSelectCopy'
import type { DragMode } from '../../../shared/editor/snapping'
import { useEditor, type EditorServices } from './context'
import { releaseFocus } from './focus'
import { useGroup, type GroupApi } from './groupContext'
import { revealItem } from './playheadItems'
import { followPointer } from './pointer'
import type { Selection } from './selection'
import type { SnapController, SnapSession } from './snapControl'
import { showTitle } from './titleItems'

export type { RefusedKind } from '../../../shared/editor/multiSelectCopy'

export interface MultiSelect {
  has(key: string): boolean
  isAnchor(key: string): boolean
  /** First line of a groupable block's pointerdown: true when it took the press (toggle, extend, collapse, group drag). */
  press(e: ReactPointerEvent, key: ItemKey, mode: DragMode): boolean
  /** First line of a non-groupable press: true when a group exists, Ctrl is held, and it showed the notice. */
  refuse(e: ReactPointerEvent, what: RefusedKind): boolean
  /** First line of an empty-space handler: true when Shift or Ctrl started a box (or a modifier click that does nothing). */
  background(e: ReactPointerEvent, track: ItemTrack | null): boolean
  /** The track of the last press any of these saw (the clip track counts as freezes; captions and layouts as none). */
  lastTrack(): ItemTrack | null
  /**
   * True while a press this controller took is held (a box, or a group click or drag): the box reads
   * the blocks' rectangles once and a group drag converts pixels at the scale it started with, so
   * the timeline must not zoom or scroll until the button is released.
   */
  busy(): boolean
}

interface Deps {
  snap: SnapController
  pxRef: RefObject<number>
  dragging: MutableRefObject<boolean>
  contentRef: RefObject<HTMLDivElement>
  boxRef: RefObject<HTMLDivElement>
  /** The timeline's single selection and its setter (Esc during a box puts the previous one back). */
  selection: Selection
  onSelect: (sel: Selection) => void
}

type Current = Deps & EditorServices & { group: GroupApi }

/** Pointer movement (px) under which a press is a click (as the timeline's drags). */
const SLOP = 3

/** Blocks the box can select, by the data attribute their element carries. */
const BLOCKS: readonly [attr: string, kind: Parameters<typeof trackOfKind>[0]][] = [
  ['zoom', 'zoom'],
  ['annotation', 'annotation'],
  ['shape', 'shape'],
  ['spotlight', 'spotlight'],
  ['title', 'title'],
  ['chapter', 'chapter'],
  ['freeze', 'freeze']
]
const BLOCK_SELECTOR = BLOCKS.map(([a]) => `[data-${a}]`).join(', ')

/** The rendered groupable blocks' rectangles, relative to `content` (read once per box; the pieces of a freeze share its key). */
function blockRects(content: HTMLElement): KeyRect[] {
  const c = content.getBoundingClientRect()
  const out: KeyRect[] = []
  content.querySelectorAll<HTMLElement>(BLOCK_SELECTOR).forEach((el) => {
    const hit = BLOCKS.find(([a]) => el.dataset[a] !== undefined)
    const id = hit ? el.dataset[hit[0]] : undefined
    if (!hit || !id) return
    const r = el.getBoundingClientRect()
    out.push({ key: `${hit[1]}:${id}` as ItemKey, x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height })
  })
  return out
}

const sameKeys = (a: readonly ItemKey[] | null, b: readonly ItemKey[]): boolean => !!a && a.length === b.length && a.every((k, i) => k === b[i])

/** What a plain click on the item does today, after the group collapses to it: shows it on the preview. */
function plainClick({ store, player }: EditorServices, key: ItemKey): void {
  const k = parseItemKey(key)
  if (!k) return
  const p = store.state
  switch (k.kind) {
    case 'annotation': {
      const a = p.annotations.find((x) => x.id === k.id)
      if (a && (player.time < a.start || player.time >= a.end)) player.seek(a.start + Math.min(0.5, (a.end - a.start) / 2))
      return
    }
    case 'shape': {
      const s = p.shapes?.find((x) => x.id === k.id)
      if (s) revealItem(player, p.clips, s, s.kind)
      return
    }
    case 'spotlight': {
      const s = p.spotlights?.find((x) => x.id === k.id)
      if (s) revealItem(player, p.clips, s, 'spotlight')
      return
    }
    case 'title': {
      const c = p.titles?.find((x) => x.id === k.id)
      if (c) showTitle(player, p.clips, c)
      return
    }
    case 'chapter': {
      const c = p.chapters?.find((x) => x.id === k.id)
      if (c) player.seek(c.t)
      return
    }
    case 'freeze': {
      const f = p.freezes?.find((x) => x.id === k.id)
      if (f) player.seek(f.at)
      return
    }
    case 'zoom':
      return
  }
}

function createMultiSelect(get: () => Current): MultiSelect {
  let last: ItemTrack | null = null
  let held = false
  /** Each group drag's undo merge key is its own. */
  let drags = 0

  const take = (e: ReactPointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
  }

  /** The keys a gesture starts from: the group's, else the single groupable selection's. */
  const baseKeys = (g: GroupApi): ItemKey[] => (g.group.keys.length ? [...g.group.keys] : g.single ? [g.single] : [])

  /** Moves `keys` with the pointer from `sx`: one plan per press, snapping, block limits, one undo step. */
  const groupDrag = (key: ItemKey, keys: readonly ItemKey[], sx: number, session: SnapSession) => {
    const { store, group } = get()
    const p0 = store.state
    const plan = groupMovePlan(p0, keys)
    const points = groupSnapPoints(plan, key)
    const clamp = (d: number): number => Math.min(plan.max, Math.max(plan.min, d))
    const accepts = (d: number): boolean => groupAccepts(p0, plan, d)
    const mergeKey = `group-move:${++drags}`
    let accepted = 0
    let warned = false
    store.beginGesture()
    return {
      move(ev: PointerEvent): void {
        const px = get().pxRef.current ?? 0
        if (!(px > 0)) return
        const dt = (ev.clientX - sx) / px
        const r = session.group(ev, points, dt, clamp, accepts)
        let delta = r.delta
        let exact = r.exact
        let held: StopReason | null = dt < plan.min - 1e-9 ? plan.minWhy : dt > plan.max + 1e-9 ? plan.maxWhy : null
        if (!accepts(delta)) {
          // A freeze frame would land on another: the block stays where it last could go.
          delta = accepted
          exact = null
          held = 'freeze-taken'
        } else accepted = delta
        if (held && !warned) {
          warned = true
          group.notice(stopNotice(held))
        }
        store.update((q) => moveGroup(q, plan, delta, exact), mergeKey)
      },
      end(): void {
        store.endGesture()
      }
    }
  }

  return {
    has: (key) => get().group.keys.has(key),
    isAnchor: (key) => get().group.group.anchor === key,
    lastTrack: () => last,
    busy: () => held,

    press(e, key, mode) {
      const parsed = parseItemKey(key)
      if (!parsed || e.button !== 0) return false
      last = trackOfKind(parsed.kind)
      const d = get()
      const toggle = e.ctrlKey || e.metaKey
      const extend = e.shiftKey && !toggle
      const member = d.group.keys.has(key)
      // Without a modifier only a member's middle is taken; its edges trim it alone, as today.
      if (!toggle && !extend && (!member || mode !== 'move')) return false
      take(e)
      d.dragging.current = true
      held = true
      // What a drag moves: the group, with the pressed item added when it is not in it yet.
      const dragKeys = member ? [...d.group.group.keys] : unionKeys(baseKeys(d.group), [key])
      const session = d.snap.begin(e, { group: dragKeys })
      const sx = e.clientX
      let drag: ReturnType<typeof groupDrag> | null = null
      followPointer(
        e,
        (ev) => {
          if (!drag) {
            if (Math.abs(ev.clientX - sx) <= SLOP) return
            if (!member) get().group.select(dragKeys, key)
            drag = groupDrag(key, dragKeys, sx, session)
          }
          drag.move(ev)
        },
        () => {
          get().dragging.current = false
          held = false
          if (drag) return drag.end()
          const now = get()
          const g = now.group
          if (toggle) {
            const r = toggleKey(g.group.keys, g.single, key, g.group.anchor)
            g.select(r.keys, r.anchor)
          } else if (extend) {
            const r = extendTo(g.group.keys, g.group.anchor, g.single, key, projectItems(now.store.state))
            g.select(r.keys, r.anchor)
          } else {
            // A plain click on a member: that item alone, then what a click on it does today.
            g.select([key], key)
            plainClick(now, key)
          }
        }
      )
      return true
    },

    refuse(e, what) {
      last = what === 'clip' || what === 'click' ? 'freezes' : null
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false
      const { group } = get()
      if (group.group.keys.length < 2) return false
      e.preventDefault()
      e.stopPropagation()
      group.notice(REFUSAL_TEXT[what])
      return true
    },

    background(e, track) {
      last = track
      const toggle = e.ctrlKey || e.metaKey
      if (e.button !== 0 || (!toggle && !e.shiftKey)) return false
      take(e)
      const d = get()
      const content = d.contentRef.current
      const box = d.boxRef.current
      if (!content || !box) return true
      d.dragging.current = true
      held = true
      const before = { keys: baseKeys(d.group), anchor: d.group.group.anchor ?? d.group.single, selection: d.selection }
      const base = toggle ? before.keys : []
      const c0 = content.getBoundingClientRect()
      const x0 = e.clientX - c0.left
      const y0 = e.clientY - c0.top
      let rects: KeyRect[] | null = null
      let starts: Map<ItemKey, number> | null = null
      let shown: ItemKey[] | null = null
      let done = false

      const finish = (): void => {
        done = true
        held = false
        box.hidden = true
        get().dragging.current = false
        window.removeEventListener('keydown', onKey, true)
      }
      // Esc while drawing puts the selection from before the press back.
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopImmediatePropagation()
        stop()
        finish()
        const g = get().group
        if (!rects) return
        if (before.keys.length) g.select(before.keys, before.anchor, { reveal: false })
        else get().onSelect(before.selection)
      }
      window.addEventListener('keydown', onKey, true)
      const stop = followPointer(
        e,
        (ev) => {
          if (done) return
          if (!rects && Math.max(Math.abs(ev.clientX - e.clientX), Math.abs(ev.clientY - e.clientY)) <= SLOP) return
          if (!rects) {
            // Read once: content-relative rectangles do not change while the timeline cannot zoom or scroll (busy()).
            rects = blockRects(content)
            starts = new Map(projectItems(get().store.state).map((x) => [x.key, x.start]))
            box.hidden = false
          }
          const c = content.getBoundingClientRect()
          const x1 = ev.clientX - c.left
          const y1 = ev.clientY - c.top
          box.style.left = `${Math.min(x0, x1)}px`
          box.style.top = `${Math.min(y0, y1)}px`
          box.style.width = `${Math.abs(x1 - x0)}px`
          box.style.height = `${Math.abs(y1 - y0)}px`
          const hits = rectsHit(rects, { x0, y0, x1, y1 })
          const keys = unionKeys(base, hits)
          if (sameKeys(shown, keys)) return
          shown = keys
          // The hit that starts first anchors the next Shift+click; with no hits the anchor stays.
          const first = hits.reduce<ItemKey | null>((a, k) => (a === null || (starts!.get(k) ?? Infinity) < (starts!.get(a) ?? Infinity) ? k : a), null)
          get().group.select(keys, first ?? before.anchor)
        },
        () => {
          // A press that never moved does nothing: the selection and the playhead stay.
          if (!done) finish()
        }
      )
      return true
    }
  }
}

/** The Timeline's multi-select controller, built once (refs keep it current). */
export function useMultiSelect(deps: Deps): MultiSelect {
  const services = useEditor()
  const group = useGroup()
  const ref = useRef<Current>({ ...deps, ...services, group })
  ref.current = { ...deps, ...services, group }
  const [controller] = useState(() => createMultiSelect(() => ref.current))
  return controller
}
