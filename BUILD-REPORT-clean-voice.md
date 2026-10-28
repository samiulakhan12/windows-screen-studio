# Build report: Clean voice (F-08 / NW-10, Studio voice)

Branch `feat-clean-voice`, from `aeca5c5` (`ccr-b6df7cf7-yked87`, Flown 0.6.0). Design:
[`docs/design/clean-voice.md`](docs/design/clean-voice.md) (§13 "As built" lists where the build
differs from the plan).

## What was built

- **Audio tab › Voice**: a **Clean voice** switch, **Strength** chips (*Light* / *Normal* / *Strong*)
  with a hint for each, and a status box: "Cleaning your voice… 42%" with a progress bar and
  **Cancel**; "Your voice is clean. The preview and the export use it." with **Hear the original**
  (a toggle button for A/B in the preview only); "Cleaning stopped…" with **Clean now**; a failure
  with its reason and **Try again**. A recording without separate sources says that its mixed track
  (microphone and PC sound together) is cleaned; a muted or missing microphone says there is nothing
  to clean. Screenshots: `docs/screenshots/clean-voice-{off,working,ready,original,mixed}.png`.
- **Engine**: ffmpeg's `arnndn` (RNNoise) with two bundled models from rnnoise-models
  (`sh.rnnn` speech-in-recording-noise, `cb.rnnn` general; 0.6 MB in all, pinned by size and SHA-256,
  bundled into the main process as text and written to `userData/voice/` before use, because ffmpeg
  cannot read inside `app.asar`). Light = `sh` at 75 % mix, Normal = `sh`, Strong = `sh` then `cb`.
  No new native code, no dependency, no download, no packaging change.
- **The cleaned stem** (`voice-<16 hex>.m4a` in the project folder, AAC 160 kb/s 48 kHz like
  `mic.m4a`): made once per source file and strength (key = SHA-256 of engine version, model
  hashes, strength, source, size and mtime), with progress and Cancel; the newest 3 are kept so
  switching strength and undo are instant. It lies exactly on the source's samples and has exactly
  its length (the 10 ms per pass delay is padded and trimmed; `amix=duration=shortest` with a
  zero-weighted copy of the source cuts arnndn's frame rounding; a late-starting mixed track keeps its
  timestamps with `aresample=async=1:first_pts=0`, as the export reads it).
- **Preview**: plays the cleaned stem in place of the microphone stem (or of the video's own track
  when there are no stems), through the existing stems graph (sync, cuts, speed, pause freezes).
  While it is being made, after Cancel, or with *Hear the original*, it plays the original.
- **Export**: the editor waits for the stem (Cancelling the export stops the wait) and sends
  `audio.voice`; the main process re-checks it and swaps the one input path. `audioPlan.ts` is
  unchanged: gains, noise reduction, loudness, music ducking (still on the original microphone's
  speech ranges), clicks and fades apply as before.
- **Old projects / switch off**: no field is added on load (`voiceLook` gives off/Normal); the job,
  the graph and the preview are exactly as before.

## Decisions and why

