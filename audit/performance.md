# Performance and resource-use audit

Commit audited: `b25a136` (branch `ccr-b6df7cf7-yked87`). No source file was changed; every number below
was measured with the scripts described in [How it was measured](#how-it-was-measured).

## Summary

The architecture is already light where it matters most:

- nothing is drawn while the editor is idle or paused (0.0–0.2 % CPU measured in every process);
- playback never re-renders React;
- per-frame engine maths is O(log n) even for 1-hour recordings;
- the expensive static layers are cached;
- memory stays flat over long sessions;
- export decode, draw and encode overlap.

What remains are costs that hit hard on one path: **the 2D canvas without GPU rasterisation**. Chromium
falls back to it when the GPU is blocklisted or missing (VMs, Remote Desktop, old drivers), and the
exporter forces it for raw-frame routes on such machines (`willReadFrequently`). On that path, measured in
the real built app, the editor preview manages **~34 fps for a plain project and ~17 fps with every
feature on**, against a 60 fps proxy. Most of the gap comes from a few fixable spots (F1, F3, F4, F5).
Separately, the raw-frame export route is capped by IPC copies (F2), and smart-speed analysis decodes
every frame of the proxy (F6).

| id | severity | area | measured cost | expected gain of fix |
|----|----------|------|---------------|----------------------|
| F1 | high | animated background upscaled with `imageSmoothingQuality = 'high'` | 89 ms/frame at 1080p, 295 ms at 4K (software canvas) | 9× on that draw (→ 9 / 32 ms), one-line fix |
| F2 | high | raw-frame export route: frame IPC | 40–70 ms per 1080p frame, 160–220 ms per 4K frame | 2.7× less data with I420/NV12; overlap readback |
| F3 | medium | motion blur redraws (and re-converts) the video frame per sub-frame | 4K export in zoom moves: 300–460 ms/frame vs 41 ms static (software) | 1.3–1.8× from converting once; −12–17 % draws at 4K from resolution-relative spacing |
| F4 | medium | pulled-back card repaints its large shadow blur every frame | +10 ms (1080p) / +72 ms (4K) per frame (software) | cached card layer drawn scaled: 4.6 / 19 ms |
| F5 | medium | spotlight paints a full-frame radial gradient | +13 ms (1080p) / +57–78 ms (4K) per frame (software) | 4.6× (gradient only around the lit area) |
| F6 | medium | smart-speed still detection decodes every proxy frame | 1 h of 1080p60 ≈ 12 min at 100 % of 4 cores | ~9× less CPU with `-skip_frame nokey` (60 fps proxies) |
| F7 | low | `new SmoothedTrack` on every cursor-smoothing slider step | 42–100 ms per step for a 1-hour recording | 3.8×, bit-identical (forward scan instead of a binary search per step) |
| F8 | low | renderer bundle is not minified | 919 kB vs 534 kB minified | size only: no measurable start-up gain (see "checked and fine") |

The GPU-canvas costs of F1, F3, F4 and F5 could not be measured: this container has no GPU. On a GPU
canvas the same operations are far cheaper. Their *relative* weight (extra full-frame passes, blur
passes, shader taps) still holds, and the fixes do not make the GPU path slower.

### Measured exports (real built app, software canvas, 24 s project with 3 zooms incl. a pull-back, 1440 frames)

The per-frame split is the exporter's own `export:` log line.

| export | route | wall | wait decode | draw | encode/IPC | ffmpeg peak RSS |
|--------|-------|------|-------------|------|------------|-----------------|
| plain, 1080p60 | Software (x264, raw frames over IPC) | 150 s | 0.4 ms | 53.8 ms | **49.2 ms** | 359 MB |
| plain, 1080p60 | WebCodecs (software H.264) | 85 s | 5.0 ms | 52.8 ms | 1.0 ms | 25 MB |
| everything on, 1080p60 | Software (x264) | 279 s | 0.4 ms | **151.4 ms** | 41.8 ms | 358 MB |
| plain, 4K60 | Software (x264) | 468 s | 0.8 ms | 154.3 ms | **169.0 ms** | 1190 MB |

Decoding is never the bottleneck: it runs ahead. On the raw route, half of every frame is the IPC copy
(F2); on WebCodecs it disappears. Drawing is the rest, and "everything on" triples it: F1, F3, F4 and F5
together account for most of the extra ~100 ms.

## Findings

### F1 (high): animated background upscaled with high-quality smoothing

**Where:** `src/renderer/src/render/staticLayer.ts:441-443` (`paintAnimatedBackground`)

```ts
ctx.imageSmoothingEnabled = true
ctx.imageSmoothingQuality = 'high'
ctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h)
```

**Problem.** An animated gradient is painted on a canvas of at most 480 px and stretched to the whole
frame, every frame. The picture is soft blobs, so a bilinear upscale looks the same as a bicubic one.
But a canvas source with `'high'` makes Skia's software rasteriser run a high-quality (cubic)
resampler over every output pixel.

**Measurement.** Chromium software canvas, 480×270 → full frame, mean of 8 draws including flush:

| target | `'high'` (current) | `'medium'` | `'low'` |
|--------|------------------|----------|-------|
| 1920×1080 | 89.2 ms | 49.0 ms | 9.4 ms |
| 3840×2160 | 295.4 ms | 193.9 ms | 32.0 ms |

Whole compositor frame at 1080p (harness, software canvas): plain gradient background 31 ms, animated
background 107 ms. In the real app (Xvfb, `2d_canvas: disabled_software`), the "everything on" project
(animated background + frame + glass + blur + spotlight + cursor FX + webcam) drew **135 frames in 8 s
(≈17 fps)** against 269 (≈34 fps) for a plain project.

**Effect.** On machines without GPU canvas, choosing a moving background roughly halves the preview
frame rate. It also adds ~0.26 s to every 4K export frame.

**Fix.** Use `'low'` (or leave smoothing at its default) for this draw only. Expected gain: −80 ms per
1080p frame and −263 ms per 4K frame on the software path. Visually identical: the source is already a
blur of large radial gradients. Cost on the GPU path: none.

```diff
-  ctx.imageSmoothingQuality = 'high'
+  // Soft blobs: bilinear is indistinguishable from bicubic here and ~9x cheaper without a GPU.
+  ctx.imageSmoothingQuality = 'low'
   ctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h)
```

The same reasoning applies to `drawBlurred` (`staticLayer.ts:77-81`, blurred wallpaper or image
backgrounds and the glass backdrop, upscaled 4×). That draw only runs when a cached layer is rebuilt,
not per frame, except for the glass border while pulled back (see F4).

**Refuted for the video itself.** The harness first suggested that `'high'` made every *video* draw
4–7× slower. That turned out to be an artefact of using a canvas as the stand-in source. With the real
sources there is no difference:

- `<video>` element, measured in Electron: 167 frames drawn with `'low'` vs 170 with `'high'` in 10 s;
- I420 `VideoFrame`, the exporter's source: 15.8 ms vs 14.9 ms per 1080p frame.

So the video draws in `compositor.ts:119-120` should keep `'high'`.

### F2 (high): the raw-frame export route is capped by IPC copies

**Where:**

- `src/renderer/src/render/encoders.ts:94-111` (`RawFrameSink.push`): one full RGBA frame per
  `window.api.exportFrame`;
- `src/preload/export.ts:11` (`ipcRenderer.invoke('export:frame', data)`);
- `src/main/exportIpc.ts:241-246`.

**Problem.** The ffmpeg routes (GIF, the *Software* encoder choice, and fallbacks when WebCodecs
hardware H.264 is unavailable) send 4 bytes per pixel per frame through Electron IPC: 8.3 MB at 1080p,
33 MB at 4K. Electron serialises and copies the buffer several times between the renderer and the main
process.

**Measurement.** Electron 44 on this 4-core Xeon 2.8 GHz, in-process `memcpy` of 33 MB = 7.5 ms:

| payload | `invoke` (current) | `send` + ack | `MessagePort` |
|---------|------------------|------------|-------------|
| 1080p RGBA, 8.3 MB | 38–71 ms | 40–48 ms | 43–46 ms |
| 4K RGBA, 33 MB | 216–221 ms | 162–191 ms | 195–216 ms |

That is ~27× a `memcpy`, the same for every transport. With 2 frames in flight (the current
`MAX_IN_FLIGHT`) the 1080p case reached 34 ms/frame. The cap is therefore roughly 25–30 fps at 1080p and
**~5 fps at 4K** on this machine. A desktop CPU is maybe 2–3× faster, which still means at most ~15 fps
at 4K.

The readback is also not overlapped with drawing: `push()` awaits `this.read()` (the `VideoFrame`
`copyTo`) before returning, so the next frame is not drawn during readback. Only the IPC transfer
overlaps.

In the real app this shows up as **49 ms of 103 ms per 1080p frame and 169 ms of 324 ms per 4K frame**
spent in "encode/IPC" on the x264 route. The same 1080p export through WebCodecs spends 1 ms there and
finishes in 85 s instead of 150 s. ffmpeg's resident memory peaked at 1.19 GB on the 4K raw route (vs
25 MB muxing WebCodecs chunks).

