# Build report: Captions Studio, phase A (wave 9)

Branch `feat/captions-studio`, built on the default branch (Flown 0.7.1 with NW-09's speakers and
estimated word times) from the contracts commit `dd7bf23`. Design: `docs/design/captions-studio.md`
(§0 holds the owner's approved looks, the Bangla requirements and the build order). Nothing was
pushed.

## What was built

Four parts were built in parallel on the frozen contracts and merged here one at a time with
`git merge --no-ff`, in the design's order (§14.5: P1, P2, P4, then P3, because P3 mounts P4's
sections):

| Merge | Part | What it brings |
|---|---|---|
| `ec675c6` | P1, look, layout and motion engine (`src/shared`) | Words with their times and scripts, the Digits choice, phrase breaks by dynamic programming, the four chunk modes, placement that keeps clear of the camera, lower thirds, key presses and the action, the motion engine (easings, entrances, word motion, spoken marks, the flash rule, calm motion), contrast and themes, a font face per word with the looks' Bangla fonts, the Studio twins of the Classic looks, emphasis marks that follow their words, graphics placement and editing, the action under a caption. |
| `a48dcd1` | P2, drawing, fonts, downloads, export | The Studio caption layer (word sprites with poses, boxes, glass, bubble, chat, spoken and emphasis marks), the graphics layer (keyword cards, emoji, counters, list cards), quote cards, the 42 bundled WOFF2 fonts registered before drawing and exporting, gallery thumbnails, the contrast measurement, pinned downloads with SHA-256 and size caps, pops and bleep tones, subtitle files per language and subtitle streams, the caption fonts' installer budget. |
| `d790ac6` | P4, automation and languages | Offline emphasis, emoji, numbers and lists (CLDR 49 data), Auto style, Tidy captions and bleeping, caption tracks translated through the AI provider, the `marks` AI task, Make my captions great and its settle rule, Polish's Caption look step, the word list as a transcription prompt, the Clean up, Languages, options and Subtitles UI. |
| `c18a55c` | P3, editor UI | The Look section and gallery, the Text, Colours, Layout, Motion, Emphasis and Speakers controls, the Graphics tab and timeline row, graphics on the preview, emphasis in the Transcript tab, the four caption preferences and saved looks, the brand kit's caption look, the seven commands, the hovered-look preview, the caption look of a vertical version, Settings › Downloads for captions. |

Merging: P1, P2 and P4 merged without conflicts. P3 conflicted in one place,
`src/renderer/src/render/studioLayer.ts`: P3 had added a `language` argument to the stub of
`drawStudioSample` while P2 wrote its body. P2's body is kept and now draws the Bangla sample of
the approved `bangla.html` ("আপনার ভিডিও শেয়ার করার জন্য তৈরি", "শেয়ার" spoken) for `bn`.

### Integration fixes (found by running the parts together)

Each fix has a test that fails without it (checked by removing the code and running the test),
with two exceptions: the masking rule behind 7 is tested (`languageSubtitleFile` in
`tests/subtitleArgs.test.ts`), but the one-line call in the Captions tab that now uses it has no
test of its own; 9 is checked by the e2e only.

1. **The spoken word never lit up** in Bold Pop, Neon, Spotlight Word, Stickers and every other
   colour, glow or sticker look. P1's `WordPose.fill` is the spoken colour's share (its doc says so)
   and `mark` the emphasis mark's; the Studio layer read `mark`. Each part's tests used its own
   reading, so all passed. Found by the new e2e (no green in Bold Pop's export). The layer now reads
   `fill`; P2's stand-in poses follow motion.ts; `tests/captionsStudioIntegration.test.ts` checks
   the lit word on P1's real poses (`cb75c17`).
2. **A mouse click on a gallery tile did nothing** (keyboard picks worked). Pressing a tile focuses
   it and starts it playing, which replaced the thumbnail's `img` with a `canvas` between press and
   release, so Chromium sent no click. The picture no longer takes the pointer (`6c18dc6`).
3. **The Digits choice reached nothing but list numbers in Bangla.** The Studio layer did not pass
   it to the layout, counters ignored it, list numbers used the locale's default (Latin digits for
   Hindi) and chapter titles never changed. All four now follow it; without the choice every drawing
   is as before (`f7e3513`).
