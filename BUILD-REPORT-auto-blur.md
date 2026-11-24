# Build report: auto-blur private information (wave 13, F-07 and LT-05)

Branch `feat/wave13` in `/home/user/wt-w13`. Design: [`docs/design/auto-blur.md`](docs/design/auto-blur.md)
(§0 holds the owner's decisions, §16 the files and parts, §17 the tests, §19 what the first version
taught). The branch starts at `d92ce61` (every wave through wave 12 at `37f9355`, plus the design and its
evidence), then the contracts step, the five parts merged in the design's order (P1, P3, P2, P4, P5),
the integration step, the rounds of fixes after it, and the final verification this report closes
(`fix/bleep-speed` merged, then every check run on the final tree). This is a rebuild: a first build of
an earlier version of the design was finished and reviewed, then lost before it was pushed; this one was
written against the design that folds in what that build learned.

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


### After integration: the rounds that finished it

Integration left 17 of `auto-blur.e2e.cjs`'s cases failing and nine items in *What is left*. Rounds of
fixes followed on this branch. Each cause was reproduced and traced before it was fixed (the helper's
protocol log, the walks' debug logs, the look pass's move scores, frame dumps, headless Finds against
the truth files); each fix has a unit or Rust test seen to fail with the old code put back; each changed
rule was written into the design in its commit, §0 unchanged. The numbers are A16's and A1's own lines:
the share of a frame the covers hide on average (the blackout check allows 25%) and the item-frames
covered.

1. **The blackout** (ae38d39 to 3a6e3e2). Six causes. A backward follow session over one instant
   `[t, t]` decoded nothing (the helper answered `frames: 0`, then `error: video`) and the scan turned
   the error into whole-frame covers to the end; at each 0.5 s piece edge a newer frame stood in for the
   one asked, so backward walks froze while the text scrolled on (helper; R23, R24). The look pass
   reported a move only for regions 12 tiles wide or more, and A16's lists are 10-11 (R25: 4 wide and 6
   tall), and a list repeating each secret every 12 rows lost every walk over its column to a copy that
   tied with the text. At each page cut the look pass reports a fake move (0.06-0.45, against 0.75-1.0
   for real scrolls) that ended or started walks by chance, and on a page of other text the absence
   search always found something at 0.5, so a lost cover never ended: a weak move is now only a
   candidate, and a text is gone only with no part at 0.5 where its own motion puts it and nowhere else
   in its region a clear match or a part at 0.85; walks ask where the text's own motion and its region's
   move put it before any copy. The renderer merged covers of one text whose boxes overlapped at any
   moment into one box over every row between (now only when they overlap throughout the time they
   share). *Cover this text everywhere* searched for the cover's text with the word beside it, which the
   read's margin took in (now only the characters inside the box). The sixth was the round's own first
   rules, which took a text partly under a tooltip for gone and placed a scroll of more than a line a
   frame on a similar line above (e02ffdb, 3a6e3e2; no A1 item-frame covered before is uncovered after).
   A13 went from 51.1% to 19.3% and passed, toasts from 100% to 2.7%, A1 from 17.0% to 11.1% (20,187 to
   20,293 of 20,495 item-frames).
2. **Covers late on scroll-ins** (29747f2 to 7450c6a). A strip scrolling in at the frame's edge is under
   the 6 tiles the look pass needs for a move and its text is cut, so a backward walk took it for a page
   change and started 1-2 frames late: the walker's own motion is now its region's move or the speed
   guide, and the union is held while the box is partly out. The first move after still frames was
   spread over them (3.6 px a frame instead of 36); a text cut at the edge was placed by a false zoom
   140 px away (a text leaving the frame is no longer tried at other scales or copies); a burst the
   recording ends in is read at its last source frame. Two fixture points: the tracking set planted its
   passwords with no label line, which §6.7 and decision 2 never find (0f14105 adds the label; the set's
   e2e cache is now keyed by its generator), and the end-to-end Finds add the GB and BD phone regions the
   evaluation truth was scored with (e38d3df; see *For the lead*). A18's export was judged by one colour
   a box and failed where a white lost area had a dark cover drawn over part of it, with nothing showing:
   it is now judged pixel by pixel against the colours of the covers drawn there (7450c6a). A1 went to
   20,495 of 20,495 at 8.6% and passed, A13 to 13.3%; A18, A20, select-text, window-drag and list-scroll
   passed.
