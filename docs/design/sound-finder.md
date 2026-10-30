# Unwanted-sound finder (F-17)

Status: designed on `feat-sound-finder` (from `ccr-b6df7cf7-yked87`, Flown 0.7.0, commit 546e479).
§13 "As built" records where the build differs. Roadmap: `docs/ROADMAP.md` F-17 ("Lists pings,
buzzes, coughs, barks and background music with Mute, Cut or Duck").

Code read for this design: `src/shared/audio/{settings,soundtrack,activity,automation,loudness,vad,voiceClean}.ts`,
`src/shared/render/{audioPlan,cutFades}.ts`, `src/shared/api/{export,voice,speech}.ts`, `src/shared/types.ts`,
`src/shared/engine/{project,timeline,freeze}.ts`, `src/shared/editor/clips.ts` (`restoreRange`),
`src/main/{audioAnalysis,analysisIpc,exportJob,projectProcesses,projects,security}.ts`,
`src/main/speech/vad.ts` (the speech detector and its `.cache/speech.json`), `src/main/voice/voiceIpc.ts`,
`src/preload/*`, `src/renderer/src/render/segmentation/*` (how MediaPipe, its WebAssembly and a model are
bundled and loaded in a worker), `src/renderer/src/editor/{previewAudio,player,exporter,audioAnalysis,voiceStems,speechState}.ts`,
`panels/{AudioPanel,TranscriptPanel,VoiceSection}.tsx`, `scripts/{verify-dist.mjs,notices.mjs,lib/packaging.cjs}`,
`resources/segmentation/MODEL.md`, `resources/notices/32-mediapipe.txt`, `tests/e2e/{clean-voice,helpers,speech-fixtures,render-fixtures}.cjs`.

The rules earlier waves set still hold:
- Preview and export agree: what you hear is what you export.
- Every user action is one undo step.
- Projects and settings made before this feature open, preview and export exactly as before.

Other teams build at the same time. This feature owns `src/shared/audio/sounds*.ts`,
`src/renderer/src/editor/sounds/*`, `src/main/sounds/*`, `src/shared/api/sounds.ts`,
`src/preload/sounds.ts`, `resources/sounds/*` and its packaging lines. Shared files get a few
additive lines each (§9.2). It does not touch Clean voice, the speech detector or transcription.

---

## 1. What the user gets

- In the **Audio** tab, a section **Unwanted sounds** with one button, **Find unwanted sounds**.
- It listens to the recording **on this PC** (nothing is uploaded or downloaded, nothing to pay) and
  lists the sounds people usually do not want in a video: **coughs** (and throat clearing),
  **sneezes**, **typing** (keyboard bursts), **notification sounds** (dings, pings, beeps, chimes),
  **phones** (ringing, buzzing), **dogs**, **knocks and doors**, and **background music**.
- **Speech is never listed.** A sound that overlaps someone speaking is not offered, because the
  actions work on the whole recording's sound and would take the words with it.
- Each row: what it is, when (the timeline's time), how long, a **Play** button (plays it with half a
  second around it, as it will sound), and four actions:
  - **Mute**: silence that stretch, with 20 ms fades so it never clicks;
  - **Duck**: make it much quieter (−14 dB), same fades;
  - **Cut**: an ordinary cut of the video there, as if cut on the timeline (with the smooth-cut fades
    every cut already gets);
  - **Ignore**: keep it as it is and take it off the list.
  A muted, ducked or cut row says so and offers **Restore**. **Mute all** mutes every open row at once.
- Every action is **one undo step**; Ctrl+Z brings the row back.
- It runs in the background with a progress bar and **Cancel**; the editor stays responsive. The
  result is kept in the project's `.cache/` folder: opening the recording again shows the list at
  once, without listening again. It listens again only when a sound file changes.
- **Preview and export sound the same**: the preview plays the muted and ducked stretches exactly as
  the export renders them (one shared gain curve, §4.6).

---

## 2. Decisions

### 2.1 The classifier

| | **YAMNet via MediaPipe tasks-audio** (chosen) | PANNs CNN14 (ONNX) | AST / BEATs | Hand-made rules (levels, spectra) |
|---|---|---|---|---|
| What | MobileNet-v1 audio event classifier trained on AudioSet, 521 classes, 0.975 s windows of 16 kHz sound. | CNN on AudioSet, 527 classes. | Transformers on AudioSet. | Loudness and spectral heuristics. |
| Licence | Model: **Apache-2.0** (TensorFlow Models, MediaPipe model card). Runtime `@mediapipe/tasks-audio` 1.0.1: **Apache-2.0**. | Code MIT; weights trained on AudioSet, released under CC-BY 4.0 with an unclear chain; ONNX Runtime web needed. | MIT/BSD code, weights large. | n/a |
| Size | Model **4,126,810 bytes** (float32). Runtime: `audio_wasm_module_internal.wasm` 6,580,784 B + loader 252,719 B. **≈ 11.0 MB installed**, ≈ 4.9 MB brotli in the installer (the model barely compresses: 3.16 MB). | 81 MB (or 20 MB int8) + ONNX Runtime web (≈ 10 MB). | 85–350 MB. | 0 |
| Speed (measured here, one core, in a Chromium worker) | **6.8 ms per 0.975 s window**; 600 s of sound in 5.5 s with no overlap. | ≈ 10–20x slower per second of sound. | far slower. | fast |
| Quality on the classes we need | Good: Cough, Sneeze, Typing, Ding, Ping, Beep, Bark, Knock, Music are AudioSet classes; measured below. | Better mAP (0.43 vs 0.31). | Best. | Poor: a cough and a word look alike to levels. |
| Fits Flown | The same family as `@mediapipe/tasks-vision` (camera blur), same bundling, same CSP, same worker pattern, same notices. | New runtime, new notices, much bigger. | Too big. | No model, but no use. |

**Chosen: YAMNet through MediaPipe tasks-audio.** It is the smallest model that knows every sound
on the list, its licence is Apache-2.0 end to end, it runs about 140x faster than real time on one
core of this machine (an hour of sound in about 25 s, §8), and it ships exactly like the camera's
background blur: Vite copies the WebAssembly runtime and the model into `out/renderer/assets/`,
a module worker loads them, nothing is downloaded. Measured on synthetic and real sound in this
environment (window by window, top classes):

| Sound | YAMNet's top classes |
|---|---|
| A 1.3 kHz ding with harmonics, 1.5 s | Ding 0.80, Clang 0.41, Ping 0.26 |
| A 1 kHz beep, 0.3 s | Beep, bleep 0.50, Busy signal 0.41 |
| A synthesised arpeggio, 8 s | Music 0.98–1.00 in every window |
| JFK's speech (`tests/fixtures/speech/jfk-16k.flac`) | Speech 0.74–0.97; no class of ours above 0.02 |

**New dependency (unavoidable):** `@mediapipe/tasks-audio` 1.0.1 (devDependency, pinned exactly like
`@mediapipe/tasks-vision` 1.0.1: Vite bundles it, nothing is added to `app.asar`'s `node_modules`).
The audio graph is not part of the vision package's WebAssembly, and running a TFLite model without
MediaPipe would need another runtime (TF.js or ONNX Runtime, each larger).

### 2.2 Where it runs

- **Decoding in main, classifying in a renderer worker.** ffmpeg (already bundled, already used for
  every sound measurement) decodes the source to 16 kHz mono float samples in the main process; the
  editor pulls them in 20 s chunks over IPC and hands each chunk to a **module Web Worker** that runs
  YAMNet (transferred, not copied). Alternatives: decoding in the renderer with `decodeAudioData`
  (needs the whole file and all its samples in memory: 460 MB for an hour at 16 kHz stereo) or with
  WebCodecs (AAC support varies, a demuxer per container); running the model in main (MediaPipe's
  loader needs a browser scope; it fails in Node with `document is not defined`, tried).
- **Pull, not push:** the renderer asks for the next chunk when the worker is ready for it, and main
  pauses ffmpeg's output while two chunks wait. Memory stays at a few MB whatever the length.
- **One worker per source, at the same time** (at most two: microphone and system sound). Each loads
  its own copy of the runtime (≈ 30 MB of memory); two cores halve the wall time.

### 2.3 Which sound is listened to (`scanSources`)

`stemsOf(project)` (`src/shared/audio/settings.ts`): when the recording kept stems, the **microphone**
and the **system sound** are listened to separately (a cough is on the microphone, a notification on
the system sound: separately each is clearer, and music under speech is still found on the system
sound). A recording without stems (older recordings, imports) is listened to on its mixed track
(`screen.mp4`, source `mix`). A stem the user muted is still listened to: the list is about what is
in the recording; a row's actions change what is heard.

### 2.4 What the actions change, and why the whole sound

Mute and Duck lower **the recording's sound** (after the stems are mixed, before cuts and speed
changes) over the row's stretch, in source time. Lowering only the stem the sound was found on would
need the export to switch to stems whenever a row is muted (`recordingMix` would change for every
such project) and the preview to keep both paths in step; the gain on the mixed sound needs neither,
and because speech is never listed (§4.3) nothing anyone says is lost. Per-stem muting is left for
later (§12).

Cut is the ordinary `cutRange` of `src/shared/engine/timeline.ts`, the same as the timeline's
cut and edit by text. It gets the 10 ms smooth-cut fades every cut gets (`cutFades.ts`).

### 2.5 Why scores are cached, not rows

The cache keeps YAMNet's **scores per window** for each of our kinds (one byte each), not the final
rows. Rows are a pure function of the scores, the speech ranges and the sound levels
(`findSounds`), so the rules and thresholds can be tuned in a later version without listening again
(the cache's version only changes when the scores themselves would). Each row has a **key**
(`<kind>-<start in centiseconds>`) derived from them; a mute, duck or ignore stores it, so the row's
state survives reopening.

---

## 3. Data model

### 3.1 `src/shared/types.ts` (additive, optional)

```ts
/** What the unwanted-sound finder changed (F-17, docs/design/sound-finder.md). */
export interface SoundEdits {
  /** Stretches of the recording's sound that are muted or lowered (source seconds, sorted by start). */
  spans: SoundSpan[]
  /** Keys of found sounds the user chose to keep as they are (Ignore). */
  ignored: string[]
}

export interface SoundSpan {
  start: number
  end: number
  action: 'mute' | 'duck'
  /** The found sound it came from (`<kind>-<centiseconds>`). */
  key: string
}

// in Project:
  /** Unwanted sounds muted, lowered or ignored (absent: none, every project from before F-17). */
  sounds?: SoundEdits
```

`RecordingSound` (`src/shared/api/export.ts`) gets one optional field:

```ts
  /** Stretches of the recording's sound at a lower gain (F-17): source seconds, gain 0 (muted) .. 1. */
  sounds?: SoundGain[]
```

### 3.2 Old projects and settings

- `migrateProject` reads `sounds` through `readSoundEdits(raw, duration)` (`src/shared/audio/soundsEdit.ts`)
  and adds it with `optional(...)`, so a project without it gets no key: it loads, saves and exports
  **byte for byte as before** (tests check `migrateProject(old)` has no `sounds` key and that a
  project with an empty `sounds` reads as absent).
- `readSoundEdits` sanitises: spans with finite `start < end` clipped to `[0, duration]` and at least
  10 ms long, `action` one of the two, `key` matching `/^[a-z]{3,10}-\d{1,9}$/`; at most 2000 spans,
  sorted by start; `ignored` unique valid keys, at most 2000. Anything else is dropped. Nothing left:
  absent.
- An export job without `sounds` builds exactly the filter graph it built before (tested).
- No settings are added.

### 3.3 Files in the project folder

`.cache/sounds.json`, written atomically by main (`writeFileAtomicSync`), at most 8 MB, read back
only when it validates:

```json
{ "version": 1, "entries": { "mic": {
  "size": 1234567, "mtimeMs": 1730000000000,        // the source file when it was listened to
  "model": "<sha256 of yamnet.tflite>", "scan": 1,   // SOUND_MODEL.sha256, SCAN_VERSION
  "skip": "a1b2c3d4",                               // which speech was skipped (§4.2)
  "hop": 0.4875, "window": 0.975, "kinds": ["speech","cough",...], "n": 7385,
  "scores": "<base64 of n × kinds bytes, score × 255>"
} } }
```

An hour is 7,385 windows × 9 bytes = 66 KB (89 KB as base64) per source. The storage manager's
cache clean-up already treats `.cache/` as removable; removing it only means listening again.

---

## 4. Behaviour

### 4.1 Kinds (`SOUND_KINDS`, `src/shared/audio/sounds.ts`)

Each kind is the highest score among its YAMNet classes (indices into the model's 521 labels; a unit
test reads the label list packed inside the bundled model and checks every index by name):

| Kind | Label (UI) | YAMNet classes | Score ≥ | Shortest | Fit to the sound |
|---|---|---|---|---|---|
| `cough` | Cough | Cough (42), Throat clearing (43) | 0.35 | 0.10 s | yes |
| `sneeze` | Sneeze | Sneeze (44) | 0.35 | 0.10 s | yes |
| `typing` | Typing | Typing (378), Typewriter (379), Computer keyboard (380) | 0.35 | 0.30 s | yes |
| `ping` | Notification sound | Bell (195), Chime (200), Beep, bleep (475), Ping (476), Ding (477) | 0.35 | 0.10 s | yes |
| `phone` | Phone | Buzz (125), Telephone (383), Telephone bell ringing (384), Ringtone (385), Vibration (517) | 0.35 | 0.20 s | yes |
| `dog` | Dog | Dog (69), Bark (70), Yip (71), Howl (72), Bow-wow (73), Growling (74), Whimper (dog) (75) | 0.35 | 0.10 s | yes |
| `door` | Knock or door | Door (348), Doorbell (349), Ding-dong (350), Slam (352), Knock (353) | 0.35 | 0.10 s | yes |
| `music` | Background music | Music (132) | 0.50 | 3.0 s | no |
| (speech) | — | Speech (0), Child speech (1), Conversation (2), Narration, monologue (3), Speech synthesizer (5) | 0.50 | — | — |

The speech column is not a row; it is the fallback speech guard when the speech detector cannot run.

### 4.2 Listening (`SoundScanner`, `src/shared/audio/soundsScan.ts`, run by the worker)

- Windows of **15,600 samples (0.975 s)** every **7,800 samples (0.4875 s)**: half overlap, so any sound
  up to half a second long lies wholly inside at least one window. The last window is padded with
  silence when at least 0.25 s of sound is left for it.
- A window is **skipped** (all scores 0, not classified) when it is
  - **quiet**: its loudest 20 ms is below −50 dBFS (nothing there anyone would want to remove), or
  - **speech**: at least 90% of it lies inside the speech detector's ranges (§4.3). This is most of
    a narrated recording's microphone, and the reason long recordings stay fast.
- Each other window is classified once (`AudioClassifier.classify(window, 16000)`, CPU, all 521
  scores) and stored as one byte per kind (`round(score × 255)`).
- `skip` in the cache is a hash (FNV-1a, 8 hex digits) of the speech ranges used to skip, rounded to
  milliseconds; ranges that changed (the speech detector became available) mean listening again.

### 4.3 From scores to rows (`findSounds`, pure)

Input: each source's scores, the speech ranges (the speech detector's, `AudioLevels.speech` of the
voice source: `mic`, else `mix`), and each source's sound levels (`AudioLevels`, 50 ms windows,
already measured for the preview's ducking and shared through `loadAudioAnalysis`).

1. **Candidates:** for each kind, the windows whose score reaches the kind's threshold **and** beats
   the window's speech score (a word that sounds like a ding is speech).
2. **Spans:** candidate windows of a kind that overlap or are less than 0.5 s apart are joined; a
   span covers its windows `[k × hop, k × hop + 0.975]`.
3. **Speech guard:** the speech ranges (or, when the detector did not run, the windows whose speech
   score is at least 0.5), each widened by 0.1 s, are taken out of the span (music under speech is
   offered only between sentences, a cough inside a sentence not at all).
4. **Fit** (each piece left, all kinds but music): inside the piece, the 50 ms level windows within
   20 dB of its loudest one; the piece becomes the first to the last of them (a cough is 0.3 s of a
   1.5 s window run), padded by 50 ms, never beyond the piece. It is kept when at least the kind's
   shortest length. Fitting after the guard means loud speech next to a sound never sets its level.
5. **Sources joined:** spans of the same kind from the microphone and the system sound that overlap
   become one row.
6. **Score:** the highest window score in the span. At most **400 rows** (the strongest), listed by
   time. Key: `<kind>-<round(start × 100)>` of the piece **before fitting**, so the key depends on the
   scores and the speech only, never on the levels: a mute, duck or ignore stays with its row.

### 4.4 Row states (`soundRows`)

From the project, per row: **muted** / **ducked** (a span with its key), else **cut** (no clip keeps
any of it), else **ignored** (its key in `ignored`), else **open**. Times shown are the timeline's
(output) time of the row's start (`sourceToOutput`; a cut row shows where the cut is).

### 4.5 Actions (`soundsEdit.ts`, each one `store.update`)

| Action | Project change |
|---|---|
| Mute / Duck | adds `{ start, end, action, key }` to `sounds.spans` (sorted) |
| Restore (muted/ducked) | removes the span with that key |
| Cut | `clips = cutRange(clips, start, end)`; refused when it would leave nothing ("That would cut the whole video") |
| Restore (cut) | `restoreRange(clips, start, end, duration)`; when nothing changes: "Use Undo to bring this back" |
| Ignore / Bring back | adds / removes the key in `sounds.ignored` |
| Mute all | one update adding a mute span for every open row |

An empty `sounds` (no spans, nothing ignored) is removed from the project, so Restore on the last row
leaves the project as it was.

### 4.6 The gain curve (one curve, preview and export)

`soundGains(project)`: the spans as `{ start, end, gain }` (mute 0, duck **0.2 = −14 dB**). Spans that
overlap or are closer than 40 ms are joined, the lower gain winning (so ramps never cross). The gain
`g(t)` in source time is 1 outside, the span's gain inside, and linear over **20 ms** (`SOUND_FADE`)
before the start and after the end: the stretch itself is fully muted or ducked.

- **Export** (`audioPlan.ts`, `recordingGraph`): when the job has `sounds`, the recording's head (the
  mixed track or the mixed stems, after noise reduction, in source time because it starts at 0 with
  `first_pts=0`) gets `asetnsamples=n=256:p=0,volume=volume='<expr>':eval=frame`. `<expr>` is
  `soundGainExpression`, the exact `g(t)` as a binary search over the joined spans (like
  `duckExpression`). Then it is cut and re-timed clip by clip as before, so cuts, speed changes and
  pause freezes carry the curve with the sound. A job without `sounds` gets the graph of before.