4. **Digits on a Classic look** wrote `digits` that the legacy drawing never shows; it now makes the
   look's Studio twin in the same undo step, like every change below today's controls (`62cc9bc`).
5. **The hint under Make my captions great** only changed when the window next got focus; it now
   reads P4's options store and changes as soon as the options are saved (`62cc9bc`).
6. **The contrast meter never measured**: nothing called P2's `setContrastSource`. The editor now
   registers the paused preview's frame; closing an editor releases only its own source (`3f6a486`).
7. **Save captions wrote bleeped words in full**; it now writes the spoken captions with the bleep
   masks, as the export's subtitle files do (`3f6a486`).
8. **`NOTICE_NAMES`** now requires CLDR, obscenity and LDNOOBW, named by P4's data notice
   (`3f6a486`).
9. **Clean up says what a bleep does in this version**: the word is masked in captions and subtitle
   files and the tone plays over it, but its own sound is not muted until phase B (see below)
   (`7c33649`).
10. **Make my captions great's options dialog** was squeezed to about 150 px beside its buttons
    (labels wrapping word by word); it now opens on a line of its own (`7c33649`).

## Phase B, left out by design (§0.4), with seams

(As phase A left it. What phase B built is in the section **Phase B** at the end.)

- **Review mode group rows** (`review.ts`, `copy.ts`, `ReviewPanel.tsx`, test 44): not built.
- **The sound finder's bleep gains**: `bleepGains` in `src/shared/captions/cleanup.ts` returns a
  local `SoundGain` (`TODO(phase B)`); until the sound finder (F-17) merges, **a bleep does not mute
  the spoken word**: Tone plays over it and Silence adds nothing. Clean up says so
  (`cleanup-bleep-note`, `TODO(phase B)` in `CleanupSection.tsx`).
- **`versions.ts` areas** (test 56): not built (the versions branch is not merged).
- **The publishing pack's `aiTranslate` and `aiCleanup` commands**: not retargeted. Cancel in
  Make my captions great, Clean up and Languages drops the AI answer; stopping the provider's own
  request needs the publishing pack's `requestId` and `cancelAiText` (`TODO(phase B)` in
  `greatRun.ts`, `CleanupSection.tsx`, `LanguagesSection.tsx`).
- **Offline translation** (F-16): waits for the owner's licence decision (§0.3 item 5).
  `LanguagesSection.tsx` has `OFFLINE_TRANSLATION = false`, `captionCommands.ts`
  `localTranslationOffered()` returns false, and the asset store has the seam for translation models
  (`TODO(phase B)` in `assetStore.ts`); `TRANSLATE_BUDGET` is checked only when
  `resources/translate/` exists.

Other things the parts left open, for the lead:

- P1's phrase costs depart from §8.3 (a break inside a run of capitalised words +8, +5 per chunk,
  +6 for breaking a line that fits); test 7 pins the result. §8.6 rule 3 (a narrower free span)
  only moves a block sideways that already fits.
