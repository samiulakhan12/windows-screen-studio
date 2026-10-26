# J / K / L playback and preview speed (E-08)

Part of Wave 6, "Easier editing". The shared rules for this wave (file ownership, the shared files, merge order and the keymap) are in [editing-wins.md](editing-wins.md).

## 1. What the user gets

- **J / K / L shuttle.** `L` plays forward and `J` plays backward. Pressing the same key again doubles the speed, up to three times (1×, 2×, 4×, 8× of the preview speed). `K` pauses. While `K` is held down, a tap of `L` or `J` moves one frame forward or back. `Space` works as it does today: it stops whatever is moving, and when nothing is moving it plays forward at the preview speed.
- **Preview speed.** A small "Preview speed" menu in the transport offers **0.5×, 1×, 1.5×, 2×**. It sets how fast normal playback runs, so a long recording can be reviewed quickly, with sound, at 1.5× or 2×. `>` and `<` move up and down the list.
- **Indicator.** While shuttling, a badge next to the timecode shows the direction and speed, for example "Reverse 2×" or "Forward 8× · no sound". When the preview speed is not 1×, the menu gets the accent outline.
- **None of this is an edit.** Nothing is written to the project. The export, undo and the save indicator are not affected. The preview speed lasts for the rest of the app session and is back to 1× after a restart.

---

## 2. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Preview speeds | `PREVIEW_SPEEDS = [0.5, 1, 1.5, 2]`, default 1. 1.25× and 3× are not offered. | The roadmap asks for 1.5× and 2×. 0.5× is for checking a zoom transition or a cursor glide. More choices would crowd a small menu, and the shuttle covers faster scanning. |
| 2 | Where the speed lives | A field on `PreviewPlayer`, seeded from a module variable `sessionPreviewSpeed` in `src/renderer/src/editor/player.ts`, so it carries over between editors in one app run (Home and the editor share one renderer page). **Not** in `Project`. **Not** in `editor-prefs.json`. | Outside `Project` it cannot reach the export, `presetLookOf`/`applyPreset` (`src/shared/editor/stylePresets.ts`), `src/shared/editor/styleDefaults.ts`, autosave or undo. Saving it to prefs would need a new `PrefKey` in `src/shared/api/prefs.ts` (`PREF_KEYS`, which `isKey` in `src/main/prefsIpc.ts` checks). It would also start the next day at 2× without the user noticing. |
| 3 | Shuttle ladder | Viewing rate = `dir × previewSpeed × 2^level`, with `level` 0–3 in both directions. | Because it multiplies, "tap again to go faster" always does something. With a fixed 2/4/8 ladder, the first extra tap would do nothing when the preview speed is already 2×. The highest viewing rate is 2 × 8 = 16. |
| 4 | Opposite key | `L` while reversing (or `J` while going forward) switches direction at level 0. The Premiere-style "slow down through zero" is not used. | One rule that is easy to predict and to test. |
| 5 | `K` + `J`/`L` | While `K` is held, `J`/`L` step one frame (1/30 s of output time), the same step as the arrow keys: `actions.step(±1/30)` → `stepOutput` (`src/shared/editor/clips.ts`). Holding `K`+`L` together for slow motion is in Later. | Pro editors work this way, and it reuses the arrow-key path exactly. |
| 6 | How reverse works | A loop driven by `seeked` events. Each time the screen's seek lands, the next animation frame **draws the frame that landed**. It then works out the wall-clock target in **output time** with `reversePosition(clips, fromOut, elapsed, rate)`, maps it through `outputToSource` (`src/shared/engine/timeline.ts`), and seeks there. If the target is the frame already shown, it only waits one animation frame. **Rejected:** (a) a negative `playbackRate`, which Chromium does not support; (b) feeding targets every animation frame into the existing coalesced `seekVideo`/`pendingSeek` path. `onSeeked` applies a pending seek and returns *without* calling `invalidate`, and `invalidate`'s rAF skips drawing while `screen.seeking`, so (b) would draw almost nothing until reverse stopped; (c) a GOP reverse decoder on `DecoderFrameSource`, which is built for the export (moved to Later). | One drawn frame per landed seek, so drawing can never starve. Cuts are skipped by construction because the target is in output time. The screen proxy is 60 fps with GOP 15 (`'-g', '15'` in `src/main/proxyArgs.ts`; `SCREEN_PROXY_FPS = 60` in `media.ts`), so a backward seek decodes at most 15 frames. |
| 7 | Sound in reverse | Silent. `PreviewAudio` stays paused and click sounds do not play. | Playing reversed audio buffers would be a feature of its own. Screen editors usually reverse silently. |
| 8 | Sound at other speeds | At viewing rate 1 everything behaves exactly as today, 8× clips included. At any other rate, sound is on only while the element rate (clip speed × viewing rate) is between **0.5 and 4**. Outside that range the player **pauses** `PreviewAudio` (stems, music and automation, with the `AudioContext` suspended) and mutes the screen element when no Web Audio graph exists. | The old behaviour stays identical. Pausing reuses the existing `pause()`/`play()` paths and stops stems and music from running muted at 16×, where they would drift and keep re-seeking. 0.5–4 is the range in which Chromium's time stretching is known to play sound. |
| 9 | Element rate | `clamp(clipSpeed × |view|, 1/16, 16)`. | Chromium's `playbackRate` accepts 0.0625–16 and throws outside it. Today's maximum is 8 (`MAX_SPEED` in `timeline.ts`), so the clamp only matters at the new rates. |
| 10 | Space | The `play` command is unchanged. `toggle()` stops when anything is moving (`moving`) and otherwise plays forward at level 0. | Keeps today's e2e ("Space plays after clicking a toggle", `tests/e2e/editor.e2e.cjs`) and people's habits. |
| 11 | UI | A native `<select>`, which blurs itself after a change, and a status badge, in a new component that `Transport.tsx` renders. A custom popover was rejected. | Same pattern as `.captions-select` in `CaptionsPanel.tsx`. The blur is required because `isTextEntry` (`src/renderer/src/editor/focus.ts`) treats `SELECT` as a text field, so while the menu has focus every editor shortcut, Space included, is off. |
| 12 | Default keys | `J`, `K`, `L`, `>`, `<`. | All five are free (§6). `<` and `>` are YouTube's speed keys. |
| 13 | Click sounds | `ClickSoundScheduler.frame(t, { ...clip, speed: elementRate })`. Clicks are skipped, with `clickSounds.reset()`, while sound is off. | `frame()` divides each click's `delay` and the `maxGap` test by `speed` (`src/shared/render/clickSound.ts`), so clicks still land on their frames at any rate. |
| 14 | Edit handles on the preview | Hidden while anything is moving, reverse included: `useStageView` reads `player.moving` instead of `player.playing`. | Otherwise the handles re-render on every landed reverse seek. One line. |

