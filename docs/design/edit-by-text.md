# Edit by text (NW-04), fillers and retakes (NW-01), smooth cuts (NW-06)

Status: design, branch `feat-edit-by-text`, from `ccr-b6df7cf7-yked87` (Flown 0.6.0, commit aeca5c5).
Roadmap: `docs/ROADMAP.md` NW-04 "Edit the video by editing the transcript", NW-01 "Remove filler
words and retakes", NW-06 "Smooth cuts" (the audio fades it says to ship first).

What ships:

- **A Transcript tab** in the editor's Inspector. It shows what was said, word by word, from the
  project's captions (`Project.transcript`, with the word timings the speech models on this PC or an
  AI provider already returned). Select words and press **Delete**: that part of the video is cut.
  Cut words stay in the text, struck through, and **Restore** brings them back. While the video
  plays, the spoken word is highlighted; clicking a word moves the playhead there. Every edit is one
  undo step. With no transcript yet the tab offers **Make captions**, which runs the Captions tab's
  own "Generate captions".
- **Find fillers and retakes.** One button lists "um", "uh", "er", "you know", "like" (and a short
  list per language, Bangla included) and retakes (a sentence said again: the last take is kept)
  as suggestions. Each has **Keep** and **Remove**, and **Remove all** removes the rest. Nothing is
  cut until you choose. Cuts are padded into the pauses around the words, so syllables are not
  clipped.
- **Smooth cuts.** Every cut gets a 10 ms audio fade out before it and a 10 ms fade in after it, in
  the export and in the preview, so a cut never clicks. Video cross-dissolves are left for later
  (§12).

The rules of the earlier waves still hold:

- Every visual is a function of source time; cuts are ordinary `Project.clips` (the model the
  timeline, Smart speed and Remove silences use), so the timeline, the preview, captions, chapters
  and the export follow without new code.
- Every user action is one undo step.
- Projects made before this feature open unchanged: this feature adds **nothing** to
  `project.json` and nothing to the settings. Their exports gain the 10 ms fades at cuts (§4.8),
  which is the point of NW-06.

---

## 1. What the user gets

| Gesture or key (in the transcript) | Result |
|---|---|
| Click a word | Selects it and moves the playhead to it. |
| Drag across words | Selects them. |
| Shift+click a word | Extends the selection from the last word clicked. |
| `←` / `→` | Moves to the previous / next word (selects it alone). |
| `Shift+←` / `Shift+→` | Extends the selection by one word. |
| `↑` / `↓` | Moves to the first word of the previous / next caption. |
| `Home` / `End` | First / last word (`Shift` extends). |
| `Enter` | Moves the playhead to the selected word. |
| `Delete` / `Backspace` | Cuts the selected words from the video. |
| `Ctrl+A` | Selects every word. |
| `Esc` | Clears the selection (a second Esc goes to the editor, as everywhere). |
| `Space`, `Ctrl+Z`, `Ctrl+Shift+Z` | The editor's own: play/pause, undo, redo. |

Buttons above the text: **Cut** (`Delete`), **Restore**, **Find fillers and retakes**.

---

## 2. Decisions

### 2.1 Where the transcript view lives

- **Chosen: a new Inspector tab, "Transcript", after "Captions".** The panel is a new file
  (`TranscriptPanel.tsx`); Inspector.tsx gets one tab entry, one type member and one render line.
- Rejected: inside the Captions tab. The Captions tab is already 1,230 lines with its own
  transcript editor whose rows are caption text fields (deleting a caption there removes the
  caption, not the video, `CaptionsPanel.tsx` `remove`). Mixing word selection into it would make
  Delete mean two different things in one tab, and it is another team's file.
- Rejected: a separate full-window "script" mode (Descript style). It would duplicate the preview
  and transport; a side panel next to the preview keeps the player and timeline in view, which is
  what makes "the cut shows on the timeline at once" visible.

### 2.2 How a word edit becomes a cut

- **Chosen: words map to source time ranges, and the range is cut with `cutRange`
  (`src/shared/engine/timeline.ts`)** and restored with `restoreRange`
  (`src/shared/editor/clips.ts`): the same functions the timeline's range cut and gap restore use.
  The transcript is never changed by a cut, so a cut word is still there to restore, and captions
  already follow cuts (`outputCues` in `src/shared/captions/subtitles.ts`).
