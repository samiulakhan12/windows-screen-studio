# Build report: Unwanted-sound finder (F-17)

Branch `feat-sound-finder`, from `546e479` (`ccr-b6df7cf7-yked87`, Flown 0.7.0 with 0.7.1's auto-update).
Design: [`docs/design/sound-finder.md`](docs/design/sound-finder.md) (§13 "As built" lists where the
build differs from the plan).

## What was built

- **Audio tab › Unwanted sounds**: *Find unwanted sounds* listens to the recording on this PC and lists
  coughs (and throat clearing), sneezes, typing, notification sounds (dings, pings, beeps, chimes,
  bells), phones (ringing, buzzing), dogs, knocks and doors, and background music. Speech is never
  listed. Progress bar with *Cancel* ("Getting the recording ready…" while the levels and the speech
  detector are measured, then "Listening to the recording… 42%"); a failure says why with *Try again*.
- **Each row**: *Play* (plays it with half a second around it, as it will sound), the kind, the
  timeline time and the length, and **Mute** (silence with 20 ms ramps), **Duck** (−14 dB), **Cut**
  (an ordinary cut, with the usual smooth-cut fades) and **Ignore**; afterwards *Restore* or *Bring
  back*. **Mute all**, **Show ignored (n)**. A polite live region announces each action; the focus
  stays on the row (or moves to the next one when a row leaves the list). Every action is one
  `store.update`, so one undo step. Screenshots: `docs/screenshots/sound-finder-{start,listening,list,actions}.png`.
- **Classifier**: YAMNet (Apache-2.0, 4,126,810 B, pinned by SHA-256) through `@mediapipe/tasks-audio`
  1.0.1 (Apache-2.0), on the CPU in a module Web Worker per source, bundled by Vite into
  `out/renderer/assets/` exactly like the camera's person segmenter (≈ 11 MB installed, ≈ 4.9 MB
  brotli). Nothing is downloaded. `resources/sounds/MODEL.md`, `resources/notices/34-yamnet.txt`,
  `scripts/notices.mjs` names the package, `resources/THIRD_PARTY_NOTICES.txt` regenerated,
  `scripts/verify-dist.mjs` checks the worker, the runtime and the model are packaged.
- **Listening**: main decodes the source with ffmpeg to 16 kHz mono floats; the window that asked pulls
  20 s chunks (ffmpeg paused two chunks ahead; streams owned per window, at most 4, closed when idle
  for 60 s, when the window goes, and with the project's other analyses when the editor closes or the
  project is deleted). Windows of 0.975 s every 0.4875 s; windows that are quiet (< −50 dBFS) or ≥ 90%
  inside the speech detector's ranges are not classified. The microphone and system stems are
  listened to apart (in parallel) when the recording has them, else the mixed track.
- **Rows** (`findSounds`, pure): per kind, windows above its threshold that beat YAMNet's speech score,
  joined within 0.5 s, speech (the speech detector's ranges, or YAMNet's speech score when the
  detector cannot run) taken out with 0.1 s to spare, each piece fitted to the 50 ms sound levels,
  shortest lengths per kind (music 3 s), sources joined, at most 400 rows.
- **Cache**: the scores (one byte per kind per window, ≈ 90 KB per source-hour) in
  `<project>/.cache/sounds.json`, keyed by the file's size and time, the model's hash, the scan
  version and the speech skipped. Opening the recording again shows the list without listening.
- **Mute / Duck** are spans in the new optional `Project.sounds` (absent in every older project).
  One gain curve, piecewise with ramps on the louder side of each edge, is played by both: the export
  puts `asetnsamples=n=64,volume='<expr>':eval=frame` on the recording's mixed sound in source time,
  before cuts, speed changes and pause freezes (`audioPlan.ts`); the preview ramps a new `sounds` gain
  node after the cut gain with the same keyframes mapped through the clips (`previewAudio.ts`).

## Decisions and why

