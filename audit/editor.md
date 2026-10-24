# Editor audit

Scope: `src/renderer/src/views/Editor.tsx`, `src/renderer/src/editor/*` (Timeline, PreviewStage, Inspector, panels, player, previewAudio, CommandPalette, ShortcutsDialog, modalFocus, focus, playheadItems, ExportDialog UI state), `src/shared/editor/*`, `src/shared/engine/project.ts` (migration).

Audited at commit `b25a136`. Baseline: `npm ci` then `npx vitest run` gives 75 files and 1066 tests, all passing. Findings were confirmed by reading the full code path. Where a finding could be run without Electron, it was also checked with a throw-away vitest probe (deleted afterwards). No source files were changed.

Findings are ordered by severity.

---

## E1 · medium · The Export dialog does not trap focus, so keyboard users can reach the editor behind it, leave the editor, and abort a running export

**Where:** `src/renderer/src/editor/ExportDialog.tsx:433-434`, which renders `role="dialog" aria-modal="true"` but never calls `useModalFocus`. Related: `src/renderer/src/views/Editor.tsx:597-608`.

**Problem:** `CommandPalette` and `ShortcutsDialog` both call `useModalFocus` (`modalFocus.ts:26`), which keeps Tab and Shift+Tab inside the dialog. `ExportDialog` adds only its own Escape listener (`ExportDialog.tsx:250-261`). Nothing makes the editor behind the dialog inert:
- The overlay blocks the mouse but not the keyboard.
- `ExportDialog` is rendered after `<Timeline>` in the DOM, so Shift+Tab from the dialog's first control moves focus to the last timeline button.
- Tab past the dialog's last control wraps to the titlebar: the Back button, the name input and Undo/Redo.
- While `exporting` is true, the editor's keydown handler returns without calling `preventDefault` (`Editor.tsx:597-608`). Enter and Space on a focused button behind the dialog therefore still activate that button natively.

**Failure scenario:**
1. Start an export (phase `running`).
2. Press Shift+Tab a few times, or Tab around, until focus reaches the titlebar's Back button.
3. Press Enter. `goBack()` flushes and calls `onClose()`, the editor unmounts, and `ExportDialog`'s unmount effect `() => abort.current?.abort()` (`ExportDialog.tsx:242`) cancels the export the user is waiting for.

The same route lets the user type into the "Recording name" input, or press Undo or Redo, while the modal is up. The project then changes behind a dialog that claims to be modal. During a run the export itself keeps its snapshot, but the dialog's length and size readouts change.

**Evidence:** `grep useModalFocus src/renderer/src/editor/*.tsx` matches only CommandPalette and ShortcutsDialog. No `inert` appears anywhere in `src/renderer/src`.

**Fix:** Use the shared trap and give it a ref. Its Escape handling already respects `defaultPrevented`, so keep `onClose` gated while running:
```tsx
const boxRef = useRef<HTMLDivElement>(null)
useModalFocus(boxRef, () => { if (!running) onClose.current() })
...
<div ref={boxRef} className={`modal export-modal ...`} role="dialog" aria-modal="true" aria-label="Export">
```
The existing capture-phase Escape effect can then go. For a stronger fix, also set `inert` on `.editor-body`, the titlebar and the timeline while `exporting`.

---

## E2 · low · Text and zooms added at the playhead go into a cut and never show

**Where:** `src/renderer/src/views/Editor.tsx:286-305` (`addZoomAt`, `addTextAt`) and `src/shared/editor/annotations.ts:222-236`.

**Problem:** `player.time` can sit inside a cut. This happens after clicking a cut or trim block, scrubbing across it, or after a cut is made around the playhead; `PreviewPlayer` documents this at `player.ts:25-26`. Shapes and spotlights handle it: `playheadItems.anchor()` moves the item to `displayTime(clips, t)`, the next kept frame, and scales its length by the clip speed. Text (`createAnnotation(player.time, …)`) and zooms (`insertZoom(p.zooms, player.time, …)`) use the raw source time instead. A cut longer than 3 s therefore swallows the new 3 s text item completely. `addTextAt` then calls `player.seek(a.start)`, which lands inside the cut, so the preview shows the next kept frame without the text. The inspector shows "Selected text", but nothing appears on the preview or in the export, and "drag the text on the preview" cannot work. A text item added in an 8× clip shows for about 0.4 s.

**Failure scenario:** Clips `[0,5]` and `[12,20]`. Click the cut block at 7 s, then press T (or click "Add text at playhead"). The annotation spans `[7,10]`, entirely inside the cut, and is invisible in the preview and in the exported video. Pressing Z does the same for a zoom.

