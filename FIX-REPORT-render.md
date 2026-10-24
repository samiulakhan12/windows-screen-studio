# Fix report: render / performance audit findings

Branch `fix-audit-render`, based on `f3db4cb`. Findings from `audit/render-export.md` (RE-3) and
`audit/performance.md` (F1, F3, F4, F5, F7, F8). I re-checked each one against `f3db4cb` before fixing
it, and all of them still applied there. The 3D tilt (`tiltLayer.ts`) and the title cards are still
in `drawFrame` and keep working (tilt and titles e2e pass).

| id | status | change | proving test |
|----|--------|--------|--------------|
| RE-3 | fixed | `shapesLayer.ts` `drawPrivacyLayer`: a privacy shape is active from half a source frame (+1 ms) before its start until half a frame after its end. The frame rate comes from `capture.fps`, which defaults to 60 for old projects. | `tests/privacyTiming.test.ts`, `tests/e2e/audit-render.e2e.cjs` |
| F1 | fixed | `staticLayer.ts` `paintAnimatedBackground`: the small gradient is upscaled with `'low'` (bilinear) instead of `'high'`. | `tests/renderCost.test.ts` (F1) |
| F3 | fixed (part 1) | `compositor.ts`: with more than one motion-blur sub-frame, the video frame is drawn once into a reused per-target canvas (`rgbCopy`). The sub-frames are blended from that canvas with `'low'`. Still frames keep drawing the video directly with `'high'`. | `tests/renderCost.test.ts` (F3) |
| F4 | fixed (different approach) | `staticLayer.ts` `paintStillCard`, called from `drawFrame` (flat and tilted): while the card moves (zoom transition) it is painted as vectors as before. Once the same pulled-back card comes twice in a row, it is drawn from the cached card layer (`paintCardLayer`, whole extent). | `tests/renderCost.test.ts` (F4) |
| F5 | fixed | `spotlightLayer.ts` `ellipseField`: with a cover rectangle, the radial gradient fills only the whole-pixel box around the ellipse's soft edge. The rest is filled with the solid unlit colour in four rectangles that meet without seams. | `tests/renderCost.test.ts` (F5) |
| F7 | fixed | `cursor.ts` `SmoothedTrack`: walks the samples forward instead of calling `cursorAt` (a binary search) for every step. The interpolation is the same, so the output is bit-identical. | `tests/smoothedTrack.test.ts` |
| F8 | fixed | `electron.vite.config.ts`: `renderer.build.minify: true`. | `tests/rendererBuild.test.ts` |

I checked that each test fails without its fix by stashing the fix and re-running the test:
- the four `renderCost` tests fail without the renderer changes;
- the `privacyTiming` tests fail without the `shapesLayer` change;
- the forward-pass test fails without the `cursor.ts` change (1,016,562 sample reads against a limit of 458,328);
- the minify test fails without the config change;
- the e2e fails on a build without the RE-3 fix.

## Details

**RE-3.** Reproduced as the audit describes: 60 fps proxy, clip starting at 0.995 s, blur starting at
2.000 s. Output frame 60 samples t = 1.995 s and both export frame sources show proxy frame 120. The
fix uses the audit's conservative variant: cover ±(half a frame + 1 ms), so coverage holds whichever
neighbouring frame the export (nearest frame) or the preview (frame containing t) shows. The 1 ms
absorbs timestamp rounding (`frameIndexAt` has a 1e-6 tolerance, and the decoder uses the measured
frame duration). Over-covering is the safe direction for a privacy tool.
- Unit test: uses the real `exportFrameTimes`, `planFeed` and `frameIndexAt` to find the output frame
  that shows proxy frame 120, then draws it. It also checks that frames well before or after the shape
  stay uncovered, and that the margin follows `capture.fps` (30 vs 60).
- e2e: exports the frame-indexed test video with this edit and reads the frame codes from the MP4.

  | build | source frame 119 | source frame 120 | source frame 121 |
  |-------|------------------|------------------|------------------|
  | before the fix | 4.18 | **4.71 (not pixelated)** | 0.25 |
  | after the fix | 4.09 | **0.20** | 0.24 |

  The numbers are the mean spread inside the mosaic cells; a pixelated frame is near 0.

**F3, scope.** Only part 1 is done (convert once). Part 2 (sample spacing relative to the resolution)
would change the number of sub-frames at 4K and so change the exported pixels. I left it out to keep
the output identical.

**F4, why not the audit's approach.** I tried the audit's approach first: draw the full-size cached card
layer scaled by `cam.scale`. The anti-aliased card edge then differs by up to 62–118/255 along a 1-px
outline, and with `'medium'` smoothing it was not faster here. So I kept the exact vector rendering
and cached it only while the pull-back holds still, which is most of a pull-back:
- pulled-back zooms with a fixed point or following the cursor stay centred, so the card is static;
- the zoom transitions are unchanged (vector path, plus one key string per frame);
- a glass border works too, because its backdrop is not scaled.

## Measurements

