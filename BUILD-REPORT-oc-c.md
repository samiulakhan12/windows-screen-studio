# Build report: offline captions and the speech detector, workstream C

Branch `feat-oc-c`, from `2011f42` (the approved spec `docs/design/offline-captions.md` and the
compiled contracts). Workstream C: the renderer, the shared consumers, the UI and the end-to-end
tests of F-01 (captions on this PC), F-03 (the speech detector) and the minimal model manager of
F-13. A (`feat-oc-a`, native helper and packaging) and B (`feat-oc-b`, main process) were merged in
during the work (with the editing-wins wave they had merged), and at the lead's request the base
branch `ccr-b6df7cf7-yked87` at `d0dff61` (A and B merged, editing-wins review fixes), cleanly.

## What I built

**Shared consumers (pure, §3.6)**

- `src/shared/audio/voice.ts` (bodies): `withTails` (≤ 0.3 s after, ≤ 0.1 s before, only into
  level-based sound that touches the speech, never across a gap; clatter that touches no speech is
  dropped), `speechActivity` (joined across `ACTIVITY.hold`, ≥ `ACTIVITY.minLength`), `trustSpeech`
  (under 2.0 s of speech against 10 s or more of sound: judged by the level), `soundDetector`
  (`speech | mixed | guard | level`, null while levels are missing or without sound).
- `src/shared/audio/soundtrack.ts` `sourceActivity`: **regression lock**: when no heard source
  carries `speech` it runs exactly today's code (`combineLevels` + `detectActivity`). Otherwise each
  source by its own rule, joined: microphone = `speechActivity`, system stem = `detectActivity`
  with its own adaptive threshold, mixed track without stems = speech ∪ level, trust guard = level.
  Same signature and null rules; Smart speed, Remove silences and both duckings (preview and export)
  read it unchanged.
- `src/shared/audio/speech.ts`: `speechFromLevels` uses `levels.speech` (joined across 1.0 s,
  ≥ 0.6 s, no input-noise filter, no trust guard) and is today's code without it;
  `DirectorSpeech.detector?`; `refineSpeech`'s levels argument gains an optional `detector`
  (additive). `directorAnalysis.ts` passes `detector: 'speech'` only when the detector ran.
- `src/shared/editor/directorCopy.ts`: a `mix-voice` source state with the spec's line ("Listening
  for voices in the recording's sound …"); the microphone line is unchanged.
- `src/shared/speech/estimate.ts` (bodies): `nextTimeLeft` (shown once 10 % is done or 15 s passed,
  smoothed 0.3, never rising by less than 30 s), `durationWords` (under 1 min, half minutes up to
  3 min, whole minutes rounded up, hours), `sizeWords` (decimal MB, GB with one decimal).
- `src/shared/speech/speechCopy.ts` (new): every renderer sentence of §7 (tier first, model once in
  brackets), the Settings rows, the Clip/Audio hints, the notices and badge titles.

**Renderer**

- `speechState.ts` (new): the speech state read once per app session with **loading kept apart from
  failure** (a rejected read, e.g. no handler, counts as unavailable and is logged once per read),
  `speech:changed` subscription, the session-only quality choice, **download-then-captions keyed by
  project** (captions start only if that project's editor is still open and the intent pending;
  closing the editor drops the intent and lets the download finish; never for another project),
  the runs of this session (for the "… detected … in 42 s" summary), the parts kept by a Cancel,
  the "Captions ready" / "could not be made" / "speech model could not be downloaded" notices while
  another tab is open, and the badge (`useCaptionsHost`, used by `Inspector.tsx`).
