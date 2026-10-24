# ssw-capture — native Windows capture helper

A small Rust program (≈440 KB) that records one monitor or one window with
**Windows.Graphics.Capture with the mouse cursor excluded** and encodes it to **H.264 MP4 with Media Foundation**,
on the GPU when a hardware encoder is present (NVIDIA NVENC, Intel Quick Sync, AMD AMF).
The MP4 is **fragmented**, so a recording survives the helper being killed or crashing.

Why it exists:

- Chromium's `getDisplayMedia` always bakes the OS cursor into the video, so the editor's
  smooth cursor, click effects and idle hiding drew a second cursor (audit F03). With the
  helper the cursor is not in the pixels; the app draws it from its own position track and
  the cursor shapes reported here.
- Chromium encodes the screen with software VP9, which drops frames at 1440p/4K 60 fps
  (audit F22). The helper hands GPU frames straight to the hardware encoder: no CPU readback,
  no CPU colour conversion.

The Electron side is `src/main/nativeCapture.ts`. When the helper is missing or `probe`
fails, the app records through Chromium as before.

## Requirements

| | |
| --- | --- |
| OS | Windows 10 version 2004 (build 19041) or later; Windows 11 to hide the yellow capture border |
| GPU | Direct3D 11 with video processing (any GPU driver from the last decade; not the bare "Microsoft Basic Display Adapter" of some VMs) |
| Encoder | A hardware H.264 Media Foundation encoder, or the Microsoft software encoder (Windows "N" editions need the Media Feature Pack) |

## Building

```bash
node scripts/build-native.mjs            # -> native/bin/ssw-capture.exe
node scripts/build-native.mjs --require  # fail (exit 1) instead of warning when it cannot be built
```

- On Windows it builds for the host toolchain (`x86_64-pc-windows-msvc`, or `-gnu`).
- On Linux/macOS it cross-compiles for `x86_64-pc-windows-gnu`, which needs
  `rustup target add x86_64-pc-windows-gnu` and MinGW-w64 (`apt install mingw-w64`).
- Without a usable toolchain (or when the build fails) the script prints a warning and exits 0:
  the app still works and falls back to Chromium capture. Release builds and CI should pass
  `--require` so a missing helper fails the build instead of silently shipping without it.
- Packaging bundles `native/bin/ssw-capture.exe` as `resources/native/ssw-capture.exe`.
  `SSW_CAPTURE_HELPER=<path>` overrides the location (an executable, or a `.js/.cjs` file
  that Electron runs as Node; the tests use `tests/fixtures/fake-capture-helper.cjs`).

Release profile: `opt-level = "s"`, LTO, stripped, `panic = "abort"`. Unit tests of the
platform-independent logic (CLI, protocol, frame pacing, sizing, the window fit and the capture
buffer growth, cursor shapes, window tracking including `cursorOver`, the polling schedule,
interrupt handling) run anywhere: `cargo test --manifest-path native/Cargo.toml`.

## Command line

```
ssw-capture probe
ssw-capture list
ssw-capture record --monitor <device name | index> --out <file.mp4> --fps <30|60> [--bitrate <bps>]
ssw-capture record --window <HWND> --out <file.mp4> --fps <30|60> [--bitrate <bps>]
ssw-capture watch-window --window <HWND>
ssw-capture desktop-icons <hide|show|status>
ssw-capture selftest --out <file.mp4> [--fps <30|60>] [--seconds <1-60>]
ssw-capture --version
```

| Exit code | Meaning |
| --- | --- |
| 0 | Success (`probe`: capture without the cursor is supported) |
| 1 | Runtime error (device, capture or encoder failure) |
| 2 | Invalid arguments (including a missing output folder) |
| 3 | Unsupported on this system |
| 4 | Monitor or window not found (`desktop-icons`: no desktop icon view) |

Human-readable diagnostics go to stderr; stdout carries only JSON.

### `probe`

```json
{"supported":true,"cursorToggle":true,"borderToggle":true,"windowCapture":true,"capture":true,"minUpdateInterval":false,
 "hardwareEncoders":["NVIDIA H.264 Encoder MFT"],"softwareEncoder":true,"reason":null}
```

`supported` = Windows.Graphics.Capture is available **and** the cursor can be excluded
(`IsCursorCaptureEnabled`, Windows 10 2004+) **and** an H.264 encoder is registered. When
false, `reason` says why and the exit code is 3.

### `list`