- **Preview** (`previewAudio.ts`): a new `sounds` gain node between `rec` and `cut`. Its curve is
  `g` mapped to the output (video) timeline through the clips and the pause freezes
  (`soundOutputKeyframes`): within a clip `t → out(c) + (t − c.start) / speed`, a step at each cut
  (masked by the cut fade). It is scheduled with the other curves (`ramp`, re-anchored after jumps
  and every 30 s) from the same keyframes, so the preview hears what the export renders. A project
  with spans plays through the Web Audio graph (as projects with cuts already do).

Both are tested against `g(t)`: the expression evaluated at thousands of times, the preview keyframes
mapped back through the clips.

### 4.7 Scanning in the editor (`soundScan.ts`)

1. `sources = scanSources(project)`; the levels of each source and the voice source's speech ranges
   come from `loadAudioAnalysis` (measured once, cached in main).
2. For each source, `soundsCached(projectId, source)` returns the stored entry when the file's size
   and time match; it is used when its model, scan version and `skip` match too.
3. The other sources are listened to at once (one worker each): `soundsOpen` starts ffmpeg and returns
   the file's size and time; `soundsRead` gives the next chunk (≤ 20 s, 1.28 MB) or null at the end;
   the worker classifies it and asks for more. Progress: seconds decoded over the recording's length,
   summed over sources.
