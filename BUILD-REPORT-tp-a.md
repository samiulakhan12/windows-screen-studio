# Build report: teleprompter, workstream A (main process and the notes window)

Branch `feat-tp-a`, from `cfeaac5` (the contracts commit). Spec: `docs/design/teleprompter.md`.
Only workstream A's files were changed (spec §9); no frozen file and no frozen signature changed.

## What was built

| File | What |
|---|---|
| `src/shared/notes/placement.ts` | `notesBounds` (size clamped to the limits, then to the work area; saved shares on their display, else top centre of the primary work area, `NOTES_TOP_MARGIN` down), `placementOf` (display holding the centre, else the one overlapped most; 0.5 with no room), `rectsOverlap` (touching edges do not), `notesAllowed` (§2.10). |
| `src/shared/recording/ownAreas.ts` | `AreaHistory`: spans of where the window was, ±250 ms slack at both ends, the same rectangle extends the open span, at most 1000 spans, `clear()`. |
| `src/shared/notes/scriptDraft.ts` | Request check (1–20,000 characters, not only white space, text), the prompt (system text of §2.13 starting with `SCRIPT_SYSTEM_START`, user `SCRIPT_USER_START + notes`, strict `spoken_script` schema), answer check (1–300 paragraphs, cleaned, joined by a blank line, length cap; `AiOutputError` otherwise), `runScriptDraft` (asks once). |
| `src/main/recording/captureExclusion.ts` (new) | `captureExclusionSupported(platform, release)`: win32 build ≥ 19041, other platforms true; unpackaged builds honour `globalThis.__SSW_CAPTURE_EXCLUSION__`. `cameraBubbleWindow.ts` re-exports it as `bubbleSupported` (same function) and uses it. |
| `src/main/notes/notesStore.ts` | `userData/notes.json` `{ version: 1, ...NotesSettings }`, read once, sanitised field by field (with the recording hotkeys as `taken`, read again on every `get()`), written with `writeFileAtomicSync`; `hold()` keeps changes in memory, `release()` writes them once and only logs a failure; a change that changes nothing writes nothing. |
| `src/main/notes/notesWindow.ts` | The window in both modes with the §2.2 options; `setContentProtection(true)` and `setAlwaysOnTop(true, 'screen-saver')` right after construction, before `loadRoute`; record mode only ever `showInactive()`, rehearse `show()`; shown on `ready-to-show` (idempotent); bounds read back after the first show and set again when more than 1 DIP off; `render-process-gone` reloads `/notes`, `did-finish-load` sends the view again; mode change = destroy and create; re-placement on `display-removed` / `display-metrics-changed`; the older-Windows lock (`movable: false`, size changes refused, `locked` in the view); notes hotkeys registered while a window is open (problems in the view and the bar), re-registered when they change; hide/show from the bar; a hotkey while hidden only shows it; `AreaHistory` updated on every show, hide, drag end, resize and re-placement and cleared in `prepare`; `script.txt` written (async) when `keepWithRecording`; the store held for the recording; restart keeps the window hidden for the next take (new `take`). |
| `src/main/notes/notesIpc.ts` | Every `NOTES_CHANNELS` handler with its sender check (Home: main window's webContents **and** the app URL; notes window: `isNotesSender`; bar: `isToolbarSender`), values sanitised (`sanitizeLookPatch`, a report sanitiser), `notes:state` sent only on change, `notes:rehearse(true)` rejected with "Finish the recording first." during a recording. `checkAnyHotkey` (all six actions; distinct from the other five; other apps tested only outside a recording and never for the action's current accelerator). |
| `src/main/recordingIpc.ts` | `prepare`: the notes after `prepareToolbar` and before the recording hotkeys (a rehearsal closes first), `kind`/`captured` from the source and area, `CapturePlan.notesNotice`; `setStatus`: `showNotes()` before `showToolbar()` on countdown and recording, `setNotesRecording` for countdown/recording/paused; `endRecordingUi` → `endRecordingNotes(restarting)`; `ToolbarStatus.notes`, notes hotkey labels and problems in the bar; the bar refreshed when the notes change; `onIdle` bypass while the notes scroll; `isOwnPoint(p, at)` adds `notesAreaContains`; notes hotkeys in the tracker's `ignoreKeys`; `pickRegion` hides a rehearsal window meanwhile; `closeRecordingWindows` closes the notes; `disposeRecording` releases the store; `settings:checkHotkey` for any of the six actions; a changed recording hotkey re-syncs an open notes window. |
| `src/main/cursorTracker.ts` | `isOwnPoint(p, at)` with `at = clock.toEpoch(tick)` at mousedown and wheel. |
| `src/main/recording/toolbarWindow.ts` | `SIZE.width` 600, `isToolbarSender`. |
| `src/main/projects.ts` | `SCRIPT_FILE` (not in `RAW`), `writeScriptFile`, `readScriptFile` (reads at most what 50,000 characters take in UTF-8, cleaned through `readProjectScript`). |
| `src/main/recording/finalize.ts` | `project.script` from `script.txt` before `writeProject` (recovered recordings go through the same function). |
| `src/main/aiIpc.ts` | `ai:draftScript` / `ai:cancelScriptDraft` behind `fromApp`; medium effort; the controller in `textCalls` (aborted on quit); one draft at a time (a new valid request aborts the old one; cancel aborts the current one). |
| `docs/IMPLEMENTATION.md` | Layout: `src/main/notes/`, capture exclusion. |