- Rejected: storing "deleted word ids" in the project and deriving clips from them. Two sources of
  truth for one cut (the clip list and the word list) drift as soon as the user trims on the
  timeline or runs Remove silences; and old projects would need a migration.
- Word state is **derived**: a word is cut when its middle is not inside any clip. So a cut made on
  the timeline, by Smart speed or by Remove silences shows struck through in the transcript too.

### 2.3 Padding: where a cut starts and ends

Word timings are about ±50 ms (offline-captions §2: median word-start error 45 ms). Cutting
exactly at a word's edges would clip the next word's first sound. **Chosen: each end of a cut goes
into the pause next to it, to the middle of the pause, but at most `MAX_REACH` = 0.5 s past the cut
word** (§4.3). A kept neighbour keeps at least half of the pause before it. Rejected: a fixed
padding (e.g. 80 ms) inward from the neighbour: on run-together words the fixed pad is larger than
the pause and eats the neighbour; on long pauses it removes most of the pause, so the speech runs
together unnaturally. The middle of the pause degrades well in both cases.

### 2.4 Finding fillers and retakes

- **Chosen: on this PC, from the words already in the transcript, with no AI call and no
  download.** Fillers are a per-language word list with a context rule for words that are only
  sometimes fillers ("like", "you know"). Retakes are found by comparing each sentence with the
  next one or two (longest common word sequence, §4.6), and short stutters ("the the", "I think I
  think") by repeated word runs.
- Rejected for now: a text task with an AI provider (ROADMAP NW-01) or sentence embeddings
  (ROADMAP F-05, a 23–118 MB model via transformers.js, a new dependency). Both are better at
  meaning-level retakes ("let me say that again"), but the word-overlap rule finds the common case
  (the same sentence started again) instantly, privately and with no cost. The review list makes
  a false positive harmless. Embeddings stay F-05 (§12).
- **A review list, never automatic.** Retakes can be repetition the speaker meant; nothing is cut
  until the user presses Remove or Remove all (ROADMAP NW-01 risks).

### 2.5 Smooth cuts

- **Chosen: always-on linear fades of `CUT_FADE` = 10 ms on each side of every cut, on the
  recording's sound only** (the music runs on through cuts and is not faded; the click sounds are
  not cut). 10 ms is inside the 5–15 ms the roadmap gives: long enough to remove the click of a
  waveform cut mid-cycle (a 100 Hz voice fundamental has a 10 ms period), short enough that no
  syllable is audibly shortened (a 20 ms dip is below the ~30 ms gap people can hear in speech).
  Linear, because ffmpeg `afade`'s default curve (`tri`) and Web Audio's `linearRampToValueAtTime`
  are both linear, so preview and export use the same curve.
- No setting. A fade at a cut has no downside a user would turn it off for, and a setting would add
  a field to `project.json`. Rejected: a crossfade (overlapping the two sides): it changes the
  video's length at each cut, so caption, chapter and click times would have to account for it
  (ROADMAP NW-06 risk), and it needs two sound pieces at once in the preview.
- **Opt-in in the export job.** `RecordingSound.cutFade` (seconds) is new and optional; the editor's
  exporter always sets it. A job without it builds exactly today's graph, so every existing
  `audioPlan` test keeps its exact expected graph and a job from an older renderer still works.
- **Video cross-dissolve: not in this release.** It needs two decoded frames at once in both the
  WebCodecs export feed and the preview (ROADMAP NW-06 risk), and the decode feed and compositor are
  being changed by the vertical-video team right now. A 10 ms audio fade removes the click, which is
  what users hear as a bad cut; a 2-frame dissolve is a visual nicety left for later (§12).

---

## 3. Data model

**No change to `project.json` and no migration.** Old projects load byte for byte as before
(`migrateProject` is not touched). Everything new is derived on the fly or held in renderer
memory:

| What | Where it lives |
|---|---|
| Cuts | `Project.clips`, as today. |
| The word list | Derived from `Project.transcript` (`transcriptWords`), memoised on the transcript object. |
| Cut or kept, per word | Derived from `Project.clips` (`cutFlags`). |
| The selection in the transcript | Panel state (indices into the word list), never saved. |
| The fillers and retakes list | Renderer memory per project id (`reviewMemory` in the panel), so switching tabs keeps it; gone when the editor closes. Never saved. |