**Fix:** Anchor the time the way shapes do:
```ts
const addTextAt = (t: number): void => {
  const at = displayTime(store.state.clips, t)
  const a = createAnnotation(at, store.state.duration)
  ...
}
// and in addZoom: addZoomAt(displayTime(store.state.clips, player.time), …)
```
Optionally also scale the default text length by `speedAt(clips, at)`, as `shapeForPlayhead` does.

---

## E3 · low · A project file with a malformed `clips` entry cannot be opened

**Where:** `src/shared/engine/project.ts:131-145` (`migrateProject`) and `src/shared/engine/timeline.ts:24`.

**Problem:** The migration filters every other item list through `objects()`, whose own comment says "a null or a number in a hand-edited file would crash the timeline". It passes `p.clips` to `normalizeClips` unfiltered, and `normalizeClips` sorts by `a.start - b.start`. A `null` or a number in the list throws.

**Failure scenario:** `project.json` contains `"clips": [null, {"id":"a","start":0,"end":5,"speed":1}]`, for example after a hand edit or a partial write by an external tool. `migrateProject` throws `Cannot read properties of null (reading 'start')` and the editor shows "Could not open this recording".

**Evidence:** Probe run:
```
migrateProject({ id:'x', duration:10, clips:[null,{…}] }) -> throws "Cannot read properties of null (reading 'start')"
```

**Fix:**
```ts
const listed = objects<Clip>(p.clips).filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end))
const clips = listed.length ? listed : [{ ...fullClip(duration), start: p.trim?.start ?? 0, end: p.trim?.end ?? duration }]
```

---

## E4 · low · Correcting the duration on open leaves shapes, spotlights, titles, chapters and layouts past the end

**Where:** `src/shared/editor/clips.ts:132-150` (`correctProjectMedia`).

**Problem:** When the file's real length differs from `project.duration`, the function clamps clips, zooms and annotations to the new duration. It leaves `shapes`, `spotlights`, `titles`, `chapters` and `layouts` untouched. If the duration shrinks, items that start after the new end never play and are drawn past the end of the timeline content (`width = duration * px`). Titles and chapters are new in Wave 3 and will be listed to users. A chapter past the end is also a likely source of wrong chapter metadata in exports.

**Failure scenario:** `project.duration` is 10, the file is 9 s long, and a shape is at `[9.5, 10]`. After opening, the shape is still `[9.5, 10]`. Probe output: `shapes after shrink [{"id":"s","start":9.5,"end":10}] titles [{"id":"t","start":9.6,"end":10}]`.

**Fix:** In the duration branch, clamp the other timed lists with the same rule used for annotations:
```ts
const clampTimed = <T extends { start: number; end: number }>(list: T[] | undefined, min: number) =>
  list?.map((x) => ({ ...x, start: clamp(x.start, 0, d), end: clamp(x.end, 0, d) })).filter((x) => x.end - x.start >= min)
// shapes: clampTimed(project.shapes, MIN_SHAPE_LENGTH), spotlights: …, titles: …, layouts: …
```
Chapters are points (`Chapter.t`), so clamp `t` to `[0, d]` only.

---

## E5 · low · "Range speed" on a range that changes nothing still adds an undo step and drops the selection

**Where:** `src/renderer/src/editor/panels/ClipPanel.tsx:93-100` and `src/shared/editor/clips.ts:69-79` (`setRangeSpeed`).