| Decision | Why |
|---|---|
| YAMNet via MediaPipe tasks-audio | Knows every kind on the list, Apache-2.0 end to end, 4 MB, ≈ 140x real time per core; same bundling, CSP, worker pattern and notices as the camera blur. PANNs/AST are 5–80x larger and slower. |
| New devDependency `@mediapipe/tasks-audio` 1.0.1 | Unavoidable: the vision package's WebAssembly has no audio graph; any other TFLite runtime is larger. Pinned to the vision package's version; Vite bundles it (nothing added to `app.asar`'s `node_modules`). |
| ffmpeg decodes in main, the model runs in a renderer worker | ffmpeg is already how every sound is measured; MediaPipe's loader needs a browser scope (fails in Node). Pull-based chunks keep memory constant. |
| Mute/Duck on the whole recording's sound, speech never listed | Keeps `recordingMix` and the export's choice of files unchanged; with speech excluded nothing said is lost. Per-stem muting is listed for later. |
| Cache scores, not rows | Rules can be tuned later without listening again; keys depend on scores and speech only. |
| Skip speech windows while listening | Most of a narrated microphone; the main reason long recordings stay fast. |

## Tests

Unit (vitest, each checked to fail without its code):
- `tests/soundsModel.test.ts`: the model's size and SHA-256; every class index names the intended
  label in the label list packed inside the model.
- `tests/soundsScan.test.ts`: kind bytes, quiet and speech skipping, window count and the padded last
  window, results independent of chunking, skip key.
- `tests/soundsFind.test.ts`: thresholds, speech beats a weak kind, joins, fitting (per piece, after
  the speech guard), stable keys, speech guard with and without the detector, shortest lengths,
  sources joined (also by key), the 400-row cap, an hour in well under 500 ms.
- `tests/soundsEdit.test.ts`: `Project.sounds` sanitising and old projects unchanged, row states,
  every action and its restore, the piecewise curve (mute inside duck), keyframes, the ffmpeg
  expression equals the curve, output keyframes through cuts, speed and a pause freeze,
  `recordingGraph` unchanged without `sounds`, job validation, cache entries.
- `tests/soundsMain.test.ts`: real ffmpeg streams (chunks, end, failure), argument checks, ownership,
  the stream limit (also for calls at once), stop and idle close, the cache file both ways.
- `tests/soundsScanState.test.ts`: stored scores shown without listening, missing sources listened to
  and saved, progress, Cancel (also while the model loads), failure, stop.
- `tests/soundsCopy.test.ts`: sentences, and AA contrast of the row's text on its background.

End to end (`tests/e2e/sound-finder.e2e.cjs`, the built app under Xvfb): the ding (12.95–13.45 s)
and the music are found on the system sound, nothing while JFK speaks on the microphone; the cache is
written and reused (`data-from="cache"` after reopening); Mute by keyboard: the export goes from
−17.6 dBFS to −126 dBFS over the ding, unchanged elsewhere, and the preview schedules gain 0; Undo is
one step, Redo mutes again; Duck lowers the music by 14.0 dB in the export and schedules 0.2 in the
preview; Cut makes exactly that cut; Ignore / Show ignored / Bring back; Cancel on a 10-minute
recording keeps nothing and the editor stays usable; a mixed-track-only recording and a silent one.

## Speed (this 4-core Linux container, the built app)

- 10 minutes (two stems, speech half the time): **10.6 s** from the click to the list.
- 1 hour: **74.6 s**: 45 s measuring the levels and running the speech detector on the whole
  recording (shared with the rest of the editor and kept in `.cache/speech.json`), then about 30 s
  listening to both stems at once. Opening it again: under a second.
- YAMNet alone: 6.8 ms per window.

## Verification

On this Linux container (4 cores), with the speech host helper built (`npm run build:speech-host`)
and the test model fetched (`npm run fetch:test-speech`):

- `npm run typecheck`: passes.
- `npx vitest run --testTimeout=60000`: **3849 passed, 1 failed** of 3850 (287 files). The failure was
  `tests/groupMove.test.ts` › G-PERF (a 250 ms time limit, measured 251.8 ms while the e2e suite loaded
  the machine). Re-run alone it passed 3 times in a row. 52 of the tests are the sound finder's.
- `npm run build`: passes. The worker (61 KB), `audio_wasm_module_internal` (.js 253 KB, .wasm 6.58 MB)
  and `yamnet-*.tflite` (4.13 MB) are in `out/renderer/assets/`.
- `xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` (the full suite): **58 of 60 files
  passed**, 248 tests passed, 2 failed:
  - `teleprompter.e2e.cjs` › "notes: … rehearsal window …": "dragged by its strip" (the window did not
    move). It **fails the same way on the base commit 546e479**: no window manager here (`openbox` cannot
    be installed in this container).
  - `shapes.e2e.cjs` › "add from the panel …": `ENOTEMPTY` while deleting the test's temporary HOME
    after the test. Re-run alone on this branch, the whole file passes (6/6).
- After the review fixes (rebuilt): `sound-finder`, `clean-voice`, `edit-by-text`, `audio-pack`,
  `audit-audio-export`, `export-pack`, `preview-speed`, `waveform` all pass again (teleprompter and the
  shapes cleanup race as above).
- `sound-finder.e2e.cjs`: 4/4 (found in about 1 s: ping 12.95–13.45 s, music 14.63–23.40 s; ding
  −17.6 → −125.9 dBFS when muted, elsewhere −17.2 / −17.2; music lowered by 14.0 dB).
- Not run here: `npm run dist:win` and `verify-dist` (they need the Windows packaging); the new
  `verify-dist` lines were checked against the `out/renderer/assets` names of this build.

## Shared files touched (additive)

`src/shared/types.ts` (`SoundEdits`, `SoundSpan`, `Project.sounds`), `src/shared/api/export.ts`
(`RecordingSound.sounds`, `SoundGain`), `src/shared/engine/project.ts` (one name in the
destructuring, one `optional` line), `src/shared/api.ts`, `src/preload/index.ts`, `src/main/index.ts`,
`src/main/analysisIpc.ts` (`stopSoundScans` in `stopAnalyses`), `src/main/exportJob.ts` (one
validation clause), `src/shared/render/audioPlan.ts`, `src/renderer/src/editor/previewAudio.ts`,
`src/renderer/src/editor/exporter.ts`, `src/renderer/src/editor/panels/AudioPanel.tsx` (import and
element), `package.json`/`package-lock.json`, `scripts/notices.mjs` (one name), `scripts/verify-dist.mjs`
(the finder's files), `resources/THIRD_PARTY_NOTICES.txt` (regenerated), docs. The single-line lists
(`api.ts`, `preload/index.ts`, the migration's destructuring) will meet other teams' lines in a merge.

## Needs a real Windows PC

- The worker and MediaPipe's WebAssembly in the packaged app (`verify-dist` checks the files are
  there; loading them under Windows' Electron is not run here), and the speed on typical laptops.
- Real coughs, sneezes, typing, phones, dogs and knocks in real recordings: only synthetic dings and
  music were available here, so the thresholds for the other kinds come from YAMNet's published
  behaviour, not from measured recordings. The scores are cached, so thresholds can be tuned later
  without listening again.
- Hearing the preview's ramps (the scheduled values are checked here, not the sound card output).

## Left for later

Per-stem muting; a row's own depth and fade; markers on the timeline's waveform; more kinds; finding
sounds automatically after recording; decoding with `aresample=async=1` for files with timestamp gaps
(see design §10).
