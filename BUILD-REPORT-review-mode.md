# Build report: Review mode (E-02)

Branch `feat-review-mode`, from `546e479` (`ccr-b6df7cf7-yked87`). Design:
[`docs/design/review-mode.md`](docs/design/review-mode.md).

## What was built

- **Review automatic changes**, a panel over the Inspector. Open it with the title-bar button
  (it shows how many changes are left), `Shift+R`, or *Review automatic changes…* in the `Ctrl+K`
  palette. It lists every automatic change in time order:
  - auto zooms
  - the camera director's segments and its face framing
  - cuts made by *Remove silences*, *Smart speed* (idle), *Polish* and *Remove all* filler
    suggestions
  - speed-ups made by those same tools
- **Each row** shows a kind chip, a title (for example "Cut 2.4 s of silence"), the time and where
  the change came from.
  - Choosing a row jumps the preview there and plays a short stretch: 1.5 s before to 1.5 s after,
    at most 8 s. The stretch ends quietly if you seek or play elsewhere.
- **Keep** makes a change yours, as an edit by hand would. **Remove** puts back what was there
  before: footage comes back at its old speeds, a zoom is deleted, a cut-out goes back to its
  camera corner, framing is reset.
  - **Keep all** and **Remove all <kind>** act on the list in one go.
  - Each action is one undo step.
- **Keyboard:** `↓`/`N` and `↑`/`P` move between rows, `Home`/`End` jump to the ends, `K` keeps,
  `Delete`/`Backspace` removes, and `Esc` closes and returns focus to the button.
  - Only one row is in the Tab order at a time (roving tabindex).
  - The list keeps its keys after a mouse click on a row.
  - The Inspector under the panel is `inert`.
- **Screen reader:** each row reads as "title, kind, at time, status". Progress ("12 of 40
  reviewed") is shown as text and as a progressbar. Every action is announced in a polite live
  region.
- **Reviewed rows** stay in the list, marked *Kept* or *Removed*, until the panel closes.

## Decisions

- **Status is computed from the project, not stored.** A row is pending while the change is still
  automatic or its record is intact. It is kept when the change is now the user's, and removed when
  it is gone or its footage is back. Undo and redo therefore need no extra state.
- **`Project.autoCuts` is optional.** It is the only new field and is written only once an automatic
  cut is made. Old projects load and save byte for byte unchanged (tested). `readAutoCuts`
  sanitises the stored list, because a project file is untrusted:
  - limits: 1000 records, 64 pieces per record, 80-character words text
  - ids must be unique; types and sources are enum-checked; times are clamped
  Larger cuts are split across several records instead of being truncated.
- **Records drop themselves when they stop being true.** A settle step runs inside the same undo
  step. If you trim into a cut or re-cut part of a speed-up by hand, its record goes, so Review
  never offers to undo something that no longer matches the timeline.
- **Removing a cut** inserts each original piece at its own speed, only where nothing plays it now.
  It does not snap, and it keeps your splits.

## Tests

- **Unit tests:** 55 in total.
  - `tests/reviewAutoCuts.test.ts` (29): recording, splitting, intact and undo, migration
    round-trip, sanitising, plus a regression block for each review finding.
  - `tests/review.test.ts` (19): the list, statuses, Keep/Remove, merge, and cut-out restore.
  - `tests/reviewCopy.test.ts` (3).
  - `tests/reviewPlayStretch.test.ts` (4).
- **End-to-end:** `tests/e2e/review-mode.e2e.cjs`.
  - It walks through: `Shift+R` → N/P → K → Delete on a cut (footage back, record gone) → `Ctrl+Z`
    → mouse click then Delete → Inspector is inert → Keep all → Esc returns focus → palette opens
    the empty state.
  - It also produces the three screenshots in `docs/screenshots/review-mode-*.png` (200–216 KB
    each).

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npx vitest run --testTimeout=60000` | 3853 passed, 1 failed: `groupMove.test.ts` G-PERF, a timing budget under full-suite load. It passes when run alone and is not touched by this branch. |
| `npm run build` | pass |
| `xvfb-run … npm run test:e2e` | 58/60 files passed on the full run. Both failing files pass alone (see below). `review-mode.e2e.cjs` passes. |

The two e2e files that failed on the full run:
- **`offline-captions.e2e.cjs`** failed because the pinned test speech model was not in the
  container. After `npm run fetch:test-speech` (SHA-256 matches the pin), it passes alone with
  11/11.
- **`w3fix-render.e2e.cjs`**, "every preview frame drew the camera", failed with 1 of 88 frames.
  It passes alone with 2/2. This is a timing flake under load, and nothing on this branch touches
  the preview renderer.

No test was skipped or loosened.

## Not covered here / needs a real Windows PC

- How NVDA and Narrator read the rows and the live region on Windows. ARIA is checked in Chromium
  only.
- The hooks in ClipPanel, Polish and TranscriptPanel that write records are covered by unit tests of
  `recordAutoCuts` and `suggestionRanges`, not by an e2e test that runs those tools.
- Later, as listed in the design doc: reviewing auto captions and retake cuts (the record already
  has `retake`/`repeat` sources); a filter by kind; and keeping the reviewed state after the panel
  closes.
