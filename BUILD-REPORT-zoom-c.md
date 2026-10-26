# Build report: smarter auto zoom, workstream C (UI)

Branch `feat-w5-zoom-c`, from `5dbaccb` (design and contracts). Spec: `docs/design/smarter-auto-zoom.md` §8.
Workstream B (`origin/feat-w5-zoom-b`, `20b9aa9`) was merged into this branch, as the task asked, to
run the end-to-end tests against the real logic. So this branch carries B's commits as well as C's.

## What was built

All of it is in C's files only. No frozen file and no exported signature of B's modules changed.

**Ignoring clicks**
- Timeline (`Timeline.tsx`, `editor.css`):
  - Every recorded in-video click (`clickRows(recorded, inputEdits)`) is a marker on the clip track.
  - Looks:
    - used left click: a 6 px white dot;
    - right or middle click: a 4 px dot;
    - ignored: a hollow ring at 45 % opacity;
    - stray: the same ring, dashed;
    - selected: an accent ring (`--focus-ring` with a dark outline, at least 3:1 on the clip block).
  - Attributes: `data-click-ms`, `data-state`, `data-button`. Hit area 12 × 14 px.
  - Pointer: `pointerdown` selects `{ kind: 'click', ms }`, seeks to `t + 0.15` inside a kept clip, and
    stops propagation. Shift/Alt+drag still selects a range.
  - Tooltips use the spec's copy.
- Selection (`selection.ts`):
  - New kind `{ kind: 'click'; ms }`.
  - `validSelection` checks a finite `ms` within the recording, so a click selection survives undo.
  - `selectionKey` returns `click:<ms>`.
  - Inspector `TAB_FOR.click = 'zoom'`.
- Delete (`Editor.tsx`, `deleteSelection`):
  - ignores a used click and keeps it selected;
  - on an ignored click, says "This click is already ignored: use it again in the Zoom panel".
