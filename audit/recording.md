# Audit: recording pipeline

Scope: `src/renderer/src/recorder/*`, `views/Home.tsx`, `Toolbar.tsx`, `RegionPicker.tsx`, `src/main/recordingIpc.ts`,
`src/main/recording/*`, `nativeCapture.ts`, `cursorTracker.ts`, `proxyArgs.ts`, `appSettings.ts`, `src/shared/recording/*`,
`src/shared/api/recording.ts`, and the Rust helper `native/`. Audited at commit `b25a136`.

How the findings were checked:
- **Unit tests:** `npm ci`, then `npx vitest run`: 75 files and 1066 tests pass.
- **Rust:** `cargo test` in `native/`: 56 unit and 6 CLI tests pass. A scratch fuzzer drove `pacer.rs` through 20,000 random pause/resume/stop sequences.
- **Repro tests:** throw-away vitest tests (not committed) ran the real `processRecording` with real ffmpeg, and the real `nativeCapture.ts` with the repo's fake helper (`tests/fixtures/fake-capture-helper.cjs`).
- **ffmpeg runs:** done by hand with `node_modules/ffmpeg-static`.
- **Not run:** Electron itself and Windows-only code. Findings in those areas come from reading the code end to end, and their evidence says so.

No finding corrupts a recording that is stopped normally. Every defect below is on a crash, quit, recovery or edge path.

## Findings (most severe first)

### R-1 (medium): a crash or forced quit loses all cursor data; native recordings are then recovered with no cursor at all
- **Where:**
  - `src/main/recordingIpc.ts:330-341` (`writeTrack`), `:356-372` (`interrupt`), `:935-943` (`disposeRecording`).
  - `src/main/cursorTracker.ts:303-319`.
  - `src/main/recording/session.ts:32` (pauses kept only in memory).
- **Problem:** cursor samples, clicks, keys, typing, marks and the pause list are held only in main-process memory. `cursor.json` is written in only two places: on a normal stop (`save`) and when the renderer crashes (`interrupt`).
  - The app may quit during a recording: "Quit anyway", `will-quit`, or Windows ending the session. `disposeRecording` then only stops the tracker (`tracker.stop()` throws the data away) and kills the helper.
  - A main-process crash, power loss or End task loses it too.
  - The manifest is left as `status: 'recording'` and does not hold the pauses either, so the track could not be rebuilt even from raw data.
- **Failure scenario:**
  1. Record a screen with native capture.
  2. Windows restarts for an update, or the app is ended in Task Manager.
  3. Next launch: Recover. `processRecording` reads no `cursor.json` (`projects.readCursor`, then `migrateCursor(undefined)` gives `valid: false`). The project is created with `cursorValid: false`, `cursorInVideo: false` (`shared/engine/project.ts:92`).
  4. Result: the video has no cursor whatsoever (WGC left it out and the app draws none), and there are no auto zooms, click effects or keystrokes.
  This contradicts README's "nothing is lost if something crashes".
- **Evidence:** read every path that writes `cursor.json` (only `writeTrack`, `processRecording`). `index.ts:36` → `disposeRecording` writes nothing.
- **Fix:**
  1. Checkpoint the raw track to disk during recording. For example, every ~5 s append new raw events (epoch ms) to `cursor.raw.jsonl`. Also write `pauses` (and `shapes` / window rects as they arrive) into `recording.json` on every pause and resume.
  2. In `processRecording`, when `cursor.json` is missing but `cursor.raw.jsonl` exists, rebuild the track with `buildCursorTrack` using `manifest.startedAt`, `manifest.pauses` and `manifest.region`.
  3. At minimum, in `disposeRecording` build and write the track synchronously with `fs.writeFileSync` (from `tracker.collect()` and `active.pauses`) before killing anything.

