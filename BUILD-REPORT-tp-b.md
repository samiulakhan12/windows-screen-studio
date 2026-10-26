# Build report: teleprompter workstream B (renderer UI)

Branch `feat-tp-b`, from `cfeaac5` (design and contracts). Workstream A (`feat-tp-a`, `612d4e1`)
was merged in for integration (`0037c4d`, no conflicts; nothing in A's or the frozen files was
changed). Spec: `docs/design/teleprompter.md`.

## What was built

**Pure shared modules** (`src/shared/notes/`)

- `blocks.ts`: one block per non-empty line, `gapBefore` for blank lines; bullets (`- `, `* `,
  `• `, `1. `, `1) `) with the marker kept as typed and not counted; `[cues]` as their own runs,
  never counted (an unclosed `[` stays text); words with `Intl.Segmenter` (`isWordLike`), with a
  whitespace fallback; `firstWord`; `readingSeconds`, `readingLabel`. Text only, never markup.
- `scroll.ts`: `blockAt` (binary search), `endPosition`, `rateAt` (wpm / 60 × height / words),
  `advance` across block boundaries, `stepTarget` (back / forward with the one-line rule), `snap`
  to device pixels, `stepDelayMs` (one device pixel, clamped to [33.3, 1000] ms), and
  `ScrollClock` (position as a pure function of an anchor and time; layout changes keep the
  block and the share of it; speed changes, jumps and pauses re-anchor). `SCROLL` unchanged.
- `playback.ts` (new): how the page follows each view. The presenter's wish (`want`) is kept
  through holds; the countdown and a hidden window always hold it, a paused recording holds it
  until the presenter presses play there; `autoStart` applies to the first `'recording'` of a
  take unless play / pause was pressed during the countdown; a new take or a countdown goes to
  the top; reaching the end stops it.
- `notesCopy.ts` (new): every string of §5 in one place, plus `wordsLabel`, `countLine`,
  `notesSummary`, `notesStatus`, `withHotkey`, `notesButtonTitles`.

**The notes window** (`views/NotesWindow.tsx`, `NotesWindow.css`)

- Blocks as text nodes; bullets with the marker in a gutter (`-` and `*` drawn as `•`); cues
  italic in `--text-2`; `--font-sans` 500, `--leading-normal`, 20 px sides; opaque
  `--surface-0`, 1 px `--border-default`, `--radius-lg` corners inside the square window.
- Reading line at 30 % (the column is positioned at `top: 30%`, so position 0 puts the first
  block on the line without padding maths): a ▸ marker in `--accent-text` and a 1 px
  `--border-strong` line; a static gradient (25 % `--surface-0` to transparent) above it.
