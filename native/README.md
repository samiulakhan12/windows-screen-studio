# ssw-capture — native Windows capture helper

A small Rust program (≈430 KB) that records one monitor with **Windows.Graphics.Capture
with the mouse cursor excluded** and encodes it to **H.264 MP4 with Media Foundation**,
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
platform-independent logic (CLI, protocol, frame pacing, sizing, cursor shapes, interrupt
handling) run anywhere: `cargo test --manifest-path native/Cargo.toml`.

## Command line

```
ssw-capture probe
ssw-capture list
ssw-capture record --monitor <device name | index> --out <file.mp4> --fps <30|60> [--bitrate <bps>]
ssw-capture selftest --out <file.mp4> [--fps <30|60>] [--seconds <1-60>]
ssw-capture --version
```

| Exit code | Meaning |
| --- | --- |
| 0 | Success (`probe`: capture without the cursor is supported) |
| 1 | Runtime error (device, capture or encoder failure) |
| 2 | Invalid arguments (including a missing output folder) |
| 3 | Unsupported on this system |
| 4 | Monitor not found |

Human-readable diagnostics go to stderr; stdout carries only JSON.

### `probe`

```json
{"supported":true,"cursorToggle":true,"borderToggle":true,"capture":true,"minUpdateInterval":false,
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
| `{"event":"stopped","frames":N,"dropped":D,"duration":S,"reason":"stop"}` | The MP4 is finalised; `reason` is `stop`, `eof` (stdin/stdout closed), `closed` (monitor disconnected or the capture was revoked), `interrupt` (Ctrl+C or the console closed) or `shutdown` (sign-out, shutdown, restart) |
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
  Separate threads read stdin and poll the cursor shape.
- `pacer.rs` owns the timeline (slots, pauses, stop, catch-up); it is pure and unit-tested.
- The Direct3D device is created on the GPU that drives the recorded monitor, so frames never
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

- `cargo test`: CLI, protocol/JSON, frame pacing (static screen, pauses, late wake-ups,
  stop), output sizing and bitrate, cursor-shape table, and the built binary's exit codes.
- Cross-compiles for `x86_64-pc-windows-gnu` with no `cargo clippy -D warnings` findings.
- Under wine 9: `probe` exits 3 with JSON (wine has no Windows.Graphics.Capture), `list`
  returns the monitors, `record` fails cleanly with exit 3. `selftest` creates the Direct3D 11
  device, the DXGI device manager and the sink writer with all media types, then walks the
  whole encoder fallback chain (wine has no H.264 encoder) and fails cleanly without leaving
  files behind. Nothing crashes or hangs. (This run found and fixed a real bug: a failed
  attempt kept its file locked, so every later fallback failed with a sharing violation.)
  Wine has no fragmented MP4 sink (`Creating the MP4 writer failed: Invalid parameter`), so
  `selftest` there also exercises the fallback to a plain MP4.
- `tests/nativeCapture.test.ts` and `tests/e2e/native.e2e.cjs` drive the Electron client
  against a protocol-compatible fake helper and against the real exe under wine: `onEnded`
  for a closed capture, a fatal error and a crash; graceful stop when the app quits (the e2e
  quits the real Electron app mid-recording); the detached spawn on Windows. The fake writes
  fragmented MP4 like the helper, so the app's processing runs on fMP4 in the e2e tests.
- `tests/nativeCrashSafe.test.ts`: the app's `processRecording` builds a project from a
  fragmented MP4 cut off mid-fragment (what a killed helper leaves), and fails on a plain MP4
  cut off the same way ("moov atom not found").

**Not verified: actual capture and encoding, which need Windows 10 2004+ or Windows 11.**
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