| Decision | Why |
|---|---|
| ffmpeg `arnndn` + RNNoise models, not DeepFilterNet3 | No signed native helper, no 8 MB, no download; 19 dB quieter pauses on Normal where `afftdn` managed 2 dB; exact, constant delay (needed for parity). DeepFilterNet3 stays the follow-up (the cache key's engine version makes a later switch automatic). |
| Strong = `sh` then `cb` (not `sh` twice) | Measured: two `sh` passes removed the band-limited JFK speech entirely (−40 dB). `cb` second keeps every voice and still removes 23–30 dB. |
| Render once, play the file | What you hear is what you export, by construction; no AudioWorklet/WASM to keep in step with ffmpeg. |
| Stem replaces the mic stem (or the mixed track), nothing else changes | Smallest substitution: one input path in the export, one element in the preview. |
| Main re-resolves and can render at export time | The export can never use a stale or wrong file; the renderer names a strength, never a path. |
| Stems store in the renderer, auto-render on need but never after the user's Cancel or a failure | Opening a project or undoing back to a strength just works; Cancel is respected. |
| Models as `?raw` text written to userData | Avoids `extraResources`/`electron-builder.config.cjs` changes; hash-checked before every render. |

## Files

New: `src/shared/audio/voiceClean.ts`, `src/shared/audio/voiceCopy.ts`, `src/shared/api/voice.ts`,
`src/main/voice/{voiceClean,voiceIpc}.ts`, `src/main/voice/model/{sh,cb}.rnnn` + `MODEL.md` +
`.gitattributes` + `model.d.ts`, `src/preload/voice.ts`, `src/renderer/src/editor/voiceStems.ts`,
`src/renderer/src/editor/panels/{VoiceSection.tsx,voice.css}`, `resources/notices/33-rnnoise.txt`,
tests `tests/{voiceClean,voiceCleanMain,voiceStems,voiceBench}.test.ts`,
`tests/e2e/clean-voice.e2e.cjs`, the design doc, screenshots.

Additive lines in shared files: `types.ts` (two types, `AudioSettings.voice`), `api.ts`,
`preload/index.ts`, `main/index.ts` (register), `analysisIpc.ts` (`stopVoiceClean` in
`stopAnalyses`, so Windows can delete a project mid-render), `mediaProtocol.ts` (serves
`voice-[0-9a-f]{16}\.m4a` only), `exportIpc.ts` (one call), `exportJob.ts` (validate `voice`),
`api/export.ts` (`RecordingSound.voice`), `previewAudio.ts`, `exporter.ts`, `AudioPanel.tsx` (one
import, one line), `resources/THIRD_PARTY_NOTICES.txt` (regenerated by `npm run notices`: only the
new entry). Not touched: `audioPlan.ts`, `project.ts`, `package.json`, `scripts/*`,
`electron-builder.config.cjs`, speech files, recording files, vertical-video files.

## Measurements

Real speech (the committed LibriSpeech and JFK fixtures) with synthesised fan and keyboard noise
(no microphone on the build machine, so the noise was added, not recorded in a room):

| | Pause noise | LibriSpeech level | JFK level |
|---|---|---|---|
| Light | −8 dB | −0.3 dB | about −1.6 dB |
| Normal | −12 to −19 dB | −0.3 dB | about −2 dB |
| Strong | −23 dB | −0.4 dB | about −2 dB |

(JFK's own crowd noise goes too, hence its extra dB.) Full table with fwSNRseg and SI-SDR, and the
comparison with `afftdn` and other models: design §2.2. In the app (e2e, speech fixture exported to
M4A, levels as heard per side): noise stretch −29.1 dBFS plain → −44.3 Normal → −59.0 Strong;
speech within 0.5 dB.

## Tests

- Unit (vitest): 71 tests for this feature in 4 files: every rule of `voiceClean.ts`; the main
  cleaner with the real ffmpeg (sample alignment and exact length for every strength, progress,
  cache reuse, new key on strength or file change, pruning, mixed track on its timestamps, missing
  files, invalid ids/sources/strengths, cancel, join, replace, quick strength changes leaving one
  render that Cancel stops, a made stem never stopping another render, model pins and rewrite of a
  damaged model, IPC sender checks, job validation, export substitution and its fallbacks); the
  renderer store with a fake API; the bench above (fails with the old Strong: checked). New tests
  were checked to fail without their code where it mattered (alignment, Strong, the render race).
- e2e (`tests/e2e/clean-voice.e2e.cjs`, 3 tests): switch → stem → preview plays it, not the mic;
  Hear the original; Strong with the keyboard, undo back to Normal with no new render; exports
  plain / Normal / Strong / off compared by level; Cancel (focus stays on the button, nothing left
  behind, not restarted by itself) and Clean now; a recording without stems; a muted microphone.

## Verification

VERIFICATION_PLACEHOLDER

## Review

An independent review found a render race (two renders for one project when strengths change
quickly, one of which Cancel could not stop), the export cleaning the mixed track when a stem file
went missing (the preview played it as recorded), a replaced render shown as the user's Cancel after
undo, a failed preview element not reloaded, and accessibility points (per-percent announcements, a
double click on Clean now cancelling, bar contrast, hover hiding the pressed look). All fixed, with
tests (commit "Clean voice: review fixes").

## Needs a real Windows PC

- The Windows ffmpeg build (`ffmpeg-static` b6.1.1) running `arnndn` with a model named by a bare
  file name in the working folder (expected: core filter since 4.3).
- File locking: pruning an older stem the preview still has open (skipped and retried later), and
  deleting a project during a render (the render is stopped first through `stopAnalyses`).
- Real-room recordings by ear, including Chromium's own noise suppression (on while recording)
  stacked with Clean voice.
- Keyboard: Space plays the video everywhere in the editor (existing rule), so the switch, like
  every editor toggle, is changed with the mouse; the chips and buttons work with Tab and Enter.

## Left for later

DeepFilterNet3 as a better engine; the "studio voice" preset (EQ, compressor, de-esser); recording the
microphone raw when Clean voice will be used (recording files, another branch); transcription and the
speech detector reading the cleaned voice; Clean voice in saved defaults and the brand kit.
