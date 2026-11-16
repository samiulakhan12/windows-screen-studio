# Build report: output and the app (wave 12), steps S0 to S3a

Branch `feat/wave12` in `/home/user/wt-w12`. Design:
[`docs/design/output-and-languages.md`](docs/design/output-and-languages.md) (§0 the owner's decisions,
§10.4 the steps, §21 the files and parts, §23 the tests). The branch starts at the integration head
with everything through wave 11 (smart tools), then the design commits, the step S0 commits (the
guards, the English guard's tour, the contracts and the language runtime, head `45f17e3`), wave 11's
last verification fix from `integ/wave8`, the seven parts P1 to P7 merged in the order of §21.9
(P1, P2, P3, P4, P6, P7, then P5, which mounts the others' rows), and the integration commits listed
below. Nothing was pushed.

This build covers steps S0 and S1, the lead's step S2 and part X6's step S3a (their own sections below).
The rest of the extraction (S3b and S4) is a later workflow, and the translations (S5) need people: no translation was drafted or written, `scripts/i18n/draft.mjs` was
never run against any service, no AI service was contacted, `translations/reviewers.json` lists
nobody, and `src/shared/i18n/built/shipped.json` is `[]`, so Bangla stays out of the language picker.

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

## What is left for S3 to S5

* **S3b** (X1 to X5, X7), from this step's result: the extraction, file list by file list from `scripts/i18n/parts.json`, and
  only `common`'s keys for the words it holds. With it come the e2e steps that check its code: L5
  (digits and Target size through `fmt` and `NumberField`), L6 (`aria-keyshortcuts`), L9 (no plain
  ASCII text under `en-XA`), L10 (right to left under `ar-XB`, which also needs the pseudo-locale
  selection P7 left unwired), L14 (confirmations through `askConfirm`), L15 (mixed digits) and the
  notification half of L7. X5 also moves the exporter's remaining English-text fallback test
  (`NOT_ENCODER_RELATED`) to error codes; this step did it for the free-space refusal only.
* Files in the lists that §21.9 keeps as they are in part: `src/shared/render/safeZones.ts` (X5) keeps
  `textArea` and `COMMON_SAFE`; `src/shared/engine/project.ts` (X1) keeps `formatTime` ASCII. The
  label-table files may hold words that are not UI text (AI prompts in `src/shared/publish/prompts.ts`,
  ids); the part puts those in `allow.json` with their reason.
* **After X6, for the S3b parts.** X6 moved the named helpers and the locale calls only. Numbers
  interpolated into prose (`${n}`, `toFixed` in a template, `Math.round(m.seconds)} s`, the crop
  editor's `${px.w} × ${px.h}`) become message values through `fmt.count` and `fmt.number` as each part
  makes its messages (§9.3). Each part keeps the `fmt` calls of `fmt-sites.json` in its files (as
  values of `t()`) or updates their entries; `node scripts/i18n/fmt-sites.mjs --check` and test 73
  say which. The helpers tests 8 and 73 compare against (`ExportDialog.tsx`'s `formatClock`,
  `formatDuration` and `formatBytes`, `formatTick`, `formatLevel`, `formatRate`, `zoomText`,
  `clockTime`, both `lengthText`s, both exported `sizeText`s, `storage/rules.ts`'s `formatBytes` and
  `usedAgo`, `versionTime`) stay exported although only `moments.ts` and `webhooks.ts` still call two
  of them. X5 owns the running view's `fmt.inSentence` (§9.6, `ExportDialog.tsx`'s lower-cased
  progress detail, not moved here). X4 decides whether the share message follows the UI language
  (then its length moves to `fmt.clock(s, 'hours-rounded')`). `src/shared/ai/cost.ts` is in no part's
  list; its `usd()` keeps US$ amounts as they are until a currency format joins `fmt` (§11.3).
* **S4**: the scanner fails for the whole tree (`"scan": "fail"`). It still reads no tables of labels,
  so it cannot tell whether those were extracted; a table rule for the scanner, or the split's
  `labelTablesOf` turned into a check, belongs with S4. Any `common` key still unused then fails
  `i18n:check`.
* Open choices the parts left for the lead, not changed here: whether stem files count as exported
  files (copy to clipboard and share refuse them today; Show in folder works); sweeping temporary
  stem files at start rather than at the next stem step; FCPXML `colorSpace` for the editing
  formats; Premiere XML for 3,000 cuts is 2.7 MB against §19.3's 2 MB; §5.4's AV1 level line
  should read 4.1 for 1080p60 and 5.0 for 1080p120 (Annex A); the av1_amf quantisers (120/136/152)
  are starting values.
* The stems equal the video's soundtrack only when the video mixes the separate microphone and
  system files; at the default gains the video plays the recording's own mixed track (§7.6), so the
  e2e F8 sets the microphone to 80% to compare the same graph.
* P2 saw a camera colour shift in an *Overlays only* CineForm file. Measured here on the same green
  camera, CineForm and VP9 decode to the same colour (20, 169, 63 against 19, 168, 63), so it is not
  CineForm's; the camera path's own colour against its source remains for whoever owns it to check.
* Temporary e2e homes kept for debugging stay under `/tmp/ssw-e2e-of-*` (about 125 MB); they are
  outside this step's scratch folder, so they were not deleted. P5 left `/tmp/ssw-e2e-presets-JNjSSu`.

## What needs a person

* **The second Bangla reviewer, and both reviewers' signed rights** (§0 decision 6): the owner adds
  them to `translations/reviewers.json` once the agreements are signed, and names the drafting
  service per language in `translations/README.md` before anyone runs `draft.mjs`.
* **The other account's agreement for the recording side** (§0 decision 11): until then a shipped
  language is a preview and the recording files keep their English.
* **§0 decision 14's checks on Windows and in other editors**: the GPU encoders' quality values,
  WebCodecs HEVC and AV1, `av1_amf`'s padding, the alpha export's speed on a GPU canvas (both
  readbacks), the Bangla UI on Windows 10 and 11 with NVDA, timeline imports into DaVinci Resolve,
  Premiere Pro and Final Cut Pro (the Cross Dissolve uid, transitions starting at the cut,
  anchored clips under retimed clips, Resolve's marker EDL), which of WebM, AV1, CineForm,
  QuickTime Animation and 32-bit float PCM in MOV each editor opens (`EDITOR_OPENS`), and GoPro's
  patent declaration for SMPTE ST 2073 before release.