## Deviations and decisions (with why)

1. **Window changes are saved 300 ms after the last one** (`saveLook`, flushed on close, end of a recording and `prepare`). The grip sends one `notes:look` per animation frame; saving each would run up to 60 synchronous `notes.json` writes a second while rehearsing. The view and Home see the new value at once (`notesSettingsNow()` merges the pending change).
2. **A `'moved'` that only reports our own `setBounds()` saves nothing.** Some platforms emit it for programmatic moves; without the guard a display change would turn the default place into a saved "Where you left it".
3. **Locked window re-placed onto the capture is hidden.** §2.10's intent is that on older Windows the notes never appear in what is recorded; if a display change moves the locked window over the captured rectangle, it is hidden (the bar can show it again only by the presenter's choice). Not stated in the spec; follows its intent.
4. **`notesWindow.ts` exports more than the stub** (allowed: "A's own, may change"): `onNotesChange`, `notesSettingsNow`, `notesView`, `notesHotkeyLabels`, `notesHotkeyProblems`, `setNotesReport`, `setNotesLook`, `dismissNotes`, `notesSettingsChanged`, `NOTES_NOTICE`. `closeRehearsal(focusMain = false)` gained an optional parameter (Home focus only when closed from the window itself, §2.1.5).
5. **`checkAnyHotkey` lives in `notesIpc.ts`** with its context injected, and `recordingIpc`'s `checkHotkey` calls it, so the rule is unit-tested without the whole recorder.
6. **`prepareRecordingNotes` runs for every recording** (it returns `{ shown: false }` when the notes are not used), so rehearsal is refused from `prepare` to the end of every recording, as §2.1 says ("prepared or running").
7. **Test placement**: the `recordingIpc` hook tests are in `tests/notesIpc.test.ts`, the draft IPC tests in `tests/scriptDraft.test.ts`, and the `finalize` → `project.script` test (real ffmpeg, like `nativeVideo.test.ts`) in `tests/notesWindow.test.ts`, to stay inside the listed test files.
8. **Spec test example "2000×1200 shrinks to the work area"**: with the frozen limits (`NOTES_WIDTH.max` 1200, `NOTES_HEIGHT.max` 720) that size is clamped by the limits first; the test checks that, and the work-area shrink on a smaller display.
9. **Draft answer cleaning**: line breaks inside a paragraph become spaces, other control characters are removed (`'Hi\u0007 there'` → `'Hi there'`); list markers need a following space (or the end), so "2024 was busy." is kept.
10. **No new test file outside the list**, no change to `cameraBubble.test.ts` or any existing test (only additions to `cursorTracker.test.ts`).

Nothing in the spec was found contradictory enough to need a signature change.

## Tests

New: `tests/notesPlacement.test.ts`, `tests/ownAreas.test.ts`, `tests/scriptDraft.test.ts`, `tests/notesStore.test.ts`, `tests/notesWindow.test.ts` (fake `BrowserWindow` recording every call), `tests/notesIpc.test.ts`, `tests/captureExclusion.test.ts`; extended: `tests/cursorTracker.test.ts`.

**Every rule fails without its code**: a mutation pass (`110` source mutations, each removing or breaking one rule, then running that rule's test file) killed all of them after five weak tests were tightened (view sent only on change, span extension, window recordings never allowed, centre over overlap, `release()` with no change). The script is not committed (scratch).

## Verification

```
npm ci                                   ok
npm run typecheck                        ok (node and web)
npx vitest run --testTimeout=60000       Test Files 144 passed (144), Tests 2052 passed (2052)
npm run build                            ok
xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs recording camera-live
E2E_RESULT
```
