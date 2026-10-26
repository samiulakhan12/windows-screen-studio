# Build report: teleprompter, workstream A (main process and the notes window)

Branch `feat-tp-a`, from `cfeaac5` (the contracts commit). Spec: `docs/design/teleprompter.md`.
Only workstream A's files were changed (spec §9); no frozen file and no frozen signature changed.

## What was built

| File | What |
|---|---|
| `src/shared/notes/placement.ts` | `notesBounds` (size clamped to the limits, then to the work area; saved shares on their display, else top centre of the primary work area, `NOTES_TOP_MARGIN` down), `placementOf` (display holding the centre, else the one overlapped most; 0.5 with no room), `rectsOverlap` (touching edges do not), `notesAllowed` (§2.10). |
| `src/shared/recording/ownAreas.ts` | `AreaHistory`: spans of where the window was, ±250 ms slack at both ends, the same rectangle extends the open span, at most 1000 spans, `clear()`. |
| `src/shared/notes/scriptDraft.ts` | Request check (1–20,000 characters, not only white space, text), the prompt (system text of §2.13 starting with `SCRIPT_SYSTEM_START`, user `SCRIPT_USER_START + notes`, strict `spoken_script` schema), answer check (1–300 paragraphs, cleaned, joined by a blank line, length cap; `AiOutputError` otherwise), `runScriptDraft` (asks once). |
| `src/main/recording/captureExclusion.ts` (new) | `captureExclusionSupported(platform, release)`: win32 build ≥ 19041, other platforms true; unpackaged builds honour `globalThis.__SSW_CAPTURE_EXCLUSION__`. `cameraBubbleWindow.ts` re-exports it as `bubbleSupported` (same function) and uses it. |
| `src/main/notes/notesStore.ts` | `userData/notes.json` `{ version: 1, ...NotesSettings }`, read once, sanitised field by field (with the recording hotkeys as `taken`, read again on every `get()`), written with `writeFileAtomicSync`; `hold()` keeps changes in memory, `release()` writes them once and only logs a failure; a change that changes nothing writes nothing. |
| `src/main/notes/notesWindow.ts` | The window in both modes with the §2.2 options; `setContentProtection(true)` and `setAlwaysOnTop(true, 'screen-saver')` right after construction, before `loadRoute`; record mode only ever `showInactive()`, rehearse `show()`; shown on `ready-to-show` (idempotent); bounds read back after the first show and set again when more than 1 DIP off; `render-process-gone` reloads `/notes`, `did-finish-load` sends the view again; mode change = destroy and create; re-placement on `display-removed` / `display-metrics-changed`; the older-Windows lock (`movable: false`, size changes refused, `locked` in the view); notes hotkeys registered while a window is open (problems in the view and the bar), re-registered when they change; hide/show from the bar; a hotkey while hidden only shows it; `AreaHistory` updated on every show, hide, drag end, resize and re-placement and cleared in `prepare`; `script.txt` written (async) when `keepWithRecording`; the store held for the recording; restart keeps the window hidden for the next take (new `take`). |
| `src/main/notes/notesIpc.ts` | Every `NOTES_CHANNELS` handler with its sender check (Home: main window's webContents **and** the app URL; notes window: `isNotesSender`; bar: `isToolbarSender`), values sanitised (`sanitizeLookPatch`, a report sanitiser), `notes:state` sent only on change, `notes:rehearse(true)` rejected with "Finish the recording first." during a recording. `checkAnyHotkey` (all six actions; distinct from the other five; other apps tested only outside a recording and never for the action's current accelerator). |
| `src/main/recordingIpc.ts` | `prepare`: the notes after `prepareToolbar` and before the recording hotkeys (a rehearsal closes first), `kind`/`captured` from the source and area, `CapturePlan.notesNotice`; `setStatus`: `showNotes()` before `showToolbar()` on countdown and recording, `setNotesRecording` for countdown/recording/paused; `endRecordingUi` → `endRecordingNotes(restarting)`; `ToolbarStatus.notes`, notes hotkey labels and problems in the bar; the bar refreshed when the notes change; `onIdle` bypass while the notes scroll; `isOwnPoint(p, at)` adds `notesAreaContains`; notes hotkeys in the tracker's `ignoreKeys`; `pickRegion` hides a rehearsal window meanwhile; `closeRecordingWindows` closes the notes; `disposeRecording` releases the store; `settings:checkHotkey` for any of the six actions; a changed recording hotkey re-syncs an open notes window. |
| `src/main/cursorTracker.ts` | `isOwnPoint(p, at)` with `at = clock.toEpoch(tick)` at mousedown and wheel. |
| `src/main/recording/toolbarWindow.ts` | `SIZE.width` 600, `isToolbarSender`. |
| `src/main/projects.ts` | `SCRIPT_FILE` (not in `RAW`), `writeScriptFile`, `readScriptFile` (reads at most what 50,000 characters take in UTF-8, cleaned through `readProjectScript`). |
| `src/main/recording/finalize.ts` | `project.script` from `script.txt` before `writeProject` (recovered recordings go through the same function). |
| `src/main/aiIpc.ts` | `ai:draftScript` / `ai:cancelScriptDraft` behind `fromApp`; medium effort; the controller in `textCalls` (aborted on quit); one draft at a time (a new valid request aborts the old one; cancel aborts the current one). |
| `docs/IMPLEMENTATION.md` | Layout: `src/main/notes/`, capture exclusion. |

## Deviations and decisions (with why)

