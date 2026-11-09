# Smart tools (wave 11): design

Plan: `docs/PLAN.md`, wave 11 "Smart tools", five items. Roadmap items: LT-03 (step-by-step guide or bug
report), LT-07 (click-through demo), F-10 (chapters without AI), LT-02 (highlight clips and short
versions), F-04 ("On this PC" AI provider) and NW-14 (any AI service, a model list, and the cost up
front). They lean on F-06 (know what was clicked) and F-13 (model manager), which this wave does not
build: §0 decisions 4 and 10 and §23 say what it leaves for them.

This is the second version, after the product, engineering and licence reviews of the first
(`a751320`). §3.3 lists where it departs from them.

Written against `rev/wave11-design` at `84b8862` (everything through wave 8, versions, and Captions
Studio phase A). Line numbers refer to that commit unless a branch is named. Two pieces of work land
before this wave's contracts step (§20.0):

- **Captions Studio phase B** (`/home/user/wt-csb`, `da87a24` when this was revised, still moving).
  It adds `src/shared/review/captionReview.ts` behind `review.ts`, six Review kinds in
  `src/shared/review/copy.ts`, the bleep gains, `requestId` and `cancelAiText` in the Captions
  Studio runners (`greatRun.ts`, `CleanupSection.tsx`, `LanguagesSection.tsx`; not the Captions tab's
  own tools, `CaptionsPanel.tsx:1068`), and version areas for its fields. This wave's Review rows
  follow its pattern.
- **Wave 10, editing polish** (designed in `/home/user/wt-w10/docs/design/editing-polish.md` at
  `06f7d33`, built before this wave). It adds `editingReview.ts` and the `join` and `colour` kinds,
  `settleJoins` and `settleGrade` in the settle chain (`Editor.tsx:207`), the `smoothCuts` Polish step,
  version areas, the chapter progress bar (`chapterBar.ts`, `chapterBarLayer.ts`,
  `chapterBarData.ts`), step badges numbered per chapter (`badgeLabels`, `src/shared/render/callouts.ts`),
  `MusicDownloadsSection.tsx` and the `soundLibrary:*` channels. Its §14 (Security) sets the download,
  path and IPC rules this wave copies (§16). This wave creates no file wave 10 names in its §17, adds
  no drawing code, and reaches every file both waves touch only after wave 10 has merged (§21).

The research behind this design is kept outside the repository, in the lead's scratch folder
`w11-design/`: `guides-demos/` (the PDF, image-size, demo and scene-change experiments, with their
scripts) and `local-ai/` (node-llama-cpp and static llama.cpp builds, benchmarks of three models,
tokenizer counts, price-list samples and the redirect and TLS tests). The second version also checked
the pinned model repositories, the `llama-cpp-2` and `llama-cpp-sys-2` crates and OpenRouter's live
model list (§9, §10.4).

Terms used below:

- **Source time, edit time, video time, viewing time**: as in `editing-polish.md`. Chapters are stored
  in source time (`Chapter.t`) and judged in video time (`outputChapters`,
  `src/shared/render/chapters.ts:32`), the time a viewer sees.
- **L**: the video's length in video time (clips, speeds and pause freezes), seconds.
- **Step**: one instruction of a guide (§5.1). **Shot**: the screenshot of a step (§5.5).
- **Panel**: a docked panel in the place and width of Review mode's (`ReviewPanel.tsx:461`, an `aside`
  with `role="region"`, 360 px over the Inspector, `review.css:26`). The preview, transport and
  timeline stay visible and usable beside it. At most one panel is open: opening one closes another.
- **Moment**: a stretch of the video that could be posted alone, 15 to 90 s (§8).
- **Service**: an AI provider reached at a base URL the user typed, speaking OpenAI's chat API (§10).
- **On this PC**: Flown's own text model and its runtime (§9); for captions, today's speech models.
- **Pending**: an automatic change Review mode still lists (`docs/design/review-mode.md`).
- **User chapters**: chapters without `auto` (§4.1): every chapter from before this wave, and found
  chapters once kept or edited.

The rules of the earlier waves hold:

- Old projects and settings load, draw and save byte for byte as before. Every new field is optional,
  every reader returns `undefined` for an absent field, and an equivalence guard written before any
  part starts pins this (§22.2).
- Preview and export draw the same frames. This wave draws nothing new into the video: screenshots
  are drawn by the export's own drawing path (`renderThumbnail`, `exporter.ts:583`).
- One user action is one undo step.
- Everything works with the keyboard and a screen reader. The app UI meets WCAG AA contrast with the
  tokens of `src/renderer/src/styles.css`.
- Everything runs offline by default. An AI service is optional and only ever used after a click
  that names it and shows the cost first (§11).
- API keys stay in the main process and never reach the renderer or the logs
  (`src/shared/diagnostics/redact.ts`).
- Only models, runtimes and data whose licences allow commercial redistribution (Apache-2.0, MIT,
  BSD, CC0), each pinned by SHA-256 and capped in size, downloaded on demand from pinned sources.
- Private text (window titles, typed text, file paths) is never sent anywhere or written into a
  guide or chapter name without the user seeing it first.
- New automatic changes are listed in Review mode with Keep and Remove.
- Bangla and other scripts work wherever text is made or drawn.
- Nothing on the recording side changes: `src/main/recording/*`, `src/main/recordingIpc.ts`,
  `src/main/windows.ts`, `src/shared/recording/*`, `Toolbar.*`, `src/renderer/src/recorder/*`,
  `RecordingOptions.tsx` and `appSettings.ts` belong to the other account. `src/main/security.ts`
  and the renderer's CSP do not change.

---

## 0. Decisions for the owner

Nothing in this wave changes an existing project until the user asks for it, sends anything anywhere
by default, or records anything new. The installer grows by about **2.4 MB** (the text-model
runtime, §9.1, plus a 30 KB price list and the guide template), under the 5 MB line. Every model is
Apache-2.0. Each decision has a recommendation; the design works with the recommended answer and
says what changes otherwise.

1. **How AI on this PC runs.** The text model needs llama.cpp (MIT), native code. Nothing that is
   downloaded may run (`src/shared/speech/catalog.ts:2-5`, `src/main/assets/assetStore.ts:9`), and
   every shipped `.exe` is signed (`electron-builder.config.cjs:75`). Choices:
   - (a) **A bundled helper, `ssw-llm.exe`**, built from llama.cpp the way `ssw-speech.exe` is built
     from whisper.cpp: static MinGW, CPU only, one AVX2 build, no DLLs. A static build of the same
     llama.cpp measured **6,935,552 bytes, 1,965,452 bytes with xz** and imports only `KERNEL32`,
     `ADVAPI32` and `msvcrt` (research `local-ai/exe/`). Installer growth about 2.2 MB. PCs without
     AVX2 do not get AI on this PC: budget Celeron and Pentium PCs sold up to about 2021 (Gemini Lake
     N4000, N4020, N5000; Jasper Lake N4500, N5100, N6000; Pentium Gold G5400) and PCs older than
     about 2013. The memory gates (8 or 12 GB, §9.5) already exclude many of them. A second, SSE4.2
     build would cost about 2 MB more. **Recommended: AVX2 only.**
   - (b) node-llama-cpp 3.22.3 (MIT) in a utility process: 33,979,230 bytes unpacked (11.9 MB
     compressed), needs the Visual C++ runtime, which Windows does not include, and does not stop
     while it reads a prompt (11–27 s measured). Over the 5 MB line.
   - (c) Download the runtime on demand: breaks "nothing downloaded runs". Rejected for this wave.
2. **Where the models download from.** The two models (§9.3) are published as GGUF files by unsloth
   on Hugging Face, pinned by commit, bytes and SHA-256. unsloth's repositories hold no LICENSE file:
   the licence is only `license: apache-2.0` in each README's front matter. Choices:
   - (a) **Qbexel's own Hugging Face repository first**, holding the same bytes plus the Apache-2.0
     text and a NOTICE naming Google (Gemma) or Alibaba Cloud (Qwen) and unsloth's quantisation, as
     Apache-2.0 §4 asks of a redistributor; unsloth's repository at the pinned commit second. Until
     the Qbexel repository exists, `LOCAL_MODEL_MIRROR` is `null` and unsloth's alone is used.
     **Recommended.**
   - (b) unsloth's repository only. A third party could delete it; the pin makes a changed file fail,
     never load.
3. **Which models.** **Recommended** · Gemma 4 E2B (3.1 GB, every language, 12 GB PCs) and **Small**
   · Qwen3.5 2B (1.3 GB, rough drafts, 8 GB PCs), both Apache-2.0. Qwen3.5 4B is left out: Gemma 4
   E2B matched it in every task measured, reads four times faster, writes faster and peaks lower
   (§9.7); it comes back only if the evaluation of decision 9 shows it better in English. Not
   offered: Llama 3.2 (a 700-million-user cap and "Built with Llama"), LFM3 (commercial use only
   under US$10 million revenue), Cohere tiny-aya (non-commercial). **Recommended: the two.**
4. **Data recorded while recording.** App switches (F-10) and the name of what was clicked (F-06)
   need a foreground-window log and Windows UI Automation in the capture helper, which belong to the
   other account. This wave does without them: chapters come from screen changes and pauses, step
   titles from the narration (or the screenshots, decision 10). The later step, to agree with the
   other account (§23, item 1): an optional `windows.json` (time, program file name, window title)
   and `uia.json` (time, element name and role at mouse-down, never a text field's value, never a
   password box) next to `cursor.json`. The seams that would read them are named in §5.2 and §7.3.
   **Recommended: not in this wave; ask the other account for the later step.**
5. **Nothing sends data by default.** Find chapters, guide titles and clip picks run offline unless
   the user picks an AI service in that tool; each AI action shows what it sends, where, and the cost
   before the click (§11). For OpenRouter, Flown asks it to use only hosts that do not keep prompts
   (`provider.data_collection: 'deny'`), changeable in the provider's form. **Recommended: yes to
   both.**
6. **Plain `http://` only on this PC.** A service's base URL must be `https://`, except a loopback
   host (`localhost`, `127.0.0.0/8`, `[::1]`) for Ollama and LM Studio. **Recommended: refuse http to
   other machines; such a server can be put behind https.**
7. **Fonts inside the files the guide writes.** A PDF embeds the subsets of the fonts it uses
   (Hind Siliguri, SIL OFL 1.1, already bundled). An HTML guide with Bangla text embeds Hind Siliguri
   400 and 600 as WOFF2 (about 280 KB). The OFL allows fonts embedded in documents; a notice comment
   names the licence. **Recommended: allow both.**
8. **Polish finds chapters.** A new Polish step, *Find chapters*, on by default in new Polish
   options, for videos of 2 minutes or more that have no chapters of the user's. Three guards keep it
   from changing what the user did not ask for (§13.3): it skips videos without captions (no
   "Part 2, Part 3" names in exported files); found chapters waiting for review do not switch on
   Captions Studio's chapter titles; and they do not restart wave 10's step-badge numbers. Review
   lists each one. Saved Polish options without the step read it as off. **Recommended: on by default
   for new options, with the guards; off if decision 9's evaluation finds the names poor on real
   recordings.**
9. **Checks before release.**
   - A native speaker reads the Bangla words of guides, demos and chapter names (§15), and Bangla
     summaries and translations from each local model.
   - The reference Windows PC measures local model speed and memory (§18), the PDF's fonts with
     Windows' own fonts, the installer's size, one real model download, and pasting *Copy guide*
     into Google Docs, Word, Outlook, Confluence, Notion and Jira (which keep the screenshots, §5.8).
   - An evaluation set: 20 recordings (10 English, 10 Bangla) through each local task, each result
     rated against the same task on a service. The per-model, per-task notes it gives go into the
     catalogue and are shown beside the provider choice (§9.3).
   **Required.**
10. **Titles from the screenshots** (LT-03's vision mode). Without narration, step titles fall back
    to "Click near the top right". Write titles could also send each step's screenshot to a service
    that reads pictures, after the user has seen exactly the pictures that go and the cost (§5.3.1).
    Alternatives: reading the clicked label on this PC (OCR, shared with F-07; Windows OCR has no
    Bangla) or waiting for UI Automation (decision 4). **Recommended: yes, as part P6, built after P1
    and P5 merge; services only, off until ticked for each run.**

---

## 1. Summary

- **Step-by-step guide.** A **Guide** button in the title bar opens a docked panel beside the preview
  that lists one step per click, double-click, drag, shortcut and stretch of typing of the recording,
  each with a title, a short note from what was said, and a screenshot zoomed to the click with a
  ring on it. Titles come from the narration ("Click “Export”"), else they are marked *Needs a
  title*; an AI service or AI on this PC can rewrite them, and with decision 10 a service can read the
  screenshots. Every screenshot can be viewed full size, and *Check screenshots* walks through them.
  A typing step's own screenshot is taken before the typing; later screenshots that may show what was
  typed are marked, with a one-click blur. Blurred and pixelated areas stay hidden in every
  screenshot. The guide saves as **PDF** (tagged, with bookmarks), **HTML** (one file) or
  **Markdown** (a folder with images), as a guide or a **bug report**, or is copied for pasting.
- **Click-through demo.** The same panel saves one offline HTML file that viewers click through:
  the whole screen with a hotspot on each click and the step's title in a callout beside it, Next and
  Back, arrow keys, an optional end screen with one link. With scripts off it reads as the guide. It
  loads nothing from the network.
- **Chapters without AI.** *Find chapters* (Text tab, palette, Polish) splits the video where the
  screen changes and settles, where the speaker pauses or starts a new section, where the topic of
  the narration shifts, and at the user's own title cards. Each split needs two kinds of evidence or
  one strong one, so a one-topic video is not cut at random pauses. It keeps YouTube's rules: the
  first at 0:00, at least three, each at least 10 seconds. Names come from title cards, the first
  sentence of each part, or a phrase said in it; weak names are marked *Rename?*. Silent recordings get
  "Intro", "Part 2", "Part 3". The Captions tab's *Suggest chapters* runs the same tool with an AI's
  suggestions. Every found chapter is a Review row.
- **Short clips.** *Find short clips* opens a panel listing the best 15–90 s moments with the reasons
  ("Opens with a question · 6 clicks · 45 s"), scored offline, each playable in the preview. Each
  moment the user ticks becomes a copy of the project (vertical by default, captions on), its media
  shared with the original. *Make a shorter version* keeps the most useful sentences, in order, in a
  copy with smooth cuts whose cuts Review lists. The original never changes.
- **AI on this PC.** Settings › *AI on this PC* downloads a small model (Recommended: Gemma 4 E2B,
  3.1 GB; Small: Qwen3.5 2B, 1.3 GB), checked by SHA-256. It then appears as "On this PC (good for
  drafts)" in the text tools: titles, chapter names, summaries, clean-up, translation, the publishing
  copy pack, script drafts, step titles and notes. No key; nothing leaves the PC. It runs one request
  at a time in a bundled helper, with progress and **Stop** beside every busy button.
- **Any AI service.** *Add a provider* offers **More services** (OpenRouter, Groq, Together AI, Azure
  OpenAI, Ollama and LM Studio on this PC, or any OpenAI-compatible address), with a model list loaded
  from the service. Every model field becomes a list loaded from the provider, with free text still
  allowed. Keys stay in the main process, bound to the host they were entered for.
- **The cost up front.** Every group of AI tools shows, before a click, what it sends and where, and
  each action's cost ("Chapters about US$0.02 · Title under US$0.01") or, on this PC, its time
  ("About 4 minutes"). Above an amount the user sets (US$1.00 by default) it asks first. Prices come
  from a dated list in the app, refreshed daily from GitHub, or from the user's own numbers. After a
  run the notice says what it cost.

---

## 2. What the user sees

### 2.1 The guide

**Where.** A **Guide** button in the title bar, between Publish and Export (`data-testid="guide-open"`,
title "Make a step-by-step guide or a click-through demo from your clicks"); like the others its label
hides at narrow widths and the icon (a numbered list) stays. The palette has *Make a step-by-step
guide…*, *Make a click-through demo…* and *Write a bug report with steps…* (§2.8).

**The panel** (a panel as defined above, `data-testid="guide-panel"`). Its heading follows how it was
opened: "Step-by-step guide", "Click-through demo" (Format set to the demo) or "Bug report" (Kind set
to Bug report). The preview, transport and timeline stay usable: *Go to* shows the frame, *Add a step
at the playhead* works on the playhead the user just moved, and a blur box is drawn in the preview
while the panel stays open. Esc inside the panel closes it and returns focus to the Guide button, as
Review mode's does.

| Part | What it holds |
|---|---|
| Top | **Title** (text field, the recording's name by default); **Intro (optional)** (text area, at most 2,000 characters, shown under the title in every format); **Kind**: *Guide* or *Bug report* (radio group); **Language**: *English* or *বাংলা* (radio group, Bangla preselected when the captions are Bangla). |
| Steps from | Only when the project has automatically numbered step badges (wave 10): **Steps:** *From your step badges (8)* or *From every click* (radio group; badges first). §5.1 rule 11. |
| Note under the top | "Each click, shortcut and stretch of typing is a step. Check each screenshot at full size before you share the guide: it shows what was on screen. Areas you blurred or pixelated stay hidden." |
| Bug report fields | With *Bug report*: **Expected** and **Actual** (text areas, placeholders "What should happen" and "What happens instead"); **Show the screen at the playhead as Actual** (button; adds a screenshot under Actual, drawn like every shot; **Remove** takes it away); **Details** (a list of checkboxes, each ticked, with its text editable: "Recorded on 7 November 2026", "Screen 1920 × 1080 at 150%", "Length 4:12"). |
| Step list | One row per step in time order (§2.1.1). Rendered 20 at a time as the list scrolls; screenshots are made in the background in step order and appear as they are ready. |
| Under the list | **Add a step at the playhead** (adds a step at the playhead with the title "Step"). A line: "**30 steps** · 4 hidden · 12 need a title · 3 may show typing" (each part only when not zero). **Next step without a title** (moves focus to the next row marked *Needs a title*, wrapping) and **Check screenshots** (§2.1.2). |
| Titles | **Titles:** *From what you said (offline)* or *Write them with* [text choice], then **Write titles**, with the cost line of §11 under it. **Also send the screenshots** (checkbox, off; only with a service that reads pictures, decision 10, §5.3.1). When no step has words near it, *Write titles* is disabled with the reason tied by `aria-describedby`: "Nothing was said near these steps." (with the checkbox ticked it is enabled again). |
| Notes | **Tidy notes with** [text choice] (button), with its cost line: rewrites each note as one or two short sentences (§5.4). |
| Format | **Format**: *PDF*, *HTML*, *Markdown*, *Click-through demo* (radio group, remembered). **Page size** (select, PDF only: A4 or Letter, A4 unless Windows' region is the US, Canada, Mexico or the Philippines). **Use the brand kit** (checkbox, shown when a brand kit exists, on: its logo in the header and its first colour for headings and the demo's buttons, §5.6). With the demo: **End screen** (disclosure, §6.1). |
| Footer | The primary button names the format: **Save PDF…**, **Save HTML…**, **Save Markdown…** or **Save demo…**. **Copy guide** (puts the guide on the clipboard with its screenshots, §5.8). **Close**. |

#### 2.1.1 A step row

| Part | Copy and behaviour |
|---|---|
| Include | Checkbox "Include step 3" (checked). Unchecking hides the step from every output (`hidden`). |
| Number and time | "3" and the step's video time ("1:05"); the time is a button "Go to 1:05" that moves the playhead to the step's shot time, so the preview shows the frame the shot is made from. |
| Screenshot | The panel's width (about 328 px), the ring drawn on it. It is a button: "View screenshot for step 3 full size" (Enter, Space or a click opens §2.1.2). A spinner with "Making the screenshot…" until ready. |
| Chips | Words, not colour: **Needs a title** (the title is a placeholder, §5.2); **May show what you typed in step 4** (§5.5.7); **AI** (the title or note was written by an AI and not edited since); **Whole screen**. |
| Title | Text field "Title of step 3" (at most 120 characters). |
| What to type | Typing steps only: text field "What to type in step 4 (optional)", empty. Flown never fills it from the recording; when filled, every format shows "Type: …" under the title. |
| Note | Text area "What to know about step 3 (optional)", filled with a short note from what was said (§5.4), at most 1,000 characters. **Use everything I said** (button) replaces it with all the words since the previous step. |
| View | Toggle button "Whole screen" (`aria-pressed`): off, the guide's shot is zoomed to the click (§5.5.3). With the demo format: toggle button "Zoom to the click in the demo" (off: the demo shows the whole screen, §6.1). |
| Typing steps | Toggle button "Show the screen after typing" (off). Its hint: "Later screenshots can still show what you typed." |
| Blur | **Blur an area…** moves the playhead to the step's shot time, adds a blur box over the click at that moment (covering the shot's frame, §5.5.8) and selects it; the hint "Drag the box over what to hide. The guide and the video both hide it." The panel stays open; only shots whose time the box covers are made again. |
| Blur the typed text | On rows marked *May show what you typed*: **Blur the typed text** adds one blur box over the typing place from the start of that typing until the screen next changes (§5.5.8), in one undo step. |
| Copy | **Copy screenshot** (puts the shot, ring included, on the clipboard as a PNG). |
| Link check | A title, note or *What to type* holding a link, email or file path nobody said is shown with the copy pack's note (`checkNote`, `src/renderer/src/publish/checkNote.tsx`), and saving or copying asks first (§12). |

#### 2.1.2 The full-size viewer and *Check screenshots*

- A modal dialog (`useModalFocus`) titled "Screenshot for step 3 of 30". The shot at 100% (one image
  pixel per device pixel), in a scrolling area that holds keyboard focus: arrow keys pan by 40 px,
  Page Up and Page Down by a screen, Home and End to the edges. **Fit** toggles 100% and fit to the
  window.
- **Previous** and **Next** move between included steps; **Blur an area…** closes the viewer and
  does what the row's button does; **Adjust** (§5.5.3) lets the user move the crop and the ring.
  Esc closes the viewer and returns focus to that step's screenshot button.
- **Check screenshots** opens the viewer on the first unchecked included step: steps marked *May show
  what you typed* first, then whole-screen shots, then the rest in order. Its line reads "Checked 12 of
  30". A shot counts as checked once shown in the viewer at 100% this session (not saved in the
  project), and only that picture: one made again differently (another crop, ring or blur) is not
  checked yet.
- With the *Click-through demo* format the rows, the viewer and *Check screenshots* show the demo's
  own shots (the whole screen unless *Zoom to the click in the demo*), and the *May show what you
  typed* and *Whole screen* marks, the line under the list and the question below count them: those
  are the pictures the demo saves. Seeing a step's zoomed guide shot does not check its demo shot.
- A bug report's Actual screenshot shows under the Actual buttons as a button "View the Actual
  screenshot full size, whole screen" that opens it in the viewer (titled "The Actual screenshot",
  with *Blur an area…* at its time and no *Adjust*); *Check screenshots* walks it with the
  whole-screen shots, and the line "Checked 12 of 31" and the question below count it.
- The first Save or Copy of a session with unchecked shots asks: "18 screenshots have not been
  checked at full size. 3 may show what you typed; 5 show the whole screen. Check them now?"
  (**Check now**, **Save anyway**; Check now focused).

**Empty and partial states.**

- No usable clicks (an invalid track, `valid: false`, or none recorded): key, typing and screen-change
  steps (§5.1 rule 8), and the note "No clicks were recorded, so a change of screen is a step too. Add
  or hide steps as you need."
- Nothing at all: "This recording has no clicks, key presses or changes of screen to make steps from.
  Add steps at the playhead." Save and Copy are disabled until a step exists.
- No captions, but speech heard (§7.8's rule): "Make captions first: step titles and notes come from
  what you say." with **Make captions** (opens the Captions tab's offline captions) and **Use clicks
  only** (dismisses the line for this session).
- More than 200 steps: the first 200 are listed, and "Only the first 200 steps are listed. Hide the
  ones you do not need or cut the video into parts."

**Saving and copying.** Save opens Windows' save dialog (PDF, HTML, demo) or folder dialog (Markdown)
in the main process. The default name is "<Title> guide", "<Title> demo" or "<Title> bug report".
While saving, the button reads "Saving…" and a live region announces "Saved “Billing guide.pdf”."
with **Show in folder** and, for a PDF, HTML or demo, the Share actions the user set up in Settings ›
Share ("Copy to OneDrive", "Post to #team"), as the export's done view offers them (`ShareDone.tsx`).
*Copy guide* announces "Copied the guide with 12 screenshots."

### 2.2 The click-through demo

The saved file opens in any browser. It shows one step at a time: the whole screen at the page's width
with a pulsing 44 px hotspot on the click, the step's title in a callout beside the hotspot, its note
under **More** in the callout, "Step 3 of 12", **Back** and **Next**, and after the last step the end
screen (§6.1) or **Start again**. Clicking the hotspot goes to the next step. Arrow keys, Page Up and
Page Down move between steps; Home and End go to the first and last. Below 640 px of width the title
and note sit under the picture. With JavaScript off, or when printed, it shows every step one below
the other, as the HTML guide does. The words are the guide's language: *Back*, *Next*, *More*,
*Start again*, *Step 3 of 12*; in Bangla *আগের ধাপ*, *পরের ধাপ*, *আরও*, *আবার শুরু*, *ধাপ ৩ / ১২*.

### 2.3 Chapters

**Text tab › Chapters** (`TextPanel.tsx:373`) gains, under *Add chapter at playhead*:

- **Find chapters** (`data-testid="find-chapters"`), with the hint "Splits the video where the screen
  changes and where you start something new, and names each part from what you say. Works offline,
  also for recordings without sound."
- **Options** (a disclosure, closed by default):
  - **How many**: *Fewer*, *Normal*, *More* (radio group; Normal). This sets the most chapters and the
    shortest; Flown makes fewer when the video has fewer clear places to split.
  - **Split at**: *Screen changes*, *Pauses*, *What you say* (checkboxes, all on).
  - **Names**: *From what you say (offline)* or *With* [text choice] (radio group), and the cost
    line of §11 under the second.
- While it runs: "Looking at the screen… 40%" and **Stop**. The screen is read once per recording
  and kept (§7.2); the second run is instant.
- After: a notice with the honest count, "Found 4 chapters. Review lists them: keep or remove each
  one." Each found chapter in the list has a chip "Found" (text, not only colour) until it is kept or
  edited. A weak name (a cut sentence or a number, §7.5) also has a hint "Rename?", and focus moves to
  the first such name field.
- When nothing is added: "Too short for chapters: YouTube needs at least 30 seconds.", "Found no clear
  place to split: no change of screen or new section.", or "Your chapters already split the video:
  found no more."
- With fewer than three chapters in the end: "Found 2 chapters. YouTube needs at least 3: add one by
  hand to use them there."
- No captions, but speech heard (§7.8): "Make captions first: chapter names come from what you say."
  with **Make captions** and **Split without words** (runs with screen changes and pauses only, names
  "Intro", "Part 2"…).

Running *Find chapters* again replaces the chapters it found that are still pending; user chapters
stay and are worked around.

**The Captions tab's *Suggest chapters*** runs the same tool (§7.6.1): with a service, the AI's
suggested starts join the candidates and its titles name them; with On this PC, Find chapters splits
offline and the model names the parts. Either way the chapters are found chapters with Review rows,
and each tool replaces the other's pending chapters. The button keeps its label; its hint reads
"Finds chapters with [provider]'s suggestions: Review lists each one."

**Review mode** lists each found chapter (§13). **Polish** gains the step *Find chapters* (§13.3).
Exports, the YouTube description, *one file per chapter* and wave 10's progress bar use found
chapters like any other, and the Export dialog's chapter note adds "3 of them not reviewed yet" while
any are pending. **The Publish dialog's YouTube card** shows, for a video of 2 minutes or more with no
chapters, "Add chapters so viewers can jump: **Find chapters**" (opens the Text tab at the section).

### 2.4 Short clips

**Entry points.**

- **The title bar's copy menu** (`CopyMenu.tsx:15`) is renamed: label, tooltip and `aria-label`
  "Copies: vertical, square, short clips"; at wide widths (`tb-label` shown) the button shows the text
  "Copies". It gains two items after *Make a square version*:

| Item | Second line |
|---|---|
| **Find short clips…** | "The best 15 to 90 second moments, each as a copy" |
| **Make a shorter version…** | "30, 60 or 90 seconds, the most useful sentences in order" |

- **The Publish dialog** and **the Export dialog's done view** have a link "Make short clips for
  Shorts and Reels…" that opens the Short clips panel.
- The palette: *Find short clips…* and *Make a shorter version…* (§2.8).

**The Short clips panel** (a panel, heading "Short clips", `data-testid="clips-panel"`):

- Intro: "The best moments to post on their own. Each one you make becomes a copy; this video stays as
  it is."
- **Focus on (optional)**: a text field, placeholder "billing, export", hint "Moments that mention
  these words rank higher."
- **Length**: *Any (15–90 s)*, *Under 60 s*, *60–90 s* (radio group).
- **Shape**: *Vertical 9:16*, *Square 1:1*, *Same as this video* (radio group; Vertical unless the
  video is already tall; remembered).
- **Captions** (checkbox, on when there are captions): each copy shows captions, with Auto style
  choosing the look for its frame (§8.5). Without captions: "No captions yet: **Make captions**".
- **Moments**: up to 10 rows, best first. Each row: checkbox "Make clip 2", the title (§8.4), "0:42 to
  1:27 · 45 s", the reasons ("Opens with a question · 6 clicks · Ends cleanly"), the first words in
  quotes, and **Play** (toggle button "Play clip 2"): the preview beside the panel plays that range
  (`playStretch`, `src/renderer/src/review/playStretch.ts:14`), the row reads "Playing · 0:12 of
  0:45", and Esc or a second press stops it.
- **Names**: *From what you say* or *With* [text choice] and the cost line.
- Footer: **Make 3 copies** (the count follows the ticks), and a line about disk space: "The copies
  share this video's files: they take almost no space." or, under OneDrive, "Each copy takes 1.2 GB:
  files in a OneDrive folder cannot be shared." When they would not fit: "These 3 copies need 3.6 GB;
  2.1 GB is free." and the button is disabled.
- While making: "Making copy 2 of 3…" with a progress bar and **Stop** (the copy being made is
  removed; finished ones stay).
- After: each made row reads "Made" with **Open** ("Open clip 2"); a list **Made from this video**
  at the bottom lists every copy whose `copyOf` is this project, each with **Open**.
- No captions, but speech heard (§7.8): "Make captions first: clips are picked from what you say."
  with **Make captions** and **Use activity only**. Silent recordings (the speech detector heard
  none, or there is no sound): the moments are the busiest stretches (§8.3) and the intro adds "No
  speech was found, so these are the moments with the most going on."
- Under 45 s: "Too short for clips: post the whole video."

**Make a shorter version** opens a small dialog: **Length** *30 s*, *60 s* (default), *90 s*, each
length at or above the video's own disabled with the reason ("This video is already 52 s");
**Focus on (optional)**; **Shape**; **Captions**; a line "Keeps 14 sentences, 58.6 s, smooth cuts";
**Make the copy**. Without captions the menu item says "Needs captions: make them first" and is
disabled (`aria-disabled`, still focusable, as copy menu items are today). In the copy, Review mode
lists each cut as "Cut 4.2 s for the shorter version" with Keep and Remove, so any sentence can be
brought back, and the smooth cuts as one row (§8.6).

### 2.5 AI on this PC

**Settings › AI on this PC** (a new section after *Captions on this PC*):

- Heading "AI on this PC". Intro: "Writes titles, chapter names, summaries, clean-ups, translations
  and posts with no key, and sends nothing anywhere. Good for drafts: check what it writes. Slower
  than an AI service."
- A line about the PC: "This PC: 16 GB of memory · processor OK", or why it cannot: "This PC's
  processor is too old for AI on this PC (it needs AVX2)." / "Flown could not check this PC's
  processor." / "AI on this PC is not part of this build."
- One row per model:

| Row | Second line | Licence line |
|---|---|---|
| **Recommended** · Gemma 4 E2B · 3.1 GB | "Every language, including Bangla. Needs 12 GB of memory." | "Apache-2.0 · Google" |
| **Small** · Qwen3.5 2B · 1.3 GB | "Rough drafts, for PCs with 8 GB of memory." | "Apache-2.0 · Alibaba Cloud" |

  Each row has **Download** ("Download Recommended, 3.1 gigabytes"), then a progress bar "1.2 of 3.1
  GB" with **Cancel**, then **Remove**. A row the PC cannot use says why ("Needs 12 GB of memory; this
  PC has 8 GB") and has no Download. A download that stopped resumes where it was.
- **Use** (radio group "Model for AI on this PC"): *Automatic* (default: Recommended when it is
  downloaded and there is room in memory for it at the time of the run, else Small), *Recommended*,
  *Small*; the two last only when downloaded.
- After the first run: "Measured on this PC: reads about 300 words a second and writes about 4."

**Settings › AI providers** gains a first row "On this PC · no key · good for drafts" with **Set up**
(scrolls to the section) or "Using Recommended" once a model is there.

**Every text tool's provider list** (Captions tab AI tools, Clean up, Languages, Publish, Draft script,
Find chapters, Guide titles and notes, Short clips names) shows **On this PC (good for drafts)** when a
model is downloaded and usable. Where the list is empty today ("Add an AI provider"), it adds "or use
AI on this PC" (opens Settings at the section). Two places never offer it: *Make my captions great*'s
AI picks (its only AI task is emphasis marks, which the small models do poorly) and splitting
chapters (§9.7). When On this PC is chosen, the catalogue's note for that task shows beside the
choice ("Small: titles often repeat the first sentence").

**While it runs**, beside every busy button of those tools (`LocalProgress`, §20.0): "On this PC:
loading the model…", "reading the captions… 45%", "writing… about 2 minutes left", and **Stop**. A run
longer than 10 seconds is a long job: the taskbar button shows its progress and the PC stays awake
(`src/main/longJobs.ts`). Results say "Written on this PC: check it before you use it."

### 2.6 Any AI service

**Settings › AI providers › Add a provider** (`ProviderForm.tsx`): the kind choice gains **More
services**, with the hint "OpenRouter, Groq, Together AI, Azure OpenAI, Ollama, LM Studio or any
OpenAI-compatible address". Choosing it shows:

| Field | Behaviour |
|---|---|
| **Service** | *OpenRouter*, *Groq*, *Together AI*, *Azure OpenAI*, *Ollama on this PC*, *LM Studio on this PC*, *Other address* (select). It fills the base URL (§10.5). |
| **Base URL** | Text field, filled by the service; Azure asks for "Your resource name" and builds the URL. A wrong URL says why under the field (§10.2). |
| **Name** | As today. |
| **API key** | As today; optional for a service on this PC ("No key needed for Ollama and LM Studio on this PC"). After the base URL changes to another address: "Enter the API key for the new address." |
| **Model** | A combobox (below). |
| **Prices** | Disclosure "Prices (US$ per million tokens)": **Input** and **Output** number fields, filled from the price list when it knows the model, else empty with "Not in Flown's price list: add them to see costs." |
| OpenRouter only | Checkbox **Only use hosts that do not keep my prompts** (on). |
| **Save and check** | Saves, then checks the key and what the service can answer in (§10.3): "Works." / "Works; Flown checks its answers more closely." with a details line "Answers in JSON with a schema" / "in plain JSON" / "in plain text". |

Under the form, always: "Your key and the text you send go to **api.groq.com**." (the ASCII host).

**Model fields become lists** for every kind: the text model and the transcription model fields are
comboboxes (a text field with a list; ARIA 1.2 combobox). **Load models** fills the list from the
provider (`ai:listModels`, §10.4) and shows "Loaded 47 models"; typing filters it; any text is still
allowed. With OpenRouter each entry shows its price, or "price varies" for its router models.

**Ask before a run that costs more than** (Settings › AI providers, a select): *Always ask*, *US$0.10*,
*US$1* (default), *US$5*, *Never* (pref `aiConfirm`, §4.7).

### 2.7 The cost line

One line under each group of AI tools that share a provider choice, tied to each button of the group
(§11.5):

- The Captions tab's tools: "Sends about 8,200 words of captions to OpenAI · Fix about US$0.05 ·
  Chapters about US$0.02 · Title under US$0.01 · Summary about US$0.01", and **Details** (a disclosure
  button: the model, the date of the prices and each action's token range).