4. At the end each entry is saved (`soundsSave`, main checks it and that the file has not changed since)
   and the rows are shown.
5. **Cancel** terminates the workers and closes the streams (ffmpeg is killed); nothing is saved.
   Closing the editor (or deleting the project) stops main's ffmpeg through `stopAnalyses`, which ends
   the scan as stopped. A failure ("Could not listen to the recording: …") offers Try again.
6. The state is per project and lives outside the panel (switching tabs does not stop it).

---

## 5. UI and copy

Section **Unwanted sounds** in the Audio tab, after Voice (`SoundsSection.tsx`):

- No sound: *"This recording has no sound."* (no button)
- Before: *"Finds coughs, sneezes, typing, notification sounds, phones, dogs, knocks and background music,
  on this PC. Speech is never listed."* Button **Find unwanted sounds**.
- Listening: a progress bar (`role="progressbar"`, value in %) and *"Listening to the recording… 42%"*,
  button **Cancel**.
- Failed: callout *"Could not listen to the recording: <reason>"*, button **Try again**.
- Done, nothing: *"No unwanted sounds found."*
- Done: *"<n> found. Nothing changes until you choose."* then the list, then **Mute all** (when at least
  two rows are open) and *"Show ignored (<n>)"* (a toggle, when any are ignored).