- `NotesScroller` (in the page, outside React) owns the `ScrollClock` and one `setTimeout`:
  each step waits `stepDelayMs(rate, devicePixelRatio)`, writes
  `translate3d(0, −snap(y) px, 0)` only when the snapped value changed, sets `data-block` only
  on change, and runs no timer while paused, hidden, at the end or empty. Back / forward glide
  over 150 ms on the same timer (at most 5 writes; instant under reduced motion). No
  `requestAnimationFrame` for scrolling, no React render per step. The column has
  `will-change: transform; contain: layout paint`, the text area `overflow: hidden; contain:
  strict`. `body.notes-body *` sets `animation: none; transition: none` (with `!important`,
  because `styles.css` loads after this page's stylesheet in the bundle).
- Boxes are measured from the column's content top, contiguous, after every text or size change
  (layout effect) and on width changes (`ResizeObserver`).
- Strip (32 px, `role="toolbar"`, drag area with `no-drag` buttons): Back · Play / Pause ·
  Forward · − `130 wpm` + · A− A+ · status (`aria-live="polite"`) · `!` hotkey problems · ×
  (hide while recording, close while rehearsing) · resize grip, or the lock icon when locked.
  Every button has an `aria-label` and a title with its hotkey. Targets are 26 × 26 px.
- Resize grip: pointer capture, `screenX/screenY` deltas, at most one `setNotesLook({ width,
  height })` per animation frame, the last size sent on release.
- Wheel: a passive listener moves the text by `deltaY` in pixels (lines × line height, pages ×
  text-area height); Ctrl + wheel: a non-passive listener, text size ±2 (at most one step per
  80 ms, so a touchpad does not race through the sizes).
- Rehearsal keyboard (only in `'rehearse'` mode): Space, ↑ / ↓, Page Up / Down (⅔ of the text
  area), Home / End, − / = and numpad − / +, Ctrl + − / Ctrl + =, Esc. Space on a focused
  button presses that button (native behaviour) instead of toggling.
- Commands from hotkeys (`toggle`, `back`, `forward`); reports to main only when `playing`,
  `ended` or `block` changed; test hooks `data-playing`, `data-ended`, `data-block`.
- End: status "End of notes" and a [Back to start] button; play at the end starts over.
- Empty rehearsal: "No notes yet. Add them on the home screen."

**Home** (`notes/`)

- `useNotes.ts`: the state from `getNotes()` / `onNotesState` (cached across visits), the typed
  text first while a save is pending, the save 500 ms after typing stops and on blur, dialog
  close and unmount, `update` and `rehearse` resolving to an error message or null.
- `NotesCard.tsx`: the "Speaker notes" `rec-group` between "Audio and camera" and Presets, shown
  only once `getNotes()` answered; empty and filled states, "Show while recording",
  [Edit notes…] / [Add notes…], [Rehearse] / [Stop rehearsing] (`aria-pressed`), the older-Windows
  warning (`role="note"`), "Could not save your notes: …", and `rehearseNotes(false)` when Home
  unmounts while rehearsing. Disabled while not idle.
- `NotesDialog.tsx`: modal (`role="dialog"`, `aria-modal`, `aria-labelledby`), Tab trapped (it
  steps aside while the Settings dialog is open on top of it), Esc closes, focus returns to the
  button that opened it, the text field focused on open. Textarea with the label and placeholder,
  "Saved" / "Could not save: …", the live count, Draft script; on the right the three toggles
  with hints, sliders for speed, text size, width and height (shown at once, saved 200 ms after
  the last move), the position line with [Reset position], three hotkey fields; footer
  [Rehearse] / [Stop rehearsing] and [Done].
- `DraftScript.tsx`: every state of §5.2 (no provider → the explanation and [Add an AI
  provider], which dispatches `OPEN_SETTINGS_EVENT`; providers re-read on
  `AI_PROVIDERS_CHANGED_EVENT` and when the settings dialog closes; empty → disabled with the
  title; over 20,000 characters → disabled with the hint; busy → "Drafting…", spinner (static
  under reduced motion), [Cancel], the textarea editable; done → the message and [Restore my
  notes] until the next edit or the dialog closes; stale; error with [Try again]). Provider
  select with 2 or more providers, remembered for the session. Only the notes text is sent, only
  on the click; a draft still running when the dialog closes is cancelled.
- `notes.css`: tokens only.

**Elsewhere**

- `RecordingOptions.tsx`: `HotkeyField` exported and generalised to `AnyHotkeyAction` (names,
  help and defaults for the notes actions); the recording list is unchanged; the auto-pause
  tooltip gains "While your notes scroll, Flown counts that as activity."
- `Toolbar.tsx` / `Toolbar.css` / `recordingIcons.tsx`: the notes button after the camera button,
  only with `status.notes`, `aria-pressed`, the §5.4 labels and titles, a static dot while the
  notes scroll; icons `notes`, `notes-off`, `step-back`, `step-forward`, `minus`, `plus`, `lock`,
  `resize`.
- `controller.ts`: `plan.notesNotice` goes to `onWarning`.
- `CaptionsPanel.tsx` (+ `captions.css`): "Your script", folded by default, only with
  `project.script`: the intro line, the text, [Copy script], [Use as notes again] with the inline
  "Replace your current notes?" [Replace] [Cancel] when the current notes differ.
- `tests/e2e/ai-mock-server.cjs`: the `spoken_script` branch ("Point: {line}." per line; a
  `slow…` key waits 4 s; the schema must be strict).
- `docs/FEATURES.md` (Speaker notes), `docs/ROADMAP.md` (NW-02 shipped).

## Deviations and why

1. **Notes shown before the bar (§2.1 step 2, §7.3 step 2).** A calls `showNotes()` before
   `showToolbar()`, but `showNotes` waits for the page's `ready-to-show`, so on the first countdown
   status the bar is shown first (the e2e log says "the bar, then the notes"). The two do not
   overlap in their default places (notes top centre, bar bottom centre). The e2e asserts that the
   notes are shown inactive within the countdown and logs the order instead of failing on it. If
   the bar must stay above a notes window dragged onto it, A could raise the bar
   (`moveTop()` on the bar, which is not focusable either) after the notes' first reveal.
2. **Dragging the recording window by its strip** does not move it under Xvfb/openbox (observed:
   the same drag moves the focusable rehearsal window, so it looks like X11 not starting a
   `-webkit-app-region` move for a window that cannot take focus; no existing e2e drags the
   recording bar, which works the same way). The drag is still made in the recording test (its
   clicks must not be recorded, which is asserted) and the move is logged; dragging and the grip
   are asserted in the rehearsal test, where the window is focusable. Windows-unverified, as in
   §7.4.
3. **Saving the place after a drag**: Electron emits `'moved'` (where A saves `placement`) on
   Windows and macOS only, so on Linux the place is saved by the next grip resize. The e2e checks
   the place after the grip. Windows-unverified.
4. **`y` in the hotkey step (§7.3 step 3)**: the spec's order (click Pause, then F7 "y still for
   1 s") would resume, not hold. The test plays with F7, pauses with F7 again, then checks the
   text stays still for 1 s.
5. **Order of the bar actions in §7.3 step 3**: hide → click where the notes were → show → pause →
   resume (instead of hide, click, pause, resume, show), because hidden notes write nothing either
   way; checking "no writes while paused, writes again after resume" needs them shown.
6. **Status while the presenter scrolls during a paused recording**: the presenter can press play
   while the recording is paused (to rehearse a passage); the status then reads "Scrolling", and
   the next resume keeps scrolling. The spec does not say; this felt least surprising.
7. **Width and height sliders** step by 10 DIP and show "560 px" (CSS px = DIP); the grip still
   sets any size.
8. **Dialog focus trap**: the shared `useModalFocus` would fight the Settings dialog opened from
   "Add an AI provider" (both trap Tab), so the Notes dialog has a small trap of its own that
   steps aside while another modal dialog holds the focus.

## Tests

Unit (vitest), new:

- `tests/notesBlocks.test.ts` (7): the spec fixture (kinds, words, gaps, cue run, firstWord), CR LF
  and CR, white space only, every bullet marker, cue-only lines and unclosed brackets, literal
  markup, 50,000 characters under 30 ms; `countWords` (Japanese, cues and markers); reading
  time and labels.
- `tests/notesScroll.test.ts` (11): every number in §7.2 (`rateAt` 16 / 24 / 0, `advance` 111 and
  the end, back / forward targets, `snap`, `stepDelayMs`, `ScrollClock` play / pause / speed /
  jump / layout / end).
- `tests/notesPlayback.test.ts` (9): countdown, autoStart on and off, pause and resume with and
  without scrolling, hide and show, new take, rehearsal, play during the countdown, play during a
  paused recording, the end.
- `tests/notesCopy.test.ts` (3): the summary and count lines, every status, button titles with
  and without hotkeys.

End to end: `tests/e2e/teleprompter.e2e.cjs`, six tests covering §7.3 steps 1–11 (see the file
header; the deviations above).

## Verification

All run on the integrated branch (B + A at `612d4e1`), Linux, Node 22, Xvfb 1920×1080 with openbox.

| Check | Result |
|---|---|
| `npm run typecheck` (node and web) | clean |
| `npx vitest run --testTimeout=60000` | 141 files, 1990 tests passed (last three runs). The first full run after the UI commit reported "1 failed file, 140 passed" with no failing test listed (a file that did not load, under load); it did not recur in the next runs. |
| `npm run build` | built (only the existing chunk-size warning) |
| `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs teleprompter` | 6/6 tests passed, `1/1 e2e files passed` (on the final build) |
| `xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` (full suite) | `43/43 e2e files passed`, 198 PASS lines, 0 FAIL (before the last two cosmetic dialog tweaks: no `aria-live` on the word count, "px" on the width / height values; the teleprompter file was run again after them) |

Logged by the e2e on every run: `first shown: the bar, then the notes` (deviation 1) and
`notes window dragged while recording: {680, 8, 560, 240} -> {680, 8, 560, 240}` (deviation 2).

Not run here (Windows-unverified, §7.4): focus never taken on Windows, capture exclusion in WGC
and Chromium video and in screen sharing, Alt+Tab / taskbar, dragging the recording window,
saving the place on `'moved'`, mixed-DPI placement, the wheel over an inactive window, the
older-Windows black box, CPU and dropped frames with the notes scrolling.

For the lead: `feat-tp-a` at `612d4e1` has no unit tests of its own yet (§7.1:
`notesPlacement`, `ownAreas`, `scriptDraft`, `notesStore`, `notesWindow`, `notesIpc`,
`captureExclusion`, the `cursorTracker` extension); the vitest count above has only B's and the
contracts' notes tests.

Screenshots: `docs/screenshots/teleprompter-notes-window.png` (rehearsal window, 32 KB),
`teleprompter-home-card.png` (Home's record panel with the group, 49 KB),
`teleprompter-dialog.png` (the Notes dialog, 93 KB).