- An action that stands alone (Translate, Write titles, Tidy notes, Find chapters with AI names, clip
  names) has the full form: "Sends about 8,200 words of captions to OpenAI · About US$0.03
  (gpt-6.1-sol, prices of 7 November 2026)".
- "Sends about 8,200 words to api.groq.com · Cost unknown for llama-4-scout: add its prices in
  Settings"
- "Sends about 8,200 words to OpenRouter · Cost unknown for openrouter/auto: it picks a model for each
  request"
- "Sends about 8,200 words to Ollama on this PC · No cost"
- "Stays on this PC · About 4 minutes"

Each button's `aria-describedby` points at a short sentence of its own: "About US$0.02; sends your
captions to OpenAI." Above the amount set in Settings (US$1.00 by default, the high end of the
estimate), the click asks first: "This costs up to about US$1.40 with claude-opus-5-5. Run it?"
**Run** / **Cancel**. A cost Flown does not know asks once per model in a session: "Flown does not
know what this costs with openrouter/auto. Run it?" (not with *Never*). A run on this PC longer than 10
minutes asks: "This takes about 25 minutes on this PC. You can keep editing meanwhile. Start?" After a
run with a service the notice adds "Cost about US$0.03 (12,400 tokens)."

### 2.8 Command palette

Appended to `COMMAND_LIST` (`src/shared/editor/commands.ts`), no default keys:

| Id | Title | Category | Keywords |
|---|---|---|---|
| `guide` | Make a step-by-step guide… | Publish | how to steps screenshots pdf markdown html instructions document tutorial copy paste |
| `demo` | Make a click-through demo… | Publish | interactive walkthrough hotspot offline html tour |
| `bugReport` | Write a bug report with steps… | Publish | steps to reproduce issue ticket expected actual jira |
| `findChapters` | Find chapters | Add | chapter markers sections youtube timestamps split auto scenes pauses |
| `shortClips` | Find short clips… | General | highlights moments shorts reels tiktok best parts copy vertical |
| `shortVersion` | Make a shorter version… | General | short summary cut down highlights 30 60 90 seconds copy |
| `localAi` | Set up AI on this PC… | General | offline local model no key download private gemma qwen |
| `aiService` | Add an AI service… | General | openrouter groq together azure ollama lm studio openai compatible api key provider model |

The existing *Suggest chapters with AI* (`aiChapters`, `commands.ts:156`) keeps its id and title and
runs §7.6.1.

---

## 3. Decisions

### 3.1 How this design was chosen

The research read the code (every place each item plugs into, and where wave 10 and phase B touch
the same files), the tools in this space (Steps Recorder, Snagit, Scribe, Tango, Guidde, Arcade,
Supademo, Storylane, Navattic, Loom, Tella, OpusClip, Vizard, Descript, CapCut), and ran
experiments: Electron 44.9.3's `printToPDF` with Bangla fonts, image formats and sizes, a single-file
demo prototype tested for keyboard use and network requests, ffmpeg's scene scores on a synthetic
screen recording, node-llama-cpp and a static llama.cpp build with three models on a 4-vCPU machine,
tokenizer counts in five scripts, and Node's fetch on redirects and TLS settings. Where a measured
number decided something, it is given with the decision. Three reviews (product, engineering,
licences) then read the first version; this one takes their findings, except where §3.3 says why not.

### 3.2 Decision table

| # | Decision | Alternatives rejected, and why |
|---|---|---|
| 1 | Guides and demos are built from what recordings already hold: clicks, keys, typing, scrolls, the cursor shape, step badges and the captions. | Waiting for UI Automation (F-06): needs the other account and only helps new recordings. OCR under the click: Windows OCR has no Bangla, and screen text is private. |
| 2 | One step per click, double-click, drag, shortcut and stretch of typing; typing within 5 s of a click joins it; scrolls join the next step. | One step per screen change only (loses clicks on the same screen); one step per caption sentence (loses silent steps). |
| 3 | Screenshots are drawn by the export's own drawing path from a derived project (§5.5.2). | Grabbing frames from the proxy: misses blur and pixelate shapes, crop and colour, so private areas could leak. A second drawing path: preview and export would differ. |
| 4 | A typing step's own shot shows the screen before the typing. Later shots on the same screen that hold the typing place are marked *May show what you typed*, checked first, and offer a one-click blur. | Claiming typed text never shows: false for every later shot of the same screen. Blurring the typing place in every later shot automatically: hides fields the guide is about, and changes the video unasked. |
| 5 | Guide shots are zoomed to the click: 950 × display-scale pixels wide (§5.5.3). Demo shots show the whole screen with a callout. | The whole screen in print: UI text of a 1920 px frame prints at about 3.2 pt on A4, unreadable. Zoomed shots in a demo: each step shows a different part of the screen and the viewer loses their place (Arcade, Storylane and Supademo show the whole screen). |
| 6 | PDF through a hidden, sandboxed window with scripts off and `printToPDF`, with static fonts. | A PDF library: a new dependency and weaker shaping of Bangla. Variable fonts: measured, they become Type 3 fonts and copied Bangla text breaks. |
| 7 | One HTML file serves as the guide and as the demo; scripts off, it reads as the guide. | A folder of files (Arcade, Snagit for Mac): harder to send. A demo that needs a server or a viewer app. |
| 8 | Markdown is a folder: `guide.md` and `images/step-01.png`. For tickets and documents, *Copy guide* puts HTML with the screenshots on the clipboard. | Images inline as data URLs in Markdown: GitHub, GitLab and others drop them. |
| 9 | Chapters are chosen in video time under YouTube's rules by an exact search that charges each split a cost (§7.4), so each needs two kinds of evidence or one strong one. | Filling a target count: a one-topic video gets split at arbitrary pauses. Greedy by score: can leave a 4 s chapter or miss the 0:00 one. |
| 10 | Screen changes are found by the share of pixels that changed, sampled about 4 times a second, and must settle (§7.2). | ffmpeg `scdet` at its default threshold: measured, it missed a full page change (score 9.30) and scored a scroll up to 7.54. |
| 11 | Found chapters carry `auto` and are Review rows. Until kept they never count as said in the link check, never switch on Captions Studio's chapter titles, and never restart step-badge numbers. | Adding them silently, as AI chapters were added: new automatic changes must be Review rows, and a name could slip a link into the copy pack. Counting them everywhere: Polish would renumber badges the user placed. |
| 12 | Chapter names come from title cards, the narration's first sentence or a phrase said in the part, and never hold anything link-like or path-like, whoever wrote them. | Window titles: not recorded (decision 4), and private. Two top key words joined: often never said together ("Invoice customer"). |
| 13 | Clip moments are scored offline and listed in a panel for review, each playable in the preview, before any copy is made. | Automatic copies: a disk and attention cost the user did not ask for. A dialog over the preview: the moments cannot be watched before ticking. |
| 14 | Each clip is a copy made by Duplicate's own code (`projectCopy`, `duplicateProject`), one after another, keeping only the pending changes inside its range. | Exporting clips straight to files: no editing, no vertical framing. Keeping every pending change: Remove in the copy would bring back footage from minutes away. |
| 15 | The shorter version is a copy whose removed stretches are `AutoCut` records (`by: 'short'`) written by `recordAutoCuts`, with smooth cuts when the original has no cut style. | A copy with no records: Review could not bring a sentence back. Hard cuts: about 14 jumps a minute. |
| 16 | AI on this PC is a bundled CPU helper (§0 decision 1), one request at a time, stopped between batches of 64 prompt tokens or tokens written. | node-llama-cpp (size, VC++ runtime, no stop while reading). llama-server: an HTTP port with permissive CORS by default and a web UI. |
| 17 | The local model always works through the same text tasks, schemas and validators as the services, with smaller batches and a JSON grammar. | Its own prompts and readers: two pipelines to keep in step, and weaker checks. |
| 18 | On this PC never splits into chapters itself; it only names parts Find chapters chose. | Its chapters task: the 2B model's chapters were the first segments, Gemma's an empty list (measured). |
| 19 | Services are kept in their own file, `ai-services.json`, and speak OpenAI's chat API with a JSON mode found by a check (§10). | A new kind in `ai-providers.json`: an older Flown drops the entry and loses it on its next save. `'openai'` with a base URL in the same file: an older Flown would send the service's key to api.openai.com. |
| 20 | Project data names a service's results `'openai'` (the API it speaks) plus its host, and results made on this PC `'local'` where the field allows it. | New kinds in `AutoOrigin.via`, `CaptionTrack.by` and `Transcript.provider`: older readers drop or relabel them (`studioData.ts:575`, `:721`). |
| 21 | Costs are estimated offline from the exact prompt text and a price list; nothing is sent to count tokens. | Anthropic's and Gemini's token-count calls: they receive the transcript before the user clicks Run. |
| 22 | Prices live in their own file, `ai-prices.json`, beside `ai-models.json`, with its own 256 KB cap; a downloaded list can only raise the amount that triggers a confirm. | Growing `ai-models.json`: older versions read it with a 64 KB cap. Trusting the downloaded list alone: one bad push would lower every user's confirm. |
| 23 | Each service's key is bound to the origin it was entered for; requests refuse redirects; a model list for an edited address never uses the stored key. | Following redirects: measured on Node 22, a cross-origin redirect drops `Authorization` but forwards a custom `api-key` header to the new host. |
| 24 | No new Inspector tab. Guides and short clips are panels in Review mode's place; chapters a section in the Text tab; the shorter version a dialog from the Copies menu; local AI a Settings section. | A "Smart" tab: the rail holds 13 tabs at the minimum window size. Modal dialogs for the guide and clips: *Go to*, *Add a step at the playhead*, blurring and playing a moment all need the preview. |
| 25 | The cost line is one line per group of tools, with each action's cost, and each button describes itself in one short sentence. | A full sentence under every button: three wrapped paragraphs in the Captions tab, read in full at every focus. |
| 26 | Local models get the chat template from Flown's code, sent to the helper in parts; only the template's own tokens are parsed as special. | Rendering the GGUF's Jinja template: a template engine in the helper. One prompt string parsed with special tokens on: a transcript holding `<turn|>` could close the user turn. |

### 3.3 Where this design departs from the reviews

- **Tidy notes** uses a `'note'` kind of the short-text task, not the clean-up task: clean-up fixes
  spelling and keeps every word, so it would not shorten a note.
- **Exporting the clips as a set** is left for later (§23): the exporter draws from the open editor,
  and nothing exports a project that is not open. Each copy has **Open**.
- **Which apps keep the screenshots of *Copy guide*** cannot be tested here; the reference PC records
  it before release (decision 9), and the panel's hint is written from that.
- **`default-features = false` does not turn `common` off.** `llama-cpp-2` 0.1.161 depends on
  `llama-cpp-sys-2` with its default features, and `common` is one of them (checked on crates.io), so
  Cargo builds it whatever Flown's manifest says. The helper never calls it and a static link takes
  only what is referenced; `verify-dist`'s import and size checks prove it, and a patched copy of the
  crate is the fallback (§9.1).
- **llama.cpp's abort callback is not reachable** through `llama-cpp-2` 0.1.161
  (`LlamaContextParams.context_params` is `pub(crate)`, checked), so Stop works between batches of 64
  prompt tokens instead (§9.2).
- **Automatic model choice goes by free memory, not caption language**: with one recommended model for
  every language, the language no longer picks the model.
- **The redaction marker** for exact keys is the file's own `<secret>`, not `[redacted]`.
- **The total size of one save** is capped at 256 MB, not 512 MB: 200 whole-screen PNGs fit, and
  main deserialises less.
- **The Polish step stays on by default**, with the guards of decision 8, rather than off.
- **A run whose cost is unknown asks once per model** in a session. The reviews asked only that it
  never read as "Less than US$0.01"; a router model can pick an expensive model for every request.

---

## 4. Data model and migration

### 4.1 `src/shared/types.ts` (additive)

```ts
/** What a found chapter's start was found from (Review's detail line), strongest first. */
export type ChapterSignal = 'start' | 'page' | 'screen' | 'pause' | 'idle' | 'cue' | 'section' | 'topic' | 'card' | 'ai'

/** A chapter Find chapters or Polish made and the user has not reviewed yet (smart-tools.md §7.7). */
export interface ChapterOrigin {
  by: 'find' | 'polish'
  /** At most 3, strongest first. */
  from: ChapterSignal[]
  /**
   * Where its name came from: a title card, the first sentence, a phrase said in it, a sentence cut
   * short, a number ("Part 3"), an AI. 'cut' and 'number' are weak: the chapter list says "Rename?".
   */
  name: 'card' | 'sentence' | 'phrase' | 'cut' | 'number' | 'ai'
  /** name 'ai' or from 'ai': the provider kind, or 'local' for AI on this PC. */
  via?: AiProviderKind | 'local'
  /** via 'openai' through a service (§10): its host, ASCII, at most 253 characters. */
  host?: string
}

export interface Chapter {
  id: string
  t: number
  title: string
  /** Found automatically and not reviewed yet; absent: the user's (every chapter from before wave 11). */
  auto?: ChapterOrigin
}

/** The step-by-step guide's choices and edits (smart-tools.md §5). Absent: none made. */
export interface GuideSettings {
  /** The guide's heading; absent: the recording's name. */
  title?: string
  /** A paragraph under the heading. */
  intro?: string
  /** 'bug': steps to reproduce with Expected and Actual. Absent: a guide. */
  kind?: 'bug'
  expected?: string
  actual?: string
  /** Bug report: source seconds of the screen shown under Actual. */
  actualAt?: number
  /** Bug report: the detail lines, as edited; absent: the three of §5.6, all included. */
  details?: { text: string; off?: true }[]
  /** The guide's own words; absent: Bangla for Bangla captions, else English. */
  language?: 'en' | 'bn'
  /** 'badges': steps from the auto-numbered step badges (§5.1 rule 11); absent: from every click. */
  from?: 'badges'
  /** false: the brand kit is not used; absent: used when one exists. */
  brand?: false
  /** The demo's end screen (§6.1). */
  end?: GuideEnd
  /** Edits of found steps, by step key (§5.1). */
  steps?: GuideStepEdit[]
  /** Steps added by hand at a time. */
  added?: GuideAddedStep[]
}

export interface GuideEnd {
  heading: string
  /** The button; with no `url`, the end screen has the heading and Start again only. */
  label?: string
  /** https only, checked by readLinkUrl (§4.2). The only link a guide can hold. */
  url?: string
}

export interface GuideStepEdit {
  /** 'c<ms>' click, 'k<ms>' key press, 't<ms>' typing, 's<ms>' screen change, 'b<ms>' badge (§5.1). */
  key: string
  title?: string
  text?: string
  /** Typing steps: what to type, written by the user only. */
  type?: string
  /** The note holds everything said since the previous step (absent: the short note, §5.4). */
  full?: true
  /** Left out of every output. */
  hidden?: true
  /** A typing step's screenshot after the typing (absent: before). */
  after?: true
  /** The guide's shot shows the whole screen (absent: zoomed to the action). */
  whole?: true
  /** The demo's shot is zoomed to the action (absent: the whole screen). */
  demoZoom?: true
  /** Adjust (§5.5.3): the crop, as fractions of the recorded frame; at least 0.05 wide and high. */
  rect?: { x: number; y: number; w: number; h: number }
  /** Adjust: the ring's centre, as fractions of the recorded frame. */
  ring?: { x: number; y: number }
  /** The title was written by an AI and not edited since (the row's "AI" chip). */
  ai?: AiProviderKind | 'local'
  /** The note was written by Tidy notes and not edited since. */
  textAi?: AiProviderKind | 'local'
}

export interface GuideAddedStep {
  /** 'a<ms>' of its time. */
  key: string
  /** Source seconds. */
  t: number
  title: string
  text?: string
}

/** On a copy made by Find short clips or Make a shorter version: what it was made from. */
export interface ClipOrigin {
  kind: 'moment' | 'short'
  /** Source seconds of the original. */
  start: number
  end: number
  /** The reasons listed when it was picked ("Opens with a question · 6 clicks"), at most 120 characters. */
  why?: string
}
```

Changes to existing types:

- `Project.guide?: GuideSettings` (after `publish`) and `Project.clipOf?: ClipOrigin` (after
  `copyOf`).