- Row (`li`): a **Play** icon button (`aria-label="Play the cough at 0:12.4"`), the label
  (*Cough*, *Sneeze*, *Typing*, *Notification sound*, *Phone*, *Dog*, *Knock or door*, *Background
  music*), the time (`0:12.4`) and length (`0.4 s`); then the actions:
  - open: **Mute** (title *"Silence it, with short fades"*), **Duck** (*"Make it much quieter"*),
    **Cut** (*"Cut it out of the video"*), **Ignore** (*"Keep it and take it off the list"*);
  - muted / ducked / cut: the state (*Muted*, *Lowered*, *Cut*) and **Restore**;
  - ignored (shown with Show ignored): *Ignored* and **Bring back**.
- A polite live region announces each action (*"Muted the cough at 0:12.4"*, *"Cut 0.4 s"*).
- Keyboard: everything is a button in tab order; after an action the focus moves to the row's first
  button (it would otherwise fall to the page, where Delete removes timeline items).
- Colours: the existing tokens (`--text`, `--text-dim`, `--accent`, `--danger`); the state text uses
  `--text-dim`, which passes AA on `--panel` (checked in §11).

---

## 6. Undo

Each action is one `store.update` (Mute all included), so one undo step. Scanning changes nothing in
the project. Play, Show ignored and the scan state are view state.

