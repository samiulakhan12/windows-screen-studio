# Build report: auto-blur private information (wave 13, F-07 and LT-05)

Branch `feat/wave13` in `/home/user/wt-w13`. Design: [`docs/design/auto-blur.md`](docs/design/auto-blur.md)
(§0 holds the owner's decisions, §16 the files and parts, §17 the tests, §19 what the first version
taught). The branch starts at `d92ce61` (every wave through wave 12 at `37f9355`, plus the design and its
evidence), then the contracts step, the five parts merged in the design's order (P1, P3, P2, P4, P5),
and the integration step this report closes. This is a rebuild: a first build of an earlier version of
the design was finished and reviewed, then lost before it was pushed; this one was written against the
design that folds in what that build learned.

## What was built

Find and hide private information on the screen and in what is said, on this PC, with solid covers that
every output draws (F-07, LT-05). In the parts' words, shortened:

* **Contracts** (§16.0): the data model (`Project.covers`, `Project.privacy`, paths of keys "t x y w h"
  with union keys between analysed frames), readers and writers that never shrink a box, the legacy
  `~cover:` shapes an older Flown draws, the drawing core (`coverScreen` after the crop and grade, again
  on the output), `privateView` for every text that leaves Flown, the seams of every output path of §9,
  the catalogues' `privacy` namespace, `guard-delta.mjs`, `make-track-fixtures.mjs`, and the equivalence
  guard (test 20) committed alone first, its digests never regenerated.
* **P1, covers in the editor** (§16.1): the Shapes tab's *Private info* section and *Cover* tool, the
  Cover section (box, times, colour chips, *Follow what is under it*, *Cover this text everywhere*, Keep
  covered and Uncover), the Covers row (group bars, roving focus, one undo step a drag), the preview's
  handles, Peek and its magnified view, Listen, the note under blur and pixelate with *Turn into a
  cover*, multi-select and group edit of covers, filmstrip fills, and the guide's blur buttons adding
  covers coloured from the step's own shot frame (decision 12).
* **P3, the text rules** (§16.3): emails, keys and tokens (36 strong rules), secrets in links, strong
  labels, passwords and codes, cards, IBANs, phones (vendored libphonenumber-js 1.13.16), IDs, QR codes,
  names (vendored double-metaphone 2.0.1), rows, PEM blocks and recovery grids, and secrets said aloud
  (digit runs across sentences and captions). 203 vectors; on the evaluation set 233 of 233 found.
* **P2, the reader** (§16.2): `ssw-ocr` (Rust, tract, PP-OCRv6 tiny and small), models hashed before
  parsing, reads seeking to the key frame, tiles and chunks, the careful-long pass, the look pass,
  follow sessions, QR decoding, crash guards (panic hook, `SetErrorMode`, `WerSetFlags`, a job object);
  main's download through `downloadPinned` and one shared reader state; packaging, notices, the
  installer's WER value.
* **P4, the scan** (§16.4): the look data and read plan, the walks that follow found text (forward and
  backward, lost areas, speed guide, zoom candidates, re-anchoring, evidence of absence, the typing rule),
  pop-up notifications, found covers merged with the user's, the rules in a worker, Find's channels, Follow
  and *Cover this text everywhere* on the one helper, copies.
* **P5, panel, Review, export notes, Polish and Settings** (§16.5): Review's private rows (Check first,
  places as parts, Peek, Listen, Peek while reviewing with V, Keep all and Uncover all of a kind, Done
  reviewing), the Find dialog and its regions dialog, the progress and result lines, leaving during
  Find, the export dialog's note (Wait for Find, Stop Find and export, Bring them over), the copies
  offer, Polish's row, Settings › Private info, and the notes in the transcription, translation, guide and
  publishing flows.

### What integration found and fixed

Each fix is its own commit with a unit test that fails without it (checked by putting the old code back):

1. **Every Find blacked out the video.** The scan opened a backward follow session as `from > to`; the
   helper only takes `[from, to]` with `to ≥ from` and answered `bad-command`; the scan swallowed the
   error and covered every hit as a lost area from its read to the end, its box grown over the whole
   scrolled page (13 of 77 covers were the whole frame for the whole minute). The first A1 run passed
   only because everything was covered; A1 and A16 now also check that the covers hide at most a quarter
   of a frame on average. Fixed in `scan.ts` (55196fd).
