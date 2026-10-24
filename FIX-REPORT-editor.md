# Fix report: editor audit (audit/editor.md, E1–E5)

Base: `f3db4cb` (waves 1–2 and three of the four wave-3 parts). Branch: `fix-audit-editor`.
E6 is not in this report; another fixer has it.

| Finding | Status | Test that proves it |
| --- | --- | --- |
| E1 Export dialog does not trap focus | fixed | `tests/e2e/audit-editor.e2e.cjs` "audit E1" |
| E2 Text and zooms added at the playhead go into a cut | fixed | `tests/e2e/audit-editor.e2e.cjs` "audit E2" |
| E3 Malformed `clips` entry stops a project from opening | fixed | `tests/project.test.ts` "opens a file with a malformed clips entry (audit E3)" |
| E4 Duration correction leaves timed items past the end | fixed | `tests/editorClips.test.ts` "keeps shapes, spotlights, titles, layouts and chapters inside a shorter file (audit E4)" |
| E5 No-op "Range speed" adds an undo step and drops the selection | fixed | `tests/editorClips.test.ts` "returns the input when the range changes nothing (audit E5)" and `tests/e2e/audit-editor.e2e.cjs` "audit E5" |

Each new test was run against the unfixed source and failed, then passed with the fix. For the
unit tests I stashed `src/shared`. For the e2e file I stashed `src/renderer` and
`src/shared/editor/clips.ts` and rebuilt.

## E1: fixed

Re-verified: `ExportDialog.tsx` still renders `aria-modal="true"` without `useModalFocus`. With
an export running, Shift+Tab moved focus to the timeline's "Zoom in timeline" button (seen in
the failing e2e run).

Change (`src/renderer/src/editor/ExportDialog.tsx`): the dialog box gets a ref and calls the
shared `useModalFocus`, so Tab and Shift+Tab stay inside the dialog in every phase. Focus also
goes back to where it was when the dialog closes. I kept the dialog's own capture-phase Escape
handler, which already closes the dialog only while no export runs and stops the editor from
seeing the key. So the hook's close callback does nothing, and Escape behaves as before. I did
not add `inert` to the editor (the audit's "stronger fix"); the focus trap alone closes the
keyboard route the finding describes.

Test: the e2e opens Export and Tabs and Shift+Tabs around in the settings step. It then starts
an MP4 export and does the same while "Cancel export" is shown. After every key press it checks
that focus is inside `.export-modal`, then that the editor is still open and the export still
running. Without the fix, only the running-export part fails. In the settings step, 4 presses
each way do not reach the edge of the dialog.

## E2: fixed

Re-verified: `addZoomAt` and `addTextAt` in `src/renderer/src/views/Editor.tsx` still used the
raw playhead time.

Change: both now place the item at `displayTime(clips, t)`, the frame the preview shows (in a
cut, the next kept one), as shapes and spotlights already do in `playheadItems.ts`. This covers
the T and Z shortcuts, the palette, "Add text at playhead" and double-clicking the text or zoom
track. I did not scale the text length by the clip speed (optional in the audit), because new
shapes do not do that either.

Test: in a project with clips [0,5] and [12,20], click the ruler at 7 s (inside the cut) and
press T. The new text must start at 12 s; before the fix it was `[7,10]`. Then click 7 s again
and press Z. The new zoom must cover the first frames after 12 s.

## E3: fixed

Re-verified: `migrateProject` still passed `p.clips` to `normalizeClips` unfiltered.

Change (`src/shared/engine/project.ts`): clips are read through the existing `objects()` filter
and must have a finite `start` and `end`. When no usable clip is left, the old fallback is used
(the v1 `trim`, or the whole recording). Valid files are read exactly as before.

Test: `[null, 3, {start: 'a', …}, {id: 'a', start: 0, end: 5}]` opens with the one good clip,
and `[null]` opens with the full clip. Before the fix this threw
`Cannot read properties of null (reading 'start')`.

## E4: fixed (titles, chapters and layouts included)

Re-verified: `correctProjectMedia` in `src/shared/editor/clips.ts` clamped only clips, zooms
and annotations.

Change: a small `clampTimed` helper clamps annotations, shapes, spotlights, title cards
(wave 3) and layout segments to the corrected duration. An item that the clamp leaves shorter
than 0.05 s is dropped, the rule annotations already used. Items already inside keep their
object identity. Chapters (wave 3, point markers) past the new end move to the end, matching
`readChapter`'s clamp in `titleData.ts`. Lists the project does not have stay absent. The 3D
tilt is a project-wide setting with no times, so nothing applies to it.

Layouts: they are handled through the reader that exists today. `migrateProject` reads them
with `objects(p.layouts)` and the type is `LayoutSegment {id, start, end, layout}`. The
camera-layouts part still being finished may change the layouts reader in `project.ts`. If it
keeps `start` and `end` on each segment, this clamp carries over unchanged; if not, the
`layouts` line in `correctProjectMedia` needs adjusting at merge time.

Test: with duration 10 corrected to 9, a shape at [8.5,10] becomes [8.5,9] and one at [9.5,10]
is dropped. A spotlight, a title card and a layout are clamped to 9, an inside title is kept,
and a chapter at 9.8 moves to 9.

## E5: fixed

Re-verified: `setRangeSpeed` always returned a new array, and the ClipPanel handler always
updated the store and cleared the selection.

Changes:
- `setRangeSpeed` (`src/shared/editor/clips.ts`) returns the input array when no clip inside
  the range changes speed. That covers a range inside a cut, and also a range that already
  plays at that speed, which before split the clips into same-speed pieces and pushed an undo
  step. Clips that already have the speed are kept as they are. `applySmartSpeed` only calls it
  for slower parts, so its results are unchanged.
- In the "Range speed" handler (`src/renderer/src/editor/panels/ClipPanel.tsx`), when nothing
  changes the store is not touched and the range stays selected. The notice says "Nothing to
  change: this range is cut or already plays at N×".

Tests: the unit test checks that a range inside the cut and a same-speed range both return
the same array, and that a real change does not. The e2e Shift+drags a range inside the cut,
clicks 2×, and checks that the notice appears, the range is still selected and Undo is still
disabled.

## Verification

Run on the final tree:

- `npm run typecheck`: passed.
- `npx vitest run`: 82 files, 1198 tests, all passing.
- `npm run build`: passed.
- e2e under `xvfb-run -a -s "-screen 0 1920x1080x24"`, one at a time: see below.

| e2e file | Result |
| --- | --- |
| `audit-editor.e2e.cjs` (new) | 3 PASS, 0 FAIL, exit 0 |
| `editor.e2e.cjs` | 13 PASS, 0 FAIL, exit 0 |
| `commands.e2e.cjs` | 5 PASS, 0 FAIL, exit 0 |
| `editor-defaults.e2e.cjs` | 2 PASS, 0 FAIL, exit 0 |
| `export.e2e.cjs` | 10 PASS, 0 FAIL, exit 0 |

Setup note: `npm ci` did not download the Electron binary in this container, so I ran
`node node_modules/electron/install.js` once. `openbox` was not installed and `apt-get` did not
install it. None of the suites listed above needs a window manager.