3. **The typed key and silent walk failures** (7ae6374 to fc7c095). Typing the key and deleting it was one
   burst, read once after the deletion through an area that cut the label (it read `CCESS_KEY=Q`): a
   burst on one line that then changes in place is now also read where it showed the most, over its line
   from the frame's left edge. The cover then ended a frame early, because the forward hold for text
   deleted in place needed a typing hint (now the backward rule's mirror). type-key went from 0 to 118 of
   118. A walk that fails now logs its error's kind (never its text) and Find's result says how many
   items were not followed (`privacy.run.notFollowed`); the helpers readerHelper and the scan duplicated
   live in `helperUse.ts`.
4. **The UI items** (`feat/w13-fx`, merged at 53272ca). *Translate again* was enabled only when the spoken
   text changed, so captions masked after Find could never be translated again (A7's driver had pressed
   the *Add a language* form's Translate and seeded its Spanish track with a hash that made it look out of
   date, which hid it). The magnified view draws the frame at the playhead, and K and Delete moved rows
   without seeking (A21; `peekStill` now holds the playhead inside the selected row). The publishing pack
   sent the project's name, which *Use as the recording's name* takes from the pack's title, unmasked in
   the share post, the description file and a browser frame's title bar. The copies offer and the export
   note now have the editor's saver write the project before main reads it; *Cover this text everywhere*
   shows Find's estimate and its places are suggestions in one Review row; the Covers row and the Cover
   section stand where §2.2-2.3 say; the Private info section shows Find's result line. A7 and A21
   passed.
5. **Page changes, zoom, sticky headers, toasts and display scale** (ea16410 to a8dbddd). A region's move
   jumped between alias shifts from frame to frame, and the edges of the region a text moves with were
   not frame edges, so a row scrolled under a sticky header stayed lost over its column. Zoom was tried
   at four scales about the region's centre (now one zoom per region over a fine grid of scales and
   anchors, taken only when half its walkers agree). Backward follow pieces decoded to the end of the
   file, so a Find of an evaluation set ran over 20 minutes (R26). The opening frame was never read. Six
   §6.10 rules missed items at 150% and 200%, and a line cut at a tile seam left a 5-8 px gap over the
   4 px join limit; after a page change only a line holding all of a text now keeps its whole-page area,
   and a text of 1-3 characters is held only by a line that is the text. Notices were judged by changes
   not their own. Three fixture points, every planted item kept: the evaluation pages were held 0.5 s,
   under §2.9's and §5.4 point 6's limit, so the budget's thinning merged their reads and most pages were
   never read (now 6 s, fd616dd); the toasts were 652 px panels living 1.15 s (now 2.8 s toasts,
   6fd8915); flick-scroll's rows were only carried past, never still (now three flicks with 5.2 s stops,
   a8dbddd). The coverage check measures a wrapped item's ink over each of its own rectangles rather than
   its union box, which takes in other words (e9ff05c, threshold unchanged). The held-out set went from
   71.1% to 16.1%, 150% from 58.7% to 13.6% and 200% from 54.5% to 7.5%, each with every item-frame
   covered; flick-scroll from 1,062 of 1,565 to 13,889 of 13,889 item-frames; toasts from 360 of 498 to
   928 of 928; browser-zoom and sticky-header from the blackout (27.9%) to every item-frame.
6. **Find's speed** (a5447ce to b99040c). A follow session decoded every frame (backward, 108 half-second
   pieces each decoding again from the key frame before it; forward, every frame), each with its
   gradient, and the careful passes queued behind the reads on one worker. Sessions now seek over frames
   not asked and work out a gradient only when asked (R27-R30), a careful worker re-reads beside the next
   read (R31), and a backward session keeps only its piece (R32). A1's Find went from 345 s at
   integration (50-56 s after round 5) to 27-28 s, within §5.11's band converted to this machine (§5.11
   records the profile); the evaluation sets from 229, 425 and 595 s to 125-130, 252-266 and 350-358 s.
7. **The design reconciled with the build** (d2ae212 to 901ef8f): see *What is left* item 8. With it,
   Find's progress and result lines show in one place at a time (A10 had met two live result lines once
   the section gained one), the section offers *Also cover the copies* with its result line (§2.12),
   A2d's WebCodecs route is proven by each output's fill where the secrets are (69f6d65), A16 prints
   fractional plan units, and A17's guard runs without the file's `SSW_OCR_` variables.
