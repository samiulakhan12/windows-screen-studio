# Build report: live camera bubble, camera corners over time, new recording bar

Branch `feat-w4-camera-live`, built on `2144728` (Wave 4 groundwork).

The request: *"While recording the camera should be visible in real time on screen to show what's
recording. Also in recording we want it sometimes bottom right, sometimes left, sometimes top left,
sometimes top right — but there is only one global setting, update this. Also the screen recorder
starting bar should be better."*

## 1. The live camera bubble: design

### Who owns the camera

The recorder runs in the **main window's renderer** (`src/renderer/src/recorder/controller.ts` →
`RecordingSession` in `session.ts`). `RecordingSession.acquire()` opens the camera once with
`getUserMedia` and records that track into `webcam.webm` with a `MediaRecorder`. Home's own live
preview (`previewCamera` in `devices.ts`) is released just before (`releaseCamera` in Home), as
before. The main process never touches the camera.

### Why the camera is opened only once

Many Windows camera drivers refuse a second open of a device (`NotReadableError`), or hand the
device over to the newest opener. A bubble that opened the camera itself could therefore break or
delay the recording. So the bubble **never calls getUserMedia**:

1. When the streams are acquired (before the countdown), the controller calls
   `openCameraBubble(api, token, session.cameraTrack)` (`recorder/cameraBubble.tsx`). It is not
   awaited.
2. It asks the main process for permission (`allowCameraBubble(token)`). Main checks the
   recording is live and that this PC can keep the bubble out of the capture, then arms a one-shot
   popup permission and answers with the bubble's look (corner, shape and mirroring of the saved
   default look; size M).
3. The recorder's page calls `window.open('about:blank', 'ssw-camera-bubble')`. Main's window-open
   handler for the main window (`windows.ts`, `allowPopup`) allows exactly that name, once, with
   the bubble's window options. An `about:blank` popup of the same origin lives in **the same
   renderer process**, so the recorder's page can fill its document.
4. The page renders the `CameraBubble` React component into the popup's document (its stylesheet
   is injected as text, `CameraBubble.css?inline`) and shows **a clone of the recorded track**
   (`MediaStreamTrack.clone()`) in a `<video>`. A clone shares the same capture source: no second
   device open. Stopping the clone (when the bubble closes) leaves the recorded track running.

The e2e test asserts this: a `getUserMedia` counter installed in the recorder's page sees exactly
one video request for the whole recording, bubble included.

### Why a bubble failure can never hurt the recording

- `openCameraBubble` is fire-and-forget; every step is in a `try/catch` that only logs and closes
  the bubble. A refused permission (`ok: false`) or a blocked `window.open` (null) just means no
  bubble.
- The bubble only reads a clone; the `MediaRecorder` of the original track is untouched. Closing
  the bubble (`bubble.close()` on stop, cancel, restart, errors, and `finally`) unmounts React,
  stops the clone and closes the window, in that order, each guarded.
- Main's side (`recording/cameraBubbleWindow.ts`) never throws into the recording flow: invalid
  tokens, phases or values are ignored; `closeBubble()` runs in `endRecordingUi()`.
- The popup has **no preload** (verified in e2e: `window.api` is undefined there) and goes through
  the usual guards (`security.ts`: navigation blocked, `window.open` denied, no permissions for
  `about:blank`). Its window is `sandbox: true`. Every new IPC handler checks that the sender is the
  app's own page (`fromApp`, `event.senderFrame.url` through `isAppUrl`).

### Keeping it out of the recording

The bubble window is created like the control bar: frameless, transparent, `alwaysOnTop`
(`'screen-saver'` level), `skipTaskbar`, `focusable: false` (dragging it never takes the keyboard
focus from the app being recorded) and **`setContentProtection(true)`**.

- **Windows 10 2004 (build 19041) and later**: Electron applies `WDA_EXCLUDEFROMCAPTURE`. The
  window is left out of every capture: Windows Graphics Capture (the native helper's
  monitor capture) and Chromium's desktop capture (WGC / DXGI duplication / GDI all honour
  display affinity). Window recordings capture only the recorded window, so the bubble never shows
  there either.