## 7. Security

- IPC handlers accept the app's own page only (`isAppUrl(senderFrame.url)`, as Clean voice).
- `projectId` goes through `projectDir` (its id pattern); `source` must be `mix`, `mic` or `system`;
  the file is `SOURCE_FILES[source]` in that folder (no path from the renderer).
- Streams: at most 4 open per window; a stream belongs to the window that opened it (another cannot
  read or close it); each is closed when its window goes away, after 60 s without a read, and when the
  project's work is stopped. Chunk size is fixed by main.
- `soundsSave` validates the entry completely (types, finite numbers, `n ≤ 4 h / hop + 2`, base64 of
  exactly `n × kinds` bytes, at most 8 MB in all) and that the source file still has the size and time
  given; it writes only `.cache/sounds.json` in that project's folder, atomically.
- The cache file read back is untrusted: size-capped before parsing, every field checked.
- Export jobs: `sounds` is validated in `exportJob.ts` (at most 4000 entries, `0 ≤ start < end ≤ 1e7`,
  `0 ≤ gain ≤ 1`). The expression is built from numbers only.
- The model and the runtime ship inside the app; nothing is downloaded. The worker loads only
  bundled URLs.

## 8. Performance (measured here; a Windows PC of the same class should be close)

Measured in the built app on this 4-core Linux container (`tests/e2e/sound-finder.e2e.cjs`'s
fixture repeated: speech on the microphone about half the time, a ding and music on the system
sound): **10 minutes in 10.6 s, an hour in 74.6 s** from the click to the list. For the hour, the
first 45 s are the sound levels and the speech detector on the whole recording, which the editor
shares (ducking, Remove silences) and keeps in `.cache/speech.json`; listening itself took about
30 s for the two sources together. Opening the recording again shows the list in under a second.