8. **The final verification** (6bda8d2 and the commit of this report). `fix/bleep-speed` merged: the known
   `bleepBangla` timeout is gone (`isSwearWord` and `bleepKey` give the same results faster; this wave
   changed only the masking functions of `cleanup.ts`, so both sides are kept as written), its spellings
   test taking 0.6 s against its 5 s limit. Then every check on the final tree, below under *Tests*.

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
- **Full run at integration** (`--maxWorkers=2`, private TMPDIR): 662 files, 8,597 tests: 8,586
  passed, 8 skipped, 3 failed. Run alone afterwards: `bleepBangla` "reads words joined by a hyphen…"
  passes (load); "bleeps them written another way…" is the known timeout (5.3 s against 5 s, a fix is
  on another branch); test 69 (`i18nExtractionLog`, every row of `x2.json`) failed because question 17
  changed three messages the extraction log records; the test now knows those three, each only at
  exactly §0's wording (3d00650), and passes. The first full run of this step, on the merged tree before
  integration's changes, had 8,579 passed and the known failure only.
- Both typechecks clean; `npm run i18n:check` passes (5,780 English messages, 26 namespaces);
  `npm run -s build` passes; `npm run notices -- --check` up to date.
- **At the final verification** (the tree of 6bda8d2, `fix/bleep-speed` merged): the full run
  (`--maxWorkers=2`, private TMPDIR) has 664 files and 8,648 tests: **8,640 passed, 8 skipped, none
  failed**, the known `bleepBangla` timeout gone; the 50 `autoBlur*` files hold the rounds' regression
  tests beside §17.1's numbers. Before the merge was pushed, `bleepBangla` alone (its spellings test
  0.6 s against 5 s) and the 143 caption, bleep, transcript and subtitle files with `autoBlurData`
  (2,551 passed, 8 skipped) passed. `npm run test:native` against the host helpers: 2 files, 13 tests
  pass. Both typechecks clean; `npm run i18n:check` passes (5,782 English messages, 26 namespaces);
  `npm run -s build` passes; `npm run notices -- --check`: up to date (753,403 bytes).

### Native

- At integration, `node scripts/build-native.mjs --require` in this worktree (its own `native/bin` copy):
  every helper built, `ssw-ocr.exe` within `OCR_BUDGET` with exactly `OCR_IMPORTS`.