```json
[{"index":0,"device":"\\\\.\\DISPLAY1","name":"DELL U2720Q","x":0,"y":0,"width":3840,"height":2160,"primary":true}]
```

Rectangles are physical pixels (the helper is per-monitor DPI aware). The app maps an
Electron display to a monitor by comparing them with `screen.dipToScreenRect(null, display.bounds)`.

### `record`

Events, one JSON object per line on stdout:

| Event | When |
| --- | --- |
| `{"event":"ready"}` | Device, encoder and capture session are set up; capture is starting |
| `{"event":"started","at":<epoch ms>,"width":W,"height":H,"fps":F,"encoder":"…","hardware":true,"fragmented":true}` | First frame captured; `at` is its capture time. `width`/`height` are the encoded size; `fragmented` says whether the file is crash-safe (see Output file) |
| `{"event":"cursor","at":<epoch ms>,"shape":"arrow"}` | Cursor shape changed (and once right after `started`) |
| `{"event":"paused","at":…}` / `{"event":"resumed","at":…}` | A pause/resume took effect at `at` |
| `{"event":"warning","message":"…"}` | Something non-fatal (e.g. the border could not be hidden, or a plain MP4 is written because fragmented MP4 could not be set up) |
| `{"event":"stopped","frames":N,"dropped":D,"duration":S,"reason":"stop"}` | The MP4 is finalised; `reason` is `stop`, `eof` (stdin/stdout closed), `closed` (monitor disconnected, recorded window closed, or the capture was revoked), `interrupt` (Ctrl+C or the console closed) or `shutdown` (sign-out, shutdown, restart) |
| `{"event":"error","message":"…"}` | Fatal; the process exits non-zero (a partial recording is finalised when possible, and a fragmented one is kept even when that fails) |

Commands, one per line on stdin: `pause [epochMs]`, `resume [epochMs]`, `stop [epochMs]`.
The optional timestamp is the instant the app acted at, so the cut matches the app's clock
even though the line arrives a few milliseconds later (clamped to "now" and to the previous
command). **Closing stdin stops the recording** — so does the app dying — and the file is
still finalised. Ctrl+C in a console does the same. Closing the console window, signing out
and shutting down also stop it; the helper then holds the process (at most 4.5 s, the most
Windows allows) until the file is finalised: a console control handler for the console, a
hidden window answering `WM_ENDSESSION` for sign-out/shutdown (a process that loaded user32
gets no console notification for those, and the app starts the helper without a console).

The app ends a recording it did not ask to end through `NativeCaptureSession.onEnded`: a
`stopped` it did not request (`closed`, …), an `error`, or the process exiting without
either (`crashed`). The app spawns the helper **detached** on Windows: Node puts other child
processes in a kill-on-close job object, so they die the instant the app does; detached, the
helper sees its stdin close and finalises. Quitting the app sends `stop` and waits up to 5 s
before anything kills the helper.

Cursor shapes: `arrow`, `text`, `pointer`, `crosshair`, `move`, `resize-ew`, `resize-ns`,
`wait` (`GetCursorInfo` polled at ~60 Hz and compared with the system cursors; diagonal resize
cursors map to `move`, custom application cursors to `arrow`).

### Window capture: `record --window` and `watch-window`

`<HWND>` is the decimal window handle; Electron's desktopCapturer window source id is
`window:<HWND>:<n>` on Windows, so the app passes that number. `probe` reports
`"windowCapture":true` when a single window can be captured with the cursor excluded
(`GraphicsCaptureItem` via `IGraphicsCaptureItemInterop::CreateForWindow`, plus the cursor
toggle).

`record --window` records that window (cursor excluded, border hidden where supported) with
the same events and commands as monitor recording, plus:

| Event | When |
| --- | --- |
| `{"event":"window","at":<epoch ms>,"x":X,"y":Y,"width":W,"height":H,"minimized":false,"cursorOver":true}` | The window's screen rectangle in physical pixels (`DWMWA_EXTENDED_FRAME_BOUNDS`, i.e. without the invisible resize border): once right after `started` (before any `cursor` event), then whenever it moves, resizes, is minimised/restored, or `cursorOver` changes (polled every 16 ms on a high-resolution timer). `cursorOver` is true when the top-level window under the cursor (`WindowFromPoint` + `GetAncestor(GA_ROOTOWNER)`) is the recorded window, false when another window covers that spot; the app ignores clicks and hides the cursor while it is false |

