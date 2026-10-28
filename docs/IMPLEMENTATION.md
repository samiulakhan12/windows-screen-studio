# How it is implemented

## Stack
Electron 44 (main + preload + renderer) · React 18 · TypeScript · electron-vite · Vitest ·
Playwright (end-to-end) · ffmpeg (`ffmpeg-static`) · `uiohook-napi` (global mouse/keyboard hook) ·
Rust (`native/`: the Windows capture helper, and `native/speech`, the speech sidecar on whisper.cpp
and Silero VAD) · electron-builder (NSIS installer).

## Layout
```
src/main/               Electron main process
  index.ts                bootstrap, single-instance lock
  windows.ts              main window
  recordingIpc.ts         recording IPC: sources, display-media handler, sessions, toolbar, region picker, recovery
  recording/              session state, ordered chunk writer, finalize (proxy + project), proxy runner,
                          native video glue, track maths (pause/region remapping), keystroke filter,
                          hook clock, toolbar / region windows, capture exclusion (Windows 10 2004+)
  notes/                  speaker notes (teleprompter, docs/design/teleprompter.md): the store
                          (userData/notes.json, held during recordings), the notes window in its
                          rehearse and record modes (content protection, focus rules, hotkeys,
                          placement, where it was and when), and its IPC with per-channel sender checks
  cursorTracker.ts        cursor polling, clicks and keystrokes via uiohook
  nativeCapture.ts        client for native/ssw-capture.exe (probe, monitor matching, session protocol)
  projects.ts, projectsIpc.ts, atomicWrite.ts, styleDefaults.ts
                          project folders, load/save with Windows lock retries, saved style defaults
  proxyArgs.ts            WebM / native MP4 -> 60 fps short-GOP proxy (GPU encoder when available, crop, fit)
  exportIpc.ts, exportArgs.ts, exportJob.ts, exportClipboard.ts, ffmpeg.ts, hwEncoders.ts
                          export encoder processes, safe temp output, clipboard, GPU encoder detection
  mediaProtocol.ts        studio-media:// with Range support for <video>
  longJobs.ts, longJobsPort.ts, appLog.ts, diagnostics.ts, storage*.ts, exportBundle.ts
                          hands-off jobs and app health (docs/design/hands-off.md): taskbar progress and
                          buttons, notifications, keep-awake and sleep; the redacted rotating log in
                          userData/logs; the diagnostics report; the storage scan and Recycle Bin clean-up;
                          files saved next to an export
  ai/                     AI providers (keys, transcription pipeline, text tasks); transcribe.ts also runs
                          "On this PC" (providerId 'local') with lossless WAV parts
  speech/                 captions on this PC and the speech detector (docs/design/offline-captions.md):
                          helper.ts (ssw-speech as a child process: build choice from the `cpu` probe,
                          minimal environment, line caps, cancel, stall watchdog and time limit, exits),
                          download.ts (pinned, resumable, SHA-256-verified downloads from Hugging Face only),
                          models.ts (userData/speech-models and speech.json: status, trust on every use,
                          default-model rules, measured speed), localClient.ts (one helper run per part,
                          part cache in <project>/.cache/transcript-parts, language carry-over, retries,
                          the shared failure sentences), vad.ts (the speech detector on mic/mix sound,
                          kept in <project>/.cache/speech.json), service.ts (the store and SpeechState),
                          speechIpc.ts (speech:* handlers, throttled speech:changed)
src/preload/            contextBridge `window.api`, one file per area (typed in src/shared/api/*)
src/shared/             pure, unit-tested logic shared by main, renderer and tests
  types.ts                project schema v2 (clips, annotations, effects, audio, capture info)
  engine/                 timeline (clips <-> output time), history (undo), cursor smoothing, zoom, layout
  editor/                 edit store, clip/annotation operations, autosave, timeline scale
  recording/              mime choice, error messages, ordered chunk pipe, region geometry
  render/                 MP4 demuxer, decode feed plan, export plan, codec tags, overlay timing
src/renderer/src/       React UI
  views/                  Home, Editor, Toolbar (floating bar), RegionPicker (area overlay)
  recorder/               capture streams, MediaRecorders, devices, controller
  editor/                 player, preview stage, timeline, inspector, transport, export dialog, exporter
  render/                 compositor, static layer cache, text/keystroke overlays, cursor sprites,
                          frame sources (WebCodecs decoder / seek fallback), encoder sinks
native/                 Rust helper ssw-capture.exe (WGC capture, MF H.264, protocol over stdin/stdout);
                          native/speech: ssw-speech (whisper.cpp + Silero VAD sidecar)
scripts/                build-native, predist checks, verify-dist, icon renderer
tests/                  vitest unit tests; tests/e2e Playwright tests of the built app
```

