# Snapping (E-05)

Part of Wave 6, "Easier editing". The shared rules for this wave (file ownership, the shared files, merge order and the keymap) are in [editing-wins.md](editing-wins.md).

Roadmap item: `docs/ROADMAP.md` E-05 (next, size S).

When you drag something on the timeline, the edge you are moving snaps to useful places:

- cuts, splits and trims;
- recorded clicks;
- chapter flags;
- freeze frames (E-11);
- the playhead;
- the edges of every other item on every track;
- the start and end of the recording.

A thin guide line with a small label ("Cut · 0:04.0") shows what the edge snapped to. Hold Alt during a drag to place the item freely. Snapping is on by default. To turn it off, use the magnet button in the timeline header, the palette command **Snapping** or `N`. This computer remembers the choice.

Snapping only chooses the numbers that an existing drag writes. It adds nothing to `project.json`, does not change rendering, and adds no undo step of its own.

---

## 1. What the user gets

- **Segment drags snap.** This covers moving and trimming zooms, text, shapes and spotlights, title cards, captions and camera layouts. The edge being moved snaps to the nearest target within **8 px**. A move uses the start or end, whichever is nearer a target.
- **Other drags snap too.** Chapter flags, the two trim handles and both ends of a Shift+drag range snap.
- **The playhead snaps while scrubbing.** This works on the ruler, on the playhead and on empty track space, once the pointer has moved 3 px. A plain click still seeks exactly where you clicked.
- **Alt turns snapping off for the drag.** Alt is read on every pointer move, so pressing or releasing it mid-drag takes effect on the next move. Alt+drag on the clip track already selects a range (`Timeline.tsx:344`); that range never snaps.
- **Snapped values are exact.** A zoom snapped to a cut has `zoom.end === clip.end`, bit for bit.

---

## 2. Decisions