- YAMNet: **6.8 ms per window** (0.4875 s of sound per window with the overlap): ≈ **50 s per hour of
  sound classified**, one core, per source.
- Skipping quiet and speech windows: a narrated microphone is typically 50–70% speech, so ≈ 15–25 s
  per hour; a system sound that is mostly silent, a few seconds. Two sources run at once.
- ffmpeg decoding to 16 kHz mono: ≈ 300x real time (12 s per hour), alongside.
- Model load: ≈ 0.6 s per worker.
- Rows from scores: linear in windows; an hour's 7,385 windows in a few milliseconds (unit test with a
  time limit).
- Opening the editor again: one small file read per source; no decoding.

## 9. Files and exported signatures

### 9.1 New files

- `src/shared/audio/sounds.ts`: `SOUND_KINDS`, `SoundKind`, `SOUND_KIND_ORDER`, `SPEECH_CLASSES`,
  `SCAN`, `SoundRow`, `findSounds(input): SoundRow[]`, `soundKey`, `scanSources(project)`.
- `src/shared/audio/soundsScan.ts`: `SoundScanner` (push samples, classify windows through a callback,
  `finish()`), `kindBytes(scores)`, `quietWindow`, `speechCover`, `skipKey(ranges)`.
- `src/shared/audio/soundsCache.ts`: `SoundScores`, `encodeScores`, `decodeScores`, `readCacheEntry`
  (validation), `cacheMatches`.