- The encoded size is fixed to the window's **initial** captured content size (made even and
  within H.264 level limits). When the window is resized, every later frame is scaled to
  **fit** inside that size, keeping its aspect ratio, centred, with black bars: exactly
  `fitContent()` in `src/shared/recording/windowGeometry.ts`
  (`scale = min(W/w, H/h)`, offset `((W - w*scale)/2, (H - h*scale)/2)`).
- While the window is minimised WGC delivers no frames; the last frame is repeated (constant
  frame rate) and `window` reports `"minimized":true`.
- When the window closes, the helper finalises the file and reports
  `{"event":"stopped",...,"reason":"closed"}` (the app is told through `onEnded`).

`watch-window --window <HWND>` captures nothing. It is used when the app records the window
with Chromium (no WGC window capture), so clicks and the cursor can still be mapped into the
window. It prints `{"event":"ready"}`, then the same `window` events (initial rectangle
first, then changes), and on stdin `stop` or EOF prints `{"event":"stopped","reason":"stop"}`
and exits 0. If the window does not exist it prints an `error` event and exits 4; if the
window closes while watched it prints `stopped` with `"reason":"closed"` and exits 0.
It needs neither Windows.Graphics.Capture nor an encoder (only user32 and DWM), so it also works
where `probe` reports `"supported":false`.

Details (`src/window.rs` decides what is reported, `src/win/window.rs` asks Windows):

- A handle that is not a window (`IsWindow`) is "not found" (exit 4) for both commands, before
  any capability check, so a stale handle is told apart from an unsupported system.
- Not on screen = minimised (`IsIconic`), hidden (`!IsWindowVisible`) or cloaked
  (`DWMWA_CLOAKED`: another virtual desktop, a suspended app). All are reported as
  `"minimized":true` with the **last on-screen rectangle** (not Windows' -32000,-32000 parking
  spot), so a minimise/restore pair does not look like a jump across the screen.
- `record --window` emits the first `window` event on the recording thread right after
  `started`, then the cursor thread (which already polls the cursor shape) looks at the window on
  the same tick; nothing is printed unless something changed.
- Polling rate: both commands poll on a fixed 16 ms schedule (`src/ticker.rs`: a tick is due one
  interval after the previous one, so the work does not stretch the period) and wait on a
  high-resolution waitable timer (`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`, `src/win/timer.rs`).
  A plain wait (`Sleep`, a channel timeout) ends on the 15.6 ms system tick, which made
  `watch-window` poll at ~32 Hz; other processes raising the timer resolution no longer help since
  Windows 10 2004. Before Windows 10 1803 (no such timer) the helper raises `timeBeginPeriod(1)`
  while it polls and releases it when it stops.
- `cursorOver`: on each tick `WindowFromPoint(GetCursorPos())` (it follows the Z order, as mouse
  input does, and sends no message to other apps) and `GetAncestor(GA_ROOTOWNER)` of both that
  window and the recorded one; equal root owners = over. So the recorded app's own child windows
  and owned dialogs count as over it; another app's window covering the spot (or the cursor being
  elsewhere, or the window minimised) is not over it. A change of `cursorOver` alone emits a
  `window` event (same rectangle).
