# Clean voice (F-08 / NW-10, Studio voice)

Status: designed and built on `feat-clean-voice` (from `ccr-b6df7cf7-yked87`, Flown 0.6.0). §13
"As built" records where the build differs. Roadmap: `docs/ROADMAP.md` NW-10 ("Studio voice with
live preview") and F-08 ("Studio voice").

Code read for this design: `src/shared/audio/{settings,soundtrack,voice,loudness,activity}.ts`,
`src/shared/render/audioPlan.ts`, `src/shared/api/{export,speech}.ts`, `src/shared/types.ts`,
`src/shared/engine/project.ts` (`migrateAudio`), `src/main/{exportIpc,exportJob,exportArgs,ffmpeg,
audioAnalysis,analysisIpc,projectProcesses,mediaProtocol,projects,proxyArgs,security}.ts`,
`src/main/recording/finalize.ts` (how `mic.m4a` is made), `src/main/speech/speechIpc.ts` (event
pattern), `src/preload/*`, `src/renderer/src/editor/{previewAudio,player,exporter,controls}.ts(x)`,
`panels/AudioPanel.tsx`, `src/renderer/src/recorder/session.ts`, `scripts/{notices.mjs,lib/packaging.cjs}`,
`resources/notices/*`, `tests/e2e/speech-fixtures.cjs`.

The rules earlier waves set still hold:
- Preview and export agree: what you hear is what you export.
- Every edit is one undo step.
- Projects and settings made before this feature open, preview and export exactly as before.

Other branches being built at the same time: this feature does not touch the speech detector or its
models (`native/speech/**`, `src/main/speech/*`, `src/shared/speech/*`, `src/shared/audio/voice.ts`,
which is the speech detector's sound rule, not this feature), nor the recording files, the
vertical-video files, `scripts/*` or `electron-builder.config.cjs`. Shared files get additive lines
only (§10).

---

## 1. What the user gets

- A **Voice** section at the top of the Audio panel's clean-up area with one switch, **Clean voice**.
  Turned on, it removes fan hum, keyboard and mouse clicks and room noise from the microphone,
  **offline, on this PC**. Nothing is uploaded and nothing is downloaded.
- **Strength**: *Light*, *Normal* (default), *Strong* (§4.2 says exactly what each does).
- The cleaned voice is made once (about 100x faster than real time: an hour of microphone sound
  takes well under a minute) with a progress bar and **Cancel**, and kept in the project folder. It
  is made again only when what it is made from changes (the strength, or the microphone file).
- The **preview plays the cleaned voice**, so what you hear is what you export.
  **Hear the original** (a toggle button) switches the preview to the untouched microphone for a
  quick A/B; the export always uses the cleaned voice while the switch is on.
- The export uses the same cleaned file, mixed with the system sound, the music (and its ducking),
  click sounds, levels and fades exactly as the original microphone would be.
- Projects that never turned it on, and projects with the switch off, sound and export exactly as
  before.

---

## 2. Engine comparison and decision

### 2.1 Candidates

| | **ffmpeg `arnndn` + RNNoise model** (chosen) | **DeepFilterNet3** | ffmpeg `afftdn` (today's *Noise reduction*) |
|---|---|---|---|
| What | RNNoise (Xiph, Jean-Marc Valin): a small recurrent network that sets a gain per band every 10 ms. Built into ffmpeg as the `arnndn` filter since 4.3. | A two-stage deep filter (ERB gains + deep filtering of the low bands), state of the art among small denoisers. | Classic spectral subtraction with a noise-floor estimate. |
| Code licence | FFmpeg (LGPL 2.1+/GPL as built; already shipped, notice in `30-ffmpeg.txt`); `af_arnndn.c` carries Xiph's BSD-3-Clause RNNoise notice. | MIT or Apache-2.0 (dual). | FFmpeg, already shipped. |
| Model | `somnolent-hogwash` (`sh.rnnn`) from `GregorR/rnnoise-models`, **297,646 bytes** (text). The repo's README: "With the exception of the tools/ directory and this file, none of this work is creative and thus none of it is subject to copyright." Trained on LibriVox (public domain) and Xiph's RNNoise contributions. | Weights MIT/Apache-2.0, about 8 MB (ONNX/tract tarball). | none |
| New native code | **none**: the bundled `ffmpeg-static` already has `arnndn` (checked: `ffmpeg -filters` lists it in 7.0.2, and it is a core filter with no external library, so every Windows build has it). | A Rust helper (`deep-filter`, tract) to build, sign, package and verify for Windows, like `native/speech`: a new `native/voice` crate, `scripts/build-native.mjs` and `verify-dist` changes, about 5–8 MB more installer. | none |
| Speed (measured here, one CPU core) | 21.4 s of sound in 0.20 s (≈ **100x** real time) per pass. | Published: real-time factor about 0.04 on one core (≈ 25x). Not measured here (the downloaded binary could not be run in this environment). | 0.10 s (≈ 200x). |
| Latency | exactly **480 samples (10 ms) per pass** at 48 kHz (measured by cross-correlation, any `mix`). | about 40 ms (look-ahead). | 25 ms (`DENOISE_LATENCY`). |

### 2.2 Measurement

Real speech (the committed LibriSpeech `1272-128104-0000` and JFK fixtures, 21.36 s with 1.5 s and
2 s pauses) with added noise: a computer fan (pink noise below 6 kHz, 100/200/300 Hz hum and a
230 Hz blade tone wobbling at 0.4 Hz, −40 dBFS RMS) and a keyboard (5–25 ms clicks in typing
bursts, about 7 a second, −22 to −14 dBFS peaks). There is no microphone in the build machine, so
the noise was synthesised and added to recorded speech rather than recorded in a room; this is the
honest limit of the measurement (§12). Measures, on 48 kHz mono, after removing each filter's delay:

- **Pause noise**: RMS of the output where the clean speech is silent (what the listener hears as
  "background"). Lower is better.
- **fwSNRseg** (frequency-weighted segmental SNR, 25 mel bands, 30 ms frames) on the LibriSpeech
  part, against the clean speech: how much of the voice survives without noise. Higher is better.
- **SI-SDR** on the same part: waveform fidelity; it also counts any change of the voice's timbre
  as error, so it drops when a denoiser reshapes the voice even when it sounds better.

| Variant | Pause noise | fwSNRseg | SI-SDR | Voice level |
|---|---|---|---|---|
| Noisy input | −38.5 dBFS | 10.97 dB | 15.08 dB | +0.13 dB |
| `afftdn` strength 1 (today's strongest) | −40.6 dBFS | 10.18 dB | 15.10 dB | −0.04 dB |
| `arnndn` cb (recording noise, general signal) | −53.6 dBFS | 10.91 dB | 11.61 dB | −0.62 dB |
| `arnndn` bd (recording noise, voice) | −56.8 dBFS | 11.63 dB | 11.39 dB | −0.69 dB |
| **Light**: `arnndn` sh, `mix=0.75` | **−48.9 dBFS** (−10 dB) | 10.59 dB | 14.03 dB | −0.34 dB |
| **Normal**: `arnndn` sh | **−57.4 dBFS** (−19 dB) | 11.62 dB | 12.03 dB | −0.43 dB |
| ~~`arnndn` sh twice~~ (first plan for Strong, dropped: §13) | −64.1 dBFS (−26 dB) | 12.02 dB | 8.00 dB | −0.43 dB |
| **Strong**: `arnndn` sh, then cb | **−61.8 dBFS** (−23 dB) | 11.55 dB | 8.02 dB | −0.43 dB |

`afftdn` barely touches this noise (2 dB): it is made for steady hiss, not clicks or a wobbling fan.
RNNoise with the speech-in-recording-noise model (`sh`) removes 19 dB in the pauses and keeps more of
the voice than the input had (fwSNRseg up). Strong trades voice fidelity (SI-SDR 8 dB) for 7 dB
more quiet, which is why it is not the default. The unit test `tests/voiceBench.test.ts` repeats this
measurement with the shipped filter strings on every run (§11) and prints the numbers.

### 2.3 Decision

**ffmpeg `arnndn` with the `sh.rnnn` model.** It sounds clearly better than what ships today, needs
no new native build, no download and no new dependency, adds 0.6 MB (two models), and its delay is exact and
constant, which is what preview/export parity needs. DeepFilterNet3 is likely better on hard noise
(babble, reverb), but needs a new signed Rust helper and 8 MB; it stays the follow-up (§12) and the
design keeps the engine behind one function (`voiceCleanArgs`) and a versioned cache key, so a later
engine replaces the stems by itself.

---

## 3. Data model

### 3.1 `src/shared/types.ts` (additive, optional)

```ts
/** How hard Clean voice works (docs/design/clean-voice.md §4.2). */
export type VoiceStrength = 'light' | 'normal' | 'strong'

/** Clean voice (F-08): the microphone (or the mixed track without one) cleaned of noise. */
export interface VoiceSettings {
  on: boolean
  strength: VoiceStrength
}

export interface AudioSettings {
  …
  /** Absent in older projects: off. */
  voice?: VoiceSettings
}
```

The strength is kept when the switch goes off, so turning it on again restores it.

### 3.2 Old projects and settings

`migrateAudio` (`shared/engine/project.ts`) spreads the stored `audio` object, so a project without
`voice` loads byte-for-byte unchanged and one with it keeps it. No migration code is added. Readers
go through `voiceLook(audio)` (§9), which gives `{ on: false, strength: 'normal' }` for an absent or
malformed field (an unknown strength reads as `'normal'`, a non-boolean `on` as off). No app setting
is added.

### 3.3 Files in the project folder

- `voice-<key>.m4a`: the cleaned voice. `<key>` is 16 hex digits, the first 64 bits of the SHA-256 of
  `JSON.stringify({ engine: VOICE_ENGINE.version, model: VOICE_ENGINE.sha256, strength, source,
  size, mtime })`, where `source` is `'mic'` or `'mix'` and `size` / `mtime` (whole ms) are the
  source file's. A new strength, a new engine version or model, or a changed source file give a new
  name, so a stale file is never used. Same length and channels as the source, 48 kHz AAC 160 kb/s
  (the settings `stemArgs` uses for `mic.m4a`), `+faststart`. About 1.2 MB a minute.
- While being made: `voice-<key>.part.m4a` (never served; removed on cancel, failure, or the next
  start of a render for that project).
- At most **3** `voice-*.m4a` files are kept (the newest by modification time, and always the one
  just made), so switching between strengths and undo are instant; older ones are deleted, best
  effort (a file the preview still has open on Windows is left for the next prune).
- They are derived data: deleting them loses nothing (they are made again on demand).

---

## 4. Behaviour

### 4.1 Which sound is cleaned (`voiceTarget(project)`)

| Project | Target |
|---|---|
| Clean voice off, no sound, recording muted or at 0 % | none |
| Stems kept and the microphone heard (`mic` stem, not muted, volume > 0) | `'mic'` (`mic.m4a`) |
| Stems kept, microphone muted, at 0 %, or not recorded | none (the panel says why) |
| No stems (an older recording, or one whose stems were not kept, or opened without them because a file is missing) | `'mix'` (the screen proxy's track, which holds the microphone and any PC sound) |

With `'mix'` the PC's sound is cleaned too; the panel says so (§5). The system stem is never cleaned.

### 4.2 Strengths (`voiceGraph(strength)`)

All three work at 48 kHz on every channel of the source, with the model file named `sh.rnnn`:

| Strength | Filter (after the delay handling) | Pause noise in §2.2 |
|---|---|---|
| Light | `arnndn=m=sh.rnnn:mix=0.75` (a quarter of the original kept under the cleaned voice) | −10 dB |
| Normal | `arnndn=m=sh.rnnn` | −19 dB |
| Strong | `arnndn=m=sh.rnnn,arnndn=m=cb.rnnn` (the general model second: §13) | −23 dB |

Delay: each pass delays by exactly 480 samples (`VOICE_PASS_DELAY`). The graph (`voiceGraph`) is
`[0:a:0]aresample=48000:async=1:first_pts=0,asplit[src][ref];[src]apad=pad_len=<480·passes>,<arnndn…>,atrim=start_sample=<480·passes>,asetpts=PTS-STARTPTS[clean];[clean][ref]amix=inputs=2:duration=shortest:normalize=0:weights=1 0[voice]`:
the cleaned sound starts on the source's first sample and nothing is lost at the end. arnndn works
in whole 10 ms frames and returns up to 480 samples more than it was given; mixing with the source
at weight 0 until the shorter one ends cuts the result to exactly the source's samples without
changing them (checked: identical samples, identical length, also after the AAC round trip).

### 4.3 Making the stem (main, `src/main/voice/voiceClean.ts`)

- `ensureVoiceStem(projectId, source, strength, onProgress?)`: resolves the source file (fixed name
  from `SOURCE_FILES`), stats it, computes the key; if `voice-<key>.m4a` exists, returns its name at
  once. Otherwise starts ffmpeg (argument list, no shell, `cwd` = the model folder so the filter
  names the model by its bare file name and no path needs escaping):
  `-hide_banner -nostdin -nostats -y -i <source> -filter_complex <graph> -map [voice] -c:a aac -b:a 160k
  -ar 48000 -movflags +faststart -progress pipe:1 <part>`, then renames the part into place and
  prunes (§3.3).
- **One render per project.** A request for the same key joins the running one (one ffmpeg, one
  promise). A request for another key of the same project stops the running render first (the
  user changed the strength mid-way).
- **Progress**: ffmpeg's `out_time_us` over the `Duration:` it prints, 0..1, sent at most 4 times a
  second (`voice:progress`).
- **Cancel** (`cancelVoiceStem(projectId)`): kills ffmpeg, waits for it to exit, deletes the part
  file; the promise rejects with `VOICE_CANCELLED`.
- **Time limit**: 60 s + 2 s per second of sound; past it the render is stopped ("Cleaning took too
  long and was stopped.").
- Stopped with the project's other analyses (`stopAnalyses`: the editor closed, or before the project
  is deleted, so Windows can delete the files), and all at quit.
- **Model**: the model text is bundled into the main process (`import … from './model/sh.rnnn?raw'`),
  its SHA-256 checked against `VOICE_ENGINE.sha256` at first use; it is written to
  `userData/voice/sh.rnnn` when that file is missing or differs, and that file is read back and
  checked before every render (a damaged or replaced file is rewritten). ffmpeg reads it from there:
  it cannot read inside `app.asar`, and this needs no `extraResources` change.
- Errors are short sentences: the microphone file is missing; the disk is full / permission denied
  (`describeFfmpegError`); took too long; "ffmpeg could not clean the sound." (with ffmpeg's last log
  line in the console).

### 4.4 Renderer state (`src/renderer/src/editor/voiceStems.ts`)

One store per window, keyed by `projectId|source|strength`, with entries
`checking | missing | working(progress) | ready(file) | stopped | failed(message)`.

- `want(id, source, strength)`: called by the preview whenever its project needs a stem. A key never
  seen is checked (`voice:status`); a missing stem starts rendering **automatically** (turning the
  switch on, changing the strength, opening a project whose stem was deleted). `stopped` (the user
  pressed Cancel) and `failed` are not restarted automatically.
- `prepare(id, source, strength)`: starts or joins a render whatever the state (the panel's
  *Clean now* / *Try again*, and the export).
- `cancel(id)`, `original(id)` / `setOriginal(id, on)` (the A/B, view state only: never saved, never
  in undo, reset to off when the editor closes).
- Progress events update the matching entry.

### 4.5 Preview (`previewAudio.ts`)

When the project's target is set, its stem is `ready`, its element has not failed and *Hear the
original* is off, the preview plays `voice-<key>.m4a` **in place of** the target:
- target `'mic'`: the cleaned file plays at the microphone's gain, through the same graph as the
  stems (the mic element is paused at gain 0); the system stem plays as before. With unity gains the
  preview would otherwise play the mixed track, so it switches to the stems (`withCleanVoice`).
- target `'mix'`: the video element's own track is muted in the graph and the cleaned file plays
  instead, at gain 1 (before the master volume, normalisation and fades).
- The cleaned element is kept on the video's time exactly like a stem (seek on jumps and cuts, speed
  nudges, pause freezes, preview speed).
- While the stem is being made (or after Cancel, or when its file fails to load) the preview plays
  the original; a failed load tells the store, which checks the status again (a deleted file is made
  again).

Ducking and the speech detector keep using the original microphone's levels and speech ranges
(the speech is in the same places; cleaning only removes noise), so the music dips exactly as before.
*Even out loudness* in the preview uses the measured loudness of the original (the cleaned voice is
about 0.4 dB quieter, §2.2); the export measures the real mix, as today.

### 4.6 Export

- Renderer (`exporter.ts`): with a target, the job's recording sound asks for stems when there are
  stems (`withCleanVoice`), carries `voice: strength`, and the exporter first awaits
  `voiceStems.prepare(…)` (it is normally ready already; if it is being made the export waits for
  it; if it fails the export stops with "Your voice could not be cleaned. <reason>").
- Main (`exportIpc.ts`, after `resolveSoundInputs`): `cleanVoiceInputs(sound, projectId)` validates
  `voice`, picks the source the way §4.1 does from what is resolved (the `mic` stem file when the job
  mixes stems with a microphone; the mixed track when it mixes no stems), calls `ensureVoiceStem`
  (made there if it is somehow missing, so the export can never use a stale or wrong file), and
  replaces that one input path. `audioPlan.ts`'s graph is unchanged: the cleaned file has the
  source's timeline, channels and exact length, so cutting, re-timing, freezes, gains, noise reduction,
  normalisation, music, clicks and fades apply exactly as to the original.
- `validRecording` accepts `voice` only as one of the three strengths.

---

## 5. UI and copy

In the Audio panel, a new section **Voice**, before *Clean up* (`panels/VoiceSection.tsx`):

- Toggle **Clean voice**. Disabled when there is nothing to clean, with the hint below instead.
- Hint (always): "Removes fan hum, keyboard and mouse clicks and room noise from your voice, on
  this PC. The preview plays the result."
- When the target is the mixed track: "This recording keeps your microphone and the PC's sound
  together, so both are cleaned."
- Disabled hints: no sound / muted recording: "The recording is silent, so there is no voice to
  clean."; stems without a heard microphone: "The microphone is muted or was not recorded, so there
  is no voice to clean."
- When on: chips **Strength** *Light* / *Normal* / *Strong* (the existing `Chips`, `aria-pressed`),
  and a hint for the chosen one:
  - Light: "Softens the noise and keeps some of the room."
  - Normal: "Removes most noise. Right for most recordings."
  - Strong: "Removes as much as it can. Quiet words can sound thin."
- Status (`role="status"`, polite):
  - checking: "Checking your voice…"
  - working: "Cleaning your voice… 42%" with a progress bar (`role="progressbar"`, value 0–100) and
    a **Cancel** button.
  - ready: "Your voice is clean. The preview and the export use it." and a toggle button
    **Hear the original** (`aria-pressed`). While pressed: "Playing the original voice. The export
    stays clean."
  - stopped: "Cleaning stopped. The preview plays the original voice, and the export cleans it
    first." and **Clean now**.
  - failed: "Your voice could not be cleaned. <reason>" and **Try again**.

Colours: only existing tokens and classes (`hint`, `callout`, `btn`, `chip`, the Audio panel's own
progress bar uses `--accent` on `--surface-2`); no new colour, so contrast is that of the existing
text (§11 checks the pairs used against WCAG AA).

Keyboard: every control is a native checkbox or button in tab order; the chips are buttons; Cancel
and Hear the original are reachable with Tab and work with Enter (Space plays the video everywhere in the
editor, by design: `views/Editor.tsx`; the switch, like every toggle in the editor, is a checkbox). Focus stays on the button
that changed (the status text changes beside it, and the Cancel button is replaced by *Clean now*
in the same place, which takes the focus when Cancel had it).

---

## 6. Undo

Turning the switch on or off, and choosing a strength, are each one `store.update` (one undo step).
Undoing back to an earlier strength finds its kept file (§3.3) and plays it at once. *Hear the
original*, Cancel, *Clean now* and the rendering itself are not edits and are not in undo.

---

## 7. Security

- IPC: `voice:status`, `voice:prepare`, `voice:cancel` accept the app's own page only (`isAppUrl` on
  the sender frame, as the analysis and speech handlers). The project id goes through `projectDir`
  (rejects anything but `[A-Za-z0-9_-]+`), `source` must be `'mic'` or `'mix'`, `strength` one of the
  three; anything else is "Invalid request." The renderer never names a path.
- Files: read only `mic.m4a` / `screen.mp4` of that project folder (fixed names); write only
  `voice-<16 hex>.part.m4a`, renamed to `voice-<16 hex>.m4a`, in that folder; prune only names that
  match `VOICE_FILE_RE` exactly. The media protocol serves `voice-[0-9a-f]{16}\.m4a` only (one strict
  alternative added to `MEDIA_FILE_RE`).
- ffmpeg is the bundled one, started with an argument array (no shell); the only values in the
  filter string are numbers and the fixed model name.
- The model is bundled and hash-checked before use; nothing is downloaded.
- Exports: the stem path is resolved in main from the project and the validated strength, never from
  the job.

---

## 8. Performance

- One ffmpeg per render, about 100x real time per pass (Strong: two passes, about 50x), plus AAC
  encoding; constant memory (streams). An hour of microphone sound: about 40 s on Normal.
- The preview plays one file instead of another: no extra decoding while playing.
- Nothing runs for projects with the switch off.

---

## 9. Files and exported signatures

New:
- `src/shared/audio/voiceClean.ts` (pure):
  `VOICE_STRENGTHS`, `DEFAULT_VOICE`, `voiceLook(audio): VoiceSettings`,
  `type VoiceSource = 'mic' | 'mix'`, `voiceTarget(project): VoiceSource | null`,
  `withCleanVoice(mix: RecordingMix, project): RecordingMix`, `VOICE_ENGINE`, `VOICE_PASS_DELAY`,
  `voicePasses(strength)`, `voiceGraph(strength): string`, `VOICE_FILE_RE`, `voiceFileName(key)`,
  `voicePartName(key)`, `voiceKeyInput(…)`, `VOICE_KEEP`, `staleVoiceFiles(files: {name, mtime}[], keep: string): string[]`.
- `src/shared/audio/voiceCopy.ts`: the strings of §5.
- `src/shared/api/voice.ts`: `VOICE_CHANNELS`, `VoiceStemStatus`, `VoiceProgress`, `VoiceApi`,
  `VOICE_CANCELLED`.
- `src/main/voice/voiceClean.ts`: `voiceCleanArgs(input, output, strength)`, `voiceKey(…)`,
  `parseDuration(log)`, `parseProgress(chunk)`, `VoiceCleaner` (`status`, `ensure`, `cancel`,
  `stopAll`), `voiceCleaner` (the app's), `ensureVoiceModel(dir)`.
- `src/main/voice/voiceIpc.ts`: `registerVoiceIpc()`, `cleanVoiceInputs(sound, projectId)`,
  `stopVoiceClean(projectId)`.
- `src/main/voice/model/sh.rnnn`, `src/main/voice/model/MODEL.md` (source, SHA-256, licence).
- `src/preload/voice.ts`: `voiceApi`.
- `src/renderer/src/editor/voiceStems.ts`: `VoiceStems`, `voiceStems`.
- `src/renderer/src/editor/panels/VoiceSection.tsx`, `panels/voice.css`.
- `resources/notices/33-rnnoise.txt` (and `THIRD_PARTY_NOTICES.txt` regenerated by `npm run notices`).
- Tests: `tests/voiceClean.test.ts`, `tests/voiceCleanMain.test.ts`, `tests/voiceStems.test.ts`,
  `tests/voiceBench.test.ts`, `tests/e2e/clean-voice.e2e.cjs`.

Additive lines in shared files:
- `src/shared/types.ts`: the two types and `AudioSettings.voice`.
- `src/shared/api.ts`: `VoiceApi` in `StudioApi`; `src/preload/index.ts`: `...voiceApi`.
- `src/main/index.ts`: `registerVoiceIpc()`.
- `src/main/analysisIpc.ts` `stopAnalyses`: `stopVoiceClean(id)` (one entry in the list; needed so
  Windows can delete a project whose voice is being cleaned).
- `src/main/mediaProtocol.ts` `MEDIA_FILE_RE`: `|voice-[0-9a-f]{16}\.m4a` (the preview must load it).
- `src/main/exportIpc.ts`: one line after `resolveSoundInputs`; `src/main/exportJob.ts`
  `validRecording`: one condition.
- `src/shared/api/export.ts` `RecordingSound`: `voice?: VoiceStrength`.
- `src/renderer/src/editor/previewAudio.ts`: the substitution (§4.5).
- `src/renderer/src/editor/exporter.ts` `soundOf`: three lines (§4.6).
- `src/renderer/src/editor/panels/AudioPanel.tsx`: one import and one JSX line.
- `src/shared/render/audioPlan.ts`: no change needed (the substitution is a file path).
- No change to `package.json`, `scripts/*`, `electron-builder.config.cjs`, `project.ts`.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| The Windows ffmpeg build lacks `arnndn` | It is a core filter (no external library) in every ffmpeg since 4.3; `ffmpeg-static` 5.x ships 6.x/7.x. If it fails anyway the panel shows the failure sentence and the export stops with it; the switch can be turned off. Listed for a check on Windows (§12). |
| Chromium's noise suppression is on while recording (`recorder/session.ts`), so RNNoise stacks on it | Normal is gentle in speech (fwSNRseg up, voice level −0.4 dB); Light exists for already-clean microphones. Recording raw when Clean voice is wanted needs the recording files, owned by another branch (§12). |
| AAC re-encoding the voice before the export encodes it again | 160 kb/s mono AAC is transparent for speech; it is how `mic.m4a` is stored already. |
| Preview loudness with *Even out loudness* | Off by about 0.4 dB at most (§4.5); the export is exact. |
| A long recording's stem takes time | Progress and Cancel; the preview plays the original meanwhile; the export waits. |
| The model's licence | The repository states the models are not subject to copyright; the RNNoise code is BSD-3-Clause and in FFmpeg. Both are in the notices. |
| Disk use | 1.2 MB a minute, at most 3 kept; derived and deletable. |

---

## 11. Test plan

Unit (vitest), each failing without its code:
- `voiceLook` defaults and sanitising; `voiceTarget` for every row of §4.1; `withCleanVoice` keeps
  every other case unchanged and forces stems at unity; `voiceGraph` strings and pass counts;
  `VOICE_FILE_RE` accepts only `voice-<16 hex>.m4a`; `staleVoiceFiles` keeps 3 and the current one;
  key input changes with each of its parts.
- Main, with the real ffmpeg: the cleaned file starts on the source's samples (cross-correlation lag
  0 within one sample) and is as long as the source within one frame, for every strength; progress
  rises to 1; the cache is reused (no second ffmpeg); a new strength or a touched source makes a new
  file; pruning keeps 3; cancel removes the part file and rejects with `VOICE_CANCELLED`; a second
  request joins the first; a different key stops the first; a missing source gives the readable
  error; the model is written, checked and rewritten when damaged; invalid ids, sources and
  strengths are refused; the IPC refuses other senders.
- Export: `validateJob` accepts the three strengths and refuses others; `cleanVoiceInputs` replaces
  the mic stem, or the mixed track, and leaves a job without `voice` untouched; the audio plan for a
  project without `voice` is byte-identical to before (existing `tests/audioPlan.test.ts` passes
  unchanged).
- Renderer store with a fake API: a missing stem is made automatically once; `stopped` and `failed`
  are not restarted by `want`; `prepare` restarts them; progress updates; the A/B flag.
- Bench (`tests/voiceBench.test.ts`): the §2.2 clip (speech fixtures plus deterministic fan and
  keyboard noise) through the shipped filters: pause noise down at least 7 / 15 / 20 dB for Light /
  Normal / Strong (as built: at least 6 / 10 / 20 dB), every voice kept (LibriSpeech within 1 dB, JFK within 3 dB), fwSNRseg within 3 dB of the input's.

End-to-end (`tests/e2e/clean-voice.e2e.cjs`, the built app under Xvfb, with the speech fixture
project from `speech-fixtures.cjs`):
- Turn on Clean voice: progress, then "Your voice is clean"; a `voice-*.m4a` is in the folder; the
  preview's sources show the cleaned file (the preview's audio elements' `src`).
- Hear the original toggles the preview back; the export still uses the cleaned stem.
- Strong makes a second file; undo returns to Normal with no new render.
- Export to M4A with Clean voice and without: in the fixture's noise stretch (12–16 s, brown noise
  and key clicks) the cleaned export is at least 10 dB quieter; in the speech stretches the level is
  within 2 dB.
- Cancel during a render leaves no `.part` file, shows *Clean now*.
- A project without `voice` exports exactly as before (the existing audio e2e tests, unchanged).
- Keyboard: the chips and the buttons are reached with Tab and work with Enter.
- Screenshots of the section: `docs/screenshots/clean-voice-*.png`.

---

## 12. Left for later

- DeepFilterNet3 as a "Best" engine (a signed Rust helper; the cache key's engine version makes the
  switch automatic).
- The "studio voice" preset of NW-10: EQ, compressor and de-esser after the cleaning (`acompressor`
  and `deesser` are in ffmpeg).
- Recording the microphone raw (without Chromium's noise suppression) when Clean voice will be used:
  needs the recording files (another branch).
- Transcription and the speech detector reading the cleaned voice.
- Clean voice in the saved default style and the brand kit (new recordings start with it on).
- Real-room recordings on a Windows PC to confirm the numbers of §2.2 by ear (no microphone here).

---

## 13. As built

Built as designed, with these differences:

- **Strong's second pass uses the general model (`cb.rnnn`)**, not the speech model again. The e2e
  fixture showed two passes of `sh` remove the band-limited, noisy JFK speech entirely (−40 dB):
  the second pass no longer recognises what the first left as speech. `sh` then `cb` keeps every
  voice (JFK −0.5 dB, LibriSpeech −0.2 dB) and still takes 23–30 dB off the noise. Both models are
  bundled (`src/main/voice/model/`, `MODEL.md`), pinned and checked; the cache key covers both hashes.
  `tests/voiceBench.test.ts` fails with the old Strong (checked).
- **Exact length**: the graph ends with `amix=duration=shortest` against a zero-weighted copy of the
  source (§4.2), so the stem has exactly the source's samples (also after the AAC round trip), and
  `aresample=…:async=1:first_pts=0` places a mixed track that starts late on its timestamps, as the
  export reads it.
- **The preview subscribes to the stems store only once a project uses Clean voice**, so projects
  without it touch nothing new.
- **Keyboard**: Space plays the video everywhere in the editor (existing rule), so the buttons are
  used with Enter; the one action button stays the same element across states, so focus stays put
  (Cancel → Clean now is checked by the e2e test).
- Measured in the e2e export (speech fixture, M4A, levels as heard on each side): noise stretch
  −29.1 dBFS plain, −44.3 Normal, −59.0 Strong; speech JFK −17.2 → −17.6 / −17.7 dBFS, LibriSpeech
  −23.5 → −23.6 / −23.7 dBFS. Bench (`tests/voiceBench.test.ts`, synthetic fan and typing on real
  speech): pauses −8 / −12 / −23 dB for Light / Normal / Strong, LibriSpeech within 0.4 dB, JFK about
  −2 dB (its own crowd noise goes too).
- Not confirmed here (no Windows PC, no microphone): the Windows ffmpeg build (`ffmpeg-static`
  b6.1.1, which has `arnndn`) running it; file locking when an older stem is pruned while the
  preview still has it open (pruning skips such a file and retries next time); real-room recordings
  by ear.