**Effect.** GIF, *Software* and fallback MP4 exports take about twice as long as their drawing needs, and
more at 4K.

**Fix (in order of gain):**

1. **Send 4:2:0 instead of RGBA.** NV12/I420 is 1.5 bytes/px, 2.67× less IPC. ffmpeg then gets
   `-pix_fmt nv12`/`yuv420p` directly and skips its own RGB→YUV conversion. Chromium's
   `VideoFrame.copyTo` cannot convert RGB→YUV, so do it on the GPU: a small WebGL2 pass rendering Y
   and UV planes, read back with `readPixels`. Do it with JS on the CPU path, where it is still cheaper
   than the extra IPC (8.3 MB→3.1 MB).
   - Expected: 4K from ~200 to ~75 ms of IPC per frame here.
   - GIF should keep RGB: its palette pass wants RGB, and GIFs are ≤1080p/15 fps anyway.
2. **Overlap readback with the next draw.** Start `read()`, return once the `VideoFrame` has been
   created (it snapshots the canvas), and await the `copyTo` in the in-flight set.
3. On machines with a GPU canvas, a hardware WebCodecs encoder is tried first, so this mostly matters
   for GIF, *Software* and fallbacks. Say so in the export dialog's ETA rather than letting users
   wonder why *Software* 4K takes minutes.

