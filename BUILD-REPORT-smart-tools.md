# Build report: smart tools (wave 11)

Branch `feat/wave11` in `/home/user/wt-w11b`. Design: [`docs/design/smart-tools.md`](docs/design/smart-tools.md)
(§0 holds the owner's decisions, §20 the files and parts, §21 where wave 10 and phase B meet this
wave, §22 the tests). The branch starts at the head of wave 10 (`feat/wave10`, everything through
Captions Studio phase B), then the design commits and the contracts commits (head `ea95902`), the
six parts, and wave 10's review fixes merged in last. Nothing was pushed.

## What was built

* **Step-by-step guide** (LT-03, §5, part P1). The **Guide** button in the title bar opens a panel
  beside the preview with one step per click, double-click, drag, shortcut and stretch of typing,
  titled from what was said near it ("Click “Export”") or marked *Needs a title*, with a note from
  the narration and a screenshot zoomed to the click with a ring. Blurred and pixelated areas stay
  hidden in every screenshot; a typing step is shot before its typing and later shots that may show
  it are marked, with *Blur the typed text*; *Blur an area…*; a full-size viewer and *Check
  screenshots*. Saves as a tagged PDF with bookmarks (printed by a sandboxed window from a temporary
  folder that is emptied after), one-file HTML, or Markdown with images, as a guide or a bug report;
  *Copy guide* puts HTML and plain text on the clipboard. English or Bangla, Hind Siliguri embedded.
* **Click-through demo** (LT-07, §6, P1). One offline HTML file: the whole screen with a hotspot on
  each click, the step beside it, Back, Next, the arrow keys, an optional end screen with one
  `rel="noopener noreferrer"` link, no network requests, a static guide with scripts off.
* **Titles from the screenshots** (§0 decision 10, §5.3.1, P6). *Also send the screenshots* under
  *Write titles*, for a service or built-in provider only, off until ticked for each run. Write
  titles first opens a send viewer with the very JPEGs that would go (768 px, quality 0.8, under
  512 KB, typed steps unticked, at most 200 in all and 50 a request), its own cost line, *Send* and
  *Cancel* (focused). Main checks every picture again; a provider that cannot read pictures says
  "This model does not read pictures…".
* **Find chapters** (F-10, §7, P2). Text tab › Chapters, the palette and Polish: candidates from
  screen changes (ffmpeg's freezedetect and frame differences, read once per recording and kept in
  `.cache/scenes.json`), pauses, section words, topic shifts (TextTiling) and title cards; YouTube's
  rules; names from title cards or what was said, *Rename?* for weak ones, *Intro / Part 2 / Part 3*
  for silent recordings; names from an AI service or AI on this PC when chosen. Found chapters carry
  `auto`, are Review rows (Keep, Remove, one undo step each), and count for nothing that must only
  trust the user (badge numbers, *Auto* chapter titles, the link check) until kept. The Captions
  tab's *Suggest chapters* runs the same tool with the AI's suggested starts as candidates.
* **Short clips** (LT-02, §8, P3). *Find short clips…* (Copies menu, Publish dialog, export done
  view): up to ten 15–90 s moments with reasons, playable in the preview; each ticked one becomes a
  copy (`copyOf`, `clipOf`, vertical by default, captions on) sharing the original's media. *Make a
  shorter version…* keeps the most useful sentences in a 30, 60 or 90 s copy with smooth cuts whose
  cuts Review lists. The original's `project.json` is never written.
* **AI on this PC** (F-04, §9, P4). Settings › AI on this PC: the PC's line, two catalogue models,
  download with progress, resume, Cancel and Remove, *Use* Automatic / Recommended / Small, measured
  speeds. The bundled helper `ssw-llm.exe` (Rust around llama.cpp through `llama-cpp-2` 0.1.161,
  `--locked`, static MinGW, CPU only, one AVX2 build) answers one JSON-lines request at a time under
  a GBNF grammar made from each task's JSON schema; it never reads a GGUF's own chat template. Every
  text tool offers *On this PC (good for drafts)*, with `LocalProgress` and Stop beside the busy
  button and "Written on this PC" on results.