- **Older Windows**: Electron falls back to `WDA_MONITOR`, which would record the bubble as a
  **black square**. `bubbleSupported()` therefore refuses the bubble below build 19041 (the app's
  documented minimum is 2004 anyway; the native helper needs it too). The recording then has no
  bubble and is otherwise unchanged; the reason is logged.
- macOS: excluded. **Linux has no exclusion**: under Xvfb the bubble *is* in the recorded screen.
  The e2e pixel checks measure the camera only where the recording cannot be (the padding).

### Moving and sizing

- Drag anywhere on the bubble (pointer capture; screen coordinates sent to main at most once per
  frame). Main moves the window; on release it **glides (180 ms, ease-out) into the nearest corner**
  of the work area of the display it was dropped on (`nearestCorner`: the quadrant of its centre).
- Hovering shows **S / M / L** (128 / 184 / 260 DIP) and **Hide**. The bar has a camera button to
  hide and show it again (the camera keeps recording either way).
- It starts in the corner of the saved default look (else bottom right), on the recorded display
  (window recordings: the display under the cursor), 24 DIP from the edges.

## 2. Camera position over time

- Each corner the bubble goes to is recorded by main with its epoch time (`bubbleMoved`), the first
  entry being where it started. `setCameraMoves` converts them to **recording time with the same
  rule as marks and cursor samples** (`toSourceTime` of `trackMath.ts`): paused time left out, a
  move made while paused applies where the pause began (= on resume in the video), a move during
  the countdown applies from 0. They are written into `recording.json` at once (a crash or an
  interrupted recording keeps them) and again on stop with the final start time and pauses.
- At finalize (`finalize.ts`), when the project has its camera and **"Camera follows the preview
  bubble"** was on, `cornerSegments` turns them into layout segments (`layout: 'default'`, `corner`)
  for each stay away from the project's default corner (after the saved default look is applied).
  Stays are back to back, so the camera moves straight from corner to corner. A stay shorter than
  `MIN_CORNER_STAY` (1 s: a quick back-and-forth, a move in the last second, one right after the
  start) is left out; the corner before it carries on (a short first stay hands the start to the
  next one).
- The option lives in the recording settings (`cameraFollowsBubble`, default on), on Home in
  Recording options, in the options summary when off, and in recording presets (stored when saved;
  older presets leave it as it is and match as "on"; it only counts for presets with a camera).

## 3. Editor: per-segment camera corners

- `layout.ts`: `LayoutSegment.corner` applies to the layouts with a bubble (`default`,
  `camera-large`; `cornered()`); side by side, camera only and screen only ignore it (their place
  does not come from a corner, and `tilt.ts` keeps using the project corner for side by side).
  `layoutPhaseAt` compares *states* (layout + effective corner): a corner change ramps in and out
  over `LAYOUT_TRANSITION` (0.4 s) with the same `easeInOutCubic`, back-to-back segments move
  straight from corner to corner, changes at the very start/end are instant, a segment in the
  project's own corner changes nothing. `LayoutPhase` carries `fromCorner` / `toCorner` only when a
  segment chose one, so **projects without corners get exactly the same phases and geometry** (all
  existing layout tests pass unchanged). `layoutGeometry` takes the corner; `sceneLayout`,
  `sceneCameraBox`, `layoutRamps` (now computed by the same rule as the phase) follow.
- The camera layer (`webcamLayer.ts`) draws `sceneCameraBox`, so it follows without change; its
  cached shadow sprite is keyed by size, not position. The preview overlay's screen rectangle
  (`sceneRect.ts`) does not move for a corner change, so it needed no change.
- `webcamData.readLayouts` keeps a valid corner (drops an unknown one).
- Layout track: a corner change shows a corner glyph and its corner's name ("Top left"), with
  `data-corner`; a large camera with a corner shows both glyphs; tooltips name the corner. Ramps
  update when the default corner changes.
- Camera panel → **Camera position**: for the selected change (or the one at the playhead) four
  corner buttons set its corner (with "Default" to clear it); outside every change the same buttons
  are **"Move camera here from the playhead"**, which adds a `default` segment with that corner
  through the shared rule (`setCornerAt` → `addLayoutAt(…, corner)`). Layouts without a bubble
  disable them with a hint. The Camera section's corner stays the default elsewhere (its tooltip
  says so). All edits go through the edit store (undo works; tested).