### F3 (medium): motion blur redraws and re-converts the video frame for every sub-frame

**Where:** `src/renderer/src/render/compositor.ts:121-137` and `motionSamples` (`compositor.ts:183-201`),
`blurSampleCount` (`src/shared/render/overlays.ts:177-180`), `EXPORT_BLUR_SAMPLES = 10`
(`exporter.ts:67`).

**Problem.** Motion blur averages up to 4 (preview) or 10 (export) camera positions. Each one is a
full-size scaled `drawImage` of the video frame. On the software path every `drawImage(video)` or
`drawImage(VideoFrame)` repeats the YUV→RGB conversion:

- `<video>`, 1080p, Electron: 1 draw = 14.7 ms of main-thread time, 4 blended draws = 53–56 ms;
- converting once into an RGB canvas and blending from it: ~10–11 ms.

**Measurement.**

How often it happens: auto zooms on a realistic cursor (rests of 0.5–3 s, eased moves; 10 minutes, 59
auto zooms, zoomed or moving 65 % of the time).

| output | video draws per frame (current) | with spacing scaled by `k` |
|--------|------------------------------|-------------------------|
| 1080p60 preview (max 4) | 1.80 | 1.80 |
| 1080p60 export (max 10) | 2.54 | 2.54 |
| 4K60 export (max 10) | 3.10 | 2.58 (−17 %) |
| 4K30 export (max 10) | 3.57 | 3.14 (−12 %) |

What each frame costs, software canvas, I420 `VideoFrame` source:

| case | per frame |
|------|-----------|
| 1080p, static | 15.8 ms |
| 1080p, zoom transition, 4 sub-frames | 50–84 ms |
| 4K, static | 41 ms |
| 4K, zoom transition, 10 sub-frames, current | 300–460 ms |
| 4K, zoom transition, 10 sub-frames, converted once to an RGB canvas then blended | 251 ms |

