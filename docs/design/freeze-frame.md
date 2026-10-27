# Freeze frame (E-11)

Part of Wave 6, "Easier editing". The shared rules for this wave (file ownership, the shared files, merge order and the keymap) are in [editing-wins.md](editing-wins.md).

Status: implemented on `w6-e11`; where the build differs from the text below, §13 "As built" says how and why. Roadmap item: `docs/ROADMAP.md` E-11 ("Hold a frame for a few seconds so viewers can read something, with the sound paused or continuing"). The roadmap lists the size as S. **Size M.** The preview clock (player and preview audio) and the split audio graph cannot be made smaller than that. What v1 leaves out to stay at M is listed in §12.

Checked against branch `feat-w6-editing-wins`. Code read for this design:
- Engine and editor: `src/shared/engine/timeline.ts`, `src/shared/editor/clips.ts`, `src/shared/editor/smartSpeed.ts`, `src/shared/editor/annotations.ts`, `src/shared/editor/commands.ts`, `src/shared/editor/shortcuts.ts`, `src/shared/engine/project.ts`, `src/shared/engine/backgrounds.ts`.
- Render and sound: `src/shared/render/{audioPlan,chapters,overlays,titleCards,feedPlan,clickSound,mp4}.ts`, `src/shared/captions/subtitles.ts`, `src/shared/audio/{soundtrack,activity}.ts`.
- Renderer: `src/renderer/src/render/{compositor,frameContext,frameSource,captionsLayer,webcamLayer,shapesLayer}.ts`, `src/renderer/src/editor/{player,previewAudio,exporter,media,selection}.ts`, `Timeline.tsx`, `Transport.tsx`, `ExportDialog.tsx`, `ExportPreview.tsx`, `Inspector.tsx`, `panels/ClipPanel.tsx`, `src/renderer/src/views/Editor.tsx`.
- Main process: `src/main/exportJob.ts`, `src/main/exportArgs.ts`, `src/shared/recording/hotkeys.ts`.
- Tests: `tests/e2e/{render-fixtures,editor-fixtures,helpers}.cjs`, `export.e2e.cjs`, `titles.e2e.cjs`, `run-all.cjs`.

---

## 1. What the user gets

- **Freeze frame at playhead** (`F`, or the button in the Clip panel) holds the frame under the playhead for 3 s. The length goes from 0.5 to 30 s in steps of 0.1 s.
- Each freeze has one of two sound modes:
  - **Pause the sound** (the default). 3 s of still picture are inserted into the video. The recording waits in silence while the background music keeps playing. Everything after the freeze moves 3 s later.
  - **Keep the sound playing.** No time is added. The screen stays on that frame for the next 3 s of the video while the voice, the camera picture and the captions go on.
- On the clip track a freeze is a hatched block:
  - drag its right edge to change the length;
  - drag its body to move it;
  - select it and press `Delete` to remove it.
- Preview and export match: the same frames, the same silence, and chapters, subtitles, click sounds and music ducking land in the same places.
- Projects without freezes open and export exactly as before.

---