- P1's contract additions (`StudioFace.stretch`, `StudioLayout.caption/speaker/bigMark`,
  `breakPhrases(…, spaces)`, `studioLayout`'s `digits`, `counterText(…, digits)`), P2's
  (`assetFontFile`, the language argument of `writeSidecar`, `ExportInput.subtitleLanguages`), P3's
  (`drawStudioSample`'s `language`) and P4's (`SubtitlesField`'s props, `tidyCaptions`'s `fix` and
  `estimated`, `planCaptionsGreat`'s `marksVia` and `cursor`, `TranscribeOptions.glossary`) are not
  yet recorded in §14.0.1.
- Quote cards from the Graphics tab need P4's AI marks answer there; Make my captions great makes
  them. Group edits of graphics have no font control.
- The design's 136 × 96 px tiles shrink to the column width in the Inspector's default 251 px
  body (the sample text stays at 18 px).

## Tests

### Unit tests (vitest)

After the four merges, before any integration fix: 340 files, 4,525 tests, all passing (the parts'
tests largely replace each other's functions with stand-ins, which is why the seams above slipped
through). Final: **341 files, 4,552 tests, all passing**.

New or extended here; each new rule's test was checked to fail without its code (the key-press
checks and "a typed title keeps its digits" guard merged behaviour that needed no new code):

- `tests/captionsStudioIntegration.test.ts` (new, 22 tests): the drawing on the parts' real code
  with no stand-ins: the Digits choice in captions, counters, list numbers and chapter titles (and
  a typed title keeps its digits); the spoken word lit on P1's real poses for Bold Pop, Spotlight
  Word and Neon; the gallery's Bangla sample in Baloo Da 2; key presses clear of a block P1 placed
  (Editorial, Bold Pop, Subtitle at Lower and Bottom, 16:9 and 9:16; test 54 on the real layout).
- `tests/captionLookSection.test.ts`: the hint follows saved options at once; Digits on a Classic
  look makes the twin in one undo step.
- `tests/captionGallery.test.ts`: a press on a tile's picture keeps its click; the options dialog
  gets its own line.
- `tests/contrastProbe.test.ts`: an editor closing releases only its own frame source.
- `tests/packaging.test.ts`: `NOTICE_NAMES` with CLDR, obscenity and LDNOOBW (a pinned list,
  stated anew and stricter).
- `tests/studioFakes.ts`: P2's stand-in poses follow motion.ts's meaning of `fill`.

The equivalence guards (`tests/captionsStudioEquivalence.test.ts`, `tests/verticalEquivalence.test.ts`)
pass unchanged; their snapshots were not touched.

`tests/aiProviders.test.ts` fails 6 of 33 tests when run against the machine's shared `/tmp`: it
fails when any `ssw-transcribe-*` folder exists there, and ten were left by other runs on this
machine between 19:02 and 19:54 the day before this build. With a private `TMPDIR` all 33 pass; the
full-suite numbers above use a private `TMPDIR`.

### End to end

`tests/e2e/captions-studio.e2e.cjs` (new; §16.3 phase A): six tests over grey 10 s fixtures with
seeded transcripts (no network, no AI provider):

1. An old project (0.8.0's boxed captions) opens and closes with `project.json` byte for byte
   unchanged, its Classic tile checked, first, "Your current style"; the export draws the legacy box
   where the legacy layout puts it, and exporting does not rewrite `project.json`.
2. A tutorial look by keyboard: Tab reaches the gallery, the arrows reach Karaoke Fill, Enter picks
   it (`preset` karaoke, `picked`); Ctrl+Z and Ctrl+Y each take one step. Preview equals export: the
   paused preview at 1.95 s and the 60 fps export's frame at the same time have the same shares of
   spoken yellow, white and ink in the caption band.
3. A Short look: in a 9:16 project the gallery opens on Short clips; Bold Pop pops in (its ink is
   narrower at +0.033 s than at +0.3 s, about the same centre) and the spoken word is green; Make my
   captions great (offline) adds emphasis and a 0–300 % counter for "300 percent", keeps the picked
   look, and one Ctrl+Z takes the whole run back.
4. Bangla: Bold Pop draws Bangla in Baloo Da 2 (loaded from the app's files); the Digits choice draws
   ৩০০ (the preview's band changes; Western draws it as written); the export draws both captions; no
   http(s) request from the window throughout.
5. Pop-ups: a keyword, an emoji and a counter added from the Graphics tab's Add menu by keyboard
   start at the playhead and show in the export at their times (the emoji in colour); nothing is
   drawn between the caption and the first pop-up.
6. Keyboard and the hovered look: Tab reaches Make my captions great, its options, the filters, the
   gallery and Show all styles on the way to Play; the options popover keeps the focus through 40
   Tabs and Esc returns it to its button; hovering Karaoke Fill shows "Previewing Karaoke Fill" and
   its look on the preview, leaving restores it, and the project and the undo stack are unchanged;
   Clean up's bleep note.

Not covered here from §16.3 (phase B or left for a later pass): Shift+R group rows (10), the
Graphics row drags (11), downloads from a local server (13), subtitle streams and files (14), a
burned-in track (15), bleep audio (16), continue freeze (18), fonts before the first frame of a
quote card (19), key presses (20; covered in vitest on the real layout), the palette (22), reduced
motion (7), the 30/60 fps determinism check (5).

Results under `xvfb-run -a -s "-screen 0 1920x1080x24"` on the built app (a failing file was run
again alone before being treated as real):

| File | Result | Notes |
|---|---|---|
| `captions-studio` | 6 of 6 pass (about 80 s) | Preview vs export at 1.95 s: yellow 0.97 % vs 0.95 %, white 0.63 % vs 0.67 %, ink 4.01 % vs 3.98 % of the caption band. Bold Pop's ink 506 px wide at +0.033 s, 546 px at +0.3 s. |
| `captions` | 9 of 9 pass | Run again on the final build. |
| `edit-by-text` | 4 of 4 pass | |
| `one-click-polish` | 3 of 3 pass | Failed first: Polish's Caption look step now tidies the captions (designed, §11.8); the assertion states it (`a0698d8`). |
| `bangla-captions` | 4 of 4 pass | |
| `offline-captions` | 11 of 11 pass with a private `TMPDIR` | Against the shared `/tmp`, "cancel keeps the finished parts…" fails twice in a row on the same leftover `ssw-transcribe-*` folders as `aiProviders.test.ts` (the step checks that none exists). |
| `transcription` | 4 of 4 pass | Failed first: two named speakers now get Subtitle with names and colours (§11.6 rule 4); the test states it and still checks names widen the caption (`a0698d8`). |
| `brand-kit` | 6 of 6 pass | |
| `vertical-video` | 1 of 1 pass | Failed first: the vertical copy now gets Bold Pop (§10.5); the test states it and still checks the caption stays in the text area (`a0698d8`). |

Not run here: the rest of §14.5's list (`review-mode`, `publish-pack`, `titles`, `multi-select`,
`polish`, `export`, `export-pack`, `render`, `commands`, `freeze`, `audio-pack`, `clean-voice`,
`sound-finder`, `versions`, `ai`, `search`); several belong to branches not merged yet.

## Verification output

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
(exit 0)

$ TMPDIR=<private> npx vitest run --maxWorkers=2
 Test Files  341 passed (341)
      Tests  4552 passed (4552)
   Duration  124.20s

$ npm run build
✓ built in 4.82s   (main)   ✓ built in 32ms (preload)   ✓ built in 3.30s (renderer)
(42 caption WOFF2 files emitted under out/renderer/assets; only Vite's usual >500 kB chunk warning)

$ node scripts/build-emoji-data.mjs --check
build-emoji-data: the generated files are up to date
$ node scripts/notices.mjs --check
notices: resources/THIRD_PARTY_NOTICES.txt is up to date (201514 bytes)
$ node scripts/fonts.mjs check
fonts: 42 WOFF2 files match their pins
```

Screenshots (each under 300 KB): `docs/screenshots/captions-studio-classic-current.png`,
`-gallery.png`, `-karaoke-fill-preview.png`, `-bold-pop-tall.png`, `-bangla-digits.png`,
`-bangla-look.png`, `-graphics-panel.png`, `-great-options.png`, `-hover-preview.png`, written by
`SSW_E2E_DOC_SHOTS=1 node tests/e2e/captions-studio.e2e.cjs`.

Not run: `npm run dist:win` and `verify:dist` (Windows packaging; see below), the native speech
tests.

## What needs a real Windows PC

- **Performance (§9.8, §18 item 6)**: the per-frame budget (at most 3 ms at 1080p; Bold Pop, Glass
  Pill and Bold Pop at 4K tall next to Clean) was measured on Linux only (P1: layout 0.03–0.07 ms
  per 12-word caption, poses 6–12 µs per frame). Measure the preview and the export on a Windows
  laptop with a GPU, and with the software canvas.
- **Installer size**: `CAPTIONS_BUDGET` (8.0 MB compressed, 8.5 MB installed) was sized from Linux
  measurements of the 42 WOFF2 files (7,449,971 B brotli). Confirm in a real `npm run dist:win` and
  `npm run verify:dist` (font hashes inside `app.asar`).
- **Fonts on Windows**: Bangla shaping and the nine Bangla families, Noto Color Emoji (COLRv1) in
  captions and pop-ups, CJK downloads, and the fallback to Windows' own fonts (Nirmala UI and
  others) for scripts without a bundled font, in DirectWrite-backed Chromium.
- **Downloads**: CJK fonts from `raw.githubusercontent.com` behind Windows proxies and antivirus,
  Retry-After on 429/503, and files under `%APPDATA%`.
- **Subtitle streams**: switchable `mov_text` tracks in MP4 and MOV and WebVTT in WebM in Films &
  TV, VLC and the browsers; the language names they show.
- **Keyboard and screen readers**: the gallery's radio group, the sliders' spoken values and the
  options popover with NVDA and Narrator; Ctrl+B and Ctrl+Shift+B on AZERTY and other layouts.
- **High contrast and scaling**: the Look section at 125 % and 150 % display scaling.

## Phase B

Branch `feat/cs-phase-b` from `a988af4` (wave 8 merged: review mode, publishing pack, sound finder,
share, search; and Captions Studio phase A). Built here: §0.4's phase B parts that wait for no
other branch. Not built: `versions.ts` areas (test 56; the versions branch is not merged, and no
file had to call it, so no seam was added) and offline translation (waits for the owner's licence
decision; its `TODO(phase B)` seams in `LanguagesSection.tsx`, `captionCommands.ts` and
`assetStore.ts` are left as they were). Nothing was pushed.

### What was built

| Commit | What |
|---|---|
| `f1b26f1`, `7abe3af` | **Bleeps mute their words** (§11.7 rule 5). `bleepGains` returns the sound finder's `SoundGain` (the local type is gone); `soundGains` joins the bleeps with the muted and lowered stretches through `joinGains`, so the preview's `sounds` gain node and the export's one `soundGainFilters` chain play the same curve; Tone still adds its 1 kHz sine. `jobSoundGains` gives the job's `RecordingSound.sounds` only when there are stretches or bleeps (a project with neither gets the job of before), and never more pieces than main's `validSoundGains` accepts (`MAX_SOUND_GAINS`): past that, the unjoined stretches and bleeps go, which main joins into the same curve. The preview's loudness hears bleeps muted, as the export's loudnorm does; the music keeps ducking under a bleeped word (a word inside speech). The preview's memo key includes the bleeps. Clean up's note that the word's sound is not muted is gone. |
| `3fab7b6` | **Palette commands retargeted** (§2.14): `aiTranslate` sends `{ kind: 'language', via: 'ai' }` (Languages › Add a language, first provider chosen, language select focused); `aiCleanup` sends `{ kind: 'cleanup', ai: true }` (Clean up's AI fix ticked, saved and focused; without a provider Clean up says to add one first). Both live in `aiCaptionCommands` (`captionCommands.ts`). `CaptionsAiTask` is `'chapters' \| 'title' \| 'summary'`; the AI tools' "is in Clean up now" notices are gone. |
| `2a18861` | **Cancel stops the provider's request**: Make my captions great's marks request (`greatRun.ts`), Clean up's AI fix and Languages' translations each send their own `requestId` and call `cancelAiText` with it on Cancel, and when their section goes while the request runs. |
| `72655b5`, `2a01ced` | **Review mode rows** (§11.8, `src/shared/review/captionReview.ts`): kinds `style`, `emphasis`, `text`, `emoji`, `graphic`, `bleep` after Review's own; `ReviewItem.members` (and `parts`, the items as listed); emphasis and text fixes as one group row each whose Keep and Remove do all pending items in one edit, and each item inside with its own. Keep drops records and clears `auto`; Remove puts back the look (since fixer round 1, only its look fields: see below) and the text and words, and deletes marks, graphics, title cards and bleeps; Remove on every row of a Make my captions great run gives the project from before it. A bleeped word is masked in its row and accessible name. The panel shows a group's items under a disclosure (`aria-expanded`, `aria-controls`); `K` and `Delete` on an item act on it; the focus moves to the next item to review. Chips use the track tokens. |
| `ecd23fe` | **Notice and hints**: Make my captions great's notice ends "Review (Shift + R) · Ctrl + Z to undo" with the user's keys (`reviewHint`; "Review mode lists them" without a key), from the button and the palette. Clean up's "Tidy changes are listed in Review mode." and the Graphics tab's two Review hints are back. |
| `ed85ce4`, `3ed2f6d` | **Test 1's wave 8 fixtures** and test 55's Review title (below). |

Expectations changed because they were phase A's interim behaviour, each said so in its commit and
in the test: `soundsBleeps.test.ts` (a bleep added only its tone), two Captions tab tests of the
"is in Clean up / Languages now" notices (replaced by one that the AI tools send and say nothing),
`great.test.ts` (the notice named no Review key), and the Graphics and Clean up hint tests (no hint
named Review mode).

### Tests

Unit tests (vitest), each new rule checked to fail with its source change reverted:

- Test 27 (`soundsBleeps.test.ts`, `bleepExportJob.test.ts`, `audioLevels.test.ts`): the preview's
  sounds gain is 0 under a bleep, alone or inside a muted or lowered stretch, Tone or Silence, and
  follows bleeps added and removed; the export graph has one gain chain and no `volume=enable`, and
  the 300 Hz recording is silent under the bleep through the pinned ffmpeg; the exporter's own job
  (caught at `exportStart`) carries the joined curve, the tone spans, nothing without bleeps or
  stretches, and at most `MAX_SOUND_GAINS` pieces for 2,000 ducks around 2,000 bleeps (same
  filters); loudness hears bleeps muted; ducking ignores them.
- Test 44 (`captionReview.test.ts`, 15 tests; `reviewPanelGroups.test.ts`): titles per kind
  (masked bleeps, "was" names), statuses, Keep and Remove per kind, the group rows (on the row and on
  one item, mixed groups read kept), "n of N" counts a group once, `mergeSnapshot` keeps a group's
  reviewed items and takes in new ones, one undo step per press through the editor's settle chain,
  undo and redo; the panel's disclosure and an item's Remove.
- Test 57 (`aiCaptionCommands.test.ts`): both commands' requests, the Languages form with the first
  provider chosen after another was picked, Clean up's AI fix ticked, saved and focused, the
  no-provider message, and no captions.
- Cancel (`greatRun.test.ts`, `cleanupAiFix.test.ts`, `languagesSection.test.ts`): the request id
  is valid and the one stopped; a run that ends by itself stops nothing; a section that goes stops
  its request.
- Test 1 (`captionsStudioEquivalence.test.ts`, `tests/fixtures/wave8-old-projects.json`): a
  publishing pack project, a review-mode project and a sound-finder project migrate to the keys and
  JSON digests that each branch's own code gave before Captions Studio merged (computed with
  `2cd2a3f`'s `src/shared` for the first two and `d58aac1`'s for the third), with no Captions Studio
  key, and read again unchanged.
- Test 55 (`graphicRules.test.ts`): Review lists "Chapter title: Export settings".
- The notice and hints (`great.test.ts`, `commandsCaptions.test.ts`, `graphicsPanel.test.ts`,
  `languagesSection.test.ts`).

End to end, extended: `captions-studio` (the Short look test: the notice names Review; Shift+R
lists one emphasis group row, the counter and the list card, no style row; the group opens to its
items; Remove deletes the list card, Ctrl+Z brings it back; a second run adds no undo step; Clean
up's hint), `review-mode` (new test: the style row, the emphasis group by keyboard, Delete and K on
one item, the group counted once, undo, Remove on the style row and the group, a masked bleep),
`sound-finder` (new test: a bleeped word in a 440 Hz recording is over 40 dB lower in the M4A with
a 1 kHz tone, or none with Silence, the rest unchanged; the preview schedules the gain of 0) and
`publish-pack` (new test: both palette commands).

### Verification output

```
$ npm run -s typecheck
(exit 0)

$ TMPDIR=<private> npx vitest run --maxWorkers=2
 Test Files  405 passed (405)
      Tests  5514 passed (5514)
   Duration  147.57s

$ npm run -s build
✓ built in 4.62s (main)   ✓ built in 37ms (preload)   ✓ built in 4.05s (renderer)
(exit 0; only Vite's usual >500 kB chunk warning)
```

An earlier full run with the default worker count (4 CPUs shared with other agents) had one
failure: `bleepBangla.test.ts` › "bleeps them written another way…" took 6.9 s against vitest's
5 s limit. It is untouched by phase B and passes alone (15 of 15, 20 s for the file), and in the run
above; it is a timing limit under load, not a wrong result.

End to end on the built app, under `xvfb-run -a -s "-screen 0 1920x1080x24"`, each file once and
alone (none had to be run again):

| File | Result | Notes |
|---|---|---|
| `captions-studio` | 8 of 8 pass (88 s) | The Short look test now covers Review (Shift+R) on the run. |
| `review-mode` | 9 of 9 pass (105 s) | Includes the new Captions Studio rows test. |
| `sound-finder` | 5 of 5 pass (35 s) | Bleep: 440 Hz under the bleep −10.5 dB → −137.7 dB; 1 kHz tone at −12.0 dB; outside unchanged (−10.5 / −10.5 dB). |
| `publish-pack` | 4 of 4 pass (31 s) | Includes the new palette test. |

Not run here: the rest of the e2e suite, `npm run dist:win`.

### Left

- `versions.ts` areas (test 56) when the versions branch merges; offline translation (tests 48,
  58's translation part, `captionLanguage` choosing On this PC) when the owner decides.
- A quote card's Review row reads "Quote: “…”" with its words (the design's example says only
  "Quote"); list cards read "List: <title>" or "List: n items" as the Graphics tab names them.
- The style row sits at the first caption's time; a look has no time of its own.
- The music's ducking does not treat a bleeped word as silence (a choice: a bleep is a word inside
  speech); the design does not say.
- Contract additions not yet recorded in §14.0.1: `ReviewItem.parts`, `words`, `style` and `text`
  (beside the design's `members`), `jobSoundGains`, `aiCaptionCommands`, `reviewHint` and
  `greatNotice`'s `review` argument; from fixer round 1, `lookOf` (exported),
  `bleepCutOut`, `heardBleeps`, `placesOf` (exported for its test), and `soundGains`,
  `jobSoundGains` and `bleepGains` taking the clips.


### Fixer round 1

The checkers' nine problems, each reproduced with their probe first; each fix has a test that fails
with its source change reverted (checked).

| Problem | Outcome |
|---|---|
| style-remove-wipes-later-settings (medium) | Fixed (`dff24f2`). Remove on the style row writes only the look fields (`lookOf`: `studio` without its place, `preset`, colours, background, size, lines, font) of `was` (the default for `null`) over the settings as they are; showing or hiding, speaker names, the track, the digits and a dragged place stay. `captions` is dropped only when `was` is `null` and nothing else changed. The row reads removed when the look shown is the old one. §11.8's table row says so. |
| classic-twin-left-after-remove-all (medium) | Fixed (`dff24f2`). With no marks left after a Remove of emphasis or of the style, an unedited Studio twin of a Classic look (deep-equal to `legacyTwin` of its settings, place included) goes back to the Classic look: Remove on every row of a run on a picked Boxed, or on the default Clean with style off, gives back the settings from before. A twin the user edited or dragged stays. |
| kept-emphasis-vanishes-after-style-remove (medium) | Fixed (`dff24f2`). When marks remain (kept or pending) after the style row puts back a look without a Studio look, the old look gets its twin (as Ctrl+B does), carrying the dragged place. Removing the emphasis afterwards drops the twin again; the settings are then the default ones written out, not absent (the same drawing). The `review-mode` e2e step that expected no settings after the style row (the whole-settings overwrite) now expects the Clean twin, and its removal with the marks. |
| remove-all-popups-takes-title-cards (low) | Fixed (`ae6a2ec`). The `graphic` kind reads "Graphic", "graphic", "Remove all graphics" (§10's word for pop-ups, counters, list cards and the title cards made from captions); the test that held "Remove all pop-ups" held the misleading label, so its expectation changed. |
| group-mouse-focus-drops (low) | Fixed (`8d6609b`). A click on a group's disclosure makes the group the focused row and puts the focus back on the disclosure after the click's focus release; Keep or Remove on an item makes its group the focused row first, so a long list keeps it drawn. Unit test for the disclosure; the item's part only shows in the DOM, so a new `review-mode` e2e step (260 cuts, a 150-item group) covers it (fails with the line reverted). |
| windowed-guess-skewed-by-open-group (low) | Fixed (`8d6609b`). `placesOf` leaves group rows out of the mean height it gives rows not measured yet. The e2e step checks the list grows by the open group only. |
| cut-bleeped-word-leaves-tone-and-mutes-neighbours (medium) | Fixed (`e09e513`, `ff1d06d`). A bleep whose word (its span without 0.05 s each side) the edit cuts wholly makes no sound: `heardBleeps` filters `bleepGains` (so `soundGains` and the export job) and `toneJob`, so preview and export agree. A word the edit keeps part of keeps its whole bleep. A bleep of an estimated time (widened 0.15 s) goes only once its word and 0.1 s each side are cut. |
| CMD-1 (high) | Fixed (`6653256`). A request for the AI fix that comes while Clean up reads its saved choices waits for them and ticks the box on top of them (saved); if they cannot be read, the box is ticked without saving. Unit tests from another tab with saved Strict, and with nothing saved; `publish-pack` e2e now runs Fix captions with AI first from the editor's first tab with Bleep Standard saved. |
| CMD-2 (low) | Fixed (`aa587ae`). With the most translations (8), Translate captions with AI… and Add a caption language… leave the form closed, say "A project keeps at most 8 translations: remove one to add another" and focus the list; Translate in a form left open when the project filled sends nothing and says the same. |

Verification after the round: typecheck exit 0; full vitest 405 files, 5526 tests pass; build
exit 0; e2e on the built app, each file once: `review-mode` 10 of 10, `publish-pack` 4 of 4,
`sound-finder` 5 of 5, `captions-studio` 8 of 8.

### Fixer round 2

The checkers' nine problems, each reproduced with their probes first (the review probes also at
`9ed0094`); each fix has a test that fails with its source change reverted (checked, part by part
for the Remove rules).

| Problem | Outcome |
|---|---|
| style-remove-keeps-auto-speaker-names (medium) | Fixed (`2e9a858`). The style record notes `names: true` when the run turned speaker names on with its look (Auto style's speakers rule; kept through a later run), and Remove on the style row drops them unless the look from before had them. Names the user had or turned on stay; the reader keeps the note. |
| emphasis-remove-drops-digits-twin (medium) | Fixed (`60928a0`). The twin automation makes for its emphasis is recorded (`captionAuto.twin`, `none` when there were no caption settings): Make my captions great and Find important words write it (`withAutoTwin`), and so does Remove on the style row when it gives the look put back a twin for emphasis still pending. Remove takes away only that twin, unedited, and only when no marks, digits (other than as written) or dragged place need it; a twin the user had (Ctrl+B twice, the Digits choice) stays. With `none`, Remove on every row in any order gives back no caption settings (round 1 wrote the defaults out). Settle rule 5 drops the record once no mark is pending or the captions have no Studio look; Keep drops it too. The `review-mode` e2e step that asked for no `captionAuto` after Remove on the style row held round 1's behaviour; it now expects the twin record, and no settings and no record after the emphasis is removed (`785cbd9`). |
| style-remove-loses-drag-without-marks (low) | Fixed (`60928a0`). A dragged place counts as needing the twin on the style path, so the Classic look put back gets its twin with the place, also with no marks left. |
| twin-named-your-style (low) | Fixed (`69cd6c8`). `lookName` names a Studio look whose `from` is a Classic preset by the Classic look ("was Clean", "was Boxed"), in the row and its accessible name. |
| point-word-bleep-dropped-without-cut (medium) | Fixed (`623a27e`). For a word timed with no length, `bleepCutOut` keeps the bleep while a kept clip reaches its instant: a split on the word or deleting the word before leaves it muted and toned; a cut over it still drops it. |
| riding-swear-word-unbleeped-after-delete (low) | Fixed (`9759977`). Tidy captions skips a swear word only for its own bleep: one of the same word over its middle, centred in it or over all of it. A short word right after another swear word (different or the same word) gets its own bleep, masked and muted over all its time, also after the first is deleted; a second Tidy adds nothing. |
| CMD2-R1 (medium) | Fixed (`f4207ad`). Every Languages request sets a counter, so it renders and its focus moves at once; no focus is left waiting for the next edit. The unit harness gains `renderIfChanged` (renders only after a state change, as React does), and `publish-pack` e2e runs the command again from a caption and types there (fails without the fix). |
| CMD2-R2 (low) | Fixed (`f4207ad`). "A project keeps at most 8 translations…" (and "Every language on the list is added already") goes once it no longer holds. |
| CMD1-T (low) | Fixed (`86946b4`). A unit test with the saved Clean up choices unreadable: the AI fix ticked and focused, nothing saved. It fails with either mutation the checker named. |

Contract additions: `CaptionAuto.twin`, `CaptionAuto.style.names`, `withAutoTwin` (`marks.ts`),
`settleTwinRecord` (`captionAutoSettle.ts`), and the test harness's `renderIfChanged`.

Verification after the round: typecheck exit 0; full vitest 405 files, 5541 tests pass; build
exit 0; e2e on the built app, each file once: `review-mode` 10 of 10, `publish-pack` 4 of 4,
`sound-finder` 5 of 5, `captions-studio` 8 of 8.
