# Captions that survive the OpenAI shutdown, with speaker labels (NW-09)

Status: design for the release after 0.7.1, on `feat-transcription` from `ccr-b6df7cf7-yked87`
(commit 546e479).

On **26 February 2027** OpenAI removes `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`
and `gpt-4o-transcribe-diarize` (ROADMAP.md, "Deadlines to plan around"). `whisper-1` is Flown's
suggested OpenAI transcription model and the only OpenAI model whose answer has word times.
Captions, karaoke highlighting, the Transcript tab (edit by text), filler and retake removal and
the subtitle files all read word times. This feature:

1. handles its replacement, `gpt-transcribe`, which returns **text only**: every word gets a time
   anyway, estimated from where the recording has sound, and the UI says plainly which words are
   estimated (§3). `whisper-1` stays the suggested model until near its retirement day, when the
   list of suggested models moves to `gpt-transcribe` (§2.1);
2. checks Gemini's word times and replaces impossible ones with estimates (§4);
3. replaces the raw API error of a retired model with a plain sentence saying what to do (§5);
4. adds **speaker labels**: "You" and "Others" from the microphone and computer-sound tracks with
   no AI, "Speaker 1", "Speaker 2"... from Gemini; renamed everywhere at once; in the Captions and
   Transcript tabs, the subtitle files and, as an option, the burned-in captions (§6–§8).

Captions on this PC (F-01, `src/main/speech/*`) are not touched: they keep exact word times, and
the UI points there whenever a provider cannot give them (§3.5).

## 1. What is true now (read 30 October 2026)

### 1.1 OpenAI

