# Smarter auto zoom (NW-03)

Status: contracts committed on `feat/autozoom-contracts`; implementation in three parallel
workstreams (see [Work split](#work-split)). Roadmap item: `docs/ROADMAP.md` NW-03.

Auto zoom is the main reason people use Flown, but busy recordings still need hand work. This
feature adds three things:

1. **Ignore stray clicks.** The user can mark a recorded click as ignored. It then drives no auto
   zoom, no click effect (ripple, ring or pulse), no click sound and no smart speed activity.
   Obvious stray clicks are found automatically when a recording is processed, and the user can
   use them again.
2. **Straighten cursor paths.** A wobbly move between two resting points can be replaced by a
   straight, smoothly eased glide. This works as a project option, as a per-range action, or
   both together.
3. **Follow scrolling.** Mouse-wheel scrolling is recorded. During a long scroll auto zoom shows
   the whole frame, then zooms back in where the scrolling stopped. Short scrolls hold the zoom.
   Smart speed counts scrolling as activity.

The recording is never changed: `cursor.json` stays exactly as recorded. Every edit is data in
`project.json`, so it can be undone and turned off. Projects made before this feature open and
export exactly as before.

---

## 1. Decisions (judging the two designs)

Two designs were compared: A (algorithm-first) and B (user-first). **A is the base.** Its data
model is stricter, its defaults are conservative, its rebasing keeps deleted zooms deleted, and
its scroll arithmetic avoids out-and-in dips. From B we take the click key, `ClickEvent.up`, the
single painted range list, the "Made for the click at..." line, scroll bands, the end-of-recording
rule, the fly-by rule and the Ctrl+wheel filter.

| # | Topic | Decision | Why |
|---|-------|----------|-----|
| 1 | Shared mechanism | One pure, memoised `effectiveTrack(recorded, project)` bound to the editor's `cursor` (both designs). | Preview, export, finalize and regeneration agree by construction. |
| 2 | Click identity | B: an integer key, `clickKey(t) = Math.round(t * 1000)` (ms). | Exact `Set`/`Map` lookups, compact JSON, no tolerance maths. A's `t ± 1e-6` dropped. |
| 3 | Stray detection | A's model: run once at finalize and on demand ("Find stray clicks"), stored as `IgnoredClick` entries with a `stray` reason. B's live `skipStray` toggle and `kept` list are dropped. | Deterministic: tuning the rules later never changes existing projects. |
| 4 | Stray rules | A's `start` (t < 0.6 s), B's `end` (last 0.6 s **and** no input after it), and B's `moving` rule made stricter (0.04 video heights on both sides within 80 ms, both moves in the same direction within 45°, press not held). | High precision; every result is visible (dashed marker) and can be undone in one click. |
| 5 | Zooms after ignore/use | A: `rebaseAutoZooms` replaces only the auto zooms whose generation changed, plus an anchor fallback. B's ±7.1 s local regeneration is dropped. | B brings back deleted auto zooms near the click; A does not. |
| 6 | Straighten default | A: off. B's on-by-default is moved to [Later](#later). | A straightened cursor can drift from hover effects in the video; wait for real-world data. |
| 7 | Where the option lives | **Neither design:** `InputEdits.straighten`, not `CursorSettings.straighten`. | Keeps the type changes to cursor track, clicks and zoom settings. Avoids `cursorLook`/`styleDefaults`, which a parallel branch may touch. Carrying it in the default style is in [Later](#later). |
| 8 | Range edits | B: one sorted, non-overlapping `paths: PathRange[]` with `mode: 'straight' \| 'recorded'`, painted (later wins). A's two lists are dropped. | One list, one rule. |
| 9 | Clicks inside a move | B: block the move (keep it as recorded). A's pin-and-split is dropped. Scroll events inside a move block it too. | Splitting at a fly-by click makes the glide stop dead at the click, which is a visible artefact. |
| 10 | Drag data | B: `ClickEvent.up` (release time) instead of A's `held` intervals. A's 0.25 s drag guess applies to old recordings in **automatic** mode only (B made it a hard block). | Release belongs to the click; the user's explicit range may override a guess, never a known drag. |
| 11 | Gesture guard | B's wobble ratio (≤ 0.2) plus A's turning guard (< 300°). A's detour ratio is dropped. | The detour ratio is redundant with wobble. Turning catches small loops on long moves. |
| 12 | Units | A: aspect-corrected video heights for every distance. | Normalised x and y are not the same length. |
| 13 | Scroll modes | A: `scrolling: 'zoom-out' \| 'hold' \| 'ignore'`, default `'zoom-out'`. B's boolean `onScroll` is dropped. | The request names both "hold" and "zoom out"; `'ignore'` is today's output. |
| 14 | Long scroll | A: ≥ 1.5 s and ≥ 4 notches. B's 1.0 s is dropped. | A break shorter than that would zoom out and back in within a second (a dip). |
| 15 | Zoom bounds near scrolls | A's `lo`/`hi` clamps, **with one fix**: today's "drop if ≤ 0.2 s" rule is kept unchanged. A range clamped by a break is dropped when shorter than 1.4 s. | A's "drop if < 1.4 s" changed output for recordings without scrolls (e.g. a 1 s recording). This fix makes the no-scroll path identical. |
| 16 | Scroll storage | A: notches (uiohook `rotation`), not B's lines (`rotation × amount`). Coalesce within 50 ms, same axis, compatible sign. B: Ctrl/Meta+wheel is not stored. | Notches do not depend on the user's lines-per-notch setting. Ctrl+wheel zooms the app; it does not scroll. |
| 17 | Smart speed | A: a whole session `[start − 0.05, end + 0.05]` is busy. B's per-event spans are dropped. | Wheel events up to 0.8 s apart must not leave idle holes. |
| 18 | Where to ignore | A's selectable timeline markers, "Selected click" section, Delete, and one review list (Zoom › Auto zoom). B's "Made for the click at … [Ignore this click]" on a selected auto zoom. Palette commands from both. B's default `I` key is moved to [Later](#later). | Selecting then pressing Delete is the timeline's existing model. B's one-click toggle on 6 px dots makes accidental toggles too easy. |
| 19 | Timeline extras | A's straightened-move bars and B's scroll bands are both kept. | Cheap, and they explain why the path or the zooms changed. |
| 20 | Names | `Project.inputEdits` (B), `AutoZoomSettings.scrolling` (A). | Clearer. |

---

## 2. Data model and migration

### cursor.json (`CursorTrack`, `src/shared/types.ts`)

Additive, written only by recordings made after this ships:

- `ClickEvent.up?: number`: release time in source seconds. Trust it only when it is finite and `>= t`.
- `ScrollEvent { t, x, y, dx, dy }`: normalised position, mapped exactly like clicks. `dx`/`dy`
  are signed wheel notches, + = right / down, summed when merged. A sub-notch touchpad step is 0
  and still counts as scrolling.
- `CursorTrack.scrolls?: ScrollEvent[]`, sorted. **Absent** means the recording was made before
  scrolling was captured. `[]` means scrolling was captured and none happened.

`cursor.json` is still written only while recording (checkpoints, stop) and once at finalize
(`clampTrack`). The editor never writes it, so click times, and with them click keys, are stable
for the life of a project.

### project.json (`Project`)

```ts
type StrayReason = 'start' | 'end' | 'moving'
interface IgnoredClick { ms: number; stray?: StrayReason }        // ms = clickKey(click.t)
type PathMode = 'straight' | 'recorded'
interface PathRange { start: number; end: number; mode: PathMode } // source seconds
interface InputEdits {
  ignoredClicks?: IgnoredClick[]  // sorted by ms, unique
  straighten?: boolean            // the "Straighten moves" option; absent = off
  paths?: PathRange[]             // sorted, never overlapping
}
Project.inputEdits?: InputEdits    // placed right after zoomSettings
AutoZoomSettings.scrolling?: 'zoom-out' | 'hold' | 'ignore'        // absent = 'zoom-out'
DEFAULT_ZOOM_SETTINGS.auto.scrolling = 'zoom-out'
```

Rules for the edit operations:

- `straighten: false` is never stored; turning the option off removes the key.
- An empty list is removed.
- An empty `inputEdits` is removed.

### Sanitising on load (implemented and frozen, `src/shared/engine/inputData.ts`)

**`migrateProject` → `readInputEdits(raw, duration)`**

- `ignoredClicks`: entries need a finite `ms`. It is rounded, and kept only in `0 … (duration + 1) s`.
  An unknown `stray` is dropped. For duplicates, the user's entry beats detection's. The list is sorted.
- `straighten`: kept only when `true`.
- `paths`: entries need a known mode. Ranges are clamped into `[0, duration]`, ranges shorter than
  0.01 s are dropped, and the rest are painted in stored order.
- If nothing is left, the result is `undefined` and the project has no key. The function is idempotent.

**`migrateCursor` → `readScrolls(raw)`**

- Not a list: `undefined`, and the track has no key.
- Otherwise: events need a finite `t`, `x` and `y`. A non-finite `dx`/`dy` becomes 0. Events are sorted.

`ClickEvent.up` passes through unchanged, as clicks always have. Consumers validate it.

**Old projects**

- They have no `inputEdits`, `scrolls` or `up`.
- `effectiveTrack` returns the recorded object itself.
- `autoZoomsForTrack` without scrolls is arithmetically identical to today.
- Stored zooms are never regenerated on open.
- Nothing is rewritten on disk.
- `zoomSettingsOf` supplies `scrolling: 'zoom-out'`, which has no effect without scroll data.

Not part of the default style: `scrolling` belongs with the other auto settings, which
"Save as default style" does not carry, and `inputEdits` is per recording.

---

## 3. The effective track (all three parts)

`effectiveTrack(recorded, { inputEdits, capture, width, height })` (`src/shared/engine/inputTrack.ts`):

1. `!recorded.valid` → return `recorded`.
2. `clicks`:
   - with no ignored entry matching any click, `recorded.clicks` (the same array);
   - otherwise the clicks whose `clickKey(t)` is not ignored.
3. `samples`:
   - `recorded.samples` when `capture.cursorInVideo`, or when there is neither `straighten` nor any `paths`;
   - otherwise `planCursorPath(recorded, { aspect: width / height, straighten, paths }).samples`.
   Straightening reads the **recorded** clicks, including ignored ones, because a click physically
   happened in the video.
4. If both are the original arrays, return `recorded` itself. Otherwise return `{ ...recorded, samples, clicks }`.
5. Memoise on:
   - `recorded.samples`, `recorded.clicks` and `recorded.scrolls`;
   - the `ignoredClicks` and `paths` arrays, by identity;
   - `straighten`, the aspect and `cursorInVideo`.
   Ignoring a click keeps the same `samples` array, so `SmoothedTrack` and `focusPathFor` are not
   rebuilt. Toggling straightening keeps the same `clicks` array. The editor operations keep the
   identity of arrays they do not change.

The editor binds `cursor = effectiveTrack(data.cursor, …)` (wired in this commit,
`Editor.tsx`). Everything already reads that `cursor`, so nothing below needs changing:

- the scene (`cursorPath`, `focusPath`);
- the cursor layer: sprite, pulse, ripple/ring/pulse effects, hide-when-idle, cursor over the video;
- the follow-cursor camera and tilt aim (`cameraAt` / `aimAt`), and motion blur;
- spotlights, and arrows placed at the cursor;
- click sounds in preview (`player.setScene` → `soundingClicks`) and export
  (`clickSoundJob(project, scene.cursor)`);
- smart speed (`ClipPanel` → `inputGaps(props.cursor)`);
- Regenerate and the auto zoom settings (`ZoomPanel` with `props.cursor`).

Finalize generates zooms from `effectiveTrack(cursor, project)` after storing stray clicks (also
wired here). Preview and export draw from the same scene object, so they match frame for frame.

---

## 4. Part 1: ignore stray clicks

### 4.1 What an ignored click no longer drives

Everything below reads the effective track, so all of it follows from step 2 above:

- auto zoom: click events, typing anchors (`typingPlace`, the click into a field, the clicks that
  split typing runs);
- the click effect and the cursor's click pulse;
- the click sound;
- smart speed activity.

It still blocks straightening across it. Zooms the user edited (`auto: false`) keep their anchor.

### 4.2 Automatic detection: `findStrayClicks(track, duration, aspect)` (`src/shared/editor/inputEdits.ts`)

Only in-video clicks (any button) are checked. Each click gets the first reason that fits:

| Reason | Rule |
|--------|------|
| `start` | `t < 0.6` (STRAY.edge). This is usually the click that focuses the recorded app; its zoom would start at 0 already zoomed in. |
| `end` | `t > duration − 0.6`, and nothing after it: no click, key, mark or scroll with a later `t`, and no typing burst ending after it. Typically a click on the taskbar to stop. |
| `moving` | The cursor travels at least 0.04 video heights in the 0.08 s before **and** in the 0.08 s after the click (`cursorAt` on the samples). The two moves are within 45° of each other (cos ≥ √½). The press was not held (no finite `up` with `up − t ≥ 0.25`). |

The `moving` threshold is about 540 px/s at 1080p: a click while flying past. Arriving and then
clicking, clicking and then leaving, and starting a drag are all one-sided, so they are never
`moving`.

Examples, 16:9, duration 10:

- **Edge clicks** at 0.3, 0.59, 0.6, 4.0 (at rest), 9.41 and 9.6:
  - `start`: 0.3 and 0.59.
  - `end`: 9.6. The click at 9.41 has the 9.6 click after it, so it stays.
  - 0.6 is not stray (strict inequality).
- **A swipe**: rest at (0.30, 0.40) until 1.9 s, then a swipe to (0.90, 0.40) at 2.0 widths/s
  until 2.2 s, with a click at 2.05 at (0.60, 0.40).
  - Before: (0.60 − 0.44) × 16/9 = 0.284 ≥ 0.04. After: 0.284. Same direction, so `moving`.
  - A click at 2.2, at the end of the swipe, has after = 0, so it is not stray.

Detection runs:

- once in finalize, for new recordings: `project.inputEdits = { ignoredClicks: stray }` before
  generating zooms;
- on demand from "Find stray clicks" (`ignoreStrayClicks`), as one undo step. This also works on old projects.

It never runs live.

### 4.3 Ignoring and using: `setClicksIgnored(p, recorded, { ignore?, use? })`

1. Merge the change into `inputEdits.ignoredClicks`. An entry replaces an existing one with the
   same `ms`; `use` removes keys. Sort the list and drop it when empty.
2. Return `p` itself if no click changes state, so no undo step is added.
3. If `zoomSettingsOf(p).auto.enabled`, update the zooms in the same new project:
   - `before = autoZoomsForTrack(effectiveTrack(recorded, p), p.duration, auto)`;
   - `after` is the same with `next`;
   - `zooms = rebaseAutoZooms(p.zooms, before, after, newlyIgnoredKeys)`.
4. Callers do this in one `store.update`, so one undo step restores the edit and the zooms together.

`rebaseAutoZooms(zooms, before, after, dropAnchors)` (`src/shared/engine/zoom.ts`):

- Two zooms are **the same** when all of these hold:
  - `start` and `end` within 1e-6;
  - equal `scale`;
  - equal `focus`;
  - anchors equal, with `t`, `x`, `y` within 1e-6 and `until` equal.
- **Keep** every zoom (same object, same id) unless it is auto, matches one in `before`, and
  matches none in `after`.
- **Also drop** an auto zoom with a click anchor (`until` undefined) whose `clickKey(anchor.t)`
  is in `dropAnchors`. This covers zooms made by an older generator, which `before` no longer
  reproduces.
- **Add**, with a new id, every zoom of `after` that matches none in `before`, overlaps no kept zoom,
  and overlaps only `before` zooms that overlap a zoom dropped by the two rules above. A `before`
  zoom the user deleted is not in `zooms`, so nothing drops for it and its stretch stays clear.
  An `after` zoom that overlaps no `before` zoom (a lone click used again) is added.
- **Keep back**: an `after` zoom that is not added because it overlaps a kept zoom or a `before`
  zoom the user deleted keeps the zooms it overlaps that only the first rule dropped, so a zoom
  the user kept is never removed for a replacement that is not added. Repeat until nothing more
  is kept, since a zoom kept this way can hold back the next `after` zoom.
- Sort by start. Return `zooms` itself if nothing changed.

Why this is sound: every user edit turns a zoom into `auto: false` (`zoomEdit.ts`, the timeline,
the preview, the Zoom panel). So an unedited auto zoom is exactly what the generator produced.

Example with the defaults (cluster gap 3, lead-in 0.9, hold 1.8, minimum 2.2, transition 0.7),
clicks at 2, 4 and 9, and a manual zoom `m` at [12, 15]:

- `before`: [1.1, 5.8] anchored at 2, and [8.1, 10.8] anchored at 9.
- Ignoring 4 gives `after`: [1.1, 3.8] anchored at 2, and [8.1, 10.8].
- The result: [1.1, 5.8] is replaced by [1.1, 3.8]. The 9 s zoom keeps its object and id, and `m` is kept.
- If the user had deleted the 9 s zoom earlier, it stays deleted.
- Using 4 again restores [1.1, 5.8].
- If the user had deleted [1.1, 5.8] instead, ignoring 4 (or 2) adds nothing: only [8.1, 10.8]
  and `m` remain. The same holds after **Remove all**.

With clicks at 2, 5 and 8 the generator makes one zoom, [1.1, 9.8]; with 5 ignored it makes
[1.1, 3.8] and [7.1, 9.8]. If the user deletes [1.1, 3.8] and then uses 5 again, the merged
[1.1, 9.8] would cover the deleted stretch, so it is not added, and [7.1, 9.8] stays (same
object). The same holds the other way round, with [7.1, 9.8] deleted. A zoom the user made
between the two halves, say [4.5, 6], holds the merge back the same way, and both halves stay.

"Regenerate" and the auto settings keep their full regeneration (`regenerateAutoZooms` with the
effective track), so ignored clicks stay ignored there too.

### 4.4 The click at the playhead: `clickAtPlayhead(rows, zooms, t)`

1. If an auto zoom under the playhead has a click anchor whose key is a row, return that click.
2. Otherwise return the row nearest to `t` within 1 s (the later one on a tie). Ignored rows count.
3. Otherwise return null.

The command flips the click's state (ignore ↔ use).

### 4.5 What made a zoom: `zoomCause(z, effectiveTrack, settings)`

Checked in this order:

1. `anchor.until` → typing.
2. `clickKey(anchor.t)` of an effective click → that click.
3. A mark at `anchor.t` → mark.
4. `anchor.t` equal to a long scroll's landing time → scroll.
5. Otherwise null. It is always null for `auto: false`.

---

## 5. Part 2: straighten cursor paths (`src/shared/engine/cursorPath.ts`)

Distances: `d(p, q) = hypot((p.x − q.x)·A, p.y − q.y)`, where A = width / height. The unit is a
video height; at 1080p, 0.001 ≈ 1 px. The constants are in `PATH`.

### 5.1 Rests and moves

**Rests.** Walk the samples. From sample i, extend j while `d(S[j+1], S[i]) ≤ 0.006`. If
`S[j].t − S[i].t ≥ 0.15`, then [i, j] is a rest and the walk continues at j + 1; otherwise it
continues at i + 1.

This works with the tracker's sparse samples:

- a still cursor is stored as its first and last poll;
- `holdSamples` adds a sample 1/120 s before the next movement.

**Moves.** A move runs between consecutive rests R_k and R_k+1:

- `t0 = S[end of R_k].t`, `t1 = S[start of R_k+1].t`, with `from` and `to` those two samples;
- the move's samples are the ones strictly between;
- there is no move before the first rest or after the last.

**Wobble** is the largest `d(sample, segment from→to)` divided by the chord `L = d(from, to)`.

**Turning** is the signed sum of direction changes, `atan2(cross, dot)`, along the recorded path
resampled every 0.02 of arc length.

### 5.2 Reasons (`CursorMove.auto` / `.manual`; null = may be straightened)

**Hard blocks** apply in both modes:

| Reason | Rule |
|--------|------|
| `off-frame` | Any sample in [i0, i1] lies outside 0..1. This keeps "cursor over the video" and window or area edges exactly as recorded. |
| `click` | A recorded click (any button, ignored ones too) has `t0 < c.t < t1`. |
| `scroll` | A scroll event has `t0 < s.t < t1`. |
| `drag` | A click with a valid `up` has `min(up, t1) − max(c.t, t0) > 0.03`. |

**Automatic mode only** (checked in this order):

| Reason | Rule |
|--------|------|
| `drag-guess` | A click **without** `up` has `t0 − 0.25 ≤ c.t ≤ t0`. This applies to older recordings. |
| `short` | `t1 − t0 < 0.1` |
| `long` | `t1 − t0 > 2.5` |
| `small` | `L < 0.03` (about 32 px at 1080p) |
| `wobbly` | wobble > 0.2 (an L-shaped path to a submenu) |
| `gesture` | `abs(turning) ≥ 300°` (a loop around something) |

An overshoot-and-return turns about 180° and is straightened. Hand tremor alternates direction
and cancels out.

**Manual mode only** (a `'straight'` range): `long` when longer than 10 s, `small` when
`L < 0.01`. The drag guess and the shape guards do not apply.

### 5.3 Which moves are straightened

Take the path range that contains the move's midpoint `tm = (t0 + t1)/2` (start ≤ tm < end):

- `'recorded'`: keep the recorded path;
- `'straight'`: straighten if `manual === null`;
- no range: straighten if `inputEdits.straighten && auto === null`.

There is no straightening at all with `capture.cursorInVideo` (the real cursor is in the pixels)
or without valid cursor data.

### 5.4 The replacement path

1. Remove the recorded samples with `t0 < t < t1`.
2. Insert samples at `t0 + k/120` for k = 1 … ⌈(t1 − t0)·120⌉ − 1, at
   `from + (to − from)·mj(s)` with `s = (t − t0)/(t1 − t0)` and `mj(s) = s³(10 − 15s + 6s²)`.
   This minimum-jerk profile has zero speed and acceleration at both ends, so the glide joins
   the rests without a kink.
3. Times never change. The samples at t0 and t1, and every sample outside straightened moves,
   are the same objects.
4. The spring smoothing (`cursor.smoothing`) still applies on top.

### 5.5 Consistency (preview = export)

The drawn cursor, trail, tilt, hide-when-idle, the "cursor over the video" test, the
follow-cursor camera (`focusPathFor`), motion blur, spotlights, arrows at the cursor, smart
speed movement, and mark and typing anchors all read the one effective `samples` array.

- Click effects stay at the recorded click positions. Clicks sit on rests, which are unchanged,
  so a ripple still appears under the cursor.
- Hide-when-idle: rests are unchanged, so idle times are the same. A move may register up to
  about 40 ms later, because the glide starts slowly.
- Toggling straightening does **not** regenerate zooms. Following the cursor uses the live focus
  path, and click anchors do not move.

### 5.6 Worked example (16:9)

The path:

- A rest at A = (0.2, 0.5): samples at 0, 0.5 and 1.0 s.
- A move every 1/60 s for 1.0 < t < 1.6: `x = 0.2 + 0.4u`, `y = 0.5 + 0.02·sin(3πu)`, with
  `u = (t − 1)/0.6`.
- A rest at B = (0.6, 0.5): samples at 1.6, 2.0 and 3.0 s.

Measurements:

- The rests are [0, 1.0] and [1.6, 3.0]. The first move sample, at 1.0167 s, is about 0.02 from A, more than 0.006.
- There is one move, t0 = 1.0 and t1 = 1.6.
- L = 0.4 × 16/9 = 0.711. Wobble = 0.02 / 0.711 = 0.028. |turning| ≈ 30°.
- So `auto` is null, and the move is straightened when the option is on.

Results:

- At t = 1.30: recorded (0.40, 0.48), straightened (0.40, 0.50).
- At t = 1.06: x = 0.2 + 0.4 × 0.00856 = 0.20342, y = 0.5.
- The positions at 1.0 and 1.6 are unchanged.

Variants:

- A click {t 0.95, up 1.45} → `drag`, never straightened.
- A click at 0.9 without `up` → `drag-guess`: kept by the option, straightened by a `'straight'` range.
- A click at 1.3 → `click`.
- A sample with y = 1.05 → `off-frame`.
- The path detours through (0.6, 0.2) → `wobbly`.
- A 3 s move → `long` for the option; a range can force it.

---

## 6. Part 3: follow scrolling

### 6.1 Sessions (`src/shared/engine/scroll.ts`, constants in `SCROLL`)

- Sort the events. Events at most **0.8 s** apart form one session.
- A session records `start`, `end`, `notches = Σ(|dx| + |dy|)`, `count`, and `last` (the
  position of its final event).
- For auto zoom, sessions are also cut at every zoom-event instant strictly inside them: used
  zoom clicks, marks, and typing session starts and ends. An event exactly at a cut starts the
  next session.

**Long** means `end − start ≥ 1.5`, `notches ≥ 4`, and no overlap with a typing session (typing
keeps the zoom on the field).

### 6.2 Modes (`AutoZoomSettings.scrolling`)

| Mode | Behaviour |
|------|-----------|
| `'zoom-out'` (default) | Long sessions are **breaks**; the other sessions are **holds**. |
| `'hold'` | Every session is a hold. |
| `'ignore'` | No breaks or holds: exactly today's output. |

Absent scroll data gives the same result as `'ignore'`.

### 6.3 Landing (zooming back in), `'zoom-out'` only

Breaks are processed in time order. Each break B gets a landing event when all of these hold:

- some zoom event, landings included, has `t1` in [B.start − hold, B.start], so a zoom was in when scrolling began;
- no click, mark or typing event starts in [B.end, B.end + 1.5];
- `L = B.end + 0.2 + leadIn ≤ duration`;
- the next break, if any, starts after L. Otherwise B gets no landing and the next break counts
  as zoomed in (its first condition holds), so the camera stays out through both and lands after
  the second.

The landing event is `{ t0: L, t1: L, anchor: { t: L, x: B.last.x, y: B.last.y } }`. Its range
starts at `L − leadIn = B.end + 0.2`, so it zooms in once the page has settled, then hands back
to the cursor 0.3 s after L, like a click zoom.

### 6.4 `zoomsFromEvents` with breaks and holds (`src/shared/engine/zoom.ts`)

**a. Clustering.** An event joins the current range only if `e.t0 − cur.last ≤ clusterGap` and
no break overlaps (cur.last, e.t0).

**b. Holds.** Holds are applied in time order, interleaved with the events. A hold [h0, h1] with
`cur.start ≤ h0 ≤ cur.end`, and no break overlapping (cur.last, h0), sets:

- `cur.end = max(cur.end, h1 + hold)`;
- `cur.last = max(cur.last, h1)`.

A hold outside every range does nothing: scrolling alone never creates a zoom.

**c. Bounds per range.** Let f be the range's first event and l its last (`cur.last`):

- `lo = prevBreak ? prevBreak.end + 0.2 : 0`, where prevBreak is the last break with `end ≤ f`.
- `hi = nextBreak ? nextBreak.start + 0.35 : duration`, where nextBreak is the first break with
  `start ≥ l`. Then `lo = max(0, lo)` and `hi = min(duration, hi)`.
- `start = clamp(r.start, lo, hi)`; `end = clamp(max(r.end, start + minDuration), lo, hi)`.
- If `end − start < 1.4`: `start = clamp(end − 1.4, lo, hi)`, then `end = clamp(start + 1.4, lo, hi)`.
- Drop the range if a break set lo or hi and `end − start < 1.4`.
- Then today's merge (`start − prev.end < 0.7` merges, never across a break).
- Then today's `end − start > 0.2` test.

With no breaks, lo = 0 and hi = duration, which is **exactly** today's code. A golden test checks this.

**d.** `rangeSegments`, the camera and anchors are unchanged. During a hold the pointer usually
rests, so a follow-cursor zoom stays steady.

### 6.5 Worked examples (defaults, duration 20)

**Main example.** Click A at 2.0 s at (0.3, 0.3); a wheel event every 0.1 s from 3.0 to 7.0 s at
(0.5, 0.5) with dy = +1 (41 notches, long); click B at 12.0 s.

| Mode | Zooms |
|------|-------|
| `zoom-out` | [1.1, **3.35**] at A; landing L = 8.1 → [7.2, 9.9] anchored at (0.5, 0.5) t 8.1; [11.1, 13.8] at B. The camera is at scale 1 at 5.0 s, and fully in on the landing at 7.9 s. |
| `hold` | [1.1, **8.8**] (7.0 + 1.8) and [11.1, 13.8]. |
| `ignore` | [1.1, 3.8] and [11.1, 13.8], as today. |

In `zoom-out` mode, A's zoom starts leaving at 2.65 s.

**Variants:**

- A 3-notch scroll from 3.0 to 3.2 s is short (a hold): A's zoom ends at 5.0.
- Click A at 2.0 with a long scroll from 5 to 9 s: no landing (A ended before 5 − 1.8 = 3.2), and A's zoom stays [1.1, 3.8].
- Click B at 7.5 after the 3–7 s scroll: no landing (B is within 1.5 s), and B's zoom is
  [**7.2**, 9.4] instead of starting at 6.6 while the page still moves.
- A click at 5.0 inside the 3–7 s scroll splits it into [3.0, 4.9] and [5.0, 7.0], two breaks.
  The click's range is bounded to [5.1, 5.35], shorter than 1.4, so it is dropped. The click still shows its effect and sound.
  - The first break gets no landing, because the click starts within 1.5 s of its end.
  - The second break gets a landing at 8.1 → [7.2, 9.9]: the click at 5.0 counts as a zoom event that ended when this scroll began.
- A second long scroll from 7.9 to 10.0 s (a 0.9 s pause, over the 0.8 s join): the first
  landing (8.1) would be inside it, so there is none; the camera stays at scale 1 through both
  and lands at 11.1 → [10.2, 12.9]. With a 1.3 s pause (8.3–10.0 s) the first landing fits:
  [7.2, 8.65], then [10.2, 12.9].
- With **Hold after** 3.0, a long scroll at 2.2–3.8 s and a 2-notch scroll at 4.7–4.8 s: the
  short scroll is across the break from A, so it does not keep A in. The zooms are [1.1, 2.55]
  and the landing [4.0, 7.9].

### 6.6 Smart speed (`src/shared/editor/smartSpeed.ts`)

`inputGaps` adds every session of `scrollSessions(track.scrolls)` (without cuts) as busy:
`[start − 0.05, end + 0.05]`. Without scroll data the output is identical. The doc comment and
copy become "move, click, scroll or type".

---

## 7. Recording (workstream A)

### Capture (`src/main/cursorTracker.ts`)

**Hook types**

- `HookModule.on` gains a typed `'wheel'` (`rotation`, `amount`, `direction`, `ctrlKey`, `metaKey`) and `'mouseup'`.
- `HOOK_EVENTS` gains `'mouseup'`, so `halt()` removes its listeners.

**Wheel.** Replace `if (activity) uIOhook.on('wheel', …)` with one handler, registered when
`pointer || activity`. In order:

1. Call `activity?.()` first, so auto-pause is unchanged.
2. Return if `!pointer`.
3. Return for Ctrl or Meta held.
4. `tick = observe(e.time)`; `p = hookPointToDip(e)`.
5. Return if `opts.isOwnPoint(p)`.
6. Notches: `finite(e.rotation) ? e.rotation : 0`. They go on the x axis when `e.direction === 4`, otherwise on y.
7. Merge into the last stored event when it is under 50 ms older, on the same axis, with a
   compatible sign (0 is compatible with anything): add the notches, and take the new position.
   Otherwise push `{ tick, x, y, dx, dy }`.

**Releases.** For mousedown of a button 1–3 whose click was stored, remember its index per
button. On `mouseup` (when `pointer`), set that click's `upTick` and clear it. A press on the
app's own window is not stored, so its release pairs with nothing. Wheel buttons on X11 send no
press or release.

**Snapshot.** `snapshot()` adds `scrolls: [{ at, x, y, dx, dy }]` and `clicks[].up` (epoch ms)
when known. `start()` resets both. Checkpoints come from the snapshot, so crash recovery keeps them.

### Track building (`src/main/recording/trackMath.ts`)

**Types.** `RawTrack.clicks[].up?: number` and `RawTrack.scrolls?: { at, x, y, dx, dy }[]` (epoch ms, DIP).

**`buildCursorTrack`:**

- **Window mapping.** `pointToScreen` also converts `raw.scrolls`, so mixed-DPI windows map exactly like clicks.
- **Filters.**
  - `recorded(at)`: events inside pauses are dropped.
  - `place.click(x, y, at)`: displays and areas drop events outside; window recordings drop
    events outside the window or over a covering window (`cursorOver: false`) and map the rest
    through the pose at that instant.
  - `t = time(at)` with `0 ≤ t ≤ end`.
- **Output.** Events are sorted. `scrolls` is set only when `raw.scrolls` exists: new recordings
  get `[]` even without scrolling. The invalid (position-less) track has no `scrolls`.
- **Releases.** Clicks get `up: time(c.up)` when `up` is present.

**`clampTrack`:** `...(track.scrolls ? { scrolls: track.scrolls.filter((s) => s.t <= duration) } : {})`.

### Finalize

Finalize is already wired by this commit: stray clicks are stored, then zooms come from the
effective track. A does not need to change it, but owns it.

### Platforms

- **Windows.** libuiohook accumulates partial deltas into notches (`input_helper.c` 358–376; down = +). *Windows-unverified*.
- **X11 (e2e).** Each wheel button press is ±1 notch.

---

## 8. Editor UX and copy (workstream C)

### Ignoring clicks

**Timeline clip track.** Every recorded in-video click (`clickRows(recorded, inputEdits)`) is a
marker. Today only left clicks show; ripples and sounds play for every button.

| State | Look |
|-------|------|
| Used, left click | 6 px white dot (today's look) |
| Used, right or middle click | 4 px dot |
| Ignored by the user | hollow 6 px ring at 45 % opacity |
| Ignored as stray | the same ring, dashed |
| Selected | accent ring |

**Marker behaviour**

- Attributes: `data-click-ms`, `data-state` (`used` / `ignored` / `stray`), `data-button`.
- Hit area: 12 × 14 px.
- `pointerdown` without Shift: select `{ kind: 'click', ms }`, seek to `t + 0.15` when inside a
  kept clip, and stop propagation (no scrub, no range).
- Shift+drag still selects a range.
- `editor.css` `.click-marker` loses `pointer-events: none`.

**Marker tooltips**

- Used: "Left click at 0:04.2 · select it and press Delete to ignore it (no zoom, click effect or sound)".
  - The key is the first one bound to **Delete selection** in the keymap. With none bound it
    reads "select it to ignore it in the Zoom panel".
  - A click that cannot start an automatic zoom (a middle click, or a right click with Auto zoom ›
    Right clicks off) says "(no click effect or sound)".
- Ignored: "Ignored click at 0:04.2 · select it to use it again".
- Stray: "Ignored automatically at 0:04.2: <reason> · select it to use it again". The reason is one of:
  - `start`: "the first moment of the recording, usually the click that focuses the app";
  - `end`: "right before the recording stopped";
  - `moving`: "made while the cursor was flying past".

**Selection and Delete**

- `selection.ts` gains `{ kind: 'click'; ms: number }`.
  - `validSelection`: finite `ms` within the recording.
  - `selectionKey`: `click:<ms>`.
- Inspector `TAB_FOR.click = 'zoom'`.
- `deleteSelection` on a used click ignores it. On an ignored click it shows "This click is
  already ignored: use it again in the Zoom panel".

**Zoom tab, "Selected click" section** (top of the tab, like Selected zoom)

- Title "Selected click", aside "Left click · 0:04.2".
- Used: "Used: it can start an automatic zoom, shows the click effect, plays the click sound and
  counts as activity for smart speed." Button **Ignore click** (shows the Delete shortcut).
  - For a click that cannot start an automatic zoom (a middle click, or a right click with Right
    clicks off): "Used: it shows the click effect, plays the click sound and counts as activity
    for smart speed." A right click adds "Turn on Auto zoom › Right clicks to zoom for it too."
- Ignored: "Ignored: no zoom, click effect or sound, and smart speed does not count it." A stray
  click adds the reason sentence. Button **Use click**.
- Hint: "Only automatic zooms change; zooms you added or edited stay as they are."

**Selected auto zoom** (`zoomCause`). A line under the time range:

- "Made for the click at 0:04.2", with a ghost button **Ignore this click** (title: "Stop using
  this click: its zoom, click effect and sound go away").
- "Made for typing at 0:20.1".
- "Made for a zoom-here mark at 0:30.0".
- "Zooms back in where scrolling stopped (0:13.0)".

Zooms that were made or edited by hand get no line. After ignoring, the selection clears,
because the zoom is gone.

**Zoom tab › Auto zoom**

- Summary: "14 left clicks (2 ignored) · 1 typing burst · 2 long scrolls detected. …".
- `hasInput` uses the **recorded** clicks, so ignoring every click does not grey the section out.
  The copy then reads "All 14 left clicks are ignored." ("The only left click is ignored." for
  one), a sentence of its own before the other counts: "All 14 left clicks are ignored. 1 typing
  burst detected. …".
- A disclosure **Recorded clicks · 14 · 2 ignored**, scrolling at a max height of 240 px, styled
  like the smart speed parts list:
  - one row per click: a time button (selects and seeks), the button kind, the state, and an
    **Ignore** / **Use** button;
  - below the rows: **Find stray clicks** and **Use all clicks**.

**Cursor tab › Clicks.** The aside reads "14 clicks · 2 ignored", with the title "Ignore or use
clicks in Zoom › Auto zoom, or select a click on the timeline".

**Notices** (with the existing undo hint)

- "Click at 0:04.2 ignored: no zoom, effect or sound · Ctrl+Z to undo"
- "Click at 0:04.2 used again"
- "No click near the playhead"
- "Ignored 2 stray clicks" / "No stray clicks found"
- "All 3 ignored clicks are used again" / "No click is ignored"

### Straightening

**Cursor tab › Motion**

- Toggle **Straighten moves**. Title: "Replaces wobbly moves between two resting points with a
  straight, smooth glide. The recording itself is not changed."
- Hint when on (`pathSummary`): "38 of 52 moves straightened. Drags, loops and moves across a
  click keep their recorded path."
- Disabled like the other Motion controls (`smoothOn`) when the cursor is in the video or there is no cursor data.

**Clip tab › Selected range.** Shown when Flown draws the cursor.

- Field **Cursor path** with buttons **Straighten** and **As recorded**, plus **Reset** when the
  range overlaps painted ranges (mode null).
- Hint: "3 moves here · 1 straightened".
- Notices:
  - "Straightened 2 cursor moves in 0:12.0 – 0:15.4"
  - "No cursor move here can be straightened (1 drag, 1 move across a click)"
  - "Kept the recorded cursor path in 0:12.0 – 0:15.4"
  - "The cursor path in 0:12.0 – 0:15.4 follows Straighten moves again"
- The range stays selected, so the user can compare.

**Timeline.** Straightened moves show as 2 px accent bars along the bottom of the clip track
(`data-testid="path-bar"`, `pointer-events: none`).

### Scrolling

**Zoom tab › Auto zoom.** Chips **While scrolling**:

| Chip | Title |
|------|-------|
| **Zoom out** | "Show the whole page while it scrolls, then zoom in where you stop" |
| **Hold** | "Keep the zoom steady until scrolling stops" |
| **Ignore** | "Scrolling does not change the zooms" |

- Choosing a chip goes through `setAuto({ scrolling })`, which regenerates like the other settings.
- When `recorded.scrolls` is undefined, the chips are disabled with the hint "Scrolling was not
  recorded in this video (it was made before Flown recorded scrolling)."

**Zoom track.** A faint hatched band for each session of `scrollBreaks(cursor, auto)`
(`data-testid="scroll-band"`, `pointer-events: none`). Title: "Scrolling 0:10.0 – 0:13.0: auto
zoom shows the whole page while it moves".

**Smart speed copy.** In ClipPanel and FEATURES.md: "…you did not move, click, scroll or type".

### Commands (`src/shared/editor/commands.ts`; no default keys)

| id | Category | Title |
|----|----------|-------|
| `toggleClickAtPlayhead` | Zoom | Ignore or use the click at the playhead |
| `findStrayClicks` | Zoom | Find stray clicks |
| `useAllClicks` | Zoom | Use all ignored clicks again |
| `toggleStraighten` | Effects (toggle) | Straighten cursor moves |
| `straightenRange` | Edit | Straighten cursor in selected range |
| `recordedPathRange` | Edit | Keep recorded cursor path in selected range |

**Palette availability messages**

- No cursor data: "This recording has no cursor data".
- Straightening with the cursor in the video: "The recorded cursor is in the video".
- Range commands without a range: "Select a range first: Shift+drag on the clip track".
- `useAllClicks` with no ignored click: "No click is ignored".

### Undo

Each of these is one `store.update`, so one undo step:

- ignore and use (with the zoom rebase);
- find stray clicks;
- use all;
- the straighten toggle;
- each range action;
- each scroll mode change.

A click selection survives undo, because `validSelection` only checks the time.

---

## 9. Contracts (this commit)

Signatures and doc comments are in the code. Bodies marked as stubs throw
`not implemented`. A query that the app or the UI calls during render returns a no-op value
instead, so nothing crashes before workstream B lands.

| File | Exports | State |
|------|---------|-------|
| `src/shared/types.ts` | `ClickEvent.up`, `ScrollEvent`, `CursorTrack.scrolls`, `AutoZoomSettings.scrolling`, `ScrollZoomMode`, `StrayReason`, `IgnoredClick`, `PathMode`, `PathRange`, `InputEdits`, `Project.inputEdits` | **frozen** |
| `src/shared/engine/inputData.ts` | `clickKey`, `STRAY_REASONS`, `PATH_MODES`, `MIN_PATH_RANGE`, `paintPathRange`, `readInputEdits`, `readScrolls`, `ClickRow`, `clickRows`, `ignoredKeys` | implemented, **frozen** |
| `src/shared/engine/project.ts` | `migrateProject` (inputEdits), `migrateCursor` (scrolls) | implemented, **frozen** |
| `src/shared/engine/inputTrack.ts` | `InputContext`, `effectiveTrack` | stub returns `recorded` (B) |
| `src/shared/engine/cursorPath.ts` | `PATH`, `MoveReason`, `CursorMove`, `minJerk` (implemented), `cursorMoves` (→ []), `moveAt` (→ null), `straightenSamples` (throws), `PathPlan`, `planCursorPath` (→ samples as recorded) | B |
| `src/shared/engine/scroll.ts` | `SCROLL`, `ScrollSession`, `scrollSessions` (→ []), `isLongScroll` (implemented), `scrollBreaks` (→ []) | B |
| `src/shared/editor/inputEdits.ts` | `STRAY`, `findStrayClicks` (→ []), `setClicksIgnored`, `ignoreStrayClicks`, `useAllClicks`, `clickAtPlayhead`, `setStraighten`, `setPathRange` (all throw), `ZoomCause`, `zoomCause` (→ null), `PathSummary`, `pathSummary` (→ zeros) | B |
| `src/shared/engine/zoom.ts` | `DEFAULT_ZOOM_SETTINGS.auto.scrolling = 'zoom-out'`; `rebaseAutoZooms` (throws); the `autoZoomsForTrack` scroll contract in its doc comment | B |
| `src/main/recording/finalize.ts` | stores `findStrayClicks` results; zooms from `effectiveTrack` | wired |
| `src/renderer/src/views/Editor.tsx` | `recorded = data.cursor`; `cursor = effectiveTrack(recorded, …)` | wired |
| `tests/inputData.test.ts` | sanitisers, painting, `clickRows`, old projects unchanged | **frozen** |

**Signature rule.** An implementer may add internal helpers, and **new** exports when a test
needs them. Changing a frozen file or an exported signature goes through the lead.

---

## 10. Risks

1. **Drags straightened by mistake.**
   - New recordings know releases, so a known drag is never straightened.
   - Old recordings use the 0.25 s guess, in automatic mode only.
   - The option is off by default.
2. **Hover mismatch.** Hover effects in the video follow the recorded path. The wobble (≤ 0.2·L)
   and turning guards bound the drift, "As recorded" fixes any single stretch, and the option is off by default.
3. **Rebase exactness.**
   - `rebaseAutoZooms` relies on deterministic generation.
   - Zooms from an older generator, or clamped after a duration correction, do not match. The
     anchor fallback still removes the ignored click's own zoom; a stale multi-click zoom keeps
     its length until Regenerate.
   - Unit tests cover both cases.
4. **Click key collisions.** Two clicks in the same millisecond are ignored together. In practice
   they are duplicates.
5. **Stray false positives.** A deliberate first click, a Submit right before stopping, or a
   flick-click can be detected.
   - Every result is visible (dashed marker, list, tooltip) and one action restores it.
   - Detection never re-runs on its own.
   - The full e2e suite (recording-input, -region, -window, polish) must still pass: xinput
     clicks teleport, wait 50 ms and then click, so they are one-sided.
6. **Scroll semantics.** Notches are not page distance:
   - lines per notch is not stored;
   - keyboard scrolling, scrollbar drags and touch panning are not seen;
   - browser smooth scrolling and inertia outlast the last wheel event (`SCROLL.rest` 0.2 s);
   - a fast flick (< 1.5 s) holds the zoom instead of zooming out;
   - a landing aims at the last wheel position, which can be a parked pointer.
   "Hold" and "Ignore" are one click away.
7. **Old projects identical.** Three things must hold, each covered by golden tests:
   - `effectiveTrack` returns the same object;
   - the no-break path in `zoomsFromEvents` matches today's arithmetic;
   - stored zooms are never regenerated on open.
8. **New behaviour for new recordings.** New recordings now start with stray clicks ignored and
   with scroll-aware zooms. This is intended and documented in FEATURES.md.
9. **Timeline hit targets.** Interactive markers on the clip track could intercept clicks in
   existing e2e tests. C runs the whole e2e suite.
10. **Parallel branch (camera director, NW-08).** It edits `types.ts` (`LayoutSegment`, director
    settings), `project.ts` and probably `finalize.ts`, `Editor.tsx` and `commands.ts`.
    - Our `Project.inputEdits` sits after `zoomSettings`, away from the end of the interface.
    - The `migrateProject` destructure line and the commands list may conflict textually; keep both sides.
    - `LayoutSegment`, `WebcamSettings` and camera code are untouched here.
11. **Performance.**
    - Rest detection is O(n·k), cached per samples array. An hour of 60 Hz movement is about 200 k samples, under 50 ms.
    - Synthetic samples exist only inside straightened moves.
    - The tracker merges wheel events (about 20/s at most).
12. ***Windows-unverified*.**
    - wheel rotation for precision touchpads and high-resolution wheels;
    - `mouseup` delivery while the native helper runs;
    - wheel coordinates on mixed-DPI setups (the same path as clicks).

---

## 11. Test plan

### Unit tests (vitest)

**Contract tests (this commit, `tests/inputData.test.ts`)**

- `clickKey`.
- `readInputEdits`: cleaning, precedence, painting, idempotence, and old projects getting no key.
- `paintPathRange`.
- `readScrolls`.
- `clickRows`: buttons, out-of-video clicks, cache identity.
- `migrateCursor` and `migrateProject` keys.
- `zoomSettingsOf` default.
- `effectiveTrack` identity.

**B: `tests/inputTrack.test.ts`**

- No edits, or `cursorInVideo` with `straighten`: returns the track itself (`toBe`).
- Ignoring 4000 of clicks [2, 4, 9] gives effective clicks [2, 9]. The recorded track is frozen
  and unchanged, and the samples array keeps its identity.
- Memo identity for the same inputs.
- `soundingClicks` and `clickSoundJob` on the effective track exclude ignored clicks.
- `inputGaps` loses the activity of ignored clicks.

**B: `tests/cursorPath.test.ts`**

- `minJerk`: values, and end derivatives below 1e-6.
- The §5.6 fixture: exact positions (1e-9 / 1e-4), same objects outside the move.
- Every variant of §5.6.
- Sparse still periods (two samples, plus a `holdSamples` sample) found as rests. Run
  `buildCursorTrack` on tracker-style raw samples.
- Precedence (option, `'recorded'` and `'straight'` ranges).
- `off-frame` is never straightened.
- An overshoot-and-return is straightened; a 0.05 loop is `gesture`.

**B: `tests/scrollZoom.test.ts`**

- Sessions: events 0.8 s apart join and 0.81 s apart split; cut at clicks; long/short with 3 vs 4 notches.
- Every §6.5 example, exact ranges and anchors, in all three modes.
- `cameraAt(5.0).scale === 1` in the main example.
- Typing overlapping a scroll gives no break.
- Two long scrolls 0.9 s apart: no landing inside the second, one after it.
- A short scroll across a break from a zoom (Hold after 3.0) does not keep that zoom in.
- **Golden parity:** every fixture of `autoZoomTrack.test.ts` and `zoom.test.ts`, with `scrolls`
  absent, `[]`, and with scrolls under `'ignore'`, deep-equals today's output (ids stripped).

**B: `tests/inputEdits.test.ts`**

- `findStrayClicks` on the §4.2 examples, including the drag guard (`up − t ≥ 0.25` is never `moving`).
- `setClicksIgnored` / rebase on the §4.3 example:
  - ids kept;
  - a deleted zoom stays deleted;
  - manual zooms untouched;
  - auto zoom off leaves zooms alone;
  - nothing changed returns the same object;
  - the stale-anchor fallback;
  - a deleted zoom stays deleted when its own clicks are ignored or used (and after Remove all);
  - a kept zoom survives when the merge that would replace it covers a deleted one (clicks 2, 5
    and 8, either half deleted) or one the user made, and a chain of such merges keeps every
    kept zoom.
- `ignoreStrayClicks`, `useAllClicks`.
- `clickAtPlayhead`: zoom anchor first, then nearest within 1 s.
- `zoomCause` for all four kinds.
- `setStraighten` and `setPathRange`: key removal, identity when unchanged.
- `pathSummary` counts; it shares the effective track's cached plan, so ignoring a click after
  any number of summaries keeps the same `samples` array.

**B: `tests/smartSpeed.test.ts`**

- Wheel events every 0.5 s over 10–14 s leave no gap inside [9.95, 14.05].
- Without scrolls, the output is unchanged.

**A: `tests/cursorTracker.test.ts`**

- A wheel event `{ time, x 200, y 100, rotation 1, direction 3 }` gives DIP (100, 50) with dy 1.
- 30 ms apart merges; 60 ms apart stays separate; direction 4 goes to dx.
- Ctrl+wheel, and a wheel over the toolbar, are dropped.
- Activity still fires for every wheel event.
- A keys-only capture stores none.
- `mouseup` sets `up`. A release after a dropped toolbar press pairs with nothing.

**A: `tests/trackMath.test.ts`, `tests/windowCapture.test.ts`**

- Scrolls are remapped through a region; outside the region and paused events are dropped; time maps across pauses.
- `up` is mapped.
- A raw track without `scrolls` gives no key; the invalid track has no scrolls.
- `clampTrack` filters scrolls.
- Window poses: mapped before and after a move; `cursorOver: false` drops; `pointToScreen` is applied.

### End to end (Playwright under Xvfb)

**C: new `tests/e2e/smart-zoom.e2e.cjs`.** Projects are seeded with `render-fixtures` and then
`project.json` / `cursor.json` are patched inside the test file. The fixtures themselves stay unchanged.

1. **"ignoring a stray click removes its zoom, effect and sound; undo restores it"**
   - Setup:
     - a 16 s solid grey video (`fx.solidVideo`), native capture;
     - ring click effect in `#ff0000`, click sound on;
     - clicks 0.3 @ (0.2, 0.2), 4.0 @ (0.7, 0.3) and 9.0 @ (0.3, 0.7), with the cursor resting at each;
     - a manual zoom [12, 15].
   - Regenerate: 3 auto zooms, [0, 2.2], [3.1, 5.8] and [8.1, 10.8].
   - Click the marker `[data-click-ms="4000"]`. "Selected click" shows; press Delete.
   - Saved `inputEdits.ignoredClicks = [{ ms: 4000 }]`. There is no auto zoom anchored at 4.0,
     the 9 s zoom keeps its id, and the manual zoom is kept. The marker shows `data-state="ignored"`.
   - Ctrl+Z restores both, the zoom with its old start and end.
   - Palette "Find stray clicks" ignores 0.3 as `start` (`data-state="stray"`), and its [0, 2.2] zoom goes away.
   - Select the auto zoom at 9 s and click "Ignore this click": that zoom goes away.
   - Export 720p60. Count reddish pixels over the whole frame, so the camera does not matter:
     - more than 100 at 4.15 s (used);
     - none at 0.45 s and none at 9.15 s (ignored);
     - `beepOnsets` gives exactly one onset, at 4.0 ± 0.03.
2. **"straightened moves: straight in preview and export, ranges override, undo"**
   - The §5.6 track with amplitude 0.05; cursor shown, style white, size 2, smoothing 0.
   - Export with the option off, then turn on Straighten moves and export again.
   - Cursor centroid at 1.15 / 1.3 / 1.45 s: within 3 px of the A–B line when on; at least
     15 px off at 1.3 s when off.
   - Equal at 0.9 and 1.8 s (±1 px).
   - The preview at 1.3 s is within 4 px of the export frame.
   - Shift-drag 0.8–1.8 s, then **As recorded**: saved `paths: [{ mode: 'recorded' }]` and the
     wobble is back. Ctrl+Z removes it.
   - Follow-cursor 2× zoom [0, 3] on the gradient video: camera cy varies by ≤ 0.005 across
     1.0–1.6 s when straightened, and by ≥ 0.01 as recorded.
3. **"follow scrolling: zooms out during a long scroll and back in where it stops"**
   - The §6.5 main example on a gradient video, with the cursor resting at (0.5, 0.5) from 2.5 s on.
   - Regenerate gives the `zoom-out` ranges. The camera, measured from pixels, is scale 1 at
     5.0 s and ≥ 1.75 at 8.5 s around (0.5, 0.5). `scroll-band` is visible.
   - Choose **Hold**: `scrolling: 'hold'` is saved and the camera is zoomed in at 5.0 s. Ctrl+Z.
   - A second project without `scrolls`: the chips are disabled with the hint, and Regenerate
     gives exactly [1.1, 3.8] and [11.1, 13.8].
4. **"click markers: under the restore button of a cut, copy that fits the click"**
   - A left click at 4.0 s inside a cut [3.5, 4.5], and a middle click at 8.0 s.
   - The cut's restore button is on top at its lower edge, over the click's marker: a press
     there restores the cut and selects no click (`.gap-restore` has z-index 4).
   - The tooltips: "press Delete … (no zoom, click effect or sound)" for the left click, "(no
     click effect or sound)" for the middle one, whose Selected click text promises no zoom.
   - Ignoring the left click: the summary starts "The only left click is ignored. Changing these settings".

**A: recording e2e**

- `tests/e2e/xinput.py` gains:
  - `w X Y N [GAP]`: move, then |N| presses of X button 5 (N > 0) or 4, 30 ms down, GAP (default 0.08 s) apart;
  - `d X0 Y0 X1 Y1 SECS`: press, glide, release.
- `recording-input.e2e.cjs`: `w 960 540 6; s 0.4; w 960 540 -3`, a wheel over the toolbar, and a
  wheel while paused. Check:
  - Σdy = +6 then −3;
  - positions within 0.01 of the centre;
  - nothing at the toolbar and nothing while paused;
  - every content click has `0.03 < up − t < 0.3`;
  - the drag's `up` covers the glide.
- `recording-window.e2e.cjs`:
  - a wheel inside the window, before and after it moves, maps like the click checks (±0.01);
  - a wheel outside is dropped;
  - a wheel over the covering window (scenario d) is dropped.

**Regression.** The whole existing e2e suite (`xvfb-run -a npm run test:e2e` after `npm run
build`) passes after the merge, as do `npm test` and both `tsc` projects.

---

## Work split

Three parallel workstreams, each on its own branch from `feat/autozoom-contracts`. **Files are
owned by exactly one workstream.** A file not listed is out of bounds; ask the lead.

### Frozen after the contracts commit (no workstream edits them)

- `src/shared/types.ts`
- `src/shared/engine/inputData.ts`
- `src/shared/engine/project.ts`
- `tests/inputData.test.ts`
- `docs/design/smarter-auto-zoom.md`
- `docs/IMPLEMENTATION.md`
- the exported signatures and doc contracts of `inputTrack.ts`, `cursorPath.ts`, `scroll.ts`,
  `editor/inputEdits.ts` and `zoom.ts` `rebaseAutoZooms` (their **bodies** belong to B)
- the e2e fixtures `tests/e2e/render-fixtures.cjs`, `editor-fixtures.cjs` and `helpers.cjs`
- these files, which need no change because they already read the effective track:
  - `src/shared/render/clickSound.ts`
  - `src/shared/render/cursorFx.ts`
  - `src/renderer/src/render/*`
  - `src/renderer/src/editor/player.ts`
  - `src/renderer/src/editor/exporter.ts`
  - `src/renderer/src/editor/ExportDialog.tsx`
  - `src/renderer/src/editor/PreviewStage.tsx`
  - `src/renderer/src/editor/playheadItems.ts`
  - `src/shared/editor/styleDefaults.ts`

### A: recording (main process)

- **Owns:**
  - `src/main/cursorTracker.ts`
  - `src/main/recording/trackMath.ts`
  - `src/main/recording/finalize.ts` (already wired; change only if needed)
  - `src/main/recordingIpc.ts` (only if needed)
  - `tests/cursorTracker.test.ts`
  - `tests/trackMath.test.ts`
  - `tests/windowCapture.test.ts`
  - `tests/inputActivity.test.ts`
  - `tests/e2e/xinput.py`
  - `tests/e2e/recording-input.e2e.cjs`
  - `tests/e2e/recording-window.e2e.cjs`
  - `tests/fixtures/fake-capture-helper.cjs` (only if needed; window rectangles already cover moves and covering windows)
- **Builds:** §7. Wheel capture with coalescing, the Ctrl filter and own-window filter, release
  pairing (`up`), `RawTrack` fields, pause/region/window mapping for scrolls, `clampTrack`.
- **Verifies:**
  - `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
  - `npx vitest run --testTimeout=60000`
  - `npm run build && xvfb-run -a node tests/e2e/run-all.cjs recording-input recording-window recording-region recording.e2e`

### B: pure logic (src/shared)

- **Owns:**
  - `src/shared/engine/inputTrack.ts`
  - `src/shared/engine/cursorPath.ts`
  - `src/shared/engine/scroll.ts`
  - `src/shared/editor/inputEdits.ts`
  - `src/shared/engine/zoom.ts` (only `autoZoomsForTrack`, `zoomsFromEvents` and its helpers, and `rebaseAutoZooms`)
  - `src/shared/editor/smartSpeed.ts`
  - new tests: `tests/inputTrack.test.ts`, `tests/cursorPath.test.ts`, `tests/scrollZoom.test.ts`, `tests/inputEdits.test.ts`
  - additions to `tests/smartSpeed.test.ts` and `tests/clickSound.test.ts`
- **Builds:** §3–§6 exactly, with the numbers given. Memoisation as in §3. The golden parity test is required.
- **Verifies:** both `tsc` projects and `npx vitest run --testTimeout=60000`. The existing
  `autoZoomTrack`, `zoom`, `zoomCamera`, `smartSpeed`, `clickSound`, `tilt` and `cursor` tests
  pass **unchanged**.

### C: UI

- **Owns:**
  - `src/renderer/src/views/Editor.tsx`
  - `src/renderer/src/editor/Timeline.tsx`
  - `src/renderer/src/editor/selection.ts`
  - `src/renderer/src/editor/Inspector.tsx`
  - `src/renderer/src/editor/panels/ZoomPanel.tsx`
  - `src/renderer/src/editor/panels/CursorPanel.tsx`
  - `src/renderer/src/editor/panels/ClipPanel.tsx`
  - `src/renderer/src/editor/editor.css`, `src/renderer/src/editor/zoom.css`
  - `src/renderer/src/editor/panels/cursorPanel.css`, `src/renderer/src/editor/panels/clipPanel.css`
  - `src/shared/editor/commands.ts`, `src/shared/editor/shortcuts.ts` (no default bindings)
  - `tests/commands.test.ts`, `tests/shortcuts.test.ts`
  - new `tests/e2e/smart-zoom.e2e.cjs`
  - `docs/FEATURES.md`, `docs/ROADMAP.md` (NW-03 shipped), `README.md` (Windows-unverified list)
- **Builds:** §8. Pass the **recorded** track and `clickRows` to the Timeline and Inspector next
  to the effective `cursor`. All edits go through the `editor/inputEdits.ts` operations inside
  `store.update`.
- **Verifies:**
  - both `tsc` projects and vitest;
  - after B is merged (C may merge B into a local test branch, committing only its own files):
    `npm run build && xvfb-run -a node tests/e2e/run-all.cjs smart-zoom`;
  - the full e2e suite.

**Merge order:** B, then A, then C. Then run the full suite: both `tsc` projects, vitest, build,
and all e2e.

---

## Later

- Straightening on by default for new recordings, after real recordings show the hover drift is acceptable.
- Carrying "Straighten moves" in "Save as default style" (would move or mirror the option into `CursorSettings`).
- A default key for "Ignore or use the click at the playhead" (`I`).
- A click overlay on the preview.
- Stray detection from the picture (a click with no visible effect).
- Zooming out for fast flicks, using page distance (`amount`, lines per notch).
- Keyboard scrolling (PageDown, Space), scrollbar drags, touch panning.
- A "dismissed auto zoom" memory, so a full Regenerate does not bring back zooms the user deleted.
- Dragging a cursor path on the preview.
- A palette command for the scroll mode.
- Moving the anchor of an edited zoom whose click was ignored.