- `src/shared/audio/soundsEdit.ts`: `readSoundEdits`, `soundGains`, `SOUND_FADE`, `DUCK_GAIN`,
  `soundGainAt`, `soundGainKeyframes`, `soundOutputKeyframes`, `soundGainExpression`,
  `soundGainFilters`, `validSoundGains`, `soundRows`, `muteRow`, `duckRow`, `cutRow`, `restoreRow`,
  `ignoreRow`, `bringBackRow`, `muteAll`.
- `src/shared/audio/soundsCopy.ts`: every sentence of the UI.
- `src/shared/api/sounds.ts`: `SOUNDS_CHANNELS`, `SoundsApi`.
- `src/preload/sounds.ts`; `src/main/sounds/soundsIpc.ts` (`registerSoundsIpc`, `stopSoundScans`,
  `SoundStreams`).
- `src/renderer/src/editor/sounds/`: `sounds.worker.ts`, `protocol.ts`, `soundScan.ts`,
  `SoundsSection.tsx`, `sounds.css`.
- `resources/sounds/yamnet.tflite`, `resources/sounds/MODEL.md`, `resources/notices/34-yamnet.txt`.
- Tests: `tests/sounds*.test.ts`, `tests/e2e/sound-finder.e2e.cjs`.

### 9.2 Additive lines in shared files

`types.ts` (the two types, one field each in `Project` and nowhere else), `api/export.ts` (`sounds?`),
`engine/project.ts` (one name in the destructuring, one `optional(...)` line), `api.ts`,
`preload/index.ts`, `main/index.ts` (register), `main/analysisIpc.ts` (`stopSoundScans` in
`stopAnalyses`), `main/exportJob.ts` (one validation clause), `render/audioPlan.ts` (`sounds?` in
`RecordingPart`, passed through, the filter appended to the head), `editor/previewAudio.ts` (a gain
node, a curve, a graph condition), `editor/exporter.ts` (one line), `panels/AudioPanel.tsx` (import
and element), `package.json` (the devDependency), `scripts/notices.mjs` (one name in `BUNDLED`),
`scripts/verify-dist.mjs` (the sound finder's files, like the background blur's),
`resources/THIRD_PARTY_NOTICES.txt` (regenerated), docs.

