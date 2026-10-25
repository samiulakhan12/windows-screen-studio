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
| **26 February 2027** | OpenAI removes `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`. OpenAI names `gpt-transcribe` and `gpt-live-transcribe` as replacements. | **Shipped feature.** `whisper-1` is Flown's default OpenAI transcription model (`src/shared/api/ai.ts`), and `src/main/ai/openai.ts` relies on its word timestamps. Third-party write-ups say the replacements return no word timings. Check the current OpenAI docs before building **NW-09**. |

Source: the [OpenAI deprecations page](https://developers.openai.com/api/docs/deprecations), checked 25 October 2026.

## What each AI provider can do

| | OpenAI | Gemini | Claude | On the PC (no key) |
|---|---|---|---|---|
| Transcribe audio | yes (models above retire Feb 2027) | yes, with word times and speaker labels | **no** (no audio input) | possible with Whisper (LT-20) |
| Text tasks (clean-up, translate, chapters, titles, summaries, copy) | yes | yes | yes; a 1M-token context fits very long transcripts | small local models through NW-14 |
| Look at frames or video | images | whole video or frames, with bounding boxes | images, up to 600 per request | Windows OCR for text (LT-05) |
| Speech (voiceover, dubbing) | until Jan 2027 | yes (Gemini TTS) | **no** | no |
| Images and music | images | images; music with Lyria | **no** | no |

## Suggested Wave 5

1. **NW-09 + LT-20**: transcription that survives the OpenAI shutdown. This has a deadline.
2. **NW-04 + NW-01**: transcript editing, then filler and retake removal. They share one review screen.
3. **NW-02**: teleprompter and speaker notes.
4. **NW-03**: better auto zoom input.
5. **NW-06**: smooth cuts. Ship the audio fades first.
6. **NW-07**: import an existing video.
7. **NW-13**: publishing copy pack.
8. **NW-15 + X-03**: auto-update and a diagnostics bundle.

**Agreed order (25 October 2026):** NW-08 camera director and NW-03 smarter auto zoom (in progress), then NW-02
teleprompter, then the quick editing wins E-01 polish in one click, E-04 waveform, E-05 snapping, E-08 J/K/L
and preview speed, E-10 crop the recording, E-11 freeze frame.

---

## Next wave

### NW-09 · Transcription that survives the OpenAI shutdown, with speaker labels
**AI · M · planned · deadline 26 Feb 2027**

- **What:** keeps word timings working when `whisper-1` goes away. Karaoke captions, filler removal and transcript editing all depend on them. Also adds speaker labels for calls and interviews.
- **Works with:**
  - Gemini: text, word times and speakers.
  - Any OpenAI-compatible Whisper host through NW-14. Groq's `whisper-large-v3` returns word timestamps.
  - On-device Whisper (LT-20).
  - Optionally ElevenLabs, for forced alignment and speakers.
  - Not Claude.
- **Builds on:** `defaultTranscriptionModel` in `src/shared/api/ai.ts`; `src/main/ai/openai.ts` (`timestamp_granularities`); `src/main/ai/gemini.ts`, which already asks for per-word times; the separate mic and system stems, which give a two-speaker split with no AI.
- **Risks:** Gemini's word times are estimated by the model and can drift, so exact cuts may need a forced-alignment step. OpenAI's diarization model is being retired too.

### NW-01 · Remove filler words and retakes
**AI · M · planned**

- **What:** finds "um", "uh", repeated words, false starts and abandoned sentences and lists them as suggested cuts. The user unticks any to keep, then applies the rest in one undoable step.
- **Works with:**
  - Fillers: a local word list on the transcript, with no AI call. The transcript has to be made in a verbatim mode: `whisper-1` leaves fillers out unless the request has a prompt that contains them (`openai.ts` sends none today), and Gemini must be asked for them.
  - Retakes: a text task with OpenAI, Gemini or Claude.
- **Builds on:** `CaptionWord` timings; `src/shared/editor/smartSpeed.ts`, which turns time ranges into cuts with a time-saved preview; NW-04's review screen; NW-09's timings.
- **Risks:** cuts can clip syllables, so they need padding and audio fades (see NW-06). Retake detection can remove repetition the speaker meant, so the review list is required. Filler words differ per language.
- **Seen in:** Descript, Loom AI, Tella, Camtasia/Audiate.

### NW-04 · Edit the video by editing the transcript
**AI · M · planned**

- **What:** select words or sentences in the transcript and press Delete, and that part of the video is cut. Restoring the text brings the video back. The spoken word is highlighted during playback.
- **Works with:** any transcript with word timings. The edit itself makes no AI call.
- **Builds on:** the transcript editor in `CaptionsPanel.tsx` (deleting a caption today removes only the caption, never the video); `clips.ts`; `outputCues` in `src/shared/captions/subtitles.ts`, which already maps words through cuts.
- **Risks:** it is only as good as the word timings. Cuts inside a phrase need padding and fades. Transcript, cuts, speed changes and translations must stay in sync.
- **Seen in:** Descript, Loom, Camtasia/Audiate.

### NW-02 · Teleprompter and speaker notes, with an AI script draft
**Recording · S · next (Wave 5, after NW-08 and NW-03)**

- **What:** a floating notes window only the presenter sees, kept out of the recording. It has font size, scroll speed and hotkey scrolling. A "Draft script" button turns bullet points into a spoken script.
- **Works with:** the script draft uses OpenAI, Gemini or Claude. The teleprompter needs no AI.
- **Builds on:** `setContentProtection(true)`, already used in `toolbarWindow.ts` and `cameraBubbleWindow.ts`; `hotkeys.ts`.
- **Risks:** hiding a window from capture needs Windows 10 2004 or later; older builds show a black box. The window must not take focus from the app being recorded. Scrolling that follows the voice is not part of v1.
- **Seen in:** Screen Studio, Loom, FocuSee, Riverside, Descript.

### NW-03 · Better auto zoom input: ignore stray clicks, straighten cursor paths, follow scrolling
**Editing · M · in progress (Wave 5)**

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
**Editing · M · planned (audio fades: S)**

- **What:** each cut can get a short crossfade, zoom punch-in, slide or dip to colour, and "Smooth all cuts" applies one style to every cut. Ship first: always-on 5–15 ms audio fades at every cut. Today `audioPlan.ts` joins clips with a plain concat, so silence removal can leave clicks.
- **Builds on:** `Clip` (`{id, start, end, speed}`, no transition field); the compositor's existing blends for zoom and layout transitions.
- **Risks:** a blend needs two decoded frames at once in preview and export. Overlapping transitions change the total length, so caption and chapter times must account for it.
- **Seen in:** Descript, Camtasia, Cap, Tella.

### NW-07 · Import an existing video
**Editing · M · planned**

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
**AI · M · in progress (Wave 5)**

- **What:** one click builds the camera track: full-screen camera for the intro and outro, a small bubble during the demo. The bubble moves away from the cursor, hides during long silences, and the crop keeps the face centred.
- **Works with:** runs on the PC, using voice activity, cursor and typing data, and a face detector. The face detector needs MediaPipe's `blaze_face_short_range` (about 0.2 MB); only the selfie segmenter is bundled today. OpenAI, Gemini or Claude can optionally label the intro, demo and outro from the transcript.
- **Builds on:** `LayoutSegment` (it needs an `auto` flag, as zoom segments have); `src/shared/audio/activity.ts`; the bundled MediaPipe worker.
- **Risks:** too many switches feel busy, so segments need minimum lengths. Preview and export must agree.
- **Seen in:** Tella Auto Layouts, Riverside, Descript, Screen Studio.

### NW-10 · Studio voice with live preview
**AI · M · planned**

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
**Editing · M · planned**

- **What:** a timed overlay track for images, GIFs and emoji that can be moved, resized, rotated, faded and trimmed. Captions, titles and annotations can use the user's own font.
- **Builds on:** `ASSET_SPECS` in `src/main/assetIpc.ts`, which makes a new asset kind cheap; `ShapeKind`; the fixed `CAPTION_FONT`, `TITLE_FONT` and `ANNOTATION_FONT`.
- **Risks:** animated GIFs must decode frame-accurately in export. Fonts must load under the content security policy and be copied into the project, so it renders the same on another PC.
- **Seen in:** Cap, Tella, ScreenPal, Camtasia.

### NW-05 · Vertical video that follows the action, with a safe-zone preview
**Editing · M · planned**

- **What:** for 9:16 and 1:1, the view crops in and follows the cursor, clicks and typing instead of shrinking the whole desktop. The camera moves to a band at the top or bottom. A toggle shows where TikTok, Reels and Shorts buttons cover the video.
- **Works with:** runs on the PC from recorded cursor data. Gemini or Claude vision could be added later.
- **Builds on:** `focusPath` in `src/shared/engine/cursor.ts`; `layout.ts`, which fits rather than fills today; the reels, tiktok and shorts presets.
- **Risks:** fast cursor moves make the pan jumpy, so it needs strong smoothing. Imported videos have no cursor data. The platforms move their buttons.
- **Seen in:** Opus Clip, CapCut, Descript, Screen Studio.

### NW-15 · Auto-update and a refreshable model list
**Quality · S · planned**

- **What:** checks for new versions, downloads them in the background and installs on restart. The list of recommended AI models can be refreshed without a full release.
- **Builds on:** `electron-builder.config.cjs` (`publish: null` today) and the code-signing setup; electron-updater.
- **Risks:** needs a release feed (GitHub Releases or a static host) and signed builds. A bad update must be easy to roll back. A remote model list must come from a trusted, integrity-checked location.

### X-02 · Caption emphasis
**AI · S · planned**

- **What:** picks the key words in each caption to colour, enlarge or pair with an emoji in the bold and karaoke styles, the social-caption look.
- **Works with:** OpenAI, Gemini or Claude.
- **Builds on:** the caption presets and the strict-schema text-task pipeline.

### X-03 · Diagnostics bundle
**Quality · S · planned**

- **What:** "Copy diagnostics" in Settings collects:
  - the Windows build;
  - the GPU and the detected encoders;
  - the native helper's probe result;
  - the capture method used;
  - recent main-process log lines.

  It never includes keys, or file paths outside the app's own folders.
- **Why:** the app has no log file or crash reporting yet, and several Windows paths have not been run on a real PC.

### X-04 · Duplicate project and single-file project
**Editing · S · planned**

- **What:** "Duplicate" makes a vertical or short cut without touching the original; LT-02 and NW-05 need it. "Save as one .flown file" moves a project to another PC or a teammate.

---

## Easier editing

Added 25 October 2026. These make everyday editing faster. Each was checked against the code at
commit `f17cd98`, and the editor does not have it yet. E-01, E-04, E-05, E-08, E-10 and E-11 are
`next`: they follow the camera director, smarter auto zoom and the teleprompter. The rest are `planned`.

| Id | Feature | What it does | Size |
|---|---|---|---|
| E-01 (next) | **Polish in one click** | Runs remove silences, auto zoom, the camera director (NW-08), captions (if a provider is set) and your style preset in one go. Shows a summary of what changed (time saved, zooms, cuts, camera changes), all in one undo step. | S–M |
| E-02 | **Review mode** | Steps through every automatic decision (each zoom, cut, camera change, removed filler) with Keep / Remove, like reviewing tracked changes. | M |
| E-03 | **Brand kit** | Your logo, colours, fonts, intro and outro title cards and style, saved once; every new recording starts with them. | S–M |
| E-04 (next) | **Audio waveform on the timeline** | Shows where you talk and where the pauses are, so cuts land in the right place. | S |
| E-05 (next) | **Snapping** | Segment edges and the playhead snap to cuts, clicks, chapter flags and other segments while dragging (hold Alt to turn it off). | S |
| E-06 | **Select several items** | Shift-click or drag a box to select zooms, text and shapes together, then move, delete, copy or paste them; paste one item's look onto another. | M |
| E-07 | **Filmstrip on the clip track** | Small frames along the clip track, to find a moment by sight. | S–M |
| E-08 (next) | **J / K / L playback and preview speed** | Reverse, pause and forward from the keyboard (tap again to go faster), and play the preview at 1.5× or 2× to review long recordings quickly. | S |
| E-09 | **Nudge by one frame** | Arrow keys move the selected item one frame, Shift + arrow ten frames. | S |
| E-10 (next) | **Crop the recording in the editor** | Hide the taskbar, browser tabs or a screen edge after recording. Today the area can only be chosen before recording. | S–M |
| E-11 (next) | **Freeze frame** | Hold a frame for a few seconds so viewers can read something, with the sound paused or continuing. | S |
| E-12 | **Versions** | Save named versions of an edit ("Before captions", "v1 for client") and go back to any of them. | S–M |
| E-13 | **Re-record one part** | Record only the part that went wrong and drop it in place. Builds on multiple takes (LT-01). | L |

---

## Later

### AI

| Id | Feature | What it does | Works with | Size |
|---|---|---|---|---|
| LT-20 | **Offline transcription on the PC** | Captions with word timings from a Whisper model on the user's PC: no key, no cost, no upload. The reviewer suggests pulling it into the next wave with NW-09. | whisper.cpp or ONNX | L |
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
| X-05 | **The app in other languages** | Extract the UI text and ship Bengali, Spanish and others, with AI-drafted translations reviewed by people. | M |

---

## Big bets

| Id | Feature | What it does | Why it is a big bet | Size |
|---|---|---|---|---|
| BB-01 | **Share links** | Upload with a player page (chapters, captions, call to action) and copy a link. Phase 1 uses the user's own storage (S3, R2, Drive, Dropbox). Phase 2 is a hosted Qbexel service with comments, views and teams. | Phase 2 needs servers, storage costs, moderation, accounts and a privacy policy, which breaks today's no-backend design. | L |
| BB-02 | **Record an Android phone over USB** | Phone screen over USB, taps feed auto zoom, inside a phone frame. | Needs adb and USB debugging, which confuse non-developers. There is no supported way to capture an iPhone on Windows. | L |
| BB-03 | **Fix a misspoken word by typing** | Type the correction and the phrase is regenerated in the presenter's own voice. | Needs a recorded consent step and misuse rules, and the new phrase must match the room tone. Gemini TTS, OpenAI custom voices or ElevenLabs; not Claude. Check the current provider docs before building. | L |
