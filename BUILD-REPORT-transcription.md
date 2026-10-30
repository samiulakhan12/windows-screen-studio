# Build report: captions that survive the OpenAI shutdown, with speaker labels (NW-09)

Branch `feat-transcription`, from `ccr-b6df7cf7-yked87` (546e479). Design: `docs/design/transcription.md`.

## What was checked first (30 October 2026)

OpenAI's deprecations page, speech-to-text guide, API reference and `gpt-transcribe` model page,
and the installed `openai` SDK 7.32.0 types (design §1):

- `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize` shut
  down on **26 February 2027**; the replacement for files is `gpt-transcribe` ($0.0045/min, 25 MB,
  `languages` hints).
- `gpt-transcribe` answers `{ text, languages, usage }`: **no segments, no word times**;
  `timestamp_granularities` is whisper-1 only. OpenAI has no speaker labels for files after February.
- Gemini: 9.5 h per prompt, 20 MB inline, 32 tokens/s; speaker diarization documented (a `speaker`
  field in the example schema); word-level times are not documented, so Flown checks them.

## What was built

- **OpenAI**: the suggested transcription model is `gpt-transcribe` (`resources/ai-models.json`
  and `BUNDLED_MODEL_LIST`, `updated` raised to 2026-10-31; `whisper-1` stays on the retiring list;
  the fallback default in `shared/api/ai.ts` too). Any model not named `whisper*` is sent
  `response_format: json` with `languages`, in parts of at most 30 s cut in pauses.
- **Word times for text-only answers** (`shared/captions/transcriptTiming.ts`): each part's words
  are spread by length over the stretches with sound (the ducking detector's ranges), never in a
  pause, grouped into captions at sentence ends / 12 words / 6 s / 0.7 s pauses, every word
  `estimated`. The Captions tab says so in the form and the summary (with *Use On this PC*); the
  Transcript tab underlines estimated words (dotted, `title="Estimated time"`).
- **Gemini**: asks for a `speaker` per segment (normalised to "Speaker N", dropped when only one);
  implausible word times are replaced by estimates (`checkWordTimes`).
- **Retired models**: after the day on the list, a failed request (404/403/400/other, not a bad
  key (401), quota, rate limit, server or network) says *"OpenAI retired whisper-1 on 26
  February 2027. Choose gpt-transcribe as the transcription model in Settings › AI providers, or
  make captions On this PC."* (`shared/captions/retiredModel.ts`, `main/ai/retired.ts`; text
  tasks get their own line).
- **Speaker labels**: `CaptionSegment.speaker`; *You* / *Others* from the microphone and
  computer-sound levels with no AI; Speakers section (rename everywhere on Enter or blur, one undo
  step; Remove labels; Label You and Others), a speaker menu per caption row, names in the
  Transcript tab, WebVTT voice tags always, "Name: " in SRT/text when asked, *Show speaker names*
  on the video (off by default; name never lit by karaoke). Split and merge keep the speaker.
- Old projects and settings load byte for byte unchanged (tested).

## Decisions and why

- **Estimate from the sound, not align locally**: aligning to the speech model on this PC would
  need a downloaded model and a full local run anyway; users who have one are pointed to *On this
  PC* for exact times. Left for later (design §13).
- **Suggest `gpt-transcribe` now, not on the day**: one tested path long before the deadline;
  users who typed `whisper-1` keep it with the Settings note.
- **Speakers as names on captions** (no id table): every reader works without a lookup; rename is a
  cheap map in one undo step.

## Changes outside the owned files (kept to the lines needed)

- `src/shared/api/ai.ts`: `defaultTranscriptionModel` for OpenAI (the built-in fallback of the list).
- `src/renderer/src/settings/ProviderForm.tsx`: the transcription-model hint no longer says whisper-1
  is the one to use.
- `src/shared/captions/captionData.ts`, `settings.ts`, `edit.ts`, `transcriptMerge.ts`,
  `layout.ts` (a `label` token karaoke skips), `subtitles.ts`, `render/captionsLayer.ts`,
  `src/shared/types.ts`: additive.
- Tests: `tests/aiProviders.test.ts`, `tests/aiKeyStore.test.ts`, `tests/transcriptParse.test.ts`,
  `tests/e2e/ai.e2e.cjs`, `tests/e2e/one-click-polish.e2e.cjs` now name `whisper-1` where they check
  its exact word times, or expect the new default; `tests/e2e/ai-mock-server.cjs` answers
  `gpt-transcribe` (json, no times), Gemini speakers when asked, and a "retired..." key with
  OpenAI's 404 `model_not_found`.

## Tests

- New unit tests: `tests/transcriptTiming.test.ts` (15), `tests/speakers.test.ts` (15), plus new
  cases in `tests/aiProviders.test.ts` (gpt-transcribe request and timing against the mock with real
  ffmpeg, Gemini speakers, retired model before/on the day and the test date ignored when packaged).
  Spot-checked that they fail without their code (split keeping the speaker, merge carrying
  `estimated`).
- New e2e: `tests/e2e/transcription.e2e.cjs` (4 tests): gpt-transcribe through the Captions tab
  (hint, request fields, estimated words within 0.6 s of their sound, summary, Transcript tab);
  Gemini speakers (rows, Transcript tab, rename + undo/redo, per-caption menu + undo, VTT voice
  tags, SRT names off/on, burned-in name makes the exported caption wider); You/Others from two
  tracks (and Remove labels + undo); the retired-model message in the Captions tab.
- An adversarial review (separate reader) found: the name of a multi-word speaker broke karaoke
  timing, the polish e2e expected whisper-1 text, slivers of sound could squeeze a word away, a
  rename lost focus, a 64-char field for a 32-char name. All fixed. Its remaining risk (duplicate or
  missed words where text-only parts are cut without a pause) is documented (design §3.4, §13).

## Verification

On the final code (commit with this report), in this Linux container:

- `npm run typecheck`: passes.
- `npx vitest run --testTimeout=60000`: **282 files, 3832 tests passed**, none failed.
- `npm run build`: passes.
- `xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` (the full suite, with the speech
  helper built by `npm run build:speech-host` and the test model fetched): **59 of 60 files passed**
  (259 passing tests). The one failure was this feature's own test *You and Others*: with the speech
  helper present, its detector does not count the fixture's tone bursts as speech, so (as designed,
  design §6.1) the microphone counted nowhere. The test now runs with `SSW_SPEECH_HELPER=/nonexistent`
  so the levels decide (the speech-range rule stays covered by a unit test); re-run alone,
  `tests/e2e/transcription.e2e.cjs` passes 4/4. Skipped by the suite for the environment: the
  native capture helper under wine (no MinGW/wine here), the packaged-installer checks (no
  `dist/win-unpacked`) and desktop icons under wine.
- No timing check failed or was retried in this run.

## Needs a real Windows PC / real keys

- A real `gpt-transcribe` request (the mock follows the documented shape; the answer's `languages`
  and the error OpenAI returns for a retired model after 26 February 2027 are from the docs).
- Gemini's real speaker labels and word-time quality on real speech (and across 5-minute parts).
- How close the estimated word times feel on real speech in karaoke and cuts.

## Screenshots

`docs/screenshots/transcription-form.png`, `-summary.png`, `-transcript-estimated.png`,
`-speakers.png`, `-caption-rows.png`, `-transcript-speakers.png`, `-you-and-others.png`,
`-burned-in.png` (each under 300 KB).