Size: the roadmap says S. The rate state machine, the menu and the commands are S. The reverse loop and the re-timed sound (§4.3–4.4) are most of the work, so this is closer to S–M.

---

## 3. Data model

**No change to `Project`, `src/shared/types.ts`, the project sanitisers or migrations** (`src/shared/engine/project.ts`). Old projects open and export exactly as before, because nothing they contain is read differently. "Save as default style" (`styleDefaults.ts`) and style presets (`presetLookOf`, `applyPreset`) only copy `Project` fields, so they never carry the preview speed.

New pure module `src/shared/editor/shuttle.ts`:

```ts
import type { Clip } from '../types'

/** Speeds the preview can play at; the exported video is never affected. */
export const PREVIEW_SPEEDS = [0.5, 1, 1.5, 2] as const
export type PreviewSpeed = (typeof PREVIEW_SPEEDS)[number]
export const DEFAULT_PREVIEW_SPEED: PreviewSpeed = 1

export type ShuttleDir = -1 | 0 | 1
/** J/K/L state: direction, and how many doublings above the preview speed (0..MAX_SHUTTLE_LEVEL). */
export interface Shuttle {
  dir: ShuttleDir
  level: number
}
export const STOPPED: Shuttle = Object.freeze({ dir: 0, level: 0 })
export const MAX_SHUTTLE_LEVEL = 3

export type ShuttleKey = 'reverse' | 'pause' | 'forward'
export interface ShuttleStep {
  next: Shuttle
  /** A frame step instead of a rate change (J/L tapped while K is held). */
  frameStep: -1 | 0 | 1
}

/** Chromium's playbackRate range (outside it the setter throws). */
export const MIN_ELEMENT_RATE = 1 / 16
export const MAX_ELEMENT_RATE = 16
/** Element rates the preview plays sound at when the viewing rate is not 1. */
export const AUDIBLE_RATES = { min: 0.5, max: 4 } as const
```

Persistence: `let sessionPreviewSpeed: PreviewSpeed = DEFAULT_PREVIEW_SPEED` at module scope in `player.ts`. `setPreviewSpeed` writes it, and each new `PreviewPlayer` starts from it. It lasts until the renderer page reloads. Nothing is written to disk.

---

## 4. Behaviour

### 4.1 State machine (`pressShuttle`)

| From | Key | `pauseHeld` | Next | `frameStep` |
|---|---|---|---|---|
| any | `pause` | – | `STOPPED` | 0 |
| any | `forward` | true | `STOPPED` | +1 |
| any | `reverse` | true | `STOPPED` | −1 |
| `dir 1, level n` | `forward` | false | `dir 1, level min(n+1, 3)` | 0 |
| `dir ≠ 1` | `forward` | false | `dir 1, level 0` | 0 |
| `dir −1, level n` | `reverse` | false | `dir −1, level min(n+1, 3)` | 0 |
| `dir ≠ −1` | `reverse` | false | `dir −1, level 0` | 0 |