**Problem:** `setRangeSpeed` always returns a new array from `split.map(...)`, even when no clip lies fully inside the range. This happens when the range is inside a cut, or shorter than `MIN_CLIP` away from both clip edges. `store.update` only skips identical objects, so each click:
- records an empty undo step (the user's next Ctrl+Z appears to do nothing),
- marks the project dirty and triggers a save,
- clears the range selection, with no message saying the speed was not applied.

**Failure scenario:** Clips `[0,5]` and `[7,10]`. Shift+drag from 5.2 to 6.8, which lies inside the cut, then click "2×". Nothing changes on screen, but an undo step is pushed and the selection disappears. Probe: `setRangeSpeed` returns content equal to the input (`same content? true`) as a new reference (`same ref? false`).

**Fix:** Return the input when nothing changed, and tell the user:
```ts
const out = split.map(...)
return out.every((c, i) => c === clips[i]) && out.length === clips.length ? clips : out
```
In the ClipPanel handler, compare `next === p.clips`. If they are equal, return `p` and call `onNotice('Nothing in this range is in the video')` instead of clearing the selection.

---

## E6 · low · An emptied recording name can be saved and leave a blank row in the library

**Where:** `src/renderer/src/views/Editor.tsx:679-691`.

**Problem:** The "Untitled recording" fallback runs only in the input's `onBlur`. Each keystroke autosaves after 400 ms (`autosave.ts` debounce), so an empty `name` reaches disk while the field still has focus. If the window is closed or the app quits at that moment, `beforeunload` and `pagehide` call `flushSync` with the empty name, and no blur follows. The library lists `p.name` directly (`src/main/projects.ts:102`), so the row is blank. This is the case the code comment says it prevents.

**Failure scenario:** Select all in the name field, press Delete, then close the window (Alt+F4 or the window's close button). The project is saved with `name: ""` and the library shows a nameless entry.

**Fix:** Apply the fallback where the document is persisted, not only on blur. For example, in the `save` and `saveSync` adapters in `openSession`:
```ts
const named = (p: Project) => (p.name.trim() ? p : { ...p, name: 'Untitled recording' })
save: (p, meta) => window.api.saveProject(withRecordedStems(named(p), data.project), meta),
saveSync: (p, meta) => window.api.saveProjectSync(withRecordedStems(named(p), data.project), meta)
```
Alternatively, make the library fall back to "Untitled recording" for blank names.

---

## Checked and fine

- **EditStore and History** (`editStore.ts`, `engine/history.ts`): merge keys, gesture holding (a reused timestamp keeps the merge window open), `seal` on undo, redo and gesture end, history limit, and `replace` without an undo step. Undo and redo bump `revision`, so autosave always sees them.
- **Autosave** (`autosave.ts`): debounce plus max-wait, a single in-flight save with reschedule on success, exponential backoff that keeps saving the latest state, `flush` awaiting an in-flight save then saving the rest, `flushSync` on unload, `markDirty` after load corrections, and the leave-anyway confirmation in `goBack`. No path loses an edit that was made before a successful save resolves.
- **Selection validity** (`selection.ts`): every id kind is re-validated against the present project on each render, so undo or redo can never leave a dangling selection. Gaps are matched against current gaps, and ranges by length only, which is correct because ranges are free source intervals.
- **Keyboard** (`Editor.tsx` keydown, `focus.ts`, `shortcuts.ts`):
  - Text entry, including `<select>`, only gets in-text commands, Escape and Enter-to-blur.
  - Sliders keep their arrow, Home and End keys.
  - Space blurs a focused toggle so it is not activated twice.
  - Repeat filtering is per command.
  - The Shift fallback works and reserved keys are rejected.
  - Shortcut capture prevents default, so Space and Enter do not click.
  - The palette and the shortcuts dialog trap Tab, handle Escape (an inner Escape is honoured) and restore focus.
- **Timeline drag maths** (`Timeline.tsx`, `engine/timeline.ts`, `zoomEdit.ts`, `annotations.ts`, `shapes.ts`):
  - Trim drags recompute from the clips captured at pointer-down, so dragging back restores clips that were dropped.
  - Zoom drags are bounded by neighbours (`zoomDragBounds`).
  - Annotation and shape move and edge drags clamp correctly, including items already shorter than the minimum.
  - The pointer always ends the gesture: window listeners handle pointerup and pointercancel, and `holdGesture` uses capture listeners.
  - `cutRange`, `restoreRange` (merges with neighbours of the same speed), `splitAt`, `setTrimStart`/`setTrimEnd`, `stepOutput` across cuts and speeds, and the smart-speed `applySmartSpeed`/`planSmartSpeed`, which only speeds up slower parts, never removes the last clip, and re-plans after apply.
- **Playback sync** (`player.ts`):
  - Cuts are skipped with a one-frame look-ahead, and frames decoded before a jump are ignored.
  - Rate changes between adjacent clips need no seek.
  - Scrub seeks are coalesced.
  - `play()` from the end or from a cut restarts correctly.
  - Late `pause` events are guarded.
  - Clip edits while paused re-seek, and edits while playing are handled by the frame loop.
  - The webcam offset and drift correction work.
  - Click-sound scheduling is reset on pause.
  - In `previewAudio`, stem drift and rate nudge are handled, music runs on through cuts, and a seek is hard.
- **Command palette:** unavailable commands show a reason instead of running, and the entries snapshot is taken when the palette opens.
- **ShortcutsDialog:** conflict and reset questions use their own Escape. Capture ends on blur.
- **Migration of old files** (`project.ts`): v1 files (with `trim`, without clips, annotations, effects, audio or capture) migrate to valid v2 files. `webcamOffset`, `style`, `cursor` and `webcam` have existed since the first schema. New optional cursor and audio fields are defaulted by their readers (`cursorLook`, `audioLook`). Apart from E3, malformed lists are dropped.
- **Media correction on open** (`correctProjectMedia`): clips that ended at the old end follow the new one, and zooms and annotations are clamped (see E4 for the other lists).