The export job gains one optional field (`src/shared/api/export.ts`, additive):

```ts
export interface RecordingSound {
  // ...existing fields
  /** Seconds of fade out before and fade in after every cut (NW-06); absent: none (earlier jobs). */
  cutFade?: number
}
```

`src/main/exportJob.ts` `validRecording` gets one clause: `cutFade` absent, or a number in
[0, 0.05]. This is the one line outside the listed shared files; without it the main process would
pass an unchecked value into the filter graph (it is formatted as a number, but the job is
untrusted renderer input and every other field is checked there).

---

## 4. Behaviour

### 4.1 The word list (`transcriptWords`)

For each caption, in order: its text split on spaces gives the shown words; its `words` (when the
provider returned timings) give the times. Captions can be edited in the Captions tab (a typo fixed,
a word added or removed) after the timings were made, so the text's words are **aligned** to the
timed words by a longest common subsequence of their normalised forms (§4.5 normalisation):

- A shown word matched to a timed word takes its times.
- Unmatched shown words between two matched ones share the time between them in proportion to
  their length in characters, and are marked `estimated`.
- A caption without any timed words gets every word estimated the same way across the caption.
- A word is at least 0 s long; times stay inside its caption.

`estimated` words work like any other; the panel says "Some word times are estimated: cuts there
may be less exact" when more than 10 % of the words are estimated.

Each word: `{ index, caption, text, start, end, estimated }` (source seconds). At most
`MAX_CAPTIONS` (5,000) captions × 400 words exist (`captionData.ts`); the list is built once per
transcript object.

### 4.2 Cut or kept (`cutFlags`)

A word is cut when its middle, `(start + end) / 2`, is in no clip (`clipIndexAt` semantics:
`start ≤ t < end`). Computed for all words in one sweep over the sorted words and the sorted clips
(O(words + clips)).

### 4.3 The range of a word span (`wordsRange`)

For the words `first..last` (indices), with `prev` = the word before `first` and `next` = the word
after `last` (in the whole transcript, whatever their state):

- `start = first.start − min(MAX_REACH, (first.start − prev.end) / 2)`; without `prev`,
  `first.start − MAX_REACH`. A negative pause (overlapping timings) counts as 0.
- `end = last.end + min(MAX_REACH, (next.start − last.end) / 2)`; without `next`,
  `last.end + MAX_REACH`.
- Clamped to `[0, duration]`.

`MAX_REACH = 0.5` s. Two spans that are next to each other meet exactly at the middle of their
pause, so cutting words one at a time gives the same cut as cutting them together, and restoring a
span restores exactly the range that cutting it removed.

### 4.4 Cut, restore