- Frames and resizing: WGC draws each frame at the top-left of a frame-pool buffer and crops
  content that is larger. A window's buffers are created with room for it to grow up to the
  largest monitor (+64 px; `sizing::window_buffer_size`), so maximising it or dragging it larger
  never yields a cropped frame: the video follows the window live, at the new fit. The cost is GPU
  memory only: two buffers of that size, as when recording that monitor. Content that still
  outgrows them (a window spanning monitors) is dropped and the buffers grow in the same poll to
  1.25x the content (never shrinking), so a continuing drag fits the next frame. Because WGC only
  sends a frame when the content changes, the capture session is restarted (`StartCapture` always
  sends the current picture) if no full frame follows within 100 ms, so a window that does not
  repaint never leaves the pre-resize picture in the video. The output size never changes (the
  window's initial size). The copy of the newest frame and the GPU video processor have their own
  capacity: a smaller or equal content size only changes the processor's source/destination
  rectangles (`fit_rects`), so a resize drag costs no texture or processor rebuild per frame.
  Frames that arrive while the window is minimised are ignored.
- The window must not be minimised when recording starts (WGC delivers no first frame then; the
  helper says so after 5 s and exits 1). The device is created on the GPU of the monitor showing
  most of the window (`MonitorFromWindow`).

### Output file

- **Fragmented MP4** (`MFTranscodeContainerType_FMPEG4`, `MF_MPEG4SINK_MIN_FRAGMENT_DURATION`
  0.9 s): the `moov` is written up front and every 1 s GOP becomes one `moof`/`mdat` fragment.
  When the helper never finalises the file (killed by Task Manager or a stop timeout, a crash,
  a driver fault, power loss), everything up to the last complete fragment still plays and the
  app's "Unfinished recordings" can recover it; a plain MP4 has no index until Finalize and
  would be lost. If the fragmented sink cannot be set up (it needs Windows 10 1709+), the
  helper writes a plain MP4 and says so in a `warning`; `started` reports `"fragmented":false`.
- H.264 High profile, **constant frame rate** at `--fps`: one frame per 1/fps slot,
  showing the newest captured frame. A static screen still produces a full-length video
  (Windows.Graphics.Capture delivers no frames when nothing changes).
- **Paused time is removed** from the timeline: no frozen gap, the video jumps cut-style.
- The video lasts until the stop instant. If the encoder falls behind, at most 4 overdue
  frames are written per wake-up and older slots are skipped (counted in `dropped`).
- 1-second GOP, no B-frames (cheap, frame-accurate seeking in the editor).
- BT.709, limited range (GPU video processor conversion; the media types carry BT.709 tags,
  which encoders write into the stream's colour description).
- Average bitrate ≈ width × height × fps × 0.07 (1080p60 ≈ 8.7 Mbps, 4K60 ≈ 35 Mbps), between
  1 and 50 Mbps, VBR where the encoder supports it; `--bitrate` overrides.
- Even dimensions (an odd last row/column is cropped). Monitors beyond H.264 level 5.2
  (more than 4096 px wide/high or 36,864 macroblocks, e.g. 5K) are scaled down to fit and a
  `warning` says so.

### `desktop-icons`

Hides or shows the desktop icons for "Hide desktop icons while recording", and prints
`{"visible":false,"changed":true}`: whether the icons are visible afterwards, and whether this
call asked for a change. `status` only reports. Exit code 4 with a JSON error when there is no
desktop icon view (Explorer is not the shell, or not running).

- The icon view is the `SysListView32` inside `SHELLDLL_DefView`, which lives in `Progman`, or in
  a top-level `WorkerW` once Explorer moved it there (wallpaper slideshow, some animated
  wallpapers); Windows 11 24H2 keeps it in `Progman`. The search is portable code
  (`src/desktop.rs`, unit-tested against those layouts).
- Only that window's own visibility changes (`ShowWindowAsync` `SW_HIDE` / `SW_SHOWNA`), never
  Explorer's "Show desktop icons" setting, which Explorer saves in the registry. Nothing outlives
  Explorer: restarting it (or signing out) always brings the icons back. Asynchronous, so a busy
  or hung Explorer never blocks the helper; it then waits up to 1 s for the change to show.
- `changed` is `false` for `hide` when the icons were already hidden (the user switched them off):
  the app then never "restores" them. The app remembers icons it hid in its settings before
  hiding them and shows them again when the recording stops, is cancelled or crashes, when the
  app quits, and at the next start if the app itself died.

### `selftest`

Runs the same GPU conversion and encoder as `record` on a generated colour sweep, without
screen capture, and prints `{"event":"selftest","ok":true,"encoder":"…","hardware":true,"fragmented":true,"speed":12.3,…}`
(`speed` = times faster than real time). Use it to tell encoder/driver problems from capture
problems.

## How it works

```
WGC frame pool (free-threaded, polled) ──CopySubresourceRegion──▶ newest BGRA texture
        │                                                             │
   cursor excluded,                                  every 1/fps slot │ ID3D11VideoProcessor
   border hidden (Win 11)                                             ▼ BGRA → NV12 BT.709
                                   MF sample allocator NV12 texture ◀─┘
                                                │ IMFSinkWriter (hardware MFT, DXGI device manager)
                                                ▼
                                            screen.mp4
```

- One recording thread: wakes at each frame slot (high-resolution waitable timer through
  `std::thread::sleep`, at least every 15 ms), drains the capture pool, converts and encodes.
  Separate threads read stdin and poll the cursor shape (and, recording a window, its rectangle
  and `cursorOver`) every 16 ms on an explicit high-resolution timer.
- `pacer.rs` owns the timeline (slots, pauses, stop, catch-up); it is pure and unit-tested.
- The Direct3D device is created on the GPU that drives the recorded monitor (for a window: the
  monitor showing most of it), so frames never
  cross GPUs on hybrid laptops and the encoder Media Foundation picks sits on that GPU.
- Encoder setup tries hardware first with full tuning, then progressively simpler settings,
  then the software encoder, so an encoder that rejects one property still works. Each
  configuration first encodes three frames into a throwaway `<out>.encoder-check-N.mp4`
  (deleted right away), because some failures only appear once frames flow. Before that, a
  cheap `<out>.container-check.mp4` checks that the fragmented MP4 sink accepts the stream
  (no encoder is loaded); the first configuration that fails as a fragmented MP4 is retried
  once as a plain MP4, to tell a container problem from an encoder problem.
- The encoder's input pool holds at most 16 frames; when it is exhausted the frame is dropped
  instead of queueing without bound, so memory stays flat.

## Verification status

Verified in this repository (Linux container, no Windows):

- `cargo test`: CLI (including `--window` / `watch-window` parsing: decimal and signed handles,
  `0x` hex, rejects 0, junk, whole `window:<n>:<m>` ids and `--monitor` + `--window`), protocol/JSON
  (the `window` event with `cursorOver` and the watch `stopped` event, field for field as in the
  table above), frame pacing (static screen, pauses, late wake-ups, stop), output sizing and
  bitrate, the fit of a resized window (`fit_content`, checked against the vectors of
  `tests/windowGeometry.test.ts` so the helper and the app agree), the capture buffer sizes
  (headroom up to the largest monitor, growth by 1.25x only when content outgrows them, never
  shrinking, capped at Direct3D's 16384), the window tracker (first state, changes only, a
  `cursorOver` change alone is a change, minimise keeps the on-screen rectangle, close reported
  once), the fixed-rate polling schedule (62.5 Hz whatever the work costs, no catch-up burst after
  a stall), cursor-shape table, and the built binary's exit codes.
- Cross-compiles for `x86_64-pc-windows-gnu` with no `cargo clippy -D warnings` findings.
- Under wine 9: `probe` exits 3 with JSON (wine has no Windows.Graphics.Capture), `list`
  returns the monitors, `record` fails cleanly with exit 3. `selftest` creates the Direct3D 11
  device, the DXGI device manager and the sink writer with all media types, then walks the
  whole encoder fallback chain (wine has no H.264 encoder) and fails cleanly without leaving
  files behind. Nothing crashes or hangs. (This run found and fixed a real bug: a failed
  attempt kept its file locked, so every later fallback failed with a sharing violation.)
  Wine has no fragmented MP4 sink (`Creating the MP4 writer failed: Invalid parameter`), so
  `selftest` there also exercises the fallback to a plain MP4.
- `desktop-icons` under wine 9 (`tests/e2e/recording-options.e2e.cjs`): without a desktop
  (wine has no Explorer shell) it prints a JSON error and exits 4 for `hide`, `show` and
  `status`, nothing crashes. Against `examples/fake_desktop.rs` (Explorer's window classes,
  `Progman` or a top-level `WorkerW` holding `SHELLDLL_DefView` > `SysListView32`) the real
  user32 path runs end to end, also through the app's client (`desktopIcons()` in
  `src/main/nativeCapture.ts`): `status` → visible, `hide` → `"visible":false,"changed":true`,
  `hide` again → `"changed":false`, `show` → `"visible":true,"changed":true`.
- Window commands under wine 9: `probe` reports `"windowCapture":false`; `watch-window` and
  `record --window` with a handle that is no window print a JSON error and exit 4; `watch-window`
  on wine's desktop window (0x10020) prints `ready`, its rectangle (the virtual screen) with
  `"cursorOver":true` (wine's `WindowFromPoint`/`GetAncestor`) and, on `stop`, `stopped` with
  exit 0 — the real timer-paced polling/stdin loop end to end; `record --window` on that
  window gets past the lookup and exits 3 (no Windows.Graphics.Capture). These run through the
  Electron client in `tests/e2e/native.e2e.cjs`.
- Window recording through the client against the fake helper on Xvfb + openbox: an xterm found
  through Electron's `desktopCapturer` (`window:<xid>:0`), moved (XMoveWindow) and resized
  (XResizeWindow) mid-recording: the rectangle timeline, the fixed output size and the letterboxed
  fit of the resized window in the video; `watchWindow()` following it; the window closing ending
  a recording (`onEnded` "closed") and a watch. `cursorOver` on X11 (the fake reports the root's
  child under the pointer, `XQueryPointer`, against the recorded window's frame, the counterpart of
  `WindowFromPoint` + `GA_ROOTOWNER`): a second xterm over part of the recorded one, the pointer
  moved with XTest onto the recorded window, onto the covering window, back, and away gives
  `true,false,true,false` with an unchanged rectangle, for `record --window` and `watch-window`.
  `tests/nativeCapture.test.ts` covers the client's window paths (ids, timelines, minimise, close,
  early exits, timeouts, no stray processes, `cursorOver` kept only when the helper reports a
  boolean).
- `tests/nativeCapture.test.ts` and `tests/e2e/native.e2e.cjs` drive the Electron client
  against a protocol-compatible fake helper and against the real exe under wine: `onEnded`
  for a closed capture, a fatal error and a crash; graceful stop when the app quits (the e2e
  quits the real Electron app mid-recording); the detached spawn on Windows. The fake writes
  fragmented MP4 like the helper, so the app's processing runs on fMP4 in the e2e tests.
- `tests/nativeCrashSafe.test.ts`: the app's `processRecording` builds a project from a
  fragmented MP4 cut off mid-fragment (what a killed helper leaves), and fails on a plain MP4
  cut off the same way ("moov atom not found").

**Not verified: actual capture and encoding, which need Windows 10 2004+ or Windows 11.** Nor
`desktop-icons` against the real Explorer (its window layout on each Windows version, and that
hiding the view leaves the wallpaper and the desktop's other behaviour intact). For
windows that includes: that `CreateForWindow` captures exactly the `DWMWA_EXTENDED_FRAME_BOUNDS`
area (the app maps the cursor through that rectangle; a mismatch of a few pixels would offset
the editor's cursor by as much), the frame-pool headroom and growth on resize (that a maximised
window's content fits the largest monitor + 64 px, that frames in a larger buffer are whole and
top-left, that `Recreate` and the session restart behave as documented, and that the video
processor accepts input textures larger than its content with only the source rectangle
changed), minimise/restore and close handling, and the cursor being absent from window captures.
Also only on Windows: the polling rate (wine's timers are not Windows' 15.6 ms tick, so the e2e
cannot show the ~32 Hz → ~62 Hz difference) and `cursorOver` against real windows (Z order,
owned dialogs, always-on-top and layered/click-through windows, a disabled owner behind a modal
dialog, cloaked windows).
Also unverified for the same reason: that Media Foundation's fragmented sink honours
`MF_MPEG4SINK_MIN_FRAGMENT_DURATION` (≈1 s fragments) and that ffmpeg reads its output as it
reads ffmpeg's own fMP4; the console-close and sign-out/shutdown handling; the detached spawn
surviving the app's death. Run the checklist below on real hardware before relying on it.

## Manual test checklist (Windows 10 2004+ / 11)

Open a terminal in the repository (after `node scripts/build-native.mjs`) and have `ffprobe`
available (e.g. `node_modules\ffmpeg-static` ships ffmpeg; any ffprobe works).

1. **Probe** — `native\bin\ssw-capture.exe probe`
   Expect exit code 0 and `"supported":true,"cursorToggle":true`; `hardwareEncoders` lists your
   GPU's encoder; Windows 11 shows `"borderToggle":true`.
2. **List** — `native\bin\ssw-capture.exe list`
   Expect one entry per monitor with physical sizes (a 4K monitor at 150 % shows 3840×2160)
   and the right `primary` flag.
3. **Selftest** — `native\bin\ssw-capture.exe selftest --out %TEMP%\selftest.mp4 --fps 60 --seconds 5`
   Expect `"ok":true`, `"hardware":true` on a machine with a GPU encoder, `"fragmented":true`
   and `speed` well above 1. The file plays as a 5 s colour sweep and is fragmented:
   `ffprobe -v trace %TEMP%\selftest.mp4 2>&1 | findstr /c:"type:'moof'"` lists about 5 fragments.
4. **Record with pause** — `native\bin\ssw-capture.exe record --monitor 0 --out %TEMP%\rec.mp4 --fps 60`
   Expect `ready`, then `started` within a second, then `cursor` events as you move over text
   fields (`text`), links (`pointer`) and window edges (`resize-ew`/`resize-ns`). Type `pause`
   Enter, wait 5 s, `resume` Enter, wait 5 s, `stop` Enter. Expect `stopped` and exit code 0.
   - `ffprobe -v error -show_entries stream=codec_name,profile,width,height,r_frame_rate,color_space,color_transfer,color_primaries,color_range:format=duration %TEMP%\rec.mp4`
     → h264 High, monitor size, 60/1, bt709 tags, tv range, duration ≈ recorded time **minus** the
     5 s pause.
   - Play it: **no mouse cursor anywhere**, no yellow border (Windows 11), smooth motion when
     dragging a window, no frozen 5 s section.
5. **Static screen** — record 20 s without touching anything, then `stop`. Duration ≈ 20 s
   (not ~0) and `frames` ≈ 20 × fps.
6. **Stop by closing stdin** — start `record`, press Ctrl+Z then Enter. Expect
   `"reason":"eof"` and a playable file. Ctrl+C instead gives `"reason":"interrupt"` and a
   playable file.
   - **Close the console** — start `record` in its own console window
     (`start cmd /c "native\bin\ssw-capture.exe record --monitor 0 --out %TEMP%\close.mp4 --fps 60"`),
     wait 10 s and close that window with its X button. `ffprobe %TEMP%\close.mp4` reads it and
     the duration is ≈ 10 s.
   - **Killed (crash safety)** — start `record --out %TEMP%\killed.mp4`, wait 10 s, then
     `taskkill /F /IM ssw-capture.exe` from another console. The file stays;
     `ffprobe -count_frames -show_entries stream=nb_read_frames %TEMP%\killed.mp4` reads it
     with ≈ 9–10 s of frames (everything up to the last complete 1 s fragment).
   - **Sign out** — start a recording in the app, then sign out of Windows. Sign back in and
     start the app: "Unfinished recordings" lists it, and recovering it gives a video that
     runs to about the moment you signed out. Repeat with a restart.
7. **Lightness** — while recording a 1440p/4K monitor at 60 fps, Task Manager shows
   ssw-capture.exe at a few % CPU and the GPU "Video Encode" engine busy; `dropped` stays 0
   while scrolling a long web page.
8. **Multi-monitor / mixed DPI** — with two monitors at different scaling (e.g. 150 % and
   100 %), record each from the app: the right monitor is recorded every time.
9. **Resolution change / unplug** — change the resolution mid-recording: recording continues
   (content scaled to the original size). Unplug the recorded monitor (or switch it to another
   input): `stopped` with `"reason":"closed"`, exit code 0 and a playable file. In the app the
   recording then stops by itself and says why, and the project holds what was recorded.
10. **In the app** — record a full screen: the editor's smooth cursor is the only cursor,
    click ripples and idle hiding work, the cursor changes to an I-beam over text. Export works.
    - **Helper killed** — while recording, end `ssw-capture.exe` in Task Manager (Details tab).
      The app stops the recording by itself and says the capture stopped (the app's `onEnded`
      handling); the project (or "Unfinished recordings") has the video up to about the kill.
    - **App killed** — while recording, end only the app's main `Screen Studio for Windows.exe`
      process in Task Manager's Details tab. `ssw-capture.exe` exits by itself within a second
      or two; on the next start, recovering the recording gives the full video up to the kill.
    - **Quit while recording** — close the main window and choose "Quit anyway". The app takes
      up to a few seconds to exit; recovering the recording on the next start gives the full
      video (the helper was stopped, not killed).
    - Run the app from a terminal: no `capture helper: Writing a plain MP4` warning appears;
      if it does, fragmented MP4 could not be set up on this machine.
11. **No helper** — rename `native\bin\ssw-capture.exe` and record: the app falls back to
    Chromium capture without errors.
12. **Window capture from the command line** — open Notepad and get its handle in PowerShell:
    `(Get-Process notepad).MainWindowHandle`. Then
    `native\bin\ssw-capture.exe record --window <handle> --out %TEMP%\win.mp4 --fps 60`.
    Expect `ready`, `started` (width/height = Notepad's size, made even), then one `window` event
    whose rectangle matches Notepad's visible frame (no invisible border: compare with a
    screenshot), before the first `cursor` event. While recording:
    - **Move** it: one `window` event per position change (none while it stands still).
    - **Resize** it larger and smaller: `window` events with the new size; the video keeps the
      initial size and shows the window scaled to fit, centred, with black bars — never stretched,
      never cropped, no garbage in the bars, no frame showing only a corner of the window.
    - **Drag a corner outward** slowly for 2-3 s: the video follows the window **live** during the
      drag (no frozen picture that jumps at the end). Task Manager shows no CPU or GPU spike while
      dragging, and `dropped` in `stopped` stays 0.
    - **Maximise** it while nothing in it changes (an idle Notepad), then wait 2 s without touching
      it: the video shows the **maximised** layout right away (not the old layout stretched or the
      old picture). Restore it: the old layout again. Repeat with a window dragged across two
      monitors so it is larger than either (the session restart path): within ~0.1 s the video
      shows the whole window.
    - **Minimise** and restore: `"minimized":true` with the previous rectangle, then
      `"minimized":false`; the video holds the last picture meanwhile (constant frame rate).
    - Move it to **another virtual desktop** and back: `"minimized":true` meanwhile.
    - **Close** it: `stopped` with `"reason":"closed"`, exit 0, a playable file.
    - `ffprobe` the file: h264, the initial size, duration ≈ recorded time. Play it: **no mouse
      cursor**, no yellow border (Windows 11).
    - `record --window 1 --out x.mp4 --fps 30` and `watch-window --window 1`: JSON error, exit 4.
13. **Desktop icons** — `native\bin\ssw-capture.exe desktop-icons status`: `{"visible":true,"changed":false}`.
    `desktop-icons hide`: the icons disappear at once, the wallpaper stays, `"changed":true`; the
    "Show desktop icons" item of the desktop's View menu is still ticked (the setting is untouched).
    `desktop-icons show`: they come back. Then: right-click the desktop › View › untick "Show
    desktop icons"; `desktop-icons hide` prints `"changed":false`, and a recording in the app
    leaves them hidden afterwards (it never shows icons it did not hide); tick the setting again. With a wallpaper slideshow running
    (Personalise › Background › Slideshow) repeat `hide`/`show` (the view lives in a `WorkerW`
    then). Restart Explorer after `hide` (Task Manager › Windows Explorer › Restart): the icons
    are back. In the app, with "Hide desktop icons" on: they disappear during the countdown and
    return when the recording stops, is discarded, when the app is closed mid-recording ("Quit
    anyway"), and — after ending the app's process in Task Manager mid-recording — at the next
    start of the app.
14. **watch-window** — `native\bin\ssw-capture.exe watch-window --window <handle>`: `ready`, then
    the rectangle; move/resize/minimise as above; `stop` Enter: `{"event":"stopped","reason":"stop"}`,
    exit 0. Closing the window instead: `"reason":"closed"`. On a 150 % monitor the numbers are
    physical pixels (1.5x what the window's DIP size suggests).
    - **Rate** — with no other app open that raises the timer resolution (close browsers and media
      players), run `native\bin\ssw-capture.exe watch-window --window <handle> > %TEMP%\w.jsonl`,
      drag the window around continuously for 3 s, type `stop` Enter. In PowerShell:
      `$at = Get-Content $env:TEMP\w.jsonl | ConvertFrom-Json | ? event -eq window | % at;
      $d = 1..($at.Count-1) | % { $at[$_] - $at[$_-1] } | sort; $d[[int]($d.Count/2)]`
      prints the median interval: ≈ 16 ms (not ≈ 31 ms). Same for `record --window` (its `window`
      events in the redirected output).
    - **cursorOver** — put another app's window (e.g. Calculator) over part of the watched window.
      Move the mouse: over the watched window `"cursorOver":true`; onto Calculator where it covers
      the watched window `false` (one event, same rectangle); back `true`; outside both `false`.
      Open one of the watched app's own dialogs (Notepad's Font dialog) and hover it: `true`
      (same root owner). Hover the watched window while that modal dialog disables it: `true`.
      An always-on-top window (Task Manager with "Always on top") over it: `false`.
15. **Window recording in the app** — record a single window with native capture (Windows 10
    2004+): the editor shows only the smooth cursor (no second, baked-in cursor), click ripples
    and auto zooms land on what was clicked, also after moving and resizing the window during the
    recording; clicks outside the window and time while it was minimised produce nothing; clicks
    on another app's window covering part of the recorded one produce no ripple or zoom, and the
    smooth cursor is hidden while over it. Repeat
    with the window on a 150 % monitor and with the window straddling two monitors. Then with a
    helper whose `probe` reports `"windowCapture":false` (or on a machine where window capture
    fails) the app records the window with Chromium plus `watch-window`: ripples and zooms still
    land correctly (the OS cursor is in the video then).