## 4. Recording bar

`views/Toolbar.tsx` + its own `views/Toolbar.css` (scoped under `.toolbar.rec-bar`, so the app-wide
stylesheet cannot reshape it; the old toolbar rules in `recorder.css` were removed):

- A compact floating pill (560 × 64 window): drag handle (the whole empty bar drags), recording dot
  pulsing once a second (a short transition driven by the timer's own once-a-second re-render; no
  CSS animation while recording, as the performance audit requires; asserted in e2e), timer,
  **Paused** / **Paused (idle)** chip, **Zoom marked** chip, hotkey problem `!`.
- **Microphone**: level meter (measured a few times a second in the recorder from the mic track,
  sent only on visible change, written straight to the DOM in the bar) and **mute** (the mic track
  is disabled: the recording and its stem get silence, nothing restarts).
- **Camera bubble** show/hide (only with a bubble).
- Pause/resume, **Restart** (confirm: the take is deleted and a new countdown starts with the same
  setup; the main window stays hidden), **Discard** (confirm), **Stop** (primary, with label).
- Countdown: a ring that empties each second around the number, "Recording starts…" with the stop
  hotkey, Cancel; "Starting…" with a spinner while the native helper starts.
- Every class, label and title the existing e2e tests use was kept (`button.stop|pause|discard|
  cancel`, `.rec-dot(.paused)`, `.tb-state(.idle)`, `.tb-warn`, `.tb-mark`, `.toolbar.confirm`,
  "Keep"/"Discard", `.countdown-number`, `.countdown-starting`, the Stop title with the hotkey).
  New controls have aria-labels.

## Files

New: `src/shared/recording/cameraBubble.ts`, `src/main/recording/cameraBubbleWindow.ts`,
`src/main/recording/cameraMoves.ts`, `src/renderer/src/recorder/cameraBubble.tsx`,
`src/renderer/src/views/CameraBubble.tsx` + `.css`, `src/renderer/src/views/Toolbar.css`,
`src/renderer/src/views/recordingIcons.tsx`, `src/renderer/src/views/inlineCss.d.ts`,
`tests/cameraBubble.test.ts`, `tests/cameraCorners.test.ts`, `tests/e2e/camera-live.e2e.cjs`.

Changed: `recordingIpc.ts`, `windows.ts` (`allowPopup`), `recording/finalize.ts`,
`recording/toolbarWindow.ts`, `shared/api/recording.ts`, `preload/recording.ts`,
`recorder/controller.ts`, `recorder/session.ts`, `recorder/RecordingOptions.tsx`,
`recorder/recorder.css`, `views/Toolbar.tsx`, `shared/recording/settings.ts`,
`shared/engine/layout.ts`, `shared/engine/webcamData.ts`, `shared/editor/layouts.ts`,
`shared/editor/layoutCommands.ts`, `editor/LayoutTrack.tsx`, `editor/panels/CameraPanel.tsx`,
`editor/camera.css`, `tests/appSettings.test.ts` (the default settings now include the option).

Outside my area, minimal and additive: **`src/renderer/src/views/Home.tsx`, one line**
(`cameraFollowsBubble: settings.cameraFollowsBubble,` in the preset setup, so saved presets carry
the option). `src/main/appSettings.ts` needed no change (it stores whatever `settings.ts`
validates). No README/docs or shared e2e helper was edited.

## Verification

Run in this container (Linux, Xvfb 1920×1080, openbox, fake camera and microphone):