2. **Text scrolled off the screen stayed covered to the end.** A forward walk had no rule for its text
   leaving the frame (the backward walk has its mirror); the lost area became the whole page and a
   template search over a page of text always finds a part above the absence score. Fixed in `paths.ts`
   (62bbb8e).
3. **A fast scroll that brought text in was taken for a page change.** Going back, the cover started
   after the scroll, with the text on screen for the frames before. A change the look pass saw as a move
   is now a move (fecb3a0).
4. **A scrolled text showed for one frame as it left the screen.** The frame where it stopped matching
   (cut at the edge) was given the box held before it, as for a fading glyph; now the lost area holds
   it when its region moved (3d64b0b).
5. **The guide's *Blur an area…* and every new cover took Dark, never the colour around the text**: the
   hidden video was read without `crossOrigin` (a tainted canvas, ef23af6), and was sought before its
   metadata, which a browser takes as a start position with no seek (57f8f11).
6. **Review's private rows squeezed their title into a column one letter wide** (the row did not wrap
   its info and action lines, e3d492d).
7. **A test hook for the reader's download** (A9): `SSW_READER_BASE_URL`, read only by an unpackaged
   app, as the speech models' hook is (4d385a4).


## The owner's answers as applied (§0)

Decisions 1-12 were accepted on 17 November 2026 and are built as decided. Questions 13-19
(`owner-answers.md` in the build's scratch folder, read again before the work on 17 and 18):

| Question | Answer | As built |
|---|---|---|
| 13 Home thumbnails and the crop | (a) draw the thumbnail through the crop | Home's thumbnail fills the covers and blur and pixelate shapes at its time and is drawn through the crop (A5) |
| 14 Windows Error Reporting exclusion | (a) the installer writes `ssw-ocr.exe = 1` under `ExcludedApplications`, HKLM for all users, HKCU for one user, removed on uninstall | `build/installer.nsh` (P2); the helper also sets `WerSetFlags(NOHEAP)` and ends without a report on an unhandled exception |
| 15 Invented secrets in the repository | keep them gzip-compressed | the evaluation set's truth and reads are `.json.gz` (contracts) |
| 16 Careful pass | careful-long | `READER_ID` `pp-ocrv6-tiny+small-careful-long`; P3's `needsCareful`, P2's `careful` command |
| 17 The three English texts that promised blur hides everything | (a) change them, in one commit of their own at integration, before the English guard is re-recorded | changed in a commit of its own (314fc1d) with §0's exact words: the Blur and Pixelate tooltips and the Animation note; the shape table's English data and its scanner entry follow; `autoBlurCatalogues` pins the three new texts and every other English message at 37f9355. `guard-delta` ran on the merged tree before it (only additions) and after it (only additions, and the Blur tooltip's change); the baseline was then re-recorded |
| 18 Crop or muted part as hiding | (b) not hiding | `hidesSomething` counts covers, blur and pixelate shapes and bleeps only (`CROP_HIDES` false); test 25, A4 |
| 19 Where decision 7's texts are masked | (a) `privateView` | masked where they leave Flown or are drawn; the stored text stays as written (A7) |

## The first version's 37 findings and 6 items left undone

The first build's independent review confirmed 37 findings (and refuted 3). The design's §19.1 says how
this version prevents each; the table adds what checked it in this build. Unit tests are §17.1's numbers
(each its own test, each seen to fail without its rule's code by the part that wrote it); A-numbers are
`tests/e2e/auto-blur.e2e.cjs`.

| Finding | What went wrong in the first build | Prevented now by | Checked by |
|---|---|---|---|
| 3 | A cover lagged one move behind before the first read when following backward | the backward walk uses the move between f and the next analysed frame; union keys between analysed frames (`stepKeys`) | tests 146, 186, 187, 229; A1, A16 every source frame. Integration found two more ways a backward walk could start late or end early on real data and fixed them (below) |
| 4 | A diagonal lost area was drawn as a one-axis band | `lostBox`: the 2-D union of the box, every candidate and every changed region | tests 142, 230; A16 `window-drag` |
| 5 | Stacked toasts | `notices.ts`: each notice and the stack's union | test 149; A16 `toasts` |
| 6 | Reads of HiDPI frames landed off the text | reads at the recording's own pixels, tiled, never scaled; sizes times the display scale | tests 138, R18; A16 at 150% and 200% |
| 7 | `limitCovers` was quadratic | heap merging over each cover's 8 nearest | tests 13, 152 (twice the input, at most 2.3 times the time) |
| 10 | A spoken number said across sentences and number words was missed | the digit stream across captions and full stops; `and` ends a run | test 129; A7 |
| 11 | The matcher was built from the padded span | own spans for everything that finds text again; spoken forms from the hit's own words | tests 127, 192; P3's hits keep their own word span |
| 12 | Chapter title cards were not masked for spoken secrets | `privateView` masks `titles[]` where they are drawn | tests 22, 191; A7 (chapter names) |
| 13 | Tidy captions kept real words under private bleeps | masking by time, whole span when words do not line up | tests 18, 23; A7 (SRT, VTT, translation) |
| 14 | `saidStale` lost when captions changed during Find | `captionsSig` taken at Find's start | test 170 |
| 16 | A cover drag overwrote Find or Follow results arriving meanwhile | results through `afterGestures`, merged against the current project | tests 61, 170; A8 (a timeline edit during Find kept with the results) |
| 17 | `readCovers` was quadratic on huge projects | one linear pass | test 3 |
| 18 | Copy and paste of a cover pasted old items or an image | snapshots at copy time, own project only, no OS clipboard | tests 49, 72; A12 |
| 19 | Opening a version settled its suggestions | no settle step for covers; edits drop `found` themselves | tests 52, 201 |
| 20 | Covers past the total-key limit loaded coarser | writers never exceed the limits; readers only grow boxes | tests 2, 188 |
| 22 | A line box rounded past the frame's edge | clipped, never rounded past the edge | test 127 |
| 23 | A failed read was dropped silently | a lost area and the failed-reads line; caps answer `partial` | tests 84, 154, 222, R21; A10 |
| 24 | Names with a leading star were written to logs | stars stripped, names joined to `secretValues()` | test 35 |
| 25 | No heartbeat during the helper's open phase | heartbeat from start | tests 81, R1 |
| 26 | A failed reader download was not shown | `privacy.find.readerFailed` with *Try again* | test 79; A9 (a wrong file refused and said) |
| 28 | The names list was not reloaded after *Cover this text everywhere* | dialogs read the list again | test 62 |
| 29 | The panel and Settings kept separate reader states | one shared `useReaderState` | tests 91, 179, 184; A9 |
| 30 | The export note's buttons did not close the dialog | close first, then open | tests 174, 249; A18 |
| 31 | Focus going into and back from the Private info panel | §11's focus rules | test 168; A11 |
| 32 | Review's *Show all changes* lost focus | §11 | test 166 |
| 33 | Peek and Listen's labels missing from their accessible names | names include the row's title | test 167; A11's audit |
| 34 | The filtered empty Review list had no message | `privacy.review.emptyKind` | test 166 |
| 35 | The Check bar's line style | dashed waiting edges, `--warning` for Check, a text badge | test 66 |
| 36 | Selection did not follow focus on the Covers row | §11 | test 67; A11 |
| 37 | Focus after Follow's *Stop* and *Keep* | *Stop* keeps focus on *Follow*, *Keep covered* moves it to the section's title | tests 61, 213 |
| 1, 2, 8, 9, 15, 21, 27 | Not recorded by name (the outputs and finding lenses) | §9's row for every output path; the P4 walks | test 20 (equivalence), A2 and A2a-A2g (every output made from two recordings and compared, with a control that differs without covers), A1, A16 |

The six items the first build left undone:

| Left undone | Done here |
|---|---|
| Multi-select and group edit of covers | P1's `coverGroup.ts` and the group branches (tests 70-72, 75, 209); A12 selects three covers by Ctrl+click, checks the count and the disabled fields' reasons, changes colour, deletes and undoes, copies and pastes, and turns three blurs into covers |
| A16, the rendered tracking set, run end to end | `make-track-fixtures.mjs` (contracts) rendered by the e2e file; A16 runs Find on every case and on the evaluation frames at 150% and 200% and the held-out seed, and checks every planted item's ink in every source frame |
| The guide's *Blur an area…* coloured from whatever frame was paused | P1's `blurArea` at the step's own shot time. Integration found it still gave Dark in the app: the hidden video was read without `crossOrigin` (a tainted canvas) and was sought before its metadata. Both fixed with unit tests; A14 checks the colour is the step's shot frame's (red), not the paused frame's (blue) |
| Re-reads decoding from the start of the recording | P2's reads seek to the key frame before each read (R16: a read at 19 minutes decodes 11 frames) |
| Numbered tests folded into one file | every §17.1 number is its own `it`, checked by `autoBlurNumbers.test.ts` and each part's own count |
| A2's variants only as unit tests | A2a joins, A2b the 9:16 follow copy made from the Copies menu, A2c a title card's blurred background, A2d the raw-frame and WebCodecs routes, A2e the guide's shots and its PDF and HTML pictures, A2f motion blur, a magnifier and a blur shape, A2g a cropped project with and without a grade and a LUT |


## Tests

### Unit tests (vitest)

- §17.1's numbered tests (1-258, each its own `it`, the numbers checked by `autoBlurNumbers.test.ts`) in
  48 `tests/autoBlur*.test.ts` files, plus integration's seven regression tests (the follow session's
  `[from, to]`, the forward exit, the backward scroll-in, the scroll-out frame, the hidden video's
  `crossOrigin` and metadata seek, Review's private row wrap, the reader's test mirror). Each was seen to
  fail with the old code put back, then pass.
- **Full run on the final tree** (`--maxWorkers=2`, private TMPDIR): 662 files, 8,597 tests: 8,586
  passed, 8 skipped, 3 failed. Run alone afterwards: `bleepBangla` "reads words joined by a hyphen…"
  passes (load); "bleeps them written another way…" is the known timeout (5.3 s against 5 s, a fix is
  on another branch); test 69 (`i18nExtractionLog`, every row of `x2.json`) failed because question 17
  changed three messages the extraction log records; the test now knows those three, each only at
  exactly §0's wording (3d00650), and passes. The first full run of this step, on the merged tree before
  integration's changes, had 8,579 passed and the known failure only.
- Both typechecks clean; `npm run i18n:check` passes (5,780 English messages, 26 namespaces);
  `npm run -s build` passes; `npm run notices -- --check` up to date.

### Native

- `node scripts/build-native.mjs --require` in this worktree (its own `native/bin` copy): every helper
  built, `ssw-ocr.exe` within `OCR_BUDGET` with exactly `OCR_IMPORTS`.
- `node scripts/build-native.mjs --ocr-host`: the host helper for the e2e runs, built into this
  worktree's `native/ocr/target/host` and copied to `native/bin/ssw-ocr`, then taken out of `native/bin`
  again so the English guard and the other e2e files see the canonical `native/bin` (with a host
  `ssw-ocr` the Shapes tab shows the reader's download line); the e2e file finds the build in
  `native/ocr/target/host/release`.

### The English guard

`guard-delta.mjs` on the merged tree after a warm-up launch: only additions (tab-shapes 7 elements, the
new settings-04 capture and 28 elements in each settings capture, palette-empty 5, shortcuts 10). After
question 17's commit: the same, and the Blur tooltip's new words. The baseline was re-recorded from two
identical runs (1ffd5ea), and A17 runs the guard in compare mode against it: passes.

### End to end: `tests/e2e/auto-blur.e2e.cjs`

Run whole once on the final build with the host helper and the models in each test HOME's userData
(`SSW_OCR_MODELS`, checked by size and SHA-256), and the pictures saved (`SSW_E2E_DOC_SHOTS=1`).
34 cases pass, 18 fail:

| Case | Result |
|---|---|
| A1 Find on a 60 s recording of eight frames with scrolls | **fails**: 20,187 of 20,495 item-frames covered (the misses on scroll frames, What is left 2); Find 345 s; Review lists 83 rows, Check first; Done reviewing keeps them |
| A2: MP4, WebM, MOV CineForm, GIF, transparent background, 120 fps, batch, per-chapter parts with their thumbnails, thumbnail PNG and the export dialog's preview, the guide's shots and PDF and HTML pictures, the timeline's This export | **pass**: every output identical over the two recordings (byte-identical files where deterministic) |
| A2 control | **passes**: without covers every one of those outputs differs, so the comparison sees what is under the covers |
| A2a joins, A2b 9:16 follow copy, A2c title card's blurred background, A2d raw frames (MP4, WebM), A2f motion blur, magnifier and blur shape, A2g crop, crop with a grade and a LUT | **pass**, identical |
| A2d WebCodecs | **passes** within its own repeatability: the same recording exported twice differs on up to 0.22% of a frame's pixels by more than 2 levels, so the whole frame is held to 0.5% and the secrets' places to 2% (at most 1.38% measured; the planted noise would make nearly all differ). §17.3's 0.1% cannot hold for this encoder |
| A3 Peek and Listen | **passes**: exports with Peek on identical over the two recordings; the tone gone under the private bleep with Listen on |
| A4 The original recordings | **passes**: the chip disabled with its reason; a stored choice exports with the notice and no media folder; main refuses the forged request |
| A5 Home thumbnail | **passes**: a Dark box at the cover's place, drawn through the crop |
| A6 Old projects and older Flown | **passes**: nine old projects saved byte for byte as the build of 37f9355 saves them; covers saved with two legacy shapes each; that build's export hides the secrets (within 8 levels of encoder noise) and draws each box solid |
| A7 Spoken secrets | **fails**: the card number and code are bleeped and the AI requests hold none of their digits; the new Spanish translation did not replace the one made before Find within 30 s |
| A8 One undo step | **passes**: Find's results one undo and one redo; a zoom added during Find kept |
| A9 The reader's download | **passes**: from a local mirror, resumed with Range after a cut, Remove, and a file that is not the pinned one refused and said |
| A10 A crash in one read | **passes**: the helper started once more, the failed reads recorded and said, lost areas covering them |
| A11 Keyboard and screen reader | **passes**: the flow by keyboard, the focus rules, one tab stop on the Covers row; the in-test audit (names, references, ids, dialogs, menus) finds nothing |
| A12 Multi-select | **fails** at its last step in this run (the Shapes tab not reopened before *Turn them all into covers*; the driver is fixed in 9d0e8b4 and not run again); the count, the disabled fields' reasons, colour, delete, undo, copy and paste passed |
| A13 Polish with Find private info | **fails**: the covers hid 51% of a frame on average (What is left 1) |
| A14 The guide's Blur an area | **passes**: the cover is red, from step 2's shot frame, with the playhead on the blue page |
| A15 Follow and Everywhere | **passes**: the followed cover holds the email while it scrolls away; every place of the text covered |
| A16 tracking set | `tooltip` and `type-email` **pass**; `list-scroll`, `flick-scroll`, `browser-zoom`, `sticky-header`, `toasts`, the 150% and 200% sets and the held-out set **fail** the blackout check (28-100% of a frame covered); `select-text`, `window-drag` and `type-key` fail coverage (What is left 4) |
| A17 English guard | **passes** |
| A18 Export during Find | **fails**: the note showed *running*, *Wait for Find* kept Export disabled until the results were in, then Find's own coverage check found 9 item-frames of one scroll frame uncovered, so the export and *Stop Find and export* checks after it did not run |
| A19 Leaving during Find | **passes** |
| A20 Copies made before Find | **fails**: Bring them over and Also cover the copy work, but the clip's export differs over the two recordings on 209 of 1,145 frames (the scroll frames of What is left 2) |
| A21 Review at speed | **fails**: 201 rows, V turns Peek while reviewing on, 100 rows kept by keyboard, but the magnified view was gone afterwards |

@@E2E@@


## Sizes

| What | Size | Against |
|---|---|---|
| `ssw-ocr.exe` (MinGW, mixed profile, `build-native --require` here) | 16,323,072 B installed, 4,084,828 B at brotli 11 | `OCR_BUDGET` 17.2e6 / 4.3e6 (P2 set it to the measured size; the design's 3.9e6/16e6 was exceeded), under decision 1's 5 MB line; its imports are exactly `OCR_IMPORTS` |
| The other helpers, rebuilt | `ssw-capture.exe` 453,120 B; `ssw-speech.exe` 3,611,136 B; `ssw-speech-compat.exe` 3,478,528 B; `ssw-llm.exe` 7,320,576 B | each within its own budget (build-native checks them) |
| Host `ssw-ocr` (Linux, the e2e runs only, not shipped) | 17,361,384 B | |
| `out/main` | 6,494,296 B (+538,239 against the build of 37f9355) | the scan, the rules worker, the vendored libphonenumber-js and double-metaphone (432,283 B of source) |
| `out/renderer` | 35,079,669 B (+448,575) | |
| `out/preload` | 28,730 B (+2,680) | |
| The reader's models, downloaded on request | 27,608,757 B | five files, pinned by size and SHA-256 |
| `resources/THIRD_PARTY_NOTICES.txt` | 753,403 B | `npm run notices -- --check`: up to date |


## What is left

Found by this integration and not fixed here (each needs design or measuring work beyond integration):

1. **Find blacks out recordings that change page or zoom.** When a walked text is lost over a region that
   changed as a whole (a page change, a cut, a browser zoom, a toast stack), its lost area is that whole
   region, and it ends only with evidence of absence: a read lacking the text **and** a template search
   that fails everywhere in the area. Over a whole page of text the template search always finds a part
   above the absence score, so the lost area lasts to the end of the recording. Measured: the evaluation
   frames at 150% shown 0.5 s each (a cut every 0.5 s) were 86% covered on average; A16's `toasts` 100%;
   the list fixtures 28-30% (half their rows are secrets, so part of that is right). Scrolls are handled
   (fixes 2 and 3 above); page changes and zooms are not. A fix belongs in §5.8's forward evidence rule
   (for example: a read lacking the text is evidence by itself when the lost area is a changed region far
   larger than the text, or the template search only near where the text was), with tests, before release.
2. **Covers start a frame or two late on some scroll-ins.** A1 (60 s, eight frames with 1 s scrolls)
   covered 20,187 of 20,495 item-frames (98.5%); the misses are all on scroll frames, mostly the first
   frames of a scroll bringing text in from the bottom, and one frame mid-scroll where the look pass
   seems to lose the move; A18's short recording missed 9 item-frames on one scroll frame. The exports
   still compare identical over the two recordings only where covers exist; these frames show the text.
3. **Find is about ten times slower than its budget.** A1's 60 s recording took 330-345 s (5.5 times
   the recording's length; §5.11 budgets 0.45-0.55 times). Profiled through the helper's protocol: 8
   reads and their careful passes took 69 s; 154 `track` commands of the follow sessions took 268 s (up
   to 64 s each), 273 `match` commands 33 s. Registering a track at a frame the session has not decoded
   near seems to decode far; P2's follow session and P4's walk order need measuring together.
4. **A16's other cases.** `tooltip` and `type-email` pass (every planted item covered in every frame).
   `select-text` 600 of 720 item-frames covered, `window-drag` 194 of 240, `type-key` 0 of 118 (no cover:
   the secret typed into a terminal is never found), and the scale and held-out sets fail on item 1.
5. **Other e2e results**: see Tests. A7's new Spanish translation did not replace the one made before
   Find (the export used the old one, masked); A13 (Polish) covered 51% of a frame on average on the short
   recording; A21's magnified view was gone after 100 rows kept by keyboard.
6. **The scan swallows a walk's error.** `followAll`'s failure is caught and every hit becomes a lost
   area to the end, silently: that is how item 1 of *What integration found* hid. It should at least log
   the error's kind (never text) and say so in Find's result.
7. **Left from the parts' reports**: Cover this text everywhere does not show Find's estimate line;
   copies made by Cover this text everywhere are the user's, not suggestions; the Covers row sits after
   the Graphics row and CoverSection at the top of the Shapes tab (a contracts placement, not §2.3's);
   readerHelper's `pauseWhileRecording`, `findFailureOf` and `carefulLines` are duplicated in the scan;
   the publishing pack's share and description sidecar were not checked for spoken-secret masking (only
   Copy was); CopiesOffer reads the copies' `project.json` from disk (a press before autosave reads the
   older file); P1's section shows Find's result only in Review's header and an editor notice.
8. **The design's text** differs from what was built in P2's tiling (ceil-count tiles, not a 64 px
   overlap) and `OCR_BUDGET`, P3's padding at line ends, continuation gap, one-word speech secrets and
   false-hit corpora, and the follow session's `[from, to]` order; the design was not edited here.
9. **Not run here**: `verify-dist` (no Windows installer was built: electron-builder's Windows Electron
   is not cached and nothing is downloaded); axe-core (not installed, and installing is not allowed here:
   A11 audits names, references, ids, dialogs and menus itself); the Rust tests and `npm run test:native`
   (P2 ran them; the helper's sources did not change since).


## What needs a person

1. **The Hugging Face mirror** (decision 10, a release blocker). Create Qbexel's own model repository on
   Hugging Face (nothing was created or uploaded here), upload these five files byte for byte at these
   paths, with PaddleOCR's Apache-2.0 licence text and a NOTICE (the text of
   `resources/notices/41-paddleocr-models.txt` names the models and their upstream repositories), then
   set `READER_MIRROR` in `src/shared/privacy/readerCatalog.ts` to the repository and its commit.
   `verify-dist` fails a `FLOWN_RELEASE=1` build until it is set. 27,608,757 bytes in all:

   | File (path in the mirror) | Bytes | SHA-256 | Upstream, pinned commit |
   |---|---|---|---|
| `PP-OCRv6_tiny_det_onnx/inference.onnx` | 1,780,590 | `193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8` | `PaddlePaddle/PP-OCRv6_tiny_det_onnx` at `2ba1506c0380` |
| `PP-OCRv6_tiny_rec_onnx/inference.onnx` | 4,462,639 | `9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6` | `PaddlePaddle/PP-OCRv6_tiny_rec_onnx` at `2612ab37152a` |
| `PP-OCRv6_tiny_rec_onnx/inference.yml` | 55,571 | `66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1` | `PaddlePaddle/PP-OCRv6_tiny_rec_onnx` at `2612ab37152a` |
| `PP-OCRv6_small_rec_onnx/inference.onnx` | 21,159,378 | `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634` | `PaddlePaddle/PP-OCRv6_small_rec_onnx` at `b8f84f0b80c5` |
| `PP-OCRv6_small_rec_onnx/inference.yml` | 150,579 | `ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1` | `PaddlePaddle/PP-OCRv6_small_rec_onnx` at `b8f84f0b80c5` |

2. **§0 decision 8's checks on the reference Windows PC**: R8 (killing the helper kills its ffmpeg) and
   R10 (the Windows reader, `WINDOWS_READER_ALLOWED` stays false until it passes: 95% or more pattern
   recall and 99% or more padded coverage) with `cargo test` on Windows; the helper's speed, memory and
   size at 1080p, 4K and 7680×2160 (§5.11), including Find's wall time, which this machine measured far
   over its budget (see What is left); the 30 real recordings (97% or more covered, nothing found ever
   shown) with their units distribution; pop-up false hits at most one per 10 minutes; and that the WER
   registry value and the run-time flags leave no crash report.
3. **The native Bangla review** (§12.4): the spoken word lists, the Bangla label tables of
   `src/shared/privacy/detect/tables.ts` and the `privacy` catalogue's Bangla messages, through
   `docs/design/output-and-languages.md` §15. No translation was written here.
4. **The other account's optional `private.json`** (decision 9, §18): ask for it; this wave works
   without it and reads nothing of it.