## 2. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Where freezes are stored | A separate list, `Project.freezes?: Freeze[]`, anchored in **source time** like zooms. Rejected: a zero-length "hold" clip in `clips`, and a `hold` field on `Clip`. | `normalizeClips` (`timeline.ts`) drops clips shorter than `MIN_CLIP`. `splitAt`, `cutRange`, `setTrimStart`, `setTrimEnd` (`timeline.ts`), `restoreRange` and `setRangeSpeed` (`clips.ts`) copy clips with `{...c}`, which would duplicate a hold. About a dozen places in ten files compute `(end − start) / speed` inline, for example `clipSampleBounds` (`audioPlan.ts`), `outOf` (`subtitles.ts`), `rangesToOutput` (`activity.ts`), `outputToSourceRanges` (`smartSpeed.ts`) and `directorCorners.ts`. A separate list survives cuts, smart speed and remove silences untouched, the same way zooms do. |
| 2 | How a pause freeze changes timing | A **layer on top of the clip timeline**. "Edit time" (today's output time) does not change. "Video time" = edit time + the holds inserted before it. `timeline.ts` is not modified. | Every user of `sourceToOutput`, `outputToSource`, `viewingTime` (`overlays.ts`) and `outputTimeAt` (`clips.ts`) keeps working. Overlay fades, keystrokes, title cards, cursor effects and the director all fall in this group. Only code on the real video clock needs the layer: the player clock, export frame times, sound, the times written into files, and the displayed positions. |
| 3 | What a pause hold shows | The whole frame at source time `at`, drawn with `drawFrame(at)` on every frame of the hold. Zoom, cursor, ripples, text, title cards, captions and camera all stop. | The compositor is a pure function of source time, and source time does not move during a hold. Preview and export therefore agree by construction. |
| 4 | What a continue freeze shows | The screen frame, cursor, zoom, keystrokes and user overlays are drawn at `at`. **Three things follow the live time:** the camera picture, the burned-in captions and the animated background. Click sounds keep sounding. | The voice goes on, so a frozen face or caption would be out of sync for up to 30 s. A frozen background would jump forward when the freeze ends, because `animationTime(project.clips, t)` in `drawFrame` follows `t`. The camera picture is already a separate input (`webcamFrame`, or the live `<video>`). |
| 5 | Unit of `length` | Seconds of the exported video, in **both** modes. For continue, the frozen span is `[edit(at), edit(at) + length)` in edit time, so it can run across cuts and speed changes. Rejected: source seconds. | "Hold for 3 s" means 3 s on screen. A speed change or a removed silence inside the span never shortens the reading time. |
| 6 | Overlapping freezes | Resolved when the plan is built: a continue span ends at the **next active freeze**, at the end of the video, or after `length`, whichever comes first. Adding a freeze where the picture is already frozen is refused. | Overlap depends on the clips. Resolving it at plan time keeps the stored data simple. |
| 7 | Freeze whose frame is cut | It stays in the project and is **inactive**: a hollow marker in the gap. Restoring the cut brings it back. Cuts never delete freezes. | Same as zooms in cuts. A cut can be undone without losing a freeze. |
| 8 | Smart speed, remove silences, E-01 polish | They never change freezes. `[at − 0.25, at + 0.25]` is added to their `keep` ranges, the same way title cards are (`ClipPanel` `keep`, line 379, passed to `planSmartSpeed` and `planSilences`). | An automatic pass must not cut away the frozen frame. |
| 9 | Export sound for holds | Silence through `adelay=delays=<samples>S:all=1`, at the start of the sound piece that follows each hold. Clips are split at each hold. Edits with holds always take the existing **sample-exact** path: `aresample=48000`, then pad and trim each piece to sample bounds. Rejected: `anullsrc` segments in the `concat`, which would need each one's layout to match the stems. | `adelay … :all=1` is already used in `retimeFilters`. A delay in samples matches the video frame bounds exactly. Without holds the graph comes from today's code, unchanged. |
| 10 | Music under a pause hold | Music keeps playing. It already runs on the output timeline ("plays on the output timeline from its start", `MusicSound` in `api/export.ts`). Ducking ranges are mapped through the holds, so a speech range around a hold stays ducked across it. | Total silence under a long hold sounds broken. Mapping the ducking stops the music from swelling up during a short hold in the middle of speech. |
| 11 | Preview of a pause hold | The player pauses the screen element, the camera element and the stems at `at`, runs a wall clock for `length` seconds with `requestAnimationFrame`, keeps the music running on the video clock, then resumes. The playhead stays at `at` while the hold block fills with progress. | The timeline is in source time (`Timeline.tsx` places clips at `c.start * px`), so a hold has no position of its own on it, and seeking never lands inside one. |
| 12 | Preview of a continue freeze | The screen element keeps playing for its sound. The compositor draws a **cached still** of `at` through the existing `RenderSources.screenFrame`. The still is decoded through `seekToFrame` / `seekedFrame` (`editor/media.ts`), the same seek path the export's `ElementFrameSource` uses. | `screenFrame` already exists for export, so the compositor needs no change for the picture. One seek path means one frame choice. |
| 13 | The anchor frame | `at` is snapped to the **start of the source frame** under the playhead (`k / fps`, rounded **up** to whole ms, never before the clip start). `fps` is `project.capture?.fps ?? 60`, the same value the player uses. | The export picks the frame at or before `t + ½ frame` (`presentationIndex` in `mp4.ts` through `planFeed`). The paused element shows the frame that contains `t`. When the playhead is in the second half of a frame, the two differ by one frame. At a frame start (+ less than 1 ms) both pick frame `k`. |
| 14 | Frozen frames are sharp | Every hold frame and still frame is drawn with `blurSamples: 1`, in preview and in export. | `motionSamples` (`compositor.ts`) and the blur in `shapesLayer.ts` sample the zoom camera at `t ± shutter/2`, so a hold on a moving zoom would show a smeared still. The preview also uses 4 samples where the export uses 10. A reading pause wants a sharp picture. |
| 15 | Hold at the very end | Allowed: "hold the last frame". Its frames repeat the **last frame the edit already exported** at that frame rate, not the source frame at `last.end`. Its sound is the existing tail `apad`. | Decoding at `last.end` with the half-frame tolerance can pick the first trimmed-off frame when the edit ends before the media does. The preview shows `frameTimeFor(last.end)`. |
| 16 | Where it is added | Command `freezeFrame` "Freeze frame at playhead", default key `F`, and a button in the Clip panel. Rejected: a right-click menu, since nothing in `src/renderer/src/editor` uses `onContextMenu`. | `F` is free (§6). It sits with `S` (split) and `Z` (zoom). |
| 17 | Default sound mode | `'pause'`. | The classic "extend frame". Reading while someone talks is the less common case, and it is one click away. |
| 18 | Style presets and "Save as default style" | They do not carry freezes. | Freezes are per-recording content, like cuts and zooms. `lookOf` (`styleDefaults.ts`) and `presetLookOf` (`stylePresets.ts`) are not touched. |
| 19 | Animated background during a **pause** hold | It stops, because `animationTime(clips, at)` is constant during the hold. It continues smoothly afterwards, since edit time does not jump. | This keeps the compositor pure in source time. Animating during holds is in §12. |

---

## 3. Data model

### `src/shared/types.ts` (additive)

```ts
/** What the recording's sound does while a freeze frame holds (E-11). */
export type FreezeSound = 'pause' | 'continue'

/** A freeze frame: the picture holds the frame at source second `at`. */
export interface Freeze {
  id: string
  /** Source seconds of the held frame (a source frame start, whole ms). */
  at: number
  /** Seconds the picture holds in the exported video: 0.5..30, in tenths. */
  length: number
  /**
   * 'pause': `length` seconds are inserted into the video at `at`; the recording waits (silent),
   * music plays on. 'continue': nothing is inserted; the picture stays on `at` for the next
   * `length` seconds of the video while the recording's sound, the camera and captions play on.
   */
  sound: FreezeSound
}

// interface Project, after `chapters`:
  /** Freeze frames, sorted by `at`. Absent: none (every project from before E-11). */
  freezes?: Freeze[]
```

### `src/shared/api/export.ts` (additive)

```ts
/** A pause freeze in the export's sound: `length` seconds of silence before source second `at`. */
export interface SoundHold { at: number; length: number }
// interface RecordingSound:
  /** Pause freezes, sorted by `at` (absent or empty: none). */
  holds?: SoundHold[]
```

### Constants (`src/shared/engine/freeze.ts`)

```ts
export const FREEZE = { min: 0.5, max: 30, step: 0.1, default: 3 } as const
export const DEFAULT_FREEZE_SOUND: FreezeSound = 'pause'
/** Anchors closer than this (source s) are the same frame: half a 60 fps frame. */
export const FREEZE_EPS = 1 / 120
/** Most freezes a project keeps (bounds the audio graph). */
export const MAX_FREEZES = 200
/** Smart speed and remove silences keep this much (source s) on each side of an anchor. */
export const FREEZE_KEEP = 0.25
let n = 0
export const newFreezeId = (): string => `f${Date.now().toString(36)}${(n++).toString(36)}`
```

### Sanitising on load (`src/shared/engine/freezeData.ts`, `readFreezes(raw, duration)`)

`migrateProject` (`project.ts`) changes in two places:
- It destructures `freezes` out of `p` next to `transcript`, `captions` and the others. Without this, `...rest` would copy it raw.
- It adds `...optional('freezes', readFreezes(freezes, duration))` after `chapters`.

The rules:

- Not an array → `undefined`, and the project has no `freezes` key.
- Each entry must be an object with a string `id` of 1 to 64 characters and a finite `at`. Anything else is dropped.
- `at` is clamped to `[0, duration]` and rounded to 1 ms.
- `length`: if not finite, `FREEZE.default`. Otherwise rounded to 0.1 and clamped to `[0.5, 30]`.
- `sound`: `'continue'` is kept. Anything else becomes `'pause'`.
- Entries are sorted by `at`. Of two entries within `FREEZE_EPS` of each other, or with the same `id`, the first is kept. At most `MAX_FREEZES` are kept.
- An empty result → `undefined`.
- The function is idempotent.

Old projects have no `freezes`. `planOf` then returns `NO_FREEZES`, every hold-aware function takes its identity path (§4.9), and nothing is rewritten on disk. Nothing in `src/main` whitelists project keys, so the field is saved as it is.

`correctProjectMedia` (`src/shared/editor/clips.ts`) gets one line: `...(project.freezes && { freezes: clampFreezes(project.freezes, d) })`.

Style presets and "Save as default style" do not carry freezes (Decision 18).

---

## 4. Algorithms and behaviour

### 4.1 The plan: `freezePlan(clips, freezes)` (`src/shared/engine/freeze.ts`)

```ts
export interface Hold  { id: string; at: number; edit: number; start: number; length: number; end: boolean }
export interface Still { id: string; at: number; editStart: number; editEnd: number }
export interface FreezePlan {
  holds: Hold[]       // pause freezes in edit order; start = video second the hold begins; end = at the edit's end
  stills: Still[]     // continue freezes; the picture shows `at` over edit [editStart, editEnd)
  added: number       // sum of hold lengths
  inactive: string[]  // ids whose frame is cut, or whose continue span is under 0.05 s
}
export const NO_FREEZES: FreezePlan // frozen, empty
export function planOf(p: Pick<Project, 'clips' | 'freezes'>): FreezePlan // NO_FREEZES when absent/empty; else memoised on (clips, freezes) identity, one entry
```

How the plan is built:

1. Sort the freezes by `at`. For each one, `e = sourceToOutput(clips, at)`, or `outputDuration(clips)` when `|at − last.end| ≤ 1 ms` (see §13). If `e` is `null`, the freeze is inactive because its frame is cut.
2. Walk the active freezes in edit order.
   - A pause freeze becomes `{ edit: e, start: e + addedSoFar, length, end: |at − last.end| ≤ 1 ms }`, and then `addedSoFar += length`.
   - A continue freeze becomes a still with `editStart = e` and `editEnd = min(e + length, nextActiveEdit, outputDuration(clips))`. A still shorter than 0.05 s goes to `inactive`. This happens at `last.end`, where the span is empty, and for a continue freeze on the last few frames before the end or one frame before the next freeze.

### 4.2 Time maps (all in `freeze.ts`, pure)

```ts
videoDuration(clips, plan) = outputDuration(clips) + plan.added
editToVideo(plan, o)       = o + Σ h.length for holds with h.edit < o − 1e-9
                             // a hold AT o comes first: o maps to the hold's start
videoToEdit(plan, v)       → { edit, hold: Hold | null, elapsed }
                             // inside [h.start, h.start + h.length): edit = h.edit, elapsed = v − h.start
videoToSource(clips, plan, v) → { time, index, hold }   // time = h.at inside a hold, else outputToSource(clips, edit)
videoTimeAt(clips, plan, t) = outputTimeAt(clips, t) >= outputDuration(clips) − 1e-9
                                ? videoDuration(clips, plan)            // the end of the edit is the end of the video
                                : editToVideo(plan, outputTimeAt(clips, t))
pictureTime(clips, plan, t) = still.at when sourceToOutput(clips, t) ∈ [editStart, editEnd) of a still, else t
```

One rule covers ranges and points:
- A range or event that starts **exactly** at a hold includes the hold.
- A range that ends exactly at a hold ends before it.
- A range with a hold strictly inside it stretches across the hold.

The compositor draws the hold at `at`, so the burned-in caption active at `at` is the one the subtitle file shows during the hold.

### 4.3 Frames: `videoFrames(clips, plan, fps)`

```ts
→ { times: number[]; pictures: number[]; held: Uint8Array | null }
```

**Without freezes:**
- With `plan === NO_FREEZES`, or with stills only, `times` is `exportFrameTimes(clips, fps)` itself.
- `pictures` is the same array when there are no stills (`===`).
- `held` is `null`.

**With holds:**
- `count = max(1, round(videoDuration * fps))`. For frame `i`, `v = i / fps`.
- Outside holds: `times[i] = videoToSource(clips, plan, v).time`, clamped to its clip's end as `exportFrameTimes` does.
- Inside a hold: `times[i] = h.at`. For an end hold (Decision 15) it is the time of the last frame before the hold, or `last.start` when there is none.
- `held[i] = 1` inside a hold.
- The cost is linear: one pointer walks the holds and one the clips.

**With stills:** every frame whose edit time lies in `[editStart, editEnd)` of a still gets `pictures[i] = still.at` and `held[i] = 1`.

`times` never decreases, and neither does `pictures`. `planFeed` (`feedPlan.ts`) already handles repeats (slow clips) and jumps forward (cuts).

**Worked example.**

- Clips: `[0,4)` at 1×, and `[6,10)` at 2×. The edit lasts 4 + 2 = 6 s.
- Freezes:
  - pause at 2.0, length 3;
  - continue at 7.0, length 1.5.
- Plan:
  - hold `{edit: 2, start: 2, length: 3}`;
  - still `{editStart: 4.5, editEnd: 6}`, because `sourceToOutput(7) = 4 + 1/2`;
  - `videoDuration = 9`.
- At 60 fps there are 540 frames:

| Frames | `times` | `pictures` | `held` |
|---|---|---|---|
| 0–119 | 0 → 1.983 | same | 0 |
| 120–299 (the hold) | 2.0 | 2.0 | 1 |
| 300 | 2.0 (moving again) | 2.0 | 0 |
| 420 | 6.0 | 6.0 | 0 |
| 449 | 6.9667 | 6.9667 | 0 |
| 450–539 | 7.0 → 9.967 | 7.0 | 1 |

- `editToVideo(plan, 2) = 2`, `editToVideo(plan, 2.5) = 5.5`, `editToVideo(plan, 6) = 9`.
- `videoToEdit(plan, 3.2) = {edit: 2, hold, elapsed: 1.2}`.

### 4.4 Export pixels (`src/renderer/src/editor/exporter.ts`, `src/renderer/src/render/compositor.ts`)

`exporter.ts`:
- `planJob`: `const { times, pictures, held } = videoFrames(clips, planOf(project), fps)`. `JobPlan` gains `pictures` and `held`.
- `exportAudio`: `frames = videoFrames(project.clips, planOf(project), AUDIO_ONLY_FPS).times.length`.
- `renderAll`:
  - The screen `FrameSource` is opened with `pictures`.
  - The camera is opened with `times.map(t => t − project.webcamOffset)`, today's line. The camera is therefore frozen in a pause hold and live in a still.
  - `masked()` passes `pictures[i]` to `cameraShownAt`, because the layout is drawn at the picture time.
  - Each frame is `drawFrame(ctx, w, h, pictures[i], scene, {...sources, screenFrame, webcamFrame}, held?.[i] ? { ...options, blurSamples: 1 } : options, times[i])`.
- `renderThumbnail`: `ThumbnailInput` gains `soundTime?: number`, which is passed through as the last argument.
- With no freezes, `pictures === times` and `held === null`, so every call is the same as today.

`compositor.ts`:
- `drawFrame` gains an 8th parameter, `soundTime = t`: the source time of the sound. `DrawOptions` stays as it is. Adding a field there would break `Required<DrawOptions>`, which `DEFAULT_OPTIONS` and `FrameContext.options` (`frameContext.ts`) both use.
- Two lines change:
  - `const bgTime = isAnimated(style.background) ? animationTime(project.clips, soundTime) : 0`
  - `drawCaptionsLayer(soundTime === t ? top : { ...top, t: soundTime })`
- Nothing else changes.

### 4.5 Export sound (`src/shared/render/audioPlan.ts`, `exporter.ts`, `src/main/exportJob.ts`)

`exporter.ts`:
- `soundOf` sets `audio.holds = plan.holds.map(h => ({ at: h.at, length: h.length }))`, only when there is at least one hold.
- **Clicks:** `clickSoundJob(...)` is unchanged. Its `times` are mapped with `editToVideo(plan, ·)`. A click exactly at a hold sounds when the hold starts.
- **Music:** `musicOf` maps the `soundActivity(...)` ranges through `editToVideo` before `musicDucking`. `job.frames / fps` already includes the holds, so `musicEnd`, the music padding and the soundtrack fades follow automatically.
- **Chapters:** `chaptersOf` calls `outputChapters(chapters, clips, planOf(project))` (§4.7).

`planSoundtrack` copies `job.audio.holds` into `RecordingPart.holds`, on both the stems path and the mixed-track path.

`recordingGraph(rec, duration)`:
- If `!rec.holds?.length`, today's code runs exactly. A test compares the graph strings.
- Otherwise `soundPieces(clips, holds)` splits each clip at every hold:
  - a hold with `|at − c.start| < 1 ms` goes in front of `c`;
  - a hold with `at ≥ last.end − 1 ms` becomes the `tail`;
  - any other hold splits `c` at `at`.
- Each piece is `{ start, end, speed, hold }`.
- Holds force the exact path: `aresample=48000:async=1:first_pts=0`, with bounds from `pieceSampleBounds(pieces)`. That function is `clipSampleBounds` with `hold + (end − start) / speed` per piece.
- The chain of piece `i` is today's chain, with `,adelay=delays=${H_i − B_i}S:all=1` inserted after `${tempo}` and before the `${exact}` pad/trim. Here `B_i` is the piece's start bound and `H_i = round((B_i / 48000 + hold) · 48000)`. Holds are in tenths, so this is a whole number of samples.
- The tail is covered by the final `apad=whole_dur=duration`, which already exists.
- For the worked example the bounds are `[0, 96000, 336000, 432000]` (= [0, 2, 7, 9] s × 48 000). Piece 1 gets `adelay=delays=144000S:all=1` and `apad=whole_len=240000,atrim=end_sample=240000`.
- A graph with 200 holds is long. `externalizeGraph` (`exportArgs.ts`) already moves any `-filter_complex` longer than `GRAPH_INLINE_MAX` into a script file, so the Windows command-line limit does not apply.

`src/main/exportJob.ts`: `validRecording` also accepts `holds`. It must be either `undefined`, or an array of at most `MAX_FREEZES` entries with `isNum(at, 0, 1e7)` and `isNum(length, FREEZE.min, FREEZE.max)`. This file is export code, not one of the recording files the teleprompter team owns.

### 4.6 Preview (`player.ts`, `previewAudio.ts`, new `freezeStills.ts`)

**New player state:**
- `plan: FreezePlan`, recomputed in `setProject` when `clips` or `freezes` change. A change clears any running hold.
- `hold: { h: Hold; elapsed: number; t0: number } | null`.
- `passed: { id: string; at: number } | null`: the hold just left, so it is not entered again at the same `t`.
- `get holdElapsed(): number`:
  - `hold.elapsed` during a hold;
  - `h.length` while `passed` is set and `|time − passed.at| < frame / 2`;
  - otherwise 0.
  - Without the middle case, the Transport and the music clock would read the hold's start on the first frame after it.
- `stills: FreezeStills`, owned by the player. It is created from `screen.currentSrc`. `prepare` runs on construction and whenever the continue anchors change.

**Entering a hold (in `onVideoFrame`, after drawing `t`):**
- Find the active hold whose `at` lies in `[t − ε, t + clip.speed · frame)` and is not `passed`.
- Run `playClicks` up to `at`.
- Set `hold` **before** pausing the elements, then:
  - pause the screen and camera elements (not `stopPlaying`);
  - `this.screen.currentTime = frameTimeFor(at)` when it differs by more than 1 ms;
  - `syncWebcam(at, true)`, forced, because its normal drift tolerance (`WEBCAM_DRIFT`, 0.15 s) would freeze a different face than the export;
  - `sound.hold(h, 0)`;
  - start a rAF loop.
- `leaveClip` at the last clip: when an end hold exists, enter it there, and call `finish()` when it ends.

**Handlers that must respect `hold`:**
- `onPause`: return when `hold` is set. Pausing the screen fires `'pause'`, and today that calls `this.pause()`, which would end playback.
- `onEnded`: return when `hold` is set.
- `invalidate`: draw while `hold` is set. It is a no-op while `playing` today, so a seek back to `at` would never be redrawn.
- `onSeeked` invalidates as today.

**During the hold (rAF loop):**
- `elapsed = (now − t0) / 1000 × previewRate`. `previewRate` is E-08's preview speed, 1 until E-08 lands.
- Each tick calls `emit()` and `sound.hold(h, elapsed)` + `sound.frame()`.
- Drawing is `draw(h.at)` with `blurSamples: 1`. It happens once on entry and again after `seeked` or `invalidate`. The end hold draws `frameTimeFor(last.end)`.

**Leaving the hold (`elapsed ≥ length`):**
- `passed = { id, at }`, `hold = null`.
- The elements play from `at`.
- `sound.jump(at, speed)`, then `sound.hold(h, h.length)` until the first frame with `t > at + frame / 2`, then `sound.hold(null, 0)`.
- `scheduleFrame()`.

**Interrupting a hold:**
- `pause()` during a hold stops the loop and keeps `elapsed`.
- `play()` sees `hold` and resumes the loop instead of starting the elements.
- `seek()` clears both `hold` and `passed`.
- Playing from a playhead within half a frame of a hold's `at` starts with that hold, from elapsed 0.

**Continue freezes:**
- `draw(t)` maps the picture: `p = pictureTime(clips, plan, t)`.
- When `p !== t`: `drawFrame(ctx, …, p, scene, { …, screenFrame: stills.get(p) }, { blurSamples: 1 }, t)`.
- The playhead runs on through the hatched block while the picture stays still.

**`FreezeStills` (`src/renderer/src/editor/freezeStills.ts`):**
- Holds at most 6 `ImageBitmap`s, in an LRU keyed by `at` in ms. Only continue freezes need stills.
- Every still comes from one hidden `<video>` through `seekToFrame` + `seekedFrame` (`media.ts`), then `createImageBitmap`. This is the same frame choice as the export (Decision 13).
- Until a still is ready, the preview draws the live element. This is logged once, and is a preview-only difference that lasts a few frames.

**`PreviewAudio`:**
- `length = videoDuration(...)`.
- `setProject` also reacts to `freezes !== prev.freezes`.
- `clipsKeyOf` includes the holds, so `scheduleIfChanged` reschedules.
- `outputAt(t) = editToVideo(plan, <today's edit value>) + heldElapsed`.
- `soundRanges()` maps the ranges through `editToVideo`, so the ducking curves line up.
- New `hold(h, elapsed)`:
  - on entry, pauses the stems;
  - `frame()` skips the stem drift loop while a hold is set, because `startStem` would restart them;
  - music keeps running and is synced through `outputAt`;
  - the stems restart on `jump`.
- A project without a sound graph needs nothing more: the paused `<video>` is silent.

### 4.7 Files and displays in video time

- `subtitleFile(segments, clips, format, plan = NO_FREEZES)` (`subtitles.ts`): cue `start` and `end` go through `editToVideo` after `outputCues`. A cue around a hold stretches across it.
- `outputChapters(chapters, clips, plan = NO_FREEZES)` (`chapters.ts`):
  - the end-of-video drop rule stays in edit time, as in `chapterInVideo`;
  - surviving starts go through `editToVideo` before chapters in the same place are merged;
  - a chapter exactly at a hold starts when the hold starts.
- `ExportDialog.tsx`:
  - `length = videoDuration(clips, plan)`, which also feeds the size estimate, the warnings and `youtubeChapters`;
  - `outputChapters(…, plan)`;
  - the **Frame** slider: the initial `frameAt = videoTimeAt(clips, plan, player.time)`;
  - `const s = videoToSource(clips, plan, frameAt).time; frameSource = pictureTime(clips, plan, s)`, and `s` is passed to `ExportPreview` and `renderThumbnail` as `soundTime`.
- `ExportPreview.tsx`: passes `soundTime` as the last argument of its `drawFrame` call.
- `CaptionsPanel.tsx`: `subtitleFile(segments, p.clips, f, planOf(p))`.
- Positions shown to the user use `videoTimeAt(clips, planOf(p), t)` instead of `viewingTime`, so they match the Transport and the YouTube timestamps:
  - `TextPanel.tsx`: the chapter rows and the item `at` label;
  - `CaptionsPanel.tsx`: the caption row times.
- With `NO_FREEZES`, every map is the identity and every output is byte-identical.

### 4.8 Edits (`src/shared/editor/freezeEdit.ts`)

`freezeAtPlayhead(p, t, init?)`:
- Anchor: `fps = p.capture?.fps ?? 60`.
  - If `|t − last.end| ≤ 1 ms`, then `at = last.end`. A playhead in the trimmed-off end is in a cut.
  - Otherwise `k = floor(t · fps + 1e-6)` and `at = ceil(max(clip.start, k / fps) · 1000) / 1000` (whole ms even when the clip starts between two ms; see §13).
- It is refused, in this order:
  1. `'cut'`: `clipIndexAt(clips, t) < 0` and `t` is not at `last.end`;
  2. `'taken'`: a freeze is within `FREEZE_EPS`; that freeze's id is returned so it can be selected;
  3. `'frozen'`: `at` lies inside an active still;
  4. `'full'`: the project already has `MAX_FREEZES`.
- `init.sound === 'continue'` at `last.end` is turned into `'pause'`, because nothing plays after the end.

Other operations:
- `setFreezeLength(p, id, v)` rounds to 0.1 and clamps to [0.5, 30]. It returns `p` itself when nothing changes.
- `setFreezeSound(p, id, s)` changes the mode.
- `moveFreeze(p, id, t)` snaps the same way. It returns `p` when the new `at` is cut or taken. A `t` exactly on a clip's end with a cut after it (the "Cut" target a drag snaps to, E-05) is in no clip, so it takes that clip's last frame.
- `removeFreeze(p, id)` removes the `freezes` key when the list becomes empty.
- `freezeTextRange(clips, f)` returns `{ start: outputToSource(clips, max(0, e − 0.5)).time, end: outputToSource(clips, e + 0.5).time }`, or `null` when the freeze is inactive.
  - "Add text on the freeze" uses it through `createAnnotation(start, p.duration, { end })` (`annotations.ts`).
  - The text is past its `ANNOTATION_FADE` (0.15 s) fade-in before the picture stops, so it shows through the whole freeze.
  - Near the edit's end the range is cut at the end, so the hold would repeat a moment of the text's fade-out. A text running to the edit's end therefore does not fade out there while a pause freeze holds one of the edit's last 0.15 s (§13).

How other features treat freezes:
- **Cuts, splits, trims, speed changes** (`timeline.ts`, `clips.ts`): untouched. A freeze whose frame is cut is inactive. A continue span is measured in edit time, so speed changes keep its length.
- **Smart speed and remove silences:** `ClipPanel` `keep` = titles + `freezeKeepRanges(freezes)` (`[at − 0.25, at + 0.25]` per freeze), with `freezes` added to the memo dependencies. `TitlesKept` reads: "Title cards and freeze frames stay as they are: the time they are on screen is never sped up or cut."
- **E-01 polish** must pass the same ranges.
- **In-editor captions** (`captionItems`), the camera director and auto zoom work in source or edit time and ignore holds. That is correct, because a hold adds no recorded content.

### 4.9 Identity guarantees for old projects

`planOf` returns `NO_FREEZES` (`===`) when `freezes` is absent or empty. Then:
- `videoFrames` returns `exportFrameTimes`, with `pictures === times` and `held === null`;
- `soundOf` sets no `holds`, and `recordingGraph` runs today's code;
- the map functions are the identity;
- `drawFrame` gets `soundTime === t`.

The player and `PreviewAudio` short-circuit on `plan === NO_FREEZES`.

---

## 5. UI and copy

**Timeline.** New `src/renderer/src/editor/FreezeMarks.tsx` (+ `freeze.css`), rendered inside `.clip-track` in `Timeline.tsx` after the click markers (one element plus props).

Every block calls `stopPropagation` on pointer-down, so the clip track's `onClipTrackDown` (playhead / Shift+range) does not also run.

- Each active freeze is a `.freeze-block` (`data-testid="freeze-block"`, `data-freeze={id}`):
  - a 12 px strip along the top edge of the clip track;
  - diagonal hatching in the accent colour;
  - minimum width 8 px;
  - a 6 px handle on the right edge.
- **Pause** freeze:
  - Starts at `at * px`, with width `length * px`. It is drawn over the footage, not pushing it aside, because the timeline is in source time. It has a dashed outline and a solid left bar.
  - Label `⏸ +3.0 s`.
  - Tooltip: "Freeze frame: adds 3.0 s here, the recording waits. Drag the edge to change, Delete to remove".
  - While it plays, a progress fill grows (`--hold-progress`, from `player.holdElapsed`, through `player.subscribe`).
- **Continue** freeze:
  - Covers the source pieces of `[editStart, editEnd)`, which can be split across cuts.
  - Label `3.0 s` with a speaker glyph.
  - Tooltip: "Freeze frame: the picture holds for 3.0 s while the sound plays on".
- **Inactive** freeze (frame cut): a hollow 8 px diamond at `at` in the gap. Tooltip: "Freeze frame in a cut: not in the video. Restore the cut, or select it and press Delete".
- A continue freeze that is inactive although its frame is kept (the video's end or the next freeze comes less than 0.05 s after it, §4.1) is the same diamond, with `data-testid="freeze-short"` and the tooltip "Freeze frame with nothing to hold: the video ends right after it. Pause the sound, or select it and press Delete" (or "the next freeze starts right after it"). `freezeInactiveReason(p, f)` (`freezeEdit.ts`) tells the cases apart.
- The selected block is drawn above the blocks it overlaps (`z-index: 1`), so a pause block that a later freeze's block covers can still be dragged by its body and its edge once selected.
- **Dragging:**
  - The edge sets the length. Pause: `initial + dx / px`. Continue: `viewingTime(clips, source at pointer) − editStart` (`setStillEnd`). Both snap to 0.1 s. A continue edge that E-05 snaps to a target takes whichever tenth on either side of it ends the still exactly there.
  - The body moves `at`, through `moveFreeze`.
  - Both run inside `store.beginGesture()` … `endGesture()`, and the playhead follows `at`.
- Pointer-down selects `{ kind: 'freeze', id }`.

**Selection.** In `src/renderer/src/editor/selection.ts`:
- add `{ kind: 'freeze'; id: string }`;
- add a `validSelection` case;
- `selectionKey` works through `'id' in sel`.

In `Inspector.tsx`, `TAB_FOR.freeze = 'clip'`. It is a `Record` over every kind, so TypeScript requires the entry.

**Clip panel.** New `src/renderer/src/editor/panels/FreezeSection.tsx`, rendered by `ClipPanel.tsx` below the clip section.

When no freeze is selected:
- Button `Freeze frame at playhead` (`withShortcut(…, keymap.freezeFrame)`).
- Hint: "Holds the picture so viewers can read it."
- The button is disabled with a reason, using the refusal texts below.

When a freeze is selected, a section titled `Freeze frame at 0:12.4`: the video time it starts at (`freezeVideoTime`). For a pause freeze this is its hold's start, so a freeze at the end reads the edit's end, not the video's:
- Slider `Hold for`: 0.5 to 30 s, step 0.1, value text `3.0 s`.
- Chips `Sound` (`data-testid="freeze-sound"`):
  - `Pause the sound`, titled "Adds the time to the video. The recording waits; music keeps playing."
  - `Keep the sound playing`, titled "Adds no time. The picture holds while the recording plays on." It is disabled at the very end of the video, titled "Nothing plays after the end of the video".
- Hint, by mode:
  - pause: "Adds 3.0 s to the video (now 1:42.0)."
  - continue: "The screen holds for 3.0 s. The camera and captions keep moving."
  - continue, shortened: "Holds for 1.2 s: the next freeze starts there." / "Holds for 1.2 s: the video ends there."
  - inactive: "This frame is cut out of the video, so the freeze is not shown."
  - inactive although the frame is kept (continue): "Nothing plays after the end of the video, so the picture is not held." at the very end, else "The video ends right after this frame, so the picture is not held." or "The next freeze starts right after this frame, so the picture is not held."
- Buttons:
  - `Add text on the freeze`;
  - `Delete freeze` (danger), titled `withShortcut('Remove this freeze frame', keymap.deleteSelection)`.

**Notices** (through `showNotice`):
- "The playhead is in a cut: move it onto a clip to freeze a frame"
- "There is already a freeze frame here" (and the freeze is selected)
- "The picture is already frozen here" (and that freeze is selected)
- "A project can have at most 200 freeze frames"

**Lengths.**
- `Transport.tsx` gets a `freezes` prop and shows `formatTime(videoTimeAt(clips, plan, player.time) + player.holdElapsed) / formatTime(videoDuration(clips, plan))`.
- `ClipPanel` "Video length" uses `videoDuration`.

---

## 6. Commands and shortcuts

`src/shared/editor/commands.ts`, `COMMAND_LIST`:

```ts
{ id: 'freezeFrame', title: 'Freeze frame at playhead', category: 'Add', keywords: 'hold still pause picture extend frame read freeze' },
{ id: 'toggleFreezeSound', title: 'Freeze frame: pause or keep the sound', category: 'Edit', keywords: 'freeze hold audio continue silence voice' },
```

`src/shared/editor/shortcuts.ts` `DEFAULT_KEYMAP`: `freezeFrame: ['F']`. `toggleFreezeSound` has no default key; it gets `[]` from the `COMMAND_IDS` spread.

Conflicts checked:
- `DEFAULT_KEYMAP` holds `Space`, `Home`, `End`, `Left`, `Right`, `Shift+Left`, `Shift+Right`, `Shift+PageDown`, `Shift+PageUp`, `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`, `S`, `Delete`, `Backspace`, `Z`, `T`, `Shift+T`, `M`, `0` to `4`, `Plus`, `=`, `-`, `_`, `Ctrl+E`, `Ctrl+/`, `Ctrl+K` and `Ctrl+Shift+P`. None of them is `F`.
- `RESERVED` holds `F11`, `Alt+F4` and others, all different chords.
- No raw `e.key` handler in `src/renderer/src` reads `f`. Grep found only the `chord.key === 'Space'` case in `Editor.tsx`.
- The global **recording** hotkeys in `src/shared/recording/hotkeys.ts` `DEFAULT_HOTKEYS` (stop `Ctrl+Shift+2`, pause `Ctrl+Shift+F9`, mark `Ctrl+Shift+F10`) are a different keymap, in a file the teleprompter team owns. They do not overlap.
- Other designs in this wave: E-08 takes `J`, `K`, `L`. E-05 uses Alt only while dragging. **E-10 must not take `F`.**

Both commands are in `PALETTE_COMMANDS`, since neither is `hidden`. Palette `unavailable` reasons in `Editor.tsx`:
- `freezeFrame`: the refusal texts in §5.
- `toggleFreezeSound`: "Select a freeze frame first". The command acts on the selected freeze, or else on the freeze at the playhead.

---

## 7. Undo

Each of these is **one undo step** through `store.update`:

- Add a freeze. Selecting it is not part of history.
- Delete a freeze (`Delete` or `Delete freeze`): a new `deleteSelection` branch in `Editor.tsx`.
- Switch the sound mode, with the chips or `toggleFreezeSound`.
- Drag the length, with the edge or the slider: inside `beginGesture` / `endGesture`, key `freeze-length:${id}`.
- Drag to move: key `freeze-move:${id}`.
- "Add text on the freeze". This adds an annotation only.

No-op edits return `p` and add no step. Cuts, smart speed and remove silences never change `freezes`. Undoing them makes a freeze active or inactive again. `correctProjectMedia` runs at load and is not a step.

---

## 8. Contracts (committed first as stubs and types)

| File | Export | Signature |
|---|---|---|
| `src/shared/types.ts` | `FreezeSound`, `Freeze`, `Project.freezes?` | §3 |
| `src/shared/api/export.ts` | `SoundHold`, `RecordingSound.holds?` | §3 |
| `src/shared/engine/freezeData.ts` | `readFreezes` | `(raw: unknown, duration: number) => Freeze[] \| undefined` |
| | `clampFreezes` | `(list: readonly Freeze[], duration: number) => Freeze[] \| undefined` |
| `src/shared/engine/freeze.ts` | `FREEZE`, `DEFAULT_FREEZE_SOUND`, `FREEZE_EPS`, `MAX_FREEZES`, `FREEZE_KEEP`, `newFreezeId` | §3 |
| | `Hold`, `Still`, `FreezePlan`, `NO_FREEZES` | §4.1 |
| | `freezePlan` | `(clips: readonly Clip[], freezes: readonly Freeze[] \| undefined) => FreezePlan` |
| | `planOf` | `(p: Pick<Project, 'clips' \| 'freezes'>) => FreezePlan` |
| | `videoDuration` | `(clips: Clip[], plan: FreezePlan) => number` |
| | `editToVideo` | `(plan: FreezePlan, o: number) => number` |
| | `videoToEdit` | `(plan: FreezePlan, v: number) => { edit: number; hold: Hold \| null; elapsed: number }` |
| | `videoToSource` | `(clips: Clip[], plan: FreezePlan, v: number) => { time: number; index: number; hold: Hold \| null }` |
| | `videoTimeAt` | `(clips: Clip[], plan: FreezePlan, t: number) => number` |
| | `videoFrames` | `(clips: Clip[], plan: FreezePlan, fps: number) => { times: number[]; pictures: number[]; held: Uint8Array \| null }` |
| | `pictureTime` | `(clips: Clip[], plan: FreezePlan, t: number) => number` |
| | `freezeKeepRanges` | `(freezes: readonly Freeze[] \| undefined) => { start: number; end: number }[]` (structural, so `engine` does not import `editor/smartSpeed`) |
| | `freezeSnapTargets` | `(clips: Clip[], plan: FreezePlan) => number[]` (source s: active anchors and still ends, for E-05) |
| `src/shared/editor/freezeEdit.ts` | `FreezeRefusal` | `'cut' \| 'taken' \| 'frozen' \| 'full'` |
| | `freezeAtPlayhead` | `(p: Project, t: number, init?: Partial<Pick<Freeze, 'length' \| 'sound'>>) => { project: Project; id: string } \| { refused: FreezeRefusal; id?: string }` |
| | `setFreezeLength` | `(p: Project, id: string, length: number) => Project` |
| | `setFreezeSound` | `(p: Project, id: string, sound: FreezeSound) => Project` |
| | `moveFreeze` | `(p: Project, id: string, t: number) => Project` |
| | `removeFreeze` | `(p: Project, id: string) => Project` |
| | `freezeTextRange` | `(clips: Clip[], f: Freeze) => { start: number; end: number } \| null` |
| `src/shared/render/audioPlan.ts` | `SoundPiece` | `{ start: number; end: number; speed: number; hold: number }` |
| | `soundPieces` | `(clips: readonly Clip[], holds: readonly SoundHold[]) => { pieces: SoundPiece[]; tail: number }` |
| | `pieceSampleBounds` | `(pieces: readonly SoundPiece[], rate?: number) => number[]` |
| | `RecordingPart.holds?` | `SoundHold[]` |
| `src/shared/render/chapters.ts` | `outputChapters` (extra parameter) | `(chapters: readonly Chapter[], clips: Clip[], plan?: FreezePlan) => OutputChapter[]` |
| `src/shared/captions/subtitles.ts` | `subtitleFile` (extra parameter) | `(segments: readonly CaptionSegment[], clips: readonly Clip[], format: SubtitleFormat, plan?: FreezePlan) => string` |
| `src/renderer/src/render/compositor.ts` | `drawFrame` (extra parameter) | `(ctx, w, h, t, scene, src, options?: DrawOptions, soundTime?: number) => void` (`soundTime` defaults to `t`) |
| `src/renderer/src/editor/exporter.ts` | `ThumbnailInput.soundTime?` | `number` |
| `src/renderer/src/editor/freezeStills.ts` | `FreezeStills` | `class { constructor(url: string, fps: number); get(at: number): ImageBitmap \| null; prepare(ats: readonly number[]): void; dispose(): void }` |
| `src/renderer/src/editor/player.ts` | `PreviewPlayer.holdElapsed` | `get holdElapsed(): number` |
| `src/renderer/src/editor/previewAudio.ts` | `PreviewAudio.hold` | `(h: Hold \| null, elapsed: number) => void` |

---

## 9. Files owned by this feature

**New:**

- `src/shared/engine/freeze.ts`: constants, plan, time maps, frames, keep ranges, snap targets.
- `src/shared/engine/freezeData.ts`: `readFreezes`, `clampFreezes`.
- `src/shared/editor/freezeEdit.ts`: edit operations.
- `src/renderer/src/editor/FreezeMarks.tsx` and `freeze.css`: clip-track blocks and their drags.
- `src/renderer/src/editor/panels/FreezeSection.tsx`: the inspector section.
- `src/renderer/src/editor/freezeStills.ts`: the preview still cache.
- `tests/freezeData.test.ts`, `tests/freeze.test.ts`, `tests/freezeEdit.test.ts`, `tests/e2e/freeze.e2e.cjs`.

**Modified:**

- `src/shared/types.ts` (**SHARED**, additive only): `FreezeSound`, `Freeze`, `Project.freezes?`.
- `src/shared/api/export.ts`: `SoundHold`, `RecordingSound.holds?`.
- `src/shared/engine/project.ts` (**SHARED** with E-10): `migrateProject` only. It destructures `freezes` and adds one `optional('freezes', …)` line after `chapters`.
- `src/shared/editor/clips.ts`: one line in `correctProjectMedia`.
- `src/shared/render/audioPlan.ts`: `soundPieces`, `pieceSampleBounds`, the hold branch of `recordingGraph`, and `holds` passed through in `planSoundtrack`. The no-holds path is untouched.
- `src/shared/render/chapters.ts`, `src/shared/captions/subtitles.ts`: the optional `plan` parameter.
- `src/main/exportJob.ts`: `validRecording` accepts `holds`.
- `src/renderer/src/render/compositor.ts`: the `soundTime` parameter, plus the `bgTime` and `drawCaptionsLayer` lines.
- `src/renderer/src/editor/exporter.ts`: `planJob`, `exportAudio`, `renderAll` (pictures, `held`, sound time), `soundOf`, `musicOf`, `chaptersOf`, `renderThumbnail` (`soundTime`).
- `src/renderer/src/editor/player.ts` (**SHARED** with E-08):
  - mine: the hold state, the look-ahead in `onVideoFrame`, the end hold in `leaveClip`, the guards in `onPause`, `onEnded` and `invalidate`, `syncWebcam(at, true)` on entry, picture mapping in `draw`, hold resume in `play`, `pause` and `seek`, `setProject` re-planning, and `FreezeStills` ownership;
  - E-08 owns `setRate` and the direction;
  - the shared rule: elapsed time is scaled by `previewRate`, and reverse playback skips holds.
- `src/renderer/src/editor/previewAudio.ts` (**SHARED** with E-08): `length`, `setProject`, `clipsKeyOf`, `outputAt`, `soundRanges`, the stem loop in `frame()`, and the new `hold()`. E-08 owns the rate code.
- `src/renderer/src/editor/Transport.tsx` (**SHARED** with E-08): the `freezes` prop and the time text line.
- `src/renderer/src/editor/Timeline.tsx` (**SHARED** with E-04 and E-05): one `<FreezeMarks …/>` element inside `.clip-track`, plus its props. E-05 owns the drag-snapping helpers; `FreezeMarks` calls them once they exist.
- `src/renderer/src/editor/selection.ts`, `Inspector.tsx` (**SHARED**, one case each): the `'freeze'` kind.
- `src/renderer/src/editor/panels/ClipPanel.tsx` (**SHARED** with E-01): render `<FreezeSection/>`, add `freezeKeepRanges` to `keep` (and its dependencies), use `videoDuration` for "Video length", and the `TitlesKept` copy.
- `src/renderer/src/editor/ExportDialog.tsx`, `ExportPreview.tsx`: `length`, `outputChapters` with the plan, the Frame slider mapping, and `soundTime`.
- `src/renderer/src/editor/panels/CaptionsPanel.tsx`, `TextPanel.tsx`: `subtitleFile(…, planOf(p))`, and the displayed times through `videoTimeAt`.
- `src/renderer/src/views/Editor.tsx` (**SHARED** with all E-features):
  - `actions`: `freezeFrame`, `toggleFreezeSound`, and the `deleteSelection` branch;
  - the `commands` map: two entries;
  - `paletteEntries` `unavailable`: two reasons;
  - the `freezes` prop for `Transport`.
- `src/shared/editor/commands.ts`, `shortcuts.ts` (**SHARED**): two command entries and the `F` default.
- `docs/FEATURES.md`: one Editor bullet. `docs/ROADMAP.md`: the E-11 row marked done.

Not touched, as required: `src/main/recordingIpc.ts`, `src/main/recording/**`, `src/shared/recording/**`, `views/Home.tsx`, `views/Toolbar.tsx`, `src/renderer/src/recorder/**`, the AI script-draft code, and every function in `timeline.ts`.

---

## 10. Test plan

**Unit tests (vitest).**

`tests/freezeData.test.ts`:
- Not an array → `undefined`.
- `[{id:'a', at: 2, length: 3, sound: 'pause'}]` is kept as it is.
- `at: -1` → 0, and `at: 99` with duration 10 → 10.
- `length` values: 0.2 → 0.5, 31 → 30, 2.345 → 2.3, NaN → 3.
- `sound: 'x'` → `'pause'`.
- Entries at 2.000 and 2.005 → only the first is kept.
- Two entries with the same `id` → the first is kept.
- 250 entries → 200.
- An empty result → `undefined`.
- `readFreezes(readFreezes(x)) ` deep-equals `readFreezes(x)`.
- `migrateProject` of a fixture without `freezes`: `!('freezes' in p)`, and `JSON.stringify` equals the pre-E-11 output.

`tests/freeze.test.ts`:
- The worked example (§4.3):
  - `videoDuration = 9`;
  - hold `{edit: 2, start: 2}`;
  - still `{editStart: 4.5, editEnd: 6}`;
  - `editToVideo`: 2 → 2, 2.5 → 5.5, 6 → 9;
  - `videoToEdit(3.2) = {edit: 2, elapsed: 1.2}`;
  - `videoFrames(…, 60)`: 540 frames; `times[119] ≈ 1.9833`, `times[120..299] = 2`, `times[300] = 2`, `times[420] = 6`; `pictures[449] ≈ 6.9667`, `pictures[450..539] = 7`; `held` is 1 exactly on 120–299 and 450–539.
- Identity:
  - `videoFrames(clips, NO_FREEZES, 60).times` deep-equals `exportFrameTimes(clips, 60)`, with `pictures === times` and `held === null`;
  - a plan with stills only gives the same `times`;
  - `planOf({clips})` is `NO_FREEZES`.
- An anchor in a cut is inactive.
- Two continue freezes 1 s apart (length 3): the first ends at the second's edit time.
- A continue freeze at `last.end` is inactive.
- End hold: clips `[0,4)` 1×, pause at 4, length 1, 60 fps → 300 frames, with `times[240..299] = times[239] ≈ 3.9833`.
- `videoTimeAt` at `last.end` = `videoDuration`.
- `pictureTime(clips, plan, 7.5) = 7`.
- `freezeKeepRanges([{at: 5}])` → `[{start: 4.75, end: 5.25}]`.

`tests/freezeEdit.test.ts` (capture fps 60):
- `freezeAtPlayhead` at 3.0 on full clips → `{at: 3, length: 3, sound: 'pause'}`.
- At 2.02 → `at = 2.017` (frame 121, rounded up).
- Inside the cut `[4, 6)` → `'cut'`.
- At 3.004 next to 3.0 → `'taken'` with the existing id.
- Inside an active still → `'frozen'`.
- With 200 freezes → `'full'`.
- At `last.end − 0.0005` → `at = last.end`; with `{sound: 'continue'}` it is stored as `'pause'`.
- `setFreezeLength` 0.26 → 0.5. The same value → `===` `p`.
- `moveFreeze` into a cut → `===` `p`.
- `removeFreeze` of the last freeze → no `freezes` key.
- `freezeTextRange` with clips `[0,10)` at 1× and `at = 4` → `{start: 3.5, end: 4.5}`.

`tests/audioPlan.test.ts` (additions):
- **Backwards compatibility:** for every existing fixture, `recordingGraph({ …, holds: [] }, d) === recordingGraph({ … }, d)`.
- `soundPieces([{0,4,1},{6,10,2}], [{at: 2, length: 3}])` → pieces `[0,2)/0`, `[2,4)/3`, `[6,10)/0`, tail 0. `pieceSampleBounds` → `[0, 96000, 336000, 432000]`.
- The graph contains `aresample=48000:async=1:first_pts=0`, `adelay=delays=144000S:all=1`, and `apad=whole_len=240000,atrim=end_sample=240000`.
- A hold at `last.end` → `tail = 3`, and no `adelay`.
- 200 holds build without error. `externalizeGraph` moves the graph to a script (`tests/exportArgs.test.ts`).

`tests/chapters.test.ts` and `tests/subtitles.test.ts` (additions), with a hold of 3 at source 2 on clips `[0,10)`:
- A chapter at source 5 → `start = 8`. A chapter exactly at 2 → `start = 2`.
- A cue `[1, 3)` → `[1, 6)`. A cue `[2, 2.5)` → `[2, 5.5)`. A cue `[1, 2)` → `[1, 2)`.
- With `NO_FREEZES`, both files are byte-identical to the current output.

`tests/commands.test.ts` and `tests/shortcuts.test.ts`:
- `freezeFrame` defaults to `['F']`, and no other command has `F`.
- `toggleFreezeSound` has no default key.
- Both are in `PALETTE_COMMANDS`.

`tests/exportMain.test.ts`: `validRecording` accepts `holds` within limits, and rejects `length: 31` and 201 holds.

**End to end (Playwright).** New `tests/e2e/freeze.e2e.cjs`. Build the app first, as the other e2e files require, then run it with `xvfb-run -a node tests/e2e/run-all.cjs freeze`.

Helpers reused:
- From `render-fixtures.cjs`: `fx.withHome`, `fx.indexedVideo({ seconds: 6, beeps: true })`, `fx.seedProject` (with `audio: true`), `fx.openProject`, `fx.openExportDialog`, `fx.pickChip` (export dialog rows only), `fx.waitForExport`, `fx.decodeIndices`, `fx.beepOnsets`, `fx.probe`.
- From `helpers.cjs`: `h.launch`, `h.mockSaveDialog`, `h.readProject`, `h.assert`, `h.run`.
- From `editor-fixtures.cjs`: `f.waitFor`.
- Copied, because they are local to other files:
  - `startExport`, `exportTo`, `codes` and `closeDialog` from `export.e2e.cjs`;
  - `timecode`, `outTime`, `playheadAt` (Home + `Shift+ArrowRight`), `saved` and `addItems` from `titles.e2e.cjs`.

Scenario:

1. **Seed and add.** Seed a 6 s project with one clip and audio on. Use `addItems` to add `chapters: [{id:'k0', t:0, title:'Intro'}, {id:'k1', t:4, title:'Later'}]`. Open it, `playheadAt(win, 2)`, press `f`. Then:
   - `saved(...)` shows `freezes: [{ at: 2, length: 3, sound: 'pause' }]`;
   - `[data-testid="freeze-block"]` is visible;
   - the `.timecode` total reads `0:09.0`.
2. **Undo and redo.** `Ctrl+Z`: no `freezes` key, and the total reads `0:06.0`. `Ctrl+Shift+Z`: the freeze is back.
3. **Export with the pause freeze**: `exportTo(..., { res: '720p', fps: '60 fps' })`. Then:
   - 540 video frames, and audio duration 9 ± 0.03 s;
   - the codes equal `round(t(i) · 60)` with `t(i) = v < 2 ? v : v < 5 ? 2 : v − 3`, where `v = i / 60`;
   - `beepOnsets` ≈ `[0, 1, 5, 6, 7, 8]` ± 0.03;
   - for the beep of source second `s`, `codes.lastIndexOf(s · 60) / 60` is within 0.03 s of its onset. For `s = 2` that is frame 300, at 5.0 s;
   - `ffprobe -show_chapters` gives starts `[0, 7]`.
4. **Switch to continue.** Select the block, click `[data-testid="freeze-sound"] .chip` with the text `Keep the sound playing`, and export again. Then:
   - 360 frames;
   - codes 120 for frames 120–299, then frame 300 has code 300;
   - beeps at `[0, 1, 2, 3, 4, 5]` ± 0.03;
   - chapters `[0, 4]`.
5. **Delete.** Select the block and press `Delete`. `freezes` is absent from `project.json`.

**Existing suites must pass unchanged:** `timeline`, `exportPlan`, `audioPlan` (old cases), `exportSound`, `chapters`, `subtitles`, `smartSpeed`, `project`, `commands`, `shortcuts`, and `export.e2e` (frames and sync).

---

## 11. Risks

- **Two output clocks.** Code that uses edit time where video time is meant misplaces things after a hold. Mitigation:
  - the `edit…` / `video…` names;
  - the complete consumer list in §4.4–§4.7;
  - unit tests for frames, clicks, chapters, cues and ducking;
  - the identity guards in §4.9.
- **Preview hold timing.** `video.play()` takes about 50–100 ms to resume, so a preview hold can run slightly long. The export is exact. Music follows the video clock through `PreviewAudio.hold`, and the "passed" offset stops it being pulled back after the hold.
- **Player handlers.** `onPause`, `onEnded` and `invalidate` must be guarded (§4.6). If one is missed, a hold ends playback or never redraws. The e2e scenario does not cover preview holds; a manual check list goes in the PR.
- **Still cache.** A 1080p `ImageBitmap` is about 8 MB, and a 4K one about 33 MB. 6 stills use at most about 200 MB at 4K. A still that is not ready yet shows a few live frames, in the preview only.
- **Click sounds in preview.** `ClickSoundScheduler.frame` schedules ahead by delay. A click less than one frame after `at` can sound at the start of the hold in the preview, while the export plays it after the hold.
- **Frozen overlays.** Text placed to start exactly at a pause freeze never fades in during it. "Add text on the freeze" avoids this, and the hint explains it. In a continue freeze, overlays and layout changes inside the span wait and then jump to the live time at its end. This follows from Decision 4.
- **Preview hit-testing in a continue freeze.** `sceneRect` and `playheadItems` measure at `player.time` while the picture shows `at`. Handles of a text or shape selected during a freeze may sit away from what is drawn. Accepted.
- **Hold boundaries.** Speech stops abruptly at a pause freeze, as it does at cuts today (no crossfade).
- **Shared files** (`Editor.tsx`, `Timeline.tsx`, `player.ts`, `previewAudio.ts`, `ClipPanel.tsx`): edits stay in the regions named in §9. The contracts commit lands first.

---

## 12. Later (out of scope)

- Overlays that animate during a hold: text fade-in, a slow zoom into the frozen frame, background motion. This needs a "hold elapsed" input to the compositor.
- Turning idle parts into freezes from smart speed ("hold instead of speed up").
- Lowering the music under holds, or a per-freeze music duck.
- Freezing only the camera, or only the screen, in a camera layout.
- Copy and paste of freezes (E-06), and multi-select delete.
- Remembering the last sound mode as an editor preference.
- A preview-hold e2e (timing-sensitive under Xvfb).
- The caption row times in `CaptionsPanel.tsx` in video time (`videoTimeAt`). That file belongs to the teleprompter work in this wave, which allowed only the `subtitleFile(…)` call (editing-wins.md decision 2), so the rows still show edit time.
- **Interactions with the other features in this wave:**
  - **E-05** snaps freeze edges and drags to `freezeSnapTargets`, and adds freeze anchors to its own targets.
  - **E-01** polish passes `freezeKeepRanges` to smart speed and remove silences, and reports `videoDuration` before and after.
  - **E-04** keeps the top 12 px of the clip track free for freeze blocks. A pause hold has no width in the waveform.
  - **E-10** crops held and still frames like any other frame. Stills are cached uncropped, and polish keeps both crop and freezes.
  - **E-08** scales hold time by the preview rate, and reverse playback skips holds.

---

---

## 13. As built

What the implementation does where it differs from, or adds to, the sections above.

**Engine and edits**
- `videoFrames`: a hold at the edit's end repeats the last exported frame's `times` **and** `pictures`, so a continue freeze that runs to the end keeps its still through the end hold instead of jumping to the live last frame.
- `freezeAtPlayhead`: the anchor is `ceil(max(clip.start, k / fps) · 1000) / 1000`. The design's `max(clip.start, ceil(…))` could store a non-whole-ms `clip.start`, which `readFreezes` would round into the cut before it on the next load. If that rounding reaches the clip's end (a clip ending less than 1 ms after the frame start), the clip's last whole ms is used.
- `setFreezeSound(p, id, 'continue')` returns `p` for a freeze at the edit's end ("Nothing plays after the end of the video").
- An anchor within 1 ms of `last.end` is the edit's end (`atEditEnd` and `anchorEdit` in `freeze.ts`, the same 1 ms as the playhead's snap to the end and `soundPieces`): `freezePlan`, `freezeRefusal`, `freezeTextRange` and `setFreezeSound` read it so. A freeze made at the end stores `last.end`, which after a trim or a cut is rarely whole ms, and `readFreezes` rounds it on the next load, past the end or into the last frame. Without the tolerance that freeze came back inactive, or as a hold before the last frame. `readFreezes` is unchanged: it does not see the clips. The preview's end hold shows `frameTimeFor(last.end)` whichever way the anchor was rounded.
- New exports in `freezeEdit.ts`: `freezeRefusal(p, t)` (the refusal without building a project; the Clip panel button and the palette use it), `freezeIdAt(p, t)` (the freeze the playhead is on), `FREEZE_REFUSAL_TEXT` and `atEditEnd(clips, at)`. Then, for the drags and the Clip panel (§5): `canMoveFreeze`, `setStillEnd`, `stillEndsAt`, `freezeVideoTime` and `freezeInactiveReason`.
- `soundPieces` gives each hold to the clip that contains its frame, so a hold where two clips touch (a split with different speeds) is used once. Holds in a cut are dropped.
- `noFadeOutFrom(clips, plan, fade)` (`freeze.ts`), read by `drawAnnotations` (`textOverlays.ts`): when a pause freeze holds a moment of the edit's last `ANNOTATION_FADE` seconds, a text ending at the edit's end (within 1 ms) does not fade out there. Otherwise "Add text on the freeze" on a freeze at the end gives the text `[e − 0.5, last.end]`, and every held frame draws it at the opacity of the moment it repeats: 22 % in a 30 fps export, 11 % at 60 fps, 3 % in the preview. Without such a hold, texts fade out at the end as before.

**Export**
- `ThumbnailInput` gains `held?: boolean` next to `soundTime`: a pause hold has `soundTime === time` but is still drawn with `blurSamples: 1`. `ExportPreview` gets the same two props, and both seek the camera to `soundTime` (the camera is live in a still, as in the export).
- The Export dialog's Frame slider shows, inside a hold at the edit's end, the edit's last frame (`outputToSource(clips, editLength − 1 ms)`), as the export does.

**Preview (`player.ts`, `previewAudio.ts`)**
- Entering a hold uses a window `[holdFrom, t + playbackRate · frame)` instead of `[t − ε, t + speed · frame)` plus a "passed" id check. `holdFrom` is where the previous frame's look-ahead ended (a hold is never skipped when frames drop), `from − frame / 2` after play and seek, and just past `at` after leaving a hold. `screen.playbackRate` is the element rate, so the window stays right once E-08's preview speed lands.
- `passed` keeps the `Hold`. `holdElapsed` returns its length while the playhead's edit time is not past the hold's (`!(h.edit < edit − 1e-9)`, the complement of `editToVideo`'s test), instead of `|time − at| < frame / 2`, which counted the hold twice for a frame just after `at`. `PreviewAudio.outputAt` adds the held time under the same test.
- During a hold at the edit's end, `player.time` is `frameTimeFor(last.end)`. `videoTimeAt` of the edit's end is already the video's end, so the Transport (`videoTimeAt + holdElapsed`) would otherwise show past the end. Finishing clears the hold, so the end reads as the video's length.
- `pause()` during a hold keeps `time` on the held frame (the element can sit up to 1 ms off it).
- Entering a pause hold seeks the screen to the **middle** of the held frame (`frameSeekTime(at, fps)`), as the export's element path and `FreezeStills` do, not to `frameTimeFor(at)`. Anchors are frame starts, and Chromium truncates a seek to whole µs: 2.05 s is 2.0499999… as a double and seeks 2.049999 s, which shows the frame before (Decision 13's "both pick frame `k`" did not hold for such anchors). It seeks whenever the element was playing, even when it already sits there, since a playing element can show a frame decoded ahead of its time. `time` stays `at`, and playback goes on from the middle of the frame. An end hold still seeks `frameTimeFor(last.end)`.
- New getter `heldFreeze` (the id being held); the timeline's progress fill reads it.
- A new plan during playback (any change to the clips or the freezes, for example the "Hold for" slider dragged while the hold plays) lets a hold in progress go as when it runs out: the Transport reads its end, and playback goes on past its frame, or ends after an end hold. A hold just left stays left. A plain seek would enter the same hold again from 0 on the next frame. Paused, the change is a seek, as §4.6 says, and play starts the hold from its beginning.
- `PreviewAudio.frame()` is unchanged: `startStem` does nothing while a hold is held, which covers `play`, `apply` and the drift loop. On leaving, the player calls `hold(h, h.length)` **before** `jump`, so the stems start again.
- With E-08 merged: a hold's clock runs at `|viewRate|` (never 0 while playing); resuming a paused hold re-applies the viewing rate of the clip under it and starts the soundtrack only when it is audible; starting reverse playback leaves any hold.
- `FreezeStills` takes an optional `onReady` (the paused player redraws) and stops asking for stills once its hidden video fails. A still that is not ready yet is not logged.

**UI**
- New `src/renderer/src/editor/freezeItems.ts`: `addFreezeAt`, `toggleFreezeSound`, `freezeTarget` and `addTextOnFreeze`, shared by the Clip panel and the commands, like `titleItems.ts`.
- `FreezeMarks` reads `freezes` from the store, as the timeline reads shapes, so `Timeline.tsx` only adds the element. Its `snap` prop is optional. Today `Timeline.tsx` does not pass it, because E-05's controller is not on this branch. After the merge the element needs `snap={snap}`. Moves begin `{ exclude: [{ owner: 'freeze:' + id }], noPlayhead: true }`, and so do continue-edge drags; a pause block's edge is not a source time and is not snapped. Each passes a `limit` whose `accept` keeps the snap to places the edit really takes: a move only to frames `moveFreeze` accepts (`canMoveFreeze`: not cut, not another freeze's frame), a continue edge only where its still then ends exactly (`stillEndsAt`: a target a whole number of tenths after the frame, or the next freeze or the video's end, which cut the still short). `FreezeMarks` also gets the timeline's `dragging` ref and sets it for the length of a drag, so the timeline does not scroll after the playhead that a move seeks.
- A plain click on a block selects it and moves the playhead to its frame. A cut freeze's diamond is `data-testid="freeze-inactive"`.
- Labels use the app's pause and speaker icons instead of the `⏸` character.
- The smart speed note names what it keeps: "Title cards stay…", "Freeze frames stay…" or "Title cards and freeze frames stay…".
- `CaptionsPanel.tsx` gets one import line (`planOf`) besides the `subtitleFile` call.

**Tests**
- The `readFreezes`, command and key cases of §10 are in the frozen `tests/editingWinsContracts.test.ts`, so they are not repeated. `tests/freezeData.test.ts` covers `correctProjectMedia`.
- `tests/previewFreeze.test.ts` drives the player with stand-ins (videos, sound, stills, clock): holds, preview speed, pause and play inside a hold, seek and reverse, the end hold, continue stills, and no change without freezes. It covers what the e2e cannot time under Xvfb.
- `tests/audioPlan.test.ts` also renders two holds through ffmpeg: silence on the hold frames, and each tick after a hold within 20 ms of where the video shows it.

**Docs:** `docs/FEATURES.md` and `docs/ROADMAP.md` (§9) are left to the lead (editing-wins.md decision 4).