- `CaptionsPanel.tsx` (GenerateSection, additive) and `LocalCaptions.tsx` (new): "Checking this PC…"
  until both reads finish; "On this PC (free, private)" first in the provider select, or the static
  "Captions are made on this PC …" line without keys; the unavailable hint with today's key block;
  `pickTranscriber` with the session's remembered choice; the **Quality** radio group (visible
  "Fast · 44 MB" / "Standard · Downloaded", accessible names "Fast, 44 megabyte download"; Most
  accurate only once downloaded and allowed; never calls `setDefaultSpeechModel`); purpose,
  estimate, "Manage speech models…", the compatible-build and slower-than-the-recording lines, the
  language hint; every §7.2 state (`no-sound`, `needs-model` with one primary button, "Make them now
  with …", small print, the one cloud link and the providers-could-not-be-read line, aria-disabled
  download with the visible disk or offline reason; `downloading` with retrying; `verifying` with
  focus on the card's heading; `stopped`; `download-failed` with every reason and its button;
  `ready` with the memory warning; `running` with recording time, time left, "Heard:", "Continuing:"
  and `data-part`/`data-parts`; `cancelled`; `done` with "Not {language}?" only after a detection;
  `error` with the button chosen by `localErrorCode`); cloud errors offer "Use On this PC"; the
  "Generate captions" command waits for both reads and starts only when the chosen quality is
  downloaded, else focuses the download button; the new intro copy.
- `captionItems.ts` (additive): `startedAt` and `local { model, language }` on the job.
- `Inspector.tsx` (about 10 lines): the ring (`captions-job-badge`, `data-phase`, `aria-hidden`).
- `ClipPanel.tsx`: the `silence-detector` line with `data-detector`, the voice hints for Silences and
  Idle parts. `AudioPanel.tsx`: the ducking hint in the voice case (reads the same levels as the
  preview through `loadAudioAnalysis`).
- Settings: `SpeechModelsSection.tsx` + `speech.css` (§7.3: lead, radio group only on downloaded
  rows, badges, facts with per-10-minutes estimate and memory, purpose, licence line, every row
  action incl. retrying, Stopped/Continue/Delete, inline Remove question with Esc, aria-disabled
  Remove while in use, blocked rows with their reason linked by `aria-describedby`, engine and
  detector lines, footer with Show folder; `reveal` scrolls and focuses the heading);
  `SettingsDialog.tsx` (section `speech` between AI providers and About), `SettingsButton.tsx`
  (`'speech'` no longer coerced to `'ai'`), `AiProvidersSection.tsx` (the "No key?" sentence;
  "+ Add provider" autofocus only when opened at `ai`), `AboutSection.tsx` + `NoticesPanel.tsx`
  (inline disclosure, `pre` role=document, Esc collapses it without closing Settings).
- Accessibility (§7.7): progress bars with role, min/max/now and text; a hidden `aria-live` span
  (shared `.sr-only` added to `styles.css`) speaks phase changes and every 25 %; the visible running
  and downloading blocks carry no live region (also removed from the cloud running block); errors
  `role=alert`; focus never falls to the body (Download → Cancel → heading → Cancel → Regenerate);
  `prefers-reduced-motion` for the ring and the busy bar; contrast of every token pair used checked
  (lowest 4.97:1, `--text-3` on `--surface-2`).

**Tests**

