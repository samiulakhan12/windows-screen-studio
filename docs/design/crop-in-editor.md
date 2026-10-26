# Crop the recording in the editor (E-10)

Part of Wave 6, "Easier editing". The shared rules for this wave (file ownership, the shared files, merge order and the keymap) are in [editing-wins.md](editing-wins.md).

Status: design (reviewed). Roadmap item: `docs/ROADMAP.md` E-10 (listed as S–M; this design is closer to M, see the phasing in [Risks](#11-risks)). Checked against branch `feat-w6-editing-wins`.

## 1. What the user gets

- **Style › Frame** gets a **Crop recording…** row (`C`). It opens a crop tool on the preview. The tool shows the whole recording with no zoom, no tilt and no camera, and a rectangle you can drag. The rectangle has 8 handles and aspect locks (Free, Original, 16:9, 4:3, 1:1, 9:16). The bar also has **Hide taskbar**, **Hide browser bar**, **Reset**, **Cancel** (Esc) and **Done** (Enter).
- The crop applies to the whole edit: preview, scrubbing, every export format, the export dialog's **Save thumbnail** PNG, and the camera director's measurements. Zooms, the cursor, click effects, shapes, blur, pixelate and spotlights stay on their content. Nothing is re-encoded.
- With the **Auto** aspect, the output follows the cropped shape. The export dialog's "upscaled" warning compares against the cropped size. The crop tool warns when the area is small.
- Clicks in the hidden part are treated like clicks outside the video: no cursor, no ripple, no click sound and no auto zoom. When you apply a crop, automatic zooms made for those clicks are removed in the same undo step. When you widen the crop again, they come back.
- Applying is one undo step. Projects without a crop open, preview and export exactly as before.

---

## 2. Decisions

| # | Topic | Decision | Why |
|---|-------|----------|-----|
| 1 | Where the crop lives | `Project.crop?: NormRect`, top level, right after `capture`. **Not** `StyleSettings.crop`. **Not** a rewrite of `CaptureInfo.region`. | `applyPreset` (`stylePresets.ts`), `lookOf` and `applyStyleDefaults` (`styleDefaults.ts`) copy `project.style`. A crop stored there would carry one recording's rectangle to other recordings. `capture.region` records what was captured and is already baked into `screen.mp4` (`src/main/proxyArgs.ts` `cropFilter`). |
| 2 | How it is applied | As a source rectangle each time a frame is drawn. The proxy is never re-encoded. | Re-encoding is slow, cannot be undone, doubles disk use, and loses pixels that a later, wider crop would need. |
| 3 | Coordinate model | **(a) Stored positions stay relative to the FULL recorded frame.** Rendering and measuring happen in *view space* (relative to the crop) through one memoised entry point, `cropView(project, track)` in a new `src/shared/engine/crop.ts`. The scene is built from that view, so `drawFrame`, `cameraAt`, `toOutput`, the layers, tilt and `directorCorners.ts` keep their code. Rejected: (b) positions relative to the crop. | Under (b), every crop change would rewrite every zoom, shape and spotlight. Narrowing and then widening would lose positions: `setZoomRegion` → `normalizeRegion` clamps to [0, 1], and `readSpotlight` clamps x to [-1, 2] and w to ≤ 2. Mapping inside each consumer instead of building one view would touch about 10 render files. Under (a), view-space spotlights still pass through `readSpotlight` at render time (`projectSpotlights` in `shared/render/shapes.ts`). That edge case is handled in 4.1 and listed in Risks. |
| 4 | Units | Normalised to the video frame. Mapping always uses the crop **snapped to the project's pixels** (`cropOf`), so geometry and copied pixels agree exactly. The tool snaps edges to whole recorded pixels. A crop whose every edge is within 0.5 px of the frame edge is never stored. | Same space as cursor samples. Normalised values survive `correctProjectMedia` (`clips.ts:150`) changing `width`/`height`. No crop and Reset are then the same state. |
| 5 | Reading pixels | Copy the crop out of each decoded frame 1:1 into a reused canvas (`cropFrame`), then draw from that copy. Smoothing stays as today: the single draw uses `'high'`; motion-blur sub-frames draw from the copy with `'low'`, as the motion-blur branch already does with `rgbCopy`. Rejected: `drawImage` with a source rectangle on the video. Rejected: forcing `'low'` for every cropped draw. | The canvas spec lets filtering use pixels outside the source rectangle, so the edge of the hidden taskbar would bleed into the card, and mipmapped `'high'` downscales read even wider. The copy also stops privacy blur from pulling in hidden pixels. Forcing `'low'` would alias text when a 4K crop is drawn into a 1080p card, and cropped projects would look softer or shimmer compared with uncropped ones. |
| 6 | Zoom levels | Relative to the visible frame: 2× shows half the crop's width. Region zooms keep framing the same content, so their level readout changes (e.g. 2.5× becomes 2×). | `zoomTargetScale` derives a region's level from its rectangle, and the camera now reads the view rectangle. Levels relative to the full frame would aim part of a narrow crop's view outside the crop, and `clampCamera` would fight it. |
| 7 | Input under the hidden part | Treated like input outside the video. In view space: the cursor is not drawn (`inVideo`, `frameContext.ts`), ripples are skipped (`cursorLayer.ts:164`), `soundingClicks` filters `inVideo` (`clickSound.ts:97`), and `focusPathFor` clamps to the crop. For auto zoom, hidden clicks are filtered out in full space (decision 8). Smart speed (`inputGaps`), `findStrayClicks` and `planCursorPath` still read the full track. | Without this, zooms would aim at the crop edge and sounds would play with no visible click. Activity is still activity, and leaving smart speed alone is one less change. |
| 8 | Auto zooms when the crop changes | `rebaseAutoZooms(p.zooms, before, after)`, with `before` and `after` from `autoZoomsInFrame` for the old and new crop, in the same undo step. `autoZoomsInFrame` **removes clicks outside the crop and clamps the resulting anchors into it, all in full-frame coordinates**. It does not map the track into view space and back. Rejected: regenerate everything. Rejected: leave the zooms alone. | Regenerating brings back zooms the user deleted. Leaving them keeps zooms aimed at hidden clicks. Mapping into view space and back is not exact: `sameFocus` (`zoom.ts`) compares fixed focus with `===`, so a 1-ulp round-trip error makes `rebaseAutoZooms` replace every fixed-focus auto zoom (recordings with `track.valid === false`) with a copy under a new id and count it as removed. Filtering and clamping leave points inside the crop bit-identical. `zoomsFromEvents` uses no spatial distances, so the result is the same as generating in view space. |
| 9 | Time | One rectangle for the whole recording. | Keyframed or per-clip crop is listed under Later. |
| 10 | Editing model | A draft held in the Editor and applied on Done as one keyless `store.update`. Rejected: live store updates coalesced by key. | The tool shows the full frame, so live updates show nothing new. A draft gives Cancel for free and exactly one undo step. `EditStore.update` already returns early when `next === prev`, so an unchanged Done adds no step. |
| 11 | Preview while cropping | Full frame, through the existing `player.setNoZoom(true)`, whose `unzoomedScene` drops zooms and tilt. The camera is hidden by `webcam.show = false` in the crop-mode copy, which also turns off layouts (`layoutsApply`). The output shape is the full frame's. | This reuses what region picking already uses. You can see both what you are cutting away and what you could bring back. |
| 12 | Aspect locks | Free, Original, 16:9, 4:3, 1:1, 9:16, as **pixel** ratios. Shift while dragging in Free keeps the current shape. | Covers `ASPECT_RATIOS` (`styleDefaults.ts:58`) plus Original. Shift keeps the shape, as in the region editor (`dragRegion` with `keepShape`). |
| 13 | Quick presets | **Hide taskbar**: the bottom 48 DIP × display scale (`CursorTrack.scale`; `migrateCursor` uses 1 when it is absent). **Hide browser bar**: the top 88 DIP × scale. Each moves one edge only. | The roadmap names both. The proxy keeps capture pixels (`proxyArgs.ts` only crops or fits, then rounds to even sizes), so DIP × scale is the size in video pixels. These are starting points, and the edge stays draggable. |
| 14 | Minimum size | 64 recorded px per side, or the whole side when the recording is smaller. Rejected: `MIN_REGION_SIDE` (0.03). | 3% of 720p is 21 px, which is useless. Upscaling is warned about, not blocked. |
| 15 | Upscale warning | Reuse ExportDialog's rule (`upscaled()`, `ExportDialog.tsx:429`) with `visibleSize(project)`. The crop bar also shows a hint when the crop is under 720 px tall. | No second rule to keep in step. |
| 16 | Presets and default style | They do not carry the crop. | The crop belongs to one recording, like `inputEdits`. |
| 17 | Preview backing store | `PreviewStage` keeps its cap at the real `project.height` (`PreviewStage.tsx:139`). The size comes from the view, the cap from the real project. | Capping at the view height would make a 300 px crop render into a 300 px preview canvas. |
| 18 | Default key | `C`. | It is free in `DEFAULT_KEYMAP` and not in `RESERVED` (section 6). |

---

## 3. Data model

### `src/shared/types.ts` (SHARED, one additive field)

```ts
export interface Project {
  // ...
  capture: CaptureInfo
  /**
   * The part of the recorded video that is shown, normalised (0..1) to the video frame
   * (screen.mp4, already cut to capture.region). Absent = the whole frame; a crop covering the
   * whole frame is never stored. Every other normalised position (cursor.json, zoom focus and
   * anchors, shapes, spotlights) stays relative to the WHOLE frame. Rendering reads the project
   * through shared/engine/crop.ts cropView().
   */
  crop?: NormRect
  // ...
}
```

### `src/renderer/src/render/compositor.ts` (additive)

```ts
export interface RenderScene {
  /** The project as drawn: cropProject(project). Positions are relative to `crop`; width/height are the crop's pixels. */
  project: Project
  /** cropTrack(effective track, crop). */
  cursor: CursorTrack
  cursorPath: SmoothedTrack
  focusPath: SmoothedTrack
  /** Snapped crop (cropOf) of each decoded screen frame that is drawn; absent = all of it. */
  crop?: NormRect
}
```

### `src/renderer/src/render/frameContext.ts` (additive)

```ts
/** Height (px) of the whole decoded recording frame; privacy blur/pixelate strength is relative to it. Absent = screen.height. */
sourceH?: number
```

The comment on `vw`/`vh` changes to "drawn (cropped) video size in pixels".

### Editor-only types (`src/shared/editor/cropEdit.ts`)

```ts
export type CropAspect = 'free' | 'original' | '16:9' | '4:3' | '1:1' | '9:16'
export interface CropDraft { rect: NormRect; aspect: CropAspect }
export interface OutsideCount { zooms: number; shapes: number; spotlights: number }
export interface CropOutcome { project: Project; removedAutoZooms: number; restoredAutoZooms: number; outside: OutsideCount }
```

Defaults: no crop. A new draft is `cropOf(p) ?? FULL_FRAME`, with aspect `'free'`.

### Sanitising on load: `readCrop(raw, width, height)`

`migrateProject` (`src/shared/engine/project.ts:130`) adds `crop` to the destructure (`const { trim: _legacyTrim, audioStems, …, director, crop, ...rest } = p`) and one line `...optional('crop', readCrop(crop, p.width, p.height))`. `readCrop` works as follows:

1. If the value is not an object, or any of `x`, `y`, `w`, `h` is not finite, return `undefined`.
2. Clip to the unit square: `x0 = clamp(x,0,1)` and `x1 = clamp(x+w,0,1)`, and the same for y.
3. When `width` and `height` are finite and > 0, drop the crop if `(x1−x0)·width < min(64, width) − 0.5`, and the same for height. Otherwise, drop it if either side is < 0.01.
4. If every edge is within 0.5 px of the frame edge, return `undefined`.
5. Otherwise return `{ x: x0, y: y0, w: x1−x0, h: y1−y0 }`. There is no pixel snapping here, which keeps `readCrop` idempotent when `correctProjectMedia` later changes the size.

**Old projects**

- They have no `crop` key, so `cropOf` returns `null`.
- `cropProject(p)` returns `p` itself and `cropTrack(t, null)` returns `t`, so the Editor's scene holds the same objects as today.
- The compositor's crop branch is never taken.
- `visibleSize(p)` is `{p.width, p.height}`, so `exportSize` is arithmetically identical.
- Nothing is written to disk. `writeProject` and `saveProjectNow` serialise the project as it is, with no key whitelist.

**Style presets and "Save as default style"** do not carry the crop. `applyPreset` only writes `style`, `cursor`, `zoomSettings` and `tilt`, and `applyStyleDefaults` writes `style`, `cursor`, `webcam`, `effects`, zoom settings and `watermark`. E-01 polish applies a preset, so it keeps the crop by construction.

---

## 4. Algorithms and behaviour

### 4.1 Mapping (`src/shared/engine/crop.ts`)

`cropOf(p)` returns the crop snapped to `p.width × p.height` (`cropPixels / size`), or `null`. Every mapping below uses that snapped crop `c`.

- `toCrop(c, p) = ((p.x − c.x)/c.w, (p.y − c.y)/c.h)`; `fromCrop` is the inverse. `c = null` is the identity and returns the same object.
- `inCrop(c, p) = inUnit(toCrop(c, p))`, which is exactly the test the view later applies (`inVideo` / `isUsableClick`).
- `clampIntoCrop(c, p)` clamps x into `[c.x, c.x + c.w]` and y into `[c.y, c.y + c.h]`. It returns `p` itself when `p` is already inside.
- Rectangles map as `x' = (x − c.x)/c.w` and `w' = w/c.w`. Negative `w`/`h` (lines and arrows) map correctly.
- Spotlight `w`/`h` scale by `1/c.w` and `1/c.h`. That covers cursor mode, which uses only `w` and `h`.

`cropPixels(c, W, H)`:

- `x0 = round(c.x·W)`, `x1 = round((c.x+c.w)·W)` and `w = max(1, x1−x0)`; the same for y.
- `null` gives `{0, 0, W, H}`.
- Example: `{0.1, 0.1, 0.5, 0.5}` on 1919×1079 gives `{192, 108, 959, 539}`.

`croppedFrameSize(c, frameW, frameH, fallback)`:

- Returns `fallback` when `frameW` or `frameH` is 0 (no decoded frame yet). Otherwise it returns `cropPixels(c, frameW, frameH)`'s `{width: w, height: h}`.
- It exists because `cropPixels(c, 0, 0).w` is 1, never 0, so the old `|| project.width` fallback would never trigger.

`visibleSize(p)` is `cropPixels(cropOf(p), p.width, p.height)` as `{width, height}`. Anything that lays the recording out uses this as the recording's size.

`cropProject(p)`, when `p` has a crop:

- Returns `{ ...p, width, height }` with the cropped pixel size and **no `crop` key**.
- Zooms (`zoomInView`): the `fixed` point, the `region` rectangle and the anchor's `x`/`y` are mapped. `scale`, times and `until` are unchanged.
- Shapes: `x, y, w, h` are mapped.
- Spotlights: `x, y` are mapped and `w, h` are scaled. A *region* spotlight whose mapped box (widened by its feather) misses `[0,1]²` is replaced by the stand-in `{x: 1.5, y: 1.5, w: 0.005, h: 0.005}`, which `readSpotlight` keeps unchanged. Everything visible is then dimmed, as it should be. Spotlights wider than 2 view units are still clamped by `readSpotlight`; see Risks.
- Everything else is shared by reference.

Memoisation:

- Each mapped array is memoised per (source array, crop key) in a `WeakMap`.
- The view is memoised per (project object, track object).
- Editing the volume therefore keeps the mapped `zooms`/`shapes` arrays, and `readAll` (`shared/render/shapes.ts`), `sortedLayouts` and `costKey` in `directorCorners.ts` stay warm.

`cropTrack(t, c)`:

- Maps `samples`, `clicks` (keeping `button` and `up`) and `scrolls`.
- `keys`, `typing`, `marks`, `shapes`, `scale` and `valid` are shared.
- It is memoised per array. Ignoring a click creates a new `clicks` array but keeps the same `samples`, so the mapped `samples` array is reused and the Editor does not rebuild `SmoothedTrack` or `focusPathFor`.

`cropView(p, track)` returns `{ project: cropProject(p), cursor: cropTrack(track, cropOf(p)), crop: cropOf(p) }` and is the single entry point.

Example: a 1280×720 recording with a 48 px taskbar gives `c = {0, 0, 1, 0.933333}` (1280×672).

| Input (full frame) | In view |
|---|---|
| Click (0.5, 0.97) | (0.5, 1.039286): outside, so no ripple, sound or zoom |
| Shape `{0.25, 0.5, 0.5, 0.2}` | `{0.25, 0.535714, 0.5, 0.214286}` |
| Region zoom `{0.25, 0.25, 0.5, 0.5}` | `{0.25, 0.267857, 0.5, 0.535714}` |

### 4.2 Every consumer and how it gets the crop

| Consumer (file:line) | Today reads | With the crop | Change |
|---|---|---|---|
| `drawFrame` camera (`cameraAt`), `motionSamples`, `cardRect`, `viewSource`, `sceneContentRect` | `scene.project`, `scene.focusPath` | the scene is the view | none |
| `focusPathFor` follow clamp, `clampCamera`, `viewSource` clip to [0, 1] when pulled back | view samples | the scene | none. Editor builds `cursorPath`/`focusPath` from **view** samples (`Editor.tsx:288-289`) |
| Cursor layer (`cursorHeight(rect.h, vh, …)`, `inVideo`, ripples) | `fc.cursor`, `fc.vh` | the scene; `vh` is the crop's height in px | none; the cursor grows with the content |
| Shapes and spotlight layers, `fc.toOut` | `fc.project` | the scene | none |
| Privacy blur and pixelate (`drawBlurred`, `drawPixelated`, `shapesLayer.ts:155,167`) | `fc.screen` pixels; strength from `img.height` | `fc.screen` is the crop copy | strength from `fc.sourceH ?? img.height`, passed in as one more argument |
| Tilt (`beginTiltedCard(…, vw, vh)`, `tiltArea`, `aimAt`) | view project, `vw`/`vh` | the scene | none |
| Webcam layer (`sceneCameraBox(project, w, h, fc.vw, fc.vh)`), side-by-side, device frames (`frameInsets(kind, srcW > srcH)`) | view size | the scene | none |
| `drawKeystrokes`, annotations, captions, title cards, watermark | output space or keys only | — | none |
| Click sounds: preview (`player.setScene` → `soundingClicks`, `player.ts:124`) and export (`clickSoundJob(project, input.scene.cursor, …)`, `exporter.ts:109`); `hasClickSounds` (`ExportDialog.tsx:270`) | `scene.cursor` | the scene | none |
| Camera director, applying (`DirectorSection.tsx:241` `inputFor`) | `{ project: p, cursor: effectiveTrack(recorded, p) }` | `{ ...cropView(p, effectiveTrack(recorded, p)), speech }`; `applyDirectorPlan(p, …)` still takes the real `p` | 1 line |
| Camera director, live preview plan (`DirectorSection.tsx:192` `safePlan({ project, cursor, … })`) | real project and cursor | `cropView(project, cursor)` | 1 line (**missed by the draft**) |
| Auto zoom Regenerate and settings (`ZoomPanel.tsx:385, 391`) | `regenerateAutoZooms(p.zooms, cursor, …)` | `regenerateInFrame(p.zooms, cursor, p, …)` | 2 call sites |
| Ignore/use click rebase (`inputEdits.ts:119-120`) | `autoZoomsForTrack(effectiveTrack(…), …)` | `autoZoomsInFrame(effectiveTrack(…), p / next, auto)` | 2 lines |
| Recording finalize (`src/main/recording/finalize.ts`) | — | new recordings have no crop | none (teleprompter-owned, not touched) |
| Smart speed `inputGaps`, `findStrayClicks`, `planCursorPath` | full track, `p.width/p.height` | not cropped (decision 7) | none |
| `exportSize` (`exportPlan.ts:55`) | `project.width/height` | `visibleSize(project)` | 1 line |
| Export scene (`exporter.ts:82-83` `prepare`) | puts `exportProject(input.project)` (the **uncropped** project) into the scene when the aspect differs | `scene = { ...input.scene, project: exportProject(input.scene.project, settings) }`; `project` stays the real one for sizes and sound | 2 lines |
| `ExportPreview.tsx:34-35` | same swap | same fix | 2 lines |
| `cameraShownAt` source size: `player.ts:260`, `exporter.ts:394`, `exporter.ts:491` | `videoWidth` / `screenFrame.width` (full frame) | `croppedFrameSize(scene.crop ?? null, fw, fh, scene.project)` | 3 sites |
| ExportDialog upscale and very-wide notes (`ExportDialog.tsx:429, 435, 475, 479`) | `project.width/height` | `visibleSize(project)` | 4 expressions |
| `PreviewStage`: output size (139), `vw/vh` (195–196), `useSceneRect` (197), `useStageView` `cameraAt` / `visibleCursorAt` (111–115), `editItem` (209/213), region label and camera (360, 437) | `project` prop | `view = scene?.project ?? project`, `crop = scene?.crop ?? null`; cap stays the real `project.height` | see 4.6 |
| `CameraPanel.tsx:117-119` camera box preview | `project.width/height` | `visibleSize(project)` | 1 line |
| `playheadItems.ts:75,86` `addShapeAt`/`addSpotlightAt` (`shapeForPlayhead` aspect, `arrowToward`, `0.24/aspect`, `cursorPosFor`) | `store.state`, full cursor | build against `cropView(p, cursor)`, store `geometryFromCrop(c, item)` | 2 functions |
| `ShapesPanel.tsx:60,253-254` region spotlight placed at the cursor | `cursorPosFor(project, cursor)`, clamp to [0, 1] | position from the view, clamp in view, then `geometryFromCrop` | 2 lines |
| `Editor.tsx:572` `focusFor` (feeds the ZoomPanel focus-mode switch) | `zoom.anchor` (full) ?? `focusPath.at()` (now view) | `zoom.anchor` clamped by `clampIntoCrop`, else `fromCrop(c, focusPath.at(...))` | 1 line |
| ZoomPanel level readout (176), mode switch to region (193–200, `regionAround(f.x, f.y, level)`), Focus X/Y sliders (263–264), "Frames X × Y" text (273) | full-frame zoom | read `zoomInView(c, zoom)`; build `regionAround` in view, then write `rectFromCrop`; sliders write through `fromCrop` | about 6 lines (**193–200 and 273 missed by the draft**) |
| `Timeline.tsx:675` zoom block level label (`zoomTargetScale(z)`) | full-frame region | `zoomTargetScale(zoomInView(cropOf(project), z))` | 1 line, SHARED (**missed by the draft**) |
| Webcam picture, framing, face framing, camera masks | camera space | — | none |
| Home library thumbnails (`Home.tsx:186`, a raw frame of `screen.mp4`) | — | stay uncropped (teleprompter-owned file; they already ignore style and zoom) | none |

### 4.3 Pixels: `drawFrame` (the only place a crop touches pixels)

```
full   = screenImage(src)                                   // decoded frame or <video>, as today
crop   = scene.crop ?? null
screen = full && crop ? cropFrame(ctx, full, crop) : full   // cropFrame may return null (no DOM)
{vw,vh}= screen ? {screen.width, screen.height}
       : croppedFrameSize(crop, src.screen.videoWidth, src.screen.videoHeight, project)  // project = view
```

`cropFrame(target, frame, crop)`:

- Uses one canvas per target context, held in a `WeakMap` like `rgbCopies`, sized to `cropPixels(crop, frame.width, frame.height)`.
- Draws `drawImage(frame.image, px.x, px.y, px.w, px.h, 0, 0, px.w, px.h)` with `imageSmoothingEnabled = false`. The copy is integer and 1:1, so it is exact.
- Returns `{ image: canvas, width: px.w, height: px.h }`.
- Without `document` (DOM-less unit tests, as `rgbCopy` already handles), it returns `null`. The screen is then treated as "not decoded yet": only overlays are drawn, at the view size. This never happens in preview or export, which both run in the renderer.

Frame draw:

- The card draw keeps `drawImage(image, v.sx*vw, v.sy*vh, v.sw*vw, v.sh*vh, …)` byte for byte, because `image` is now exactly the crop.
- The single draw keeps `imageSmoothingQuality = 'high'`, as today.
- In the motion-blur branch, `rgbCopy` is skipped when `screen.image` is already the crop canvas: it is RGB already. Quality goes to `'low'`, as that branch already does.
- `fc.screen = screen` (the crop copy) and `fc.sourceH = full?.height`.

### 4.4 Export size and upscaling

`exportSize` uses `visibleSize(project)`. `autoAspect` snaps only within 1% of a standard shape (`layout.ts:29`).

| Recording | Crop | Visible | Export |
|---|---|---|---|
| 1280×720 | taskbar | 1280×672 (ratio 1.9048) | 720p → **1372×720**; 1080p → 2058×1080 |
| 1920×1080 at 100% | taskbar 48 px | 1920×1032 | 1080p → 2010×1080 |
| 2560×1440 at 150% | taskbar 72 px | 2560×1368 | 1080p → 2022×1080 |
| 1920×1080 | 1920×64 strip | 1920×64 | 2160p → `capSize` → `capped: true`, long side 4096 (existing path) |

A fixed aspect (16:9 and the others) fits the cropped card inside the padding, as today.

Upscale: the rule stays `styleContentRect(d.width, d.height, srcW, srcH, style).h > srcH × 1.05`, with `{srcW, srcH} = visibleSize(project)`. Example: 1920×1080 cropped to 960×540, padding 0.07, 1080p export. The content height is 928.8, which is more than 567, so the dialog warns "Larger than the recording (960×540): the video is upscaled and may look soft."

### 4.5 Auto zoom and the director

`autoZoomsInFrame(track, p, s)`, with `c = cropOf(p)`:

- With no crop, it is exactly `autoZoomsForTrack(track, p.duration, s)`.
- With a crop:
  1. `hidden = { ...track, clicks: track.clicks.filter((k) => inCrop(c, k)) }`, memoised per (clicks array, crop key).
  2. `zs = autoZoomsForTrack(hidden, p.duration, s)`.
  3. Each anchor is clamped with `clampIntoCrop`; typing places, marks and scroll landings can lie outside the crop.
  4. When `track.valid === false`, the fixed focus that `autoZoomsForTrack` copies from the anchor is clamped too.
- Points already inside the crop are returned unchanged, so `sameZoom` in `rebaseAutoZooms` matches across calls exactly. `zoom.ts` is not changed.

`regenerateInFrame(zooms, track, p, s)`:

- Calls `regenerateAutoZooms(zooms, hidden, p.duration, s)`, then applies the same clamp only to zooms with `auto: true`.
- Manual zooms are returned as the same objects.

Director:

- Both `inputFor(p)` and the live `safePlan` input are built from `cropView`.
- Corner costs are then measured where the cropped video draws clicks (`toOutput(screen, cameraAt(view zooms, …))`), with `outputSize`/`styleContentRect` on the cropped size (`directorCorners.ts:224-225`).
- `applyDirectorPlan(p, …)` writes only layout segments, which have no screen coordinates.

### 4.6 Editing on the preview (writing view-space edits back)

`PreviewStage` reads geometry only from `view = scene?.project ?? project`:

- `pickZoom` and `editItem` are looked up by id in `view.zooms`, `view.shapes` and `view.spotlights`.
- `out = outputSize(view.style.aspectRatio, view.width, view.height, project.height)`.
- `vw/vh = croppedFrameSize(crop, player.screen.videoWidth, player.screen.videoHeight, view)`.
- `useSceneRect(view, …)`, and `useStageView(player, view, scene, item)`.

All writes go through `c = scene?.crop ?? null`. Every patch they send is absolute geometry computed from the view item's initial value (`moveLine`, `setLineEnd`, `drawnGeometry`, `drawnBox`, `resizeAround`), never a delta, so mapping each patch is correct.

| Write (PreviewStage.tsx) | Change |
|---|---|
| `updateShape` (525) / `updateSpotlight` (529) | patch → `geometryFromCrop(c, patch)`. Partial patches work because x and w map independently. |
| `setRegion(id, box)` (255) | `setZoomRegion(z, rectFromCrop(c, box))`. `normalizeRegion` then runs in full space, where the region is never smaller than in view. |
| Fixed focus pick (294; clamped to [0, 1] in view, i.e. inside the crop) | `fromCrop(c, {x, y})` |
| Annotation position (507) | output space, no change |

### 4.7 Crop tool maths (`src/shared/editor/cropEdit.ts`)

Everything works in recorded pixels `W×H`, so ratios are pixel ratios. `MIN = (min(64, W), min(64, H))`.

**`dragCrop(r, handle, dx, dy, size, ratio)`**, with handles from `RegionHandle` (`zoomEdit.ts:73`):

- `move` translates the rectangle, clamped inside the frame; the size does not change. Example: `{0.5,0.5,0.5,0.5}` with `dx = +0.3` stays at `x = 0.5`.
- A free edge or corner moves the dragged edges, clamped to the frame and to at least `MIN` from the opposite edge. Example on 1920×1080: from the full frame, `se` by (−0.5, −0.5) gives `{0,0,0.5,0.5}`; by −0.99, the width stops at 64/1920.
- A locked corner with ratio `R`:
  1. The opposite corner is the anchor; `w' = |x − ax|` and `h' = |y − ay|`.
  2. `w = max(w', h'·R)`.
  3. `w = min(w, availW, availH·R)`.
  4. `w ≥ max(MINw, MINh·R)`, and then `h = w/R`.
  - Example on 1920×1080: `r = {0,0,0.5,0.5}`, 1:1, `se` by (+0.1, 0). Then w' = 1152, which is capped at 1080, giving `{0, 0, 0.5625, 1}`.
- A locked `n`/`s` edge: the new height gives `w = h·R`, centred on the old centre, shifted to stay inside and stopped at `W`. `e`/`w` work the same way on the other axis. Example: 16:9, `r = {0.25,0.25,0.5,0.5}`, `n` by −0.1 gives `{0.2, 0.15, 0.6, 0.6}`.
- `free` with Shift held uses the current rectangle's ratio for that drag.

**`fitCropAspect(r, R, size)`** runs when you pick a lock chip. It returns the largest rectangle of ratio `R` inside `r`, around `r`'s centre. Example: 1920×1032 with 16:9 gives 1835×1032 at x ≈ 42. "Original" uses `R = W/H`.

**`snapCrop(r, size, magnet, ratio)`** runs after every step:

- An edge within `magnet` of 0 or 1 snaps to it. `magnet = { x: 8 / rect.w, y: 8 / rect.h }`, i.e. 8 screen px of the overlay.
- Edges are then rounded to whole pixels.
- With a lock, `w` is rounded and `h = round(w/R)` (±1 px).

### 4.8 Quick presets

Presets move one edge of the current draft, and the lock becomes Free. Inputs:

- `s = track.scale`.
- `region = capture.region ?? {0,0,1,1}`.
- `target` falls back as `CaptureInfo` documents: `'area'` when `region` is set, otherwise `'screen'`.

**Hide taskbar** (`taskbarCrop`):

- `cut = (region.y + region.h − 1)/region.h + 48·s/p.height`.
- Offered when `target ≠ 'window'` and `0 < cut ≤ 0.25`. The bottom edge moves to `1 − cut`.
- Screen 1920×1080 at s = 1: 48 px, `h = 1032/1080`.
- Screen 2560×1440 at s = 1.5: 72 px, `h = 0.95`.
- Area `{0, 0.5, 0.5, 0.5}` recorded at 960×540, s = 1: `cut = 0.0889`.
- Area `{0, 0, 0.5, 0.5}`: not offered.

**Hide browser bar** (`browserBarCrop`):

- `cut = 88·s/p.height`.
- Offered for screens, for windows, and for areas with `region.y === 0`. The top edge moves to `cut`.
- Example: 1920×1080 at s = 1 gives `y = 0.081481`.

### 4.9 Applying: `setCrop(p, crop, track)` returns `CropOutcome`

1. `c' = crop ? readCrop(crop, p.width, p.height) : undefined`.
2. If `c'` equals `p.crop` (both absent, or every field within 1e-9), return `{ project: p, removedAutoZooms: 0, restoredAutoZooms: 0, outside: zeros }`.
3. Otherwise `next = { ...p, crop: c' }`, with the key removed when `c'` is undefined.
4. If `track` is given and `zoomSettingsOf(p).auto.enabled`:
   - `next.zooms = rebaseAutoZooms(p.zooms, autoZoomsInFrame(track, p, auto), autoZoomsInFrame(track, next, auto))`.
   - `removedAutoZooms` counts the auto zooms of `p` missing from `next`; `restoredAutoZooms` counts the zooms that were added.
   - There is no `track.valid` condition, matching `setClicksIgnored`.
5. `outside = outsideCrop(next, c')` counts:
   - zooms whose fixed point, region or click anchor is outside `c'`;
   - shapes whose `shapeBounds` miss `c'`;
   - region spotlights whose box misses `c'`.

### 4.10 Edge cases

- **Area recordings:** the crop is inside the already-cropped proxy, and it cannot reach beyond what was recorded.
- **Window recordings with fit bars** (`fitFilters`): the crop can hide the bars.
- **`cursorInVideo` recordings:** the baked-in cursor is cropped together with the pixels.
- **Pulled back (scale < 1):** `viewSource` clips to the view's [0, 1], so hidden content never shows around the card.
- **Camera-only layout:** the screen is hidden, so the crop is irrelevant.
- **Side-by-side:** the card takes the crop's shape.
- **A portrait crop of a landscape recording:** `frameInsets(kind, srcW > srcH)` picks the portrait device chrome.
- **`correctProjectMedia` changes `width/height`:** the crop is normalised, so `cropOf` re-snaps it to the new pixels.
- **A recording under 64 px on an axis:** that axis cannot be cropped.
- **Clicks under the hidden part:** they still appear as markers on the timeline (`clickRows`). They are recorded input; they just do nothing on screen.

### 4.11 Preview = export

- The Editor's single `scene` (built by `cropView`) is drawn by `player` and handed to `ExportDialog` → `exporter` (`prepare`, `renderThumbnail`) and `ExportPreview`.
- After the two `exportProject(scene.project, …)` fixes, no export path puts the uncropped project back into the scene.
- The crop touches pixels only in `cropFrame` (`compositor.ts`).
- `exportFrameTimes`, the audio plan and the clip mapping do not depend on the crop. Click sounds read `scene.cursor` in preview and export alike.
- Without a crop, `cropProject`/`cropTrack` return their inputs and `visibleSize` is `{width, height}`, so old projects are bit-identical.

---

## 5. UI and copy

**Style › Frame** (`src/renderer/src/editor/panels/StylePanel.tsx`, the `<Section title="Frame">` at line 74, under the *Aspect ratio* chips) gets a new row component, `panels/CropRow.tsx`:

- Uncropped: label **Crop**, button **Crop recording…** (tooltip "Choose the part of the recording to show (C)"), and the hint "Hide the taskbar, browser tabs or an edge."
- Cropped: "**1920 × 1032** of 1920 × 1080", with buttons **Edit…** and **Reset** (tooltip "Show the whole recording").

**Crop tool** (`src/renderer/src/editor/CropEditor.tsx` + `crop.css`), mounted by `PreviewStage` in place of the other overlays while a draft exists:

- The preview shows the full frame, unzoomed, flat, with the camera hidden (decision 11).
- Outside the rectangle is dimmed by four panels styled like `.region-shade` (`zoom.css:119`), at 55% black.
- 8 handles are styled like `.region-handle` (`zoom.css:156`). Thirds lines show while dragging.
- A label in the top-left corner shows "1920 × 1032".
- Title on the box: "Drag to move · edges and corners resize · Enter to apply, Esc to cancel". Double-clicking the box applies.
- Test ids: `crop-editor`, `crop-box`, `crop-handle-<h>`, `crop-done`, `crop-cancel`, `crop-reset`, `crop-taskbar`, `crop-browserbar`.

**Bar under the stage.** Every button calls `blurActiveControl()` (`editor/focus.ts:25`) after its action. A focused button would otherwise take the next Enter, because `RESERVED` says "Enter presses the focused button".

- **Aspect** chips:
  - *Free*: "Any shape. Hold Shift while dragging to keep the current shape".
  - *Original*: "The recording's own shape (1920 × 1080)".
  - *16:9*, *4:3*, *1:1*, *9:16*.
- **Hide taskbar**: "Cut the bottom 60 px: the Windows taskbar at 125% scaling" (computed). When disabled: "This recording does not show the taskbar".
- **Hide browser bar**: "Cut the top 110 px: tabs and address bar of a maximised browser" (computed). When disabled: "Only for screen or window recordings, or areas at the top of the screen".
- Size readout: "1920 × 1032 px".
- Small-area hint, when the crop is under 720 px tall: "Only 960 × 540 px: larger exports will be upscaled and may look soft."
- Buttons **Reset** ("Whole recording"), **Cancel** ("Esc") and **Done** ("Enter").

**Notices** (`showNotice`):

- After Done: "Cropped to 1920 × 1032." Then, when the counts are not zero:
  - " 1 automatic zoom for a click outside it was removed."
  - " 2 automatic zooms came back."
  - " 2 shapes are outside it; they come back if you widen the crop."
- The counts come from `CropOutcome`, with plural forms.
- After Reset: "Showing the whole recording."

**While the tool is open:**

- The selection is cleared. Playback and scrubbing work.
- Undo, Redo, opening Export and leaving the editor all close the tool without applying.
- The Editor sets `player.setNoZoom(!!pickZoom || !!cropDraft)`, combined into the existing effect at `Editor.tsx:294`.

---

## 6. Commands and shortcuts

New entries go into `COMMAND_LIST` (`src/shared/editor/commands.ts`) with `category: 'Edit'`. Availability goes into the `unavailable` map of `paletteEntries` (`Editor.tsx:770`), and the handlers go into the commands map that `commandsRef` runs.

| id | Title | Keywords | Default key | Unavailable when |
|---|---|---|---|---|
| `cropRecording` | Crop the recording… | crop trim edge taskbar tabs hide area frame region cut | `C` | never |
| `resetCrop` | Show the whole recording (reset crop) | crop uncrop full frame reset | — | "The recording is not cropped" |
| `cropTaskbar` | Crop out the taskbar | crop hide taskbar bottom windows | — | "This recording does not show the taskbar" |

Conflicts checked against `DEFAULT_KEYMAP` (`shortcuts.ts:28-58`):

- Space, Home, End, Left, Right, Shift+Left, Shift+Right, Shift+PageDown, Shift+PageUp.
- Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Ctrl+E, Ctrl+/, Ctrl+K, Ctrl+Shift+P.
- S, Delete, Backspace, Z, T, Shift+T, M, 0–4, Plus, =, -, _.
- `RESERVED` (`shortcuts.ts:335`): Enter, Tab, Ctrl+0, Ctrl+Plus, Ctrl+W, Ctrl+R and the rest, plus the Escape rule.

`C` is free. No renderer handler reads `c` or `KeyC` today, and Ctrl+C stays the text fields' own copy. In this wave, E-08 takes J/K/L. If E-01 or E-11 claim a letter, they must avoid `C`; whoever merges second runs `tests/shortcuts.test.ts`.

Enter and Esc are handled in `Editor.tsx`'s `onKeyDown` (around line 868), not as shortcuts:

- `Escape` closes the tool before the `pickFocus` branch.
- `Enter` with no modifiers, outside text entry and not on a focused button, applies the draft.

---

## 7. Undo

- **Done** is one step: the crop and the rebased auto zooms, in one keyless `store.update((p) => setCrop(p, rect, cursor).project)`. Keyless updates never merge (`History.push`).
- **Reset** (panel or palette) is one step. **Crop out the taskbar** from the palette is one step.
- Dragging, aspect chips and presets inside the tool change only the draft and add no step.
- Esc adds no step. Done with an unchanged rectangle returns the same object, which `EditStore.update` ignores (`next === prev`).
- Undo restores the previous crop and zooms exactly, from the history snapshot.

---

## 8. Contracts (committed first as stubs and types)

| File | Export | Signature |
|---|---|---|
| `src/shared/types.ts` | `Project.crop` | `crop?: NormRect` |
| `src/shared/engine/crop.ts` | `MIN_CROP_PX` | `64` |
| | `FULL_FRAME` | `Readonly<NormRect>` |
| | `PixelRect` | `{ x: number; y: number; w: number; h: number }` |
| | `readCrop` | `(raw: unknown, width: number, height: number) => NormRect \| undefined` |
| | `cropOf` | `(p: Pick<Project, 'crop' \| 'width' \| 'height'>) => NormRect \| null` (snapped to pixels) |
| | `cropPixels` | `(crop: NormRect \| null, frameW: number, frameH: number) => PixelRect` |
| | `croppedFrameSize` | `(crop: NormRect \| null, frameW: number, frameH: number, fallback: { width: number; height: number }) => { width: number; height: number }` |
| | `visibleSize` | `(p: Pick<Project, 'crop' \| 'width' \| 'height'>) => { width: number; height: number }` |
| | `inCrop` | `(crop: NormRect \| null, p: { x: number; y: number }) => boolean` |
| | `clampIntoCrop` | `<T extends { x: number; y: number }>(crop: NormRect \| null, p: T) => T` |
| | `toCrop` / `fromCrop` | `(crop: NormRect \| null, p: { x: number; y: number }) => { x: number; y: number }` |
| | `rectToCrop` / `rectFromCrop` | `<R extends NormRect>(crop: NormRect \| null, r: R) => R` |
| | `geometryFromCrop` | `<T extends Partial<NormRect>>(crop: NormRect \| null, patch: T) => T` |
| | `zoomInView` | `(crop: NormRect \| null, z: ZoomSegment) => ZoomSegment` |
| | `CroppableProject` | `Pick<Project, 'width' \| 'height' \| 'zooms' \| 'shapes' \| 'spotlights' \| 'crop'>` |
| | `cropProject` | `<P extends CroppableProject>(p: P) => P` |
| | `cropTrack` | `(track: CursorTrack, crop: NormRect \| null) => CursorTrack` |
| | `cropView` | `<P extends CroppableProject>(p: P, track: CursorTrack) => { project: P; cursor: CursorTrack; crop: NormRect \| null }` |
| | `autoZoomsInFrame` | `(track: CursorTrack, p: Pick<Project, 'crop' \| 'width' \| 'height' \| 'duration'>, settings: AutoZoomSettings) => ZoomSegment[]` |
| | `regenerateInFrame` | `(zooms: ZoomSegment[], track: CursorTrack, p: Pick<Project, 'crop' \| 'width' \| 'height' \| 'duration'>, settings?: AutoZoomSettings) => ReturnType<typeof regenerateAutoZooms>` |
| `src/shared/editor/cropEdit.ts` | `CropAspect`, `CropDraft`, `OutsideCount`, `CropOutcome` | section 3 |
| | `CROP_ASPECTS` | `readonly CropAspect[]` |
| | `TASKBAR_DIP`, `BROWSER_BAR_DIP`, `SMALL_CROP_PX` | `48`, `88`, `720` |
| | `cropRatio` | `(a: CropAspect, width: number, height: number) => number \| null` |
| | `dragCrop` | `(r: NormRect, handle: RegionHandle, dx: number, dy: number, size: { width: number; height: number }, ratio: number \| null) => NormRect` |
| | `fitCropAspect` | `(r: NormRect, ratio: number, size: { width: number; height: number }) => NormRect` |
| | `snapCrop` | `(r: NormRect, size: { width: number; height: number }, magnet: { x: number; y: number }, ratio: number \| null) => NormRect` |
| | `taskbarCrop` / `browserBarCrop` | `(r: NormRect, p: Pick<Project, 'capture' \| 'width' \| 'height'>, scale: number \| undefined) => NormRect \| null` |
| | `outsideCrop` | `(p: Project, crop: NormRect \| null) => OutsideCount` |
| | `setCrop` | `(p: Project, crop: NormRect \| null, track: CursorTrack \| null) => CropOutcome` |
| | `cropNotice` | `(o: CropOutcome) => string` |
| `src/renderer/src/render/compositor.ts` | `RenderScene.crop` | `crop?: NormRect` |
| `src/renderer/src/render/frameContext.ts` | `FrameContext.sourceH` | `sourceH?: number` |
| `src/renderer/src/editor/CropEditor.tsx` | `CropEditor` | `(props: { recorded: { width: number; height: number }; rect: Rect; draft: CropDraft; capture: CaptureInfo; scale: number \| undefined; onDraft: (d: CropDraft) => void; onDone: () => void; onCancel: () => void }) => JSX.Element` |
| `src/renderer/src/editor/panels/CropRow.tsx` | `CropRow` | `(props: { project: Project; onCrop: (action: 'edit' \| 'reset') => void }) => JSX.Element` |

---

## 9. Files owned by this feature

**Create**

- `src/shared/engine/crop.ts`: snapping, mapping, sanitiser, view and memoisation, and the crop-aware auto zoom wrappers.
- `src/shared/editor/cropEdit.ts`: drag, aspect, snap, presets, `setCrop`, `outsideCrop` and the notice copy.
- `src/renderer/src/editor/CropEditor.tsx` and `src/renderer/src/editor/crop.css`: the overlay and its bar.
- `src/renderer/src/editor/panels/CropRow.tsx`: the Style › Frame row.
- Tests: `tests/crop.test.ts`, `tests/cropEdit.test.ts`, `tests/compositorCrop.test.ts`, `tests/exportCrop.test.ts` and `tests/e2e/crop.e2e.cjs`. `run-all.cjs` picks up `*.e2e.cjs` by itself.

**Modify**

- `src/shared/types.ts` (**SHARED**): one field, `crop?: NormRect`, in `Project` after `capture`.
- `src/shared/engine/project.ts` (**SHARED**; E-11 may add a field): `migrateProject` only. `crop` is added to the destructure at line 130, plus one `...optional('crop', readCrop(...))` line.
- `src/shared/editor/commands.ts` (**SHARED**): 3 entries with `category: 'Edit'` in `COMMAND_LIST`.
- `src/shared/editor/shortcuts.ts` (**SHARED**; E-08 adds keys): one line, `cropRecording: ['C']`, in `DEFAULT_KEYMAP`.
- `src/shared/render/exportPlan.ts`: `exportSize` uses `visibleSize(project)`.
- `src/shared/editor/inputEdits.ts`: `setClicksIgnored` uses `autoZoomsInFrame` (lines 119–120).
- `src/renderer/src/render/compositor.ts`: `RenderScene.crop`, `cropFrame`, crop-aware `vw/vh` through `croppedFrameSize`, `rgbCopy` skipped for the crop canvas, `fc.sourceH` set.
- `src/renderer/src/render/frameContext.ts`: `sourceH?`.
- `src/renderer/src/render/shapesLayer.ts`: `drawBlurred`/`drawPixelated` take their strength height from `fc.sourceH`.
- `src/renderer/src/views/Editor.tsx` (**SHARED** with E-01, E-05, E-08 and E-11). Regions touched:
  - the scene block (lines 288–290): `cropView`, `cursorPath`/`focusPath` from view samples, the crop-mode scene and `scene.crop`;
  - the `setNoZoom` effect (294);
  - `focusFor` (572);
  - the `cropDraft` state and `applyCrop`;
  - three entries in the commands map and in `unavailable` (770);
  - the Esc/Enter branch of `onKeyDown` (868);
  - the `PreviewStage`/`Inspector` props.
- `src/renderer/src/editor/PreviewStage.tsx`: view reads, crop write-back, `vw/vh`, mounting `CropEditor`.
- `src/renderer/src/editor/player.ts`: `webcamShownAt` (260) uses `croppedFrameSize`.
- `src/renderer/src/editor/exporter.ts`: `prepare` (82–83) applies `exportProject` to `input.scene.project`; `cameraShownAt` sizes (394, 491).
- `src/renderer/src/editor/ExportPreview.tsx`: `exportProject` on `props.scene.project` (34–35).
- `src/renderer/src/editor/ExportDialog.tsx`: `visibleSize` at lines 429, 435, 475 and 479.
- `src/renderer/src/editor/Timeline.tsx` (**SHARED** with E-04, E-05, E-08 and E-11): one expression at line 675, `zoomTargetScale(zoomInView(cropOf(project), z))`.
- `src/renderer/src/editor/playheadItems.ts`: `addShapeAt`/`addSpotlightAt` build in the view and map back.
- `src/renderer/src/editor/panels/ZoomPanel.tsx`: `regenerateInFrame` (385, 391); level readout (176); region switch (193–200); sliders (263–264); "Frames" text (273).
- `src/renderer/src/editor/panels/DirectorSection.tsx`: `cropView` in `inputFor` (241) and in the live `safePlan` input (192).
- `src/renderer/src/editor/panels/CameraPanel.tsx`: `visibleSize` (117–119).
- `src/renderer/src/editor/panels/ShapesPanel.tsx`: `cursorPos` (60) and spotlight placement (253–254) through the view.
- `src/renderer/src/editor/panels/StylePanel.tsx`: `<CropRow>` in the Frame section, plus an `onCrop` prop.
- `src/renderer/src/editor/Inspector.tsx` (**SHARED**): pass `onCrop` to `StylePanel` at line 131, and add `InspectorProps.onCrop`.
- `docs/FEATURES.md` (one Editor bullet), `docs/ROADMAP.md` (E-10 status), `docs/IMPLEMENTATION.md` (one sentence: "layout reads the recording's size through `visibleSize`; geometry for drawing comes from `cropView`").

**Not touched** (teleprompter team): `src/main/**` (including `recording/finalize.ts` and `projects.ts`), `recordingIpc.ts`, `src/shared/recording/**`, `Home.tsx` (library thumbnails stay uncropped), `Toolbar.tsx`, `src/renderer/src/recorder/**` and the AI script code.

**Interactions with the wave**

- **E-01 polish:** it must use `regenerateInFrame`/`autoZoomsInFrame` and `cropView` for its auto zoom and director steps. `applyPreset` keeps the crop.
- **E-05 snapping:** timeline only. The crop tool has its own 8 px frame-edge magnet. The crop has no time, so snap targets are unaffected. Both features edit `Timeline.tsx`; E-10 changes only line 675.
- **E-08:** J/K/L and preview speed keep working while the tool is open.
- **E-11 freeze frame:** a frozen frame goes through `drawFrame` with the same scene, so it is cropped too.
- **E-04 waveform:** shares `Timeline.tsx` only.

---

## 10. Test plan

**`tests/crop.test.ts`**

- `readCrop`:
  - `undefined`, `'x'`, or a NaN field → `undefined`;
  - `{0,0,1,0.933333}` at 1280×720 is kept;
  - `{-0.1,0,0.6,1}` → `{0,0,0.5,1}`;
  - `{0.5,0.5,0.02,0.5}` at 1280×720 (25.6 px wide) → `undefined`;
  - `{0.0001,0,0.9999,1}` → `undefined` (whole frame);
  - idempotent.
- `migrateProject`: no crop gives `'crop' in p === false`; a valid crop is kept; a whole-frame crop is dropped.
- `cropPixels`:
  - `(null, 1280, 720)` → `{0,0,1280,720}`;
  - the taskbar crop → `{0,0,1280,672}`;
  - `{0.1,0.1,0.5,0.5}` on 1919×1079 → `{192,108,959,539}`.
- `cropOf` snaps `{0.10003, 0, 0.5, 1}` at 1920 to `x = 192/1920`.
- `croppedFrameSize(c, 0, 0, {width: 1280, height: 672})` returns the fallback, not `{1, 1}`.
- `toCrop`/`fromCrop` with `c = {0.1,0.2,0.5,0.4}`: (0.35, 0.4) → (0.5, 0.5) and back within 1e-12. `rectToCrop({0.6,0.6,−0.2,−0.1})` → `{1,1,−0.4,−0.25}`.
- `inCrop` agrees with `inVideo(toCrop(...))` on 1,000 random points.
- `clampIntoCrop` returns the same object for a point inside.
- `cropTrack`:
  - `(t, null) === t`;
  - with a crop, samples, clicks (`up` kept) and scrolls are mapped, and `keys`/`typing`/`marks` are the same arrays;
  - a new `clicks` array with the same `samples` keeps the mapped `samples` array.
- `cropProject` on 1280×720 with the taskbar crop:
  - `cropProject(p) === p` without a crop;
  - with the crop: 1280×672 and no `crop` key;
  - fixed focus (0.5, 0.5) → (0.5, 0.535714);
  - region → `{0.25, 0.267857, 0.5, 0.535714}`;
  - anchor (0.5, 0.97) → (0.5, 1.039286);
  - cursor spotlight h 0.24 → 0.257143;
  - a region spotlight entirely outside the crop → `{1.5, 1.5, 0.005, 0.005}`;
  - two project objects sharing `zooms` give the same mapped array.
- `autoZoomsInFrame` (clicks at t = 2 (0.5, 0.5) and t = 6 (0.5, 0.97), duration 10, default auto):
  - no crop → 2 zooms;
  - taskbar crop → 1 zoom, **deep-equal** (ids aside) to the first zoom without a crop.
- **Exactness regression case.** A `valid: false` track with the click at (0.3, 0.3) and the crop `{0.1, 0.1, 0.7, 0.7}`: the fixed focus is exactly `(0.3, 0.3)`, and `rebaseAutoZooms(zooms, before, after)` returns `zooms` itself.
- `regenerateInFrame` returns manual zooms as the same objects.

**`tests/cropEdit.test.ts`** (on 1920×1080)

- `dragCrop`: the free, `move`, locked-corner (1:1 → `{0,0,0.5625,1}`) and locked-edge (16:9 `n` → `{0.2,0.15,0.6,0.6}`) cases from 4.7. The result is never smaller than 64 px.
- `fitCropAspect`: 1920×1032 with 16:9 gives a width within 1 px of 1835, height 1032, centred.
- `snapCrop`: an edge 5 px from the right with an 8 px magnet snaps to 1. All values land on whole pixels.
- `taskbarCrop`:
  - h = 1032/1080;
  - h = 0.95 at s = 1.5;
  - area cut 0.0889;
  - top-left area → null;
  - window → null;
  - the draft's other edges are unchanged.
- `browserBarCrop`: 1920×1080 → y = 0.081481.
- `setCrop`:
  - an unchanged crop returns the same project object;
  - a whole-frame crop removes the key;
  - a taskbar-click auto zoom gives `removedAutoZooms: 1`, and setting the crop back to `null` gives `restoredAutoZooms: 1`;
  - a manual fixed zoom at (0.5, 0.97) is kept and counted in `outside.zooms`;
  - a `valid: false` project gets the rebase too;
  - through `EditStore`, there is one step and undo restores the crop and zooms.
- `outsideCrop`: the counts for shapes, region spotlights and zooms.

**`tests/compositorCrop.test.ts`**

Same harness as `compositorBounds.test.ts`: `recordingContext`, a stubbed `Path2D`, and `vi.stubGlobal('document', …)` whose `createElement('canvas')` returns `{ width, height, getContext: () => recordingContext().ctx }`. With a document present, other DOM paths (static layer caches, privacy scratch canvases) are active too, and the stub supports them.

- No crop: the calls equal those of a run where the scene is built by `cropView` (identity), and the frame draw reads `(image, 0, 0, 1280, 720, …)`.
- Taskbar crop:
  - the copy canvas is 1280×672 and receives `drawImage(frame, 0, 0, 1280, 672, 0, 0, 1280, 672)`;
  - the card draw reads the copy with source `(0, 0, 1280, 672)` and `imageSmoothingQuality === 'high'`;
  - a click at (0.5, 0.97) draws no ripple (`arc` count 0), and one at (0.5, 0.5) does.
- Without a decoded frame (`readyState 0`), the overlays are laid out at 1280×672, not 1×1.
- Blur: for a box inside the crop, the blur sigma (the scratch context's `filter`) is the same with and without the crop, because the strength height comes from `sourceH` = 720.

**`tests/exportCrop.test.ts`**

- `exportSize` with the taskbar crop on 1280×720 and Auto: 720p → 1372×720, 1080p → 2058×1080. With 16:9 at 1080p → 1920×1080.
- No crop: equal to `outputSize(aspect, w, h, res)` for 10 recording sizes.
- A 1920×64 crop at 2160 → `capped: true`, long side 4096.

**Existing:** `tests/commands.test.ts` (unique ids, known categories) and `tests/shortcuts.test.ts` must pass, with no conflicts between default keys.

**E2E: `tests/e2e/crop.e2e.cjs`**

Reuse:

- `render-fixtures.cjs`: `withHome`, `seedProject` (takes `media`, `capture`, `cursor`; defaults to a black background, padding 0 and Auto), `openProject`, `openExportDialog`, `pickChip`, `waitForExport`, `framesAt`, `probe`;
- `helpers.cjs`: `launch`, `mockSaveDialog`, `readProject`, `assert`, `run`;
- `editor-fixtures.cjs`: `waitFor`.

The fixture is built inline into the test home with ffmpeg: `color=c=0x808080:s=1280x720:r=60,drawbox=x=0:y=672:w=1280:h=48:color=0xff0000:t=fill`, 4 s, `-c:v libx264 -qp 0 -pix_fmt yuv420p`. Lossless encoding means no deblocking pulls red above row 672, so any red seen comes from the crop, not the encoder.

1. Seed with `media`, `capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }` and the default cursor `{ …, scale: 1, valid: false }`. Open the project.
2. Click **Crop recording…**, then `[data-testid=crop-taskbar]`, then `[data-testid=crop-done]`. Do not press Enter here: the focused button would take it.
3. `waitFor` `readProject(home, id).crop`: `{x: 0, y: 0, w: 1}` and `|h − 0.933333| < 1e-4`.
4. Wait 300 ms, then read `.preview-canvas` with `getImageData` in `win.evaluate`: no pixel with r > 200, g < 60 and b < 60.
5. Export with `mockSaveDialog`, `openExportDialog`, `pickChip('Format','MP4')`, `pickChip('Resolution','720p')`, `pickChip('Frame rate','60 fps')`, then Export and `waitForExport`.
   - `probe` gives 1372×720.
   - `framesAt(out, [0, 120], 'rgb24')`: no red pixels anywhere.
   - In the bottom 4 rows (columns 8 to width−8), every pixel has `r − g < 30`, so there is no edge bleed.
6. Close the dialog (Esc). Press Ctrl+Z, then `waitFor` until `crop` is absent from project.json.
7. Press `C`: `[data-testid=crop-editor]` is visible. Press Esc: it closes, and project.json is unchanged after 1 s.

---

## 11. Risks

1. **A view-space value leaks into stored data** through a write path missed in 4.2/4.6. Mitigations:
   - every write goes through `geometryFromCrop`, `rectFromCrop` or `fromCrop`;
   - the review rule: never `store.update` with values read from `scene.project` or `scene.cursor` without mapping them back;
   - a follow-up e2e step can move a shape while cropped, Reset, and check that it stayed on its content.
2. **Future code reading `project.width/height`** to lay out the recording gets the uncropped size. Mitigations: one line in `docs/IMPLEMENTATION.md`, and the view project already carries the cropped `width/height`.
3. **Spotlights in view space go through `readSpotlight`** (`projectSpotlights`). That clamps x/y to [-1, 2] and w/h to ≤ 2. A region spotlight more than twice as wide as the crop, or whose left edge is more than one crop-width to the left, is drawn clamped. A spotlight entirely off-view is handled (4.1); the partial case is only possible with crops under half the spotlight's width. It is accepted and covered by a unit test. The later fix is a view-only read path in `shared/render/shapes.ts`.
4. **Per-frame cost:** one extra crop-size blit per drawn frame for cropped projects. The single draw then smooths a canvas source with `'high'`. The motion-blur comment in `compositor.ts` notes that this is the slower cubic path. It is one draw per frame, not one per sub-frame. Measure 4K export in the `renderCost.test.ts` style. If it misses the budget, drop the single cropped draw to `'medium'` (mipmapped bilinear) in both preview and export together.
5. **Preset heuristics:**
   - The Windows 10 taskbar is 40 DIP, so 8 DIP of content is cut.
   - Auto-hidden, top or side taskbars are not handled.
   - Older `cursor.json` files without `scale` assume 1.
   - 88 DIP for the browser bar varies by browser.
   - These are starting points the user can drag.
6. **`STILL_EPS = 0.0015`** (`cursor.ts:83`) is in normalised units. In view space it is `crop.w` times smaller in content terms, so hide-when-idle reacts to slightly smaller moves on tight crops.
7. **Region zoom level readouts change after a crop**: the same framing gives a different number in ZoomPanel, `PreviewStage` and the timeline label. This is expected but may surprise users.
8. **Auto aspect sizes are non-standard** (for example 1372×720). Users who need a standard size pick 16:9.
9. **E-01** must call the crop-aware wrappers. If it calls `autoZoomsForTrack` directly, polish brings back zooms for taskbar clicks.
10. **Size.** About 27 files are touched, 6 of them SHARED, so this is closer to M than the roadmap's S–M. Suggested order:
    - **Phase 1:** `crop.ts`, data and migration, compositor, export/size fixes, Editor scene, the tool with Free/Original/16:9, Hide taskbar, Reset, `cropRecording`.
    - **Phase 2:** the other locks, Hide browser bar, the outside-item notice and the `cropTaskbar` command.
11. **Home library thumbnails** stay uncropped: `Home.tsx` belongs to the teleprompter team.

---

## 12. Later (out of scope)

- Crop over time: keyframed or per clip ("pan and scan").
- Detecting the taskbar, black bars or a browser frame automatically from pixels.
- Cropping inside the native helper while recording (the existing FEATURES roadmap line).
- Rotate and flip.
- Snapping crop edges to detected UI edges.
- A default crop per recording preset or in the brand kit (E-03).
- Showing the cropped result live beside the full frame while dragging.
- Cropped library thumbnails on Home, once that file is free.
- A view-only spotlight read path, so very large spotlights on tight crops are not clamped.

---