## Data model
A project folder holds `project.json` (schema v2, migrated automatically from v1), `cursor.json`
(cursor samples, clicks with their release times, keystrokes, cursor shapes, zoom-here marks,
typing bursts, mouse-wheel scrolls, display scale) and H.264 proxies (`screen.mp4`, `webcam.mp4`).
Edits are a list of **clips** (kept source ranges, each with a speed); the gaps between clips are
cuts. Zooms, annotations, cursor data and keystrokes stay in **source time**, so cutting or
re-timing never moves an overlay off its content.

`cursor.json` is written only while recording and once when processing finishes; the editor never
changes it. Edits to the recorded input are data in `project.json` `inputEdits`: ignored clicks
(named by their time in whole milliseconds), the straighten-moves option and painted path ranges.
`shared/engine/inputTrack.ts` `effectiveTrack()` applies them, and the editor's scene (so preview
and export), processing and every auto zoom regeneration read the track only through it
(`docs/design/smarter-auto-zoom.md`). Older recordings have no scroll or release data and no
`inputEdits`, and behave exactly as before.

Two more edits of the recording are data in `project.json` (Wave 6, `docs/design/editing-wins.md`).
A **crop** (`Project.crop`, a rectangle normalised to the full recorded frame) is applied when frames
are drawn, never by re-encoding: every stored position stays relative to the full frame, and
`shared/engine/crop.ts` `cropView()` gives the scene, the cursor track and the director their view of
the cropped picture; layout and export sizes read the recording's size through `visibleSize`.
**Freeze frames** (`Project.freezes`, anchored in source time) add a layer over the clip timeline:
`shared/engine/freeze.ts` maps edit (output) time to **video time**, which includes the inserted
holds. Only the player clock, export frames and sound, subtitle and chapter times and the displayed
times read video time; overlays, snapping, smart speed and the director keep using source and edit time.

Image overlays (`Project.overlays`) are timed in source seconds and placed in the **output frame**
(centre normalised to the frame, size as fractions of its shorter side), like text annotations;
their files (`overlay-<n>.<ext>`) and fonts (`Project.fonts`, `font-<n>.<ext>`) are copied into the
project folder by `src/main/assetIpc.ts`, which checks type by content and size and stores an
identical file once. `render/overlayLayer.ts` decodes each picture once (GIF frames with WebCodecs
`ImageDecoder`, the frame chosen by output time); `render/fontLoader.ts` registers fonts from their
bytes with `FontFace` (the CSP is unchanged) and the text layers key their caches by the font. The
brand kit lives in userData (`brand-kit.json` and `brand-kit/`, `src/main/brandKit.ts`); applying it
is one pure function (`shared/editor/brandKit.ts`), used by the editor (one undo step) and by
`applyStyleDefaults` for new recordings (`docs/design/brand-kit.md`).

Recordings live in `Videos\Flown`, settings in userData (`%APPDATA%\Flown`; Electron derives both
names from `productName`). The app was called "Screen Studio for Windows" before; on the first
start as Flown `src/main/brandMigration.ts` renames the old userData folder (before the
single-instance lock, which lives in it; the whole folder moves, so Chromium's `Local State` and
the safeStorage key that decrypts saved AI keys stay together) and moves `Videos\Screen Studio
for Windows` to `Videos\Flown`. Each step is one rename, so it is crash-safe and simply resumes
on the next start; whatever cannot be moved stays where it is and is still used (userData via
`app.setPath`, recordings as an extra library root in `projects.ts`).

