# Build report: smarter auto zoom, workstream B (pure logic)

Branch `feat-w5-zoom-b`, from `5dbaccb` (contracts). Spec: `docs/design/smarter-auto-zoom.md`.
Only B's files were changed, plus one assertion in `tests/nativeVideo.test.ts` (see
[Deviations](#deviations-and-decisions)). No frozen file and no exported signature was changed.

## What was built, per spec section

### §3 The effective track (`src/shared/engine/inputTrack.ts`)

- `effectiveTrack` follows steps 1–4 exactly. An invalid track, a project without edits, ignored
  keys that name no click, and `capture.cursorInVideo` with straightening all return `recorded`
  itself.
- Clicks: filtered by `clickKey`. When no click is ignored, the same `recorded.clicks` array is
  kept.
- Samples: `planCursorPath(recorded, …)` only when Flown draws the cursor and the project has
  `straighten` or `paths`. The plan reads the **recorded** clicks, so an ignored click still
  blocks straightening.
- Memoisation works in three layers:
  - per recorded track, on samples, clicks, scrolls, the `ignoredClicks` and `paths` arrays,
    `straighten`, the aspect and `cursorInVideo`;
  - filtered clicks per (clicks, ignoredClicks) arrays;
  - plans per (samples, clicks, scrolls, aspect) and (straighten, paths).

  So ignoring a click keeps the samples array, toggling straightening keeps the clicks array, and
  going back returns the same arrays again.
- Cost on an hour of 60 Hz movement (216 k samples, about 1 800 moves, 900 clicks, 5 000 wheel
  events):
  - move detection: about 20 ms warm, 63 ms cold;
  - the straightened samples: about 20 ms;
  - a memo hit: 0.01 ms;
  - ignoring one more click: 0.5 ms;
  - `autoZoomsForTrack` with those scrolls: about 40 ms.

### §4 Ignore stray clicks (`src/shared/editor/inputEdits.ts`, `zoom.ts` `rebaseAutoZooms`)

- **`findStrayClicks`** checks only in-video clicks (every button) and gives each the first reason
  that fits:
  - `start`: `t < 0.6`;
  - `end`: `t > duration − 0.6`, with no click, key, mark or scroll after it and no typing
    burst ending after it;
  - `moving`: `cursorAt` 0.08 s before, at and after the click; both moves at least 0.04
    aspect-corrected video heights; cosine ≥ √½; not held (`up − t ≥ 0.25`).
- **`setClicksIgnored`** merges entries by `ms`, removes `use` keys, sorts the list, and drops an
  empty list and empty `inputEdits`. It keeps the identity of the other edit arrays. It returns
  `p` itself when the set of ignored keys does not change. When auto zoom is on, it rebases the
  zooms with `before`/`after` from `autoZoomsForTrack(effectiveTrack(recorded, p / next))` and
  the newly ignored keys.
- **`rebaseAutoZooms`** implements exactly the same / keep / drop / anchor-fallback / add / sort
  rules, and returns `zooms` itself when nothing changes.
- **`ignoreStrayClicks`**, **`useAllClicks`**, **`clickAtPlayhead`** (the zoom anchor first, then
  the nearest row within 1 s, the later one on a tie) and **`zoomCause`** (typing → click → mark →
  scroll landing; null for `auto: false`) follow the spec.

### §5 Straighten cursor paths (`src/shared/engine/cursorPath.ts`)

- **Rests:** the walk from §5.1, with squared distances.
- **Moves:** between consecutive rests, with wobble against the chord *segment* and turning on the
  path resampled every 0.02 of arc length.
- **Hard blocks** (both modes): `off-frame`, `click`, `scroll`, `drag`.
  - A trusted `up` is finite and `≥ t`.
  - Click and scroll checks use binary searches over sorted times.
  - Drags are found with a running maximum of release times.
- **Automatic mode:** `drag-guess` (clicks without a trusted `up`), `short`, `long`, `small`,
  `wobbly` and `gesture`, in that order.
- **Manual mode:** `long` (> 10 s) and `small` (< 0.01).
- **`planCursorPath`:** the range containing the midpoint decides (`start ≤ mid < end`).
- **`straightenSamples`:**
  - synthetic samples at `t0 + k/120` for k = 1 … ⌈(t1 − t0)·120⌉ − 1, with a 1e-9 guard so
    float noise never puts a sample on t1;
  - all other samples stay the same objects;
  - returns `samples` itself when no move is straightened.
- **`moveAt`:** a binary search.
- New export **`pathModeAt(paths, t)`**: `pathSummary` and the tests use it.

### §6 Follow scrolling (`scroll.ts`, `zoom.ts`, `smartSpeed.ts`)

- **`scrollSessions`** joins events at most 0.8 s apart (1e-9 tolerance). A cut in
  `(previous event, event]` starts a new session. It records `start`, `end`, `notches`, `count`
  and `last`.
- **`autoZoomsForTrack`** is split into `autoZoomInput` (today's code, unchanged) and
  `planScroll`:
  - cuts at every zoom-event instant (`t0` and `t1` of clicks, marks and typing sessions);
  - breaks are long sessions that overlap no typing session (strict overlap);
  - holds are the rest of the sessions;
  - landings are placed in break order, with the three §6.3 conditions.
- **`zoomsFromEvents`** gains the §6.4 rules:
  - no clustering across a break;
  - holds interleaved with the events in time order (an event first on a tie);
  - `lo`/`hi` bounds;
  - the drop rule when a break set a bound (1e-9 tolerance);
  - no merging across a break.

  Without breaks, `lo = 0` and `hi = duration`, so the arithmetic is the old code.
- New export **`scrollZoomPlan(track, settings, duration?)`** gives the breaks, holds and landings
  exactly as `autoZoomsForTrack` sees them. `scrollBreaks` returns its `breaks`, so the editor's
  bands and summary always agree with the generator.
- **`inputGaps`** adds every `scrollSessions(track.scrolls)` session as busy,
  `[start − 0.05, end + 0.05]`. Its doc comments now say "move, click, scroll or type".

## Deviations and decisions

1. **`tests/nativeVideo.test.ts` (not a B file) was failing, and I changed one assertion.**
   - Its "native window recording" fixture is a 2 s recording with clicks at 0.5 s and 1.5 s.
   - The spec's own rules make both stray: `start`, and `end` (in the last 0.6 s with nothing
     after).
   - Finalize was already wired to store stray clicks, so the project gets no auto zoom. That is
     intended behaviour (spec §10 risk 8). The old assertion `zooms.length > 0` encoded the
     pre-feature behaviour.
   - The test now checks:
     - the stored `inputEdits` (`start` and `end`);
     - that there are no zooms;
     - that `useAllClicks` brings the zooms back.

     So it still covers zoom generation through the window mapping.
   - **The lead should confirm this**, or move the test to whoever owns it.
2. **`zoom.ts` and `scroll.ts` import each other.**
   - `zoom.ts` needs `scrollSessions`, and `scrollBreaks` must match the generator exactly
     (typing sessions and zoom events are private to `zoom.ts`).
   - Neither module uses the other at load time, so the cycle is safe. `npm run build` reports no
     warning.
3. **"No click changes state" (§4.3 step 2)** is read as "the set of ignored keys does not
   change". So the user ignoring a click that detection already ignored returns `p`, and the
   entry keeps its `stray` reason. A stray entry is replaced by the user's only when the same
   call also changes another click.
4. **`setClicksIgnored` only stores keys that name a recorded click** (any button, in or out of
   the video).
   - Ignoring a key that names no click changes nothing.
   - `use` removes any stored key, stale ones too, so "Use all clicks" also cleans up.
5. **`setPathRange` clamps the range to `[0, duration]`** before painting, as `readInputEdits`
   does on load, so a saved project reads back identically.
6. **`pathSummary` `kept` reasons:**
   - in a `'straight'` range: the manual reason;
   - outside every range: the automatic reason, **whether or not the option is on**, so "why
     would the option keep these" can be shown before turning it on;
   - in a `'recorded'` range: not counted (kept by choice).
7. **Breaks and typing:** "no overlap with a typing session" uses strict overlap. A scroll
   session that starts exactly where typing ends (which the cut makes possible) can be a break.
8. **The landing's "zoom was in" test** uses zoom-event `t1` values only, as written. A zoom held
   in by a short scroll does not count as "in" for a later long scroll.
9. **`findStrayClicks` `end` rule:** "input after it" means strictly later. A key at the same
   instant does not keep the click.

## Tests

New files:

- **`tests/inputTrack.test.ts`** (7):
  - identity without edits, with cursorInVideo, with unknown keys, and for invalid tracks;
  - ignoring 4000 of [2, 4, 9] on a deep-frozen track, with the samples identity kept;
  - straightening keeps the clicks array, and an ignored click still blocks;
  - memo identity both ways;
  - aspect;
  - `soundingClicks` and `clickSoundJob`;
  - `inputGaps`.
- **`tests/cursorPath.test.ts`** (21):
  - `minJerk` values and end derivatives;
  - the §5.6 fixture: rests, move, wobble, exact positions at 1.30 (1e-9) and 1.06 (1e-4), the
    71 synthetic samples on the profile, same objects outside the move;
  - every §5.6 variant: drag, untrusted `up`, drag-guess (with the 0.25 s edge), click, scroll,
    off-frame, wobbly, long (option vs range, manual > 10 s), short and small;
  - overshoot-and-return straightened, and a 0.05 loop as a `gesture`;
  - precedence of option, `'recorded'` and `'straight'`, and the midpoint rule;
  - tracker-style sparse samples through `buildCursorTrack`, including the `holdSamples`
    sample.
- **`tests/scrollZoom.test.ts`** (23 cases, plus every fixture of `autoZoomTrack.test.ts` and
  `zoom.test.ts` run through the parity wrapper):
  - **Golden parity:**
    - `vi.mock` wraps `autoZoomsForTrack` and `generateAutoZooms`. Every call that the two
      existing test files make (they are imported and run again inside this file, 38 checked
      calls) is compared with a **verbatim copy of the generator at 5dbaccb** (ids stripped),
      and with the same track with `scrolls: []` and with wheel events everywhere under
      `'ignore'`.
    - 400 fuzzed recordings (clicks of every button, off-frame clicks, typing, marks, random
      settings, tiny durations, invalid tracks) go through the same checks.
    - 100 more fuzzed recordings check that `'hold'` and `'zoom-out'` without scroll data
      also equal the old output.
    - A mutation check confirmed that the wrapper catches a 1 ms change to the zoom
      arithmetic.
  - **Sessions:** 0.8 s joins and 0.81 s splits; fields; cuts (an event at a cut starts the next
    session); long with 4 notches vs 3.
  - **§6.5 main example in all three modes:** exact ranges and anchors, A leaving at 2.65 s,
    `cameraAt(5.0).scale === 1`, fully in at 7.9 s.
  - **Every variant in all three modes.**
  - Typing over a scroll gives no break.
  - No landing past the end.
  - No clustering or merging across a break.
  - Absent `scrolling` means `'zoom-out'`.
  - `scrollBreaks` per mode.
  - Scrolling alone makes no zoom.
- **`tests/inputEdits.test.ts`** (27):
  - **`findStrayClicks`:**
    - the §4.2 edge example;
    - every kind of later input for `end`;
    - the swipe (`moving`, and not `moving` at its end or on arrival);
    - the drag guard (`up − t ≥ 0.25` is never `moving`);
    - the 45° rule;
    - in-video only, and invalid tracks.
  - **§4.3 example:**
    - generator output [1.1, 5.8], [8.1, 10.8];
    - ignoring 4 keeps ids and the manual zoom;
    - using 4 again restores the zoom;
    - a deleted zoom stays deleted;
    - edited zooms are untouched;
    - auto zoom off;
    - unchanged returns the same object;
    - the stale-anchor fallback (and a stale multi-click zoom kept);
    - key and list removal with identity kept;
    - the user's entry replacing detection's;
    - rebase identity.
  - **`ignoreStrayClicks`** and **`useAllClicks`**.
  - **`clickAtPlayhead`:** zoom anchor first, then nearest, tie, ignored rows, manual and typing
    zooms.
  - **`zoomCause`:** all four kinds; null for manual zooms, for zooms without an anchor, for an
    ignored click, and for scroll in hold mode.
  - **`setStraighten`** and **`setPathRange`:** key removal, identity, clamping.
  - **`pathSummary`:** counts, a range, `'recorded'` and `'straight'` ranges, zeros.

Additions to existing files:

- **`tests/smartSpeed.test.ts`**:
  - wheel events every 0.5 s over 10–14 s leave no gap inside [9.95, 14.05];
  - separate sessions leave a hole;
  - without scroll data the output equals `scrolls: []` and a copy of the old `inputGaps`.
- **`tests/clickSound.test.ts`**: ignored clicks (any button) make no sound in `soundingClicks`
  or `clickSoundJob`; with every click ignored there is no job; without edits the result is
  identical.

The existing `autoZoomTrack`, `zoom`, `zoomCamera`, `smartSpeed`, `clickSound`, `tilt` and
`cursor` tests are unchanged and pass.

## Verification

- `npm ci`: OK.
- `npm run typecheck` (both `tsc` projects): exit 0.
- `npx vitest run --testTimeout=60000`: **126 files, 1668 tests passed**, 0 failed.
- `npm run build`: exit 0. The only warning is the existing chunk-size one; there is no
  circular-import warning.
- E2E (`xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs zoom cursor editor`,
  after installing `openbox`): running; results below when finished.
