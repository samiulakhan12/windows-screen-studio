# Auto-blur private information (F-07, LT-05): design

Plan: `docs/PLAN.md`, the last wave, "Auto-blur private information". Roadmap items F-07 (auto-blur
sensitive info) and LT-05 (redact passwords, emails, keys and names on screen and in what is said),
and the AI table row "Windows OCR for text" (`docs/ROADMAP.md`). Written against `rev/autoblur-design`
at `37f9355` (every wave through wave 12). Line numbers refer to that commit.

Flown finds passwords, emails, API keys and tokens, phone and card numbers, codes and the names the
user lists, on screen in a recording and in what is said. It suggests solid covers that follow the
text over time, and bleeps for what is said, for the user to review in Review mode. The user no
longer scrubs the video by hand. Everything runs on this PC.

This is the second version of this design. The first (2,899 lines, built in five parts and reviewed)
was lost before it was pushed. Only its record of the owner's answers, its measurements and its
review findings survived; §0 restates the answers, §19 maps every finding to the section that
prevents it. Every code fact below was checked again at `37f9355`, and every measurement was made
again for this version. This revision then took the product, engineering, security and lessons
reviews of the second version; §3.4 lists what they changed and where this design disagrees.

The rules of the earlier waves hold:

- **Preview and export draw the same frames.** Covers are filled into the screen picture inside
  `drawFramePicture` (`src/renderer/src/render/compositor.ts:147`), which the preview, every export,
  the export dialog's preview, thumbnails, join stills, freeze stills and guide shots all use (§8).
  Texts made from captions are masked in the same view of the project for the preview and every
  output (`privateView`, §7.5).
- **A covered region is unrecoverable in every output.** Covers are solid. They are filled into the
  screen picture after the crop and the colour grade, before anything samples it, and again on the
  output (§8, decision 3). Blur and pixelate were shown reversible (§3.2).
- **Every path that emits pixels or frames applies the covers or refuses plainly** (§9, one row per
  path).
- **The original recording files are never changed.** Covers live in `project.json`.
- **Old projects, settings and presets load, draw, sound and save byte for byte as before.** Every new
  field is optional and absent by default. The equivalence guard (test 20) is written first and
  committed alone (§16.0, §17.2).
- **One user action is one undo step** (§14).
- **Keyboard and screen reader** for everything (§11). WCAG AA with the tokens of
  `src/renderer/src/styles.css`.
- **Offline by default. Nothing leaves the PC without the user's explicit choice.** The only download
  is the text reader's model files, from Qbexel's Hugging Face mirror, pinned by size and SHA-256 and
  checked before use (§5.12, §10.2). Nothing in this work creates or uploads to that mirror.
- **Only models and libraries whose licences allow commercial redistribution in a Windows app**
  (§6.14 lists each licence and size).
- **New UI text goes into the catalogues** with keys and meta entries. The English guard and the
  scanner rules of `docs/design/output-and-languages.md` apply. Existing English does not change
  (§12).
- **The other account's files are not touched**: `src/main/recording/*`, `src/main/recordingIpc.ts`,
  `src/main/windows.ts`, `src/shared/recording/*`, `src/renderer/src/views/Toolbar.*`,
  `src/renderer/src/recorder/*`, `RecordingOptions.tsx`, `src/main/appSettings.ts` and `native/src`
  (with `native/Cargo.toml`). The design works from the recorded video and `cursor.json` alone. Data
  captured while recording (password boxes, windows) is the optional later `private.json` of
  decision 9 (§18).

The evidence is in the repository:

- `tests/fixtures/privacy-eval/`: the evaluation set. 24 lossless 1920×1080 PNG frames (3,470,088
  bytes), its truth file and the held-out set's, the PP-OCRv6 reads of both sets (tiny,
  careful-narrow and careful-long), and the text rules' 203 test vectors. Commits `79c1701` and
  `0f3a4d1`.
- `scripts/privacy/`: the generator (`make-eval-set.mjs`), the reader scorer (`score_reader.py`,
  `ppocr.py`, the stand-in `rules.py`), the tract parity check and skeleton, the careful-pass
  builder (`careful_long.py`, commit `89b95f0`), the text rules prototype with its full rule table
  (`detect/RULES.md`, `detect/rules.mjs`), the model pins (`reader-models.json`) and every result
  quoted here (`results/`). `scripts/privacy/README.md` says how to run each one.
- `scripts/privacy/bench-buckets.sh` and `decode-speed.sh` (commit `ce5572e`): the build time, run
  time and peak memory of the reader's fixed plan buckets (`results/tract-buckets.txt`), and what
  ffmpeg takes to decode a 1080p60 proxy for the look, follow and read passes
  (`results/decode-speed.txt`). §5.5 and §5.11 quote them.

The truth file, the reads and the score files are gzip-compressed, because they hold invented keys
and tokens in their real formats and GitHub's push protection would otherwise stop the push (§0,
question 15).

Measurements were made on 23 Nov 2026 on a shared machine (Intel Xeon 2.10 GHz, 4 vCPU, AVX2 and
AVX-512, 16 GB) while a setup job compiled beside them (load 1.4-6.2). Every reader ran on one thread.
Absolute times are inflated by perhaps 10-40%; ratios between configurations are the reliable part.

Terms used below:

- **Cover**: a solid box over the screen picture for a time range. Its box can move over time (a
  **path**). Stored in `Project.covers`.
- **Suggestion**: a cover or a bleep that Find made and the user has not kept yet. **Auto**: score
  0.85 or more. **Check**: 0.50 up to 0.85. Both are drawn; Check rows come first in Review.
- **Find**: *Find private info*, the scan of §5. **Find again**: a second scan of the same project.
- **Reader**: the text reader helper `ssw-ocr.exe` (`native/ocr`) with the PP-OCRv6 models.
- **Read**: one run of the reader on an area of one frame. **Line**: one text line a read returns:
  its box, its text and the x-range of each character.
- **Own span**: the characters of the secret itself in a line, never padded. **Cover box**: the own
  span's box padded (§6.1).
- **Look pass**: the cheap pass over every frame that finds where and when the screen changes and
  by how much it moved (§5.2). **Analysed frame**: a frame the look pass compares: every frame up
  to 30 fps, every second frame at 60 fps, every fourth at 120 fps (§5.2). **Source frame**: any
  frame of `screen.mp4`.
- **Lost area**: a cover over the whole area where text may be after Flown could not place it
  (§5.8).
- **Check read**: a small read a walk asks for, to prove that text was not yet on screen (§5.8).
- **Private item**: the unit every count of this feature uses: one Review row of found covers (a
  group), one cover the user drew, or one group of private bleeps (§2.12).
- **Private bleep**: a bleep over a secret said aloud. Its `word` holds a kind marker, never the
  word (§4.4).
- **Spoken forms**: the ways a private bleep's secret can appear in text made from captions (§7.3).

---

## 0. Decisions for the owner

**Decided by the owner on 17 November 2026: every recommendation of decisions 1-12 is accepted.**
They stand and are not asked again. Each is restated here as decided, with what this version
measured against it. Questions 13-19 are new and open, each with a recommendation; the build is
written so that every part can start before they are answered.

1. **DECIDED: which text reader, and the 5 MB line.** A bundled `ssw-ocr.exe` with tract compiled in.
   The PP-OCRv6 models are downloaded on demand from Qbexel's mirror (decision 10). Their exact bytes
   are fixed by the contracts step. Windows OCR is offered only after it passes decision 8. If the
   helper measures over 5 MB compressed, the owner chooses between tract and ONNX Runtime (+5.4 MB).
   *Measured again:*
   - PaddlePaddle itself publishes ONNX files for all six PP-OCRv6 models, Apache-2.0
     (`PaddlePaddle/PP-OCRv6_<tiny|small|medium>_<det|rec>_onnx`). Nothing is converted. Each ONNX
     repository carries the same `inference.json` and `inference.yml` git blobs as PaddlePaddle's
     official Paddle-format repository, and the graphs are named "PaddlePaddle Graph in PIR mode".
   - The shipped set is tiny det, tiny rec and small rec: **27,402,607 bytes** of models plus the two
     recognisers' `inference.yml` files (55,571 and 150,579 bytes, which hold the character lists of
     6,904 and 18,708 entries): **27,608,757 bytes** in all (§5.12).
   - tract-onnx 0.23.10 (MIT OR Apache-2.0) runs all six graphs with no unsupported operator, with
     `with_ignore_value_info(true)`. Its results match ONNX Runtime: detector boxes identical within
     1 px, every CTC step of 36 recognised lines the same (§5.6).
   - A MinGW skeleton with tract is **3,336,375 bytes** at brotli 11 (the mixed profile, §16.2), under
     the 5 MB line. tract stays; ONNX Runtime is not needed.
   - Windows OCR is built into the same helper as a second reader behind `WINDOWS_READER_ALLOWED =
     false` (§5.13), so decision 8's check can be run on the reference PC. Nothing offers it until
     that check passes.
2. **DECIDED: which detectors are on by default.** On: passwords and PINs; codes and QR codes (secret
   QR codes 0.99, any other 0.6); keys and tokens, including strong labels (0.75); tokens in links and
   webhooks; emails; card and bank numbers; phones (the PC's region, the UI language's region and up
   to 5 added); ID numbers with a label, plus SSN and NI formats; listed names; pop-up notifications
   in whole-screen recordings. Off: addresses, password dots, unlabelled random-looking strings. The
   panel says what Find does not see (§2.9). *Measured again:* unlabelled random strings gave 2,193
   false hits in 368,134 lines of text with nothing planted (1,940 of them on 5,000 hashes and
   UUIDs), the same order as the first version's 2,766 (§6.12).
3. **DECIDED: default redaction.** A solid cover filled into the screen picture after the crop and
   grade, before anything samples it, and again on the output. Its colour comes from a ring just
   outside the text, or Dark. Existing blur and pixelate items stay, with a note and a *Turn into a
   cover* button (§8).
4. **DECIDED: exports and timeline files that use the raw recordings.** *The original recordings* is
   refused whenever the project hides anything, in the dialog and in main. A saved preset that
   chooses it loads unchanged, and Export goes ahead without that step, with a notice. Redacted copies
   of the recordings come later. Older projects with blur or bleeps lose this choice too (confirmed
   with decision 4) (§9 row 10).
5. **DECIDED: older Flown versions opening a project with covers.** Every write of `project.json`
   (save, `writeProject`, copies, the version body; a rename keeps them) adds two `~cover:` shapes per
   drawn cover piece: a full-strength pixelate that never fades, and a filled opaque rectangle over
   it. This version drops them on load. The version hash and summary are computed without them. The
   remaining risk is stated: during the rectangle's 0.15 s fades and in an older Flown's guide
   screenshots, only the mosaic hides the text (§4.6).
6. **DECIDED: no AI vision pass**, neither to a service nor on this PC.
7. **DECIDED: spoken secrets.** On when the project has captions. Private bleeps mask every word under
   them. A translated caption is masked whole until it is translated again after Find. A settle step
   masks chapter names, the publishing pack and the guide, and every field of an AI request is masked.
   Transcribing with a service warns that the service will hear the secrets; the sound is not muted
   (§7). *Applied:* listening is on whenever the project has captions, and unchecked and disabled
   without them (§2.5). Question 19 asks whether the masking of stored texts may happen where they
   leave Flown instead of in the stored text; §7.5 is written for the recommended answer.
8. **DECIDED: checks before release.** Required: the shipped model bytes measured with the committed
   scorer; Windows OCR at 95% or more pattern recall and 99% or more padded coverage; the helper's
   speed, memory and size at 1080p, 4K and 7680×2160; the rendered tracking set (lists, zoom,
   selection, sticky header, window drag, toasts) with every planted item covered in every frame; 30
   real recordings (97% or more covered, nothing found ever shown); pop-up false hits at most one per
   10 minutes; and a native Bangla review. *Applied:* Windows OCR is measured by R10 on the reference
   PC (§5.13); the tracking set is A16 (§17.3); the Bangla review covers the spoken word lists, the
   Bangla label tables of `detect/tables.ts` and the `privacy` catalogue through
   `docs/design/output-and-languages.md` §15 (§12.4).
9. **DECIDED: the other account.** Ask now for an optional `private.json` holding password-box and
   text-field rectangles and focus, and each window's rectangle, visibility, z-order, process and
   title over time; never values. Its shape is in §18. This wave works without it.
10. **DECIDED: where the reader downloads from.** Qbexel's Hugging Face mirror, with the exact pinned
    bytes, the Apache-2.0 text and a NOTICE. A release blocker until it exists (`READER_MIRROR` is
    `null`, as `LOCAL_MODEL_MIRROR` is at `src/shared/localAi/catalog.ts:94`). PaddlePaddle is a
    second source only for a file it serves byte for byte as pinned, which every pinned file is
    today. Never ModelScope or RapidOCR.
11. **DECIDED: the Polish step.** *Find private info*, on for new options when the reader is
    downloaded. The runner gathers the scan after fetching that run's captions and passes it in
    `PolishInput.privacy`. Saved options read it as off (§2.10).
12. **DECIDED: the guide's blur buttons** add covers from now on. Their labels do not change; a new
    hint says the area is covered (§2.11).

New questions:

13. **OPEN: Home thumbnails and the crop.** Home thumbnails today draw a raw `screen.mp4` frame at
    min(1 s, 15%) with no crop, blur or pixelate (`src/renderer/src/views/Home.tsx:201-238`). This
    wave fills the covers and the blur and pixelate shapes active at that time as solid boxes (§9
    row 17). The crop is the user's other way of hiding part of the screen (a second monitor, a
    taskbar), and Home ignores it too.
    - (a) Also draw the thumbnail through the crop. Thumbnails of cropped projects change once.
    - (b) Leave the crop as it is.

    **Recommended: (a).** It is the same leak; the change is visible only on Home, never in an output.
14. **OPEN: the Windows Error Reporting exclusion.** A crash dump of `ssw-ocr.exe` would hold frame
    pixels with secrets, and Windows Error Reporting can upload it. Whatever the answer, the helper
    asks Windows to leave its heap out of any report (`WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP)`)
    and ends itself without a report on an unhandled exception (§10.5); both come from `kernel32`
    and change nothing outside the process. The question is whether to add the registry exclusion
    as well, for the crashes those two cannot catch.
    - (a) The installer writes `ssw-ocr.exe = 1` (DWORD) under `…\Windows Error Reporting\
      ExcludedApplications`: in `HKLM\SOFTWARE\Microsoft\Windows` for an install for all users, in
      `HKCU\Software\Microsoft\Windows` for an install for one user. The uninstaller removes it from
      the same place (§10.5).
    - (b) No registry change.

    **Recommended: (a).** It is one value named after Flown's own helper, written where the install
    is and removed on uninstall.
15. **OPEN: invented secrets in the repository.** The evaluation set's truth file, reads and scores
    hold invented keys in real formats. GitHub push protection is on for this public repository and
    would refuse them, so they are committed gzip-compressed with a `.gitignore` against unpacked
    copies (`scripts/privacy/README.md`). The other choice is to allow them through push protection
    on GitHub, case by case.
    **Recommended: keep them compressed.** Nothing real is in them; the compression is stated in the
    commit and the README.
16. **OPEN: the careful pass.** Measured on the main and held-out sets (§5.6): careful-narrow (re-read
    lines with a rule hit or confidence below 0.9) misses a mangled `github_pat_` key on the held-out
    set; careful (re-read 52% of lines) misses nothing but costs 1.95 s a frame; careful-long
    (careful-narrow plus any line holding 16 or more token characters) re-reads 30% of lines,
    misses nothing on either set and costs about 1.53 s a frame (ONNX Runtime, one thread).
    **Recommended: careful-long.** It is the configuration every number in §5.11 assumes.
17. **OPEN: three English texts that are now wrong about privacy.** The rule that existing English
    does not change is the owner's. These texts tell the user that blur and pixelate hide
    everything, which §3.2 shows is not so for text:
    - `text.shape.blur.title`, "Blur private content (always fully applied)", and
      `text.shape.pixelate.title`, "Pixelate private content (always fully applied)" (the add-shape
      buttons' tooltips, `src/shared/editor/itemNames.ts:23-24`);
    - `text.calloutSection.privacyNote`, "Blur and pixelate are fully on for their whole time, so
      nothing they hide shows." (`CalloutSection.tsx:23`).
    - (a) Change them, in one commit at integration that names this feature and re-records the
      English guard: "Blur (always fully applied; blurred text can sometimes be read back)",
      "Pixelate (always fully applied; pixelated text can sometimes be read back)", and "Blur and
      pixelate are fully on for their whole time. Text under them can sometimes be read back; a cover
      hides it completely."
    - (b) Leave them; the new note under the slider (§2.4) and the *Cover* tool beside *Blur* carry
      the warning.

    **Recommended: (a).** A privacy tool should not promise what it does not do. The build is written
    for (b) and works unchanged under (a); only the three messages change.
18. **OPEN: does a crop or a muted part count as "hiding" for decision 4?** *The original recordings*
    copies the whole uncropped `screen.mp4` and the unmuted sound. Decision 4 refuses it "whenever the
    project hides anything", which this design reads as a cover, a blur or pixelate shape, or a bleep
    (`hidesSomething`, §9 row 10).
    - (a) Also refuse it for a cropped project and for a project with muted parts.
    - (b) Not for those: a crop is usually framing (a taskbar, a second monitor's edge) and a muted
      part a cough; the choice is named *The original recordings* and copies exactly that.

    **Recommended: (b).** (a) would take the choice from most existing projects, which crop. Test 25
    is written for the answer given.
19. **OPEN: where decision 7's texts are masked.** Decision 7 has "a settle step" mask the spoken
    secrets' forms in chapter names, title cards, the publishing pack and the guide. A settle step
    rewrites text the user wrote, and *Uncover* on a private bleep that was a false hit cannot bring
    the words back. Example: the user says their support line aloud and also typed it into the saved
    YouTube description; Find bleeps it and the description becomes "•••-••••" for good.
    - (a) Mask where these texts leave Flown or are drawn, in one view of the project
      (`privateView`, §7.5): title cards and the chapter bar in the preview and every export, chapter
      metadata, sidecars, the pack's copy and share, guide outputs, AI requests, the search index.
      The stored text stays as the user wrote it, and uncovering a bleep brings every word back.
    - (b) Keep the settle step, and store each changed field's original text in the same update, so
      *Uncover* restores it in one undo step.

    **Recommended: (a).** It masks every place (b) masks, also in the preview, and never changes what
    the user typed. §7.5 and the contracts are written for (a); under (b) `settleSaid` returns, with
    `Project.privacy.originals`, in the same contracts item.

---

## 1. Summary

- **Covers in the editor.** A new *Private info* section at the top of the Shapes tab: *Add cover*
  (3 seconds, to the end, or the whole video), *Find private info…*, the number of private items
  and of suggestions to check, *Show where covers are* (a dashed outline in the editor only), and
  what Find does not see. A *Cover* tool sits beside *Blur* and *Pixelate*. A selected cover has its
  colour, its box, *Change the whole path*, *Start here* and *End here*, *Follow what is under it*,
  *Cover this text everywhere…*, *Keep it for the whole video*, *Keep covered* and *Uncover*. Several
  covers can be selected and edited together. Covers have their own row on the timeline, shown only
  when the project has covers. Blur and pixelate shapes get a note and *Turn into a cover*.
- **Find private info.** A dialog with the kinds to find (decision 2's defaults), names to hide, words
  never to hide, phone regions and *Also listen for secrets said aloud*. Find runs on this PC in the
  background while the user keeps editing: a look pass over every frame, reads of the areas that
  changed, the text rules, and following each found text through scrolls and moves until there is
  evidence it is gone. Its results land as suggestions in one undo step.
- **Review.** A new Review kind, *Private*. One row per text (all the places and times the same text
  showed in that run), each place a part of the row, Check rows first, filters per kind, *Keep
  covered* and *Uncover* per row, per place and for all of a kind (with a confirm), *Peek while
  reviewing* (V: see under the selected row's covers, magnified, in the preview only), *Listen*
  (hear a bleeped secret in the preview only) and *Done reviewing*.
- **Spoken secrets.** With captions, Find also listens: cards, codes, phones, IDs, passwords, emails
  and listed names said aloud become private bleeps. Their words are masked everywhere text is made
  from captions: captions, translations, subtitles, chapter names, the publishing pack, the guide,
  the search index and every AI request.
- **Every output** draws the covers: every export format, transparent and GIF, thumbnails, the export
  dialog's preview, guide screenshots, PDF, HTML and Markdown guides, short clips, the publish pack's
  copy, share, Home thumbnails, the filmstrip and the pictures sent to AI. *The original recordings*
  timeline mode is refused while the project hides anything.
- **Export note.** The export dialog says how many private items the video hides, how many are
  still to check, which blurred areas can be read back, whether Find has not checked the video or
  did not finish, and offers to wait for a running Find or stop it first. Copies made from the
  video before Find can take its covers.
- **Polish** gains *Find private info*. **Settings** gains *Private info*: the reader's download, the
  default kinds, names and never-hide lists for every video, phone regions and the colour of new
  covers.
- **Older Flown** opening a project with covers draws a pixelate and an opaque box over each cover.
- **Size**: the installer grows by about 3.5 MB (the helper). The reader's models, 27.6 MB, are
  downloaded on demand.

---

## 2. What the user sees

Every text below is a catalogue message in the new `privacy` namespace
(`src/shared/i18n/messages/en/privacy.json`, with a meta entry each in `privacy.meta.json`), unless
its key names another namespace. The contracts step writes all of them (§16.0). Plurals are ICU
messages; no sentence is made of pieces (the words rule, `scripts/i18n/config.json` `"words":
"fail"`). Times are shown with the editor's clock format (`fmt.clock`).

### 2.1 Shapes tab › Private info

A new section of the Shapes tab (`tab-shapes` in the English guard), right after the add-shape buttons
(*Add at playhead*) and before *Spotlight*, with the Cover section of §2.2 under it. It is always there,
so a project without covers shows it too (§12.2 lists the guard captures this adds to). This section
first put it at the top, above the shape buttons; that moves every existing element of `tab-shapes`,
which the English guard's compare mode refuses and `guard-delta` reports as old texts changed, so it
follows them (tried at integration and taken back).

| Key | English |
|---|---|
| `privacy.section.title` | Private info |
| `privacy.section.addCover` | Add cover |
| `privacy.section.addCoverMenu` | Choose how long the cover lasts |
| `privacy.cover.length.three` | For 3 seconds |
| `privacy.cover.length.toEnd` | To the end of the video |
| `privacy.cover.length.whole` | For the whole video |
| `privacy.section.find` | Find private info… |
| `privacy.section.count` | `{count, plural, one {{n} private item.} other {{n} private items.}}` |
| `privacy.section.toCheck` | `{count, plural, one {{n} to check.} other {{n} to check.}}` |
| `privacy.section.review` | Review |
| `privacy.section.readerMissing` | Find needs the text reader, a 27.6 MB download from Hugging Face. |
| `privacy.section.showCovers` | Show where covers are |
| `privacy.section.showCoversHint` | Draws a dashed outline around each cover in the editor only. Exports never show it. |
| `privacy.section.weak` | `{count, plural, one {{n} blurred or pixelated area can sometimes be read back.} other {{n} blurred or pixelated areas can sometimes be read back.}}` |
| `privacy.section.weakTurn` | Turn them all into covers |
| `privacy.section.notSee` | What Find does not see |
| `privacy.shape.cover` | Cover |
| `privacy.shape.cover.title` | Cover private content with a solid box |

- *Add cover* adds a cover at the playhead, for 3 seconds by default; its arrow opens the length menu,
  which remembers the last choice for the session. The new cover's box is 30% × 10% of the frame,
  centred where the cursor is at the playhead (or the frame's centre when the cursor is hidden or
  invalid), clipped to the frame. Its colour is picked from the paused frame (§8.4). It is selected.
  One undo step.
- The add-shape row of the Shapes tab (`ShapesPanel.tsx`, the `SHAPE_KINDS` buttons) gains a *Cover*
  button after *Pixelate* (`privacy.shape.cover`, tooltip `privacy.shape.cover.title`). It does what
  *Add cover* does, so the habit of reaching for *Blur* meets the safe choice beside it.
- *Find private info…* opens the dialog of §2.5. While Find runs, the section shows the progress line
  of §2.6 instead of the button.
- The count line counts private items (§2.12) and shows only when there is at least one. *Review*
  opens Review mode filtered to *Private*.
- *Show where covers are* (a checkbox, on by default, remembered in the preferences, §4.5) draws a
  1 px dashed outline in `--accent-400` around every active cover in the editor's preview only, so a
  cover the colour of its background still shows where it is (§8.5). It never reaches an output.
- The weak line shows when the project has blur or pixelate shapes. *Turn them all into covers*
  turns every one into a cover over the same box and times, in one undo step.
- *What Find does not see* is a disclosure button (`aria-expanded`) that opens §2.9's list.

### 2.2 A selected cover

Selecting a cover (on the timeline row, on the preview, or from Review) shows the *Cover* section
in the Shapes tab, below *Private info*, in place of the shape properties.

| Key | English |
|---|---|
| `privacy.cover.title` | Cover |
| `privacy.cover.colour` | Colour |
| `privacy.cover.colour.ring` | Match the background |
| `privacy.cover.colour.dark` | Dark |
| `privacy.cover.colour.light` | Light |
| `privacy.cover.colour.black` | Black |
| `privacy.cover.colour.white` | White |
| `privacy.cover.box` | Box at the playhead |
| `privacy.cover.box.left` | Left |
| `privacy.cover.box.top` | Top |
| `privacy.cover.box.width` | Width |
| `privacy.cover.box.height` | Height |
| `privacy.cover.wholePath` | Change the whole path |
| `privacy.cover.wholePathHint` | Moves and resizes the cover at every time, not only at the playhead. |
| `privacy.cover.startHere` | Start here |
| `privacy.cover.endHere` | End here |
| `privacy.cover.outside` | The playhead is outside this cover. |
| `privacy.cover.follow` | Follow what is under it |
| `privacy.cover.followHint` | Flown reads the text under the cover and moves the cover with it. |
| `privacy.cover.following` | Following… |
| `privacy.cover.followStop` | Stop |
| `privacy.cover.followDone` | The cover now follows the text from {start} to {end}. |
| `privacy.cover.followNone` | Flown found no text under this cover to follow. |
| `privacy.cover.everywhere` | Cover this text everywhere… |
| `privacy.cover.whole` | Keep it for the whole video |
| `privacy.cover.keep` | Keep covered |
| `privacy.cover.uncover` | Uncover |
| `privacy.cover.uncovered` | Uncovered. It will show in exports. |
| `privacy.cover.found` | Found by Find private info. |
| `privacy.cover.what` | What it hides |
| `privacy.cover.toCheck` | Check that this cover is needed and in the right place. |
| `privacy.cover.lost` | Flown could not tell where this text moved, so the cover hides the whole area it may be in. |
| `privacy.cover.missed` | The last Find did not find this text again. The cover stays until you uncover it. |
| `privacy.cover.thin` | Flown read this part of the video less often. Check that the cover is right. |
| `privacy.cover.timeKept` | This cover follows moving text, so it can't be moved in time. Drag its ends to change how long it lasts. |
| `privacy.cover.oneProject` | Covers paste only into the video they were copied from. |
| `privacy.cover.selected` | `{count, plural, one {{n} cover selected} other {{n} covers selected}}` |
| `privacy.cover.oneForBox` | Select one cover to change its box. |
| `privacy.cover.oneForFollow` | Select one cover to follow what is under it. |
| `privacy.cover.oneForEverywhere` | Select one cover to cover its text everywhere. |
| `privacy.weak.turnSelected` | `{count, plural, one {Turn {n} into a cover} other {Turn {n} into covers}}` |

- The box fields are percentages of the whole recorded frame, one decimal, with `NumberField`
  (`src/renderer/src/i18n/NumberField.tsx`). They show the box at the playhead.
- **Resizing applies to the whole path.** For a cover with more than one key, an edge handle drag
  moves that edge by the same amount at every key, and a *Width* or *Height* change moves the right
  or bottom edge by the same amount at every key. The most common fix, widening a cover because a
  character shows at its edge, so holds wherever the playhead is.
- **Moving follows *Change the whole path*.** Dragging the middle, and *Left* and *Top*, move the box
  from the playhead until the path's next key while the checkbox is off (the default), and at every
  key while it is on.
- On the preview the selected cover has eight handles (P1 `CoverHandles`). Covers are drawn solid in
  the editor too; the selection outline is drawn outside the box.
- *Start here* and *End here* set the cover's start or end to the playhead, holding the box there as
  `setCoverEnds` does. Each is one undo step, and both are in the palette with no default key
  (§2.15). They are disabled with `privacy.cover.outside` as their description when the playhead is
  outside the cover.
- *Follow what is under it* reads the text under the cover at the playhead and makes the cover a
  path that follows it (§5.9). Inside the time the walk reached, the followed path replaces the old
  box; the old box stays only where the walk was lost and outside that time. One undo step when it
  lands. *Stop* keeps the cover as it was.
- *Cover this text everywhere…* opens its own dialog (below, §5.9).
- *Keep it for the whole video* sets the cover's times to the whole recording, keeping its path (its
  first and last boxes held to the ends).
- *Keep covered* shows only on a suggestion; it makes the cover the user's. *Uncover* deletes the
  cover, says `privacy.cover.uncovered` in the status line, and remembers the removed path so Find
  again does not suggest the same kind on it (§5.10). Both read the same in Review (§2.7).
- A suggestion's lines show under the title: `privacy.cover.found`, then *What it hides* with the
  kind's title (`privacy.kind.<kind>.title`, "Email address") as a label and value, then `toCheck`,
  `lost`, `missed` and `thin` where they apply.

**Several covers selected** (Ctrl+click or Shift+click on bars or on the preview, or *Select on the
timeline* in Review, §2.7). The section's title reads `privacy.cover.selected`. Colour chips, *Keep
covered*, *Uncover*, *Keep it for the whole video*, nudging with the arrow keys and *Copy look* /
*Paste look* act on every selected cover in one undo step. The box fields, *Follow what is under it*
and *Cover this text everywhere…* are disabled, each with its reason (`oneForBox`, `oneForFollow`,
`oneForEverywhere`) as its description. Selected blur and pixelate shapes show
`privacy.weak.turnSelected`, which turns them all into covers in one undo step.

**Cover this text everywhere** (P1 `EverywhereDialog`, a modal dialog labelled by its title):

| Key | English |
|---|---|
| `privacy.everywhere.title` | Cover this text everywhere |
| `privacy.everywhere.body` | Flown reads the text under this cover, finds it wherever it shows in this video, and covers it there. |
| `privacy.everywhere.reading` | Reading the text under the cover… |
| `privacy.everywhere.noText` | Flown found no text under this cover. |
| `privacy.everywhere.needsReader` | This needs the text reader, a 27.6 MB download from Hugging Face. It runs on this PC. |
| `privacy.everywhere.remember` | Also add it to the names to hide |
| `privacy.everywhere.rememberNo` | No |
| `privacy.everywhere.rememberThis` | In this video. The text is saved in this video's project file. |
| `privacy.everywhere.rememberAll` | In every video. The text is saved in Flown's settings on this PC. |
| `privacy.everywhere.start` | Cover everywhere |
| `privacy.everywhere.done` | `{count, plural, =0 {The text was not found anywhere else.} one {Covered {n} more place.} other {Covered {n} more places.}}` |
| `privacy.everywhere.failed` | Flown could not cover this text everywhere. Try again, or cover its other places by hand. |

- On opening, the dialog asks main to read the text under the cover at the playhead (`underCover`,
  §5.9) and shows `reading`. Then it shows one of: `needsReader` with *Download*
  (`privacy.find.readerDownload`, the download's progress and failure lines of §2.5); `noText`; or
  the body, the estimate (`privacy.find.estimate`) and *Cover everywhere*.
- The *Also add it to the names to hide* choice (radio buttons, *No* checked) shows only when main
  says the text looks like a name (§5.9). A key, a password, a code or a number is never offered.
- While it runs, the dialog shows the progress line of §2.6 with *Stop*; *Stop* keeps what was found
  so far. Then `done` or `failed`.

### 2.3 The Covers row on the timeline

A row labelled *Covers* (`privacy.track.title`) between the Shapes row and the Images row. It shows
only when the project has at least one cover, so older projects' timelines do not change.

- Each cover is a bar from its start to its end. Suggestions waiting for review have a dashed edge;
  Check suggestions have the warning colour (`--warning`) on their edge; lost areas a hatched fill.
  Bars of the same group (§5.10) that overlap in time are drawn as one bar with a count badge.
- Clicking a group's bar selects every cover of the group; Ctrl+click toggles one cover in or out
  of the selection; Shift+click adds the bars between.
- Thin marks under a bar show where the path changes (each key), at most one mark every 4 px.
- Spans Find read less often (§5.4) are drawn under the row as hatched marks; each is an item of the
  row's roving focus (`privacy.track.thin`) and Enter seeks to its start.
- Keyboard: the row is one tab stop with roving focus (§11). Arrow keys move between bars, Enter
  selects, Delete uncovers, Shift+Arrow lengthens or shortens by one frame (only the ends; §2.2's
  time rule).
- Dragging a bar's ends changes its start or end (one undo step per drag). Dragging the middle of a
  bar moves it in time only for a cover with one key; a cover that follows text shows
  `privacy.cover.timeKept` in the status line instead.

| Key | English |
|---|---|
| `privacy.track.title` | Covers |
| `privacy.track.item` | `Cover, {kind}, {start} to {end}` |
| `privacy.track.itemCheck` | `Cover to check, {kind}, {start} to {end}` |
| `privacy.track.itemWaiting` | `Suggested cover, {kind}, {start} to {end}` |
| `privacy.track.itemMine` | `Cover, {start} to {end}` |
| `privacy.track.group` | `{count, plural, one {{n} place} other {{n} places}}` |
| `privacy.track.thin` | `Read less often, {start} to {end}` |

The bars' names are lists of fields (`{kind}` is `privacy.kind.<kind>.title`), not sentences
(§12.1).

### 2.4 Blur and pixelate: the note

Under the strength slider of a selected blur or pixelate shape (`ShapesPanel.tsx:226`), beside the
existing hint `text.shapesPanel.hidesWhatIsUnder` ("Hides what is under it for its whole time on
screen, also while the camera moves. The cursor stays visible on top."), a note and a button.

| Key | English |
|---|---|
| `privacy.weak.note` | Even fully on, blurred or pixelated text can sometimes be read back. A cover hides it completely. |
| `privacy.weak.turn` | Turn into a cover |

The note is worded to sit beside three existing texts that say blur and pixelate hide everything:
the add-shape tooltips `text.shape.blur.title` and `text.shape.pixelate.title` ("…private content
(always fully applied)", `itemNames.ts:23-24`) and `text.calloutSection.privacyNote` ("…so nothing they
hide shows.", `CalloutSection.tsx:23`). They stay unchanged unless the owner answers question 17 (a).

*Turn into a cover* replaces the shape with a cover over the same box and times (colour from the
paused frame, §8.4), in one undo step, and selects it.

### 2.5 Find private info

A modal dialog (`role="dialog"`, labelled by its title), opened from the section, the command
palette, Review's header and the export note.

| Key | English |
|---|---|
| `privacy.find.title` | Find private info |
| `privacy.find.intro` | Flown reads the text on screen, and what is said, on this PC. Nothing is sent anywhere. |
| `privacy.find.what` | What to find |
| `privacy.find.regions` | Phone numbers from: {regions} |
| `privacy.find.regionsChange` | Change… |
| `privacy.find.regionsTitle` | Phone numbers from |
| `privacy.find.regionsHint` | Numbers that start with + are found from every country. Choose up to 5 more. |
| `privacy.find.names` | Names to hide in this video |
| `privacy.find.namesHint` | One name or word per line. List each form you want hidden, like Jane Doe and Jane. A * at the start or end matches any letters there. |
| `privacy.find.neverHide` | Never hide |
| `privacy.find.neverHideHint` | Product names and other words Flown should leave visible, one per line. |
| `privacy.find.everyVideo` | Names and words from Settings are used too. |
| `privacy.find.listen` | Also listen for secrets said aloud |
| `privacy.find.listenHint` | Uses the captions. Secrets said aloud are bleeped and masked in captions and translations. |
| `privacy.find.listenNone` | Make captions first to listen for secrets said aloud. |
| `privacy.find.readerNone` | Find needs the text reader, a 27.6 MB download from Hugging Face. It runs on this PC. |
| `privacy.find.readerDownload` | Download |
| `privacy.find.readerProgress` | Downloading the text reader… {percent}% |
| `privacy.find.readerFailed` | The text reader could not be downloaded. {reason} |
| `privacy.find.readerRetry` | Try again |
| `privacy.find.estimate` | `{count, plural, =0 {Less than a minute on this PC. You can keep editing; keep this video open until Find ends.} one {About {n} minute on this PC. You can keep editing; keep this video open until Find ends.} other {About {n} minutes on this PC. You can keep editing; keep this video open until Find ends.}}` |
| `privacy.find.again` | Find again keeps every cover you have and adds what is new. |
| `privacy.find.start` | Find |
| `privacy.find.startAgain` | Find again |
| `privacy.find.cancel` | Cancel |

The kinds, in this order, each a checkbox with its default from decision 2:

| Kind | `privacy.kind.<kind>.label` | `privacy.kind.<kind>.title` | Default |
|---|---|---|---|
| `password` | Passwords and PINs | Password or PIN | on |
| `code` | Sign-in and recovery codes | Code | on |
| `qr` | QR codes | QR code | on |
| `key` | Keys and tokens | Key or token | on |
| `link` | Tokens in links and webhooks | Token in a link | on |
| `email` | Email addresses | Email address | on |
| `card` | Card and bank numbers | Card or bank number | on |
| `phone` | Phone numbers | Phone number | on |
| `id` | ID numbers | ID number | on |
| `name` | Names you list | Name | on (finds nothing until a name is listed) |
| `notice` | Notifications | Notification | on in whole-screen recordings; hidden for area and window recordings and for imported videos |
| `address` | Street addresses | Street address | off |
| `dots` | Password dots | Password dots | off |
| `random` | Random-looking text | Random-looking text | off |

`privacy.kind.notice.hint` describes the notifications kind under its checkbox: "The boxes that slide
in at a corner of the screen." A user cover has no kind; a cover made by *Cover this text everywhere*
has kind `text` (`privacy.kind.text.title`: "Text you chose"). The `.title` messages are standalone
noun phrases used as labels and list fields, never inside a sentence; sentences that name a kind
select on the kind's id (§12.1).

- The kinds, regions, lists and *listen* choice are remembered per project in `Project.privacy`
  (§4.3) and default from Settings (§2.14). *Listen* is on whenever the project has captions, unless
  the user unticked it for this project (`Project.privacy.listen: false`); Settings has no listen
  choice.
- Regions: the PC's region (`app.getSystemLocale()` region, read in main) and the UI language's region
  (`bn` → BD, `hi` → IN, `es` → ES, `en` → none) are always on; the user adds up to 5 in a list of
  every region the phone metadata knows, by country name.
- The estimate is §5.11's first estimate. It is replaced by a second one after the look pass (§2.6).
- *Listen* is unchecked and disabled with `privacy.find.listenNone` when the project has no
  captions.
- Without the reader the dialog shows `privacy.find.readerNone` and *Download*; *Find* stays enabled
  only for *listen* (spoken secrets need no reader), and then reads `privacy.find.start`.
- With another Find running in Flown (one at a time, §5.1), *Find* is disabled with `privacy.run.busy`
  as its description.

### 2.6 While Find runs, and when it ends

The Shapes tab's section and Review's header show one progress line (`role="status"`, polite,
announced at most every 10%). It shows in one place at a time, the one in front: Review's header
while Review is open (Review covers the Inspector, and so the section), and *Cover this text
everywhere*'s dialog over both; the result line likewise. Each is a live region, so two in the page
said every step and the result twice (§11 says it once): found end to end, where A10 met two result
lines after the section gained its own (`FindLine.tsx`, `lineShows`). Find runs in main at below-normal priority; the user keeps editing
this video. **One Find runs in Flown at a time** (§5.1): a second, for this video or another, is
refused with `privacy.run.busy`. Find belongs to the open editor: it stops when the editor closes,
and its results are applied only to the project and request that started it.

| Key | English |
|---|---|
| `privacy.run.look` | Looking for changes on screen… {percent}% |
| `privacy.run.read` | Reading text… {done} of {total} |
| `privacy.run.follow` | Following text… |
| `privacy.run.left` | `{count, plural, =0 {Less than a minute left.} one {About {n} minute left.} other {About {n} minutes left.}}` |
| `privacy.run.stop` | Stop |
| `privacy.run.waiting` | Find waits while Flown records. |
| `privacy.run.foundNone` | Find private info found nothing private. |
| `privacy.run.notSeeLink` | What Find does not see |
| `privacy.run.found` | `{count, plural, one {Found {n} private item.} other {Found {n} private items.}}` |
| `privacy.run.foundCheck` | `{count, plural, one {{n} of them is to check.} other {{n} of them are to check.}}` |
| `privacy.run.said` | `{count, plural, one {{n} was said aloud and is bleeped.} other {{n} were said aloud and are bleeped.}}` |
| `privacy.run.failedReads` | `{count, plural, one {Flown could not read {n} part of the video. It is covered until you check it.} other {Flown could not read {n} parts of the video. They are covered until you check them.}}` |
| `privacy.run.notFollowed` | `{count, plural, one {Flown could not follow {n} private item as it moved. It is covered to the end of the video until you check it.} other {Flown could not follow {n} private items as they moved. They are covered to the end of the video until you check them.}}` |
| `privacy.run.thinned` | `{count, plural, =0 {Flown read part of this video less often, so it may have missed text there.} one {Flown read {n} minute of this video less often, so it may have missed text there.} other {Flown read {n} minutes of this video less often, so it may have missed text there.}}` |
| `privacy.run.suppressed` | `{count, plural, one {{n} was not suggested again, because you uncovered the same kind there before.} other {{n} were not suggested again, because you uncovered the same kind there before.}}` |
| `privacy.run.saidFull` | Too many bleeps: some secrets said aloud could not be bleeped. Remove bleeps you do not need and find again. |
| `privacy.run.stopped` | Find stopped. What it found so far stays covered to the end of the video, because Flown did not finish following it. Review to trim them. |
| `privacy.run.busy` | Find private info is already running for a video. Wait for it, or stop it there. |
| `privacy.run.tooLarge` | This recording is too large for Find to read: more than 7680 × 4320 pixels. |
| `privacy.run.readerDamaged` | The text reader's files are damaged. Download them again. |
| `privacy.run.downloadAgain` | Download again |
| `privacy.run.failed.helper` | Find private info could not start the text reader on this PC. |
| `privacy.run.failed.video` | Find private info could not read this recording. |
| `privacy.run.failed.crashed` | The text reader stopped twice, so Find ended with what it had found. |
| `privacy.run.failed.other` | Find private info stopped because of a problem. |
| `privacy.run.openReview` | Review |
| `privacy.leave.body` | Find private info is still running. Leave and stop it? What it found so far is kept. |
| `privacy.leave.action` | Leave and stop |
| `main.jobs.privacyDone` | `{count, plural, =0 {Find private info is done: nothing to review.} one {Find private info is done: {n} to review.} other {Find private info is done: {n} to review.}}` |

- When results land, they are applied in one undo step (§14.1) and the line shows `found` (or
  `foundNone` followed by the link `notSeeLink`, which opens §2.9's list) with `foundCheck`, `said`,
  `failedReads`, `notFollowed`, `thinned` and `suppressed` as separate sentences when they apply, and
  *Review*.
- While a recording runs, the line shows `waiting` (§5.11).
- *Stop* ends the scan. What was found and followed so far is applied as one undo step. A cover whose
  following was not finished is extended to the end of the recording as a lost area over the place it
  was last seen, with its region (§5.10). Text that moved after the stop point can still show:
  `stopped` says to review, and the export note says Find did not finish (§2.12).
- **Leaving the editor while Find runs** (Home, opening another project, *Open the original*) asks
  first, inside the editor's `leave` (`Editor.tsx:570-591`) and through `askConfirm` as
  `editor.leave.unsaved` is asked: `privacy.leave.body` with the action `privacy.leave.action`; the
  default button keeps the editor open. Confirming stops Find, applies what it found as *Stop* does,
  then saves and leaves as today. **Closing Flown's window** tears the page down without that path
  (`Editor.tsx:1825-1840` saves synchronously); Find is stopped by `stopAnalyses`, what it found in
  this run is lost, and `privacy.find` is unchanged, so nothing claims the video was checked.
- When Flown's window does not have the focus as Find ends, Windows shows `main.jobs.privacyDone`
  (`notificationFor`, `src/shared/jobs/longJobs.ts:160`, gains this one case; analysis jobs show no
  notification today).
- A failed read never drops silently: its area becomes a lost area until the next good read there,
  and `failedReads` says so (§5.6).
- Nor does a failed walk (§5.8: the follow session's error, such as the helper dying mid-walk or
  refusing a session): each item of its span is covered from the last read of its place without it
  to the end of the video, over its region, the log names the error's kind (§10.6), and
  `notFollowed` says how many items (`FindResult.notFollowed`). Found end to end: a refused session
  turned every item into a lost area to the end with nothing said, and the video was blacked out. A
  Stop meanwhile is no failure; `stopped` says that.
- Failures name their cause in one whole sentence (`failed.helper`, `failed.video`,
  `failed.crashed`, `failed.other`, `tooLarge`, `readerDamaged` with *Download again*); none takes a
  raw reason string.

### 2.7 Review: private items

Review mode (`docs/design/review-mode.md`) gains the kind *Private* (`review.kind.private.*`), listed
before *Chapter*.

| Key | English |
|---|---|
| `review.kind.private.chip` | Private |
| `review.kind.private.name` | private item |
| `review.kind.private.all` | Uncover all private items |
| `review.kind.private.count` | `{count, plural, one {{n} private item} other {{n} private items}}` |
| `privacy.review.title` | `{kind} · {start}–{end}` |
| `privacy.review.where` | `{place, select, topLeft {Top left} top {Top} topRight {Top right} left {Left} centre {Middle} right {Right} bottomLeft {Bottom left} bottom {Bottom} other {Bottom right}} of the screen` |
| `privacy.review.places` | `{count, plural, one {{n} place} other {{n} places}}` |
| `privacy.review.area` | Covers {percent} of the screen for {time} |
| `privacy.review.place` | `{where} · {start}–{end}` |
| `privacy.review.check` | Check |
| `privacy.review.said` | Said aloud |
| `privacy.review.lost` | Covers an area |
| `privacy.review.missed` | Not found again |
| `privacy.review.thin` | Read less often here |
| `privacy.review.keep` | Keep covered |
| `privacy.review.uncover` | Uncover |
| `privacy.review.keepRow` | Keep covered: {title} |
| `privacy.review.uncoverRow` | Uncover: {title} |
| `privacy.review.uncovered` | Uncovered. It will show in exports. |
| `privacy.review.select` | Select on the timeline |
| `privacy.review.peek` | Peek |
| `privacy.review.peekRow` | Peek: {title} |
| `privacy.review.peekAll` | Peek while reviewing |
| `privacy.review.peekAllHint` | Shows what is under the selected row's covers, magnified, in the preview only. Key: V. |
| `privacy.review.listen` | Listen |
| `privacy.review.listenRow` | Listen: {title} |
| `privacy.review.filter` | Show |
| `privacy.review.filterAll` | All kinds |
| `privacy.review.keepKind` | `{kind, select, password {Keep all passwords and PINs covered} code {Keep all codes covered} qr {Keep all QR codes covered} key {Keep all keys and tokens covered} link {Keep all tokens in links covered} email {Keep all email addresses covered} card {Keep all card and bank numbers covered} phone {Keep all phone numbers covered} id {Keep all ID numbers covered} name {Keep all names covered} notice {Keep all notifications covered} address {Keep all street addresses covered} dots {Keep all password dots covered} random {Keep all random-looking text covered} text {Keep all text you chose covered} other {Keep all of this kind covered}}` |
| `privacy.review.uncoverKind` | `{kind, select, password {Uncover all passwords and PINs} code {Uncover all codes} qr {Uncover all QR codes} key {Uncover all keys and tokens} link {Uncover all tokens in links} email {Uncover all email addresses} card {Uncover all card and bank numbers} phone {Uncover all phone numbers} id {Uncover all ID numbers} name {Uncover all names} notice {Uncover all notifications} address {Uncover all street addresses} dots {Uncover all password dots} random {Uncover all random-looking text} text {Uncover all text you chose} other {Uncover all of this kind}}` |
| `privacy.review.uncoverConfirm` | `{count, plural, one {Uncover {n} private item? It will show in every export.} other {Uncover {n} private items? They will show in every export.}}` |
| `privacy.review.uncoverConfirmAction` | Uncover |
| `privacy.review.done` | Done reviewing |
| `privacy.review.doneConfirm` | `{count, plural, one {Keep the {n} cover still waiting?} other {Keep the {n} covers still waiting?}}` |
| `privacy.review.doneCheck` | `{count, plural, one {{n} of them is to check and has not been looked at.} other {{n} of them are to check and have not been looked at.}}` |
| `privacy.review.doneKeep` | Keep them |
| `privacy.review.emptyKind` | Nothing of this kind is waiting. |
| `privacy.review.findAgain` | Find again… |
| `privacy.review.unfinished` | Find private info did not finish: it read this video up to {time}. |

**One row per text.** A row is one group (§5.10): every place and time the same text showed in that
Find run, with its covers. Its title is the kind's title and the first start to the last end ("Email
address · 0:42–3:10"), then the place on screen of its first cover ("Top right of the screen"), the
number of places, and, when the row holds a lost area, the largest one's size and time
(`privacy.review.area`: "Covers 40% of the screen for 1:10"). A secret said aloud is a row of its
own: its private bleeps share a group (§4.4), and the screen's text never reaches the renderer to be
matched with it (D5).

**Places.** A row with more than one place shows Review's existing parts expansion
(`review.row.showParts` / `hideParts`, `ReviewPanel.tsx:985-1000`). Each place is a part: its title
(`privacy.review.place`: where on screen and its times), its badges, its own preview stretch, and its
own *Keep covered* and *Uncover*. So one wrong place, or one large lost area, can be checked and
decided without leaving Review. The row's own buttons act on every place.

**What is shown.** The screen's text is never shown in Review or anywhere in the UI outside the
preview's Peek: the user may be sharing their screen. Words said aloud are shown where the user
edits captions (the Captions and Transcript tabs) as today; every output and every other text made
from captions masks them (§7).

**Order.** Check rows first, then the rest, each by start time. `reviewItems` sorts every kind by time
(`src/shared/review/review.ts:108`), so the private order is applied by `ReviewPanel` (P5) to the rows
of kind `private` when the *Private* filter is on, and kept there; the list keys of Review
(`src/shared/review/keys.ts:17-27`) work as before on that order.

**Keep covered, Uncover.** The two row buttons read *Keep covered* and *Uncover* for private rows,
with the accessible names `keepRow` and `uncoverRow` and the acted line `uncovered`; Review's shared
*Keep* and *Remove* keys and messages are unchanged for every other kind. K and Delete act on private
rows as on others. *Keep covered* makes every cover and bleep of the row the user's; *Uncover*
deletes them and remembers the removed paths (§5.10). Each is one undo step. The kind filter
(`privacy.review.filter`, a select of the kinds present) narrows the list; with one kind shown, the
header has *Keep all … covered* and *Uncover all …* for it, each one whole message selecting on the
kind (§12.1). *Uncover all …* and `review.kind.private.all` ask first (`uncoverConfirm`, focus on
*Cancel*), keep a version, as *Remove all* does today (`ReviewPanel.tsx:398-405`), and run as one
undo step through `heldInSlices` (`src/shared/review/slices.ts:103`).

**Select on the timeline** (on each row) selects every cover of the row on the Covers row, for the
group edits of §2.2.

**Done reviewing.** In the header while private rows wait. It keeps every waiting private suggestion
in one undo step, after a confirm (`doneConfirm`, with `doneCheck` when Check rows are among them;
focus starts on *Cancel*). The export note's "still to check" line then goes away.

**Unfinished Find.** When the last Find stopped, failed reads or ended early (`FindRecord.stopped`,
`failed`, `readTo`, §4.1), the header shows `privacy.review.unfinished` with *Find again…*.

**Badges** on a row and on a place: *Check*, *Said aloud*, *Covers an area*, *Not found again*, *Read
less often here*.

**Preview.** Selecting a row seeks to its start and plays its stretch as Review does
(`src/shared/review/preview.ts:51-70`, 1.5 s before and after, at most 8 s), with the covers drawn.
Selecting a place plays that place's stretch. *Peek* and *Listen* are toggle buttons on the row, and
*Peek while reviewing* is a toggle in the header (§2.8).

### 2.8 Peek and Listen

- **Peek** (`aria-pressed`, accessible name `privacy.review.peekRow`) shows the row's covers as 2 px
  outlines in the accent colour, so the user sees what is under them, in the editor's preview only.
  The command *Peek under covers* does the same for every cover while it is on.
- **Peek while reviewing** (a toggle in the private Review header, `aria-pressed`, tooltip
  `privacy.review.peekAllHint`) stays on while the user moves through the rows: the selected row is
  peeked, then the next one when N or ↓ moves on. V in the list turns it on and off (`keys.ts`
  gains the action `peek` for V, given only when the selected row is of kind `private`, so V goes on
  to the editor everywhere else as today; V has no editor shortcut). A keyboard pass over 200 rows
  is N, look, K or Delete, with no mouse and no pressing of Peek again. While it is on, moving to a
  private row (N, P, ↑, ↓, K and Delete moving on, a click, V turning it on) holds the playhead still
  inside the row's earliest cover that the edit shows, half a frame after its start (`peekStill`),
  instead of playing the row's stretch: the magnified view is drawn from the frame at the playhead,
  so it shows the row only there (K moves on without seeking, and a stretch ends 1.5 s after the
  row). Space on the row plays its stretch. *Peek* on a row holds the playhead inside that row the
  same way.
- **The magnified view.** While a row is peeked, a panel under the banner shows the selected
  cover's area at the playhead from the raw frame, cut with a margin of half its height and drawn at
  twice the preview's scale (at least 2×, at most 8×, and never past the recording's own pixels), so
  text 12 px high in a 1080p frame is readable in a small preview. It is a preview-only canvas
  (`aria-label` `privacy.peek.inset`), never in an output, the export dialog's preview, a thumbnail
  or a guide shot (§8.5).
- A banner sits over the preview while anything is peeked:

  | Key | English |
  |---|---|
  | `privacy.peek.banner` | Peeking under covers. Exports still cover them. |
  | `privacy.peek.stop` | Stop peeking |
  | `privacy.peek.inset` | Magnified view of what is under the cover |

- **Listen** (`aria-pressed`, accessible name `privacy.review.listenRow`, on rows with a bleep) plays
  that bleep's original sound in the preview only.
- Peek and Listen are cleared when Review closes, when the project closes, before any export or
  guide shot starts, and after 60 s without input. They never reach an export, the export dialog's
  preview, a thumbnail, a guide shot, a join still kept for export or the AI (§8.6, §9).

### 2.9 What Find does not see

The disclosure of §2.1 and the dialog's footer list, one message each (`privacy.notSee.*`):

| Key | English |
|---|---|
| `privacy.notSee.scripts` | Text in Bangla, Hindi, Arabic or other scripts the reader does not know. |
| `privacy.notSee.small` | Text smaller than about 9 pixels high, or blurred by motion. |
| `privacy.notSee.names` | People's and company names, unless you list them. |
| `privacy.notSee.brief` | Text that is on screen for less than about a second, like a page you scroll past quickly. |
| `privacy.notSee.unlabelled` | Codes and passwords shown with no label near them, like an authenticator app's codes. |
| `privacy.notSee.pictures` | Text inside pictures and videos shown on screen, handwriting, and faces. |
| `privacy.notSee.added` | Images you add and the camera. Covers hide parts of the screen recording only. |
| `privacy.notSee.off` | Kinds that are off: street addresses, password dots and random-looking text. |
| `privacy.notSee.said` | Secrets said aloud when the video has no captions, or that the captions got wrong. |
| `privacy.notSee.length` | A cover can still show roughly how long the hidden text is. |
| `privacy.notSee.folder` | The project folder on this PC keeps the original recording, without covers. |
| `privacy.notSee.check` | Always watch the video before you share it. |

The names hint of the Find dialog (§2.5) says how to list the people and companies a recording shows.

### 2.10 Polish

`PolishDialog.tsx` gains the row *Find private info* (`review.polish.step.privacy`, "Find private
info") after *Camera director*, only when the reader is downloaded. Its hint names the time:
`review.polish.hint.privacy`: `{count, plural, =0 {Covers passwords, keys, codes and other private
text, and bleeps secrets said aloud. Less than a minute on this PC.} one {Covers passwords, keys,
codes and other private text, and bleeps secrets said aloud. About {n} minute on this PC.} other
{Covers passwords, keys, codes and other private text, and bleeps secrets said aloud. About {n}
minutes on this PC.}}`, with §5.11's first estimate. When this project's last Find already read the
whole screen with the same kinds and reader (`privacy.find`, not stopped, with no failed reads), the
hint is `review.polish.hint.privacyChecked`
("Already checked on screen. Listens to the new captions for secrets said aloud.") and Polish only
listens (§14.5).

It is on in `DEFAULT_POLISH_OPTIONS` and read as off from saved options (`readPolishOptions`,
`src/shared/editor/polish.ts:393`), like every step added after options were saved. While it runs,
Polish's progress shows Find's phase lines (`privacy.run.look`, `read`, `follow`). Its result line in
Polish's summary follows the other steps' style ("Smooth cuts at 4 cuts"):

- `review.polish.result.privacy`: `{count, plural, =0 {Find private info: nothing private found}
  one {Find private info: {n} private item} other {Find private info: {n} private items}}`;
- `review.polish.result.privacyCheck`: `{count, plural, one {Find private info: {n} private item ·
  {check} to check in Review} other {Find private info: {n} private items · {check} to check in
  Review}}` (`check` formatted by `fmt.count`);
- `review.polish.result.privacyListened`: "Find private info: already checked on screen; listened to
  the new captions";
- `review.polish.result.privacyUnfinished`: "Find private info did not finish. Find again before you
  share the video." when it stopped, failed reads or ended early.

Without the reader the step is skipped with `review.polish.skip.noReader` ("The text reader is not
downloaded.").

### 2.11 The guide

*Blur an area…* and *Blur the typed text* (`GuidePanel`, `guideRun.ts:231`, `:246`) keep their labels
and now add a cover over the box and times the blur shape had, in one update, coloured from the
step's own shot frame (§8.4). A hint under them (`privacy.guide.covered`): "The area is covered with a
solid box in the video and in every screenshot." Blur shapes made before stay as they are.

The shot viewer shows `privacy.guide.notChecked` ("Find private info has not checked this video.")
above *Also send the screenshots* when that is ticked and the project has never been through Find,
and `privacy.guide.unfinished` ("Find private info did not finish on this video. Find again before
you send the screenshots.") when the last Find stopped, failed reads or ended early. With the reader
downloaded, the guide's save and copy area (PDF, HTML, Markdown, copy) shows the same two lines,
each with *Find…* (`privacy.export.find`), so the guide's outputs are not silent either.

### 2.12 The export dialog

**What is counted.** One unit everywhere: a **private item** is one Review group of found covers,
one cover the user drew, or one group of private bleeps (`privateItems`, §16.0). The *Private info*
section, Find's result, Review's count, the export note and Polish all count it, so their numbers
agree. Ordinary bleeps (swear words) are not private items. Blur and pixelate shapes are not counted
as hidden: they have their own line, because §3.2 shows they can be read back.

A note above *Export* (P5 `PrivacyExportNote`). It shows only when one of its lines applies, so the
dialog of a project without covers, private bleeps or privacy shapes, opened by a user who never
downloaded the reader, is unchanged.

| Key | English |
|---|---|
| `privacy.export.hides` | `{count, plural, one {This video hides {n} private item.} other {This video hides {n} private items.}}` |
| `privacy.export.toCheck` | `{count, plural, one {{n} is still to check.} other {{n} are still to check.}}` |
| `privacy.export.review` | Review |
| `privacy.export.weak` | `{count, plural, one {{n} blurred or pixelated area can sometimes be read back.} other {{n} blurred or pixelated areas can sometimes be read back.}}` |
| `privacy.export.weakTurn` | Turn them all into covers |
| `privacy.export.notChecked` | Find private info has not checked this video. |
| `privacy.export.find` | Find… |
| `privacy.export.unfinished` | Find private info did not finish: it read this video up to {time}. Find again before you share it. |
| `privacy.export.thinned` | `{count, plural, =0 {Find read part of this video less often, so it may have missed text there.} one {Find read {n} minute of this video less often, so it may have missed text there.} other {Find read {n} minutes of this video less often, so it may have missed text there.}}` |
| `privacy.export.saidRemoved` | `{count, plural, one {{n} secret said aloud is no longer bleeped.} other {{n} secrets said aloud are no longer bleeped.}}` |
| `privacy.export.running` | Find private info is still running. This export does not include what it is finding. Wait for Find, or stop it to cover what it found so far. |
| `privacy.export.wait` | Wait for Find |
| `privacy.export.stopAndExport` | Stop Find and export |
| `privacy.export.captionsChanged` | The captions changed after Find listened to them. Find again to check what is said. |
| `privacy.export.findAgain` | Find again… |
| `privacy.export.fromOriginal` | The video this was made from has covers this copy does not have. |
| `privacy.export.bringOver` | Bring them over |
| `privacy.export.recordingsOff` | The original recordings are not saved while this video hides something. |
| `privacy.export.recordingsSkipped` | The timeline was not saved: it used the original recordings, and this video hides parts of them. |

- `hides` shows when there is at least one private item, with `toCheck` when suggestions wait.
- `weak` shows when the project has blur or pixelate shapes; *Turn them all into covers* turns them
  into covers in one undo step, as in the *Private info* section (§2.1).
- `notChecked` shows when the reader is downloaded (the user has opted into the feature) and the
  project has no `privacy.find`. Users without the reader see no change.
- `unfinished` shows when the last Find stopped, failed reads or ended early (`FindRecord.stopped`,
  `failed`, `readTo`), with `{time}` its `readTo`. `thinned` repeats Find's line from
  `FindRecord.thin`. `saidRemoved` shows when private bleeps Find made (`FindRecord.saidIds`) are gone,
  for example removed by an older Flown.
- `running` shows while Find runs for this video, with two buttons. *Wait for Find* keeps the dialog
  open with *Export* disabled until Find ends and its results are applied. *Stop Find and export*
  stops Find, applies what it found as one undo step (the *Stop* path of §5.10), then exports. An
  export never starts while Find runs without one of these.
- `fromOriginal` shows on a copy (`copyOf`) whose original has covers or private bleeps this copy
  lacks (main compares, §5.10). *Bring them over* adds them as suggestions in one undo step.
- *Review*, *Find…*, *Find again…* and *Bring them over* close the dialog first and then open Review
  or the Find dialog (finding 30).
- In *Also save › Timeline*, the *Uses: The original recordings* choice is disabled with
  `privacy.export.recordingsOff` as its description while `hidesSomething` (§9 row 10); that line is
  driven by `hidesSomething` alone, not by the count above. A preset or saved bundle choice of *The
  original recordings* loads unchanged; Export goes ahead and the done view lists
  `privacy.export.recordingsSkipped`.

**Copies made before Find.** Short clips, vertical and square versions, Duplicate and shorter
versions are separate projects on the same recording (`copyOf`, `clipOf`). After Find, and after
*Keep covered* or *Done reviewing*, on a project that has copies, Find's result line (in the Private
info section, or in Review's header while Review covers it, §2.6) and Review's header offer:

| Key | English |
|---|---|
| `privacy.copies.offer` | `{count, plural, one {Also cover the copy made from this video} other {Also cover the {n} copies made from this video}}` |
| `privacy.copies.done` | `{count, plural, one {Covered the copy made from this video. Its covers wait in its Review.} other {Covered the {n} copies made from this video. Their covers wait in their Review.}}` |

It adds this video's covers and private bleeps to each copy, as suggestions, through main (§5.10),
which reads this project from its `project.json`, so the offer first has the editor's saver write it
(Review gets the saver's flush from the editor, the Private info section through the Inspector).
Covers are in source seconds of the shared `screen.mp4`, so they are copied as they are.

### 2.13 Captions, translations and transcription

- **Captions tab** (Languages section, `LanguagesSection.tsx`): a translation with private bleeps not
  yet translated again shows `privacy.translated.masked`: "Captions over secrets said aloud show as
  •••• in this language until you translate it again." The existing line "Bleeped words are not
  masked in translations" (`captionTracks.ts:205`) stays as it is; it is about ordinary bleeps.
  That row's *Translate again* is how it is translated again: it is enabled while any of its captions
  shows as ••••, though their spoken text did not change, and sends them (masked, §7.6) with any that
  changed or are missing (`captionsToTranslate`, §7.4). Its tooltip then is
  `privacy.translated.again`: "Translates the captions that show as •••• again, from the masked text,
  and any that changed or are missing". *Add a language* does not offer a language that has a track.
- **Transcribe with a service** (the transcription choices): when *Find private info* has run with
  *listen*, or the project has private bleeps, `privacy.transcribe.hears`: "The service hears
  everything said in the video, secrets too. Bleeps apply only to what Flown makes from it." The
  sound is not muted (decision 7).
- **Publishing pack** (`PublishDialog.tsx`): the dialog shows the stored text the user edits; when a
  spoken secret's form is in it, `privacy.publish.masked` says "Secrets said aloud show as •••• when
  this text is copied, saved or shared." Copy, the sidecar description and share post the masked
  text (§7.5).
- Private bleeps have no list of their own in the Captions tab (it has none at `37f9355`); they are
  Review rows (§2.7).

### 2.14 Settings › Private info

A new section in Settings. Settings has no navigation: its sections are stacked children of
`.settings-body` (`src/renderer/src/settings/SettingsDialog.tsx:57-69`). `PrivacySettings` is placed
after `LocalAiSection`, with its own heading `privacy.settings.title` ("Private info"), and
`SettingsSection` gains `'privacy'` (`:22`) so the palette and *Find private info…*'s reader line can
open Settings scrolled to it (`reveal`, as `LocalAiSection` does). The English guard's
`settings-NN` captures are numbered by child index (`tests/e2e/uiTour.cjs:427-435`), so the sections
after it shift by one; §12.2 says how the guard check aligns them.

| Key | English |
|---|---|
| `privacy.settings.title` | Private info |
| `privacy.settings.reader` | Text reader |
| `privacy.settings.readerAbout` | Reads text on screen on this PC: PaddlePaddle's PP-OCRv6 models (Apache-2.0), a 27.6 MB download from Hugging Face (Qbexel's copy, or PaddlePaddle's own files). |
| `privacy.settings.readerReady` | Downloaded. |
| `privacy.settings.readerNone` | Not downloaded. |
| `privacy.settings.readerDamaged` | The downloaded files are damaged. Download them again. |
| `privacy.settings.download` | Download |
| `privacy.settings.cancel` | Cancel |
| `privacy.settings.remove` | Remove |
| `privacy.settings.kinds` | What Find looks for in a new video |
| `privacy.settings.names` | Names to hide in every video |
| `privacy.settings.neverHide` | Words never to hide in any video |
| `privacy.settings.regions` | Phone numbers from |
| `privacy.settings.colour` | Colour of new covers |
| `privacy.settings.withPolish` | Polish finds private info when this is on in its options. |
| `privacy.settings.unavailable.helper` | The text reader cannot run on this PC. Flown's installation may be damaged; installing it again may help. |
| `privacy.settings.unavailable.cpu` | The text reader cannot run on this PC's processor. |

The names and never-hide lists are kept in `editor-prefs.json` under the new key `privacy` (§4.5).
They are private: they never go to logs or diagnostics (§10.6). The Windows reader of §5.13 has no
control and no message while `WINDOWS_READER_ALLOWED` is false.

### 2.15 Command palette and shortcuts

Five commands in `COMMAND_LIST` (`src/shared/editor/commands.ts:42`), categories *Add*, *Edit* and
*View*, with no default key (`DEFAULT_KEYMAP` unchanged, as every wave-10 to wave-12 command):

| Command id | Title (`commands.title.<id>`) | Keywords |
|---|---|---|
| `addCover` | Add a cover | privacy hide redact secret password solid box blur pixelate censor mask black out |
| `findPrivate` | Find private info… | privacy redact secret password email key token scan blur censor mask |
| `peekCovers` | Peek under covers | privacy show hidden covers |
| `coverStartHere` | Start the selected cover here | privacy cover trim start begin playhead |
| `coverEndHere` | End the selected cover here | privacy cover trim end stop playhead |

They sit on `WAITING_COMMANDS` (§12.3) until the part that makes them work is merged, so the palette
and the shortcuts editor do not change before integration.

### 2.16 Keyboard and screen readers

Every control above is reachable by Tab, has a visible focus ring (`--focus-ring`) and an accessible
name from its catalogue message. §11 gives the focus rules, the names of covers and rows, and the
live regions.

---

## 3. Decisions

### 3.1 How this design was chosen

The first version's design went through product, engineering and security reviews, was built in
five parts and then reviewed independently (37 confirmed findings, all fixed). Its record
(`lessons.md` in the lead's scratch folder) gave the owner's answers, the blockers the reviews
raised and how they were solved, and the findings. This version keeps those answers and those
solutions, checks each against the code at `37f9355`, and measures every number again with
committed scripts. Where this version differs from the first it says so (§19).

### 3.2 Decision table

| # | Question | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | What hides the text | A solid fill, its colour from the ring around the text (§8) | Blur and pixelate: recovered by hidden Markov models (Hill et al., PoPETs 2016(4):403-417), by image recognition (McPherson et al., arXiv 1609.00408: 57% against 16×16 mosaics), by Depix and Unredacter, and from video because motion shifts the mosaic grid (Positive Security, 25 Jan 2022; Jeff Geerling, 15 Apr 2025). Screen recordings are the worst case: the text scrolls under the effect and the font is known. Flown's own first version read codes back from its blur and pixelate. |
| D2 | Where the fill happens | In the screen picture after the crop and grade (`compositor.ts:169`), and again on the output | Only on the output: blur and pixelate shapes, magnifier lenses, motion-blur sub-frames, the title card's blurred background and the Glass caption look all sample the screen picture before the output; a secret next to a cover would leak through them. Only in the source: the recording files are never changed. |
| D3 | How covers move | A path of boxes over time, from the look pass's shifts and the reader's positions (§5); between two analysed frames where the box moved, a key holds the union of both boxes (§4.2) | A fixed box per read: uncovers text during every scroll. Optical flow over the whole frame: too slow on a laptop and wrong on text. Following by OCR every frame: 2.5 s a frame (§5.11). Keys only at analysed frames: at 60 fps the frame between two of them showed text half a step past its cover. |
| D4 | When a cover ends, and starts | Only on evidence the text is gone, in both directions: a read finds no part of it and the template search fails, or a page change with no match, or the box has left its region (§5.8) | At the next change in its region: a scroll would end it with the text still on screen (the first version's blocker). A fixed time: either too short or too long. Stopping the backward walk at the first frame with no match: a tooltip over the text, or a caret, started the cover too late. |
| D5 | Where the text rules run | In main, on the reader's lines; only covers reach the renderer (§5.7) | In the renderer: the screen's text would sit in the renderer's memory and could reach React state, logs or a crash report. |
| D6 | Which reader | `ssw-ocr.exe` with tract and PaddlePaddle's own PP-OCRv6 ONNX files (decision 1); Windows.Media.Ocr built into the same helper behind `WINDOWS_READER_ALLOWED = false` (§5.13) | ONNX Runtime: +5.4 MB and cannot be downloaded, because nothing downloaded may run. Windows.Media.Ocr alone: its accuracy on screen text, its speed and its behaviour from an unpackaged helper are not measured; decision 8 measures them before it is offered. Tesseract: weaker on screen text and on small fonts. RapidOCR's conversions: their licence covers only some files. |
| D7 | Which models | tiny det, tiny rec, and small rec for the careful pass (careful-long, question 16) | small det: 2.4 s a frame for 0.4 points more line coverage. medium: 12.7 s a frame. tiny alone: misses a mangled key on the held-out set. |
| D8 | How Find reports | Suggestions in the project, reviewed in Review mode, one row per text (§2.7) | A separate list: Review already has keyboard rules, bulk work in one undo step, previews and the export note's count. One row per cover: a scrolled email gives dozens of rows. |
| D9 | Check rows | Drawn, listed first, counted in the export note | Not drawn until checked: a miss is worse than an extra box (decision 2). |
| D10 | Spoken secrets | Private bleeps whose `word` is a kind marker; masking by time everywhere (§7) | Storing the word: the secret would sit in `project.json` and in Review titles. Muting the upload to a transcription service: drops those words from new captions (decision 7). |
| D11 | Older Flown | Legacy `~cover:` shapes written by every writer of `project.json` (§4.6) | Nothing: an older Flown keeps `covers` (it passes unknown fields through, `src/shared/engine/project.ts:151-156`) but draws nothing. A new format version: an older Flown would refuse the project. |
| D12 | Raw-recording outputs | Refused while anything is hidden, in the renderer and in main (§9 row 10) | Redacted copies of the recordings: a later wave (decision 4). |
| D13 | Home thumbnails | Fill the cover boxes main computes into `ProjectSummary` (§9 row 17) | Draw the project through the compositor on Home: Home has only `ProjectSummary` (`src/main/projects.ts:147-159`), and loading every project fully would slow Home. Hide thumbnails of projects with covers: users lose their thumbnails for no reason. |
| D14 | Filmstrip | Fill cover boxes on each tile as it is drawn; the cache stays raw on this PC (§9 row 18) | Re-extract the filmstrip with covers: every cover edit would re-run ffmpeg. |
| D15 | AI requests | One renderer wrapper `aiTextFor` masks every string of every request (§7.6) | Masking in main's `aiText`: main has no project there (`src/main/aiIpc.ts:134`). |
| D16 | Time moves of followed covers | Refused; only the ends change (§2.2) | Moving the whole path in time: moves the cover off the text it was made for. |
| D17 | Unlabelled random strings | Off; a Check suggestion when on (§6.12) | On: 2,193 false hits in 368,134 lines of text with nothing planted. |
| D18 | Where Find's per-project choices live | `Project.privacy` (§4.3), defaults in Settings | Only in Settings: Find again must use what the last Find used. |
| D19 | One coordinate space for drawing covers | `project.covers` in whole-frame coordinates; `cropProject` maps them into the view like shapes; the drawing code maps view boxes straight to picture pixels (§4.8, §8.1) | Mapping again through the crop in `coverScreen`: the scene's project is already the crop's view (`crop.ts:305-311`), so every cropped project would draw its covers in the wrong place. Not mapping in `cropProject`: covers would be the one item of the view in another space than shapes, handles and the outline. |
| D20 | Where the text rules run in main | A `worker_threads` worker with a time limit per read (§10.3) | Main's event loop: a line built to trip a backtracking pattern would freeze the whole app, autosave included. |
| D21 | What a removed suggestion suppresses | Its own path: a new suggestion of the same kind is dropped only when its box lies inside the removed path at every key (§5.10) | The union box and time range of the removed cover: removing one false hit on a scrolled list stopped every later hit of that kind in that area for minutes. |
| D22 | How long the screen's text lives in main | During Find, and folded text only for at most 10 minutes after it, for *Cover this text everywhere* (§5.7) | No cache: *Cover this text everywhere* right after Find would read the whole video again (about 7 minutes for 20). For the session: a renderer crash or a forgotten close kept secrets in memory with no limit. |
| D23 | Cover widths | Rounded up to steps of 4 character widths plus 0-2 at random per group (§6.1) | The text's own width: a cover's width gives the hidden text's rendered width, enough to rank names and tell a PIN's length (the redaction-width attack). |
| D24 | Texts made from captions | Masked in one view of the project wherever they are drawn or leave Flown (`privateView`, §7.5; question 19) | Rewriting the stored text (the settle step of decision 7 as written): a false hit's masking could not be undone. |
| D25 | Find's lifetime | One Find in Flown at a time, owned by the open editor; leaving asks first and applies what was found (§2.6, §5.1) | Running on after the editor closes: nothing would apply its results, and two projects could run two helpers of up to 700 MB each. |
| D26 | Following's protocol | A follow session in the helper that decodes each frame once and answers every track of a frame together; the walks stay in main (§5.8) | One `follow` per hit over a range with candidates fixed in advance: the speed guide and re-anchoring depend on the previous frame's result, and 20 hits on one page decoded the same frames 40 times. The helper computing the walks itself: the lost areas, evidence of absence and re-anchoring by reads would be written twice, in Rust and in P4's tested TypeScript. |

### 3.3 What this version adds to the first

- The careful pass is careful-long (question 16), measured on the held-out set.
- The text rules run on every read of a line (tiny and small) and on the union of their hits. JWTs
  split by a wrap and tokens wrapped after a dash continue onto the next line; a key read with one
  space inside is joined (§6.10). These close the three misses the rules prototype had on the
  held-out reads (`scripts/privacy/results/detect-eval-reads-holdout.txt`).
- PEM BEGIN and END lines are widened by five character widths at each end (§6.4): OCR drops the
  dash runs, which left those lines 88-93% covered.
- The legacy shapes are written per path piece, not per cover (§4.6).
- Multi-select, group edit, group nudge and the group clipboard include covers (§14.4).
- Re-reads and following seek to the nearest key frame (§5.5, §5.8).
- The guide's *Blur an area…* takes its colour from the step's own shot frame (§8.4).
- A16, the rendered tracking set, and the A2 variants are end-to-end tests (§17.3).
- Every numbered test is its own test (§17).

### 3.4 What the reviews of this version changed, and where this design disagrees

Four reviews (product, engineering, security, lessons) read the first draft of this version. Every
code claim they made was checked at `37f9355` and held. Taken:

- **Every second frame at 60 fps** (all four): a key between two analysed frames holds the union of
  both boxes; starts and ends reach the source frame next to the analysed one (§4.2, §5.8); tests 186
  and 187, and A16's fast scroll checked frame by frame.
- **The crop mapped twice** (engineering, security): one coordinate rule (D19, §4.8, §8.1); test 15
  builds its scene with `cropView`; A2g.
- **Find's lifetime** (product, engineering, security, lessons): D25, §2.6, §5.1.
- **Export during Find** (product, engineering): the note's sentence was false; it now offers *Wait
  for Find* and *Stop Find and export* (§2.12); A18.
- **The backward walk, typed text, lost areas and short texts** (engineering, security, lessons):
  §5.8's backward evidence, check reads, the typing rule and the 2-D lost area whatever the
  candidates scored.
- **The helper's protocol** (engineering, lessons): threads, out-of-band commands, a careful event,
  a follow session, restarts from the next read (§5.5, §5.6, §5.8, §16.0).
- **Budgets** (engineering): fixed detector buckets measured here, plans kept for the whole Find,
  every read decode counted, phases so that at most three threads are busy (§5.4, §5.5, §5.11).
- **Privacy of the text** (security): rules in a worker (D20), retention (D22), widths (D23), helper
  stderr and panics (§10.4, §10.6), caps that answer `partial` (§10.3), suppression by path (D21),
  WER for installs for all users and at run time (§10.5), IPC checks (§10.7).
- **Review without fatigue** (product): places as parts, *Peek while reviewing* with V and a
  magnified view, *Keep covered* and *Uncover* with a confirm on bulk, one counting unit, thinned
  spans shown, unfinished Finds shown, copies made before Find, cover outlines in the editor,
  resizing the whole path, *Start here* and *End here*, multi-selection's states (§2).
- **Catalogue fixes** (product, engineering): no `#` in any message (rule 17 of
  `output-and-languages.md`, `scripts/i18n/lib/catalogue.cjs:114`); sentences naming a kind select on
  the kind's id; the keys `KIND_WORDS` and `LOOK_CLASS_WORDS` need (§12.1).
- **Spoken forms** (lessons): built from the hit's own words, numbers as digit strings, word
  boundaries (§7.3). **Stored texts** (engineering): question 19 and D24.
- **Gaps in the parts** (lessons, engineering): the reader-state and progress stubs, the tracking
  fixtures script, the timeline flush seam and the runner cases are contracts items; the waiting
  commands are split per part (§16.0, §12.3).

Where this design disagrees, or chose between the reviews:

- **Slack instead of union keys.** The product review proposed a slack of half a look step. At 120 fps
  (step 4) half a step does not reach the next key, and a larger slack widens every cover, the user's
  too, at both ends. The union key is data: legacy shapes, Home thumbnails and filmstrip tiles see it
  with no new logic.
- **Following computed in the helper** (lessons) or **in main with a session** (engineering): D26
  takes the session.
- **No cache of the screen's text** (security): D22 keeps folded text for at most 10 minutes, the
  security review's own fallback, so *Cover this text everywhere* right after Find does not read the
  video again.
- **Showing the text read under a cover, masked, with press to show** (product, optional): not done;
  the screen's text stays out of the renderer (D5). The dialog says when nothing was read.
- **Disabling *Cover this text everywhere…* without the reader** (product): the dialog offers the
  download instead, which is one step shorter; the button stays enabled.
- **Extending covers to the field or column** (security): a read gives lines, not fields, so only the
  width rounding of D23 is done; §2.9 says a cover can still show roughly how long the text is.
- **A static ReDoS checker such as recheck** (security): not added as a dependency; P3 writes a small
  check for nested and overlapping quantifiers, and the worker's time limit is the guarantee (§10.3).
- **Crop as hiding** (security): question 18. **The three blur texts** (product): question 17.

---

## 4. Data model and migration

### 4.1 `src/shared/types.ts` (additive)

```ts
/** What Find looks for (§6); also what a found cover hides. 'text' is Cover this text everywhere. */
export type PrivateKind =
  | 'password' | 'code' | 'qr' | 'key' | 'link' | 'email' | 'card' | 'phone' | 'id' | 'name'
  | 'notice' | 'address' | 'dots' | 'random' | 'text'

/**
 * A solid box over the screen picture (docs/design/auto-blur.md §4.2). Its box may move over time
 * (`path`). Filled into the screen picture after the crop and grade and again on the output (§8).
 */
export interface Cover {
  id: string
  /** Source seconds, start < end, within the recording. */
  start: number
  end: number
  /**
   * Where it is: keys "t x y w h" joined by ";", t in source seconds (3 decimals), the box
   * normalised to the whole recorded frame (4 decimals, rounded outward). One key: a fixed box.
   * The box holds from one key until the next (§4.2).
   */
  path: string
  /** '#rrggbb', ungraded: the ring around the text when it was made, or a chip's colour. */
  color: string
  /** A suggestion waiting for review: 'auto' (found, score 0.85 or more) or 'check'. Absent: the user's. */
  found?: 'auto' | 'check'
  /** What it hides. Absent: a cover the user drew. */
  kind?: PrivateKind
  /** One Find run's suggestions of the same text share a group: one Review row (§5.10). */
  group?: string
  /** Covers the whole area where the text may be, because Flown could not place it (§5.8). */
  lost?: true
  /** Made from reads further apart than usual (§5.4). */
  thin?: true
  /** The last Find did not find this text again (§5.10). */
  missed?: true
}

/**
 * A suggestion the user uncovered (§5.10): its own path. Find again does not suggest `kind` where a
 * new path lies inside this one's drawn box at every key.
 */
export interface RejectedPlace {
  kind: PrivateKind
  start: number
  end: number
  /** The removed cover's path, as `Cover.path` (§4.2). */
  path: string
}

/** What the last Find did (§5.10). Holds no text. */
export interface FindRecord {
  /** ISO time it finished. */
  at: string
  kinds: PrivateKind[]
  listened: boolean
  /** The captions it listened to: sha256 of their words and times, hex (§7.7). */
  captionsSig?: string
  /** The reader's model set, e.g. 'pp-ocrv6-tiny+small-careful-long'. Absent: no screen read. */
  reader?: string
  /** Areas it could not read (§5.6). */
  failed?: number
  stopped?: true
  /** Source seconds up to which the screen was read, when it stopped before the end. */
  readTo?: number
  /** Spans read less often than planned (§5.4): "start end" pairs joined by ";", source seconds. */
  thin?: string
  /** Suggestions not added because a removed path of the same kind held them (§5.10). */
  suppressed?: number
  /** Ids of the private bleeps this Find made, at most 2,000 (§2.12 `saidRemoved`). */
  saidIds?: string[]
}

/** Find's choices for this project (§2.5). Absent: Settings' defaults. */
export interface ProjectPrivacy {
  kinds?: PrivateKind[]
  /** Up to 5 regions added for phone numbers (ISO 3166-1 alpha-2). */
  regions?: string[]
  listen?: boolean
  /** Names to hide in this video, one entry each (§6.11). */
  names?: string[]
  /** Words never to hide in this video. */
  neverHide?: string[]
  find?: FindRecord
  rejected?: RejectedPlace[]
}
```

`Project` gains two optional fields, after `soundFx`:

```ts
  /** Solid covers (docs/design/auto-blur.md). Absent: none (every project from before). */
  covers?: Cover[]
  /** Find private info's choices and record. Absent: never used. */
  privacy?: ProjectPrivacy
```

`CaptionTrack`'s segment (`types.ts:860-870`) gains `maskedFor?: string` (§7.4), and
`readCaptionTracks` (`src/shared/captions/studioData.ts:739`), which builds each segment from `id`,
`text` and `src` only, keeps it when it is a string of at most 2,048 characters. `Bleep` does not
change; a private bleep is a bleep whose `word` starts with `:` (§4.4).

### 4.2 Paths

- **Grammar**: `path := key (";" key)*`, `key := t " " x " " y " " w " " h`, each a decimal without
  exponent. At most `MAX_KEYS_PER_COVER = 4000` keys; keys strictly increasing in `t`.
- **Meaning**: at source time `t`, the box is the last key with `key.t <= t`; before the first key, the
  first key's box. A cover is active on `[start, end)`.
- **Slack**: a cover is drawn at picture time `t` when it is active at any time in
  `[t - s, t + s]` with `s = 0.5 / capture.fps + 0.001` (the slack privacy shapes use,
  `shapesLayer.ts:43`), and its drawn box is the union of its boxes over that window. It absorbs the
  difference between a picture's time and its source frame's time; it does not reach a neighbouring
  frame.
- **Between analysed frames** (the rule that makes a path cover every source frame). Find places a
  box only on analysed frames (every second frame at 60 fps, every fourth at 120). Text that moves
  between two analysed frames `a` and `b` is, on the source frames between them, somewhere between
  its box at `a` and its box at `b`. So whenever a walk writes different boxes at `a` and `b`, it
  also writes a **union key** at the first source frame after `a` (`t(a) + 1 / fps`, rounded down to
  the millisecond) holding `union(box(a), box(b))`; the key at `b` follows. When `b` is just one
  source frame after `a` (step 1), no union key is needed and none is written. `stepKeys`
  (`coverPath.ts`, contracts) is the one function that turns a walk's placements into keys, and every
  path Find, *Follow* or *Cover this text everywhere* writes goes through it.
- **Starts and ends** follow the same rule. A found cover starts at the first source frame after the
  last frame proven to be without the text (§5.8), not at the next analysed frame, and its first key
  there holds the union of its first placed box and that box moved back by the move the look pass saw
  between the two frames. It ends one analysed frame after the first frame without a match (§5.8;
  `end` is exclusive): that frame, which may still show a fading glyph, and the source frames up to
  the next analysed frame stay covered.
- Because these are keys like any other, the legacy shapes (§4.6), Home thumbnails (§9 row 17), the
  filmstrip tiles (row 18) and the output pass (§8.2) need nothing more.
- **Rounding**: `writePath` writes x and y rounded down and x + w and y + h rounded up to 4 decimals
  (0.19 px at 1920), so a written path never shrinks a box. `t` is rounded to the millisecond, down
  for the first key and to the nearest for the others; `start` rounds down and `end` up.
- **Why a string**: `project.json` is written with `JSON.stringify(project, null, 2)`
  (`src/main/projectsIpc.ts:37`), which puts every number of an array on its own line. A 2,000-cover
  project with 50 keys each is about 3.5 MB as strings and about 14 MB as arrays.
- **Limits**: at most `MAX_COVERS = 2000` covers and `MAX_KEYS = 200000` keys in a project. Find
  never writes more (§5.10, `mergeCovers`, `simplifyKeys`). Union keys count toward the limits; a
  10 s scroll at 30 analysed frames a second gives about 600 keys.
- **Simplifying keys** (`simplifyKeys(covers, maxKeys)`, contracts): while the total is over
  `maxKeys`, the cover with the most keys has its neighbouring keys merged in pairs, each pair
  replaced by one key at the first one's time holding the union of both boxes. The longest paths are
  simplified first, so no cover drops to one key while a longer one keeps more. Merging only grows
  boxes.

### 4.3 Readers (`src/shared/privacy/coverData.ts`, contracts, in full)

- `readCovers(raw: unknown, duration: number): Cover[] | undefined`: one linear pass (finding 17).
  - Drops anything that is not an object, or has no string id (or a repeated one), no finite
    `start < end`, or a path that does not parse. Clamps times to `[0, duration]`. A cover shorter
    than 0.02 s (one frame at 60 fps is 16.7 ms; a cover clamped at the recording's end can be
    shorter) is **widened**, never dropped: to 0.02 s about its middle, held inside the recording.
    The writers do the same before writing, so a one-frame hit survives a write and a read.
  - Keeps `color` when it is `#rrggbb`, else `COVER_DARK` (`'#1c1c22'`, the `--surface-2` token).
  - Keeps `found`, `kind`, `group` (1-32 characters of `[A-Za-z0-9_-]`), `lost`, `thin` and `missed`
    only when valid.
  - Boxes are clamped to the frame (x and y in 0..1, w and h at least 0.002 and at most 1 - x, 1 - y).
  - A file Flown wrote never exceeds the limits of §4.2. A hand-edited file that does is read
    without losing cover: a cover over `MAX_KEYS_PER_COVER` keys becomes one key holding the union
    of all its boxes; past `MAX_COVERS`, covers are merged by `mergeCovers` (§5.10), which only ever
    grows boxes and times; past `MAX_KEYS` in all (for example 2,000 covers of 150 keys each),
    `simplifyKeys` (§4.2) merges neighbouring keys of the longest paths first. Nothing a file covers
    is ever uncovered by reading it, and no cover is read coarser because of where it sits in the
    file (finding 20).
  - Returns `undefined` for absent or empty input, so absent stays absent.
- `readPrivacy(raw: unknown, duration: number): ProjectPrivacy | undefined`: kinds from
  `PRIVATE_KINDS` only, at most 5 regions of two upper-case letters, at most 200 names and 200
  never-hide words of 1-80 characters each (NFC, one line), `find` with a valid ISO time (its `thin`
  parsed like a path's times, at most 2,000 spans; at most 2,000 `saidIds`), at most 5,000 rejected
  places whose paths parse with at most 400 keys each (a longer removed path is simplified with
  `simplifyKeys` before it is written). Unknown fields are dropped.
- `isPrivateBleep(b: Bleep): boolean`: `b.word.startsWith(':')`.
- Both readers are idempotent: reading what they return gives the same value.

### 4.4 Private bleeps

A private bleep is an ordinary `Bleep` (`types.ts:873-882`) with:

- `word: ':' + kind + ':' + group`, for example `':card:k3v9q2m8xa'`: the kind, then the group of the
  said text (10 characters of `[a-z0-9]`, lower case because `readBleeps` lower-cases every word,
  `studioData.ts:773`; 17 characters at most, under `BLEEP_WORD_MAX = 40`). `privateKindOf` and
  `privateGroupOf` parse it; a word of the form `':' + kind` alone is read with no group. Bleeps of
  one said text share the group, so they are one Review row (§2.7). `bleepKey` of any caption word
  never starts with `:`
  (it keeps letters, digits and marks only, `src/shared/captions/cleanup.ts:362-363`), so no word
  ever matches it. An older Flown reads it with
  `readBleeps` (`src/shared/captions/studioData.ts:760`) and keeps it: it mutes the sound and, because
  no word matches, masks every word under it by time (`maskedSegments`, `cleanup.ts:901`: "when the
  caption was edited and none matches, every word there"). An older Flown's word-based masking
  (`maskBleeped`) does nothing for it; that risk is stated in §15.
- `auto: true` while it is a suggestion; *Keep* drops it, as for every automatic bleep. It is
  listed under *Private*, not under *Bleep*, in Review (§14.3).
- `sound: 'tone'`, the default for new bleeps.

The kind marker survives every round trip through an older Flown, so `isPrivateBleep` needs no other
field.

**The bleep limit.** `readBleeps` keeps at most `MAX_BLEEPS = 2000` and, past it, the earliest by time
(`studioData.ts:779`), so a project near the limit could lose its latest private bleeps on the next
load. Two rules prevent it:

- `saidBleeps` (§7.2) keeps the total at or under `MAX_BLEEPS`: past it, it merges private bleeps
  that are close in time, across groups if it must (each merge only grows a bleep, and the merged
  bleep takes the earlier group). When even that cannot fit, Find's result says so
  (`privacy.run.saidFull`: "Too many bleeps: some secrets said aloud could not be bleeped. Remove
  bleeps you do not need and find again.") and the hits it could not place are counted in Review.
- `readBleeps` keeps private bleeps first when it must cut (then the earliest of the rest). A project
  with no private bleeps is cut exactly as today.

### 4.5 Preferences

`editor-prefs.json` gains the key `privacy` (`PrefKey`, `src/shared/api/prefs.ts:6`), read by
`readPrivacyPrefs` in `prefsIpc.ts`'s sanitisers:

```ts
export interface PrivacyPrefs {
  kinds?: PrivateKind[]
  regions?: string[]
  names?: string[]
  neverHide?: string[]
  /** 'ring' or a chip: 'dark' | 'light' | 'black' | 'white'. */
  colour?: 'ring' | 'dark' | 'light' | 'black' | 'white'
  /** *Show where covers are* (§2.1). Absent: on. */
  showCovers?: false
}
```

Same limits as `readPrivacy`. An older Flown keeps unknown keys in `editor-prefs.json`. The reader's
own state lives in `userData/reader-models/models.json` (§5.12), not in preferences.

### 4.6 Older Flown: the legacy shapes

`withLegacyShapes(project: Project): Project` (`coverData.ts`) returns the project itself when it has
no covers, and otherwise a copy whose `shapes` end with the legacy shapes:

- Each cover is cut into **pieces**: runs of keys whose union box is at most 1.5 times the area of
  the run's largest box, at most 4 pieces a cover (the last piece takes the rest). A piece spans from
  its first key's time (the cover's start for the first piece) to the next piece's first key (the
  cover's end for the last), widened by the slack of §4.2 at both ends. Its box is the union of its
  keys' boxes.
- Each piece gives two shapes, in this order, ids `~cover:<cover id>:<piece>:p` and `…:r`:
  - `kind: 'pixelate'`, `strength: 1` (a 54 px cell at 1080p), `opacity: 1`. Privacy shapes never
    fade (`shapeAlpha`, `src/shared/render/shapes.ts:57-63`).
  - `kind: 'rect'`, `fill: true`, `opacity: 1`, `color` the cover's colour, `strokeWidth: 0`. It
    fades over `SHAPE_FADE` (0.15 s) at its ends in an older Flown; the pixelate under it hides the
    text then.
- At most 4,000 legacy shapes in all. Past that, each cover's pieces are merged into one (union box,
  whole time), largest covers first, until the count fits.
- Every writer of `project.json` writes through one function in main,
  `projectFileText(project: Project, form: 'pretty' | 'compact' = 'pretty'): string`
  (`src/main/projectFile.ts`, new): `JSON.stringify(withLegacyShapes(project), null, 2)`, or without
  the indent for `'compact'`. Its callers:
  - `saveProjectNow` (`src/main/projectsIpc.ts:37`), which serves `projects:save` and
    `projects:saveSync`;
  - `writeProject` (`src/main/projects.ts:96-98`), which only writes new projects;
  - `makeCopy` (`src/main/projectCopy.ts:229`): Duplicate, *Make vertical/square*, Short clips and
    *Make a shorter version*;
  - `saveVersion`'s body (`src/main/versions.ts:281`, `JSON.stringify(project)` today), with
    `'compact'`; its size check (`:282`) measures that text.
- `renameVersion` (`:326-346`) rewrites the version file from its parsed raw JSON
  (`JSON.stringify({ ...raw, meta })`, `:339`), so the legacy shapes written with the body stay as
  they are; it never builds a `Project`.
- **Reading**: `migrateProject` drops every shape whose id starts with `~cover:` before
  `readItems(readShape)`, so no part of this version ever sees them. `hashProject`
  (`src/main/versions.ts:76`) and `versionSummary` run on the project as the renderer holds it,
  which has none, so a project's hash and summary do not depend on them.
- **Byte for byte**: a project with no covers is written exactly as today (test 20).

What an older Flown shows: an opaque box with a mosaic under it over each piece; an older guide
screenshot shows the same boxes. **What an older Flown (the `37f9355` code) still leaks**, stated as
the residual risk of decision 5 and risk 7:

- during the rectangle's 0.15 s fades only the mosaic hides the text, and a piece's union box may
  hide more than the cover did;
- its magnifier lens draws only `drawPrivacyLayer` inside the lens (`magnifierLayer.ts:152`), so a
  lens over a cover shows the mosaic alone, magnified;
- its Home thumbnails and timeline filmstrip draw raw frames;
- its *The original recordings* timeline copies `screen.mp4`;
- its captions mask a private bleep's words by time but keep each word's first letter (`maskWord`,
  `cleanup.ts:842-847`), and leave a caption unmasked when its words and times do not line up
  (`:896`);
- it sends captions to AI unmasked (marks, cleanup, translation);
- it lists a private bleep as an ordinary automatic bleep, which the user can remove there. This
  version then sees it gone: `FindRecord.saidIds` lets the export note say so (§2.12).

### 4.7 Migration (`src/shared/engine/project.ts`)

`migrateProject` (`:145`) destructures `covers` and `privacy` beside the other optional fields
(`:151`) and adds `...optional('covers', readCovers(covers, duration))` and
`...optional('privacy', readPrivacy(privacy, duration))` (`optional`, `:133`); before reading `shapes`
it removes the legacy shapes (§4.6). A project without either field migrates to the same keys and
bytes as before.

**Copies keep every cover.** Copies carry covers and private bleeps by spread: `projectCopy`
(`src/shared/editor/duplicate.ts:75-90`), `clipCopy` (`src/shared/clips/clipCopy.ts:141-153`) and
`short60.ts:269`. A clip copy or a shorter version keeps **every** cover, as it keeps every shape:
`clipCopy` limits only the clips (`:141-153`), and the copy holds the whole recording
(`src/main/projectCopy.ts:116-136` links or copies every media file), so widening its clips in its own
editor brings back footage whose covers must still be there. Covers are in source seconds and cost
nothing off screen. `clipCopy.withinRange` (`:106-113`) settles pending Review rows wholly outside the
clip's range by Review's own Keep, as for every other kind; for a private row, Keep only drops
`found`, so the cover stays and is drawn.

### 4.8 Crop

**One coordinate rule (D19).** `project.covers` is in whole-frame coordinates, always: the project
file, Find, the box fields, Home thumbnails (§9 row 17), the filmstrip (row 18) and the legacy shapes
(§4.6) use it as it is. The view the scene draws is `cropView(project, track)` (`crop.ts:305-311`):
its `project` is `cropProject(project)` and every position in it is relative to the crop, as the
scene's own comment says (`compositor.ts:41`). So:

- `cropProject` (`src/shared/engine/crop.ts:247-267`) maps `covers` like `shapes`: every key's box
  through `rectToCrop` (`:149`), memoised per list in its own WeakMap beside `mapped` (`:225-236`).
  A cover entirely outside the crop is left out of the view (nothing of it is shown), never out of
  the project.
- `coverScreen` (§8.1) and `drawCoverOutput` (§8.2) take `scene.project.covers`, already in view
  space, and **never map through the crop again**. The picture they fill is the crop's copy (or the
  grade's canvas made from it), whose pixels are the view's; without a crop the view and the frame
  are the same.
- `CoverHandles` and the preview's outlines work in view space like the shapes' handles; a box edit
  maps back with `fromCrop` before it is stored, as shape edits do.
- While the crop tool is open the scene has no crop and the whole frame (`Editor.tsx:507-511`), so
  covers show in place.

Test 15 builds its scene through `cropView` and checks the filled pixels of a cropped and graded
project; A2g exports one.

### 4.9 What older and newer Flown do with each field

| Field | This version | An older Flown |
|---|---|---|
| `covers` | read, drawn, edited | kept on save (`...rest`), not drawn |
| `~cover:` shapes | dropped on load, written on save | drawn as pixelate + opaque box, kept, editable |
| `privacy` | read | kept on save, unused |
| private bleep (`word: ':card:<group>'`) | private: listed under Private, masked everywhere | an ordinary bleep: muted, masked by time in captions (first letter kept, `maskWord`) |
| `privacy.rejected[].path`, `privacy.find.thin`, `saidIds` | read | kept on save, unused |
| `maskedFor` on a track segment | used (§7.4) | dropped on save by its track reader; this version then masks that caption whole again (the safe side) |
| `privacy` in `editor-prefs.json` | read | kept |

---

## 5. The detection pipeline

### 5.1 Overview

Find runs as one long job in main (`src/main/privacy/scan.ts`, P4), like the scene scan
(`src/main/sceneScan.ts`), at below-normal priority.

**Lifetime (D25).**

- **One Find in Flown at a time.** `findIpc.ts` holds one running scan for the whole app; a second
  `privacy:find`, for this project or another, answers `{ ok: false, reason: 'busy' }`. *Follow what
  is under it* and *Cover this text everywhere* use the same helper and the same queue, ahead of
  Find's reads, so at most one helper runs.
- **Find belongs to the open editor.** It is stopped by `stopAnalyses`
  (`src/main/analysisIpc.ts:210`), which the editor calls when it closes (`player.ts:1229`) and
  `projects:delete` calls (`projectsIpc.ts:105`), and by *Stop*. Its results are applied only in the
  renderer, to the open store.
- **Leaving asks first** (§2.6): confirming stops Find, waits for its partial result, applies it as
  *Stop* does, and only then saves and leaves. Closing the window loses this run's results and
  leaves `privacy.find` unchanged.
- **Results land only where they belong.** `privacyRun` applies a `FindResult`, `FollowResult` or
  *Everywhere* result only when its `projectId` and `requestId` equal the open project's current
  request; anything else is dropped (test 247).

```
renderer                         main (scan.ts)                          ssw-ocr.exe (helper)
FindDialog ── privacy:find ────▶ load project.json (saved first)
                                 open ───────────────────────────────▶ read, hash, parse models (§10.2)
                                 look ───────────────────────────────▶ look worker: ffmpeg (look scale)
                                 ◀── look batches (no pixels, no text)    → tiles, moves
                                 planReads (P4 plan.ts, pure)
                                 read (one per command, ≤ 3 queued) ─▶ inference worker: ffmpeg seeks to
                                 ◀── lines: boxes, text, spans, ring      the key frame → tiles, detector,
                                                                          recogniser, QR
                                 rules worker: detectFrame (P3, pure)
                                 careful (lines to read again) ──────▶ careful worker: small recogniser,
                                                                          beside the next read
                                 ◀── careful variants
                                 followOpen / match (per frame) ─────▶ follow session: half-size frames
                                 ◀── matches for every track            decoded once, templates per part
                                 found items (P4 found.ts): groups, paths, scores; no text
◀── privacy:find result ──────── (covers only); folded text kept ≤ 10 min (§5.7)
privacyRun: detectSaid on the
captions (P3, in the renderer);
one store.update (afterGestures)
```

- The screen's text never leaves main and the helper. The renderer receives covers (boxes, times,
  kinds, colours, groups), never text (D5). The one exception is the user's explicit choice to add
  a text read under a cover to the names to hide (§5.9).
- The spoken rules run in the renderer on the captions it already holds (§7.2), so Polish can run
  them on the captions it has just made (decision 11).
- Main flushes nothing itself: the renderer saves the project (`projects:saveSync`) before
  `privacy:find`, and main reads `project.json` for `capture`, `source`, `width`, `height`,
  `duration` and the file names. Covers and choices travel in the request.
- **Phases.** Find runs its look pass first, then reads and follows minute by minute, so that at most
  three threads are busy at once (§5.11).

### 5.2 The look pass (helper `look`, P2; planning in `look.ts`, P4)

The look pass decodes every frame once at a small size and records, per analysed frame, which
tiles changed and how each changed region moved. It holds no pixels and no text afterwards.

- **Decode**: the helper's look worker runs the bundled `ffmpeg.exe` (path from main) inside a job
  object (§10.4): `-hide_banner -nostdin -loglevel error -threads 2 -filter_threads 1 -i screen.mp4
  -map 0:v:0 -vf "select='not(mod(n\,STEP))',scale=W/k:H/k:flags=area,format=gray,showinfo" -f
  rawvideo -`. Every frame is decoded (H.264 needs it) but only analysed frames are scaled.
  `showinfo` gives each frame's exact `pts_time` and `iskey`, so every time in Find is a frame's own
  time, and the key frames are known for the reads (§5.5). This is the only ffmpeg of Find with more
  than one thread.
- **Look scale** `k = max(4, ceil(sqrt(W·H / (480·270))))`: 480×270 for 1080p, 480×270 for 4K
  (k = 8), 640×180 for 7680×2160 (k = 12).
- **Step**: every frame up to 30 fps; every second frame at 60 fps, Flown's default (`step =
  ceil(fps / 30)`; `src/shared/recording/settings.ts:42`, the proxy is constant-rate,
  `src/main/proxyArgs.ts:120-121`). The source frames between analysed ones are covered by the union
  keys of §4.2. Text that shows for less than two frames is not followed between reads; a read can
  still find it (§5.4).
- **Tiles**: 8×8 look pixels (32×32 video pixels at 1080p). A tile changed when its mean absolute
  difference from the last analysed frame is over 2.0 levels or its largest over 24 levels.
- **Regions**: changed tiles joined by 8-connectivity, merged when within 2 tiles, each as its
  bounding box.
- **Moves**: for a region at least 4 tiles wide and 6 tall (a list in a column a few words wide
  scrolls too: at 12 tiles wide, A16's lists got no move and every walk on them was lost over the
  whole column, R25), the row and column profiles of its gradient
  magnitude are compared with the last frame's by normalised cross-correlation (NCC) over shifts of
  up to half the region's size. The best shift and up to two alternatives scoring at least 0.85 of
  the best are kept; a diagonal candidate (dx from the columns, dy from the rows) is kept when the
  region's 2-D gradient NCC at it is 0.9 or more. Each move: `{ box, dx, dy, score, alt: [dx, dy,
  score][] }` in video pixels. In main (`look.ts`), a region's move **continues its move** of the
  analysed frame before: when its best shift is far from the move of the region it overlaps most at
  that frame (scored 0.5 or more) and one of its alternatives is within two look pixels, or a quarter
  of that move, of it, that alternative is its move and the best becomes an alternative. A list that
  repeats its rows (every 336 px in A16's) offers the shift of a whole period beside the scroll, and
  under a sticky header that shift scored above the scroll at one frame in eight (0.73 against 0.72):
  taken for the region's move, it put every row on its copy a period away.
- **Output**: batches of at most 1,000 frames or 1 MB (`LookBatch`, §16.0 `protocol.ts`): each frame's
  `t`, `key`, its changed tiles as a bit string (base64) and its moves. A 20-minute 1080p60 recording
  gives 36,000 analysed frames and about 11 MB of look data in main.
- **Cache**: main keeps the look data in `<project>/.cache/look.bin` (P4 `lookCache.ts`), keyed by
  `screen.mp4`'s size and mtime, `k` and `step`, like `.cache/scenes.json`
  (`sceneScan.ts:133-136`). Find again and *Cover this text everywhere* reuse it. It holds no pixels
  and no text.
- **Black and still frames**: the first non-black analysed frame is the read plan's first frame.

### 5.3 Hints from `cursor.json`

The editor already loads the cursor track (`projects:load`, `src/main/projectsIpc.ts:70-85`;
`CursorTrack`, `types.ts:49-66`). Find uses, whatever `cursor.valid` says (window captures have
`valid: false`, but their times hold):

- **Typing bursts** `{t, end}` (no key content): typed text appears in a field. A read follows each
  burst (§5.4).
- **Clicks**: a click followed by a burst within 5 s marks the field's place when positions are
  valid.
- **Cursor shapes** `'text'` (the I-beam, native capture only): a text field under the cursor.
- **Shortcut labels** `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert`: something was pasted; a read follows
  0.3 s later.
- **Scrolls**: notches mark when a region is expected to move; they seed the move search's direction
  when the profile NCC has two close candidates.
- **Display scale** (`CursorTrack.scale`, `types.ts:62`; 1 when absent): at 150-200% a field and its
  label are 1.5-2 times larger in video pixels. Every size given in screen pixels below is multiplied
  by it: the typing read's box and the settle padding (§5.4). **Not** the helper's search window
  (§5.8 step 3): it stays ±4 template pixels (±8 video pixels), which holds what the look pass's
  moves are precise to (a look pixel, at most 8 video pixels at 4K, where text is twice as large), and
  the template search's grid is set by that window, not by the scale (§5.8, evidence of absence).

`cursor.json` holds no typed text (`src/main/recording/keystrokes.ts:1-6`, read only).

### 5.4 Which frames and areas to read (`planReads`, P4 `plan.ts`, pure)

`planReads(look: LookData, hints: ReadHints, size: Size, fps: number, budget: number, end?: number):
ReadPlan` returns reads `{ t, areas: Box[], why, units }` in time order (the display scale comes in
`hints.scale`; `end` is the recording's last source frame, point 2).

**Cost.** The detector runs on fixed **buckets**: 640×352, 960×544 and 1920×1088 (§5.5). A read's
cost is the buckets it actually runs, measured against the largest (`results/tract-buckets.txt`, one
thread: 71-77 ms, 141-215 ms and 871-909 ms a run): **0.1, 0.2 and 1 unit**. Each area is padded up
to the smallest bucket that holds it; an area larger than 1920×1088 is cut into 1920×1088 tiles;
small areas of one read that fit together in one bucket are packed into it (shelf packing, a 32 px
gap between them, no area cut). A unit with its lines and careful re-reads costs about 2.9 s (§5.6).

1. **First frame**: the first non-black frame, whole: the first analysed frame after the changes of
   the opening (black frames giving way to the screen, a screen fading in), each changing 90% or more
   of the frame. A change of part of the frame is the screen's own: a page zoomed in its browser,
   changing 21-32% of the frame every 0.2 s, moved the first read past four steps (to 0.8 s), and the
   rows the zoom then pushed off the frame were never read at their first places.
2. **Settle reads**: for each burst of changes in a region (changed frames less than 0.3 s apart), the
   first analysed frame at least 0.3 s after the burst in which the region is still, or the frame just
   before the next burst when it comes sooner. A burst the recording ends in is read at the
   recording's last source frame (`end`), which shows the most of what came in: at 60 fps the last
   analysed frame can be one before it, and a phone number a scroll was bringing in at the bottom
   edge, cut there, was misread ("+1.415.555.4187") and never covered. The area is the union of the
   burst's changed tiles, padded by 64 × `scale` video pixels.
   **New: a value after its label.** For a burst on one line (at most three rows of tiles, below)
   with no real move of its region, each of its pieces three tile columns wide or more reaches up to
   480 × `scale` px further to the left, where the label of a value typed, pasted or printed after
   it stands on its line, on screen already, so it never changed with the value: a 40-character key
   pasted after "Personal access token: " (or "Enter your API key: ") was read through an area that
   began 64-95 px left of it and cut the label to "ken:" ("[ key:"), the reads after it cut the line
   on its other side, and the key was never covered (found end to end, with and without the paste
   key in `cursor.json`). A caret blinking is one or two tile columns and keeps its padded area
   alone. The reach never takes a read into the 1920×1088 bucket that its padded area does not need:
   it stops where the area is 960 px wide, so it costs at most 0.1 unit a read (a chat's typed lines,
   600 px long from x 320, cost three times the units reaching the whole 480 px; the area of a key of
   40 characters at 12.6 px a character still reaches at least 352 px to its left with its padding,
   more than the 328 px of "Secret Access Key [None]: ", whose words name it, §6.6).
   Measured on the look data of A1, A16's cases and the evaluation sets: every plan's units the same
   but `type-key`'s (1.3 to 1.4); a 10-minute chat typed a line every 12 s from 15 to 20 units for
   300 px lines and the same 20 for 600 px lines.
   **In-place reads.** A burst on one line (its changed tiles in at most three rows of tiles: a line
   of text lies in one, two where it straddles them) that, after its changed tiles last grew, changes
   a tile older than those it last grew by (the text in it deleted or changed in place, not typed on)
   and goes on changing for 0.3 s or more, with no real move of its region (§5.8 step 2), is also read
   at the analysed frame before that change, where it showed the most of what came in. The area is
   its line band: the settle area from the frame's left edge, where the label of a typed value stands
   on its line, before it (§5.8). A key typed into a terminal and deleted again was one burst, read
   once after it was deleted, over an area that cut its label ("CCESS_KEY=Q"), and never found. A zoom
   or a page changing in place is no line: the reads of the page read it.
3. **Scroll reveals**: during a move lasting over 1.0 s, every 0.75 s, the strip that came into the
   region since the last read of it.
4. **Typing reads**: 0.3 s after each typing burst ends and after each paste: a (640 × 200) ×
   `scale` px box around the click before the burst when positions are valid, else the changed
   regions since the burst started, padded as settle areas are, each on one line and three tile
   columns wide or more reaching to its left as point 2 says.
5. **Periodic reads**: the whole frame every 60 s in which no read covered half of it.
6. **Merging, always**: settle and typing areas of overlapping regions less than 1.0 s apart are read
   once, at the later one's frame, over the union of their areas. Text shown for less than about a
   second can be missed, and §2.9 says so (`privacy.notSee.brief`). In-place reads are never merged:
   the settle read of their own burst comes after what they read was changed.
7. **Budget**: `budget = ceil(duration / 8) × min(2, W·H / (1920·1080))` units (150 for 20 minutes at
   1080p). Over it, in this order until it fits: reveals every 1.5 s, then periodic reads every
   120 s, then settle and typing areas less than 3 s apart merged, then less than 5 s apart. In-place
   reads count against it and are not thinned (point 6). A read is never dropped: the plan stops
   thinning at twice the budget and runs what is left. Every span whose reads were thinned is
   recorded (`ReadPlan.thinSpans`), covers made from it are marked `thin` (§2.2), Find's result
   reports the thinned minutes (`privacy.run.thinned`), and `FindRecord.thin` keeps the spans for the
   Covers row and the export note.
8. **Check reads and partial reads** are added while Find runs: a walk asks for a check read of one
   small area when it needs proof that text was not yet on screen (§5.8, about 0.1 unit each), and a
   read that hit a cap is completed by extra reads of its unread areas (§10.3). Both count against the
   budget and are reported with the rest.
9. **Estimates** (§5.11): the dialog shows the first estimate from the recording's length, size and
   frame rate; the progress line replaces it with the second, from the plan's units and the measured
   look speed, once the look pass ends.

`scale` is the cursor track's display scale (§5.3). The planned areas themselves are checked against
whole-frame reads by R17: the reader must find the same items through them (§17.1).

### 5.5 Reading a frame (helper `read`, P2)

- **The helper's threads.** A stdin dispatcher reads commands; a **look worker** runs the look pass
  with its own ffmpeg (§5.2); one **inference worker** runs reads and follow matches from one queue;
  a **careful worker** runs careful re-reads beside it, so the next read is read while the last
  one's lines are read again (a careful pass is about half of a read's work: on A1's recording 8
  reads took 12.2 s and their careful passes 12.4 s, one after the other on one thread). A careful
  re-read that comes while the careful worker is busy goes to the inference worker when that is free
  first. The careful worker's re-read and ffmpeg decoding the next read's frame ahead of time share
  one slot, so the helper keeps at most two threads busy in the read phase (§5.11). `careful`,
  `release` and `cancel { id }` are handled by the dispatcher between commands, never queued behind
  a read: `careful` goes to the front of the queue, `release` frees a read's crops at once, `cancel`
  drops a queued command or stops a running one at its next tile or frame. So a read waiting for its
  careful pass can never block the command that would finish it (R31: a careful pass of every line
  of a frame and a small read sent after it, the read is answered first).
- **One read per command.** Main sends one `read { id, video, key, t, areas }` per planned read (the
  ffmpeg path was given once, at `open`) and keeps at most 3 reads sent and not yet released, so
  the helper holds at most 3 reads' line crops. One counter numbers every command; every event
  carries the command id it answers.
- **Decoding**: for each read the helper starts ffmpeg with `-threads 1 -filter_threads 1`, seeking
  to the key frame at or before it (`-ss <key t> -i screen.mp4 -copyts`, the key frame from the look
  pass; the proxy has one every 15 frames, `proxyArgs.ts:123`) and keeping only the planned frame
  (`select` by `pts`), as RGB24 at full size. Reads less than 1.0 s apart share one ffmpeg run, which
  decodes at most 60 extra frames (about 0.11 s, the cost of one more process). Measured
  (`results/decode-speed.txt`, one thread): one such read costs 0.094-0.106 s of CPU and 0.16 s wall
  with the process start. A read never decodes from the start of the recording, and the next read's
  frame is decoded while the current one is inferred (two threads, §5.11).
- **Too large**: a recording over 7680×4320 or 40 megapixels is refused before decoding (`tooLarge`,
  §10.3).
- **Buckets and tiles**: each area is padded (with zeros) up to the smallest of the three detector
  buckets that holds it, 640×352, 960×544 or 1920×1088; larger areas are cut into as few 1920×1088
  tiles as cover them, spread evenly, so neighbouring tiles overlap only by what is left over (a
  3840×2160 frame is two columns meeting at x 1920 and two rows overlapping by 16 px, four tiles;
  7680×2160 eight); small areas of one read are packed into one bucket (§5.4). A 64 px overlap, which
  this section first gave, does not spare the join below (a line longer than the overlap is cut in
  both tiles all the same) and would take 9 detector runs for a 4K frame instead of 4, and 15 for
  7680×2160 instead of the 8 that §5.11 counts; read through these tiles with the seam join, A16's
  evaluation frames at 200% (3840×2160) cover every one of their 44,100 item-frames. The helper builds the
  three detector plans once when it opens and keeps them for the whole Find: 0.37 s to build, 259 MB
  peak with all three (`results/tract-buckets.txt`). No read ever builds a plan.
- **Detector post-processing** (PP-OCRv6's own `inference.yml`): threshold 0.2, box threshold 0.4,
  unclip ratio 1.4, at most 3,000 candidates; minimum-area rectangles; a line tilted more than 2°
  is cut with a rotated crop.
- **Joining across tile edges**: two boxes from neighbouring tiles that meet inside the band around
  their seam, overlapping or at most half a line height apart (the detector's boxes stop short of a
  tile's edge, and a cut between words leaves the space: 5-8 px at 200% display scale, where a 4 px
  limit left an IBAN and a key in two pieces), on the same baseline within 25% of their height, are
  joined, and the joined line is read again. Boxes inside one tile are never joined.
- **Recogniser**: each line is scaled to height 48 and padded to the next width bucket of 320, 448,
  640, 896 or 1280 (concrete plans; tract runs symbolic widths 3.7-7 times slower). A line wider than
  1280 at height 48 is cut into 1280-wide chunks overlapping by 64, read, and joined at the overlap.
  Both recognisers' five plans are built once at open and kept: tiny 0.23 s and 58 MB, small 0.53 s
  and 188 MB (`results/tract-buckets.txt`).
- **CTC decoding** with the model's character list (from its `inference.yml`); each character's
  x-range comes from its CTC columns (`scripts/privacy/ppocr.py:180-197`), mapped back to video
  pixels.
- **Ring colour**: for each line, the median RGB of a 2 px ring just outside its padded box, and the
  largest per-channel median absolute deviation as its spread (§8.4).
- **QR codes**: rqrr on each area's grey image; the helper returns each code's quad and payload, which
  main classes and forgets (§6.9).
- **Line crops** are kept in the helper until main sends `careful` or `release` for that read (§5.6);
  main's limit of 3 reads in flight bounds them.
- **Caps answer `partial`.** A read that reaches a cap (64 tiles, 3,000 detector candidates in a tile,
  1,000 lines) stops there and answers `partial: true` with the areas it did not finish. Main splits
  those areas and reads them as extra reads (§5.4); whatever still cannot be read becomes a lost area
  counted in `failedReads` (§10.3). A dense spreadsheet or log is therefore read in more pieces,
  never cut silently.
- **Answer**: `{ id, read: { t, lines: [{ box, quad, variants: [{ model, text, conf, spans }], ring,
  spread }], qr: [{ quad, payload }], partial?: Box[] } }`, or `{ id, error }`. Each answer names the
  command it answers; main never relies on their order.

### 5.6 The careful pass, and what the reader measures

Main runs the text rules (§6) on each line's tiny read and sends `careful { id, read, lines }` (its own
command id, the read's id, the line indices) for every line that has a rule hit, a confidence under
0.9, or a run of 16 or more token characters (`[A-Za-z0-9_\-+/.~]`) after cleaning (§6.2):
**careful-long** (question 16). The helper reads those lines again with the small recogniser in its
careful worker, beside the next read and never behind one (§5.5), and answers with its own event `{ id, careful: ReadVariant[][] }` (one list per line
asked, in the order asked), then frees that read's crops. A read with no line to re-read gets
`release { read }`. Main runs the rules on every variant and keeps the union of the hits (§6.1).

**Accuracy on the evaluation set** (ONNX Runtime 1.32, one thread, the stand-in rules of
`scripts/privacy/rules.py`; `scripts/privacy/results/`). *Lines*: the reader alone, the share of each
planted item's ink under the padded line boxes. *Pattern*: an item at least half covered. *Padded*:
99% of its ink inside the padded covers. *Folded*: its text found in the lines' text after folding
O/0 and I/l/1. False hits: ordinary items touched, out of 255; stray covers.

| Config | Set | Lines | Pattern | Padded | Folded exact | Ordinary | Stray | ms a frame | Lines re-read |
|---|---|---|---|---|---|---|---|---|---|
| tiny | main | 98.3 | 100.0 | 100.0 | 84.9 | 1 | 3 | 691 | 0% |
| careful-narrow | main | 98.3 | 100.0 | 100.0 | 92.5 | 2 | 4 | 1,296 | 22% |
| **careful-long** | main | 98.3 | 100.0 | 100.0 | 94.6 | 2 | 4 | ≈1,528 | 30% |
| careful | main | 98.3 | 100.0 | 100.0 | 94.6 | 2 | 4 | 1,953 | 52% |
| small | main | 98.7 | 100.0 | 100.0 | 96.2 | 3 | 6 | 2,396 | 0% |
| tiny | held-out | 98.7 | 99.2 | 98.7 | 87.4 | 4 | 7 | — | 0% |
| careful-narrow | held-out | 98.7 | 99.6 | 99.6 | 93.7 | 5 | 11 | 1,482 | 22% |
| **careful-long** | held-out | 98.7 | 100.0 | 100.0 | 97.5 | 5 | 11 | ≈1,745 | 30% |
| careful | held-out | 98.7 | 100.0 | 100.0 | 97.5 | 5 | 11 | 2,204 | 52% |

- The stand-in rules were tuned on the main set; the held-out numbers are the honest ones. The
  held-out set has new tokens, dark and light swapped and the scales rotated.
- careful-long's times are careful-narrow's plus 66-72 ms for each added line (the small recogniser's
  measured mean per line on these frames).
- Exact text of random keys is low even when they are covered (O/0, I/l/1, `_` read as a space).
  Everything that matches text across frames compares folded text (§6.2).
- The product's rules prototype (`scripts/privacy/detect/rules.mjs`) on the same reads: main set
  233 of 233 text items found, 227 fully covered, 1 of 271 visible items touched; held-out tiny reads
  229 found (98.3%), 224 covered (96.1%), 2 touched. Its held-out misses are two JWTs split by a wrap,
  a token wrapped after a dash, a key read with a space and a mangled `github_pat_` (which the careful
  read fixes); §6.10 adds the rules that close them, and P3's tests hold them (§17.1).

**tract against ONNX Runtime** (`scripts/privacy/results/tract-parity.json`, 3 frames, 36 line crops of
20 widths from 320 to 4,333):

| Model | Largest difference | Result |
|---|---|---|
| tiny det | 2.3e-3 / 1.4e-3 / 4.9e-3 | 3, 3 and 5 of 2,088,960 pixels flip at 0.2; boxes 70/70, 43/43, 57/57 identical within 1 px |
| small det | ≤ 2.3e-4 | no flips |
| tiny rec | 4.2e-5 | 36 of 36 lines decode the same; 3,229 of 3,229 CTC steps have the same best class |
| small rec | 9.8e-5 | 36 of 36 the same |

**tract speed** (one thread, best of 3 after warm-up, `tract-profiles-speed.json`):

| Profile | tiny det, 1920×1088 tile | tiny rec a line | small rec a line | plan build (tiny / small rec) |
|---|---|---|---|---|
| opt-level 3 | 963 ms | 17.2 ms | 97.3 ms | 48 / 139 ms |
| mixed (shipped, §16.2) | 1,136 ms | 19.6 ms | 95.6 ms | 51 / 132 ms |
| opt-level s | 1,220 ms | 20.3 ms | 98.3 ms | 60 / 137 ms |

A full 1080p read with careful-long (37 lines, 11 of them read again) is therefore about
1.14 + 37 × 0.020 + 11 × 0.096 ≈ **2.9 s** on one thread with the shipped profile.

**Through the planned areas.** The first build measured R4 through a real scan, which cuts settle,
typing and reveal areas, pads them by 64 px, tiles them and joins lines across tile edges: pattern
recall 97.9 against 98.9 for whole frames, at the edge of its 1-point tolerance, and its report
pointed at the tile and detector-scale path. This version checks that path on its own: R17 reads the
24 evaluation frames through the areas `planReads` cuts (bucket-padded and packed) and requires
pattern recall and padded coverage within 0.5 points of the whole-frame reads.

**Failures.** Each read runs inside `catch_unwind`. A failed read answers `{ id, error }`: main marks
its areas as a lost area from that frame until the next good read of them, and counts it for
`privacy.run.failedReads` (finding 23). After any caught panic the helper drops and rebuilds its
plans (about 1.1 s), because tract's state inside a panicked run is not trusted. If the helper process
dies (a stack overflow or an allocation failure is not caught by `catch_unwind`), every read in
flight is marked failed (a lost area each), main starts the helper again once per Find, opens the
models again and goes on from the **next** planned read, so a frame that kills the helper is never
read twice. A second death ends Find with what it has, as *Stop* does, with
`privacy.run.failed.crashed` (§2.6).

### 5.7 From lines to suggestions (main, `scan.ts`, P4; the rules are P3's)

- `detectFrame(lines, context)` (P3, §6) runs on every read with the read's lines (every variant),
  the rows and columns they form, the frame size, the kinds on, the regions, the names and never-hide
  lists. It returns hits `{ kind, rule, score, spans: { line, start, end }[], box }` where `spans` are
  own spans (§6.1). It runs in a `worker_threads` worker (`src/main/privacy/rulesWorker.ts`, P4) with a
  time limit of 2 s a read; on timeout main ends the worker, starts a new one, counts the read as
  failed and covers its areas as a lost area (§10.3).
- A hit's **cover box** is the union of its own spans' boxes, padded by max(3 px, 0.35 × line height)
  vertically and max(that, one mean character width) horizontally, then widened to hide the text's
  length (§6.1), clipped to the frame (finding 22). Keys and PEM blocks use their block's full width
  (§6.4).
- A hit's **group key** is its own text folded (§6.2), kept in main's memory only. Hits of one run
  with the same group key share one random group id (`group`, 12 characters).
- QR codes give hits of kind `qr` with their quad's box padded by 4 modules' worth (the quiet zone).
- Pop-up notifications come from the look data (§6.13), not from reads.
- Hits below 0.50 are dropped. A hit at 0.85 or more is `found: 'auto'`, else `'check'`. A
  suggestion's score is the highest of its reads while it is followed; a later read never lowers it.
- Each hit is then followed (§5.8) into a path.
- **How long the text lives (D22).** The lines, the raw texts, the templates and the QR payloads are
  dropped when Find ends. Only the **folded** text of each read line (§6.2), with its frame and box,
  is kept in main's memory, for *Cover this text everywhere* (§5.9), and only for 10 minutes after
  Find ends. It is cleared earlier on *Stop*, on `stopAnalyses` (the editor closing or the project
  being deleted), when the renderer process goes away (`render-process-gone`) and when a new Find
  starts (`forgetReads`). Nothing of it is written, logged or sent to the renderer.

### 5.8 Following

Every hit starts at its read frame R with its cover box and its **parts**: its own box cut into equal
parts no wider than 6 line heights each, at most 3.

**The follow session (D26).** Main opens one session per span of time it walks, in one direction:
`followOpen { id, video, key, from, to, dir }`, the span always `[from, to]` with `to ≥ from`: a walk
forward (`dir` 1) goes from `from` up, a walk backward (`dir` -1) from `to` down. The helper answers
a span given the other way round with `bad-command`; the scan first opened a backward walk's session
as `from > to`, and that refusal turned every hit of a Find into a lost area to the end (found at
integration, 55196fd; a failed walk is now said, §2.6). The helper decodes the frames the walk asks of the
span once each, at half size in grey (the template scale), with `-threads 1`: forward in order,
keeping the last 8 frames; backward one piece at a time, newest first, keeping the piece it is in and
the frames up to a tenth of a second above the frame last asked (a walk going back never asks above
them again; an ask above them starts again there, R32). A walk asks only
the frames where its text could have moved (a still frame holds the box without a match), so the
session seeks over a stretch it is not asked instead of decoding it: forward, to a frame asked more
than a second after the newest it decoded (seeking costs a process and at most one key-frame
interval, as reads less than a second apart share one run, §5.5); backward, to a frame below the
next piece (R27, R28). A backward piece is every frame from the key frame at or before half a second
below its end (at most a second and a half of them) up to its end, decoded with `-noaccurate_seek`
so the key-frame interval it decodes is the one it keeps, and the piece below starts where it did
(R30); a piece reaching the span's start seeks to the start itself. A frame's gradient is worked out
only when a track or a match asks it, and the last two are kept (R29); a kept frame is its grey
image. Measured on A1's recording (60 s, 1080p30, a key frame a second, eight pages with 1 s scrolls):
the walks ask about 250 frames in each direction, and the backward session had decoded every frame
from 53.7 s down to 0 in 108 half-second pieces, each a process seeking to the key frame up to a
second before it (13.5 s), the forward session every frame from 0 to 60 s with its gradient
(4.4 s): 19.4 s of a 49 s Find; seeking and asked gradients make it 4.7 s with the same covers. A
span of one instant ([t, t], every hit of a span read at one frame) holds that frame (R23), and going
backward the frame at t is always that frame itself: the older piece holding it is decoded before a
frame of a newer piece could stand in for it (R24; one did for up to 0.1 s at each piece's edge, and a
backward walk held its box still there while the text scrolled on). Each piece's decoding stops at
the piece's end (R26): its frame selection reaches a tenth of a second past the piece and the run ends
at the first frame selected there, before its pixels are read. ffmpeg holds a selected frame's pixels
until the next selected frame or the end of the recording, so a selection ending at the piece's end
gave the piece's last frame only once the rest of the recording was decoded: 11.5 s a piece of a
144 s recording against 0.06 s, and a backward session over it did not finish in 20 minutes. Main registers each
hit as a **track** with `track { session, track, t, parts }` (templates cut at frame `t`), then walks
every track of the span together, one analysed frame at a time: `match { session, t, tracks: [{
track, parts, candidates }] }` answers `{ id, matched: [{ track, parts: (number | null)[], best: {
dx, dy, scale } | null, second: number }] }` for every track at once. So 20 hits on one page cost one
decode of each frame, and main can feed each frame's candidates from the result of the frame before
(the speed guide, re-anchoring). `closeSession` frees it. A frame costs about 3.1 ms to decode at
half size (`results/decode-speed.txt`), its gradient about 2.5 ms, and a few hundredths of a
millisecond a part to match.

**Templates.** At `t`, each part's box padded by 25% of the line height, cut from the half-size grey
frame, as Sobel gradient magnitude. Gradient magnitude does not change when text is selected or
inverted (dark mode, a highlight), so one template serves both.

**Forward walk.** For each analysed frame f after R:

1. If no tile under the cover's box changed, the box holds (no key).
2. **Candidates**: the moves of the regions overlapping the box at f (best and alternatives), no
   move, and the **speed guide**: the last placed move per frame times the frames since. A box that
   holds at step 1 is placed there, standing still, so the first move after still frames is the
   speed of one frame (counted from before them, it was spread over them, and the guide put a text
   scrolling in at the frame's edge a tenth of the way). A move is
   its region's **real move** (the one that carries a lost box, ends or starts a walk by carrying the
   text out of its region or the frame, and rules out a zoom) when the look pass scored it 0.5 or
   more, or when a move scored so in the same frame agrees with it within a look pixel (a scroll's
   strip of new content scores lower than the body moving with it). A weaker shift stays a candidate
   only: every page change and in-app zoom gets one (0.06-0.45 on the evaluation frames, against
   0.75-1.0 for real scrolls), and taken for a move it ended walks by chance and kept zooms from
   being tried. Of a region's shifts, its own move (the first, continued from the frame before, §5.2)
   is its real move when it is real; an alternative scored a little higher is not.
3. For each candidate, each part is matched by gradient NCC at its predicted place ± 4 template
   pixels (±8 video pixels; `RADIUS` in `follow.rs`, at any display scale, §5.3).
4. **Placed** when at least one part scores 0.6 or more, the best candidate beats the next by 0.15 or
   more (one clear best match), and the placed parts agree within 2 px. **Near first**: each frame's
   match is asked first with only the candidates landing where the walker's own predictions put the
   text (the predicted place, no move, the speed guide and its region's real move from the predicted
   place: without the move, a scroll of more than a line a frame was placed on a similar line where
   the text had been), so a copy of the same text further away
   (a list showing one email on every twelfth row, its look moves offering the scroll and its
   aliases) never makes the match ambiguous; only when no clear match is there are all candidates
   asked, and not when the walker's own motion takes its cover box partly out of the frame (the
   template is cut padded, so a text whose ink is inside but whose padding is not matches nowhere
   either), where a match
   elsewhere is a copy, not where it went. The box moves by that
   candidate; `stepKeys` writes the key at f and, when the box moved, the union key before it (§4.2).
5. **Not placed** while the region changed: the cover becomes a **lost area**. Its box at f is the 2-D
   union of the box, the box moved by **every** candidate, and **every changed region the box
   overlaps**, whatever the candidates scored (finding 4: never a band along one axis). A move that
   is not among the candidates (a Page Down larger than half the region, a jump, a false 0.45 match
   in dense text) therefore still lands inside the lost area, because the text stays inside the
   region that changed. The last placed templates are tried at every later changed frame; one clear
   match places the cover again.
6. **Zoom inside the recorded app** (the whole region changed with no real move): before the cover
   is lost, one zoom is estimated for the region from all the walkers in it together. Each walker's
   parts are tried at 0.8, 0.9, 1.1 and 1.25 about the region's centre and at every scale from 0.6 to
   1.67 in steps of 1.5% (with a browser's zoom steps, 1.1, 1.136, 1.2 and their inverses) about the
   region's top left and centre and the frame's top left and centre; each walker's best place says a
   scale and an anchor, and the scale and anchor most walkers agree on (within three steps, as each
   best place is refined within the helper's search: a browser's ×0.88 was said as 0.833-0.924; each
   matching at 0.6 or more) is the region's zoom when half or more of the region's walkers agree on it
   (a page that changed gives scattered places, a few agreeing by chance: on the held-out pages a zoom
   two keys agreed on placed a third key on the new page, where its cover stayed for pages, 75% of a
   frame covered); a region of one walker needs a part at 0.85. Every walker of
   the region is then placed by it where a part matches at 0.6 or more. A browser zooms about the
   page's top left by steps the four scales about the centre missed (1.136, 1.2, 0.833 ...), and the
   page's repeated rows tied with each walker's own: A16's browser zoom was lost over the whole page
   on every step. Not when the walker's own motion takes its cover box partly out of the frame (a
   code at the bottom edge, cut there, was placed by a zoom 140 px away).
7. **Cut at the frame's edge.** The walker's **own motion** is its region's real move, or, when its
   region has none, the speed guide while it was placed at the step before: a strip of a page
   scrolling in or out at the frame's edge is too short for the look pass to find its move (under 6
   tiles), and the text in it is cut, so no template matches it. When that motion moves the cover box
   partly out of the frame, past an edge it moves toward (a box resting over an edge, its padding
   beyond it, that moves along the edge is not leaving, and is matched as any other), the text is
   placed where it puts it, and the box holds the union of its
   last box and the moved one, clipped to the frame, until the motion takes it wholly out (below and
   in the backward walk). A1's scroll-ins started their covers one or two frames late without it.
   For a walker placed at the step before whose motion is its region's real move, the region's edges
   count as the frame's: a page scrolling under what does not scroll (a sticky header, a toolbar) goes
   out of view at the region's edge, whose tiles do not change. An edge of the region inside the frame
   is taken one tile in (the region is known to a tile, and a sticky header covers the top of its first
   row of tiles): a row reaching it is cut already, its padded template taking in the header's edge
   (it matched 0.51 where it was going, and a copy of it a period down matched clearly and took the
   cover). A lost walker's motion is a guess, and only the frame's edges count for it.

**Evidence of absence.** A cover ends only when the text is shown to be gone:

- its region changed at frame C, and
- the next read covering its box or lost area, at frame S, finds no line holding the text, and
- no part scores 0.5 or more where the walker's own motion puts the text at S (the predicted place,
  no move and the speed guide: a text partly under a tooltip or a toast still matches there, and at
  the first frame of a recording one under a tooltip was taken for gone and showed for a frame);
  for a text lost at a page change (30% or more of the frame changed with no real move) since it was
  last placed, those places hold the new page and are judged as the region's other places are,
  below: left out where they reach half onto a line the read at S read, and otherwise the text only
  where the walk would place it or a part scores 0.85 (on the evaluation pages a key's own place
  showed other text scoring 0.53-0.61, read or not, and its lost area, the whole page, lasted for
  pages), and
- the template search at S, anywhere in the region at scale 1 and at the zoom scales of step 6, finds
  no place where the walk would place the text (no part at 0.6 or more beating every other place by
  0.15, step 4) and no part at 0.85 or more, leaving out the places whose search window (±8 video
  pixels) reaches half onto a line the read at S read: none of those lines holds the text, so other
  text is there. On a page of other text a part at 0.5 is always found (0.57-0.84 on the held-out
  frames, with the second best within 0.07 of the best), so the old rule, no part at 0.5, never gave
  evidence after a page change and the lost area, the whole page, lasted to the end; the text
  itself scores 0.87 or more. Without the reader (Follow, §5.9) the search alone is the evidence and
  keeps the old rule.
  **New: the search is complete.** Its candidates stand on a grid 16 video pixels apart (twice the
  helper's ±8), so the window about them reaches every place of the region, at any display scale and
  in a region of any size; the helper is asked in calls of at most 1,200 candidates a track, and their
  answers are joined as one (the best place, and the best of every place more than 2 px from it). A
  search that left places unasked would be no evidence that the text is gone. Found by review: the grid
  was 16 × the display scale (32 px at 200%) and grew by a quarter until it held 1,200 candidates (49 px
  over a 1080p page), so a text a page laid out again had moved between its points was taken for gone,
  and without the reader its cover ended while it showed (in 8 of 16 landing places over a page and 1
  of 16 in a panel at 200% with the real helper).

"Holding the text" is generous, because reading is not exact (folded exact text is 94.6-97.5%,
§5.6): a line holds it when it has the folded own text; or for a text of 12 characters or more, any
third of it; or for a text of 5-11 characters, the text within edit distance 1 or any run of 4 of its
characters; or for a text of 4 characters, the text itself; for one to three (a wrapped token's last
characters, §6.10), only a line that is the text, but for marks: such a text is in nearly every line,
and a JWT's last character on the held-out logs page, lost at the page's end, kept the whole frame
covered for the 102 s to the recording's end. One misread digit of a six-digit code therefore
never ends its cover. **New**: for a text lost at a page change since it was last placed, whose lost
area is the page, only a line holding the whole folded own text (or within edit distance 1 of it)
holds it: on the 150% evaluation pages an email lost at a cut kept the whole frame covered for the
next page (6 s), another email there sharing a third of it (its domain).

It then ends at the analysed frame after the first changed frame e from C on at which the walk's
match did not find the text by the same rules (no part at 0.5 where its own motion puts it, no clear
match and no part at 0.85 anywhere it was asked; at most 16 frames are checked; at S when more): frame e itself, which may show a fading glyph,
and the source frames up to the next analysed frame stay covered (§4.2). Until then it goes on,
placed or lost, with no time limit. A read that finds the same group key again re-anchors the cover
there, and the walk backward from that read corrects the path to the last placed frame (the lost
area between them stays).

**Carried out of the frame.** Going forward, a cover also ends where the walker's own motion (step
7: the real move of the region the text moved with, or the speed guide) carries its box wholly out
of the frame (scrolled or dragged out of view), or, placed at the step before, wholly out of the
region it moved with (under a sticky header: a row scrolled under one was lost over the whole column
to the end, the reads finding its copies further down), with no
read needed: the mirror of the backward walk's rule. That frame's box is the union of the last box
and the moved one, clipped to the frame, so the source frames before it, which show the text cut at
the edge, stay covered, and the cover ends one analysed frame after it: a text cut at the edge is
not fading, so no earlier end frame applies (at 60 fps the frame between two analysed frames showed
it, and a text lost at the edge for a few frames ended at the first of them).

**Backward walk.** From R back to the start: the box at f is the box at the next analysed frame
moved back by the move the look pass found **between f and that frame** (finding 3: never the move
before f). The same placing and lost rules apply, and the walk **does not stop at the first frame
where no part matches**: a tooltip, a hover highlight, the cursor, a toast or a caret over the text
makes frames with no match while the text is still there. It goes on, placed or lost, until one of:

- **evidence of absence going back**: at an earlier frame S′, a read covering the box or lost area
  lacks the text (with the same generous rule) and the template search there finds no place for it
  (the same rule as going forward).
  When no read covers it, the walk asks for a **check read**: the box's padded area (or the lost
  area) at the analysed frame before the earliest frame with no match, read alone (about 0.1 unit,
  §5.4). A check read that finds the text re-anchors the walk, which goes on back;
- a **page change** (30% or more of the frame changed, `SCREEN_RULES.page`,
  `src/shared/smart/screenChanges.ts`, with no real move of the box's region, step 2: the spurious
  weak move the look pass gives a cut is none, and counted as a scroll it made every walk on the
  evaluation pages ask for a check read of the whole frame at each cut) at a frame where the match
  where the walker's own motion puts the text finds nothing (no clear match and no part at 0.85: a
  token on a half-pixel step of a scroll matched 0.88 against its own line's 0.75, and its cover
  started early);
- the box has moved **wholly outside the region it moved with, or outside the frame**: the text
  scrolled or was dragged into view there. Its own motion (step 7) carries it: cut at the edge on
  the way, the box holds the union of its box and the moved one;
- the first frame of the recording.

The cover then starts at the first source frame after the frame proven absent, with the union key of
§4.2. So text that scrolled into view, or sat under a tooltip, before its first read is covered from
when it appeared.

**Text typed or deleted in place.** Text that grows one character per keystroke (an email or a card
number typed into a form, a key typed into a terminal, a code into a field) matches no part until
most of a part is there, so the rules above would leave its first characters uncovered. So:

- When the frames before R change only inside the hit's **line band** (the rows of its padded box,
  from the line's left edge to the right edge of its changed region), or a typing burst, a
  text-cursor span or a paste (§5.3) covers them, the backward walk covers back to the start of that
  burst, or to the first frame after the line band was last still for 1.0 s, whichever is earlier,
  with one box: the union of the own box and every changed tile of the line band in that span. That
  piece is marked `lost` (it covers an area). The cover's start then follows the evidence rule above
  from there.
  **New: in place only.** The line band is where the text is at the frame the rule starts from, and
  the piece never reaches back across a real move (step 2) of the region the text is in: what came
  into the band with a scroll or a drag was typed, if it was, where it came from. The walk follows the
  move back as it follows any move, and once it places the text across a real move it applies the rule
  again there, on the band the text came from. Found by review: a key typed or pasted on a terminal's
  last line, then Enter scrolling the terminal up, was read only after the scroll (the typing read and
  the settle read are merged); the typing burst covered the scroll, so the band the key scrolled to was
  held back to the burst's start and the walk skipped the frames between, and the key showed a line
  lower while it was typed (248 of 360 source frames in a whole Find), and a token a command printed
  while its output scrolled the terminal showed on 20 frames. Going forward the band follows the text
  in the same way.
- Going forward, when the parts stop matching while the line band changes inside a typing burst (the
  text is being deleted or changed), or, with no typing hint, while only the line band changes in a
  burst (changed again less than 0.3 s after it last changed, as text deleted one key at a time is:
  the backward rule's mirror), the cover holds as the same union until the burst ends and the band
  has been still for 1.0 s; only then does the evidence of absence apply. A key typed into a terminal
  and deleted again one key a frame, with no cursor data, was taken for gone once its last characters
  matched no part: the read after the deletion lacked it, and its first character showed in the last
  frame. Text cleared in one change is gone, and the evidence applies as before.
  **New: in place only**, as going back: not while the walker's own motion (step 7: its region's real
  move, or the speed guide of a text moving when it was placed at the step before) carries the text;
  the rules for a text cut at the frame's edge and carried out of it apply. Since the band follows the
  text, a line a scroll was taking out at the frame's top over a plain background had only its own
  line's tiles changing near it (the zone around the band is cut at the frame's edge), so the hold
  began there: on A1's pages the cover held a band across the top of the frame while the next page
  scrolled through it, 9.6% of a frame covered on average against 8.6%.
- The read that finds such text is §5.4 point 2's in-place read, where its line showed the most of it.

**What this handles** (each is a case of A16, §17.3): scrolling lists and pages (vertical moves), a
fast scroll of 1,500 px a second checked on every source frame, horizontal scrolling, a window
dragged across the screen (2-D moves), a sticky header (its tiles do not change, so covers in it hold
while the body scrolls), a selection or highlight drawn over the text, zoom in the app, toasts sliding
over covered text (the cover is lost under the toast and placed again when it leaves), a toast or
tooltip over text before its first read, and text typed into a field or a terminal and deleted again.

### 5.9 *Follow what is under it* and *Cover this text everywhere*

- **Follow** (`followCover`, P4; run from P1's `followRun.ts`): main reads the cover's box at the
  playhead's frame; the lines at least half inside it make the template and the group key. The walks
  of §5.8 run from there. **Inside the time the walks reached** (from the backward walk's start to
  the forward walk's proven end), the followed path replaces the old box wherever it was placed; the
  old box is kept only where the walk was lost, and before and after that time. So a cover made *To
  the end of the video* over an email, then followed through a scroll, leaves no box at the old place
  once the text has moved. The user asked for it and it is one undo step. Without the reader, the
  template is the raw box itself, following is by template only, the cover ends only where the region
  changed and the template fails, and the result is marked `thin`.
- **Everywhere** (`underCover` then `coverEverywhere`, P4; P1's `EverywhereDialog.tsx`):
  1. `underCover { projectId, requestId, t, box }` reads the cover's box at the playhead's frame,
     keeps the characters of its lines that lie inside the box (the read's margin reaches the words
     beside the cover on the same line, and "to priya.raman@example.com" was then looked for
     everywhere, never finding the email standing alone), and answers `{ ok: true, nameLike } | { ok: false, reason: 'noText' | 'reader' | 'failed' }`. Main
     keeps the text for that request id only, until the dialog closes. `nameLike` is true when the
     text is at most 40 characters of letters, spaces, `.`, `'` and `-`, and no rule of §6.4-6.8 hits
     it. A key, a password, a code or a number is never name-like.
  2. `coverEverywhere { projectId, requestId, remember }` looks for the same folded text in the kept
     reads of the last Find (§5.7) when there are some; otherwise it runs Find with that text as the
     only target and every other kind off, using the look cache, with Find's estimate, progress and
     *Stop*. Each place is followed and added as a cover of kind `text` in a new group, in one undo
     step. They are suggestions, tiered by main's score (Auto, or Check for a lost area), as every
     group is (§4.1): one Review row, *Text you chose* (§2.7's `text` sentences), kept or uncovered
     there. The cover the user started from stays theirs.
  3. `remember` is `'no'`, `'project'` or `'settings'`. Only when it is not `'no'` and the text is
     name-like does the result carry `addedName: string`, which the renderer adds to
     `Project.privacy.names` (in the same undo step) or to Settings' names. This is the one place the
     screen's text reaches the renderer, by the user's explicit choice, and it then shows in the names
     list. Every other result holds no text (test 233). The dialogs that show the list read it again
     afterwards (finding 28).

### 5.10 Find again, groups, merging and applying (P4 `found.ts`)

- **Find again never uncovers anything.**
  - Covers the user owns (no `found`) are never changed.
  - A new suggestion is dropped as a duplicate only when one existing cover contains it: at every key
    of the new path and every key of the existing path inside the new one's times, the existing
    drawn box (with slack) contains the new box (`containsOver`, §16.0). Overlap is not enough.
  - The last run's suggestions that this run did not find stay, marked `missed: true`, with their
    group; a later run that finds them again clears the mark.
  - **A removed path suppresses only what it holds (D21).** A new suggestion is not added only when a
    rejected place of the **same kind** holds it: at every key of the new path, and at every key of
    the rejected path inside the new one's times, the rejected path's drawn box (with slack)
    contains the new box (`containsOver`, §16.0). Removing one false email on a scrolled list
    therefore never stops a different email shown later in the same area. A removed place never
    suppresses another kind. Each suppression is counted (`FindRecord.suppressed`) and reported
    (`privacy.run.suppressed`).
- **Groups**: one Review row (§2.7). Covers of one group whose boxes overlap throughout the time they
  share (the same place found twice), or that are within 0.5 s of each other with boxes overlapping
  where they meet, are merged into one cover whose path is the union. Two places of one text whose
  boxes only cross (a list showing one email on many rows, one of its walks lost over the list for a
  moment) stay two covers: one cover is one box at a time, so their union would cover every row
  between them for their whole time (A16's lists were covered over their whole column).
- **Indexes** (finding 7, and the quadratic loops a 2,000-cover project would hit): containment
  against existing covers and against rejected places looks only at candidates from a time index
  (one-second buckets) and a coarse spatial grid (8 × 8 cells of the frame), built once per call.
- **Limits**: over `MAX_COVERS` (2,000) covers, `mergeCovers` merges the cheapest pairs first (same
  kind before any kind; cost = added area × added time), with a heap. Candidate pairs are only each
  cover's 8 nearest by start time among the covers sharing a grid cell with it, refreshed for the
  merged cover after each merge, so the work is O(n log n) (finding 7), never all pairs. Merging only
  grows boxes and times. A drawn cover is never dropped. Over `MAX_KEYS`, `simplifyKeys` (§4.2).
- **Applying**: the result is applied with `withFoundCovers(project, result)` (P4) in one
  `store.update` scheduled with `afterGestures` (`src/shared/editor/editStore.ts:299`), against the
  project as it is when the result lands, so a drag during Find is never overwritten and never
  overwrites the result (finding 16). The same update adds the private bleeps of §7.2, sets
  `Project.privacy.find` and clears `missed` where it applies.
- **Stop**: what was found so far is applied the same way; covers whose walks were not finished run to
  the end of the recording as lost areas over the union of their last box and the region they were
  moving with (§2.6); `FindRecord.stopped` and `readTo` say how far the screen was read. **New**: that
  holds for every item of a span being walked, also those the stopped walk had not reached yet (a span
  is walked back from its latest item and forward from its earliest): one the backward walk had not
  reached is covered as an item no walk followed (§2.6), from one source frame after the last good read
  of its place without it, over its box and the regions changed at its frame; one the forward walk had
  not reached runs to the end over the same. Found by review: Stop during a backward walk covered an
  earlier item only from its read (an email showing from 2 s, read at 2.3 s, showed uncovered for nine
  frames), and Stop during a forward walk ended a later item's cover at its read, though it showed for
  ten more seconds (`unwalkedCover`, shared with the items of spans never walked).
- **Copies made before Find** (§2.12): `privacy:copies { projectId }` lists the projects whose
  `copyOf.id` is this one (`ProjectSummary.copyOf`); `privacy:coverCopies { projectId, copyIds }`
  reads each copy's `project.json`, adds this project's covers and private bleeps with
  `withFoundCovers` as suggestions (kinds, groups and tiers kept; containment and the copy's own
  rejected places apply), and writes it through `projectFileText`. A copy that is open in the editor
  is skipped and says so; it can use *Bring them over* (§2.12). `privacy:originCovers { projectId }`
  answers how many of the original's covers and private bleeps a copy lacks, and returns them for
  *Bring them over*. Main reads the project open in the editor from its `project.json` for both, so
  the renderer first writes it as the user sees it, as the export's timeline does (§9 row 10): the
  offer awaits the editor saver's `flush` before `privacy:coverCopies` (a press before the autosave
  would give the copies the covers of the last save), and the export note calls the dialog's `flush`
  before `privacy:originCovers`.

### 5.11 CPU and memory budgets

For a **20-minute recording at 1920×1080 and 60 fps** (72,000 frames, H.264 as Flown's proxy is) on a
**4-core laptop** (the reference PC of decision 8). Every figure marked *measured* is from this
machine on one thread (`results/decode-speed.txt`, `results/tract-buckets.txt`, §5.6); the reference
PC measures them again before release.

**Threads.** Find keeps **at most three threads busy at once**, all at below-normal priority, so the
editor keeps a core:

- **Look phase** first: the look ffmpeg on 2 threads (the only ffmpeg with more than one) and the
  look worker's analysis on 1.
- **Read and follow phase** next, minute by minute (the reads of a minute, then its follow sessions):
  the inference worker on 1 thread (or its ffmpeg with `-threads 1` decoding the read's frame or the
  session's frames while it waits); in the read phase, one second thread in the helper: the careful
  worker re-reading the last read's lines, or ffmpeg decoding the next read's frame while the current
  one is inferred, never both (§5.5); the rules worker in short bursts between.

| Stage | Work | CPU | Basis |
|---|---|---|---|
| Look: decode | every one of 72,000 frames decoded; 36,000 analysed frames scaled to 480×270 grey | 72,000 × 1.77-1.86 ms + 36,000 × 0.65-0.7 ms ≈ 150-160 s; ≈ 80-100 s wall on 2 threads | *measured* per frame (decode only, and decode with the look scale) |
| Look: analysis | tiles and moves on 36,000 analysed frames | about 15 s | 0.4 ms a look frame (estimate; R11 measures it) |
| Reads: inference | 150 units (§5.4) with careful-long, check reads and partial reads inside the budget | 150 × 2.9 s ≈ 435 s of CPU; the careful re-reads (about half of it) on the second thread beside the reads (§5.5) | *measured* tract times: detector buckets, tiny and small recognisers per line (§5.5, §5.6) |
| Reads: decode | about 300-600 reads, each a seek to its key frame (reads less than 1 s apart share one) | 0.094-0.106 s each ≈ 30-60 s, on the second thread while the first infers when the careful worker is not re-reading | *measured* (one read with its process start) |
| Rules | about 37 lines a unit × 1.3 variants | under 3 s, in the rules worker | prototype: 40-250 µs a line |
| Follow: decode | the frames the walks ask, about 15% of all, once each at 960×540 grey; the sessions seek over the rest (§5.8) | 10,800 × 3.05-3.06 ms ≈ 33 s, on the second thread | *measured* per frame |
| Follow: matching | parts × tracks × analysed frames in sessions | under 10 s | 0.05 ms a part a frame (estimate; R22 measures it) |
| **Wall time** | look phase, then reads and follows | **about 9-11 minutes** (0.45-0.55 × the recording's length) | the sum of the rows' wall times; the plan's real units replace it in the second estimate |

The 150 units are the budget, not a measured distribution: how many units a real recording's plan
needs (settle bursts, typing, reveals) is measured on A16's videos at integration and on decision 8's
30 real recordings, and every user sees the second estimate made from their own plan.

**Measured here** (24 November 2026, this machine, otherwise quiet; the helper's host build, through
its protocol with each command's time; the reference PC measures again, decision 8). The band is
converted to a recording on this machine as the first estimate is: this PC's own decode speed `d`,
which Find records from its look pass (look time × 1.8 × the 1080p area ratio ÷ frames), and the
plan's units at 2.9 s. A1's recording (60 s at 1920×1080 and 30 fps, 1,800 frames, lossless H.264
4:4:4 with a key frame a second; eight pages with 1 s scrolls between them; a plan of 8 units, its
budget): `d` = 3.4 ms (lossless 4:4:4 frames decode more slowly than the proxy's 1.85 ms), so
1,800 × 3.4 ms ÷ 1.8 + 8 × 2.9 s + 0.05 × 60 s = 3.4 + 23.2 + 3.0 ≈ **29.6 s**, within the band of
0.45-0.55 × 60 s = 27-33 s.

| A1's Find | Before | Now |
|---|---|---|
| In the app (the end-to-end A1: *Find took*, the scan's own time) | 50-56 s (48.1-53.9 s): 0.83-0.93 × | **27-28 s (25.3-26.5 s): 0.45-0.47 ×** |
| Headless, the same scan | 48.7-50.0 s | 26.3-27.2 s |
| Open (hash, parse, build every plan) | 1.3 s | 1.0-1.3 s |
| Look (1,800 frames, 2 ffmpeg threads) | 3.3 s | 3.0-3.9 s |
| Reads (8 whole frames, 293 lines, 114 read again) | 24.7-29.5 s: the reads 12.2 s and their careful passes 12.4-16.8 s, one after the other on one thread | 16.8-17.6 s (2.1-2.2 s a unit): the careful worker beside the reads (§5.5) |
| Follow (2 sessions, about 250 frames asked in each direction) | 19.4-20.0 s: every frame from 53.7 s down to 0 in 108 half-second pieces, every frame from 0 to 60 s, each with its gradient | 4.9 s: 14 backward pieces decoding 386 frames, 281 forward frames and 7 seeks, 341 gradients (0.8 s), 378 matches (0.9 s) |
| The helper's peak memory | | 442 MB at 1080p; 502 MB at 3840×2160 (the evaluation frames at 200%) |

The same Finds made the same covers (98, every one of A1's 20,495 item-frames covered, 8.6% of a
frame on average). A16's evaluation cases (144 s each) went from 229, 425 and 595 s to 125-130,
252-266 and 350-358 s, every item-frame still covered: their plans (24, 96 and 144 units against
budgets of 18, 36 and 36) run over the budget as §5.4 point 7 allows, so the band does not bound them. The follow phase is
still about 0.08 × the recording's length on A1, more than the 0.05 the first estimate allows,
because its frames are decoded after the reads rather than beside them. On recordings that change
page, the follow phase is the template searches at each cut, not decoding: on the held-out set
(headless, 129 s) it took 64 s, 52 s of it in the 62 matches over 0.2 s, each walker lost at a cut
trying the zoom grid and the region's other places (§5.8 steps 4 and 6) at about 2 µs a placement of
a part; the inner product itself is at its scalar speed, so only fewer placements would shorten it.

| Process | Peak memory |
|---|---|
| `ssw-ocr.exe` | ≤ 600 MB at 1080p and 4K, ≤ 750 MB at 7680×2160: detector plans for the three buckets 259 MB (*measured*, with their input and activations), small recogniser plans 188 MB and tiny 58 MB (*measured*, each with its own process's base; all built once at open and kept, §5.5), a careful re-read running beside a read (§5.5), at most 3 RGB frames in flight (6.3 MB each at 1080p, 25 MB at 4K, 50 MB at 7680×2160), line crops ≤ 20 MB, a follow session's frames at half size in grey (backward the piece it is in and the 0.1 s above the frame asked: at most about 0.85 s of frames with the proxy's key frame every 15 frames, 26 MB at 1080p60 and 105 MB at 4K; forward 8 frames) and the gradients of the last two frames asked (4 MB at 1080p, 17 MB at 4K), the look worker ≤ 10 MB; *measured* peak 442 MB at 1080p (A1) and 502 MB at 3840×2160 |
| `ffmpeg.exe` | 76-124 MB each (*measured* peak: look 76 MB, a read's seek 93 MB, full-size RGB 124 MB); at most one at a time in each phase |
| main (scan state) | ≤ 60 MB: look data 11 MB, the run's folded texts and boxes, the paths |
| renderer | the covers only: under 5 MB for 2,000 covers |

- **4K** (3840×2160): the look scale keeps the look frames at 480×270, but decoding is about four
  times the work; reads take up to twice the units (§5.4). Estimated 2-3 times the 1080p wall time.
  **7680×2160**: eight tiles a full read. Both are measured on the reference PC (decision 8).
- **First estimate** (before Find starts, §2.5): `frames × d / 1.8 + readBudget(duration, size) ×
  2.9 s + 0.05 × duration`, where `d` is 1.85 ms a frame at 1080p scaled by area until this PC's own
  decode speed is known (recorded after each Find in `userData/reader-models/models.json`), and 1.8 is
  the speed-up of two decoding threads.
- **Second estimate** (after the look pass, §2.6): from the plan's units, the read speed measured on
  this run's first reads and the follow spans.
- **Recording in progress**: Find does not start while Flown records (`privacy.run.waiting`). When a
  recording starts during Find, main sends `pause`: the helper stops reading its ffmpeg's output (the
  pipe fills and ffmpeg blocks), and its workers stop at the next tile or frame, at most one
  1920×1088 detector run later (0.87-0.91 s *measured*). `resume` continues. Windows has no call to
  suspend a job object, so this is the mechanism. Main reads the state with `isToolbarVisible()`
  (`src/main/recording/toolbarWindow.ts:89`, imported as `busyReason` does at
  `src/main/updates/updatesIpc.ts:14, 33`, never edited), every 2 s while Find runs.
- **Other work**: Find registers as an `analysis` job, so *Restart now* and the language relaunch wait
  for it (`busyReason`, `updatesIpc.ts:30-42`).

### 5.12 The models: pins, download and checks

`src/shared/privacy/readerCatalog.ts` (written in full by the contracts step, §16.0; P2 uses it):

| File | Upstream repository @ commit | Bytes | SHA-256 |
|---|---|---|---|
| `PP-OCRv6_tiny_det_onnx/inference.onnx` | `PaddlePaddle/PP-OCRv6_tiny_det_onnx` @ `2ba1506c0380b8f0b03dd142459aac66d4421f6c` | 1,780,590 | `193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8` |
| `PP-OCRv6_tiny_rec_onnx/inference.onnx` | `PaddlePaddle/PP-OCRv6_tiny_rec_onnx` @ `2612ab37152ae0a677521bae4e1e3d4fb4cf7c30` | 4,462,639 | `9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6` |
| `PP-OCRv6_tiny_rec_onnx/inference.yml` | same | 55,571 | `66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1` |
| `PP-OCRv6_small_rec_onnx/inference.onnx` | `PaddlePaddle/PP-OCRv6_small_rec_onnx` @ `b8f84f0b80c529de40b4fbb3544b84fa7233a513` | 21,159,378 | `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634` |
| `PP-OCRv6_small_rec_onnx/inference.yml` | same | 150,579 | `ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1` |

Total 27,608,757 bytes. The tiny detector's `inference.yml` (883 bytes, SHA-256 `3ac018be…`) is not
downloaded: its four post-processing numbers are constants in the helper, and test 85 checks them
against the pinned file in `scripts/privacy/reader-models.json`.

- **Licence**: Apache-2.0 (the model cards' metadata; the ONNX repositories hold no LICENSE file, so
  the text is PaddleOCR's LICENSE, 11,376 bytes, SHA-256 `3840c5c0…`). The mirror holds the five files,
  that LICENSE and a NOTICE naming PaddlePaddle, the upstream repositories and commits, and that the
  files are unchanged.
- **Sources** (`readerUrls(file)`): `READER_MIRROR: { repo: string; commit: string } | null = null`
  first, then the upstream URL at its pinned commit
  (`https://huggingface.co/<repo>/resolve/<commit>/<file>`), which serves the pinned bytes today
  (decision 10). Hugging Face answers with a 302 to `us.aws.cdn.hf.co`, which `allowDownloadUrl`
  (`src/main/speech/download.ts:188`) already allows (`*.hf.co`). Its `x-linked-size` and
  `x-linked-etag` headers equal the pins. A release with `READER_MIRROR` still `null` fails
  `verify-dist` (§16.2).
- **Download** (`src/main/privacy/readerModels.ts`, P2): one file after another through
  `downloadPinned` (`download.ts:247`), which resumes a `.part` with Range after checking its prefix
  hash, checks every redirect hop, and checks size and SHA-256 at the end. Files go to
  `userData/reader-models/` with `models.json` (`{ files: { [file]: { bytes, sha256 } }, decodeMs? }`).
  One download at a time; *Cancel* stops it and keeps the `.part` files for resuming.
- **Before use**: main checks every file's size and SHA-256 when Find starts (about 0.1 s for 27.6 MB)
  and the helper checks them again before parsing any (§10.2). A damaged file is deleted and the state
  becomes `damaged` (`privacy.settings.readerDamaged`).
- **Remove** deletes the folder. Nothing else is ever downloaded for this feature.

### 5.13 The Windows reader (behind `WINDOWS_READER_ALLOWED`, P2)

Decision 1 offers Windows OCR only after it passes decision 8's check (95% or more pattern recall,
99% or more padded coverage). For that check to be run, the helper carries it:

- `open { reader: 'windows' }` makes the helper use `Windows.Media.Ocr` (`OcrEngine` for the user's
  profile languages, through the `windows` crate's WinRT bindings) instead of tract. Reads, tiles,
  buckets, the careful pass (skipped: one reader only), caps and answers are the same. Windows OCR
  gives word boxes but no character positions, so each word's characters get equal shares of its
  box; the own-span padding of §6.1 covers the difference, and R10 measures it.
- Its imports are added to the helper's allow-list (`combase.dll`, `oleaut32.dll`,
  `api-ms-win-core-winrt-l1-1-0.dll`, as the first build measured) and the helper's size budget is
  measured with them (§16.2).
- **R10** (Windows, reference PC) reads the 24 evaluation PNGs with it and scores them with
  `score_reader.py`'s rules. Whether it runs from an unpackaged helper, its speed and its memory are
  measured in the same run.
- `WINDOWS_READER_ALLOWED = false` (`readerCatalog.ts`) keeps every path to it closed: main never
  sends `reader: 'windows'`, and no control or message offers it (§2.14). Turning it on, with the UI
  that offers it, is a later change made only after R10 passes.

---

## 6. The detectors (P3, `src/shared/privacy/detect/`, pure)

The full rule table, with every pattern as a JavaScript regular expression, its score and its
source, is `scripts/privacy/detect/RULES.md`; its prototype is `scripts/privacy/detect/rules.mjs`.
P3 implements those rules as written, with the changes this section makes, and its tests are the 203
vectors in `tests/fixtures/privacy-eval/rule-vectors.json` plus the end-to-end scores of §17.1. This
section gives what each kind finds, how, and why.

### 6.1 Hits, own spans, cover boxes and tiers

- A **hit** is `{ kind, rule, score, spans, box }`. Its **own spans** are the secret's own characters
  `[start, end)` in each line, never padded. Everything that finds the secret again (the group key,
  *Cover this text everywhere*, spoken forms, the masks of §7) is built from the own spans, never
  from the padded box (finding 11).
- The **cover box** is the own spans' x-ranges (from the character spans) and the line's y-range,
  padded by max(3 px, 0.35 × line height) vertically; horizontally by max(that, one mean character
  width) at the line's ends (where the span starts at the line's first character or ends at its last)
  and by the vertical pad where other words of the line stand beside it; clipped to the frame, never
  rounded past its edge (finding 22). The stand-in scorer measured that one character width plus a
  quarter line height is the smallest pad that fully covers a 4-character PIN; 0.6 of a character
  width left it 96% covered. A character width on both sides everywhere, as this point first said,
  reaches into the word beside a secret: on the committed held-out reads it touched a third visible
  item (an ordinary token beside a key on the logs page; test 103 allows two), while the careful-long
  reads covered 233 of 233 items with either pad (the tiny reads alone 231 with the pad as built and
  232 with the wider one; test 102 asks 227). The width that hides a text's length (below) widens
  each found cover further.
- **Hiding the length (D23).** A solid cover as wide as its text gives the text's rendered width,
  and in a known UI font that is enough to rank candidate names and email local parts, or to tell a
  PIN's length (the redaction-width attack, Bland et al., "Story Beyond the Eye", PoPETs 2023). So
  after padding, `found.ts` widens each found cover, equally on both sides (held inside the frame):
  its width is rounded up to the next multiple of 4 mean character widths of its line, then widened
  by 0, 1 or 2 more character widths, chosen at random once per group, so every place of one text
  gets the same extra. Two names of 9 and 11 characters in one font then get covers of the same
  width. The covers of keys and PEM blocks, which already span their block, are left as they are.
  §2.9 still says a cover can show roughly how long the text is (`privacy.notSee.length`).
- **Tiers**: 0.85 or more is `auto`; 0.50 up to 0.85 is `check`; below 0.50 nothing. Every
  suggestion is drawn (decision 2). Decision 2's scores are kept: secret QR codes 0.99, other QR codes
  0.6, strong labels 0.75.
- **Variants**: the rules run on each read of a line (tiny, and small when it was read again); the
  hits are joined, and where two overlap, the higher score and the union of their spans win.
- **Dedupe**: a hit contained in a kept hit is dropped; a hit is never dropped because it overlaps a
  lower-scored hit of another kind.

### 6.2 Cleaning, views and folding

- **Clean** each line, keeping a map to the raw text: NFKC; every dash (U+2010-2015, U+2212, U+FE58,
  U+FE63, U+FF0D) to `-`; bullet-like dots to `•`; zero-width characters and soft hyphens removed;
  inside a token holding an ASCII letter or digit, `θ Θ ø Ø ⊘` to `0` (slashed and dotted zeros of
  programming fonts come back as θ), `×` to `x`, and Greek and Cyrillic look-alikes to Latin.
- **Views**, each the same length as the cleaned text so spans map back one to one:
  - *digit view*: Bengali and Devanagari digits to ASCII (as `asciiDigits`,
    `src/shared/captions/numbers.ts:22`); in a run of digit groups holding 6 or more real digits,
    look-alike letters of each group become digits (`O o D Q` → 0, `l I | i !` → 1, `S s` → 5,
    `B` → 8, `Z z` → 2, `G b` → 6, `g q` → 9, `T` → 7);
  - *prefix view*: a token that starts with a known prefix up to OCR confusions has the prefix
    rewritten (`x0xb-` → `xoxb-`, `AK1A` → `AKIA`, `Alza` → `AIza`) when 8 or more token characters
    follow; built as one combined matcher (the prototype's loop over 50 prefixes cost 40-250 µs a
    line);
  - *URL view*: inside a link, a single space between two runs of 6 or more token characters is
    dropped (OCR reads `_` as a space);
  - *label view*: inside words of two or more letters, `0` → O, `1` → I, `5` → S, `8` → B
    (`SLACK_B0T_T0KEN`). Labels are matched only on this view.
- **Folding** (`foldText`, used for group keys, *Cover this text everywhere*, evidence of absence and
  names): NFKC, lower case, spaces and `_` removed, `0` → o, `1 | !` → l, `i` → l, `5` → s, `8` → b,
  `rn` → m, `vv` → w, `cl` → d. Measured: folded exact text matches 94.6-97.5% of planted items with
  careful-long, against 77.8-85.4% strict.

### 6.3 Emails

- A strict pattern first; an OCR-tolerant one (`©` or `®` for `@`, a comma or space for a dot) only
  where the strict one found nothing (tried first, it swallowed " · Sales" as a domain and lost the
  address). Score 0.95; tolerant 0.75.
- The top-level domain must be in Flown's IANA lists (`X_GENERIC_TLDS`, `X_COUNTRY_TLDS`,
  `src/shared/publish/tlds.ts:22,118`).
- Role addresses (`noreply`, `support`, `info`, `admin`, …) and reserved domains (`.test`,
  `.example`, `.invalid`, `.localhost`, `example.com/.org/.net`) are Check (0.60): a stand-in for a
  real address is still covered.
- Not emails: `git@host:` remotes, `@2x.png`, `@types/node`, `user@HOST` without a top-level domain,
  the key part of a DSN (§6.5).
- Emails in caption text (Whisper writes `jsmith@gmail.com` as one token) are found by the same rule
  in §7.2.

### 6.4 Keys and tokens

- **Strong prefixes**: 36 rules translated from gitleaks v8.30.1 (`config/gitleaks.toml`, MIT,
  97,731 bytes, SHA-256 `e163e53b…`), each listed with its gitleaks rule and line in `RULES.md` §4.1:
  OpenAI, Anthropic, GitHub (36 ± 2 characters: the recogniser may drop or double one), GitHub
  fine-grained, GitLab, Slack, AWS access key ids (skipping `…EXAMPLE`), Google API keys, Stripe
  secret and restricted keys and webhook secrets, SendGrid, Twilio, npm, PyPI, Hugging Face, Azure AD
  client secrets, DigitalOcean, Shopify, Linear, Notion, Perplexity, Sentry, Grafana, Vault,
  Databricks, Postman, Heroku, age, Telegram bots, JWTs and Azure connection strings. Scores 0.85-0.99.
  Node 22 rejects gitleaks' inline modifiers `(?i:…)`, so each pattern is rewritten by hand and the
  vectors test each one.
- **Not keys**: a payload with `XXXX`, `xxxxxx`, 8 or more zeros, `****`, `....` or at most two distinct
  characters in its last 12; the allow list (`AKIAIOSFODNN7EXAMPLE`, the AWS example secret, the 16
  Google examples gitleaks allows). Stripe publishable keys (`pk_live_`, public by design) are Check
  (0.60).
- Checksums (GitHub's CRC32) are not checked: one misread character breaks them, and the cover needs
  only the place.
- **Private keys**: a `BEGIN … PRIVATE KEY` line (dashes not required; OCR gives `- - --BEGIN PRIVATE
  KEY-- - - -`) starts a PEM block (§6.10). Public keys and certificates are not covered.
  **New**: the BEGIN and END lines' covers are widened by five character widths at each end, because
  OCR drops the dash runs from their boxes (they were 88-93% covered on both sets).

### 6.5 Secrets in links (URL view; the cover is the secret part only)

Slack, Discord, Teams and Google Chat webhook paths (0.98); the password of `scheme://user:pw@host`
(0.97); a DSN key `https://<key>@host` (0.90); about 40 secret query parameters (`token`, `access_token`,
`sig`, `X-Amz-Signature`, `ticket`, `oobCode`, `session`, `code` with 16 or more characters or a digit,
…) (0.92); reset, invite, magic and share path tokens of 16 or more characters with a letter and a
digit (0.90); CLI secret flags (`--password`, `--token`, … with a value of 8 or more characters and
entropy 3 or more), and `-p` only on a `mysql`, `psql`, `login`, `redis-cli`, … line, never `tsc -p` or
`docker -p` (0.85).

### 6.6 Strong labels (Check, 0.75)

- **Assignments** in code and config (gitleaks' generic-api-key, line 638): a key name holding
  `api_key`, `secret`, `token`, `password`, `pwd`, `credential`, `auth`, `access_key`, `private_key`
  or `client_secret`, then `=`, `:`, `:=`, `=>`, `,` or `||`, then a value of 8-150 token characters
  with Shannon entropy 3.0 or more a character. Skipped: letters only, `true/false/null/…`,
  placeholders (`<…>`, `${…}`, `{{…}}`, `your_…_here`, `changeme`, `example`, `redacted`, …), reads from
  elsewhere (`os.environ[…]`, `process.env.X`, `getenv(…)`, a call, a regex literal), URLs, paths and
  env assignments of URLs.
- **UI labels**: *API key*, *Secret key*, *Client secret*, *Access token*, *Personal access token*,
  *Signing secret*, *Webhook secret*, … (en, bn, es, hi), with a value of 12 or more characters
  holding a letter and a digit, beside the label, after it or under a short label line (§6.10).
  **New**: a hint in brackets or parentheses of up to 40 characters between any label and its `:`,
  `=` or `：` is part of the label (`LABEL_SEPARATOR`, for every kind here and in §6.7 that follows a
  label): `aws configure` asks "AWS Secret Access Key [None]: " and, once set, "[****************ABCD]:
  ", and forms write "API key (optional): ". Without it the separator took only the space before the
  bracket, a key label needs a separator, and the secret after it was never found though the reader
  read the whole line (found end to end: only the AKIA id beside it was covered). Measured with it:
  tests 102 and 103 unchanged (231, 233 and 233 of 233 covered; 1, 1 and 2 visible items touched),
  Flown's UI catalogue 0 hits and the other docs 5 in 35,941 lines (test 134); the speech rules do not
  use it.
- **Authenticator setup keys** (base32, `XXXX XXXX XXXX XXXX` or 16+ characters) under or beside such
  a label: 0.95.

### 6.7 Passwords, PINs and codes

- **Passwords** (0.90): a label (`password`, `passwd`, `pwd`, `passcode`, `passphrase`, `contraseña`,
  `clave`, `পাসওয়ার্ড`, `पासवर्ड`, *Network security key*, *Wi-Fi password*, *PSK*, …, on the label
  view) followed by a separator, `is`/`es`/`হলো`/`है`, quotes on either side, up to five words then
  `is` ("PIN for the shared phone is 2580"), or nothing when the line is exactly label and value; or a
  value under a short label line or beside a label box on the row. `pass` counts only at the start of
  a line or after a user field, with `:` or `=`. Not a password: lines saying *forgot*, *reset*,
  *change*, *show*, *must*, *at least*, *strength*, …; placeholders; code; Wi-Fi types (`WPA2-Personal`).
- **PINs** (0.90): `PIN`, `পিন`, `पिन`, `NIP` as written (not "Pin to taskbar") then 4-8 digits.
- **Codes** (0.90; alphanumeric 0.85): a code label (`code`, `OTP`, `one-time`, `2FA`, `verification`,
  `security code`, `sign-in code`, `código`, `কোড`, `ওটিপি`, `कोड`, …) then a code; the code first
  ("G-482913 is your … code"); a line that is only a code under a sentence naming a code within two
  lines ("Use this code to finish signing in." above "739204"); recovery-code blocks and grids under
  *Recovery codes*, *Backup codes*, *Recovery phrase*, *Seed phrase*, …. Not a code: `zip`, `postal`,
  `error`, `status`, `exit`, `promo`, `coupon`, `QR`, `colour`, `HTTP`, `VS Code`, years, algorithm names
  (`SHA-256`, `UTF-8`, `RFC 6238`), and heading numbers ("2. Save your backup codes").
- Codes and passwords shown with **no label** (an authenticator app's six digits under an account
  name) are not found; §2.9 says so.

### 6.8 Cards, bank numbers, phones and IDs

- **Cards** (digit view): grouping (no separators; one kind of separator with groups in multiples of
  four, because OCR drops spaces: `4783 58545363 5299`; or Amex and Diners 4-6-5, 4-6-4), **Luhn**, and an
  issuer prefix with an allowed length (Visa, Mastercard, Amex, Discover, Diners, JCB, UnionPay,
  Maestro, Mir, RuPay, Verve, Troy, Dankort, Uzcard, HUMO, Napas, UATP; table in `RULES.md` §3.1). 0.96
  grouped or labelled, 0.88 bare. Under a reference, order, invoice, tracking, ticket, serial, SKU,
  IMEI, ICCID, ISBN, EAN or UPC label: 0.60 (random grouped 16-digit numbers pass Luhn and a major
  prefix 2.6-3.9% of the time). A Luhn failure counts only with a card label, 4-4-4-4 grouping and a
  prefix (0.80); unlabelled, it fired on 28% of random `Ref dddd dddd dddd dddd` lines. CVV and CVC
  with their label (0.90). Stripe's and the other published test numbers, numbers that are mostly
  zeros, and masked cards (`•••• 4242`) are skipped.
- **IBAN** (as written, upper case): country length for 89 registry countries, mod 97 = 1 (0.97); when it
  fails, one or two swaps among `0/O 1/I 5/S 8/B 2/Z 6/G` after the first four characters (0.85); an
  `IBAN` label with a failing check (0.75). Lower-case text is never an IBAN (upper-cased hex read as
  IBANs in code). Account, routing, sort-code and BSB numbers only with a label (§6.8 IDs).
- **Phones**: libphonenumber-js metadata (max set, §6.14). A bare digit run is never enough: the share
  of random digit strings of a valid length that pass the max metadata's type patterns is 30.8% (US),
  27.7% (GB), 63.4% (IN) and about 70% (DE). One of these must hold: `+` or `00` with a valid national
  number (0.92), or a possible length only and grouped (0.85; Ofcom's drama range `+44 7700 900xxx` is
  unallocated, so not valid, and still a phone on screen); a phone label on the line or above with a
  number valid for one of the user's regions (0.92); written groups that follow one of the region's
  formats in the metadata (0.85, our own check: the library's matcher has no grouping leniency,
  `es6/PhoneNumberMatcher.js:145-146` throws for `STRICT_GROUPING`); a bare mobile written with its
  national prefix and no order or invoice word on the line (0.60; never for NANP numbers). Dates,
  IPv4 addresses, times and decimals are rejected first. Bengali and Devanagari digits are converted
  before the library is called (its `parseDigits` maps only Arabic-Indic, Persian and full-width
  digits).
- **IDs**: SSN shape with the SSA's never-assigned areas, groups and serials excluded (0.85; 0.95
  labelled); UK National Insurance numbers as written, by HMRC NIM39110's prefix rules (0.85); a value
  of 4-30 characters, half or more digits, after, under or beside an ID label (*Account number*,
  *Customer ID*, *Passport*, *Tax ID*, *NHS number*, *Sort code*, *Employee ID*, *DNI*, *CPF*,
  *জাতীয় পরিচয়পত্র*, *आधार*, …; every label on a line counts) (0.85); Windows product keys (0.90) and
  licence keys after their label (0.85).

### 6.9 QR codes

The helper decodes each code with rqrr 0.11.0 (`(MIT OR Apache-2.0) AND ISC`) and returns its quad and
payload to main, which classes it with `classQr(payload)` (P3) and forgets the payload, as it does the
screen's text (§5.7): never written, logged or sent to the renderer. Classing in main keeps one copy of
the rules (the first version kept a second copy in the helper for this).

| Class | Payload | Score |
|---|---|---|
| secret | `otpauth://`, `otpauth-migration://`, `WIFI:` with a `P:` field, a strong rule of §6.4 or a secret link parameter of §6.5 inside it, login and pairing links (`discord.com/ra/`, `s.team/q/`, WhatsApp Web's form) | 0.99 |
| personal | `BEGIN:VCARD`, `MECARD:`, `mailto:`, `tel:`, `sms:`, `geo:` | 0.90 |
| other | any other payload, plain links included | 0.60 |
| undecoded | three finder patterns but no decode (half on screen) | 0.60 |

### 6.10 Rows, columns and frames

- **Beside**: for each box, the three nearest boxes to its left whose centres are within 0.6 line
  heights vertically; the nearest that is a label box makes this box its value (other boxes between
  allowed: "Router admin PIN · From the sticker · 58204716"). **New**: a label with a line under it
  (a hint, the two stacked within 0.6 line heights), the box centred on the pair (its centre within
  a quarter of their pitch of their middle, each up to 1.2 line heights away), is on the box's row
  too: at 150% and 200% display scale "Router admin PIN" over "From the sticker" sat 0.64 line
  heights above its PIN. A time on a sender's row with a subject naming a password under the sender
  is not centred on the pair.
- **Under**: the line above is a short label line (40 characters or fewer, 4 words or fewer, the label
  taking all but 10 characters); the whole line is the value.
- **PEM block**: from a BEGIN line, every line below in the same column to the END line (dashes
  optional), at most 60 lines, across the block's full width. **New**: where the line below went to
  another box of the row (a BEGIN marker read apart from the JSON key before it, the body at the
  row's left), the next line is the nearest under the row within 2.2 line heights that overlaps the
  block so far by 30% of the narrower, the widest of the reads at that height. Without an END line, or when the reader
  returned no lines between BEGIN and END, the cover runs to the bottom of the text region as a lost
  area.
- **Continuation**: a hit that runs to the end of its line continues on the next line when that line
  starts at most 0.6 line heights under the line's bottom (the gap between wrapped lines) at the same
  left edge (within one line height) with 4 or more token characters that are not a plain word. Within
  2.5 line heights, as this point first said (or 1.5), a token on the dashboard pages continued onto
  the field under it ("us-east-1"), touching a visible item on the main and the held-out reads (tests
  102 and 103 then touched 2 and 3 against their 1 and 2), and test 119's line set a line height
  apart was taken for the rest of the token. The prototype required the line to reach its block's
  right edge; **new**: that requirement is dropped for JWT, link and key hits whose last character is
  a token character or a dash, which closes the held-out misses of a token wrapped after `R7-` and of
  JWTs wrapped inside a box. At most 6 lines are chained. **New**: the next line is the nearest read
  there, of the reads at that height the widest, not only the one line the frame's columns put below
  (a piece of the row cut at a tile's edge, or a second read of the row, took that place on the
  150% dashboard). **New**: the last one to three token characters of a JWT, link or key hit whose
  line reaches its block's right edge, alone on the next row but for a closing quote or bracket,
  under the line or at the start of its row (a log line's time read apart from its message) and
  then alone on that row (not an editor's next line number), are covered too, as a cover of their
  own: the hit's one box would take in the row above from the row's start.
- **JWT head** (**new**, 0.90): `e[yv][JIl1][A-Za-z0-9_-]{10,}\.e[yv][JIl1][A-Za-z0-9_-]{4,}` at the
  end of a line, a JWT whose third part is on later lines; it starts a continuation.
- **One space in a key** (**new**): on the prefix view, a strong-prefix token followed by a single
  space and 6 or more token characters with no space is read as one token when the joined token
  matches the rule and the parts alone do not (`sk-proj-6Pwp… S9f1s…` on the held-out set). In a
  quoted value, a key hit that opens the value and stops one space before its last one to eight
  token characters and its closing quote runs to the quote (an underscore read as a space:
  `"pypi-…QL1 6i0c"` at 200%).
- **A code's digit groups apart** (**new**): two boxes of one row, 3-4 digits each, the second within
  one line height of the first, under a line (or two) naming a code, joined are a code
  (`code-labelled-groups`, 0.90; a code's fields read as two boxes at 150%).
- **Wrap join**: a line ending in a full-width token and the next line's first token are joined with
  no space; when the joined text matches a strong rule that neither part matches, both parts are
  covered.

### 6.11 Names you list

- Entries come from Settings (every video) and `Project.privacy.names` (this video). An entry is a
  phrase; `*` at either end matches any letters there (`Acme*`).
- **On screen** the match is visual: both sides folded (§6.2) with spaces optional (OCR joins words),
  Damerau-Levenshtein distance 0 for 4 letters or fewer, 1 for 5-8, 2 for 9 or more, up to 4 OCR
  words a match. Where matches overlap, the smallest distance wins. Exact after folding: 0.97; within
  tolerance: 0.80. One word of a listed full name alone is not a match.
- **Never hide**: a hit whose own folded text equals a never-hide entry is dropped (product names).
- **Said aloud**: §7.2.
- Names are private: they never reach logs or diagnostics (§10.6), and a leading or trailing `*` is
  stripped before they are given to the log redaction (finding 24).

### 6.12 Off by default

- **Street addresses** (Check, 0.60): a house number and a street word (`Street`, `St`, `Road`, `Rd`,
  `Avenue`, `Ave`, `Lane`, `Drive`, `Way`, `Court`, `Place`, `Square`, `Calle`, `Avenida`, `রোড`,
  `সড়ক`, `मार्ग`, …) on one line, or a postcode shape (US ZIP with a state code, UK postcode, Indian PIN
  with a label, Spanish 5-digit with a city) on the line below such a line. The 13 planted addresses
  are the vectors.
- **Password dots** (0.60): four or more bullet-like dots after or under a password label.
- **Random-looking text** (Check, 0.55): 24 or more token characters of two classes with entropy 4.0
  or more. It fired on 1,940 of 5,000 synthetic hashes, UUIDs and digests, 84 times in Flown's docs, 62
  in its source and 107 in its tests: 2,193 extra hits in 368,134 lines (D17).

### 6.13 Pop-up notifications (P4 `notices.ts`, from the look data)

In whole-screen recordings only: `capture.target === 'screen'` and no `project.source`. An imported
video also has `target: 'screen'` (`src/main/importVideo.ts:292`), but slides, phone or camera footage
are not a desktop, and the corner rule would fire on them; so imported videos never run it, and the
kind's checkbox is hidden for them (§2.5). A **notice** is a changed region that:

- appears in one analysed frame from still surroundings, rectangular (its changed tiles fill 80% or
  more of its box);
- is 12-30% of the frame's width and 5-35% of its height;
- has its right edge within 3% of the frame's right edge, and its top within 15% of the top or its
  bottom within 15% of the bottom (Windows' and browsers' notification corners);
- is still inside (no moves, fewer than 10% of its tiles change per second) while it shows;
- disappears 2-30 s later, or when the recording ends.

Each notice gets a Check cover (0.70, kind `notice`) over its box for its whole life, from the frame
it starts sliding in. **Stacked notices** (finding 5): notices whose boxes touch or overlap in time and
space are covered each, and the union of the stack is covered while two or more show. A notice's
stillness and its going count only its own changes: the changed tiles of regions lying half or more
inside its box. A toast stacking under another shares a row of tiles with it (each one's shadow
reaches into the other's), and its sliding in or out there is the other's neighbour, not a change of
it: counted, it made the first toast never still, and neither of A16's two stacked toasts was found.
The regions a notice slides in through are never an appearance of their own (each was found again,
starting a frame later). **New: a push.** Windows puts a new toast in the bottom slot and pushes the
ones showing up a slot (and closes the stack up when one goes). A notice's going is a push when its
own change reaches beyond its box, along its column (within two tiles of it), within 0.17 s of its
going, by half its height or more within the slide's 0.5 s: the toast moved and the next one took its
slot, and neither went. The notice then ends at the push, and its **stack** is covered from the push
over every slot it reaches (a change along its column grows it, up to 60% of the frame's height) until
its last change, the last toast going: every change over the stack keeps it, and none is an
appearance of its own. A toast lives 30 s at most, so a stack with no change for longer went with its
last change; one the recording ends within 30 s of its last change is covered to the end. Found by
review: the push was taken for the first toast's going and its regions were never tried as an
appearance, so the first toast at its new slot and the new one were never covered (582 of 754 toast
frames at 1080p60), and each toast's going became a notice to the recording's end. A notice now
starts at the first source frame after the analysed frame before the one it is seen in, where its
first strip can show (at 60 fps one source frame earlier). Decision 8
requires at most one false hit per 10 minutes on real recordings; above that, the default turns off.

### 6.14 Libraries and data (licences and sizes)

| What | Version | Licence | Size | How |
|---|---|---|---|---|
| libphonenumber-js | 1.13.16 (published 10 Nov 2026; tarball 1,908,294 bytes, SHA-256 `5cc6aa79…`, npm integrity checked) | MIT; its metadata Apache-2.0 (from Google's libphonenumber) | 54 files, 378,277 bytes vendored (the ES modules reached from `findPhoneNumbersInText`, `parsePhoneNumber`, `isValidPhoneNumber` and `metadata.max.json.js`; 156,639 bytes of metadata, 34,054 brotli) | vendored by `scripts/vendor-privacy.mjs` with a `--check` mode, as `scripts/build-emoji-data.mjs` does; notice `resources/notices/38-libphonenumber-js.txt` with both texts and its AUTHORS |
| double-metaphone | 2.0.1 (tarball 8,588 bytes, SHA-256 `f069e40d…`) | MIT | one file, 24,368 bytes, no imports | vendored the same way; notice `39-double-metaphone.txt` |
| gitleaks rules | v8.30.1, `gitleaks.toml` SHA-256 `e163e53b…` | MIT | about 36 rules translated | notice `40-gitleaks-rules.txt` |
| rqrr | 0.11.0 | (MIT OR Apache-2.0) AND ISC | in the helper | `scripts/notices.mjs` `CRATES` |
| tract-onnx and its dependencies | 0.23.10 | MIT OR Apache-2.0 (prost Apache-2.0, foldhash Zlib, unicode-ident with Unicode-3.0, some MIT or Unlicense) | in the helper | `CRATES` |
| PP-OCRv6 tiny det, tiny rec, small rec | the pins of §5.12 | Apache-2.0 | 27,608,757 bytes, downloaded | notice `41-paddleocr-models.txt` ("downloaded when you ask for it") |
| TLD lists, CLDR number words, `asciiDigits` | already in Flown | Apache-2.0, Unicode-3.0 | — | — |

The notice numbers are the next free ones after `37-…` in `resources/notices/` at integration; P2 and
P3 each add their own files.

### 6.15 False hits measured (default rules, text with nothing planted)

| Corpus | Lines | Hits | Per 10,000 lines | What they were |
|---|---|---|---|---|
| Flown's English UI catalogue | 5,502 | 0 | 0 | — |
| `docs/**/*.md` | 35,922 | 5 | 1.4 | 4 sample emails, 1 sample key |
| `src/**/*.ts(x)` | 169,896 | 13 | 0.8 | 11 real emails in font licence headers, 1 path after `api_key`, 1 `password: next` |
| `tests/**/*.ts` | 147,814 | 160 | 10.8 | the repository's own fake keys, webhooks and `user:pw@` links, which should be covered |
| 5,000 synthetic hashes, UUIDs, digests | 5,000 | 0 | 0 | — |
| 5,000 order, invoice and `Ref dddd …` lines | 5,000 | 26 | 52 | Luhn-valid random references, all Check |
| Flown's docs read as speech | 455,764 words | 8 | 0.18 per 10,000 words | numbers in technical prose |

The table is the prototype's (`scripts/privacy/detect/corpus.mjs`, `results/detect-corpus.txt`), before
this design was in `docs/`. Measured again with the rules as built (`src/shared/privacy/detect/`, 24
November 2026, tests 133 and 134 measure the same way): the English UI catalogue, 5,787 lines, 0 hits;
`docs/**/*.md` without this file, 35,941 lines, 5 hits (1.39 per 10,000: the same four sample emails and
sample key); this file alone, 4,835 lines, 11 hits, every one a vector or example it quotes (a planted
email, PINs, cards, a password), which should be found, as the `tests/` row's are, so tests 133 and 134
leave it out; `src/**/*.ts(x)`, 188,381 lines, 31 hits (1.65): the font licences' emails as before, the rest the
privacy code's own examples (`2580`, `jsmith@gmail.com`) and identifiers under a password label;
Flown's docs read as speech, §7.2.

---

## 7. Spoken secrets, and every text made from captions

### 7.1 What exists (code facts at `37f9355`)

- `Bleep { id, start, end, word, sound, auto? }` (`types.ts:873-882`); `word` is "the word as matched,
  lower case, at most 40 characters". `readBleeps` keeps at most `MAX_BLEEPS = 2000`
  (`src/shared/captions/studioData.ts:81`, `:760-781`).
- `maskWord` keeps the first letter ("f***", `cleanup.ts:842`). `maskedSegments` (`:888-918`) masks by
  time and word, and returns a caption **unmasked** when its word times and its text's words do not
  line up one to one (`:896`).
- `maskBleeped` (`:866-882`) masks by word only; it serves titles, search (`search/extract.ts:67-73`)
  and Review titles.
- `spokenSegments` (`subtitles.ts:182-184`) and `burnedSegments` (`captionTracks.ts:271-290`) mask the
  spoken text only. Translations are never masked ("Bleeped words are not masked in translations",
  `captionTracks.ts:205`). Subtitle files come from `trackCues.ts:19`.
- Sound: `bleepGains` (`cleanup.ts:979`) mutes bleeped words in the export (`exporter.ts:162`,
  `jobSoundGains`) and the preview (`previewAudio.ts:192, 266, 747`).
- AI: 9 call sites send captions or text made from them straight to `window.api.aiText`:
  `greatRun.ts:124` (marks: the transcript, unmasked), `CleanupSection.tsx:197` (cleanup: unmasked,
  `bleep: 'off'`), `LanguagesSection.tsx:228` (translate: `captionsToTranslate`, unmasked),
  `CaptionsPanel.tsx:1144` and `chaptersRun.ts:182` (`spokenSegments`, bleep-masked),
  `chaptersRun.ts:217` and `ShortClipsPanel.tsx:308` (names), `publishRun.ts:158` (the pack,
  `publishSegments`), `guideRun.ts:155` (step names, with pictures when ticked).
- `parseEnglish` and the Bangla and Hindi parsers refuse digits said one after another
  (`numbers.ts:179, 235`); `numberData.ts` holds CLDR 49's Bangla and Hindi words for 0-99.

### 7.2 Finding secrets said aloud (P3 `said.ts`, run in the renderer)

`detectSaid(transcript, bleeps, options): SaidHit[]` with the kinds, the names, the never-hide list and
the regions. It runs on the captions the project holds when Find starts, or on the captions Polish has
just made (decision 11).

- **The digit stream**: every word of every caption in time order (caption boundaries and full stops
  do not end a run). Words give digits: digit tokens in five scripts; English `zero`, `oh` (inside a run
  only), `nought`, `one` … `nine`, `ten` … `ninety-nine`; `double` and `triple`; Bangla শূন্য … নয় and
  the English digits said in Bangla script (জিরো, ওয়ান, টু, থ্রি, …); Spanish `cero` … `nueve`; Hindi शून्य
  … नौ. Fillers inside a run: `um`, `uh`, `then`, `dash`, `space`, `comma`, `is`, উম, `y`, `guion`. A run
  ends at a pause over 2.0 s or any other word. `and` ends a run: as a filler it turned "400, 300 and
  1500, 800" into a Luhn-valid card. So "4917 6123 4567 eight nine zero four" across two captions is
  one run (finding 10).
- **Rules on runs** (the label context is the 12 words or 10 s before the run):

  | Kind | Rule |
  |---|---|
  | card | 13-19 digits with Luhn and an issuer prefix (no label needed), or with a card word |
  | code | 4-8 digits with a code word (code, OTP, verification, passcode, PIN, কোড, ওটিপি, পিন, código, कोड, ओटीपी, पिन), said as one number, single digits or groups; never a year or a version |
  | phone | 7-15 digits with a phone word, valid for one of the user's regions by the same libphonenumber check as the screen (§6.8), or a Bangladeshi mobile `01[3-9]` + 8 digits (or `8801…`) with no label |
  | id | 6-20 digits with an ID word (social security, SSN, account, routing, passport, licence, national insurance, Aadhaar, NID, অ্যাকাউন্ট, হিসাব, পাসপোর্ট, এনআইডি, cuenta, खाता, आधार) |
  | password | a password word followed at once by `is`, `was`, `=`, `:`, হলো, হল, হচ্ছে, `es`, है, `it's`; then up to 6 words, ending at a pause over 1.0 s or the sentence's end. "it skips password boxes" gives nothing |
  | email | `<1-4 words> (at, at the rate, অ্যাট, এট, arroba, एट) <domain word> (dot, ডট, punto, डॉट) <tld word>`; and each caption word holding an `@` or a run of 16 token characters, run alone through the screen's email, key and link rules and kept when a hit of the Auto tier (0.85 or more) is the whole word (Whisper writes `jsmith@gmail.com` as one token; see below) |
  | name | a caption word whose double-metaphone codes equal a listed word's and within edit distance 2 (Latin script); Bangla-script words against Bangla entries by edit distance of their NFC forms |

- Bangla and Hindi words are compared in NFC with punctuation and symbols removed only
  (`[\p{P}\p{S}]`, as `bareWord`, `numbers.ts:42-49`), never "everything not a letter or digit", which
  strips vowel signs and the nukta. য়, ড় and ঢ় are composition exclusions, so every word list is
  normalised with the same NFC at build time. The Bangla lists need the native review of decision 8.
- **One word written as a secret** (`said.ts`): the screen's rules run on such a word alone, never
  on a caption's whole text, and only their Auto tier counts, because a private bleep mutes the
  speech: a role or reserved address said as one token (`billing@example.com`, 0.60 on screen, where a
  box costs little) is no bleep (test 130). Run over each caption's whole text at every tier, as this
  row first said, Flown's docs read as speech gave 12 hits where test 133 allows 10, and test 130's
  role address was bleeped.
- Measured on Flown's docs read as speech (455,764 words): 8 hits, 0.18 per 10,000 words, with the
  prototype. With the rules as built (24 November 2026, `docs/**/*.md` without this design, which
  quotes the spoken vectors and alone gives 14 hits, every one its own examples): 10 hits in 456,506
  words, 0.22 per 10,000, two of them the one-word rule finding `anna.li@acme.de`, a sample address
  in a doc. A 20-minute talk is about 3,000 words.
- **Each hit becomes a private bleep** (§4.4) from its first word's start − 0.05 s to its last word's
  end + 0.05 s (0.15 s for estimated times, as `Bleep` widens), `auto: true`, kind and group in
  `word`. Hits of the same said text (the same digit string, or the same folded words) share one
  group. A hit inside an existing bleep adds nothing. The total stays at or under `MAX_BLEEPS` (§4.4):
  neighbouring private bleeps of the same group within 1 s are merged first, then across groups,
  each merge only growing a bleep; a hit that still cannot be placed is reported
  (`privacy.run.saidFull`), never dropped silently.

### 7.3 Spoken forms (`spokenForms`, contracts, `src/shared/privacy/spoken.ts`)

`spokenForms(project): SpokenForms`, computed once per `transcript` and `bleeps` array (WeakMap), holds
for each group of private bleeps, **from the hit's own words, never from the padded span** (finding
11 applied to speech):

- **Own words**: the caption words whose **midpoint** lies inside the bleep shrunk back by its
  widening (0.05 s, or 0.15 s for estimated times). A short neighbour that only falls half inside
  the padding ("is", "my") is never a form.
- **A multi-word hit is one phrase form** (the words joined, as written and folded), never each word
  on its own.
- **A number run is its digit string** with its usual written groupings (4-4-4-4, 3-3-4, 3-2-4,
  spaced and dashed), never its number words: a card said "four nine one seven …" gives
  `4917…`, not "four" or "nine".
- For emails said aloud, the address as written (`name@domain.tld`).

`maskPrivate(text, forms): string` replaces every occurrence of a form in `text` with `•` for each of
its letters and digits, keeping spaces and punctuation. Word and phrase forms match **on word
boundaries only** and case-insensitively, so "weight", "fourteen" and "Four ways to save" stay as they
are. Digit forms are compared on the digit view, ignoring spaces and dashes between digits, and only
where the digits are not part of a longer digit run. A form of fewer than 4 letters or digits is used
only as a whole phrase. `maskPrivate` returns `text` itself when nothing matched, and when the
project has no private bleeps it is never called.

### 7.4 Captions and translations

- **Captions** (`maskedSegments`, contracts): a private bleep masks every caption word at least half
  inside it, by time, with `•` for each letter and digit. When the caption's word times and its words
  do not line up, the whole caption text from the first to the last word whose time touches the bleep
  is masked, and when no word times exist, the whole caption. Ordinary bleeps keep today's behaviour,
  including `:896`, so old projects mask exactly as before (test 20).
- **Translations** (`captionTracks.ts`, contracts): a translated segment whose spoken caption overlaps
  a private bleep is shown as `••••` (one `•` per letter or digit of the translation, spaces kept)
  unless its `maskedFor` equals the sorted ids of the private bleeps over that caption, joined by
  `,`. `maskedFor` is written by the translate request's result handling when the request was masked
  (§7.6), so a caption translated again after Find shows its translation, which was made from the
  masked text. Such a caption is one to translate again (`maskedToTranslate`): `captionsToTranslate`
  sends it with those out of date or missing, so the track's *Translate again* (§2.13) makes the
  translation that replaces it, also when the spoken text did not change since the track was made. This applies to `burnedSegments`, the Languages list, the subtitle files (`trackCues`),
  the sidecars (`exportBundleRun.ts:65-73`) and every export.
- **Tidy and Clean up** (finding 13): what they change under a private bleep is still masked by time,
  and the request they send is masked (§7.6), so the service never saw the words.

### 7.5 Every other text made from captions

**`privateView(project): Project`** (contracts, `src/shared/privacy/spoken.ts`; question 19, answer
(a); D24). The project as it is drawn and as it leaves Flown: a copy whose stored texts made from, or
typed beside, captions have the spoken forms masked with `maskPrivate`. It is memoised per project
object (WeakMap, like `cropView`), returns `project` itself when the project has no private bleeps or
no field holds a form, and never changes the stored project. The user still sees and edits their
own text in the panels that edit it (the chapter list, the title card fields, the pack's text
boxes, the guide's step fields); the preview, every export and every other output use the view.

Its fields (`PRIVATE_TEXT_FIELDS`): `name` (the pack's title becomes it through *Use as the
recording's name*; the description sidecar, the share post and a browser frame's title bar carry it);
`chapters[].title`; `titles[].title` and `.subtitle`; `publish.description`; `guide.title`, `.intro`,
`.expected`, `.actual`, `.details[].text`, and every string of `.steps[]` and `.added[]`. A text made
from them outside the view (the description sidecar's title, a part's "Part 1 of …") is masked the
same way with `privateText(project, text)`.

| Text | Where it is made | How the private forms are masked |
|---|---|---|
| Chapter names, found or made by AI | `src/shared/chapters/names.ts`, `chaptersRun.ts` | drawn and written from `privateView`: the chapter bar (`chapterBarLayer.ts`), the file's chapter metadata (`chaptersOf`, `exporter.ts:273-276`), the chapters sidecar, the pack's chapters, timeline markers |
| Chapter title cards (finding 12) | `titles[]` made from chapters | drawn from `privateView` (`titleCardLayer.ts`), so the preview, every export, thumbnails and guide shots show the masked card |
| Graphics made from captions (pop-ups, counters, list cards, quote cards) | drawn from caption words with `maskBleeped` | drawn: `maskBleeped` also applies `maskPrivate` when the project has private bleeps |
| Publishing pack (title, description, posts, chapters) | `publishSegments` (`pack.ts:88-91`), `ProjectPublish` | made from `maskedSegments`; the saved description goes out (copy, sidecar, share) from `privateView`; the title, once *Use as the recording's name* made it the name, goes out from `privateView` in the description sidecar (its title line, and a part's) and the share post; the dialog says so (§2.13) |
| Guide step titles and notes | `stepTitles.ts`, `guideSegments` (`:119`), `GuideSettings` edits | made from masked segments; written from `privateView` (`guideRun.ts`, PDF, HTML, Markdown, clipboard) |
| Short clip and shorter-version names | `clipsRun.ts`, `ShortClipsPanel.tsx` | made from masked segments |
| Search index | `search/extract.ts:67-73` | `maskPrivate` beside `maskBleeped` |
| Review titles for captions | `captionReview.ts` | private bleeps are not listed as *Bleep* rows; their titles never hold words (§2.7) |
| Transcript text export | `transcriptText.ts` | from `maskedSegments` |

**Where the view is taken.** The scene's project: `Editor.tsx`'s `drawn` becomes
`cropView(privateView(project), cursor)` (`:504-511`), so the preview and every export that takes the
scene draw it. The exporter's own project inputs (`chaptersOf`), the bundle's sidecars
(`exportBundleRun.ts`), the pack's outputs (`publishRun.ts`, `PublishDialog.tsx`'s copy and share),
the guide's outputs (`guideRun.ts`), the timeline (`timelineRun.ts`) and `maskRequest` (§7.6) each take
`privateView(project)` at their entry. Removing a private bleep (*Uncover*) brings every word back
everywhere, in the same undo step, because nothing stored changed.

### 7.6 AI requests (`aiTextFor`, contracts)

- **One wrapper**: `aiTextFor(project, providerId, request, requestId)`
  (`src/renderer/src/ai/aiTextFor.ts`) calls `maskRequest(request, project)`
  (`src/shared/privacy/aiRequest.ts`) and then `window.api.aiText`, and returns what `aiText` returns
  (`ReturnType<AiApi['aiText']>`: the result with its optional `usage` and `model`, which
  `CleanupSection.tsx:200` and `LanguagesSection.tsx:238, 253` read). All 9 call sites of §7.1 call it.
  A new test (test 31) fails when any file under `src/renderer` other than `aiTextFor.ts` calls
  `window.api.aiText`.
- **`maskRequest`** walks every string of the request (`segments[].text` and their words, `text`,
  `names.items[].text` and `.action`, `chapters[].title`, `notes`, every other string field, found by
  walking the object, not by a list of known fields), applying `maskPrivate` with the project's spoken
  forms, and masks `segments` by time with the private bleeps as §7.4 does. It returns the request
  itself (the same object) when the project has no private bleeps, so every request of an old project
  is byte for byte what it is today (test 20).
- **Translate** results: when a translate request was masked, the segments that came back carry
  `maskedFor` (§7.4).
- **Ordinary bleeps** are not applied to AI requests by this wave: that would change what old projects
  send. Private bleeps and their forms are.
- **Pictures**: only the guide's *Write titles* with *Also send the screenshots* sends pictures
  (`visionTitles.ts:44-118`); they are guide shots, drawn with covers (§9 row 12). Never to AI on this
  PC, which has no vision (`api/ai.ts:75`; `native/llm` is built with mtmd off). No frame is ever sent
  to find private data (decision 6).
- **Transcription with a service** uploads the recording's sound (`src/main/ai/transcribe.ts:194`).
  The transcription choices show `privacy.transcribe.hears` (§2.13). The sound is not muted
  (decision 7).

### 7.7 When the captions change after Find

Find records `captionsSig` (§4.1), the SHA-256 of the caption words and times it listened to, taken
when it starts (so a change during Find is caught, finding 14). The export note shows
`privacy.export.captionsChanged` when the captions' signature now differs and Find listened. Private
bleeps stay where they are when captions change: they are times, so new words over them are masked
too.

### 7.8 Sound

Private bleeps mute their words through `bleepGains` in the export, the stems (`job.audio.sounds`) and
the preview. *Listen* (§2.8) leaves out the one listened bleep in the preview only. The timeline's
recordings WAVs are refused with the rest of *The original recordings* (§9 row 10).

---

## 8. Drawing

### 8.1 `coverScreen`: into the screen picture (contracts, `src/renderer/src/render/coverLayer.ts`)

`drawFramePicture` (`compositor.ts:147-307`) today makes the screen picture in three steps: the decoded
frame or the video element (`screenImage`, `:86-91`), the crop's 1:1 copy (`cropFrame`, `:161-163`,
`:351-368`) and the grade (`gradeScreen`, `:169`). Covers are filled right after the grade, before
`vw` and `vh` are read (`:170-172`):

```ts
const graded = cropped && grade && !overlaysOnly ? gradeScreen(…) : cropped
const screen = graded && !overlaysOnly ? coverScreen(ctx, graded, full, scene, t) : graded
```

`coverScreen(target, screen, full, scene, t): FrameImage`:

1. Finds the covers active at `t` with slack (§4.2) through the project's cover index (§13.1). None:
   returns `screen` itself. **A project without covers, or a frame with none active, draws exactly as
   before**, with no copy (test 20).
2. Picks the canvas to fill:
   - `screen.image !== full.image`: the picture is a canvas the compositor owns for this target and
     redraws every frame (the crop's copy, or the grade's `c.out` or `c.cpu`, `gradeLayer.ts:593-640`).
     It is filled in place.
   - Otherwise (no crop and no grade, or Compare on): the picture is the `<video>` element, a
     `VideoFrame`, or a shared `ImageBitmap` (freeze stills, join stills). It is copied 1:1 into a
     per-target canvas (`coverCopies`, a WeakMap like `cropCopies`, `:343`), which is filled. A picture
     the compositor does not own is never drawn into.
3. Maps each cover's drawn box, which `scene.project` already holds in view space (§4.8, D19), straight
   to the picture's pixels: `x × width`, `y × height`, rounded outward (floor the start, ceil the end),
   clipped to the picture. It never maps through the crop: the picture is the crop's copy, or the
   grade's canvas made from it, whose pixels are the view's. Whether the picture is a crop's copy, a
   grade's canvas or the frame itself changes only step 2, never the mapping.
4. Fills each box with the cover's graded colour (§8.4), `globalCompositeOperation = 'copy'` off,
   no anti-aliasing (integer pixel rectangles).
5. Returns the filled picture.

Everything after it reads the covered picture: the main draw and every motion-blur sub-frame
(`:231-259`); `fc.screen` (`:280`), which blur and pixelate shapes (`shapesLayer.ts:37-64`) and
magnifier lenses (`magnifierLayer.ts:93-171`) sample; the tilt card (`:202`, warped at `:300-303`);
the title card's blurred background (`titleCardLayer.ts:112-162`, `:312-341`) and the Glass caption
look (`blurredFrameOf`, `:172-190`), which read the frame canvas; and join stills A*
(`joinLayer.ts:136-170`), which are composed by `drawFramePicture` at their own instant.

`copied` (`:249`) becomes true when a cover's copy is made, so the motion-blur path skips `rgbCopy`
and reads the covered copy at `'low'` smoothing, as it does for a crop's copy today. `fc.sourceH` stays
the uncropped height. The `'overlays'` alpha mode draws no recording (`:168`, `:226-231`) and so no
cover.

### 8.2 `drawCoverOutput`: again on the output

Inside the card's clip, right after the screen draw (`:259`) and before the FrameContext, the covers
active at `t` are filled again on the output, through the camera of every sub-frame drawn
(`motionSamples`), as the union of their output boxes, each grown by one output pixel, in the same
graded colour. Each view gives `toOut(x, y): { x, y }` (normalised view coordinates to output pixels,
as `FrameContext.toOut`, `frameContext.ts:50`, and `outputPoint.ts`); a box's output rectangle is the
bounding box of its four mapped corners, rounded outward. On a tilted card this is drawn on the
card's own canvas, so the warp carries it. It catches anything that could still bring the text's
pixels to the output: resampling at the box's edge, a decoder showing a neighbouring frame, a
sub-frame camera whose view differs from the main one. It is skipped in the `'overlays'` alpha mode
and when no cover is active.

### 8.3 The magnifier, shapes and the cursor

- A magnifier lens draws `fc.screen`, already covered, through its own camera and then
  `drawPrivacyLayer` inside the lens (`magnifierLayer.ts:136-152`); the cover shows magnified, solid.
- Blur and pixelate shapes next to or over a cover sample covered pixels.
- The cursor is drawn over the privacy layer by design (`:289-290`) and over covers too, so a
  tutorial's pointer stays visible on a covered field.
- The webcam is drawn after the picture (`:305`); covers do not apply to it (faces are not in this
  wave, §2.9).

### 8.4 Colour

- **Ring colour** (P1 `coverColour.ts`): the median RGB of a 2 px ring just outside the cover's box in
  the frame it was made from (raw, before the grade), and the ring's spread, the largest per-channel
  median absolute deviation. A spread over 24 levels (a box over mixed backgrounds) gives **Dark**
  (`COVER_DARK`, `#1c1c22`).
- Found covers take the ring colour of their read line (§5.5). User covers, *Turn into a cover* and
  the paused frame use `ringColourAt(projectId, t, box)` (P1 `coverPick.ts`), which seeks a hidden
  `<video>` of `screen.mp4` to `t` and samples the ring there; the guide's *Blur an area…* calls it at
  the step's own shot time (finding F: not whatever frame is paused). Settings' *Colour of new covers*
  can replace the ring with a chip.
- **Graded colour** (`gradedCoverColour(color, grade, lut)`, P1; the contracts' stub returns `color`):
  the cover colour run through the screen's grade and LUT with the CPU grade's maths
  (`gradePixelsCpu`, `gradeLayer.ts:606`) on one pixel, cached per colour, grade and LUT. So a cover on
  a graded recording matches its graded background. With Compare on, the ungraded colour.
- A path's colour does not change over time. *Match the background* picks again from the frame at the
  playhead when the user chooses it.

### 8.5 Peek, Listen and other preview-only state

- `RenderScene.peek?: { ids: readonly string[] | 'all' }` (contracts, a field only). When set,
  `coverScreen` and `drawCoverOutput` skip the peeked covers, and `drawCoverPeek` (P1) draws their
  boxes as 2 px outlines in `--accent-400` on the output.
- `RenderScene.coverMarks?: true` (contracts, a field only): *Show where covers are* (§2.1). When
  set, `drawCoverMarks` (P1) draws a 1 px dashed `--accent-400` outline with a 1 px `#000000` halo
  around every active cover after the output pass.
- The magnified view of §2.8 is not part of the scene: `PeekInset` (P1) is its own preview-only
  canvas that draws the raw frame's area under the selected cover from the player's video element.
- Only the player's preview scene sets `peek` and `coverMarks`, as `comparedScene` sets `compare`
  (`player.ts:597-600`). `ExportDialog` receives `scene`, not the preview scene
  (`Editor.tsx:2042-2044`); the exporter, `ExportPreview`, thumbnails and guide shots build their
  scenes without them. Every export entry point strips both from the scene it is given (`forOutput`,
  contracts; test 17).
- `JoinStills.fresh` (`joinStills.ts:45-46`) keys on the peek and marks state as it does on `compare`;
  its stale-still fallback (`:119`) never returns a still composed with another state.
  `ExportPreview` has its own `JoinStills` (`ExportPreview.tsx:208-211`), never peeked.
- *Listen* removes one private bleep from the preview's sound gains only (`previewAudio.ts`), never from
  the export's (`exporter.ts:162`).

### 8.6 Cost

- No cover active: nothing at all (one index lookup, §13.1).
- Covers active, picture owned (crop or grade): one `fillRect` per cover.
- Covers active, picture not owned: one 1:1 copy per frame per target, as `rgbCopy` does: about 1 ms at
  1080p and 3-4 ms at 4K on a laptop GPU (to be measured in the real preview and export, §13).
- The output pass: one `fillRect` per cover per sub-frame camera.

---

## 9. Every path that emits pixels, frames or text

One row per path. "drawFrame" means the path draws through `drawFrame` or `drawFramePicture`, so §8
applies with no change of its own. Line numbers are at `37f9355`.

| # | Path | File:line | How covers apply, or the refusal |
|---|---|---|---|
| 1 | Editor preview (play, pause, scrub, J/K/L, freeze holds) | `src/renderer/src/editor/player.ts:451-476` (drawFrame `:460`) | drawFrame. Peek and Listen are set only here (§8.5) |
| 2 | Preview join A* stills | `joinStills.ts:131-164`, `joinLayer.ts:155` | drawFramePicture at the still's instant; recomposed on every project change; `fresh` keys on peek |
| 3 | Preview freeze stills | `freezeStills.ts:12-40`, `player.ts:457-468` | the still is the `screenFrame` and `t` is its picture time; §8.1 copies it before filling |
| 4 | Export dialog preview | `ExportPreview.tsx:191-223` (drawFrame `:221`; its own JoinStills `:208-211`) | drawFrame; never peeked |
| 5 | Every video export: MP4 (H.264, HEVC, AV1), WebM (VP9), MOV (CineForm, Animation, ProRes when allowed), GIF, transparent `background` and `overlays`, 24-120 fps, batch, per-chapter parts, presets | `exporter.ts:319-355` `exportVideo`, `:520-745` `renderAll` (drawFrame `:682`, joins `:623`, alpha `:357-360`, batch `:855-892`) | drawFrame. Every encoder route (WebCodecs, raw frames to ffmpeg, GPU encoders, GIF) only reads the canvas after drawFrame. `overlays` draws no recording |
| 6 | Thumbnail PNGs (Save thumbnail, the bundle's thumbnail, part thumbnails) | `exporter.ts:776-820` (drawFrame `:803`); `ExportDialog.tsx:688-689, 843, 884-895` | drawFrame |
| 7 | Copy the exported file to the clipboard | `src/main/exportIpc.ts:421-424` (only files in `exportedFiles`) | the file already has covers |
| 8 | Export bundle sidecars: subtitles (spoken and translated), chapters, description, thumbnail; chapter metadata in the file | `exportBundleRun.ts:65-111`, `src/main/exportBundle.ts:38-84`; `exporter.ts:273-276` `chaptersOf`, `src/main/exportArgs.ts:141-157` | thumbnail: row 6. Subtitles: `maskedSegments` and the translation masks (§7.4). Chapters, chapter metadata and description: from `privateView` (§7.5) |
| 9 | Timeline for other editors, *This export* | `src/main/timelineIpc.ts:305-372` | points at the covered export; stems carry the private bleeps (row 11) |
| 10 | Timeline, *The original recordings* | `timelineIpc.ts:174-200` `copyRecordings`, `:322-323`; `timelineRun.ts:91-118`; `BundleOptions.timelineMedia` (`exportBundle.ts:32`, `:63`), user presets (`userPresets.ts:30, 110, 154`), `ExportBundleOptions.tsx:263, 310-319` | **Refused** while `hidesSomething(project)` (any cover, any blur or pixelate shape, any bleep; a crop and muted parts as question 18 decides). Renderer: the chip is disabled with `privacy.export.recordingsOff`; `writeTimelineStep` (`timelineRun.ts:91`) skips the step and the done view says `privacy.export.recordingsSkipped`. Main: `writeTimeline` in recordings mode reads `project.json` itself (`migrateProject`) and refuses with `errors.timeline.hidden` ("This video hides parts of its recordings, so they were not copied.") whatever the renderer sent. So that main reads what the user sees, `ExportDialog` gains a `flush: () => void` prop that `Editor.tsx` passes (its saver's `flushSync`), and the bundle run calls it before the timeline request (test 25 checks the order). A preset choosing it loads unchanged (test 20) |
| 11 | Sound stems | `exporter.ts:184-196` `stemsOf`; `src/main/stemsRun.ts`; `src/shared/render/stems.ts:80-104` | private bleeps are bleeps: `jobSoundGains` carries them (`exporter.ts:162`) |
| 12 | Guide, demo and bug-report screenshots (Actual included) | `guideStills.ts:81-163` (drawFrame `:116`), from `guideProject` (`src/shared/guide/shots.ts:42-79`) via `stillsInput` (`useGuideShots.ts:29-48`) | drawFrame. `guideProject` keeps `covers` through `...rest` (the privacy shapes are kept the same way). The shot cache key `shotSig` (`shots.ts:279-293`) and `planActual` (`:305-310`) gain the covers active at `t` (id, colour, drawn box) and the peek-free flag, so an edit never leaves a stale, uncovered shot in the cache (300 shots or 256 MB) |
| 13 | Guide outputs: PDF, HTML, demo HTML, Markdown folder, HTML+text clipboard, one PNG on the clipboard | `src/main/guide/writeGuide.ts`, `printPdf.ts`, `guideIpc.ts:88, 91-95`; `guideRun.ts:113, 138` | pictures from row 12; titles and notes from masked segments and `privateView` (§7.5) |
| 14 | Pictures sent to AI (guide *Write titles* with *Also send the screenshots*) | `visionTitles.ts:44-118`, `guideRun.ts:155`, main `src/main/ai/images.ts:41` | the pictures are row 12's shots; the request goes through `aiTextFor` (§7.6); never on this PC |
| 15 | AI text requests (all 9 call sites) | §7.1 | `aiTextFor` (§7.6) |
| 16 | Transcription with a service | `src/main/ai/transcribe.ts:194` | the warning of §2.13; the sound is not muted (decision 7) |
| 17 | Home thumbnails | `Home.tsx:201-238` `captureThumbnail` (drawImage `:231`, `toDataURL` `:232`), cache `:195-199` | `ProjectSummary` gains `thumbCovers?: NormRect[]`, computed in main by `listProjects` (`src/main/projects.ts:147-159`) with `thumbCovers(project, from, to)`: the boxes of the covers and of the blur and pixelate shapes active **anywhere** in `[t − 0.1 s, t + 0.1 s]`. The thumbnail's time `t` is worked out in one place, `thumbTime(duration)` = min(1, duration × 0.15) (contracts), which `captureThumbnail` (`Home.tsx:221`, today from the element's `video.duration`) and main both call with `project.duration`, so the two cannot drift apart by more than the window. `captureThumbnail` fills the boxes in Dark after drawing the frame and before `toDataURL`; the cache key adds a hash of the boxes. Absent when there are none, so other projects' summaries and thumbnails are unchanged. Question 13: the crop |
| 18 | Filmstrip on the timeline | `src/main/filmstrip.ts:35-50`, `:161`, cache written `:208`; drawn by `src/renderer/src/editor/Filmstrip.tsx` | each tile shows the last key frame at or before its time `t` (`-skip_frame nokey`, `round=up`, `filmstrip.ts:30-46`), which can be up to one key-frame interval earlier (15 frames). So each tile is drawn with the boxes of every cover active anywhere in `[t − 15 / fps − 0.02 s, t]` filled in Dark (`fillCoverTiles`, P1); the cache file stays raw on this PC, beside `screen.mp4` itself |
| 19 | Project copies: Duplicate, Make vertical or square, Short clips, Shorter version | `projectCopy.ts:154-235` (write `:229`); `duplicate.ts:75-90`, `clipCopy.ts:141-153`, `short60.ts:269` | covers ride `...project`; every copy, clip copies included, keeps every cover and private bleep (§4.7); written with the legacy shapes (§4.6). Copies made before Find get its covers through *Also cover the copies* and *Bring them over* (§2.12, §5.10) |
| 20 | Share after export | `src/main/share/shareService.ts` (`isExported` gate `:20`), `copyToFolder.ts:152`, `webhookPost.ts:37` | exported files only; the post names the video by `privateView(project).name`, which the export dialog passes as the share's title after the export and from its done view (row 21) |
| 21 | Publishing copy pack: copy, sidecar description, share post | `pack.ts:88-91`, `publishRun.ts:158`, `PublishDialog.tsx`; `exportBundleRun.ts` `sidecarText` | text only: masked segments, `aiTextFor`; Copy and Copy tags through `maskPrivate`; the saved description from `privateView`; without one (and for each part) the description file's title line and a part's "of" through `privateText`; the share post's name from `privateView` (§7.5); the dialog's note (§2.13) |
| 22 | Search index | `search/extract.ts:67-73` | `maskPrivate` beside `maskBleeped` (§7.5) |
| 23 | Caption contrast probe | `contrastProbe.ts:55-79` (drawFrame `:67`) | reads the covered frame; emits nothing |
| 24 | Internal readers that output numbers only: scene scan, still detection, the look pass | `sceneScan.ts:289`, `analysisIpc.ts:168`, §5.2 | no pixels leave |
| 25 | Logs and diagnostics | `appLog.ts:57` (`redactLine(…, secretValues())`), `diagnostics.ts:93-96` | no found text is ever logged; listed names join `secretValues()` (§10.6) |
| 26 | Versions | `src/main/versions.ts:267-346` | the version body is written with the legacy shapes (§4.6); restoring keeps the covers |
| 27 | Project folder copies by the user (Explorer) | outside Flown | `project.json` holds covers and the legacy shapes; `screen.mp4` is the raw recording, as today. §2.9's list says so: `privacy.notSee.folder`, "The project folder on this PC keeps the original recording, without covers." (test 63 checks the list) |
| 28 | The Style tab's colour look chips | `src/renderer/src/editor/panels/ColourControls.tsx:136-170` (`thumbPixels`, `LookThumb`: the playhead's frame at 96×54) | a preview-only picture, but it is the raw frame: `LookThumb` fills the boxes of the covers active at the playhead, in Dark, into the 96×54 pixels before grading (`fillCoverPixels`, P1, contracts stub draws nothing) |
| 29 | The cover outlines and the magnified view under Peek | P1 `drawCoverMarks`, `PeekInset` (§8.5) | preview only: set only on the player's preview scene or drawn on their own canvas; `forOutput` strips the marks at every export entry point (test 17) |
| 30 | Title cards and the chapter bar | `titleCardLayer.ts`, `chapterBarLayer.ts`, through `drawFrame` | drawn from the scene's project, which is `privateView` (§7.5), so rows 1-6 and 12 carry the masking |

---

## 10. Privacy and security

### 10.1 What stays where

- The screen's text exists only in the helper's and main's memory: in full while Find runs, and as
  folded text for at most 10 minutes after it, cleared earlier on *Stop*, on the editor closing, on
  the renderer going away and on a new Find (§5.7, D22). It is never written to disk, logged, sent to
  the renderer or sent off the PC, with one exception the user chooses (below). `Project.covers`
  holds boxes, times, colours, kinds and random group ids; no text and no hash of text (a hash of a
  6-digit code can be reversed by trying a million values).
- Private bleeps hold a kind marker and a random group, never the word (§4.4).
- The names and never-hide lists are the user's own entries, kept in `project.json` and
  `editor-prefs.json` because the user typed them there. *Cover this text everywhere* adds the text
  read under a cover to a list only when the user chooses *In this video* or *In every video*, and
  only when the text looks like a name (§5.9); it then shows in that list. A key, a password, a code
  or a number is never added.
- The look cache holds tile bits and moves, no pixels (§5.2).
- Nothing is uploaded. The only download is the reader's files (§5.12).

### 10.2 The models: checked before parsing

- Main checks every file's size and SHA-256 against `READER_FILES` when Find starts. A mismatch deletes
  the file and sets the state to `damaged`.
- The helper's `open` receives the expected size and SHA-256 of each file (from main, which has them
  compiled in from `readerCatalog.ts`, and the helper compiles in the same pins: both must agree).
  It reads each file into memory **once**, hashes that buffer, and parses the same buffer
  (`model_for_read`), so a file swapped between the check and the parse is never parsed. It hashes
  every file before parsing any; a mismatch answers `{ error: 'model' }` and parses nothing (test
  R2).
- Models are data: nothing downloaded is ever run. The helper itself is signed and installed with the
  app (`resources/native/ssw-ocr.exe`), never downloaded.

### 10.3 Screen content is untrusted

- Recognised text can be anything a web page or a chat showed. It is only matched by the rules,
  never evaluated, never used as a path or a command, never shown in the UI.
- **The rules never run on main's event loop (D20).** `detectFrame` and `classQr` run in a
  `worker_threads` worker (`src/main/privacy/rulesWorker.ts`) with a time limit of 2 s a read. On
  timeout main ends the worker, starts a new one, counts the read as failed and covers its areas as a
  lost area. So a line built to make a backtracking pattern slow costs at most 2 s and one failed
  read, and never freezes the editor or its autosave.
- **Patterns**: lines are matched in windows of 512 characters that overlap by 256, longer than the
  longest match any rule allows (200 characters), and a hit touching a window's edge is extended on
  the full line to the end of its token run, so a 900-character JWT or signed URL is covered whole.
  Test 104 runs every pattern on 64 KB adversarial strings with a 50 ms limit, and a static check
  (`scripts/privacy/regexCheck.mjs`, P3) refuses any pattern with nested unbounded quantifiers or a
  quantified alternation whose branches can match the same text. The worker's time limit is the
  guarantee; the static check keeps the patterns from needing it.
- QR payloads are screen content like the text: main classes them in the rules worker and forgets
  them (§6.9). rqrr decodes with its own bounds; the helper drops codes whose version is over 40 and
  payloads over 4,096 bytes.
- **Huge frames**: the helper refuses a video over 7680×4320 or 40 megapixels before decoding
  (`tooLarge`), and splits lines wider than 1280 at height 48 (§5.5). **Caps answer `partial`**: a
  read capped at 64 tiles, 3,000 detector candidates a tile or 1,000 lines answers with the areas it
  did not finish; main reads them as extra reads, and whatever still cannot be read becomes a lost
  area counted in `failedReads` (§5.5, finding 23). A malformed or truncated video ends the read with
  an error; ffmpeg runs with `-xerror` off and a time limit of 60 s plus the recording's length, as the
  scene scan (`sceneScan.ts`).

### 10.4 The helper process

- Spawned by main with `shell: false` and `windowsHide`, its path from `resources/native/ssw-ocr.exe`
  when packaged and `native/bin` in development (`SSW_OCR_HELPER` overrides it unpackaged only), as
  `src/main/localAi/engine.ts:331, 483-496` does for `ssw-llm.exe`.
- Below-normal priority. A heartbeat line every 2 s, also while `open` hashes and parses the models
  (finding 25); main kills a helper silent for 20 s.
- **It exits when main is gone**: on end of input on stdin, and when writing a heartbeat fails. So no
  helper keeps frames and text in memory after Flown has closed or crashed (tests R1, R20).
- Its threads are those of §5.5: the stdin dispatcher, the look worker, the inference worker, the
  careful worker.
- ffmpeg runs inside a Windows job object created by the helper with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so killing the helper kills ffmpeg (test R8, Windows only).
  ffmpeg runs with `-loglevel error`, and the helper reads its stderr only to classify an exit
  (`video`, `stopped`); it never passes it on.
- **A crash in one read** is caught (`catch_unwind`) and answered as an error, and the plans are
  rebuilt (§5.6); a crash of the process is restarted once per Find, from the next read.
- **Nothing it holds reaches stderr.** At start the helper sets `std::panic::set_hook` to print only a
  fixed code and the panic's source location (`panic at read.rs:212`), never the payload: Rust's
  default hook prints the message, and a slicing panic quotes up to 256 characters of the string
  itself. No code path writes recognised text, a QR payload or a path inside the user's folders to
  stderr, or to stdout outside the protocol's answers (test R19 forces a panic on a line holding a
  marker string and checks stderr).
- `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)` at start, so no crash dialog appears.

### 10.5 Windows Error Reporting (question 14, recommended (a))

A crash dump of `ssw-ocr.exe` would hold frames with secrets.

- **At run time, whatever question 14's answer**: the helper calls
  `WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP)` (kernel32) at start, so a report Windows makes leaves
  out its heap, where frames, crops and lines live; and it installs `SetUnhandledExceptionFilter`
  with a filter that ends the process with `TerminateProcess` and no report. Neither writes the
  registry nor imports `wer.dll` (test 89 reads the source for both calls; R8's Windows run checks
  that a forced crash leaves no report in `%LOCALAPPDATA%\Microsoft\Windows\WER`).
- **The registry value (question 14, recommended (a))**: `build/installer.nsh` gains, in
  `customInstall`, the DWORD `ssw-ocr.exe = 1` under `…\Windows Error Reporting\ExcludedApplications`:
  under `HKLM\SOFTWARE\Microsoft\Windows` when the install is for all users, under
  `HKCU\Software\Microsoft\Windows` when it is for the installing user. The installer is assisted
  (`oneClick: false`, `electron-builder.config.cjs:79`) and offers both; the macro reads the mode the
  installer chose. A new `customUnInstall` macro deletes the value from the same place. The file has
  no uninstall macro today (`build/installer.nsh:44-51` holds `customInstall` only).
- **Main and the renderer** (`Flown.exe`) hold the screen's text during Find (main) and the frames
  while editing (the renderer), as they hold every frame of every export today. Their crash dumps stay
  under Windows' own consent settings; this wave does not change them, and §15 says so (risk 14).

### 10.6 Logs and diagnostics

- No log line holds recognised text, a QR payload, a group key or a listed name. Main's scan logs
  counts and times only (`privacy: read 37 lines in 2.81 s`), and a walk that failed as its error's
  kind only (`privacy: following 4 found places failed (crashed); covered to the end`: the helper's
  error kind, else the error's name, never its message).
- **Main never logs the helper's stderr or its lines.** Unlike the speech and local AI helpers, whose
  last stderr lines go to the log on a crash (`src/main/speech/localClient.ts:185`;
  `src/main/localAi/engine.ts:336-337` keeps them), the reader's exits are logged as an exit code and
  an error kind only. A helper line that fails to parse is counted (`privacy: 2 helper lines
  refused`), and the parse error's message, which V8 writes with part of its input, is never logged
  or shown (test 216).
- The listed names (Settings and the open project's) join `secretValues()`, which `redactLine` already
  takes (`src/main/appLog.ts:57`, `src/main/diagnostics.ts:93-96`), through a getter
  `privateNames(): string[]` in `src/main/privacy/names.ts` (contracts) that the renderer updates with
  `privacy:names` whenever the lists change. Leading and trailing `*` are removed and entries shorter
  than 3 characters are left out (finding 24).
- Diagnostics include the reader's state and model hashes, never `models.json`'s timing of a project.

### 10.7 IPC

New channels (preload `src/preload/privacy.ts`): `privacy:readerState`, `privacy:downloadReader`,
`privacy:cancelReaderDownload`, `privacy:removeReader`, `privacy:find`, `privacy:stopFind`,
`privacy:follow`, `privacy:underCover`, `privacy:everywhere`, `privacy:copies`,
`privacy:coverCopies`, `privacy:originCovers`, `privacy:names`, and the events
`privacy:readerProgress` and `privacy:findProgress`.

- **Every handler checks its sender first**, as `analysisIpc.ts:216-218` does (`fromApp`, through
  `isAppUrl`): a frame that is not Flown's own page can neither start the model download (network)
  nor a Find (test 32).
- **Every request is validated** by a contracts function before main touches anything:
  `validateFindRequest` (a project id of the project folder's form, kinds from `PRIVATE_KINDS`, at
  most 400 names of 80 characters, regions of two letters, no paths), `validateFollowRequest` and
  `validateEverywhereRequest` (finite boxes inside 0..1, times inside the recording, a path that
  `parsePath` accepts within §4.2's limits, `remember` one of its three values),
  `validateCopiesRequest` (at most 200 project ids of the folder's form), and `setPrivateNames`'s
  array (as `readPrivacyPrefs`' names). Main finds every file itself from the project id.

---

## 11. Accessibility

- **Keyboard**: every control of §2 is reachable by Tab in reading order. The Covers row is one tab
  stop with roving focus (`aria-activedescendant` is not used; the focused bar has `tabindex=0`):
  Left and Right move between bars and thin-span marks, Home and End go to the first and last, Enter
  selects (a group's bar selects the group), Ctrl+Enter toggles one cover in the selection, Delete
  uncovers, Shift+Left and Shift+Right move the nearer end by one frame, Escape returns focus to the
  row. Selection follows focus on the row (finding 36).
- **Review by keyboard**: N or ↓ and P or ↑ move, K keeps covered, Delete uncovers, V turns *Peek
  while reviewing* on and off (private rows only, §2.8), Enter on a row with places expands them
  (Review's parts). A pass over 200 private rows needs no mouse and no pressing of Peek again (test
  246).
- **Names**: each bar's accessible name is `privacy.track.item…` (kind, start, end, and whether it is
  waiting or to check). Review rows read their title, place, places count, area and badges; the row
  buttons' names are `privacy.review.keepRow` and `uncoverRow`; *Peek* and *Listen* are toggle
  buttons (`aria-pressed`) whose names include the row's title ("Peek: Email address · 0:42–3:10";
  finding 33). The magnified view is a canvas named `privacy.peek.inset`.
- **Several covers selected**: the Cover section's title (`privacy.cover.selected`) is its heading;
  each disabled action has its reason as `aria-describedby` text (`oneForBox`, `oneForFollow`,
  `oneForEverywhere`, `privacy.cover.outside`), never a tooltip alone.
- **Live regions**: Find's progress is a polite status, announced at most every 10% and at each phase
  change; its result is announced once. Following announces `privacy.cover.followDone` or
  `followNone`. *Uncover* announces `privacy.cover.uncovered`.
- **Focus**:
  - Opening *Find private info…* moves focus to the dialog's first checkbox; closing it returns focus
    to the control that opened it; *Find* returns focus to the section's progress line (finding 31).
  - Review's *Show all changes* and the kind filter keep focus on the control used (finding 32); with
    nothing left of a filtered kind, the list says `privacy.review.emptyKind` and focus moves to the
    filter (finding 34).
  - *Follow*'s *Stop* keeps focus on *Follow what is under it*; when following ends, focus moves to
    the cover's status line. *Keep covered* in the Cover section moves focus to the section's title,
    because the suggestion lines it removes held it (finding 37).
  - The confirms (*Uncover all …*, *Done reviewing*, leaving during Find) start on the button that
    changes nothing.
  - The export note's buttons close the dialog first and move focus to Review or the Find dialog
    (finding 30).
- **Contrast** (WCAG AA, `src/renderer/src/styles.css`): text uses `--text-1`, `--text-2` and
  `--text-3` on `--surface-1` (17:1, 7.2:1, 5.4:1). The Check edge uses `--warning` (#fbbf24) on
  `--surface-2` (10.2:1) beside a text badge, so colour is never the only sign. Waiting bars have a
  dashed edge (a shape, not only a colour). Peek outlines and the cover outlines of *Show where covers
  are* use `--accent-400` (2 px and 1 px dashed; 4.0:1 on `--surface-1`, over the 3:1 that WCAG asks
  of graphics) with a 1 px `#000000` halo outside, so they show on any frame; the banner uses
  `--surface-overlay` with `--text-1` (17.5:1).
- **Motion**: the progress line has no animation under `prefers-reduced-motion`; Peek's outlines do
  not blink.
- **Screen sharing**: the UI never shows a found screen text (§2.7), so reviewing on a shared screen
  does not leak it; Peek and the magnified view show it only in the preview, with a banner.

---

## 12. Languages

### 12.1 Catalogues

- A new namespace `privacy` (`privacy.json`, `privacy.meta.json`) holds every message of §2 that is
  not in `review`, `commands`, `main`, `style`, `polish` or `errors`. The contracts step writes all of
  them, each with a meta entry (its place, its arguments and their kinds, `maxLength` where the UI
  needs one). A part that needs another message adds it to `privacy.json` only, with its meta entry.
- **No `#` anywhere.** Rule 17 of `docs/design/output-and-languages.md` (§9.3, decision 17) and the
  checker (`scripts/i18n/lib/catalogue.cjs:114`, the `pound` problem) refuse `#`: every plural above
  selects on `count` and shows `{n}`, formatted by `fmt.count`. Times pass as `count` (whole minutes)
  plus `n`. Percentages pass as text formatted by `fmt` with their sign (`{percent}`).
- **No sentence built from pieces.** A sentence that names a kind is one ICU `select` over the kind's
  id with a whole sentence in each branch (`privacy.review.keepKind`, `uncoverKind`), as Review's
  per-kind messages are whole (`review.kind.<k>.all`). `privacy.kind.<kind>.title` is a standalone
  noun phrase used only as a label's value or a field of a list: the timeline bars' names ("Cover,
  Email address, 0:42 to 3:10"), Review titles ("Email address · 0:42–3:10") and the *What it hides*
  line. These are lists, not sentences; their meta entries say so, so a translator may order the
  fields.
- New keys in existing namespaces:
  - `review.kind.private.{chip,name,all,count}`;
  - `commands.title.{addCover,findPrivate,peekCovers,coverStartHere,coverEndHere}`;
  - `review.polish.step.privacy`, `review.polish.hint.privacy`, `review.polish.hint.privacyChecked`,
    `review.polish.result.privacy`, `review.polish.result.privacyCheck`,
    `review.polish.result.privacyListened`, `review.polish.result.privacyUnfinished`,
    `review.polish.skip.noReader`;
  - `review.versions.area.covers` ("covers");
  - `style.groupEdit.count.cover` (`{count, plural, one {{n} cover} other {{n} covers}}`), which
    `KIND_WORDS: Record<GroupKind, MessageKey>` (`multiSelect.ts:239`) needs once `'cover'` is a
    `GroupKind`, and `style.groupEdit.class.cover.one` ("cover") and `.other` ("covers"), which
    `LOOK_CLASS_WORDS` (`groupEdit.ts:1118`) needs once `'cover'` is a `LookClass`;
  - `main.jobs.privacyDone` (§2.6);
  - `errors.timeline.hidden`.
  No existing message changes (question 17 is the only proposal to change one).
- The scanner (`scripts/i18n/config.json`: `"scan": "fail"`, `"words": "fail"`) covers every new file
  from its first commit: every new file of §16 is added to `failFor` by the contracts step.
- English stays the only shipped UI language until the reviewers of `docs/design/output-and-languages.md`
  §15 approve the Bangla messages; the new messages go through the same review.

### 12.2 The English guard

The English guard (`tests/e2e/english-guard.e2e.cjs`, tests 9 and 10 of `output-and-languages.md`)
compares the whole English UI with `tests/e2e/english-guard/baseline.json` (3,748,519 bytes, 51
screenshots): test 9 every text and accessible name exactly, test 10 every element's box, font and
colour, and every screenshot pixel for pixel (`english-guard.e2e.cjs:4-8`). This wave adds to these
captures and changes no existing text:

| Capture | What is added |
|---|---|
| `tab-shapes` | the *Private info* section (§2.1) and the *Cover* button in the add-shape row |
| `settings-NN` | one more capture: the *Private info* section, after *AI on this PC*; the captures of the sections after it shift by one (`uiTour.cjs:427-435` numbers them by child index) |
| `palette-empty` | the five commands, once off `WAITING_COMMANDS` |
| `shortcuts` | the same five rows |
| `review` | the *Private* chip in the kind list (it shows only when a fixture has private rows: none do, so no change expected) |
| `polish`, the export dialog captures | nothing: the Polish row shows only with the reader, the export note only when one of its lines applies, and the tour has no reader |

- **During the build** every part runs the guard in compare mode, after **one warm-up launch** (or
  with `--twice`): the first contracts run of the first version failed only on cold-launch timing (the
  product tour thumbnail's 6 s capture timeout, and the update check), so a difference that is timing
  on a cold first launch is run again, never recorded. A part's run is expected to fail only on
  additions. The part runs `scripts/i18n/guard-delta.mjs` (new, contracts) on the run's output, which
  passes only when:
  - every screen of the baseline is in the run, after aligning the `settings-NN` captures by their
    section's heading text rather than by number (the new section is reported as an added capture);
  - every text, text attribute and accessible name of the baseline is unchanged in the run;
  - every element of the baseline keeps its tag, font, colour, direction and alignment, and every
    box difference is an added element or a box pushed by one (reported with the element that pushed
    it);
  - **every capture with no added element passes test 10's screenshot rule unchanged** (0.1% of
    pixels may differ by at most 2 levels); the captures with additions are listed, with the
    baseline and the run's screenshots side by side, for the lead to look at.
  It prints the additions for the part's report.
- **At integration** the lead runs `guard-delta.mjs` once more on the merged tree and, only when it
  passes and the listed screenshots were looked at, re-records the baseline with `--record` (two
  identical runs) in a commit that names this feature, as `english-guard.e2e.cjs:12-13` requires.

### 12.3 Commands waiting for their part

Two arrays in `commands.ts` beside `LANGUAGE_COMMANDS` (`:239`), on lines of their own with a blank
line between them, so that P1 and P5 each edit only their own line:

```ts
export const WAITING_P1: readonly CommandId[] = ['addCover', 'peekCovers', 'coverStartHere', 'coverEndHere']

export const WAITING_P5: readonly CommandId[] = ['findPrivate']
export const WAITING_COMMANDS: readonly CommandId[] = [...WAITING_P1, ...WAITING_P5]
```

`PALETTE_COMMANDS` and `listedCommands` leave `WAITING_COMMANDS` out. P1 empties `WAITING_P1`, P5
empties `WAITING_P5`. The contracts write every command's runner case in `Editor.tsx` (each calling a
stub that does nothing until its part, `findPrivate` opening the `FindDialog` stub), so no part edits
the runner. The tests that pin the palette and shortcut lists (`outputSeams.test.ts:30`,
`i18nCommands.test.ts:99-100`) are extended by the contracts to leave out `WAITING_COMMANDS`.

### 12.4 Bangla and other scripts

- The PP-OCRv6 character lists hold all 94 printable ASCII characters and no Bengali, Cyrillic,
  Arabic or Devanagari: Bangla on screen is not read in this wave (§2.9).
- Bangla speech is handled (§7.2). Decision 8's native Bangla review covers its spoken word lists,
  the Bangla label tables of `detect/tables.ts` (used on captions and kept ready for a reader that
  reads Bangla) and the `privacy` catalogue's Bangla messages, through `output-and-languages.md` §15.

---

## 13. Performance

### 13.1 In the editor

- **Cover index** (`coverIndex(covers)`, contracts): built once per `covers` array (WeakMap); covers
  sorted by start in buckets of one second. `coversAt(index, t, slack)` is O(log n + k). Paths are
  parsed once per cover string and cached (WeakMap on the cover object).
- **Review's index** (`privacyIndex(project)`, contracts, used by P5's hooks): built once per `covers`
  and `bleeps` arrays (WeakMap): each group's cover ids, bleep ids and status. `ReviewPanel` works out
  every row's status on every project change (`ReviewPanel.tsx:85`), so `privacyStatus` and
  `privacyPendingCount` are O(1) a row through it, never a scan of every cover per row (as
  `review.ts` already needed for automatic cuts).
- **Drawing**: §8.6. A 2,000-cover project with 50 keys each parses in under 30 ms once.
- **Timeline**: the Covers row draws bars for the visible time only; groups that overlap draw once.
- **Review**: 2,000 private rows are grouped first (a scroll or a page gives one row), and the list is
  windowed as Review's list is.
- **Saving**: a 2,000-cover project adds about 3.5 MB to `project.json` (§4.2) and up to 4,000 legacy
  shapes (about 1.4 MB).
- **Budgets checked by tests** (×6 on CI): `readCovers` of 2,000 covers and 200,000 keys under 150 ms
  (finding 17); `mergeCovers` of 20,000 found items under 300 ms, and twice the items at most 2.3
  times the time (finding 7); `coversAt` under 0.02 ms; `withLegacyShapes` under 50 ms; `maskRequest`
  of a 20,000-caption request under 40 ms; `reviewStatus` over 2,000 private groups under 20 ms;
  `withFoundCovers` with 2,000 existing covers, 5,000 rejected paths and 2,000 new ones under 400 ms.

### 13.2 Find

§5.11. On a 4-core laptop Find keeps at most three threads busy at below-normal priority, leaving a
core to the editor; the preview keeps playing at full rate on the reference PC (checked in decision
8's run).

### 13.3 Size

- Installer: `ssw-ocr.exe`, 4,086,548 bytes at brotli 11 and 16,323,584 bytes installed (measured on
  24 November 2026 by `build-native --require`: the mixed profile with tract, rqrr, sha2 and the
  Windows reader's WinRT bindings, §16.2, where `opt-level = "z"` made it larger; the first build
  measured 3,497,668 bytes at brotli 11), under decision 1's 5 MB line, plus the
  vendored libphonenumber-js and double-metaphone in `app.asar` (403 KB, about 60 KB brotli).
- Downloaded on request: 27,608,757 bytes of models.

---

## 14. Undo, Versions and Review

### 14.1 One action, one undo step

| Action | How it is one step |
|---|---|
| Add cover, the *Cover* tool, Turn into a cover, Turn them all into covers, Keep it for the whole video, Keep covered, Uncover, Start here, End here, a colour chip | one `store.update` |
| Dragging a bar's end or a handle on the preview | one gesture (`beginGesture` … `endGesture`, `editStore.ts:282-290`), merged by key |
| Typing in a box field | merged by key while the field has focus, then `seal` |
| Find's results (covers, bleeps, record) | one `store.update` through `afterGestures` (§5.10, finding 16) |
| *Stop*, *Stop Find and export*, leaving during Find | what was found: one `store.update` through `afterGestures`, then the export or the leave |
| *Follow what is under it* | one update through `afterGestures` when it lands; *Stop* changes nothing |
| *Cover this text everywhere*, with a name added to this video's list | one update through `afterGestures` |
| *Bring them over* on a copy | one update |
| *Also cover the copies* | no step in this project; each copy's file changes once, while it is closed (§5.10) |
| Keep all … covered, Uncover all …, Done reviewing | `heldInSlices` with `removeSteps` (`src/shared/review/slices.ts:103`), one step; *Uncover all* keeps a version first |
| Polish with *Find private info* | inside Polish's one update between seals (`polishRunner.ts:233-239`) |
| Multi-select delete, nudge, colour, Keep covered, Paste look | one update for the whole selection |

**No settle step for covers.** Editing a suggestion makes it the user's inside the edit itself: every
function of P1's `coverEdit.ts` and every group function drops `found` (and `missed`, `thin`) from the
covers it changes. So undo, redo, restoring a version and opening one never settle a suggestion
(finding 19; test 201). There is no new settle step at all: texts made from captions are masked in
`privateView`, which changes nothing stored (§7.5).

### 14.2 Versions

- `AREAS` (`src/shared/editor/versions.ts:199-231`) gains `{ name: 'covers', keys: ['covers'] }`, so a
  changed `covers` shows as "covers" rather than "other settings"; `privacy` joins the same area.
  `CHANGED_AREA_NAMES` (`:245`) gains it; `i18nVersionWords.test.ts` is extended.
- The version body is written with the legacy shapes (§4.6); `hashProject` and the summary are
  computed on the project without them. An automatic version is skipped when one with the same hash
  exists (`src/main/versions.ts:287`), unchanged.
- `AUTO_REASONS` (`:20`) is unchanged: *Uncover all* in Review uses `'review'`, Polish uses `'polish'`.
- Restoring a version replaces `covers` and `privacy` with the version's, as any other field, and
  keeps `found`, `missed` and the bleeps' `auto` as the version holds them.

### 14.3 Review

- `ReviewKind` gains `'private'`, inserted **before `'chapter'`** in `REVIEW_KINDS`
  (`src/shared/review/copy.ts:22`), so `REVIEW_KINDS.slice(-2)` stays `['chapter', 'short']`
  (`smartContracts.test.ts:328`). `KIND_WORDS` takes its four keys (§2.7).
- `src/shared/review/privacyReview.ts` (P5; contracts stubs) gives the hooks `review.ts` calls for
  each aggregator, with the same shapes as `smartReview.ts` (`smartItemStatus(project, item)`,
  `keepSmartItems(project, items)`, `smartReview.ts:34-39`): `privacyReviewItems(project)`,
  `privacyPendingCount(project)`, `privacyStatus(project, item: ReviewItem)`,
  `privacyKeep(project, items: readonly ReviewItem[])` and `privacyRemove(project, items: readonly
  ReviewItem[])`. A row's status is read from the project (`found` on its covers, `auto` on its
  bleeps) through `privacyIndex` (§13.1), so undo and redo need nothing more.
- A private row's places are its `parts` (`ReviewItem.parts`, `review.ts:68`), one per cover, so
  Review's existing parts expansion, part actions and part previews serve them (§2.7).
- `reviewItems` keeps its time order (`review.ts:108`); the Check-first order of the *Private* filter
  is applied by `ReviewPanel` (§2.7).
- Private bleeps are not listed under *Bleep* (`captionReview.ts:212-213` skips `isPrivateBleep`);
  each said text is a private row of its own (§4.4).
- `clipCopy.withinRange` (`clips/clipCopy.ts:106-113`) settles pending rows wholly outside a short
  clip's range by Keep, private rows included; their covers stay (§4.7).
- *Uncover* writes the removed suggestions' paths to `privacy.rejected` (§5.10), in the same update.

### 14.4 Multi-select and group edit (P1)

`'cover'` joins `GROUP_KINDS` (`src/shared/editor/multiSelect.ts:12`) after `'graphic'`, with its own
track (`ItemTrack` `'covers'`), and `LookClass` (`groupEdit.ts:36`) gains `'cover'`. Each switch that
lists the kinds gains its branch, as `'graphic'` joined (`docs/design/captions-studio.md` §10.5). The
items are `ItemEntry` (`multiSelect.ts:32`) and the look is `Look` with `LookClass` `'cover'`
(`groupEdit.ts:78`); the preview's outlines take the `SceneView` the shapes' handles take
(`CalloutHandles.tsx:29`).

| File | What covers do there |
|---|---|
| `multiSelect.ts` (`GROUP_KINDS`, `ItemTrack`, `TRACK_OF`, `projectItems`, `idsOf`, `KIND_WORDS`) | covers are items of the Covers row; `style.groupEdit.count.cover` (§12.1) |
| `selection.ts` (renderer: `Selection`, `validSelection`, `groupKeyOf`) | `{ kind: 'cover', id }`; a group's bar selects its covers (§2.3) |
| `groupEdit.ts` (`LookClass` `'cover'`, `GROUP_FIELDS`, `KIND_OF`, `listOf`, `withList`, `mapItems`, `deleteItems`, `lookName`, `copyLook`, `pasteLook`, `LOOK_CLASS_WORDS`) | the colour is the group field; *Copy look* copies it; delete writes rejected paths for suggestions; every change drops `found` |
| `groupClipboard.ts` (`ClipItem`, `copy`, `paste`) | covers paste only into their own project, like freezes (`projectId`, `:41-42`); a copy is a snapshot of each cover at copy time (finding 18); paste never reads the OS clipboard |
| `groupMove.ts` (`listOf`, the moves) | a time move applies only to covers with one key; followed covers are left in place and the status line says `privacy.cover.timeKept` |
| `nudge.ts` | arrow keys on the preview move the selected covers' whole paths by one pixel (Shift: ten) |
| `multiSelectControl.ts` (`BLOCKS`, `plainClick`) | Ctrl+click and Shift+click on bars |
| `PreviewStage.tsx` (`previewBoxes`, `EditItem`) | group outlines on the preview |
| `Editor.tsx` (single delete `:906-932`, `TAB_TRACK` `:1112`) | the Shapes tab maps to `'covers'` when a cover is selected |
| `itemClipboard.ts` | a single cover's copy is its snapshot, for its own project only |

The Cover section's multi-selection state (title, actions, disabled actions with reasons) is §2.2's.
Selected blur and pixelate shapes offer *Turn into covers* (`privacy.weak.turnSelected`), one undo
step.

Tests that pin these lists are extended: `multiSelectContracts.test.ts:42`, `graphicsSelection.test.ts:89`
(now `GROUP_KINDS.at(-2) === 'graphic'`), `multiSelect.test.ts:58`, `multiSelectCopy.test.ts:18`.

### 14.5 Polish

`PolishStep` gains `'privacy'`, appended after `'director'` in `POLISH_STEPS` (`polish.ts:49`; the
adjacency tests at `smartContracts.test.ts:352`, `studioContracts.test.ts:318-319` and
`editingContracts.test.ts:922` hold). `PolishOptions.privacy: boolean`, `DEFAULT_POLISH_OPTIONS.privacy:
true`, `readPolishOptions` reads a missing value as `false`. `PolishSkip` gains `'no-reader'`
(`SKIP_TEXT`, `polishCopy.ts:113`). `PolishInput.privacy?: PrivacyGathered` (the found covers and
bleeps, or null). `polishRunner.ts` gathers it with `gatherPrivacy(project, captions, signal)` (P5;
contracts stub returns `null`) after that run's captions arrive (`:183`), as a fourth gather;
`planPolish` applies it with `withFoundCovers` in its single update.

`gatherPrivacy` reads the screen unless the project's `privacy.find` has the same kinds and reader
and finished (not stopped, no failed reads); in that case it only listens on the run's captions
(`detectSaid`) and the result line says `privacyListened` (§2.10). `screen.mp4` never changes after
recording, so a screen pass already made with the same choices stays valid. While it runs, Polish's
progress shows Find's phase lines.

---

## 15. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Old projects, settings or presets draw, sound or save differently through shared code (`drawFramePicture`, `maskedSegments`, `migrateProject`, the project writers, AI requests, `privateView`). | Every new path is behind a field absent today; `coverScreen` returns its input with no cover active; `privateView` returns its input without private bleeps; test 20 is written first, alone, and never regenerated. |
| 2 | A secret shows through: next to a cover (blur, lens, scaling), at a frame boundary, on the frame between two analysed frames, under motion blur, in a join or a freeze, in a cropped project. | The fill is in the screen picture before anything samples it, and again on the output (§8); union keys between analysed frames and starts and ends at source frames (§4.2); one coordinate rule (D19); A2 and its variants compare every output of two recordings that differ only under the covers. |
| 3 | A cover ends, or starts, while the text is still there (scrolls, toasts, tooltips, zoom, typing). | Evidence of absence in both directions, check reads, the typing rule, lost areas over every changed region with no time limit (§5.8); A16 checks every planted item in every source frame. |
| 4 | The reader misses text (small fonts, odd fonts, video compression, ClearType, HiDPI). | careful-long; the padded box of §6.1; sizes scaled by the display scale (§5.3); R17 and R18; the 30 real recordings of decision 8; §2.9 says what is not seen; the export note asks to check. |
| 5 | Too many false covers make users turn Find off. | Measured false-hit rates (§6.15); unlabelled random strings off; one Review row per text with places as parts; *Peek while reviewing*; *Keep all … covered* and *Uncover all …*; removed paths are remembered. |
| 6 | A secret said aloud leaks through text made from captions. | Masking by time even when words do not line up (§7.4); translations masked whole; `privateView` at every output (§7.5); spoken forms from the hit's own words (§7.3); `aiTextFor` with a test that no other file calls `aiText` (test 31). |
| 7 | An older Flown shows covered text. | Legacy shapes written by every writer (§4.6); the residual risks listed in §4.6 (the fades, the lens's mosaic, raw Home thumbnails and filmstrip, the recordings timeline, first letters kept, unaligned captions, AI requests, removable private bleeps). |
| 8 | The raw recordings leave through the timeline. | Refused in the renderer and in main, which reads `project.json` itself after the dialog's `flush` (§9 row 10). |
| 9 | The models are swapped or damaged. | Size and SHA-256 in main, and again in the helper on the same buffer it parses (§10.2); downloads checked hop by hop. |
| 10 | The mirror does not exist at release. | `READER_MIRROR` null fails `verify-dist` for a release build (§16.2); the upstream files serve the pinned bytes meanwhile for development. |
| 11 | Find takes too long or slows the editor. | Budgets of §5.11 from measured parts; at most three busy threads at below-normal priority; fixed plan buckets built once; two estimates; *Stop* keeps what was found. |
| 12 | Memory on 8 GB laptops. | Helper ≤ 600 MB at 1080p and 4K, measured per plan (§5.11); tiles; at most 3 reads in flight. |
| 13 | Windows OCR is offered before it is measured. | Built behind `WINDOWS_READER_ALLOWED = false`, with no UI (§5.13); R10 on the reference PC decides. |
| 14 | A crash dump with frames or text leaves the PC. | The helper: `catch_unwind`, restart once, job object, `SetErrorMode`, `WerSetFlags` with no heap, an unhandled-exception filter, and the registry exclusion of question 14 (§10.5). Main's and the renderer's dumps stay under Windows' consent settings, as for every export today. |
| 15 | Merge conflicts in shared files (`compositor.ts`, `Editor.tsx`, `review.ts`, `groupEdit.ts`, `commands.ts`, the catalogues). | The contracts step completes every shared seam and every runner case; `WAITING_P1` and `WAITING_P5` on lines of their own; one owner per file afterwards (§16.6). |
| 16 | The English guard is re-recorded over a real change. | `guard-delta.mjs` proves every old text and name unchanged, aligns the settings captures by heading, and holds the screenshot rule for every capture without additions (§12.2). |
| 17 | Invented secrets in the repository are flagged or mistaken for real ones. | Compressed fixtures with a `.gitignore` and a README (question 15); every value invented. |
| 18 | Bangla speech rules are wrong. | Native review (decision 8, §12.4); Bangla vectors in `rule-vectors.json`; Bangla screen text not claimed. |
| 19 | Pop-up notification rules cover ordinary panels. | Check tier; recordings only, never imported videos (§6.13); decision 8's limit of one false hit per 10 minutes, or the default turns off. |
| 20 | A line on screen built to make a pattern slow freezes Flown. | The rules run in a worker with a 2 s limit a read (D20, §10.3); the static pattern check. |
| 21 | A cover's width tells how long the hidden text is. | Widths rounded to 4 characters plus a random 0-2 per group (D23); §2.9 says what remains. |
| 22 | Uncovering one false hit stops real ones from being suggested. | Suppression only inside the removed path, for its kind (D21); the count is reported. |
| 23 | Find's work is lost, or applied to the wrong project. | One Find at a time; leaving asks and applies what was found; results checked against project and request ids (§5.1). |

---

## 16. Build plan: files, exported signatures and parts

A contracts step made by the lead, then five builder parts in their own worktrees, then integration.
Each part owns the files its table names; it edits an existing file only where §16.6 names it as the
owner. Stubs written by the contracts keep today's behaviour (or render nothing) and have the exact
signatures below, so every part compiles alone.

### 16.0 Contracts step (first; frozen afterwards)

Made on `rev/autoblur-design` after this design, before any part starts. Changed later only with every
part's agreement, recorded here.

1. **The equivalence guard, first and alone.** `tests/autoBlurEquivalence.test.ts` (test 20, §17.2)
   with its digests in `tests/fixtures/autoblur-equivalence.json`, committed by itself against
   `37f9355`'s code, before any other change. Its digests are never regenerated.
2. **The models, pinned and measured again.** The five files of §5.12 are downloaded from their pinned
   upstream commits, their sizes and SHA-256 checked against `scripts/privacy/reader-models.json`, and
   `score_reader.py` (careful-narrow and careful) plus `careful_long.py` run on both sets: the results
   must equal §5.6 within 0.5 points. `src/shared/privacy/readerCatalog.ts` (§16.2's signatures) is
   written in full from that file. The contracts add two flags to `make-eval-set.mjs`: `--seed`, for
   a second held-out set (`--holdout --seed 9000`) rendered only at test time by A16 and the release
   check, on which no part tunes its rules; and `--scale`, which renders the set at a device scale
   (1.5 gives 2880×1620, 2 gives 3840×2160) for R18.
3. **Types and API**: §4.1 in `src/shared/types.ts`; `src/shared/api/privacy.ts`;
   `ProjectSummary.thumbCovers?` (`src/shared/api/projects.ts`); `PrefKey` `'privacy'` and `PREF_KEYS`
   (`src/shared/api/prefs.ts`); `RenderScene.peek?` and `RenderScene.coverMarks?` (`compositor.ts`,
   the fields only); `JobOutcome`'s done outcome gains `notice?: NotificationCopy`, which
   `notificationFor` (`src/shared/jobs/longJobs.ts:160`) returns for any kind when present (no job
   sets it today); `src/preload/privacy.ts` and its line in `src/preload/index.ts`.
4. **Readers, tables and boundaries in full** (with their tests): `kinds.ts`, `coverPath.ts`
   (`stepKeys`, `simplifyKeys`), `coverData.ts`, `covers.ts` (`privacyIndex` included), `protocol.ts`
   (parsing every helper line strictly), the validators of §10.7, `readPrivacyPrefs` (wired into
   `prefsIpc.ts`'s sanitisers), and `readBleeps` keeping private bleeps first when it cuts (§4.4).
5. **Migration and the writers**: `migrateProject` (§4.7); `src/main/projectFile.ts` and its four
   callers (§4.6); the crop mapping (§4.8).
6. **Drawing**: `coverLayer.ts` (`coverScreen`, `drawCoverOutput`, `forOutput`) wired into
   `compositor.ts` (§8.1, §8.2); `forOutput` at every export entry point; `JoinStills.fresh` keyed on
   `peek` and `coverMarks`; `PreviewStage.tsx`'s cover boxes in view space.
7. **Masking in full** (§7): `spoken.ts` (`spokenForms`, `maskPrivate`, `privateView`),
   `maskedSegments` for private bleeps, the translation masks and `maskedFor` in `readCaptionTracks`,
   `maskBleeped` with `maskPrivate`, `search/extract.ts`, `captionReview.ts`, `transcriptText.ts`,
   `privateView` taken at the scene (`Editor.tsx:504-511`) and at every output entry point of §7.5,
   `aiRequest.ts` and `aiTextFor.ts` with all 9 call sites switched.
8. **Output seams**: the guide's `shotSig` and `planActual` (§9 row 12); the timeline refusal in
   `timelineIpc.ts`, `timelineRun.ts` and `ExportBundleOptions.tsx`, and `ExportDialog`'s new `flush`
   prop passed by `Editor.tsx` and called by the bundle run before the timeline request (row 10); Home
   thumbnails (row 17: `thumbTime`, `listProjects` and `captureThumbnail`); the filmstrip's draw
   calling `fillCoverTiles` (row 18, P1 stub draws nothing) from
   `src/renderer/src/editor/Filmstrip.tsx`; `LookThumb` calling `fillCoverPixels` (row 28, P1 stub
   draws nothing).
9. **Review, Versions, multi-select, Polish seams**: `'private'` in `REVIEW_KINDS` and `KIND_WORDS`;
   `review.ts`'s aggregator hooks calling `privacyReview.ts` with `ReviewItem`s (P5 stubs return the
   project, zero and no rows); `keys.ts`'s `peek` action for V on private rows (§2.8); the `covers`
   area in `versions.ts`; `'cover'` in `GROUP_KINDS` and in `LookClass`, with `KIND_WORDS`' and
   `LOOK_CLASS_WORDS`' keys (§12.1) and every switch of §14.4 calling
   `src/shared/editor/coverGroup.ts` (P1 stubs: covers are not selectable yet, `validSelection` drops
   them); `PolishStep` `'privacy'`, its options, `PolishInput.privacy`, `polishRunner.ts` calling
   `gatherPrivacy` (P5 stub `null`); `clipCopy.withinRange` unchanged in code (private rows settle by
   Keep like the rest, §4.7), with a test.
10. **Commands and mounts**: the five commands with `WAITING_P1` and `WAITING_P5` (§12.3); every
    command's runner case in `Editor.tsx`, each calling its stub; the leave hook in `Editor.tsx`'s
    `leave` calling `confirmLeaveFind` (P5 stub resolves `true` at once); mounts of every part's
    component, each a stub rendering nothing: `PrivacySection`, `CoverSection`, `WeakBlurNote` and
    `CoverShapeButton` (in the add-shape row) in `ShapesPanel.tsx`; `CoverTrack` in `Timeline.tsx`
    (beside the other `TrackSlotProps` rows, `:855-859`); `CoverHandles`, `PeekBanner` and
    `PeekInset` in `PreviewStage.tsx`; `PrivacyExportNote` in `ExportDialog.tsx`; `PrivacySettings`
    in `SettingsDialog.tsx` after `LocalAiSection`, with `'privacy'` in `SettingsSection` (it renders
    nothing until P5, so the guard's captures do not move before integration); `TranscribeNote` and
    `TranslatedNote` in the captions panels (`CaptionsPanel.tsx`'s transcription choices and
    `LanguagesSection.tsx`); `NotCheckedNote` in `src/renderer/src/guide/ShotViewer.tsx` and in the
    guide's save and copy area; `PublishMaskedNote` in `PublishDialog.tsx`; `FindDialog` in
    `Editor.tsx`; `FindProgressLine` wherever §2 shows the progress line. The renderer hooks
    `useReaderState` and `useFindProgress` are stubs with their final signatures (P5 fills them;
    P1's components use them from the start).
11. **Main**: `registerReaderIpc()` (P2 stub answers `{ status: 'none' }` and refuses downloads with
    `errors.feature.notReady`), `registerFindIpc()` (P4 stub answers `{ ok: false, reason: 'failed' }`
    and checks the sender and the request first), both called in `src/main/index.ts`;
    `src/main/privacy/names.ts` (`privateNames`, `setPrivateNames`) joined to `secretValues()`.
12. **Catalogues**: `privacy.json` and `privacy.meta.json` complete for §2, the keys of §12.1 in their
    namespaces, every new file in `failFor`; `scripts/i18n/guard-delta.mjs` (§12.2: heading
    alignment of the settings captures, the screenshot rule for captures without additions).
13. **The tracking fixtures**: `scripts/privacy/make-track-fixtures.mjs`, from the evaluation set's
    generator (`eval-lib.mjs`, `eval-scenes.mjs`). It renders the cases of A16 (§17.3) as lossless
    60 fps videos (`-c:v libx264rgb -qp 0`, `-r 60`) with a truth file holding every planted item's
    box in every source frame, read back from the page as `make-eval-set.mjs` reads its truth. Test
    196 renders one short case and checks that its truth boxes hold the drawn ink. It plants only what
    the default rules find: a password with its label line above it (§6.7; planted unlabelled, a
    random-looking string that decision 2 leaves off, it was never found and A16 counted it uncovered
    in every frame), checked from each row case's own lines by the rules.
14. **Tests 1-40 and 186-197** (§17.1), each its own test, and test 20 green throughout. Both
    typechecks, all of vitest, `npm run i18n:check`, `npm run -s build`, and the English guard in
    compare mode after a warm-up launch (no difference at all: every mount renders nothing and every
    command waits).

**Contracts files and signatures** (all new unless marked):

```ts
// src/shared/privacy/kinds.ts
export const PRIVATE_KINDS: readonly PrivateKind[]           // §2.5's order, then 'text'
export const DEFAULT_KINDS: readonly PrivateKind[]           // decision 2
export const SAID_KINDS: readonly PrivateKind[]              // card, code, phone, id, password, email, name
export const AUTO_SCORE = 0.85
export const CHECK_SCORE = 0.5
export function tierOf(score: number): 'auto' | 'check' | null
export const COVER_DARK = '#1c1c22'
export const COVER_COLOURS: Readonly<Record<'dark' | 'light' | 'black' | 'white', string>>

// src/shared/privacy/coverPath.ts
export interface CoverKey { t: number; x: number; y: number; w: number; h: number }
export interface Placement { t: number; box: NormRect }       // a placed or lost box on an analysed frame
export const MAX_KEYS_PER_COVER = 4000
export function parsePath(path: string): CoverKey[] | null
export function writePath(keys: readonly CoverKey[]): string
export function pathKeys(cover: Pick<Cover, 'path'>): readonly CoverKey[]     // parsed once, cached
export function boxAt(cover: Cover, t: number): NormRect | null              // null outside [start, end)
export function drawnBox(cover: Cover, t: number, slack: number): NormRect | null
export function coverSlack(fps: number): number                             // 0.5 / fps + 0.001
export function unionBox(a: NormRect, b: NormRect): NormRect
/** Keys for placements on analysed frames, with a union key at the first source frame after each move (§4.2). */
export function stepKeys(placements: readonly Placement[], fps: number): CoverKey[]
/** Merges neighbouring keys of the longest paths first until the total is at most maxKeys (§4.2). */
export function simplifyKeys(covers: readonly Cover[], maxKeys: number): Cover[]

// src/shared/privacy/coverData.ts
export const MAX_COVERS = 2000
export const MAX_KEYS = 200000
export const LEGACY_PREFIX = '~cover:'
export const MAX_LEGACY_SHAPES = 4000
export function readCovers(raw: unknown, duration: number): Cover[] | undefined
export function widenShort(cover: Cover, duration: number): Cover                 // at least 0.02 s, never dropped
export function readPrivacy(raw: unknown, duration: number): ProjectPrivacy | undefined
export function readPrivacyPrefs(raw: unknown): PrivacyPrefs | null
export function isPrivateBleep(b: Pick<Bleep, 'word'>): boolean
export function privateBleepWord(kind: PrivateKind, group: string): string        // ':card:k3v9q2m8xa'
export function privateKindOf(b: Pick<Bleep, 'word'>): PrivateKind | null
export function privateGroupOf(b: Pick<Bleep, 'word'>): string | null
export function legacyPieces(cover: Cover, slack: number): { start: number; end: number; box: NormRect }[]
export function withLegacyShapes(project: Project): Project
export function withoutLegacyShapes(shapes: unknown): unknown
export function mergeCovers(covers: readonly Cover[], max: number): Cover[]
export function thumbTime(duration: number): number                              // min(1, duration × 0.15)
export function thumbCovers(project: Project, from: number, to: number): NormRect[]
export function hidesSomething(project: Pick<Project, 'covers' | 'shapes' | 'bleeps' | 'crop'>): boolean   // the crop only if question 18 says (a)
export interface PrivateItems { items: number; waiting: number; check: number; said: number; weak: number }
export function privateItems(project: Pick<Project, 'covers' | 'bleeps' | 'shapes'>): PrivateItems   // §2.12's unit

// src/shared/privacy/covers.ts
export interface CoverIndex { readonly covers: readonly Cover[] }
export function coverIndex(covers: readonly Cover[]): CoverIndex             // cached per array
export function coversAt(index: CoverIndex, t: number, slack: number): readonly Cover[]
export function coversIn(index: CoverIndex, from: number, to: number): readonly Cover[]
export function containsOver(outer: Pick<Cover, 'path' | 'start' | 'end'>, inner: Pick<Cover, 'path' | 'start' | 'end'>, slack: number): boolean
export function placeOf(box: NormRect): 'topLeft' | 'top' | 'topRight' | 'left' | 'centre' | 'right' | 'bottomLeft' | 'bottom' | 'bottomRight'
export interface PrivacyIndex { group(id: string): { covers: readonly string[]; bleeps: readonly string[]; waiting: boolean; check: boolean } | null; readonly groups: readonly string[] }
export function privacyIndex(project: Pick<Project, 'covers' | 'bleeps'>): PrivacyIndex   // cached per covers and bleeps arrays

// src/shared/privacy/protocol.ts
export const OCR_PROTOCOL = 1
export type Box = [x: number, y: number, w: number, h: number]               // video pixels
export interface ModelPin { file: string; path: string; bytes: number; sha256: string }
export interface LookMove { box: Box; dx: number; dy: number; score: number; alt: [dx: number, dy: number, score: number][] }
export interface LookFrame { t: number; key: boolean; tiles: string; moves: LookMove[] }
export interface ReadVariant { model: 'tiny' | 'small' | 'windows'; text: string; conf: number; spans: [number, number][] }
export interface ReadLine { box: Box; quad: [number, number][]; variants: ReadVariant[]; ring: string; spread: number }
export interface ReadResult { t: number; lines: ReadLine[]; qr: { quad: [number, number][]; payload: string | null }[]; partial?: Box[] }
export interface Candidate { dx: number; dy: number; scale: number }
export interface TrackMatch { track: number; parts: (number | null)[]; best: Candidate | null; second: number }
export type HelperCommand =
  | { op: 'open'; id: number; protocol: 1; reader: 'paddle' | 'windows'; models: ModelPin[]; ffmpeg: string }
  | { op: 'look'; id: number; video: string; k: number; step: number; from: number; to: number }
  | { op: 'read'; id: number; video: string; key: number; t: number; areas: Box[] }
  | { op: 'careful'; id: number; read: number; lines: number[] }
  | { op: 'release'; id: number; read: number }
  | { op: 'followOpen'; id: number; video: string; key: number; from: number; to: number; dir: 1 | -1 }   // [from, to], to ≥ from; dir -1 walks it from `to` down
  | { op: 'track'; id: number; session: number; track: number; t: number; parts: Box[] }
  | { op: 'match'; id: number; session: number; t: number; tracks: { track: number; parts: number[]; candidates: Candidate[] }[] }
  | { op: 'closeSession'; id: number; session: number }
  | { op: 'cancel'; id: number; target: number }
  | { op: 'pause'; id: number } | { op: 'resume'; id: number } | { op: 'stop'; id: number }
export type HelperEvent =
  | { alive: number }
  | { id: number; opened: { protocol: number; version: string; reader: 'paddle' | 'windows' } }
  | { id: number; look: LookFrame[]; done: boolean }
  | { id: number; read: ReadResult }
  | { id: number; careful: ReadVariant[][] }
  | { id: number; session: { from: number; to: number; frames: number } }
  | { id: number; matched: TrackMatch[] }
  | { id: number; done: true }
  | { id: number; error: 'model' | 'read' | 'video' | 'tooLarge' | 'stopped' | 'cancelled' | 'panic' | 'bad-command' }
export function parseHelperEvent(line: string): HelperEvent | null           // strict; unknown or malformed → null, never throws
export function commandLine(c: HelperCommand): string

// src/shared/api/privacy.ts
export type ReaderState =
  | { status: 'none' } | { status: 'downloading'; done: number; total: number } | { status: 'ready'; bytes: number; decodeMs: number | null }
  | { status: 'damaged' } | { status: 'failed'; reason: string } | { status: 'unavailable'; reason: 'helper' | 'cpu' }
export interface FindRequest { projectId: string; requestId: string; kinds: PrivateKind[]; regions: string[]; names: string[]; neverHide: string[]; only?: 'everywhere' }
export interface FindProgress { projectId: string; requestId: string; phase: 'look' | 'read' | 'follow' | 'waiting'; done: number; total: number; secondsLeft: number | null }
export interface FoundCover { kind: PrivateKind; score: number; group: string; start: number; end: number; path: string; color: string; lost?: true; thin?: true }
export type FindFailure = 'reader' | 'busy' | 'tooLarge' | 'helper' | 'video' | 'crashed' | 'failed'
export type FindResult =
  | { ok: true; projectId: string; requestId: string; found: FoundCover[]; failedReads: number; thinSpans: string; stopped: boolean; readTo: number | null; reader: string; crashed?: true; notFollowed?: number }
  | { ok: false; projectId: string; requestId: string; reason: FindFailure }
export interface FollowRequest { projectId: string; requestId: string; t: number; box: NormRect; start: number; end: number; path: string }
export type FollowResult =
  | { ok: true; projectId: string; requestId: string; path: string; start: number; end: number; walked: { start: number; end: number }; lostSpans: string; thin: boolean }
  | { ok: false; projectId: string; requestId: string; reason: 'none' | 'stopped' | 'busy' | 'failed' }
export interface UnderCoverRequest { projectId: string; requestId: string; t: number; box: NormRect }
export type UnderCoverResult = { ok: true; nameLike: boolean } | { ok: false; reason: 'noText' | 'reader' | 'busy' | 'failed' }
export interface EverywhereRequest { projectId: string; requestId: string; remember: 'no' | 'project' | 'settings' }
export type EverywhereResult = (Extract<FindResult, { ok: true }> & { addedName?: string }) | Extract<FindResult, { ok: false }>
export interface CopyInfo { id: string; name: string; open: boolean }
export interface OriginCovers { missing: number; covers: FoundCover[]; bleeps: Bleep[] }
export interface PrivacyApi {
  readerState(): Promise<ReaderState>
  downloadReader(): Promise<ReaderState>
  cancelReaderDownload(): Promise<void>
  removeReader(): Promise<ReaderState>
  onReaderState(listener: (state: ReaderState) => void): () => void
  findPrivate(request: FindRequest): Promise<FindResult>
  stopFind(projectId: string): Promise<void>
  onFindProgress(listener: (progress: FindProgress) => void): () => void
  followCover(request: FollowRequest): Promise<FollowResult>
  underCover(request: UnderCoverRequest): Promise<UnderCoverResult>
  coverEverywhere(request: EverywhereRequest): Promise<EverywhereResult>
  copies(projectId: string): Promise<CopyInfo[]>
  coverCopies(projectId: string, copyIds: string[]): Promise<{ covered: number; skipped: string[] }>
  originCovers(projectId: string): Promise<OriginCovers>
  setPrivateNames(names: string[]): Promise<void>
}
export function validateFindRequest(raw: unknown): FindRequest | null
export function validateFollowRequest(raw: unknown, duration: number): FollowRequest | null
export function validateUnderCoverRequest(raw: unknown, duration: number): UnderCoverRequest | null
export function validateEverywhereRequest(raw: unknown): EverywhereRequest | null
export function validateCopiesRequest(raw: unknown): { projectId: string; copyIds: string[] } | null

// src/shared/privacy/spoken.ts
export interface SpokenForms { readonly phrases: readonly string[]; readonly digits: readonly string[] }
export function spokenForms(project: Pick<Project, 'transcript' | 'bleeps'>): SpokenForms | null
export function maskChars(text: string): string                             // '•' for each letter and digit
export function maskPrivate(text: string, forms: SpokenForms | null): string
export function maskedForOf(project: Pick<Project, 'transcript' | 'bleeps'>, segmentId: string): string
export const PRIVATE_TEXT_FIELDS: readonly string[]                         // §7.5
export function privateView<P extends Project>(project: P): P               // memoised; `project` itself without private bleeps

// src/shared/privacy/aiRequest.ts
export function maskRequest<R extends object>(request: R, project: Pick<Project, 'transcript' | 'bleeps'>): R

// src/renderer/src/ai/aiTextFor.ts
export function aiTextFor(project: Project, providerId: string, request: AiTextRequest, requestId?: string): ReturnType<AiApi['aiText']>

// src/renderer/src/render/coverLayer.ts
export interface OutputView { toOut(x: number, y: number): { x: number; y: number } }
export function coverScreen(target: CanvasRenderingContext2D, screen: FrameImage, full: FrameImage, scene: RenderScene, t: number): FrameImage
export function drawCoverOutput(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly OutputView[]): void
export function forOutput<S extends RenderScene>(scene: S): S               // without peek and coverMarks

// src/renderer/src/privacy/readerState.ts (P5 fills; stubs return null and render nothing)
export function useReaderState(): ReaderState | null
export function useFindProgress(projectId: string): FindProgress | null
export function FindProgressLine(props: { projectId: string; onReview?: () => void }): JSX.Element | null
export function confirmLeaveFind(services: EditorServices): Promise<boolean>

// src/main/projectFile.ts
export function projectFileText(project: Project, form?: 'pretty' | 'compact'): string

// src/main/privacy/names.ts
export function privateNames(): string[]
export function setPrivateNames(names: unknown): void
```

**What the contracts step settled** (branch `feat/wave13`, from `d92ce61`; recorded as in
`docs/design/output-and-languages.md` §21.0):

- **The guard first.** Test 20 was committed alone (`f4cd44c`) and its digests were never made
  again. Home's summaries are compared without the two fields this wave adds to them
  (`thumbCovers` and `thumbCrop`); the test checks each of them on its own.
- **The reader's pins.** `readerCatalog.ts` holds the five files of §5.12 (27,608,757 bytes),
  `READER_MIRROR` stays null and `WINDOWS_READER_ALLOWED` false. The scores were measured again on
  both sets and equal §5.6 (`scripts/privacy/results/contracts-rescore.txt`). `make-eval-set.mjs`
  takes `--seed` and `--scale`; without them it writes the committed frames byte for byte.
- **Question 13 (a)** is built: `ProjectSummary.thumbCrop`, and Home draws a thumbnail through the
  crop with the covers' boxes. Questions 17 and 18 are built as (b): no English message changes,
  and a crop or a muted part alone hides nothing (`CROP_HIDES = false`).
- **Polish.** `PrivacyGathered` is `{ covers, said, privacy, found, check, listenedOnly, unfinished }`:
  the covers as Find's merge leaves them, the private bleeps to add (by id), and the run's record.
  `planPolish` applies it in its one update; `summary.privacy` is set only when the step ran. The
  dialog shows the row only once `useReaderState()` is not null, and runs the step only then; with
  nothing gathered the step is skipped as `no-reader`.
- **Commands.** No category is named *View*, and a new one would change the palette's list, so
  `peekCovers` is in *Effects*; `addCover` and `findPrivate` in *Add*; the two trims in *Edit*. They
  sit after the Language command, before the blocks whose places later waves' tests pin. The
  runner's four cover commands come from `src/renderer/src/privacy/coverCommands.ts`
  (`coverCommands({ services, cursor, scene, selection, select, reveal, notice })`, stubs that part
  P1 fills); `findPrivate` opens the `FindDialog` stub. Leaving asks `confirmLeaveFind` before the
  save.
- **Multi-select.** A group move moves covers through `moveCoversInTime` by the move's delta; a
  length change leaves covers alone; a group copy leaves covers out until P1; deleting covers in a
  group goes through `deleteCoverItems`. The Selection view names a cover section with
  `privacy.track.title` and a cover row with `privacy.cover.title`; Select only the… has no cover
  branch (its message is not changed), which P1 meets when covers become selectable.
- **AI requests.** `maskRequest` leaves the ids, the task and a caption's id as they are and
  masks every other string by time; `marks.captions` word lists are made again from the masked
  text. The nine call sites go through `aiTextFor`.
- **Main.** The privacy channels check their sender before anything else, validate, and answer a
  valid request as failed until P2 and P4; Follow's and the text under a cover's times are checked
  against the duration main reads from `project.json`. The listed names join `secretValues()`,
  `scrubSecrets` and every log and diagnostics line take them out first, in any case. A job's
  `notice` is set only in main (`validOutcome` drops one sent by a page).
- **Merging and reading paths.** `mergeCovers` keeps each round's covers in start order as arrays
  and writes merged keys into one pool; `parsePath` reads each field's digits as it scans, and
  `readCovers` checks a path with `scanPath` without making its keys (they are made when first
  drawn). Tests 3 and 13 time processor time, in up to five rounds, the bounds unchanged.
- **The scanner and the guard.** Every file the contracts step made is in `failFor` (42); a later
  part adds each of its new files in the commit that makes it, because `outputSeams.test.ts` holds
  every `failFor` entry to an existing file (the whole tree fails the scan since step S4 anyway). `guard-delta.mjs` reads a settings capture's section as the first section heading
  below the dialog's own, its words from the accessibility tree; a moved box passes when an element
  was added before it, above it or beside it.
- **Tracking fixtures.** `make-track-fixtures.mjs` renders ten cases (list scroll, flick, browser
  zoom, selection, sticky header, dragged window, toasts, tooltip, typed email, typed key); a part of
  an item under a toast, a tooltip or a header is left out of its box. Test 196 needs Chromium
  through Playwright, as `make-eval-set.mjs` does.
- **Old outputs pinned for the tests.** `tests/fixtures/autoblur-english-37f9355.json` (each English
  namespace's digest at `37f9355`) and `tests/fixtures/autoblur-job-notices-37f9355.json` (what that
  commit's `notificationFor` gave for every kind and ending).

### 16.1 Part P1 · Covers in the editor

| File | Exports or change |
|---|---|
| `src/shared/editor/coverEdit.ts` (new) | `type CoverLength = 'three' \| 'toEnd' \| 'whole'`; `function addCover(project: Project, at: { t: number; box: NormRect; length: CoverLength; color: string }, random?: () => number): { project: Project; id: string }`; `function coverFromShape(project: Project, shapeId: string, color: string): { project: Project; id: string } \| null`; `function coversFromShapes(project: Project, shapeIds: readonly string[], colours: Readonly<Record<string, string>>): { project: Project; ids: string[] }` (*Turn into covers* and *Turn them all into covers*); `interface BoxEdit { move?: { dx: number; dy: number }; edges?: { left?: number; top?: number; right?: number; bottom?: number } }`; `function editCoverBox(project: Project, id: string, t: number, edit: BoxEdit, wholePath: boolean): Project` (edges move at every key; the move at every key with `wholePath`, else from `t` to the next key, §2.2); `function setCoverEnds(project: Project, id: string, start: number, end: number): Project` (holds the first and last boxes); `function coverStartHere(project: Project, id: string, t: number): Project \| null` and `function coverEndHere(project: Project, id: string, t: number): Project \| null` (null outside the cover); `function moveCoverTime(project: Project, id: string, dt: number): Project \| null` (null for a cover with more than one key); `function coverWholeVideo(project: Project, id: string): Project`; `function setCoverColour(project: Project, ids: readonly string[], color: string): Project`; `function keepCovers(project: Project, ids: readonly string[]): Project`; `function deleteCovers(project: Project, ids: readonly string[]): Project` (writes each suggestion's path to `privacy.rejected`); `function nudgeCovers(project: Project, ids: readonly string[], dx: number, dy: number): Project`; `interface CoverClip { projectId: string; at: number; covers: Cover[] }`; `function copyCovers(project: Project, ids: readonly string[], at: number): CoverClip`; `function pasteCovers(project: Project, clip: CoverClip, at: number): { project: Project; ids: string[] } \| null` (null for another project); `function duplicateCover(project: Project, id: string): { project: Project; id: string }`; `function withFollowedPath(project: Project, id: string, result: Extract<FollowResult, { ok: true }>): Project` (replaces inside `walked` where placed, keeps the old box where lost and outside, §5.9); `function newCoverId(random: () => number): string`. Every function drops `found`, `missed` and `thin` from the covers it changes |
| `src/shared/editor/coverGroup.ts` (stub from the contracts) | the branches of §14.4: `function coverItems(project: Project): ItemEntry[]`; `function coverTrackOf(): ItemTrack`; `function moveCoversInTime(project: Project, ids: readonly string[], dt: number): { project: Project; refused: string[] }`; `function deleteCoverItems(project: Project, ids: readonly string[]): Project`; `function coverLookOf(cover: Cover): Look`; `function pasteCoverLook(project: Project, ids: readonly string[], look: Look): Project`; `function validCoverSelection(project: Project, id: string): boolean`; `function groupCoverIds(project: Project, coverId: string): string[]` (a group's bar selects them) |
| `src/shared/render/coverColour.ts` (new) | `function ringColour(pixels: Uint8ClampedArray, width: number, height: number, box: { x: number; y: number; w: number; h: number }): { color: string; spread: number }`; `function coverColourOf(ring: { color: string; spread: number }, pref: PrivacyPrefs['colour']): string` |
| `src/renderer/src/render/coverGrade.ts` (stub from the contracts) | `function gradedCoverColour(color: string, grade: ColorGrade \| undefined, lut: CubeLut \| null, compare?: boolean): string`; `function drawCoverPeek(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly OutputView[]): void`; `function drawCoverMarks(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly OutputView[]): void` |
| `src/renderer/src/privacy/peek.ts` (new) | `interface PeekState { ids: readonly string[] \| 'all' \| null; review: boolean; listen: string \| null; marks: boolean }`; `function peekCovers(ids: readonly string[] \| 'all' \| null): void`; `function peekWhileReviewing(on: boolean): void`; `function listenBleep(id: string \| null): void`; `function showCoverMarks(on: boolean): void`; `function clearPeek(): void`; `function peekNow(): PeekState`; `function usePeek(): PeekState`; `function peekedScene<S extends RenderScene>(scene: S): S`; `function listenedGains(gains: readonly SoundGain[], project: Pick<Project, 'bleeps'>): readonly SoundGain[]` |
| `src/renderer/src/privacy/coverPick.ts` (new) | `function ringColourAt(projectId: string, t: number, box: NormRect): Promise<string>` |
| `src/renderer/src/privacy/followRun.ts` (new) | `function runFollow(services: EditorServices, coverId: string, signal: AbortSignal): Promise<'done' \| 'none' \| 'stopped' \| 'busy' \| 'failed'>`; `function runEverywhere(services: EditorServices, coverId: string, remember: EverywhereRequest['remember'], signal: AbortSignal): Promise<{ added: number; name: string \| null } \| null>` |
| `src/renderer/src/privacy/filmstripCovers.ts` (stub from the contracts) | `function fillCoverTiles(ctx: CanvasRenderingContext2D, project: Project, fps: number, tiles: readonly { t: number; x: number; y: number; w: number; h: number }[]): void` (window `[t − 15 / fps − 0.02, t]`); `function fillCoverPixels(pixels: Uint8ClampedArray, width: number, height: number, project: Project, t: number): void` (look chips) |
| `src/renderer/src/privacy/PrivacySection.tsx`, `CoverSection.tsx`, `WeakBlurNote.tsx`, `CoverShapeButton.tsx`, `CoverTrack.tsx`, `CoverHandles.tsx`, `PeekBanner.tsx`, `PeekInset.tsx`, `EverywhereDialog.tsx`, `covers.css` (stubs from the contracts) | `function PrivacySection(props: { services: EditorServices; onFind: () => void; flush?: () => unknown }): JSX.Element \| null` (`flush`: the editor's saver, given through the Inspector, for the copies offer with its result line, §2.12); `function CoverSection(props: { services: EditorServices; coverIds: readonly string[]; shapeIds: readonly string[] }): JSX.Element \| null`; `function WeakBlurNote(props: { services: EditorServices; shapeId: string }): JSX.Element \| null`; `function CoverShapeButton(props: { services: EditorServices }): JSX.Element \| null`; `function CoverTrack(props: TrackSlotProps): JSX.Element \| null` (the props every timeline row takes, `Timeline.tsx:855-859`); `function CoverHandles(props: { project: Project; selection: Selection; view: SceneView }): JSX.Element \| null`; `function PeekBanner(): JSX.Element \| null`; `function PeekInset(props: { services: EditorServices; view: SceneView }): JSX.Element \| null`; `function EverywhereDialog(props: { services: EditorServices; coverId: string; onClose: () => void }): JSX.Element` |
| `src/renderer/src/editor/player.ts`, `joinStills.ts`, `previewAudio.ts` | the preview scene through `peekedScene` (peek and marks); the listened bleep left out of the preview's gains |
| `src/renderer/src/guide/guideRun.ts` | `export async function blurArea(services: EditorServices, step: GuideStep, opts: { after: boolean; scale: number; onSelect(sel: Selection): void }): Promise<string>` (the cover's id) and `export async function blurTypedText(store: EditStore<Project>, typing: GuideStep, marked: { t: number }, scan: SceneScan \| null, scale: number, colourAt: (t: number, box: NormRect) => Promise<string>): Promise<void>`: each awaits `ringColourAt` at the step's own shot time, then makes one update (§2.11) |
| the files of §14.4 | the `'cover'` branches, through `coverGroup.ts` |
| Tests | 41-75 and 201-215 |

P1 empties `WAITING_P1` and fills the runner's stubs for its four commands (`commands.ts`, its one
line only).

### 16.2 Part P2 · The reader

| File | Exports or change |
|---|---|
| `native/ocr/Cargo.toml`, `Cargo.lock` (new) | its own `[workspace]`, `license = "MIT"`, `publish = false`, `rust-version = "1.91"`; `tract-onnx = { version = "=0.23.10", default-features = false }`, `rqrr = "=0.11.0"`, `sha2`, `serde_json`, `windows-sys` (job objects, `SetErrorMode`, `WerSetFlags`, `SetUnhandledExceptionFilter`, `TerminateProcess`), `windows` (`Media_Ocr`, `Graphics_Imaging`, `Storage_Streams`, `Foundation` for §5.13); profile `release` with `opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "unwind"` (needed for `catch_unwind`), and `opt-level = 3` for `tract-linalg` and `tract-core` (the mixed profile); feature `fixture` (test builds only) |
| `native/ocr/src/main.rs`, `protocol.rs`, `models.rs`, `look.rs`, `read.rs`, `ctc.rs`, `follow.rs`, `qr.rs`, `ffmpeg.rs`, `guard.rs`, `winocr.rs` (new) | the commands and events of `protocol.ts`; the three threads of §5.5 with `careful`, `release` and `cancel` handled between commands; heartbeat every 2 s from start (also during `open`); exit on stdin end and on a failed heartbeat write; `open` reads each model once, hashes the buffer and parses that buffer, every pin before any parse; the three detector buckets and both recognisers' five plans built at open and kept; `tooLarge`; look (§5.2); read with buckets, packing, tiles, joins, chunks, spans, rings and QR, `partial` at a cap (§5.5); `careful` as its own event (§5.6); the follow session (§5.8); the Windows reader behind `reader: 'windows'` (§5.13); ffmpeg with `-threads 1` (2 for look) in a job object with `KILL_ON_JOB_CLOSE`, seeking to key frames; `pause` and `resume` (§5.11); `catch_unwind` around each read with plans rebuilt after a panic; the panic hook, `SetErrorMode`, `WerSetFlags` and the unhandled-exception filter at start (§10.4, §10.5). The `fixture` feature adds `{ op: 'readImage', png }` for the evaluation PNGs; release builds do not contain it |
| `native/ocr/tests/cli.rs`, `native/ocr/README.md` (new) | R1-R32 (§17.1); the README records the pins, the tract parity method and the measurements of §5.5, §5.6 and §5.11 |
| `scripts/build-native.mjs` | `--ocr` and `--ocr-host` flags; `cargoOcr`, `buildOcrWindows` (MinGW POSIX, the import allow-list, the budget, copied to `native/bin/ssw-ocr.exe`), `buildOcrHost` |
| `scripts/lib/packaging.cjs` | `function ocrHelper(): string`; `const OCR_IMPORTS = ['KERNEL32.dll', 'ntdll.dll', 'msvcrt.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll', 'combase.dll', 'oleaut32.dll', 'api-ms-win-core-winrt-l1-1-0.dll']` (the WinRT three for §5.13; measured by the first build); `const OCR_BUDGET = { compressed: 4.3e6, installed: 17.2e6 }` (about 5% over the measured 4.09 MB and 16.3 MB of §13.3, and under decision 1's 5 MB line; the 3.9e6 and 16e6 first written here were below what the helper measures with the Windows reader in it); `function ocrHelperStatus(): …`; `function ocrHelperProblems(file: string): string[]` (brotli 11 with a 2^24 window, as `llmHelperProblems`, `:214-237`); `speechResources` carries it to `resources/native` so it is signed |
| `scripts/verify-dist.mjs` | §4d: the helper's imports, budget and no `readImage` string; for a release build (`FLOWN_RELEASE=1`), `READER_MIRROR` must not be null |
| `scripts/notices.mjs` | `CRATES` gains `native/ocr/Cargo.toml`; `RUST_TITLE` names `ssw-ocr.exe`; `resources/notices/41-paddleocr-models.txt` (Apache-2.0 text, NOTICE, "downloaded when you ask for it") |
| `build/installer.nsh` | the WER value in `customInstall` under HKLM or HKCU by install mode, and a new `customUnInstall` removing it from the same place (§10.5) |
| `src/shared/privacy/readerCatalog.ts` (written by the contracts in full; P2 reads it) | `interface ReaderFile { file: string; bytes: number; sha256: string; repo: string; commit: string }`; `const READER_FILES: readonly ReaderFile[]`; `const READER_BYTES = 27608757`; `const READER_ID = 'pp-ocrv6-tiny+small-careful-long'`; `const READER_MIRROR: { repo: string; commit: string } \| null = null`; `const WINDOWS_READER_ALLOWED = false`; `function readerUrls(f: ReaderFile, mirror?: { repo: string; commit: string } \| null): string[]` |
| `src/main/privacy/readerModels.ts` (new) | `function readerDir(): string`; `function readerState(): ReaderState`; `function downloadReader(onState: (s: ReaderState) => void, signal: AbortSignal, deps?: DownloadDeps): Promise<ReaderState>`; `function removeReader(): Promise<ReaderState>`; `function checkReader(): Promise<ModelPin[] \| null>` (sizes and hashes; null and `damaged` on a mismatch); `function recordDecodeSpeed(msPerFrame1080: number): void`; `function decodeSpeed(): number \| null` |
| `src/main/privacy/readerHelper.ts` (new) | `function helperPath(): string \| null`; `interface FollowSession { readonly id: number; track(track: number, t: number, parts: readonly Box[]): Promise<void>; match(t: number, tracks: readonly { track: number; parts: readonly number[]; candidates: readonly Candidate[] }[]): Promise<TrackMatch[]>; close(): Promise<void> }`; `class OcrHelper { static start(deps?: HelperDeps): Promise<OcrHelper>; open(pins: ModelPin[], ffmpeg: string, reader?: 'paddle' \| 'windows'): Promise<void>; look(req: Omit<Extract<HelperCommand, { op: 'look' }>, 'op' \| 'id'>, onFrames: (f: LookFrame[]) => void, signal: AbortSignal): Promise<void>; read(req: Omit<Extract<HelperCommand, { op: 'read' }>, 'op' \| 'id'>, signal: AbortSignal): Promise<{ id: number; result: ReadResult }>; careful(readId: number, lines: readonly number[]): Promise<ReadVariant[][]>; release(readId: number): void; followOpen(req: Omit<Extract<HelperCommand, { op: 'followOpen' }>, 'op' \| 'id'>, signal: AbortSignal): Promise<FollowSession>; cancel(id: number): void; pause(): void; resume(): void; stop(): Promise<void>; kill(): void; readonly exited: Promise<number \| null>; readonly refusedLines: number }` (20 s silence kills it; at most 3 reads unreleased; never logs stderr or a line) |
| `src/main/privacy/helperUse.ts` (new) | What the helper's users share, in one place with no Electron (readerHelper re-exports it; the scan, findIpc and the rules' worker take it from here): `type HelperFailure`; `class HelperError extends Error { readonly kind: HelperFailure }`; `function findFailureOf(err: unknown): FindFailure`; `function failureKind(err: unknown): string` (a failure's kind for a log line: the helper's error kind or the error's name, never its message); `function pauseWhileRecording(helper: { pause(): void; resume(): void }, recording: () => boolean, onWaiting: (waiting: boolean) => void, everyMs?: number): () => void` (checked at once, then every 2 s; the scan passes the helper it has now, which a restart replaces); `function carefulLines(result: Pick<ReadResult, 'lines'>, hits: readonly Hit[]): number[]`; `function withCareful(result, lines, careful)` |
| `src/main/privacy/readerIpc.ts` (stub from the contracts) | `function registerReaderIpc(): void` (sender check first) |
| `tests/fixtures/fake-ocr-helper.cjs` (new) | a scripted helper for main's tests and the e2e runs: answers from a JSON script (`SSW_OCR_SCRIPT`), can crash on a chosen read, stall, answer a bad hash, answer `partial`, or write a marker string to stderr |
| Tests | 76-100 and 216-222; Rust R1-R32 |

### 16.3 Part P3 · The text rules

| File | Exports or change |
|---|---|
| `src/shared/privacy/detect/clean.ts` (new) | `interface CleanLine { text: string; map: Int32Array; digit: string; prefix: string; url: string; label: string }`; `function cleanLine(raw: string): CleanLine`; `function foldText(s: string): string` |
| `detect/email.ts`, `cards.ts`, `phones.ts`, `ids.ts`, `keys.ts`, `links.ts`, `labels.ts`, `extra.ts` (new) | one `function find<Kind>(line: CleanLine, ctx: LineContext): Hit[]` each: emails (§6.3); cards, CVV and IBAN (§6.8); phones (§6.8); IDs (§6.8); strong prefixes and PEM lines (§6.4); link secrets (§6.5); strong labels, passwords, PINs and codes (§6.6, §6.7); addresses, dots and random strings (§6.12) |
| `detect/rows.ts` (new) | `function rowRules(lines: readonly DetectLine[], hits: Hit[], ctx: FrameContext): Hit[]` (beside, under, code under a sentence, recovery blocks and grids, PEM blocks, continuation, JWT head, one space in a key, wrap join, §6.10) |
| `detect/windows.ts` (new) | `function lineWindows(text: string): { start: number; text: string }[]` (512 characters overlapping by 256); `function extendAtEdges(hits: Hit[], line: CleanLine): Hit[]` (§10.3) |
| `detect/names.ts` (new) | `function compileNames(entries: readonly string[], neverHide: readonly string[]): NameMatcher`; `function findNames(line: CleanLine, m: NameMatcher): Hit[]`; `function saidNames(words: readonly CaptionWord[], m: NameMatcher): SaidHit[]`; `function looksLikeName(text: string): boolean` (§5.9: at most 40 characters of letters, spaces, `.`, `'` and `-`, and no rule of §6.4-6.8 hits it) |
| `detect/qr.ts` (new) | `function classQr(payload: string \| null): { kind: 'qr'; score: number; class: 'secret' \| 'personal' \| 'other' \| 'undecoded' }` |
| `detect/score.ts`, `detect/detect.ts` (new) | `interface Hit { kind: PrivateKind; rule: string; score: number; spans: { line: number; start: number; end: number }[]; box: Box }`; `interface DetectOptions { kinds: readonly PrivateKind[]; regions: readonly string[]; names: NameMatcher; frame: { width: number; height: number } }`; `function detectFrame(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions): Hit[]` (every variant, union, dedupe, padded cover boxes; the width rounding is `found.ts`'s); `function needsCareful(line: ReadLine, hits: readonly Hit[], index: number): boolean` (careful-long's trigger) |
| `detect/said.ts` (new) | `interface SaidHit { kind: PrivateKind; score: number; start: number; end: number; estimated: boolean; group: string; words: [number, number] }` (the own word span); `function digitRuns(words: readonly CaptionWord[]): DigitRun[]`; `function detectSaid(transcript: Transcript, options: { kinds: readonly PrivateKind[]; regions: readonly string[]; names: NameMatcher }): SaidHit[]`; `function saidBleeps(hits: readonly SaidHit[], existing: readonly Bleep[] \| undefined, random: () => number): { bleeps: Bleep[]; unplaced: number }` (groups in the word, at most `MAX_BLEEPS` in all, §4.4) |
| `detect/tables.ts` (new) | the label lists (en, bn, es, hi), issuer prefixes, IBAN lengths, gitleaks-derived patterns, allow lists, region names per language code |
| `src/shared/privacy/vendor/libphonenumber/**`, `vendor/double-metaphone.js` (generated) | vendored, each file with a GENERATED header naming the package, version and SHA-256 |
| `scripts/vendor-privacy.mjs` (new) | downloads the pinned tarballs, checks SHA-512 integrity and SHA-256, copies the files of §6.14, drops `//# sourceMappingURL` lines; `--check` compares |
| `scripts/privacy/regexCheck.mjs` (new) | refuses a pattern with nested unbounded quantifiers or a quantified alternation whose branches can match the same text; run by test 224 over every pattern of `detect/tables.ts` |
| `resources/notices/38-libphonenumber-js.txt`, `39-double-metaphone.txt`, `40-gitleaks-rules.txt` (new) | MIT and Apache-2.0 texts, AUTHORS, versions and hashes |
| `scripts/i18n/allow.json` | the rule tables' word lists as data, each with its reason (P3 only) |
| Tests | 101-135 and 223-228 |

### 16.4 Part P4 · The scan

| File | Exports or change |
|---|---|
| `src/shared/privacy/look.ts` (new) | `function lookScale(width: number, height: number): number`; `function lookStep(fps: number): number`; `interface LookData { k: number; step: number; fps: number; size: Size; frames: LookFrame[]; keys: number[] }`; `function addLookFrames(data: LookData, frames: readonly LookFrame[]): void`; `function changedTiles(frame: LookFrame, data: LookData): Uint8Array`; `function changedIn(data: LookData, box: Box, from: number, to: number): number[]` (frame indices); `function keyBefore(data: LookData, t: number): number`; `function regionsAt(data: LookData, index: number): Box[]` |
| `src/shared/privacy/plan.ts` (new) | `interface ReadHints { typing: { t: number; end: number }[]; clicks: { t: number; x: number; y: number }[]; pastes: number[]; textCursor: { t: number; end: number }[]; valid: boolean; scale: number }`; `function hintsOf(cursor: CursorTrack \| null): ReadHints`; `const BUCKETS: readonly { w: number; h: number; units: number }[]` (640×352 0.1, 960×544 0.2, 1920×1088 1); `interface PlannedRead { t: number; areas: Box[]; packed: { bucket: number; areas: Box[] }[]; why: 'first' \| 'settle' \| 'inPlace' \| 'reveal' \| 'typing' \| 'periodic' \| 'check' \| 'partial'; units: number; thin: boolean }`; `interface ReadPlan { reads: PlannedRead[]; units: number; thinned: number; thinSpans: string }`; `function planReads(look: LookData, hints: ReadHints, size: Size, fps: number, budget: number, end?: number): ReadPlan`; `function packAreas(areas: readonly Box[]): { bucket: number; areas: Box[] }[]`; `function readBudget(duration: number, size: Size): number`; `function firstEstimate(duration: number, fps: number, size: Size, decodeMs: number \| null): number`; `function secondEstimate(plan: ReadPlan, look: LookData, measured: { readSeconds: number \| null }): number` |
| `src/shared/privacy/paths.ts` (new) | `interface Track { placements: Placement[]; start: number; end: number; lost: boolean; thin: boolean; lostSpans: string }`; `interface Matcher { track(track: number, t: number, parts: readonly Box[]): Promise<void>; match(t: number, tracks: readonly { track: number; parts: readonly number[]; candidates: readonly Candidate[] }[]): Promise<TrackMatch[]>; checkRead(t: number, area: Box): Promise<ReadResult \| null> }` (maps one to one onto `FollowSession` and a check read); `function walkSpan(starts: readonly Placed[], dir: 1 \| -1, look: LookData, reads: ReadIndex, m: Matcher, hints: ReadHints, size: Size): Promise<Track[]>` (every hit of a span together, frame by frame; evidence of absence both ways, check reads, the typing rule, §5.8); `function lostBox(box: Box, candidates: readonly Candidate[], changed: readonly Box[]): Box` (the 2-D union of the box, every candidate's box and every changed region it overlaps); `function holdsText(own: string, line: string): boolean` (the generous rule of §5.8); `function joinTracks(back: Track, fwd: Track): Track` |
| `src/shared/privacy/notices.ts` (new) | `function findNotices(look: LookData, project: Pick<Project, 'capture' \| 'source'>): { start: number; end: number; box: Box; stacked: boolean }[]` (nothing for an imported video) |
| `src/shared/privacy/found.ts` (new) | `function foundCovers(result: Extract<FindResult, { ok: true }>, size: Size, random: () => number): Cover[]` (groups, tiers, colours, the width rounding of §6.1); `function withFoundCovers(project: Project, result: Extract<FindResult, { ok: true }>, said: readonly Bleep[], record: FindRecord, random: () => number): { project: Project; suppressed: number }` (§5.10: containment through the time and grid index, missed, rejected paths, groups, merging, limits); `function limitCovers(covers: readonly Cover[]): Cover[]`; `function originCoversFor(original: Project, copy: Project): OriginCovers` |
| `src/main/privacy/scan.ts` (new) | `interface ScanDeps { helper?: () => Promise<OcrHelper>; projectDir?: (id: string) => string; readProject?: (id: string) => Promise<Project>; ffmpeg?: () => string; now?: () => number; recording?: () => boolean }`; `function runFind(request: FindRequest, onProgress: (p: FindProgress) => void, signal: AbortSignal, deps?: ScanDeps): Promise<FindResult>` (phases, at most 3 reads in flight, careful, partial and check reads, restart from the next read, pause while recording); `function followCover(request: FollowRequest, signal: AbortSignal, deps?: ScanDeps): Promise<FollowResult>`; `function underCover(request: UnderCoverRequest, signal: AbortSignal, deps?: ScanDeps): Promise<UnderCoverResult>`; `function coverEverywhere(request: EverywhereRequest, onProgress: (p: FindProgress) => void, signal: AbortSignal, deps?: ScanDeps): Promise<EverywhereResult>`; `function forgetReads(): void` (the kept folded texts, D22; also on its 10-minute timer); `function setReaderStart(start: ((models: boolean) => Promise<ScanHelper>) \| null): void` (how the scan reaches P2's helper, registered by `findIpc.ts`) |
| `src/main/privacy/rulesWorker.ts`, `rulesHost.ts` (new) | the worker running `detectFrame` and `classQr`; `class RulesHost { detect(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions): Promise<Hit[] \| 'timeout'>; close(): void }` (2 s a read, a new worker after a timeout) |
| `src/main/privacy/copies.ts` (new) | `function listCopies(projectId: string): Promise<CopyInfo[]>`; `function coverCopies(projectId: string, copyIds: readonly string[]): Promise<{ covered: number; skipped: string[] }>`; `function originCovers(projectId: string): Promise<OriginCovers>` |
| `src/main/privacy/findIpc.ts` (stub from the contracts) | `function registerFindIpc(): void` (one Find in Flown; `privacy:find`, `stopFind`, `follow`, `underCover`, `everywhere`, `copies`, `coverCopies`, `originCovers`; the progress events; the sender check and the validators first; `stopAnalyses` and `render-process-gone` stop it and call `forgetReads`; Find's job ends with `notice` = `main.jobs.privacyDone`) |
| `src/main/privacy/lookCache.ts` (new) | `function readLookCache(projectDir: string, key: LookKey): Promise<LookData \| null>`; `function writeLookCache(projectDir: string, key: LookKey, data: LookData): Promise<void>` |
| `src/main/analysisIpc.ts` | `stopAnalyses` (`:210`) also stops Find and calls `forgetReads` |
| Tests | 136-160 and 229-240 |

### 16.5 Part P5 · Panel, Review, export notes, Polish and Settings

| File | Exports or change |
|---|---|
| `src/shared/review/privacyReview.ts` (stub from the contracts) | `function privacyReviewItems(project: Project): ReviewItem[]` (one row per group, its places as `parts`, titles with kind, times, place and area); `function privacyPendingCount(project: Project): number`; `function privacyStatus(project: Project, item: ReviewItem): ReviewStatus`; `function privacyKeep(project: Project, items: readonly ReviewItem[]): Project`; `function privacyRemove(project: Project, items: readonly ReviewItem[]): Project` (rejected paths); `function privacyOrder(items: readonly ReviewItem[], project: Project): ReviewItem[]` (Check rows first, for `ReviewPanel`); `function privacyKinds(project: Project): PrivateKind[]`; `function doneReviewing(project: Project): Project` |
| `src/renderer/src/privacy/privacyRun.ts` (new; `gatherPrivacy` stub from the contracts) | `function startFind(services: EditorServices, choices: FindChoices): Promise<'done' \| 'stopped' \| 'busy' \| 'failed'>` (saves, calls main, runs `detectSaid`, applies through `afterGestures` only when the project and request ids match); `function stopAndApply(services: EditorServices): Promise<void>` (*Stop*, *Stop Find and export*, leaving); `function gatherPrivacy(project: Project, captions: Transcript \| null, signal: AbortSignal): Promise<PrivacyGathered \| null>` (listens only when the screen pass is already valid, §14.5) |
| `src/renderer/src/privacy/readerState.ts` (stubs from the contracts) | `useReaderState`, `useFindProgress`, `FindProgressLine`, `confirmLeaveFind` (§16.0) filled: one shared reader state for every user (finding 29), the progress line of §2.6, the leave question of §2.6 |
| `src/renderer/src/privacy/FindLine.tsx`, `findRuns.ts`, `reviewRequest.ts` (new), `src/shared/privacy/findState.ts`, `sha256.ts`, `regions.ts` (new) | `FindLine` and `FindResultLine` (the progress and result lines of §2.6, each with `place: 'section' \| 'review' \| 'dialog'`, shown only where no line of the project's is in front, `lineShows`), `outcomeSentences`; the one run of this window and each project's last outcome (`beginRun`, `endRun`, `runFor`, `outcomeFor`); opening Review filtered to *Private*; the dialog's choices, a run's record and result line, the captions' signature (§7.7); the phone regions always on and the ones that can be added (§2.5) |
| `src/renderer/src/privacy/FindDialog.tsx`, `RegionsDialog.tsx` (new; `FindDialog` stub from the contracts) | `function FindDialog(props: { services: EditorServices; onClose: () => void; mode: 'find' \| 'again' }): JSX.Element`; `function RegionsDialog(props: { regions: readonly string[]; onDone: (regions: string[]) => void; onCancel: () => void }): JSX.Element` |
| `src/renderer/src/privacy/PrivacyExportNote.tsx`, `TranscribeNote.tsx`, `TranslatedNote.tsx`, `NotCheckedNote.tsx`, `PublishMaskedNote.tsx`, `CopiesOffer.tsx`, `PrivacySettings.tsx` (stubs from the contracts) | `function PrivacyExportNote(props: { project: Project; onReview: () => void; onFind: () => void; onWait: (waiting: boolean) => void; onStopAndExport: () => void }): JSX.Element \| null`; `function TranscribeNote(props: { project: Project; place: 'service' \| 'local' }): JSX.Element \| null`; `function TranslatedNote(props: { project: Project; language: string }): JSX.Element \| null`; `function NotCheckedNote(props: { project: Project; place: 'send' \| 'save' }): JSX.Element \| null`; `function PublishMaskedNote(props: { project: Project; text: string }): JSX.Element \| null`; `function CopiesOffer(props: { services: EditorServices }): JSX.Element \| null`; `function PrivacySettings(props: { reveal: boolean }): JSX.Element \| null` |
| `src/renderer/src/review/ReviewPanel.tsx` | the header (kind filter, *Keep all … covered*, *Uncover all …* with its confirm, *Done reviewing*, *Find again…*, *Peek while reviewing*, the progress line, the unfinished line, the copies offer), the private order (`privacyOrder`), the rows' *Keep covered*, *Uncover*, *Select on the timeline*, *Peek* and *Listen*, V through `keys.ts`'s `peek` action, the focus rules of §11 |
| `src/renderer/src/editor/PolishDialog.tsx`, `src/shared/editor/polishCopy.ts` | the row (shown with the reader), its hint with the estimate or *already checked*, its skip reason and result lines (§2.10) |
| `src/renderer/src/privacy/privacyPanel.css` (new) | the dialog, the notes and the rows |
| Tests | 161-185 and 241-258 |

P5 empties `WAITING_P5` (`commands.ts`, its one line only).

### 16.6 Ownership of shared files, and merge order

**Completed by the contracts and edited by no part afterwards**: `types.ts`, `api/privacy.ts`,
`api/projects.ts`, `api/prefs.ts`, `jobs/longJobs.ts`, `kinds.ts`, `coverPath.ts`, `coverData.ts`,
`covers.ts`, `readerCatalog.ts`, `protocol.ts`, `spoken.ts`, `aiRequest.ts`, `aiTextFor.ts`,
`coverLayer.ts`, `compositor.ts`, `engine/project.ts`, `engine/crop.ts`, `projectFile.ts` and its
four callers, `cleanup.ts`, `captionTracks.ts`, `studioData.ts`, `search/extract.ts`,
`captionReview.ts`, `transcriptText.ts`, `guide/shots.ts`, `timelineIpc.ts`, `timelineRun.ts`,
`exportBundleRun.ts`, `ExportBundleOptions.tsx`, `Home.tsx`, `projects.ts`, `review/copy.ts`,
`review.ts`, `review/keys.ts`, `versions.ts`, `polish.ts`, `polishRunner.ts`, `clipCopy.ts`,
`ShapesPanel.tsx`, `Timeline.tsx`, `ExportDialog.tsx`, `SettingsDialog.tsx`, `ShotViewer.tsx`,
`PublishDialog.tsx`, `Filmstrip.tsx`, `ColourControls.tsx`, the captions panels' mounts,
`Editor.tsx` (mounts, the scene's `privateView`, every runner case, the leave hook, the `flush`
prop), `src/main/index.ts`, `prefsIpc.ts`, `appLog.ts`, `diagnostics.ts`, `preload/*`, the
catalogues' existing namespaces, `guard-delta.mjs`, `make-track-fixtures.mjs`.

**Edited by one part below the contracts' lines**:

| Part | Existing files it edits |
|---|---|
| P1 | `player.ts`, `joinStills.ts`, `previewAudio.ts`, `guideRun.ts`, `PreviewStage.tsx` (handles, group outlines, the inset), the files of §14.4, `commands.ts` (`WAITING_P1`'s line only) |
| P2 | `scripts/build-native.mjs`, `scripts/lib/packaging.cjs`, `scripts/verify-dist.mjs`, `scripts/notices.mjs`, `build/installer.nsh`, `electron-builder.config.cjs` (only if `speechResources` cannot carry the helper), `vitest.native.config.ts`, `.gitignore` (`native/ocr/target/`) |
| P3 | `scripts/i18n/allow.json` |
| P4 | `src/main/analysisIpc.ts` (`stopAnalyses`) |
| P5 | `ReviewPanel.tsx`, `PolishDialog.tsx`, `polishCopy.ts`, `commands.ts` (`WAITING_P5`'s line only) |

**Who writes the code behind each seam**:

| Seam | Code behind it |
|---|---|
| `coverLayer.ts` → `gradedCoverColour`, `drawCoverPeek`, `drawCoverMarks` | P1 `coverGrade.ts` |
| `ShapesPanel.tsx`, `Timeline.tsx`, `PreviewStage.tsx` mounts; `fillCoverTiles` and `fillCoverPixels`; `coverGroup.ts`; the runner's cover commands | P1 |
| `registerReaderIpc`; the reader's state in main | P2 `readerIpc.ts`, `readerModels.ts` |
| `detectFrame`, `detectSaid`, `saidBleeps`, `classQr`, `needsCareful`, `looksLikeName` | P3 |
| `registerFindIpc`; `withFoundCovers`; the copies channels | P4 |
| `privacyReview.ts`; `gatherPrivacy`; `readerState.ts`'s hooks and `confirmLeaveFind`; `FindDialog`, the notes, `CopiesOffer`, `PrivacySettings`; the runner's `findPrivate` | P5 |

**Merge order**: P1, P3, P2, P4, P5. P3 before P2 because P2's tests use P3's `needsCareful` on fixture
reads; P4 needs both; P5 mounts on everything. After each merge the lead runs both typechecks, all
of vitest, `npm run i18n:check`, `npm run -s build`, the English guard in compare mode (after a
warm-up launch) with `guard-delta.mjs`, and the e2e files the part touches.

**Integration** (after P5): A1-A21 under `xvfb-run` (§17.3) with the host helper (`build-native
--ocr-host`) and the downloaded models in a fixed `userData`; then `guard-delta.mjs` on the merged
tree and the baseline re-recorded in a commit naming this feature (§12.2); then `npm run notices --
--check` and `verify-dist`. If the owner answered question 17 (a), the three messages change in a
commit of their own before the baseline is re-recorded.

**For a person, before release**: the Hugging Face mirror (`READER_MIRROR`); the Windows-only checks
(R8 and R10, Windows OCR, speed and memory at 1080p, 4K and 7680×2160 on the reference PC, the WER
value and the run-time flags, the 30 real recordings with their units distribution, pop-up false
hits); the native Bangla review (§12.4); the other account's optional `private.json` (§18).

---

## 17. Test plan

### 17.1 Unit tests (vitest). Each is its own test and fails without the code of its rule.

By owner: contracts 1-40 and 186-197 (test 20 is the guard, §17.2), P1 41-75 and 201-215, P2
76-100, 216-222 and Rust R1-R32, P3 101-135 and 223-228, P4 136-160 and 229-240, P5 161-185 and
241-258. The numbers added by this revision follow each part's first block, so every earlier number
keeps its meaning. Test files are named `tests/autoBlur<Area>.test.ts`; each numbered test
is one `it` whose title starts with its number, and `tests/autoBlurNumbers.test.ts` checks that every
number of this list exists exactly once.

**Contracts**

1. **Migration**: every old fixture (`tests/fixtures/vertical-old-projects.json`,
   `wave8-old-projects.json`, `captions-old-projects.json`, and wave 10 to 12's) migrates to the same keys
   and bytes; no `covers` or `privacy` key appears; `~cover:` shapes are dropped on load; reading a
   migrated project again changes nothing.
2. **`readCovers` on hostile input**: non-objects, missing or repeated ids, `start >= end`, NaN, paths
   with exponents, non-increasing times or 4,001 keys, boxes past the frame, colours that are not
   `#rrggbb`: limits held, nothing thrown, unknown fields dropped; a cover with 4,001 keys becomes one
   key holding their union; 2,001 covers become 2,000 and every input box at every input key is inside
   some output cover's drawn box (finding 20); 2,000 covers of 150 keys each are cut to at most
   200,000 keys by `simplifyKeys`, with every input box inside an output drawn box and no cover cut to
   one key while a longer one keeps more (test 188 holds the rule itself).
3. **`readCovers` is linear** (finding 17): 2,000 covers with 100 keys each read in under 150 ms (×6
   on CI), and doubling the input at most 2.2 times the time.
4. **Paths**: `writePath` rounds outward (for 10,000 random boxes the parsed box contains the input);
   `parsePath` refuses exponents, `NaN`, `Infinity`, decreasing times and empty keys; `boxAt` holds a box
   until the next key; `drawnBox` at a key's time with slack is the union of both boxes;
   `coverSlack(60)` is 0.009333….
5. **`readPrivacy` and `readPrivacyPrefs`**: 6 regions keep 5; lower-case or three-letter regions are
   dropped; 201 names keep 200; an 81-character name is dropped; names are NFC and one line;
   `__proto__` and `constructor` keys are ignored; 5,001 rejected places keep 5,000.
6. **Private bleeps**: `privateBleepWord('card')` is `':card'`; `isPrivateBleep` is true for it and
   false for every bleep in the fixtures; `bleepKey` of 10,000 caption words in en, bn, es and hi never
   starts with `:`; `readBleeps` keeps `':card'` through a read and write.
7. **Legacy shapes**: no covers gives the same object; a 3-key path gives pieces of a pixelate
   (strength 1) then a filled opaque rectangle of the cover's colour, each read by `readShape`; pieces
   overlap by the slack; more than 4 pieces merge into 4; 2,500 covers give at most 4,000 shapes, the
   largest covers merged first; `migrateProject` drops them all.
8. **Every writer**: `saveProjectNow`, `writeProject`, `makeCopy` and `saveVersion`'s body each write
   a file whose `shapes` end with the legacy shapes, and `renameVersion` keeps them (one test per
   writer, in a temporary `userData`); a project without covers is written as
   `JSON.stringify(project, null, 2)`, and a version body as `JSON.stringify(project)`, byte for
   byte.
9. **Hash and summary**: `hashProject` and `versionSummary` of a project equal those of the same project
   after a write and a read through `projectFileText` and `migrateProject`.
10. **Crop**: `cropProject` maps every key's box through `rectToCrop`; the same covers array gives the
    same mapped array (memoised); without a crop the covers are returned unchanged; a cover wholly
    outside the crop is left out of the view only; `project.covers` itself is never changed.
11. **Cover index**: `coversAt` equals a brute-force scan for 2,000 random covers at 10,000 times with
    slack, in under 0.02 ms a call.
12. **`containsOver`**: a path inside an existing cover at every key is contained; one that leaves it at
    one key is not; overlap alone is not.
13. **`mergeCovers`** (finding 7): 20,000 found items to 2,000 in under 300 ms, and twice the items take
    at most 2.3 times as long; every input box at every input key is inside an output cover's drawn
    box.
14. **`thumbCovers` and `hidesSomething`**: the boxes of covers and of blur and pixelate shapes active
    anywhere in the window; a project with only a bleep hides something and has no thumbnail boxes;
    `listProjects` adds `thumbCovers` only when there are boxes, so other summaries are unchanged.
15. **`coverScreen`, through the view** (D19): the scene is built with `cropView` as `Editor.tsx`
    builds it. With no cover active it returns its input (the same object) and makes no canvas. For a
    cropped project, and for a cropped, graded project with a LUT, the filled pixels are exactly the
    cover's view box mapped to the picture and rounded outward, never mapped through the crop a second
    time (a cover over text 10 px inside the crop's edge is checked). With no crop and no grade it
    copies into a per-target canvas and never draws into the video element or an `ImageBitmap` (spies
    on both).
16. **Everything samples the covered picture**: in the recording fake context's call log
    (`verticalEquivalence.test.ts`'s), a blur shape beside a cover, a magnifier lens over it, every
    motion-blur sub-frame, a title card's blurred background and a join still all draw after the
    cover's fill into the picture they read; `drawCoverOutput` fills once per sub-frame camera;
    nothing is drawn in the `'overlays'` alpha mode.
17. **Peek and the cover outlines never reach an output**: `exportVideo`, `ExportPreview`,
    `renderThumbnail`, `renderGuideStills` and `composeJoinStill` given a scene with `peek` and
    `coverMarks` draw the fills and no outline (`forOutput`); `JoinStills.fresh` is false when either
    changes, and its fallback never returns a still of another state.
18. **Captions**: `maskedSegments` masks the words under a private bleep with `•`, by time; a caption
    whose words and times do not line up is masked from the first to the last word touching the
    bleep; one with no word times is masked whole; ordinary bleeps give exactly today's output.
19. **Translations**: a track segment over a private bleep reads `••••…` unless its `maskedFor`
    matches; `readCaptionTracks` keeps `maskedFor`; `burnedSegments`, `trackCues` and the SRT and VTT
    sidecars are masked.
20. **The equivalence guard** (§17.2).
21. **Spoken forms**: a card said "4917 6123 4567 eight nine zero four" gives the digit string and its
    groupings; `maskPrivate` masks "4917-6123-4567-8904" and "4917 6123 4567 8904" in a chapter title; a
    form of 3 characters masks only a whole word; without private bleeps it returns its input.
22. **`privateView` at every output** (finding 12): with a private bleep, the chapter bar and a
    chapter title card drawn in the preview scene and in an export, the file's chapter metadata
    (`chaptersOf`), the chapters and description sidecars, the pack's copy, the guide's outputs and
    the timeline's markers hold no form; the stored `chapters`, `titles`, `publish` and `guide` are
    unchanged.
23. **`maskRequest`**: every string is walked (a form inside an unknown nested field is masked);
    segments are masked by time; without private bleeps it returns the same object; for each request
    shape (cleanup, translate, chapters, marks, names, title, summary, youtube, posts) a fixture with a
    spoken secret holds no form after masking.
24. **Other texts**: the search index, Review's caption titles and the transcript text hold no form;
    private bleeps are not listed as *Bleep* rows.
25. **The timeline refusal**: `writeTimeline` in recordings mode reads a `project.json` with a cover, a
    blur shape or a bleep (and a crop or a muted part as question 18 decides) and refuses with
    `errors.timeline.hidden`, writing nothing, whatever the request says; a saved preset and bundle
    choice of `'recordings'` normalise unchanged; `writeTimelineStep` skips the step and reports it;
    the chip is disabled with its description; the export dialog's `flush` runs before
    `writeTimeline` is called (call order recorded).
26. **Guide shots**: `shotSig` and `planActual` change when a cover active at `t` changes its box or
    colour, and not when a cover elsewhere in time changes; `guideProject` keeps `covers`.
27. **Review wiring**: `REVIEW_KINDS` has `'private'` before `'chapter'` and `slice(-2)` is unchanged;
    `KIND_WORDS.private` has its four keys; `clipCopy.withinRange` settles private rows wholly outside
    the clip by Keep and every cover stays (a clip copy whose clip is widened again still covers the
    footage that comes back); `captionReview` skips private bleeps; `keys.ts` gives `peek` for V only
    on a private row and `null` elsewhere.
28. **Versions**: `changedAreas` gives "covers" for a changed `covers` or `privacy`;
    `CHANGED_AREA_NAMES` holds it; every old fixture pair gives what it gave before.
29. **Polish seam**: `POLISH_STEPS` ends with `'privacy'` and the adjacency tests hold;
    `DEFAULT_POLISH_OPTIONS.privacy` is true; `readPolishOptions({})` reads it as false; `planPolish`
    with `privacy: null` equals today's plan; with a gathered result it adds the covers and bleeps in
    its one update.
30. **Commands**: the five commands are in `COMMAND_LIST`, left out of `PALETTE_COMMANDS` and
    `listedCommands` by `WAITING_COMMANDS` (`WAITING_P1` and `WAITING_P5` on lines of their own), have
    no default key, and each has its runner case in `Editor.tsx`.
31. **One AI chokepoint**: no file under `src/renderer` but `aiTextFor.ts` contains
    `window.api.aiText(`; each of the 9 call sites calls `aiTextFor`.
32. **Validators and senders**: `validateFindRequest` refuses paths, unknown kinds, 401 names, an
    81-character name, regions that are not two capital letters and project ids not of the project
    folder's form; `validateFollowRequest`, `validateUnderCoverRequest`, `validateEverywhereRequest` and
    `validateCopiesRequest` refuse non-finite or out-of-frame boxes, times outside the recording, a
    path over §4.2's limits and an unknown `remember`; each accepts a valid request unchanged. Every
    `privacy:*` handler refuses a sender frame that is not Flown's page (`isAppUrl`) before
    validating, the download channel included.
33. **`parseHelperEvent`**: strict; unknown keys, wrong types and lines over 16 MB give `null`;
    `commandLine` and parsing round-trip every command.
34. **Preferences**: `prefsIpc.ts` sanitises `privacy` with `readPrivacyPrefs`; an older
    `editor-prefs.json` without it is written back byte for byte.
35. **Names in logs** (finding 24): with "Priya Raman" listed, a log line holding it is written with
    `<secret>`; `*Acme` redacts "Acme"; a two-letter entry is not used; diagnostics hold no name.
36. **Multi-select seam**: `GROUP_KINDS` ends with `'cover'` and `LookClass` has `'cover'` (the pinned
    tests extended); `KIND_WORDS.cover` and `LOOK_CLASS_WORDS.cover` read their messages; while
    `coverGroup.ts` is the stub, `validSelection` drops covers and every other kind behaves as before.
37. **Stubs render nothing**: every mounted stub returns `null`, every seam stub returns its input,
    `useReaderState` and `useFindProgress` return `null`, and `confirmLeaveFind` resolves `true`.
38. **Catalogues**: every key of §2 and §12.1 is in its catalogue with a meta entry; no message holds
    `#`; the kind sentences select on every kind id; no English message of `37f9355` changed (compared
    with the catalogues at that commit); every new file is in `failFor`.
39. **`guard-delta.mjs`**: on synthetic baseline and run pairs it passes an added element and a box
    pushed by it, and fails a changed text, a changed accessible name, a removed element, a restyled
    element and a box moved with no added element; with a settings section inserted, it aligns the
    later `settings-NN` captures by heading and reports one added capture; a capture with no added
    element and one screenshot pixel off by 3 levels in 1% of pixels fails.
40. **Pins**: `READER_FILES` equals the shipping entries of `scripts/privacy/reader-models.json` (bytes,
    SHA-256, repository, commit) and the files sum to 27,608,757 bytes.
186. **Union keys at step 2**: a 60 fps path from placements on analysed frames moving 30 px a frame
     pair (a 1,800 px/s scroll) through `stepKeys`: at every source frame, analysed or not, the
     planted box of that frame lies inside `drawnBox` with `coverSlack(60)`; without the union keys
     the odd frames fail (the test checks that too).
187. **Union keys at step 4, starts and ends**: the same at 120 fps (step 4); a cover whose text
     appears on an unanalysed frame covers it from that source frame; one whose text leaves on an
     unanalysed frame covers it to that frame.
188. **`simplifyKeys`**: 2,000 covers of 150 keys fit 200,000 keys; the longest paths are merged first;
     every input box at every input time is inside an output drawn box.
189. **Short covers are widened, never dropped**: a 16.7 ms cover and one clamped to 0.01 s at the
     recording's end read as at least 0.02 s, inside the recording, and survive a write and a read.
190. **`privateItems`**: a group of found covers, a user cover and a group of private bleeps are three
     items; ordinary bleeps are none; blur and pixelate shapes count as `weak` only; the numbers the
     section, Review's count and the export note show are equal for the same project.
191. **`privateView`**: masks the forms in every field of `PRIVATE_TEXT_FIELDS`; returns the project
     itself without private bleeps or without a form; the same object for the same project (memoised);
     removing the private bleep gives the stored texts back unchanged.
192. **Spoken forms from the own words**: a card said "four nine one seven …" gives its digit string
     and groupings and no number word; "weight", "fourteen" and "Four ways to save" stay unmasked; a
     padded neighbour ("is") is not a form; a multi-word hit masks only as the whole phrase.
193. **Home thumbnails**: `thumbTime` is the one time both sides use; `thumbCovers(project, t − 0.1,
     t + 0.1)` holds a cover active only 0.05 s before `t`.
194. **`readBleeps` keeps private bleeps first** when it cuts at 2,000; a project with no private bleep
     is cut exactly as at `37f9355`.
195. **Private bleep words**: `privateBleepWord`, `privateKindOf` and `privateGroupOf` round-trip
     through `readBleeps`' lower-casing; a word of `':' + kind` alone reads with no group; no caption
     word's `bleepKey` parses as one.
196. **Tracking fixtures**: `make-track-fixtures.mjs` renders a 2 s list scroll; its truth file has a box
     for every planted item in every one of the 120 frames, and each box holds that item's ink in the
     decoded frame (no ink outside the box within its line).
197. **Job notices**: a done outcome with `notice` gives that notification for an `analysis` job when
     the window is not focused; every old kind and outcome gives what it gave at `37f9355`.

**P1 · Covers in the editor**

41. `addCover`: 3 s at the playhead, 30% × 10% centred on the cursor and clipped; *To the end*; *For the
    whole video*; centred on the frame when the cursor is invalid; one undo step; the new cover is
    selected.
42. `coverFromShape`: a blur shape becomes a cover over its box and times, the shape removed, one step.
43. `editCoverBox`: a move with `wholePath` false changes the box from `t` to the next key, with
    `wholePath` true every key; an edge change moves that edge at every key whatever `wholePath` says
    (widening a followed cover's right edge holds at every playhead); both drop `found`.
44. `setCoverEnds` holds the first and last boxes; `moveCoverTime` is null for a cover with two or more
    keys and moves a one-key cover.
45. `coverWholeVideo` covers 0 to the recording's end with the path's ends held.
46. `deleteCovers` writes a rejected place (kind, times, the removed cover's own path, simplified to 400
    keys at most) for each suggestion and none for a user's cover.
47. `keepCovers` drops `found`, `missed` and `thin`.
48. `nudgeCovers` moves whole paths by pixels in normalised units, clamped to the frame.
49. Copy and paste (finding 18): a paste holds the cover as it was when copied, even after the source is
    edited; pasting into another project gives null and `privacy.cover.oneProject`; no OS clipboard
    API is called.
50. `duplicateCover` gives a new id and the same path.
51. `withFollowedPath` never covers less than the old path where the walk was lost or outside the time
    it walked.
52. Every exported edit function of `coverEdit.ts` and `coverGroup.ts` drops `found` from what it
    changes (one property test over all of them).
53. `ringColour` gives the median and spread of synthetic rings; a spread over 24 gives Dark through
    `coverColourOf`; the preference's chips replace the ring.
54. `gradedCoverColour` equals the CPU grade of one pixel for five grades, with and without a LUT; with
    Compare on it is the raw colour.
55. `drawCoverPeek`: peeked covers are outlined and not filled; others are filled.
56. The peek store clears on project close, before an export starts, before guide shots, and after
    60 s without input; `peekedScene` adds `peek` only to the preview's scene.
57. `listenedGains` leaves out only the listened bleep; the export's gains are unchanged.
58. `joinStills` never returns a still composed with another peek state (its `:119` fallback).
59. `ringColourAt` seeks a hidden video to `t` and samples there; the guide's *Blur an area…* passes the
    step's shot time, not the playhead (finding F).
60. The guide's buttons add covers over the old box and times in one update; their labels are unchanged;
    the hint shows.
61. `runFollow` lands through `afterGestures` while a drag is open, and both the drag's and the follow's
    results are kept (finding 16); *Stop* changes nothing and keeps focus on *Follow what is under
    it*; when it ends, focus moves to the cover's status line (finding 37).
62. `runEverywhere` adds `text` covers in one step; with `remember: 'project'` and a name-like text it
    adds the returned name to `privacy.names` in the same step, with `'settings'` to Settings' names,
    and the open dialogs show the new list (finding 28); with a text that is not name-like nothing is
    added.
63. `PrivacySection`: its buttons, the remembered length, the private-item count and the to-check
    line, *Show where covers are*, the weak line and *Turn them all into covers*, the reader line, and
    the disclosure with `aria-expanded` listing every `privacy.notSee.*` message, `folder` included.
64. `CoverSection`: the box fields in percent; the colour chips; *Change the whole path*; *Start here*
    and *End here*; *Follow*, *Everywhere*, *Keep it for the whole video*, *Keep covered* and
    *Uncover*; the lines for found, what it hides, check, lost, missed and thin.
65. `WeakBlurNote`: the note and *Turn into a cover*; `text.calloutSection.privacyNote` unchanged.
66. `CoverTrack` draws only with covers: bars, dashed waiting edges, the warning edge for Check, hatched
    lost areas, one bar with a count for a group's overlapping covers; clicking it selects the group,
    Ctrl+click toggles one cover; each bar's accessible name.
67. `CoverTrack` keys: roving focus, Left, Right, Home, End, Enter, Delete and Shift+arrows; selection
    follows focus (finding 36); dragging a followed cover in time is refused with the status line.
68. `CoverHandles`: a drag moves the box at the playhead in one undo step.
69. `PeekBanner` shows while anything is peeked; *Stop peeking* clears it.
70. Multi-select: Ctrl+click several covers; group delete is one step with rejected places; group colour;
    *Copy look* and *Paste look*.
71. Group time moves move one-key covers and leave followed ones with the status line; arrow keys on the
    preview move whole paths.
72. The group clipboard pastes covers only into their own project, as snapshots.
73. `fillCoverTiles` fills each tile's active cover boxes in Dark; with no covers it makes no draw call.
74. *Add a cover*, *Peek under covers*, *Start the selected cover here* and *End the selected cover
    here* run from the palette and `WAITING_P1` is empty.
75. The pinned list tests hold with `'cover'`: `multiSelectContracts.test.ts:42`,
    `graphicsSelection.test.ts:89` (`at(-2) === 'graphic'`), `multiSelect.test.ts:58`,
    `multiSelectCopy.test.ts:18`.
201. **Versions and undo never settle** (finding 19): restoring a version, opening one, and undo and
     redo across a Find leave every cover's `found`, `missed` and `thin` and every private bleep's
     `auto` exactly as they were.
202. A size change on a 40-key followed cover, by an edge handle and by the *Width* field, holds at the
     playhead and at every other key; a move with *Change the whole path* off moves one span only.
203. `coverStartHere` and `coverEndHere` hold the box at the playhead, are one undo step each, and are
     null (the buttons disabled with `privacy.cover.outside`) outside the cover.
204. *Follow* on a *To the end of the video* cover over an email that then scrolls: after the scroll no
     frame has a box at the old place; where the walk was lost, the old box stays.
205. The *Cover* button sits after *Pixelate* in the add-shape row with its tooltip and does what *Add
     cover* does.
206. *Turn into covers* on three selected blur shapes, and *Turn them all into covers*, are one undo
     step each and leave no blur or pixelate shape behind.
207. *Show where covers are* draws dashed outlines on the preview scene only, is on by default, and when
     turned off is remembered in the preferences (`showCovers: false`).
208. `PeekInset` draws the selected cover's area at 2× to 8× the preview's scale, never past the
     recording's own pixels, only while a row is peeked, and is not drawn by any export path.
209. Several covers selected: the title reads `privacy.cover.selected`; colour, *Keep covered*,
     *Uncover*, nudge and *Paste look* act on all in one step; the box fields, *Follow* and
     *Everywhere* are disabled with their reasons as descriptions.
210. `fillCoverPixels` fills the active covers into the look chips' 96×54 pixels before grading; with no
     cover it touches nothing.
211. `fillCoverTiles` fills, for a tile at `t`, every cover active anywhere in `[t − 15 / fps − 0.02,
     t]`, so a cover that ended 10 frames before `t` is filled on a tile showing the key frame before
     it.
212. `EverywhereDialog`'s states: reading, `needsReader` with *Download*, `noText`, the remember choice
     only when `nameLike`, progress with *Stop*, `done` and `failed`.
213. *Keep covered* in the Cover section moves focus to the section's title (finding 37's *Keep*).
214. The Covers row's thin-span marks are items of its roving focus with their names, and Enter seeks
     to their start.
215. *Uncover* says `privacy.cover.uncovered` in the status line, deletes the cover and writes its path
     to `privacy.rejected` in the same undo step.

**P2 · The reader**

76. `readerUrls` puts the mirror first when set and the upstream at its pinned commit after it; with
    `READER_MIRROR` null only the upstream.
77. `downloadReader` against a local fake Hugging Face: a 302 to `*.hf.co` is followed and one to another
    host refused; a `.part` resumes with Range after its prefix hash; a size or SHA-256 mismatch deletes
    the file and fails; one download at a time; *Cancel* keeps the `.part`.
78. `checkReader`: a changed byte gives `damaged` and deletes the file; intact files give the pins.
79. `ReaderState` moves through its states with events; a failure carries its reason to the dialog and
    Settings (finding 26).
80. `removeReader` deletes the folder and gives `none`.
81. `OcrHelper` with the fake helper: `open` sends the pins; heartbeats arrive during `open` (finding 25);
    20 s of silence kills it; an exit is reported.
82. Malformed helper lines are dropped; a line over 16 MB kills the helper.
83. `read`, `careful` and `release`: main never has more than 3 reads unreleased; a `careful` answers
    as its own event while a fourth read waits, so no read blocks the careful pass that frees it.
84. A read error comes back as `{ id, error }` for that read only (finding 23).
85. The helper's detector constants (`native/ocr/src/read.rs`, read as text) equal the tiny detector's
    pinned `inference.yml` values in `reader-models.json`.
86. `ocrHelperProblems`: a fixture importing `wer.dll` fails the allow-list and one importing the
    WinRT three passes; the budget is measured at brotli 11; `speechResources` carries `ssw-ocr.exe`;
    a build without it says so.
87. `verify-dist` §4d: a release build with `READER_MIRROR` null fails; a binary containing `readImage`
    fails; `OCR_IMPORTS` is checked.
88. Notices: `CRATES` holds `native/ocr/Cargo.toml`, `RUST_TITLE` names `ssw-ocr.exe`,
    `41-paddleocr-models.txt` exists, and `npm run notices -- --check` is up to date.
89. `installer.nsh`: `customInstall` writes the WER value under HKLM for an install for all users and
    under HKCU for one user, and `customUnInstall` deletes it from the same place; the helper's source
    calls `WerSetFlags` with `WER_FAULT_REPORTING_FLAG_NOHEAP` and `SetUnhandledExceptionFilter`.
90. `helperPath`: the packaged path, `native/bin` in development, and `SSW_OCR_HELPER` honoured only
    unpackaged.
91. `readerIpc`: requests validated; one state shared by every window (finding 29).
92. The decode speed is recorded after a Find and used by `firstEstimate`.
93. `pause` and `resume` reach the fake helper when the recording state turns true and false (read as
    `isToolbarVisible()` from `src/main/recording/toolbarWindow.ts`); the progress shows `waiting`.
94. `OcrHelper.start` refuses a helper that answers another protocol number.
95. A model pin mismatch reported by the helper (`error: 'model'`) sets the state to `damaged`.
96. The helper is started with `shell: false`, `windowsHide` and below-normal priority.
97. `careful` re-reads exactly the lines `needsCareful` picked on the committed main-set tiny reads (P3's
    function on `tests/fixtures/privacy-eval/reads/main-tiny.json.gz`).
98. The fake helper's crash on one read makes `runFind` (with P4's stub matcher) mark every read in
    flight failed, restart it once and continue from the next planned read, never the one that
    crashed; a second crash ends Find with `crashed`.
99. The look batches' frame times and key flags parse into `LookData` without loss.
100. `tooLarge` from the helper ends Find with `privacy.run.tooLarge`; `model` with
     `privacy.run.readerDamaged`.
216. **Nothing the helper says is logged**: the fake helper writes a marker string to stderr and a
     malformed line holding it; after a crash and a refused line, `app.log` and the diagnostics
     report hold no marker, and `refusedLines` counts the line.
217. `OcrHelper` numbers every command from one counter; every event is matched to its command by id,
     whatever order the answers come in; `cancel` drops a queued read.
218. A helper death with 3 reads in flight marks those 3 as failed reads (lost areas) and the restarted
     helper is sent the next planned read.
219. The follow session API: `followOpen`, `track`, `match` and `close` round-trip with the fake helper,
     and every track of a frame is answered in one `matched` event.
220. `ReaderState` `ready` carries this PC's decode speed once a Find recorded it; `firstEstimate` uses
     it.
221. With `WINDOWS_READER_ALLOWED` false, main never sends `reader: 'windows'` and no message of §2
     mentions the Windows reader.
222. **Partial reads**: the fake helper answers `partial` for a read; main reads the unread areas as
     extra reads; when those fail too, a lost area is made and `failedReads` counts it.

**Rust (`native/ocr`, `cargo test`, host build with the `fixture` feature and `SSW_OCR_MODELS`)**

- R1. `open` with intact models answers `opened`; the heartbeat runs throughout; every plan (three
  detector buckets, ten recogniser widths) is built at open and none during reads (a build counter).
- R2. `open` with one changed byte in any model answers `error: 'model'` and parses nothing (a parse
  counter stays 0); each file is read once (a read counter) and the parsed buffer is the hashed one.
- R3. `tooLarge` for 7681×4320 and for 41 megapixels, before ffmpeg starts.
- R4. On the 24 evaluation PNGs (`readImage`), careful-long's reads scored with `score_reader.py`'s rules
  give pattern recall and padded coverage within 1 point of §5.6 (ONNX Runtime 100.0 and 100.0).
- R5. Tiles and buckets: a 3840×2160 frame is read as 4 tiles; a line across a tile edge comes back as
  one line; a 300×80 area runs the 640×352 bucket and three small areas share it.
- R6. A 4,333 px wide line is read in chunks and its text equals ONNX Runtime's within the parity
  tolerance of §5.6.
- R7. Spans: every character's span lies inside its line's box; spans are increasing.
- R8. (Windows) killing the helper kills its ffmpeg (job object).
- R9. A read that panics answers `error: 'panic'`, the plans are rebuilt (a build counter), and the
  next read succeeds with the same results as before the panic.
- R10. (Windows, reference PC) the Windows build reads the evaluation PNGs as the host build does;
  then the Windows reader (§5.13) reads them and is scored with `score_reader.py`'s rules: decision
  8's 95% pattern recall and 99% padded coverage, with its speed and memory.
- R11. Look on a synthetic scroll video (made by the test with ffmpeg from one PNG) reports the scroll's
  shift per frame within one pixel, and prints the analysis time a look frame.
- R12. Look on a window dragged diagonally reports both dx and dy.
- R13. Follow places parts on a selected (inverted) copy of the text.
- R14. Follow refuses a match when two places score within 0.15.
- R15. QR: the 6 codes of the set are decoded or reported as found; payloads come back only in the
  `read` answer, never on stderr.
- R16. Reads seek to the key frame before them: decoding a read at 19 minutes in a 20-minute clip
  decodes at most one key frame interval (counted with `showinfo`).
- R17. **Through the planned areas**: the 24 evaluation frames read through the areas `planReads`
  cuts (padded to buckets, packed and tiled) give pattern recall and padded coverage within 0.5 points
  of the same frames read whole (the first build's scan was 1.0 point lower, §5.6).
- R18. **Display scale** (finding 6): the evaluation frames rendered at 150% and 200%
  (`make-eval-set.mjs --scale`, 2880×1620 and 3840×2160) are read; each planted item's ink lies
  inside its line's padded box, and the typing box of `planReads` at that scale holds the field and
  its label.
- R19. **Nothing reaches stderr**: a read forced to panic on a line holding a marker string, and a
  malformed command holding it, leave no marker on stderr (the panic hook prints a code and a
  location only).
- R20. **The helper exits when main is gone**: closing its stdin ends it within 2 s; so does a closed
  stdout when a heartbeat is written.
- R21. **Caps answer `partial`**: a synthetic 3840×2160 frame of 1,500 short lines answers `partial`
  with its unread areas, and reading those areas finds the rest.
- R22. **The follow session decodes each frame once**: 20 tracks walked over 300 frames decode 300
  frames (a decode counter), and match in under 0.1 ms a part a frame (printed).
- R23. **A backward session over one instant** `[t, t]` holds the frame at t: it opens with one frame,
  and a track cut there matches itself.
- R25. **Look reports a narrow column's scroll**: a column 4 tiles wide scrolling beside a still
  page reports its move within a pixel.
- R24. **A backward session answers each frame itself**: a track walked back over 60 frames of a
  scroll, across a piece's edge, matches at every frame where the scroll put it, never at a later
  frame's place.
- R26. **A backward piece decodes only up to its own end**: a backward session over 0.4 s at 10 s of
  a four-minute 1280×720 recording decodes at most its frames and a key-frame interval before them (a
  decode counter) and answers within 3 s, neither decoding nor waiting for the 230 s after it.
- R32. **A backward session keeps one piece and the frames just above what it was asked**: a walk back
  over every frame of 6 s with a key frame every second keeps at most 35 frames at once (a counter);
  keeping two whole pieces held 61.
- R31. **A careful re-read runs beside the next read**: a careful pass of every line of the terminal
  frame and a small read of another frame sent after it: the read is answered first (with one worker
  it waited for every line of the careful pass).
- R27. **A backward session decodes only the pieces holding the frames it is asked**: a track at 50 s
  of a minute-long 1280×720 recording and matches at 20 s keep and decode at most two pieces' frames
  (counters), not the 900 frames between (the walk asks nothing there).
- R28. **A forward session seeks past frames it is not asked**: a track at 0 s and matches at 30 s keep
  at most 10 frames and decode at most 40, not the 900 between.
- R29. **A frame's gradient only when it is asked**: over 2 s of a scroll, matches at every sixth frame
  (each twice) keep every frame between (0.1 s apart, decoded on) and work out one gradient for each
  frame asked and the track's (a counter), never one for every frame kept.
- R30. **Backward pieces are whole key-frame intervals, decoded once each**: a walk back over every
  frame of 6 s of a recording with a key frame every second takes at most 7 ffmpeg runs (half-second
  pieces each sought from the key frame took 13) and decodes each frame once but for the frame that
  ends each run.

**P3 · The text rules**

101. All 178 screen and 25 speech vectors of `rule-vectors.json` pass (placeholders expanded as
     `runVectors.mjs` does).
102. On the committed main-set reads (`reads/main-tiny.json.gz`, and `main-careful-long.json.gz` with
     every variant): 233 of 233 text items found and at least 227 fully covered, at most 1 visible item
     touched.
103. On the committed held-out reads (`reads/holdout-careful-long.json.gz`, every variant): 233 of 233
     text items found and at least 230 fully covered, at most 2 visible items touched (the prototype,
     reading only each line's first read and without §6.10's new rules, gave 229 and 224 on the tiny
     reads).
104. Every pattern runs in under 50 ms on 64 KB adversarial strings; lines are matched in windows of
     512 characters overlapping by 256.
105. `cleanLine`: NFKC, dashes, bullets, zero-width characters, θ and ø as 0 inside tokens, Cyrillic look-
     alikes; every view has the cleaned text's length and maps back.
106. `foldText` folds O/0, I/l/1, rn/m, vv/w, cl/d and drops spaces and `_`.
107. Emails: strict before tolerant; the TLD list; role and reserved addresses at 0.60; `git@host:`,
     `@2x.png` and `@types/node` are not emails.
108. Cards: grouping, Luhn and issuer; merged groups; a reference label gives 0.60; a Luhn failure only
     with a card label; test numbers and masked cards skipped.
109. IBAN: lengths, mod 97, one and two swaps at 0.85, lower case refused, published examples skipped.
110. Phones: `+` numbers valid and possible; labels; the region's written formats; bare mobiles at 0.60
     and never NANP; dates, IPs, times and decimals refused; Bengali digits converted first; the vendored
     library's `isValidPhoneNumber` is what is called.
111. IDs: SSN exclusions, NI prefixes, labelled IDs beside, after and under, every label on a line,
     product and licence keys.
112. Strong prefixes: each of the 36 rules with a positive and a placeholder negative; `…EXAMPLE` and the
     allow list skipped.
113. PEM: a block from BEGIN to END at full width; BEGIN and END widened by five characters; no END gives
     a lost area to the region's bottom.
114. Links: each webhook, userinfo, DSN, query parameter and path token; `tsc -p` and `docker -p` are not
     secrets.
115. Strong labels at 0.75 with the entropy rule and every skip; authenticator keys at 0.95.
116. Passwords: separators, quotes, "PIN for the shared phone is 2580", `pass` rules, the not-a-password
     words.
117. Codes: after the label, value first, under a sentence, recovery blocks and grids; `CODE_NOT`; heading
     numbers.
118. Rows: beside with boxes between, under a short label line.
119. Continuation (new): a JWT head at a line end continues onto the next lines; a webhook token wrapped
     after `-` continues; at most 6 lines.
120. One space in a key (new): `sk-proj-` with one inner space is one token; two spaces are not.
121. Wrap join: a joined token matching a strong rule covers both parts.
122. Names on screen: folding, distances by length, wildcards, overlapping matches, one word of a full name
     is not a match, never-hide removes a hit.
123. Off-by-default kinds find their vectors only when on.
124. `classQr`: each class of §6.9 and `null` as undecoded.
125. Variants: hits of the tiny and small reads are joined; the higher score wins.
126. Dedupe: a contained hit is dropped; an overlapping hit of another kind is kept.
127. Cover boxes: padding of §6.1, clipped at the frame's edge with no rounding past it (finding 22); own
     spans unpadded (finding 11).
128. `needsCareful`: careful-long's trigger on cleaned text (rule hit, confidence under 0.9, 16 or more token
     characters).
129. The digit stream across captions and full stops; a 2.0 s pause ends a run; `and` ends a run (the
     "400, 300 and 1500, 800" vector); finding 10's card across sentences.
130. Spoken rules: cards with no label, codes, phones (the libphonenumber check), IDs, passwords, emails said
     aloud and as one token, names by double metaphone.
131. Bangla: NFC with য়, ড় and ঢ়; punctuation stripped without vowel signs; the Bangla digit words and
     English digits said in Bangla script.
132. `saidBleeps`: widening of 0.05 s and 0.15 s for estimated times, kind and group markers, no
     bleep inside an existing one.
133. Speech false hits: Flown's docs read as speech give at most 10 hits (this design left out: it quotes
     the spoken vectors, §6.15).
134. Screen false hits: Flown's English UI catalogue gives 0; `docs` at most 2 per 10,000 lines (this
     design left out, §6.15).
135. `scripts/vendor-privacy.mjs --check` passes and every vendored file carries its header.
223. **Window edges**: a 900-character JWT on one line is one hit covering the whole token; a hit that
     touches a window's edge is extended to the end of its token run.
224. **Pattern check**: `regexCheck.mjs` refuses `(a+)+`, `(a|a)*` and `(\w+\s?)*` and passes every
     pattern of `detect/tables.ts`.
225. **The bleep limit**: with 1,999 ordinary bleeps and 5 said hits, `saidBleeps` keeps the total at
     2,000 by merging private bleeps (across groups when needed, only growing them) and reports the
     hits it could not place.
226. **Said groups**: two hits of the same said digit string share a group, a different one gets
     another; the group is in each bleep's word.
227. **`looksLikeName`**: "Priya Raman", "O'Neil" and "Mei-Lin" are names; a GitHub token, a password
     with a digit, a six-digit code, an email and a 41-character text are not.
228. **Rules in a worker are the same rules**: `detectFrame` run through `RulesHost` on the committed
     main-set reads gives exactly the hits it gives in-process.

**P4 · The scan**

136. `lookScale` and `lookStep` for 1080p, 4K and 7680×2160 at 30 and 60 fps.
137. `changedIn` and `keyBefore` on synthetic look data.
138. `planReads`: the first frame; settle reads 0.3 s after bursts; reveals every 0.75 s in a long scroll;
     typing reads after bursts and pastes, with valid and invalid cursor data; periodic reads; at
     display scale 1.5 and 2 the typing box and the settle padding grow by that scale (finding 6).
139. The budget: settle and typing areas less than 1 s apart are always merged; over budget, reveals,
     then periodic reads, then 3 s and 5 s merging thin in that order; thinning stops at twice the
     budget and no read is dropped; `thinSpans` holds every thinned span.
140. Estimates: `firstEstimate` from length, size and rate; `secondEstimate` from the plan and measured
     speeds.
141. `walkSpan` forward on a scripted matcher: holds without changes; follows a clear move; refuses an
     ambiguous one (two within 0.15) and becomes lost.
142. Lost areas (finding 4): a diagonal move with no clear candidate gives a 2-D union box, never a band
     along one axis; a move outside every candidate, with one candidate at 0.45, still leaves the
     planted text inside the lost area in every frame (the changed region is in the union).
143. The speed guide: a scroll whose profile is ambiguous keeps the last speed as a candidate.
144. Evidence of absence: a cover ends only when the next read lacks the text and the template search
     fails at every scale; it ends one analysed frame after the first changed frame with no match;
     with a match it goes on; after an in-app zoom, a read that gives a six-digit code with one
     misread digit keeps the cover going.
145. Re-anchoring: a read finding the group again corrects the path backward and keeps the lost area.
146. The backward walk (finding 3): a scroll before the first read is followed back with the move
     between f and the next analysed frame; the cover covers the text in every source frame from its
     appearance, which is where the box left its region.
147. Zoom: a whole-region change matched at scale 1.25 places the cover.
148. Toasts over a cover: the cover is lost under the toast and placed again after it.
149. `findNotices`: a toast in the bottom right for 5 s is found; one lasting 40 s, one in the middle,
     one in a window recording and one in an imported video are not; stacked toasts (finding 5) give
     each box and the union.
150. `foundCovers`: groups by group key, scores to tiers, colours from rings.
151. `withFoundCovers`: containment drops duplicates, overlap does not; `missed` set and cleared; user
     covers untouched; Find again never covers less anywhere; with 2,000 existing covers, 5,000
     rejected paths and 2,000 new ones it runs in under 400 ms (×6 on CI).
152. `limitCovers` keeps at most 2,000 covers without uncovering anything, and twice the input takes at
     most 2.3 times as long (finding 7).
153. `runFind` with the fake helper: progress phases; the result holds no text (a JSON scan of it finds none
     of the planted strings).
154. `runFind` and a failed read: a lost area from that frame until the next good read; `failedReads`
     counted (finding 23).
155. *Stop*: the found covers come back with unfinished walks run to the end as lost areas over their
     last box and region; `stopped` and `readTo` are set.
156. `followCover` returns `walked` and `lostSpans` with its path; without the reader, a template-only
     path marked `thin`.
157. `coverEverywhere` uses the kept folded reads within 10 minutes of Find, else a limited Find with
     progress and *Stop*.
158. `lookCache` round-trips and is ignored when `screen.mp4`'s size or mtime changes.
159. `stopAnalyses` stops Find and forgets its reads.
160. A second `privacy:find`, for the same project or another, while one runs answers `busy`; *Follow*
     and *Everywhere* go through the same helper's queue ahead of Find's reads.
229. **Walks write union keys**: `walkSpan` on a scripted 60 fps fast scroll (1,500 px/s) returns
     placements whose `stepKeys` path covers the planted text on every source frame.
230. **Backward evidence**: a tooltip over the text for 1.5 s before its first read does not start the
     cover after the tooltip; the walk asks for a check read before the earliest frame with no match,
     and starts the cover one source frame after the frame the check read proved empty; a page change
     with no match stops it at once.
231. **Holding the text**: `holdsText` accepts one misread character of a 5-11 character text, a run of
     4 of its characters, and a third of a longer one; it refuses an unrelated line.
232. **Typed text**: a code typed one character every 0.2 s inside a typing burst before its first read
     is covered from the burst's start with one box over the line band (marked `lost`); text deleted
     inside a burst stays covered until the band has been still for 1.0 s.
233. **No text leaves main**: a JSON scan of every `FindResult`, `FollowResult`, `UnderCoverResult` and
     `EverywhereResult` of the e2e fixtures finds none of the planted strings, except `addedName` for a
     name-like text with `remember` set; the kept folded texts are gone after 10 minutes (a fake
     clock), on *Stop*, on `stopAnalyses`, on `render-process-gone` and on a new Find.
234. **Hiding the length**: two names of 9 and 11 characters in one font get covers of the same width
     with the random part fixed at 0; every place of one group gets the same extra.
235. **Removed paths suppress only what they hold** (D21): uncovering one email that scrolled through a
     list does not stop a different email shown later in the same area from being suggested; a new
     path inside the removed one at every key is suppressed and counted.
236. **Buckets and packing**: `packAreas` puts three 300×80 areas in one 640×352 bucket at 0.1 unit and
     a 1200×500 area in the 1920×1088 bucket at 1 unit; the plan's units are the sum.
237. **Partial and check reads count**: extra reads for a `partial` answer and check reads are in the
     plan's units and its report.
238. **The rules worker's limit**: a read whose rules take over 2 s (a test rule that spins) is
     counted as failed, its area becomes a lost area, and the next read runs in a new worker.
239. **Results are tagged**: every result carries the request's `projectId` and `requestId`.
240. **Copies**: `listCopies` finds the copies by `copyOf.id`; `coverCopies` adds the original's covers
     and private bleeps to a closed copy as suggestions through `projectFileText` and skips an open one;
     `originCovers` counts what a copy lacks.

**P5 · Panel, Review, export notes, Polish and Settings**

161. `privacyReviewItems`: one row per group with its places as parts; titles with the kind's title,
     times, place and the largest lost area's size; badges; `privacyOrder` puts Check rows first.
162. `privacyKeep` and `privacyRemove` take `ReviewItem`s and act on a row's or a part's covers and
     bleeps; Remove writes rejected paths.
163. `privacyPendingCount` counts without making rows; `reviewStatus` over 2,000 private groups runs in
     under 20 ms (×6 on CI) through `privacyIndex`.
164. *Keep all … covered* and *Uncover all …* of a kind are one undo step through `heldInSlices`;
     *Uncover all* asks first (focus on *Cancel*) and keeps a version first.
165. `doneReviewing` keeps every waiting suggestion in one step; its confirm names the Check rows and
     starts on *Cancel*.
166. The kind filter; with nothing left of a kind, `privacy.review.emptyKind` and focus on the filter
     (finding 34); *Show all changes* keeps focus (finding 32).
167. *Peek* and *Listen* are toggle buttons whose names include the row's title (finding 33).
168. `FindDialog`: defaults from Settings and the project; *listen* on with captions, off when unticked
     for this project, unchecked and disabled without captions; the reader line, download and retry;
     the estimate; focus in and back (finding 31).
169. `RegionsDialog`: at most 5 added; the PC's and the UI language's regions always on.
170. `startFind` saves first, runs `detectSaid` on the captions, applies one update through
     `afterGestures`, and records `captionsSig` at the start (finding 14).
171. The progress line: phases, the second estimate, announcements at most every 10%.
172. `gatherPrivacy` runs on the run's captions and returns covers and bleeps for Polish.
173. Polish: the row shows only with the reader; on for new options, off for saved ones; the result lines.
174. `PrivacyExportNote`: the hides, to-check and captions-changed lines; absent for a project hiding
     nothing when the reader is not downloaded; its buttons close the dialog first (finding 30).
175. The export dialog of a project hiding nothing renders exactly as before (snapshot).
176. `TranscribeNote` shows for a service when Find listened or private bleeps exist.
177. `TranslatedNote` shows for a translation not translated again since a private bleep.
178. `NotCheckedNote` shows in `ShotViewer` with *Also send the screenshots* and no Find, shows
     `privacy.guide.unfinished` after a stopped Find, and shows in the guide's save and copy area when
     the reader is downloaded.
179. `PrivacySettings`: the reader's states and buttons; the lists; regions; colour; one shared state with
     the dialog (finding 29).
180. *Find private info…* runs from the palette and is off `WAITING_COMMANDS`.
181. Review's header shows Find's progress while it runs and *Find again…* after.
182. The said rows: *Said aloud* badge and *Listen*; their titles never hold a word.
183. The export note counts a Check row reviewed by *Keep* as done.
184. `useReaderState` updates every mounted user on one event.
185. `PrivacySettings` is the child of `.settings-body` after `LocalAiSection`, with its heading, and
     `SettingsSection` `'privacy'` opens Settings scrolled to it.
241. **Places as parts**: a group with three places shows *Show the 3 items* (Review's parts); each part
     has its own preview stretch, *Keep covered* and *Uncover*; uncovering one part leaves the others.
242. **The verbs**: private rows' buttons read *Keep covered* and *Uncover*, with the names
     `privacy.review.keepRow` and `uncoverRow`; every other kind's buttons are unchanged; *Uncover*
     says `privacy.review.uncovered`.
243. **Kind sentences**: `keepKind` and `uncoverKind` give a whole sentence for every kind id.
244. *Select on the timeline* selects every cover of the row.
245. **Peek while reviewing**: with it on, moving with N peeks the next row and stops peeking the last;
     V turns it on and off on private rows; on a row of another kind V goes on to the editor.
246. **A keyboard pass**: 200 private rows are reviewed with N, V, K and Delete only; no mouse event and
     no second press of Peek are needed, and every row ends kept or uncovered.
247. **Results land only where they belong**: a `FindResult`, `FollowResult` or `EverywhereResult` whose
     `projectId` or `requestId` is not the open project's current request changes nothing.
248. **Leaving during Find**: confirming stops Find, applies what it found (one undo step) and only then
     saves and leaves; declining keeps the editor and Find running.
249. **The export note's new lines**: *Wait for Find* keeps *Export* disabled until the results are
     applied; *Stop Find and export* applies what was found, then exports; `notChecked` shows only with
     the reader; `unfinished`, `thinned` and `saidRemoved` follow `FindRecord`; `weak` with *Turn them
     all into covers*; `hides` only with a private item; `recordingsOff` by `hidesSomething` alone.
250. **Copies**: after Find on a project with two copies the offer shows and covers both closed copies;
     a copy's export note shows `fromOriginal`, and *Bring them over* adds the covers in one undo step.
251. **Find dialog choices**: *Find* is disabled with `privacy.run.busy` while another Find runs; the
     *Notifications* box is hidden for area, window and imported recordings.
252. **Polish**: the hint names the first estimate; with a valid screen pass the step only listens and
     the result line is `privacyListened`; a stopped run gives `privacyUnfinished`.
253. **Settings states**: the reader's `unavailable` reasons show their messages; the colour of new
     covers and *Show where covers are* are remembered.
254. **The progress line**: phases, `waiting` while recording, the second estimate, *Stop*.
255. **Publish dialog**: `PublishMaskedNote` shows when the saved description holds a spoken form;
     *Copy* puts the masked text on the clipboard.
256. **Done notification**: when the window is not focused as Find ends, `main.jobs.privacyDone` is
     shown with the count to review; when it is focused, none.
257. **Find's result line**: `foundNone` with the *What Find does not see* link; `thinned`,
     `suppressed`, `saidFull` and `stopped` as separate sentences when they apply.
258. **Review's unfinished line**: after a stopped Find, Review's header shows
     `privacy.review.unfinished` with *Find again…*.

### 17.2 The equivalence guard (test 20)

`tests/autoBlurEquivalence.test.ts`, committed alone first (§16.0). Its digests
(`tests/fixtures/autoblur-equivalence.json`) are taken in that commit from `37f9355`'s code and never
regenerated. For every old fixture project and stored setting:

- **Projects**: `migrateProject` then `projectFileText` (in its commit: `JSON.stringify(…, null, 2)`)
  gives the same bytes as the fixture's own migration and write before this wave.
- **Drawing**: the recording fake context's `drawFrame` call logs at 24 times, for fixture projects with
  blur and pixelate shapes, crops, grades with and without a LUT, Compare, motion blur, magnifiers,
  joins, freezes, tilt, title-card backgrounds, the Glass caption look and both alpha modes, equal
  their digests.
- **Sound**: `jobSoundGains` and `bleepGains` of every fixture, and the soundtrack graphs, equal their
  digests.
- **Captions and text**: `maskedSegments`, `burnedSegments`, `trackCues` output, `maskBleeped`,
  the search extract, Review items, `pendingCount`, `changedAreas` and the transcript text equal their
  digests.
- **AI**: for every fixture, the requests made by the pure request builders (the pack's, the
  chapters' and names' requests, `captionsToTranslate`, the guide's step names, the marks request)
  equal their digests, and `maskRequest` returns each of them as the same object. Three requests are
  built inline in React handlers (`CleanupSection.tsx:197`, `LanguagesSection.tsx:228`,
  `CaptionsPanel.tsx:1144`), where a test written before any change cannot reach them; test 31's
  per-call-site check covers them once they call `aiTextFor`.
- **Texts made from captions**: `privateView` of every fixture is the fixture itself (the same
  object).
- **Settings and presets**: stored export settings, bundle choices (`timelineMedia: 'recordings'`
  included), user presets and `editor-prefs.json` normalise and write back byte for byte.
- **Polish**: `planPolish` with saved options equals its digest.
- **Guide**: `shotSig` and `planActual` of every step of the guide fixtures equal their digests.
- **Home**: `listProjects`' summaries of the fixture folder equal their digests.

### 17.3 End to end (`tests/e2e/auto-blur.e2e.cjs`, under `xvfb-run`)

The host helper (`build-native --ocr-host`) and the pinned models in a fixed `userData`; fixture videos
made by the test from the evaluation PNGs with ffmpeg (lossless, `-c:v libx264rgb -qp 0`). Exported
frames are read back with ffmpeg as raw RGB.

**How an output is shown to cover** (A1, A2 and its variants). A colour check alone cannot prove
nothing leaks: lossy codecs never reproduce a solid colour exactly, and it would never look outside
the boxes, where a blur shape, a lens, a title card's background or the Glass caption look could
carry the text. So each output is made **twice**, from two fixture recordings that differ only in the
pixels under the covers (two different secrets, same everything else), and the two are compared:

- lossless and deterministic routes (PNG thumbnails and guide pictures, raw canvas readback of the
  preview and the export dialog's preview, x264 and libvpx run with `-threads 1`, `-fflags +bitexact`
  and `-map_metadata -1`, GIF): **byte-identical** outputs;
- the WebCodecs and hardware encoder routes: every decoded frame identical within 2 levels on 99.5% of
  pixels of the **whole frame** and on 98% of the pixels where the secrets are, and in each output
  every secret's place a **solid fill**: at most 0.1% of its pixels more than 12 levels off its median
  colour in any frame. The 99.9% first written here cannot hold: the WebCodecs encoder is not
  repeatable, and one recording exported twice differs by 0.16-0.31% of a frame's pixels and by up to
  1.33% where the secrets are (measured 24 November 2026; the covered pair, 0.13-0.31% and up to
  1.47%). Those two numbers pool the encoder's noise with whatever shows, so they cannot prove the
  covers alone: a cover 3 px short of its secret passed them (0.39% and 1.93%). The fill check does:
  covered, no pixel of a secret's place was 12 levels off its fill; the 3 px strip gave 0.7-1.2% of
  that secret's pixels and fails it; without covers 94-99.9%;
- and, for the lossless routes, each cover box is filled exactly with its graded cover colour, as a
  second check.

- **A1. Find on a recorded fixture.** A 60 s video of eight evaluation frames with scrolls between them:
  *Find private info* with the defaults; Review lists the rows, Check rows first; *Done reviewing*; the
  export passes the comparison above against the same video with other secrets planted, and every
  planted on-by-default item's ink is inside a cover in every source frame.
- **A2. Every output covers.** One project with three covers (one moving): MP4, WebM, MOV CineForm, GIF,
  transparent `background`, 120 fps, a batch, a per-chapter part, the thumbnail PNG, the export
  dialog's preview canvas, the guide's shots and its PDF and HTML pictures, a short clip copy and the
  timeline's *This export* mode, each compared as above. Variants:
  - **A2a joins**: a crossfade and a slide over a cut inside a cover's time.
  - **A2b vertical follow**: the 9:16 copy with the follow camera.
  - **A2c title-card background**: a title card with the blurred-frame background over a cover.
  - **A2d WebM and hardware raw frames**: the raw-frame route to ffmpeg and the WebCodecs route.
  - **A2e guide pictures**: the PDF's and the HTML folder's images, decoded.
  - **A2f motion blur, a magnifier and a blur shape** beside a cover: the whole frame is compared, not
    only the cover's box.
  - **A2g a cropped project**, then cropped with a grade and a LUT, with a moving cover over text 10 px
    inside the crop's edge (D19).
- **A3. Peek and Listen never reach an output.** With Peek on, an export and a thumbnail are covered;
  with Listen on, the export's sound is muted under the private bleep.
- **A4. The original recordings.** With a cover, the chip is disabled; a preset choosing it exports with
  the notice and no media folder; main refuses a forged request.
- **A5. Home thumbnail.** A project with a cover at 1 s shows a Dark box there on Home.
- **A6. Old projects and older Flown.** Opening and saving every old fixture project leaves its bytes
  unchanged; a saved project with covers holds the legacy shapes, and a build of `37f9355` opening it
  draws the opaque boxes over the covers' places.
- **A7. Spoken secrets.** A fixture with captions saying a card number and a code: private bleeps; the
  captions, a Spanish translation, the SRT sidecar, chapter names and a fake AI service's recorded
  requests hold no digit of them; the export's sound is muted there.
- **A8. One undo step.** Find's results are one undo; a timeline drag during Find keeps both.
- **A9. The reader's download.** From a local fake mirror: download, resume after a cut, a wrong hash
  refused, Remove.
- **A10. A crash in one read.** The fake helper crashes on one read: Find ends with the failed-reads line
  and a lost area over that part.
- **A11. Keyboard and screen reader.** The whole flow with the keyboard only; axe finds no violation in
  the dialog, the section, the Covers row and Review.
- **A12. Multi-select.** Select three covers (Ctrl+click, and a group's bar); the section shows the
  count and the disabled actions' reasons; change their colour, nudge, delete, undo, copy and paste
  them; select three blur shapes and *Turn into covers*.
- **A13. Polish.** Polish with *Find private info* on a fixture with captions.
- **A14. The guide's buttons.** *Blur an area…* adds a cover coloured from the step's shot frame.
- **A15. Follow and Everywhere.** A user cover over a scrolled email follows it; *Cover this text
  everywhere* covers its other places.
- **A16. The rendered tracking set** (`scripts/privacy/make-track-fixtures.mjs`, written in the
  contracts step, §16.0 item 13): lossless videos at 60 fps of a scrolling list, a fast flick scroll
  of 1,500 px a second or more (three flicks at 1,600 px a second, 672, 672 and 456 px, from the
  list's top to 1,800 px, each after 5.2 s at rest, and 1.075 s at rest at the end, 17.8 s in all:
  every other row of rows 0-89 is planted, 45 items, and each is at rest, whole, at one of the stops,
  on screen 1.1-10.9 s and still 1.07-5.22 s; the case first flicked 1,800 px once after 0.2 s, and
  its 19 planted rows in between were each on screen 0.45-0.47 s and never still, a page scrolled
  past quickly that §2.9 and §5.4 point 6 say Find may miss, and never read; stops less than 5 s
  apart would be read once by a plan over its budget, §5.4 point 7; the end-to-end check decodes the
  case a gigabyte at a time), browser zoom in and out, text selected and deselected, a sticky header
  over a scrolling page, a window dragged diagonally, stacked toasts sliding in and out (toast-shaped,
  each living 2.8 s in a 3.5 s recording, as notifications do: §6.13 finds a notice living 2-30 s,
  and the reads of §5.4 point 6 may miss text shown under about a second; they were first 652 px
  tall, the evaluation set's own toast style pinning their bottom, and lived 1.15 s, still 0.85 s),
  a toast and a tooltip passing over text before its first read, an email typed into a form field and a key typed
  into a terminal (and deleted again), the evaluation frames at 150% and 200% display scale, and the
  new-seed held-out frames (each frame held 6 s at 30 fps, 144 s a set: they test reading at display
  scale and on unseen frames, not flashing pages; held 0.5 s, every page was on screen under the
  second §2.9 and §5.4 point 6 say Find may miss, and a plan over its budget, as every whole-page read
  of these sets is, reads pages less than 5 s apart once, §5.4 point 7), with every planted item's
  box known in every frame. The rendered cases
  are cached under a key of their generator, so a changed fixture is rendered afresh; Find runs with
  the phone regions the evaluation set's truth was scored with (the United States, which an English
  UI has, and Great Britain and Bangladesh, added in the dialog). After Find, every
  on-by-default item is covered (its whole ink inside a cover, the ink of each of its own rectangles:
  a token wrapped onto a second line has two, and the box holding both takes in the line's other
  words) in **every source frame** it shows in,
  the frames between analysed frames included, for every video; each typed character is covered from
  the frame it appears. A failure prints the item, frame and uncovered pixels. The plan's units for
  each video are printed, for §5.11's units distribution.
- **A17. The English guard.** `guard-delta.mjs` on the merged tree passes; the baseline is re-recorded
  only then (§12.2).
- **A18. Export during Find.** With Find running, the export note shows `running`; *Wait for Find*
  keeps *Export* disabled until the results are applied and the export then covers them; *Stop Find
  and export* applies what was found and the export covers it. "Covers" is checked on every 30th
  frame: each pixel of each cover's box (3 px in from its edges, and from another cover's) shows the
  colour of a cover drawn over it; covers overlap and keep their own colours.
- **A19. Leaving during Find.** Going Home while Find runs asks first; confirming applies what was found
  before the project is saved, and reopening the project shows those covers.
- **A20. Copies made before Find.** Make a short clip, run Find on the original, choose *Also cover the
  copy*; the clip's export covers the planted items; a second copy made earlier shows `fromOriginal`
  and *Bring them over* does the same.
- **A21. Review at speed.** 200 private rows reviewed by keyboard with *Peek while reviewing* on; the
  magnified view shows the text under the selected cover; an export and a thumbnail made meanwhile
  have no outline and no magnified view.

---

## 18. The optional `private.json` (decision 9, for the other account)

This wave works from the recorded video and `cursor.json` alone. Data only the recording side can
capture would make Find surer: where password boxes and text fields were, and which windows were on
screen. Decision 9 asks the other account, now, for an optional file written beside `cursor.json` by
the recording side's own files. Nothing in this wave reads it; a later wave would.

```ts
/** <project>/private.json, written once when the recording is finalised. Never holds a value typed or shown. */
interface PrivateCapture {
  format: 'flown-private'
  v: 1
  /** The recording's frame, so rectangles can be normalised: the video's pixels after capture.region. */
  frame: { width: number; height: number }
  /** Text fields and password boxes that had focus or were visible, from UI Automation. */
  fields: {
    /** Source seconds, as cursor.json's times. */
    t: number
    end: number
    kind: 'password' | 'text'
    /** Normalised to the video frame (0..1). */
    rect: [x: number, y: number, w: number, h: number]
    focused: boolean
  }[]
  /** Top-level windows over time: one entry per change of rectangle, visibility or order. */
  windows: {
    t: number
    end: number
    /** Stable within the recording. */
    id: number
    /** The executable's file name only, e.g. "chrome.exe". */
    process: string
    /** The window title as shown. Private itself: never exported, logged or shown outside the editor. */
    title: string
    rect: [x: number, y: number, w: number, h: number]
    /** 0 is the topmost. */
    z: number
    visible: boolean
  }[]
}
```

- Limits a reader would enforce: at most 100,000 field entries and 100,000 window entries, titles of
  at most 256 characters, file size at most 32 MB.
- Uses a later wave could make: cover a password box while it shows typed text (dots are off by
  default); an "Always cover these apps" setting (a process list) drawn from `windows`; pop-up
  notifications told from ordinary windows by their process; planReads reading a field when it gets
  focus.
- It never holds keystrokes, clipboard contents, field values or window contents.

---

## 19. What the first version taught

### 19.1 The independent review's findings, and what prevents each

| Finding | What went wrong | Prevented by |
|---|---|---|
| 3 | A cover lagged one move behind before the first read when following backward | §5.8 the backward walk uses the move between f and the next analysed frame; union keys between analysed frames (§4.2); tests 146, 186, 187 |
| 4 | A diagonal lost area was drawn as a band along one axis | §5.8 step 5: a 2-D union of the box, every candidate and every changed region, whatever the candidates scored; tests 142, 230 |
| 5 | Stacked toasts | §6.13 each notice and the stack's union; test 149; A16's stacked toasts |
| 6 | The helper's display scale: reads of HiDPI frames landed off the text | §5.5 reads at the recording's own pixels, tiled, never scaled; §5.3 every size in screen pixels multiplied by the display scale; tests 138 (scale 1.5 and 2), R18 (frames rendered at 150% and 200%), A16 |
| 7 | `limitCovers` was quadratic | §5.10 heap merging over each cover's 8 nearest in its grid cells, O(n log n); tests 13 and 152, each with a "twice the input, at most 2.3 times the time" check |
| 10 | A spoken number said across sentences and number words was not found | §7.2 the digit stream across captions and full stops; test 129 |
| 11 | The matcher was built from the padded span | §6.1 own spans for everything that finds text again on screen; §7.3 spoken forms from the hit's own words, by word midpoints inside the unpadded bleep; tests 127, 192 |
| 12 | Chapter title cards were not masked for spoken secrets | §7.5 `privateView` masks `titles[]` where they are drawn, in the preview and every output; tests 22, 191 |
| 13 | Tidy captions kept real words under private bleeps | §7.4 masking by time, whole span when words do not line up; masked requests; tests 18, 23 |
| 14 | `saidStale` was lost when captions changed during Find | §7.7 `captionsSig` taken at Find's start; test 170 |
| 16 | A cover drag overwrote Find or Follow results arriving meanwhile | §5.10 and §14.1 results through `afterGestures`, merged against the current project; tests 61, 170 |
| 17 | `readCovers` was quadratic on huge projects | §4.3 one linear pass; test 3 |
| 18 | Copy and paste of a cover pasted old items or an image | §14.4 snapshots at copy time, own project only, no OS clipboard; tests 49, 72 |
| 19 | Opening a version settled its suggestions | §14.1 no settle step for covers, nor any new settle step; edits drop `found` themselves; tests 52, 201 |
| 20 | Covers past the total-key limit loaded coarser | §4.2 writers never exceed the limits, `simplifyKeys` merges the longest paths first; §4.3 readers only ever grow boxes; tests 2, 188 |
| 22 | A line box rounded past the frame's edge | §6.1 clipped, never rounded past the edge; test 127 |
| 23 | A failed read was dropped silently | §5.6 a lost area and the failed-reads line; §10.3 caps answer `partial` and are completed; tests 84, 154, 222, R21, A10 |
| 24 | Names with a leading star were written to logs | §10.6 stars stripped, names joined to `secretValues()`; test 35 |
| 25 | No heartbeat during the helper's open phase | §10.4 heartbeat from start; tests 81, R1 |
| 26 | A failed reader download was not shown | §2.5 `privacy.find.readerFailed` with *Try again*; test 79 |
| 28 | The names list was not reloaded after *Cover this text everywhere* | §5.9 dialogs read the list again; test 62 |
| 29 | The panel and Settings kept separate reader states | `useReaderState`, one shared state, a contracts stub with its final signature (§16.0 item 10); tests 91, 179, 184 |
| 30 | The export note's buttons did not close the dialog | §2.12 and §11 close first, then open; tests 174, 249 |
| 31 | Focus going into and back from the Private info panel | §11 focus rules; test 168 |
| 32 | Review's *Show all changes* lost focus | §11; test 166 |
| 33 | Peek and Listen's labels were missing from their accessible names | §2.8 and §11 names include the row's title; test 167 |
| 34 | The filtered empty Review list had no message | §2.7 `privacy.review.emptyKind`; test 166 |
| 35 | The Check bar's line style | §2.3 and §11: dashed waiting edges, `--warning` for Check, a text badge; test 66 |
| 36 | Selection did not follow focus on the Covers row | §11; test 67 |
| 37 | Focus after Follow's *Stop* and *Keep* | §11: *Stop* keeps focus on *Follow*, *Keep covered* moves it to the section's title; tests 61, 213 |
| 1, 2, 8, 9, 15, 21, 27 | Not recorded by name (they were in the outputs and finding lenses) | §9's row for every output path, A2 and its variants compared against a second recording, and test 20 cover the output lenses; §5.6, §5.8, §5.10 and the P4 tests 141-160 and 229-240 the finding lenses |

### 19.2 What the first build left undone, and where it is done now

| Left undone | Done here |
|---|---|
| Multi-select and group edit of covers | §2.2's multi-selection state, §14.4's branches; tests 70-72, 75, 209; A12 |
| A16, the rendered tracking set, run end to end | `make-track-fixtures.mjs` is contracts item 13 (§16.0) with test 196; A16 checks every source frame, with the fast scroll, typed text, a tooltip before the first read and HiDPI cases added |
| The guide's *Blur an area…* coloured from whatever frame was paused | §2.11 and §8.4: `ringColourAt` at the step's own shot time, `blurArea` async (§16.1); test 59; A14 |
| Re-reads decoding from the start of the recording | §5.5: a seek to the key frame before each read, measured at 0.1 s a read; R16 |
| Numbered tests folded into one file | §17.1: one `it` per number, checked by `autoBlurNumbers.test.ts` |
| A2's variants only as unit tests | §17.3 A2a-A2g end to end, each compared against a recording with other secrets |
| R4 passed only at the edge of its tolerance through a real scan | R17 checks the planned-area path alone, within 0.5 points of whole frames (§5.6) |
| `useReaderState` was still P5's stub returning null, so Follow and Everywhere stayed enabled | the reader-state and progress hooks are contracts stubs with final signatures that P1 uses from the start (§16.0 item 10) |
| The timeline flush needed a new `ExportDialog` prop | named in §9 row 10 and contracts item 8; test 25 checks the order |
| The folder notice of the first design | `privacy.notSee.folder` in §2.9's list (§9 row 27); test 63 |
| The English guard's first run failed on cold-launch timing | §12.2: a warm-up launch before every compare run; timing differences are run again, never recorded |
| `WAITING_COMMANDS` edited by two parts | `WAITING_P1` and `WAITING_P5` on lines of their own (§12.3) |
| `bcryptprimitives.dll` and the WinRT imports measured late | `OCR_IMPORTS` lists all eight (§16.2) |
| libphonenumber-js and double-metaphone not added | §6.14 vendored by `scripts/vendor-privacy.mjs` (no `npm install` needed), with notices |
| tract against ONNX Runtime not measured on the shipped bytes | measured on PaddlePaddle's own files, which are the shipped bytes (§5.6); the contracts step repeats it |
| Character list counts written wrongly (6,908 and 18,712) | 6,904 and 18,708, read from the pinned `inference.yml` files (§0 decision 1) |
| `aiTextFor` masked only private forms | still so, on purpose: ordinary bleeps would change old projects' requests (§7.6) |
| R8 and R10 not run (Windows only) | still for the reference PC; R10 now also scores the Windows reader built behind its flag (§5.13) |
| Still for a person | the mirror, the Windows-only checks, the native Bangla review and the other account's `private.json` (§16.6) |