* **Any AI service and the cost up front** (NW-14, §10, §11, P5). *More services*: OpenRouter,
  Groq, Together AI, Azure OpenAI, Ollama and LM Studio on this PC, Other address; *Save and check*
  finds the JSON mode the service answers in; model comboboxes with *Load models*; keys encrypted in
  main, bound to the origin they were entered for, scrubbed from logs and errors; redirects refused;
  TLS problems named. A cost line under every group of AI tools (words sent, where, each action's cost
  or time on this PC), each button's own sentence, a question above the amount in Settings (US$1 by
  default, *Always ask* … *Never*) and once per unpriced model, prices from a dated list in the app
  refreshed daily from GitHub or the user's own, and the cost after a run.

## The owner's decisions as applied (§0)

1. **AI on this PC runs in a bundled helper** like `ssw-speech.exe`: `native/llm`, built by
   `scripts/build-native.mjs` as `native/bin/ssw-llm.exe`, static MinGW, CPU only, one AVX2 build
   (SSE4.2, AVX, AVX2, FMA and F16C on, everything newer off). It imports only `KERNEL32`,
   `ADVAPI32`, `msvcrt`, `ntdll` and `api-ms-win-core-synch-l1-2-0` (checked at build and by
   `verify-dist`). PCs without AVX2 are told so and offered no download.
2. **Models download from a Qbexel Hugging Face mirror first, unsloth's repository second.** The
   mirror does not exist yet: `LOCAL_MODEL_MIRROR` in `src/shared/localAi/catalog.ts` is `null`, so
   downloads come only from `unsloth/gemma-4-E2B-it-GGUF` at `0314792d…` and
   `unsloth/Qwen3.5-2B-GGUF` at `f6d5376b…`. No repository was created and nothing was uploaded.
3. **Two models, pinned by bytes and SHA-256**: Gemma 4 E2B Q4_K_M (Recommended, 3,106,738,272
   bytes, `740185b2…`) and Qwen3.5 2B Q4_K_M (Small, 1,280,835,840 bytes, `aaf42c8b…`). A file of
   the wrong size or without the `GGUF` magic is never opened; nothing downloaded is ever executed.