**Effect.** Zoom moves are where the preview drops frames without a GPU, and they dominate 4K export
time on that path.

**Fix.**

1. When `samples.length > 1`, draw the frame once into a reusable RGB canvas at source size and blend
   the sub-frames from that canvas. Draw them with `'low'`/`'medium'` smoothing: the averaging blurs
   anyway, and a canvas source with `'high'` is the expensive case of F1. Measured 1.3–1.8× on the
   software path. On the GPU path it trades N texture conversions for 1 plus a copy, which is neutral.
2. Make the sample spacing resolution-relative: `blurSampleCount(d, max, 2 * k)` with
   `k = min(w, h) / 1080`. 4K then gets the same angular step as 1080p. That is −17 % of video draws at
   4K60, with no visible change.

### F4 (medium): a pulled-back card repaints its shadow blur every frame

**Where:** `src/renderer/src/render/compositor.ts:108-110` → `paintCard` (`staticLayer.ts:270-286`) →
`paintShadow` (`staticLayer.ts:159-181`).

**Problem.** While the camera is pulled back (`cam.scale < 1`), the card is drawn as vectors every
frame. That includes a canvas shadow with `shadowBlur = 70·k·shadow` (glow: 110·k·shadow), plus the
glass backdrop through a clip.

A cached card layer already exists for animated backgrounds (`paintCardLayer`, `staticLayer.ts:459-488`).
Drawn scaled by `cam.scale`, it gives the same picture: everything in it shrinks uniformly, including
the blur radius (the code already passes `k * shrink`). Down-scaling a raster keeps edges crisp.

**Measurement.**

Full compositor frame, software canvas, `'low'` video:

| 4K frame | per frame |
|----------|-----------|
| flat | 31.5 ms |
| pulled back | 70.5 ms |
| pulled back, glow shadow | 83.2 ms |

The shadowed card alone vs the cached layer drawn scaled:

| | 1080p | 4K |
|-|-------|----|
| shadowed card (current) | 10.0 ms | 71.6 ms |
| cached layer drawn scaled | 4.6 ms | 19.3 ms |

Pull-back zooms last as long as the user makes them (levels 0.5–1×).

**Fix.** In `drawFrame`, when `cam.scale < 1`, draw the background layer, then the cached
`paintCardLayer` canvas with
`drawImage(layer, b.x, b.y, b.w, b.h, X(b.x), Y(b.y), b.w * s, b.h * s)`, mapping the layer's bounds
through the card transform (`card = cardRect(rect, cam)`, `s = cam.scale`). Keep the vector path only for
the glass border, whose backdrop must not scale. Expected: −5 ms per 1080p frame and −52 ms per 4K frame
on the software path, and one blur pass fewer per frame on the GPU path.

### F5 (medium): spotlight paints a full-frame radial gradient

**Where:** `src/renderer/src/render/spotlightLayer.ts:404-417` (`ellipseField` with `cover` = whole
frame), called from `drawSpotlightLayer` (`spotlightLayer.ts:338`).

**Problem.** A single spotlight fills the whole frame with a radial gradient. Outside the feathered ring
the gradient is constant, so the rasteriser evaluates the gradient for millions of pixels that all get
the same colour.

**Measurement.** Software canvas, ellipse spotlight, dim 0.6:

| | 1080p | 4K |
|-|-------|----|
| full-frame radial gradient (current) | 13.4 ms | 56.7 ms |
| gradient only inside the ellipse's outer box + solid dim elsewhere (even-odd hole) | 3.2 ms | 12.4 ms |
| solid fill only, for reference | 0.9 ms | 4.8 ms |

Whole compositor frame at 4K: flat 31.5 ms, with one cursor spotlight 109 ms.

**Fix.** In `ellipseField` with `cover`, fill `cover` minus the box `[cx ± rx·r1, cy ± ry·r1]` with the
solid unlit paint (`paint(0)`, one `rect` + `rect` + `fill('evenodd')`). Then fill only that box with the
gradient (the code already does that when `cover` is null). `rectField` already works this way. Expected:
4.6× on the spotlight cost and pixel-identical output: outside `r1` the gradient is clamped to its last
stop anyway.

