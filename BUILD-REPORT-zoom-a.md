# Build report: smarter auto zoom, workstream A (recording)

Branch `feat-w5-zoom-a`, from `5dbaccb` (contracts commit). Spec: `docs/design/smarter-auto-zoom.md` §7 and
"Work split".

## What was built

Only files owned by A were changed. No frozen files or exported signatures were changed.
`finalize.ts`, `recordingIpc.ts` and `fake-capture-helper.cjs` needed no change.

### `src/main/cursorTracker.ts`

- `HookModule.on` has a typed `'wheel'` overload (`rotation`, `amount`, `direction`, `ctrlKey`, `metaKey`)
  and takes `'mouseup'`. `HOOK_EVENTS` includes `'mouseup'`, so `halt()` removes its listeners.
- **Wheel.** There is now one handler, registered when `pointer || activity`. It replaces the old
  activity-only listener. In order, it:
  1. calls `activity?.()`;
  2. returns when the pointer is not tracked;
  3. returns when Ctrl or Meta is held;
  4. reads `observe(e.time)` and `hookPointToDip(e)`;
  5. returns over the app's own windows (`isOwnPoint`);
  6. takes the notches as `finite(rotation) ? rotation : 0`, on x when `direction === 4`, otherwise on y.

  A wheel event is merged into the last stored one when that event is under 50 ms older, on the same
  axis, with a compatible sign (the product of the notches is ≥ 0, so 0 goes with anything). The merged
  event adds the notches and takes the new position. Otherwise a new event is pushed.
- **Releases.** For a stored press of buttons 1–3, the tracker remembers the click's index for that
  button. On `mouseup`, registered when the pointer is tracked, it sets that click's `upTick` and clears
  the index.
- **Snapshot.** `snapshot()` adds `scrolls: [{ at, x, y, dx, dy }]` and `clicks[].up` (epoch ms, only when
  known). `start()` resets both. Checkpoints and crash recovery use the snapshot, so they keep both.

### `src/main/recording/trackMath.ts`

- `RawTrack.clicks[].up?: number` and `RawTrack.scrolls?: { at, x, y, dx, dy }[]`.
- `buildCursorTrack`:
  - The window `pointToScreen` conversion also converts `raw.scrolls`.
  - Clicks and scrolls share one placement step: `recorded(at)` (pauses), then `place.click(x, y, at)`
    (display, area or window pose, including `cursorOver: false`), then `0 ≤ t ≤ end`.
  - Scrolls are sorted. The `scrolls` key is set only when `raw.scrolls` exists, so a new recording gets
    `[]` even with no scrolling. The invalid track has no `scrolls`.
  - Clicks get `up: time(c.up)` when `up` is present.
- `clampTrack` filters `scrolls` by the final duration and keeps an absent key absent.

### `tests/e2e/xinput.py`

- `w X Y N [GAP]`: moves to X Y, then makes |N| presses of X button 5 (N > 0) or 4 (N < 0). Each press is
  held 30 ms, and presses are GAP apart (default 0.08 s).
- `d X0 Y0 X1 Y1 SECS`: presses at X0 Y0, glides to X1 Y1 over SECS, then releases.

## Deviations and decisions (spec gaps)