4. **No new data recorded while recording**: every tool reads what Flown already keeps; the
   recording side (`src/main/recording/*`, `recordingIpc.ts`, `windows.ts`, `src/shared/recording/*`,
   the toolbar, the recorder, `RecordingOptions.tsx`, `appSettings.ts`) is untouched by this wave:
   `git diff ab640c9 HEAD` (wave 10's head against this branch) over those paths, and over
   `src/main/security.ts`, is empty.
5. **Nothing is sent to an AI service unless the user picks one in that tool**: every tool defaults
   to offline or On this PC; the cost line says what goes where before the click. OpenRouter
   requests carry `provider.data_collection: "deny"` while *Only use hosts that do not keep my
   prompts* is on (the default).
6. **Plain http only for loopback hosts**: `readBaseUrl` refuses `http://` anywhere else, and the
   test catalogue for AI on this PC takes only a loopback address (unpackaged builds only).
7. **Hind Siliguri embedded** in the PDF and HTML guides for Bangla.
8. **Polish's *Find chapters* step is on by default for new Polish options** (videos of 2 minutes
   or more without chapters of the user's), with the three guards: it skips videos without captions;
   found chapters waiting for review do not switch on Captions Studio's chapter titles; and they do
   not restart wave 10's step-badge numbers. Saved Polish options without the step read it as off.
9. **Checks before release** need people: listed under *What needs a person*.
10. **Titles from the screenshots** as part P6, services only, off until ticked for each run.

## Merging

The first integrator pass merged the parts with `git merge --no-ff` in §20.7's order:

| Merge | Part | Conflicts and how both sides were kept |
|---|---|---|
| `395ae29` | P5 Any AI service and the cost | none |
| `39f542a` | P4 AI on this PC | none |
| `4f12d5f` | P2 Chapters | `tests/labelContrast.test.ts`: P4's and P2's contrast blocks both kept. |
| `717f26c` | P1 Guides and demos | `tests/smartPickers.test.ts` (test 102's list of renderer files that call `aiText`): every part's entry kept. |
| `1ca526a` | P3 Short clips | the same list. |

P6 was then built on that head (`a59e77c` … `037d5c1`), and this pass merged `feat/wave10` at
`ab640c9` (`aa46277`, 27 review-fix commits). Its one conflict was the doc comment of `badgeLabels`
in `src/shared/render/callouts.ts`: wave 10 counts a badge in the chapter where its entrance has
finished and skips badges a cut removes whole; this wave counts the user's chapters only. Both rules
are in the code and the comment now names both; the 18 test files the merge touched pass.

### Integration fixes (found by running the parts together)

Each code fix has a test that fails without it (checked by taking the code out and running the test):

1. **The guide asked the cost question twice** (first pass, `e583813`): P5's `CostLine` holds a
   click and asks; P1's run asked again. The run now leaves the question to the cost line, and Write
   titles and Tidy notes each read their own cost sentence. `tests/guidePanel.test.ts`.
2. **The guide read the screen a second time** (first pass, `e583813`): it sent `project.crop`
   where Find chapters, Short clips and Polish send `cropOf(project)`, so main's kept scan missed.
3. **`ai.e2e.cjs` counted On this PC as a saved provider** (first pass, `8eca5d3`): it now counts
   the saved providers' own list and checks On this PC is listed first with no key.
4. **An edited address of a service saved with a key received a request without one** (`02ca7b2`,
   found by §22.3 step 17): *Load models* on a service whose base URL was changed to another port on
   this PC sent `GET /v1/models` there with no key while the form said "Enter the API key for the
   new address." `ServiceStore.keyForDraft` now refuses with that message, and nothing is sent, for a
   service saved with a key whose preset needs one; Ollama and LM Studio, services saved without a
   key and new forms on this PC are unchanged. `tests/serviceStore.test.ts`.
5. **Find chapters and Short clips' Make did not read their cost sentence** (`9c716ce`): with names
   from an AI, each button's `aria-describedby` now also names the cost line's sentence (§11.5).
   `tests/findChapters.test.ts`, `tests/shortClipsPanel.test.ts`.
6. **Suggest chapters' hint described the old behaviour** (`79303a2`): "Chapters from what is
   said, added to the chapter strip" became the design's "Finds chapters with OpenAI's suggestions:
   Review lists each one." (with On this PC: "Finds chapters and names them on this PC…").
   `tests/captionsPanel.test.ts`.
7. **Review mode's rows ran under their own buttons** (`a87ba0c`, seen in the screenshots):
   `transcript.css` styled `.review-list`, `.review-row`, `.review-text` and `.review-actions`
   everywhere, so the Review panel took the Transcript list's wrapping layout and a found chapter's
   long detail ("Find chapters · page change, pause and cue word") made the list scroll sideways
   under Keep and Remove. The Transcript list's rules now apply to its own list only
   (`transcript-review`). The smart-tools e2e checks the rows (it failed before the change);
   `edit-by-text.e2e.cjs` and `review-mode.e2e.cjs` pass after it.
8. **`tests/e2e/smart-tools.e2e.cjs` written** (`f023897`), which no part owned (below). Secret's
   video, cursor and narration moved to `tests/e2e/smart-fixtures.cjs`, which `guides.e2e.cjs` now
   uses too.

## Tests

### Unit tests (vitest)

* Both typechecks (`npm run typecheck`: `tsconfig.node.json` and `tsconfig.web.json`) are clean.
* The full suite with `--maxWorkers=2` and a private `TMPDIR`: 529 files, 7,061 passed, 8 skipped,
  0 failed (after the wave 10 merge and before this pass's fixes: 529 files, 7,057 passed, 8
  skipped; this pass added four tests).
* The 8 skipped tests are `tests/llmHelper.test.ts`'s real-helper tests, which need a model and a
  built helper; they were run by hand below.
* The equivalence guard (`tests/smartEquivalence.test.ts`, tests 1, 3, 4, 5 and 101's old-project
  case) and the earlier waves' guards pass unchanged; no snapshot was regenerated.

### The text helper with a real model

`tests/llmHelper.test.ts` (§22 tests 66, 68, 80 and 128) with llama.cpp's own small test model
`stories15M-q4_0.gguf` (19,077,344 bytes, SHA-256 `66967fbe…1739` checked after the download from
the pinned `ggml-org/models-moved` commit, deleted afterwards):

* the host build (`node scripts/build-native.mjs --llm-host`): 8 passed;
* the Windows build `ssw-llm.exe` under wine: 7 passed, the parent-process test skipped as
  documented (a Windows process cannot see Linux process ids).

### End to end (`tests/e2e/*.e2e.cjs`, under `xvfb-run`, one file at a time, without `TMPDIR`)

`tests/e2e/smart-tools.e2e.cjs` covers §22.3 steps 1, 10–12 and 16–20 in six tests; steps 2–9 are
in `guides.e2e.cjs` and 13–15 in `short-clips.e2e.cjs` (the parts' files, on the same fixtures):

| Test | What it checks |
|---|---|
| 1 Old project | wave 8's *review-mode* fixture opens and closes with `project.json` byte for byte; the Guide button and Find chapters are there; Review lists the four rows it listed before and no found chapter. |
| 10 11 Find chapters | Secret: chapters at 0:00, 12.4 s and 26.4 s named "Click the Export button", "Open settings", "Save it", the notice, three Found chips, three Review rows; Remove is gone and back with one Undo; Keep drops `auto` and the chip. Silent: Intro, Part 2, Part 3 at 0, 12 and 26 s, three *Rename?*, the focus on the first name, the scan kept and not read again. |
| 12 17 18 A service | Other address at a mock on 127.0.0.1: Load models fills the combobox; Save and check says "Works." and sent its key; the address edited to a second mock's port with no key: "Enter the API key for the new address." and the second mock received nothing; the cost line names `127.0.0.1:<port>`, never OpenAI, "Cost unknown"; Suggest chapters asks once for the unpriced model, then the found chapters carry the service's titles and Review says "Suggest chapters with 127.0.0.1…"; Find chapters replaces them; the Guide panel's line reads "7 steps · 4 need a title · 1 may show typing" once the screen is read (§22.3 step 2), and its send viewer names the service and Cancel sends nothing; Suggest a title arrives; prices of US$1,000 a million: the line shows US$, the click asks, Cancel (focused) sends nothing; *Always ask* with a cheap price asks too; the key is never in `main.log`. |
| 16 AI on this PC | a test catalogue entry on a server on this PC downloads (SHA-256 checked) and *Use* shows Automatic; Captions offers "On this PC (good for drafts)" with "Stays on this PC · … about 50 seconds"; Summarize shows the progress line beside the buttons and the summary with "Written on this PC"; Stop ends a run in 120 ms and the fake helper is told to cancel. |
| 19 Title bar | at the minimum window size every title bar button is in view and takes a click, and the Guide and Copies labels hide like Versions'. |
| 20 Bangla | the guide's titles in Bangla words ("“রপ্তানি”-এ ক্লিক করুন" …) and digits; the saved PDF's text (`pdftotext`) holds every title unchanged; Find chapters names chapters from the Bangla sentences. |

The §20.7 list, then the parts' own files, each run alone on the build of its time (a failing file
would have been run once more alone; none failed):

| File | Tests | Result |
|---|---|---|
| smart-tools | 6 | pass (on the final build, with the screenshots) |
| editing-polish | 17 | pass |
| captions-studio | 8 | pass |
| review-mode | 10 | pass (again after the CSS fix below) |
| polish | 5 | pass |
| one-click-polish | 3 | pass |
| titles | 6 | pass |
| vertical-video | 1 | pass |
| publish-pack | 4 | pass |
| captions | 9 | pass |
| transcription | 4 | pass |
| offline-captions | 11 | pass |
| bangla-captions | 4 | pass |
| export | 10 | pass |
| export-pack | 5 | pass |
| render | 3 | pass |
| versions | 3 | pass |
| commands | 5 | pass |
| ai | 4 | pass |
| search | 3 | pass |
| share | 1 | pass |
| ui | 5 | pass |
| packaging | 2 | pass; its `verify-dist` half skips without `dist/win-unpacked` (no installer was built) |
| guides | 1 | pass (on the final build) |
| short-clips | 1 | pass (on the final build) |
| edit-by-text | 4 | pass (after the CSS fix, which touches its list) |

Every file named in §20.7 exists; none was skipped.

### Build and packaging checks

* `npm run -s build`: succeeds (the usual chunk-size warning only).
* `npm run notices -- --check`: "resources/THIRD_PARTY_NOTICES.txt is up to date (257039 bytes)".
* `node scripts/build-native.mjs --require`: succeeds in 4 min 24 s and builds all four Windows
  helpers: `ssw-capture.exe` (443 KB), `ssw-speech.exe` (3,528 KB), `ssw-speech-compat.exe`
  (3,399 KB) and `ssw-llm.exe` (7,149 KB, imports `api-ms-win-core-synch-l1-2-0.dll`,
  `ADVAPI32.dll`, `KERNEL32.dll`, `msvcrt.dll`, `ntdll.dll`). It ran in a copy of `scripts/` and
  `native/` under the scratch folder, with `native/speech` and `native/llm` linked to this worktree,
  because `native/bin` here is a link to the main checkout's and must not be overwritten by a
  worktree's build. `node scripts/build-native.mjs --llm-host` built the host helper (5,300 KB) the
  same way.

## Screenshots

`docs/screenshots/smart-tools-*.png`, each under 300 KB, taken by the e2e runs with
`SSW_E2E_DOC_SHOTS=1`: `smart-tools-guide-panel.png` (the Guide panel on Secret), `smart-tools-send-screenshots.png` (the
send viewer, "These screenshots go to 127.0.0.1:…"), `smart-tools-guide-bangla.png`,
`smart-tools-find-chapters.png` (the Text tab's chapters with Found chips),
`smart-tools-review-chapters.png`, `smart-tools-service-form.png` (Other address in *More
services*), `smart-tools-cost-line.png`, `smart-tools-cost-question.png`, `smart-tools-local-ai.png`
(Settings › AI on this PC with the test model; its size reads 0.0 GB because the test file is 64 KB),
`smart-tools-local-summary.png` (a summary written on this PC), `smart-tools-short-clips.png` and
`smart-tools-shorter-version.png`. The largest is 260 KB.

## What needs a person

* **Decision 9, before release:**
  * a native speaker reads the Bangla words of guides, demos and chapter names (`guideWords.ts`'s
    `bn` table, the demo's words, the offline chapter names), and the local models' Bangla output;
    the e2e run named a chapter "এরপর আমরা সেটিংস খুলব", keeping the cue word "এরপর" ("Next") that the
    English names drop;
  * on the reference Windows PC: the local models' speed and memory (reading and writing tokens a
    second, the peak, load time) against the catalogue's numbers; the PDF with Hind Siliguri and
    Windows' own fonts; the installer's size with `ssw-llm.exe`; one real model download from
    unsloth's repository (resume after a cut, the hash check); *Copy guide* pasted into Google Docs,
    Word, Outlook, Confluence, Notion and Jira;
  * an evaluation set of 20 recordings (10 English, 10 Bangla) run through each local task and
    rated against a service; decision 8 (Find chapters on by default in Polish) depends on it;
  * for titles from the screenshots: real vision models with the 768 px screenshots, and each
    provider's wording when a model cannot read pictures.
* **Creating the Hugging Face mirror** (decision 2): make Qbexel's repository, upload the two files
  byte for byte, pin its commit, and only then set `LOCAL_MODEL_MIRROR`. Until then unsloth's
  repository at the pinned commits is the only source.
* **The Windows measurements** above, and running the e2e suite once on Windows: the helper under
  Windows' job objects and low priority, the taskbar progress of long local runs, and the share
  actions after a guide is saved.

## Known gaps and notes

* **§22.3 step 12 as written cannot hold on a 40 s recording**: the chapters task (unchanged by
  design, test 5) keeps at most max(2, round(last caption end / 120)) suggestions, two for Secret's
  27 s of captions. The service's first two titles name the chapters they merge with; the third
  start is found offline and named from what was said. The e2e checks that.
* **§22.3 step 17's "the log file holds the origin"**: nothing in main logs AI requests, so the log
  holds neither the key nor the origin. The e2e checks the key is absent and prints whether the
  origin is there.
* **Steps 2–9 and 13–15 of §22.3 run in `guides.e2e.cjs` and `short-clips.e2e.cjs`**. Not
  automated end to end there: step 2's *Go to 0:16* and the timeline click with the panel open,
  Ctrl+Z of a title edit, *Blur an area…* timing (2.9667 s), step 4's viewer, step 5's PDF outline,
  step 6's bug-report Markdown, step 7's scripts-off Chromium check and step 8's hotspot,
  `prefers-reduced-motion` and 600 px layout; the units cover each of them (P1's tests 14–28 and
  105–114).
* **The Captions tab still holds the old Suggest chapters code** (`newChapters`, `addChapters`,
  the `captions-chapters-suggestion` block): unreachable since Suggest chapters runs through Find
  chapters, and older tests in `tests/captionsPanel.test.ts` still exercise it; it should be
  removed with them.
* **Moving a service saved with a key to another address on this PC**: *Load models* now asks for
  the key (fix 4), but *Save and check* still saves it without one (the key is dropped and none goes
  to the new address, as `tests/serviceStore.test.ts` asks). The two agree on what is sent; they
  differ on whether a key is asked for.
* **Until the screen is read, the Guide panel counts every later step as one that may show typing**
  (§5.5.7: without a scene scan every later shot is considered): `guides.e2e.cjs` reads "3 may
  show typing" right after the steps appear; it becomes 1 when the scan arrives (checked in
  `smart-tools.e2e.cjs`).
* **From the parts' reports**, still open: the scan-only stop channel; `LocalNote` in the other text tools ("Written on this PC" is now under
  every result made on this PC, §2.5); Share
  and Copy to folder for saved guides; the run-cost notice, which only Clean up and Languages show;
  the 200-pictures-in-all cap enforced only in the renderer (main sees one request at a time).
* **Design text to update**: test 116 against §7.4's wording about which user chapter stands in for
  0:00 (the code follows the test), and §11.2's token ratios, replaced by measured ones (P5).
* **Contract changes made by the parts**, for review: P1 `GuideStepEdit.shown?: true`; P4 `LocalNote`
  and the "Written on this PC" line in `CaptionsPanel.tsx`, and bytes and a SHA-256 in
  `tests/smartRouting.test.ts`'s catalogue entry; P5 `CostLine`'s optional `notes`, `estimateText`'s
  `live`, `costSentence`'s `what`, `ProviderForm`'s `onSaved` check, `ServiceStore`'s provider count,
  `compatibleClient`'s base fetch, and one line each in `DraftScript.tsx`, `CleanupSection.tsx` and
  `LanguagesSection.tsx`.
