# Roadmap: future features

What Flown could do next, researched on 25 October 2026. Nothing on this page is built yet.

The list comes from three sources:

- the feature pages and changelogs of current recorders and editors: Screen Studio, Cap, FocuSee, Rapidemo, Tella, Loom, Camtasia, Descript, ScreenPal, Arcade, Supademo, Guidde, Scribe and Riverside;
- the AI features in video tools, and what the OpenAI, Gemini and Claude APIs can do today;
- a read of this codebase for gaps and for the places where a feature would be cheap to add.

A second reviewer checked every item against the code at commit `6198d86` and dropped anything the app already does. Each item has an id, a status and a size:

- **Size:** **S** = days, **M** = about a week, **L** = several weeks.
- **Status:** `planned` until work starts, then `in progress` with the wave, then `shipped` (also move the item into [FEATURES.md](FEATURES.md)).
- **Tier:** *Next wave* is ranked by value to someone making tutorials, product demos and marketing clips on Windows. *Later* and *Big bets* are grouped by kind, not ranked.

AI features keep the current model: the user brings their own key, there is no Flown server, and keys stay in the main process. Any feature that needs a hosted service says so.

## Deadlines to plan around

| Date | What happens | What it affects |
|---|---|---|
| **6 January 2027** | OpenAI removes `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts`. OpenAI names `gpt-realtime-2.1-mini` as the replacement. | Nothing shipped. LT-04 (voiceover) should be built on Gemini TTS. |
| **26 February 2027** | OpenAI removes `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize`. OpenAI names `gpt-transcribe` and `gpt-live-transcribe` as replacements. | **Handled by NW-09** (next release): Flown handles `gpt-transcribe`, which returns text only (OpenAI's docs, 30 October 2026); it times its words from the sound and marks them estimated, and a request to a retired model fails with a plain message. `whisper-1` stays the suggested model until the list of suggested models moves to `gpt-transcribe` a few weeks before the day, only for versions that can use it (a minimum app version per suggestion, added before 0.7.1 ships; `docs/design/transcription.md` §2.1). Users who typed `whisper-1` keep it, with the Settings note, until the day. Captions on this PC (F-01, shipped) do not depend on it. |

Source: the [OpenAI deprecations page](https://developers.openai.com/api/docs/deprecations), checked 25 October 2026.

## What each AI provider can do

| | OpenAI | Gemini | Claude | On the PC (no key) |
|---|---|---|---|---|
| Transcribe audio | yes (models above retire Feb 2027) | yes, with word times and speaker labels | **no** (no audio input) | yes, with word times: Whisper on the PC (F-01, shipped) |
| Text tasks (clean-up, translate, chapters, titles, summaries, copy) | yes | yes | yes; a 1M-token context fits very long transcripts | small local models through NW-14 |
| Look at frames or video | images | whole video or frames, with bounding boxes | images, up to 600 per request | Windows OCR for text (LT-05) |
| Speech (voiceover, dubbing) | until Jan 2027 | yes (Gemini TTS) | **no** | no |
| Images and music | images | images; music with Lyria | **no** | no |

## Suggested Wave 5

1. **NW-09 + LT-20**: transcription that survives the OpenAI shutdown. This has a deadline. (LT-20 shipped with F-01, captions on this PC; NW-09 shipped for the next release.)
2. **NW-04 + NW-01**: transcript editing, then filler and retake removal. They share one review screen.
3. **NW-02**: teleprompter and speaker notes (shipped in 0.3.0).
4. **NW-03**: better auto zoom input.
5. **NW-06**: smooth cuts. Ship the audio fades first.
6. **NW-07**: import an existing video (shipped in 0.7.0).
7. **NW-13**: publishing copy pack.
8. **NW-15 + X-03**: auto-update and a diagnostics bundle.

**Agreed order (25 October 2026):** NW-08 camera director and NW-03 smarter auto zoom (both shipped in Wave 5, 0.2.0), then NW-02
teleprompter, then the quick editing wins E-01 polish in one click, E-04 waveform, E-05 snapping, E-08 J/K/L
and preview speed, E-10 crop the recording, E-11 freeze frame.

---

## Next wave

### NW-09 · Transcription that survives the OpenAI shutdown, with speaker labels
**AI · M · shipped (next release) · deadline 26 Feb 2027**: see [FEATURES.md](FEATURES.md) (Captions after OpenAI retires whisper-1, Speaker labels) and `docs/design/transcription.md`. OpenAI's replacement `gpt-transcribe` returns text only (checked 30 October 2026): Flown times its words from the sound (marked estimated; exact times On this PC), and the suggested model moves to it through the model list near the day. Gemini labels speakers; recordings with separate tracks get You / Others with no AI. Left for later: aligning a provider's text to word times from the speech model on this PC, keeping Gemini's speaker numbers consistent across 5-minute parts, speaker labels for captions made On this PC beyond You / Others, a colour per speaker, and exact word times with a key through an OpenAI-compatible Whisper host (NW-14).

- **What:** keeps word timings working when `whisper-1` goes away. Karaoke captions, filler removal and transcript editing all depend on them. Also adds speaker labels for calls and interviews.
- **Works with:**
  - Gemini: text, word times and speakers.
  - Any OpenAI-compatible Whisper host through NW-14. Groq's `whisper-large-v3` returns word timestamps.
  - On-device Whisper (LT-20, shipped with F-01).
  - Optionally ElevenLabs, for forced alignment and speakers.
  - Not Claude.
- **Builds on:** `defaultTranscriptionModel` in `src/shared/api/ai.ts`; `src/main/ai/openai.ts` (`timestamp_granularities`); `src/main/ai/gemini.ts`, which already asks for per-word times; the separate mic and system stems, which give a two-speaker split with no AI.
- **Risks:** Gemini's word times are estimated by the model and can drift, so exact cuts may need a forced-alignment step. OpenAI's diarization model is being retired too.

### NW-01 · Remove filler words and retakes
**AI · M · shipped (0.7.0, on this PC, no AI call)**: see [FEATURES.md](FEATURES.md) (Remove fillers and retakes) and `docs/design/edit-by-text.md`. Left for later: verbatim transcription requests (a prompt with fillers for `whisper-1`, asking Gemini for them) and meaning-level retakes (F-05 or an AI text task).

- **What:** finds "um", "uh", repeated words, false starts and abandoned sentences and lists them as suggested cuts. The user unticks any to keep, then applies the rest in one undoable step.
- **Works with:**
  - Fillers: a local word list on the transcript, with no AI call. The transcript has to be made in a verbatim mode: `whisper-1` leaves fillers out unless the request has a prompt that contains them (`openai.ts` sends none today), and Gemini must be asked for them.
  - Retakes: a text task with OpenAI, Gemini or Claude.
- **Builds on:** `CaptionWord` timings; `src/shared/editor/smartSpeed.ts`, which turns time ranges into cuts with a time-saved preview; NW-04's review screen; NW-09's timings.
- **Risks:** cuts can clip syllables, so they need padding and audio fades (see NW-06). Retake detection can remove repetition the speaker meant, so the review list is required. Filler words differ per language.
- **Seen in:** Descript, Loom AI, Tella, Camtasia/Audiate.

### NW-04 · Edit the video by editing the transcript
**AI · M · shipped (0.7.0)**: see [FEATURES.md](FEATURES.md) (Edit by text) and `docs/design/edit-by-text.md`. Left for later: typing to replace words, moving sentences by drag, a command and shortcut for the Transcript tab. Known issue in 0.7.0, for 0.7.1: in four multi-step cases a word deleted in the Transcript tab shows again in the saved captions file (SRT/VTT) while the video stays cut: its caption trimmed and then moved on the caption track; trimmed, grown back over the word and the project reopened (two variants); or merged with a caption whose words were retyped (`docs/design/edit-by-text.md` §13).

- **What:** select words or sentences in the transcript and press Delete, and that part of the video is cut. Restoring the text brings the video back. The spoken word is highlighted during playback.
- **Works with:** any transcript with word timings. The edit itself makes no AI call.
- **Builds on:** the transcript editor in `CaptionsPanel.tsx` (deleting a caption today removes only the caption, never the video); `clips.ts`; `outputCues` in `src/shared/captions/subtitles.ts`, which already maps words through cuts.
- **Risks:** it is only as good as the word timings. Cuts inside a phrase need padding and fades. Transcript, cuts, speed changes and translations must stay in sync.
- **Seen in:** Descript, Loom, Camtasia/Audiate.

### NW-02 · Teleprompter and speaker notes, with an AI script draft
**Recording · S · shipped (0.3.0)**: see [FEATURES.md](FEATURES.md) (Speaker notes) and `docs/design/teleprompter.md`. Scrolling that follows the voice is F-27.

- **What:** a floating notes window only the presenter sees, kept out of the recording. It has font size, scroll speed and hotkey scrolling. A "Draft script" button turns bullet points into a spoken script.
- **Works with:** the script draft uses OpenAI, Gemini or Claude. The teleprompter needs no AI.
- **Builds on:** `setContentProtection(true)`, already used in `toolbarWindow.ts` and `cameraBubbleWindow.ts`; `hotkeys.ts`.
- **Risks:** hiding a window from capture needs Windows 10 2004 or later; older builds show a black box. The window must not take focus from the app being recorded. Scrolling that follows the voice is not part of v1.
- **Seen in:** Screen Studio, Loom, FocuSee, Riverside, Descript.

### NW-03 · Better auto zoom input: ignore stray clicks, straighten cursor paths, follow scrolling
**Editing · M · shipped (Wave 5)**: see [FEATURES.md](FEATURES.md) (Ignore stray clicks, Straighten cursor moves, Follow scrolling) and `docs/design/smarter-auto-zoom.md`.

- **What:**
  - Mark a click as "ignore" so it no longer triggers a zoom or click effect.
  - Replace a wobbly cursor move with a straight, smooth one.
  - Scrolling is recorded, so auto zoom holds or zooms out while a page scrolls and zooms back in where the scrolling stops.
- **Builds on:**
  - `ClickEvent` and `CursorTrack` in `src/shared/types.ts`, which have no ignore flag and no scroll data today.
  - `src/main/cursorTracker.ts`, which hears wheel events but uses them only for idle detection.
  - The `auto` flag on zoom segments.
- **Risks:** scroll data exists only for recordings made after this ships. Regenerating must touch only `auto` zooms, so manual zooms survive.
- **Seen in:** Camtasia cursor path editing, Rapidemo "disable accidental clicks".

### NW-06 · Smooth cuts
**Editing · M · audio fades shipped (0.7.0: 10 ms out and in at every cut, export and preview)**; the video cross-dissolve, per-cut styles and "Smooth all cuts" are still planned (`docs/design/edit-by-text.md` §12).

- **What:** each cut can get a short crossfade, zoom punch-in, slide or dip to colour, and "Smooth all cuts" applies one style to every cut. Ship first: always-on 5–15 ms audio fades at every cut. Today `audioPlan.ts` joins clips with a plain concat, so silence removal can leave clicks.
- **Builds on:** `Clip` (`{id, start, end, speed}`, no transition field); the compositor's existing blends for zoom and layout transitions.
- **Risks:** a blend needs two decoded frames at once in preview and export. Overlapping transitions change the total length, so caption and chapter times must account for it.
- **Seen in:** Descript, Camtasia, Cap, Tella.

### NW-07 · Import an existing video
**Editing · M · shipped (0.7.0)** · see [FEATURES.md](FEATURES.md) (Import a video) and `docs/design/import-video.md`

- **Shipped:** *Import video* and drag and drop on Home; MP4, MOV, MKV and WebM; probe, test decode, size, length, DRM and disk checks with plain refusals; an editing copy at 30 or 60 fps (variable rates made constant), upright, at most 3840 × 2160, HDR tone-mapped; no cursor data, and the editor says what that turns off.
- **Left for later:** remuxing files that already meet the editing-copy rules instead of re-encoding; keeping 24, 25 and 50 fps; choosing among several sound tracks; importing a separate camera file; AVI, WMV and MTS; several files at once; F-28 (auto zoom from the picture).

- **What:** start a project from an MP4, MOV or WebM recorded with OBS, Xbox Game Bar, Teams or a phone. Backgrounds, manual zooms, captions, silence removal and export then work as usual.
- **Builds on:** `proxyArgs.ts` and `recording/finalize.ts`, which can turn any video into the editing proxy.
- **Risks:** an imported video has no cursor or click data, so auto zoom, cursor effects and click sounds are off, and the UI must say so. Phone videos have variable frame rates and odd codecs, so files need careful probing.
- **Seen in:** Screen Studio, FocuSee, Tella, ScreenPal, Camtasia.

### NW-13 · Publishing copy pack
**AI · S · planned**

- **What:** from the transcript, writes:
  - a YouTube description with chapter timestamps and tags;
  - a LinkedIn or X post;
  - a help-centre article;
  - release notes.

  Each is copyable in one click, and all the AI text tools go into the command palette (Ctrl+K).
- **Works with:** OpenAI, Gemini or Claude.
- **Builds on:** the text-task pipeline (one prompt, schema, validator and effort entry per task); the Summarize button, shipped in Wave 4; `src/shared/render/chapters.ts`, which already writes YouTube timestamps; `commands.ts`.
- **Risks:** generic-sounding text, so add a tone setting. The transcript must stay marked as data, not instructions. Silent recordings get nothing until LT-09.

### NW-14 · Any AI service, a model list, and the cost up front
**AI · M · planned**

- **What:**
  - An "OpenAI-compatible" provider with a custom URL, for Azure OpenAI, OpenRouter, Groq, or local Ollama and LM Studio.
  - Model fields become a list fetched from the provider instead of free text.
  - Long jobs show an estimated cost before they start.
- **Builds on:** `src/main/ai/endpoints.ts`, which honours a base URL only in development builds today; `openai.ts`, which accepts `baseURL`; the key test, which already lists models; `ProviderForm.tsx`.
- **Risks:**
  - Servers differ in whether they support structured output and audio, so each feature checks what the server can do and fails with a clear message.
  - The custom URL receives the user's key, so allow `http://` only for localhost.
  - Cost estimates go stale when prices change.

### NW-08 · Automatic camera director
**AI · M · shipped (Wave 5)** · see [FEATURES.md](FEATURES.md) and `docs/design/camera-director.md`

- **Shipped as designed**, with no separate face model: the face is found from the bundled selfie segmenter's person mask (the top of the silhouette), so `blaze_face_short_range` is not needed. AI labelling of intro and outro is left for later.
- **What:** one click builds the camera track: full-screen camera for the intro and outro, a small bubble during the demo. The bubble moves away from the cursor, hides during long silences, and the crop keeps the face centred.
- **Works with:** runs on the PC, using voice activity, cursor and typing data, and a face detector. The face detector needs MediaPipe's `blaze_face_short_range` (about 0.2 MB); only the selfie segmenter is bundled today. OpenAI, Gemini or Claude can optionally label the intro, demo and outro from the transcript.
- **Builds on:** `LayoutSegment` (it needs an `auto` flag, as zoom segments have); `src/shared/audio/activity.ts`; the bundled MediaPipe worker.
- **Risks:** too many switches feel busy, so segments need minimum lengths. Preview and export must agree.
- **Seen in:** Tella Auto Layouts, Riverside, Descript, Screen Studio.

### NW-10 · Studio voice with live preview
**AI · M · partly shipped (0.7.0)**: *Clean voice* (the RNNoise denoiser, rendered once and played in the preview as exported) shipped; see [FEATURES.md](FEATURES.md) and `docs/design/clean-voice.md`. Left for later: the "studio voice" preset (EQ, compressor, de-esser), recording the microphone raw when Clean voice will be used, and DeepFilterNet3 as a better engine.

- **What:** a neural speech denoiser (RNNoise) that removes keyboard noise and fans, plus a "studio voice" preset (EQ, compressor, de-esser). The user hears the result while editing, not only after export.
- **Works with:** runs on the PC with no key. An ElevenLabs Voice Isolator key is optional for hard cases. OpenAI, Gemini and Claude offer no audio clean-up.
- **Builds on:** `audioPlan.ts` (export uses `afftdn` today); the bundled ffmpeg, which already has `arnndn`, `deesser` and `acompressor`; `previewAudio.ts`.
- **Risks:** matching the preview (WASM in an AudioWorklet) to the export is the real work. The mic is recorded with Chromium's noise suppression on (`session.ts`), so stacking RNNoise can over-process. Offer to record raw when Studio Voice is on.

### NW-11 · Checks before and during recording
**Recording · M · planned**

- **What:**
  - Warns when the disk is nearly full and stops cleanly before it fills.
  - Asks "no microphone selected, record anyway?".
  - A 5-second mic check flags a quiet, clipping, noisy or echoing mic.
  - The webcam can record at 1080p or 4K and 60 fps (it is fixed at 1280×720, 30 fps today).
  - The recorded window can be resized to an exact size such as 1920×1080.
- **Works with:** analysis runs on the PC. Gemini can optionally give plain-language mic advice.
- **Builds on:** `session.ts`, `meterMicrophone`, `windowGeometry.ts`, the Home mic warning.
- **Risks:** some webcams report modes they cannot hold. Resizing another app's window fails for elevated or fixed-size windows.
- **Seen in:** Cap, Adobe Podcast Mic Check, Screen Studio, Loom.

### NW-12 · Image, logo and sticker overlays, plus brand fonts
**Editing · M · shipped (0.6.0, `feat-brand-kit`)**: see [FEATURES.md](FEATURES.md) (Image overlays and stickers, Brand fonts) and `docs/design/brand-kit.md`. Left for later: a GIF that plays once and holds (GIFs always loop), WOFF (1) and font collections (`.ttc`), choosing a font weight or style inside a family, a font for the watermark text and the keystroke overlay, and a command and shortcut to add an image (the editor's command list is being reworked on `feat/multi-select`).

- **What:** a timed overlay track for images, GIFs and emoji that can be moved, resized, rotated, faded and trimmed. Captions, titles and annotations can use the user's own font.
- **Builds on:** `ASSET_SPECS` in `src/main/assetIpc.ts`, which makes a new asset kind cheap; `ShapeKind`; the fixed `CAPTION_FONT`, `TITLE_FONT` and `ANNOTATION_FONT`.
- **Risks:** animated GIFs must decode frame-accurately in export. Fonts must load under the content security policy and be copied into the project, so it renders the same on another PC.
- **Seen in:** Cap, Tella, ScreenPal, Camtasia.

### NW-05 · Vertical video that follows the action, with a safe-zone preview
**Editing · M · shipped (0.7.0)**: see [FEATURES.md](FEATURES.md) (Vertical video that follows the action, Safe-zone preview), `docs/design/vertical-video.md` and `docs/screenshots/vertical-video-*.png`. **Before release:** compare the safe-zone table with TikTok, Reels and Shorts on a phone and record the date in each platform's `checked` field (`src/shared/render/safeZones.ts`). Left for later (the design's §12): a Framing track with *Frame here* and *Whole screen* blocks and ticks that say why the view moved; following picture changes in recordings without cursor data; pulling back while travelling on long pans; following in frames wider than the recording, and a camera band in square frames; carrying following in style presets, the default style and Polish; re-anchoring texts to the content they point at; captions at the seam between band and screen; more platforms and per-preset placement in the safe-zone table, refreshed without a release (with NW-15); an opt-in screen-description hint from the user's own AI key; incremental plan rebuilds while dragging on very long recordings.

- **What:** for 9:16 and 1:1, the view crops in and follows the cursor, clicks and typing instead of shrinking the whole desktop. The camera moves to a band at the top or bottom. A toggle shows where TikTok, Reels and Shorts buttons cover the video.
- **Works with:** runs on the PC from recorded cursor data. Gemini or Claude vision could be added later.
- **Builds on:** `focusPath` in `src/shared/engine/cursor.ts`; `layout.ts`, which fits rather than fills today; the reels, tiktok and shorts presets.
- **Risks:** fast cursor moves make the pan jumpy, so it needs strong smoothing. Imported videos have no cursor data. The platforms move their buttons.
- **Seen in:** Opus Clip, CapCut, Descript, Screen Studio.

### NW-15 · Auto-update and a refreshable model list
**Quality · S · shipped (0.7.1)**: see [FEATURES.md](FEATURES.md) (Updates itself, Suggested AI models refresh themselves), `docs/design/auto-update.md` and `docs/RELEASING.md`. Left for later: differential downloads, a beta channel, staged roll-outs, code signing (needs a certificate).

- **What:** checks for new versions, downloads them in the background and installs on restart. The list of recommended AI models can be refreshed without a full release.
- **Builds on:** `electron-builder.config.cjs` (`publish: null` today) and the code-signing setup; electron-updater.
- **Risks:** needs a release feed (GitHub Releases or a static host) and signed builds. A bad update must be easy to roll back. A remote model list must come from a trusted, integrity-checked location.

### X-02 · Caption emphasis
**AI · S · planned**

- **What:** picks the key words in each caption to colour, enlarge or pair with an emoji in the bold and karaoke styles, the social-caption look.
- **Works with:** OpenAI, Gemini or Claude.
- **Builds on:** the caption presets and the strict-schema text-task pipeline.

### X-03 · Diagnostics bundle
**Quality · S · shipped (0.7.0, `feat-hands-off`)**: see [FEATURES.md](FEATURES.md) (Diagnostics) and `docs/design/hands-off.md`. Left for later: crash reports (minidumps) next to the log.

- **What:** "Copy diagnostics" in Settings collects:
  - the Windows build;
  - the GPU and the detected encoders;
  - the native helper's probe result;
  - the capture method used;
  - recent main-process log lines.

  It never includes keys, or file paths outside the app's own folders.
- **Why:** the app has no log file or crash reporting yet, and several Windows paths have not been run on a real PC.

### X-04 · Duplicate project and single-file project
**Editing · S · Duplicate shipped (0.7.0); single-file project planned**: Duplicate, Make a vertical version and Make a square version are in the editor (see [FEATURES.md](FEATURES.md) and `docs/design/vertical-video.md` §4.7). Still planned: Duplicate from the Home library, "Save as one .flown file" (both can reuse `src/main/projectCopy.ts`'s list of the files a project holds), and removing half-made copies at start-up rather than only at the next copy. Hard links on NTFS and the OneDrive check are *Windows-unverified*.

- **What:** "Duplicate" makes a vertical or short cut without touching the original; LT-02 and NW-05 need it. "Save as one .flown file" moves a project to another PC or a teammate.

---

## Easier editing

Added 25 October 2026. These make everyday editing faster. Each was checked against the code at
commit `f17cd98`, and the editor does not have it yet. E-01, E-04, E-05, E-08, E-10 and E-11 are
`shipped` (Wave 6): see [FEATURES.md](FEATURES.md) and `docs/design/editing-wins.md`, which links the six
designs. E-06 is `shipped` (after 0.5.0): see [FEATURES.md](FEATURES.md) and `docs/design/multi-select.md`.
The rest are `planned`.

| Id | Feature | What it does | Size |
|---|---|---|---|
| E-01 (shipped, Wave 6) | **Polish in one click** | Runs remove silences, auto zoom, the camera director (NW-08), captions (on this PC once a speech model is downloaded, else with a provider that can transcribe) and your style preset in one go. Shows a summary of what changed (time saved, zooms, cuts, camera changes), all in one undo step. | S–M |
| E-02 | **Review mode** | Steps through every automatic decision (each zoom, cut, camera change, removed filler) with Keep / Remove, like reviewing tracked changes. | M |
| E-03 (shipped, `feat-brand-kit`) | **Brand kit** | Your logo, colours, fonts, intro and outro title cards and style, saved once; every new recording starts with them. See [FEATURES.md](FEATURES.md) and `docs/design/brand-kit.md`. Left for later: several named kits, sharing a kit as a file, and new text taking the kit's body font when it is added. | S–M |
| E-04 (shipped, Wave 6) | **Audio waveform on the timeline** | Shows where you talk and where the pauses are, so cuts land in the right place. | S |
| E-05 (shipped, Wave 6) | **Snapping** | Segment edges and the playhead snap to cuts, clicks, chapter flags and other segments while dragging (hold Alt to turn it off). | S |
| E-06 (shipped) | **Select several items** | Ctrl/Shift-click or drag a box to select zooms, text, shapes, spotlights, title cards, chapters and freeze frames together, edit what they share, move, delete, copy, paste or duplicate them; copy one item's look onto others. | M |
| E-07 | **Filmstrip on the clip track** | Small frames along the clip track, to find a moment by sight. | S–M |
| E-08 (shipped, Wave 6) | **J / K / L playback and preview speed** | Reverse, pause and forward from the keyboard (tap again to go faster), and play the preview at 1.5× or 2× to review long recordings quickly. | S |
| E-09 | **Nudge by one frame** | Arrow keys move the selected item one frame, Shift + arrow ten frames. | S |
| E-10 (shipped, Wave 6) | **Crop the recording in the editor** | Hide the taskbar, browser tabs or a screen edge after recording. Today the area can only be chosen before recording. | S–M |
| E-11 (shipped, Wave 6) | **Freeze frame** | Hold a frame for a few seconds so viewers can read something, with the sound paused or continuing. | S |
| E-12 | **Versions** | Save named versions of an edit ("Before captions", "v1 for client") and go back to any of them. | S–M |
| E-13 | **Re-record one part** | Record only the part that went wrong and drop it in place. Builds on multiple takes (LT-01). | L |

---

## Free automation (no running cost)

Researched 26 October 2026. Each item automates work with no paid API call and no Qbexel server:
AI that runs on the user's PC, features built into Windows or Electron, or plain rules. A reviewer
checked each one against the code and the roadmap, and checked licences and sizes on the web.
Sizes and speeds marked "about" are estimates to benchmark. Large models are optional downloads,
fetched only when the user turns the feature on (see F-13). All are `planned` except F-01 and F-03
(shipped) and a minimal F-13 (shipped with F-01). Their rows keep the research; what shipped is in
`docs/design/offline-captions.md` §2.

Quality trade-off: on-device models are free and private, but small language and vision models
write plainer text than OpenAI, Gemini or Claude, and are weaker on rare languages. Paid providers
stay available as the premium option.

### Best value

| Id | Feature | What it automates | How it is free | Size | Serves |
|---|---|---|---|---|---|
| F-01 | **Offline captions with exact word timings** · *shipped*: see [FEATURES.md](FEATURES.md) (Captions on this PC) and `docs/design/offline-captions.md` | Captions, karaoke and transcript editing with no key, no upload and no cost; keeps working after OpenAI's 26 Feb 2027 shutdown | Shipped: whisper.cpp 1.8.3 (MIT) in a Rust sidecar (whisper-rs-sys, Unlicense), a standard (AVX2) and a compatible CPU build; models on demand: tiny q8_0 44 MB, base q5_1 60 MB (the default), small q5_1 190 MB, large-v3-turbo q5_0 574 MB; Silero VAD built in; DTW word times (flash attention off). **Bangla model shipped** (offline-captions §14): Bengali.AI Whisper medium q5_0, 539 MB, Apache-2.0, Bangla only (18 % WER on FLEURS Bangla long-form against 98 % for turbo), recommended in the Captions tab for Bengali, used by Polish for Bengali; Qbexel may re-host the same bytes later (one repository in the catalog). Later: a Vulkan build and Parakeet TDT 0.6B v3 (CC-BY-4.0, attribution) via sherpa-onnx as a faster English/European engine | L | LT-20, NW-09, NW-01, NW-04 |
| F-02 | **After-recording autopilot and naming templates** | Each recording preset runs steps when you stop: style, remove silences, captions, export to a folder, copy, notify; names like `{app} - {preset} - {date} #{n}` | Plain app code reusing finalize, smart speed and batch export; needs a hidden export window (new) and a saved approved folder | M–L | E-01 |
| F-03 | **Neural speech detector** · *shipped*: see [FEATURES.md](FEATURES.md) (Speech detector) | Remove silences, smart speed, music ducking and the camera director react to real speech, not keyboard clatter or fans | Shipped: Silero VAD v6.2.0 (MIT) in ggml format, 885 KB, in the installer, run by the speech sidecar on one thread (about 400 times real time) | S | Silences, smart speed, NW-08, NW-01 |
| F-04 | **"On this PC" AI provider** | Titles, chapters, summaries, clean-up, translate, copy pack and script drafts with no key | llama.cpp via node-llama-cpp (MIT) in a utility process (CPU 33 MB or Vulkan 74 MB runtime); Qwen3.5 2B (1.3 GB) or 4B (2.7 GB), Apache-2.0, on demand; JSON-schema output. Label it "good for drafts" | L | NW-14, NW-13, X-02, NW-02 |
| F-05 | **Fillers and retakes found offline** | Suggested cuts for "um", repeats and abandoned takes, reviewed in one list | Fillers from F-01 verbatim transcripts plus word lists; retakes from sentence similarity (all-MiniLM-L6-v2 Apache-2.0 about 23 MB quantised, or multilingual-e5-small MIT about 118 MB) via transformers.js | M | NW-01, NW-04 |
| F-06 | **Know what was clicked** | Auto zoom frames the whole button or dialog, typing zooms aim at the text box, empty-space clicks are flagged stray, guides say "Click 'Export'" without AI | Windows UI Automation (built in since Windows 7) in a new long-running helper subcommand, queried at mouse-down with timeouts; never reads text fields, skips password boxes | M | NW-03, LT-03, LT-07, LT-15 |
| F-07 | **Auto-blur passwords, emails, keys and card numbers** | Blur suggestions to review, instead of scrubbing the video | UIA password-box rectangles; Windows.Media.Ocr (officially needs package identity) with PaddleOCR PP-OCRv5 ONNX (Apache-2.0, about 20 MB) as a real fallback; Luhn and key-prefix patterns | M–L | LT-05 |
| F-08 | **Studio voice** (Clean voice shipped in 0.7.0, with ffmpeg arnndn and bundled RNNoise models; DeepFilterNet3 left for later, `docs/design/clean-voice.md` §2) | Removes fan hum, keyboard and room noise; the preview sounds like the export | DeepFilterNet3 (MIT/Apache-2.0, about 8 MB, Rust/tract); render the cleaned stem once and play it in preview; ffmpeg arnndn as the no-download fallback | M | NW-10 |
| F-09 | **Markers that edit while recording** | Hotkeys for "new chapter here" and "cut that"; the project opens with chapters and suggested cuts. Later, the spoken phrases after recording | Extends today's "zoom here" marks; phase 2 is offline keyword spotting on the mic stem (sherpa-onnx, Apache-2.0, a few MB) | S | NW-01, E-02, chapters |
| F-10 | **Chapters without AI** | Named chapters from app switches, scene changes and pauses, following YouTube's rules; silent recordings too | Foreground-window log in the helper, ffmpeg scdet, F-03 pauses; names from window titles (reviewed before export, they can be private) | M | Chapters, LT-09, NW-13 |
| F-11 | **Export bundle and one file per chapter** · *shipped* (`docs/design/hands-off.md`); later: a chapter list file for a whole set of parts | SRT/VTT, chapter list, thumbnail and description written next to each export; "01 Intro.mp4", "02 Billing.mp4" in one tick | Reuses subtitle, chapter, thumbnail and batch export code | S | NW-13, LT-02 |
| F-12 | **Hands-off long jobs** · *shipped* (`docs/design/hands-off.md`): a locked PC keeps working (it is the point of hands-off), sleep pauses and resumes; later: pausing captions between parts. Notification buttons and thumbnail buttons are *Windows-unverified* | Taskbar progress, Pause/Stop on the taskbar thumbnail, "Export finished" notification with buttons, PC kept awake, lock pauses, sleep stops cleanly | Electron built-ins: Notification actions, setProgressBar, setThumbarButtons, powerSaveBlocker, powerMonitor | S | NW-11 |
| F-13 | **Model manager and hardware check** · *minimal manager shipped with F-01* (the speech models in Settings › Captions on this PC) | One Settings page lists optional models with size and purpose, downloads on demand, resumes, verifies each file, removes with one click | Free hosting on GitHub Releases or Hugging Face, SHA-256 pinned; models under about 20 MB ship in the installer. Pick one ONNX route (sherpa-onnx native for audio) | M | NW-15; needed by F-01, F-04, F-05, F-16, F-21 |

### Worth doing

| Id | Feature | What it automates | How it is free | Size |
|---|---|---|---|---|
| F-14 | **Start recording from anywhere** | Global start hotkey per preset, "record the last area again", tray menu, taskbar jump list, start quietly with Windows | Electron globalShortcut, Tray, setUserTasks, setLoginItemSettings; a tested argument parser shared with F-23 | S |
| F-15 | **Face and expression tracking** | Face centring, screen-only when the presenter looks away, no blink freeze frames, thumbnail picks with eyes open and smiling | MediaPipe Face Landmarker (Apache-2.0, 3.76 MB) in the existing worker; blaze_face (0.23 MB) if only centring is needed | S |
| F-16 | **Offline caption translation** | Captions and titles in other languages, timings kept | Mozilla Bergamot (MPL-2.0) built to WASM with the fallback GEMM, models re-hosted (15–40 MB per pair); opus-mt (CC-BY-4.0) for gaps; avoid NLLB (non-commercial) | M–L |
| F-17 | **Unwanted-sound finder** | Lists pings, buzzes, coughs, barks and background music with Mute, Cut or Duck | YAMNet (Apache-2.0, 4.1 MB) via MediaPipe tasks-audio (adds about 11 MB to the installer) | S |
| F-18 | **Search every recording** | Find a moment by meaning or by on-screen text across the library | Local index of transcripts, OCR, UIA labels and titles; small embedding model via transformers.js | M |
| F-19 | **Profiles per app and per client** | The right style, export preset and folder picked by the app being recorded or the client | Rules in settings; process name and foreground hook in the helper (new subcommand) | M |
| F-20 | **Batch actions with a background queue** | Restyle, remove silences, caption or export many recordings at once | Existing modules plus a hidden render window; project snapshots for undo | M–L |
| F-21 | **Offline voiceover** | Narration from a script or captions, timed to each caption | Kokoro-82M (Apache-2.0 weights, 92 MB q8) via kokoro-js; its phonemizer bundles eSpeak NG (GPL-3.0), so legal review before shipping; Windows voices as a no-download fallback | M |
| F-22 | **Share without a server** | Copy to OneDrive/Dropbox/Google Drive folders, upload with the user's rclone and copy a link, post to a Discord/Slack/n8n webhook | File copies and local programs; webhook URLs stored like API keys | S |
| F-23 | **Command line, flown:// links, scheduled and self-stopping recordings** | Stream Deck, AutoHotkey or Task Scheduler can start a preset; recordings stop after N minutes, a file size or N seconds of silence | Protocol handler, second-instance arguments, per-user schtasks; links can never start a recording without confirmation | M |
| F-24 | **Clean desktop mode and notification guard** | Taskbar auto-hide, plain wallpaper and minimised windows for the session, restored afterwards; warns about notifications | Documented Win32 calls, every change opt-in; Windows has no public Do not disturb switch, so warn and link only | M |
| F-25 | **Speaker labels on the PC** | Who is speaking in calls and interviews | Mic vs system stems first (free today); then sherpa-onnx diarization (pyannote segmentation MIT, ERes2Net 26.5 MB Apache-2.0) | M |
| F-26 | **Storage manager with clean-up rules** · *shipped* (`docs/design/hands-off.md`): caches, not proxies (the proxies are the recording), last use kept in userData, not project.json; later: move the library | Disk use per recording, approved clean-up rules, Recycle Bin instead of permanent delete, move the library | fs.statfs, shell.trashItem; record the last export in project.json | S |

### Later

| Id | Feature | Notes | Size |
|---|---|---|---|
| F-27 | **Teleprompter that follows the voice** | Needs NW-02 first. Moonshine streaming (MIT, English) or sherpa-onnx streaming zipformers; Moonshine's non-English models are non-commercial | M |
| F-28 | **Auto zoom for videos from other recorders, and watch folders** | Needs NW-07. Cursor template matching and inferred clicks (marked "estimated"), OpenCV.js (Apache-2.0); avoid AGPL YOLO detectors | L |
| F-29 | **Small vision model for silent recordings** | Florence-2-base (MIT) or Qwen3.5 with vision via F-04; drafts only, weaker than cloud vision; avoid AGPL OmniParser/YOLO | L |
| F-30 | **Copilot+ PC fast path** | Windows AI APIs on Windows 11 24H2 Copilot+ PCs (NPU): OCR, Phi Silica, upscaling, object erase. Needs package identity (a signed sparse MSIX; free only if Qbexel already signs), Windows App SDK 1.8; a documented Electron crash with sparse packages must be detected, never worked around by disabling the sandbox | L |

---

## Later

### AI

| Id | Feature | What it does | Works with | Size |
|---|---|---|---|---|
| LT-20 | **Offline transcription on the PC** · *shipped with F-01* | Captions with word timings from a Whisper model on the user's PC: no key, no cost, no upload. The reviewer suggests pulling it into the next wave with NW-09. | whisper.cpp (shipped) | L |
| LT-02 | **Highlight clips and short versions** | Finds the best 15–90 s moments, or makes "a 60-second version about billing". Each result is saved as a copy of the project, framed and captioned. Needs X-04, and works best after NW-05. | OpenAI, Gemini or Claude (Claude for very long transcripts); Gemini can also judge the video | M |
| LT-03 | **Step-by-step guide or bug report** | For each click: a styled frame with a highlight ring and a numbered instruction. Exports Markdown, HTML or PDF. A bug-report template writes steps to reproduce. Build with LT-07. | Vision + text with OpenAI, Gemini or Claude; a no-AI mode uses clicks and keys only | M |
| LT-04 | **AI voiceover and dubbed languages** | Narration from a script or the edited captions, timed to each caption, then spoken tracks in other languages. | Gemini TTS (main), ElevenLabs optional; not Claude; OpenAI TTS retires Jan 2027 | L |
| LT-05 | **Auto-blur sensitive information** | Finds emails, API keys, passwords, phone and card numbers and listed names, and suggests blur boxes to review. | Windows OCR plus patterns, no key (needs the OCR language pack); optional vision pass | M (L with scroll tracking) |
| LT-08 | **AI co-editor and pre-publish review** | "Cut the pauses, zoom every click in the first minute, keep it under 3 min" becomes previewed edits in one undo step. "Review" lists pacing problems with one-click fixes. | OpenAI, Gemini or Claude with strict structured output or tools | L |
| LT-09 | **Understands silent recordings** | Titles, chapters, summaries, alt text and a thumbnail pick from keyframes or a low-resolution copy of the video. | Gemini (video or frames), Claude (images), OpenAI (images) | M |
| LT-14 | **Virtual background and cut-out camera** | Replaces the webcam background, or shows the presenter as a floating cut-out. | Runs on the PC (bundled MediaPipe segmenter) | S |
| LT-15 | **Content-aware zooms and callouts** | Suggests zooms, spotlights and arrows on the element being talked about, even without a click. | Gemini (bounding boxes) fits best; Claude and OpenAI give approximate positions | L |
| LT-21 | **AI thumbnails, backgrounds, images and music** | A thumbnail from a frame, a unique Style wallpaper, an illustration, or a music bed fitted to the video's length. | Images: OpenAI or Gemini; music: Gemini Lyria; not Claude | M |
| X-01 | **Search the library** | Find "the recording where I showed billing" across transcripts, titles, chapters and summaries, and jump to that moment. | Keyword search needs no AI; optional embeddings or a text task | S–M |

### Recording

| Id | Feature | What it does | Size |
|---|---|---|---|
| LT-01 | **Multiple takes and live rewind** | Record a project in several takes, rewind the last seconds while recording, reuse an intro and outro. Live rewind alone is M and can ship first. | L |
| LT-06 | **Screenshot mode** | A hotkey captures a window or area as a still with Flown's background, padding, shadow and device frame, ready to annotate, blur, copy or save. | M |
| LT-18 | **Record only one app's sound** | Captures only the recorded app's audio, so Slack and Teams pings stay out. Process loopback is documented for Windows 10 build 20348 and later; probe for support and fall back. | M |
| LT-19 | **Draw on screen while recording** | Pen, highlighter and arrow on a hotkey. Strokes are saved as editable timed shapes. | M |

### Editing and polish

| Id | Feature | What it does | Size |
|---|---|---|---|
| LT-10 | **Subtitle tracks in several languages** | Keeps one transcript per language. Export adds switchable subtitle tracks, or writes SRT/VTT for every language. | M |
| LT-11 | **Animated callouts and a chapter progress bar** | Enter and exit animations for text, shapes and titles; step badges; speech bubbles; a chapter progress bar. | M |
| LT-12 | **Magnifier (loupe) zoom** | A round magnifier over a small detail while the rest of the screen stays visible. | S |
| LT-13 | **Built-in music and sound-effects library** | Royalty-free (CC0) music beds, plus optional whoosh and pop sounds on zooms and titles. | S |
| LT-16 | **Colour correction and looks** | Brightness, contrast, saturation, temperature and LUTs, separately for camera and screen. | M |

### Sharing and output

| Id | Feature | What it does | Size |
|---|---|---|---|
| LT-07 | **Interactive click-through demo** | An offline HTML folder viewers click through step by step, with hotspots and Next and Back buttons. | M |
| LT-17 | **Publish to YouTube, Vimeo and LinkedIn** | Upload with the AI title, description, chapters and captions filled in. YouTube alone is M; Google's API audit is needed for public uploads. | L |
| LT-22 | **Pro export formats** | HEVC, AV1, ProRes and WebM with transparency, 4:5, 24/25/120 fps, saved presets, WAV stems, and FCPXML/EDL for Premiere and Resolve. The bundled ffmpeg already has the encoders. 4:5, 24/25 fps and WAV stems are S each. | L |
| X-05 | **The app in other languages** | Extract the UI text and ship Bengali, Spanish and others, with AI-drafted translations reviewed by people. (Bangla *captions* on this PC already shipped: offline-captions §14.) | M |

---

## Big bets

| Id | Feature | What it does | Why it is a big bet | Size |
|---|---|---|---|---|
| BB-01 | **Share links** | Upload with a player page (chapters, captions, call to action) and copy a link. Phase 1 uses the user's own storage (S3, R2, Drive, Dropbox). Phase 2 is a hosted Qbexel service with comments, views and teams. | Phase 2 needs servers, storage costs, moderation, accounts and a privacy policy, which breaks today's no-backend design. | L |
| BB-02 | **Record an Android phone over USB** | Phone screen over USB, taps feed auto zoom, inside a phone frame. | Needs adb and USB debugging, which confuse non-developers. There is no supported way to capture an iPhone on Windows. | L |
| BB-03 | **Fix a misspoken word by typing** | Type the correction and the phrase is regenerated in the presenter's own voice. | Needs a recorded consent step and misuse rules, and the new phrase must match the room tone. Gemini TTS, OpenAI custom voices or ElevenLabs; not Claude. Check the current provider docs before building. | L |