- New: `tests/speechEstimate.test.ts` (13), `tests/voice.test.ts` (13), `tests/soundtrackSpeech.test.ts`
  (8: the regression lock on three literal envelopes, union, superset, guard, the system stem's own
  threshold), `tests/speechCopy.test.ts` (11, including "every Captions-tab sentence that names a
  model names its tier first").
- Extended: `tests/directorSpeech.test.ts` (+6), `tests/captionsPanel.test.ts` (+23: checking while
  either read is pending, a failed read is today's tab, the local option first, chips, "Make them
  now with …", the consent card, slow-PC lines, no-sound, the command, every error button,
  no-model, the cloud error link, the summary, download-then-captions with the editor open, closed
  and for another project).
- End to end: `tests/e2e/offline-captions.e2e.cjs` (13 tests), `speech-fixtures.cjs` (the §10.3
  fixture: silence, JFK, brown noise with 8 Hz key clicks, LibriSpeech), `speech-hold-helper.sh`
  (mode 755), the `/hf/` route in `ai-mock-server.cjs` (Range/206, faults `cut`, `flip`, `slow`,
  404, 403, queued once each). Migrated: `captions.e2e.cjs` (today's key block with
  `SSW_SPEECH_HELPER=/nonexistent`, a new case for the consent card and "On this PC" first),
  `ai.e2e.cjs` (the providers intro sentence), `camera-director.e2e.cjs` (real speech at 0.5-6,
  17-22, 34-46.5 s from the committed FLACs; the plan's boundaries come out at 6.55, 16.13, 22.95,
  33.69 and 48 s, inside the existing tolerances; a new case with the helper missing), and helper
  checks in `audio-pack`, `polish` and `w3fix-timeline` (the last two also assert
  `data-detector="mixed"`).
- Docs: `docs/FEATURES.md` (Captions on this PC, Speech detector, the ducking change), `docs/ROADMAP.md`
  (F-01, F-03 shipped; F-13 minimal and LT-20 with F-01), `docs/RELEASE-NOTES.md` (new, with the
  ducking line), screenshots `docs/screenshots/offline-captions-*.png` (12, 15-61 KB each).

## Deviations and why

1. **B bug: Cancel during a streaming download hangs** (`src/main/speech/download.ts`, B's file, not
   changed here). In `netGet`, after `request.abort()` once the response has started, the response
   emits neither `end`, `error` nor `aborted`, so the body generator waits forever: the row stays
   "Downloading… 3 % · 2 of 44 MB" and the download never becomes `stopped`. The e2e test "Settings
   stops a download ("Stopped at …") and Continue completes it" fails on it (the Captions tab's
   Cancel in `downloading` has the same cause). Proposed fix, in the body generator:
   `signal.addEventListener('abort', () => { failed = new Error('aborted'); poke() }, { once: true })`
   (and `if (opts.signal.aborted) throw cancelled()` at the top of the `for await` loop). No local
   workaround is possible from the renderer.
2. `durationWords` rounds up as §3.3's table does, so Standard on the compatible build reads
   "about 12 min" (11.2 min), where §3.3's prose says "about 11 min". The test follows the table rule.
3. `DirectorSpeech.detector` is set only when the speech detector ran (`'speech'`); without it the
   field is absent, so the director's results stay exactly today's objects (B's
   `directorAnalysis.test.ts` deep-equals them). The status line uses a new `mix-voice` state.
4. The Quality chips are a radio group of their own (`role=radiogroup`/`radio`, arrow keys) with
   the `chips`/`chip` classes: the shared `Chips` control is a button group with `aria-pressed` and no
   per-option accessible name, and `controls.tsx` is not one of C's files.
5. No key provider and the providers could not be read, with On this PC available: the read error
   and [Check again] show under the cloud link, not as today's whole key block (one primary action).
6. The time left of a running job is computed from the progress since the first progress line of
   the run (parts resumed from the cache would otherwise make the first estimate near 0 s, which
   the no-rise rule would then keep), updated when the share moves and counted down in between.