- **Cut** (`cutWords(clips, words, spans, duration)`): `cutRange` for each span's range, in one
  store update. `cutRange` keeps its own rules: no kept piece shorter than `MIN_CLIP` (0.1 s) is
  left (a single short word between two cuts goes with them, and shows struck through), and the
  last piece of the video is never removed (then nothing changes and the notice says "That would
  cut the whole video").
- **Restore** (`restoreWords`): `restoreRange` of the span's range: what is cut inside it comes
  back at 1×, kept parts keep their speed, and neighbours with the same speed merge (the timeline's
  own restore rule).
- With a selection that is all kept, **Restore** is disabled; all cut, **Cut** is disabled.
  `Delete` on an all-cut selection says "Already cut. Press Restore to bring it back".

### 4.5 Fillers (`findFillers`)

Normalisation (`normalizeWord`): Unicode NFKC, lower case, punctuation and symbols (`\p{P}`,
`\p{S}`) removed from both ends, inner apostrophes kept.

Lists by the transcript's language (`Transcript.language`, the part before `-`; unknown: English):

| Language | Always fillers | Fillers only in context |
|---|---|---|
| any | um, umm, uh, uhh, uhm, hmm, hm, mm | — |
| en | er, erm, ah, eh | like; you know; I mean |
| bn | উম, উমম, আঁ, উঁ, হুম, হুমম, আহ | মানে |
| de | äh, ähm, öh, öhm | — |
| fr | euh, heu, bah | — |
| es | eh, em, este (context) | este |

A **context** filler counts only when it stands apart: a pause of at least `FILLER_PAUSE` = 0.3 s
before or after it, or a comma right after it or right after the word before it. "I like it"
is never flagged; "it was, like, slow" and "it was like ... slow" are.

Multi-word fillers ("you know", "I mean") match consecutive words. Each filler is one suggestion
`{ kind: 'filler', first, last }`.

### 4.6 Retakes (`findRetakes`)

Tokens are the normalised words with fillers left out.

**Sentences.** A sentence ends after a word that ends with `.`, `?`, `!`, `…` or `।` (the Bangla
full stop), or before a pause of at least `SENTENCE_PAUSE` = 0.8 s, or at a caption's end when the
pause after it is at least 0.3 s.

**Retake rule.** Sentence A is a retake of a later sentence B when B starts within
`RETAKE_WINDOW` = 15 s of A's end and:

- A has 3 to 80 tokens, `LCS(A, B) / |A| ≥ 0.75` (longest common subsequence of tokens), and B's
  first three tokens include A's first token; or
- A has exactly 2 tokens and B starts with the same 2 tokens.

B is the next sentence, or the one after it when the sentence between them has at most 6 tokens
("Sorry, again."). The suggestion cuts from A's first word to the word before B:
`{ kind: 'retake', first: A.first, last: B.first − 1 }`. With three takes A, A′, A″ both A and
A′ are suggested and A″ is kept.

**Stutters.** A run of 1 to 4 tokens said twice in a row (the second starting within 1 s of the
first's end) is suggested as `{ kind: 'repeat' }` for the first run. Single-word repeats skip words
that are often doubled on purpose: that, had, is, very, really, so, no, yes, yeah, bye, ha, more,
now, well, far, long, many, again, go, too, okay, ok.

Suggestions inside a retake's span are dropped (the retake covers them); overlapping stutters and
fillers keep the earlier one.

### 4.7 The review list

"Find fillers and retakes" builds the list from the current word list and clips: only suggestions
that save time (`rangeSaving(range, clips, 'cut') ≥ 0.05` s, the Smart speed rule) are listed, so
words already cut are skipped. Each row: the kind ("Filler", "Retake", "Repeat"), the words in
quotes (with up to 4 words of context before, dimmed), the time where it plays, and Keep / Remove.

- Clicking the row's text moves the playhead to it.
- **Remove**: cuts that suggestion (one undo step); the row goes.
- **Keep**: the row goes; nothing changes; no undo step.
- **Remove all**: cuts every listed suggestion in one store update (one undo step); the list
  closes; the notice says "Removed 6 (8.2 s)".
- Words of listed suggestions are underlined dotted in the transcript.
- An edit elsewhere (undo, a timeline cut) re-filters the list against the new clips, so a row
  whose words became cut disappears.
- None found: "No fillers or retakes found." plus the hint "Some captions leave fillers out. Captions
  made on this PC keep most of them."

### 4.8 Smooth cuts in the export (`audioPlan.ts`, `cutFades.ts`)

`recordingGraph` already splits the edit into sound pieces (`soundPieces`: the clips, split at
pause freezes). With `cutFade = d > 0`, a piece gets:

- a fade in, `afade=t=in:st=0:d=f`, when it does not continue the piece before it (its `start`
  differs from the previous piece's `end` by more than 1 µs): a cut is in front of it;
- a fade out, `afade=t=out:st=L−f:d=f`, when the next piece does not continue it.

`L` is the piece's sound length in the output (`(end − start) / speed`; for re-timed edits the
exact sample count the video gives it, less its hold) and `f = min(d, L / 2)`. The filters go after
the re-timing and before the pause-freeze silence, so they act on the piece's own sound. Adjacent
clips with different speeds (a split, no cut) get no fade; the edit's very start and end get none
(the soundtrack fades are for that). A job without `cutFade` (or with 0) builds the same graph as
before, character for character.

### 4.9 Smooth cuts in the preview (`previewAudio.ts`)

The preview jumps over a cut by seeking the video element (`player.ts` `leaveClip`/`jumpTo`). The
Web Audio graph gets one more gain node, `cut`, between the recording's gain and the limiter
(the music and click sounds do not pass through it):

- **Fade out.** On every video frame (`frame()`), when the current clip ends in a cut, the time
  until the player's jump is `w = (clip.end − t) / rate − PREVIEW_FRAME` (the player jumps one frame
  before the clip's end; `rate` is the element's playback rate, `PREVIEW_FRAME` = 1/60 s, the
  proxy's frame). Once `w ≤ CUT_FADE + 2 × PREVIEW_FRAME`, a linear ramp to 0 ending at `now + w`
  (starting `CUT_FADE` before it) is scheduled, once per cut.
- **Fade in.** On the jump the gain is set to 0; on the first frame after the jump lands it ramps
  linearly to 1 over `CUT_FADE`.
- Play, pause and seeks set it back to 1 at once.
- The graph is created when the edit has a cut and the recording is heard (in addition to today's
  reasons, `needsAudioGraph`). A project without cuts plays exactly as before (the video element's
  own track).

The preview's fades have the export's length and curve; their placement follows the video frame
callbacks, so it is within about one frame (17 ms) of the export's. The pure part (when to start the
fade out) is `cutFadeAhead()` in `cutFades.ts`, unit-tested.

### 4.10 Playback highlight and follow

The current word is the word whose `[start, end)` contains the preview's display time
(`displayTime(clips, player.time)`), read through `useSyncExternalStore(player.subscribe, …)` so the
panel re-renders only when the index changes, not every frame. While playing, the current word is
scrolled into view unless the word list has the focus; the page follows it (§4.11).

### 4.11 Pages

The text is shown in pages of 40 captions (like the Captions tab's 50-row pages), with Earlier /
Later. The page follows the current word while playing and the focused word while moving with the
keys. Selections can span pages (they are word indices).

---

## 5. UI and copy

Tab: **Transcript** (icon: lines of text with a cursor), after Captions.

No transcript (or every caption deleted):

> **Edit by text**
> Cut the video by deleting words, like editing a document.
> This video has no transcript yet. Make captions first: the transcript comes with them.
> [Make captions]

`Make captions` opens the Captions tab and asks it to generate (`requestCaptions({ kind:
'generate' })`, the command palette's "Generate captions" path): it starts at once when it can,
else it shows what is missing (a model to download, a key to add). Without sound: the button is
disabled and the text says "This recording has no sound to make a transcript from."

With a transcript:

- Section title: **Transcript**, aside: "312 words · 14 cut".
- Toolbar: **Cut** (title "Cut the selected words (Delete)"), **Restore** (title "Bring the
  selected words back"), **Find fillers and retakes**.
- Hint under the toolbar: "Select words and press Delete to cut them. Click a word to go there."
- Estimated-time hint (§4.1) when it applies.
- Text: one paragraph per caption, its video time at the start (as the Captions tab shows times,
  `videoTimeAt`). Words: kept `--text-1`; cut: `--text-3` with a line-through; selected:
  `--accent-soft` background with an `--accent-text`-coloured outline; current word:
  `--track-caption` underline 2 px; suggested: dotted `--warning` underline. Contrast on
  `--surface-1`: `--text-1` 17:1, `--text-3` 5.4:1 (AA), `--accent-text` 6.3:1.
- The text area is `role="listbox"` with `aria-multiselectable="true"`, label "Transcript words",
  focusable (`tabIndex 0`), `aria-activedescendant` naming the focused word; each word is
  `role="option"` with `aria-selected`, and a cut word's label adds ", cut".

Review list (after Find), section **Fillers and retakes (6)**:

> Nothing is cut until you choose. Removing all saves 8.2 s.
> Filler · 0:12 · "so **um**" · [Keep] [Remove]
> Retake · 0:31 · "**Today we will look at the**" · [Keep] [Remove]
> [Remove all] [Close]

Notices: "Cut 3 words (1.2 s)", "Cut 1 word (0.4 s)", "Restored 3 words", "Already cut. Press
Restore to bring it back", "That would cut the whole video", "Removed 6 (8.2 s)", "No fillers or
retakes found".

---

## 6. Security

Nothing here reads files, runs programs or talks to the network. The transcript comes from the
project (already read and bounded by `readTranscript`: at most 5,000 captions, 400 words each, 500
characters per caption). Rendering puts word text into React text nodes only (no HTML). The one new
export field is validated in the main process (§3). Regular expressions are linear (no nested
quantifiers); retake comparison is bounded (80 tokens per sentence, two candidates per sentence).

---

## 7. Undo

| Action | Undo steps |
|---|---|
| Delete (Cut) on any selection | 1 (`store.update`, no merge key) |
| Restore | 1 |
| Remove (one suggestion) | 1 |
| Remove all | 1 |
| Keep, Find, selecting, seeking | 0 |

After undo the selection (word indices) still points at the same words: the word list does not
change with cuts.

---

## 8. Performance

- The word list: once per transcript object (`useMemo`); 20,000 words align in a few ms (LCS per
  caption, at most 400 × 400).
- Cut flags: one sweep per clips object.
- The playhead highlight: a number from `useSyncExternalStore`, so a re-render only when the word
  changes (about 3 per second while talking).
- Pages of 40 captions keep the DOM at a few hundred spans.
- Fillers and retakes: O(words) plus at most two LCS of ≤ 80 tokens per sentence.
- Preview fades: a few arithmetic operations per frame.

---

## 9. Files and exported signatures

New (owned):

- `src/shared/editor/transcript.ts`
  - `interface TranscriptWord { index; caption; text; start; end; estimated }`
  - `transcriptWords(transcript?: Transcript): TranscriptWord[]`
  - `alignCaptionWords(seg: CaptionSegment): Omit<TranscriptWord, 'index' | 'caption'>[]`
  - `cutFlags(words, clips): boolean[]`
  - `wordsRange(words, first, last, duration): TimeRange`, `MAX_REACH`
  - `cutWords(clips, words, spans, duration): Clip[]`, `restoreWords(clips, words, first, last, duration): Clip[]`
  - `wordIndexAt(words, t): number`, `spanSaving(...)`
- `src/shared/editor/transcriptSelection.ts`: `interface WordSelection { anchor; focus }`,
  `selectionSpan`, `moveSelection(sel, key, shift, words)`, `clickSelection(sel, index, shift)`.
- `src/shared/editor/fillers.ts`: `normalizeWord`, `fillerLanguage`, `findFillers(words, language?)`.
- `src/shared/editor/retakes.ts`: `sentencesOf(words)`, `findRetakes(words, language?)`.
- `src/shared/editor/transcriptReview.ts`: `interface EditSuggestion`, `reviewSuggestions(words,
  clips, duration, language?)`, `applySuggestions(clips, words, items, duration)`.
- `src/shared/render/cutFades.ts`: `CUT_FADE`, `PREVIEW_FRAME`, `pieceCutFades(pieces)`,
  `cutFadeFilters(...)`, `cutFadeAhead(clips, t, rate)`.
- `src/renderer/src/editor/panels/TranscriptPanel.tsx`, `src/renderer/src/editor/panels/transcript.css`.
- `tests/transcript.test.ts`, `tests/transcriptSelection.test.ts`, `tests/fillers.test.ts`,
  `tests/retakes.test.ts`, `tests/transcriptReview.test.ts`, `tests/cutFades.test.ts`,
  `tests/e2e/edit-by-text.e2e.cjs`.

Additive lines in shared files:

- `src/shared/api/export.ts`: `RecordingSound.cutFade?`.
- `src/shared/render/audioPlan.ts`: `RecordingPart.cutFade?`, the fade filters in the piece chain,
  passing `cutFade` through `planSoundtrack`.
- `src/main/exportJob.ts`: one validation clause (§3).
- `src/renderer/src/editor/exporter.ts`: `audio.cutFade = CUT_FADE`.
- `src/renderer/src/editor/previewAudio.ts` (the preview's audio path): the `cut` gain node and its
  scheduling.
- `src/renderer/src/editor/Inspector.tsx`: the tab, its type member, its render line.
- `src/renderer/src/editor/EditorIcon.tsx`: one icon path.
- Docs: FEATURES, ROADMAP, RELEASE-NOTES, this file.

Not touched: `native/**`, `src/main/speech/*`, `src/shared/speech/*`, the Captions panel, the
vertical-video files, `src/main/recording/*` and the other recording files, `package.json` (no new
dependency).

---

## 10. Risks

| Risk | Answer |
|---|---|
| Word timings are off by tens of ms, so a cut clips a syllable. | Cuts end in the middle of the pause (§4.3); the 10 ms fades soften what is left; Restore and undo are one step. |
| Transcripts made by a cloud service leave fillers out (whisper-1 without a prompt, `openai.ts`). | The empty-result hint says so; making the request verbatim is in `src/main/ai/*` (another team's area) and is left for later (§12). |
| A retake rule flags repetition the speaker meant ("Click Next. Click Next."). | Review list; nothing is cut without Remove. |
| "like" flagged where it is a verb. | Context rule (§4.5) and review list. |
| The preview's fade placement drifts from the export's. | Same length and curve; placement within about one frame; e2e checks that the preview creates the fade node and the export dips at the cut. |
| Creating the Web Audio graph for every project with cuts changes the preview path for those projects. | The graph is the same one used today whenever music, stems, normalisation or fades are on, and is exercised by the existing audio e2e tests. Projects without cuts are untouched. |
| Big transcripts (4 hours). | Pages, memoised derivations, sweeps (§8). |

---

## 11. Test plan

Unit (vitest, node), each rule failing without its code:

- `transcript.test.ts`: alignment (equal text, a fixed typo, an added word, a removed word, no
  timings), estimated flags, clamping; `cutFlags` against `clipIndexAt` on random clips;
  `wordsRange` (middle of the pause, `MAX_REACH`, no neighbour, overlapping timings, clamps);
  adjacent spans meet; cut then restore returns the original clips; cutting everything is refused;
  `wordIndexAt`.
- `transcriptSelection.test.ts`: click, shift+click, arrows with and without Shift, Home/End,
  Up/Down by caption, Ctrl+A, bounds.
- `fillers.test.ts`: each list; normalisation (case, punctuation, NFKC); context rule (pause,
  comma, "I like it" not flagged); multi-word; language fallback; Bangla.
- `retakes.test.ts`: sentence splitting (punctuation, pauses, Bangla `।`); a false start; three
  takes keep the last; the in-between short sentence; a long in-between sentence blocks it; the
  window; two-token rule; stutters and the doubled-word list; overlaps.
- `transcriptReview.test.ts`: savings, already-cut words skipped, Remove all as one clip change,
  suggestions inside retakes dropped.
- `cutFades.test.ts` and new cases in a new test file for the graph: no `cutFade` gives the old
  graph exactly; fades only at cuts, not at speed splits or the edit's ends; `f = min(d, L/2)`;
  re-timed pieces use their exact sample length; holds; `cutFadeAhead`.

End to end (`tests/e2e/edit-by-text.e2e.cjs`, Linux, real app):

1. A seeded project with a transcript (word timings) opens; the Transcript tab lists the words.
2. Click a word: the playhead moves to it.
3. Select three words with Shift+→ and press Delete: the saved `clips` have the cut where §4.3 says;
   the words show struck through; one Ctrl+Z restores the clips; Ctrl+Shift+Z cuts again.
4. Restore on the cut words brings them back.
5. Find fillers and retakes lists the seeded "um" and the retake; Keep removes a row with no edit;
   Remove all cuts the rest in one undo step.
6. A project without a transcript shows Make captions, which opens the Captions tab.
7. Export to M4A of a tone with one cut: the samples at the joint are within the fade (quiet), and
   away from it the tone is at full level.
8. Old projects: an existing fixture project opens and saves with an unchanged `project.json`
   apart from what the editor already writes.

---

## 12. Left for later

- Video cross-dissolve (2 frames) at cuts, and a per-cut transition style (crossfade, dip to
  colour, zoom punch-in) and "Smooth all cuts" (NW-06 full).
- Fades at pause freezes (sound stopping for a held frame) and at the edit's start and end.
- Verbatim transcription (a prompt with fillers for `whisper-1`, asking Gemini for them), in
  `src/main/ai/*`.
- Meaning-level retakes with sentence embeddings on this PC (F-05) or an AI text task.
- Typing to replace words (overdub) and moving sentences by drag.
- A command-palette entry and a shortcut for the Transcript tab.