### R-2 (low): on quit, the app's own `will-quit` handler SIGKILLs the helper that `guardQuit` is still finalising
- **Where:**
  - `src/main/nativeCapture.ts:832-851` (`guardQuit`).
  - `src/main/index.ts:36-39`.
  - `src/main/recordingIpc.ts:940` (`active?.killNative()`).
- **Problem:** `guardQuit` prepends a `will-quit` listener: it calls `preventDefault()`, sends `stop` to the helper, and re-quits once the MP4 is finalised. But `preventDefault()` does not stop the other listeners of the same emit. `index.ts`'s listener runs straight after, and `disposeRecording()` → `active.killNative()` → `session.kill()` SIGKILLs the helper.
  - The kill happens before the helper has even read the `stop` line. This defeats the contract at `nativeCapture.ts:14-15`.
  - On the same first emit, `killAllFfmpeg()` and `restoreSync()` also run early, while the quit is still postponed.
- **Failure scenario:** quit while a native recording runs (session end, or "Quit anyway" while the helper runs). The helper is killed mid-file instead of finalised: the last fragment (up to ~1 s) is lost and the `stopped` stats never arrive.
  - **Reachability:** limited. During recording the main window is hidden and the toolbar has no close action, so this mostly happens on OS session end or a dev Ctrl+C.
- **Evidence:** a repro test with the fake helper. It ran the prepended guard listener, then a listener doing what `disposeRecording` does (`session.kill()`). Result: `s.stop()` rejects with "The capture helper was stopped", and the helper's stdin log is empty, so it never saw `stop`.
- **Fix:** make the app listener a no-op while the guard is postponing the quit. For example, export `nativeQuitPending()` from `nativeCapture.ts` and skip `disposeRecording()` while it is true. Or skip `killNative()` when `event.defaultPrevented` is set. The second `will-quit`, after the helpers are done, then does the cleanup:
  ```ts
  app.on('will-quit', (e) => { if (e.defaultPrevented) return; disposeRecording(); disposeExport() })
  ```
  This relies on the guard being prepended, which it is. Check that `disposeExport` tolerates being deferred.

### R-3 (low): a damaged separate audio file makes a native recording permanently unprocessable, though its video is intact
- **Where:** `src/main/recording/finalize.ts:196-205`.
- **Problem:** for native capture, the mux of `audio.webm` onto the video proxy is fatal. `friendlyFfmpegError(err, 'audio')` is thrown, the manifest becomes `failed`, and "Retry" runs the same mux and fails the same way forever.
  - By contrast, a camera or stem that cannot be converted is skipped (`:229-234`, `keepStems`).
- **Failure scenario:** `audio.webm` is cut inside its header or first cluster. This happens if the main process dies, the PC loses power or the disk fills during the first chunk write. ffmpeg then refuses the input, and the user can never get the screen recording into the editor.
- **Evidence:** a repro test ran the real `processRecording` (real ffmpeg, libx264) on `native.mp4` plus an `audio.webm` truncated to 150 bytes. It rejected with "Couldn't convert the audio" on both attempts, and `native.mp4` was untouched.
  - With hand-run ffmpeg, the same mux args exit 187 or 251 on files truncated to 40, 150 or 400 bytes, and 0 on 1000 bytes.
- **Fix:** on a non-cancel mux failure, keep the video. Rename `videoOut` to `screenOut` (it was encoded with `faststart: false`, so remux with `-c copy -movflags +faststart`, or simply accept it). Then set `hasAudio = false` and log, like the camera path does:
  ```ts
  } catch (err) {
    if (isCancelled(err)) throw err
    console.error('Audio could not be added; the project opens without it:', err)
    await fs.rename(videoOut, screenOut); audioLost = true
  }
  // later: const hasAudio = native ? !!audio && !audioLost : ...
  ```

### R-4 (low): recordings recovered after a renderer crash put the camera (and, for Chromium capture, the cursor) out of sync
- **Where:**
  - `src/main/recordingIpc.ts:580-605` (`started`) versus `:712-716` (`save`).
  - `src/renderer/src/recorder/session.ts:303-323`.