| # | Topic | Decision | Why |
|---|-------|----------|-----|
| 1 | Time base | Targets, dragged edges and the threshold are all in **source seconds**. | The timeline is drawn in source time. `Timeline` is documented as a "Source-time timeline", and every block is at `left: t * px`. `TrackSlotProps.px` is "Pixels per second of source time" (`LayoutTrack.tsx`), so one pixel is the same number of seconds everywhere, cuts included. Overlays, clicks and chapters are all stored in source time (`engine/timeline.ts` header). **Rejected:** output time. Cut ranges have no output time (`sourceToOutput` returns null), and every target would need mapping there and back. |
| 2 | Threshold | Catch at **8 px**, release at **12 px**, both converted with the current scale (`8 / px`). | It matches what the user sees at every zoom level. **Rejected:** a fixed number of seconds. 0.1 s is under 1 px at fit and 40 px at `MAX_PX_PER_SEC = 400` (`timelineScale.ts`). |
| 3 | Hysteresis | The target that caught the edge holds it until the edge is more than 12 px away, and it wins ties. | No flicker at the 8 px border or between two close targets. |
| 4 | Several targets in range | The nearest in pixels wins. Distances within **0.5 px** count as equal. A tie goes to the current target, then the kind priority (#5), then the lower point index (start before end), then the earlier time. | **Rejected:** strict priority, because a far cut would beat a near click. The tie rules make the result deterministic and testable. |
| 5 | Kind priority | playhead > clip edges (cut, split, trim) > freeze frame > chapter > click > other items' edges > recording start/end. | The playhead and cuts are the most deliberate places. The recording's ends are already clamps in every drag helper. |
| 6 | Clicks | Only **used** clicks are targets: `ClickRow.ignored === null`. Every button counts, since `clickRows` in `engine/inputData.ts` keeps all in-video clicks. | An ignored click drives nothing and is drawn dashed. It is usually a stray click. |
| 7 | Target collection | Targets are collected **once, at pointerdown**, from `store.state`. They are sorted and merged within 1e-6 s into a `Float64Array`. Each move does a binary search. | The dragged item changes on every move. Collecting at press time uses the other items as they were, at O(log n) per move. |
| 8 | Own edges | Excluded by owner key: `zoom:<id>`, `annotation:<id>`, `shape:<id>`, `spotlight:<id>`, `title:<id>`, `caption:<id>`, `layout:<id>`, `chapter:<id>`, `trim:start`, `trim:end`. A layout drag also excludes the shared edges of its `stayAround` neighbours (the `before` end and the `after` start), because `dragLayout` moves those edges with it. | An edge must never snap to itself or to an edge that follows it. |
| 9 | Playhead as target | Only when the player is not moving at pointerdown (`player.moving === false`: not playing and, once E-08 lands, not shuttling in reverse). It is never a target for a scrub, which moves the playhead itself, or for a trim drag, which seeks the playhead to the edge (`Timeline.tsx:393`). | A moving target cannot be caught reliably. |
| 10 | Where snapping applies | The pure `snapSpan` snaps the **raw `dt`** and then calls the unchanged helper (`dragZoomTimes`, `dragAnnotationTimes`, `dragShapeTimes`, `dragTitleTimes`, `dragCaptionTimes` or `dragLayoutTimes`), which still clamps. **Rejected:** a snap parameter on six helpers in five modules. | No helper or helper test changes. Bounds and minimum lengths behave as they do now. |
| 11 | Snap lost to a clamp | If the clamp moves the snapped edge off its target (a neighbour bound, a minimum length), `snapSpan` returns the **unsnapped** result `resolve(dt)`. It shows no guide and clears the current target. Point drags take a `limit` and ignore targets outside it. | The edge never jumps to a place the pointer did not ask for. The guide shows only when the edge really sits on the target. |
| 12 | Exactness | The snapped edge is written as `target.t` exactly. In a move, the other edge is `target.t ± (initial.end − initial.start)`, the same length the helpers keep (`end = start + len`). A point drag returns `target.t`. | `start + (dt + delta)` is not always `T` in floating point. Visibility tests are half-open, as in `titleVisibleAt`'s `t >= start && t < end`. `exportFrameTimes` samples `c.start` exactly whenever a frame falls on a clip's output start. A title snapped to a clip start must then show on that frame in both preview and export. |
| 13 | Scrubbing | The press seeks exactly as today. Snapping starts once the pointer has moved **3 px** from the press, and stays on for the rest of the scrub. | A click on the ruler goes where you clicked, and scrubbing still finds cuts and chapters, also back near the press point. |
| 14 | Turning it off | Alt (live, `ev.altKey`) plus a persistent toggle. **Rejected:** Ctrl, because Ctrl+wheel zooms the timeline. **Rejected:** Shift, because Shift+drag selects a range. | Alt is the convention the roadmap names. The app is Windows only, so macOS Option is not a concern. |
| 15 | Where the toggle is stored | `localStorage['editor-snapping']`: `'0'` means off, anything else means on. Every read and write is in try/catch. This follows `CommandPalette.tsx` (`RECENT_KEY = 'editor-recent-commands'`). | **Rejected:** `project.json`. Snapping is not an edit, and storing it would dirty the project and its undo history. **Rejected:** `editor-prefs.json`. It needs a new `PrefKey` in `PREF_KEYS` (`src/shared/api/prefs.ts`, imported by `src/main/prefsIpc.ts`), and it is an async IPC read, while pointerdown needs the value synchronously. **Rejected:** app settings, because `src/shared/recording/settings.ts` belongs to the teleprompter team. |
| 16 | Default key | `N`. It is free in `DEFAULT_KEYMAP`, and DaVinci Resolve and Final Cut use it for snapping. `S` is split. | See section 6 for the conflict check. |
| 17 | Drawing the guide | One `.snap-guide` element in `.tl-content`, moved by direct DOM writes (`style.transform`, `textContent`), as `placePlayhead` moves the playhead. | No React state per move, so the memoised `Timeline` does not re-render 60 times a second. |
| 18 | Off-screen edges | A dragged edge outside the visible scroll window cannot be caught. | Snapping something the user cannot see is confusing. The timeline does not scroll during a drag (`placePlayhead` checks `dragging.current`), so the window is fixed for the whole drag. |
| 19 | Pure core | Choosing, clamp fallback and exactness live in pure `src/shared/editor/snapping.ts` (`snapSpan`, `snapAt`). The renderer session only gates, tracks the current target and draws. | vitest runs with `environment: 'node'` (`vitest.config.ts`), so DOM code is not unit-testable. This keeps every numeric rule under unit tests. |

---

## 3. Data model

**No project data changes.** `src/shared/types.ts`, `migrateProject` and every sanitiser stay untouched. Projects made before E-05 open and export byte for byte as before. Snapping only decides the numbers that existing edits write.

- **Style presets.** "Save as default style" and style presets do not carry snapping. `stylePresets.ts` and `styleDefaults.ts` are untouched, because snapping is an editor preference, not part of the project's look.
- **Toggle storage.** `localStorage['editor-snapping']` holds `'1'` or `'0'`. A missing or unreadable value means on. It is stored per user profile, in Electron's userData Local Storage, so a fresh e2e `HOME` starts with snapping on.

```ts
// src/shared/editor/snapping.ts
import type { ClickRow } from '../engine/inputData'
import type { Chapter, Clip, Project } from '../types'

export const SNAP = {
  /** A target this close to a dragged edge (screen px) catches it. */
  enterPx: 8,
  /** A caught target holds until the edge is further than this (screen px). */
  leavePx: 12,
  /** Distances closer than this (px) are equal: current, priority, point order, time decide. */
  tiePx: 0.5,
  /** Scrubbing snaps once the pointer has moved at least this far from the press (px). */
  scrubSlopPx: 3,
  /** Targets closer than this (s) are one target. */
  mergeS: 1e-6,
  /** A resolved edge further than this (s) from its target lost the snap to a clamp. */
  exactS: 1e-9
} as const

export type SnapKind = 'playhead' | 'clip' | 'freeze' | 'chapter' | 'click' | 'segment' | 'bound'
/** Lower wins a tie. */
export const SNAP_PRIORITY: Readonly<Record<SnapKind, number>> =
  { playhead: 0, clip: 1, freeze: 2, chapter: 3, click: 4, segment: 5, bound: 6 }

export type SnapEdge = 'start' | 'end' | 'at'
export type DragMode = 'move' | 'start' | 'end'
export interface Span { start: number; end: number }

export interface SnapTarget {
  /** Source seconds. */
  t: number
  kind: SnapKind
  /** "Cut", "Split", "Trim", "Click", "Chapter · Intro", "Zoom start", "Playhead", "Start", "End", "Freeze frame". */
  label: string
  /** Owner key ('zoom:z1', 'trim:start', 'clips', 'chapter:h1', …); none for clicks, the playhead and the ends. */
  owner?: string
  edge?: SnapEdge
}

/** One block on a timeline track. */
export interface SnapSegment { owner: string; label: string; start: number; end: number }

export interface SnapSources {
  duration: number
  clips: readonly Clip[]
  /** Source times of used (not ignored) in-video clicks. */
  clicks: readonly number[]
  chapters: readonly Chapter[]
  segments: readonly SnapSegment[]
  /** Source times of freeze frames (E-11); [] until E-11 lands. */
  freezes: readonly number[]
  /** Playhead (source s), or null when it is not a target. */
  playhead: number | null
}

/** Leaves out an owner's targets: all of them, or one edge. */
export interface SnapExclude { owner: string; edge?: SnapEdge }

export interface SnapIndex {
  /** Sorted ascending, merged within SNAP.mergeS; times[i] === targets[i].t. */
  times: Float64Array
  targets: readonly SnapTarget[]
}

/** What one move sees: scale, the target holding the edge (hysteresis), the visible window. */
export interface SnapView {
  pxPerSec: number
  current: SnapTarget | null
  /** Source seconds; null = no limit. */
  visible?: { start: number; end: number } | null
}

export interface SnapResult {
  /** Seconds to add to the dragged time(s); 0 when nothing caught. */
  delta: number
  target: SnapTarget | null
  /** Index into `points` of the edge that caught it, or -1. */
  point: number
}
```

---

## 4. Algorithms and behaviour

### 4.1 Targets: `projectSnapSources` and `buildSnapIndex`

`projectSnapSources(p, rows, { playhead, layouts, freezes })` builds the sources:

- `clips` is `p.clips`.
- `clicks` is `rows.filter((r) => r.ignored === null).map((r) => r.click.t)`. These are the same rows the timeline draws: the `clickRows` prop, built from `clickRows(recorded, inputEdits)` at `Editor.tsx:235`.
- `chapters` is `p.chapters ?? []`.
- `freezes` is `opts.freezes`, or else `projectFreezeTargets(p)`.
- `segments` comes from `projectSnapSegments(p, { layouts })`:

| Source | Owner | Label |
|---|---|---|
| `p.zooms` | `zoom:<id>` | "Zoom" |
| `p.annotations` | `annotation:<id>` | "Text" |
| `p.shapes` | `shape:<id>` | `shapeLabel(kind)` (`shapes.ts`), e.g. "Arrow", "Blur" |
| `p.spotlights` | `spotlight:<id>` | "Spotlight", or "Cursor spotlight" when `mode === 'cursor'` (as `trackItems` in `Timeline.tsx`) |
| `p.titles` | `title:<id>` | "Title card" |
| `p.transcript?.segments` | `caption:<id>` | "Caption" |
| `p.layouts`, only when `layouts` is true | `layout:<id>` | "Camera layout" |

`layouts` is true only when the camera is present. This is the same test as `useHasCamera` in `LayoutTrack.tsx`: `store.state.hasWebcam && player.webcam !== null`. When the layout track is hidden, its blocks are not targets.

`projectFreezeTargets(p, exclude)` gives the freeze targets: `freezeSnapTargets(p.clips, planOf(p))` (E-11, `engine/freeze.ts`). Those are bare source times without an owner, so an exclude entry `freeze:<id>` cannot remove them in `buildSnapIndex`. Instead, when `exclude` names freezes, the targets come from the plan of the other freezes, `freezeSnapTargets(p.clips, freezePlan(p.clips, others))`. A dragged freeze therefore never catches its own anchor or still end, and E-05 still knows nothing of the plan's internals.

`buildSnapIndex(src, exclude)` emits:

| Kind | Times | Label |
|---|---|---|
| `bound` | `0` and `duration` | "Start", "End" |
| `clip` | every `clip.start` and `clip.end` strictly inside `(0, duration)` | see below |
| `freeze` | each of `src.freezes` | "Freeze frame" |
| `chapter` | `c.t`, owner `chapter:<id>`, edge `at` | "Chapter · <title>", or "Chapter" when the title is empty |
| `click` | each click time | "Click" |
| `segment` | `start` and `end` of each segment, owner and edge set | "<label> start" / "<label> end" |
| `playhead` | `src.playhead`, when not null | "Playhead" |

Clip edge labels:

- The kept start `clips[0].start` has owner `trim:start` and label "Trim". The kept end `clips[last].end` has owner `trim:end` and label "Trim".
- An edge that borders a `timelineGaps` gap of `kind === 'cut'` has owner `clips` and label "Cut".
- An edge where two clips touch has owner `clips` and label "Split".

Then the build:

1. Drops non-finite times and times outside `[0, duration]`.
2. Drops every target matched by an `exclude` entry: equal owner, and the entry has no edge or the same edge.
3. Sorts by time and merges targets closer than `SNAP.mergeS`. The highest-priority target keeps the slot with **its own `t` and label**. A zoom starting 3e-7 s after a cut therefore shows as "Cut", at the cut's exact time.

### 4.2 Choosing: `snapPoints(index, points, view, limit?)`

`points` are the dragged edges after the raw move, from `dragPoints(initial, mode, dt)`:

- `'start'` gives `[start + dt]`.
- `'end'` gives `[end + dt]`.
- `'move'` gives `[start + dt, end + dt]`.
- A point drag passes `[t]`.

The steps:

1. Set `enter = 8 / px`, `leave = 12 / px`, `tie = 0.5 / px`.
2. Skip points outside `view.visible`. For each remaining point `p`, binary-search `times` for targets in `[p − enter, p + enter]`, skipping targets outside `limit` (when given). Each becomes a candidate with distance `|t − p|`.
3. If `view.current` is set and within `limit`, find its smallest distance to any point. If that is at most `leave`, it is a candidate too, even beyond `enter`.
4. Choose the smallest distance. Among candidates within `tie` of it, prefer the current target, then the lower `SNAP_PRIORITY`, then the lower point index, then the earlier `t`.
5. Return `{ delta: target.t − p, target, point }`, or `{ delta: 0, target: null, point: -1 }` when there is no candidate.

### 4.3 Spans and points: `snapSpan`, `snapAt` (pure)

`snapSpan(index, initial, mode, dt, view, resolve)` handles span drags. `resolve(dt)` is the drag helper with its bounds bound in, for example `(d) => dragZoomTimes(initial, mode, d, bounds)`.

1. Run `r = snapPoints(index, dragPoints(initial, mode, dt), view)`. With no target, return `{ times: resolve(dt), target: null }`.
2. Run `out = resolve(dt + r.delta)`. The snapped edge is `'start'` when `mode === 'start'` or when `mode === 'move'` with `r.point === 0`. Otherwise it is `'end'`.
3. If `|out[edge] − T| > SNAP.exactS`, the clamp moved it. Return `{ times: resolve(dt), target: null }` (#11).
4. Otherwise:
   - **move:** `len = initial.end − initial.start`, and `times = edge === 'start' ? { start: T, end: T + len } : { start: T − len, end: T }`.
   - **start/end:** `times = { ...out, [edge]: T }`.

   Return `{ times, target: r.target }`.

`snapAt(index, t, view, limit?)` handles point drags. It runs `r = snapPoints(index, [t], view, limit)` and returns `{ t: r.target ? r.target.t : t, target: r.target }`.

Worked example at `px = 100` (enter 0.08 s, leave 0.12 s). Zoom `z1` is `[1, 2]`, there is a cut at `[4, 6]`, and the zoom is moved by its middle.

| Pointer moved | dt | Points | Result | Written zoom |
|---|---|---|---|---|
| +204 px | 2.04 | [3.04, 4.04] | Cut 4 is 4 px from the end point and catches | {3, 4} exactly; guide "Cut · 0:04.0" |
| +211 px | 2.11 | [3.11, 4.11] | 11 px ≤ 12, and it is current, so it holds | {3, 4} |
| +213 px | 2.13 | [3.13, 4.13] | 13 px > 12, released | {3.13, 4.13}; no guide |
| +207 px | 2.07 | [3.07, 4.07] | 7 px ≤ 8, caught again | {3, 4} |

At fit, a 10 min recording in a ~1180 px view gives `px ≈ 1.93`, so 8 px is about 4 s. That is the precision the view offers anyway. Zoom in or hold Alt to place things more finely.

### 4.4 The session (renderer, `snapControl.ts`)

`useSnapController({ pxRef, scrollerRef, clickRows, guideRef })` is called once in `Timeline`. It returns a controller with **stable identity**, built once with refs. Its dependencies (and `store` and `player` from `useEditor`) are kept in a ref that is updated on every render.

`controller.begin(e, spec)` is called once at pointerdown by each drag handler. It:

- ends a session that is still open (one drag at a time);
- reads `snapPref.get()` once;
- when snapping is on, builds the index:
  `buildSnapIndex(projectSnapSources(store.state, clickRows, { playhead: spec.noPlayhead || player.moving ? null : player.time, layouts: store.state.hasWebcam && player.webcam !== null, freezes: projectFreezeTargets(store.state, spec.exclude) }), spec.exclude)`;
- records `e.clientX` and `e.pointerId`, and sets `current = null`;
- adds `pointerup` and `pointercancel` listeners on `window` in the capture phase, as `holdGesture` in `context.ts` does. They hide the guide and drop the session;
- while the session is open, calls `preventDefault()` on Alt `keydown`/`keyup` (risk 1).

The session is gated on every move. It passes values straight through, with `current = null` and the guide hidden, when any of these holds:

- snapping is off;
- `ev.altKey` is true;
- the pointer has not yet moved `spec.slopPx ?? 0` px from the press (`Math.abs(ev.clientX − sx) >= slop` once opens this gate for the rest of the session).

With the default slop 0, the gate is open at the press itself, so a range anchor can snap.

The session has two methods:

- **`span(ev, initial, mode, dt, resolve)`** runs `snapSpan(index, initial, mode, dt, { pxPerSec: pxRef.current, current, visible: visibleWindow() }, resolve)`. It sets `current = result.target`, shows or hides the guide, and returns `result.times`.
- **`at(ev, t, limit?)`** runs `snapAt(…)`, updates `current` and the guide the same way, and returns the time.

`visibleWindow()` is `{ start: (scrollLeft − GUTTER) / px, end: (scrollLeft + clientWidth − GUTTER) / px }`, read from `scrollerRef`. `GUTTER = 10`, which is the `.tl-content` padding.

Pressing or releasing Alt changes nothing until the next pointer move. The guide stays where it is until then, which keeps #11 true.

### 4.5 Each drag (one `begin` line and one changed move line)

| Drag | File, function | `begin` spec | Each move |
|---|---|---|---|
| Zoom | `Timeline.tsx` `onZoomDown` | `{ exclude: [{ owner: 'zoom:' + z.id }] }` | `times = s.span(ev, initial, mode, raw, (d) => dragZoomTimes(initial, mode, d, bounds))` |
| Text | `onAnnotationDown` | `annotation:<id>` | `… (d) => dragAnnotationTimes(initial, mode, d, duration)` |
| Shape / spotlight | `onShapeDown` | `` `${item.type}:${item.id}` `` | `… (d) => dragShapeTimes(initial, mode, d, duration)` |
| Trim start | `onTrimDown('start')` | `{ exclude: [{owner:'trim:start'}], noPlayhead: true }` | `setTrimStart(initial, s.at(ev, from + raw, { min: 0, max: lastEnd − MIN_CLIP }))` |
| Trim end | `onTrimDown('end')` | `{ exclude: [{owner:'trim:end'}], noPlayhead: true }` | `setTrimEnd(initial, s.at(ev, from + raw, { min: firstStart + MIN_CLIP, max: duration }), duration)` |
| Shift+drag range | `onClipTrackDown`, only when `e.shiftKey && !e.altKey` | `{}` | anchor `s.at(e.nativeEvent, timeAt(e.clientX))`; each move `t = s.at(ev, timeAt(ev.clientX))` |
| Alt+drag range | `onClipTrackDown`, Alt branch | none | unchanged: never snaps |
| Scrub (ruler, playhead, empty track space on all tracks) | `scrub` | `{ noPlayhead: true, slopPx: SNAP.scrubSlopPx }` | the press seeks `timeAt(e.clientX)` unsnapped as today; each move `player.seek(s.at(ev, timeAt(ev.clientX)))` |
| Title card | `TitleTrack.tsx` `onTitleDown` | `title:<id>` | `… (d) => dragTitleTimes(initial, mode, d, duration)` |
| Chapter flag | `TitleTrack.tsx` `onChapterDown` | `chapter:<id>` | `t = s.at(ev, clamp(c.t + raw, 0, duration), { min: 0, max: duration })` |
| Caption | `CaptionTrack.tsx` `onCaptionDown` | `caption:<id>` | `… (d) => dragCaptionTimes(initial, mode, d, bounds)`; `retimeWords(seg, times)` unchanged (its 1e-9 length test still sees a move) |
| Camera layout | `LayoutTrack.tsx` `onSegmentDown` | `layout:<id>`, plus `{owner:'layout:'+around.before.id, edge:'end'}` and `{owner:'layout:'+around.after.id, edge:'start'}` when present | `… (d) => dragLayoutTimes(initial, mode, d, bounds)`; `dragLayout(p.layouts, s.id, times, around)` unchanged |

In every row, `raw = (ev.clientX − sx) / px`, as each handler computes it today.

`scrub` reaches TitleTrack, CaptionTrack and LayoutTrack through `TrackSlotProps.scrub`, so scrubbing there snaps with no change in those files. Those files receive the controller through the new `TrackSlotProps.snap`.

Not covered (all in Later):

- double-click to add (`onBackgroundDown` → `onAddZoom`, `addTitleAt`, `addChapterAt`, `addLayoutAt`);
- click-marker presses, which select and never drag;
- drags on the preview stage.

### 4.6 Edge cases

- **Snapping is off or Alt is held:** each handler gets exactly today's value (`resolve(raw)`, `from + raw`, `timeAt(…)`).
- **Index with only the bounds:** Start and End are the only targets.
- **Item shorter than the threshold:** both edges are candidates, and the nearer one wins.
- **The clamp undoes the snap:** the result is unsnapped and no guide shows (#11). A trim drag never shows a guide at an unreachable target, because of its `limit`.
- **`stayAround` neighbours:** their moving edges are excluded (#8).
- **Targets inside cut or trimmed ranges:** they are drawn there and remain valid targets.
- **Trim start snapped to a cut's start:** `setTrimStart` drops the earlier clip and starts the next one there. That is today's behaviour for any value past `clip.end − MIN_CLIP`; snapping does not change it.
- **Chapter dropped on a cut start:** it maps through `outputChapters` (`render/chapters.ts`) exactly like a chapter placed there by hand.
- **Freeze frame dropped on a cut start:** the clip's end is in no clip (ends are exclusive), so `moveFreeze` (E-11) takes that clip's last frame, the nearest frame to the guide.
- **Range snapped to clip edges:** `cutRange` gets exact edges, so it leaves no sliver. This is the same reason `setRangeSpeed` (`editor/clips.ts`) has its own internal snap.

### 4.7 Preview equals export

Nothing in the render path changes. `compositor.ts`, `player.ts`, `exporter.ts`, `exportPlan.ts` and `render/chapters.ts` are untouched. A snapped drag writes the same fields (`start`, `end`, `t`, `clips`) through the same `store.update` calls and coalescing keys as an unsnapped one. Preview, scrubbing and export already agree on any such values.

The one numerical effect is #12: snapped edges are exactly the target. A title or zoom starting on a clip edge therefore passes the same half-open tests on the frame `exportFrameTimes` samples at `c.start`, in preview and export alike.

---

## 5. UI and copy

**Magnet button.** `<SnapButton />` from `SnapGuide.tsx`, placed in `Timeline.tsx` `.tl-head` just before the `.tl-zoom` group.

- `.tl-head` uses `justify-content: space-between` (`editor.css`), so `.tl-snap` gets `margin-left: auto`. That keeps it next to the zoom buttons instead of centring it.
- Markup: `<button className="btn ghost icon-btn tl-snap" aria-pressed={on} aria-label="Snapping" data-testid="snap-toggle">` with `<EditorIcon name="magnet" size={16} />`.
- Tooltip when on: `withShortcut('Snapping on: edges and the playhead snap to cuts, clicks, chapters and other items. Hold Alt while dragging to place freely', keymap.toggleSnapping)`.
- Tooltip when off: `withShortcut('Snapping off: items move freely. Click to snap to cuts, clicks, chapters and other items', keymap.toggleSnapping)`.
- Pressed style: `.tl-snap[aria-pressed="true"] { color: var(--accent-text) }`. The button is 28 px high, to sit level with the `.tl-zoom` group.
- It is never disabled. A click toggles it without a notice, since the button shows its own state.

**Hint line.** The `.tl-hint` text (`Timeline.tsx:534`) becomes "Click a track to move the playhead · Shift+drag on the clip to select a range · Double-click a track to add · Hold Alt while dragging to place freely". The wording avoids "Alt+drag", which already means a range on the clip track. The span ellipsises on narrow windows; no e2e test reads it.

**Guide.** `<SnapGuide ref={guideRef} />` goes inside `.tl-content`, just before `.playhead` (`Timeline.tsx:771`).

- Markup: `<div class="snap-guide" data-testid="snap-guide" hidden><span class="snap-label"/></div>`. While shown, it carries `data-kind` and `data-t` (the target's source time).
- Line (`snap.css`): `position:absolute; top:0; bottom:0; left:10px; width:1px; margin-left:-0.5px; background:var(--accent-400); pointer-events:none; z-index:5`. That places it above the track blocks and click markers (z-index 1–4) and below `.playhead` (z-index 6). It is placed with `transform: translateX(t * px)`, like the playhead.
- Label: a 10 px pill at the top of the ruler, white on `var(--accent-500)` (white on `--accent-400` is 4.2:1, under AA; `styles.css`). It flips to the left of the line (class `flip`) when its measured width would run past the visible right edge of the timeline (`scrollLeft + clientWidth` of the scroller), which also covers the content's right edge.
- Label text comes from `snapLabel(target)`, which is `"<label> · <formatTime(t)>"`. `formatTime` floors the tenths, as every timeline tooltip does. Examples:
  - "Cut · 0:04.0"
  - "Split · 0:07.5"
  - "Trim · 0:01.5"
  - "Click · 0:05.5"
  - "Chapter · Intro · 0:12.0"
  - "Zoom end · 0:03.0"
  - "Caption start · 0:08.4"
  - "Freeze frame · 0:09.0"
  - "Playhead · 0:10.0"
  - "Start · 0:00.0"
  - "End · 1:23.4"

**Command palette.** **Snapping** sits in the Timeline category as a toggle. Its `on` value is `snapPref.get()`, and it is never unavailable.

**Notice.** Toggling from the command (`N` or the palette) shows "Snapping on" or "Snapping off" through the existing `turned()` helper in `Editor.tsx`, as `toggleCursor` and `toggleClickEffects` do. Toggling never marks the project as changed.

---

## 6. Commands and shortcuts

| id | Category | Title | Keywords | Flags | Default key |
|---|---|---|---|---|---|
| `toggleSnapping` | Timeline | Snapping | `snap magnet align edges cuts clicks chapters playhead stick toggle` | `toggle: true` | `N` |

`CommandId` is inferred from `COMMAND_LIST` in `commands.ts`, so adding the entry after `timelineFit` adds the id. `DEFAULT_KEYMAP` gets `toggleSnapping: ['N']`. Both were added in the wave's contracts commit (`editing-wins.md` §3), with the `n` → `toggleSnapping` key case in `tests/editingWinsContracts.test.ts`.

Wiring in `Editor.tsx`:

- The `commands` map (`Editor.tsx:600`, next to `timelineFit` at line 745) gets `toggleSnapping: () => turned('Snapping', snapPref.toggle())`, where `toggle()` returns the new state. The map is typed `Record<CommandId, () => void>`, so the entry is required.
- The palette `on` map (`Editor.tsx:804`) gets `toggleSnapping: snapPref.get()`, as its first entry (the other features append theirs at the end).

The keydown handler, the Shortcuts dialog and custom shortcuts read `COMMANDS` and `DEFAULT_KEYMAP` and need no change. `N` is a plain key without `inText`, so it does nothing while typing.

Conflicts checked against `src/shared/editor/shortcuts.ts`:

- **`DEFAULT_KEYMAP`** binds Space, Home, End, Left, Right, Shift+Left, Shift+Right, Shift+PageDown, Shift+PageUp, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, S, Delete, Backspace, Z, T, Shift+T, M, 0–4, Plus, =, -, _, Ctrl+E, Ctrl+/, Ctrl+K and Ctrl+Shift+P. `N` is free.
- **`RESERVED`** holds Enter, Tab, Shift+Tab, Alt+F4, Alt+Space, Ctrl+Escape, Ctrl+Shift+Escape, Alt+Escape, Ctrl+W, Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I, F11, Ctrl+0, Ctrl+Plus, Ctrl+= and Ctrl+-, plus every Escape chord. `N` is not reserved.
- **`tests/shortcuts.test.ts`:** "I stays free" is unaffected, and "has no conflicts and only valid, non-reserved shortcuts" covers `N`.
- **Alt alone** is a modifier and never a command (`MODIFIER_KEYS`, and `chordFromEvent` returns null). The case `ev('s','KeyS',{altKey:true}) → null` still holds.
- **Palette search tests** (`tests/commands.test.ts` lines 66–114): "Snapping" and its keywords do not match "stray", "ignore click", "use all clicks", "split", "undo", "zoom timeline" or "add zebra", so no ranking changes.
- **Parallel E-features:** E-08 uses J, K and L. If E-10 or E-11 also claims `N`, `findConflicts(DEFAULT_KEYMAP)` fails. The rule is that E-05 then drops its default (`toggleSnapping: []`).

---

## 7. Undo

- **A snapped drag** is still exactly one undo step. Each handler keeps its `store.beginGesture()` … `store.endGesture()` and its key (`zoom-drag:<id>`, `annotation-drag:<id>`, `${type}-drag:<id>`, `title-drag:<id>`, `chapter-drag:<id>`, `caption-drag:<id>`, `layout-drag:<id>`, `trim-<edge>`). `EditStore.update` merges same-key updates while a gesture is open. Snapping only changes the values passed in.
- **Toggling snapping** (button, `N` or palette) is not an edit. It never goes through `EditStore`, is not autosaved and cannot be undone.
- **Scrubbing and range selection** stay non-edits, as today.

---

## 8. Contracts

These are committed first as types and stubs that pass values through, so the app behaves exactly as today until the implementation lands:

- `snapPoints` returns `{ delta: 0, target: null, point: -1 }`.
- `snapSpan` returns `{ times: resolve(dt), target: null }`.
- `snapAt` returns `{ t, target: null }`.
- The controller's session returns its inputs unchanged.

| File | Export | Signature |
|---|---|---|
| `src/shared/editor/snapping.ts` | `SNAP`, `SnapKind`, `SNAP_PRIORITY`, `SnapEdge`, `DragMode`, `Span`, `SnapTarget`, `SnapSegment`, `SnapSources`, `SnapExclude`, `SnapIndex`, `SnapView`, `SnapResult` | as in section 3 |
| 〃 | `projectSnapSegments` | `(p: Project, opts: { layouts: boolean }) => SnapSegment[]` |
| 〃 | `projectFreezeTargets` | `(p: Pick<Project, 'clips' \| 'freezes'>, exclude?: readonly SnapExclude[]) => number[]` (added in the implementation, §4.1) |
| 〃 | `projectSnapSources` | `(p: Project, rows: readonly ClickRow[], opts: { playhead: number \| null; layouts: boolean; freezes?: readonly number[] }) => SnapSources` |
| 〃 | `buildSnapIndex` | `(src: SnapSources, exclude?: readonly SnapExclude[]) => SnapIndex` |
| 〃 | `dragPoints` | `(initial: Span, mode: DragMode, dt: number) => number[]` |
| 〃 | `snapPoints` | `(index: SnapIndex, points: readonly number[], view: SnapView, limit?: { min: number; max: number }) => SnapResult` |
| 〃 | `snapSpan` | `(index: SnapIndex, initial: Span, mode: DragMode, dt: number, view: SnapView, resolve: (dt: number) => Span) => { times: Span; target: SnapTarget \| null }` |
| 〃 | `snapAt` | `(index: SnapIndex, t: number, view: SnapView, limit?: { min: number; max: number }) => { t: number; target: SnapTarget \| null }` |
| 〃 | `snapLabel` | `(target: SnapTarget) => string` |
| `src/renderer/src/editor/snapControl.ts` | `SNAP_PREF_KEY` | `'editor-snapping'` |
| 〃 | `snapPref` | `{ get(): boolean; set(on: boolean): void; toggle(): boolean; subscribe(l: () => void): () => void }` |
| 〃 | `SnapBegin` | `{ exclude?: readonly SnapExclude[]; noPlayhead?: boolean; slopPx?: number }` |
| 〃 | `SnapSession` | `{ span(ev: PointerEvent, initial: Span, mode: DragMode, dt: number, resolve: (dt: number) => Span): Span; at(ev: PointerEvent, t: number, limit?: { min: number; max: number }): number }` |
| 〃 | `SnapController` | `{ begin(e: ReactPointerEvent, spec?: SnapBegin): SnapSession }` (stable identity) |
| 〃 | `useSnapController` | `(deps: { pxRef: RefObject<number>; scrollerRef: RefObject<HTMLDivElement>; clickRows: readonly ClickRow[]; guideRef: RefObject<SnapGuideHandle> }) => SnapController` |
| 〃 | `SnapGuideHandle` | `{ show(t: number, pxPerSec: number, target: SnapTarget): void; hide(): void }` (declared here by the contracts commit; `SnapGuide.tsx` imports it) |
| `src/renderer/src/editor/SnapGuide.tsx` | `SnapGuide` | `forwardRef<SnapGuideHandle>` component |
| 〃 | `SnapButton` | `() => JSX.Element` (reads `snapPref` with `useSyncExternalStore` and the keymap with `useKeymap`) |
| `src/renderer/src/editor/LayoutTrack.tsx` | `TrackSlotProps.snap` | `snap: SnapController` (additive field) |
| `src/shared/editor/commands.ts` | `COMMAND_LIST` entry | `{ id: 'toggleSnapping', title: 'Snapping', category: 'Timeline', keywords: '…', toggle: true }` (so `CommandId` gains `'toggleSnapping'`) |

---

## 9. Files owned by this feature

**Create**

- `src/shared/editor/snapping.ts`: the pure module (sections 4.1–4.3).
- `src/renderer/src/editor/snapControl.ts`: `snapPref` (localStorage with try/catch), `useSnapController`, and the session (gates, current target, Alt `preventDefault`, window listeners, guide calls).
- `src/renderer/src/editor/SnapGuide.tsx`: the guide line, its label and the magnet button.
- `src/renderer/src/editor/snap.css`: `.snap-guide`, `.snap-label`, `.flip` and `.tl-snap` (including `margin-left: auto`).
- `tests/snapping.test.ts`: unit tests.
- `tests/e2e/snapping.e2e.cjs`: the e2e scenario. `run-all.cjs` picks up every `*.e2e.cjs` file.

**Modify**

- `src/renderer/src/editor/Timeline.tsx` (**SHARED** with E-04, which draws the waveform on the clip track, and E-11, which draws freeze frames on the clip track). E-05 touches only:
  - the imports;
  - a `guideRef` and one `useSnapController` call after `pxRef` (line 164);
  - `scrub` (lines 332–335);
  - the Shift branch of `onClipTrackDown` (lines 344–360);
  - `onTrimDown` (lines 380–397);
  - one `begin` line and one move line in each of `onZoomDown`, `onAnnotationDown` and `onShapeDown`;
  - `.tl-head`: `<SnapButton />` and the hint text (lines 532–547);
  - `snap={snap}` on the three track slots (lines 767–769);
  - `<SnapGuide>` before `.playhead` (line 771).

  It does not touch clip-block, gap or click-marker rendering.
- `src/renderer/src/editor/LayoutTrack.tsx`: the `TrackSlotProps.snap` field, plus a `begin` and a move line in `onSegmentDown`.
- `src/renderer/src/editor/TitleTrack.tsx`: a `begin` and a move line in `onTitleDown` and in `onChapterDown`.
- `src/renderer/src/editor/CaptionTrack.tsx`: a `begin` and a move line in `onCaptionDown`.
- `src/shared/editor/commands.ts` and `src/shared/editor/shortcuts.ts` (**SHARED**, frozen): the `toggleSnapping` entry and `N` came with the contracts commit; E-05 does not edit them.
- `src/renderer/src/views/Editor.tsx` (**SHARED**): the import of `snapPref`, the `toggleSnapping` handler in the E-05 group of the `commands` map, and one entry in the palette `on` map.
- `src/renderer/src/editor/EditorIcon.tsx` (**SHARED**): one `PATHS` entry, `magnet: 'M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4'`.
- `tests/shortcuts.test.ts`: not changed. The `n` → `toggleSnapping` case is in `tests/editingWinsContracts.test.ts` (contracts commit).
- `tests/e2e/w3fix-timeline.e2e.cjs` and `tests/e2e/editor.e2e.cjs` (**SHARED**, only if a run fails; see section 10): one line in the setup that turns snapping off for tests that assert free placement.
- `docs/FEATURES.md` and `docs/ROADMAP.md`: edited by the lead after the merge (`editing-wins.md` decision 4). The suggested FEATURES bullet, after "Zoomable, scrollable timeline": "✓ **Snapping**: item edges, chapter flags, trim handles, range ends and the playhead snap to cuts, clicks, chapters, the playhead and other items while dragging, with a labelled guide; hold `Alt` to place freely; the magnet button or `N` turns it off." ROADMAP: mark E-05 done.

**Not touched:** `src/shared/types.ts`, `src/shared/engine/*`, `src/shared/render/*`, `src/renderer/src/render/*`, `player.ts`, `exporter.ts`, `src/shared/api/prefs.ts`, all of `src/main/**`, and every recording or teleprompter file (`recordingIpc.ts`, `src/shared/recording/**`, `Home.tsx`, `Toolbar.tsx`, `recorder/**`).

**Interaction with the parallel features**

- **E-11 Freeze frame.** Freeze frames are `freeze` targets, from E-11's `freezeSnapTargets(clips, plan)` in `engine/freeze.ts` (a stub returning `[]` until E-11 lands). E-05 wires it in already (`projectFreezeTargets`, §4.1), so nothing in `snapControl.ts` changes when E-11 merges.
  - E-11's `FreezeMarks` drag calls `snap.begin(e, { exclude: [{ owner: 'freeze:' + id }] })` and then `session.at(ev, t, limit)`. The exclusion plans the freeze targets without the dragged freeze. Because the playhead follows `at` during that drag, passing `noPlayhead: true` as well keeps the playhead's press-time position from catching the anchor.
- **E-04 Waveform.** It adds no targets. The guide (z-index 5) draws above the waveform. Snapping to pause edges is in Later.
- **E-08 J/K/L.** The playhead is a target only while the player is not moving (`player.moving`, a contracts getter that E-08 extends to reverse shuttling).
- **E-10 Crop.** No interaction; crop is spatial.
- **E-01 Polish.** The cuts, zooms and layouts it makes become targets. Polish never touches `snapPref`.

---

## 10. Test plan

### Unit tests: `tests/snapping.test.ts` (vitest, node)

Common fixture `F`: clips `[{c0, 0–4, 1×}, {c1, 6–10, 1×}, {c2, 10–12, 2×}]`, `duration 15`, `px = 100`, no other sources, unless a case says otherwise.

1. **Clip targets.** `buildSnapIndex(F)` gives `times = [0, 4, 6, 10, 12, 15]`, labelled Start, Cut, Cut, Split, Trim, End. The kind at 0 is `bound` (the kept start at 0 is not strictly inside), and the owner at 12 is `trim:end`.
2. **Trimmed start.** With `clips[0].start = 1`, the target at 1 is "Trim" with owner `trim:start`. Excluding `{owner:'trim:start'}` removes it, and Start at 0 stays.
3. **Merging keeps the winner's time.** Zoom `z1` from `4 + 3e-7` to 5, plus the cut at 4, leaves one target with `t === 4`, kind `clip`, label "Cut". The target at 5 is "Zoom end".
4. **Excluding an owner.** Segment `zoom:z1` 2–3 with exclude `[{owner:'zoom:z1'}]` leaves no target at 2 or 3. Layout `L0` 2–3 with exclude `[{owner:'layout:L0', edge:'end'}]` keeps 2 and drops 3.
5. **Ignored clicks.** `projectSnapSources` with rows at 2.5 s (ignored) and 3.0 s (used) gives `clicks = [3]`.
6. **Hidden layout track and bad times.** Layouts are absent with `layouts: false`. `NaN`, `−1` and `16` are dropped.
7. **Catching.** In F, the point 4.05 gives `delta ≈ −0.05` (`toBeCloseTo`, 12 digits) with target Cut 4. The point 4.09 (9 px) gives `target = null`.
8. **Hysteresis.** With `current` = Cut 4, the point 4.11 holds and the point 4.13 releases.
9. **Nearest wins.** Click 4.03 and Cut 4 with the point 4.025: the click wins (0.5 px against 2.5 px).
10. **Ties by priority.** Cut 4 and click 4.1:
    - point 4.05 (5 px each): Cut wins;
    - point 4.052 (5.2 px against 4.8 px, within 0.5): Cut wins;
    - point 4.06 (6 px against 4 px): Click wins.
11. **Current wins a tie.** With `current` = Click 4.1, the point 4.05 stays on the click.
12. **Move picks the closer edge.** `dragPoints({start:2, end:3.5}, 'move', 1.96)` gives `[3.96, 5.46]`. With chapter 5.48 added to F, the chapter (2 px) beats Cut 4 (4 px): `delta ≈ 0.02`, `point = 1`.
13. **`dragPoints` shapes.** `'start'` gives `[start+dt]`, `'end'` gives `[end+dt]`, and `'move'` gives both.
14. **Visible window.** In F, the point 12.05 with `visible = {start: 0, end: 12}` gives `target = null`. With `visible = null`, it snaps to Trim 12.
15. **Fit scale.** A single clip 0–30, one chapter at 10, `px = 2` (enter 4 s): the point 13 snaps to 10 (6 px), and the point 14.5 (9 px) does not.
16. **No targets.** `snapPoints({ times: new Float64Array(0), targets: [] }, [5], …)` returns `{ delta: 0, target: null, point: -1 }`.
17. **Labels.** `snapLabel` gives "Cut · 0:04.0", "Chapter · Intro · 0:12.0", and "Chapter · 0:12.0" for an empty title.
18. **`snapSpan` exactness.** Index from clips `[0–4, 6–12]`, duration 12. `snapSpan(idx, {start:1, end:2}, 'move', 2.04, {pxPerSec:100, current:null}, (d) => dragZoomTimes({start:1,end:2}, 'move', d, {lower:0, upper:12}))` returns `times.start === 3` and `times.end === 4` (`toBe`) with target Cut.
19. **`snapSpan` start edge.** The same index, with `initial {4.5, 8}`, `'start'`, `dt = 1.44` and `dragAnnotationTimes(…, 12)`, gives `{ start: 6, end: 8 }` exactly.
20. **`snapSpan` clamp fallback.** Case 18 with bounds `{lower: 0, upper: 3.95}` gives `{ start: 2.95, end: 3.95 }` (the unsnapped clamp) and `target = null`.
21. **`snapAt` limit.** In F, `snapAt(idx, 11.95, view, { min: 0, max: 11.9 })` returns `{ t: 11.95, target: null }`. Without the limit, it returns 12 (Trim).
22. **Scale.** Building with 20 000 click targets, then 1 000 `snapPoints` calls, finishes in under 250 ms. The bound is generous on purpose, as with the `Date.now()` bounds in `analysisIpc.test.ts`.

Existing tests that must stay unchanged and green:

- `tests/shortcuts.test.ts` (the conflicts/reserved test now covers `N`) and `tests/editingWinsContracts.test.ts` (the `n` → `toggleSnapping` case);
- `tests/commands.test.ts` (unique ids, palette search order);
- `tests/editorClips.test.ts`, `tests/timeline.test.ts`;
- every drag-helper test (`dragZoomTimes`, `dragCaptionTimes` and the others are not edited).

### End to end: `tests/e2e/snapping.e2e.cjs` (Playwright under Xvfb)

**Reuse:**

- `h.tempHome`, `h.launch`, `h.run`, `h.readProject`, `h.sleep` and `h.assert` from `helpers.cjs`;
- `f.seedProject`, `f.openProject` and `f.waitFor` from `editor-fixtures.cjs`. `seedProject` takes `zooms` directly;
- a local copy of `openSeeded(ctx, tag, opts, patch)` from `w3fix-timeline.e2e.cjs`, which patches `chapters` into `project.json`;
- local copies of `xForTime` and `centerOf` from `editor.e2e.cjs` (`GUTTER = 10`), and of `playheadTime` and `saved` (polls `project.json` until it matches) from `w3fix-timeline.e2e.cjs`.

The shared `drag` helper releases the mouse at the end. This test therefore adds a local `dragHold(win, from, to, steps = 8)` that does `mouse.move`, `mouse.down` and the stepped moves, without `mouse.up`.

**Seed:** 12 s, clips `[{c0, 0–4}, {c1, 6–12}]` (a cut from 4 to 6), `zooms: [{ id:'z1', start:1, end:2, scale:2, focus:{mode:'cursor'}, auto:false }]`, and the patch `chapters: [{ id:'h1', t:9, title:'Demo' }]`.

**Scenario "snaps, Alt frees, N toggles, scrub and trim snap"**

1. Open the project. Read `px` from `.tl-content[data-px-per-sec]` and assert `[data-testid="snap-toggle"]` has `aria-pressed="true"`.
2. **Snap to the cut.** `dragHold` from the centre of `.zoom-seg[data-zoom="z1"]` by `2·px + 4` px. Before release, assert:
   - `[data-testid="snap-guide"]` is not hidden;
   - `data-kind="clip"`, `data-t="4"`;
   - the text starts with "Cut · 0:04.0".

   Then `mouse.up()` and assert:
   - the guide is hidden;
   - once saved, `h.readProject(home, id).zooms[0]` has `end === 4` and `Math.abs(start − 3) < 1e-9`.
3. **One undo step.** `Control+Z`, then `[data-zoom="z1"]` has `data-start="1"` and `data-end="2"`.
4. **Alt frees.** `keyboard.down('Alt')`, the same `dragHold`, and before release assert the guide is hidden. Release, `keyboard.up('Alt')`. Assert `end > 4 + 2 / px` and `start > 3 + 2 / px`. `Control+Z`.
5. **`N` toggles.** Press `n` and assert:
   - `aria-pressed="false"`;
   - `win.evaluate(() => localStorage.getItem('editor-snapping')) === '0'`;
   - the same drag ends at `end > 4 + 2 / px` with the guide hidden.

   `Control+Z`. Press `n` again and assert `aria-pressed="true"`.
6. **Scrubbing snaps to the chapter.** Press on `.tl-ruler` at `xForTime(8.5)` and move in steps to `xForTime(9) + 5`. Before release, assert:
   - `Math.abs(playheadTime − 9) < 1e-6`;
   - the guide has `data-kind="chapter"` and the text "Chapter · Demo · 0:09.0".

   Release; the guide is hidden.
7. **Trim handle to the cut end.** Drag from `centerOf('.trim-handle.start')` by `xForTime(6) − xForTime(0) − 5` px, at the handle's y (the handle is 10 px wide, so its centre is 5 px right of the kept start). Once saved, `clips.length === 1` and `clips[0].start === 6`. Unsnapped, `setTrimStart` would leave `start ≈ 6 − 5 / px`.
8. **No errors.** `ctx.logs` has no `[pageerror]` or `[console.error]` entries.

**Existing e2e suite.** Snapping is on by default, so run the whole suite (`tests/e2e/run-all.cjs`). Tests that place items or the playhead freely and assert tight positions could now snap. The ones known to be at risk:

- `w3fix-timeline.e2e.cjs`: "the playhead is under the pointer" (< 3 px) while scrubbing the layout and title tracks;
- `editor.e2e.cjs`: range cut ("about 1 s", ±0.1 s) and trim-handle start (0.3–0.7 s);
- the timeline drags in `camera.e2e.cjs`, `captions.e2e.cjs`, `titles.e2e.cjs`, `zoom.e2e.cjs`, `smart-zoom.e2e.cjs`, `shapes.e2e.cjs`, `camera-director.e2e.cjs` and `audit-editor.e2e.cjs`.

For any test that fails, add `await win.evaluate(() => localStorage.setItem('editor-snapping', '0'))` in its setup after `.home` appears and before `f.openProject`. Home and the editor share one renderer origin. Do not change what the test asserts.

---

## 11. Risks

1. **Alt on Windows.** The main window uses `titleBarStyle: 'hidden'` with `titleBarOverlay` (`src/main/windows.ts:65`), and there is no `Menu.setApplicationMenu` call. Releasing Alt alone may move keyboard focus to the hidden default menu. Alt+drag ranges already exist (`Timeline.tsx:344`), so this is not new.
   - Mitigation: `preventDefault()` on Alt `keydown`/`keyup` while a snap session is open.
   - This is unverified on Windows (e2e runs on Linux, where Playwright sends modifiers through CDP) and needs one manual check. `src/main/**` stays untouched either way.
2. **Alt+drag on the clip track already selects a range.** It never snaps, while Shift+drag ranges do. That is consistent ("Alt = free"), and the hint line avoids the word "Alt+drag".
3. **Long recordings at fit.** 8 px can be several seconds, and dense clicks or captions can catch almost every drag. Mitigations: zoom in, hold Alt, or turn snapping off. Per-kind toggles are in Later.
4. **Existing e2e tests break** because snapping is on by default (section 10). Mitigation: run the suite and switch snapping off in the setup of failing tests. This touches shared test files by one line each.
5. **Hysteresis may feel sticky.** The constants live in `SNAP` and can be tuned without changing the logic or the shape of the tests.
6. **Merge conflicts in `Timeline.tsx`** with E-04 and E-11. Mitigation: the exact region list in section 9; no E-05 change touches the clip track's render body.
7. **E-11's freeze targets** are only a stub until E-11 lands. Mitigation: E-05 reads them through E-11's own `freezeSnapTargets` and `freezePlan` (contracts), so they appear with no further change; the unit test for a dragged freeze compares against those functions and holds before and after the merge.
8. **Building the index at every press**, including plain scrubs: O(n log n) for a few thousand targets, far below a frame. Unit case 22 guards it. If profiling disagrees, cache the index by `store.revision`, `clickRows` and the playhead.

---

## 12. Later (out of scope)

- Snap the position of a double-click add, of keyboard nudges (E-09) and of pasted items.
- Snap the outer edges of a group drag over a multi-selection (E-06).
- Snap to pause edges from E-04's audio levels (`audioAnalysis.ts`), to caption word boundaries, to straightened-path bars and to scroll bands.
- Per-kind snap toggles (clicks, captions, other items) and a threshold setting.
- When a clamp undoes the best snap, fall back to the next target inside the bounds.
- Snap to frame boundaries or ruler ticks.
- Alignment guides for shapes and text dragged on the preview stage (a separate, spatial feature).