1. **Window changes are saved 300 ms after the last one** (`saveLook`, flushed on close, end of a recording and `prepare`). The grip sends one `notes:look` per animation frame; saving each would run up to 60 synchronous `notes.json` writes a second while rehearsing. The view and Home see the new value at once (`notesSettingsNow()` merges the pending change).
2. **A `'moved'` that only reports our own `setBounds()` saves nothing.** Some platforms emit it for programmatic moves; without the guard a display change would turn the default place into a saved "Where you left it".
3. **Locked window re-placed onto the capture is hidden.** §2.10's intent is that on older Windows the notes never appear in what is recorded; if a display change moves the locked window over the captured rectangle, it is hidden (the bar can show it again only by the presenter's choice). Not stated in the spec; follows its intent.
4. **`notesWindow.ts` exports more than the stub** (allowed: "A's own, may change"): `onNotesChange`, `notesSettingsNow`, `notesView`, `notesHotkeyLabels`, `notesHotkeyProblems`, `setNotesReport`, `setNotesLook`, `dismissNotes`, `notesSettingsChanged`, `NOTES_NOTICE`. `closeRehearsal(focusMain = false)` gained an optional parameter (Home focus only when closed from the window itself, §2.1.5).
5. **`checkAnyHotkey` lives in `notesIpc.ts`** with its context injected, and `recordingIpc`'s `checkHotkey` calls it, so the rule is unit-tested without the whole recorder.
6. **`prepareRecordingNotes` runs for every recording** (it returns `{ shown: false }` when the notes are not used), so rehearsal is refused from `prepare` to the end of every recording, as §2.1 says ("prepared or running").
7. **Test placement**: the `recordingIpc` hook tests are in `tests/notesIpc.test.ts`, the draft IPC tests in `tests/scriptDraft.test.ts`, and the `finalize` → `project.script` test (real ffmpeg, like `nativeVideo.test.ts`) in `tests/notesWindow.test.ts`, to stay inside the listed test files.
8. **Spec test example "2000×1200 shrinks to the work area"**: with the frozen limits (`NOTES_WIDTH.max` 1200, `NOTES_HEIGHT.max` 720) that size is clamped by the limits first; the test checks that, and the work-area shrink on a smaller display.
9. **Draft answer cleaning**: line breaks inside a paragraph become spaces, other control characters are removed (`'Hi\u0007 there'` → `'Hi there'`); list markers need a following space (or the end), so "2024 was busy." is kept.
10. **No new test file outside the list**, no change to `cameraBubble.test.ts` or any existing test (only additions to `cursorTracker.test.ts`).

Nothing in the spec was found contradictory enough to need a signature change.

## Tests

New: `tests/notesPlacement.test.ts`, `tests/ownAreas.test.ts`, `tests/scriptDraft.test.ts`, `tests/notesStore.test.ts`, `tests/notesWindow.test.ts` (fake `BrowserWindow` recording every call), `tests/notesIpc.test.ts`, `tests/captureExclusion.test.ts`; extended: `tests/cursorTracker.test.ts`.

**Every rule fails without its code**: a mutation pass (`110` source mutations, each removing or breaking one rule, then running that rule's test file) killed all of them after five weak tests were tightened (view sent only on change, span extension, window recordings never allowed, centre over overlap, `release()` with no change). The script is not committed (scratch).

## Verification

```
npm ci                                   ok
npm run typecheck                        ok (node and web)
npx vitest run --testTimeout=60000       Test Files 144 passed (144), Tests 2052 passed (2052)
npm run build                            ok
xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs recording camera-live
10/10 e2e files passed (40 PASS lines, exit 0), on the final build:
```

```
=== audit-recording.e2e.cjs
PASS R-1/R-2: quitting during a native recording finalises the video and keeps the cursor track
PASS R-1: when the whole app dies, the cursor track recorded until the last checkpoint is on disk
PASS R-4: the camera offset is saved while recording and kept by a recorder crash
PASS E6: an emptied recording name is saved as "Untitled recording", even while the field keeps focus
=== camera-live.e2e.cjs
PASS the live camera bubble: one camera open, out of the capture, dragged corners become camera corners at their times
PASS recording bar: pause and resume, mute, restart and discard with confirmation
PASS restart: a next take that cannot be prepared brings the app back with its error
PASS "Camera follows the preview bubble" off: moving the bubble moves nothing in the video
PASS Camera panel: camera position of a layout change, "Move camera here from the playhead", undo
=== recording-input.e2e.cjs
PASS real input: cursor, clicks, releases, scrolling and shortcuts are captured; toolbar input is not content
PASS real input in an area recording: scrolls and releases remapped into the area, outside input dropped
=== recording-long.e2e.cjs
PASS a 65 s recording streams to disk and keeps renderer memory flat
=== recording-native.e2e.cjs
PASS native capture: helper video + Chromium audio, cursor shapes, no cursor in video
PASS native capture at 30 fps: the helper is asked for 30 fps and the proxy keeps it
PASS native capture failure falls back to Chromium capture automatically
PASS native capture: a helper that ends on its own stops the recording, keeps it and says why (windows-1)
=== recording-options.e2e.cjs
PASS camera preview on Home: live, mirrored frames; released when recording starts; 30 fps recording
PASS auto-pause: pauses after the idle time, resumes on the next real input
PASS custom hotkeys: conflicts and taken combos refused on Home; stop, pause and zoom marks by hotkey; typing bursts without keys
PASS a hotkey another app took after it was set is reported when recording starts
=== recording-recovery.e2e.cjs
PASS recorder crash mid-recording: UI recovers and the footage can be recovered
PASS failed conversion keeps the recording, explains where it is, and Retry finishes it
PASS Finish later stops a long conversion and keeps the recording for later
PASS Finish later during "Optimising camera…" keeps the camera for later, never a project without it
PASS a crash while not recording is not blamed on the recorder (audit-A-3)
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
```