### F6 (medium): smart-speed still detection decodes every frame of the proxy

**Where:** `src/main/analysisIpc.ts:31-42` (`freezeDetectArgs`), started from *Find* in the Clip panel
or the smart-speed command (`ClipPanel.tsx:209-245`).

**Problem.** `fps=10,scale=320` throws away 5 of every 6 frames, but only after ffmpeg has decoded all
of them at full resolution. The proxies are 60 fps, full recording resolution, and have a key frame
every 15 frames (`proxyArgs.ts:113`).

**Measurement.** ffmpeg-static, 20 s 1080p60 x264 proxy built with the app's own proxy arguments, 4
cores:

| | wall | CPU |
|-|------|-----|
| current arguments | 4.0 s | 13.0 s |
| with `-skip_frame nokey` before `-i` | 1.24 s | 1.44 s |

For a 1-hour 1080p60 recording that is about **12 minutes with all 4 cores busy** today. A 4K proxy
costs about 4× more.

**Effect.** The editor stays usable, but the fans spin up and everything else on the PC slows down for
minutes.

**Fix.** Pass `-skip_frame nokey` when the proxy is 60 fps. Key frames every 0.25 s sample the picture
more coarsely than `fps=10`, but the shortest idle length offered is 1 s (`MIN_IDLE_CHOICES`) and every
idle part keeps `IDLE_PAD = 0.5 s` at both ends, so boundaries 0.25 s coarser are absorbed. For 30 fps
proxies (key frames every 0.5 s = `STILL_DETECT_MIN`) keep full decoding, or lower `-g` for new 30 fps
proxies to 8. Also consider `-threads 2` so the analysis never takes every core while the user edits.

### F7 (low): the cursor path is rebuilt with a binary search per step

**Where:** `src/shared/engine/cursor.ts:26-54` (`SmoothedTrack` calls `cursorAt` → `lowerIndex` for each
of the `duration × 120` steps). It is rebuilt from `Editor.tsx:217` whenever `project.cursor.smoothing`
changes, so on every input event of the smoothing slider.

**Measurement.** Realistic cursor tracks, node 22:

| recording | current | forward scan (same output, max difference 0) |
|-----------|---------|------------------------------------------|
| 10 min | 13 ms | 4.8 ms |
| 60 min | 42 ms warm (100 ms cold) | 11 ms |

**Effect.** The smoothing slider stutters on hour-long recordings. Short recordings are unaffected.

**Fix.** Walk the sample index forward (the step times increase monotonically):

```ts
let j = 0
for (let i = 0; i < n; i++) {
  const t = i * dt
  while (j + 1 < samples.length && samples[j + 1].t <= t) j++
  // interpolate samples[j], samples[j + 1] exactly like cursorAt
}
```

Optionally also defer the rebuild with `useDeferredValue(project.cursor.smoothing)`.

### F8 (low): the renderer bundle is not minified

`out/renderer/assets/index-*.js` is 919 kB and unminified (electron-vite leaves `build.minify` off for
the renderer). An esbuild-minified build of the same entry is 534 kB.

Measured load cost of the built bundle in Chromium (median of 7, stubbed `window.api`):

| page | script time | JS heap |
|------|-------------|---------|
| Home | 33 ms | 2.6 MB |
| toolbar window | 19 ms | 2.1 MB |
| toolbar-only bundle (Toolbar.tsx alone) | 17 ms | 1.6 MB |

Minifying did not reduce script time measurably, and code-splitting the toolbar or region windows away
from the editor would save ~2 ms and ~0.5 MB. Worth flipping `renderer.build.minify: true` for the
download size; not a start-up problem.

## Checked and fine

- **Idle and paused editor.** `PreviewPlayer.invalidate` coalesces to one draw per change; nothing is
  drawn while paused. Measured 0.0–0.2 % CPU in every process with the editor open (plain and
  everything-on projects), and on Home after start-up.