1. **Reference point for the 50 ms merge.** "Under 50 ms older" is measured from the stored event's own
   time. The merged event keeps the time of its first wheel event; only its position is updated.
   - If the time moved forward on each merge, a steady wheel stream (one event every 16–30 ms) would
     collapse into a single event. A single event has `start == end`, so §6.1 could never see a long
     scroll (≥ 1.5 s).
   - With this rule the tracker stores at most 20 events per second, which matches §10.11 ("about 20/s
     at most").
2. **Releases after a dropped press.** Any new press of a button clears the pending index for that
   button, including a press on the toolbar, which is not stored. So a release can never pair with an
   older click of the same button. This is how the spec's rule "a release after a dropped toolbar press
   pairs with nothing" is implemented.
3. **`mouseup` is not reported as activity.** The spec says nothing about this. The press already counts
   as activity for auto-pause, so auto-pause is unchanged.
4. **`up` is not clamped by `clampTrack`.** The spec says nothing about this either. The types say
   consumers validate `up` (finite and `>= t`), and `time()` is monotonic, so a release is never before
   its press.
5. **Order of the Ctrl check.** The order in §7 is followed: the Ctrl/Meta check comes before
   `observe()`. A Ctrl+wheel therefore does not feed the hook clock. This is harmless.
6. **Updated existing test in `tests/inputActivity.test.ts`.**
   - The test "without auto-pause registers no extra listeners" expected 0 wheel listeners for a
     pointer recording without auto-pause.
   - §7 now requires a wheel handler whenever the pointer is tracked. The test now expects one `wheel`
     and one `mouseup` listener when the pointer is tracked, and no mouse listeners for a keys-only
     capture.
7. **Wheel "outside the window" in `recording-window.e2e.cjs`.**
   - On the bare desktop, openbox switches virtual desktops on a root-window wheel. That hid the
     recorded xterm: x11grab failed with BadMatch, and the window disappeared from the source list for
     the following scenarios. I confirmed this against the unmodified baseline, which passes.
   - The outside wheel is therefore turned over a second, small xterm (`SSW-OUTSIDE`, at +1550+40). The
     test starts it for each recording and kills it afterwards.
   - The §11 test plan does not mention this.
8. **Area recording e2e.** `recording-region.e2e.cjs` is not an A-owned file. The area check is a second
   test in `recording-input.e2e.cjs`: it picks an area with the overlay, then checks scrolls and releases
   inside the area and drops the input outside it.
9. **Tolerances in the window e2e.** Wheel positions are checked within ±0.01, as §11 asks. The existing
   click checks keep their ±0.02.
10. **X11 wheel buttons.** On X11, wheel buttons send no press or release. This is confirmed by the e2e
    tests: the click counts are exact, and every scroll lands as ±1 notch per button press.

Note: these e2e tests ran against B's stubs (`findStrayClicks` returns `[]`, `scrollBreaks` returns
`[]`). The scrolls in the tests are short (≤ 1.3 s), so with B's logic they are holds and not long
scrolls. The xinput clicks teleport and then wait 50 ms, so they are never `moving` strays. Expect the
existing zoom assertions (every zoom contains or is anchored to a click) to hold after the merge, but
that is not verified here.

## Tests added

**`tests/cursorTracker.test.ts`**

`CursorTracker: wheel scrolling`:
- stores a wheel event in DIP with its signed notches on y (`{x 200, y 100, rotation 1, direction 3}` gives (100, 50), dy 1)
- merges events under 50 ms apart on the same axis, taking the new position; 60 ms apart stays separate
- puts horizontal wheel notches on dx, and never merges across axes or opposite signs
- a sub-notch or malformed rotation is stored as 0 notches (still scrolling)
- drops Ctrl+wheel and Meta+wheel (app zoom) and a wheel over the toolbar, but reports activity for every wheel event
- stores no scrolling for a keys-only capture, but still reports activity
- records scrolling in global DIP for a window whose position is known
- snapshots and start() reset the scrolls; a checkpoint keeps them

`CursorTracker: button releases`:
- pairs each stored press with its release (epoch ms), per button
- a release after a dropped toolbar press pairs with nothing, not with an earlier click
- a release without any press, or of another button, pairs with nothing
- stores no presses or releases for a keys-only capture
- stop() removes the release and wheel listeners with the others
- releases and scrolls go through buildCursorTrack on the pause-adjusted clock

**`tests/inputActivity.test.ts`**
- without auto-pause registers no extra listeners (no cost) (updated, see decision 6)
- a wheel reports activity once whether or not it is stored, also while paused (auto-pause unchanged)

**`tests/trackMath.test.ts`**

`buildCursorTrack: scrolling and releases`:
- places scrolls like clicks: normalised, sorted, after the end and outside the display dropped
- remaps scrolls into a recorded region and drops those outside it
- drops scrolls made while paused and maps the others across the pause
- a raw track without scrolls gives no key; [] stays []; the invalid track has none
- maps releases to source time (also across a pause); clicks without one get no key
- clampTrack drops scrolls after the final duration and keeps an absent key absent

`buildCursorTrack for a window: scrolling and releases`:
- maps scrolls through the window before and after it moves, dropping those outside it
- drops scrolls over a covering window (cursorOver false), while minimised and while paused
- keeps release times of window clicks