- `viewRate(s, ps) = s.dir × ps × 2^s.level`. It is signed, and 0 when stopped.
- `elementRate(clipSpeed, view) = clamp(clipSpeed × |view|, 1/16, 16)`.
- `soundAt(clipSpeed, view)`:
  - `view === 1` → true (today's behaviour, 8× clips included);
  - `view ≤ 0` → false;
  - otherwise `0.5 ≤ elementRate(clipSpeed, view) ≤ 4`.
- `clipSpeed` is one of `SPEED_PRESETS` (0.25–8, `timeline.ts`).

When sound is on, `elementRate` is at most 4, so it is never clamped. That means output time then moves at exactly `|view|` seconds per wall second, which is the rate `PreviewAudio` needs (§4.4). When the element rate is clamped, sound is always off.

### 4.2 Forward playback at a viewing rate (`player.ts`)

- New private `audible = true`. `setRate(speed)`:
  1. Sets `screen.playbackRate` and `webcam.playbackRate` to `rate = elementRate(speed, view)`.
  2. Calls `sound.setRate(rate)` and `sound.setView(|view|)`.
  3. Re-evaluates `soundAt(speed, view)`. When the result flips while playing, sound goes off with `sound.pause()` + `sound.setSilent(true)`, or back on with `sound.setSilent(false)` + `sound.play(screen.currentTime, rate)`.
- **The element rate goes to every sound call, not only to `setRate`.** Today `seek()` (`sound.jump(from.time, clips[from.index].speed)`), `play()` (`sound.play(from.time, clips[from.index].speed)`) and `jumpTo()` (`sound.jump(time, …speed)`) pass the raw clip speed. That overwrites `PreviewAudio.speed`, which `startStem` and the `frame()` nudge use, so the stems would run at 1× under a 2× video. All three pass `elementRate(speed, view)` instead. `play()` calls `sound.play` only when `audible`.
- `onVideoFrame` changes in three places:
  - The rate check becomes `screen.playbackRate !== elementRate(clip.speed, view)`. Comparing against `clip.speed` would reset the rate on every frame.
  - The look-ahead before a cut becomes `t + elementRate × this.frame >= clip.end − 1e-4`.
  - `playClicks` runs only when `audible`, with `{ ...clip, speed: elementRate }`. Otherwise it calls `clickSounds.reset()`.
- `syncWebcam` already scales its drift tolerance by `Math.max(1, screen.playbackRate)`. No change.
- `applyRate()`: `setRate(clips[clipIndexAt(clips, this.time)].speed)`. This changes the rate mid-playback without a seek. It is used by L escalation and `setPreviewSpeed`.
- `setPreviewSpeed(ps)`:
  - sets the field and `sessionPreviewSpeed`;
  - while playing forward, calls `applyRate()`;
  - while reversing, re-anchors (§4.3);
  - calls `emit()`.
- `stopPlaying()`:
  - also resets `audible = true` and calls `sound.setSilent(false)`, so a paused editor never keeps a shuttle mute;
  - sets `shuttleState = STOPPED`.
- `play()` sets `shuttleState = { dir: 1, level: 0 }` unless it is already forward. `finish()` goes through `stopPlaying()`.

### 4.3 Reverse (`player.ts`)

New private `rev: { fromOut: number; t0: number; rate: number; raf: number } | null`.

- **Start** (`shuttle('reverse')` from stopped or forward):
  1. If playing, call `stopPlaying()`. Sound and clicks stop.
  2. Set `pendingSeek = null`.
  3. Set `rev = { fromOut: outputTimeAt(clips, time), t0: performance.now(), rate: |view|, raf: 0 }`.
  4. Call `revStep()`.
- **`revStep()`:**
  1. Compute `r = reversePosition(clips, rev.fromOut, (performance.now() − rev.t0) / 1000, rev.rate)` and set `time = r.time`.
  2. If `r.done`, call `stopReverse()` and `seek(keptBounds(clips).start)`, then return.
  3. Compute `s = frameTimeFor(r.time)`.
     - If `|screen.currentTime − s| < this.frame / 2`, set `rev.raf = requestAnimationFrame(revStep)`: the same frame, so wait.
     - Otherwise set `screen.currentTime = s` and call `reverseWebcam(s)`.
  4. Call `emit()`. The timecode and the timeline playhead follow `player.time`.
- **`onSeeked`.** As its first branch, when `rev` is set: `rev.raf = requestAnimationFrame(() => { this.draw(this.screen.currentTime); this.revStep() })`, then return. The `pendingSeek` branch is not used during reverse.
- **`reversePosition`.**
  - `out = fromOut − elapsed × rate`.
  - When `out ≤ 0`, return `{ time: keptBounds(clips).start, out: 0, done: true }`.
  - Otherwise return `{ time: outputToSource(clips, out).time, out, done: false }`.
  - Cuts are skipped. A 2× clip reverses 2 source seconds per second at "Reverse 1×".
- **Re-anchoring** (`rev.fromOut = outputTimeAt(clips, time)`, `rev.t0 = now`, `rev.rate = |view|`) happens on:
  - `seek(t)` while reversing. That covers ruler scrubs, arrows, chapter jumps and `showLayout`. In this case `seek` only sets `time` and re-anchors, with no `seekVideo`; the loop moves the video.
  - `setProject` with new clips. The existing `if (!this.playing) this.seek(this.time)` reaches the re-anchor through `seek`.
  - `J` pressed again (a new level) and `setPreviewSpeed`. Without a re-anchor, changing `rate` would make the position jump.
- **Camera.** `reverseWebcam(s)` seeks the camera to `s − webcamOffset` only when `!cam.seeking`, after `holdWebcam(cam)`. A forced seek on every step would restart the camera's seek before it lands, which is the starvation `syncWebcam`'s comment describes. `holdWebcam`'s guard is not changed. While the camera seeks, `draw()` already uses the held picture through `seekingWebcamPicture`. `onWebcamSeeked` releases it as today.
- **Frame rate.** One drawn frame per landed seek, so at most one per display frame. With GOP-15 proxies that is expected to be 20–60 fps at 1080p (to be measured). Higher reverse rates show frames further apart in time but stay in step with the wall clock.
- **Stopping.** `stopReverse()` does three things:
  1. cancels `rev.raf` and sets `rev = null`;
  2. sets `shuttleState = STOPPED`;
  3. calls `seekVideo(frameTimeFor(displayTime(clips, time)))`, so the paused frame matches the timecode even when a seek was still in flight.

  `pause()` (which returns early today unless `playing`), `play()`, `dispose()` and a forward `shuttle` call it. `toggle()` tests `moving`. `getPlaying` returns `moving`, so the Transport button shows Pause during reverse. `onPause` is unaffected because the element is already paused.

### 4.4 Sound (`src/renderer/src/editor/previewAudio.ts`)

- New field `view = 1`. `setView(rate)` stores it, and while playing calls `schedule()` (to re-time the automation) and `syncMusic(false)`.
  - `ramp()` uses `linearRampToValueAtTime(k.gain, now + (k.t − out) / this.view)`, so fades and ducking stay on the output timeline at any rate.
  - `frame()`: the anchor drift test becomes `a.out + (g.ctx.currentTime − a.ctx) × this.view − out`.
  - `syncMusic`: on a hard sync, `music.el.playbackRate = this.view`; otherwise `setRate(music.el, this.view × nudge(drift, MUSIC_NUDGE))`. Music follows output time, which now moves at `view` per wall second. `HORIZON` stays in output seconds.
- New field `silent = false`. `setSilent(on)` stores it and, when there is no graph, calls `applyElementOnly()`. That function now sets `screen.muted = silent || !hasAudio || muted || volume <= 0`. With a graph, the screen element's track reaches the speakers only through the `AudioContext`, which `pause()` suspends, so no extra node is needed.
- Stems get the element rate through `play`/`jump`/`setRate` (`this.speed`), now that every caller passes it (§4.2). Nothing else changes.

### 4.5 Preview = export

- Every drawn frame is still `drawFrame(ctx, w, h, t, scene, …)` (`src/renderer/src/render/compositor.ts`) at a source time `t`:
  - forward: `meta.mediaTime`;
  - reverse: the landed `currentTime`.
- That is the same pure function used for paused scrubbing and for the export. Motion blur scales its shutter by `speedAt(project.clips, t)` and `frameInterval` (`motionSamples`), never by the playback rate.
- The export (`src/renderer/src/editor/exporter.ts`) takes frame times from `exportFrameTimes(clips, fps)`. Its audio speed comes from `atempoChain`/`atempoStages` (`src/shared/render/audioPlan.ts`). It never imports `PreviewPlayer`.
- No exporter, compositor, `src/shared/render/*` or `src/shared/engine/*` file changes.
- If E-11 adds held time to the output timeline, it should do so inside `outputToSource`/`sourceToOutput`/`outputTimeAt`. Reverse, the timecode and stepping already go through those functions.

### 4.6 Edge cases

| Case | Behaviour |
|---|---|
| `J` at the start (`outputTimeAt(clips, time) ≤ 1e-3` and not reversing) | Notice "At the start: nothing to play backwards". The state does not change. Checked in `Editor.tsx` before `player.shuttle`. |
| `L` at the end | `play()` already restarts from `clips[0].start`. Level 0. |
| Forward reaches the end | `finish()` → `stopPlaying()` sets `STOPPED`. |
| 8× clip × "Forward 4×" | The element plays at 16 (capped from 32). The badge shows the viewing rate, "Forward 4× · no sound". |
| High rates | Chromium drops frames. Frames that land in a cut are never drawn (`onVideoFrame` jumps before drawing). At an element rate of 16 with a 60 fps proxy, up to 16/60 ≈ 0.27 s at each clip end is skipped while viewing. |
| Export dialog opens / Back | `openExport` and `goBack` call `player.pause()`, which now also stops reverse. |
| `K` held and keyup lost (Alt+Tab) | The held flag is cleared on window `blur`. |
| Auto-repeat | `J`/`L`/`K` have no `repeat`, so holding a key does not escalate (`if (e.repeat && !commandInfo(id).repeat) return` in `Editor.tsx`). |
| Edit during reverse (split, undo, polish) | `setProject` → `seek(time)` re-anchors on the new clips. |
| User had already bound J/K/L/`<`/`>` to another command | `resolveKeymap` gives the user's own choices priority. The new command then has no key, and the user can bind one in the shortcuts dialog. |

---

## 5. UI and copy

**New file `src/renderer/src/editor/PreviewSpeed.tsx`** exports `PreviewSpeedControl`.
- It imports a new `./previewSpeed.css`, as `CaptionTrack.tsx` imports `captions.css`, so `editor.css` is not touched.
- It uses `useEditor()` and `useKeymap()`, and reads `useSyncExternalStore(player.subscribe, player.getShuttleKey)`. `getShuttleKey` returns a string such as `"1|2|1.5|0"` (dir|level|speed|silent). React re-renders only when that string changes, never on every frame.

`Transport.tsx` renders `<PreviewSpeedControl />` between `.timecode` and `.notice-slot`. Its props do not change. `.notice-slot` stays `flex: 1`.

**Badge** `<span className="shuttle-badge" role="status" aria-live="polite" data-dir="reverse|forward">`:
- Shown only when `shuttleLabel(...)` is not null, that is while reversing, or going forward at level > 0.
- Text examples: "Reverse 1×", "Reverse 2×", "Forward 4×", "Forward 12×" (1.5 × 8).
- " · no sound" is added only going forward, when sound is off and the project has sound (`hasAudio`, music with volume > 0 (`audioLook`), or `cursorLook(project.cursor).clickSound`). The player works this out and puts it in the key.
- Tooltip: "J plays backwards, K pauses, L plays forward; press again to go faster. Hold K and tap J or L to step one frame. No sound in reverse or above 4×." The key letters come from the keymap (`shortcutLabel`), and parts whose command has no key are left out.

**Speed menu** `<label className="preview-speed" data-changed={ps !== 1}>`:
- Contents: `<EditorIcon name="speed" size={14} />` (the `speed` path exists in `EditorIcon.tsx`) and `<select aria-label="Preview speed">` with options "0.5×", "1×", "1.5×", "2×" (values `"0.5"`, `"1"`, `"1.5"`, `"2"`).
- `onChange`: `const v = Number(e.target.value); if (isPreviewSpeed(v)) player.setPreviewSpeed(v); e.currentTarget.blur()`. The blur gives Space, J, K and L back to the editor at once (see Decision 11).
- Tooltip: "Preview speed: play the preview faster or slower to review it (< slower, > faster). The exported video keeps its own speed." The key labels come from `shortcutLabel(keymap.previewSpeedDown[0])` and `shortcutLabel(keymap.previewSpeedUp[0])`, and are left out when unbound.
- `data-changed` gives it the accent outline.
- It is never disabled.

**Notices** (Editor `showNotice`):
- `>`/`<`: "Preview speed 1.5× (the export is not affected)".
- At the limits: "The preview already plays at its fastest speed (2×)" and "The preview already plays at its slowest speed (0.5×)".
- `J` at the start: "At the start: nothing to play backwards".

The play button's tooltip and the timecode do not change. The timecode already updates on every `emit`, reverse included.

---

## 6. Commands and shortcuts

Appended to `COMMAND_LIST` (`src/shared/editor/commands.ts`), category `Playback`, after `prevChapter`:

| id | Title | Keywords | Default key (`shortcuts.ts`) |
|---|---|---|---|
| `shuttleReverse` | Play backwards (again: faster) | reverse rewind backwards shuttle j | `J` |
| `shuttlePause` | Pause | stop hold shuttle k | `K` |
| `shuttleForward` | Play forward (again: faster) | fast forward shuttle speed l | `L` |
| `previewSpeedUp` | Faster preview speed | playback rate review quick 1.5x 2x | `>` |
| `previewSpeedDown` | Slower preview speed | playback rate slow motion 0.5x | `<` |

None of these has `repeat`, `inText`, `toggle` or `hidden`.

In the palette memo, `unavailable` holds:
- `previewSpeedUp`: "Already the fastest preview speed (2×)" at 2×;
- `previewSpeedDown`: "Already the slowest preview speed (0.5×)" at 0.5×.

**Palette ranking.** A copy of `commands.ts` with these rows was run through `searchCommands`:
- "reverse" → `shuttleReverse` first;
- "preview speed" → both speed commands first;
- "pause" → `shuttlePause`, then "Play / pause";
- "speed" → the two preview speed commands narrowly above "Smart speed".

Every query in `tests/commands.test.ts` and every `runCommand` query in `tests/e2e/*.e2e.cjs` still ranks the same first title.

**Conflicts checked** against `DEFAULT_KEYMAP`:
- Existing keys: Space, Home, End, Left, Right, Shift+Left, Shift+Right, Shift+PageDown, Shift+PageUp, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, S, Delete, Backspace, Z, T, Shift+T, M, 0–4, Plus, =, -, _, Ctrl+E, Ctrl+/, Ctrl+K, Ctrl+Shift+P. None of them is J, K, L, `<` or `>`.
- `Ctrl+K` (palette) is its own exact chord. `matchShortcut` only falls back by dropping Shift, never Ctrl.
- Shift+J, Shift+K and Shift+L fall back to J, K and L. That is intended.
- `<` and `>` are in `SYMBOLS`, so `chordFromEvent` drops Shift and they match by character (Shift+, and Shift+. on US layouts; the `<` key on German and French layouts). On layouts where they need AltGr, Chromium reports Ctrl+Alt and they do not match. Users can rebind them.
- None of the five is in `RESERVED`, so `checkShortcut` accepts them.
- No other renderer keydown handler uses these keys. `ExportDialog.tsx` and `modalFocus.ts` handle their own keys, and editor shortcuts are off while a dialog or the export is open.
- The recording's global hotkeys (`DEFAULT_HOTKEYS` in `src/shared/recording/hotkeys.ts`: Ctrl+Shift+2, Ctrl+Shift+F9, Ctrl+Shift+F10) all have modifiers. The teleprompter team owns that file and `recordingIpc.ts`, and nothing here touches them. Their scroll hotkeys are `globalShortcut`s. If they ever stay registered outside recording and use unmodified letters, they would steal J/K/L from the editor, so they should keep modifiers or unregister when recording ends.
- Other E-features in this wave should not take J, K, L, `<` or `>` as defaults.

**K-held detection** (`src/renderer/src/views/Editor.tsx`):
- A component-level `const pauseHeld = useRef<string | null>(null)`, so both the `commands` memo and the keyboard effect can see it.
- In `onKeyDown`, just before the `e.repeat` return: `if (id === 'shuttlePause' && !e.repeat) pauseHeld.current = e.code`.
- In `onKeyUp`, as the first statement so no early return can skip it: `if (e.code === pauseHeld.current) pauseHeld.current = null`.
- A window `blur` listener clears it.
- Because the held key is tracked by `code`, this keeps working when the pause key is rebound.
- The commands call `player.shuttle(key, pauseHeld.current !== null)` and apply `frameStep` with `actions.step(frameStep / 30)`.

---

## 7. Undo

**Nothing is an undo step.** No shuttle or speed command calls `store.update`, so the history, `canUndo` and `Autosaver` are untouched, and the save state stays "saved". `K` + `J`/`L` frame steps are seeks, like the arrow keys.

---

## 8. Contracts (committed first; bodies may be stubs)

| File | New exports and signatures |
|---|---|
| `src/shared/editor/shuttle.ts` | `PREVIEW_SPEEDS`, `type PreviewSpeed`, `DEFAULT_PREVIEW_SPEED`, `type ShuttleDir`, `interface Shuttle`, `STOPPED`, `MAX_SHUTTLE_LEVEL`, `type ShuttleKey`, `interface ShuttleStep`, `MIN_ELEMENT_RATE`, `MAX_ELEMENT_RATE`, `AUDIBLE_RATES`;<br>`pressShuttle(s: Shuttle, key: ShuttleKey, pauseHeld?: boolean): ShuttleStep`;<br>`viewRate(s: Shuttle, previewSpeed: number): number`;<br>`elementRate(clipSpeed: number, view: number): number`;<br>`soundAt(clipSpeed: number, view: number): boolean`;<br>`formatRate(r: number): string`;<br>`shuttleLabel(s: Shuttle, previewSpeed: number, silent?: boolean): string \| null`;<br>`nextPreviewSpeed(cur: PreviewSpeed, step: 1 \| -1): PreviewSpeed \| null`;<br>`isPreviewSpeed(v: unknown): v is PreviewSpeed`;<br>`reversePosition(clips: Clip[], fromOut: number, elapsed: number, rate: number): { time: number; out: number; done: boolean }` |
| `src/renderer/src/editor/player.ts` | `PreviewPlayer`:<br>`get previewSpeed(): PreviewSpeed`;<br>`get shuttleState(): Shuttle`;<br>`get reversing(): boolean`;<br>`get moving(): boolean`;<br>`get viewRate(): number`;<br>`getShuttleKey: () => string`;<br>`setPreviewSpeed(speed: PreviewSpeed): void`;<br>`shuttle(key: ShuttleKey, pauseHeld?: boolean): ShuttleStep`.<br>`getPlaying` now returns `moving`. `pause()` and `toggle()` also act on reverse. |
| `src/renderer/src/editor/previewAudio.ts` | `PreviewAudio.setView(rate: number): void`;<br>`PreviewAudio.setSilent(on: boolean): void` |
| `src/renderer/src/editor/PreviewSpeed.tsx` | `PreviewSpeedControl(): JSX.Element` (memo) |
| `src/shared/editor/commands.ts` | `CommandId` gains `shuttleReverse`, `shuttlePause`, `shuttleForward`, `previewSpeedUp`, `previewSpeedDown` |
| `src/shared/editor/shortcuts.ts` | `DEFAULT_KEYMAP` gains `shuttleReverse: ['J']`, `shuttlePause: ['K']`, `shuttleForward: ['L']`, `previewSpeedUp: ['>']`, `previewSpeedDown: ['<']` |

---

## 9. Files owned by this feature

**Create**
- `src/shared/editor/shuttle.ts`: the pure state machine, rates, sound rule, labels and reverse position.
- `src/renderer/src/editor/PreviewSpeed.tsx`: the speed menu and the shuttle badge.
- `src/renderer/src/editor/previewSpeed.css`: `.preview-speed` and `.shuttle-badge`.
- `tests/shuttle.test.ts`: unit tests (§10).
- `tests/e2e/preview-speed.e2e.cjs`: the e2e scenario (§10).

**Modify**
- `src/renderer/src/editor/player.ts` (**SHARED with E-11 freeze frame**):
  - `setRate`, plus the element rate passed to `sound.play`/`sound.jump` in `seek`, `play` and `jumpTo`;
  - in `onVideoFrame`: the rate check, the look-ahead and the `playClicks` gate;
  - `applyRate`, `setPreviewSpeed`, `shuttle`;
  - reverse: `rev`, `revStep`, `stopReverse`, `reverseWebcam`, and the first branch of `onSeeked`;
  - the `seek` re-anchor branch;
  - `pause`/`toggle`/`play`/`stopPlaying`/`dispose`;
  - `getPlaying`/`getShuttleKey`.

  If E-11 holds frames with a wall-clock timer during forward playback, the timer should last `hold / |player.viewRate|`.
- `src/renderer/src/editor/previewAudio.ts` (**SHARED with E-11**): `setView`, `setSilent`, `applyElementOnly` (the `silent` term), `ramp` (÷ `view`), the drift test in `frame`, and the two music rate lines in `syncMusic`. E-11's "sound paused during a freeze" should reuse `pause()`/`play()` the way §4.2 does, not the `master` gain, which carries the fades.
- `src/renderer/src/editor/Transport.tsx` (**SHARED**, e.g. with E-01 if it adds a button): one import and `<PreviewSpeedControl />` after the `.timecode` span.
- `src/renderer/src/editor/PreviewStage.tsx` (**SHARED with E-10 crop**): one line in `useStageView`, `player.playing` → `player.moving`. A crop overlay from E-10 should test `player.moving` too.
- `src/renderer/src/views/Editor.tsx` (**SHARED with all E-features**):
  - five entries in the `commands` map;
  - the `pauseHeld` ref and its keydown, keyup and `blur` handling in the keyboard effect;
  - two `unavailable` entries in `paletteEntries`.
- `src/shared/editor/commands.ts` (**SHARED**): five rows appended after `prevChapter`.
- `src/shared/editor/shortcuts.ts` (**SHARED**): five `DEFAULT_KEYMAP` lines after `prevChapter`.
- `tests/shortcuts.test.ts` and `tests/commands.test.ts` (**SHARED**): added cases only.
- `docs/FEATURES.md`: one bullet under the editor: "J / K / L shuttle and preview speed (0.5×–2×), preview only".
- `docs/ROADMAP.md`: mark E-08 shipped.

No teleprompter-owned file is touched (`src/main/**` recording windows, `recordingIpc.ts`, `src/shared/recording/**`, `Home.tsx`, `Toolbar.tsx`, `src/renderer/src/recorder/**`).

---

## 10. Test plan

**`tests/shuttle.test.ts` (vitest)**

`pressShuttle`:
- `STOPPED` + `forward` → `{1,0}`, `frameStep` 0.
- `forward` four more times → levels 1, 2, 3, 3.
- `{1,2}` + `reverse` → `{-1,0}`.
- `{-1,1}` + `reverse` → `{-1,2}`.
- `{-1,2}` + `pause` → `STOPPED`.
- `STOPPED` + `forward` with `pauseHeld` → `STOPPED`, `frameStep: 1`.
- `{1,2}` + `reverse` with `pauseHeld` → `STOPPED`, `frameStep: -1`.

`viewRate`:
- `({1,0}, 1.5)` = 1.5
- `({1,3}, 2)` = 16
- `({-1,1}, 1)` = −2
- `(STOPPED, 2)` = 0

`elementRate`:
- `(8, 4)` = 16 (capped from 32)
- `(0.25, 0.5)` = 0.125
- `(1, -2)` = 2
- `(0.25, 0.125)` = 0.0625 (capped from 0.03125)

`soundAt`:
- `(8, 1)` = true (unchanged behaviour)
- `(1, 2)` = true
- `(1, 4)` = true (boundary)
- `(2, 4)` = false (8)
- `(0.75, 0.5)` = false (0.375)
- `(1, 0.5)` = true (boundary)
- `(1, -1)` = false

`shuttleLabel`:
- `(STOPPED, 1)` = null
- `({1,0}, 2)` = null
- `({1,1}, 1)` = "Forward 2×"
- `({-1,0}, 1)` = "Reverse 1×"
- `({-1,0}, 1, true)` = "Reverse 1×" (no suffix in reverse)
- `({1,3}, 1.5)` = "Forward 12×"
- `({1,3}, 1, true)` = "Forward 8× · no sound"

`formatRate`: 0.5 → "0.5×"; 1 → "1×"; 1.5 → "1.5×"; 16 → "16×".

`nextPreviewSpeed`:
- `(1, 1)` = 1.5
- `(2, 1)` = null
- `(1, -1)` = 0.5
- `(0.5, -1)` = null

`isPreviewSpeed`: `1.5` → true; `3` → false; `"1"` → false.

`reversePosition` with clips `[{start 0, end 4, ×1}, {start 6, end 10, ×2}]` (output length 6; `fromOut` 5 is source 8):
- elapsed 0.5, rate 1 → out 4.5, time 7
- elapsed 2, rate 1 → out 3, time 3 (crosses the cut 4–6)
- elapsed 1, rate 2 → out 3, time 3
- elapsed 6, rate 1 → done, time 0

**`tests/shortcuts.test.ts`** (rows added to the `cases` of "default keymap: every key the editor always had"):
- `ev('j','KeyJ')` → `shuttleReverse`
- `ev('k','KeyK')` → `shuttlePause`
- `ev('l','KeyL')` → `shuttleForward`
- `ev('L','KeyL',{shiftKey:true})` → `shuttleForward`
- `ev('>','Period',{shiftKey:true})` → `previewSpeedUp`
- `ev('<','Comma',{shiftKey:true})` → `previewSpeedDown`
- The existing `ev('k','KeyK',{ctrlKey:true})` → `commandPalette` row stays and covers the Ctrl+K check.
- The existing "has no conflicts and only valid, non-reserved shortcuts" test covers the new defaults.
- New: `resolveKeymap({ split: ['L'] }).shuttleForward` equals `[]` (a user's own binding wins).

**`tests/commands.test.ts`**:
- The five ids are in `PALETTE_COMMANDS` with category `Playback`.
- `titles('reverse')[0]` is "Play backwards (again: faster)".
- `titles('preview speed').slice(0, 2)` contains both speed titles.
- `titles('  Smart  SPEED ')[0]` is still "Smart speed: find idle parts" (the existing row).

**E2E `tests/e2e/preview-speed.e2e.cjs`**

Setup:
- Reuse `h.run`, `h.launch`, `h.tempHome`, `h.readProject`, `h.assert`, `h.sleep` (`helpers.cjs`) and `f.seedProject`, `f.openProject`, `f.waitFor` (`editor-fixtures.cjs`).
- Copy from `editor.e2e.cjs`: `setup` (with the `window.__videos` hook; `commands.e2e.cjs`'s `setup` lacks it), `waitSaved`, `timecode`, `outTime`, `isPlaying`, `video`.
- Copy from `commands.e2e.cjs`: `notice` and `playheadAt`.

Scenario "preview speed and J/K/L never change the project":
1. Seed `{ name: 'Shuttle', seconds: 60, width: 320, height: 180, fps: 30, audio: true }`. A 12 s video would reach its end within about 1.5 s at 8× and `finish()` would clear the badge mid-check. Open the project and `waitSaved`. Save `clips0 = disk().clips`.
2. `selectOption('select[aria-label="Preview speed"]', '2')`. Assert that `document.activeElement` is not the select (the blur). Press Space and wait for `isPlaying`. Assert `video().rate === 2`. After `h.sleep(1500)` the timecode has moved at least 2.2 s. Press Space.
3. Select `1`, then press `Home`.
   1. Press `l`: playing, `rate === 1`, no `.shuttle-badge`.
   2. Press `l`: the badge reads "Forward 2×" and `rate === 2`.
   3. Press `l` twice more: "Forward 8× · no sound", `rate === 8`, `video().muted === true`.
   4. Press `l` once more: still "Forward 8×".
   5. Press Space: stopped, badge gone, `video().muted === false` (no mute left behind).
4. `playheadAt(8)`, then `j`.
   1. The badge reads "Reverse 1×", `isPlaying` is true and `video().paused === true`.
   2. After `h.sleep(1500)`, `outTime` is between 5.5 and 7.6, and `video().t` is below 8, which proves frames are being drawn and seeks are landing.
   3. Press `k`: not playing, badge gone.
5. `playheadAt(3)`, then `f.waitFor` until `video().t` is within 0.01 of 3. Run `keyboard.down('k')`, three `press('l')`, then `keyboard.up('k')`. Wait until `video().t` is within 0.02 of 3.1. It is not playing.
6. Press `>` twice: first the notice "Preview speed 1.5× (the export is not affected)", then the 2× notice. A third press shows "The preview already plays at its fastest speed (2×)".
7. Press `Home`, then `j`: the notice "At the start: nothing to play backwards".
8. Check that nothing reached the project:
   - `.save-state[data-state="saved"]` is shown;
   - `disk().clips` deep-equals `clips0`;
   - no top-level key of `disk()` matches `/preview|shuttle/i`;
   - `button[aria-label="Undo"]` is disabled.

---

## 11. Risks

- **Reverse smoothness depends on seek speed.** On 4K proxies or slow GPUs, reverse may show about 10 fps. It still keeps time, because the target follows the wall clock. Measure on a real Windows PC. A GOP-cached decoder is in Later.
- **Chromium's own audio limits** may not match the 0.5–4 rule. Outside 1× the player decides explicitly, so the video track, stems and music always agree. At 1× nothing changes. Unverified on Windows until checked.
- **Capped element rate.** On 8× clips at "Forward 4×" or more, the badge (the viewing rate) overstates the real speed. This affects viewing only.
- **Automation re-timing.** A missed `schedule()` after a rate change would put fades or ducking at the wrong moment. `setView` always reschedules, and the drift test in `frame()` is scaled by `view`, so a stale anchor corrects itself within `ANCHOR_DRIFT`.
- **Menu focus.** If the user opens the select and dismisses it without choosing, it keeps focus and shortcuts wait until Esc or a click elsewhere, as with the inspector's selects today.
- **Timeline follow in reverse.** `followScroll` (`src/shared/editor/timelineScale.ts`) places a playhead that leaves on the left at 10% of the viewport, so a long reverse pages about every 10% of the width. It works but looks jumpy. A fix is in Later, because `Timeline.tsx` is shared with E-04 and E-05.
- **Merge conflicts** in the shared files:
  - `player.ts` and `previewAudio.ts` with E-11;
  - `Editor.tsx`, `commands.ts` and `shortcuts.ts` with every E-feature;
  - `PreviewStage.tsx` with E-10.

  E-08 only appends rows and makes narrow, named edits. Its rate changes should land before E-11's hold timer.
- **Forgetting that the speed is 2×.** The menu has the accent outline when the speed is not 1×, and the speed resets on restart.
- **Lost `K` keyup.** It is cleared on `blur`. At worst, one `L` becomes a frame step.
- **Size.** The reverse loop and the sound re-timing push this beyond the roadmap's S. If time is short, ship the preview speed and `L`/`K` first, and `J` second, since `J` is self-contained in `revStep`/`stopReverse`.

---

## 12. Later (out of scope)

- Holding `K`+`L` or `K`+`J` for slow motion at ¼ speed, as in Avid.
- Smooth reverse: decode a GOP forward with `DecoderFrameSource` and show it backwards.
- Reversed audio, and sound with pitch kept above 4×.
- A reverse-aware `followScroll` that places the playhead at 90% of the viewport while reversing.
- Remembering the preview speed across restarts (a `preview` `PrefKey`), if users ask for it.
- Shuttle in the export dialog's preview (`ExportPreview.tsx`).
- Frame-exact stepping at the proxy's frame rate, together with E-09 "Nudge by one frame". Today's step is 1/30 s.

---
