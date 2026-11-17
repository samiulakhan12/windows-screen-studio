# Build report: output and the app (wave 12), steps S0 to S4b

Branch `feat/wave12` in `/home/user/wt-w12`. Design:
[`docs/design/output-and-languages.md`](docs/design/output-and-languages.md) (§0 the owner's decisions,
§10.4 the steps, §21 the files and parts, §23 the tests). The branch starts at the integration head
with everything through wave 11 (smart tools), then the design commits, the step S0 commits (the
guards, the English guard's tour, the contracts and the language runtime, head `45f17e3`), wave 11's
last verification fix from `integ/wave8`, the seven parts P1 to P7 merged in the order of §21.9
(P1, P2, P3, P4, P6, P7, then P5, which mounts the others' rows), and the integration commits listed
below. Nothing was pushed.

This build covers steps S0 and S1, the lead's step S2, part X6's step S3a, the extraction parts X1 to
X5 and X7 merged at step S3b, the lead's step S4, and step S4b with its three groups merged and the
scanner's words rule turned to fail (their own sections below). The translations
(S5) need people: no translation was drafted or written, `scripts/i18n/draft.mjs` was never run
against any service, no AI service was contacted, `translations/reviewers.json` lists nobody, and
`src/shared/i18n/built/shipped.json` is `[]`, so Bangla stays out of the language picker and Flown
runs in English, which the English guard holds unchanged against the baseline recorded at S2.

## What was built

### Export (LT-22)

* **Codecs** (§5, part P1). A *Codec* row under Format: MP4 offers H.264, HEVC and AV1; MOV offers
  H.264, HEVC, CineForm and *Lossless* (QuickTime Animation); WebM offers VP9 and AV1. Each format's
  old codec stays its default, so stored settings export what they did. HEVC runs only on the
  graphics card (WebCodecs, then `hevc_nvenc`, `hevc_qsv`, `hevc_amf`, `hevc_mf` with
  `-hw_encoding 1`, each only when the 10-frame probe found it); AV1 runs on the graphics card or
  `libaom-av1` (two passes for a size target). Levels and codec strings for HEVC and AV1, the
  frame-rate rules (`rateFps`, 5 blur samples at 120 fps), size and time estimates, the free-space
  check before large exports (error code `disk-full`), and every encoder name on the allow-list of
  §5.1 (test 81 runs over 500+ accepted jobs).
* **Transparency** (§6, P2). `alphaOf` and `seeThrough`; `drawFramePicture` draws a transparent or
  overlays-only frame with one option; joins composed on a transparent scratch, dips fading to
  transparent; straight alpha out of the canvas, the same bytes through both readbacks; the
  dialog's preview draws the transparent export over a checkerboard.
* **Stems and the WAV format** (§7, P3). `stemJobOf` lists the stems a project writes; one ffmpeg
  graph writes them all from the soundtrack's own parts, with one fixed gain in place of
  `loudnorm`, exactly `stemSamples` long from sample 0, 32-bit float with a BWF chunk; written
  after the video and never undoing it; the WAV format is the M4A job's graph written as float WAV.
* **Timelines** (§8, P4). The plans of *This export* and *The original recordings*, FCPXML 1.10,
  Premiere XML and CMX 3600 EDL writers (golden files, Apple's DTD), main's checked writing (the
  video must be this session's export, stems next to it, the plan checked, the media probed) and
  the recordings copied without touching the project folder.
* **The dialog and presets** (§2, P5). The Codec, Background and Frame rate rows as radio groups,
  the picks that change other settings in the same step, saved presets above the destinations with
  their menus, `.flownpreset` files written and read by main (64 KB, strict UTF-8), Portrait post,
  For editing and Transparent overlay, Sound stems and Timeline in *Also save*, the running steps
  and the done view of every file saved.

### Languages (X-05), ready but not shipped

* **Runtime** (S0). Messages in English JSON catalogues, one runtime for main and renderer, the
  English profile of `fmt`, the renderer booting its language before the first render.
* **Language runtime, settings and fonts** (§9, §11, §12, P6). Main resolves the start language
  from the `ui` preference, Windows' languages and what ships; a restart is refused while an export,
  a recording or a download would be lost and reopens the editor's project; the renderer loads a
  catalogue and the Bangla UI face within 1.5 s or stays English; canvases keep `lang="en"`;
  `askConfirm`, `NumberField`, `scripts.css`, Settings › Language and the offer on Home.
* **Checks and translation tools** (§15, §16, P7). The TypeScript-AST string scanner (failing for
  every file the parts made, a report elsewhere until S4), the catalogue checks, built catalogues
  that ship only strings approved by two listed people, pseudo-locales, the review sheet, the
  drafting script (tested only against a fake local service), the extraction codemod and split,
  the review overlay and pack, the release checks, and the read-only checks workflow with pinned
  actions.

### Integration (this step)

* `exporter.ts` reads the code main records when it refuses a route's start: a free-space refusal
  stops the export at the first route with its own message instead of being asked again of every
  encoder; an encoder failure still moves on (`tests/proExporter.test.ts`).
* The finalizing line names libaom's two passes for a size target, as it does for x264 and libvpx.
* The done view shows main's own whole stem sentences once ("The sound stems could not be
  written.") and wraps only a bare reason in "The sound stems could not be saved: {reason}"
  (`tests/exportDialogUi.test.ts`). This settles the wording question P3 and P5 left open.
* `scripts/i18n/config.json`'s `failFor` now lists the parts' three files that were missing from
  it: `src/main/exportSpace.ts`, `src/main/exportedJobs.ts`, `src/renderer/src/i18n/languageNames.ts`.
* **Fixed, found by the new screenshots**: the done view put "The recordings the timeline uses"
  under every sound stem, with or without a timeline. The line now belongs to the `<name> media`
  folder only (`tests/exportDialogUi.test.ts`; F8 and F11 check both sides).
* **Fixed, found by the new e2e tests**: the export dialog's preview stayed blank when the
  *Thumbnail frame* slider moved before its first frame. `whenReady` waited only for `loadeddata`,
  which fires once per load; a video already seeking was back at HAVE_METADATA and the second wait
  never ended. It now also ends on a `seeked` or `canplay` that leaves a current frame
  (`tests/mediaWhenReady.test.ts`, failing without the change). It is a race that the build before
  wave 12 has too (1 of 4 launches stalled there, 8 of 12 here, where the dialog does more before
  its first frame); after the fix, 5 of 5 launches drew at once.
* Screenshots of the new dialog: `docs/screenshots/output-codec.png`, `output-transparent.png`,
  `output-portrait.png`, `output-also-save.png`, `output-done.png`, `output-presets.png` (57 to 111 KB).
* Two end-to-end files no part wrote: `tests/e2e/output-formats.e2e.cjs` (§23.3) and
  `tests/e2e/languages.e2e.cjs` (§23.4), described below.

### Contract changes the parts made (accepted)

* P1: the job base spreads `jobCodecFields(settings, alpha)` in `exporter.ts`, and `proSink` gets
  the quality as an optional sixth argument; `export:start` clears the error code and runs
  `spaceProblem`; `exportArgs.ts` exports helpers `proPlan` shares and moves the chapter and
  subtitle files into `planSidecars` (test 3's digests unchanged); `targetBitrate` and `rateOf` use
  `rateFps` (no change up to 60 fps); one message `codecs.webcodecs.unsupported`.
* P2: `alphaRawSink`'s third parameter takes an `AlphaInput` instead of a whole job.
* P3: `writeStemsStep` and `renderStems` take optional test seams; stems drop input tags
  (`-map_metadata -1`) as the M4A export does.
* P4: `src/main/exportedJobs.ts` keeps the last four export jobs in memory (one import and one call
  in `exportIpc.ts`); `copyRecordings` takes an optional fifth argument.
* P6: `UiInfo` gains an optional `catalogue` (unpackaged builds with `SSW_I18N_CATALOGUE_DIR` only);
  read-only download flags in four stores; `recordingBusyReason()` exported; `OWN_WORDS`.

## The owner's decisions as applied (§0)

1. **HEVC through the graphics card only**: `CODEC_POLICY.hevcSoftware` is `false`; no route lists
   `libx265`; `hevc_mf` always carries `-hw_encoding 1`; the HEVC chip shows only where the probe or
   WebCodecs found an encoder, and a stored HEVC on a PC without one exports as H.264 and says so
   (export-presets.e2e.cjs, F2). An `ffmpeg.exe` without libx265 and the HEVC decoder is for the
   first release after this wave (§24).
2. **No ProRes; CineForm for editing**: `CODEC_POLICY.prores` is `false` (`prores_ks` exists behind
   it and is never tagged `apl0`), `CODEC_POLICY.cineform` is `true`; a ProRes preset imports as
   CineForm with a notice (F12).
3. **`ffmpeg.exe` corresponding source**: not part of this build; the binary is unchanged.
4. **No DNxHR**: not offered, not on the allow-list.
5. **Bangla first**: the runtime, fonts and digits are built for `bn`; Spanish and Hindi have names
   and plural rules only.
6. **Two reviewers with signed rights**: `translations/reviewers.json` lists nobody; the checks
   refuse anyone not listed and the build ships only strings two different listed people approved.
7. **The shipping rule**: `shipped.json` is `[]`; Settings has no Language section and the palette
   no *Language…* (languages.e2e.cjs, L1).
8. **Offer once, never switch**: the offer shows once while the setting is absent and a shipped
   language is known offline; *Not now* is recorded for good (L8).
9. **Bangla digits for prose quantities**: `fmt`'s non-English branch and the `latn` meta are
   built; the call sites move to `fmt` in S3a (X6).
10. **Exported files stay English**: batch file names, the chapters file, thumbnails and frames are
    the same in a Bangla session (L12, L13).
11. **The recording side stays English; a shipped language shows as a preview**: no recording file
    was touched; the recording bar keeps `lang="en"` in a Bangla session (L11); the fixture's
    Bangla shows as "বাংলা (প্রিভিউ) · Bangla (preview)" (L2).
12. **The English UI unchanged**: no English text changed; the English guard runs with no baseline
    (S2 records it); P6 compared its tour on the contracts build and its own across 51 screens.
13. **One fixed gain for stems**: the stems use the preview's gain where the video uses `loudnorm`
    (test 31; F8's sum).
14. **Checks on Windows and in other editors**: not possible here; listed under *What needs a person*.
15. **Installer size**: no new font or locale pack; the renderer's own JS grew by 28.7 KB at P6.

Untouched, checked with `git diff be3cbdc HEAD`: `src/main/recording/*`, `src/main/recordingIpc.ts`,
`src/main/windows.ts`, `src/shared/recording/*`, `src/renderer/src/views/Toolbar.*`,
`src/renderer/src/recorder/*`, `src/main/appSettings.ts`, `src/main/security.ts`, the CSP in
`src/renderer/index.html`, and `electron-builder.config.cjs` (`electronLanguages` stays `['en-US']`).

## Tests

All on the final head, under `xvfb-run -a -s "-screen 0 1920x1080x24"` for the end-to-end files,
one file at a time, with at least 9.7 GB free throughout.

* **Typechecks**: both clean (`tsconfig.node.json`, `tsconfig.web.json`).
* **vitest** (`--maxWorkers=2`, private `TMPDIR`): 585 files, 7,786 tests passed, 8 skipped (the same
  skips as before wave 12). The guards hold: `outputEquivalence` (tests 1 to 4), the vertical,
  Captions Studio, wave 10 and wave 11 equivalence guards.
* **`npm run -s build`**: succeeds (renderer `views` chunk 2,646.9 KB).
* **`npm run i18n:check -- --report`** and **`npm run i18n:check`**: every check passed (171 English
  messages in 25 namespaces; 2,882 texts in 220 files still to extract, a report until S4; 101
  pending in the other account's files). `node scripts/i18n/build-catalogues.mjs --check`: the built
  catalogues match the translations (none). `npm run notices -- --check`: up to date (the notices
  did not change).
* **New unit tests in this step**, each failing without its change (checked by putting the old code
  back): `tests/proExporter.test.ts` (a coded free-space refusal stops at the first route; an
  encoder failure moves on; libaom's two passes are named), `tests/exportDialogUi.test.ts` (main's
  whole stem sentences once; the media line only on the recordings folder),
  `tests/mediaWhenReady.test.ts` (the preview's wait ends with a seek).
* **The pinned actions** of `.github/workflows/checks.yml` were checked with `git ls-remote`:
  `actions/checkout` v4.2.2 is `11bd7190…` and `actions/setup-node` v4.4.0 is `49933ea5…`, as pinned.

End to end (the list of §21.9 plus the parts' own files):

| File | Result |
|---|---|
| `output-formats` (new: F1, F3 to F11, F14) | 4/4 pass; again 4/4 after the done-view fix |
| `languages` (new: L1 to L4, L7, L8, L11 to L13) | first run 3/4: L2 stopped its recording before any frame arrived and the empty recording was refused, so the editor never opened; re-run alone 4/4; the test now records 3 s, and passes 4/4 |
| `export-presets` (P5: F2, F12, F13, F15, F16) | 2/2, and 2/2 after the done-view fix |
| `languages-network` (P6: test 60) | 1/1: 52 screens in Bangla, no request left the app |
| `export` | 10/10, and 10/10 after the done-view fix |
| `export-pack` | 5/5, and 5/5 after the done-view fix |
| `render` | 3/3 |
| `audit-audio-export` | 2/2 |
| `clean-voice` | 3/3 |
| `editing-polish` | 17/17 |
| `smart-tools` | 6/6 |
| `captions-studio` | 8/8 |
| `vertical-video` | 1/1 |
| `versions` | 3/3 |
| `commands` | 5/5 |
| `ui` | 5/5 |
| `smoke` | 1/1 |
| `packaging` | 2/2; its `verify-dist` half says SKIP because no `dist/win-unpacked` was built (the installer was not built in this step) |
| `english-guard` | ran the tour over 51 screens; no baseline exists, so it recorded and compared nothing (S2 records it) |
| `hands-off` (extra, after the done-view fix) | 5/5 |

F1 was also run once against a build of the release before wave 12 (`be3cbdc`, built in a scratch
worktree, `SSW_E2E_BASELINE_DIR`): the stored settings of before export the same stream (H.264 High,
1920×1080, 60 fps, 240 frames, the same colour tags) with identical frames; those values are pinned
in the test. Fixtures are 4 s long instead of the design's 10 s to fit a shared machine.

Not covered end to end yet: F4's caption placement in 4:5 (its sizes and the Portrait post's
identical frames are), F7's caption (the camera's opacity is), and the L steps that need S3.

## Step S2: the baseline, `common` and the split

* **Masks first** (`tests/e2e/uiTour.cjs`, as the timer and the sizes are). A mask can now be
  `{ selector, value }`: inside the selector's elements only the text the regular expression `value`
  matches becomes the placeholder, so the sentence around it stays guarded; the selector is painted
  over in the screenshots, and the element whose own text holds the value is left out of the layout
  (its width follows the value). Settings' "Speech models use 0 MB · 10 GB free on this drive" masks
  its free space this way. Storage's line ("Recordings use 95 KB · 9.5 GB free on this drive") was
  masked whole in the text but not in the accessibility snapshot, which splits it at its `<strong>`:
  the snapshot is now masked piece by piece where it does not hold a masked text whole. Looked for
  other values that change by nature: free memory shows only in a warning a fresh home never reaches;
  the PC's cores and memory and the speed estimates made from them are fixed per machine; file times
  read "used today" because they come after the fixed clock; the encoder probe finds nothing on this
  machine. None changes between runs.
* **One nondeterminism in the tour's set-up, fixed.** The first `--record` refused: `home-confirm`'s
  screenshot differed at the picked source card's bottom corners (12 pixels, up to 18 levels; the
  same failure as one of S0's runs). Measured in a loop: after a project is deleted the corners come
  out in one of three raster states at random (9 of 18 deletions in another state), never after a
  cancelled delete (0 of 6) or without one (0 of 6), and always the same after a reload (12 of 12).
  The tour now waits for the deleted card to go, reloads Home and waits for the sources, as for the
  other Home screens; the question and its buttons are recorded when they are asked. No source file
  changed, and nothing real is masked.
* **The baseline**: `english-guard.e2e.cjs --record` on the merged build, two runs, identical, 51
  screens: `tests/e2e/english-guard/baseline.json` (3,748,519 bytes) and
  `tests/e2e/english-guard/shots/` (51 PNGs); 14,135,227 bytes in all. Compared again with four
  fresh runs (three on the build it was recorded on, one on the final build with `common` filled):
  all pass.
* **`common`** (`src/shared/i18n/messages/en/common.json`, 65 messages with their meta): from the
  inventory of the scanner's texts grouped by exact text, the 75 that three or more files show, less
  sentence fragments ("s", "of", "timed out", the three key-store names), errors only main shows that
  §9.6 gives to `errors` ("Cancelled.", "The disk is full.", "Unknown speech model.") and a locale
  call. Actions (`action.cancel`, `action.close`, `action.deleteName` "Delete {name}", …), states
  (`state.saving` "Saving…", …), labels (`label.size`, `label.opacity`, …), the colour picker's two
  texts and `error.drawingSurface`. Each meta entry gives the sense the word has (Cut and Delete are
  the verbs, not the cut part or the Delete key), and the three `{name}` messages mark the name as the
  user's. Frozen by `tests/i18nCommon.test.ts`. No code uses these keys yet, so until S4 turns the
  scanner on for the whole tree an unused `common` key is a warning of `i18n:check`; from S4 it fails
  like any other (`scripts/i18n/lib/checks.cjs`; test in `tests/i18nCatalogueChecks.test.ts`, failing
  without the change).
* **The split** (`scripts/i18n/parts.json`, from `node scripts/i18n/split.mjs`): X1 23 files, X2 73,
  X3 46, X4 30, X5 104, X7 65 stylesheets; no file claimed twice, none claimed by no part. The scanner
  reads text at its sinks, not in tables of labels, so §9.1's tables (`EXPORT_PRESETS` labels,
  `RESOLUTION_LABELS`, `ENCODER_NAMES`, `SPEECH_TIER_NAMES`) and the like were in no part's list:
  the split now also takes every file with a table of labels (a `label`, `title`, `name`, …
  property holding words; 107 files), and the rules give the 18 it left unclaimed to the part whose
  screens show them (`src/shared/audio/**` and the editing tables of `src/shared/editor` to X2,
  `captionTiles.ts` to X3, `versions.ts` and `src/shared/publish/**` to X4, the AI providers' tables
  to X5, `snapping.ts` to X1). `tests/i18nSplit.test.ts` holds the owners of these files and an
  empty conflict and unclaimed list; both new tests fail on the old rules.
* **Size and first render** (§19.4, `docs/design/output-and-languages-measurements.json`).
  `measure-start.cjs` gave the recording bar no preload (`getLastWebPreferences()` no longer reports
  it), so the bar failed before it drew, and an idle bar draws nothing: S0's 68 ms was the paint of
  the bar page's background, and after the views became lazy there was no paint at all (P6's
  finding). The script now opens the bar with its own window options and preload, tells it a
  recording is paused, and reads its first contentful paint. The machine's times drift by some 30 ms
  from one session to the next, so `--baseline <dir>` alternates the runs between a build of S0's
  commit and this one and writes both; S0 was taken again that way from `31c4b0d`, built in a scratch
  worktree.

  | | S0 (`31c4b0d`) | S2 | Difference | Budget |
  |---|---|---|---|---|
  | Renderer JavaScript | 2,715,936 B | 2,818,582 B | +102,646 B | +250 KB |
  | Main window, first contentful paint | 244 ms | 256 ms | +12 ms | +30 ms |
  | Recording bar, first contentful paint | 192 ms | 196 ms | +4 ms | +20 ms |

  (Main's JavaScript is 5,769,855 B against 5,896,910 B, the preload 25,303 B against 26,247 B.)
  Measured on `d2963a4` with this step's `common` built in. Ten more alternated pairs gave +4 ms and
  +4 ms.
* **Checks**: both typechecks clean; vitest (`--maxWorkers=2`, private `TMPDIR`): 589 files, 7,829
  tests passed, 8 skipped (the same skips); `npm run i18n:check` passes with one warning (65 `common`
  keys not used yet); `build-catalogues.mjs --check` matches; `npm run -s build` succeeds.

## Step S3a: part X6, the formatter call sites

* **What moved** (§10.5, §11.2): every call of our own files that formatted a size, length, clock,
  date, factor, list or grouped count with one of today's helpers now goes through `fmt`: the
  helpers §10.5 names (`formatClock`, `formatDuration`, the three `formatBytes` and two `sizeText`
  helpers, `clockTime`, `formatTick`, `formatLevel`, `formatRate`, `zoomText`, the sounds list's
  `lengthText`), `formatTime` at our call sites (§9.5: the timeline, transport, panels and the shared
  copy modules §10.5 cites, such as `soundsCopy.ts:57` and `polishCopy.ts:196`), the eight calls with
  no locale (`Home.tsx`, `search/rows.ts`, `useUpdates.ts`, `StorageSection.tsx`, `FontPicker.tsx`),
  and the rest of §11.2's table: `versionTime`, `usedAgo`, the two local `listPhrase` copies and the
  `toLocaleString('en-US')` counts (notes, script drafts, the LUT reader's errors, the cost line's
  tokens, the colour grading's CPU reason). 198 calls in 59 files (60 source files changed with fmt.ts), in five commits by area.
* **`fmt.bytes` styles.** Three of the size helpers wrote other shapes than the export dialog's
  ("1.5 GB" and whole MB for Home and Settings › Storage, "0 KB" for nothing in Storage, never under
  1 MB for short clips), so `fmt.bytes(n, style)` takes `'fine'` (the default, as before),
  `'coarse'`, `'storage'` or `'megabytes'`; English runs each helper's own code, and other languages
  write the same shapes in the format locale's digits.
* **What stayed**, each in `fmt-sites.json` with its reason: the crop editor's pixel size (a local
  `sizeText` that is not a size helper of §11), `usd()`'s US$ amount (fmt has no currency format yet;
  §11.3 gives it to the cost line's extraction), the short clip's "Most action, 1:02" title (it becomes
  a project's name, §9.7) and the share message's length (posted by main to the user's own channel,
  outside the app; if X4 makes the message follow the UI language, the length moves to
  `fmt.clock(s, 'hours-rounded')`). `formatTime` itself, the recording side's files and the helpers
  tests 8 and 73 compare against are unchanged; Home's `formatBytes` and the two `listPhrase` copies
  were local and are gone, and test 73 keeps their code as the reference.
* **`scripts/i18n/fmt-sites.json`** lists the 198 moved calls (the call they replaced, the call now,
  the line at S3a and the mapping), the 25 mappings and the 4 kept calls. `node
  scripts/i18n/fmt-sites.mjs [--check]` finds every formatter call in our files with the TypeScript
  compiler (`scripts/i18n/lib/fmtSites.cjs`) and fails on one neither moved nor kept, a kept entry
  matching nothing, or a moved call missing from its file. A part that rewrites a listed call keeps its
  `now` text (as `t()` values do) or updates the entry.
* **Test 73** (`tests/i18nFmtSites.test.ts`) compares each mapping's `fmt` call with the helper it
  replaced over §11.2's grids (seconds from −3 to 10⁶ with NaN and Infinity, bytes from −5 to 10¹²,
  factors, ticks at nine steps, counts with decimals and NaN, lists, local instants around midnight and
  new year, ages, version times at a fixed now), checks that each site's call is its mapping's, and runs
  the tree check. On the S2 tree the check finds 198 calls not moved and 183 moved calls missing; with
  S2's `fmt.ts` the `coarse`, `storage` and `megabytes` pairs differ.
* **Size**: the renderer's JavaScript is 2,818,204 bytes against S2's 2,818,582, main's 5,897,684
  against 5,896,910, the preload unchanged.
* **Checks** on the final build: **tests 9 and 10 pass** against the S2 baseline
  (`english-guard.e2e.cjs` under `xvfb-run`, compare mode; the baseline was not touched); test 73
  passes (29 tests) and test 8 too; both typechecks are clean; vitest (`--maxWorkers=2`, private
  `TMPDIR`): 590 files, 7,858 tests passed, 8 skipped (the same skips); `npm run i18n:check` passes
  with the same warning (65 `common` keys unused), the scanner now reporting 2,874 texts in 218 files
  (the eight locale-less calls are gone); `build-catalogues.mjs --check` matches; `npm run -s build`
  succeeds. No recording-side file, `security.ts`, the CSP, the baseline, `reviewers.json` or the
  built catalogues changed (`git diff e825ddf`).

## Step S3b: the extraction parts X1 to X5 and X7

Merged one at a time with `git merge --no-ff` onto `9533899` (S3a) in the order X1, X2, X3, X4, X5,
X7. After each merge: both typechecks, `npm run -s build` and the English guard (tests 9 and 10,
`english-guard.e2e.cjs` in compare mode against the S2 baseline, which was never re-recorded). All
six guards passed at the first run.

* **Merge conflicts**: only `scripts/i18n/allow.json` (X2, X4, X5 appended site entries; both sides
  kept) and the comment above two tests' English re-registration after a module reset
  (`captionsPanel.test.ts` with X3, `providerFormOwnPrices.test.ts` with X5; same code, one comment
  kept). No source conflict: the split of §10.5 held.
* **What each part extracted** (their reports, condensed):
  * X1 (editor shell, 557 log rows): command titles and categories (palette search over the UI
    title, the English title and the keywords, in NFC; test 70), the keycap sentences and the
    shortcuts editor (test 71), the timeline, transport, snap guide and preview speed menu, the
    preview, inspector tabs and save state, the multi-select notices, `media.ts`'s errors, the
    engine's look names (`src/shared/engine/lookNames.ts`, so main keeps its English tables),
    Editor.tsx's screens and notices, `askConfirm` for leaving and copies, and `ariaKeys` with
    `aria-keyshortcuts` on the palette rows (its own last commit, `7ef521e`, held for the NVDA check).
  * X2 (panels, 1,787 rows): the style, zoom, camera, sound and text namespaces over 73 files, wave
    10's moods and effect names through `src/shared/audio/soundNames.ts`, the cut-style names,
    `camera.corner.*`, `NumberField` at its three sites outside English (English keeps today's input),
    and `Rich.tsx` for messages whose values are elements. Two hints keep today's text nodes because
    merged text nodes moved glyphs under the guard.
  * X3 (captions, first half, 411 rows): the Captions tab, the AI pieces it shares (cost line, cost
    question, AI on this PC progress, model list), speakers, subtitles, Make my captions great, Clean
    up, Languages and the caption style gallery, `captionWords.ts` for the main-graph tables, and test
    77 (the UI digits never change caption content digits).
  * X4 (review and project tools, 623 rows): Review mode with its kinds as plural messages (test 78),
    Versions (`versionWords.ts`), Polish, the Copies menu, importing, the speaker notes, Home's search
    and Share. The Publish dialog was left (see S4).
  * X5 (export, settings, Home, main, 937 rows): the export dialog, exporter and render layers
    (`exportNames.ts`), Settings, Home, the camera bubble, area picker and update notices, main's
    dialogs, file filters, notifications, taskbar tooltips and errors, and the error codes of §9.6
    that replace the exporter's reading of English words (`refusedForGood`, `ExportFailure`; tests 72
    and 75).
  * X7 (right to left): the codemod and check `rtl-sites.mjs` turned 124 declarations in 34
    stylesheets into logical properties and lists the 135 kept physical with reasons; `direction:
    ltr` on the time axis and pictures; mirrors under `:dir(rtl)`; test 76 in vitest and in the app
    (`languages-rtl.e2e.cjs`, L10 with `<html dir="rtl">` set by the test).
* **Fixed after the merges**: X5's codes left `voiceIpc.ts` throwing plain errors from
  `export:start`, so a missing microphone file (whose words said "missing") and a file another app
  held now tried every other encoder instead of stopping. They now carry `missing-input` and
  `in-use` (`08f52fe`), and a test compares the new decision with the old words for every reason the
  cleaner gives (fails without the change). The Captions tab and the speech download compared main's
  English "Cancelled."; they now also accept `errors.cancelled` in the UI language (`cancelled.ts`).

## Step S4: the scanner fails for the whole tree

* **What the parts left, extracted** (617 rows in `scripts/i18n/log/s4.json`, 514 new messages):
  the Make a guide panel and its screenshot viewer (with `stepsLine`, `checkQuestion`, the formats,
  the chips and the rows' accessible names), Find chapters (its options and `FIND_WORDS`, now
  getters), Short clips and Make a shorter version (with `CLIPS_WORDS` as getters, the lengths and
  shapes, the made and stopped notices as plurals), the Publish dialog and its link check (the cards'
  names, tones, lengths and blockers through `src/renderer/src/publish/publishWords.ts`, because
  `pack.ts` is in main's import graph), the Captions tab's look section and Captions Studio controls
  (every chip table, the themes and gradients), Edit by text (its notices, kinds and the words' and
  paragraphs' accessible names), and the captions made on this PC card. Errors thrown in main's
  import graph became `errors` messages: the AI text request checks, the transcription parse errors,
  "Not a project file", Draft script's refusals, and the webhook refusals and post failures
  (`webhookHelp()` replaces `WEBHOOK_HELP`). The local AI grammar's four schema checks are
  programming errors no user sees and are listed in `allow.json` with that reason; no UI text was
  allow-listed.
* **English kept**: sentences around a name or number use `Rich` with the value as a node, so the
  text nodes are today's; `Rich` now isolates a user placeholder in `<bdi>` outside English, as `T`
  does (English adds no element). Icon labels keep the space in the markup. The English guard passed
  on the two tour screens these files reach (Captions, Transcript) after each batch.
* **The switch**: `scripts/i18n/config.json` says `"scan": "fail"`. Test 61 gained its whole-tree
  case (the config says fail, the repository scan finds no failure and nothing to report, only the
  other account's files wait), and S0's seam test now expects `fail`. `npm run i18n:check` passes
  with no warning: every `common` key is used (the last one, *Make captions*, by the guide, Find
  chapters, Short clips and Edit by text).
* **Tests changed for S4, none loosened**: the two test harnesses read the text a message component
  (`Rich`, `T`) renders; tests that read renamed exports or source lines follow them with the same
  expectations (`findHint()`, `sendShotsLabel()`, `webhookHelp()`, the Publish link's message, the
  smart pickers' hint lines); the Captions badge test registers English after its module reset. New:
  `tests/i18nS4Extraction.test.ts` (the Publish words equal `pack.ts`, the getters follow the
  catalogue, the webhook messages keep today's English, the cancel check, `Rich`'s `<bdi>`).

* **Commits of S3b and S4**: the merges `7344297` (X1), `bc787be` (X2), `b5bd388` (X3), `996914c`
  (X4), `c9b6720` (X5), `7c588ae` (X7); then `0257c2e` (the extraction), `6e061d0` (the scanner
  fails, test 61), `7b6fe58` (tests following the extraction, the overflow check), `08f52fe` (Clean
  voice's error codes), `b09cd98` (the languages test reads the Bangla session's digits) and this
  report with the feature list and release notes.

### Checks and tests at S4

On the final head, one end-to-end file at a time under `xvfb-run -a -s "-screen 0 1920x1080x24"`,
with at least 7.9 GB free throughout.

* **Typechecks**: both clean.
* **vitest** (`--maxWorkers=2`, private `TMPDIR`): 605 files, 7,950 tests passed, 8 skipped (the same skips as before wave 12; 585 files and 7,786 tests at S1).
* **`npm run -s build`**: succeeds (renderer `views` chunk 2,690.7 KB, 2,646.9 KB at S1).
* **i18n checks (§16)**: `npm run i18n:check`: every check passed (4,545 English messages in 25
  namespaces; the scan reads 820 files and finds no failure; 101 texts pending in the other account's
  files). `node scripts/i18n/build-catalogues.mjs --check`: the built catalogues match the
  translations (none; one merge group, in `export`). `fmt-sites.mjs --check`: 198 sites moved to
  `fmt`, 4 kept with a reason. `rtl-sites.mjs --check`: 135 physical declarations kept with their
  reasons in 65 stylesheets. `split.mjs`: the parts' files as merged.
* **The English guard** (tests 9 and 10, `english-guard.e2e.cjs` in compare mode against the S2
  baseline): passed after each of the six merges, after each S4 batch, on the head the end-to-end list
  ran on, and again on the final build.

End to end (the task's list; every file exists):

| File | Result |
|---|---|
| `english-guard` | pass (compare), and again on the final build |
| `languages` | 3/4, the same on the re-run alone: L12/L13 looked for the batch button *Export 2 files* in the Bangla session, where the count now shows in Bangla digits (*Export ২ files*, §11.3) because X5 put it through `fmt`; the test now names the button by the session's digits (`b09cd98`), and passes 4/4 on the final build |
| `output-formats` | 5/5 |
| `export` | 10/10 |
| `export-pack` | 5/5 |
| `render` | 3/3 |
| `audit-audio-export` | 2/2 |
| `clean-voice` | 3/3, and 3/3 on the final build with the error codes fix |
| `editing-polish` | 17/17 (E1 and E13 say SKIP: they need an older build and the prepared download beds, as before) |
| `smart-tools` | 6/6 |
| `guides` | 1/1 |
| `short-clips` | 1/1 |
| `captions-studio` | 8/8 |
| `captions` | 9/9 |
| `review-mode` | 10/10 |
| `vertical-video` | 1/1 |
| `versions` | 3/3 |
| `commands` | 5/5 |
| `search` | 3/3 |
| `ui` | 5/5 |
| `smoke` | 1/1 |
| `packaging` | 2/2; `verify-dist` says SKIP because no installer was built in this step |

The list ran on the build before the voice error codes commit (`08f52fe`, main only); the app was
built again after it and the English guard, `languages` and `clean-voice` ran on that build.

### Counts by namespace (English messages)

4,545 messages in 25 namespaces (240 at S3a): alpha 12, camera 181, captions 584, codecs 52, commands
165, common 65, editor 248, errors 228, export 232, home 85, keys 47, language 20, main 85, presets 30,
recording 0 (reserved for the other account), review 636, settings 218, smart 225, sound 156, stems 16,
style 592, text 398, timeline 67, timelines 31, zoom 172. Extraction log rows: X1 557, X2 1,787, X3
411, X4 623, X5 937, X7 0, S4 617 (4,932 in all), every one given back by test 69.

### The pseudo-locale check (§12.3)

`tests/e2e/pseudo-overflow.cjs` (new, for development, not in run-all) runs Flown in English, bn-XA and
en-XA from `npm run i18n:pseudo`, walks Home, every Settings section, the editor with all 13 inspector
tabs, the palette, Polish, Versions and the export dialog, and lists each element whose text
overflows its box (`scrollWidth > clientWidth` or `scrollHeight > clientHeight`), apart from the 47
that overflow in English too. Results on this build:

* **bn-XA, 21 elements**: the title bar's save state (64 px wide, +32 px, every editor screen); the
  timeline's hint line (ellipsis; the whole line, every editor screen); the Style tab's preset name
  (42 px box, +119 px, ellipsis) and *Save as default for new recordings* (239 px button, +113 px);
  the Zoom tab's active chip (+26 px); two buttons of the Cursor and Clip tabs (239 px, +16 and
  +56 px); the Audio tab's *Find unwanted sounds* (+26 px) and the music rows' titles and credits
  (67 px wide, the English names overflow because the translated buttons beside them are wider); three
  disabled commands in the palette (+6 to +89 px, ellipsis); five labels of the export dialog's form
  rows (92 px column, +3 to +45 px); and the recording options' summary on Home (English text, +32
  px, beside longer translated words).
* **en-XA, 7 elements**: the save state (+4/+5 px), the timeline hint (+224 px, ellipsis), the preset
  name (+16 px), *Save as default for new recordings* (+30 px), the Zoom chip (+3 px), a music row's
  title and the recording options' summary.
* These are layout work before a language ships (fixed-width buttons and the 92 px label column of
  the export dialog first); the meta entries can carry `maxLength` for the fixed ones (§12.3). The
  screenshots are under the run's `--out` folder for the reviewers.

## Step S4b: word tables, sentences in pieces and cancel codes

S4 left what the scanner of that step could not see: word tables, copy a function returns or builds,
and sentences made of pieces. S4b added a **words rule** to the scanner (`scripts/i18n/lib/scan.cjs`,
`WORD_KINDS`: `table`, `copy`, `fragment`). Its inventory at `790664e` listed 1,296 sites in 173 files
(801 table, 471 copy, 24 fragment; 144 more in the other account's files, pending), split into three
disjoint groups of files for three builders: b (captions, speech, sound and AI; 64 files, 666 sites),
c (editor, panels, review rows, notes, share and search; 86 files, 532 sites) and d (sentences in
pieces, the cancel paths and the pseudo-locale wiring; 37 files, 98 sites). After the three merges
113 sites in 15 files were left, each one whose display site was in a file outside its group's list;
the integration extracted them and turned the rule from report to fail.

* **The merges**: `feat/w12-s4b` (`47ab5f1`), `feat/w12-s4c` (`46db203`) and `feat/w12-s4d`
  (`46d7153`), one at a time with `git merge --no-ff` onto `790664e`. Group b merged cleanly; c and d
  conflicted only in the English catalogues, their meta files and `allow.json`, where both sides
  appended entries. Each was resolved by a three-way JSON merge that keeps every key and entry of
  both sides (no key was changed differently on two sides; the piece keys group d renamed follow its
  rename). After each merge `npm run -s build` and the English guard (tests 9 and 10, compare mode
  against the S2 baseline, never re-recorded) passed at the first run, and both typechecks were clean
  after the last.
* **The rule**: `scripts/i18n/config.json` says `"words": "fail"`. A word table (labels, names,
  hints, notes and sentences in object and array literals, maps keyed by ids, getters, Map entries,
  a component's own text prop), copy a function returns, builds or throws, or a sentence made of
  pieces (a message joined with English words, English in a placeholder, messages side by side that
  are not each a whole sentence, a message whose English is itself a piece) now fails
  `npm run i18n:check`, `predist` and the checks workflow anywhere in our files. Ids, CSS values,
  fonts, paths, file-format words, logs, comparisons, message keys and merge-group keys pass. The
  whole tree has none left: test 61's whole-tree case (`tests/i18nScan.test.ts`) holds the config to
  fail and the repository scan to no failure, no report and no word finding, and
  `tests/i18nScanWords.test.ts` does the same for the words rule alone.
* **`scripts/i18n/s4b-sites.json` removed**: it was the builders' work list (written by
  `s4b-sites.mjs` through `lib/s4bSites.cjs`, read only by the inventory test). With the rule failing
  there is nothing left to list, so the list, its script and library and the inventory's own test
  are gone; the whole-tree cases above replace that test. (The removal landed in `cedf450`, whose
  message does not mention it; `5fa0f09` describes it. At `cedf450` alone the old inventory test
  would not load.)
* **What the groups extracted** (their reports, condensed):
  * b (522 log rows in `s4b.json`): main's AI, download, clipboard and music-loop failures, the
    speech helper's and detector's reasons, Clean voice (`voiceWords.ts`), the shared captions and AI
    tables through words files (`greatWords.ts`, `captionWords.ts`, `transcriptMarks.ts`,
    `timingWords.ts`, `textChoices.ts`), AI on this PC and the speech tiers, captions on this PC
    (`speechCopy.ts`, 170 messages), the AI cost line, cost question and usage line (one whole message
    per sentence shape, plurals, a capitalised message for a sentence's first word), the Captions
    tab's look controls, Polish's skip line and the music library's lengths and sizes.
  * c (381 rows in `s4c.json`): main's guide, notes, copy, share and versions texts; the import, LUT,
    font, YouTube chapter and Draft script refusals; the editor, guide, render layers and share
    block; the clips, autosave, crop, selection, paste, shuttle, cut marker, image, magnifier and
    caption review texts; the found chapters', Auto colour's and smooth cuts' review rows; the
    safe-zone chips, the brand kit's selects, the clips' fallback names, an imported video's hints,
    the search moment notices and the work folders' names.
  * d (82 rows in `s4d.json`): the cancel codes, main's sentences for AI failures, captions on this
    PC and pinned downloads as whole `errors` messages, Make a guide's live-region sentences, the
    merge groups, `FLOWN_I18N_PSEUDO` and `english-changes.md` (below).
  * The integration (107 rows in `s4b-lead.json`, `cedf450`): what the groups could not reach
    because the display site was in another group's or nobody's file. The Clip tab calls
    `silencesVoiceHint()` and `idleVoiceHint()`, `review.ts` calls `framingTitle()` and
    `directorDetail()`, the title bar calls `polishButtonTitle()`, the editor's restore takes the file
    notices from `versionWords.ts`, the share folders' sources come from `steps.ts`; shapes on the
    timeline, the preview and the snap guides are named by `itemNames.ts`' `shapeName`; Polish names
    the built-in looks by `presetLabel`; the Style, Zoom and Effects tabs and group edit take the
    gradients, wallpapers, animated gradients, zoom easings (`ZOOM_EASING_CHOICES`, made when read)
    and tilt presets from `lookNames.ts`; the Captions field's chips come from `exportNames.ts`. The
    colour looks (`editor.look.colour.*`) and stickers (`text.sticker.*`, with an image item's name
    as `text.overlay.*`) had no renderer words and got them; the Images tab puts a sticker's name
    inside its tooltip through `fmt.inSentence` instead of lower-casing it in code. The English
    constants these replaced (`SILENCES_VOICE_HINT`, `IDLE_VOICE_HINT`, `FRAMING_TITLE`,
    `DIRECTOR_DETAIL`, `POLISH_BUTTON_TITLE`, versions.ts' two notices, `sourceText`, `shapeLabel`)
    are gone; their tests follow the words files with the same English.
* **Data, not UI text** (`allow.json`, 140 site entries, 68 at S4): every entry has its reason, and
  none is UI text. The groups listed default content Flown writes into a project (a new text's,
  chapter's and project's names, readers' fallbacks, a pasted image's file name), words written into
  exported files and team-chat posts (output stays English, §0), AI prompts (Write titles' step
  actions), log-only and token texts, the noted-text action ids, the caption gallery's sample caption
  (caption content chosen by the captions' language), and the tables main loads whose words the
  renderer shows only through a words file (§9.5, §9.6: `exportNames.ts`, `itemNames.ts`,
  `versionWords.ts`, `notesCopy.ts`, `rows.ts`, `steps.ts`, `soundNames.ts`, `captionWords.ts` and the
  others). The integration added ten of that last kind: `SHAPE_KINDS`' names, `BUILT_IN_PRESETS`'
  names, the gradients and animated gradients, wallpapers, zoom easings, tilt presets, colour looks,
  stickers, and `SIDECAR_LABELS` with `sidecarBlocked`'s reasons, each naming the words file that
  shows it.
* **Two behaviours fixed outside English** (each with a test that fails without it): the guide's save
  and copy checks gave English sentences the preload, main and the panel all showed. They now give a
  problem id (`GuideProblem`) with its `errors.guide.*` key (`GUIDE_PROBLEM_KEYS`, plain keys because
  the preload has no catalogue, test 86); main throws the message, the renderer checks first and says
  it in the UI language, and the preload refuses with the id only (`tests/guideCopy.test.ts`,
  `tests/i18nS4bLeftovers.test.ts`). Polish's summary named a built-in look by its English stored
  name in every language; it now uses `presetLabel` (`tests/polishRunner.test.ts`).

### Counts by namespace (English messages)

5,487 messages in 25 namespaces (4,545 at S4; 5,019 after group b, 5,361 after c, 5,457 after d):
alpha 12, camera 182, captions 880, codecs 52, commands 165, common 65, editor 307, errors 507,
export 239, home 85, keys 48, language 20, main 137, presets 30, recording 0 (reserved for the other
account), review 716, settings 222, smart 281, sound 183, stems 16, style 607, text 417, timeline 99,
timelines 31, zoom 186. Extraction log rows: X1 557, X2 1,787, X3 411, X4 623, X5 937, X7 0, S4 617,
S4b group b 522, group c 381, group d 82, integration 107 (6,024 in all), every one given back by
test 69.

### Merge groups (§9.3)

`build-catalogues.mjs --check` reports 19 groups: camera 1, editor 2, export 3, keys 1, main 1,
review 1, settings 2, smart 2, style 4, text 1, zoom 1 (one, in `export`, existed at S4). Group d made
the 18 sentences English still builds from pieces into `merge: true` groups with a `.whole` message:
the guide's check question and too-big line, the Clip tab's edit hint, the Selection tab's keycap
hint, the FreezeMarks tooltips, the director's automatic title (`autoTitleSuffix`; LayoutTrack uses
`autoTitle`), the export dialog's resolution notes and batch heading, the preview and overlay
pickers' hints, the ignored click, the saved look notice, the spoken search time, About's line,
Storage's line, the undo hint (`keys.undoHint`, still added after other notices, so the {undo}
placeholder of other messages is unchanged) and the batch export notification. English keeps exactly
today's code path and text nodes; other languages show the whole message, with selects, plurals and
rich tags. To give each sentence its own group, 21 piece keys were renamed and only the key fields of
their rows in the X1, X2, X5 and S4 logs changed. `tests/i18nS4dMergeGroups.test.ts` runs the other
languages' path with the English catalogue and checks each whole message says what English builds.

### `scripts/i18n/english-changes.md`

It lists eight English texts that only a deliberate later change could improve (§0 decision 12,
§10.3 rule 8): "Bengali" in the captions' language lists against "Bangla" in new text; the Selection
tab's hint that can end with a semicolon or a space; the freeze block tooltip; the export dialog's
Batch heading; the review and undo hints that carry their separator or full stop into other notices;
the space at the end of the guide's too-big line; and the Clip tab's hint in four pieces. None was
changed: each needs the owner's approval and a deliberate change of the guard's baseline, named in
its commit. Other languages already get whole messages for them.

### Cancel codes (§9.6)

A stopped AI request, transcription, captions run on this PC, pinned download, speech model download,
download of a model for AI on this PC and chat post now throw or reject an error named
`CancelledError` (`CANCELLED_ERROR` in `src/shared/jobs/longJobs.ts`) whose message is
`errors.cancelled` in the UI language. Electron puts the name before the message of a rejected
invoke, and `isCancelled` reads it there or on the error itself; the Captions tab, the speech download
notice and both Settings sections decide by it, never by words, and main's English "Cancelled." is
gone. `tests/i18nS4dCancels.test.ts` runs each path in en-XA or bn-XA and shows the rejection is a
cancel in a translated UI and in English, and that the same words without the code are a failure.
For captions on this PC, `localErrorCode` still finds a failure's code from its text (English
patterns, or the UI language's messages outside English): passing a code, as cancels now do, would
be cleaner later.

### The pseudo-locale switch

`FLOWN_I18N_PSEUDO=en-XA|bn-XA|ar-XB` starts an unpackaged build in that pseudo-locale from
`scripts/i18n/pseudo/<locale>/` (written by `npm run i18n:pseudo`, not committed); ar-XB's page is
right to left. A packaged build never reads the variable (`tests/i18nPseudoSwitch.test.ts`).

### Checks and tests at S4b

On the final head, one end-to-end file at a time under `xvfb-run -a -s "-screen 0 1920x1080x24"`,
with at least 8.6 GB free throughout.

* **Typechecks**: both clean.
* **vitest** (`--maxWorkers=2`, private `TMPDIR`): 612 files, 8,016 tests passed, 8 skipped (the same
  skips as before wave 12; 605 files and 7,950 tests at S4).
* **`npm run -s build`**: succeeds.
* **i18n checks (§16)**: `npm run i18n:check`: every check passed (5,487 English messages; the scan
  and its words rule find nothing in our files; 245 texts pending in the other account's files, 101
  at S4, because the words rule also reads their tables). `build-catalogues.mjs --check`: the built
  catalogues match the translations (none), 19 merge groups. `fmt-sites.mjs --check`: 198 sites moved
  to `fmt`, 4 kept with a reason. `rtl-sites.mjs --check`: 135 physical declarations kept with their
  reasons in 65 stylesheets. `split.mjs --check`: passes (group b named `CaptionsPanel.tsx` in X3's
  list, since it has no table left for the split to find it by).
* **The English guard** (tests 9 and 10, compare mode against the S2 baseline, never re-recorded):
  passed after each of the three merges, after the integration's extraction, and on the final build
  in the list below.

End to end (the task's list; every file exists), on the final build (`5fa0f09`'s code), at least 9 GB
free throughout; every file passed at its first run, so none was re-run:

| File | Result |
|---|---|
| `english-guard` | pass (compare) |
| `languages` | 4/4 |
| `output-formats` | 5/5 |
| `export` | 10/10 |
| `export-pack` | 5/5 |
| `render` | 3/3 |
| `audit-audio-export` | 2/2 |
| `clean-voice` | 3/3 |
| `editing-polish` | 17/17 (E1 and E13 say SKIP: they need an older build and the prepared download beds, as before) |
| `smart-tools` | 6/6 |
| `guides` | 1/1 (steps, screenshots, PDF, Markdown, HTML, demo and Copy guide, through the renderer's new size check) |
| `short-clips` | 1/1 |
| `captions-studio` | 8/8 |
| `captions` | 9/9 |
| `review-mode` | 10/10 |
| `vertical-video` | 1/1 |
| `versions` | 3/3 |
| `commands` | 5/5 |
| `search` | 3/3 |
| `ui` | 5/5 |
| `smoke` | 1/1 |
| `packaging` | 2/2; `verify-dist` says SKIP because no installer was built in this step |

### The pseudo-locale check again (§12.3)

`tests/e2e/pseudo-overflow.cjs` on the final build, the same walk as at S4 (Home, every Settings
section, the editor with all 13 inspector tabs, the palette, Polish, Versions and the export dialog),
lists each element whose text overflows its box apart from those that overflow in English too (16 now,
47 at S4: the English walk now finds fewer, mostly the music rows' texts that the S4 run counted on
more screens). The list replaces S4's:

* **bn-XA, 26 elements** (21 at S4): the title bar's save state (64 px wide, +32 px, every editor
  screen); the timeline's hint line (ellipsis; the whole line, every editor screen); the Style tab's
  preset name (42 px box, +119 px, ellipsis) and *Save as default for new recordings* (239 px button,
  +113 px); the Zoom tab's active chip (*Zoom out*, 72 px, +26 px); **new since S4: the Zoom tab's
  four easing chips** (55 px, +18 to +26 px; they were English at S4 and are messages now) and **a
  colour look's name in the Colour tab** (66 px, +12 px, ellipsis; new messages); two buttons of the Cursor and Clip
  tabs (239 px, +16 and +56 px); the Audio tab's *Find unwanted sounds* (+26 px) and the music rows'
  titles and credits (67 px wide; the English names overflow because the translated buttons beside
  them are wider); three disabled commands in the palette (+6 to +89 px, ellipsis); five labels of the
  export dialog's form rows (92 px column, +3 to +45 px); and the recording options' summary on Home
  (English text, +32 px, beside longer translated words).
* **en-XA, 10 elements** (7 at S4): the save state (+4/+5 px), the timeline hint (+224 px, ellipsis),
  the preset name (+16 px), *Save as default for new recordings* (+30 px), the Zoom tab's active chip
  (*Zoom out*, +3 px), **the Zoom tab's easing chips** (Smooth, Snappy and Bouncy, +9 and +10 px;
  new), a music row's title and the recording options' summary.
* As at S4, these are layout work before a language ships (fixed-width buttons and chips and the
  92 px label column of the export dialog first); the meta entries can carry `maxLength` for the fixed
  ones (§12.3). The screenshots and `overflow.json` were written to the run's `--out` folder (a
  scratch folder of this step, not kept in the repository).

## What is left for S5 and after

* **Sentences joined in code that the words rule does not see**: a reason shown with a full stop added
  in the markup (`` `${reason}.` `` in `ExportBundleOptions.tsx`'s reasons and also-save lines,
  `{blocked}.` in the Captions field, `SubtitlesField.tsx`) and `orPress(...)` followed by "." (the
  Zoom tab's auto zoom hint, whose `errors.imported.autoZoom` meta says so). Each is one message with
  a placeholder plus a full stop in code, so a language that ends sentences otherwise (Bangla's "।")
  cannot choose its own; they want `{reason}.`-style messages, or merge groups where English must
  keep its text nodes, before a language ships.
* **English that only a deliberate change could improve**: the eight entries of
  `scripts/i18n/english-changes.md` (see S4b). Each needs the owner's approval and a deliberate
  re-record of the guard's baseline named in its commit; other languages already have whole messages.
* **Code that still reads English text**: Home's source refresh matches `/no longer available/` from
  the recording side (a request to the other account is in `pending.json`); the editor's copy check
  compares the prefix of `editor.copy.failed` while `duplicateFlow` and the clips use
  `review.copy.failed` (same English; translations must keep the same prefix or it doubles); for
  captions on this PC `localErrorCode` finds a failure's code from its text (English patterns, or the
  UI language's messages outside English), where a code passed from main, as cancels now have, would
  be cleaner.
* **Judgements to confirm**: group c treats the default content Flown writes into a project ("Add
  your text", "Key point", "Chapter n", "Untitled recording", "Imported video", a pasted image's name,
  and group d the "Step" title of a step added by hand) as the user's content, the same in every UI
  language, like `UNTITLED` and the stored speaker labels; webhook post lines are output and stay
  English. The guide's cost line has its own `smart.guide.cost.what` with the same English as
  `captions.ai.what.steps` ("the steps' narration"); both are kept, one per context.
* **Emoji names**: the Graphics tab's emoji picker searches and names each emoji by Unicode's English
  short name, from the generated `src/shared/captions/emojiList.ts` (3,963 names, listed in
  `allow.json` as third-party data). A translated picker wants CLDR's annotations for its language,
  generated the same way, not catalogue messages.
* **Not wired**: the notes window's resize drag in a right-to-left page; arrow keys following the
  visual direction (§13.2); postcss is used by X7's tools from vite's dependency, not listed in
  `package.json` (no install was run).
* **Testing note**: the English guard and the pseudo-overflow check write under `os.tmpdir()`
  (`/tmp/flown-english-guard`, `/tmp/flown-english-guard-home`), which every worktree shares, so two
  guard runs at the same time can break each other; run them one at a time. `docs/design/offline-captions.md`
  still names the removed `CAPTIONS_SKIPPED_NO_MODEL` (now `captionsSkippedNoModel()`); the design
  record was left as written.
* **S5 itself** (§10.4, §15): Bangla drafted with a service whose terms allow commercial use, reviewed
  in context with the review pack and sheet (`npm run i18n:pack`, `npm run i18n:sheet`) by two
  listed reviewers, the merge-group report, `npm run i18n:build`, the installer built and its size
  compared with S0's (tests 62, 65, 85).
* Open choices from S1 still open: whether stem files count as exported files (copy to clipboard and
  share refuse them; Show in folder works); sweeping temporary stem files at start; FCPXML
  `colorSpace` for the editing formats; Premiere XML for 3,000 cuts is 2.7 MB against §19.3's 2 MB;
  §5.4's AV1 level line (4.1 for 1080p60, 5.0 for 1080p120); the av1_amf quantisers are starting
  values; the camera path's own colour against its source.

## What needs a person

* **The second Bangla reviewer, and both reviewers' signed rights** (§0 decision 6): the owner adds
  them to `translations/reviewers.json` once the agreements are signed; nobody is listed.
* **Drafting with a service whose terms allow commercial use** (§15.3): the owner names the service
  per language in `translations/README.md` before anyone runs `draft.mjs`. No draft was made here.
* **The review pack and sheet** (§15.4): the reviewers work from `npm run i18n:pack` (screenshots in
  context, with the pseudo-locale overflow list above) and `npm run i18n:sheet`; their approvals are
  imported with the sheet's checks.
* **The other account's agreement for the recording side** (§0 decision 11, §9.5): until then a
  shipped language is a preview, the recording files keep their English (245 texts pending since
  S4b: 101 found by the sink rules and 144 by the words rule), and our code shows their text in
  corner messages and `lang="en"` wrappers.
* **§0 decision 14's checks on Windows and in other editors**: the NVDA check of the palette's
  `aria-keyshortcuts` (`7ef521e` can be held back on its own) and of the Bangla UI on Windows 10 and
  11, the GPU encoders' quality values, WebCodecs HEVC and AV1, `av1_amf`'s padding, the alpha
  export's speed on a GPU canvas (both readbacks), timeline imports into DaVinci Resolve, Premiere
  Pro and Final Cut Pro (the Cross Dissolve uid, transitions starting at the cut, anchored clips
  under retimed clips, Resolve's marker EDL), which of WebM, AV1, CineForm, QuickTime Animation and
  32-bit float PCM in MOV each editor opens (`EDITOR_OPENS`), and GoPro's patent declaration for
  SMPTE ST 2073 before release.