7. "Exporting now slows the captions down." is not built (the spec's cut-first item).
8. No release-notes file existed: `docs/RELEASE-NOTES.md` is new.
9. E2E item 7 needs Whisper base: the test fetches it once from its pinned address into the test
   cache (`npm run fetch:test-speech` only fetches tiny), checked against its SHA-256.
10. E2E item 9 reads the preview's ducking by recording the Web Audio gain automation calls
    (`AudioParam.setValueAtTime`/`linearRampToValueAtTime`) from the test; the app has no hook.
11. audio-pack's microphone-tone cases pass with today's numbers without a guard assertion: their
    numbers do not depend on the microphone's activity (the ducking case runs on a mixed track, the
    stems case's ducking follows the steady system tone).
12. **Polish in one click (E-01) wired to captions on this PC**, at the lead's request (§3.8):
    `polishTranscriber()` in `shared/editor/polish.ts` uses the frozen `speech/transcriber.ts`
    (`pickTranscriber`, `canTranscribeNow`): On this PC with a downloaded model first; a remembered
    On this PC without a model skips captions with a new `no-model` reason whose text is
    `CAPTIONS_SKIPPED_NO_MODEL`, even when a key exists; never a download. `PolishDialog` waits for
    the speech state too, lists "On this PC (free, private)" in its picker (also while `no-model`,
    so the user can switch), says "Runs on this PC: nothing is uploaded …" and passes the model;
    `polishRunner` hands it to `fetchTranscript`. The old key-only `pickTranscriber` of polish.ts is
    kept (its tests use it). Tests: `tests/polishLocal.test.ts` (7); `one-click-polish.e2e.cjs`
    passes. The caption-row and "left out after" times in CaptionsPanel were left to the lead.
13. Commits carry the session line given in the task (`session_01WUGBwQ8vJoqr9176Dsm72x`).

## Verification

Setup: `npm ci`; xvfb present; openbox installed late (it needed `apt-get update` first);
Rust 1.97, cmake, clang present. Host helper: `npm run build:speech-host` (A's script, after the
second merge) → `native/bin/ssw-speech` (1689 KB); `npm run fetch:test-speech` → the pinned
`ggml-tiny-q8_0.bin` matches. (Before A's scripts landed I built the same crate with
`GGML_NATIVE=OFF cargo build --release` and fetched the pinned tiny model with curl, SHA-256 checked.)

- `npm run typecheck`: clean (both projects).
- `npx vitest run --testTimeout=60000`: **189 files, 2634 tests passed** (after the final base merge).
- `npm run build`: ok.
- `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs offline-captions captions ai
  camera-director audio-pack polish w3fix-timeline` (the filter also matches `one-click-polish`
  and `offline-captions`), final build, run together with audit-recording, native and
  integration-native: **10 of 12 files passed**, 65 tests passed.
  - `offline-captions`: 12 of 13 pass; **fails: "Settings stops a download ("Stopped at …") and
    Continue completes it"**, B's cancel bug (deviation 1).
  - `audio-pack`: two recording cases (a Chromium recording's microphone stem alignment, 0.020 s;
    crash recovery, 0.445 s) failed in this run; a different one of them failed in each earlier
    run, and an immediate re-run of `audio-pack` alone passed all 10. They test recording and stem
    alignment, which C does not touch.
  - camera-director 7/7, captions 8/8, ai 4/4, one-click-polish 3/3, polish 5/5, w3fix-timeline 4/4.
- Full suite `xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` (before the final base merge
  and the Polish wiring): **45 of 50 files passed**. Failing: offline-captions (the same B bug);
  audio-pack crash recovery (flaky, see above); `native` and `audit-recording` (quitting during a
  native recording: `Cannot read properties of undefined (reading '_object')`) and `teleprompter`
  (window drag): openbox was missing then (apt could not find it until `apt-get update`); with
  openbox installed, `native` and `audit-recording` passed in the final run above and
  `teleprompter` passed on its re-run. I did not re-run the whole 50-file suite after the final
  merge.

Measured on the e2e fixture (tiny on the host build): the words include "americans", "country",
"apostle", "middle", "classes", "gospel"; every word lies inside the speech, none in the noise; the
speech detector finds speech at 1.34-12.00 and 16.58-21.50 s and none in the clatter (12-16 s);
Remove silences finds 12.1-16.2 s with the detector (`data-detector="speech"`) and nothing there
without it (`level`); the music ducks to 0.20 under speech and stays at 1.00 under the clatter in
both the preview and the export (0.20 under the clatter too without the detector); a restart runs
no `vad` (the project's `.cache/speech.json` is read); cancel at part 2 of 3 leaves no helper process
and no `ssw-transcribe-*` folder, and the restart continues with "Continuing: 1 of 3 parts were
already done.".