## Data flow
1. **Record.** Home picks a source. For screens and areas on Windows, main starts the native helper
   (cursor excluded, GPU H.264, paused time cut out at the app's exact pause/resume instants) and
   the renderer records audio only; otherwise the renderer records video+audio with MediaRecorder
   (hardware H.264 preferred). Every 1 s chunk is sent over an ordered IPC channel and appended to
   files in the recording folder, with a `recording.json` manifest, so a crash leaves recoverable
   data. The cursor tracker samples positions, clicks (ignoring the app's own windows and anything
   outside the recorded display/area) and shortcut keystrokes on the same pause-adjusted clock.
2. **Process.** ffmpeg builds the proxies (GPU encoder when one works, else x264 superfast; fixed
   size with aspect-preserving fit; exact crop for areas; separate native video + audio muxed with
   their measured offset), with progress and "Finish later". The project duration comes from the
   video frames. Auto zoom segments are generated from click clusters.
3. **Edit.** An edit store wraps the project in an undo history (drags/sliders coalesce into one step)
   and autosaves atomically. The player maps output time to source time through the clips (skipping
   cuts, per-clip `playbackRate`) and draws with the compositor on `requestVideoFrameCallback`,
   only when something changed. The compositor is a pure function of `(source time, project,
   frames)`: cached background/shadow layer, camera from zoom envelopes and a heavily smoothed
   cursor path, motion blur by sampling the camera across the frame interval, cursor sprite,
   ripples, webcam, text and keystroke overlays.
   **Selecting several items** (E-06, `docs/design/multi-select.md`) is view state, never saved: next
   to the single selection the editor keeps a group (`ItemGroup`: keys `${kind}:${id}`, the snapping
   owner keys, an anchor and a stamp), dropped by `validGroup` when undo or a delete removes its
   items. Components read it through `GroupContext`; the timeline's tracks call one controller
   (`multiSelectControl.ts`) on the first line of their pointer handlers, so a press without `Ctrl`
   or `Shift` runs exactly as before. The rules are pure and unit-tested in
   `src/shared/editor/`: `multiSelect.ts` (keys, toggles, runs, `Ctrl+A`, box hits), `groupMove.ts`
   (block limits, freeze acceptance, moves from the press times), `groupEdit.ts` (the field table
   behind the Selection view, Mixed, looks, delete) and `groupClipboard.ts` (copy, paste,
   duplicate). Each group action is one `store.update` (a drag: one gesture), so one undo step.
   Copied items and looks live in renderer memory only (`itemClipboard.ts`), never the OS clipboard.
4. **Export.** Output frame times come from the clips (`exportFrameTimes`). Source frames are decoded
   in order with WebCodecs from the proxy (own MP4 demuxer), with a frame-accurate seek fallback.
   Frames are encoded with WebCodecs (H.264 Annex B chunks to ffmpeg for muxing) or as raw frames to
   ffmpeg with the best working encoder (NVENC / Quick Sync / AMF, else x264); raw video frames are
   converted to 4:2:0 YUV in the renderer, which makes the IPC copies 2.7x smaller. Audio is rebuilt
   from the clips with `atrim`/`atempo`/`concat` (each re-timed clip kept on its frames despite
   atempo's lead), volume and exact duration; sources mixed together (click sounds too) are made
   stereo first, a mono one at full level on each side as the preview plays it. GIFs use
   bounded-memory palette passes. Output goes to a temp file and is renamed into place on success.

## Why these choices
* **Determinism:** every visual is a function of source time, so preview, scrubbing and export
  agree; the motion engine is pure TypeScript with unit tests.
* **Never lose a recording:** streaming to disk plus a manifest replaces holding the recording in
  memory (which broke above 2 GiB in the first version).
* **Native capture for the cursor:** Chromium always draws the OS cursor into desktop capture, so the
  smooth cursor needs Windows Graphics Capture with cursor capture disabled.
* **Light and smooth:** hardware encoders for recording, proxies and export; no React re-render per
  playback frame; no work when idle.

## Testing
* `npm test`: vitest unit tests for engine, timeline, editor operations, recording maths, export and
  proxy arguments, MP4 demuxer, overlays, native client protocol (with a fake helper) and packaging.
  The speech main process is tested against `tests/fixtures/fake-speech-helper.cjs` (through
  `SSW_SPEECH_HELPER`, unpackaged only) and a local HTTP server for downloads.
* `npm run test:e2e` (after `npm run build`, under `xvfb-run` on Linux): Playwright drives the real
  app. It records with fake camera/microphone devices and real X11 input, and covers the native path
  through a helper process that speaks the real protocol. Editor flows, frame-accurate export, A/V
  sync after cuts and speed changes, colours, cancel safety, clipboard, overlays and packaging are
  covered too. Captions on this PC and the speech detector run the host build of the speech sidecar
  with a small Whisper model served by the mock server (`tests/e2e/offline-captions.e2e.cjs`).
* `cargo test` / `cargo clippy` in `native/` and `native/speech`; `npm run dist:win` runs `verify-dist` on the package.
* Windows-only behaviour that cannot run here is listed in the README and in `native/README.md`.