**`tests/windowCapture.test.ts`**
- maps scrolls through pointToScreen exactly like clicks on a window straddling a 100% and a 150% monitor

**`tests/e2e/recording-input.e2e.cjs`**
- **Screen recording.** Runs `w 960 540 6; s 0.4; w 960 540 -3`, a drag, 2 notches over the toolbar, and
  −4 notches while paused. It checks:
  - Σdy is +6, then −3, with down before up;
  - every scroll is within 0.01 of the centre, so none came from the toolbar or the paused time;
  - the content clicks have 0.03 < up − t < 0.3;
  - the drag's `up` is at least 0.6 s after its press, and the pointer is at the drag's start at the
    press and at its end at the release.
- **Area recording (new test).** Scrolls inside the area are remapped into it, a wheel and a click outside
  the area are dropped, and the drag and click releases are remapped.

**`tests/e2e/recording-window.e2e.cjs`**
- **(a) and (b).** A wheel inside the window before it moves (+2 at (0.5, 0.75)) and after it moves (−2 at
  (0.25, 0.75)) is mapped within ±0.01. The wheel over a window outside is dropped, and the click
  releases are recorded.
- **(c).** No cursor data means no `scrolls` key.
- **(d).** The wheel over the covering window is dropped; the wheel on the recorded window is kept.

## Verification (Linux, Xvfb 1920x1080x24, openbox, xterm, ffmpeg)

Setup: `npm ci`, then `apt-get install -y xvfb openbox python3-xlib` (xvfb was already present; openbox
and xterm were added).

| Command | Result |
|---|---|
| `npm run typecheck` (both `tsc` projects) | exit 0 |
| `npx vitest run --testTimeout=60000` | 122 files, 1578 tests passed |
| `npm run build` | exit 0 |
| `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs recording-input recording-window recording-region recording.e2e` | 5/5 e2e files passed (the `recording.e2e` filter also matches `audit-recording`) |
| `xvfb-run … run-all.cjs integration-window` (recording-window with the real helper process) | 1/1 passed |

E2E output:

```
=== audit-recording.e2e.cjs
PASS R-1/R-2: quitting during a native recording finalises the video and keeps the cursor track
PASS R-1: when the whole app dies, the cursor track recorded until the last checkpoint is on disk
PASS R-4: the camera offset is saved while recording and kept by a recorder crash
PASS E6: an emptied recording name is saved as "Untitled recording", even while the field keeps focus
=== recording-input.e2e.cjs
PASS real input: cursor, clicks, releases, scrolling and shortcuts are captured; toolbar input is not content
PASS real input in an area recording: scrolls and releases remapped into the area, outside input dropped
=== recording-region.e2e.cjs
PASS region recording: overlay selection, exact crop, cursor remapped
PASS region minimum size: main accepts what the picker offers and explains a rejection (seams-6)
=== recording-window.e2e.cjs
PASS window (a): native window capture, cursor and clicks mapped through the moving window, smooth cursor on
PASS window (b): Chromium window capture with a watcher keeps auto zoom and click highlights
PASS window (c): nothing follows the window: no cursor data, and the user is told so
PASS window (d): another window covering the recorded one: a click on it is ignored, the cursor hidden there
=== recording.e2e.cjs
PASS record with fake mic + camera, pause/resume, media streamed while recording
PASS cancel during the countdown leaves nothing behind
PASS stop during the countdown cancels instead of saving an empty recording
PASS double-clicking Start runs a single recording
PASS discard asks for confirmation; Keep continues the recording
PASS vanished sources give friendly errors; unexpected capture requests are denied once
PASS a second launch hands over to the running instance
PASS a stop shortcut owned by another app is reported on the toolbar
PASS Home: light per-tab thumbnails, honest window hint, live microphone level
5/5 e2e files passed
```

Real wheel data recorded on X11 (screen test): nine events at (0.5, 0.5), dy +1 six times then −1 three
times, about 110 ms apart. Held times: 0.060 s and 0.059 s for the clicks, 0.725 s for the drag.

*Windows-unverified* (as in spec §10.12):
- wheel rotation for precision touchpads and high-resolution wheels;
- `mouseup` delivery while the native helper runs;
- wheel coordinates on mixed-DPI setups. These go through the same `pointToScreen` path as clicks,
  which the unit tests cover.
