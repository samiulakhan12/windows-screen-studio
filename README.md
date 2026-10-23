# Screen Studio for Windows

A Windows screen recorder inspired by [Screen Studio](https://screen.studio/) for macOS:
record your screen, and get a polished video with **automatic zoom on clicks**, a
**smooth cursor**, beautiful **backgrounds**, a **webcam bubble** and one-click **MP4 / GIF export**.

Built with Electron, React, TypeScript and ffmpeg.

- [Research](docs/RESEARCH.md): what Screen Studio does and how others approached it
- [Feature list](docs/FEATURES.md): what's in v1 and what's on the roadmap
- [Implementation](docs/IMPLEMENTATION.md): architecture and design decisions

## Features (v1)

| | |
| --- | --- |
| **Record** | Any screen or window · microphone · system audio (Windows loopback) · webcam · 3-2-1 countdown · floating control bar with pause/resume/discard · `Ctrl+Shift+2` to stop |
| **Motion** | Auto zoom generated from your clicks · camera follows the cursor with spring smoothing · smooth, resizable cursor · click ripples · hide cursor when idle |
| **Edit** | Live preview · timeline with trim and draggable/resizable zoom segments · per-zoom level and focus · gradient / colour / image backgrounds · padding, rounded corners, shadow · webcam position, size, shape · aspect ratios (Auto, 16:9, 9:16, 1:1, 4:3) · auto-save |
| **Export** | MP4 (H.264/AAC) 720p → 4K at 30/60 fps, three quality presets · palette-optimised GIF |

## Getting started

Requirements: Windows 10 (2004+) or 11, Node.js 20+.

```bash
npm install
npm run dev        # run the app with hot reload
npm test           # unit tests for the motion engine and ffmpeg pipeline
npm run typecheck
npm run dist:win   # build an NSIS installer into dist/ (run on Windows)
```

### Building the installer from Linux/macOS

`npm run dist:win` works natively on Windows. To cross-build, install Wine (64- and 32-bit) and
fetch the Windows ffmpeg binary first:

```bash
(cd node_modules/ffmpeg-static && npm_config_platform=win32 npm_config_arch=x64 node install.js)
npm run dist:win   # -> dist/ScreenStudio-Setup-<version>.exe
```

The installer is not code-signed yet, so Windows SmartScreen will warn on first launch
("More info" → "Run anyway").

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