- **React during playback.** The player notifies subscribers per frame, but the transport time and
  timeline playhead write to the DOM directly (`Transport.tsx:36-47`, `Timeline.tsx:181-201`).
  `useStageView`, `AnnotationHandle` and the shapes panel only set state when a value changes.
  `Timeline`, `PreviewStage`, `Transport` and `Inspector` are `memo`ised, and only the active inspector
  tab renders. During drags each `store.update` re-renders the editor once, and the redraw is coalesced
  to one rAF.
- **Per-frame engine maths.** Camera plan cached per zoom list (`planFor`), binary searches for zooms,
  cursor opacity (precomputed last-move times), keystrokes. Measured on a 60-minute track (41 k samples,
  1 k clicks): `cursorOpacity` 2.7 µs, `clickPulse` 2.5 µs (linear over clicks, still negligible),
  `keystrokesAt` 0.9 µs. The static-layer cache key (`JSON.stringify`) is 2.5 µs per frame.
- **Cached layers.** The background, card and shadow are cached per target canvas (`WeakMap<ctx>`), and
  only the bands around the recording are copied. Watermark stamps, cursor images and logos are
  downscaled once. Privacy-blur scratch canvases only grow and are reused. Blurred backgrounds are
  blurred at ¼ size, once. Measured costs per 1080p frame (software): privacy blur +4 ms, pixelate
  +4 ms, cursor with trail, tilt and highlight +0–1 ms, webcam bubble +1–2 ms (its shadow 0.9 ms; 3.8 ms
  at 4K), watermark +0 ms, keystrokes and annotation +1–4 ms.
- **Memory over long sessions.** Real app, 60 s 1080p project:
  - renderer JS heap 10.6 MB after GC, both after playing and after 6 open/play/close cycles;
  - process working set plateaus at ~830 MB.

  The jump from ~295 MB to ~800 MB at first playback is Chromium's software video-to-canvas path. A bare
  page that only draws a `<video>` into a canvas shows the same +600 MB, with any smoothing quality, and
  not when nothing is drawn. Bounded queues: decoder `MAX_READY = 3`, `MAX_QUEUE = 6`; range reader 2
  blocks of 4 MB; undo history 200 structurally shared snapshots; audio levels 4 bytes per 50 ms
  (288 kB/h); smoothed paths 3.5 MB/h. Listeners are removed in `PreviewPlayer.dispose`.
- **Preview audio.** Curves, activity and loudness are memoised by key. `frame()` only nudges element
  rates, and automation is rescheduled only on drift or horizon. Click sounds create their
  `AudioContext` on first use and suspend it on pause.
- **Recording overhead.**
  - Cursor polling: 60 Hz `getCursorScreenPoint`, positions stored only on movement.
  - uiohook mouse moves: thinned to one per 8 ms when not polling.
  - Chunk pipe: one chunk in flight.
  - Main window: hidden while recording; the mic meter and camera preview only run while Home is idle
    and visible.
  - Toolbar timer: re-renders once per second.
  - Encoders: hardware H.264 preferred, native capture encodes on the GPU.
- **Export pipeline structure.**
  - WebCodecs hardware H.264 is tried first.
  - Decoding runs ahead (ranged 4 MB block reads with prefetch, not per-frame fetches).
  - The encoder queue (≤2) and chunk sends overlap with drawing.
  - Frames are closed promptly; ffmpeg muxes only.
- **Start-up.** Built app under Xvfb: first DOM in 545–632 ms, Home usable in 730–908 ms (4 runs), idle
  CPU ≈ 0. The main bundle (260 kB) and preload (5 kB) are small.
- **Saving.** `project.json` (no cursor data) is written synchronously but small, without fsync, debounced
  400 ms (max 2 s).

## Rules for the wave-3 features

The current compositor keeps per-frame work proportional to what is visible. New layers must keep it
that way.

1. **Nothing that changes per frame in a cache key.** `sceneContentRect` is about to depend on `t`
   (camera layouts). The static layer's key contains `spec.rect` (`staticLayer.ts:369`), so an animated
   layout transition would rebuild the background, shadow and border **every frame**: a full repaint plus
   a 70·k px blur. Key the background on style and size only, and draw the card through the cached card
   layer at the animated rect (as in F4), rebuilding only once the layout settles.