- **Problem:** `started()` persists `audioOffset` "so a recording interrupted by a crash keeps its separately recorded sound in sync". But two values the editor needs are only sent at stop (`SaveRecordingPayload`):
  - **`webcamOffset`:** `cameraFirst - nativeStart`, or `cameraFirst - screenZero`.
  - **The Chromium timeline zero:** `screenZero`, the first video frame. `started()` stores `startedAt = startCall` instead.
  `interrupt()` keeps `webcamOffset = 0` and `startedAt = startCall`.
- **Failure scenario:** the renderer crashes mid-recording, and the user recovers it from Unfinished recordings.
  - **Camera:** the bubble is offset by the camera's start delay. For native capture that is `audioOffset` plus the first camera frame (tens of ms or more).
  - **Chromium capture without audio:** the video zero is the first frame, which on a static screen can come well after `start()` (`nextFrameTime` waits up to 3 s). The whole cursor, click and zoom track is shifted by that much.
- **Evidence:** code reading of both paths. `interrupt` never receives the renderer payload, by construction.
- **Fix:** once `firstFrames` resolves in `RecordingSession.start`, send the measured offsets to main through a new `recording:offsets` IPC (`webcamOffset`, and for Chromium `startedAt = screenZero`). Main stores them in the manifest the way `started()` does for `audioOffset`. The values are known within a few frames of the start.