Sources: the deprecations page (https://developers.openai.com/api/docs/deprecations), the
speech-to-text guide (https://developers.openai.com/api/docs/guides/speech-to-text), the API
reference for `POST /v1/audio/transcriptions`
(https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create),
the `gpt-transcribe` model page (https://developers.openai.com/api/docs/models/gpt-transcribe) and
the types of the installed `openai` SDK 7.32.0 (`resources/audio/transcriptions.d.ts`).

- **Deprecations, entry "2026-08-26: Transcription models"**: `whisper-1`, `gpt-4o-transcribe`,
  `gpt-4o-mini-transcribe` (with `-2025-12-15`) and `gpt-4o-transcribe-diarize`, announced 26
  August 2026, shut down **26 February 2027**, replacement "`gpt-live-transcribe` or
  `gpt-transcribe`". `/v1/audio/translations` goes the same day. (`gpt-4o-mini-transcribe-2025-03-20`
  already goes on 20 January 2027.)
- **`gpt-transcribe`**: "the recommended model for transcribing recorded speech in its original
  language". `/v1/audio/transcriptions` and realtime transcription sessions. **$0.0045 per minute**
  of audio. Files up to **25 MB** (no length limit is stated). Takes `languages` (an array of
  ISO-639-1 codes: hints) instead of the singular `language`, and `keywords` (words to guide it).
  Its answer, the `Transcription` object, is `{ text, languages: [{ code }], usage }`: **no segments,
  no words, no times**. "The `timestamp_granularities[]` parameter is only supported for
  `whisper-1`."
- **`gpt-live-transcribe`**: for live audio over the Realtime API. Not a fit for a finished
  recording, and no word times either.
- **`whisper-1`** (until shutdown): `verbose_json` with `timestamp_granularities` `segment` and
  `word`; 25 MB; 98 languages ("accuracy varies by language"); $0.006 per minute.
- **Speaker labels**: only `gpt-4o-transcribe-diarize` (`diarized_json`, `known_speaker_names`),
  which is retired the same day. After February OpenAI has no speaker labels for files.

**So no OpenAI transcription model keeps word times after the shutdown.**

### 1.2 Gemini

Source: https://ai.google.dev/gemini-api/docs/audio (and the files and structured-output pages
already cited in `src/main/ai/gemini.ts`).

- Audio up to **9.5 hours** per prompt; **32 tokens per second** of audio; requests up to
  **20 MB** inline, larger through the Files API; WAV, MP3, AIFF, AAC, OGG, FLAC and more.
- Timestamps: the page documents `MM:SS` references to parts of the audio. It does not document
  word-level timestamps or their accuracy: per-word times are whatever the model writes into the
  JSON schema Flown gives it, so they are checked (§4).
- **Speaker diarization** is listed as a use case; the page's own transcription example asks to
  "Identify distinct speakers (e.g., Speaker 1, Speaker 2)" with a required `speaker` field per
  segment in the response schema.

### 1.3 The table

| | Text | Segment times | Word times | Speakers | Limits | Price |
|---|---|---|---|---|---|---|
| OpenAI `whisper-1` (until 26 Feb 2027) | yes | yes | yes | no | 25 MB, 98 languages | $0.006/min |
| OpenAI `gpt-transcribe` | yes | **no** | **no** | no | 25 MB, `languages` hints | $0.0045/min |
| OpenAI `gpt-4o-transcribe-diarize` (until 26 Feb 2027) | yes | yes | no | yes | 25 MB | — (retiring) |
| Gemini (`gemini-3.8-flash`) | yes | asked for (JSON) | asked for (JSON, unchecked by Google) | asked for | 9.5 h, 20 MB inline | per token (32/s of audio) |
| On this PC (F-01) | yes | yes | yes (DTW) | no | none | free |

## 2. Decisions

### 2.1 OpenAI: handle `gpt-transcribe`, keep suggesting `whisper-1` until near the day

`resources/ai-models.json` and `BUNDLED_MODEL_LIST` keep suggesting `whisper-1` (with its retiring
entry): until 26 February 2027 it still works and gives exact word times, where `gpt-transcribe`
gives estimated ones. Anyone who wants `gpt-transcribe` sooner types it as the transcription model
in Settings › AI providers, and this release handles it.

The retiring list also names the other OpenAI transcription models, which this release makes
usable (they take the text-only path below): `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`,
`gpt-4o-mini-transcribe-2025-12-15` and `gpt-4o-transcribe-diarize` on 26 February 2027, and
`gpt-4o-mini-transcribe-2025-03-20` on 20 January 2027 (§1.1). A provider using one gets the
Settings note before the day and the plain message of §5 after it.

**The switch goes through the list, near the day.** `resources/ai-models.json` on the default
branch is the list every installed Flown downloads (the newest `updated` wins), 0.7.1 included,
which has no text-only path: its `openai.ts` asks for `timestamp_granularities` and its parser
rejects an answer without timings, so a `gpt-transcribe` suggestion would break its captions.
So:

1. Before 0.7.1 ships, the list format gains a minimum app version per suggestion (the lead is
   adding it): a Flown older than that minimum does not take the suggestion.
2. A few weeks before 26 February 2027, the list on the default branch suggests `gpt-transcribe`
   for OpenAI transcription, with the first version that has this text-only path as its minimum
   and a newer `updated`. `BUNDLED_MODEL_LIST` follows in the release of that time (a test keeps it
   equal to the file).
3. A provider saved with the suggested transcription model (the form fills it in) stores none
   (`keyStore.ts`), so it uses the list's suggestion (`transcribe.ts`:
   `info.transcriptionModel ?? modelDefaults(kind)`; the provider rows show it too) and moves with
   the list. A model the user chose instead is stored and kept, and so is the `whisper-1` that an
   earlier Flown stored for every OpenAI provider: such a provider sees the Settings note until
   the shutdown, then gets the plain message of §5, which names the list's suggestion.
   Main may download a newer list while a form is open, so the form asks main for the list each
   time it opens and sends the transcription model only once the user types in the field: left
   alone, main fills in its own newest suggestion for a new provider, and an edit of the same
   kind keeps what the provider had (`ProviderForm.tsx`, `useModelList.ts`, `keyStore.ts`).

A Flown that never downloads the newer list still suggests `whisper-1`; after the day its message
says to choose another transcription model or make captions On this PC (§5).

The OpenAI client now has two ways:

- `whisper-1` (any model whose name starts with `whisper`): exactly as before, `verbose_json`
  with segment and word times.
- **Any other model** (`gpt-transcribe` and what comes after it): `response_format: "json"`,
  `languages: [code]` when the user chose a spoken language (`language: code` for the `gpt-4o`
  transcription models, retired on the same day, which take only that). The text comes back
  without times and Flown times it (§3).

