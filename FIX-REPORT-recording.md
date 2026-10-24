# Fix report: recording audit findings

Findings fixed here: all of `audit/recording.md` (R-1 to R-9), F1, F2 and F6 from
`audit/security-packaging.md`, and E6 from `audit/editor.md`. Each was checked again against
commit `f3db4cb` before it was fixed. All eleven still applied as written. Some line numbers had
moved, but the code paths were the same.

| Id | Outcome | Proving test |
| --- | --- | --- |
| R-1 | fixed | `tests/e2e/audit-recording.e2e.cjs` (quit test, SIGKILL test) |
| R-2 | fixed | `tests/e2e/audit-recording.e2e.cjs` (quit test) |
| R-3 | fixed | `tests/recordingFinishLater.test.ts` › a damaged native sound file |
| R-4 | fixed | `tests/e2e/audit-recording.e2e.cjs` (R-4 test) |
| R-5 | fixed | `tests/hotkeys.test.ts` › never takes Redo or the command palette… |
| R-6 | fixed | `native/src/desktop.rs` › `requests_are_posted_even_when_the_view_already_reads_as_wanted` |
| R-7 | fixed | `tests/desktopIcons.test.ts` › held by a helper…, `tests/desktopIconsClient.test.ts` › holds the icons…, `native/src/desktop.rs` / `cli.rs` tests |
| R-8 | not a bug (no change to behaviour) | `native/src/pacer.rs` › `late_pauses_never_shift_the_timeline_after_resume` |
| R-9 | fixed | `native/src/pacer.rs` › `far_off_instants_saturate_instead_of_overflowing` |
| F1 | fixed | `tests/projectsCopies.test.ts` › reads a copied recording's manifest… |
| F2 | fixed | `tests/projectsCopies.test.ts` › lists, loads and deletes a copied project… |
| F6 | fixed | `tests/projectsCopies.test.ts` › writeCursor (F6) |
| E6 | fixed | `tests/e2e/audit-recording.e2e.cjs` (E6 test) |

"Fails without the fix" was checked for every new test. For the TypeScript fixes, the `src/`
changes were stashed, the app was rebuilt, and the tests were run against the old code. All four
e2e tests and every new unit test failed. For R-9, the Rust test was run against the old
`ticks_at`, and it panicked with "attempt to add with overflow". The exceptions are R-6 and R-8.
The R-6 test exercises the new `plan()` function, which the old code did not have. The R-8 test
records behaviour that the code already had and keeps.

## Details

### R-1: cursor data lost on a crash or forced quit (fixed)
- `CursorTracker.snapshot()` returns what has been captured so far without stopping tracking.
  `collect()` is now `halt` + `flushStill` + `snapshot`.
- `ActiveRecording.pausesUntil()` returns the pause list, including a pause that is still open.
- In `recordingIpc.ts`, `checkpointTrack()` builds the track recorded so far and writes it
  atomically and synchronously (`projects.writeCursorSync`).
  - It runs every 5 s while recording. The checkpoints start in `started()` and stop in
    `beginStop` / `discard`.
  - It also runs first thing in `disposeRecording()` (quit), before the tracker is stopped.
- A normal stop and a renderer crash still write the complete track over the checkpoint
  (`writeTrack`).
- `processRecording` already reads `cursor.json` on recovery, so a recovered recording now has
  its cursor, clicks, keystrokes and auto zooms. The most it loses is the last 5 s, and only on a
  hard kill.
- Limits:
  - Window recordings keep only keys, marks and typing in a checkpoint. Placing positions
    needs the window rectangles, which are only reported at stop.
  - Native cursor shapes are reported only at stop, so a checkpoint has none. The default arrow
    is drawn instead.

### R-2: the app's `will-quit` SIGKILLed the helper that the quit guard was finalising (fixed)
`index.ts` now skips `disposeRecording()` / `disposeExport()` when `event.defaultPrevented` is
set. The quit guard is prepended, so its listener has already postponed the quit by then. The
second `will-quit`, after the helper has finalised, runs the cleanup.

The e2e test drives the real `nativeCapture` client against the fake helper process. It checks:
- the helper received `stop`;
- `native.mp4` is a finalised video;
- after a restart, Recover produces a native project with its cursor track.

### R-3: a damaged `audio.webm` made a native recording unprocessable for good (fixed)
`finalize.ts`: when the mux fails for any reason other than a cancel, the video-only proxy is
renamed to `screen.mp4` and the project opens without sound (`hasAudio: false`). This matches how
a failed camera is handled.
- The proxy is not faststart. The app's MP4 reader and `studio-media://` both handle `moov` after
  `mdat`, so it is used as it is.
- A cancel still removes the partial files and keeps the recording unfinished.

### R-4: camera offset and the Chromium timeline zero were known only at stop (fixed)
- The renderer's offset calculation moved into `RecordingSession.offsets()`. `stop()` uses it, and
  so does a new `recording:offsets` IPC. That IPC is sent as soon as the first frames arrive.
- Main (`setOffsets`) stores `webcamOffset`, `audioOffset` and, for Chromium capture,
  `startedAt` in the manifest. It only does so once `started()` has run, so its estimates cannot
  overwrite the measured values. The stop payload sends the same values again.

### R-5: default hotkeys swallowed Redo and the command palette (fixed)
- The defaults are now pause `Ctrl+Shift+F9` and zoom-here `Ctrl+Shift+F10`.
- `Ctrl+Shift+Z` (Redo) and `Ctrl+Shift+P` (command palette) were added to `COMMON`, so they
  are refused as recording hotkeys.
- Saved settings that still hold the old defaults now fail validation, so `sanitizeHotkeys`
  moves them to the new defaults. No separate migration was needed.
