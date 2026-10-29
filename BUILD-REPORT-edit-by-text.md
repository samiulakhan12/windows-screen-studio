# Build report: Edit by text (NW-04), fillers and retakes (NW-01), smooth cuts (NW-06)

Branch: `feat-edit-by-text`, from `ccr-b6df7cf7-yked87` (aeca5c5, Flown 0.6.0).
Design: `docs/design/edit-by-text.md` (§13 lists where the build differs from the spec).

## What was built

- **Transcript tab** (Inspector, after Captions; `src/renderer/src/editor/panels/TranscriptPanel.tsx`,
  `transcript.css`). The project's captions word by word. Click, drag, Shift+click or the arrow keys
  select words; `Delete` cuts them from the video; cut words stay struck through and *Restore* brings
  them back. Clicking a word moves the playhead; the spoken word is underlined while playing. Pages of
  40 captions. No transcript: *Make captions* opens the Captions tab and starts its own
  "Generate captions" (no change to the Captions panel).
- **Cuts are ordinary clips.** A word span becomes a source range (each end at the middle of the pause
  next to it, at most 0.5 s into it) cut with the timeline's `cutRange` and restored with
  `restoreRange`. Whether a word is cut is derived from the clips, so cuts made anywhere show in the
  text. Every action is one `store.update` (one undo step).
- **Find fillers and retakes** (`fillers.ts`, `retakes.ts`, `transcriptReview.ts`): um, uh, er, …;
  "like", "you know", "I mean" only when set apart by a pause (0.3 s) or a comma; short lists for
  Bangla (উম, হুম, মানে in context, …), German, French and Spanish; repeated words (not across a
  sentence end, not words often doubled on purpose); sentences said again (word overlap of 75 % or
  more with the next sentence or the one after a short one; the last take is kept). A review list
  with Keep / Remove each and Remove all (one undo step). Nothing is cut until the user chooses.
- **Smooth cuts** (`src/shared/render/cutFades.ts`): 10 ms linear fades out before and in after every
  cut. Export: `afade` filters last in each sound piece's chain (opt-in `RecordingSound.cutFade`, set
  by the editor's exporter, validated in `src/main/exportJob.ts`); a job without it builds the exact
  earlier graph. Preview: a `cut` gain node in `previewAudio.ts`, ramped to silence at the player's
  predicted jump and back after it, with the same length and curve.

No change to `project.json` or the settings; old projects open unchanged. Old projects with cuts sound
slightly different at their next export, right at the cuts (in the release notes).

## Decisions and why

- A new tab rather than inside the Captions tab: Delete there removes a caption, not video; another
  team's 1,230-line file.
- Cuts stored only as clips (no "deleted words" list): one source of truth; the timeline, Smart speed
  and Remove silences stay in step; nothing to migrate.
- Padding to the middle of the pause (max 0.5 s): word timings are about ±50 ms; it degrades well on
  both run-together words and long pauses, and adjacent spans meet exactly so restore undoes a cut.
- Fillers and retakes on this PC from word overlap, no AI call or model download; a review list makes
  false positives harmless. Embeddings (F-05) and AI text tasks are left for later.
- Always-on 10 ms audio fades with no setting; the video cross-dissolve is left for later (needs two
  decoded frames in the export feed and compositor, which the vertical-video team is changing).

## Files outside my own

Additive lines only: `src/shared/api/export.ts` (one field), `src/shared/render/audioPlan.ts` (field,
fade filters, pass-through), `src/main/exportJob.ts` (one validation clause and its import),
`src/renderer/src/editor/exporter.ts` (one line and import), `src/renderer/src/editor/previewAudio.ts`
(the `cut` node and its scheduling), `src/renderer/src/editor/Inspector.tsx` (tab, type member, render
line), `src/renderer/src/editor/EditorIcon.tsx` (one icon path), docs.
Two e2e expectations changed for intended behaviour, both still exact: `tests/e2e/ui.e2e.cjs` (twelve
Inspector tabs; the rail still fits at the minimum window size) and `tests/e2e/audio-pack.e2e.cjs` (the
older-project reference graph gains the 10 ms fades at its three cuts; difference still < 1e-6).
No new dependencies.

## Tests

- Unit (vitest): `tests/transcript.test.ts`, `transcriptSelection.test.ts`, `fillers.test.ts`,
  `retakes.test.ts`, `transcriptReview.test.ts`, `cutFades.test.ts` (graph strings, preview timing, and
  an ffmpeg run showing a plain join clicks and the faded one does not). Each rule was checked to fail
  without its code (a scripted mutation run: every guarded rule's tests fail when it is removed).
- E2E: `tests/e2e/edit-by-text.e2e.cjs` (4 tests: click to seek, Shift+arrows, Delete, struck words,
  undo/redo, Restore, keyboard select-all and Esc; Find, Keep, Remove all in one undo step; Make
  captions; an M4A export whose sound fades to near silence at the cut — verified to fail with the
  fades turned off).
- An adversarial review (a separate reviewer) found preview fade timing at 30 fps and slow preview
  speeds, the export fade position on re-timed clips, notices that miscounted, restored slivers,
  stutters across sentences, a prototype lookup, an unneeded audio graph when muted, key leaks and the
  pager while playing. All fixed with tests (design §13).

## Verification

On the final code (this branch's head), Linux, Xvfb without a window manager:

- `npm run typecheck`: passes.
- `npx vitest run --testTimeout=60000`: 3022 of 3023 tests pass (221 of 222 files). The one failure is
  `tests/groupMove.test.ts` › G-PERF (a 250 ms timing limit, measured 260–290 ms here); it fails the
  same way on the base commit aeca5c5 on this machine and is not touched by this branch.
- `npm run build`: passes.
- `xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` (the full suite, after
  `npm run build:speech-host` and `npm run fetch:test-speech`): 51 of 54 files pass, 226 tests pass.
  The three failing files:
  - `teleprompter.e2e.cjs` › "notes: … dragged by its strip": fails identically on base aeca5c5 here
    (no window manager to move the window; `openbox` is not installable in this container).
  - `camera-live.e2e.cjs` › "the live camera bubble …" (a recording's duration vs a 2.5 s pause):
    passed on the re-run and in the first full run; recording timing, not touched by this branch.
  - `bangla-captions.e2e.cjs` › "Bengali shows its chip … the click downloads it": failed in the full
    run and once more in a re-run of two files, then passed twice run alone, and passes on base. The
    assertion reads the mock server's request log the moment the progress text appears, so it is a
    race under load; this branch does not touch the Captions tab, speech or downloads.
  - `edit-by-text.e2e.cjs`: 4 of 4 pass. `audio-pack.e2e.cjs`: 10 of 10 pass (its known 20 ms
    microphone-stem flake did not show on the final run). `ui.e2e.cjs`: 5 of 5 pass.

## Needs a real Windows PC

- How the preview's fades sound at cuts on real hardware and displays (60/120/144 Hz, 30 and 60 fps
  recordings): the timing follows measured frame callbacks, but audio output latency is the device's.
- Lip sync of projects with cuts now playing through Web Audio in the preview (the same graph used
  whenever music, stems or loudness are on).
- Word timing accuracy of real recordings (cloud and on-this-PC captions) at cut edges.