2. **Webcam background blur (WASM segmentation).**
   - Segment at low resolution (≤256×144), in a Worker, once per *camera* frame (30 fps), not per output
     frame. The export reuses each camera frame for two 60 fps output frames, so cache the mask by
     camera frame index.
   - Never run `ctx.filter = 'blur()'` on a full-size camera frame per frame. Blur a ¼-size copy (like
     `blurredPicture`) and composite through the mask.
   - While paused, keep the last mask: the preview must stay at 0 % CPU when idle.
   - Load the model and WASM lazily, only when blur > 0, so the start-up bundle does not grow.
3. **3D tilt (WebGL).**
   - One WebGL context per target canvas, created once and reused (like the `WeakMap<ctx>` caches).
   - Upload the frame once per output frame (`texImage2D(video)`).
   - Never `readPixels`/`getImageData` back into the 2D canvas: `drawImage(glCanvas)` instead.
   - When `getGPUFeatureStatus().webgl` is not enabled, WebGL runs on SwiftShader and is very slow. Fall
     back to a 2D approximation (affine skew) or disable tilt with a notice; this container's measured
     GPU status is the case to test.
   - With `animate: 'none'` and an unchanged scene, the transform matrix is constant: cache it.
4. **Title cards.**
   - Render the text, pill and shadow once into a cached canvas keyed by text, style and size; per frame
     only `drawImage` with `globalAlpha` (as `watermarkLayer` does).
   - The `'blur'` background must blur a ¼-size copy of the frame, not apply `ctx.filter` to the full
     frame.
   - Use `'low'` smoothing when upscaling that copy (F1).
5. **Chapters.** Timeline and export metadata only: no per-frame compositor work, and no per-frame React
   state (subscribe to the player and write the DOM, as `Transport` does).
6. **General.**
   - Every layer returns before allocating when nothing of it is active at `t`.
   - No canvas creation per frame.
   - Shadows on large or static shapes go into cached sprites.
   - Upscales of soft content use `'low'`.
   - Per-frame JS stays O(log n) in the recording length.
   - Measure each new layer on the software canvas with the harness below. Target: ≤ +5 ms per 1080p
     frame on the software path, and zero cost when the feature is off.

## How it was measured

All scripts are outside the repository (session scratchpad); they import the repository's sources
unchanged.

- **Compositor harness.** `drawFrame` from `src/renderer/src/render/compositor.ts` bundled with esbuild
  and run in Playwright's Chromium (software canvas), with a synthetic 60 s project and a
  random-walk/realistic cursor.
  - Features are toggled one at a time and in combination, in five phases: no zoom, zoom transition,
    steady zoom, pulled back, pull-back transition.
  - Times include a 1-pixel `getImageData` to force rasterisation.
  - Sources: a detailed RGB canvas and, for the corrected video numbers, an I420 `VideoFrame`.
  - Draw-call and shadow counters were recorded by wrapping `CanvasRenderingContext2D` methods.
- **Engine maths.** Node 22, esbuild bundles of `src/shared/**`, tracks up to 60 minutes.
- **Real app.** `npm run build`, Electron 44 under `xvfb-run`, projects seeded with the e2e fixtures
  (`tests/e2e/editor-fixtures.cjs`). Measured: CPU and working set from `app.getAppMetrics()`;
  playback with `requestVideoFrameCallback` counts and `getVideoPlaybackQuality()`; memory over
  open/play/close cycles; export per-frame timings from the exporter's own `export:` console line.
  GPU status in this environment: `2d_canvas: disabled_software`, `video_decode` and `video_encode`
  software.
- **IPC.** A minimal Electron app sending 8.3 MB and 33 MB `Uint8Array`s with `invoke`, `send` and
  `MessagePort`.
- **ffmpeg.** `node_modules/ffmpeg-static`, the app's proxy and freeze-detect arguments on a 20 s
  1080p60 test video.

Machine: 4-core Intel Xeon 2.8 GHz container, no GPU. Absolute numbers on a desktop will be lower; the
ratios between current code and proposed fixes are what the findings rely on.