- `AutoCutSource` gains `'short'` (the shorter version's cuts).
- Wave 10's `ProjectJoins.auto.by` widens from `'polish'` to `'polish' | 'short'` (the shorter
  version's smooth cuts, §8.6).
- `CaptionTrack.host?: string` and `AutoOrigin.host?: string`: a service's host when `by`/`via` is
  `'openai'` through a service (decision 20). Absent for OpenAI itself.
- `ProjectSummary.copyOf?: ProjectCopyOf` and `ProjectSummary.clip?: true` (the copy is a clip or a
  shorter version), so *Made from this video* can be listed without opening each project.

Nothing else in `Project` changes. `AiProviderKind` stays `'openai' | 'gemini' | 'anthropic'`.

### 4.2 Readers

- `readChapter` (`src/shared/engine/titleData.ts:60`) keeps `auto` when `readChapterOrigin(raw.auto)`
  returns one: `by` in its list, `from` of 1–3 known signals (unknown ones dropped, none left: the
  origin is dropped), `name` in its list, `via` a known kind or `'local'`, `host` a string of 1–253
  characters of `[a-z0-9.-]` or a bracketed IPv6 literal. Any failure drops `auto` (the chapter is
  then the user's), never the chapter.
- `src/shared/guide/guideData.ts` (new, contracts): `readGuideSettings(raw: unknown):
  GuideSettings | undefined`. Strings cut to `GUIDE_LIMITS` (title 120, intro 2,000, expected and
  actual 2,000 each, a detail 120 and at most 8 details, step title 120, step text 1,000, step type
  200, end heading 120, end label 40 characters; control characters but line breaks in notes become
  spaces); `steps` at most 1,000 entries, keys matching `^[cktsb]\d{1,9}$`, one entry per key (the
  last wins); `rect` four finite numbers with `0 ≤ x`, `0 ≤ y`, `x + w ≤ 1`, `y + h ≤ 1`, `w` and
  `h` at least 0.05, else dropped; `ring` two finite numbers in 0..1, else dropped; `added` at most
  200, keys `^a\d{1,9}$`, `t` finite and clamped into the recording; `actualAt` finite and clamped;
  `end.url` kept only when `readLinkUrl` accepts it. An object with no field left reads as
  `undefined`.
- `readLinkUrl(raw)` (`src/shared/smart/privateText.ts`, contracts): a string of at most 300
  characters that the WHATWG parser reads as `https:` with a host, no user name or password and no
  `javascript:`-like scheme; returns its `href`, else `null`.
- `readClipOrigin(raw)` (same file as `readGuideSettings`): `kind` in its list, `start < end`, both
  finite, `why` cut to 120.
- `AUTO_CUT_SOURCES` (`src/shared/review/autoCutData.ts:10`) gains `'short'`; wave 10's join reader
  accepts `by: 'short'`.
- `readAutoOrigin` (`src/shared/captions/studioData.ts:572`) and the caption track reader keep
  `host` by the same rule as `readChapterOrigin`.
- `ProjectSummary` is filled by `listProjects` (`src/main/projects.ts:152`) from the project it
  already reads.

### 4.3 Migration (`src/shared/engine/project.ts`)

`migrateProject` reads `guide` with `readGuideSettings` and `clipOf` with `readClipOrigin`, through
`optional()` (`project.ts:127`), so an absent field stays absent. Chapters go through `readChapter`
as today (`project.ts:167`). No version bump: `version: 2` stays.

### 4.4 Old projects and settings load and save unchanged

- No existing `project.json` has `guide`, `clipOf`, `Chapter.auto`, `host`, an `AutoCut` with
  `by: 'short'` or `joins.auto.by: 'short'`. Each reader returns `undefined` for an absent field and
  adds no key, so the migrated project has the keys it had and saves to the same bytes (test 1).
- `src/shared/review/review.ts` lists the same rows for an old project: the new aggregator returns no
  items without `Chapter.auto` or `'short'` records (test 3).
- `badgeLabels` (wave 10) and `resolveGreatOptions` (`great.ts:113`) now count user chapters only
  (§7.7). An old project has no other kind, so its badge labels and its resolved options are the same
  (test 101).
- `changedAreas` (`src/shared/editor/versions.ts:218`) gives the same answer for two old versions
  (test 4).
- The prompts of every existing text task are the same text with the default limits (test 5):
  `textPrompts` (§20.0) only lists them, and `runTextTask`'s new `limits` parameter defaults to
  today's numbers.
- `userData/ai-providers.json` is never written by the new code unless the user changes one of its
  providers, and is then written exactly as today (`FILE_VERSION` 1, the same fields). Services go to
  a new file (§4.7).
- Saved Polish options without `chapters` read it as `false` (§13.3).
- No existing pref key changes; new ones are listed in §4.7.

### 4.5 An older Flown opening a newer project

- `guide` and `clipOf` pass through `...rest` (`project.ts:138`) and survive an older save.
- An older `readChapter` rebuilds chapters from `id`, `t` and `title`, so `auto` is lost on its save:
  pending chapters become the user's. Their names never hold links or paths (§7.5, §7.6, whoever
  wrote them), so the copy pack's check loses nothing it needs.
- An older `readAutoCuts` (`autoCutData.ts:118`) drops records with `by: 'short'` (an unknown
  source): the shorter version's cuts stay cut and are no longer listed. A wave 10 reader drops a
  `joins.auto` with `by: 'short'`: the smooth cuts stay and are no longer listed.
- Older readers drop `host`; the track then says "translated with OpenAI".
- This is the same degradation earlier waves accepted: only forward loading is required.

### 4.6 Versions, Duplicate and project files

- **Versions** (`src/shared/editor/versions.ts`): `AREAS` gains `{ name: 'guide', keys: ['guide'] }`.
  `clipOf` joins `RECORDING_FIELDS` (`:242`) next to `copyOf`: it is not part of an edit. A found
  chapter that differs only in `auto` makes the item "chapters" differ, as a kept zoom does for
  "zooms".
- **Duplicate and Make a vertical version** copy `guide` and `Chapter.auto` as they are. A clip copy
  drops `chapters`, `guide` and the pending changes outside its range (§8.5).
- **Project files**: the scene scan's cache `.cache/scenes.json` (§7.2) joins `COPIED`
  (`src/main/projectCopy.ts:39`) and the `.cache` entries `planFiles` walks (`projectCopy.ts:119`,
  today only the speech and sounds caches), so a copy reads its screen changes at once. Versions
  never keep `.cache/`.

### 4.7 New settings files and prefs

| Where | What | Absent |
|---|---|---|
| `userData/ai-services.json` | Services (§10.1): `{ version: 1, services: [...] }`, keys encrypted with `safeStorage` as `ai-providers.json` does. | No services. |
| `userData/ai-usage.json` | Per (kind or host, model, task): measured ÷ estimated input and output tokens (§11.6). No text. At most 200 entries. | Estimates without correction. |
| `userData/ai-prices.json` | The last price list downloaded (§11.4). | The bundled list. |
| `userData/text-models/` | The local models (`*.gguf`, `*.part`) and `models.json` (`{ version: 1, use: 'auto' \| LocalModelId, speed }`). | Nothing downloaded; *Automatic*. |
| `userData/tmp/guide-print/` | The PDF print step's temporary file (§5.7), `guide-*.html`, deleted after each print and swept at start. | — |
| Pref `aiPrices` | `Record<providerId, { input: number; output: number }>`: US$ per million tokens the user typed (0..1000). | The price list. |
| Pref `aiConfirm` | `'always' \| '0.1' \| '1' \| '5' \| 'never'`: ask before a run whose high end passes that amount (§11.5). | `'1'`. |
| Pref `guide` | `{ format?: GuideFormat; page?: 'A4' \| 'Letter'; titles?: string; notes?: string }`: the last format, page size, and title and note sources (a provider id, `'local'` or `'offline'`). | PDF; A4 or Letter by region; offline. |
| Pref `findChapters` | `{ density, use, names }` of §2.3. | Normal, all signals, offline names. |
| Pref `shortClips` | `{ length, shape, names, captions }` of §2.4. | Any, Vertical, offline, captions on. |

Each pref has a sanitiser in `src/main/prefsIpc.ts` (`PrefKey`, `src/shared/api/prefs.ts:6`) that
turns anything malformed into the default.

---

## 5. The step-by-step guide

### 5.1 Steps (`findSteps`, `src/shared/guide/steps.ts`)

Input: the effective track (`effectiveTrack`, `src/shared/engine/inputTrack.ts:32`: ignored and stray
clicks are gone), the clips, `project.capture`, the annotations, and the scene scan (§7.2) when there
is one. Distances are in pixels of the captured area (`dx × width`, `dy × height` of the project),
times in source seconds. A step whose time is cut (`isCut`, `src/shared/search/moment.ts:9`) is
dropped.

| # | Rule | Numbers (`STEP_RULES`) |
|---|---|---|
| 1 | Each click is a step: left *click*, right *right-click*, middle *middle-click*. Coordinates outside 0..1 are dropped. | — |
| 2 | Two presses of the same button close together are one *double-click*, at the first press. | Δt ≤ 0.5 s (Windows' default `GetDoubleClickTime`), distance ≤ 4 px × display scale (`SM_CXDOUBLECLK`) |
| 3 | A press held while the cursor travels is a *drag* from the press to the cursor at release. | `up` finite, `up − t` ≥ 0.25 s (`STRAY.held`, `inputEdits.ts:18`), travel ≥ 0.02 of the frame height |
| 4 | Clicks of one button on the same spot in a row are one step, "… 3 times". | each ≤ 1.5 s after the last, ≤ 12 px × scale from the first |
| 5 | Typing bursts closer than 6 s are one burst (`TYPING_PAUSE`, `zoom.ts:274`). A burst that starts within 5 s after a click, with no click between, joins that click: "Click … and type". Another burst of at least 0.5 s is its own step. | `TYPING_CLICK_JOIN` 5 s, `TYPING_MIN_LENGTH` 0.5 s (`zoom.ts:268-272`) |
| 6 | Each key press not inside a burst (from its start to 0.3 s after its end) is a step "Press Ctrl + S", with the label as recorded. The same label repeated is one step "Press Tab 3 times". Enter or Tab within 1.5 s after a burst joins it: "… and press Enter". | repeat ≤ 1.5 s apart |
| 7 | A scroll session (`scrollSessions`, `src/shared/engine/scroll.ts:48`) followed by a step within 10 s adds "Scroll down, then" to that step; otherwise it is dropped. | 10 s |
| 8 | **No usable clicks** (an invalid track, `valid: false`, which keeps keys, typing and marks but drops clicks and samples, `src/main/recording/trackMath.ts:279`; or a track with no clicks; or an imported video): each screen change (§7.2: at least 10% of pixels change and the screen settles) is a step too, beside the key and typing steps. A change within 1.5 s after a key or typing step belongs to that step (the press caused it) and adds none. | 1.5 s |
| 9 | Steps the user added (`guide.added`) are steps at their time. | — |
| 10 | At most 200 steps, the first in time. | `maxSteps` 200 |
| 11 | **From your step badges** (`guide.from === 'badges'`, offered when wave 10's automatically numbered badges exist): each badge annotation with `number: 'auto'` whose start is not cut is a step at its start, its place the badge's `pin` (a point of the recording; a badge without a pin gives a whole-screen shot), its number the badge's label (`badgeLabels`), so guide and video agree. When the labels start again at a chapter, that chapter's title becomes a section heading before the step. The steps rules 1–9 give between two badges are listed hidden; one the user includes is numbered after the badge before it ("3.1", "3.2", in the guide's digits). | — |

Each step has a key that survives edits of other steps, the same rounding as `clickKey`
(`src/shared/engine/inputData.ts:13`): `c` + the click's time in milliseconds (also for double-clicks,
drags and joined typing), `k` + the key press's, `t` + a lone burst's start, `s` + a screen change's,
`b` + a badge's start, `a` + an added step's. Edits (`guide.steps`) are found by key, so finding the
steps again after an edit of the video keeps them.

### 5.2 Titles without AI (`stepTitle`, `src/shared/guide/stepTitles.ts`)

In order, the first that gives a title, with where it came from (`from`):

1. **The narration** (`'narration'`). Words said from 2.5 s before the step to 1.0 s after it (kept
   words only), run through the UI-verb finder Captions Studio uses for emphasis (`objectIndexes`,
   `src/shared/captions/emphasis.ts:184`, exported by the contracts as `uiObjects`): in English the
   word after a button or menu verb ("click the Export" → "Export"); in Bangla and Hindi the word
   before a polite command, after `uiObjects` has skipped the light verb ("ক্লিক"). Two more steps for
   Bangla and Hindi: a generic word for the control is skipped too (bn বোতামে, বাটনে, মেনুতে, অপশনে,
   ট্যাবে, লিংকে; hi बटन, मेनू, ऑप्शन, टैब, लिंक, पर), and a case ending written after a hyphen is
   removed ("Export-এ" → "Export"). So "রপ্তানি বোতামে ক্লিক করুন" gives "রপ্তানি", and "Export-এ ক্লিক
   করুন" gives "Export". The object nearest the step's time wins; a run of up to 3 capitalised words is
   one name ("Visual Studio Code"). An object is refused when it is a stop word, only digits, longer
   than 40 graphemes, or private-like (`privateLike`, §7.5). The title uses the step's own action,
   not the spoken verb: "Click “Export”", "Double-click “Quarterly report”", "Right-click “Desktop”",
   "Drag “Header”", "Click “Search” and type", "Click “Next” 3 times".
2. **Key presses** (`'keys'`) are always "Press <label>": complete as they are.
3. **Screen, badge and added steps** (`'sentence'`): the first sentence said after them, by
   `sentenceName` (§7.5 rule 2, at most 8 words), else rule 4's cut (`'cut'`).
4. **What the cursor showed** (`'cursor'`, native capture only, `CursorShapeEvent`): a *text* cursor at
   the press gives "Click in the text field near the top right"; a *pointer* (hand) gives "Click the
   link or button near the top right".
5. **The taskbar** (`'taskbar'`). A whole-screen recording (`capture.target === 'screen'`) clicked in
   the bottom 48 px × scale: "Click on the taskbar, on the left".
6. **Where on the screen** (`'place'`), in thirds (`placeOf`, `src/shared/review/copy.ts:30`): "Click
   near the top right", "Click in the middle", "Drag from the top left to the middle", "Type your text".
7. **A number** (`'template'`): "Step 3" ("ধাপ ৩").

Titles from 4–7 and rule 3's cut are **placeholders**: the row shows *Needs a title*, the line under
the list counts them, and *Next step without a title* walks through them. A title the user types, or
an AI writes, is never a placeholder.

The words come from `GUIDE_WORDS` (§15) in English or Bangla. For later: `stepTitle` takes an
optional `element` (F-06: the clicked element's name and role); with it, "Click the “Export”
button". Nothing passes it in this wave.

### 5.3 Titles with AI

**Write titles** sends the `names` text task (§9.6, §20.0) with `kind: 'step'`: for each step not
edited by hand **that has words near it**, its key, its action in words ("click, top right of the
screen", "press Ctrl + S", "type after clicking near the top") and the words said from 6 s before to
2 s after it (at most 600 characters, bleeped words masked). Steps with no words keep their offline
titles; when no step has words, the button is disabled with "Nothing was said near these steps."
(unless the screenshots go too, §5.3.1). Nothing else is sent: no screenshot (unless §5.3.1), no file
name, no window title.

- `runTextTask` splits the items into requests by the limits (40 items or 12,000 characters for a
  service, 12 or 3,000 on this PC), so a guide of 200 steps is several requests under one cost line.
- The answer is checked by `validateNamesAnswer`: known keys only, each once, plain text of 1–80
  characters. A title in which `privateLike` (§7.5: the link check's `linkLike` plus `pathLike`) finds
  anything is dropped, **whether or not those words were said**; that step keeps its offline title.
- The titles are written in one store update into `guide.steps` with `ai` set (the row's "AI" chip).
  Editing a title by hand clears `ai`. **Use offline titles** (shown while any title has `ai`)
  removes every AI title in one update.

#### 5.3.1 Titles from the screenshots (part P6, §0 decision 10)

- **Also send the screenshots** (checkbox under *Write titles*, off, not remembered) appears when the
  chosen text choice is a service or a built-in provider (never On this PC: its runtime is built
  without image support, §9.1). The cost line becomes "Sends 12 screenshots and about 300 words to
  OpenAI · About US$0.04".
- Clicking *Write titles* first opens the full-size viewer in its **send** form, titled "These
  screenshots go to OpenAI": every picture that would go, one at a time, with **Previous**, **Next**,
  a checkbox "Send step 3's screenshot" on each (steps marked *May show what you typed* start
  unticked), and **Send 12 screenshots** / **Cancel** (Cancel focused at the start). Nothing is sent
  before *Send*.
- The pictures are the guide's own shots (zoomed, ring drawn, every blur and pixelate shape applied,
  §5.5.2), scaled to at most 768 px on the longer side, JPEG quality 0.8. A whole-screen step sends
  its whole-screen shot at that size.
- The request is the same `names` task; each item gains `image` (the JPEG bytes). The system text adds
  "The picture shows the screen just before the action; the red ring marks where the user clicked.
  Name the control in the ring." Validation (contracts, §20.0): JPEG by its first bytes, at most
  512 KB each, at most 50 a request, at most 200 in all.
- Each client sends the image in its API's own form: OpenAI's Responses API an `input_image` part
  with a `data:` URL; a service's Chat Completions an `image_url` part with a `data:` URL; Gemini an
  `inline_data` part; Claude an `image` block with base64 data. A provider that refuses pictures
  (HTTP 400 naming the image) gives "This model does not read pictures. Choose another model, or
  untick Also send the screenshots."
- Image tokens are estimated per provider (`imageTokens`, `src/shared/ai/tokens.ts`): Claude
  `w × h ÷ 750`; Gemini 258 per image up to 384 px a side, else 258 per 768 px tile; OpenAI and
  services 85 + 170 per 512 px tile after fitting into 2,048 px and the shorter side into 768 px, or
  the model's own entry in the price list (`imageTokens`), with the range widened to ±60%.

### 5.4 The note under each step (`stepText`)

- **The short note** (default): the words said from 0.5 s after the step before to 1.0 s after this
  step (from the start for the first step), kept words only, bleeped words masked as
  `publishSegments` masks them (`src/shared/publish/pack.ts:88`), with fillers (`findFillers`,
  `src/shared/editor/fillers.ts:60`) and the earlier takes of retakes (`findRetakes`,
  `src/shared/editor/retakes.ts:79`) left out, and without the sentence the title came from. Of what is
  left, the first two whole sentences, at most 300 characters, ending at a sentence end.
- **Use everything I said** (`full`): the same words with nothing left out but cut and bleeped ones,
  whole sentences, at most 1,000 characters.
- **Tidy notes with** [text choice]: the `names` task with `kind: 'note'`: each step's full words (at
  most 1,000 characters) and its title; the answer is one or two short sentences of instruction for
  each, 1–300 characters, checked like titles (`privateLike` refuses). Written in one update with
  `textAi` set (the "AI" chip on the note); a hand edit clears it.
- It is the user's own narration; the panel shows it before anything is saved. The user can rewrite
  or empty it.

### 5.5 Screenshots

#### 5.5.1 Which moment (`shotTime`)

| Step | Time | Why |
|---|---|---|
| Click, double-click, drag, key press, click and type | `t − 1/fps`, `fps = capture.fps ?? 60`, kept inside the clip that holds `t` | The screen the viewer must act on; the page can change within about 100 ms of the press. |
| Typing alone | the burst's start `− 1/fps` | Nothing of this typing shows. |
| With *Show the screen after typing* | the burst's end `+ 0.2 s` | Chosen by the user, step by step. |
| Screen change | the change `+ 0.75 s` | After it settled (§7.2). |
| Badge | its start | The badge's own moment. |
| Added | its time | — |
| Bug report's Actual | `guide.actualAt` | The playhead when the user asked for it. |

#### 5.5.2 How it is drawn (`guideProject`)

The shot is the frame the export would draw for a derived project, through `renderGuideStills`
(§20.1), which uses the exporter's own `prepare` (exported as `prepareFrames`), `openSource` and
`drawFrame`. The derived project:

- keeps: clips, crop, cursor (with `clickEffect: false`), `inputEdits`, every **blur and pixelate
  shape** at its times, and wave 10's colour grade (`grade`), so shots look like the video;
- drops: zooms, the camera, captions, title cards, graphics, texts, other shapes, spotlights and
  magnifiers, images, the watermark, tilt, layouts, vertical framing, cut styles (`joins`) and the
  progress bar;
- sets the style to no padding, no corners, no shadow, no device frame, aspect `'auto'`;
- is drawn at the cropped recording's own size (at most 3840 px wide), so one shot pixel is one
  recording pixel.

So nothing that was blurred or pixelated in the video can appear in a guide (test 14).

#### 5.5.3 Zoomed to the click (`shotRect`) and Adjust

- Crop width `Wc = clamp(round(950 × s), round(vw / 3), vw)` recording pixels, `s` = the display
  scale (`track.scale ?? 1`); height in the recording's aspect; centred on the click (a drag: the
  middle of its ends; typing alone: the typing place from `typingSessionsOf`, `zoom.ts:348`; a badge:
  its pin), moved to stay inside the frame. A drag whose ends do not both fit with 8% to spare widens
  the crop up to the whole frame.
- Why 950: on A4 with 14 mm margins the image is 182 mm wide. UI text is about 12 px × s high; for it
  to print at 6.5 pt (2.29 mm) or more, `Wc ≤ 12 × s × 182 / 2.29 ≈ 954 × s`. Letter (188 mm) gives
  985 × s. A whole 1920 px frame prints that text at about 3.2 pt.
- Key presses, screen changes, added steps and badges without a pin show the whole screen. *Whole
  screen* on any step does too. The demo shows the whole screen unless *Zoom to the click in the
  demo* is on (§6.1).
- **Adjust** (in the full-size viewer): the crop shows as a rectangle with 8 handles and the ring as a
  movable circle, over the whole frame. Dragging snaps to the frame's edges within 8 px. Keys: Tab
  moves between the crop and the ring; arrows move the focused one by 1% of the frame (Shift: 10%);
  Alt with arrows resizes the crop. **Done** stores `rect` and `ring` (fractions of the recorded
  frame) in one update; **Reset** removes them. A crop under 5% of the frame is refused.
- Output width: the crop's, at most 1600 px (twice an 800 px column in HTML; 223 ppi across 182 mm),
  scaled down with high-quality smoothing.
- A click outside the picture (outside the recorded region, or cropped away by `project.crop`) keeps
  its step, with the whole screen, no ring, and the note "The click was outside the recorded area."

#### 5.5.4 The ring and the arrow (`ringOf`, `arrowOf`)

Drawn into the image itself, so every format shows it:

- In a 960 px wide image: a circle 44 px across, a 4 px ring in the ring colour with a 3 px white
  halo outside it; scaled with the image's width.
- The ring colour is the brand kit's first colour when it has 3:1 contrast with white, else
  `#0060df` (5.6:1 on white, 3.7:1 on black: WCAG 1.4.11 against light and dark screens).
- A drag gets an arrow from press to release: a 4 px line with a 3 px halo and a 16 px head.
- Key presses and screen changes get no ring.

#### 5.5.5 Formats and sizes (measured on 20 Flown screenshots, 1360–1920 px wide)

| Use | Format | Measured |
|---|---|---|
| PDF | JPEG, quality 0.9 | Embedded unchanged: 20 shots 2.05 MB. (PNG is recompressed: 3.54 MB; WebP is stored decoded: 6.21 MB.) |
| HTML guide and demo | WebP, quality 0.85 | 47.2 KiB a zoomed shot; 20 steps make a 1,280,230-byte file, the template 11,466 bytes of it. A whole-screen demo shot at 1600 px is about 90 KiB. |
| Markdown, *Copy screenshot* | PNG | 161.9 KiB a shot; every wiki shows PNG. |
| *Copy guide* | PNG in the HTML, at most 1200 px wide | Pasted documents scale images to their column. |

A demo or HTML guide over 10 MB shows "This file is 14 MB: too big for some email. **Make it
smaller**", which re-encodes at quality 0.75 and at most 1280 px wide (42.5 KiB a zoomed shot).

#### 5.5.6 Making them

One decoder pass serves every shot: `openSource(url, times)` (`exporter.ts:380`) already takes a list
of times. Shots are made in step order in the background while the panel is open, kept in memory (at
most 300 shots or 256 MB, the oldest dropped), and remade only for steps whose time, view, `rect` or
`ring` changed, or whose shot time a changed blur or pixelate shape covers. A demo's whole-screen shots
are made when the format is the demo, or at saving. Closing the panel stops the pass and frees them.

#### 5.5.7 Shots that may show typing (`typedBefore`)

A typing step's own shot is taken before its typing; later shots can show the typed text in its
field. A step is marked **May show what you typed in step N** when, for a typing burst of step N that
ended before the step's shot time:

- no **page change** (§7.2, at least 30% of pixels, settled) lies between the burst's end and the
  shot time (without a scene scan, every later shot is considered); and
- the step's shot holds the typing place (`typingSessionsOf`'s place) with a margin of 5% of the
  frame, which a whole-screen shot always does.

Every stretch of typing counts (`typingRuns`), not only the listed steps' typing: a burst whose step
was cut (Remove silences can cut a click and its typing while the next shot still shows the filled
field), or one too short to be a step, still marks the later shots that show it. Its chip then says
**May show what you typed**, without a step number, and *Blur the typed text* blurs from that burst's
start.

Marked steps come first in *Check screenshots*, are counted under the list and in the save question
(§2.1.2), and start unticked in §5.3.1's send list.

#### 5.5.8 Blurring from the panel

- **Blur an area…** calls `addShapeAt(services, 'blur', null, { at: shotTime(step) − 1/fps, box })`
  (`src/renderer/src/editor/playheadItems.ts:77`, which gains an optional `box`), with `box` a
  rectangle 30% × 10% of the frame centred on the step's place, and moves the playhead to the shot
  time. The blur starts one frame before the shot, so the privacy layer, which covers a shape from
  half a frame plus 1 ms before its start (`shapesLayer.ts:38`), always covers the shot's frame
  (test 106). The shape keeps the Shapes tab's default length (3 s, `DEFAULT_SHAPE_LENGTH`) and is
  selected, so the user drags it over what to hide in the preview, as any selected shape.
- **Blur the typed text** (on a marked step): one `store.update` adding a blur shape from the burst's
  start to the next settled page change after the marked step (or the end of the video), the box
  centred on the typing place, 360 × 48 px × scale, moved 40 px × scale left of it so it covers a
  field that grows to the right, clamped into the frame. It hides the typing in the video too, and is
  one undo step.

### 5.6 The document (`buildGuideDoc`, `src/shared/guide/guideDoc.ts`)

`GuideDoc` holds the title, the intro, the language (`lang` for the page and each text), the words
of §15, the brand (logo bytes and a heading colour, when used), and for each included step in order:
its number in the guide's digits ("3", "৩", "3.1"), label ("Step 3", "ধাপ ৩"), a section heading when
one starts there (§5.1 rule 11), title, *Type* text, note, image bytes and type, its size, the hotspot
point (0..1 of the image), and the alt text "Step 3: Click “Export”" (screenshot). A bug report adds
Expected, Actual, the Actual screenshot and the included detail lines ("Recorded on 7 November 2026",
"Screen 1920 × 1080 at 150%" from `project.width`, `project.height` and the track's scale, "Length
4:12" from L). A demo adds its end screen. Every string is plain text; builders escape it.

**Markdown** (`guideMarkdown`): CommonMark punctuation in titles and notes is escaped
(`` \ ` * _ { } [ ] < > ( ) # + - . ! | ``); no raw HTML passes.

```markdown
# Billing demo

## 1. Click “Export”

![Step 1: Click “Export”](images/step-01.png)

Now we export the report.
```

A step with *What to type* adds a line `Type: billing@example.com` (escaped). A bug report:

```markdown
# Export fails with a large report

## Steps to reproduce

1. Click “Export”
   ![Step 1: Click “Export”](images/step-01.png)
2. …

## Expected

What should happen

## Actual

What happens instead

![Actual](images/actual.png)

## Details

- Recorded on 7 November 2026
- Screen 1920 × 1080 at 150%
```

With sections (§5.1 rule 11), each section is `## <name>` and its steps `### 1. …`.

**HTML** (`guideHtml(doc, { demo, print, fonts, page })`): one file.

- `<html lang="…">`; `<title>` with the guide's title (escaped), so a PDF's document title is the
  guide's, not the temporary file's name (measured: without it Electron writes the file name into
  `/Title`); the heading, the intro, an `<ol>` of steps, each an `<li>` with an `<h2 dir="auto">`, a
  `<p class="type" dir="auto">` for *Type*, a `<figure>` with the `<img>` (data URL, `alt`, `width`,
  `height`) and, in a demo, a hidden `<button class="hotspot">` placed with `left` and `top` in
  percent, and a `<p dir="auto">` note.
- A `Content-Security-Policy` meta tag: `default-src 'none'; img-src data:; font-src data:;
  style-src 'unsafe-inline'; script-src 'sha256-<DEMO_SCRIPT_HASH>'; base-uri 'none'; form-action
  'none'` (no `script-src` at all when not a demo) and `<meta name="referrer" content="no-referrer">`.
- Styles: light and dark colours by `prefers-color-scheme`, each pair at least 4.5:1 for text and
  3:1 for the hotspot ring; print styles show every step with `break-inside: avoid`.
- **Brand** (when *Use the brand kit* is on and a kit exists): the kit's logo in the header as a
  `data:` image, at most 48 px high, `alt` "" (the title follows it); the kit's first colour for
  headings and, in the demo, the buttons' fill, each used only where it has 4.5:1 against that
  colour scheme's page background (headings) or its label colour (buttons), else the default colour
  of that scheme (`contrastRatio`, `src/shared/captions/colors.ts:39`).
- Fonts: the system stack `"Segoe UI", "Nirmala UI", "Hind Siliguri", system-ui, sans-serif`; with
  Bangla text, Hind Siliguri 400 and 600 embedded as WOFF2 data URLs (about 280 KB) with a comment
  naming the SIL Open Font License (§0 decision 7).
- No text ever goes into the script, an attribute other than `alt`, `aria-label`, `title`, `lang`
  and `dir`, or a URL; every string is escaped (`escapeHtml`: `& < > " '`). The one exception is the
  demo's end-screen link (§6.1): a URL `readLinkUrl` accepted, escaped, in one `href`.

**PDF**: the same HTML with `print: true`: no script, JPEG images, the static font stack
`"Hind Siliguri", "Segoe UI", "Nirmala UI", "Leelawadee UI", "Yu Gothic UI", "Malgun Gothic",
"Microsoft YaHei UI", sans-serif` (Hind Siliguri, bundled and static, covers Latin and Bengali; the
others are Windows' static system fonts for Devanagari, Tamil, Arabic, Hebrew, Thai, Japanese,
Korean and Chinese), and page numbers in CSS margin boxes:
`@page { size: A4; margin: 16mm 14mm; @bottom-center { content: counter(page) " / " counter(pages) } }`
(Bangla: `"পৃষ্ঠা " counter(page, bengali) " / " counter(pages, bengali)`). A 16:9 shot 182 mm wide
is about 102 mm tall: two steps a page.

### 5.7 Printing the PDF (`printGuidePdf`, `src/main/guide/printPdf.ts`)

1. Write the HTML to a temporary file in `userData/tmp/guide-print/`, named `guide-<random>.html`,
   mode 0600. A page loaded from a data URL over 2 MiB fails (`ERR_INVALID_URL`, measured), so a file
   is used. At start, main deletes every `guide-*.html` left in that folder (a crash or a kill during
   printing), as `sweepTranscribeTemp` does for transcription's files.
2. Make a hidden window: `new BrowserWindow({ show: false, width: 820, height: 1160, webPreferences:
   { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, partition:
   'guide-print', webgl: false, spellcheck: false } })`, no preload. The partition is in memory (no
   `persist:`). Its session refuses every request except the temporary file's URL and `data:`
   (`webRequest.onBeforeRequest`), and every permission. `guardWebContents` already covers it
   (`src/main/security.ts:49`, through `web-contents-created`).
3. `loadFile(temp)`. Fonts given as data URLs are loaded before it resolves, also with scripts off
   (measured).
4. `printToPDF({ printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true,
   generateDocumentOutline: true })`. Measured (Electron 44.9.3, "Skia/PDF m152"): tagged (H1, H2, P,
   Figure with `/Alt` from each `alt`), bookmarks from the headings, `/Lang` per element; Hind
   Siliguri embedded as a CID TrueType subset and Bangla copied out of the PDF exactly
   ("ধাপ ১: “রপ্তানি” বোতামে ক্লিক করুন।"). Electron's own header and footer are not used: their font is
   embedded as Type 3.
5. Close the window and delete the temporary file in a `finally`. A time limit of 60 s plus 1 s a step;
   Cancel closes the window.

Measured: 6 steps load in 63–87 ms and print in 56–122 ms (705 ms the first, cold time); 20 JPEG steps
print in 27 ms.

### 5.8 Saving and copying (`src/main/guide/guideIpc.ts`)

**Saving** (`guide:save`). The renderer sends the format, a name and the bytes; main shows the dialog,
builds every path, and writes. It never takes a path from the renderer.

| Format | Dialog | What main writes |
|---|---|---|
| PDF | Save, filter PDF, in Documents | The printed PDF, through a `.part` file renamed into place. |
| HTML, demo | Save, filter HTML | The HTML file, the same way. |
| Markdown | Folder ("Save the guide in this folder") | A new folder `<name>/` (" (2)" when taken) holding `guide.md` and `images/step-01.png` … (and `images/actual.png`) in the order sent. |

Limits (`GUIDE_SAVE_LIMITS`), checked in the preload before sending and again in main
(`checkGuidePayload`): HTML at most 64 MB, Markdown at most 2 MB, at most 300 images of at most 16 MB
each, each a PNG, JPEG or WebP by its first bytes, and **at most 256 MB in all**; the name passes the
export's file-name check (`batchFileOk`), else "Guide". The answer is `{ path, bytes }`. Main adds a
PDF, HTML or demo file it wrote to the export's set of files written this session (a new
`rememberExported(file)` beside `isExportedFile`, `src/main/exportIpc.ts:55`), so `guide:showItem`
and Share (`share:start`, which checks `isExportedFile`) accept it and nothing else.

**Copy guide** (`guide:copy`). The renderer sends `{ html, text }`: the guide's HTML without script,
styles inline, the screenshots as PNG `data:` images at most 1200 px wide, and a plain-text form
(numbered titles, *Type* lines and notes). Main writes both with `clipboard.write({ html, text })`.
Limits: HTML at most 64 MB, text at most 2 MB. Which apps keep the images on paste (Google Docs, Word,
Outlook, Confluence, Notion, Jira) is measured on the reference PC (§0 decision 9); the panel's hint
for *Copy guide* names the ones that do not.

**Copy screenshot** (`guide:copyImage`): one PNG of at most 16 MB, written with
`clipboard.writeImage(nativeImage.createFromBuffer(png))`.

---

## 6. The click-through demo

### 6.1 How it behaves

The demo is the HTML guide (§5.6) with `demo: true`: one fixed script, `DEMO_SCRIPT`
(`src/shared/guide/guideHtml.ts`), about 4 KB, pinned by its SHA-256 in the page's CSP. When it runs
it adds the class `demo` to `<html>`, shows one step at a time, shows each hotspot and callout, and
builds the navigation from elements already in the page. It reads nothing but the page: positions
come from `style` attributes Flown wrote, never from text.

**Layout** (`src/shared/guide/demoLayout.ts`, pure, so the placement is unit-tested):

- The step's picture fills the page's width (at most 1600 CSS px), the whole screen unless the step
  has *Zoom to the click in the demo* (`demoZoom`).
- The hotspot is a `<button>` 44 × 44 CSS px over the click (WCAG 2.5.5), named "<title>. Next step".
  Activating it goes to the next step and puts focus on the next step's hotspot.
- The **callout**, a box at most 320 px wide, holds the title and, under a **More** disclosure
  (`<details>`), the note and *Type* line. It sits beside the hotspot: to its right, 16 px away, with
  a 10 px pointer to it; to its left when the hotspot is in the right 40% of the picture; above or
  below (whichever has room) when neither side has 336 px. It never covers the hotspot. A step with
  no click has the callout at the picture's top left.
- **Below 640 px** of page width the callout leaves the picture and sits under it, full width, and
  the hotspot stays on the picture.
- **Back**, **Next** (native buttons), "Step 3 of 12".
- Keys: Right arrow or Page Down next, Left arrow or Page Up back, Home and End to the first and the
  last. No single-letter keys (WCAG 2.1.4).
- The pulse: 3 times 1.2 s (3.6 s, under WCAG 2.2.2's 5 s), none under `prefers-reduced-motion`.
- A polite, atomic live region announces "Step 3 of 12: Click “Export”".
- Steps without a click (key presses, screen changes, added steps) have no hotspot: Next only.
- **End screen** (optional, `guide.end`): after the last step, the heading ("You are ready to export
  your report") and, when set, one button-styled link with the user's label and `https://` link:
  `<a class="end-link" href="…" rel="noopener noreferrer" target="_blank">`, the only URL in the page
  that is not `data:`. The link is typed by the user in the panel's *End screen* disclosure (fields
  **Heading**, **Button label**, **Link**), accepted only by `readLinkUrl` (§4.2) and passed through
  the link check (a link the user typed there is their own, so it is not noted). **Start again** is
  always there. Without an end screen, the last step has **Start again**.
- No autoplay in this wave (§23).

### 6.2 One offline file

Tested on the prototype (research `guides-demos/demo/`): 0 network requests, 0 console errors, load
66 ms, script heap about 10 MB, 20 steps in 1,280,230 bytes. With scripts off it is the guide; printed,
every step shows. Arcade and Storylane offer offline demos only on their top plans. The end-screen
link loads nothing until the viewer follows it.

### 6.3 Size

Aim for 5 MB or less (about 50 whole-screen steps of 1440 × 900 at WebP 0.85); warn above 10 MB
(§5.5.5). Outlook.com takes about 20 MB attachments, Gmail and Exchange Online 25 MB.

---

## 7. Chapters without AI

### 7.1 The rules they keep

- YouTube's: the first chapter at 0:00, at least 3, each at least 10 s, listed in order. Flown
  already checks these (`YOUTUBE_RULES`, `youtubeChapters`, `src/shared/render/chapters.ts:59,73`).
- They are judged in **video time** (after cuts, speeds and pause freezes, `outputChapters`) and
  stored in source time (`Chapter.t`). A candidate inside a cut is dropped.
- `L < 30 s`: too short ("Too short for chapters…"). Below three chapters the plan is still applied
  when it has at least two, and the notice says YouTube needs three.
- **At most** `N = clamp(round(L / 90 × d), 3, 12)` chapters, each at least
  `m = max(10, 0.06 × L × e)` long, with `d, e` = 0.6, 1.5 for *Fewer*; 1, 1 for *Normal*; 1.5, 0.67
  for *More*. Examples at Normal: L = 120 s allows 3, m = 10 s; 600 s allows 7 and 36 s; 3600 s
  allows 12 and 216 s. `N` is a ceiling, not a target: each split must earn its place (§7.4).
- User chapters are fixed: always kept, never moved, worked around. Pending found chapters are
  removed before planning again.

### 7.2 Reading the screen (`detectScenes`, `src/main/sceneScan.ts`)

One ffmpeg pass over `screen.mp4` finds both still stretches and how much of the picture changed at
each sample, inside the editor's crop as still detection does (`freezeDetectArgs`,
`src/main/analysisIpc.ts:47`):

```
ffmpeg -hide_banner -nostdin -nostats [-skip_frame nokey] -i screen.mp4 -an -sn -dn
  -filter_complex "[0:v]<fps=4,><crop,>scale=320:-2:flags=area,split=2[a][b];
    [a]freezedetect=n=-50dB:d=0.5[fa];
    [b]format=gray,tblend=all_mode=difference,blackframe=amount=0:threshold=8[fb]"
  -map "[fa]" -f null - -map "[fb]" -f null -
```

- The changed share at a sample is `100 − pblack`, read from blackframe's lines
  (`frame:19 pblack:38 … t:5.000000`). Stills are freezedetect's `freeze_start` / `freeze_end`.
- **Sampling.** Proxies and imported videos are encoded with a key frame every 15 frames
  (`-g 15`, `src/main/proxyArgs.ts:123`, at the video's own rate). Only at 60 fps or more
  (`capture.fps ≥ 60`) are key frames 0.25 s apart or closer, so only then are key frames alone read
  (`-skip_frame nokey`). Every other rate (30 fps recordings, 24 and 25 fps imports, whose key frames
  are 0.5–0.63 s apart) is decoded whole with `fps=4` before the crop, as still detection decodes a
  30 fps proxy whole (`analysisIpc.ts:171-176`, whose `keyFramesOnly = fps !== 30` this scan does not
  copy). The step between samples is then 0.25 s, or the key-frame spacing at 60 fps and above.
- Measured on a 34 s, 1440 × 900 synthetic recording made from Flown's own screens: 0.84 s for the
  pass, about 45 times real time.
- Result `SceneScan { step: number; t: number[]; changed: number[]; stills: { start: number; end:
  number }[] }` (`changed` 0..100, whole numbers).
- Cached in memory (8 results, as still detection) and in the project's `.cache/scenes.json`, keyed
  by the file's size, its modified time and the crop, so the second run and copies are instant.
- Progress events (`projects:sceneProgress`) from the last `t:` read ÷ the duration, every 250 ms.
  Time limit: 60 s plus the recording's length, as still detection's. `stopAnalyses`
  (`analysisIpc.ts:208`) also stops it, so closing the editor or deleting the project never waits.
- Smart speed's own still detection is untouched; its cache and results stay the same.

**A screen change** at sample *i* (`screenChanges`, `src/shared/smart/screenChanges.ts`, contracts):
`changed[i] ≥ 10`, the median of the samples in the next 1.0 s (`settleS`; `ceil(1.0 / step)`
samples, 4 at a 0.25 s step) is `≤ 3` (the screen settled), and no scroll event in the 0.5 s before
it. It is a **page change** when `changed[i] ≥ 30`. Measured on the synthetic recording:

| Event | Changed share | scdet score (for comparison) |
|---|---|---|
| A page of another app | 62% | 9.30 (missed at scdet's default 10) |
| A dialog opening | 17% | 11.21 |
| A menu | 7% | 4.34 |
| Scrolling (each key frame) | 23–53%, never settles | 1.2–7.5 |
| A page after the scroll | 73% | 11.44 |
| Another panel of the same app | 6% | 1.11 |
| The cursor moving | 1% | about 0.05 |

Scrolling and video playing on screen never settle, so they are never changes. A full-screen
recording's page changes stand in for the app switches F-10 asked for (§0 decision 4).

### 7.3 Candidates and their scores (`src/shared/chapters/signals.ts`)

Each signal gives candidate times in source seconds. Candidates within 2 s of each other merge: the
score is the sum of the best score of each kind present, the signals are kept for Review's detail,
and the time is chosen by the snap rule below.

| Signal | Rule | Score |
|---|---|---|
| Page change | §7.2, share ≥ 30% | 3.5 |
| Screen change | §7.2, share 10–30% | 1.5 |
| Pause in speech | a gap between speech ranges ≥ 2 s (1.5–2 s: 0.75); speech from the transcript's words (`transcriptSpeech`, `src/shared/audio/speech.ts:84`), else the speech detector's cached ranges (F-03), else none; the candidate is the next speech start | 1.5 (0.75) |
| Idle input | an input gap ≥ 3 s (`inputGaps`, `src/shared/editor/smartSpeed.ts:102`); the candidate is the gap's end | 1 |
| Common cue | a sentence (`sentencesOf`, `src/shared/editor/retakes.ts:42`) starting with a word that also starts ordinary sentences (`CUE_WORDS.common`): en "now", "next", "first", "then", "so", "okay", "let's"; bn "এখন", "এবার", "প্রথমে", "তারপর" | 1 |
| Section cue | a sentence starting with words that announce a part (`CUE_WORDS.section`): en "moving on", "next step", "next up", "the next thing", "in this section", "in the next part", "let's move on", "finally", "lastly", "to finish", "part" or "step" followed by a number; bn "পরবর্তী ধাপ", "এবার আসি", "পরের অংশে", "শেষে", "সবশেষে", "ধাপ" or "অংশ" followed by a number. A sentence counts once, as its strongest cue | 2.5 |
| Topic shift | TextTiling over the transcript's kept words: pseudo-sentences of 20 words, blocks of 6, smoothing 2, a boundary where the depth exceeds mean − σ/2, at least 4 gaps between boundaries; snapped to the nearest sentence start | `2 × min(1, depth ÷ 0.5)` |
| Title card | the start of a user's centred, big or lower-third card (not one Captions Studio made from a chapter) | 4 |
| AI suggestion | a start the `chapters` task suggested (§7.6.1) | 3.5 |
| The user's chapter | fixed | — |

- *Split at* turns kinds off: *Screen changes* (page and screen), *Pauses* (pause and idle), *What you
  say* (cues and topics). Title cards and AI suggestions always count.
- **Snap**: a merged candidate moves to the nearest sentence start within 2 s; else it stays at the
  screen change, or at the speech start.
- The topic score uses TextTiling's own depth (a difference of cosine similarities, 0..2), not a share
  of the deepest, so a one-topic transcript's shallow valleys score low. The 0.5 is held by tests 36
  and 117: the true boundaries of a three-topic fixture score at least 1.5; no valley of a one-topic
  fixture scores above 1.
- **Silent recordings** (no transcript, no speech ranges) use screen changes, idle input and title
  cards, so they get chapters too.
- The seam for later: `planChapters` takes an optional `apps` list (F-10 with a foreground-window log,
  §0 decision 4), each switch a candidate of score 4. Nothing passes it in this wave.

### 7.4 Choosing (`chooseBoundaries`, `src/shared/chapters/plan.ts`)

Exact, by dynamic programming over the candidates sorted by video time `v₁ < … < vₖ` (at most 400
after merging; the best-scored are kept when there are more):

- **Each split costs** `c` = 3.5 (*Fewer*), 3.0 (*Normal*), 2.0 (*More*), and a candidate adds
  `score − c`. A split is made only when that is above 0, so at Normal a split needs a page change, a
  title card, an AI suggestion, a section cue with a pause, or three weaker signals together. A pause
  and "now" (2.5) is not enough; a page change alone (3.5) is.
- **The first start**: 0:00 (the first kept source time) is always a start and costs nothing; a
  candidate within 2 s of it merges into it and lends it its signals. When a user chapter lies within
  `m` (or within 10 s, whichever is larger) of the first kept time, that chapter stands in for the
  0:00 start and no found chapter is added before it; the plan's `youtube` is then `false` when that
  chapter is not at 0:00 (the notice says "YouTube needs the first chapter at 0:00").
- `best[i][n]` = the highest total of `score − c` of `n` chosen starts ending with candidate *i*,
  over predecessors *j* with `vᵢ − vⱼ ≥ m`. Fixed (user) starts must be chosen and add 0; between two
  fixed starts the `m` rule is waived.
- The answer is the highest `best[i][n]` with `n ≤ N` and `L − vᵢ ≥ m`; ties go to fewer chapters,
  then to the plan with more even lengths (the smaller largest chapter).
- The notice reports the honest count. No candidate above `c`: `nothing` ("Found no clear place to
  split…").
- Cost: `k² × N` = 1.9 million steps at most, under 50 ms (§18).

### 7.5 Names (`chapterNames`, `src/shared/chapters/names.ts`)

For each found chapter, in order, the first that gives a name (`ChapterOrigin.name`):

1. **A title card** (`'card'`) the user made starting within 3 s of the chapter: its title, one line.
2. **The first sentence** (`'sentence'`, `sentenceName`, `src/shared/smart/sentenceName.ts`,
   contracts): the first sentence that starts in the first 20 s of the chapter, with leading cue words
   (`CUE_WORDS`), fillers (`findFillers`, `src/shared/editor/fillers.ts:60`) and lead-ins removed
   (`LEAD_WORDS`: en "so", "and", "okay", "alright", "now", "next", "then", "first", "finally", "let's",
   "we'll", "I'll", "I'm going to", "we're going to", "you can", "we", "you" before a verb; bn "তো",
   "আচ্ছা", "এবার", "এখন", "তারপর", "চলুন", "শেষে"), then cut at its first comma, semicolon, "so
   that", "and then", "which" or "because" (bn "যাতে", "তারপর", "কারণ"), the first letter made a capital
   in scripts that have them. Used when what is left is 2 to 8 words: "Now let's set up billing, which
   takes a minute." gives "Set up billing".
3. **A phrase said in it** (`'phrase'`): among runs of 2 to 4 consecutive kept words inside one
   sentence of the chapter, the run with the highest summed tf-idf (the chapter against the whole
   transcript; stop words, `src/shared/captions/stopWords.ts`, and words under 3 graphemes count 0),
   whose first and last words are not stop words; sentence case in Latin scripts: "Billing address",
   "Export settings". Else the object `uiObjects` finds most often in the chapter, at least twice:
   "Export".
4. **The first sentence, cut** (`'cut'`, weak): at a word boundary to at most 40 graphemes
   (`Intl.Segmenter`), without a trailing punctuation mark or ellipsis.
5. **A number** (`'number'`, weak): "Part 3" for the third chapter (bn "অংশ ৩", digits as the
   captions' `digits` choice); the 0:00 chapter is "Intro" (bn "শুরু").

A name is refused, and the next source tried, when `privateLike` finds anything in it (§20.0: the
link check's `linkLike`, `check.ts:158`, for URLs, emails and dotted names, plus `pathLike` for
Windows and home paths: `C:\`, `\\server\`, `~/`, `/Users/`, `/home/`), so no URL, email or file path
ever becomes a name; or when it is empty, or the same (ignoring case) as an earlier chapter's name.
Names are cut to `CHAPTER_MAX_CHARS` (100, `titleData.ts:14`) by graphemes, never inside a cluster.
Weak names (`'cut'`, `'number'`) show "Rename?" in the chapter list until edited.

### 7.6 Names with AI

*Names: With* [text choice] sends the `names` task with `kind: 'chapter'`: per chapter, its id and
its kept narration (at most 1,500 characters, from the start; bleeped words masked). A chapter with
no words is not sent and keeps its offline name. The answer is checked (§5.3's rules, names of 1–100
characters); a name in which `privateLike` finds anything is dropped for the offline one, **whether
or not it was said**, so the guarantee of §7.5 holds for every name. The origin says `name: 'ai'` and
`via` (and `host` for a service).

#### 7.6.1 Split with AI (the Captions tab's *Suggest chapters*)

- With a service or built-in provider: the existing `chapters` task runs as today (its prompt
  unchanged, test 5). Each suggested start becomes an `'ai'` candidate (score 3.5, snapped to the
  nearest sentence start within 2 s) beside the offline signals, and §7.4 chooses, so YouTube's rules
  and the user's chapters hold. A chosen start merged with an AI candidate takes that suggestion's
  title (checked by `privateLike`; refused: the offline name), with `name: 'ai'`, `from` including
  `'ai'`, `via` and `host`. Other starts are named offline.
- With On this PC: Find chapters splits offline and the local model names the parts (decision 18).
- Either way the chapters go through `withFoundChapters` (§7.7): Review rows, and each run replaces
  the pending chapters of the other.
- The Captions tab's shared provider select (`CaptionsPanel.tsx:1137`) is built with
  `useTextChoices('title')`, so it offers On this PC; *Suggest chapters* routes a `'local'` choice as
  above. `CaptionsPanel` already receives the Inspector's `cursor` track (`Inspector.tsx:33`, passed
  with `{...props}`), which `runFindChapters` needs.

### 7.7 Applying, Review and settling (`src/shared/chapters/chapterAuto.ts`)

- `withFoundChapters(project, found)`: in one store update, removes the pending found chapters
  (`auto` set) that are not found again, and the pending chapter-title cards Captions Studio made
  from them (`TitleCard.auto.by === 'chapter'` with that `auto.chapter`), then adds the new chapters,
  each with a new id (`createChapter`, `src/shared/editor/titles.ts:152`) and its `auto` origin. A
  chapter found again within 0.05 s of a pending one with the same title and an equal origin keeps
  that chapter object (its id and `auto`), so a second identical run returns the input project itself.
- Review rows, Keep and Remove: §13.1.
- `settleChapters(next, prev)` (the settle chain, `Editor.tsx:207`): a found chapter whose `t` or
  `title` changed while its `auto` object stayed the same object loses `auto` in the same update: an
  edit by hand makes it the user's, as with automatic zooms. Automation always writes new `auto`
  objects, so its own updates keep them. Returns `next` itself when nothing applies.
- **Where pending chapters go.** Like pending zooms, pending chapters are live: exports, the YouTube
  description, *one file per chapter* and wave 10's progress bar use them. Three places count **user
  chapters only**, so a found chapter changes nothing there until it is kept:
  - the copy pack's link check: `projectSaid` (`checkNote.tsx:18`) and the Publish dialog's
    `chapterTitles` for `saidLinks` (`PublishDialog.tsx:68-71`) skip chapters with `auto`, so a found
    or AI-named chapter can never vouch for a link;
  - Captions Studio's *Auto* chapter titles (`resolveGreatOptions`, `great.ts:124`): Auto means "on in
    wide videos that have user chapters";
  - wave 10's step-badge numbering (`badgeLabels`): the count starts again at user chapters only.
  The chapter row's detail adds "· keeping it restarts step numbers here" when the project has
  automatically numbered badges and `badgesByChapter` is not `false`.
- The Export dialog's chapter note adds "3 of them not reviewed yet" while any are pending.

### 7.8 Running it (`runFindChapters`, `src/renderer/src/editor/chaptersRun.ts`)

1. **Words or not.** Without captions, `needsCaptions` (`src/shared/smart/speechHeard.ts`, contracts)
   looks at the audio levels the silence tools already read (`analyzeAudio`,
   `src/shared/api/export.ts:178`): when the speech detector's ranges, or without them the activity
   that `speechFromLevels` (`src/shared/audio/speech.ts:71`) finds, add up to 10 s or more, the
   recording holds speech and the panel says "Make captions first" (§2.3). "No speech was found" is
   said only when the levels show less than 10 s, or there is no sound.
2. Read the scene scan (`projects:detectScenes`, cached; skipped when *Screen changes* is off), the
   speech ranges, the effective track and the transcript.
3. With §7.6.1's service: the `chapters` task (its cost line shown before the click).
4. `planChapters` (pure) gives the starts and their signals, or why none.
5. `chapterNames` names them offline; with *Names: With …*, the `names` task names those with words.
6. `withFoundChapters` applies them in one update; the notice of §2.3, and focus on the first weak
   name.

A failed scene scan is not fatal: "Could not read the screen: chapters come from pauses and what you
say." Stop cancels the scan and the AI request; nothing changes.

---

## 8. Short clips

### 8.1 Sentences and their features (`scoredSentences`, `src/shared/clips/sentences.ts`)

Sentences come from `sentencesOf` (`SENTENCE_PAUSE` 0.8 s, `retakes.ts:10`) over the kept words. For each
sentence, in viewing time (clip speeds):

| Feature | Rule |
|---|---|
| Speech density | words a second, z-scored over the recording |
| Key words | the sum of `emphasisScores` (`emphasis.ts:72`) of 2.5 or more, per second, z-scored |
| The user's emphasis | a user's (not automatic) `captionMarks` entry in it: +1 |
| Numbers | a statistic by `findNumbers` (Captions Studio): +0.5 each, at most +1 |
| Action | clicks, typing sessions, zoom starts and screen changes inside it: `min(1, count / 3)` |
| Fillers | fillers a second (`findFillers`), z-scored, subtracted |
| Retakes | the earlier take of a retake pair (`findRetakes`, `retakes.ts:79`): left out |
| Focus on | a word of *Focus on* (lower case, compared by its first 5 letters in Latin scripts, whole in others) in it: +2 |

Sentences of fewer than 3 words are left out.

### 8.2 Moments (`findMoments`, `src/shared/clips/moments.ts`)

- **Candidates**: every stretch from a sentence start (after a gap of at least 0.3 s) to a later
  sentence end whose kept length is 15 to 90 s (*Under 60 s*: 15–60; *60–90 s*: 60–90). Never from
  or to the middle of a sentence. A 1-hour recording of 600 sentences gives at most about 9,000.
- **Score**: the length-weighted mean of the sentences' features, plus:
  - **hook** +1: the first sentence is a question (ends in "?", "؟" or "।?", or starts with how, why,
    what, কীভাবে, কেন, কী), holds a number, or starts with a UI verb (`UI_VERBS`);
  - **ending** +0.5: the last sentence is followed by a gap of at least 0.4 s;
  - **refers back** −0.5: the first sentence starts with "as I said", "like I said", "as mentioned",
    "this one", "that one", "যেমন বললাম", "আগেই বলেছি";
  - **empty** −1: more than 30% of the stretch has no speech and no input;
  - **choppy** −0.5: more than 4 cuts a 30 s;
  - **length** +1.5 × `exp(−((len − 45) / 20)² / 2)`, best at 45 s.
- **Pick**: best first; a candidate overlapping a picked one by more than 30% of the shorter is
  dropped; at most `K = clamp(round(L / 120), 3, 10)` moments. A video under 45 s gets none ("Too
  short for clips: post the whole video.").
- **Reasons** (at most 3, from the largest terms): "Packed with information" (density), "Important
  words" (key words), "Words you emphasised", "Numbers", "6 clicks", "Opens with a question", "Ends
  cleanly", "Mentions “billing”" (*Focus on*), and always the length "45 s".

### 8.3 Silent recordings

Only when §7.8's rule finds no speech (with speech and no captions, the panel asks for captions
first). The activity a second (clicks, keys, typing, scrolls and screen changes) is summed in 15–90 s
windows that start and end at a screen change that settled or an input gap of at least 1 s, scored by
activity density plus 1 per page change, the same length term, and picked the same way. The title is
"Most action, 1:05" and the reasons "12 clicks · 3 screens". *Use activity only* forces this path for
a recording with speech.

### 8.4 Titles

- Offline: the first sentence by `sentenceName` (§7.5 rule 2), else rule 4's cut, else "Clip 2".
- *Names: With* [text choice]: the `names` task with `kind: 'clip'`, each moment's words (at most
  1,500 characters); names of 1–80 characters, refused by `privateLike` whether or not said.

### 8.5 Making the copies (`clipCopy`, `src/shared/clips/clipCopy.ts`)

For each ticked moment, one after another (Duplicate makes one copy at a time,
`src/main/projectCopy.ts:136`):

1. `projectCopy(project, shape, measure)` (`src/shared/editor/duplicate.ts:75`) with `'vertical'`,
   `'square'` or `'copy'`, so the vertical framing, caption look and refit are Duplicate's own.
2. Then: `clips` = the original's kept pieces inside the moment (`clipsBetween`,
   `src/shared/render/exportBundle.ts:192`, by edit time), `freezes` only those inside it (as
   `partProject` does, `:241`), `chapters` and `guide` dropped, `name` = "<title> (clip)" cut to 120
   characters (`copyName`'s rule), `clipOf = { kind: 'moment', start, end, why }`.
3. **Only the pending changes it shows** (`withinRange`, same file): the original's `AutoCut` records
   are kept only when their `[start, end]` lies inside the moment; the rest are dropped with no
   outcome recorded, so Remove in the copy can never bring back footage from outside it. Every other
   pending Review item (automatic zooms, camera moves, Captions Studio's automatic items, cut styles)
   whose time range lies wholly outside the moment is settled with Review's own `keepItems`, which only
   drops its record; what lies inside stays listed. The copy's Review count is then about the copy.
4. **Captions** (the panel's checkbox, on when there are captions): `captions.show = true`.
   `projectCopy` already gives a copy in another shape the look Auto style picks for its frame
   (`withCopyLook`, `duplicate.ts:109`) unless the user picked one by hand.
5. `window.api.duplicateProject(project.id, copy)`, with Duplicate's progress and cancel
   (`src/renderer/src/editor/duplicateFlow.ts:36`). Media is hard-linked unless the projects folder is
   under OneDrive (`linkAllowed`, `projectCopy.ts:72`), where each copy holds a full copy of
   `screen.mp4` and the other recordings.
6. Before the first copy: `projects:copyCost` (§20.3) gives whether files can be linked, the bytes a
   full copy takes and the free space; the panel's space line and its block come from it.

Everything else is kept as it is: every item is in source time, so captions, zooms and texts stay in
place, and what lies outside the moment is never shown.

### 8.6 The shorter version (`planShort`, `src/shared/clips/short60.ts`)

1. Sentence scores: key words (normalised 0..1 over the recording) + 1 near an action (within 0.6 s
   of a click, typing, a zoom or a screen change) + 0.5 in the first 15% or the last 10% of the video
   (the set-up and the result) + 2 for a *Focus on* word + 1 for the user's emphasis + 0.5 for a
   statistic; earlier takes of retakes and sentences under 3 words left out; fillers more than 30% of
   a sentence: −1.
2. Choose by relevance with a penalty for repeating (maximal marginal relevance, λ = 0.7, similarity
   = cosine of the sentences' tf-idf vectors of content words). First one sentence per user chapter
   while they fit (when there are 2 or more), then the best remaining while any fits.
3. A sentence's piece runs from 0.15 s before its first word to 0.25 s after its last, never past the
   midpoint to the next or previous word. Pieces less than 0.6 s apart join. The pieces' viewing time
   (with their clips' speeds) plus the pause freezes inside them must stay within the length chosen
   (30, 60 or 90 s, to 0.05 s). A length at or above L is not offered.
4. Pieces stay in their original order. Fewer than half the length found: "Not enough clear speech
   for a shorter version." and no copy.
5. The copy (`shortCopy`): `projectCopy` for the shape; the original's `AutoCut` records kept only
   when they lie inside one kept piece (a record inside a removed stretch would, when removed, put a
   stray fragment into the short), other pending items outside the pieces settled as in §8.5 step 3;
   then `recordAutoCuts(copy, pieceClips, removedRanges, 'cut', 'short')`
   (`src/shared/review/autoCuts.ts:496`), which writes the records of the removed stretches with
   their `was` pieces and speeds, splitting a stretch of more than 64 pieces (`MAX_WAS_PIECES`,
   `autoCutData.ts:27`) into several records, so one stretch can be several rows. Review lists each
   with Keep and Remove, and Remove brings it back (`takeBackSteps`). Freezes inside the pieces only,
   chapters dropped, name "<name> (60 s)" (the length chosen: 30, 60 or 90 s), `clipOf = { kind:
   'short', start: first piece start, end: last piece end }`, and the dialog's Captions choice as in
   §8.5.
6. **Smooth cuts.** About 14 cuts a minute make a jumpy short. When the original has no `joins.all`
   of its own, the copy gets wave 10's smooth cuts, `joins.all = { kind: 'smooth' }`, recorded as
   `joins.auto = { by: 'short', was: null }`, so Review lists one row ("Smooth cuts at 14 cuts",
   detail "Make a shorter version") with Keep and Remove, as for Polish's. A cut style the user chose
   is kept.

Without captions, *Make a shorter version* is disabled (§2.4).

---

## 9. AI on this PC

### 9.1 The helper (`ssw-llm.exe`, `native/llm/`)

- **What it is.** A Rust program, like `ssw-speech` (`native/speech/Cargo.toml`), on the
  `llama-cpp-2` and `llama-cpp-sys-2` crates (0.1.161, MIT OR Apache-2.0), which vendor llama.cpp
  (MIT) and its own ggml. A separate program, so its ggml never meets whisper.cpp's (0.9.5) in one
  binary. Built by `scripts/build-native.mjs` for `x86_64-pc-windows-gnu` with the POSIX-thread MinGW,
  statically (`-static`, `static-stdcxx`), CPU only, with SSE4.2, AVX, AVX2, FMA and F16C forced on
  through `GGML_*` variables, which `llama-cpp-sys-2`'s build script forwards to CMake (`build.rs:789`)
  (one build; §0 decision 1). Output `native/bin/ssw-llm.exe`.
- **The crates, pinned** (checked on crates.io): `llama-cpp-2 = { version = "=0.1.161",
  default-features = false }`, which turns off its defaults `openmp` and `android-shared-stdcxx`
  (with `openmp` off, the sys crate's build script sets `GGML_OPENMP=OFF`, `build.rs:1198-1201`, so
  no `libgomp-1.dll`), and leaves `mtmd` and `llguidance` off. `native/llm/Cargo.lock` is committed
  and the build runs with `--locked`. `native/llm/README.md` and the notice record:
  `llama-cpp-sys-2` 0.1.161, crate SHA-256
  `e9bea77fde41bbc15a278891cd5edd2ba07c5260d162614b41080ba1f100b39b`, built from llama-cpp-rs commit
  `e7af607ebd5ec2932709ef918c17cca2f9b0fce4` (its `.cargo_vcs_info.json`); `llama-cpp-2` 0.1.161,
  crate SHA-256 `7e5249e590eab4a5015ba35cf078a4548b941e841ef8024310c3a10b2edb7179`; and the vendored
  llama.cpp commit (the contracts step reads it with `git ls-tree e7af607e llama-cpp-sys-2/llama.cpp`
  in llama-cpp-rs and writes it there). The vendored `src/llama-arch.cpp` lists `qwen35` and `gemma4`
  (checked), so the spike only has to prove the static MinGW build.
- **`common` is compiled but not linked.** `llama-cpp-2` 0.1.161 depends on `llama-cpp-sys-2` with
  its default features, and `common` is one of them, so Cargo builds llama.cpp's `common/` (and its
  vendored cpp-httplib) whatever Flown's manifest says. The helper calls nothing from it, and a static
  link takes only referenced objects. `verify-dist`'s checks prove it on every build: imports only
  `KERNEL32.dll`, `ADVAPI32.dll` and `msvcrt.dll` (no `WS2_32.dll`), and the size budget. If either
  fails, the helper builds against a `[patch.crates-io]` copy of `llama-cpp-2` 0.1.161 in
  `native/llm/vendor/` whose one change is `default-features = false` on its `llama-cpp-sys-2`
  dependency (the diff in the README).
- **No template engine.** The helper never reads or runs the GGUF's embedded Jinja chat template;
  Flown's code writes the chat format (§9.6). Hugging Face's file scanner marks these files
  PAIT-GGUF-100 (a chat template that a template engine could run); that does not apply to a helper
  that never runs it.
- **Shipped** through the same directory-form `extraResources` entry as the speech helpers
  (`speechResources`, `scripts/lib/packaging.cjs:147`, `{ from: 'native/bin', to: 'native', filter }`),
  with `ssw-llm.exe` added to its filter, so electron-builder signs it: a single-file `from` is copied
  without the signing transformer (`electron-builder.config.cjs:46-49`). A build without the file
  leaves it out, as for the speech helper.
- **Checks in `verify-dist`.** Its imports as above; `LLM_BUDGET = { compressed: 3.0e6, installed:
  9.0e6 }` bytes; in a signed build, an Authenticode signature; its notice.
- **Notices.** `scripts/notices.mjs` gains `native/llm/Cargo.toml` in `CRATES` (`:29`) and names
  `ssw-llm.exe` in `RUST_TITLE` (`:36`), so the helper's crates (`llama-cpp-2`, `llama-cpp-sys-2`,
  `enumflags2`, `thiserror`, `tracing`, `tracing-core`, the JSON crate) are listed and
  `npm run notices -- --check` catches a missing one; `NOTICE_NAMES` (`packaging.cjs:171`) gains
  `'llama.cpp'`. `resources/notices/NN-llama-cpp.txt` names the vendored llama.cpp commit and gives the
  MIT notices of the code compiled in: the ggml authors (llama.cpp and ggml), the Mozilla Foundation
  (`ggml-cpu/llamafile/sgemm.cpp`; `GGML_LLAMAFILE` is on by default), Jeffrey Quesnelle and Bowen
  Peng (the YaRN code in `ops.cpp`), and ggllm.cpp (code adapted in `llama-vocab.cpp`); the Unicode
  data of `src/unicode-data.cpp` points to the Unicode licence already in `35-caption-data.txt`.
- **Toolchain note.** GCC 13's mingw-w64 headers lack `THREAD_POWER_THROTTLING_STATE`
  (`ggml-cpu.c:2598`): the build uses newer mingw-w64 headers, or patches that hint in, so Windows 11
  does not park its threads. Building with `_WIN32_WINNT=0x0601` (as the research did) loses it.
- **The spike first** (one day, P4's first task): build it, load the two pinned models (§9.3), and
  run test 66 under wine. If `llama-cpp-2` cannot be built statically, the same program is written in
  C++ against llama.cpp at the same pinned commit (research: 50 s to build on 4 cores).
- **Lifecycle.** Started with `--low-priority --parent-pid <pid>` (the speech helper's `commonArgs`,
  `src/main/speech/helper.ts:160`): below-normal priority, and it exits when Flown's process is gone.
  It reads stdin on its own thread, so a closed stdin ends it within a second even in the middle of
  a request.

**Protocol** (JSON lines on stdin and stdout; `src/shared/localAi/protocol.ts` reads each line
strictly; a line over 4 MB, or one that does not parse, ends the job):

| Direction | Line | Meaning |
|---|---|---|
| → | `{"op":"load","model":"<path>","ctx":8192,"threads":4,"mmap":false}` | Load a model. `mmap: false` saved 0.77 GB (llama.cpp keeps a second, rearranged copy on CPUs). |
| ← | `{"ev":"loaded","ms":1840,"ctxTrain":131072}` | — |
| → | `{"op":"run","id":"r7","parts":[{"t":"<\|turn>system\n","special":true},{"t":"…","special":false},…],"grammar":"<GBNF>","maxTokens":400,"temperature":0.2,"topP":0.9,"seed":1}` | One request. `parts` is the chat in pieces (§9.6): each is tokenized with special-token parsing set by its `special`, so only the template's own pieces can make control tokens. The model's beginning-of-text token is added by the tokenizer to the first part when the model asks for one (`tokenizer.ggml.add_bos_token`). |
| ← | `{"ev":"read","id":"r7","done":512,"total":1478}` | After each batch of 64 prompt tokens. |
| ← | `{"ev":"write","id":"r7","tokens":48}` | Every 16 tokens written. |
| ← | `{"ev":"done","id":"r7","text":"{…}","prompt":1478,"output":212,"readMs":11700,"writeMs":38200}` | The answer (at most 256 KB). |
| → | `{"op":"cancel","id":"r7"}` | Stop after the current batch of 64 prompt tokens or the current token. |
| ← | `{"ev":"cancelled","id":"r7"}` | — |
| ← | `{"ev":"error","id":"r7","code":"context","message":"…"}` | `code`: `context` (prompt too long), `model`, `memory`, `internal`. |
| → | stdin closed | Exit. |

It reads only the model file main names and its stdin, writes only stdout and stderr, opens no port
and makes no other file. Main never passes it a project path or a key. It does not report the
processor: §9.5 reads that from the speech helpers' probe, so a CPU without AVX2 never runs it.

### 9.2 Running it (`src/main/localAi/engine.ts`)

- One helper process at most, started on the first request, arguments as a list (no shell, `commonArgs`
  first), working folder `userData/text-models`.
- **One request at a time.** Others wait in order; each waiting one's progress says "Waiting for AI
  on this PC…". The Publish dialog's queue runs one at a time for On this PC (two for services, as
  today, `publishRun.ts:94`).
- **Threads**: `clamp(floor(logical / 2), 1, 8)` (one per physical core on most PCs; 4 on the
  research machine).
- **Context**: 8,192 tokens; the measured peaks (§9.3) include it. A longer context would only make
  reading slower (§9.6 splits instead).
- **Unload**: the helper exits after 120 s with no request, when the last editor window closes, and
  when the app quits, giving its memory back.
- **Cancel**: the `cancel` line. `llama-cpp-2` 0.1.161 has no way to set llama.cpp's abort callback
  (`LlamaContextParams.context_params` is `pub(crate)`), so the helper reads the prompt in batches of
  64 tokens and checks between them. At the catalogue's cautious read speeds (Recommended 250, Small
  120 tokens a second) a batch takes at most 0.53 s; writing stops at the next token. If no
  `cancelled` comes within 2,000 ms (as the speech helper's `cancelGraceMs`), the process is killed
  and the model loads again next time (1–8 s); that is the fallback, not the path.
- **Watchdog**: no line for 120 s while a request runs (the speech helper's `stallMs`) kills it.
- **Long job**: a request expected to take more than 10 s is a long job (`beginJob`,
  `src/main/longJobs.ts`) of the new kind `'ai'`: the taskbar shows its progress, Stop on the
  thumbnail cancels it, the PC stays awake.
- **Progress** to the page that asked, by its `requestId` (`localAi:progress`, at most every 250 ms):
  `{ requestId, phase: 'loading' | 'reading' | 'writing' | 'waiting', done, total, secondsLeft }`,
  `secondsLeft` from the measured speeds (§9.8). Every text tool sends a `requestId` (§20.0), so the
  progress line and Stop reach the right button.
- **Test hook**: `SSW_LLM_HELPER` names a helper to run instead (a fake for tests); it is read only
  when `!app.isPackaged`, like `SSW_CAPTURE_HELPER` (`src/main/ai/endpoints.ts:5`) and the speech
  helper's `FAKE_SPEECH_*` (`helper.ts:153`).

### 9.3 The models (`src/shared/localAi/catalog.ts`)

| Id | Shown as | File | Bytes | SHA-256 | Source (unsloth, Hugging Face) | Peak memory | Needs total |
|---|---|---|---|---|---|---|---|
| `gemma4-e2b` | Recommended · Gemma 4 E2B | `gemma-4-E2B-it-Q4_K_M.gguf` | 3,106,738,272 | `740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8` | `unsloth/gemma-4-E2B-it-GGUF` @ `0314792d7f1f7e229411f620751375812bb9faf2` | 3,848 MB | 12 GB |
| `qwen3.5-2b` | Small · Qwen3.5 2B | `Qwen3.5-2B-Q4_K_M.gguf` | 1,280,835,840 | `aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223` | `unsloth/Qwen3.5-2B-GGUF` @ `f6d5376be1edb4d416d56da11e5397a961aca8ae` | 2,226 MB | 8 GB |

- Both Apache-2.0, neither repository gated. The SHA-256 values and sizes were checked against the
  downloaded files and against Hugging Face's `x-linked-size` and `x-linked-etag` headers at the
  pinned commits; the commits were checked against Hugging Face's API.
- **Licences.** unsloth's repositories hold no LICENSE file; the licence is `license: apache-2.0` in
  each README's front matter (Gemma's with `license_link: https://ai.google.dev/gemma/docs/gemma_4_license`,
  which is the Apache 2.0 text). The upstream licences: `Qwen/Qwen3.5-2B` @
  `15852e8c16360a2fea060d615a32b45270f8a8fc` has an Apache-2.0 LICENSE file; `google/gemma-4-E2B-it` @
  `4adf15748de9e1a0097b6274cee9c15836c41c37` has none and links the same page. Test 70 keeps those
  front matters, that LICENSE file and a saved copy of the Gemma 4 licence page as fixtures.
- **Not offered**, kept in the research for decision 9's evaluation: Qwen3.5 4B
  (`unsloth/Qwen3.5-4B-GGUF` @ `e87f176479d0855a907a41277aca2f8ee7a09523`, 2,740,937,888 bytes,
  peak 4,070 MB).
- Each entry also holds its chat family (`'qwen'` or `'gemma'`), its default speeds (§9.8), its
  licence and maker for Settings, `minTotalMemGB`, and `notes`: per task, a short line shown beside
  the provider choice when that model would run it, written from decision 9's evaluation (before
  it: Small's title note "Small: titles often repeat the first sentence" and Bangla summary note
  "Small: Bangla summaries are short", from the research).
- `LOCAL_MODEL_MIRROR`: the Qbexel repository and commit, `null` until it exists (§0 decision 2).
- **Use** (`models.json`'s `use`): *Automatic* takes Recommended when it is downloaded, the PC is not
  blocked for it, and free memory at the start of the run is at least its peak; else Small when it is
  downloaded; else the run fails with §9.5's free-memory message. *Recommended* or *Small* pins one.
- Suggested at first download: Recommended on PCs with 12 GB or more, Small below.

### 9.4 Downloading and keeping them (`src/main/localAi/models.ts`)

- Through `downloadPinned` (`src/main/speech/download.ts:242`) with its rules: `.part` resumed with
  Range, SHA-256 checked as bytes arrive, renamed when it matches, 60 s stall, 3 retries,
  `Retry-After` up to 10 minutes, free space checked first (the file's bytes plus 64 MB),
  `allowDownloadUrl` (https on `huggingface.co`, `*.huggingface.co`, `*.hf.co`, port 443, no
  credentials; Hugging Face answers with a 302 to `us.aws.cdn.hf.co`, which it accepts). Sources in
  order: the mirror, then unsloth's commit URL `https://huggingface.co/<repo>/resolve/<commit>/<file>`.
- Kept in `userData/text-models/`; `models.json` holds the *Use* choice and the measured speeds.
  Unknown files are never opened; stale `.part` files go after 30 days (`STALE_PART_MS`,
  `src/main/speech/models.ts:30`).
- Before a file is handed to the helper: its size equals the catalog's and its first 4 bytes are
  `GGUF`. (The hash was checked when it was written; checking 3.1 GB again at every load would cost
  seconds.)
- Remove deletes the file (stopping the helper first if it has it loaded).
- IPC (`src/main/localAi/localAiIpc.ts`): `localAi:state`, `localAi:download`, `localAi:cancel`,
  `localAi:remove`, `localAi:setUse`, and events `localAi:changed` (at most every 250 ms) and
  `localAi:progress`. Every handler checks the sender (`fromApp`) and takes only catalog ids.
- **Test hook**: `SSW_TEXT_MODEL_TEST_CATALOG` names a JSON file of catalog entries (a small model on
  a local server) for the e2e run; read only when `!app.isPackaged`, as `SSW_MODEL_LIST_URL`
  (`src/main/ai/modelListIpc.ts:15`).

### 9.5 When the PC can use it

- **Processor**: AVX2, FMA and F16C, read only from the speech helpers' processor probe
  (`probedProcessor()`, `src/main/speech/helper.ts:167`), which `ssw-speech-compat.exe` runs without
  any AVX code (`src/shared/speech/protocol.ts:59`). `ssw-llm` is never started to find out. Without
  the features: "This PC's processor is too old for AI on this PC (it needs AVX2)." No probe result
  (the probe failed, or a build without the speech helpers): the same block, worded "Flown could not
  check this PC's processor."
- **Total memory**: at least `minTotalMemGB − 1` GB (an "8 GB" PC reports as little as 7 GB, the rule
  of `speechModelBlock`, `src/shared/speech/catalog.ts:242`).
- **Free memory before loading**: at least the model's peak. Below it the request does not start
  (after *Automatic* has tried Small): "AI on this PC needs about 3.8 GB of free memory and 2.6 GB is
  free. Close some apps, or download the Small model." Below the peak plus 1 GB it warns in the
  progress line ("Memory is low: this may be slow").
- **The helper**: missing in a build without it ("AI on this PC is not part of this build.").

### 9.6 Prompts, grammar and sizes

- **The same tasks.** On this PC runs the shared text tasks (`runTextTask`,
  `src/shared/captions/transcriptText.ts:324`) with the same prompts, schemas and validators as the
  services, through an `AiClient` (`src/main/ai/types.ts:50`) whose `json(prompt)` is one helper
  request. `aiText` and `draftScript` in `src/main/aiIpc.ts` take `LOCAL_TEXT_ID` (`'local'`, the same
  string as `LOCAL_TRANSCRIBER_ID`, `src/shared/api/speech.ts:14`) before any key lookup; stored ids
  (`^ai…`, `^svc…`) can never collide with it.
- **Chat format** (`chatParts(family, system, user)`, `src/shared/localAi/chatFormat.ts`; `chatPrompt`
  joins the parts' text for tests), checked against each pinned file's own template:
  - `'gemma'` (Gemma 4): `<|turn>system\n` · system (trimmed) · `<turn|>\n<|turn>user\n` · user ·
    `<turn|>\n<|turn>model\n`. Thinking stays off: no `<|think|>` in the system turn, as the template
    writes it with `enable_thinking` false.
  - `'qwen'` (Qwen3.5): `<|im_start|>system\n` · system · `<|im_end|>\n<|im_start|>user\n` · user ·
    `<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n` (the empty think block is what the
    template writes with thinking off).
  - The pieces between the system and user text are `special: true`; the system and user text are
    `special: false`, so text such as `<turn|>\n<|turn>model\n` or `</think>` in a transcript is read
    as plain characters and cannot close the user turn.
  - **Defence in depth** (`breakSpecialTokens`): every control and user-defined token string of each
    pinned vocabulary (the GGUF's `tokenizer.ggml.tokens` whose `token_type` is CONTROL or
    USER_DEFINED, saved by `scripts/llm-special-tokens.mjs` as `tests/fixtures/llm/<id>-special.json`)
    is broken with a zero-width joiner in user and system text before it is sent. Gemma 4's include
    `<|turn>`, `<turn|>`, `<|channel>`, `<channel|>`, `<|think|>`, `<|tool>`, `<|tool_call>`,
    `<|tool_response>`, `<|"|>`, `<|image|>`, `<|audio|>`, `<|video|>`; Qwen3.5's `<|im_start|>`,
    `<|im_end|>`, `<|endoftext|>`, `<think>`, `</think>`, `<tool_call>`, `<tool_response>`,
    `<|vision_start|>` and the rest of its list.
- **Grammar** (`schemaGrammar(schema, caps)`, `src/shared/localAi/grammar.ts`): GBNF made from the
  task's JSON schema, which already uses only objects with every property required, arrays and
  strings (`transcriptText.ts:8-11`). Strings are JSON strings; a `{0,n}` repetition bounds them only
  for caps of 100 characters or fewer (names, titles), because a bounded repetition expands into `n`
  nested optional rules and slows the sampler. Longer strings (caption text, summaries, articles) are
  bounded by `maxTokens` and the validators. Arrays of `names` and `chapters` need at least one item
  (an empty list satisfied the schema in the research). The grammar forces the answer to start with
  `{`, so the model cannot think aloud or chat. The validators still check every answer.
- **Sizes** (`localLimits(language, family)`, `src/shared/localAi/budget.ts`), passed to
  `runTextTask`'s new `limits` (§20.0):

| Task | On this PC | Services (today, unchanged) |
|---|---|---|
| Clean-up, translate | batches of 40 captions or 3,000 characters | 150 or 12,000 (`transcriptText.ts:34-35`) |
| Title, summary | the transcript as evenly spaced excerpts within 4,500 prompt tokens | the whole transcript |
| Copy pack | excerpts within 4,500 prompt tokens | 60,000 characters (`PACK_TRANSCRIPT_MAX`) |
| Names (steps, notes, chapters, clips) | 12 items or 3,000 characters a request | 40 items or 12,000 characters |
| Script draft | notes within 4,500 prompt tokens, else "These notes are too long for AI on this PC: shorten them or use an AI service." | 20,000 characters |

  Prompt tokens are estimated from characters by script for the model's tokenizer (§11.2: Qwen 4.8
  characters a token in English, 2.04 in Bangla; Gemma 4.84 and 3.45). The prompt plus `maxTokens`
  stays within 8,192 − 64.
- **`maxTokens`** a request: clean-up and translate `ceil(text tokens × 1.3) + 12 a caption + 64`
  (text tokens of the target script), at most 4,096; title 80; summary 400; names 48 an item + 32
  (notes 120 an item + 32); YouTube 1,000; LinkedIn 700; X 160; article 2,200; release notes 1,400;
  script draft 2,000. An answer cut off at `maxTokens` fails its check ("Nothing was changed") and
  that batch is tried once more with 1.5 times the room.
- **Sampling**: temperature 0.2, top-p 0.9, seed 1: the same input gives the same draft.

### 9.7 What it is good for (measured, CPU, 4 threads)

| | Qwen3.5 2B (Small) | Gemma 4 E2B (Recommended) | Qwen3.5 4B (not offered) |
|---|---|---|---|
| Load | 1.1–2.0 s | 8.2 s | 6.3 s |
| Reading | 105–254 tokens/s | 395–462 | 88–108 |
| Writing | 5.8–12.6 tokens/s | 7.4–12.5 | 5.1–7.9 |
| Peak memory | 2,226 MB | 3,848 MB | 4,070 MB |
| Valid JSON with the grammar | 5 of 5 | 4 of 4 | 5 of 5 |
| Chapters by itself | wrong (the first segments) | an empty list | usable |
| Title | copied the first sentence | good | good |
| Bangla summary | one short sentence | two good sentences | two good sentences |
| English → Bangla, 5 captions | readable, some errors (37.7 s) | good (12.4 s) | good (29.2 s) |
| Stop while writing | 44 ms | 77 ms | 7 ms |

These rest on 4–5 samples a task; decision 9's evaluation replaces them with per-task notes before
release. So: names, titles, notes, summaries, clean-up, translation, the copy pack and script drafts
run on either model, labelled "good for drafts"; the *chapters* and *marks* tasks never run on this
PC (decision 18: Find chapters chooses, the model names; *Make my captions great*'s picker does not
offer On this PC). For a 20-minute recording (about 3,000 words) on the Recommended model: a title or
summary under a minute, clean-up about 7–11 minutes, English to Bangla about 10–12 minutes. Those
times are shown before the click (§11.5).

### 9.8 Speed on this PC

Each model starts with cautious speeds (Recommended: reads 250, writes 7 tokens a second; Small: 120
and 8). Each finished request blends its measured speeds in (`readMs`, `writeMs`; new = 0.7 × old +
0.3 × measured), stored per model in `models.json`. Estimates and `secondsLeft` use them.

### 9.9 Failures

| What happens | Behaviour | Message |
|---|---|---|
| Not enough free memory | Not started (after *Automatic* tried Small) | §9.5 |
| The file is missing or the wrong size | Not offered; the row offers Download again | "The model file is missing or damaged. Download it again in Settings › AI on this PC." |
| The helper crashes or the PC runs out of memory | The request fails; the next starts a new helper | "AI on this PC stopped unexpectedly. Try again, or use the Small model." |
| No line for 120 s | Killed | "AI on this PC stopped responding. Try again." |
| An answer fails its check | That batch once more with more room, then | "The AI's answer could not be used (…). Nothing was changed; try again." (`AiOutputError`, `transcriptText.ts:121`) |
| Stop | `cancel`, killed after 2 s | "Stopped." |
| The page that asked reloads or closes | Its requests are cancelled (`ai:text`'s handlers, `aiIpc.ts:194`) | — |
| The disk fills while downloading | `.part` kept for a later resume | "Not enough disk space: the model needs 3.2 GB." |
| A second request | Waits its turn | "Waiting for AI on this PC…" |

---

## 10. Any AI service

### 10.1 Where services are kept (`src/main/ai/serviceStore.ts`)

`userData/ai-services.json`, `{ version: 1, services: [...] }`, written atomically
(`writeFileAtomicSync`), read entry by entry like `ai-providers.json` (`keyStore.ts:92`). Each entry:

```ts
interface StoredService {
  id: string            // ^svc[a-z0-9]{1,30}$
  preset: ServicePreset // 'azure' | 'openrouter' | 'groq' | 'together' | 'ollama' | 'lmstudio' | 'other'
  label: string
  baseUrl: string       // normalised (§10.2)
  origin: string        // scheme://host[:port] the key is bound to
  model: string         // MODEL_RE, at most 100 characters
  json: 'schema' | 'object' | 'text'   // from the last check (§10.3); 'text' until checked
  keepNoData?: true     // OpenRouter: provider.data_collection 'deny' (§0 decision 5)
  createdAt: string
  key?: string          // encrypted with safeStorage, base64; absent only for a loopback origin
}
```

- The renderer sees `AiProviderInfo` with `kind: 'openai'` (the API spoken) and
  `service: { preset, baseUrl, host, loopback, json }`; never the key, only its last 4 characters.
- `listAiProviders` lists the providers, then the services; together at most 20
  (`AI_LIMITS.maxProviders`).
- `saveAiProvider` with `service` set goes to this store. Changing the base URL to another origin
  needs the key again ("Enter the API key for the new address."), as changing the kind does today
  (`keyStore.ts:184`).
- An empty key is allowed only for a loopback origin.
- Older Flown never reads this file, so it cannot drop entries or send a service's key elsewhere
  (decision 19).

### 10.2 Base URL rules (`readBaseUrl`, `src/shared/ai/baseUrl.ts`)

Parsed with the WHATWG URL parser, then:

1. `https:`; or `http:` only when the host is `localhost`, an address in `127.0.0.0/8`, or `[::1]`
   (§0 decision 6). Else: "Use an https:// address. Plain http:// is only for a service on this PC."
2. No user name or password, query or fragment ("Remove the part after ?", "Remove the name and
   password from the address.").
3. At most 300 characters; the path kept (`/openai/v1`, `/api/v1`); a trailing slash removed.
4. The host shown and stored is the ASCII form (`url.hostname`, so an internationalised name shows
   its `xn--` form): "Your key and the text you send go to **xn--…**".
5. Azure: the resource name matches `^[a-z0-9][a-z0-9-]{1,62}$` and gives
   `https://<name>.openai.azure.com/openai/v1`.

### 10.3 Talking to a service (`src/main/ai/compatible.ts`)

- The OpenAI SDK (already bundled) with `baseURL` = the stored base URL, `logLevel: 'off'`, its own
  retries off, and a `fetch` that sets `redirect: 'error'` and checks before every request that the
  URL's origin equals the stored `origin`. Retries go through `callWithRetry`
  (`src/main/ai/request.ts:56`).
- **Text tasks** use Chat Completions (`/chat/completions`), which every listed service offers; the
  Responses API that the OpenAI provider uses (`openai.ts:105`) is not assumed.
- **JSON mode**, found by *Save and check* and kept in `json`:
  1. `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }` →
     `'schema'` ("Works.");
  2. on a 400 or 422: `response_format: { type: 'json_object' }` with the schema described in the
     system text → `'object'` ("Works; Flown checks its answers more closely.");
  3. else no `response_format`, the schema in the system text, and the answer read from its first
     `{` to its matching `}` → `'text'` (the same words).
  The check sends only a fixed tiny request (`{"ok": true}`) and the key, never project text. A real
  request that later fails with a 400 naming `response_format` drops one level, retries once, and
  saves the new level.
- **Every answer** still goes through the task's validator: a service cannot add anything the
  schema and checks do not allow.
- **Failure messages** carry a service's own words for a 400 or 422 (`describeFailure`,
  `src/shared/captions/transcriptErrors.ts:64-69`). Before any `AiError` leaves main, `compatible.ts`
  and `callWithRetry` (for every provider) replace each value of `secretValues()` (§16.5) in its
  message with `<secret>`, so a gateway that echoes the request's key cannot put it in the renderer.
- OpenRouter with `keepNoData` sends `provider: { data_collection: 'deny' }`.
- **Usage**: `usage.prompt_tokens` and `usage.completion_tokens` are read when present (§11.6).
- **Transcription** through a service is not offered in this wave (`canTranscribe: false`; §23).

### 10.4 Model lists (`ai:listModels`, `src/main/ai/modelLists.ts`)

For a saved provider (`{ providerId }`) or a form not saved yet (`{ draft }`), main asks the provider:

| Kind | Call | Kept |
|---|---|---|
| OpenAI | `GET /models` | ids; text models for the model field, ids with `whisper` or `transcribe` for the transcription field; `tts`, `dall-e`, `gpt-image`, `embedding` and `moderation` ids left out |
| Gemini | `models.list` | models whose `supportedGenerationMethods` has `generateContent`, without `models/` |
| Claude | `models.list` | ids |
| Service | `GET <base>/models` | ids; from OpenRouter also `pricing.prompt` and `pricing.completion` (US$ per token, as text) and whether `supported_parameters` lists `structured_outputs` |

**Which key a draft uses.** A draft is checked with `readBaseUrl` first. It uses `draft.apiKey` when
one is given. Without one, it uses the stored key of the entry `draft.id` names only when the draft's
origin and kind equal that entry's; otherwise it refuses with "Enter the API key for the new
address." and sends nothing. So an edited address, typed wrong or sent by a compromised page, never
receives the stored key.

**OpenRouter's prices.** Its live list (checked on 7 November 2026: 460 models) prices 8 router
models (`openrouter/auto`, `openrouter/auto-code`, `openrouter/fusion`, `nvidia/switchyard` and
others) as `"-1"`, and 16 free models as `"0"`. A price is read only as a finite number of 0 or more;
`"-1"`, a missing value or anything not numeric is **unknown** (the combobox says "price varies"; the
cost line says "Cost unknown for openrouter/auto: it picks a model for each request"); `"0"` for both
is free ("No cost").

Limits: 20 s, 4 MB, 2,000 ids, each id `MODEL_RE` and at most 100 characters; redirects refused.
The list lives for the session (not stored). It sends the key only, never project text.

### 10.5 Presets (`SERVICE_PRESETS`, `src/shared/ai/presets.ts`)

| Preset | Base URL | Key | Notes |
|---|---|---|---|
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/v1` | needed | The model is the deployment's name. |
| OpenRouter | `https://openrouter.ai/api/v1` | needed | 460 models listed publicly; prices with the list. |
| Groq | `https://api.groq.com/openai/v1` | needed | A strict schema only on some models; the check finds out. |
| Together AI | `https://api.together.xyz/v1` | needed | — |
| Ollama on this PC | `http://localhost:11434/v1` | none | No cost. |
| LM Studio on this PC | `http://localhost:1234/v1` | none | No cost. |
| Other address | typed | needed, or none for this PC | — |

A preset only fills fields; every service is checked the same way. A preset's *No cost* and its price
entries apply only while the stored host equals the preset's own (`localhost:11434`,
`localhost:1234`, `api.groq.com`, `api.together.xyz`, `openrouter.ai`); a preset whose address was
edited to another host is priced as *Other address*.

### 10.6 What project data says

Results from a service are written as OpenAI's (decision 20) with its host: `CaptionTrack.by:
'openai'` and `host` ("translated with api.groq.com"); `AutoOrigin.via: 'openai'` and `host` (Review's
detail "Groq" when the host is a known preset's, else the host); `ChapterOrigin.via` and `host`.
The write sites are `withTranslation` and the track label (`trackRows`, which today says
`PROVIDER_NAMES[t.by]`) in `src/shared/captions/captionTracks.ts`, and the AI picks of *Make my
captions great* in `src/renderer/src/editor/greatRun.ts`; the contracts step adds the host there
(§20.0). Results made on this PC: a translation is `by: 'local'` with `model: 'gemma4-e2b'` and so on
("translated on this PC"; Mozilla's offline models have their own model names, so the two never
mix); found chapters named on this PC have `via: 'local'`; the other tasks write no provenance.

---

## 11. The cost up front

### 11.1 What is estimated (`estimateText`, `src/shared/ai/cost.ts`)

The exact text of every request the action would send: `textPrompts(request, limits)` (§20.0) lists
the prompts `runTextTask` would build, batches included (system text, user text, the schema's JSON,
and the pictures of §5.3.1). Characters are counted exactly; tokens are estimated from them. Nothing
is sent to count tokens (decision 21). Results are memoised per request object, so the line updates as
the user edits without delay.

### 11.2 Characters per token (`TOKEN_RATIOS`, `src/shared/ai/tokens.ts`)

The text is split by script (the `ScriptTag`s of `src/shared/captions/words.ts`) and each run divided by its ratio
(measured with OpenAI's o200k tokenizer; Qwen's and Gemma's for this PC):

| Script | OpenAI, Gemini, services | Claude | Qwen3.5 | Gemma 4 |
|---|---|---|---|---|
| Latin (English prose 4.83, tutorials with URLs and file names 3.58) | 4.0 | 3.1 | 4.8 | 4.84 |
| Cyrillic | 3.5 | 2.7 | — | — |
| Arabic, Hebrew | 3.17 | 2.4 | — | — |
| Devanagari, Tamil | 3.2 | 2.5 | — | — |
| Bengali | 2.6 | 2.0 | 2.04 | 3.45 |
| Thai | 3.08 | 2.4 | — | — |
| Hangul | 2.44 | 1.9 | — | — |
| Han, Kana | 2.13 | 1.6 | — | — |

- Claude's column is the o200k ratio ÷ 1.3 (Anthropic's newer tokenizer counts about 30% more).
  Gemini says "about 4 characters" a token. A dash: the o200k value is used.
- The range shown is ±25% (±40% for services, whose tokenizer is unknown; ±60% for pictures).
- Digits, punctuation and JSON structure count as Latin.

### 11.3 What comes back (output tokens by task)

| Task | Low – high |
|---|---|
| Clean-up | input caption tokens × 1.0 – × 1.15, + 12 a caption |
| Translate | input caption tokens × (source ratio ÷ target ratio) × 0.9 – × 1.2, + 12 a caption |
| Chapters | 25 – 25 × `maxChapters(end)` |
| Title | 15 – 40 |
| Summary | 80 – 300 |
| Names | 8 – 25 an item (notes 30 – 90) |
| Marks | 5 – 20 a caption |
| YouTube, LinkedIn, X, article, release notes (Normal; Short halves) | 450–900, 250–500, 60–90, 900–2,000, 400–1,000 |
| Script draft | notes tokens × 1.0 – × 2.0 |
| Thinking (models that think; effort low / medium) | the high end gains 500 / 2,000 a request |

Transcription: minutes × the price per minute (`whisper-1` US$0.006, `gpt-transcribe` US$0.0045); for
Gemini, 32 input tokens a second of sound plus the words written (§11.2).

### 11.4 Prices (`src/shared/ai/prices.ts`, `resources/ai-prices.json`)

```json
{
  "version": 1,
  "updated": "2026-11-07",
  "currency": "USD",
  "models": [
    { "service": "openai", "model": "gpt-6.1-sol", "input": 2.0, "output": 10.0 },
    { "service": "openai", "model": "whisper-1", "perMinute": 0.006 },
    { "service": "gemini", "model": "gemini-3.8-flash", "input": 0.75, "output": 3.75 },
    { "service": "anthropic", "model": "claude-opus-5-5", "input": 4.0, "output": 20.0 },
    { "service": "groq", "model": "openai/gpt-oss-20b", "input": 0.075, "output": 0.3 }
  ]
}
```

- US$ per million tokens (`input`, `output`), or per minute of sound; optionally `imageTokens` for a
  model's own picture rule. `service` is a kind or a preset. A model matches exactly, or the longest
  entry marked `"prefix": true`. Prices above US$1,000 or below 0 are refused; at most 2,000 entries.
- **Bundled** in the app, and **refreshed** from `PRICE_LIST_URL`,
  `https://raw.githubusercontent.com/samiulakhan12/windows-screen-studio/HEAD/resources/ai-prices.json`,
  at most daily, only while automatic updates are on, with `redirect: 'error'` and a 256 KB cap
  (`src/main/ai/priceList.ts`, as `refreshModelList` does, `src/main/ai/modelList.ts:93`). A list that
  does not parse is ignored as a whole. **Test hook**: `SSW_PRICE_LIST_URL`, read only when
  `!app.isPackaged`.
- **A downloaded list is untrusted.** Its `updated` must not be later than today + 1 day (a list
  dated 2099 would otherwise override every later bundled list); of the bundled and downloaded lists
  the newer `updated` is shown, but the high end of an estimate and the confirm use, per model, the
  **higher** of the two prices; a downloaded price of 0 is ignored where the bundled list has one. A
  bad push can raise an estimate, never lower a confirm.
- **Kept up to date by hand** from each provider's price page before each release and when a provider
  changes prices, checked against LiteLLM's price file (MIT) for differences (a script,
  `scripts/check-ai-prices.mjs`, that prints them; LiteLLM is credited in the notices).
- **OpenRouter**: the prices its model list gives (§10.4) win over the file for that session, when
  they are known; unknown stays unknown.
- **The user's own prices** (pref `aiPrices`, Settings › the provider's *Prices*) win over everything.
- Shown with their date: "prices of 7 November 2026".

### 11.5 The line, the confirm and the time on this PC (`CostLine`, `src/renderer/src/ai/CostLine.tsx`)

`CostLine` takes the choice and the group's actions (`{ key, label, buttonId, request }[]`) and renders
one line. Its parts:

| Case | Text of the action's part |
|---|---|
| A known price, high < US$0.01 | "under US$0.01" |
| high < 2 × low | "about US$0.03" |
| else | "US$0.02 to US$0.05" |
| No price known | "cost unknown" (the line adds why: "add its prices in Settings", or for a router model "it picks a model for each request") |
| A free model, or Ollama or LM Studio on this PC | "no cost" (any other address, loopback or not, is priced: it may be a proxy to a paid service) |
| On this PC | "about 4 minutes" (from §9.8's speeds; "about 40 seconds" under a minute) |

- **The line**: what is sent and where, once ("Sends about 8,200 words of captions to OpenAI"), then
  each action's part with its label ("Chapters about US$0.02 · Title under US$0.01"). An action alone
  (Translate, Write titles, Tidy notes, Find chapters with AI names, clip names, Draft script) uses
  the full form with the model and date ("· About US$0.03 (gpt-6.1-sol, prices of 7 November 2026)").
  An unknown price on a paid service never reads "under US$0.01".
- **Details** (a disclosure button after a group's line): the model, the date of the prices, and each
  action's input and output token ranges.
- **Each button** has `aria-describedby` pointing at a visually hidden sentence of its own:
  "About US$0.02; sends your captions to OpenAI." / "About 4 minutes; stays on this PC."
- What is sent is named: "words of captions", "words of notes", "chapter names and what is said in
  them", "the steps' narration", "screenshots"; the count is words (by `Intl.Segmenter`), the place
  the TextChoice's place name (§20.0: `serviceName()` for a service, "this PC" for On this PC).
- **Confirm** (`confirmCost`, `src/renderer/src/ai/costConfirm.ts`): when the high end passes the
  amount of pref `aiConfirm` (US$1.00 by default; *Always ask*: every paid run; *Never*: none): "This
  costs up to about US$1.40 with claude-opus-5-5. Run it?" (alert dialog; **Run**, **Cancel**; Cancel
  focused). An unknown cost on a paid service asks once per (provider, model) in a session, unless
  *Never*. On this PC, over 10 minutes: "This takes about 25 minutes on this PC. You can keep editing
  meanwhile. Start?".
- Where the line appears (each tied to its buttons by `aria-describedby`):

| Place | Group or action |
|---|---|
| Captions tab | Generate captions (with a provider) alone; Fix captions, Suggest chapters, Suggest a title, Summarize as one group |
| Captions › Clean up | Fix spelling with AI |
| Captions › Languages | Translate |
| Captions › Make my captions great | with AI picks |
| Publish dialog | each card's Write and Regenerate as one group, with Write all (the sum) |
| Notes › Draft script | Draft script |
| Polish dialog | the Captions step with a provider |
| Text › Chapters | Find chapters with AI names |
| Guide panel | Write titles (with or without screenshots); Tidy notes |
| Short clips panel | names with AI |

### 11.6 After a run

- Main adds `usage` (input and output tokens summed over the action's requests, when the provider
  reported them) to the result. The notice adds "Cost about US$0.03 (12,400 tokens)."
- `userData/ai-usage.json` keeps, per (kind or host, model, task), the ratio of reported to estimated
  tokens for input and output, blended (0.7 × old + 0.3 × new) and clamped to 0.5..2.0; later
  estimates are multiplied by it. It holds no text. At most 200 entries, the oldest dropped.

---

## 12. Privacy

What a recording holds that could be private, and where each new feature lets it go:

| Private thing | Recorded? | Guides and demos | Chapter names | Clips | AI services | AI on this PC |
|---|---|---|---|---|---|---|
| Typed text | The keys are never recorded (`keystrokes.ts:1-6`), but the text shows on screen | A typing step's own shot is taken before its typing. Later shots of the same screen can show the text: they are marked *May show what you typed*, checked first, counted before saving, and offer *Blur the typed text* (§5.5.7, §5.5.8). *What to type* is only what the user writes | — | The copy shows what the video shows | Pictures only with §5.3.1, after the user saw each one; marked steps start unticked | — |
| Window titles, program names | Not recorded (§0 decision 4), but on screen | Not used as text; on screen in shots, which the user checks at full size | Not used | — | As above | — |
| What is on screen | In the video | Every shot can be viewed at 100% and *Check screenshots* walks through them, whole-screen shots before the rest; blur and pixelate shapes always applied (§5.5.2); **Blur an area…** | Not read (no OCR) | The copy shows what the video shows | Only §5.3.1's pictures, after the user saw each one | — |
| File paths, emails, links said aloud | In the transcript | Shown in the notes; the link check and the path rule mark them and saving asks first | Refused as names, whoever wrote them (§7.5, §7.6) | In titles: refused the same way | Sent only as part of the text the line names, after the click | Stays on the PC |
| Shortcut labels | Recorded | "Press Ctrl + S" | — | — | Sent as the step's action ("press Ctrl + S") with Write titles | — |
| The narration | In the transcript | Notes, titles; shown before saving | Names from it | Titles from it | Only with a click whose cost line names what goes and where | Stays on the PC |

Rules that hold everywhere:

1. Nothing is sent by default (§0 decision 5). Every AI action names, before the click, what it sends
   and to which provider or host (§11.5).
2. Every guide, demo and chapter name the user shares has been on screen in Flown first: the Guide
   panel lists every step's title, note and shot, and every shot can be viewed at full size; found
   chapters are Review rows with their names in the chapter list. The first Save or Copy with shots
   not yet checked at full size says how many, how many may show typing and how many show the whole
   screen (§2.1.2).
3. The link check (`notedPieces`, `src/shared/publish/check.ts:524`) and the path rule (`pathLike`,
   §7.5) run on step titles, notes, *What to type* and the guide's title before saving or copying:
   what they find is marked, and saving asks "This guide has a link, address or file name nobody said.
   Save anyway?" (**Save anyway**, **Go back**; Go back focused).
4. Found chapters count as said nowhere, switch on nothing and renumber nothing until kept (§7.7).
5. AI answers are checked by validators and `privateLike`; an AI title, note or name holding anything
   link-like or path-like is dropped, whether or not it was said.
6. Exported HTML loads nothing from the network (its CSP), so opening a guide or demo tells nobody.
   The demo's one optional end-screen link loads nothing until followed.
7. Keys and base URLs stay in main; logs carry a service's origin only, never a key, a path or a
   query; error messages are scrubbed of key values before they reach the renderer (§16).

---

## 13. Review mode, settling and Polish

### 13.1 Rows (`src/shared/review/smartReview.ts`)

An aggregator hooked into `review.ts` the way phase B's `captionReview.ts` and wave 10's
`editingReview.ts` are, after them at equal times: `smartReviewItems`, `smartPendingCount`,
`smartItemStatus`, `keepSmartItems`, `removeSmartItems`, `isSmartKind`. It delegates to P2's
`chapterReview.ts`. The shorter version's cuts are `AutoCut` records and ride the existing cut rows,
with their own kind; its smooth cuts ride wave 10's `join` row.

| Key | Kind (chip) | Title | Detail | Keep | Remove |
|---|---|---|---|---|---|
| `chapter:<id>` | `chapter` (*Chapter*) | "Chapter “Set up billing” at 1:05" (video time) | "Find chapters · screen change and pause" / "Polish · …" / "Suggest chapters with OpenAI · …"; with AI names "· named on this PC" or "· named by OpenAI" (or the host); with auto badges "· keeping it restarts step numbers here" | drops `auto` | deletes the chapter, and the pending chapter-title card made from it (`TitleCard.auto.chapter`), in the same edit |
| `cut:<id>` with `by: 'short'` | `short` (*Short*) | "Cut 4.2 s for the shorter version" | "Make a shorter version" | as other cuts (`keepItems`) | as other cuts: the stretch comes back (`takeBackSteps`) |
| `join:all` with `joins.auto.by: 'short'` | `join` (wave 10's *Cuts*) | "Smooth cuts at 14 cuts" | "Make a shorter version" | as wave 10's | as wave 10's |

- Status of a chapter row: pending while the chapter has `auto`; removed when it is gone; kept
  otherwise (the user's).
- `KIND_WORDS` (`copy.ts`): `chapter: { chip: 'Chapter', name: 'found chapter', all: 'Remove all
  found chapters', one: 'found chapter', plural: 'found chapters' }`; `short: { chip: 'Short', name:
  'shorter-version cut', all: 'Remove all shorter-version cuts', one: 'shorter-version cut', plural:
  'shorter-version cuts' }`. `REVIEW_KINDS` appends `'chapter'` and `'short'`. `cutKind` gives
  `'short'` for `by: 'short'`; `CUT_DETAILS.short` is "Make a shorter version". Wave 10's join row
  takes its detail from `joins.auto.by` ("Polish" or "Make a shorter version").
- Each Keep and Remove is one store update, so one undo step; *Keep all* and *Remove all* include
  them.

### 13.2 Settling

The chain at `Editor.tsx:207` (with wave 10's `settleJoins` and `settleGrade`) gains `settleChapters`
(§7.7). It returns `next` itself for projects without found chapters.

### 13.3 Polish (`src/shared/editor/polish.ts`)

- `PolishStep` gains `'chapters'`, in `POLISH_STEPS` after `'captions'` and before `'captionLook'`
  (after wave 10's `'smoothCuts'`): the transcript and the cuts are final when it runs.
- `PolishOptions.chapters: boolean`; `DEFAULT_POLISH_OPTIONS.chapters = true` (§0 decision 8);
  `readPolishOptions` reads a missing value as `false`.
- `PolishSkip` gains `'has-chapters'` ("Your chapters are kept": the project has user chapters;
  pending found chapters do not count and are replaced, as *Find chapters* replaces them),
  `'short-video'` ("Under 2 minutes: no chapters needed") and `'no-speech'` ("No captions to name
  chapters from"): without transcript words, or when every name would be a number, the step adds
  nothing, so Polish never writes "Intro, Part 2, Part 3" into exported files.
- The step runs `planChapters` with *Normal*, every signal, offline names, `by: 'polish'`, inside
  Polish's one update. `polishRunner.ts` fetches the scene scan with the other analyses. `STEP_LABEL.
  chapters` "Find chapters"; summary line "Found 6 chapters".
- **The guards of decision 8**: the found chapters are pending, so the *Caption look* step after it
  resolves *Auto* chapter titles without them (§7.7) and makes no chapter-title cards from them, and
  wave 10's badges keep their numbers. Polishing a polished project again changes nothing: the step
  keeps re-found chapters as they are (§7.7), and with user chapters it skips.

### 13.4 What Review does not list, and why

- **Guide steps, titles and notes**: they change no frame of the video; the Guide panel shows every
  one before anything is saved, and AI titles and notes carry an "AI" chip until edited. The blurs
  made from the panel are the user's own shapes.
- **Clip copies**: each moment is listed for review before a copy is made; the original never
  changes. Inside a copy, only the pending changes within its range stay listed (§8.5).
- **Local AI results** go through the same flows as a provider's (Clean up's AI fix makes Captions
  Studio's text records, which phase B lists).

---

## 14. Accessibility

Every control is a native element or has the matching ARIA role, a visible label, and a value text
where it is a slider or a progress bar. New CSS uses the tokens of `src/renderer/src/styles.css` and
joins `tests/labelContrast.test.ts`.

| Control | Role and name | Keys | Announcement |
|---|---|---|---|
| Guide button | button "Guide" | Enter, Space | — |
| Guide panel | `aside`, `role="region"`, named by its heading ("Step-by-step guide") | Tab moves through it and on to the editor; Esc closes it and returns focus to the Guide button | — |
| Kind, Language, Steps from, Format | `radiogroup`s; Page size a `select` | arrows | — |
| Step list | `list` "Steps"; each row a `group` "Step 3, 1:05" | Tab through the row's controls | — |
| Include | checkbox "Include step 3" | Space | — |
| Go to 1:05 | button | Enter | — |
| Chips | text inside the row's name: "Step 3, 1:05, needs a title, may show what you typed in step 2" | — | — |
| Step title, What to type, note | text field "Title of step 3", text field "What to type in step 4 (optional)", text area "What to know about step 3"; the link note tied by `aria-describedby` | — | — |
| Whole screen, Zoom to the click in the demo, Show the screen after typing | toggle buttons, `aria-pressed` | Space | — |
| Screenshot | button "View screenshot for step 3 full size" holding the `img` (alt "Screenshot for step 3"), or `aria-busy` while made | Enter, Space | — |
| Next step without a title, Check screenshots | buttons | Enter | live: "Step 7 needs a title" when focus moves |
| Full-size viewer | `dialog` "Screenshot for step 3 of 30", modal (`useModalFocus`); the image area a focusable `group` "Screenshot, 100%" | arrows, Page Up, Page Down, Home, End pan; Esc closes and returns focus to the row's screenshot button | live: "Checked 12 of 30" in *Check screenshots* |
| Adjust | the crop and the ring as two focusable buttons whose names hold their place: "Crop, 45% wide, from 20% across and 10% down", "Ring at 42% across, 30% down"; Done and Reset buttons | Tab between them; arrows move by 1% (Shift 10%); Alt + arrows resize the crop; Enter is Done | live: the new place after each move |
| Screenshots progress | `progressbar` "Making screenshots", value text "12 of 30" | — | live (polite) at the end: "Screenshots ready" |
| Save, Copy guide, Copy screenshot | buttons | Enter | live: "Saved “Billing guide.pdf”." with Show in folder; "Copied the guide with 12 screenshots." |
| Find chapters | button; Options a disclosure button `aria-expanded` | Enter, Space | live: the notice text |
| How many, Names | `radiogroup`s | arrows | — |
| Split at | checkboxes | Space | — |
| Found chip, Rename? | text inside the row's name: "Chapter at 1:05, found, not reviewed, rename?" | — | — |
| Short clips panel | `aside`, `role="region"` "Short clips"; moments a `list` "Moments"; row `group` "Clip 2, 0:42 to 1:27, 45 seconds" | Tab; Esc stops playing, then closes | — |
| Make clip | checkbox "Make clip 2" | Space | — |
| Play | toggle button "Play clip 2" | Space; Esc stops while focus is in the panel | live: "Playing clip 2" / "Stopped" |
| Make 3 copies | button; disabled with the reason tied by `aria-describedby` | Enter | live: "Making copy 2 of 3" every copy; "Made 3 copies" |
| Model rows | per row: text, Download button "Download Recommended, 3.1 gigabytes", `progressbar` "Downloading Recommended" with value text "1.2 of 3.1 gigabytes" | Enter | live at the end: "Recommended is ready" |
| Use | `radiogroup` "Model for AI on this PC" | arrows | — |
| Local progress (beside every busy text tool) | `progressbar` "AI on this PC" with value text "Reading, 45 percent" / "Writing, about 2 minutes left"; Stop a button | Enter | live (polite) at phase changes only |
| Model field | `combobox` (ARIA 1.2, `aria-autocomplete="list"`) with a `listbox` popup | Down opens, arrows move, Enter picks, Esc closes; free text allowed | live: "Loaded 47 models" |
| Load models | button | Enter | — |
| Cost line | text; each button's `aria-describedby` names its own short sentence; Details a disclosure button | Enter | read with the button |
| Confirm | `alertdialog` | Enter on the focused button (Cancel) | — |

Never colour alone: "Found", "AI", "Short", "Needs a title" and "May show what you typed" are words;
the ring in a shot has a white halo and is described in the alt text. The demo file meets the same
rules on its own (§6.1): 44 px targets, visible focus (3 px outline, 4 px offset), a live region, no
single-letter keys, reduced motion, 4.5:1 text in both colour schemes and with the brand colour, the
callout's text reachable by Tab and read after the step's announcement.

---

## 15. Bangla and other scripts

- **The guide's own words** (`GUIDE_WORDS`, `src/shared/guide/guideWords.ts`) in English and Bangla:

| English | বাংলা |
|---|---|
| Click “{x}” | “{x}”-এ ক্লিক করুন |
| Double-click “{x}” | “{x}”-এ ডাবল-ক্লিক করুন |
| Right-click “{x}” | “{x}”-এ রাইট-ক্লিক করুন |
| Click near the {place} | {place} ক্লিক করুন |
| Click in the text field near the {place} | {place} লেখার ঘরে ক্লিক করুন |
| Click the link or button near the {place} | {place} লিংক বা বোতামে ক্লিক করুন |
| Click on the taskbar, on the {side} | টাস্কবারে {side} ক্লিক করুন |
| Drag from the {a} to the {b} | {a} থেকে {b} পর্যন্ত টেনে আনুন |
| Type your text | আপনার লেখা টাইপ করুন |
| Type: {text} | টাইপ করুন: {text} |
| … and type | … এবং টাইপ করুন |
| … and press {key} | … এবং {key} চাপুন |
| Press {keys} | {keys} চাপুন |
| … {n} times | … {n} বার |
| Scroll down, then … | নিচে স্ক্রোল করে … |
| Step {n} | ধাপ {n} |
| Back · Next · More · Start again · Step {n} of {m} | আগের ধাপ · পরের ধাপ · আরও · আবার শুরু · ধাপ {n} / {m} |
| Steps to reproduce · Expected · Actual · Details | সমস্যাটি ঘটানোর ধাপ · যা হওয়ার কথা · যা হচ্ছে · বিস্তারিত |
| Recorded on {date} · Screen {w} × {h} at {scale} · Length {time} | রেকর্ড করা হয়েছে {date} · স্ক্রিন {w} × {h}, {scale} · দৈর্ঘ্য {time} |
| Part {n} · Intro | অংশ {n} · শুরু |

  Places: top left উপরে বাঁদিকে, top উপরে, top right উপরে ডানদিকে, left বাঁদিকে, middle মাঝখানে, right
  ডানদিকে, bottom left নিচে বাঁদিকে, bottom নিচে, bottom right নিচে ডানদিকে. A native speaker checks every
  one before release (§0 decision 9). Other languages use the English words with their own narration
  until the app is translated (X-05, wave 12).
- **Digits**: step numbers ("৩", "৩.১"), chapter numbers ("অংশ ৩") and page numbers follow the
  captions' `digits` choice (`withDigits`, `src/shared/captions/words.ts:259`): Bangla digits by
  default for Bangla.
- **Graphemes**: every length rule (40 for objects and cut names, 100 for chapter names, 80 for AI
  titles, 300 for notes) counts graphemes with `Intl.Segmenter`, and every cut lands between
  clusters: a conjunct or a vowel sign stays with its letter (test 39). Words for tf-idf, phrases,
  TextTiling and the sentence rules come from `studioWordTexts`, which splits Thai, Chinese and
  Japanese without spaces.
- **Cue words and lead-ins** in Bangla (§7.3, §7.5), with Bangla's own clause cuts ("যাতে", "তারপর",
  "কারণ"); questions ending in "?" or "।?" and starting with কীভাবে, কেন, কী (§8.2).
- **PDF**: the static Hind Siliguri (bundled; Latin and Bengali) and Windows' static fonts for the
  other scripts (§5.6). Never the bundled variable Noto fonts (measured: Type 3, broken copy-out);
  shipping static instances of them would grow the installer and is left out (§23).
- **HTML, demo and *Copy guide***: `lang` on the page and `dir="auto"` on every title, note and
  callout, so Arabic and Hebrew read right to left inside an English guide; Hind Siliguri embedded
  when there is Bangla text (not in *Copy guide*, whose target app picks its own font). The demo's
  callout flips sides by the hotspot's place, not the text's direction.
- **Markdown**: UTF-8; file and folder names keep Bangla letters (Windows allows them), with only the
  characters Windows refuses replaced (`safeName`, `exportBundle.ts`).
- **Local models**: the Recommended model, Gemma 4 E2B, reads Bangla with 1.7 times fewer tokens than
  Qwen (3.45 against 2.04 characters a token), so it is faster and has more room; token budgets use
  each script's ratio (§9.6, §11.2).
- **Cost estimates** count each script with its own ratio; Bangla costs about 1.5 to 2 times English
  per character.

---

## 16. Security

1. **Keys stay in main.** Services' keys are encrypted with `safeStorage` (a weak Linux keyring is
   refused, `aiIpc.ts:22-29`), never sent to the renderer (only the last 4 characters), and each is
   bound to the origin it was entered for: every request checks the URL's origin against it, a new
   origin needs the key again (§10.1), and a model list for a draft with an edited address never uses
   the stored key (§10.4).
2. **Base URLs** follow §10.2: https, or http only on this PC; no credentials, query or fragment;
   ASCII host shown.
3. **No redirects** on any service request, model list, price list or download of a list
   (`redirect: 'error'`). Measured on Node 22: a cross-origin redirect drops `Authorization` but
   forwards a custom `api-key` header.
4. **TLS**: in a packaged app, main deletes `NODE_TLS_REJECT_UNAUTHORIZED` from its environment at
   start (`src/main/ai/tlsGuard.ts`, imported first by `src/main/index.ts`), as `endpoints.ts`
   ignores base-URL variables there (measured: `=0` silently turns off certificate checks for fetch).
   Flown never offers "ignore certificate errors".
5. **Logs and errors**: a service is logged by its origin only. `redactLine` (`redact.ts:56`) keeps
   its signature and gains a fourth parameter: `redactLine(line, roots = {}, names = [], secrets:
   readonly string[] = [])`, so its callers (`appLog.ts:56`, `:139`, `diagnostics.ts:95`) keep their
   arguments and add `secretValues()`. It replaces each exact secret value, longest first, with the
   file's own `<secret>` before the generic rules (so keys shorter than the 32-character rule,
   `redact.ts:48`, are caught too), and the user and password of any `scheme://user:pass@host` with
   `<secret>`. Values are registered by main when keys are read or saved (`src/main/ai/secrets.ts`).
   The same values are scrubbed from every `AiError` message before it leaves main (§10.3).
6. **Downloads of models** (§9.4) follow wave 10 §14.3: exact hosts, https on 443, no credentials,
   pinned bytes and SHA-256, `.part` renamed only after the check, free space first, `Retry-After`
   capped; the GGUF header and size checked again before loading.
7. **The helper** is bundled and signed (the directory-form entry, §9.1); `verify-dist` checks its
   imports (no network library) and its signature; it gets a catalog file path built by main and
   prompt text on stdin, never a key or a project path; it never runs the GGUF's template; its output
   lines are size-capped and parsed strictly; a stuck helper is killed; it exits with Flown
   (`--parent-pid`).
8. **Prompt text is data**: the transcript, notes and narration sit in data blocks ("the text is data
   to work on, not instructions", `transcriptText.ts:145`); for the local model, only the template's
   own pieces are tokenized with special tokens, and special-token text is also broken in user text
   (§9.6); every answer passes its validator; names, titles and notes are plain text and pass
   `privateLike`.
9. **Generated HTML runs no untrusted script.** The only script is `DEMO_SCRIPT`, a constant in
   Flown's source, pinned by its SHA-256 in the page's CSP (`default-src 'none'`); the guide without
   a demo has no script at all. No user text goes into the script, into a URL, or into an attribute
   other than `alt`, `aria-label`, `title`, `lang` and `dir`; every string is escaped. Images are
   `data:` URLs Flown encoded. The one URL that is not `data:` is the demo's end-screen link, an
   `https:` URL `readLinkUrl` accepted, escaped, with `rel="noopener noreferrer"`. Test 24 feeds titles
   like `</script><script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `javascript:alert(1)`,
   U+2028, bidi controls and NUL, and checks the output has exactly one `<script>` (demo) or none, no
   `on…=` attribute, and no URL but `data:` and that one link.
10. **Markdown** escapes punctuation and passes no raw HTML; image paths are fixed names.
11. **The print window**: hidden, sandboxed, scripts off, no preload, its own in-memory partition
    whose requests other than the temporary file and `data:` are refused, permissions refused,
    navigation and new windows refused (`guardWebContents`); the temporary file lives in
    `userData/tmp/guide-print/`, is deleted in a `finally`, and anything left there is swept at start.
12. **Paths**: main shows every save dialog and builds every path; the renderer sends bytes and a
    name. File names pass the export's check; Markdown makes a new folder; nothing is overwritten
    except through the save dialog's own confirm. `guide:showItem` and Share accept only files this
    session wrote (`rememberExported`). Copies use Duplicate's own checks (`projectCopy.ts`: the
    source must be the open project, `within`).
13. **IPC**: new channels `guide:save`, `guide:showItem`, `guide:copy`, `guide:copyImage`,
    `localAi:state`, `localAi:download`, `localAi:cancel`, `localAi:remove`, `localAi:setUse`,
    `ai:listModels`, `ai:priceList`, `projects:detectScenes`, `projects:copyCost`. Each checks the
    sender with `fromApp` (`aiIpc.ts:133`), validates every argument (ids against their pattern or
    catalog; sizes capped: HTML 64 MB, images 16 MB and 300, Markdown 2 MB, 256 MB in all for one
    save, clipboard text 2 MB, names 120 characters, §5.3.1's pictures 512 KB, 50 a request and 200 in
    all), checks the totals in the preload before sending, and returns no path it was not asked to
    show.
14. **Lists from GitHub** (prices) are untrusted: parsed field by field, capped, dated no later than
    tomorrow, and able only to raise an estimate's high end, never to lower a confirm (§11.4).
15. **Test hooks** (`SSW_LLM_HELPER`, `SSW_TEXT_MODEL_TEST_CATALOG`, `SSW_PRICE_LIST_URL`) are read
    only when `!app.isPackaged`, as every existing hook is, so an environment variable can never make
    a packaged Flown run another executable, load an unpinned file or read another price list
    (test 104).
16. **CSP and windows**: the renderer's CSP (`index.html:8`) and `src/main/security.ts` do not change.

---

## 17. Undo

One user action is one `store.update`:

- *Find chapters* (with AI names or AI splits), *Suggest chapters*, Polish (with its chapters step),
  each Keep and Remove in Review.
- Each guide edit: a title, a note or *What to type* (typing merges through the gesture keys
  `guide-title:<key>`, `guide-text:<key>`, `guide-type:<key>`, as chapter names do,
  `TextPanel.tsx:343`), Include, Whole screen, Zoom to the click in the demo, Show after typing, Use
  everything I said, *Adjust*'s Done and Reset, *Add a step at the playhead*, the guide's title,
  intro, kind, language, steps source, brand, end screen, Expected, Actual, the Actual screenshot,
  Details; *Write titles* (all titles at once); *Tidy notes* (all notes at once); *Use offline
  titles*.
- *Blur an area…* is one update (the shape, through `addShapeAt`); dragging it afterwards is the
  shape's own edits. *Blur the typed text* is one update.
- Saving or copying a guide or demo, and making clip copies and the shorter version, change nothing
  in the open project and have no undo; a copy is a new project, deleted from Home like any other.
- Downloads, model choices, provider, price and confirm settings are settings, not edits.
- Local AI results are applied by the same updates as a provider's.

---

## 18. Performance budget

Reference rig as wave 10's (Electron 44.9.3, 4-core Xeon, no GPU) for the renderer; the 4-vCPU
research machine for the local models. The pure parts' budgets are pinned by each part's performance
test (tests 30, 48, 61 and 100, with 6 times the margin on CI); the rest are measured on the
reference Windows PC after the build (§0 decision 9).

| Work | Budget | Measured / basis |
|---|---|---|
| `findSteps`, 10,000 clicks | 50 ms | linear passes |
| `typedBefore` flags, 200 steps | 5 ms | one pass over bursts and page changes |
| Shots: one decoder pass, draw, crop, encode | 120 ms a shot at 1080p; 50 steps under 10 s | the default frame draws in 8.8 ms (wave 10 §15); WebP and JPEG encodes are the rest |
| Full-size viewer | first paint under 100 ms (the shot is already in memory) | — |
| Shot memory | 300 shots or 256 MB | §5.5.6 |
| `printToPDF`, 50 steps | 5 s | 20 JPEG steps print in 27 ms; a cold start 705 ms |
| Demo file | under 5 MB for 50 whole-screen steps; warn at 10 MB | 1,280,230 bytes for 20 zoomed |
| Scene scan | 30 times real time or better: 1 h under 2 min, once per recording | 45 times measured (key frames); `fps=4` decoding to be measured on the reference PC |
| Chapter plan, 1 h | 200 ms (DP under 50 ms) | k ≤ 400, N ≤ 12 |
| Moments, 1 h, 600 sentences | 300 ms | ≤ 9,000 windows, prefix sums |
| Shorter-version plan | 100 ms | MMR over ≤ 600 sentences |
| A clip copy | under 1 s when linked; disk speed under OneDrive | Duplicate's |
| Cost estimate, 20,000 captions | 20 ms, memoised per request | character counts |
| Local model load | 1–2 s (Small), 8 s (Recommended) | measured |
| Local reading / writing | Recommended 395–462 / 7.4–12.5 tokens a second; Small 105–254 / 5.8–12.6 | measured; a laptop to be measured |
| Local memory | the catalog's peak + 10% (Recommended 4.2 GB, Small 2.5 GB) | measured peaks |
| Grammar sampling | at most 2 ms a token for the largest task grammar (test 66) | short caps only (§9.6) |
| Stop | under 0.6 s while reading (64-token batches at 120 tokens a second or more), under 0.1 s while writing; killed at 2 s | measured 44–77 ms while writing |
| Model list call | 20 s limit | — |

The editor stays responsive while a local model runs: the helper runs at below-normal priority with
one core left free, as the speech helper does.

---

## 19. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Old projects change through shared code (`readChapter`, `migrateProject`, `review.ts`, `versions.ts`, `runTextTask`, the prompts, `badgeLabels`, `resolveGreatOptions`). | Readers return `undefined` without their field; the aggregator returns nothing without `auto` chapters or `'short'` records; "user chapters" equal all chapters in an old project; `limits` defaults to today's numbers; the equivalence guard is written before the contracts and never regenerated (§22.2). |
| 2 | A screenshot shows something private. | Shots are drawn by the export path with every blur and pixelate shape (test 14); full-size viewing and *Check screenshots*; the save question counts unchecked, typing and whole-screen shots; *May show what you typed* marks and *Blur the typed text*; *Blur an area…* covers the shot's own frame (test 106). |
| 3 | A found chapter's name carries a link into the copy pack. | Names never hold link-like or path-like text, whoever wrote them (§7.5, §7.6); pending chapters never count as said (§7.7, test 44). |
| 4 | Chapters split a one-topic video at random pauses. | Each split costs `c`, so it needs strong or combined evidence; common cues score 1; topic depth is absolute; `N` is a ceiling (test 117); Review removes any. |
| 5 | Chapter names read badly. | Short first sentences up to 8 words or phrases actually said; never cut inside a word; weak names marked *Rename?* with focus on the first; an AI can name them; Review shows each. |
| 6 | Clip scores do not match what people find best. | Moments are listed with reasons and can be played before ticking; nothing is made automatically; *Focus on* steers them. |
| 7 | Clip copies fill a OneDrive disk. | The space line, the block when they would not fit, and Duplicate's own 64 MB spare check per copy. |
| 8 | The local helper does not build statically, `common` slips into the binary, or Stop is slow. | The one-day spike first (§9.1); the import and size checks; the patched-crate fallback; a C++ fallback at the same llama.cpp commit; 64-token batches; the AI-service route ships either way. |
| 9 | The local model runs a laptop out of memory. | Total and free memory gates (§9.5); *Automatic* falls back to Small; `mmap: false` (0.77 GB less); the helper exits when idle. |
| 10 | Local runs are slow. | Times shown before the click; confirm over 10 minutes; long jobs on the taskbar; progress and Stop beside every busy button; the label "good for drafts". |
| 11 | A local model writes broken JSON or nonsense. | The grammar (valid JSON 14 of 14 in the research); validators; one retry with more room; "Nothing was changed"; decision 9's evaluation and per-task notes. |
| 12 | Model hosts move or rate-limit. | Pinned by bytes and SHA-256, so any host serving the same bytes works; a Qbexel mirror first (§0 decision 2); `Retry-After` honoured. |
| 13 | A service's key leaks to another host or into the renderer. | Keys bound to their origin; no redirects; drafts never borrow a stored key for a new origin; https only off this PC; a separate file older versions never read; error messages scrubbed. |
| 14 | Services differ in what they support (strict schemas, chat API, pictures). | The check finds the JSON mode; fallbacks; the validators; a model that refuses pictures says so; transcription not offered through services yet. |
| 15 | Prices go stale or a bad list arrives. | Dated; refreshed daily; a downloaded list can only raise a high end; future dates refused; OpenRouter's live prices with unknown kept unknown; the user's own prices; usage calibrates the token estimates. |
| 16 | Generated HTML runs script or loads something. | One pinned script, a strict CSP, escaping everywhere, one checked link at most, fuzz test 24, and e2e step 8 counting network requests. |
| 17 | The PDF's Bangla breaks when copied, or a script has no font. | Static Hind Siliguri (measured exact) and Windows' static fonts; never variable fonts; checked on the reference PC (§0 decision 9). |
| 18 | Merge conflicts with wave 10 and phase B (`review.ts`, `copy.ts`, `polish.ts`, `PolishDialog.tsx`, `polishRunner.ts`, `versions.ts`, `Editor.tsx`, `commands.ts`, `exporter.ts`, `CaptionsPanel.tsx`, `SettingsDialog.tsx`, `aiIpc.ts`, `callouts.ts`, `great.ts`, `playheadItems.ts`, `joinReview.ts`). | The contracts step comes after both have merged; it completes every shared seam; every other file has one owner (§20.7); new UI lives in new files mounted with one line each. |
| 19 | The title bar runs out of room. | The Guide button's and the Copies button's labels hide with the others at narrow widths (`tb-label`); e2e step 19 checks the minimum window size. |
| 20 | The Bangla words of guides and chapter names are wrong. | A native speaker's check before release (§0 decision 9). |
| 21 | Steps drift after edits of the video. | Steps are keyed by their input event's time in milliseconds (§5.1); edits find their step again; a step whose time is cut leaves the list but keeps its edit. |
| 22 | Pictures sent for titles show something private. | Off by default each run; the user sees every picture that goes at full size first; marked steps start unticked; blur shapes applied; never on this PC; nothing sent on Cancel (test 141). |

---

## 20. Files, exported signatures and builder parts

### 20.0 Contracts step (first; frozen afterwards)

Made by the lead on the wave 11 branch after Captions Studio phase B and wave 10 (with their review
fixes) have merged, before any part starts. Changed later only with every part's agreement, recorded
here. The contracts close every seam two parts would share: each existing file below is completed
here, calls only functions that live in one part's new files (as stubs that return their input,
nothing, or a "not part of this build" error), and is not edited by any part afterwards. Code two
parts both call is written here in full, with its tests.

**Types and readers**

- `src/shared/types.ts`: §4.1 in full.
- `src/shared/engine/titleData.ts`: `export function readChapterOrigin(raw: unknown):
  ChapterOrigin | undefined`; `readChapter` keeps `auto`.
- `src/shared/guide/guideData.ts` (new, in full): `export const GUIDE_LIMITS = { title: 120, intro:
  2000, expected: 2000, actual: 2000, detail: 120, details: 8, stepTitle: 120, stepText: 1000,
  stepType: 200, endHeading: 120, endLabel: 40, edits: 1000, added: 200 } as const`; `export function
  readGuideSettings(raw: unknown, duration?: number): GuideSettings | undefined`; `export function
  readClipOrigin(raw: unknown): ClipOrigin | undefined`.
- `src/shared/chapters/pending.ts` (new, in full): `export function pendingChapters(project:
  Pick<Project, 'chapters'>): Chapter[]`; `export function userChapters(project: Pick<Project,
  'chapters'>): Chapter[]`.
- `src/shared/smart/privateText.ts` (new, in full): `export function pathLike(text: string): boolean`
  (a drive letter and a slash, a `\\server\` share, `~/`, `/Users/`, `/home/`); `export function
  privateLike(text: string): boolean` (`linkLike` on each piece, or `pathLike`); `export function
  readLinkUrl(raw: unknown): string | null` (§4.2).
- `src/shared/smart/sentenceName.ts` (new, in full; P1, P2 and P3 use it): `export const CUE_WORDS:
  Readonly<Record<string, { common: readonly string[]; section: readonly string[] }>>`; `export const
  LEAD_WORDS: Readonly<Record<string, readonly string[]>>`; `export function sentenceName(text: string,
  language?: string): string | null` (§7.5 rule 2); `export function cutName(text: string, max = 40):
  string | null` (rule 4).
- `src/shared/smart/screenChanges.ts` (new, in full; P1, P2 and P3 use it): `export const SCREEN_RULES
  = { change: 10, page: 30, settle: 3, settleS: 1.0, scrollGuard: 0.5 } as const`; `export function
  screenChanges(scan: SceneScan, scrolls?: readonly ScrollEvent[]): { t: number; share: number; page:
  boolean }[]`.
- `src/shared/smart/speechHeard.ts` (new, in full; P1, P2 and P3 use it): `export function
  speechHeard(project: Project, levels: Partial<Record<AudioSource, AudioLevels>> | null, track:
  CursorTrack | null): 'captions' | 'speech' | 'none'` (§7.8: captions present; 10 s or more of speech
  heard; less, or no sound).
- `src/shared/review/autoCutData.ts`: `'short'` in `AUTO_CUT_SOURCES`.
- `src/shared/engine/joinData.ts` (wave 10): `readJoins` accepts `auto.by: 'short'`.
- `src/shared/captions/studioData.ts`: `host` kept by `readAutoOrigin` and the track reader;
  `export function readHost(raw: unknown): string | undefined` (shared with `readChapterOrigin`).
- `src/shared/engine/project.ts`: `migrateProject` reads `guide` and `clipOf` (§4.3).
- `src/shared/captions/emphasis.ts`: `export function uiObjects(tokens: readonly StudioToken[],
  language: string): number[]` (today's `objectIndexes`, unchanged).

**User chapters only** (§7.7)

- `src/shared/render/callouts.ts` (wave 10): `badgeLabels` restarts the count at `userChapters` only.
- `src/shared/captions/great.ts`: `resolveGreatOptions`' `chapters` *Auto* reads
  `userChapters(project).length` (`:124`).
- `src/renderer/src/publish/checkNote.tsx`: `projectSaid` skips `pendingChapters`;
  `src/renderer/src/publish/PublishDialog.tsx`: the `chapterTitles` given to `saidLinks` (`:68-71`)
  are user chapters' only.

**API types and channels**

- `src/shared/api/ai.ts`:
  - `export const LOCAL_TEXT_ID = 'local'`;
  - `AiTextTask` gains `'names'`; `export interface NamesRequest { kind: 'chapter' | 'clip' | 'step' |
    'note'; language?: string; items: { id: string; text: string; action?: string; image?: Uint8Array
    }[] }`; `AiTextRequest.names?: NamesRequest`; `AiTextRequest.requestId?: string`;
    `AiTextResult` gains `{ task: 'names'; names: { id: string; name: string }[] }`;
    `AI_TEXT_TASKS` gains `'names'`;
  - `export interface AiUsage { input: number; output: number }`; `aiText` resolves
    `AiTextResult & { usage?: AiUsage }`;
  - `ScriptDraftRequest.requestId?: string`, so *Draft script* can be cancelled through the same
    `cancelAiText(requestId)` as `aiText` (`ai:draftScript`'s handler registers the id as
    `ai:text`'s handlers do, `aiIpc.ts:194`);
  - `export type ServicePreset = 'azure' | 'openrouter' | 'groq' | 'together' | 'ollama' |
    'lmstudio' | 'other'`; `export interface ServiceInfo { preset: ServicePreset; baseUrl: string;
    host: string; loopback: boolean; json: 'schema' | 'object' | 'text'; keepNoData?: true }`;
    `AiProviderInfo.service?: ServiceInfo`; `AiProviderInput.service?: { preset: ServicePreset;
    baseUrl: string; keepNoData?: boolean }`;
  - `export interface TextChoice { id: string; label: string; kind: AiProviderKind | 'local'; model:
    string; host?: string; place: string; free?: true; pictures?: boolean }` (`place`: "OpenAI",
    "api.groq.com", "Ollama on this PC" or "this PC", the one name every hint and cost line uses);
  - `export type ModelListTarget = { providerId: string } | { draft: AiProviderInput }`;
    `export interface ListedModel { id: string; prices?: { input: number; output: number } | 'varies';
    schema?: boolean }`;
  - `AiApi.listModels(target: ModelListTarget): Promise<ListedModel[]>`;
    `AiApi.getAiPriceList(): Promise<PriceList>`;
  - `AI_LIMITS.names = { items: 200, text: 1500, total: 320_000, action: 80, image: 512 * 1024,
    imagesPerRequest: 50, images: 200 }` (200 items of 1,500 characters and an action fit; `runTextTask`
    splits them into requests by `TextLimits`).
- `src/shared/api/localAi.ts` (new): `export type LocalModelId = 'gemma4-e2b' | 'qwen3.5-2b'`;
  `export type LocalModelUse = 'auto' | LocalModelId`; `export interface LocalModelState { id:
  LocalModelId; state: 'missing' | 'downloading' | 'ready' | 'damaged'; bytes: number; done?: number;
  block: 'memory' | 'processor' | 'helper' | null }`; `export interface LocalAiState { models:
  LocalModelState[]; use: LocalModelUse; active: LocalModelId | null; pc: { totalMemBytes: number;
  freeMemBytes: number; avx2: boolean | null; helper: boolean }; speeds:
  Partial<Record<LocalModelId, { read: number; write: number }>> }`; `export interface LocalAiProgress
  { requestId?: string; phase: 'waiting' | 'loading' | 'reading' | 'writing'; done: number; total:
  number; secondsLeft?: number }`; `export interface LocalAiApi { localAiState(): Promise<LocalAiState>;
  downloadLocalModel(id: LocalModelId): Promise<LocalAiState>; cancelLocalDownload(id: LocalModelId):
  Promise<void>; removeLocalModel(id: LocalModelId): Promise<LocalAiState>; setLocalModelUse(use:
  LocalModelUse): Promise<LocalAiState>; onLocalAiState(listener: (s: LocalAiState) => void): () =>
  void; onLocalAiProgress(listener: (p: LocalAiProgress) => void): () => void }`; `LOCAL_AI_CHANNELS`.
- `src/shared/api/guide.ts` (new): `export type GuideFormat = 'pdf' | 'html' | 'demo' |
  'markdown'`; `export interface GuideSavePayload { format: GuideFormat; name: string; html?: string;
  markdown?: string; images?: Uint8Array[]; page?: 'A4' | 'Letter' }`; `export interface GuideApi {
  saveGuide(payload: GuideSavePayload): Promise<{ path: string; bytes: number } | null>;
  showGuideFile(path: string): Promise<void>; copyGuide(clip: { html: string; text: string }):
  Promise<void>; copyGuideImage(png: Uint8Array): Promise<void> }`; `GUIDE_SAVE_LIMITS = { html: 64 <<
  20, markdown: 2 << 20, images: 300, image: 16 << 20, total: 256 << 20, name: 120, clipText: 2 << 20 }`.
- `src/shared/api/projects.ts`: `export interface SceneScan { step: number; t: number[]; changed:
  number[]; stills: { start: number; end: number }[] }`; `export interface CopyCost { linked: boolean;
  bytes: number; free: number }`; `ProjectsApi.detectScenes(id: string, crop: NormRect | null):
  Promise<SceneScan>`, `onSceneProgress(listener: (p: { id: string; fraction: number }) => void):
  () => void`, `copyCost(id: string): Promise<CopyCost>`.
- `src/shared/api/prefs.ts`: `PrefKey` gains `'aiPrices' | 'aiConfirm' | 'guide' | 'findChapters' |
  'shortClips'`; sanitisers in `src/main/prefsIpc.ts`.
- `src/shared/jobs/longJobs.ts`: `JobKind` gains `'ai'`; `src/main/longJobs.ts` its words ("Writing
  with AI on this PC").

**The text pipeline** (a security boundary every part uses; frozen with its tests 5 and 6)

- `src/shared/captions/transcriptText.ts`: `export interface TextLimits { batchSegments: number;
  batchChars: number; transcriptTokens: number | null; namesItems: number; namesChars: number }`;
  `export const DEFAULT_TEXT_LIMITS: TextLimits` (150, 12,000, null, 40, 12,000);
  `TextPrompt.images?: { mime: 'image/jpeg'; data: Uint8Array; id: string }[]`;
  `export function textPrompts(request: AiTextRequest, limits?: TextLimits): TextPrompt[]`;
  `runTextTask(request, ask, limits?: TextLimits)`; the `names` prompt (`NAMES_SCHEMA` = `{ names: [{
  id, name }] }`, the system texts of §5.3, §5.3.1, §5.4, §7.6 and §8.4, the items as a JSON data
  block, pictures beside their item); `export function validateNamesAnswer(answer: unknown, request:
  NamesRequest): { id: string; name: string }[]` (caps: chapter 100, step and clip 80, note 300;
  `privateLike` refuses); `validateTextRequest` checks `names` against `AI_LIMITS.names` (pictures:
  JPEG by their first bytes, the size and count caps) and lets a `names` request carry `segments: []`
  without the captions check (`transcriptText.ts:472-491`).
- `src/shared/publish/prompts.ts`: the excerpt cap comes from `limits.transcriptTokens` when set
  (else `PACK_TRANSCRIPT_MAX`, unchanged).

**Main seams**

- `src/main/ai/types.ts`: `AiClient.json(prompt, opts: { signal: AbortSignal; effort: TextEffort;
  onUsage?: (u: AiUsage) => void })`; `AiClient.models?: (signal: AbortSignal) =>
  Promise<ListedModel[]>`. A client given a prompt with `images` it cannot send throws "This model
  does not read pictures…" until P6.
- `src/main/aiIpc.ts`: `EFFORT.names = 'low'`; `aiText` and `draftScript` take `LOCAL_TEXT_ID` first
  through P4's `localTextClient(ctx: { sender: WebContents; requestId?: string }): Promise<AiClient
  & { limits(request: AiTextRequest): TextLimits }>`; `draftScript` takes and registers a
  `requestId`; `providers()` lists both stores through P5's `ServiceStore`; usage summed into the
  result; `ai:listModels` and `ai:priceList` call P5's `listModels` and `priceList`.
- `src/main/ai/providers.ts`: `clientFor` returns P5's `compatibleClient(info, key)` for an
  `info.service`.
- `src/main/analysisIpc.ts`: `stopAnalyses` also awaits P2's `stopSceneScan(id)`.
- `src/main/projectCopy.ts`: `COPIED` gains `.cache/scenes.json`, and `planFiles`' `.cache` walk
  (`:119`) gains it beside the speech and sounds caches.
- `src/main/projectsIpc.ts`: `projects:copyCost`, calling P3's `copyCost` in its new file.
- `src/main/projects.ts`: `listProjects` fills `copyOf` and `clip`.
- `src/main/exportIpc.ts`: `export function rememberExported(file: string): void` beside
  `isExportedFile` (`:55`).
- `src/main/index.ts`: imports `./ai/tlsGuard` first; registers `registerGuideIpc`,
  `registerLocalAiIpc`, `registerSceneIpc` and the two new AI channels; at start, sweeps
  `userData/tmp/guide-print/`.
- **Preload, in full**: `src/preload/guide.ts` and `src/preload/localAi.ts` (new), and the new calls
  in `src/preload/ai.ts`, `src/preload/projects.ts` and `src/preload/index.ts`. The preload checks
  `GUIDE_SAVE_LIMITS` (the total too) before sending. No part edits a preload file.

**Review, versions, commands, Polish**

- `src/shared/review/copy.ts`: §13.1's kinds and words; `cutKind`, `cutTitle`, `CUT_DETAILS` for
  `'short'`.
- `src/shared/review/joinReview.ts` (wave 10): the `join:all` row's detail from `joins.auto.by`.
- `src/shared/review/smartReview.ts` (new, in full): `export function smartReviewItems(project:
  Project): ReviewItem[]`; `smartPendingCount(project: Project): number`; `smartItemStatus(project:
  Project, item: ReviewItem): ReviewStatus`; `keepSmartItems(project: Project, items: readonly
  ReviewItem[]): Project`; `removeSmartItems(project: Project, items: readonly ReviewItem[]): Project`;
  `isSmartKind(kind: ReviewKind): boolean` (`'chapter'` only: `'short'` rides the cut rows). It calls
  P2's `chapterReview.ts`.
- `src/shared/review/review.ts`: the five hooks beside phase B's and wave 10's.
- `src/shared/editor/versions.ts`: `AREAS` gains 'guide'; `RECORDING_FIELDS` gains `'clipOf'`.
- `src/shared/editor/commands.ts`: §2.8's eight commands.
- `src/shared/editor/polish.ts`, `polishCopy.ts`, `src/renderer/src/editor/PolishDialog.tsx`,
  `polishRunner.ts`: the `chapters` step declared (§13.3: option, reader, skips, label, row, the scene
  scan fetched) and its body `polishChapters(project: Project, input: PolishInput & { scan:
  SceneScan | null }): Project` from P2.

**Renderer seams**

- `src/renderer/src/views/Editor.tsx`: the Guide button; mounts `GuidePanel` (P1) and
  `ShortClipsPanel` (P3) in the Review panel's place (one panel at a time) and `ShortVersionDialog`
  (P3); the eight command handlers; `settleChapters` (P2) in the settle chain.
- `src/renderer/src/editor/playheadItems.ts` (wave 10 touches it first): `addShapeAt`'s options gain
  `box?: { x: number; y: number; w: number; h: number }` (fractions of the recorded frame).
- `src/renderer/src/ai/textChoices.ts` (new, in full): `export function useTextChoices(task:
  AiTextTask, opts?: { pictures?: boolean }): TextChoice[]` (providers, services, and On this PC when
  P4's `useLocalAiReady()` says so and the task is not `'chapters'` or `'marks'`; with `pictures`,
  only choices that can send them).
- **The text pickers** use `useTextChoices`, mount P5's `<CostLine>` (§11.5's table) and P4's
  `<LocalProgress requestId onStop={() => window.api.cancelAiText(requestId)}/>` beside each busy
  button, and send a `requestId` with every run: `CaptionsPanel.tsx` (its own runs gain one,
  `:1068`; the shared select is `useTextChoices('title')`; *Suggest chapters* calls P2's
  `runFindChapters` for every choice, §7.6.1), `CleanupSection.tsx`, `LanguagesSection.tsx`,
  `GreatOptions.tsx` (`useTextChoices('marks')`), `src/renderer/src/publish/PublishDialog.tsx` and
  `publishRun.ts` (a queue of one for On this PC), `src/renderer/src/notes/DraftScript.tsx`,
  `PolishDialog.tsx`. Every "where it goes" hint in them (`CaptionsPanel.tsx:717`, `:1255`,
  `PublishDialog.tsx:309`, `LanguagesSection.tsx:32`'s `providerName`, `DraftScript.tsx:99`) names
  `TextChoice.place` instead of `KIND_NAMES[kind]`, or is removed where the cost line already names
  the place, so no hint says "OpenAI" for a Groq service or "undefined" for On this PC.
- `src/shared/captions/captionTracks.ts`: `withTranslation` takes and writes `host`; the track label
  (`trackRows`, `:204`) says "translated with <host>" when `host` is set.
- `src/renderer/src/editor/greatRun.ts`: the AI picks' `AutoOrigin` carries `host` for a service.
- `src/renderer/src/editor/panels/TextPanel.tsx`: mounts P2's `<FindChapters>`; the "Found" chip and
  "Rename?" hint on chapters with `auto`; focus on the first weak name after a run.
- `src/renderer/src/editor/CopyMenu.tsx`: the label "Copies: vertical, square, short clips" and the
  text label at wide widths; the two items (props `onClips()`, `onShort()`); the shorter version's
  disabled reason.
- `src/renderer/src/publish/PublishDialog.tsx`: the YouTube card's "Add chapters" hint and the "Make
  short clips…" link; `src/renderer/src/editor/ExportDialog.tsx`: the same link in the done view.
- `src/renderer/src/settings/SettingsDialog.tsx`: `SettingsSection` gains `'localAi'` (the palette's
  *Set up AI on this PC…* and every "use AI on this PC" link open it there); mounts P4's
  `LocalAiSection` after `SpeechModelsSection`.
- `src/renderer/src/editor/ExportBundleOptions.tsx`: "n of them not reviewed yet".
- `src/renderer/src/editor/exporter.ts`: exports `prepareFrames` (today's `prepare`) and
  `openSource`, unchanged.
- **Stub files** for each part's components and entry points, each with its frozen signature; the
  owning part replaces the body: `GuidePanel.tsx`, `ShotViewer.tsx`, `FindChapters.tsx`,
  `chaptersRun.ts`, `chapterAuto.ts`, `chapterReview.ts`, `ShortClipsPanel.tsx`,
  `ShortVersionDialog.tsx`, `LocalAiSection.tsx` with `LocalAiRow`, `localAiState.ts` (P4's
  `useLocalAiReady`, `useLocalAiProgress`), `LocalProgress.tsx`, `localTextClient.ts`, `sceneScan.ts`,
  `copyCost.ts`, `serviceStore.ts`, `compatible.ts`, `modelLists.ts`, `priceList.ts`, `CostLine.tsx`,
  `useCost.ts`, `costConfirm.ts`.

**Tests written in this step**: `tests/smartContracts.test.ts` (tests 1–8 and 101–104), test 33 and
the `sentenceName` cases of test 39 with the shared files they test, and
`tests/smartEquivalence.test.ts` (§22.2), the guard written first, against the code after wave 10.

### 20.1 Part P1 · Guides and demos

| File | Exports |
|---|---|
| `src/shared/guide/steps.ts` (new) | `export type StepKind = 'click' \| 'double' \| 'right' \| 'middle' \| 'drag' \| 'type' \| 'keys' \| 'screen' \| 'badge' \| 'added'`; `export interface GuideStep { key: string; t: number; kind: StepKind; x?: number; y?: number; to?: { x: number; y: number }; times?: number; keys?: string; typing?: { t: number; end: number; place: { x: number; y: number } }; then?: string; scroll?: 'up' \| 'down' \| 'left' \| 'right'; shape?: CursorShape; place?: { x: number; y: number }; badge?: { label: string; section?: string }; hiddenByDefault?: true }`; `export const STEP_RULES = { doubleS: 0.5, doublePx: 4, dragHeldS: 0.25, dragTravel: 0.02, repeatS: 1.5, repeatPx: 12, typingJoinS: 5, typingMinS: 0.5, typingPauseS: 6, typingTailS: 0.3, keyAfterTypingS: 1.5, screenAfterKeyS: 1.5, scrollAheadS: 10, maxSteps: 200 } as const`; `export function findSteps(input: { track: CursorTrack; project: Pick<Project, 'clips' \| 'duration' \| 'width' \| 'height' \| 'capture' \| 'guide' \| 'annotations' \| 'chapters' \| 'effects'>; scan: SceneScan \| null }): GuideStep[]`; `export function stepKey(kind: StepKind, t: number): string`; `export function typedBefore(steps: readonly GuideStep[], shots: ReadonlyMap<string, { t: number; rect: Rect; whole: boolean }>, scan: SceneScan \| null, frame: { w: number; h: number }): ReadonlyMap<string, string>` (step key → the typing step's key) |
| `src/shared/guide/guideWords.ts` (new) | `export interface GuideWords { … }` (every phrase of §15); `export const GUIDE_WORDS: Record<'en' \| 'bn', GuideWords>`; `export function guideLanguage(project: Project): 'en' \| 'bn'` |
| `src/shared/guide/stepTitles.ts` (new) | `export type TitleFrom = 'narration' \| 'keys' \| 'sentence' \| 'cut' \| 'cursor' \| 'taskbar' \| 'place' \| 'template'`; `export function stepTitle(step: GuideStep, ctx: { segments: readonly CaptionSegment[]; language: 'en' \| 'bn'; transcriptLanguage?: string; digits?: 'native' \| 'western'; target: CaptureInfo['target']; scale: number; height: number; element?: { name: string; role: string } \| null }): { title: string; from: TitleFrom }`; `export function needsTitle(from: TitleFrom): boolean`; `export function stepText(steps: readonly GuideStep[], i: number, project: Project, full: boolean): string`; `export function stepNarration(step: GuideStep, project: Project): string`; `export function stepAction(step: GuideStep): string`; `export function namesRequestForSteps(project: Project, steps: readonly GuideStep[], kind: 'step' \| 'note'): NamesRequest` |
| `src/shared/guide/shots.ts` (new) | `export const SHOT = { cropBase: 950, maxWidth: 1600, maxSource: 3840, ringAt: 960, ringDiameter: 44, ringWidth: 4, halo: 3, arrowHead: 16, ring: '#0060df', send: 768, copy: 1200 } as const`; `export function guideProject(project: Project): Project`; `export function shotTime(step: GuideStep, clips: readonly Clip[], fps: number, after: boolean): number`; `export function shotRect(step: GuideStep, frame: { w: number; h: number }, crop: NormRect \| null, scale: number, view: { whole: boolean; rect?: GuideStepEdit['rect'] }): { rect: Rect; outside: boolean }`; `export function ringOf(step: GuideStep, rect: Rect, outW: number, frame: { w: number; h: number }, crop: NormRect \| null, at?: GuideStepEdit['ring']): { cx: number; cy: number; r: number; width: number; halo: number } \| null`; `export function arrowOf(…same…): { x0: number; y0: number; x1: number; y1: number; width: number; head: number } \| null`; `export function ringColour(project: Project): string`; `export function blurBoxes(step: GuideStep, frame: { w: number; h: number }, scale: number): { area: NormRect; typed: NormRect \| null }` |
| `src/shared/guide/guideEdit.ts` (new) | `export function withStepEdit(project: Project, key: string, patch: Partial<Omit<GuideStepEdit, 'key'>> \| null): Project`; `export function withAddedStep(project: Project, t: number, title: string): Project`; `export function withAiTitles(project: Project, titles: readonly { key: string; title: string }[], via: AiProviderKind \| 'local'): Project`; `export function withAiNotes(project: Project, notes: readonly { key: string; text: string }[], via: AiProviderKind \| 'local'): Project`; `export function withoutAiTitles(project: Project): Project`; `export function withGuideFields(project: Project, patch: Partial<Omit<GuideSettings, 'steps' \| 'added'>>): Project`; `export function withTypedBlur(project: Project, step: GuideStep, until: number, box: NormRect): Project` |
| `src/shared/guide/guideDoc.ts` (new) | `export interface GuideImage { bytes: Uint8Array; mime: 'image/png' \| 'image/jpeg' \| 'image/webp'; width: number; height: number }`; `export interface GuideDoc { title: string; intro?: string; lang: string; words: GuideWords; digits: 'native' \| 'western'; brand?: { logo: GuideImage \| null; colour: string \| null }; steps: { n: string; label: string; section?: string; title: string; type?: string; text?: string; image: GuideImage \| null; alt: string; hotspot?: { x: number; y: number } }[]; bug?: { expected: string; actual: string; actualImage: GuideImage \| null; details: string[] }; end?: GuideEnd }`; `export function buildGuideDoc(project: Project, steps: readonly GuideStep[], images: ReadonlyMap<string, GuideImage>, brand: GuideDoc['brand'] \| null): GuideDoc` |
| `src/shared/guide/guideMarkdown.ts` (new) | `export function escapeMarkdown(text: string): string`; `export function guideMarkdown(doc: GuideDoc): { markdown: string; images: string[] }` (image names `step-01.png`…, `actual.png`) |
| `src/shared/guide/guideHtml.ts` (new) | `export const DEMO_SCRIPT: string`; `export const DEMO_SCRIPT_HASH: string` (`sha256-…`, base64; test 24 recomputes it); `export function escapeHtml(text: string): string`; `export function guideHtml(doc: GuideDoc, opts: { demo: boolean; print: boolean; clipboard?: boolean; fonts: readonly { family: string; weight: number; woff2: Uint8Array }[]; page?: 'A4' \| 'Letter' }): string`; `export function guideText(doc: GuideDoc): string` |
| `src/shared/guide/demoLayout.ts` (new) | `export function calloutPlace(hotspot: { x: number; y: number } \| null, picture: { w: number; h: number }, callout: { w: number; h: number }): { side: 'right' \| 'left' \| 'above' \| 'below' \| 'corner'; x: number; y: number }`; `export const DEMO_NARROW = 640` |
| `src/renderer/src/guide/guideStills.ts` (new) | `export async function* renderGuideStills(input: ThumbnailInput, shots: readonly { key: string; t: number; rect: Rect; ring: ReturnType<typeof ringOf>; arrow: ReturnType<typeof arrowOf> }[], opts: { mime: GuideImage['mime']; quality: number; maxWidth: number; signal: AbortSignal }): AsyncGenerator<{ key: string; image: GuideImage }>` |
| `src/renderer/src/guide/guideRun.ts` (new) | `export async function saveGuide(format: GuideFormat, deps: { project: Project; steps: readonly GuideStep[]; images: ReadonlyMap<string, GuideImage>; page: 'A4' \| 'Letter'; signal: AbortSignal }): Promise<{ path: string; bytes: number } \| null>`; `export async function copyGuide(deps: { project: Project; steps: readonly GuideStep[]; images: ReadonlyMap<string, GuideImage> }): Promise<{ images: number }>`; `export async function writeStepTitles(deps: { store: EditStore<Project>; steps: readonly GuideStep[]; choice: TextChoice; pictures: ReadonlyMap<string, Uint8Array> \| null; signal: AbortSignal; requestId: string }): Promise<{ notice: string }>`; `export async function tidyNotes(deps: { store: EditStore<Project>; steps: readonly GuideStep[]; choice: TextChoice; signal: AbortSignal; requestId: string }): Promise<{ notice: string }>`; `export function guideFonts(doc: GuideDoc, print: boolean): Promise<{ family: string; weight: number; woff2: Uint8Array }[]>` |
| `src/renderer/src/guide/GuidePanel.tsx` (new), `ShotViewer.tsx` (new), `guide.css` (new) | `export function GuidePanel(props: { project: Project; cursor: CursorTrack; start: 'guide' \| 'demo' \| 'bug'; onClose(): void; onNotice(message: string): void }): JSX.Element`; `export function ShotViewer(props: { shots: readonly { key: string; label: string; image: GuideImage }[]; index: number; mode: 'view' \| 'check' \| 'send'; place?: string; onClose(result?: { send: readonly string[] }): void; onBlur(key: string): void; onAdjust(key: string, edit: Pick<GuideStepEdit, 'rect' \| 'ring'> \| null): void }): JSX.Element` |
| `src/main/guide/printPdf.ts` (new) | `export const PRINT_PARTITION = 'guide-print'`; `export const PRINT_DIR = 'tmp/guide-print'`; `export async function printGuidePdf(html: string, opts: { page: 'A4' \| 'Letter'; steps: number; signal?: AbortSignal }): Promise<Buffer>`; `export async function sweepGuidePrint(dir: string): Promise<string[]>` |
| `src/main/guide/writeGuide.ts` (new) | `export function guideNameOk(name: string): boolean`; `export function checkGuidePayload(raw: unknown): GuideSavePayload`; `export async function writeGuideFiles(target: string, payload: GuideSavePayload, pdf?: Buffer): Promise<{ path: string; bytes: number }>` |
| `src/main/guide/guideIpc.ts` (new) | `export function registerGuideIpc(): void` (`guide:save`, `guide:showItem`, `guide:copy`, `guide:copyImage`) |
| Tests | `tests/guideSteps.test.ts`, `tests/guideTyped.test.ts`, `tests/guideTitles.test.ts`, `tests/guideNotes.test.ts`, `tests/guideShots.test.ts`, `tests/guideBlur.test.ts`, `tests/guideDoc.test.ts`, `tests/guideHtml.test.ts`, `tests/demoLayout.test.ts`, `tests/guideMarkdown.test.ts`, `tests/guidePrint.test.ts`, `tests/guideSave.test.ts`, `tests/guideCopy.test.ts`, `tests/guideEdit.test.ts`, `tests/guidePanel.test.ts`, `tests/shotViewer.test.ts` |

May touch additively: none. The demo script's behaviour is tested in e2e step 8.

### 20.2 Part P2 · Chapters

| File | Exports |
|---|---|
| `src/main/sceneScan.ts` (new) | `export function sceneScanArgs(file: string, fps: number \| undefined, crop: NormRect \| null): string[]` (key frames only at 60 fps or more, else `fps=4`); `export function parseSceneLog(log: string, duration: number, step: number): SceneScan`; `export async function detectScenes(id: unknown, crop: unknown, onProgress?: (fraction: number) => void): Promise<SceneScan>`; `export const stopSceneScan: (id: string) => Promise<void>`; `export function registerSceneIpc(): void` (`projects:detectScenes`, `projects:sceneProgress`) |
| `src/shared/chapters/signals.ts` (new) | `export const CHAPTER_RULES = { minVideo: 30, perChapter: 90, minChapters: 3, maxChapters: 12, minShare: 0.06, minLength: 10, pause: 2, shortPause: 1.5, idle: 3, merge: 2, snap: 2, maxCandidates: 400, cardNear: 3, topicDepth: 0.5, cost: { fewer: 3.5, normal: 3, more: 2 }, score: { page: 3.5, screen: 1.5, pause: 1.5, shortPause: 0.75, idle: 1, common: 1, section: 2.5, topic: 2, card: 4, ai: 3.5 } } as const`; `export interface Candidate { t: number; v: number; score: number; from: ChapterSignal[]; fixed?: true; ai?: { title: string } }`; `export function pauseCandidates(speech: readonly TimeRange[] \| null, gaps: readonly TimeRange[] \| null): Candidate[]`; `export function cueCandidates(segments: readonly CaptionSegment[], language?: string): Candidate[]`; `export function textTiling(words: readonly { text: string; start: number }[], opts?: { w: number; k: number; smooth: number }): { t: number; depth: number }[]`; `export function cardCandidates(titles: readonly TitleCard[]): Candidate[]`; `export function aiCandidates(chapters: readonly { t: number; title: string }[]): Candidate[]`; `export function mergeCandidates(list: readonly Candidate[], sentenceStarts: readonly number[]): Candidate[]` |
| `src/shared/chapters/plan.ts` (new) | `export interface ChapterPlanInput { project: Project; track: CursorTrack \| null; scan: SceneScan \| null; speech: readonly TimeRange[] \| null; density: 'fewer' \| 'normal' \| 'more'; use: { screen: boolean; pauses: boolean; words: boolean }; ai?: readonly { t: number; title: string }[]; apps?: readonly { t: number }[] }`; `export type ChapterPlan = { ok: true; starts: { t: number; from: ChapterSignal[]; ai?: string }[]; youtube: boolean } \| { ok: false; reason: 'too-short' \| 'nothing' \| 'already' }`; `export function planChapters(input: ChapterPlanInput): ChapterPlan`; `export function chooseBoundaries(cands: readonly Candidate[], L: number, m: number, n: number, cost: number): Candidate[]` |
| `src/shared/chapters/names.ts` (new) | `export function chapterNames(project: Project, starts: readonly { t: number; ai?: string }[]): { title: string; name: ChapterOrigin['name'] }[]`; `export function phraseName(chapterWords: readonly string[][], allWords: readonly string[], language?: string): string \| null`; `export function namesRequestForChapters(project: Project, starts: readonly number[]): NamesRequest`; `export function weakName(name: ChapterOrigin['name']): boolean` |
| `src/shared/chapters/chapterAuto.ts` (new) | `export function withFoundChapters(project: Project, found: readonly { t: number; title: string; origin: ChapterOrigin }[]): Project`; `export function withoutPendingChapters(project: Project): Project`; `export function settleChapters(next: Project, prev: Project): Project`; `export function polishChapters(project: Project, input: PolishInput & { scan: SceneScan \| null }): Project` |
| `src/shared/review/chapterReview.ts` (new) | `export function chapterReviewItems(project: Project): ReviewItem[]`; `chapterPendingCount(project: Project): number`; `chapterItemStatus(project: Project, item: ReviewItem): ReviewStatus`; `keepChapterItems(project: Project, items: readonly ReviewItem[]): Project`; `removeChapterItems(project: Project, items: readonly ReviewItem[]): Project` |
| `src/renderer/src/editor/chaptersRun.ts` (new) | `export interface FindChapterOptions { density: 'fewer' \| 'normal' \| 'more'; use: { screen: boolean; pauses: boolean; words: boolean }; names: string; split?: string }` (`names`: `'offline'`, a provider id or `'local'`; `split`: a provider id for §7.6.1); `export async function runFindChapters(deps: { store: EditStore<Project>; recorded: CursorTrack; options: FindChapterOptions; signal: AbortSignal; requestId: string; onProgress(text: string, fraction: number \| null): void }): Promise<{ notice: string; weak: string \| null } \| { needsCaptions: true }>` |
| `src/renderer/src/editor/panels/FindChapters.tsx` (new), `findChapters.css` (new) | `export function FindChapters(props: { project: Project; cursor: CursorTrack; onNotice(message: string): void }): JSX.Element` |
| Tests | `tests/sceneScan.test.ts`, `tests/chapterSignals.test.ts`, `tests/textTiling.test.ts`, `tests/chapterPlan.test.ts`, `tests/chapterNames.test.ts`, `tests/chapterAuto.test.ts`, `tests/chapterReview.test.ts`, `tests/polishChapters.test.ts`, `tests/findChapters.test.ts`, `tests/suggestChapters.test.ts` |

May touch additively: none.

### 20.3 Part P3 · Short clips

| File | Exports |
|---|---|
| `src/shared/clips/sentences.ts` (new) | `export interface ScoredSentence { start: number; end: number; seconds: number; text: string; words: number; features: { density: number; keywords: number; emphasis: number; numbers: number; action: number; fillers: number; focus: number }; retake: boolean; chapter: number }`; `export function scoredSentences(project: Project, ctx: { track: CursorTrack \| null; scan: SceneScan \| null; focus?: string }): ScoredSentence[]` |
| `src/shared/clips/moments.ts` (new) | `export const CLIP_RULES = { min: 15, max: 90, shortMax: 60, longMin: 60, gapBefore: 0.3, gapAfter: 0.4, best: 45, spread: 20, lengthWeight: 1.5, overlap: 0.3, perMoments: 120, minMoments: 3, maxMoments: 10, minVideo: 45, empty: 0.3, choppy: 4 } as const`; `export interface Moment { start: number; end: number; seconds: number; score: number; reasons: string[]; first: string; title: string; silent: boolean }`; `export function findMoments(project: Project, ctx: { track: CursorTrack \| null; scan: SceneScan \| null; focus?: string; length: 'any' \| 'short' \| 'long'; activityOnly?: boolean }): Moment[] \| { reason: 'too-short' \| 'nothing' }` |
| `src/shared/clips/short60.ts` (new) | `export type ShortPlan = { ok: true; pieces: { start: number; end: number }[]; seconds: number; sentences: number } \| { ok: false; reason: 'no-captions' \| 'too-little' \| 'too-short' }`; `export function planShort(project: Project, sentences: readonly ScoredSentence[], opts: { seconds: 30 \| 60 \| 90; focus?: string }): ShortPlan`; `export function shortCopy(project: Project, plan: Extract<ShortPlan, { ok: true }>, opts: { shape: 'same' \| 'vertical' \| 'square'; captions: boolean; measure: MeasureText \| null }): Project` |
| `src/shared/clips/clipCopy.ts` (new) | `export function clipCopy(project: Project, moment: Moment, opts: { shape: 'same' \| 'vertical' \| 'square'; captions: boolean; measure: MeasureText \| null }): Project`; `export function clipsInRange(project: Pick<Project, 'clips' \| 'freezes'>, start: number, end: number): Pick<Project, 'clips' \| 'freezes'>`; `export function withinRange(copy: Project, ranges: readonly { start: number; end: number }[]): Project` |
| `src/renderer/src/clips/ShortClipsPanel.tsx`, `ShortVersionDialog.tsx`, `clips.css` (new) | `export function ShortClipsPanel(props: { project: Project; cursor: CursorTrack; vw: number; vh: number; onClose(): void; onOpen(id: string): void }): JSX.Element`; `export function ShortVersionDialog(props: { project: Project; cursor: CursorTrack; vw: number; vh: number; onClose(): void; onOpen(id: string): void }): JSX.Element` |
| `src/renderer/src/clips/clipsRun.ts` (new) | `export async function makeClipCopies(copies: readonly Project[], deps: { sourceId: string; flush(): Promise<boolean>; signal: AbortSignal; onProgress(i: number, n: number, p: DuplicateProgress \| null): void }): Promise<{ made: { id: string; name: string }[]; stopped: boolean }>` (one after another through `duplicateProject`) |
| `src/main/clips/copyCost.ts` (new) | `export async function copyCost(sourceId: unknown): Promise<CopyCost>` (the contracts register `projects:copyCost` to it) |
| Tests | `tests/clipSentences.test.ts`, `tests/clipMoments.test.ts`, `tests/short60.test.ts`, `tests/clipCopy.test.ts`, `tests/clipsRun.test.ts`, `tests/copyCost.test.ts`, `tests/shortClipsPanel.test.ts`, `tests/shortVersionDialog.test.ts` |

May touch additively: none.

### 20.4 Part P4 · AI on this PC

| File | Exports |
|---|---|
| `native/llm/` (new: `Cargo.toml`, `Cargo.lock`, `src/main.rs`, `src/protocol.rs`, `README.md`) | the `ssw-llm` program of §9.1 |
| `scripts/build-native.mjs` | builds `native/bin/ssw-llm.exe` with `--locked` and the `GGML_*` flags (and `--llm-host` for tests) |
| `scripts/lib/packaging.cjs` (P4 owns its changes) | `ssw-llm.exe` in `speechResources`' directory-form filter (or a sibling directory-form entry), `llmHelperStatus()`, `LLM_BUDGET`, `'llama.cpp'` in `NOTICE_NAMES` |
| `scripts/verify-dist.mjs` | the import, size and signature checks of §9.1 |
| `scripts/notices.mjs`, `resources/notices/NN-llama-cpp.txt` | `native/llm/Cargo.toml` in `CRATES`; `ssw-llm.exe` in `RUST_TITLE`; the notice of §9.1 |
| `scripts/llm-special-tokens.mjs` (new), `tests/fixtures/llm/*` | the special-token lists and the template fixtures (§9.6) |
| `src/shared/localAi/catalog.ts` (new) | `export interface LocalModelSpec { id: LocalModelId; name: string; title: string; hint: string; file: string; bytes: number; sha256: string; repo: string; commit: string; licence: 'Apache-2.0'; maker: string; family: 'qwen' \| 'gemma'; peakMB: number; minTotalMemGB: number; read: number; write: number; loadS: number; notes: Partial<Record<AiTextTask, string>> }`; `export const LOCAL_MODELS: readonly LocalModelSpec[]`; `export const LOCAL_MODEL_MIRROR: { repo: string; commit: string } \| null`; `export function localModel(id: string): LocalModelSpec \| undefined`; `export function localModelUrls(spec: LocalModelSpec): string[]`; `export function localModelBlock(spec: LocalModelSpec, pc: { totalMemBytes: number; avx2: boolean \| null; helper: boolean }): 'memory' \| 'processor' \| 'helper' \| null`; `export function pickLocalModel(use: LocalModelUse, ready: readonly LocalModelId[], pc: { totalMemBytes: number; freeMemBytes: number; avx2: boolean \| null; helper: boolean }): LocalModelId \| null`; `export function suggestedModel(pc: { totalMemBytes: number }): LocalModelId`; `export function llmThreads(logical: number): number` |
| `src/shared/localAi/protocol.ts` (new) | `export type HelperEvent = …` (each `ev` of §9.1); `export function readHelperLine(line: string): HelperEvent \| null`; `export function runLine(id: string, parts: readonly ChatPart[], grammar: string, maxTokens: number): string` |
| `src/shared/localAi/chatFormat.ts` (new) | `export interface ChatPart { t: string; special: boolean }`; `export function chatParts(family: 'qwen' \| 'gemma', system: string, user: string): ChatPart[]`; `export function chatPrompt(family: 'qwen' \| 'gemma', system: string, user: string): string`; `export function breakSpecialTokens(text: string, family: 'qwen' \| 'gemma'): string` |
| `src/shared/localAi/grammar.ts` (new) | `export function schemaGrammar(schema: Record<string, unknown>, caps?: { string?: number; minItems?: Readonly<Record<string, number>> }): string` (a `{0,n}` bound only for `n ≤ 100`) |
| `src/shared/localAi/budget.ts` (new) | `export function localLimits(language: string \| undefined, family: 'qwen' \| 'gemma'): TextLimits`; `export function maxTokensFor(prompt: TextPrompt, task: AiTextTask, family: 'qwen' \| 'gemma', kind?: NamesRequest['kind']): number`; `export const LOCAL_CTX = 8192`; `export const PROMPT_BATCH = 64` |
| `src/main/localAi/engine.ts` (new) | `export class LlmEngine { constructor(opts: { helper: string; dir: string; spawn?: typeof spawn; idleMs?: number; graceMs?: number; stallMs?: number }); run(req: { spec: LocalModelSpec; parts: readonly ChatPart[]; grammar: string; maxTokens: number; signal: AbortSignal; onProgress(p: LocalAiProgress): void }): Promise<{ text: string; prompt: number; output: number; readMs: number; writeMs: number }>; unload(): Promise<void>; dispose(): Promise<void> }`; `export function llmHelperPath(): string \| null` (`SSW_LLM_HELPER` only when unpackaged) |
| `src/main/localAi/models.ts` (new) | `export const TEXT_MODELS_DIR: string`; `export async function localAiState(): Promise<LocalAiState>`; `export async function downloadLocalModel(id: unknown, opts: { signal: AbortSignal; onProgress(s: LocalAiState): void }): Promise<LocalAiState>`; `export async function removeLocalModel(id: unknown): Promise<LocalAiState>`; `export async function setLocalModelUse(use: unknown): Promise<LocalAiState>`; `export async function blendSpeed(id: LocalModelId, readTps: number, writeTps: number): Promise<void>`; `export function testCatalog(): readonly LocalModelSpec[] \| null` (`SSW_TEXT_MODEL_TEST_CATALOG` only when unpackaged) |
| `src/main/localAi/localTextClient.ts` (new) | `export async function localTextClient(ctx: { sender: WebContents; requestId?: string }): Promise<AiClient & { limits(request: AiTextRequest): TextLimits }>` |
| `src/main/localAi/localAiIpc.ts` (new) | `export function registerLocalAiIpc(): void` |
| `src/renderer/src/settings/LocalAiSection.tsx` (new), `localAi.css` | `export function LocalAiSection(props: { reveal: boolean }): JSX.Element`; `export function LocalAiRow(props: { onOpen(): void }): JSX.Element` |
| `src/renderer/src/ai/localAiState.ts` (new) | `export function useLocalAiReady(): boolean`; `export function useLocalAiProgress(requestId: string \| null): LocalAiProgress \| null`; `export function useLocalNote(task: AiTextTask, kind?: NamesRequest['kind']): string \| null` |
| `src/renderer/src/ai/LocalProgress.tsx` (new) | `export function LocalProgress(props: { requestId: string \| null; onStop(): void }): JSX.Element \| null` |
| Tests | `tests/localCatalog.test.ts`, `tests/localProtocol.test.ts`, `tests/llmEngine.test.ts` (a fake helper), `tests/llmHelper.test.ts` (the real helper, with `SSW_LLM_TEST_MODEL`), `tests/chatFormat.test.ts`, `tests/localGrammar.test.ts`, `tests/localBudget.test.ts`, `tests/localModels.test.ts`, `tests/localTextClient.test.ts`, `tests/localAiSection.test.ts`, `tests/llmPackaging.test.ts`, `native/llm/tests/` |

May touch additively: `src/main/speech/download.ts`, only to export what `models.ts` reuses
(`allowDownloadUrl` is already exported), with no change in behaviour.

### 20.5 Part P5 · Any AI service and the cost

| File | Exports |
|---|---|
| `src/shared/ai/baseUrl.ts` (new) | `export type BaseUrlResult = { ok: true; baseUrl: string; origin: string; host: string; loopback: boolean } \| { ok: false; message: string }`; `export function readBaseUrl(raw: string): BaseUrlResult`; `export function azureBaseUrl(resource: string): BaseUrlResult`; `export function isLoopbackHost(host: string): boolean` |
| `src/shared/ai/presets.ts` (new) | `export const SERVICE_PRESETS: Readonly<Record<ServicePreset, { label: string; baseUrl: string \| null; host: string \| null; keyNeeded: boolean; free: boolean; priceService: string \| null }>>`; `export function presetApplies(preset: ServicePreset, host: string): boolean`; `export function serviceName(info: Pick<AiProviderInfo, 'label' \| 'service'>): string` |
| `src/shared/ai/prices.ts` (new) | `export interface PriceEntry { service: string; model: string; prefix?: true; input?: number; output?: number; perMinute?: number; imageTokens?: { base: number; perTile: number; tile: number } }`; `export interface PriceList { version: 1; updated: string; currency: 'USD'; models: PriceEntry[] }`; `export const BUNDLED_PRICE_LIST: PriceList`; `export const PRICE_LIST_URL: string`; `export const PRICE_LIST_MAX_BYTES = 256 * 1024`; `export function parsePriceList(raw: unknown, today: string): PriceList \| null`; `export function priceOf(list: PriceList, service: string, model: string): PriceEntry \| null`; `export function confirmPrice(bundled: PriceList, downloaded: PriceList \| null, service: string, model: string): PriceEntry \| null` (the higher per model); `export function readOpenRouterPrice(raw: unknown): { input: number; output: number } \| 'varies'` |
| `src/shared/ai/tokens.ts` (new) | `export const TOKEN_RATIOS: Readonly<Record<'o200k' \| 'claude' \| 'qwen' \| 'gemma', Partial<Record<ScriptTag, number>>>>`; `export function estimateTokens(text: string, family: 'o200k' \| 'claude' \| 'qwen' \| 'gemma'): number`; `export function imageTokens(kind: AiProviderKind, size: { w: number; h: number }, rule?: PriceEntry['imageTokens']): number`; `export function countWords(text: string): number` |
| `src/shared/ai/cost.ts` (new) | `export interface CostEstimate { requests: number; words: number; pictures: number; inputTokens: [number, number]; outputTokens: [number, number]; usd: [number, number] \| null; unknown?: 'no-price' \| 'varies'; seconds?: [number, number]; price?: { entry: PriceEntry \| { input: number; output: number }; updated?: string } }`; `export function estimateText(request: AiTextRequest, target: { choice: TextChoice; limits: TextLimits; prices: PriceList; confirmPrices: PriceList; own?: { input: number; output: number }; speed?: { read: number; write: number }; calibration?: { input: number; output: number } }): CostEstimate`; `export function estimateTranscription(seconds: number, target: { kind: AiProviderKind; model: string; prices: PriceList }): CostEstimate`; `export function costPart(estimate: CostEstimate): string`; `export function costLineText(estimates: readonly { label: string; estimate: CostEstimate }[], where: string, what: string, model: string, full: boolean): string`; `export function costSentence(estimate: CostEstimate, where: string): string`; `export type ConfirmPref = 'always' \| '0.1' \| '1' \| '5' \| 'never'`; `export function needsConfirm(estimate: CostEstimate, pref: ConfirmPref, askedUnknown: boolean): boolean`; `export const CONFIRM_LOCAL_S = 600` |
| `src/main/ai/serviceStore.ts` (new) | `export class ServiceStore { constructor(file: string, box: SecretBox); list(): AiProviderInfo[]; get(id: unknown): { info: AiProviderInfo; apiKey: string \| null }; keyForDraft(draft: AiProviderInput): string \| null; save(raw: unknown, now?: Date): AiProviderInfo; remove(id: unknown): void; setJsonMode(id: string, json: ServiceInfo['json']): void }`; `export function validateServiceInput(input: unknown): AiProviderInput & { service: NonNullable<AiProviderInput['service']> }` |
| `src/main/ai/compatible.ts` (new) | `export function compatibleClient(info: AiProviderInfo, apiKey: string \| null, store: Pick<ServiceStore, 'setJsonMode'>): AiClient`; `export async function probeJsonMode(client: AiClient, signal: AbortSignal): Promise<ServiceInfo['json']>`; `export function noRedirectFetch(origin: string): typeof fetch` |
| `src/main/ai/modelLists.ts` (new) | `export async function listModels(target: unknown, deps: { providers(): …; services(): ServiceStore }): Promise<ListedModel[]>`; `export function filterModels(kind: AiProviderKind, ids: readonly string[], field: 'text' \| 'transcription'): string[]` |
| `src/main/ai/priceList.ts` (new) | `export function priceList(): { shown: PriceList; confirm: PriceList }`; `export async function refreshPriceList(opts: { fetch?: typeof fetch; now?: number; updatesOn: boolean }): Promise<PriceList>`; `export function priceListUrl(): string` (`SSW_PRICE_LIST_URL` only when unpackaged) |
| `src/main/ai/usage.ts` (new) | `export function calibration(key: string): { input: number; output: number }`; `export async function recordUsage(key: string, estimated: { input: number; output: number }, used: AiUsage): Promise<void>` |
| `src/main/ai/tlsGuard.ts` (new) | side effect only: deletes `NODE_TLS_REJECT_UNAUTHORIZED` in a packaged app |
| `src/main/ai/secrets.ts` (new) | `export function registerSecret(value: string): void`; `export function secretValues(): readonly string[]`; `export function scrubSecrets(message: string): string` |
| `src/shared/diagnostics/redact.ts`, `src/main/appLog.ts`, `src/main/diagnostics.ts` | `redactLine(line: string, roots: RedactRoots = {}, names: readonly string[] = [], secrets: readonly string[] = []): string` (exact values, longest first, as `<secret>`; URL credentials); the three call sites add `secretValues()` |
| `src/main/ai/request.ts` | `callWithRetry` passes every failure message through `scrubSecrets` |
| `src/main/ai/openai.ts`, `gemini.ts`, `anthropic.ts` | `models(signal)` and `onUsage` (reading `usage`, `usageMetadata`); nothing else changes |
| `resources/ai-prices.json` (new), `scripts/check-ai-prices.mjs` (new) | §11.4 |
| `src/renderer/src/settings/ProviderForm.tsx`, `AiProvidersSection.tsx` | the fields of §2.6; the service rows; *Ask before a run that costs more than*; `AiProvidersSection` mounts P4's `LocalAiRow` (the contracts' stub until P4 merges) first |
| `src/renderer/src/ai/ModelCombobox.tsx` (new) | `export function ModelCombobox(props: { id: string; label: string; value: string; onChange(v: string): void; target: ModelListTarget \| null; field: 'text' \| 'transcription' }): JSX.Element` |
| `src/renderer/src/ai/CostLine.tsx` (new), `src/renderer/src/ai/useCost.ts` (new), `src/renderer/src/ai/costConfirm.ts` (new) | `export function CostLine(props: { id: string; choice: TextChoice \| null; actions: readonly { key: string; label: string; buttonId: string; request: AiTextRequest \| (() => AiTextRequest) \| null }[]; full?: boolean; transcribeSeconds?: number }): JSX.Element \| null`; `export function useCost(choice: TextChoice \| null, request: AiTextRequest \| null): CostEstimate \| null`; `export function confirmCost(estimate: CostEstimate, choice: TextChoice): Promise<boolean>` |
| Tests | `tests/baseUrl.test.ts`, `tests/serviceStore.test.ts`, `tests/compatibleClient.test.ts` (a local HTTPS server), `tests/redirects.test.ts`, `tests/tlsGuard.test.ts`, `tests/redactKeys.test.ts`, `tests/modelLists.test.ts`, `tests/priceList.test.ts`, `tests/tokens.test.ts`, `tests/cost.test.ts`, `tests/costLine.test.ts`, `tests/costConfirm.test.ts`, `tests/providerFormService.test.ts`, `tests/modelCombobox.test.ts`, `tests/usage.test.ts` |

May touch additively: none.

### 20.6 Part P6 · Titles from the screenshots (§0 decision 10)

Built after P1 and P5 have merged, on their files, which it then owns for these additions.

| File | Exports |
|---|---|
| `src/main/ai/images.ts` (new) | `export function checkImages(images: readonly Uint8Array[]): void` (JPEG, size and count caps); `export function openAiImagePart(img: TextPrompt['images'][number]): unknown`; `export function chatImagePart(…): unknown`; `export function geminiImagePart(…): unknown`; `export function claudeImageBlock(…): unknown` |
| `src/main/ai/openai.ts`, `gemini.ts`, `anthropic.ts`, `compatible.ts` | send `prompt.images` with their item; a refusal naming the image maps to "This model does not read pictures…" |
| `src/renderer/src/guide/visionTitles.ts` (new) | `export async function picturesToSend(steps: readonly GuideStep[], images: ReadonlyMap<string, GuideImage>, typed: ReadonlyMap<string, string>): Promise<{ key: string; jpeg: Uint8Array; ticked: boolean }[]>` |
| `src/renderer/src/guide/GuidePanel.tsx`, `ShotViewer.tsx` | the checkbox, the send form of the viewer |
| `src/shared/ai/tokens.ts`, `cost.ts` | pictures counted (`imageTokens`), "screenshots" named in the line |
| Tests | `tests/visionTitles.test.ts`, `tests/aiImages.test.ts` |

### 20.7 Not touched, ownership and merging

**Not touched by any part**: the recording side (listed at the top), `Home.tsx`,
`src/main/security.ts`, the CSP, `src/main/windows.ts`, `appSettings.ts`, every drawing layer and
`compositor.ts` (this wave draws nothing new), `frameView.ts`, wave 10's `chapterBar*` files (they
read `outputChapters`, which already includes found chapters), `keyStore.ts`'s file format, the model
list's format (`ai-models.json` and `parseModelList`), smart speed's still detection.

**Ownership.** The files the contracts complete (§20.0), the preload files among them, are edited by
no part. Every other existing file a part touches has that part as its only owner: the three provider
clients, `request.ts`, `redact.ts`, `appLog.ts`, `diagnostics.ts`, `ProviderForm.tsx`,
`AiProvidersSection.tsx`: P5 (then P6 for its image additions, after P5 merges); `build-native.mjs`,
`packaging.cjs`, `verify-dist.mjs`, `notices.mjs`: P4. P3 owns no existing file: `copyCost` lives in
its new `src/main/clips/copyCost.ts`, and the contracts register its channel.

**Merge order**: P5, P4, P2, P1, P3, P6 (the cost line and text choices first, as every AI action shows
them; chapters before guides and clips, whose tests read found chapters; P6 last, on P1 and P5). Then
both typechecks, all of vitest, `npm run build`, `node scripts/build-native.mjs --require` with the
LLM helper, `npm run notices -- --check`, and under `xvfb-run`: `smart-tools`, `editing-polish`,
`captions-studio`, `review-mode`, `polish`, `one-click-polish`, `titles`, `vertical-video`,
`publish-pack`, `captions`, `transcription`, `offline-captions`, `bangla-captions`, `export`,
`export-pack`, `render`, `versions`, `commands`, `ai`, `search`, `share`, `ui`, `packaging`.

---

## 21. Where wave 10 and phase B meet this wave

| Shared place | Wave 10 / phase B | This wave |
|---|---|---|
| `review.ts`, `copy.ts` | `captionReview.ts` (phase B), `editingReview.ts` (wave 10); kinds style … bleep, join, colour | `smartReview.ts` after them; kinds `chapter`, `short` appended |
| `joinReview.ts`, `joinData.ts`, `ProjectJoins.auto` | the `join:all` row for Polish's smooth cuts; `by: 'polish'` | `by: 'short'` for the shorter version's smooth cuts; the row's detail from `by` |
| Settle chain, `Editor.tsx:207` | `settleCaptionAuto`, `settleJoins`, `settleGrade` | `settleChapters` |
| Polish | `captionLook`, `smoothCuts` | `chapters`, after `captions`, before `captionLook` |
| `versions.ts` | Captions Studio areas (phase B), smooth cuts, colour, progress bar (wave 10) | `guide`; `clipOf` a recording field |
| Chapter names drawn in the video | wave 10's progress bar labels; step badges per chapter (`badgeLabels`, `callouts.ts`); phase B's chapter-title cards (`great.ts`) | found chapters feed the progress bar like any chapter; badges and *Auto* chapter titles count user chapters only (§7.7); removing a found chapter in Review also removes its pending chapter-title card |
| Step badges | `number: 'auto'`, `pin`, `badgeLabels` | guide steps from badges (§5.1 rule 11) |
| `playheadItems.ts` | wave 10 adds callout motions | `addShapeAt` gains `box` (§5.5.8) |
| `youtube.ts` | wave 10's music credit line | untouched |
| Settings | `CaptionDownloadsSection` (phase A), `MusicDownloadsSection` (wave 10) | `LocalAiSection` |
| Downloads | wave 10 §14.3 rules | the same rules (§16.6) |
| `exporter.ts` | wave 10's join feed | two exports only (§20.0) |
| Screenshots | wave 10's colour grade, magnifiers, crossfades | grade kept, magnifiers and crossfades dropped from the derived project (§5.5.2) |
| The shorter version | wave 10's smooth cuts | set on the copy when it has no cut style (§8.6) |
| Captions Studio runners | phase B's `requestId` and `cancelAiText` in `greatRun.ts`, `CleanupSection.tsx`, `LanguagesSection.tsx` | the same for the Captions tab's own tools and *Draft script*, and `LocalProgress` beside each (§20.0) |
| IPC names | `soundLibrary:*` | `guide:*`, `localAi:*`, `ai:listModels`, `ai:priceList`, `projects:detectScenes`, `projects:copyCost` |

---

## 22. Test plan

### 22.1 Unit tests (vitest). Each fails without the code of its rule.

Tests 1–100 keep their numbers from the first version, changed where the design changed; tests
101–141 are new. By owner: contracts 1–8, 33, the `sentenceName` cases of 39, and 101–104; P1 9–30
and 105–114; P2 31–48 and 115–121; P3 49–62 and 122–127; P4 63–80 and 128–131; P5 81–100 and
132–137; P6 138–141.

**Contracts and the guard** (§20.0)

1. **Migration**: the old fixtures (`tests/fixtures/vertical-old-projects.json`,
   `tests/fixtures/wave8-old-projects.json`, phase B's and wave 10's fixtures) migrate to the same keys
   and byte-equal JSON; no new key appears (`guide`, `clipOf`, `auto` on chapters, `host`); each new
   reader returns `undefined` for absent input and is idempotent.
2. **Readers**: `readChapterOrigin` keeps a valid origin (each `name`, `from` with `'section'` and
   `'ai'`) and drops one with an unknown `by`, no known `from`, a bad `host` (`"a b"`, 254
   characters, `"x/y"`), keeping the chapter; `readGuideSettings` cuts every string to
   `GUIDE_LIMITS`, keeps the last edit of a key, drops bad keys (`"x12"`, `"c-1"`), keeps `b123`,
   drops a `rect` 0.04 wide or past the frame and a `ring` at 1.2, clamps added steps' times and
   `actualAt`, reads `{}` as `undefined`; `readLinkUrl` takes `https://example.com/start` and refuses
   `http://…`, `javascript:alert(1)`, `https://user:pw@host/`, 301 characters; `readClipOrigin`
   refuses `start ≥ end`; `'short'` cut records survive `readAutoCuts`; `readJoins` keeps `by:
   'short'`; `pathLike` is true for `C:\Users\sam`, `\\nas\share`, `~/notes`, `/Users/sam` and
   `/home/sam`, false for "1/2", "and/or" and "Save/Export".
3. **Review unchanged**: for every fixture, `reviewItems`, `pendingCount`, `reviewStatus`,
   `keepItems` and `removeItems` give what they gave before the contracts (snapshots taken first).
4. **Versions**: `changedAreas` of every fixture pair is unchanged; a changed `guide` gives "guide";
   a changed `clipOf` gives nothing; a found chapter kept (only `auto` gone) gives "chapters".
5. **Prompts unchanged**: for every existing task (the `chapters` task included), `textPrompt` and
   `packPrompt` give byte-equal text with `DEFAULT_TEXT_LIMITS`; `textPrompts(request)` equals the
   prompts `runTextTask` sends with a fake `ask` that answers validly, batches included.
6. **The names task**: its schema uses only required properties and `additionalProperties: false`;
   `validateNamesAnswer` keeps known ids once each, trims to plain one-line text of 1–100 characters
   (chapters), 1–80 (steps, clips) or 1–300 (notes), refuses a `privateLike` answer, throws
   `AiOutputError` when none is left; `validateTextRequest` refuses 201 items, 1,501 characters in one,
   320,001 in all, a picture that is not JPEG, one of 512 KB + 1, a 51st picture in a request; it
   accepts a `names` request with `segments: []`; `runTextTask` splits 200 step items of 680
   characters into requests of at most 40 items and 12,000 characters.
7. **Key store untouched**: listing, testing and using providers and services leaves
   `ai-providers.json`'s bytes unchanged; saving an OpenAI provider writes the same fields as before.
8. **Routing**: `aiText('local', …)` reaches `localTextClient` without a key lookup (a stub records
   it), `aiText('svc…', …)` reaches `compatibleClient`; `EFFORT.names` is `'low'`; usage is summed
   into the result only when reported.

**P1 · Guides and demos**

9. Clicks, double-clicks (0.49 s and 3 px: one step; 0.51 s or 5 px at scale 1: two), drags (0.24 s
   held: a click; 0.26 s and 0.03 of the height: a drag with `to`), repeats ("3 times"), right and
   middle buttons, ignored and stray clicks gone, clicks in cuts gone.
10. Typing joins a click 4.9 s before it, not one 5.1 s before or with a click between; bursts 5.9 s
    apart join, 6.1 s do not; a 0.4 s lone burst is dropped; Enter 1.4 s after a burst joins it;
    keys inside a burst are not steps; "Press Tab 3 times".
11. A scroll session 9 s before a click adds "Scroll down, then" (lower-case continuation in Latin);
    one 11 s before is dropped.
12. A track with `valid: false` that keeps keys and typing gives its key and typing steps **and** one
    step per settled screen change of a fixture scan; a change 1.2 s after an Enter step adds none, one
    2 s after adds one; a valid track with no clicks does the same; nothing at all gives no steps.
13. Keys are stable: cutting a part of the video before a step, or adding one, leaves the other
    steps' keys and their edits in place; a step in a cut leaves the list and its edit stays.
14. **Privacy in shots**: `guideProject` keeps every blur and pixelate shape with its times, the crop
    and `grade`, and drops zooms, camera, captions, titles, graphics, texts, other shapes, spotlights,
    images, watermark, tilt, layouts, reframe, joins and the progress bar; the recording fake
    context's call log for a shot at a time inside a blur shape includes the blur's draw at the
    click's place.
15. `shotTime`: one frame before a click at 60 and 30 fps; the clip's start when that frame is cut;
    before typing; after typing with `after` (+0.2 s); a screen change +0.75 s; a badge at its start;
    the Actual shot at `actualAt`.
16. `shotRect`: 950 px wide at scale 1 and 1425 at 1.5 on 1920 and 2880 px frames; at least a third
    of the frame; centred and moved inside at the edges; a long drag widens it to the whole frame;
    `whole`; a stored `rect` wins; a click outside `project.crop` gives `outside` and the whole frame.
17. Ring colour: a brand colour with 3:1 on white is used, `#ffd400` (1.4:1) falls back to `#0060df`;
    ring sizes scale with the image width; a stored `ring` moves it; no ring for keys and screen
    changes.
18. Titles from narration (English): "so now click the Export button" at the click gives
    "Click “Export”" (`from: 'narration'`); "open Visual Studio Code" gives "“Visual Studio Code”";
    the nearest of two objects wins; an object that is a URL, a path, a stop word or "2024" is
    refused; a double-click and a repeat get their own verbs.
19. Titles in Bangla: "রপ্তানি বোতামে ক্লিক করুন" gives "“রপ্তানি”-এ ক্লিক করুন"; "Export-এ ক্লিক করুন" gives
    "“Export”-এ ক্লিক করুন"; Hindi "Export बटन पर क्लिक करें" gives the object "Export"; Bangla digits in
    "ধাপ ৩".
20. Fallbacks and their `from`: a text cursor gives "Click in the text field near …" (`'cursor'`), a
    hand "Click the link or button …"; a click in the bottom 48 px of a whole-screen recording at
    scale 1 gives the taskbar title, at 47 px above it not; thirds give the nine places (`'place'`);
    keys "Press Ctrl + S" (`'keys'`); `needsTitle` is true for `'cut'`, `'cursor'`, `'taskbar'`,
    `'place'` and `'template'` only.
21. `stepText`: the short note leaves out fillers, the earlier take of a retake and the title's
    sentence, keeps at most two whole sentences and 300 characters; with `full`, every kept word since
    the previous step, at most 1,000 characters ending at a sentence end; deleted and cut words out
    and bleeped words masked in both.
22. AI titles: `namesRequestForSteps` sends only unedited steps that have words, their action and 600
    characters of words, no screenshot or path; a returned title holding "example.com" or
    "C:\Users\sam" is dropped even when the words sent held it; `ai` is set and cleared by a hand edit;
    *Use offline titles* is one update.
23. Markdown: every CommonMark punctuation character in a title, *Type* line and note is escaped;
    `<b>` stays text; image names `step-01.png` … `step-12.png` and `actual.png`; the bug-report layout
    with Details; sections as `##` with steps as `###`; Bangla text unchanged.
24. **HTML safety**: titles, notes, *Type* lines, the end heading and label like
    `</script><script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `javascript:alert(1)`,
    U+2028, bidi controls and NUL give HTML with no `on…=` attribute, no URL but `data:` and at most
    the one end-screen link (whose `href` equals `readLinkUrl`'s output, escaped, with
    `rel="noopener noreferrer"`), exactly one `<script>` for a demo (none otherwise), whose SHA-256
    equals `DEMO_SCRIPT_HASH` and the CSP's; parsed with a strict HTML parser, every title is a text
    node equal to the input; the clipboard form has no script.
25. HTML structure: `lang` on `<html>`, a `<title>` equal to the guide's title, `dir="auto"` on
    titles, notes and callouts, one `<h1>`, an `<h2>` per step, `alt` on every image, the hotspot's
    `aria-label`, both colour schemes' text pairs at 4.5:1 or more (computed from the CSS constants).
26. Fonts: with Bangla text the HTML embeds Hind Siliguri 400 and 600 with the OFL notice; without,
    none; the print HTML never names a variable font family; the clipboard HTML embeds no font.
27. `printGuidePdf` (Electron mocked): the window has `sandbox: true`, `javascript: false`, no
    preload, the in-memory partition; the request filter allows only the temporary file and `data:`;
    the temporary file is `userData/tmp/guide-print/guide-*.html` and is deleted after success,
    failure and cancel; `sweepGuidePrint` removes leftovers at start; the options include
    `generateTaggedPDF` and `generateDocumentOutline`.
28. `guide:save`: a name with `\ / : * ? " < > |` or `CON` falls back to "Guide"; Markdown makes a new
    folder (" (2)" when taken); an image that is not PNG, JPEG or WebP, the 301st image, a 64 MB + 1
    HTML, and a payload of 256 MB + 1 in all (checked in the preload and in main) are refused; a saved
    PDF is remembered for `guide:showItem` and Share, a path it did not write is refused; a sender
    that is not the app's page is refused.
29. Guide edits: each `withStepEdit`, `withAddedStep`, `withGuideFields`, `withAiNotes` is one update
    and makes no `guide` key for a no-op; removing the last edit removes `guide`.
30. **Performance**: `findSteps` over 10,000 clicks, 2,000 keys and 500 bursts under 50 ms, and
    `typedBefore` over 200 steps under 5 ms (× 6 on CI).

**P2 · Chapters**

31. `parseSceneLog` reads blackframe and freezedetect lines of a saved log (the research recording),
    gives `changed` 62, 17, 7, 73 at the events and stills 0–5, 5–8, 8–11, 11–14 s.
32. `sceneScanArgs`: the crop filter as still detection writes it; `-skip_frame nokey` only at 60 fps
    and above; `fps=4` and no skip at 30, 25 and 24 fps.
33. (contracts) `screenChanges` on the fixture: the page change (62%) and the dialog (17%) are found,
    the menu (7%) and the panels (6%) are not, every scroll sample is not (it never settles, and the
    scroll guard); ≥ 30% is a page; the settle window is 1.0 s whatever the step (4 samples at
    0.25 s, 2 at 0.5 s).
34. The scan's cache key changes with the size, the time and the crop; `stopAnalyses` stops a scan
    and waits; a failed scan is not cached.
35. Candidates: a 2.0 s pause gives 1.5, 1.6 s gives 0.75, 1.4 s nothing; an input gap of 3 s gives 1;
    "now" at a sentence start gives 1, "moving on" and "ধাপ ২" give 2.5, in the middle nothing, a
    sentence with both counts 2.5; a user's lower-third card gives 4, a Captions Studio
    chapter-title card nothing; candidates 1.9 s apart merge with summed kinds, 2.1 s do not;
    snapping to a sentence start within 2 s.
36. TextTiling on a fixture of three topics of 300 words each finds two boundaries within one sentence
    of the true ones, each scoring at least 1.5.
37. `chooseBoundaries` equals a brute-force search on 200 random small inputs with the cost `c`; the
    first start at 0; every chapter at least `m`; at most `N`; only candidates above `c` chosen; fixed
    starts kept even closer than `m`; the tie rules.
38. Plans: 29 s gives `too-short`; no candidate above `c` gives `nothing`; user chapters every 40 s
    give `already`; a 2-chapter result is applied with `youtube: false`.
39. Names: a card wins; "Now let's set up billing, which takes a minute." gives "Set up billing"
    (`'sentence'`); "So, okay, first we open the settings page" gives "Open the settings page"; "Next
    we open settings" gives "Open settings"; a 9-word clause gives a phrase (`'phrase'`); a long one
    is cut to 40 graphemes at a word, never inside "ক্ষ" or "স্ত্র" (`'cut'`); a name with "example.com" or
    "C:\Users\sam" falls to the next source; a duplicate falls to the next; "Part 3" and "অংশ ৩"
    (`'number'`); the 0:00 chapter "Intro" / "শুরু". (The `sentenceName` and `cutName` cases are
    written in the contracts step.)
40. AI names: a valid answer replaces names with `name: 'ai'` and `via`; a name holding a link or a
    path keeps the offline name, also when that chapter's words held it; a chapter with no words is
    not sent.
41. `withFoundChapters`: one update; removes pending found chapters and their pending chapter-title
    cards, keeps user chapters; a second identical run returns the input project itself (ids and
    `auto` objects unchanged).
42. `settleChapters`: renaming or moving a found chapter drops `auto` in the same update; automation's
    updates (new `auto` objects) keep it; a project without found chapters returns `next` itself.
43. Review rows: title "Chapter “Set up billing” at 1:05" in video time, the detail words (with
    "keeping it restarts step numbers here" when auto badges exist), Keep drops `auto`, Remove deletes
    the chapter and its pending card, each one update; status after undo and redo; *Remove all found
    chapters*.
44. `projectSaid` and the Publish dialog's said set with a pending chapter named "see example.com" do
    not count it as said; after Keep they do.
45. Polish: saved options without `chapters` read `false`; new defaults `true`; skipped with user
    chapters ("Your chapters are kept"; pending found ones do not count and are replaced), under
    2 minutes, and without captions (`'no-speech'`); the step runs offline inside Polish's one update
    with `by: 'polish'`; polishing twice returns an equal project; `STEP_LABEL` and the dialog row
    exist.
46. The export note counts pending chapters; none, no note.
47. A silent recording with page changes gets chapters named "Intro", "Part 2", "Part 3"; screen
    changes with idle gaps alone give none at Normal and some at More.
48. **Performance**: planning a 1-hour fixture (600 sentences, 14,400 samples) under 200 ms, the DP
    under 50 ms (× 6 on CI).

**P3 · Short clips**

49. Sentence features on a fixture: density, key words, the user's marks (automatic marks do not
    count), statistics, actions, fillers; retake losers out; sentences under 3 words out; *Focus on*
    matches "billing" in "Billing's".
50. Candidates start at sentence starts after 0.3 s gaps and end at sentence ends; lengths stay within
    15–90 s (and the *Under 60 s*, *60–90 s* bounds) in viewing time on 2× clips.
51. Each score term: a question or a number or a UI verb first (+1), a 0.4 s gap after (+0.5),
    "as I said" first (−0.5), 31% empty (−1), 5 cuts in 30 s (−0.5); the length term peaks at 45 s.
52. Picks: overlap over 30% drops the weaker; `K` = 3 for 5 minutes, 10 for 30 minutes; a 44 s video
    gives `too-short`.
53. Reasons: at most 3 plus the length; the words of §8.2 ("Packed with information", "Important
    words", "Words you emphasised", "Mentions “billing”").
54. A silent fixture gives "Most action" moments between settled screen changes; a fixture with speech
    and no captions gives `needsCaptions` unless `activityOnly`.
55. `clipCopy`: clips cut to the moment by edit time (a 2× clip keeps its speed), freezes inside only,
    chapters and guide gone, name "<title> (clip)" within 120 characters, `clipOf` set; with
    `'vertical'` it equals `projectCopy(…, 'vertical')` in every field but those and the pending
    changes of §8.5 step 3.
56. `makeClipCopies` makes them one after another; Stop removes the one being made and keeps the
    finished; a refusal ("a copy is already being made") stops with that message.
57. `copyCost`: linked outside OneDrive, not inside (`OneDrive` set); bytes of the linked media;
    the panel blocks when `bytes × n + 64 MB > free`.
58. `planShort`: the total viewing time plus freezes stays within 60.00 s (and 30, 90); order kept;
    pads 0.15 / 0.25 s never cross the neighbour's midpoint; pieces 0.5 s apart join; one sentence per
    user chapter first; retakes and short sentences never chosen; under half the length gives
    `too-little`; a length at or above L gives `too-short`.
59. `shortCopy`: its records come from `recordAutoCuts` with `by: 'short'` and `was` equal to the
    original's kept pieces there; Review lists them as "Cut 4.2 s for the shorter version"; Remove
    brings back the stretch exactly (`takeBackSteps`).
60. `listProjects` gives `copyOf` and `clip`; *Made from this video* lists copies of this project only.
61. **Performance**: moments of a 1-hour fixture under 300 ms; `planShort` under 100 ms (× 6 on CI).
62. Bangla: a sentence ending in "?" or starting with "কীভাবে" is a hook; "যেমন বললাম" first refers back;
    titles cut by graphemes.

**P4 · AI on this PC**

63. The catalog: two entries, Apache-2.0, sizes, SHA-256 and full 40-character commits as §9.3, URLs on
    `huggingface.co` that `allowDownloadUrl` accepts, the mirror first when set.
64. `readHelperLine`: each event parses; an unknown `ev`, a line over 4 MB, a `text` over 256 KB, a
    non-object or bad JSON give `null` (the job ends).
65. `LlmEngine` with a fake helper: one request at a time, the second waits ("waiting"); cancel sends
    `cancel` and kills after 2,000 ms without `cancelled`; no line for 120 s kills it; idle 120 s
    unloads; a crash rejects the request and the next starts a new process; arguments are a list
    starting with `--low-priority --parent-pid <pid>`.
66. **The real helper** (`SSW_LLM_TEST_MODEL`, under wine on Linux CI and natively on Windows): loads a
    pinned model, answers a names request under the grammar with valid JSON, samples at most 2 ms a
    token under the largest task grammar, stops within 0.6 s when cancelled while reading a
    3,000-token prompt, exits when stdin closes mid-request, and, given every control and user-defined
    token string of its vocabulary in a `special: false` part, makes no control token from it.
67. `chatParts` and `chatPrompt`: for each pinned file, the joined parts equal the file's own chat
    template rendered for a sample with thinking off (saved fixtures: Gemma 4's `<|turn>system` …
    `<|turn>model\n`, Qwen3.5's `<|im_start|>` … `<think>\n\n</think>\n\n`); only template pieces are
    `special: true`; `breakSpecialTokens` breaks every string of the saved special-token lists in user
    text.
68. `schemaGrammar` for every task schema is accepted by llama.cpp's grammar parser (in test 66's run,
    or a saved parser check), forces `{` first, bounds strings with caps of 100 or fewer and no
    others, needs one item in `names`.
69. `localLimits` and `maxTokensFor`: 40 captions or 3,000 characters a batch; excerpts within 4,500
    tokens for English and Bangla (Qwen 2.04, Gemma 3.45 characters a token); prompt + `maxTokens` ≤
    8,128; an answer cut off is retried once with 1.5 times the room.
70. Licences, from fixtures: the README front matter of each pinned unsloth commit
    (`license: apache-2.0`, Gemma's `license_link`); the LICENSE of `Qwen/Qwen3.5-2B` @ `15852e8c…`
    (Apache-2.0); the README front matter of `google/gemma-4-E2B-it` @ `4adf1574…` and a saved copy of
    the Gemma 4 licence page (the Apache 2.0 text); the notice file names llama.cpp, ggml, the Mozilla
    Foundation, YaRN's authors, ggllm.cpp and the crates.
71. `downloadLocalModel` against a local server: resumes a `.part`, refuses a wrong hash (deletes it),
    checks free space first, refuses a host outside the list; a file of the wrong size or without
    `GGUF` is `damaged`; Remove while loaded unloads first.
72. Gates: no AVX2 gives `processor`; 7.2 GB total gives `memory` for Recommended, not Small; free
    memory under the peak refuses the run with §9.5's message; no helper gives `helper`.
73. `aiText('local')`: progress events reach the page that asked, by `requestId`, with `secondsLeft`;
    a run expected over 10 s is a long job of kind `'ai'`; a reload of the page cancels it.
74. `'chapters'` and `'marks'` with `'local'` are refused in main ("Not available on this PC");
    `useTextChoices` never offers On this PC for them, and `GreatOptions`' picker does not show it; the
    Captions tab's select (`'title'`) does, and its *Suggest chapters* with `'local'` runs Find
    chapters with local names.
75. Speeds blend 0.7 / 0.3 per model and survive a restart.
76. `LocalAiSection`: rows, blocks, Download → progress → *Use* → Remove, the suggestion by memory,
    the measured-speed line, the "could not check this PC's processor" line.
77. `useTextChoices` lists "On this PC (good for drafts)" only when a model is ready and usable; the
    task note shows beside it.
78. `verify-dist`: `ssw-llm.exe` imports only KERNEL32, ADVAPI32 and msvcrt (a fixture importing
    WS2_32 fails) and stays within `LLM_BUDGET`; a build without it passes with the section saying so.
79. Failures map to §9.9's messages.
80. Bangla through the grammar: a Bangla name with conjuncts and a "।" comes back intact.

**P5 · Any AI service and the cost**

81. `readBaseUrl`: `https://api.groq.com/openai/v1/` normalised; `http://localhost:11434/v1`,
    `http://127.0.0.5:1234/v1`, `http://[::1]:8080` allowed; `http://192.168.1.5:11434` refused;
    credentials, query and fragment refused; 301 characters refused; an internationalised host shown
    as `xn--`; `azureBaseUrl('my-res')`.
82. `ServiceStore`: its own file; keys encrypted; ids `svc…`; an empty key only for loopback; a new
    origin needs the key; at most 20 with the providers; a malformed entry dropped with a warning;
    `setJsonMode` saved; `keyForDraft` gives the stored key only for the same origin and kind.
83. Listing merges providers then services; an older `ai-providers.json` loads and saves unchanged.
84. `compatibleClient` against a local HTTPS server: Chat Completions with `json_schema`; a 400 drops
    to `json_object`, then to text with the answer read from the first `{`; the level is saved;
    validators reject a wrong shape; OpenRouter's `data_collection: 'deny'` is sent with
    `keepNoData`; `usage` reported.
85. **Redirects**: a 302 from the service to another origin fails ("unexpected redirect") and the
    other origin receives nothing; a request whose URL's origin is not the stored one is refused
    before sending.
86. `tlsGuard`: with `app.isPackaged`, `NODE_TLS_REJECT_UNAUTHORIZED=0` is removed before the first
    request and a self-signed server is refused; unpackaged it is left.
87. Redaction: `redactLine(line, roots, names, secrets)` turns a stored 20-character key into
    `<secret>`, the longer of two overlapping keys first; `https://user:pw@host/x` loses `user:pw`;
    the existing callers' arguments still work and the existing rules' tests pass.
88. Model lists from mock servers for each kind: filtering (no `tts-1`, `dall-e-3`,
    `text-embedding-3-small` in the text list; `whisper-1` in the transcription list); Gemini's
    `generateContent` filter; OpenRouter prices parsed from strings; 2,001 ids cut to 2,000; a 4 MB +
    1 body refused; 20 s timeout.
89. `parsePriceList`: the bundled file parses; negative, over 1,000, 2,001 entries, a bad date, and an
    `updated` two days ahead refuse the list; `priceOf` exact before prefix; the newer `updated` is
    shown; the refresh runs at most daily, only with automatic updates on, with `redirect: 'error'`
    and the 256 KB cap.
90. Tokens: English, Bangla, Hindi, Arabic, Japanese and mixed text give counts within 10% of the
    saved o200k, Qwen and Gemma counts of the research's samples; Claude counts are 1.3 times.
91. Output estimates per task as §11.3; thinking widens only the high end.
92. Text of each part of §11.5's table; the confirm at each `aiConfirm` value (a US$1.40 run asks at
    `'1'`, not at `'5'`; a US$0.05 run asks at `'always'`; nothing asks at `'never'`) and over
    10 minutes on this PC; Cancel focused.
93. Usage calibration: ratios blend and clamp to 0.5..2.0; no text in `ai-usage.json`; 200 entries.
94. Every action of §11.5's table has a cost tied by `aria-describedby` (rendered with a fake
    project and each provider type), and no hint in the text pickers names a place other than the
    choice's `place` (a Groq service shows "api.groq.com", On this PC "this PC", never "OpenAI" or
    "undefined").
95. `ProviderForm` with a service: *More services* and its hint; presets fill the URL; Azure's
    resource field; prices disclosure; "Your key and the text you send go to api.groq.com."; *Save and
    check* says "Works." or "Works; Flown checks its answers more closely." with the JSON level in
    its details line.
96. `ModelCombobox`: the ARIA 1.2 pattern (Down opens, Enter picks, Esc closes, free text kept),
    "Loaded 47 models", "price varies" for a router model.
97. Provenance: a translation through a service writes `by: 'openai'` and `host`; Languages says
    "translated with api.groq.com"; *Make my captions great*'s AI picks carry `host`; on this PC
    `by: 'local'` with the model's id ("translated on this PC"); chapters named or split through a
    service carry `host`.
98. A service test (`testAiProvider`) sends only the fixed probe, never project text.
99. The Publish queue runs one request at a time for On this PC and two for services.
100. **Performance**: an estimate for 20,000 captions under 20 ms, and memoised (× 6 on CI).

**Contracts, new**

101. **Pending chapters change nothing until kept**: a project with automatic badges and two pending
     found chapters keeps the badge labels it had without them; `resolveGreatOptions`' *Auto*
     chapter titles stay off for it and turn on after Keep; Polish with default options on an old
     project with step badges leaves every badge label unchanged and makes no chapter-title card.
102. **Every text tool can be followed and stopped**: each call site of `aiText` and `draftScript`
     (the Captions tab's tools, Clean up, Languages, *Make my captions great*, Publish, Draft script,
     Polish, Find chapters, the Guide panel, Short clips names) sends a `requestId`; `LocalProgress`
     is mounted beside each busy button; Stop reaches `cancelAiText` with that id, also for Draft
     script.
103. **Destinations**: with a Groq service chosen, no text in `CaptionsPanel`, `PublishDialog`,
     `LanguagesSection` or `DraftScript` says "OpenAI"; with On this PC, none says "undefined".
104. **Test hooks**: with `app.isPackaged`, `SSW_LLM_HELPER`, `SSW_TEXT_MODEL_TEST_CATALOG` and
     `SSW_PRICE_LIST_URL` are ignored (the built-in helper path, catalogue and URL are used);
     unpackaged they are read.

**P1, new**

105. `typedBefore`: on a fixture with typing at 21–23 s, a click at 24.5 s whose zoomed shot holds the
     typing place is marked for the typing step; the same click with a zoomed shot that excludes the
     place is not; a step after a settled page change at 26 s is not; a whole-screen key step before
     26 s is; without a scene scan every later shot holding the place is.
106. **Blurring from the panel**: *Blur an area…* makes a blur starting at `shotTime − 1/fps`, and
     `drawPrivacyLayer` at the step's shot time draws it (at 30 and 60 fps); *Blur the typed text*
     adds one shape from the burst's start to the next settled page change at the typing place, in
     one update, and the marked step's shot is made again with it.
107. Placeholders and *Write titles*: the line counts "need a title"; *Next step without a title*
     wraps; *Write titles* is disabled with "Nothing was said near these steps." when no step has
     words, and enabled again with *Also send the screenshots*; steps without words keep their
     offline titles after a run.
108. Notes: *Use everything I said* sets `full`; *Tidy notes* sends `kind: 'note'` with each step's
     full words and title, writes `textAi`, and a hand edit clears it.
109. **Demo layout** (`calloutPlace`): right of a hotspot at x 0.3, left of one at x 0.7, above or
     below when neither side has 336 px, the top-left corner without a hotspot, never over the hotspot;
     `demoZoom` gives the zoomed shot, its absence the whole screen; the end screen renders its heading,
     label and one link, and Start again.
110. *Copy guide* writes HTML with one PNG `data:` image a step (at most 1200 px wide) and plain text
     with the numbered titles; a 64 MB + 1 HTML is refused; *Copy screenshot* writes one PNG.
111. Steps from badges: badges with `number: 'auto'` give steps numbered by `badgeLabels`, a section
     heading where the labels start again at a chapter, keys `b<ms>`; the clicks between them are
     listed hidden and an included one is numbered "3.1"; a badge in a cut gives no step.
112. *Adjust*: Done stores `rect` and `ring` in one update; Reset removes them; a crop under 5% is
     refused; the keyboard moves the ring by 1% and 10%.
113. Bug report: Details lists the recording date, the size and scale, and the length, each
     removable and editable; *Show the screen at the playhead as Actual* stores `actualAt` and every
     format shows the Actual screenshot.
114. Brand kit: with a kit, the logo is in the header and the heading colour is the kit's first
     colour when it has 4.5:1 on that scheme's background, else the default; unticked, neither.

**P2, new**

115. The scene scan of a 25 fps import decodes with `fps=4` (no `-skip_frame`), its settle window is
     4 samples, and its dialog of 17% is found.
116. A user chapter at 0:03 stands in for the 0:00 start (no found chapter before it, `youtube:
     false`); one at 0:00 gives `youtube: true`; one at 0:25 in a 10-minute video does not stand in.
117. **One topic**: a 5-minute, one-topic narrated fixture of 60 sentences, a third of them starting
     with "now", "so" or "let's" after 2 s pauses, with no screen change, gives `nothing` at Normal;
     no TextTiling valley in it scores above 1; adding one page change and a "moving on" sentence
     gives exactly one split there.
118. Names: rule 2 takes up to 8 words after the clause cut; the phrase rule picks a run said in one
     sentence, never one that starts or ends with a stop word, and falls back to the most-said
     `uiObjects` object; `weakName` is true for `'cut'` and `'number'`; the run returns the first weak
     chapter for focus.
119. *Suggest chapters* through a service (mock): its starts become `'ai'` candidates of 3.5, the
     plan keeps YouTube's rules and user chapters, chosen AI starts take the AI's titles with `name:
     'ai'`, a suggested title holding a path falls back to the offline name; a later *Find chapters*
     replaces those pending chapters, and the reverse.
120. `speechHeard`: captions give `'captions'`; 12 s of detected speech without captions gives
     `'speech'`; 8 s gives `'none'`; no sound gives `'none'`; without the detector's ranges, activity
     minus typing decides; the Find chapters, Guide and Short clips messages follow it.
121. Polish's guard: on a project without captions the chapters step reports `'no-speech'` and adds
     nothing; on one with captions and only number names it adds nothing.

**P3, new**

122. **Clip copies keep only their own pending changes**: a clip copy of a project with silence cuts
     before, inside and after the moment keeps only the record inside; *Remove all* in the copy leaves
     its clips inside the moment; no outcome is recorded for the dropped records; a pending automatic
     zoom wholly outside the moment is no longer listed and one inside still is.
123. The shorter version: an original silence record inside a removed stretch is not in the copy; one
     inside a kept piece is, and is listed; a removed stretch of 70 kept pieces gives 2 records and
     2 rows.
124. Smooth cuts in the shorter version: an original without `joins.all` gives `joins.all = { kind:
     'smooth' }` and `joins.auto.by: 'short'`, listed as one row with the detail "Make a shorter
     version"; Remove restores no `joins`; an original with its own `joins.all` keeps it and has no
     row.
125. Panel and dialog: *Captions* sets `captions.show` and a vertical copy gets Auto style's look;
     lengths at or above the video's are disabled with "This video is already 52 s"; under 45 s the
     panel says "Too short for clips: post the whole video."; the menu item reads "Make a shorter
     version…".
126. *Play* in the panel plays the moment's range through `playStretch` and stops at its end, on a
     second press, or on Esc.
127. Entry points: the copy menu's label, tooltip and `aria-label` read "Copies: vertical, square,
     short clips"; the Publish dialog and the Export dialog's done view open the Short clips panel.

**P4, new**

128. Lifecycle with the real helper: started with `--parent-pid`, it exits within 2 s after that
     process is killed; it exits within 1 s when stdin closes in the middle of a request.
129. The processor comes only from `probedProcessor()`: `null` blocks with "Flown could not check this
     PC's processor"; `ssw-llm` is never spawned before a run.
130. *Use*: *Automatic* picks Recommended when it is ready and free memory is at least its peak,
     Small when memory is short or Recommended missing, and fails with §9.5's message when neither
     fits; a pinned choice is used as set.
131. Packaging: `ssw-llm.exe` is in a directory-form `extraResources` entry (no single-file `from`);
     `verify-dist` fails an unsigned helper in a signed build; `npm run notices -- --check` fails
     without the helper's crates; `NOTICE_NAMES` includes llama.cpp.

**P5, new**

132. Draft model lists: an existing service with an edited base URL and no key is refused with "Enter
     the API key for the new address." and the mock at the new address receives 0 requests; the same
     origin uses the stored key; a draft with its own key uses it.
133. OpenRouter prices: `"-1"` is unknown (line "Cost unknown for openrouter/auto: it picks a model
     for each request", never "under US$0.01"); `"0"`/`"0"` is "no cost"; a missing price is unknown;
     an unknown cost asks once per model in a session.
134. Price list safety: for the confirm, the higher of the bundled and downloaded prices is used; a
     downloaded 0 where the bundled list has a price is ignored; a Groq preset whose host was edited to
     another is priced as *Other address*; an Ollama preset on another port is not "no cost".
135. Error scrubbing: a mock service that echoes the key in a 400 body gives the renderer a message
     holding `<secret>` and not the key, for a service and for each built-in provider through
     `callWithRetry`.
136. The `aiConfirm` pref: its sanitiser turns anything else into `'1'`; Settings shows and saves the
     five choices.
137. The cost line for a group: the Captions tab's line names the place once and each action's cost;
     each button's `aria-describedby` reads its own short sentence; *Details* lists the model, the
     date and the token ranges.

**P6 · Titles from the screenshots**

138. `picturesToSend`: the guide's shots at most 768 px on the longer side as JPEG; steps marked
     *May show what you typed* unticked; unticked pictures are not sent.
139. Each client sends a picture in its API's form (OpenAI Responses `input_image`, Chat Completions
     `image_url`, Gemini `inline_data`, Claude `image`) to a mock server; a 400 naming the image gives
     "This model does not read pictures…".
140. `imageTokens` per provider rule; the cost line says "Sends 12 screenshots and about 300 words".
141. On this PC never offers *Also send the screenshots*; Cancel in the send viewer sends nothing (the
     mock counts 0 requests).

### 22.2 Equivalence guard for old projects

Tests 1, 3, 4, 5 and 101's old-project case are written in the contracts step against the code after
wave 10 has merged, before any shared file changes, in `tests/smartEquivalence.test.ts`. With the
earlier waves' guards (`verticalEquivalence.test.ts`, `captionsStudioEquivalence.test.ts`, wave 10's)
they must pass after every part merges. The snapshots are never regenerated to make a change pass.

### 22.3 End to end: `tests/e2e/smart-tools.e2e.cjs`

**Fixtures**:

- A 40 s, 60 fps screen recording made with ffmpeg from three solid "pages" (A 0–12 s, B 12–26 s,
  C 26–40 s) with a dialog box drawn over B at 18–20 s, a text field on B into which black text
  "hunter2" appears from 21.0 s, a moving cursor, and a red "SECRET" label on page A at the centre;
  a `cursor.json` with clicks at 3.0 (on the label's button area), 8.0 (a double-click), 16.5 (a
  drag, with no words near it), a click at 20.5 in the text field followed by typing 21.0–23.0, a click at 24.5 next to the
  field, Ctrl + S at 30.0 and Enter at 31.0; a transcript with "Now click the Export button" at
  2.2–3.4 s, "Next we open settings" at 12.4 s, "Finally save it" at 26.4–27.4 s.
- Projects: **Secret** (that recording, with a pixelate shape over the label from 0 to 12 s);
  **Silent** (the same video, no transcript, no sound); **Narrated3** (a 3-minute recording of six
  pages, 30 s each, with a 60-sentence transcript); **Old** (as 0.8 saved it).
- Local AI and services use the AI mock server of `ai.e2e.cjs`; AI on this PC uses a fake `ssw-llm`
  that answers fixed JSON, named by `SSW_LLM_HELPER`, and a catalogue entry for a small file on a
  local server, named by `SSW_TEXT_MODEL_TEST_CATALOG` (both read only unpackaged, test 104).

**Steps and assertions**

1. **Old project unchanged.** Open and close *Old*: `project.json` bytes unchanged; Review lists what
   it listed before; the Guide button and Find chapters are there.
2. **Steps.** Open the Guide panel on *Secret*: 7 steps (a click, a double-click, a drag, a click and
   type, a click, Ctrl + S, Enter), titles "Click “Export”", "Double-click near …", "Drag from … to
   …", "Click … and type", "Click near …", "Press Ctrl + S", "Press Enter"; the line reads "7 steps ·
   4 need a title · 1 may show typing". With the panel open, step 3's *Go to 0:16* moves the
   playhead to its shot time (the transport reads 0:16.48) and the timeline still takes a click.
   Keyboard only: Tab to the third step's title, type; Esc closes the panel and focus is on the
   Guide button; reopening keeps the edit; Ctrl+Z in the editor undoes it.
3. **Privacy in shots.** The first step's shot (read from the panel's image) has no red pixels where
   the label is (pixelated), while the video frame without the shape has them; the typing step's shot
   is taken before 21.0 s; step 5 is marked "May show what you typed in step 4"; *Blur the typed
   text* adds one shape (one undo step) and step 5's shot then has no black text pixels in the field;
   *Blur an area…* on step 1 makes a blur shape starting at 2.9667 s, one frame before the shot's
   2.9833 s, and step 1's shot is made again.
4. **Full size and checking.** Enter on step 5's screenshot opens the viewer with the image at its
   natural width; Esc returns focus to that button; *Check screenshots* starts at step 5; the first
   *Save PDF…* with unchecked shots asks with the counts; *Check now* opens the viewer.
5. **PDF.** Save as PDF into a temporary folder (the save dialog stubbed in main): the file starts
   with `%PDF`, `pdfinfo` reports tagged and a Title equal to the guide's title, the bytes hold no
   `guide-` temporary name, `pdftotext` gives the step titles in order, the document outline lists
   the steps, no network request was made by the print window, and `userData/tmp/guide-print/` is
   empty afterwards.
6. **Markdown.** Save as Markdown: a folder with `guide.md` and `images/step-01.png` … whose first
   lines are `# <title>` and `## 1. Click “Export”`; a bug report gives "Steps to reproduce",
   "Expected", "Actual" and "Details".
7. **HTML guide.** Save as HTML: opens in a plain Chromium page with scripts off and shows every step;
   no `<script>`.
8. **Demo.** With an end screen (heading, label, `https://example.com/start`), save the demo and open
   it in a new Electron window with network logging at 1280 px: 0 requests, 0 console errors; "Step 1
   of 7"; the first shot is the whole screen; the callout sits beside the hotspot; Right → 2, Left →
   1, End → 7, Home → 1; activating the hotspot goes to step 2 and focus is on step 2's hotspot; the
   live region reads the step; after the last step the end screen shows one link with
   `rel="noopener noreferrer"` and no request is made; under `prefers-reduced-motion` no animation
   runs. At 600 px the callout sits under the picture.
9. **Copy guide.** *Copy guide*: the clipboard (read in main) holds HTML with 7
   `<img src="data:image/png` and plain text with the 7 titles; the live region says "Copied the guide
   with 7 screenshots."
10. **Find chapters.** On *Secret*: chapters at 0:00, about 12.4 s and about 26.4 s, named "Click the
    Export button", "Open settings" and "Save it"; the notice "Found 3 chapters…"; Review lists 3
    rows; Remove one: gone and one undo step; Keep one: its "Found" chip goes; the copy pack's link
    check treats a pending name as not said.
11. **Silent chapters.** On *Silent*: chapters at 0:00, 12 s and 26 s named "Intro", "Part 2" and
    "Part 3", each with "Rename?" and focus on the first name; the scene scan is read once (a
    second run shows no progress).
12. **Suggest chapters.** On *Secret* with a mock service that suggests 0:00, 12.3 s and 26.2 s with
    titles: three found chapters with the mock's titles, Review details "Suggest chapters with
    127.0.0.1"; *Find chapters* afterwards replaces them.
13. **Short clips.** On *Narrated3*, open the panel from the Publish dialog's link: at least one moment
    with reasons; *Play clip 1* advances the transport inside the moment and Esc stops it; tick it,
    *Vertical*, *Captions* on; *Make 1 copy*: a new project in the library with `copyOf` and `clipOf`,
    9:16, its clips inside the moment, `captions.show` true, its Review listing no change outside the
    moment, the original's `project.json` unchanged; *Made from this video* lists it.
14. **Too short.** On *Secret* (40 s): the panel says "Too short for clips: post the whole video."; the
    shorter-version dialog disables 60 s and 90 s ("This video is already 40 s") and offers 30 s.
15. **Shorter version.** On *Narrated3*, 60 s: the copy's video is at most 60.0 s; its Review lists
    "Cut … for the shorter version" rows and one "Smooth cuts" row; Remove one cut brings back that
    stretch.
16. **AI on this PC.** The section downloads the test model (progress, then *Use* shows Automatic),
    Captions › Summarize offers "On this PC (good for drafts)" with "about … minutes" in its line;
    Summarize shows the progress line beside the button and the summary with "Written on this PC";
    Stop during a run ends it within 2 s.
17. **A service.** Add *Other address* at the mock server's address (`http://127.0.0.1:<port>/v1`,
    allowed on this PC) with a key: *Save and check* says "Works."; *Load models* fills the combobox;
    the base URL edited to a second mock's port with no key: *Load models* says "Enter the API key for
    the new address." and the second mock received nothing. Captions › Suggest a title shows "Sends
    about … words … to 127.0.0.1 · … cost unknown …"; the Captions tab's hint names 127.0.0.1, not
    OpenAI; with prices entered, "about US$…"; the title arrives; the log file holds the origin and
    never the key.
18. **Confirm.** With prices set high, a run passes US$1.00 and the click asks first; Cancel sends
    nothing (the mock counts requests); with *Always ask*, a cheap run asks too.
19. **Title bar at the minimum window size.** Every button is reachable and the Guide and Copies
    buttons' labels hide like the others.
20. **Bangla.** A Bangla transcript gives Bangla step words and digits in the panel, the PDF text
    copies out as the same Bangla (`pdftotext`), and a found chapter named from a Bangla sentence.

---

## 23. Later

1. **Data recorded while recording** (§0 decision 4), to agree with the other account:
   - `windows.json`: on each change of the foreground window and at each click, `{ t, exe, title }`
     (the program's file name and the window title, at most 200 characters). App switches become
     chapter candidates of score 4 (`planChapters`'s `apps`); a name may come from the program
     ("Excel") with the user's tick, never from a title until the user has seen it in Review.
   - `uia.json`: at mouse-down, Windows UI Automation's element under the point within 50 ms:
     `{ t, name, role }`, at most 80 characters; never the value of a text field, nothing from a
     password box. `stepTitle`'s `element` makes "Click the “Export” button".
2. **Reading the clicked label on this PC** (OCR, with F-07's work on screen text), and a small vision
   model on this PC (F-29; the pinned GGUF repositories ship vision projectors, but the helper is
   built without `mtmd`).
3. **Transcription through a service** (Groq's `whisper-large-v3` returns word times), with the
   provenance field it needs.
4. **A GPU pack** for AI on this PC (Vulkan, about 41 MB), a downloaded executable: needs the owner's
   decision and a Qbexel-signed build. **An SSE4.2 build** of the helper for PCs without AVX2 (about
   2 MB, §0 decision 1).
5. **One Downloads page** in Settings for speech models, caption downloads, music and text models
   (the rest of F-13).
6. **Copy for silent recordings** (`publish-pack.md:731`): the pack written from the guide's steps
   and the chapters.
7. **Autoplay** in the demo (a delay from the text's length, with a visible Pause, WCAG 2.2.2),
   **chapters as sections** of the demo, and a **Word** file of the guide.
8. **The compact transcript format** for local models (`12|0:53|text`), about half the reading time.
9. **Static instances of the Noto fonts** for PDFs on PCs without Windows' script fonts (installer
   growth; owner).
10. **Export the clips as a set**: one preset over every copy *Made from this video*, into one folder.
    The exporter draws from the open editor today; this needs exports of projects that are not open.
