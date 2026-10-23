# Screen Studio for Windows

A Windows screen recorder inspired by [Screen Studio](https://screen.studio/) for macOS:
record your screen, and get a polished video with **automatic zoom on clicks**, a
**smooth cursor**, beautiful **backgrounds**, a **webcam bubble** and one-click **MP4 / GIF export**.

Built with Electron, React, TypeScript and ffmpeg.

- [Research](docs/RESEARCH.md): what Screen Studio does and how others approached it
- [Feature list](docs/FEATURES.md): what's in v1 and what's on the roadmap
- [Implementation](docs/IMPLEMENTATION.md): architecture and design decisions
- [Building](docs/BUILDING.md): toolchain, installer, icon and code signing

## Features (v1)

| | |
| --- | --- |
| **Record** | Any screen or window · microphone · system audio (Windows loopback) · webcam · 3-2-1 countdown · floating control bar with pause/resume/discard · `Ctrl+Shift+2` to stop |
| **Motion** | Auto zoom generated from your clicks · camera follows the cursor with spring smoothing · smooth, resizable cursor · click ripples · hide cursor when idle |
| **Edit** | Live preview · timeline with trim and draggable/resizable zoom segments · per-zoom level and focus · gradient / colour / image backgrounds · padding, rounded corners, shadow · webcam position, size, shape · aspect ratios (Auto, 16:9, 9:16, 1:1, 4:3) · auto-save |
| **Export** | MP4 (H.264/AAC) 720p → 4K at 30/60 fps, three quality presets · palette-optimised GIF |

## Getting started

Requirements: Windows 10 (2004+) or 11 to run the app; Node.js **20.19+ or 22.12+** to build it
(Vite 7 and electron-vite 5 need it; see `engines` in `package.json`).

```bash
npm install
npm run dev        # run the app with hot reload
npm test           # unit tests
npm run typecheck
npm run dist:win   # build the Windows installer: dist/ScreenStudio-Setup-<version>.exe
```

### Building the installer

`npm run dist:win` works on Windows, Linux and macOS (Linux/macOS need Wine, 64- and 32-bit). It
checks its inputs first and fetches the Windows `ffmpeg.exe` itself when cross-building, so there
is no manual pre-step; if ffmpeg cannot be fetched the build stops with an error instead of
producing an installer that cannot record. It also builds and bundles the native capture helper
when a Rust toolchain is available (optional), then verifies the package: only the compiled app and
its runtime dependencies in `app.asar`, the app icon in the exe and installer, and only the
English Chromium locale. See [docs/BUILDING.md](docs/BUILDING.md) for details and sizes.

### Code signing

The installer is unsigned until you add a certificate, so Windows SmartScreen warns on first launch
("More info" → "Run anyway"). Signing switches on automatically when the environment (or a
git-ignored `electron-builder.env`) provides one of:

- a `.pfx` file: `CSC_LINK` + `CSC_KEY_PASSWORD`;
- a certificate in the Windows store (USB token / EV): `WIN_SIGN_CERT_SHA1` or `WIN_SIGN_CERT_SUBJECT`;
- Azure Trusted Signing: `AZURE_TRUSTED_SIGNING_ENDPOINT`, `_ACCOUNT`, `_PROFILE`, `_PUBLISHER`
  plus Microsoft Entra credentials (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`).

Set `SSW_REQUIRE_SIGNING=1` for release builds so an unsigned build fails. Full instructions:
[docs/BUILDING.md](docs/BUILDING.md#code-signing).

Recordings are stored in `Videos\Screen Studio for Windows\<recording>` as
`project.json`, `cursor.json` and H.264 proxies of the screen and camera.

### Editor shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `Z` | Add a zoom at the playhead |
| `Delete` | Delete the selected zoom |
| `←` / `→` | Step one frame (hold `Shift` for one second) |
| Double-click zoom track | Add a zoom there |

## How it works (short version)

1. The main process captures the chosen source through Electron's display-media handler
   (with `loopback` system audio) while sampling the cursor at 60 Hz and listening for clicks
   via the optional `uiohook-napi` hook.
2. After recording, ffmpeg turns the MediaRecorder WebM into a 60 fps short-GOP H.264 proxy so
   the editor can seek frame-accurately; auto zoom segments are generated from click clusters.
3. A single canvas compositor — a pure function of time — draws background, rounded/shadowed
   recording, zoom camera, smoothed cursor, click ripples and webcam. The preview and the
   exporter both use it, so what you see is exactly what you export.
4. Export renders each frame offscreen and streams raw RGBA into ffmpeg (`libx264` + trimmed
   audio, or a palette-based GIF).

## Known limitations

- Hiding the OS cursor depends on Chromium honouring `cursor: 'never'`. When it doesn't, the
  Windows cursor is baked into the video and the smooth cursor starts **off** (you can still turn it
  on; auto zoom works either way). A native Windows Graphics Capture helper is on the roadmap.
- Cursor tracking and auto zoom need a full-screen recording; window recordings keep the
  original cursor and use manual zooms.
- Click detection needs the optional native module `uiohook-napi`; without it, add zooms manually.
- Verified end-to-end (record → edit → MP4/GIF export) on Linux/X11 under Xvfb; the
  Windows-specific paths (loopback audio, hiding the control bar from the capture, mouse hook)
  rely on Electron/uiohook Windows support and still need a run on a real Windows machine.