- Zoom tab (`ZoomPanel.tsx`, `zoom.css`):
  - **Selected click** at the top of the tab. The aside reads "Left click · 0:04.2", followed by the
    used or ignored sentence, plus the stray reason. Buttons are **Ignore click** (with the Delete key
    as a keycap) and **Use click**, then the hint about automatic zooms.
  - **Selected auto zoom**, from `zoomCause`:
    - "Made for the click at …" with a ghost **Ignore this click** button (spec title). The selection
      clears afterwards.
    - "Made for typing at …", "Made for a zoom-here mark at …", "Zooms back in where scrolling
      stopped (…)".
    - Zooms made or edited by hand get no line.
  - **Auto zoom**:
    - Summary: "3 left clicks (1 ignored) · … · 1 long scroll detected." When every click is ignored:
      "All N left clicks are ignored".
    - `hasInput` uses the recorded clicks.
    - Disclosure **Recorded clicks · N · M ignored**, max height 240 px, styled like the smart speed
      list. Each row has a time button (selects and seeks), the button kind, the state and
      **Ignore**/**Use**. Below the rows: **Find stray clicks** and **Use all clicks**.
- Cursor tab › Clicks: the aside reads "N clicks · M ignored", with the spec title.
- Notices use the spec's copy. "· Ctrl + Z to undo" is the app's existing `undoHint`.

**Straightening**
- Cursor tab › Motion:
  - Toggle **Straighten moves** with the spec title.
  - When on, the hint "X of Y moves straightened. Drags, loops and moves across a click keep their
    recorded path." (`pathSummary`).
  - Disabled like the other Motion controls.
- Clip tab › Selected range (only when Flown draws the cursor):
  - Field **Cursor path** with **Straighten**, **As recorded**, and **Reset** when the range overlaps
    painted ranges.
  - Hint "N moves here · M straightened".
  - The four notices.
  - The range stays selected.
- Timeline: 2 px accent bars (`data-testid="path-bar"`, `pointer-events: none`) for the straightened
  moves of `planCursorPath`.

**Scrolling**
- Zoom › Auto zoom:
  - Chips **While scrolling** (Zoom out / Hold / Ignore, spec titles), through `setAuto({ scrolling })`.
  - Disabled with the spec hint when `recorded.scrolls` is undefined.
- Zoom track: a faint hatched band (`data-testid="scroll-band"`) for each `scrollBreaks(cursor, auto)`,
  with the spec title.
- Smart speed copy (ClipPanel, FEATURES.md): "…you did not move, click, scroll or type".

**Commands** (`commands.ts`; no default keys, so `shortcuts.ts` needed no change)
- The six commands, with the spec's ids, categories and titles: `toggleClickAtPlayhead`,
  `findStrayClicks`, `useAllClicks`, `toggleStraighten` (a toggle), `straightenRange` and
  `recordedPathRange`.
- The palette shows the spec's availability messages.

**Undo.** Each action runs one `store.update` through the `editor/inputEdits.ts` operations:
- ignore and use (with the zoom rebase);
- find stray clicks;
- use all;
- the straighten toggle;
- each range action;
- each scroll mode change.

`Editor.tsx` owns these as one `InputActions` object (typed in `Inspector.tsx`). It passes the recorded
track, `clickRows` and the actions to the Inspector and the Timeline, next to the effective `cursor`.

**Docs:**
- `docs/FEATURES.md`: three new entries, plus the smart speed, auto zoom settings and palette lines.
- `README.md`: the Motion row, and the smarter auto zoom items in the "Not yet verified on a real
  Windows PC" list.
- `docs/ROADMAP.md`: NW-03 marked shipped.

## Deviations and why

1. **Shared click copy lives in `selection.ts`** (`clickKind`, `clickState`, `STRAY_REASON_TEXT`,
   `clickTooltip`). Both the Timeline and the Zoom panel need it, and the work split puts files outside
   C's list out of bounds, so no new module was added.
2. **Scroll bands receive pointer events.** The spec asks for both `pointer-events: none` and a title,
   and a title never shows without pointer events. The band sits inside the zoom track, behind the
   zoom segments, so a press bubbles to the track exactly as before: scrub, and double-click to add a
   zoom. Path bars are `pointer-events: none` as specified.
3. **"Straighten" on a range where nothing can be straightened stores nothing.** It shows "No cursor
   move here can be straightened (1 drag, …)" without adding an undo step that changes nothing. The
   reason nouns, such as "move across a click" and "loop", are my wording.
4. **Small copy additions for singular cases** the spec does not cover:
   - "The ignored click is used again" (one click);
   - "The only left click is ignored";
   - "Ignored 1 stray click".
5. **Click markers take no keyboard focus**, like every other timeline item. The keyboard route is the
   Recorded clicks list (buttons, natural tab order), Delete on a selected click, and the palette
   commands.
6. **`toggleClickAtPlayhead` flips the click without selecting it**, so the open tab does not change.
7. **B is merged into this branch** (the task's instruction). The spec suggested a local test branch.

## Tests

**Unit (vitest).**
- `tests/commands.test.ts` › "smarter auto zoom commands":
  - "are in the palette with their titles and categories";
  - "are found by what people type".
- `tests/shortcuts.test.ts` › "gives the smarter auto zoom commands no default key (I stays free)".

**End to end: `tests/e2e/smart-zoom.e2e.cjs`.** The fixtures are seeded with `render-fixtures` and
patched in the test file. The fixture files are unchanged.
1. "ignoring a stray click removes its zoom, effect and sound; undo restores it".
2. "straightened moves: straight in preview and export, ranges override, undo". This includes the
   follow-cursor camera check through the palette toggle.
3. "follow scrolling: zooms out during a long scroll and back in where it stops".

With `SSW_E2E_SHOTS=<dir>`, it saves the screenshots now in `docs/screenshots/smart-zoom-*.png`. There
are 7 files, each 40–49 KB.

## Verification

Run on Linux under Xvfb (`-screen 0 1920x1080x24`).

- `npm run typecheck`: clean, before and after merging B.
- `npx vitest run --testTimeout=60000`:
  - before merging B: 122 files, all pass;
  - after merging B: **126 files, 1675 tests, all pass**.
- `npm run build`: ok.
- `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs smart-zoom`, after merging B:
  **3/3 PASS**. Measured values:

  | Test | Measured |
  |------|----------|
  | 1 | Reddish pixels at 0.45 / 4.15 / 9.15 s: 0 / 182 / 0. Click sound onsets: `[3.995]`. |
  | 2 | Tip y as recorded 360.0 / 390.2 / 335.3 / 366.0 / 360.1 px; straightened 360.0 / 360.2 / 360.1 / 360.1 / 360.0 px (at 0.9 / 1.15 / 1.3 / 1.45 / 1.8 s). Preview vs export at 1.3 s: (461.7, 387.4) vs (461.5, 387.4). Follow-cursor camera cy spread: 0.0103 as recorded, 0.0004 straightened. |
  | 3 | Zoom out: 1.000× at 5.0 s and 1.799× at 8.5 s around (0.500, 0.500). Hold: 1.799× at 5.0 s, zooms [1.10, 8.80] and [11.10, 13.80]. The older recording gives exactly [1.1, 3.8] and [11.1, 13.8], with the chips disabled. |

- **Full e2e suite** (`xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e`):
  - **Before merging B:** 40/41 files passed (181 PASS lines). The only failing file was
    `smart-zoom.e2e.cjs`, as expected while B's operations were stubs. Every existing file passed with
    the clickable markers, including recording-input, -region and -window, polish, zoom, editor and
    commands. Three checks skip as always without Wine or a Windows package.
  - **After merging B:** FULL_SUITE_RESULT