- `recording-options.e2e.cjs` presses the new defaults, and `docs/FEATURES.md` was updated.

### R-6: a `show` skipped while Explorer had not yet applied a `hide` (fixed)
`desktop.rs` gained a portable `plan(action, before)`. The request is now always posted, and
`changed` is still `target != before`. `win/desktop.rs` uses it, so `SW_SHOWNA` is always queued
after a pending `SW_HIDE`.

### R-7: icons stayed hidden after the app process died (fixed)
- New helper mode `desktop-icons hold`. It hides the icons, prints the usual JSON, blocks until
  stdin ends, then shows the icons again if it hid them.
- `nativeCapture.holdDesktopIcons()` spawns it detached on Windows, the same way `record` is
  spawned, so the app's job object does not kill it.
- `DesktopIcons.hide()` keeps the holder while the icons are hidden.
  - `restore()` releases it and waits for it to exit before the usual `show`, so it can never show
    the icons after a later hide.
  - `restoreSync()` closes its stdin on quit.
  - If the app dies, the OS closes the pipe and the holder shows the icons.
- The persisted flag stays as the fallback, for when the holder itself is killed.
- Not verifiable here: Explorer and pipe-close-on-death on Windows. The manual checklist in
  `native/README.md` (item 13) was extended to cover them. The Windows code type-checks with
  `cargo check --target x86_64-pc-windows-gnu` and with clippy for that target.

### R-8: pause and stop take effect slightly late in the native video (not a bug, left as is)
The finding is accurate that slots already written past a late `pause <at>` stay in the video. But
the pacer counts the paused span from the app's own instant, so the timeline re-anchors at every
resume. Every slot after a resume is due exactly when the app's pause list says. The only effect
is up to one command latency (typically under one frame) of pre-pause picture at the start of
each resumed span, and it never accumulates.

The proposed fix would clamp the pause to the written frontier and use the helper's instants
for the cursor track. The cursor would then match the video, but the separately recorded sound
pauses at the app's instant, not the helper's. So each pause would add a lasting A/V offset of
the command latency, and those offsets would accumulate. That is worse than one stale frame. The
new test `late_pauses_never_shift_the_timeline_after_resume` pins the non-accumulating behaviour:
three pauses each read 10 ms late, and the next slot is still due at the app's instant.

### R-9: `Timebase::ticks_at` overflowed on huge timestamps (fixed)
The float-to-int cast saturates, and the sum now uses `saturating_add`. The pacer then clamps
the instant to now or to the previous state change, as it does for any out-of-range instant.

### F1: Recover on a copied unfinished folder could delete another project (fixed)
`projects.readManifest(id)` returns `{ ...m, id }`, so the folder decides the id.
- `runProcessing` / `processRecording` now work only in the folder the user picked. If that folder
  holds no video, it is the one that gets removed.
- `processing.has(id)` now matches `m.id`.

### F2: a copied project was listed, opened, saved and deleted as the original (fixed)
`projects.readProject(id)` returns `{ ...migrateProject(...), id }`, and `listProjects` takes
`dir` from the folder name. Listing, loading, saving (the editor saves `project.id`) and deleting
a copy now all act on the copy.

### F6: `cursor.json` was rewritten in place (fixed)
`writeCursor` / `writeCursorSync` go through `writeFileAtomicSync` (a temporary file plus a
rename, with retries on transient locks), like the other state files. The test holds a hard link
to the old file. An in-place rewrite changes what that link reads, while a rename does not.

### E6: an emptied name could be saved (fixed)
New `src/shared/editor/projectName.ts` (`UNTITLED`, `withSavedName`). The editor's `save` and
`saveSync` adapters apply it, so neither autosave nor the unload `flushSync` stores a blank
name. The field still shows what the user typed, and the existing `onBlur` fallback uses the same
constant.

## Files touched and parallel work
- The camera-layout work merged later touches `src/renderer/src/editor/exporter.ts`,
  `render/frameSource.ts`, `webcamLayer.ts`, the layout files, `project.ts`, the CSP and the
  packaging. None of those files were edited here.
- `src/main/nativeCapture.ts` gained one new exported function.
- `src/main/recordingIpc.ts` gained additive hooks only.

## Verification
All of these ran on the final code. The e2e runs used
`xvfb-run -a -s "-screen 0 1920x1080x24"` with openbox installed, one file at a time.

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npx vitest run` | 83 files and 1204 tests pass (run twice) |
| `npm run build` | pass |
| `cargo test` (native/) | 60 unit and 6 CLI tests pass |
| `cargo check` / `cargo clippy --all-targets --target x86_64-pc-windows-gnu` | pass, no warnings |
| `tests/e2e/audit-recording.e2e.cjs` | 4/4 PASS (all 4 FAIL on the unfixed `src/`) |
| `tests/e2e/recording.e2e.cjs` | 9 PASS |
| `tests/e2e/recording-recovery.e2e.cjs` | 5 PASS |
| `tests/e2e/recording-native.e2e.cjs` | 4 PASS |
| `tests/e2e/recording-options.e2e.cjs` | 4 PASS, 1 SKIP (desktop icons under wine: wine and `ssw-capture.exe` are not installed here, as before) |
| `tests/e2e/smoke.e2e.cjs` | 1 PASS |

Notes:
- One early `npx vitest run` reported a test file that failed to load, with no test failing. It
  did not happen again in three later runs.
- `cargo fmt --check` reports the same differences before and after these changes, in
  `examples/fake_desktop.rs`, `src/desktop.rs`, `src/main.rs` and `tests/cli.rs`. These
  predate this work and were left alone.
