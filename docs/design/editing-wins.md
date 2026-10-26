# Easier editing, Wave 6 (E-01, E-04, E-05, E-08, E-10, E-11)

Status: design and contracts on `feat-w6-editing-wins`; implementation in six parallel
workstreams (see [Work split](#5-work-split)). Roadmap: `docs/ROADMAP.md`, "Easier editing".

This wave adds six editing features. Each has its own design, reviewed against the code:

| Id | Feature | Design | Size |
|---|---|---|---|
| E-01 | Polish in one click | [polish-in-one-click.md](polish-in-one-click.md) | S–M |
| E-04 | Audio waveform on the timeline | [timeline-waveform.md](timeline-waveform.md) | S |
| E-05 | Snapping | [snapping.md](snapping.md) | S |
| E-08 | J / K / L playback and preview speed | [shuttle-and-preview-speed.md](shuttle-and-preview-speed.md) | S–M |
| E-10 | Crop the recording in the editor | [crop-in-editor.md](crop-in-editor.md) | M |
| E-11 | Freeze frame | [freeze-frame.md](freeze-frame.md) | M |

The teleprompter (NW-02, [teleprompter.md](teleprompter.md)) is built at the same time on
another branch. This document records how the two waves stay out of each other's way.

The rules the earlier waves set still hold:
- Every visual is a function of source time, so preview, scrubbing and export agree.
- Every edit is one undo step.
- Projects made before this wave open, preview and export exactly as before.

---

## 1. Decisions across the wave

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Teleprompter files | This wave does not edit any file the teleprompter's work split owns or freezes (teleprompter.md §9), with one exception, below: `src/main/notes/**`, `src/main/recordingIpc.ts`, `src/main/recording/**`, `src/main/cursorTracker.ts`, `src/main/aiIpc.ts`, `src/main/projects.ts`, `src/shared/notes/**`, `src/shared/recording/**`, `src/shared/api/{notes,recording,ai}.ts`, `src/shared/api.ts`, `src/preload/**`, `src/main/index.ts`, `src/renderer/src/main.tsx`, `views/Home.tsx`, `views/Toolbar.tsx`, `views/NotesWindow.tsx`, `recorder/**`, `notes/**`. | The merge stays mechanical. |
| 2 | The one shared teleprompter file | `src/renderer/src/editor/panels/CaptionsPanel.tsx`: E-11 changes **only** the `subtitleFile(…)` call (it passes the freeze plan). The teleprompter adds its "Your script" section in another part of the file. | Subtitle files must follow pause freezes. One call line merges cleanly. |
| 3 | `types.ts` and `project.ts` | The teleprompter froze them after its contracts commit, and ours is the only other change. E-10 adds `Project.crop` after `capture`. E-11 adds `FreezeSound`, `Freeze` and `Project.freezes` after `chapters`. Both are sanitised in `migrateProject`, in this wave's contracts commit. | Additive, in regions the teleprompter did not touch. |
| 4 | Docs | `docs/FEATURES.md`, `docs/ROADMAP.md` and `docs/IMPLEMENTATION.md` are edited once, by the lead, after the six workstreams are merged. Workstreams do not edit them. | The teleprompter edits the same three files. One additive commit at the end is the easiest merge. |
| 5 | Commands and keys | Every new command id and default key is added in the contracts commit (section 3). Workstreams fill the handlers. | `Editor.tsx`'s `commands` map is `Record<CommandId, () => void>`, so every id needs an entry from the start. One place checks the keymap for conflicts. |
| 6 | Time model | Source time stays the base. E-11 adds **video time** as a layer over today's output ("edit") time (`freeze.ts`). Only the player clock, export frames and sound, file times (subtitles, chapters) and displayed times read it. `timeline.ts` is unchanged. | Overlays, snapping (E-05), the waveform (E-04), smart speed and the director keep working in source and edit time. |
| 7 | Coordinate model | E-10 keeps every stored position relative to the **full** recorded frame and draws through `cropView(project, track)` (`crop.ts`). | Projects without a crop are untouched, and narrowing then widening a crop never moves anything. |
| 8 | Polish and the other features | E-01 calls `regenerateInFrame` / `cropView` (E-10) for auto zoom and the director, and adds `freezeKeepRanges(project.freezes)` (E-11) to its keep ranges. | Polish must keep the crop and must not cut a freeze. |
| 9 | Snapping targets | E-05 adds freeze anchors from `freezeSnapTargets(clips, planOf(p))` (E-11, source seconds). | One function owned by E-11; E-05 does not know freeze internals. |
| 10 | Player state | `PreviewPlayer` gains `moving` and `viewRate` (E-08) and `holdElapsed` (E-11). The contracts commit adds them with today's behaviour (`moving` = `playing`, `viewRate` = 1, `holdElapsed` = 0). A pause hold lasts `length / |viewRate|` seconds of wall clock; reverse playback skips holds. | E-10's crop overlay and E-11's holds read them before E-08 lands. |

---

## 2. Shared files and who changes what

A file not listed here belongs to exactly one feature (see each design's "Files owned").
For each shared file, each feature changes only the region named. Conflicts at merge time are
resolved by the lead.

| File | E-01 | E-04 | E-05 | E-08 | E-10 | E-11 |
|---|---|---|---|---|---|---|
| `src/renderer/src/views/Editor.tsx` | dialog state, `polish` handler, title-bar button, dialog line | `toggleWaveform` handler, palette lines | `toggleSnapping` handler, palette `on` | five handlers, `pauseHeld`, palette lines | scene block (`cropView`), `cropDraft`, three handlers, Esc/Enter, stage props | `actions` (freeze, delete branch), two handlers, palette lines, `Transport` prop |
| `src/renderer/src/editor/Timeline.tsx` | | `<ClipWaveform>` in `.clip-track`, title | drag handlers, `.tl-head` button, guide | | one zoom-scale expression | `<FreezeMarks>` in `.clip-track` |
| `src/renderer/src/editor/player.ts` | | | | rates, shuttle, reverse | `webcamShownAt` size | holds, stills |
| `src/renderer/src/editor/previewAudio.ts` | | | | `setView`, `setSilent`, rate lines | | `hold()`, video-time mapping |
| `src/renderer/src/editor/Transport.tsx` | | | | `<PreviewSpeedControl/>` | | `freezes` prop, time text |
| `src/renderer/src/editor/PreviewStage.tsx` | | | | `player.moving` | crop tool, view reads | |
| `src/renderer/src/render/compositor.ts` | | | | | `scene.crop`, `cropFrame` | `soundTime` |
| `src/renderer/src/editor/exporter.ts` | | | | | `prepare`, camera sizes | frames, sound, chapters, thumbnail |
| `src/renderer/src/editor/ExportDialog.tsx`, `ExportPreview.tsx` | | | | | `visibleSize` | length, chapters, frame slider |
| `src/renderer/src/editor/Inspector.tsx` | | | | | `onCrop` | `'freeze'` kind |
| `src/renderer/src/editor/panels/ClipPanel.tsx` | | | | | | `<FreezeSection>`, keep ranges |
| `src/renderer/src/editor/LayoutTrack.tsx`, `TitleTrack.tsx`, `CaptionTrack.tsx` | | | drag begin/move lines | | | |
| `src/renderer/src/editor/captionItems.ts` | `fetchTranscript` split | | | | | |
| `src/shared/editor/commands.ts`, `shortcuts.ts`, `tests/commands.test.ts`, `tests/shortcuts.test.ts` | contracts commit | contracts | contracts | contracts | contracts | contracts |

---

## 3. Commands and default keys (contracts commit)

| Command | Feature | Category | Default key |
|---|---|---|---|
| `polish` | E-01 | Edit | `Shift+P` |
| `toggleWaveform` | E-04 | Timeline | none |
| `toggleSnapping` | E-05 | Timeline | `N` |
| `shuttleReverse`, `shuttlePause`, `shuttleForward` | E-08 | Playback | `J`, `K`, `L` |
| `previewSpeedUp`, `previewSpeedDown` | E-08 | Playback | `>`, `<` |
| `cropRecording`, `resetCrop`, `cropTaskbar` | E-10 | Edit | `C`, none, none |
| `freezeFrame`, `toggleFreezeSound` | E-11 | Add, Edit | `F`, none |

Checked against today's `DEFAULT_KEYMAP` and `RESERVED`: none of `Shift+P`, `N`, `J`, `K`, `L`,
`<`, `>`, `C`, `F` is bound or reserved. `Shift+P` is not `Ctrl+Shift+P` (the palette):
`matchShortcut` drops Shift only when there is no exact match. `findConflicts(DEFAULT_KEYMAP)`
stays empty (tested). The teleprompter's hotkeys are global and all carry modifiers
(`src/shared/recording/hotkeys.ts`), and are registered only while its window is open.

---

## 4. Contracts (this commit)

Types, sanitisers and migration are implemented and **frozen**. Every other export listed in a
design's "Contracts" table exists with its final signature and a body that keeps today's
behaviour (identity or empty result), so the app runs unchanged until a workstream lands.

| File | State |
|---|---|
| `src/shared/types.ts`: `Project.crop`, `FreezeSound`, `Freeze`, `Project.freezes` | frozen |
| `src/shared/api/export.ts`: `SoundHold`, `RecordingSound.holds` | frozen |
| `src/shared/api/prefs.ts`: `'polish'` | frozen |
| `src/shared/engine/project.ts`: `crop` and `freezes` in `migrateProject` | frozen |
| `src/shared/engine/crop.ts`: `readCrop`, `cropOf` implemented and frozen; the rest identity for no crop | E-10 |
| `src/shared/engine/freezeData.ts`: `readFreezes`, `clampFreezes` | frozen |
| `src/shared/engine/freeze.ts`: constants, types, `NO_FREEZES`, `planOf`; maps are identity | E-11 |
| `src/shared/editor/commands.ts`, `shortcuts.ts`: section 3 | frozen |
| `src/renderer/src/views/Editor.tsx`: one no-op handler per new command, grouped per feature | each feature replaces its own group |
| `src/renderer/src/editor/player.ts`: `moving`, `viewRate`, `holdElapsed` | E-08 / E-11 |
| `src/renderer/src/render/compositor.ts`: `RenderScene.crop`, `drawFrame(…, soundTime?)` | E-10 / E-11 |
| stubs: `snapping.ts`, `snapControl.ts`, `shuttle.ts`, `waveform.ts`, `cropEdit.ts`, `freezeEdit.ts`, `polish.ts`, `polishCopy.ts` | their feature |
| `tests/editingWinsContracts.test.ts` | frozen |

**Signature rule.** An implementer may add internal helpers and new exports. Changing a frozen
file or an exported signature that another feature uses goes through the lead.

---

## 5. Work split

Six workstreams, each on its own branch (`w6-e01` … `w6-e11`) from the contracts commit. Each
owns the files in its design's "Files owned" list, minus the docs in decision 4, and changes
shared files only in its region (section 2).

**Verify, each workstream:**
- `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`;
- `npx vitest run --testTimeout=60000` (its new tests, and every existing test unchanged);
- `npm run build && xvfb-run -a node tests/e2e/run-all.cjs <its e2e file> editor.e2e`.

**Merge order:** E-04, E-05, E-08, E-10, E-11, E-01 (the smallest first; E-11 after E-08 because
both change the player; E-01 last because it calls E-10 and E-11). After all six: both `tsc`
projects, the whole vitest suite, `npm run build`, and the whole e2e suite.

**After the merge:** the lead updates `docs/FEATURES.md` (one Editor bullet per feature),
`docs/ROADMAP.md` (the six rows shipped) and `docs/IMPLEMENTATION.md` (crop view and video
time).