Alternatives considered:

1. **Suggest `gpt-transcribe` now.** Cheaper, recommended by OpenAI, and the timing path would be
   used long before the deadline. Rejected: word times would be estimates for four months while
   exact ones are still there, and the list on GitHub is read by every installed Flown, so 0.7.1
   would suggest a model it cannot use (§2.1).
2. **Align the provider's text to the audio with the speech model on this PC** (run whisper.cpp
   over the same parts and copy its word times onto matching words). Exact times where words
   match, but it needs a downloaded model (44–574 MB), runs a full local transcription anyway
   (minutes per hour of sound on a CPU) and the Bangla model has no word times. A user who has the
   model can simply make the captions On this PC, which the UI offers (§3.5). Left for later
   (§13), with the pure word matcher it would need (`lcsPairs`) already in the code.
3. **Even spread over each part** (what the Transcript tab already does for a caption without
   word times). Rejected on its own: a 30 s part with pauses would put words into the pauses.
4. **Ask a text model to time the words.** It cannot hear the sound. Rejected.

Chosen: **short parts, words spread over the stretches that have sound** (§3), every such word
marked `estimated` (the flag the Transcript tab already reads, `CaptionWord.estimated`), and the
UI saying so (§3.5). Never captions without times.

### 2.2 Gemini: keep asking for word times, check them

Gemini already asks for per-word times. They are kept when they are plausible and replaced by
the same estimate (spread over the caption) when they are not (§4). Gemini is also asked for a
`speaker` per segment (§6.2).

### 2.3 Speakers are names on captions

`CaptionSegment.speaker?: string`, the name as shown ("You", "Speaker 2", "Priya"). No separate
table of speakers: renaming changes the name on every caption that has it, in one undo step; two
names made the same become one speaker. Alternatives: speaker ids plus a name table on the
transcript (a rename touches one place, but every reader — subtitles, drawing, the two tabs, the
AI text tasks that copy captions — needs the table, and a dangling id is a new failure mode).
With at most 5000 captions a rename is a cheap map.

## 3. Word times for text-only answers

### 3.1 Parts of 30 seconds, cut in pauses