- At integration, `node scripts/build-native.mjs --ocr-host`: the host helper for the e2e runs, built
  into this worktree's `native/ocr/target/host` and copied to `native/bin/ssw-ocr`, then taken out of
  `native/bin` again so the English guard and the other e2e files see the canonical `native/bin` (with a
  host `ssw-ocr` the Shapes tab shows the reader's download line); the e2e file finds the build in
  `native/ocr/target/host/release`.
- **At the final verification**: `node scripts/build-native.mjs --require` exits 0, every helper built
  (cargo found each up to date with its source) and within its budget; `ssw-ocr.exe` is 16,323,584 B
  installed and 4,086,548 B at brotli 11 with only `OCR_IMPORTS`. The host helper was built as
  build-native builds it (`cargo build --release --locked`, `CARGO_TARGET_DIR=native/ocr/target/host`)
  without the copy into `native/bin`, which holds no host `ssw-ocr`; the auto-blur run was given it
  through `SSW_OCR_HELPER`. The rounds after integration did the same. The helper's Rust tests, run
  again on the final source: the crate's 21 unit tests pass, and the CLI tests (`--profile test-fast
  --features fixture`, the pinned models, the scratch Python with numpy, OpenCV and PyYAML) pass 30 of
  32, R8 and R10 ignored as Windows only (484 s).

### The English guard

`guard-delta.mjs` on the merged tree after a warm-up launch: only additions (tab-shapes 7 elements, the
new settings-04 capture and 28 elements in each settings capture, palette-empty 5, shortcuts 10). After
question 17's commit: the same, and the Blur tooltip's new words. The baseline was re-recorded from two
identical runs (1ffd5ea), and A17 runs the guard in compare mode against it: passes.

At the final verification the guard ran alone in compare mode against that baseline, after a warm-up
launch (`smoke.e2e.cjs`): **passes** (95 s), so no text, box or picture on its tour differs from that
baseline; A17 passed again in the whole auto-blur run. Nothing was re-recorded.

### End to end at integration: `tests/e2e/auto-blur.e2e.cjs`

Run whole once on the final build with the host helper and the models in each test HOME's userData
(`SSW_OCR_MODELS`, checked by size and SHA-256), and the pictures saved (`SSW_E2E_DOC_SHOTS=1`).
34 cases passed and 18 failed in that run; A12, whose driver was fixed after it (9d0e8b4), passes run
alone on the same build, so 35 pass and 17 fail:

| Case | Result |
|---|---|
| A1 Find on a 60 s recording of eight frames with scrolls | **fails**: 20,187 of 20,495 item-frames covered (the misses on scroll frames, What is left 2); Find 345 s; Review lists 83 rows, Check first; Done reviewing keeps them |
| A2: MP4, WebM, MOV CineForm, GIF, transparent background, 120 fps, batch, per-chapter parts with their thumbnails, thumbnail PNG and the export dialog's preview, the guide's shots and PDF and HTML pictures, the timeline's This export | **pass**: every output identical over the two recordings (byte-identical files where deterministic) |
| A2 control | **passes**: without covers every one of those outputs differs, so the comparison sees what is under the covers |
| A2a joins, A2b 9:16 follow copy, A2c title card's blurred background, A2d raw frames (MP4, WebM), A2f motion blur, magnifier and blur shape, A2g crop, crop with a grade and a LUT | **pass**, identical |
| A2d WebCodecs | **passes** within its own repeatability: the whole frame is held to 0.5% and the secrets' places to 2% (at most 1.38% measured; the planted noise would make nearly all differ). §17.3's 0.1% cannot hold for this encoder. Measured again after the rounds, one recording exported twice differs by 0.16-0.31% of a frame and up to 1.33% where the secrets are, and those pooled shares let a cover 3 px short of its secret pass; each output is now also checked to show a solid fill where each secret is (69f6d65, §17.3) |
| A3 Peek and Listen | **passes**: exports with Peek on identical over the two recordings; the tone gone under the private bleep with Listen on |
| A4 The original recordings | **passes**: the chip disabled with its reason; a stored choice exports with the notice and no media folder; main refuses the forged request |
| A5 Home thumbnail | **passes**: a Dark box at the cover's place, drawn through the crop |
| A6 Old projects and older Flown | **passes**: nine old projects saved byte for byte as the build of 37f9355 saves them; covers saved with two legacy shapes each; that build's export hides the secrets (within 8 levels of encoder noise) and draws each box solid |
| A7 Spoken secrets | **fails**: the card number and code are bleeped and the AI requests hold none of their digits; the new Spanish translation did not replace the one made before Find within 30 s |
| A8 One undo step | **passes**: Find's results one undo and one redo; a zoom added during Find kept |
| A9 The reader's download | **passes**: from a local mirror, resumed with Range after a cut, Remove, and a file that is not the pinned one refused and said |
| A10 A crash in one read | **passes**: the helper started once more, the failed reads recorded and said, lost areas covering them |
| A11 Keyboard and screen reader | **passes**: the flow by keyboard, the focus rules, one tab stop on the Covers row; the in-test audit (names, references, ids, dialogs, menus) finds nothing |
| A12 Multi-select | **passes** run alone after the whole run (`SSW_E2E_ONLY='A12:'`): the count, the disabled fields' reasons, colour, nudge, delete, undo, copy and paste, and three blurs turned into covers (8 covers after). In the whole run it failed at its last step only, because the driver did not reopen the Shapes tab before *Turn them all into covers* (fixed in 9d0e8b4) |
| A13 Polish with Find private info | **fails**: the covers hid 51% of a frame on average (What is left 1) |
| A14 The guide's Blur an area | **passes**: the cover is red, from step 2's shot frame, with the playhead on the blue page |
| A15 Follow and Everywhere | **passes**: the followed cover holds the email while it scrolls away; every place of the text covered |
| A16 tracking set | `tooltip` and `type-email` **pass**; `list-scroll`, `flick-scroll`, `browser-zoom`, `sticky-header`, `toasts`, the 150% and 200% sets and the held-out set **fail** the blackout check (28-100% of a frame covered); `select-text`, `window-drag` and `type-key` fail coverage (What is left 4) |
| A17 English guard | **passes** |
| A18 Export during Find | **fails**: the note showed *running*, *Wait for Find* kept Export disabled until the results were in, then Find's own coverage check found 9 item-frames of one scroll frame uncovered, so the export and *Stop Find and export* checks after it did not run |
| A19 Leaving during Find | **passes** |
| A20 Copies made before Find | **fails**: Bring them over and Also cover the copy work, but the clip's export differs over the two recordings on 209 of 1,145 frames (the scroll frames of What is left 2) |
| A21 Review at speed | **fails**: 201 rows, V turns Peek while reviewing on, 100 rows kept by keyboard, but the magnified view was gone afterwards |

### End to end after the rounds

Every case of `auto-blur.e2e.cjs`, each run alone without `TMPDIR` on the final build (24 November 2026,
source of 56c71a0; A17 again at 13ee1f0, which changes only its environment), with the host helper in
`native/ocr/target/host` (none in `native/bin`) and the pinned models; the English guard first, alone,
in compare mode after a warm-up launch. **Every case passes**, and the guard passes:

| Case | Result |
|---|---|
| A1 | **passes**: 20,495 of 20,495 item-frames covered, 8.6% of a frame on average; export identical over the two recordings; Find 27 s for the 60 s recording |
| A2 (11 routes), A2 control, A2a, A2b, A2c, A2d raw frames, A2f, A2g (2) | **pass** |
| A2d WebCodecs | **passes**, now with the fill check: no pixel of a secret's place 12 levels off its cover's fill in either output |
| A3-A15, A17-A21 | **pass**. A10 failed after 53272ca on two result lines (fixed in d2ae212). A17 failed when the runner set `SSW_OCR_HELPER`, which its guard inherited (Settings › Private info then offered the download, not the baseline's line); the guard now runs without the file's `SSW_OCR_` variables (13ee1f0) and A17 passes with and without it |
| A16 tracking set | **all ten pass**: list-scroll 1,564/1,564 (14.2%), flick-scroll 13,889/13,889 (12.1%), browser-zoom 1,188/1,188 (14.3%), select-text 720/720 (6.0%), sticky-header 1,588/1,588 (16.0%), window-drag 240/240 (2.1%), toasts 928/928 (6.9%), tooltip 480/480 (3.9%), type-email 117/117 (1.7%), type-key 118/118 (1.6%); plans of 1.1-4 units, Finds of 4-11 s |
| A16 held-out seed 9000 | **passes**: 44,460/44,460, 16.1%, 24 units, Find 127 s |
| A16 at 150% | **passes**: 44,100/44,100, 13.6%, 96 units, Find 266 s |
| A16 at 200% | **passes**: 44,100/44,100, 7.5%, 144 units, Find 358 s |

Of the other 77 end-to-end files, the six nearest what the rounds changed (Review, the export dialog,
the publishing pack, the Inspector and the commands) were run again, each alone on the same build:
`review-mode` (10 of 10), `export-pack` (5), `publish-pack` (4), `editor` (13), `commands` (5) and
`versions` (3) pass. All 77 ran again at the final verification (below).

### End to end at the final verification

`auto-blur.e2e.cjs` run **whole**, once, on the final build (24 November 2026, the tree of 6bda8d2), with
the host helper in `native/ocr/target/host` (none in `native/bin`), the pinned models through
`SSW_OCR_MODELS` and no `TMPDIR`: **all 52 cases pass** (2,206 s), so no case needed a run alone.

| Case | Result |
|---|---|
| A1 | **passes**: Find 27 s for the 60 s recording (the scan 24.7 s: 8 units, 293 lines, 98 covers, no read failed, nothing not followed); 20,495 of 20,495 item-frames covered, 8.6% of a frame on average (90th percentile 7.4%); Review 84 rows, 14 to check; the export 1,800 of 1,800 frames identical over the two recordings, byte-identical |
| A2 (11 routes), A2 control, A2a, A2b, A2c, A2d raw frames, A2f, A2g (2) | **pass**: every output identical over the two recordings (byte-identical where the route is deterministic); without covers every route differs |
| A2d WebCodecs | **passes**: 0.000% of a secret's pixels off its cover's fill in either output |
| A3 | **passes**: the outputs made with Peek and Listen on identical; the 440 Hz tone gone under the private bleep (0.00000, against 374.6 before it) |
| A4, A5, A6, A8, A9, A12, A14, A18, A19 | **pass**; A6's nine old projects are saved with the bytes 37f9355 writes, and that build's export hides the secrets |
| A7 | **passes**: two private bleeps (the card and the code); the captions, the new Spanish translation, the SRT and VTT sidecars, the chapter names and the AI requests hold no digit of them, and the sound is muted there |
| A10 | **passes**: the helper started once more, 2 reads failed, said and covered |
| A11 | **passes**: the flow by keyboard; the in-test audit (names, references, ids, dialogs, menus; axe-core is not installed here) finds nothing |
| A13 | **passes**: 13.4% of a frame on average |
| A15 | **passes**: the followed cover holds the email 0-4.5 s; *Covered 2 more places.* |
| A16 tracking set | **all ten pass**: list-scroll 1,564/1,564 (14.3%), flick-scroll 13,889/13,889 (12.0%), browser-zoom 1,188/1,188 (14.3%), select-text 720/720 (5.8%), sticky-header 1,588/1,588 (16.0%), window-drag 240/240 (2.1%), toasts 928/928 (6.9%), tooltip 480/480 (3.9%), type-email 117/117 (1.7%), type-key 118/118 (1.6%); plans of 1.1-4 units, Finds of 3-11 s |
| A16 at 150% | **passes**: 44,100/44,100, 13.6%, 96 units, Find 248 s |
| A16 at 200% | **passes**: 44,100/44,100, 7.5%, 144 units, Find 337 s |
| A16 held-out seed 9000 | **passes**: 44,460/44,460, 16.1%, 24 units, Find 128 s |
| A17 | **passes**: the English guard in compare mode |
| A20 | **passes**: *Also cover the copies* and *Bring them over*; the clip's 1,145 frames and the duplicate's 1,800 identical over the two recordings, byte-identical |
| A21 | **passes**: 100 rows kept by keyboard in 1.9-2.1 s; the outputs made meanwhile identical |

**Find's speed, measured in this run.** A1's Find took 27 s for its 60 s recording: 0.45 of its length,
within §5.11's band of 0.45-0.55 (27-33 s converted to this machine). The evaluation sets' plans run over
their budgets as §5.4 point 7 allows (24, 96 and 144 units against 18, 36 and 36), so the band does not
bound them: their Finds took 128 s (held-out), 248 s (150%) and 337 s (200%) for 144 s each. The tracking
cases' Finds took 3-11 s for recordings of 2-17.8 s at 60 fps.

### Every other end-to-end file

At integration: the 77 other files in `tests/e2e/` (the English guard among them), each run alone under
`xvfb-run -a -s "-screen 0 1920x1080x24"` without `TMPDIR`, on the final build (source of 3d64b0b; the
commits after it change tests and docs only), with the canonical `native/bin` (no host `ssw-ocr` in it):
**all 77 passed on the first run**, none needed its one retry. 4,221 s in all; the longest were
`editing-polish` 216 s, `export` 189 s, `offline-captions` 155 s, `camera-director` 144 s. The English
guard passed in compare mode against the re-recorded baseline. No real failure was found, so no fix or
regression test came from this run.

**At the final verification** (the build of 6bda8d2, the same way, after the whole auto-blur run; the
English guard ran alone before it, above): the 76 other files ran one at a time, 4,305 s in all.
**75 passed on the first run.** `native.e2e.cjs` failed once, in its case for the real `ssw-capture.exe`
under wine: `record --window` of wine's desktop window ended with exit code 0 where the case expects 3,
with the same message (*Windows.Graphics.Capture is not available*); run again alone, the whole file
passed (8 of 8) and the helper ended with 3. The capture helper and the recording code are not part of
this wave and were not changed by it, and the retry passed, so it does not count as a real failure. The
longest files were `editing-polish` 229 s, `output-formats` 199 s, `export` 193 s, `offline-captions`
156 s and `camera-director` 153 s. Three parts skip for want of what they need, as at integration:
`packaging.e2e.cjs`'s `verify-dist` part (no Windows installer is built here) and `editing-polish`'s E1
and E13 (a build of Flown from before wave 10 in `SSW_E2E_BASELINE_APP`, the prepared download beds in
`SSW_E2E_SOUND_RELEASE`). No real failure was found, so no fix or regression test came from this run.


## Sizes

| What | Size | Against |
|---|---|---|
| `ssw-ocr.exe` (MinGW, mixed profile, `build-native --require` here) | 16,323,072 B installed, 4,084,828 B at brotli 11 at integration; 16,323,584 B and 4,086,548 B after round 6 and at the final verification | `OCR_BUDGET` 17.2e6 / 4.3e6 (P2 set it to the measured size; §16.2 now says so), under decision 1's 5 MB line; its imports are exactly `OCR_IMPORTS` |
| The other helpers, rebuilt | `ssw-capture.exe` 453,120 B; `ssw-speech.exe` 3,611,136 B; `ssw-speech-compat.exe` 3,478,528 B; `ssw-llm.exe` 7,320,576 B | each within its own budget (build-native checks them) |
| Host `ssw-ocr` (Linux, the e2e runs only, not shipped) | 17,361,384 B at integration; 17,358,560 B at the final verification | |
| `out/main` | 6,494,296 B at integration (+538,239 against the build of 37f9355); 6,516,041 B at the final verification (+559,984, `fix/bleep-speed` included) | the scan, the rules worker, the vendored libphonenumber-js and double-metaphone (432,283 B of source) |
| `out/renderer` | 35,079,669 B (+448,575); 35,087,534 B (+456,440) at the final verification | |
| `out/preload` | 28,730 B (+2,680), the same at the final verification | |
| The reader's models, downloaded on request | 27,608,757 B | five files, pinned by size and SHA-256 |
| `resources/THIRD_PARTY_NOTICES.txt` | 753,403 B | `npm run notices -- --check`: up to date |


## What is left

Integration's list, item by item, as it stands at the final verification (checked against the code,
the rounds' reports and the final verification's runs, *Tests* above):

1. **Find blacked out recordings that change page or zoom.** Done (rounds 1 and 5). Every A16 case and
   the evaluation sets at 150%, 200% and the held-out seed cover every item-frame, with 1.6-16.1% of a
   frame covered on average against the blackout check's 25%. Two smaller over-coverings remain, both
   within the checks and neither showing anything: each page cut of the evaluation sets is covered whole
   for about 0.33 s until that page's read (the lost areas at a cut, §5.8), and on the held-out set one
   email lost at a cut keeps a whole-frame cover for one 6 s page (4.3 points of its 16.1%).
2. **Covers started a frame or two late on some scroll-ins.** Done (round 2): A1, A18 and A20 cover
   every planted item in every frame, and their exports compare identical over the two recordings.
3. **Find was about ten times slower than its budget.** Done for this machine (round 6): A1's Find takes
   27-28 s for its 60 s recording (27 s in the final verification's whole run), within §5.11's band of
   27-33 s converted to this machine. The evaluation sets' plans (24-144 units) run over their budgets as
   §5.4 point 7 allows, so their Finds (125-358 s for 144 s after round 6; 128, 248 and 337 s at the
   final verification) are not bounded by the band. The reference PC's measurements are decision 8's
   (below).
4. **A16's other cases.** Done (rounds 2, 3 and 5): all ten tracking cases pass.
5. **A7, A13 and A21.** Done (rounds 1 and 4).
6. **The scan swallowed a walk's error.** Done (round 3): the log names the error's kind and Find's
   result says how many items were not followed.
7. **Left from the parts' reports.** Done (rounds 3, 4 and 7): Everywhere's estimate line;
   Everywhere's places as suggestions; the Covers row and Cover section placed as §2.2-2.3 say; the
   duplicated helpers in `helperUse.ts`; the pack's share and description sidecar masked; the copies
   offer writing the project first; Find's result line in the Private info section. That last change
   put two live result lines in the page while Review covers the section (A10 met two elements, and a
   screen reader heard each step twice): the lines now show in one place at a time (d2ae212), and the
   copies offer goes with the section's line as §2.12 asks (e865ee5). Two points of the parts' texts
   the build does not do, now written into the design as built: Private info at the top of the Shapes
   tab (the English guard refuses the move; §2.1), and see item 8.
8. **The design's text against the build.** Done in round 7, each with its measurement or reason in
   the design and in its commit: §5.5's tiles (as few as cover an area, spread evenly, not a 64 px
   overlap) and §13.3/§16.2's size and `OCR_BUDGET` (29b580a); §5.8's follow session span `[from, to]`
   (f19f4a1); §6.1's padding at line ends and §6.10's continuation gap (b9d04ea: the design's numbers
   touched visible items past tests 102 and 103's limits); §7.2's one-word secrets said aloud and
   §6.15's false-hit corpora, with tests 133 and 134 leaving this design out of the docs they read
   (e961d1a); §2.1's placement (3bc15ac); §17.3's lossy-route threshold (69f6d65, see *Tests*). One
   difference touches a decision of §0 and is **not** changed here (below, *For the lead*).
9. **Not run here.** The Rust tests and `npm run test:native` have run since (round 6, and again at the
   final verification: R1-R32 pass but R8 and R10, which need Windows; the crate's 21 unit tests;
   test:native 13 of 13). Still not run, and not runnable here: `verify-dist` (no Windows installer is
   built here: electron-builder's Windows Electron is not cached and nothing is downloaded) and axe-core
   (not installed, and installing is not allowed here; A11 audits names, references, ids, dialogs and
   menus itself).

Found since, and not done here:

- **Phones of an English UI.** An English UI always uses the United States' phone region, whatever
  the PC's format locale: `uiRegion` takes the PC's region from `currentUiInfo().formatLocale`, which
  `formatLocaleOf('en', …)` makes `en-US` always (and for another language the system's region only
  when the system locale is in that language). §2.5 says the PC's region comes from
  `app.getSystemLocale()`, and §0 decision 2 turns on "the PC's region", so a PC in Great Britain or
  Bangladesh with an English UI does not find its local phone numbers unless the user adds the region.
  It touches §0's decision 2, so it is left for the lead: the end-to-end Finds add GB and BD in the
  dialog (e38d3df), which hides it from the tests.
- **Test 133 is at its limit.** Flown's docs read as speech give 10 hits, the most it allows (two are
  the sample address `anna.li@acme.de` in a doc, found by the one-word rule). A doc that adds a sample
  email or card number said in prose will fail it; nothing is wrong with the rules.
- **Cover this text everywhere's estimate** is Find's whole first estimate even when main still keeps
  the last Find's reads and the run is a search of them (seconds): `underCover` does not say whether
  it keeps them. It overstates, never understates.
- **Output file names** made from the project's name (the default save name, batch file names, the
  guide's file name) are not masked; the user sees and can change each in the save dialog or the batch
  list. A name only holds a spoken secret when the user typed it there.
- **The helper's `second`** counts a match a few pixels along the best match's own line, so on scrolls
  at an odd speed a true match is not clear and the walk is lost every other frame, which grows lost
  areas (round 2's finding). Leaving the best match's own line out of `second` needs a Rust test and a
  rebuild of the Windows helper.
- **In-place reads are never thinned** (round 3): recordings full of one-line corrections spend more
  units. A typed key kept (not deleted) in a terminal line whose label starts more than 64 px to its left
  is read through a settle area that cuts the label.
- **A wine flake outside this wave.** At the final verification `native.e2e.cjs` failed once in its case
  for the real `ssw-capture.exe` under wine (exit code 0 where 3 is expected, with the expected message)
  and passed whole on its retry alone. The capture helper and the recording code are unchanged since
  37f9355; it is noted here only because integration's run did not meet it.
- **For the lead to confirm**, as the rounds asked: the tracking set's labelled passwords (0f14105) and
  the phone regions the end-to-end Finds add (e38d3df) follow §6.7 and §6.8 and change no check; A18's
  export checked per pixel against the covers drawn there (7450c6a) and A16's ink measured over each of
  an item's own rectangles (e9ff05c) change how a check measures, not its threshold.

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
   size at 1080p, 4K and 7680×2160 (§5.11), including Find's wall time, which this machine now measures
   within its band on A1 (§5.11); the 30 real recordings (97% or more covered, nothing found ever
   shown) with their units distribution; pop-up false hits at most one per 10 minutes; and that the WER
   registry value and the run-time flags leave no crash report.
3. **The native Bangla review** (§12.4): the spoken word lists, the Bangla label tables of
   `src/shared/privacy/detect/tables.ts` and the `privacy` catalogue's Bangla messages, through
   `docs/design/output-and-languages.md` §15. No translation was written here.
4. **The other account's optional `private.json`** (decision 9, §18): ask for it; this wave works
   without it and reads nothing of it.