**Method.** `drawFrame` from the old tree (`f3db4cb`) and the new tree, both bundled with esbuild and
run in the same page of Playwright's Chromium on a software canvas (`willReadFrequently`). The source
is a detailed 1920×1080 I420 `VideoFrame`, the exporter's source type. Each value is the median of 20
frames; before and after runs alternate, and every frame ends with a 1-px `getImageData` to force
rasterisation. Pixel comparisons use the whole final frame, before vs after. The machine is a 4-core
container with no GPU, so absolute numbers are noisy, but the ratios are what matters. The harness
scripts were in the session scratchpad and are not committed.

| scenario | 1080p before → after (ms) | 4K before → after (ms) | max pixel diff | changed bytes |
|----------|---------------------------|------------------------|----------------|---------------|
| plain (no feature, control) | 11.0 → 10.8 | 31.1 → 30.1 | 0 | 0 % |
| F1 animated background | 33.9 → 20.6 | 103.7 → 56.7 | 1/255 | 9 % (±1 LSB) |
| F3 zoom move, export blur (10 samples) | 111.8 → 57.5 | 266.8 → 211.2 | 0 (1080p), 3/255 (4K) | 0 %, 0.013 % |
| F3 zoom move, preview blur (4 samples) | 45.9 → 28.0 | 111.3 → 89.2 | 0 | 0 % |
| F4 pulled back, soft shadow | 14.7 → 10.0 | 54.9 → 25.9 | 3/255 | 0.08 %, 0.007 % |
| F4 pulled back, glow shadow | 16.2 → 10.9 | 58.7 → 26.4 | 2/255 | 0.035 %, 0.003 % |
| F4 pulled back, browser frame | 14.8 → 10.4 | 51.5 → 24.4 | 8/255 (title text anti-aliasing) | 0.29 %, 0.56 % |
| F5 spotlight ellipse | 18.3 → 13.6 | 58.7 → 38.1 | 1/255 | 9 % (±1 LSB) |
| F5 spotlight at the frame edge | 19.7 → 14.3 | 58.1 → 36.9 | 1/255 | 7.5 % (±1 LSB) |
| everything (animated bg, pull-back with motion blur, glow, spotlight) | 87.6 → 39.2 | 327.8 → 157.5 | 4/255 | 19 % (PSNR 55 dB) |

What the pixel differences are:
- F1 and F5: rounding differences of 1 LSB (bilinear vs cubic on soft blobs; Skia's clamped gradient vs a
  solid fill of the same colour).
- F4: the cached layer is composited from a transparent canvas, so the soft shadow edge and the
  browser-frame title text round slightly differently.
- F3: at 1080p the blended sub-frames are bit-identical to the old video draws.

None of these is visible.

**F7.** `new SmoothedTrack` on realistic tracks (rests and eased moves at 60 Hz), Node, median of 9
runs. Output is bit-identical (max difference 0).

| track | before | after |
|-------|--------|-------|
| 10 min (9,383 samples) | 4.9 ms | 5.0 ms |
| 60 min (55,284 samples) | 27.0 ms | 17.4 ms |

**F8.** `out/renderer/assets`:

| file | before | after |
|------|--------|-------|
| JS | 1,023.0 kB | 586.8 kB |
| CSS | 77.8 kB | 58.1 kB |

As the audit says, this is a download-size gain, not a start-up one.

## Verification

- `npm run typecheck`: pass.
- `npx vitest run`: 86 files, 1205 tests, all pass (including the 4 new files).
- `npm run build`: pass.
- e2e under `xvfb-run -a -s "-screen 0 1920x1080x24"`, one file at a time, with openbox installed:

  | file | result |
  |------|--------|
  | `audit-render.e2e.cjs` (new) | 1/1 PASS |
  | `render.e2e.cjs` | 3/3 PASS |
  | `zoom.e2e.cjs` | 3/3 PASS |
  | `shapes.e2e.cjs` | 6/6 PASS |
  | `style-pack.e2e.cjs` | 7/7 PASS |
  | `tilt.e2e.cjs` | 6/6 PASS |
  | `titles.e2e.cjs` | 6/6 PASS |
  | `export.e2e.cjs` | 10/10 PASS (see below) |

- About `export.e2e.cjs`: in the first complete run, 9/10 passed. The failure was "GIF intermediates
  removed": `/tmp` held `screen-studio-gif-18783-…mkv`, written at 18:52 by an earlier run of this same
  file. A background time limit killed that run (and its app) mid-export; the dead pid 18783 was its
  app, not part of the checked run. After removing that leftover, the GIF test passed on its own
  (`SSW_E2E_ONLY="60 s GIF"`). The other 9 tests passed in the full run.

## Merge notes

- Files touched:
  - `render/compositor.ts`
  - `render/staticLayer.ts`
  - `render/spotlightLayer.ts`
  - `render/shapesLayer.ts`
  - `shared/engine/cursor.ts`
  - `electron.vite.config.ts`
  - new tests only
- None of the camera-layout / webcam files are touched.
- The F4 cache keys on the card spec of each frame, so an animated layout transition (once
  `sceneContentRect` depends on t) falls back to the vector path while it moves. It is not cached
  wrongly.