A client that returns text only reports `timing: 'text'` with `partLimits.maxSeconds = 30`
(`openai.ts`). The existing planner (`transcriptPlan.planParts`) cuts at the middle of the
longest quiet stretch (at least 0.3 s) in the last 35 % of each 30 s window, else at a fixed point
with a 2 s overlap. A part's text is therefore known to lie within at most 30 s. 30 s is where
OpenAI itself starts to recommend chunking (`chunking_strategy` "for audio longer than 30
seconds"); a shorter part would cut more sentences in two and cost more requests (a request per
30 s: 120 for an hour; OpenAI's lowest tier allows 5000 a minute). Price is per minute, so it
does not change.

### 3.2 Where the sound is

The whole decoded sound is measured once, as for splitting today (`LevelMeter` 50 ms windows,
`detectActivity`: the ducking detector's threshold just above the noise floor). For a text-only
client this always runs (today it runs only for recordings longer than one part). Each part takes
the active ranges inside it; when they add up to less than 0.2 s (a quiet voice under a loud noise
floor), the whole part counts as active.

### 3.3 Spreading the words (`timeTextPart`, `src/shared/captions/transcriptTiming.ts`)

- The text is split on whitespace into words. A run in a script written without spaces
  (Chinese, Japanese, Thai, Lao, Khmer, Burmese) is cut further into words by `Intl.Segmenter`;
  punctuation stays with the word before it (an opening bracket or quote with the word after it),
  and a caption joins those words without spaces, so the caption rules below apply to them too.
- Each word weighs its number of characters (graphemes) plus one (the space). The active ranges
  are laid end to end as "speaking time"; word *k* gets the share of it its weight gives, and
  that position is mapped back to the recording. A word never starts in a pause; a word that
  straddles a pause is moved to start after it (its share stays on the earlier side) so no word
  spans a gap longer than 0.25 s.
- Captions are made from the words: a new caption starts after a word ending a sentence
  (`.`, `!`, `?`, `…`, `。`, `！`, `？`) once the caption has 3 words; after 12 words; before a word
  that starts after a pause of 0.7 s or more; or when the caption would pass 6 s. A caption runs
  from its first word's start to its last word's end.
- Every word is `estimated: true`, and `fromSound: true` when the sound placed it: the part has
  sound, and at least 0.25 s of it is quiet. With (almost) no sound, or sound all through the part
  (steady music or noise under the voice, where nothing says where the voice pauses), the words
  are an even spread over the whole part, a plain guess.

`fromSound` decides how a cut treats the word (edit-by-text.md §4.2): like a heard word, by its
middle, so a timeline cut, trim or Smart speed cut takes the words said there out of the
Transcript tab and the subtitle files. A plain guess is cut only when its whole caption is (or its
heard neighbours and everything between them are), which would leave every word of a text-only
caption in the subtitle files after a partial cut. The dotted underline and the notices still
read `estimated`. Loaded back only as `true`, and only with `estimated` (`captionData.ts`).

Expected error: within a phrase between pauses, words are placed by length, so a word is typically
off by a fraction of a syllable-weighted share — tenths of a second, rarely more than half a
second; at pauses the estimate is exact to the 50 ms window (the speech starts there). The e2e
test checks, with the mock's tone bursts, that every word starts within 0.6 s of its burst.

### 3.4 Merging

`RawWord` gains `estimated?: true` and `fromSound?: true`; `RawSegment` gains `speaker?: string`.
The merge (`transcriptMerge.ts`) carries them through unchanged (additive spreads), so
`CaptionWord.estimated` and `CaptionWord.fromSound` reach the project.

Where no pause is found near the end of a 30 s window (steady music or noise under the voice),
parts are cut at a fixed point with a 2 s overlap. The two parts' estimates of the same word there
can be seconds apart, so pairing them by time (within 0.5 s, as for providers that time words
themselves) would lose or repeat words at nearly every cut. When both parts answered text only
(every word estimated), the merge matches the overlap by text instead (`overlapByText`,
`startAfterText` in `transcriptMerge.ts`): the earlier part keeps every word it heard; the later
part drops the run of its first words that repeats the earlier part's last words with the most
words shared (by `wordKey`, at most 8 words a second of overlap, so text that repeats itself
cannot swallow a part). The run may leave out one word cut in two at either edge (its text differs
from the whole word the other part heard; that edge word is dropped too) and differ by one word
inside it (the two parts wrote it differently, "OK" and "okay", or only one said it, "um"; the
earlier part's words are kept), when at least two words are shared; its last word is the earlier
part's last whole word. The later part's first kept words, when timed before the earlier part's
last kept word, are moved after it, and the words after them squeezed a little, over twice that
distance, so captions follow one another and no word is lost. Where the parts differ by more (two
words written differently, or a word cut in two where fewer than two whole words are shared, as
with a pause in the overlap) the overlap may still show twice.

A caption split at a fixed cut keeps the spaces its text had between the words it keeps (none
inside Chinese or Japanese, one around a Latin name in them); when a word is not found in the
text, its words are joined with spaces unless the text has none.

Stretches of sound shorter than 0.12 s are left out of the spread (a sliver at a part's edge would
squeeze a word to nothing and the caption would be dropped as too short).

### 3.5 Saying so in the UI

- **Captions tab, Generate form**, with an OpenAI provider whose model gives text only:
  *"OpenAI's gpt-transcribe gives text without timings. Flown estimates when each word is spoken
  from the sound. For exact word times, make captions On this PC."* + a link **Use On this PC**
  when the engine is available (it selects On this PC, like the existing error offer).
- **Captions tab, summary** after such a run (over half of the words estimated):
  *"Word times are estimated: karaoke and cuts by word may be a little early or late. Captions On
  this PC have exact word times."*
- **Transcript tab**: an estimated word gets a dotted underline and `title="Estimated time"`;
  the existing hint *"Some word times are estimated: cuts there may be less exact."* stays, with a
  second line when every word is estimated: *"Words with a dotted line have estimated times."*

## 4. Gemini word times (`checkWordTimes`, `transcriptParse.ts`)

A segment's words are kept as Gemini timed them when all of these hold, else they are re-spread
over the segment by length and marked `estimated`:

- starts never go back by more than 0.05 s from one word to the next, in the order Gemini sent
  them (kept words are sorted by start only after this check);
- at most a quarter of the words have no length (end − start < 0.01 s);
- in a segment longer than 1 s, the words reach over at least 30 % of it;
- there are as many timed words as words in the text, or at least half as many (Gemini sometimes
  merges punctuation; the drawing and the Transcript tab already match words by count and by text).

A segment Gemini gave no words is left without words (the drawing spreads its text, the
Transcript tab estimates its words, as today).

## 5. A retired model fails with a plain message

`src/shared/captions/retiredModel.ts`: `retiredMessage(list, kind, model, today, suggestion)`
returns, for a model on the retiring list whose day has come,

- transcription: *"OpenAI retired whisper-1 on 26 February 2027. Choose gpt-transcribe as the
  transcription model in Settings › AI providers, or make captions On this PC."* The model named is
  the list's suggestion (`gpt-transcribe` once the list has moved, §2.1); while the list still
  suggests a retired model (the one that failed, or `whisper-1` for a `gpt-4o` model retired the
  same day), *"Choose another transcription model in Settings › AI providers, or make captions On
  this PC."*
- text tasks: *"OpenAI retired gpt-x on 1 March 2027. Choose another model in Settings › AI
  providers."*

Both clients (`openai.ts`, `gemini.ts`) wrap failed requests: a non-retryable failure that is
not cancelled, network, timeout, rate limit, quota or a bad key (401) — that is, 400, 403, 404
and the rest (a 403 keeps its status on the failure, so it is told apart from a bad key) —
becomes an `AiError` of kind `not-found` with that message when the model is on the list and
retired. The date is the PC's (UTC). Before the day the request is sent as usual (the
provider may keep a model longer). The Settings note (`retiringNotes`) is unchanged.

## 6. Speaker labels

### 6.1 From the recording's two tracks, with no AI (`stemSpeakers`, `speakers.ts`)

A recording that kept the microphone and the computer sound apart (`Project.audioStems` with
`mic` and `system`) has their levels (`analyzeAudio`, 50 ms windows; the microphone's speech
detector ranges when it ran). For each caption, over its own time:

- a window is *mic* when the microphone is above its activity threshold (or inside a detected
  speech range), *system* when the computer sound is above its threshold; when both, the one
  further above its own threshold wins (a microphone picks up speakers a little, at a lower level);
- a caption with at least 3 *mic* or *system* windows (0.15 s) is "You" when *mic* windows are at
  least as many as *system* ones, else "Others"; one without is left unlabelled.

It runs in the renderer on demand: **Captions tab › Speakers › Label You and Others**, one undo
step, notice *"Labelled 34 captions: 20 You, 14 Others."* To caption both sides of a call the
transcription must hear both: the Speakers section says *"For calls, transcribe the Mixed sound
so the other people's words are captioned too."* when the transcript was made from the
microphone only and labels were asked for.

### 6.2 From Gemini

The transcription schema gets `speaker` per segment (*"Who speaks: 'Speaker 1' for the first
voice heard, 'Speaker 2' for the next, and so on, the same label for the same voice"*). Read:
labels matching `Speaker N` (N 1–20) are kept, others become `Speaker N` by order of first
appearance in the part. After merging, labels are dropped when fewer than two speakers are left.
Risk: parts are 5 minutes, and Gemini numbers voices per part, so "Speaker 1" in one part may be
"Speaker 2" in the next. The user fixes that per caption or by renaming; §13.

### 6.3 Names

`cleanSpeakerName`: one line, single spaces, trimmed, at most 32 characters; empty means no
label. Old projects have no `speaker` and load byte for byte unchanged; an invalid stored value
(not a string, empty after cleaning) is dropped on load.

## 7. UI

### 7.1 Captions tab

- A **Speakers** section (new component `SpeakersSection.tsx`), after Transcript, shown when the
  transcript has labels or the recording has both tracks:
  - one row per speaker: a text field with the name (`aria-label="Name of Speaker 1"`), and the
    count *"12 captions"*. The new name is applied on Enter or when the field is left (not per
    key, so a name typed through another speaker's name never merges them); Escape puts the old
    name back. Empty removes the label.
  - **Label You and Others** (only with both tracks): replaces any labels (it asks first when
    there are some: *"Replace the speaker labels with You and Others from the sound tracks?"*).
  - **Remove labels**.
  - Hint without labels and without both tracks: *"Speaker labels come from Gemini, or from
    recordings that kept the microphone and the computer sound apart."*
- Each caption row with labels in the transcript gets a small select (`aria-label="Speaker of the
  caption at 0:12"`): *No speaker*, each name, and *New speaker* (the next free "Speaker N").
- **Look**: a toggle **Show speaker names** (*"Put the speaker's name before each caption on the
  video"*), off by default, shown when there are labels.
- **Export captions**: a toggle **Speaker names in SRT and text** (*"Start each caption with the
  speaker's name, like "Priya: Hello". WebVTT files always name the speaker."*), shown when there
  are labels; remembered for the session like the format.

### 7.2 Transcript tab

A paragraph whose speaker differs from the paragraph before starts with the name in bold, and so
does the first paragraph of every page (a page can start inside someone's turn)
(`.transcript-speaker`, not selectable as a word, `aria-hidden` with the name in the paragraph's
`aria-label`).

## 8. Files out

- **WebVTT**: a cue with a speaker is `<v Name>text` (the name escaped like the text: `&`, `<`,
  `>`), always — players that do not show voices ignore the tag.
- **SRT** and **text**: `Name: text` when the option is on; unchanged when off (the default).
- **Burned-in**: with *Show speaker names*, the caption is drawn as `Name: text`; each word of the
  name is a `label` token (`CaptionToken.label`, `layout.ts`) that karaoke never lights, and the
  caption's own words keep the times the drawing gives them without the name. The name never shows
  alone: a line holding only the name is shown with the next line (so with *One line* that chunk has
  two). The caption's own words set its direction, so an Arabic or Hebrew caption stays right to
  left with a Latin name, which sits at its right end and is drawn left to right, its colon after it
  (`wordDirection`); a name with right-to-left letters is drawn right to left as a whole, its number
  too, so the colon ends it (`متحدث 2:`). Preview and export draw through the same layer (`captionsLayer.ts`), so they match.
- The export pack (*Also save*, `exportBundleRun.ts`, not part of this change) writes WebVTT with
  voice tags; its SRT has no names (the option is the Captions tab's).

## 9. Data model

```ts
// shared/types.ts (additive)
interface CaptionSegment { …; speaker?: string }
interface CaptionWord { …; fromSound?: true }   // with estimated: placed by the sound (§3.3)
interface CaptionSettings { …; showSpeaker?: true }
// shared/captions/transcriptParse.ts
interface RawWord { …; estimated?: true; fromSound?: true }
interface RawSegment { …; speaker?: string }
interface RawTranscript { …; untimed?: true }   // text-only answer: one segment per part
// main/ai/types.ts — AiClient: no change; the client marks its answer untimed
```

Loading: `readCaptionSegments` keeps a valid `speaker`; `readCaptionSettings` keeps
`showSpeaker: true` only. A project without them is written back exactly as read (no new keys).
Settings: none.

## 10. Security

- Names and texts from providers are untrusted: cleaned to one line and bounded (32 / 2000
  characters; a text-only answer to 2000 per 30 s of its part) in `transcriptParse.ts`, again on
  load. They are drawn on a canvas and written into subtitle files (VTT-escaped; `-->` replaced as
  for text), never into HTML.
- No new IPC channel; `transcribe` options are validated as before. No new dependency.

## 11. Files and exported signatures

- `src/shared/captions/transcriptTiming.ts` (new):
  `timeTextPart(text: string, active: Range[], partSeconds: number): RawSegment[]`,
  `activeIn(active: Range[], start: number, end: number): Range[]`,
  `spreadWords(texts: string[], start: number, end: number): RawWord[]`,
  `checkWordTimes(seg: RawSegment): RawSegment`,
  `providerTiming(kind, model): 'words' | 'text'`, `isTextOnlyOpenAiModel(model)`, `TIMING_COPY`.
- `src/shared/captions/speakers.ts` (new): `cleanSpeakerName`, `speakersOf(segments)`,
  `renameSpeaker(segments, from, to)`, `setSpeaker(segments, id, name)`, `clearSpeakers`,
  `nextSpeakerName`, `normalizeSpeakers(segments)`, `stemSpeakers(segments, mic, system)`,
  `speakerCaption(seg)`, `SPEAKER_COPY`.
- `src/shared/captions/retiredModel.ts` (new): `retiredMessage(...)`, `todayUtc()`.
- `src/renderer/src/editor/panels/SpeakersSection.tsx` (new): `SpeakersSection`, `CaptionSpeakerSelect`.
- Changed: `openai.ts`, `gemini.ts`, `transcribe.ts`, `transcriptParse.ts`, `transcriptMerge.ts`
  (carry fields), `captionData.ts` and `settings.ts` (load), `editor/transcript.ts` (`fromSound`
  words are cut like heard ones), `edit.ts` (split and merge keep the speaker), `subtitles.ts`
  (voice tags, option), `captionsLayer.ts` (name token), the two panels (additive), `types.ts`,
  `keyStore.ts` (the suggested transcription model is not stored, §2.1; an edit without the field
  keeps the provider's), `ProviderForm.tsx` and `useModelList.ts` (the field is sent only once
  typed in; the list is asked for each time the form opens). `ai-models.json` and
  `BUNDLED_MODEL_LIST` are unchanged (§2.1).

## 12. Test plan

Unit (vitest): `timeTextPart` (no word in a pause, captions split by the rules, all estimated,
`fromSound` only where the sound placed them, an even spread when the part is quiet); a timeline
cut over a text-only caption takes the words whose middles it cuts out of the Transcript tab and
the SRT, a word retyped there stays a plain guess; `parseOpenAiText`; the OpenAI request shape for
`gpt-transcribe` vs `whisper-1`; `checkWordTimes` each rule; Gemini speakers (normalised, dropped
when one); merge carries `estimated` and `speaker`; `retiredMessage` before/on/after the day and the
client wrapping; `stemSpeakers` (mic only, system only, both with bleed, too short); rename/merge
names/clear; load of old and new projects (byte-equal for old); split and merge keep speakers;
VTT voice tags and escaping, SRT/text prefix on and off; `speakerCaption`; the model list
(`whisper-1` still suggested and on the retiring list with the `gpt-4o` transcription models, JSON
equals the bundled list); a provider saved with the suggested transcription model moves with the
list, one with a chosen model and one saved by an earlier Flown keep theirs, an edit without the
field keeps the provider's; the provider form (`tests/providerForm.test.ts`) suggests the list main
has when it opens, and a provider added or edited while main moves the list follows it unless the
user typed a model.

E2E (`tests/e2e/transcription.e2e.cjs`, the AI mock server, no real API): an OpenAI provider with
`gpt-transcribe` transcribes the tone fixture with `response_format=json` and no timestamp
fields; words are estimated and start within 0.6 s of their bursts; the Captions tab shows the
estimate notice; the Transcript tab marks words; a Gemini run returns two speakers, shown in the
caption rows and the Transcript tab; renaming one renames every caption and Undo brings it back;
the VTT export has `<v …>`; Show speaker names changes the drawn frame; a recording with both
tracks gets You/Others; a retired-model 404 shows the plain message naming the suggestion of a
downloaded list that has moved to `gpt-transcribe`. `tests/e2e/ai.e2e.cjs`: a new OpenAI provider
still gets `whisper-1`.

## 13. Left for later

- Aligning a provider's text to word times from the speech model on this PC (§2.1 alternative 2).
- *Speaker names in SRT and text* for the export pack's files.
- Keeping Gemini's speaker numbers consistent across 5-minute parts (send the previous part's
  last seconds, or match voices).
- Speaker labels for captions made On this PC beyond You/Others (needs a diarization model).
- Colour per speaker in burned-in captions.
- Groq or another OpenAI-compatible Whisper host (NW-14) for exact word times with a key.