| check | result |
| --- | --- |
| `npm run typecheck` | pass |
| `npx vitest run` | 1360 of 1361 pass (27 new tests in `cameraBubble.test.ts`, `cameraCorners.test.ts`). The one failure is `tilt.test.ts` › "keeps every corner inside the padding for any lean", a 5 s **timeout**: it runs about 6–8 s on this CPU and fails the same way on the base commit `2144728` without my changes. It passes with `--testTimeout=60000` (38/38). |
| `npm run build` | pass |
| `camera-live.e2e.cjs` (new) | 4/4 pass, twice (in the full list and again on the final build) |
| `camera.e2e.cjs` | pass |
| `recording.e2e.cjs` | in the full list, 8/9: "vanished sources give friendly errors…" failed once. It presses Stop the moment the bar shows it, and the screen file was empty ("Nothing was captured"). That test has no camera or microphone, so none of the new code runs. **Rerun alone on the final build: 9/9 pass.** I count this as a timing flake under load, not proven. |
| `recording-options.e2e.cjs` | pass (its desktop-icons-under-wine part SKIPs: no wine here, as before) |
| `recording-recovery.e2e.cjs` | pass |
| `recording-region.e2e.cjs` | pass |
| `recording-window.e2e.cjs` | pass |
| `recording-native.e2e.cjs` | pass |
| `smoke.e2e.cjs` | pass |
| `audit-recording.e2e.cjs` | pass |

`native/` was not changed, so cargo was not run.

What `camera-live.e2e.cjs` proves:
- the bubble window exists during the countdown and the recording: always on top, not focusable,
  `setContentProtection(true)` called on it, its video playing the fake camera (pixel check of its
  screenshot), no preload;
- exactly one video `getUserMedia` in the recorder's page for the whole recording;
- three real X drags (top left, top right, and bottom left while paused) become three back-to-back
  `default` segments with those corners. They start at the drop times (±0.9 s), the paused move
  lands at the pause start, and the last one runs to the end. The layout track shows the corners;
- the 720p export has the camera in the expected corner at times before, inside and between the
  segments. It is measured where only the camera can be (the padding), with a mid-glide frame in
  neither top corner;
- hide and show from the bar; pause and resume; mute and unmute. Restart (Keep first, then confirm)
  gives a new countdown with the main window still hidden, deletes the first take and brings the
  bubble back. Discard (Keep first, then confirm) leaves nothing;
- with the option off, the same drag leaves no layouts;
- Camera panel: "Move camera here from the playhead" adds a 5 s top-left change, a corner button
  changes the selected one in place, two undos restore, and a camera-only change disables the
  corners.

## Known gaps

- **The bubble is in the recording on Linux** (no capture exclusion there); Windows and macOS
  exclude it. Only matters for development and tests.
- **Before Windows 10 2004 there is no bubble** (it would be recorded as a black square). The
  recording itself works as before.
- The bubble's corners are those of the display's work area, also for area recordings (the bubble
  stands for where the camera goes in the *video*, not inside the area).
- Resizing is S/M/L buttons, not a free drag of the edge.
- "Move camera here from the playhead" adds a 5 s change (the shared add rule), which the user then
  stretches on the timeline; it does not run to the next change automatically.
- Mute silences the microphone in the recording and in its stem; the editor does not mark muted
  stretches.
- The bubble shows the camera as captured (mirrored by default), not the editor's framing
  (zoom/crop) or background blur.

## To check on a real Windows PC

1. Windows 10 2004+/11, native capture (screen and area) and Chromium fallback: the bubble and the
   bar are **not** in the recorded video (WGC and DXGI capture honour `WDA_EXCLUDEFROMCAPTURE`).
2. Window recordings: the bubble over the recorded window is not in the video.
3. A camera whose driver allows a single open (many UVC webcams, virtual cameras): the recording's
   camera keeps working with the bubble shown; no `NotReadableError`.
4. Dragging the bubble feels right with `focusable: false` (no focus stolen from the recorded app),
   on mixed-DPI multi-monitor setups (drop on another monitor: it snaps to that monitor's corner),
   and the 180 ms glide is smooth.
5. Transparency: the circle has no square backdrop or shadow artefacts (transparent frameless
   window, `hasShadow: false`).
6. Windows 10 before 2004 (e.g. 1909): no bubble, recording unaffected.
7. The bar: dragging it by empty space, the countdown ring, the mic meter moving with speech, mute
   producing silence in `mic.m4a` and the mixed track, Restart going straight to a new countdown.
8. CPU: a 30 fps bubble video in its own window costs little; check with a 4K60 native recording.
