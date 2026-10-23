# How it is implemented

## Stack
Electron (main + preload + renderer) · React · TypeScript · electron-vite · Vitest ·
ffmpeg (`ffmpeg-static`) · `uiohook-napi` (optional, global mouse hook) · electron-builder (NSIS installer).

## Process layout
```
src/main/        Electron main process
  index.ts         windows (home/editor, floating recording bar), IPC, global shortcut
  capture.ts       desktopCapturer sources + display-media handler (video + loopback audio)
  cursorTracker.ts 60 Hz cursor polling + click hook, pause-aware timestamps
  projects.ts      project folders in Videos/Screen Studio for Windows
  ffmpeg.ts        WebM -> seekable H.264 proxy, export encoder (raw frames on stdin)
src/preload/     contextBridge `window.api` (typed in src/shared/api.ts)
src/shared/      pure, unit-tested logic shared by renderer and tests
  types.ts         Project / cursor / zoom / style types
  engine/          spring smoothing, auto zoom, camera, layout, time helpers
src/renderer/    React UI
  views/Home       source picker, devices, record button, project library
  views/Toolbar    floating recording bar
  views/Editor     preview, timeline, inspector, export dialog
  render/          canvas compositor (background, frame, camera, cursor, webcam)
  recorder/        MediaRecorder orchestration
```

## Data flow
1. **Record** – renderer asks main for sources; main installs a display-media handler for the
   chosen source (`audio: 'loopback'` for system audio). Renderer mixes mic + system audio with
   WebAudio, records screen and webcam with `MediaRecorder`. Main simultaneously samples the
   cursor (and clicks) with timestamps relative to the recording start, excluding paused time.
2. **Finalize** – main writes the WebM files, then ffmpeg converts them into constant 60 fps H.264
   proxies with a short GOP (`-g 15`) so `<video>` seeking is fast and frame-accurate. (The explicit
   rate matters: WebM's 1 ms timebase otherwise makes ffmpeg emit 1000 fps.) Auto zoom segments are
   generated from the click data and stored in `project.json`.
3. **Edit** – the compositor is a pure function of `(time, project, videos)`:
   * cursor track → spring-smoothed path (pre-computed at 120 Hz, deterministic, seek-safe);
   * camera → for each zoom segment an eased in/out envelope; focus follows a second, heavier
     smoothed cursor path and is clamped so the zoomed view never leaves the frame;
   * layout → output size from aspect ratio, content rect from padding, rounded clip + shadow.
4. **Export** – renderer seeks each frame, draws it to an offscreen canvas at output resolution
   and streams raw RGBA frames to main, which pipes them into ffmpeg (`libx264` + audio from the
   proxy, trimmed) or a palette-based GIF filter graph.

## Why these choices
* Determinism over real-time physics: every visual is a function of time, so preview, scrubbing
  and export always agree.
* ffmpeg once after recording fixes MediaRecorder's unseekable WebM and gives a robust encoder.
* Native code is optional: without `uiohook-napi` the app still records; auto zoom then needs
  manual segments.

## Testing
* Vitest unit tests for the engine (smoothing, auto zoom, camera clamping, layout, time mapping)
  and the ffmpeg argument builders.
* `npm run typecheck` for main/preload/renderer.
* End-to-end: the built app was driven with Playwright under Xvfb (record a screen → stop from the
  floating bar → add a zoom and change background → export MP4 and GIF), and the outputs were
  checked with ffprobe and by inspecting frames.