### R-5 (low): two default recording hotkeys swallow shortcuts the recorded app needs
- **Where:** `src/shared/recording/hotkeys.ts:14` (defaults) and `:159-168` (`COMMON`).
- **Problem:** the defaults are pause `Ctrl+Shift+P` and zoom-here `Ctrl+Shift+Z`. `globalShortcut` on Windows uses `RegisterHotKey`, which consumes the keystroke, so while recording those keys never reach the recorded app:
  - `Ctrl+Shift+P` is VS Code's Command Palette (and Chrome DevTools' command menu).
  - `Ctrl+Shift+Z` is Redo in most editors (VS Code, browsers' text fields, Figma, Adobe apps).
  `validateHotkey` exists to forbid exactly this ("taking them while recording would break them in the recorded app"), but `COMMON` omits these two, so the defaults pass.
- **Failure scenario:** recording a VS Code demo with default settings. Pressing Ctrl+Shift+P pauses the recording instead of opening the palette, and Ctrl+Shift+Z adds a zoom mark instead of redoing.
- **Fix:** pick non-conflicting defaults, for example `Ctrl+Shift+F9` / `Ctrl+Shift+F10` (or `Alt+Shift+…`), and add `Ctrl+Shift+Z` (Redo) and `Ctrl+Shift+P` to `COMMON`. Saved settings that still hold the old defaults then fall back through `sanitizeHotkeys`, so also migrate them.

### R-6 (low): a show issued while Explorer has not yet applied the hide leaves the desktop icons hidden
- **Where:** `native/src/win/desktop.rs:59-71`, with `src/main/recording/desktopIcons.ts:65-75`.
- **Problem:** `hide` posts `ShowWindowAsync(SW_HIDE)`, waits at most 1 s for Explorer to apply it, then reports `changed: true` even if it has not yet been applied.
  - `show` computes `target = action.target().filter(|&t| t != before)`. If the view still reads visible, no `SW_SHOWNA` is posted at all.
  - The pending `SW_HIDE` is then applied afterwards.
  - `show` returns ok, so the app clears `desktopIconsHidden` and never tries again.
- **Failure scenario:**
  1. "Hide desktop icons" is on, and Explorer is busy (e.g. just after sign-in, or under heavy IO).
  2. The user cancels during the countdown, or the recording fails to start.
  3. Restore runs before Explorer has processed the hide. The icons then disappear and stay hidden until Explorer restarts.
- **Evidence:** read both files end to end. Posted messages are processed in order, so an unconditional show posted after the hide would win.
- **Fix:** for `Show` (and `Hide`), always post the request instead of filtering on the current visibility. `SW_SHOWNA` on a visible window is harmless. Keep `changed = (before != target)` for the reply:
  ```rust
  let target = action.target();
  if let Some(show) = target { let _ = unsafe { ShowWindowAsync(view, if show { SW_SHOWNA } else { SW_HIDE }) }; /* wait */ }
  output::emit(&result_json(visible(view), target.is_some_and(|t| t != before)));
  ```

### R-7 (low): if the app process dies, the desktop icons stay hidden until the app is started again
- **Where:** `src/main/recording/desktopIcons.ts` (restore only from JS: `recordingIpc.ts:311`, `:843`, `:938`) and `native/src/win/desktop.rs:52-72` (one-shot hide).
- **Problem:** this is documented as intended ("the next app start restores them"). Still, after End task or a main-process crash nothing restores the icons until the user relaunches the app or Explorer restarts. This misses the "always restored" requirement.
- **Fix:** add a guardian mode, `desktop-icons hide --hold`: the helper hides the icons, blocks reading stdin, and on EOF (the app exited or died) shows them again if it hid them. Spawn it detached with a stdin pipe, as `record` is spawned. Keep the persisted flag as the fallback for when the guardian itself is killed.

### R-8 (low): pause and stop take effect a little late in the native video
- **Where:**
  - `native/src/pacer.rs:93-114` (`pause` / `resume`), `:140-157` (`finish`), `:159-167` (`take_until`).
  - `src/main/nativeCapture.ts:663` (`paused` / `resumed` events ignored).
- **Problem:** the app sends `pause <at>` and `stop <at>` with its own `Date.now()`, and the helper reads them a little later. Slots already written for times after `at` are never taken back. So the video keeps up to one command-latency of content past the pause or stop instant, while the app's cursor track and audio pause exactly at `at`.
- **Failure scenario:** at 60 fps, a pause at 990 ms that is read at 1000 ms keeps slot 60. After resume, 10 ms of pre-pause picture plays where the cursor track already shows post-resume time. Each pause adds an offset of about a frame (it does not accumulate past the next pause, since each pause re-anchors).
- **Evidence:** the fuzzer over the real `pacer.rs` measured the video running up to 58 ms longer than the app-side active timeline, with up to 19 ms simulated latency at 30 fps (this includes the intended round-up of the last slot).
- **Fix:** clamp the pause or stop instant to the written frontier, and use the instants the helper reports in `paused` / `resumed` as the pause list for native recordings:
  ```rust
  let at = self.clamp_instant(at, now).max(self.written_frontier().min(now));
  ```

### R-9 (low, robustness only): `Timebase::ticks_at` overflows on huge timestamps
- **Where:** `native/src/pacer.rs:209-211`, reached from `protocol.rs:19-30` (accepts any finite value).
- **Problem:** `(ms - epoch) * 10_000` saturates in the cast, then `self.ticks + …` overflows. Debug builds panic; release builds wrap to a negative value, so `pause 1e20` / `stop 1e20` acts at the previous state change.
  - The app always sends `Date.now()`, so this is not reachable from the app.
- **Evidence:** a scratch binary calling `ticks_at(1e20)` panics with "attempt to add with overflow" in debug.
- **Fix:** clamp the delta and use `saturating_add`, or reject timestamps more than a day from now in `parse_command`.

## Checked and fine

- **Pause/resume bookkeeping:**
  - `ActiveRecording.pause/resume/stop`: idempotent, and a stop while paused closes the span.
  - `toSourceTime` / `buildCursorTrack`: events inside pauses are dropped or moved to the pause start; shapes changed while paused apply on resume.
  - Typing bursts split at pauses. The tracker flushes the still period at pause, and the key filter resets.
- **Auto-pause:**
  - Idle resume versus manual pause ordering (commands are handled in order by the renderer).
  - The watcher stops on a manual pause and restarts on resume.
  - Disabled with a warning when the input hook is not running.
  - Activity is seen while paused (poll and hook).
- **Native start, fallback and cancel:**
  - Cancel during "Starting…" aborts and kills a helper that is still launching before the folder is removed.
  - Fallback clears native leftovers, and the fallback watcher for windows works.
  - A helper ending during the countdown is handled by `started()`.
  - A late `onEnded` subscription still fires; `stopAfterNativeEnd` cannot race the renderer's `started` flag.
- **Stop and timeouts:** helper stop/kill/timeouts in `HelperSession` (equal 30 s budgets are resolved in creation order, so the inner error with shapes and rects wins). The watcher stop has a kill grace.
- **Streaming to disk:** `ChunkPipe` and `ChunkWriter` serialise writes, report the first failure, and the renderer flushes pipes before `saveRecording`.
- **Stems:** kept only as a complete set, dropped on a recorder or disk failure in the renderer and in the manifest; `settleStems`; `keepStems` is non-fatal and removes partial outputs on cancel.
- **Finish later / Retry:** `processing` / `deferred` / `processingAborts` are cleaned in `finally`; cancel never falls back to another encoder; no project is written after an abort; partial proxies are removed. `listUnfinished` excludes active and processing ids, and `projectDir` rejects path traversal.
- **Renderer crash:** while recording, the run is interrupted (kept); during countdown or start, it is discarded. The toolbar renderer reloads itself after a crash.
- **Area recordings and toolbar:**
  - `sanitizeRegion` / `isUsableRegion` use the same minimum as the picker.
  - The crop uses identical rounding in TypeScript and ffmpeg (`regionPixels` / `cropFilter`).
  - Cursor and clicks are remapped into the area, and clicks outside it are dropped.
  - The toolbar is placed outside the area and excluded from capture; its own clicks are ignored.
- **Windows:**
  - Rectangle timeline: interpolation while moving, minimised windows, `cursorOver`, and resized windows fitted with the same rule as ffmpeg's `fitFilters`.
  - Mixed DPI: points are converted per point to physical pixels.
  - Odd window sizes fall back to VP8 in MediaRecorder.
- **Multi-monitor / DPI:** monitor matching by physical rectangle, with rounding tolerance and ambiguity refused; hook points converted via `screenToDipPoint`; display scale kept for cursor size.
- **Keystrokes:** shortcut-only labels; AltGr detection; missed keyups; the app's own hotkeys are excluded (uiohook keycodes are VK-derived, so labels match on other layouts). Hotkey validation, conflicts and sanitising are fine apart from R-5.
- **A/V offsets:** native audio and webcam offsets from one synced epoch clock (`syncEpoch`); adelay or `-ss` with `apad` + `atrim` to the frame-count duration; stems aligned by cross-correlation with a timestamp fallback.
- **Desktop icons:**
  - The flag is saved before hiding, so a crash is restored at the next start.
  - Icons the user had hidden themselves are never "restored".
  - Operations are queued, and a synchronous restore runs on quit.
  - Exceptions: R-6 and R-7.
- **Rust helper:**
  - Pacer: no duplicate or backwards timestamps across 20k fuzzed sequences.
  - Finalisation on stop, EOF, Ctrl+C, console close and session end, bounded by a 4.5 s latch.
  - Fragmented MP4 kept on error or abort.
  - Parent death reads as EOF.
  - Protocol parsing of junk, empty and partial lines.
  - Sizing: even sizes, level limits, no division by zero.
  - Window resize, minimise and close, plus monitor unplug, rotation and device loss.
  - No panicking unwraps on Windows API results.
- **Not verifiable here:** WGC, Media Foundation encoders, loopback audio, the real uiohook on Windows layouts, and Explorer behaviour. R-6 and R-7 are from code reading only.