## 10. Risks

- **False rows** (a demo's beep, a song the video is about): nothing changes until the user chooses,
  and Ignore keeps it off the list.
- **Missed sounds**: a cough during a word is not offered (by design); YAMNet's thresholds are
  tuned on clear examples. The scores are cached, so the rules can be tuned later without listening
  again.
- **Speech detector unavailable** (development builds, a processor that cannot run it): the YAMNet
  speech score guards instead; nothing is skipped, so listening is slower.
- **WebAssembly blocked or out of memory** in the worker: the panel says why and offers Try again;
  the editor is unaffected.
- **Merge conflicts**: single-line lists (`api.ts`, `preload/index.ts`, the migration's destructuring)
  are touched by every team; each change is one token or one line.

## 11. Test plan

Unit (vitest), each failing without its code:
- labels: every class index names the label in the model's packed label list; the model's SHA-256 is
  the pin.
- scanner: window positions and count, last-window padding, quiet and speech skipping, bytes per
  kind, chunk boundaries do not change results, skip key.
- `findSounds`: thresholds, speech beats a weak kind, joins, fit to levels, speech guard (pieces,
  shortest length), music only when long, sources joined, keys stable, cap of 400, speed on an hour.
- cache: encode/decode round trip, every malformed entry refused, `cacheMatches`.
- edits: `readSoundEdits` sanitising, old project unchanged, row states, every action and its
  restore, Mute all, empty edits removed.
- gain: `soundGainAt` shape (fades outside, joined spans), keyframes exact, expression equals the
  curve, output keyframes through cuts, speed and holds; `recordingGraph` with and without `sounds`
  (unchanged graph without); export job validation.
- main: streams (chunks, end, errors, backpressure, per-window ownership, limits, idle close,
  stop), cache read/save validation and stat check (with a fake ffmpeg).
- copy: contrast of the state text tokens (AA).

End to end (`tests/e2e/sound-finder.e2e.cjs`, the built app under Xvfb):
- a recording with stems: speech on the microphone, a ding and music on the system sound. Find →
  progress → the list has the notification sound and the background music, no speech row; the cache
  file is written; reopening shows the list without listening (no stream opened).
- Mute the ding (keyboard: Tab to the button, Enter): saved as one span; the M4A export is silent there
  and unchanged elsewhere; Ctrl+Z brings it back (one step); Duck the music: about 14 dB lower;
  Cut: the clips change; Ignore hides the row, Show ignored brings it back.
- Cancel during a long recording: stops, nothing cached, the editor stays usable.
- An old project opens and saves unchanged.
- Screenshots `docs/screenshots/sound-finder-*.png`.

## 12. Left for later

- Muting only the stem a sound was found on (keeping speech on the other).
- A row's own duck depth and fade length; per-kind sensitivity in Settings.
- Markers of found sounds on the timeline's waveform.
- More kinds (sirens, traffic, chair squeaks, mouse clicks, lip smacks) and a GPU delegate.
- Finding sounds automatically after recording (with hands-off jobs).

## 13. As built

- Order of §4.3 changed while building: speech is taken out of a window run first, then each piece is
  fitted to the levels, and the row's key is the piece's start before fitting. Fitting first let
  loud speech next to a sound set its level, and made the key depend on the levels.
- Listening shows *"Getting the recording ready…"* while the levels and the speech detector are
  measured (45 s for an hour the first time), then the percentage.
- Opening the Audio tab reads the stored scores first and only waits for the levels and the speech
  detector when every source has some.
- `@mediapipe/tasks-audio` is pinned at 1.0.1 (the version of `@mediapipe/tasks-vision` in use);
  `scripts/notices.mjs` names it among the bundled packages and `resources/THIRD_PARTY_NOTICES.txt`
  is regenerated; `resources/notices/34-yamnet.txt` names the model.
