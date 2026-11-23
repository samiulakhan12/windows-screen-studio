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
again for this version.

The rules of the earlier waves hold:

- **Preview and export draw the same frames.** Covers are filled into the screen picture inside
  `drawFramePicture` (`src/renderer/src/render/compositor.ts:147`), which the preview, every export,
  the export dialog's preview, thumbnails, join stills, freeze stills and guide shots all use (§8).
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
  by how much it moved (§5.2).
- **Lost area**: a cover over the whole area where text may be after Flown could not place it
  (§5.8).
- **Private bleep**: a bleep over a secret said aloud. Its `word` holds a kind marker, never the
  word (§4.4).
- **Spoken forms**: the ways a private bleep's secret can appear in text made from captions (§7.3).

---

## 0. Decisions for the owner

**Decided by the owner on 17 November 2026: every recommendation of decisions 1-12 is accepted.**
They stand and are not asked again. Each is restated here as decided, with what this version
measured against it. Questions 13-16 are new and open, each with a recommendation.

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
   (§7).
8. **DECIDED: checks before release.** Required: the shipped model bytes measured with the committed
   scorer; Windows OCR at 95% or more pattern recall and 99% or more padded coverage before it is
   offered; the helper's speed, memory and size at 1080p, 4K and 7680×2160 on the reference PC; the
   rendered tracking set (A16) with every planted item covered in every frame; 30 real recordings
   (97% or more covered, nothing found ever shown); pop-up false hits at most one per 10 minutes; and
   a native Bangla review of the spoken word lists (§15, §17.3).
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
    pixels with secrets, and Windows Error Reporting can upload it. The helper calls `SetErrorMode`
    so no dialog appears, but only an exclusion stops the report.
    - (a) The installer writes `HKCU\Software\Microsoft\Windows\Windows Error Reporting\
      ExcludedApplications\ssw-ocr.exe = 1` (DWORD) and the uninstaller removes it (§10.5).
    - (b) No registry change; the helper only calls `SetErrorMode`.

    **Recommended: (a).** It is one per-user value, named after Flown's own helper, removed on
    uninstall.
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

---

## 1. Summary

- **Covers in the editor.** A new *Private info* section at the top of the Shapes tab: *Add cover*
  (3 seconds, to the end, or the whole video), *Find private info…*, the number of covers and of
  suggestions to check, and what Find does not see. A selected cover has its colour, its box, *Follow
  what is under it*, *Cover this text everywhere…*, *Cover the whole video*, *Keep* and *Remove*. Covers
  have their own row on the timeline, shown only when the project has covers. Blur and pixelate
  shapes get a note and *Turn into a cover*.
- **Find private info.** A dialog with the kinds to find (decision 2's defaults), names to hide, words
  never to hide, phone regions and *Also listen for secrets said aloud*. Find runs on this PC in the
  background while the user keeps editing: a look pass over every frame, reads of the areas that
  changed, the text rules, and following each found text through scrolls and moves until there is
  evidence it is gone. Its results land as suggestions in one undo step.
- **Review.** A new Review kind, *Private*. One row per text (all the places and times the same text
  showed in that run), Check rows first, filters per kind, *Keep* and *Remove* per row and for all of a
  kind, *Peek* (see under the covers in the preview only), *Listen* (hear a bleeped secret in the
  preview only) and *Done reviewing*.
- **Spoken secrets.** With captions, Find also listens: cards, codes, phones, IDs, passwords, emails
  and listed names said aloud become private bleeps. Their words are masked everywhere text is made
  from captions: captions, translations, subtitles, chapter names, the publishing pack, the guide,
  the search index and every AI request.
- **Every output** draws the covers: every export format, transparent and GIF, thumbnails, the export
  dialog's preview, guide screenshots, PDF, HTML and Markdown guides, short clips, the publish pack's
  copy, share, Home thumbnails, the filmstrip and the pictures sent to AI. *The original recordings*
  timeline mode is refused while the project hides anything.
- **Export note.** The export dialog says how many items the video hides and how many are still to
  check, with *Review*.
- **Polish** gains *Find private info*. **Settings** gains *Private info*: the reader's download, the
  default kinds, names and never-hide lists for every video, phone regions and the colour of new
  covers.
- **Older Flown** opening a project with covers draws a pixelate and an opaque box over each cover.
- **Size**: the installer grows by about 3.4 MB (the helper). The reader's models, 27.6 MB, are
  downloaded on demand.

---

## 2. What the user sees

Every text below is a catalogue message in the new `privacy` namespace
(`src/shared/i18n/messages/en/privacy.json`, with a meta entry each in `privacy.meta.json`), unless
its key names another namespace. The contracts step writes all of them (§16.0). Plurals are ICU
messages; no sentence is made of pieces (the words rule, `scripts/i18n/config.json` `"words":
"fail"`). Times are shown with the editor's clock format (`fmt.clock`).

### 2.1 Shapes tab › Private info

A new section at the top of the Shapes tab (`tab-shapes` in the English guard), above the existing
shape buttons. It is always there, so a project without covers shows it too (§12.2 lists the guard
captures this adds to).

| Key | English |
|---|---|
| `privacy.section.title` | Private info |
| `privacy.section.addCover` | Add cover |
| `privacy.section.addCoverMenu` | Choose how long the cover lasts |
| `privacy.cover.length.three` | For 3 seconds |
| `privacy.cover.length.toEnd` | To the end of the video |
| `privacy.cover.length.whole` | For the whole video |
| `privacy.section.find` | Find private info… |
| `privacy.section.count` | `{covers, plural, =0 {No covers yet.} one {# cover.} other {# covers.}}` |
| `privacy.section.toCheck` | `{count, plural, one {# to check.} other {# to check.}}` |
| `privacy.section.review` | Review |
| `privacy.section.readerMissing` | Find needs the text reader, a 27.6 MB download. |
| `privacy.section.notSee` | What Find does not see |

- *Add cover* adds a cover at the playhead, for 3 seconds by default; its arrow opens the length menu,
  which remembers the last choice for the session. The new cover's box is 30% × 10% of the frame,
  centred where the cursor is at the playhead (or the frame's centre when the cursor is hidden or
  invalid), clipped to the frame. Its colour is picked from the paused frame (§8.4). It is selected.
  One undo step.
- *Find private info…* opens the dialog of §2.5. While Find runs, the section shows the progress line
  of §2.6 instead of the button.
- The count line shows only when the project has covers. *Review* opens Review mode filtered to
  *Private*.
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
| `privacy.cover.moveAll` | Move the whole path |
| `privacy.cover.moveAllHint` | Changes to the box move it at every time, not only at the playhead. |
| `privacy.cover.follow` | Follow what is under it |
| `privacy.cover.followHint` | Flown reads the text under the cover and moves the cover with it. |
| `privacy.cover.following` | Following… |
| `privacy.cover.followStop` | Stop |
| `privacy.cover.followDone` | The cover now follows the text from {start} to {end}. |
| `privacy.cover.followNone` | Flown found no text under this cover to follow. |
| `privacy.cover.everywhere` | Cover this text everywhere… |
| `privacy.cover.whole` | Cover the whole video |
| `privacy.cover.keep` | Keep |
| `privacy.cover.remove` | Remove |
| `privacy.cover.found` | Found by Find private info: {kind}. |
| `privacy.cover.toCheck` | To check: {kind}. |
| `privacy.cover.lost` | Flown could not tell where this text moved, so the cover hides the whole area it may be in. |
| `privacy.cover.missed` | The last Find did not find this text again. The cover stays until you remove it. |
| `privacy.cover.thin` | Flown read this part of the video less often. Check that the cover is right. |
| `privacy.cover.timeKept` | This cover follows text, so it keeps its times. Drag its ends to make it longer. |
| `privacy.cover.oneProject` | Covers paste only into the video they were copied from. |

- The box fields are percentages of the whole recorded frame, one decimal, with `NumberField`
  (`src/renderer/src/i18n/NumberField.tsx`). They show the box at the playhead. With *Move the whole
  path* off (the default), a change sets the box from the playhead until the path's next key; on, it
  moves every key by the same amount.
- On the preview the selected cover has eight handles (P1 `CoverHandles`); dragging moves or resizes
  it under the same rule. Covers are drawn solid in the editor too; the selection outline is drawn
  outside the box.
- *Follow what is under it* reads the text under the cover at the playhead and makes the cover a
  path that follows it (§5.9). One undo step when it lands. *Stop* keeps the cover as it was.
- *Cover this text everywhere…* opens the dialog of §2.5 with one choice: the text under this cover,
  found and followed in the whole video (§5.10).

  | Key | English |
  |---|---|
  | `privacy.everywhere.title` | Cover this text everywhere |
  | `privacy.everywhere.body` | Flown reads the text under this cover and covers it wherever it shows in this video. |
  | `privacy.everywhere.remember` | Also add it to this video's names to hide |
  | `privacy.everywhere.start` | Cover everywhere |
  | `privacy.everywhere.done` | `{count, plural, =0 {The text was not found anywhere else.} one {Covered # more place.} other {Covered # more places.}}` |

- *Cover the whole video* sets the cover's times to the whole recording, keeping its path (its first
  and last boxes held to the ends).
- *Keep* shows only on a suggestion; it makes the cover the user's. *Remove* deletes the cover; a
  removed suggestion is remembered so Find again does not suggest it there again (§5.10).
- A suggestion's lines (`found`, `toCheck`, `lost`, `missed`, `thin`) show under the title. `{kind}`
  is the kind's name from §2.5's table, in lower case through its own message
  (`privacy.kind.<kind>.name`).

### 2.3 The Covers row on the timeline

A row labelled *Covers* (`privacy.track.title`) between the Shapes row and the Images row. It shows
only when the project has at least one cover, so older projects' timelines do not change.

- Each cover is a bar from its start to its end. Suggestions waiting for review have a dashed edge;
  Check suggestions have the warning colour (`--warning`) on their edge; lost areas a hatched fill.
  Bars of the same group (§5.10) that overlap in time are drawn as one bar with a count badge.
- Thin marks under a bar show where the path changes (each key), at most one mark every 4 px.
- Keyboard: the row is one tab stop with roving focus (§11). Arrow keys move between bars, Enter
  selects, Delete removes, Shift+Arrow lengthens or shortens by one frame (only the ends; §2.2's time
  rule).
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
| `privacy.track.group` | `{count, plural, one {# place} other {# places}}` |

### 2.4 Blur and pixelate: the note

Under the strength slider of a selected blur or pixelate shape (`ShapesPanel.tsx`), a note and a
button. The existing note `text.calloutSection.privacyNote` stays as it is.

| Key | English |
|---|---|
| `privacy.weak.note` | Blurred and pixelated text can sometimes be read back. A cover hides it completely. |
| `privacy.weak.turn` | Turn into a cover |

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
| `privacy.find.namesHint` | One name or word per line. A * at the start or end matches any letters there. |
| `privacy.find.neverHide` | Never hide |
| `privacy.find.neverHideHint` | Product names and other words Flown should leave visible, one per line. |
| `privacy.find.everyVideo` | Names and words from Settings are used too. |
| `privacy.find.listen` | Also listen for secrets said aloud |
| `privacy.find.listenHint` | Uses the captions. Secrets said aloud are bleeped and masked in captions and translations. |
| `privacy.find.listenNone` | Make captions first to listen for secrets said aloud. |
| `privacy.find.readerNone` | Find needs the text reader, a 27.6 MB download from Qbexel. It runs on this PC. |
| `privacy.find.readerDownload` | Download |
| `privacy.find.readerProgress` | Downloading the text reader… {percent}% |
| `privacy.find.readerFailed` | The text reader could not be downloaded. {reason} |
| `privacy.find.readerRetry` | Try again |
| `privacy.find.estimate` | `{minutes, plural, one {About # minute on this PC.} other {About # minutes on this PC.}} You can keep editing.` |
| `privacy.find.again` | Find again keeps every cover you have and adds what is new. |
| `privacy.find.start` | Find |
| `privacy.find.startAgain` | Find again |
| `privacy.find.cancel` | Cancel |

The kinds, in this order, each a checkbox with its default from decision 2:

| Kind | `privacy.kind.<kind>.label` | `privacy.kind.<kind>.name` | Default |
|---|---|---|---|
| `password` | Passwords and PINs | password | on |
| `code` | Sign-in and recovery codes | code | on |
| `qr` | QR codes | QR code | on |
| `key` | Keys and tokens | key | on |
| `link` | Tokens in links and webhooks | token in a link | on |
| `email` | Email addresses | email address | on |
| `card` | Card and bank numbers | card or bank number | on |
| `phone` | Phone numbers | phone number | on |
| `id` | ID numbers | ID number | on |
| `name` | Names you list | name | on (finds nothing until a name is listed) |
| `notice` | Pop-up notifications | pop-up notification | on in whole-screen recordings; the box is hidden for area and window recordings |
| `address` | Street addresses | street address | off |
| `dots` | Password dots | password dots | off |
| `random` | Random-looking text | random-looking text | off |

A user cover has no kind; a cover made by *Cover this text everywhere* has kind `text`
(`privacy.kind.text.name`: "text you chose").

- The kinds, regions, lists and *listen* choice are remembered per project in `Project.privacy`
  (§4.3) and default from Settings (§2.14).
- Regions: the PC's region (`app.getSystemLocale()` region, read in main) and the UI language's region
  (`bn` → BD, `hi` → IN, `es` → ES, `en` → none) are always on; the user adds up to 5 in a list of
  every region the phone metadata knows, by country name.
- The estimate is §5.11's first estimate. It is replaced by a second one after the look pass (§2.6).
- *Listen* is disabled with `privacy.find.listenNone` when the project has no captions.
- Without the reader the dialog shows `privacy.find.readerNone` and *Download*; *Find* stays enabled
  only for *listen* (spoken secrets need no reader), and then reads `privacy.find.start`.

### 2.6 While Find runs, and when it ends

The Shapes tab's section and Review's header show one progress line (`role="status"`, polite,
announced at most every 10%). Find runs in main at below-normal priority; the user keeps editing.
One Find at a time per project; opening another project leaves it running for the first.

| Key | English |
|---|---|
| `privacy.run.look` | Looking for changes on screen… {percent}% |
| `privacy.run.read` | Reading text… {done} of {total} |
| `privacy.run.follow` | Following text… |
| `privacy.run.left` | `{minutes, plural, =0 {Less than a minute left.} one {About # minute left.} other {About # minutes left.}}` |
| `privacy.run.stop` | Stop |
| `privacy.run.foundNone` | Find private info found nothing private. |
| `privacy.run.found` | `{count, plural, one {Find private info found # private item.} other {Find private info found # private items.}}` |
| `privacy.run.foundCheck` | `{count, plural, one {# of them is to check.} other {# of them are to check.}}` |
| `privacy.run.said` | `{count, plural, one {# was said aloud and is bleeped.} other {# were said aloud and are bleeped.}}` |
| `privacy.run.failedReads` | `{count, plural, one {Flown could not read # part of the video. It is covered until you check it.} other {Flown could not read # parts of the video. They are covered until you check them.}}` |
| `privacy.run.stopped` | Find stopped. What it found so far is kept. |
| `privacy.run.failed` | Find private info stopped: {reason} |
| `privacy.run.openReview` | Review |

- When results land, they are applied in one undo step (§14.1) and the line shows `found` (or
  `foundNone`) with `foundCheck` and `said` as separate sentences when they apply, and *Review*.
- *Stop* ends the scan. What was found and followed so far is applied as one undo step; a cover whose
  following was not finished is extended to the end of the recording as a lost area (§5.8), so
  stopping never leaves text uncovered that Find had found.
- A failed read never drops silently: its area becomes a lost area until the next good read there,
  and `failedReads` says so (§5.6).

### 2.7 Review: private items

Review mode (`docs/design/review-mode.md`) gains the kind *Private* (`review.kind.private.*`), listed
before *Chapter*.

| Key | English |
|---|---|
| `review.kind.private.chip` | Private |
| `review.kind.private.name` | private item |
| `review.kind.private.all` | Remove all private item covers |
| `review.kind.private.count` | `{count, plural, one {# private item} other {# private items}}` |
| `privacy.review.title` | `{kind} · {start}–{end}` |
| `privacy.review.where` | `{place, select, topLeft {top left} top {top} topRight {top right} left {left} centre {middle} right {right} bottomLeft {bottom left} bottom {bottom} other {bottom right}} of the screen` |
| `privacy.review.places` | `{count, plural, one {# place} other {# places}}` |
| `privacy.review.check` | Check |
| `privacy.review.said` | Said aloud |
| `privacy.review.lost` | Covers an area |
| `privacy.review.missed` | Not found again |
| `privacy.review.thin` | Read less often here |
| `privacy.review.peek` | Peek |
| `privacy.review.listen` | Listen |
| `privacy.review.filter` | Show |
| `privacy.review.filterAll` | All kinds |
| `privacy.review.keepKind` | Keep all {kindPlural} |
| `privacy.review.removeKind` | Remove all {kindPlural} |
| `privacy.review.done` | Done reviewing |
| `privacy.review.doneConfirm` | `{count, plural, one {Keep the # cover still waiting?} other {Keep the # covers still waiting?}}` |
| `privacy.review.doneCheck` | `{count, plural, one {# of them is to check and has not been looked at.} other {# of them are to check and have not been looked at.}}` |
| `privacy.review.doneKeep` | Keep them |
| `privacy.review.emptyKind` | Nothing of this kind is waiting. |
| `privacy.review.findAgain` | Find again… |

**One row per text.** A row is one group (§5.10): every place and time the same text showed in that
Find run, with its covers and bleeps. Its title is the kind and the first start to the last end
("Email · 0:42–3:10"), then the place on screen of its first cover ("top right of the screen") and
the number of places. The text itself is never shown in Review or anywhere in the UI outside the
preview's Peek: the user may be sharing their screen.

**Order.** Check rows first, then the rest, each by start time. The list keys of Review
(`src/shared/review/keys.ts:17-27`) work as before.

**Keep, Remove.** *Keep* makes every cover and bleep of the row the user's; *Remove* deletes them and
remembers the places (§5.10). Each is one undo step. The kind filter (`privacy.review.filter`, a
select of the kinds present) narrows the list; with one kind shown, the header has *Keep all…* and
*Remove all…* for it (`kindPlural` is the kind's plural name, `privacy.kind.<kind>.plural`). Bulk work
uses `heldInSlices` (`src/shared/review/slices.ts:103`), one undo step, and *Remove all* keeps a
version first, as Review does today (`ReviewPanel.tsx:398-405`).

**Done reviewing.** In the header while private rows wait. It keeps every waiting private suggestion
in one undo step, after a confirm (`doneConfirm`, with `doneCheck` when Check rows are among them;
focus starts on *Cancel*). The export note's "still to check" line then goes away.

**Badges** on a row: *Check*, *Said aloud*, *Covers an area*, *Not found again*, *Read less often here*.

**Preview.** Selecting a row seeks to its start and plays its stretch as Review does
(`src/shared/review/preview.ts:51-70`), with the covers drawn. *Peek* and *Listen* are toggle buttons
on the row (§2.8).

### 2.8 Peek and Listen

- **Peek** (`aria-pressed`) shows the selected row's covers as 2 px outlines in the accent colour,
  so the user sees what is under them, in the editor's preview only. The command *Peek under covers*
  does the same for every cover while it is on. A banner sits over the preview while anything is
  peeked:

  | Key | English |
  |---|---|
  | `privacy.peek.banner` | Peeking under covers. Exports still cover them. |
  | `privacy.peek.stop` | Stop peeking |

- **Listen** (`aria-pressed`, on rows with a bleep) plays that bleep's original sound in the preview
  only.
- Peek and Listen are cleared when Review closes, when the project closes, before any export or
  guide shot starts, and after 60 s without input. They never reach an export, the export dialog's
  preview, a thumbnail, a guide shot, a join still kept for export or the AI (§8.6, §9).

### 2.9 What Find does not see

The disclosure of §2.1 and the dialog's footer list, one message each (`privacy.notSee.*`):

| Key | English |
|---|---|
| `privacy.notSee.scripts` | Text in Bangla, Hindi, Arabic or other scripts the reader does not know. |
| `privacy.notSee.small` | Text smaller than about 9 pixels high, or blurred by motion. |
| `privacy.notSee.unlabelled` | Codes and passwords shown with no label near them, like an authenticator app's codes. |
| `privacy.notSee.pictures` | Text inside pictures, videos and handwriting, and faces. |
| `privacy.notSee.off` | Kinds that are off: street addresses, password dots and random-looking text. |
| `privacy.notSee.said` | Secrets said aloud when the video has no captions, or that the captions got wrong. |
| `privacy.notSee.check` | Always watch the video before you share it. |

### 2.10 Polish

`PolishDialog.tsx` gains the row *Find private info* (`review.polish.step.privacy`, "Find private info";
hint `review.polish.hint.privacy`, "Covers passwords, keys, codes and other private text, and bleeps
secrets said aloud.") after *Camera director*, only when the reader is downloaded. It is on in
`DEFAULT_POLISH_OPTIONS` and read as off from saved options (`readPolishOptions`,
`src/shared/editor/polish.ts:393`), like every step added after options were saved. Its result line
in Polish's summary follows the other steps' style ("Smooth cuts at 4 cuts"):
`review.polish.result.privacy`: `Find private info: {count, plural, =0 {nothing private found} one {{n}
private item} other {{n} private items}}`, or with Check rows `review.polish.result.privacyCheck`:
`Find private info: {count, plural, one {{n} private item} other {{n} private items}} · {check} to check
in Review`. Without the reader the step is skipped with `review.polish.skip.noReader` ("The text reader
is not downloaded.").

### 2.11 The guide

*Blur an area…* and *Blur the typed text* (`GuidePanel`, `guideRun.ts:231`, `:246`) keep their labels
and now add a cover over the box and times the blur shape had, in one update, coloured from the
step's own shot frame (§8.4). A hint under them (`privacy.guide.covered`): "The area is covered with a
solid box in the video and in every screenshot." Blur shapes made before stay as they are.

The shot viewer shows `privacy.guide.notChecked` ("Find private info has not checked this video.")
above *Also send the screenshots* when that is ticked and the project has never been through Find.

### 2.12 The export dialog

A note above *Export* (P5 `PrivacyExportNote`), shown only when the project hides something or Find
is running, so the dialog of a project without covers, bleeps or privacy shapes is unchanged.

| Key | English |
|---|---|
| `privacy.export.hides` | `{count, plural, one {This video hides # private item.} other {This video hides # private items.}}` |
| `privacy.export.toCheck` | `{count, plural, one {# is still to check.} other {# are still to check.}}` |
| `privacy.export.review` | Review |
| `privacy.export.running` | Find private info is still running. The export covers only what it has found so far. |
| `privacy.export.wait` | Wait for Find |
| `privacy.export.captionsChanged` | The captions changed after Find listened to them. Find again to check what is said. |
| `privacy.export.findAgain` | Find again… |
| `privacy.export.recordingsOff` | The original recordings are not saved while this video hides something. |
| `privacy.export.recordingsSkipped` | The timeline was not saved: it used the original recordings, and this video hides parts of them. |

- *Review*, *Wait for Find* and *Find again…* close the dialog first and then open Review, keep the
  dialog open with Export disabled until Find ends, or open §2.5 (finding 30).
- In *Also save › Timeline*, the *Uses: The original recordings* choice is disabled with
  `privacy.export.recordingsOff` as its description while the project hides something (§9 row 10). A
  preset or saved bundle choice of *The original recordings* loads unchanged; Export goes ahead and
  the done view lists `privacy.export.recordingsSkipped`.

### 2.13 Captions, translations and transcription

- **Captions tab** (Languages section, `LanguagesSection.tsx`): a translation with private bleeps not
  yet translated again shows `privacy.translated.masked`: "Captions over secrets said aloud show as
  •••• in this language until you translate it again." The existing line "Bleeped words are not
  masked in translations" (`captionTracks.ts:205`) stays as it is; it is about ordinary bleeps.
- **Transcribe with a service** (the transcription choices): when *Find private info* has run with
  *listen*, or the project has private bleeps, `privacy.transcribe.hears`: "The service hears
  everything said in the video, secrets too. Bleeps apply only to what Flown makes from it." The
  sound is not muted (decision 7).
- **Bleeps list**: private bleeps are listed in the Captions tab's bleeps list as
  `privacy.bleep.item`: "Secret said aloud: {kind}, {start}" and never show the word.

### 2.14 Settings › Private info

A new section in Settings (`SettingsSection` gains `'privacy'`, after `'localAi'`;
`src/renderer/src/settings/SettingsDialog.tsx:22`). The nav label is `settings.privacy.title`
("Private info").

| Key | English |
|---|---|
| `privacy.settings.reader` | Text reader |
| `privacy.settings.readerAbout` | Reads text on screen on this PC: PaddlePaddle's PP-OCRv6 models (Apache-2.0), 27.6 MB, from Qbexel's copy. |
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

The names and never-hide lists are kept in `editor-prefs.json` under the new key `privacy` (§4.5).
They are private: they never go to logs or diagnostics (§10.6).

### 2.15 Command palette and shortcuts

Three commands in `COMMAND_LIST` (`src/shared/editor/commands.ts:42`), category *Add* and *View*, with
no default key (`DEFAULT_KEYMAP` unchanged, as every wave-10 to wave-12 command):

| Command id | Title (`commands.title.<id>`) | Keywords |
|---|---|---|
| `addCover` | Add a cover | privacy hide redact secret password solid box |
| `findPrivate` | Find private info… | privacy redact secret password email key token scan |
| `peekCovers` | Peek under covers | privacy show hidden covers |

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
| D3 | How covers move | A path of boxes over time, from the look pass's shifts and the reader's positions (§5) | A fixed box per read: uncovers text during every scroll. Optical flow over the whole frame: too slow on a laptop and wrong on text. Following by OCR every frame: 2.5 s a frame (§5.11). |
| D4 | When a cover ends | Only on evidence the text is gone: a read finds no part of it and the template search fails (§5.8) | At the next change in its region: a scroll would end it with the text still on screen (the first version's blocker). A fixed time: either too short or too long. |
| D5 | Where the text rules run | In main, on the reader's lines; only covers reach the renderer (§5.7) | In the renderer: the screen's text would sit in the renderer's memory and could reach React state, logs or a crash report. |
| D6 | Which reader | `ssw-ocr.exe` with tract and PaddlePaddle's own PP-OCRv6 ONNX files (decision 1) | ONNX Runtime: +5.4 MB and cannot be downloaded, because nothing downloaded may run. Windows.Media.Ocr: needs package identity (MSIX or a package with external location); a later option after decision 8. Tesseract: weaker on screen text and on small fonts. RapidOCR's conversions: their licence covers only some files. |
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
- Re-reads and following seek to the nearest key frame (§5.6).
- The guide's *Blur an area…* takes its colour from the step's own shot frame (§8.4).
- A16, the rendered tracking set, and the A2 variants are end-to-end tests (§17.3).
- Every numbered test is its own test (§17).

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

/** A place a suggestion was removed from: Find again suggests nothing of `kind` inside it. */
export interface RejectedPlace {
  kind: PrivateKind
  start: number
  end: number
  x: number
  y: number
  w: number
  h: number
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
  `shapesLayer.ts:43`), and its drawn box is the union of its boxes over that window. A decoder that
  shows the next or the previous frame never shows a line the cover moved off.
- **Rounding**: `writePath` writes x and y rounded down and x + w and y + h rounded up to 4 decimals
  (0.19 px at 1920), so a written path never shrinks a box. `t` is rounded to the millisecond, down
  for the first key and to the nearest for the others; `start` rounds down and `end` up.
- **Why a string**: `project.json` is written with `JSON.stringify(project, null, 2)`
  (`src/main/projectsIpc.ts:37`), which puts every number of an array on its own line. A 2,000-cover
  project with 50 keys each is about 3.5 MB as strings and about 14 MB as arrays.
- **Limits**: at most `MAX_COVERS = 2000` covers and `MAX_KEYS = 200000` keys in a project. Find
  never writes more (§5.10, `mergeCovers`).

### 4.3 Readers (`src/shared/privacy/coverData.ts`, contracts, in full)

- `readCovers(raw: unknown, duration: number): Cover[] | undefined`: one linear pass (finding 17).
  - Drops anything that is not an object, or has no string id (or a repeated one), no finite
    `start < end`, or a path that does not parse. Clamps times to `[0, duration]`; drops a cover
    shorter than 0.02 s.
  - Keeps `color` when it is `#rrggbb`, else `COVER_DARK` (`'#1c1c22'`, the `--surface-2` token).
  - Keeps `found`, `kind`, `group` (1-32 characters of `[A-Za-z0-9_-]`), `lost`, `thin` and `missed`
    only when valid.
  - Boxes are clamped to the frame (x and y in 0..1, w and h at least 0.002 and at most 1 - x, 1 - y).
  - A file Flown wrote never exceeds the limits of §4.2. A hand-edited file that does is read
    without losing cover: a cover over `MAX_KEYS_PER_COVER` keys becomes one key holding the union
    of all its boxes; past `MAX_COVERS`, covers are merged by `mergeCovers` (§5.10), which only ever
    grows boxes and times. Nothing a file covers is ever uncovered by reading it (finding 20).
  - Returns `undefined` for absent or empty input, so absent stays absent.
- `readPrivacy(raw: unknown, duration: number): ProjectPrivacy | undefined`: kinds from
  `PRIVATE_KINDS` only, at most 5 regions of two upper-case letters, at most 200 names and 200
  never-hide words of 1-80 characters each (NFC, one line), `find` with a valid ISO time, at most 5,000
  rejected places with valid boxes and times. Unknown fields are dropped.
- `isPrivateBleep(b: Bleep): boolean`: `b.word.startsWith(':')`.
- Both readers are idempotent: reading what they return gives the same value.

### 4.4 Private bleeps

A private bleep is an ordinary `Bleep` (`types.ts:873-882`) with:

- `word: ':' + kind`, for example `':card'`. `bleepKey` of any caption word never starts with `:`
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
screenshot shows the same boxes. The residual risk (decision 5): during the rectangle's 0.15 s fades
only the mosaic hides the text, and a piece's union box may hide more than the cover did.

### 4.7 Migration (`src/shared/engine/project.ts`)

`migrateProject` (`:145`) destructures `covers` and `privacy` beside the other optional fields
(`:151`) and adds `...opt('covers', readCovers(covers, duration))` and
`...opt('privacy', readPrivacy(privacy, duration))`; before reading `shapes` it removes the legacy
shapes (§4.6). A project without either field migrates to the same keys and bytes as before. Copies
carry covers by spread: `projectCopy` (`src/shared/editor/duplicate.ts:75-90`), `clipCopy`
(`src/shared/clips/clipCopy.ts:141-153`) and `short60.ts:269`. A clip copy keeps only the covers that
overlap its range, mapped like its other items, and keeps the private Review rows waiting
(`clipCopy.withinRange`, `:106-113`, skips the `private` kind; §14.3).

### 4.8 Crop

`cropProject` (`src/shared/engine/crop.ts:247-267`) maps `covers` like `shapes`: every key's box through
`rectToCrop` (`:149`), memoised per list in its own WeakMap beside `mapped` (`:225-236`). While the
crop tool is open the scene has no crop and the whole frame (`Editor.tsx:507-511`), so covers show in
place. A cover entirely outside the crop is dropped from the view (nothing of it is shown), never
from the project.

### 4.9 What older and newer Flown do with each field

| Field | This version | An older Flown |
|---|---|---|
| `covers` | read, drawn, edited | kept on save (`...rest`), not drawn |
| `~cover:` shapes | dropped on load, written on save | drawn as pixelate + opaque box, kept, editable |
| `privacy` | read | kept on save, unused |
| private bleep (`word: ':card'`) | private: listed under Private, masked everywhere | an ordinary bleep: muted, masked by time in captions |
| `maskedFor` on a track segment | used (§7.4) | dropped on save by its track reader; this version then masks that caption whole again (the safe side) |
| `privacy` in `editor-prefs.json` | read | kept |

---

## 5. The detection pipeline

### 5.1 Overview

Find runs as one long job in main (`src/main/privacy/scan.ts`, P4), like the scene scan
(`src/main/sceneScan.ts`): below-normal priority, one per project, stopped by `stopAnalyses`
(`src/main/analysisIpc.ts:210`) when the project closes or is deleted, and by *Stop*.

```
renderer                         main (scan.ts)                          ssw-ocr.exe (helper)
FindDialog ── find:start ──────▶ flush check, load project.json
                                 open ───────────────────────────────▶ hash models, parse (§10.2)
                                 look ───────────────────────────────▶ ffmpeg (look scale) → tiles, moves
                                 ◀── look batches (no pixels, no text)
                                 planReads (P4 plan.ts, pure)
                                 read ───────────────────────────────▶ ffmpeg (seek to key frame) → tiles,
                                 ◀── lines: boxes, text, spans, ring      detector, recogniser, QR class
                                 detectFrame (P3, pure) on every read
                                 careful (lines to read again) ──────▶ small recogniser
                                 ◀── second reads
                                 follow ─────────────────────────────▶ gradient templates per part
                                 ◀── positions per frame
                                 found items (P4 found.ts): groups, paths, scores; no text
◀── find:result (covers only) ── text forgotten
privacyRun: detectSaid on the
captions (P3, in the renderer);
one store.update (afterGestures)
```

- The screen's text never leaves main and the helper. The renderer receives covers (boxes, times,
  kinds, colours, groups), never text (D5).
- The spoken rules run in the renderer on the captions it already holds (§7.2), so Polish can run
  them on the captions it has just made (decision 11).
- Main flushes nothing itself: the renderer saves the project (`projects:saveSync`) before
  `find:start`, and main reads `project.json` for `capture`, `width`, `height`, `duration` and the
  file names. Covers and choices travel in the request.

### 5.2 The look pass (helper `look`, P2; planning in `look.ts`, P4)

The look pass decodes every frame once at a small size and records, per analysed frame, which
tiles changed and how each changed region moved. It holds no pixels and no text afterwards.

- **Decode**: the helper runs the bundled `ffmpeg.exe` (path from main) inside a job object (§10.4):
  `-hide_banner -nostdin -threads 2 -i screen.mp4 -map 0:v:0 -vf
  "scale=W/k:H/k:flags=area,format=gray,showinfo" -f rawvideo -`. `showinfo` gives each frame's exact
  `pts_time` and `iskey`, so every time in Find is a frame's own time, and the key frames are known
  for the reads (§5.5).
- **Look scale** `k = max(4, ceil(sqrt(W·H / (480·270))))`: 480×270 for 1080p, 480×270 for 4K
  (k = 8), 640×180 for 7680×2160 (k = 12).
- **Step**: every frame up to 30 fps; every second frame at 60 fps (`step = ceil(fps / 30)`). Text
  that shows for less than two frames is not followed between reads; a read can still find it
  (§5.4).
- **Tiles**: 8×8 look pixels (32×32 video pixels at 1080p). A tile changed when its mean absolute
  difference from the last analysed frame is over 2.0 levels or its largest over 24 levels.
- **Regions**: changed tiles joined by 8-connectivity, merged when within 2 tiles, each as its
  bounding box.
- **Moves**: for a region of at least 12×6 tiles, the row and column profiles of its gradient
  magnitude are compared with the last frame's by normalised cross-correlation (NCC) over shifts of
  up to half the region's size. The best shift and up to two alternatives scoring at least 0.85 of
  the best are kept; a diagonal candidate (dx from the columns, dy from the rows) is kept when the
  region's 2-D gradient NCC at it is 0.9 or more. Each move: `{ box, dx, dy, score, alt: [dx, dy,
  score][] }` in video pixels.
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

`cursor.json` holds no typed text (`src/main/recording/keystrokes.ts:1-6`, read only).

### 5.4 Which frames and areas to read (`planReads`, P4 `plan.ts`, pure)

`planReads(look: LookData, hints: ReadHints, size: Size, fps: number, budget: number): ReadPlan`
returns reads `{ t, areas: Box[], why }` in time order. A **unit** is one 1920×1088 tile's area; a
read's cost is its area in units (at least one tile per area).

1. **First frame**: the first non-black frame, whole.
2. **Settle reads**: for each burst of changes in a region (changed frames less than 0.3 s apart), the
   first analysed frame at least 0.3 s after the burst in which the region is still, or the frame just
   before the next burst when it comes sooner. The area is the union of the burst's changed tiles,
   padded by 64 video pixels.
3. **Scroll reveals**: during a move lasting over 1.0 s, every 0.75 s, the strip that came into the
   region since the last read of it.
4. **Typing reads**: 0.3 s after each typing burst ends and after each paste: a 640×200 px box (at
   the recording's pixels) around the click before the burst when positions are valid, else the
   changed regions since the burst started.
5. **Periodic reads**: the whole frame every 60 s in which no read covered half of it.
6. **Budget**: `budget = ceil(duration / 8) × min(2, W·H / (1920·1080))` units (150 for 20 minutes
   at 1080p). Over budget, steps 1, 2 and 4 are kept and steps 3 and 5 are thinned (reveals every
   1.5 s, periodic every 120 s); covers made from thinned spans are marked `thin` (§2.2). Settle reads
   of the same region within 1 s are merged before anything else is thinned. Nothing is dropped
   silently: the plan counts what it thinned and the scan's result reports it.
7. **Estimates** (§5.11): the dialog shows the first estimate from the recording's length, size and
   frame rate; the progress line replaces it with the second, from the plan's units and the measured
   look speed, once the look pass ends.

### 5.5 Reading a frame (helper `read`, P2)

- **Decoding**: reads are sent in time order, in batches of reads less than 10 s apart. For each
  batch the helper starts ffmpeg at the key frame at or before the batch's first frame (`-ss <key t>
  -i screen.mp4 -copyts`, the key frame from the look pass) and keeps only the planned frames
  (`select` by `pts`), as RGB24 at full size. A read never decodes from the start of the recording.
- **Too large**: a recording over 7680×4320 or 40 megapixels is refused before decoding (`tooLarge`,
  §10.3).
- **Tiles**: each area is cut into tiles of at most 1920×1088 that overlap by 64 px, zero-padded to
  multiples of 32. The detector runs on each tile with a concrete plan per tile shape (at most 4
  shapes kept).
- **Detector post-processing** (PP-OCRv6's own `inference.yml`): threshold 0.2, box threshold 0.4,
  unclip ratio 1.4, at most 3,000 candidates; minimum-area rectangles; a line tilted more than 2°
  is cut with a rotated crop.
- **Joining across tile edges**: two boxes from neighbouring tiles that overlap inside the overlap
  band, on the same baseline within 25% of their height, are joined, and the joined line is read
  again. Boxes inside one tile are never joined.
- **Recogniser**: each line is scaled to height 48 and padded to the next width bucket of 320, 448,
  640, 896 or 1280 (concrete plans; tract runs symbolic widths 3.7-7 times slower). A line wider than
  1280 at height 48 is cut into 1280-wide chunks overlapping by 64, read, and joined at the overlap.
- **CTC decoding** with the model's character list (from its `inference.yml`); each character's
  x-range comes from its CTC columns (`scripts/privacy/ppocr.py:180-197`), mapped back to video
  pixels.
- **Ring colour**: for each line, the median RGB of a 2 px ring just outside its padded box, and the
  largest per-channel median absolute deviation as its spread (§8.4).
- **QR codes**: rqrr on each area's grey image; the helper returns each code's quad and payload, which
  main classes and forgets (§6.9).
- **Line crops** are kept in the helper until main sends `careful` or `release` for that read (§5.6),
  at most 3 reads' crops at once.
- **Answer**: `{ id, t, lines: [{ box, quad, variants: [{ model, text, conf, spans }], ring, spread }],
  qr: [{ quad, payload }] }`, or `{ id, error }`. Reads answer in command order.

### 5.6 The careful pass, and what the reader measures

Main runs the text rules (§6) on each line's tiny read and sends back `careful { id, lines }` for every
line that has a rule hit, a confidence under 0.9, or a run of 16 or more token characters
(`[A-Za-z0-9_\-+/.~]`) after cleaning (§6.2): **careful-long** (question 16). The helper reads those
lines again with the small recogniser and adds the variant. Then main runs the rules on every variant
and keeps the union of the hits (§6.1).

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

**Failures.** Each read runs inside `catch_unwind`. A failed read answers `{ id, error }`: main marks
its areas as a lost area from that frame until the next good read of them, and counts it for
`privacy.run.failedReads` (finding 23). If the helper process dies, main starts it again once per
Find, opens the models again and goes on from the failed read; a second death ends Find with what it
has, as *Stop* does (§2.6).

### 5.7 From lines to suggestions (main, `scan.ts`, P4; the rules are P3's)

- `detectFrame(lines, context)` (P3, §6) runs on every read with the read's lines (every variant),
  the rows and columns they form, the frame size, the kinds on, the regions, the names and never-hide
  lists. It returns hits `{ kind, rule, score, spans: { line, start, end }[], box }` where `spans` are
  own spans (§6.1).
- A hit's **cover box** is the union of its own spans' boxes, padded by max(3 px, 0.35 × line height)
  vertically and max(that, one mean character width) horizontally, clipped to the frame (finding 22).
  Keys and PEM blocks use their block's full width (§6.4).
- A hit's **group key** is its own text folded (§6.2), kept in main's memory only. Hits of one run
  with the same group key share one random group id (`group`, 12 characters).
- QR codes give hits of kind `qr` with their quad's box padded by 4 modules' worth (the quiet zone).
- Pop-up notifications come from the look data (§6.13), not from reads.
- Hits below 0.50 are dropped. A hit at 0.85 or more is `found: 'auto'`, else `'check'`. A
  suggestion's score is the highest of its reads while it is followed; a later read never lowers it.
- Each hit is then followed (§5.8) into a path.
- The texts, group keys, lines and templates are dropped when Find ends. Nothing of them is written,
  logged or sent to the renderer.

### 5.8 Following

Every hit starts at its read frame R with its cover box and its **parts**: its own box cut into equal
parts no wider than 6 line heights each, at most 3. Main asks the helper to follow (`follow`), which
decodes the frames it needs at half size (the template scale), seeking to key frames.

**Templates.** At R, each part's box padded by 25% of the line height, cut from the half-size grey
frame, as Sobel gradient magnitude. Gradient magnitude does not change when text is selected or
inverted (dark mode, a highlight), so one template serves both.

**Forward walk.** For each analysed frame f after R:

1. If no tile under the cover's box changed, the box holds (no key).
2. **Candidates**: the moves of the regions overlapping the box at f (best and alternatives), no
   move, and the **speed guide**: the last placed move per frame times the frames since.
3. For each candidate, each part is matched by gradient NCC at its predicted place ± 4 template
   pixels.
4. **Placed** when at least one part scores 0.6 or more, the best candidate beats the next by 0.15 or
   more (one clear best match), and the placed parts agree within 2 px. The box moves by that
   candidate; a key is written at f.
5. **Not placed** while the region changed: the cover becomes a **lost area**. Its box at f is the
   union of the box moved by every candidate. When no candidate scored 0.4 or more, it is the union
   of the box and every changed region it overlaps, as a 2-D box (finding 4: never a band along one
   axis). The last placed templates are tried at every later changed frame; one clear match places
   the cover again.
6. **Zoom inside the recorded app** (the whole region changed with no profile match): the parts are
   also tried at scales 0.8, 0.9, 1.1 and 1.25 about the region's centre before the cover is lost.

**Evidence of absence.** A cover ends only when the text is shown to be gone:

- its region changed at frame C, and
- the next read covering its box or lost area, at frame S, finds no line holding the text (the folded
  own text, or for a text of 12 characters or more, any third of it), and
- the template search at S finds no part scoring 0.5 or more anywhere in the region.

It then ends at the first changed frame from C on at which no part matches (at most 16 frames are
checked; at S when more), plus one frame. Until then it goes on, placed or lost, with no time limit.
A read that finds the same group key again re-anchors the cover there, and the walk backward from
that read corrects the path to the last placed frame (the lost area between them stays).

**Backward walk.** From R back to the start: the box at f is the box at f + 1 moved back by the move
the look pass found **between f and f + 1** (finding 3: never the move of f − 1 to f). The same
placing and lost rules apply. It stops at the first frame f at which the region changed and no part
matches: the cover starts at f + 1. A page change (30% or more of the frame changed,
`SCREEN_RULES.page`, `src/shared/smart/screenChanges.ts`) with no match stops it as well. So text that
scrolled into view before its first read is covered from when it appeared.

**What this handles** (each is a case of A16, §17.3): scrolling lists and pages (vertical moves),
horizontal scrolling, a window dragged across the screen (2-D moves), a sticky header (its tiles do
not change, so covers in it hold while the body scrolls), a selection or highlight drawn over the text,
zoom in the app, and toasts sliding over covered text (the cover is lost under the toast and placed
again when it leaves).

### 5.9 *Follow what is under it* and *Cover this text everywhere*

- **Follow** (`followCover`, P4; run from P1's `followRun.ts`): main reads the cover's box at the
  playhead's frame; the lines at least half inside it make the template and the group key. The walks
  of §5.8 run from there. The result is the old path's union with the new one: the cover never covers
  less than it did. Without the reader, the template is the raw box itself, following is by template
  only, and the cover ends only where the region changed and the template fails; the result is marked
  `thin`.
- **Everywhere** (`coverEverywhere`, P4; P1's `EverywhereDialog.tsx`): main reads the text under the
  cover as for Follow, then looks for the same folded text in the last Find's reads of this project
  (kept in main's memory for the session) or, when there are none, runs Find with that text as the
  only listed name and every other kind off. Each place is followed and added as a cover of kind
  `text` in a new group, in one undo step. *Also add it to this video's names to hide* (off by
  default) adds the text to `Project.privacy.names`, the user's explicit choice to keep it there; the
  dialogs that show the list read it again from the project afterwards (finding 28).

### 5.10 Find again, groups, merging and applying (P4 `found.ts`)

- **Find again never uncovers anything.**
  - Covers the user owns (no `found`) are never changed.
  - A new suggestion is dropped as a duplicate only when one existing cover contains it: at every key
    of the new path and every key of the existing path inside the new one's times, the existing
    drawn box (with slack) contains the new box (`containsOver`, §16.0). Overlap is not enough.
  - The last run's suggestions that this run did not find stay, marked `missed: true`, with their
    group; a later run that finds them again clears the mark.
  - A new suggestion of a kind whose every key box lies at least 80% inside a rejected place of the
    same kind (§4.1), within that place's times, is not added. A removed place never suppresses
    another kind.
- **Groups**: one Review row (§2.7). Covers of one group that overlap in time (or are within 0.5 s)
  and whose boxes overlap are merged into one cover whose path is the union.
- **Limits**: over `MAX_COVERS` (2,000) covers, `mergeCovers` merges the cheapest pairs first (same
  kind before any kind; cost = added area × added time), with a heap, O(n log n) (finding 7), until the
  count fits. Merging only grows boxes and times. A drawn cover is never dropped. Over `MAX_KEYS`,
  the longest paths are simplified into fewer keys whose boxes are unions of the keys they replace.
- **Applying**: the result is applied with `withFoundCovers(project, result)` (P4) in one
  `store.update` scheduled with `afterGestures` (`src/shared/editor/editStore.ts:299`), against the
  project as it is when the result lands, so a drag during Find is never overwritten and never
  overwrites the result (finding 16). The same update adds the private bleeps of §7.2, sets
  `Project.privacy.find` and clears `missed` where it applies.
- **Stop**: what was found so far is applied the same way; covers whose walks were not finished run to
  the end of the recording as lost areas (§2.6).

### 5.11 CPU and memory budgets

For a **20-minute recording at 1920×1080 and 60 fps** (72,000 frames, H.264 as Flown records) on a
**4-core laptop** (the reference PC of decision 8). Find uses at most three threads, all at
below-normal priority: ffmpeg's decoder with 2 threads, and the reader on 1. The editor keeps the
fourth core.

| Stage | Work | CPU | Basis |
|---|---|---|---|
| Look: decode | 72,000 frames decoded and scaled to 480×270 grey | 110-240 s on 2 threads (1.5-3.3 ms a frame) | estimate for software H.264 at 1080p; measured on the reference PC before release |
| Look: analysis | tiles and moves on 36,000 analysed frames | about 15 s | 0.4 ms a look frame (estimate) |
| Reads | 150 units (§5.4) with careful-long | 150 × 2.9 s ≈ 435 s on 1 thread | measured tract times (§5.6) on this machine |
| Rules | 150 units × 37 lines × 1.3 variants | under 3 s | prototype: 40-250 µs a line |
| Follow: decode | the frames with moves near covers, about 15%, at half size | 20-45 s | estimate |
| Follow: matching | parts × changed frames | under 10 s | 0.05 ms a part a frame (estimate) |
| **Wall time** | the look pass runs ahead; reads and follows of each minute run while the look pass decodes the next | **8-10 minutes** | 0.4-0.5 times the recording's length |

| Process | Peak memory |
|---|---|
| `ssw-ocr.exe` | ≤ 700 MB: the detector's tile plan 250 MB, tiny recogniser plans (5 buckets) 85 MB, small recogniser plans 259 MB while a careful batch runs (dropped after it), frames and crops ≤ 60 MB |
| `ffmpeg.exe` (look or read) | 120-200 MB |
| main (scan state) | ≤ 60 MB: look data 11 MB, the run's lines and texts, the paths |
| renderer | the covers only: under 5 MB for 2,000 covers |

- **4K** (3840×2160): the look scale keeps the look frames at 480×270, but decoding is about four
  times the work; reads take up to twice the units (§5.4). Estimated 2-3 times the 1080p wall time.
  **7680×2160**: eight tiles a full read. Both are measured on the reference PC (decision 8).
- **First estimate** (before Find starts, §2.5): `frames × decodeMs(W·H) / 2 + 150 units × 2.9 s ×
  (duration / 1200 s)`, with `decodeMs` 2.5 ms for 1080p scaled by area, replaced by this PC's
  measured speed once one Find has run (kept in `userData/reader-models/models.json`).
- **Second estimate** (after the look pass, §2.6): from the plan's units, the read speed measured on
  this run's first reads and the follow spans.
- **Recording in progress**: Find does not start while Flown records, and a recording that starts
  suspends Find's helper and its ffmpeg (`suspend`, through the job object) until it ends. Main reads
  the state with `isToolbarVisible()` (`src/main/windows.ts`, called as `busyReason` does at
  `src/main/updates/updatesIpc.ts:33`, never edited), every 2 s while Find runs.
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
  padded by max(3 px, 0.35 × line height) vertically and max(that, one mean character width)
  horizontally, clipped to the frame, never rounded past its edge (finding 22). The stand-in scorer
  measured that one character width plus a quarter line height is the smallest pad that fully covers
  a 4-character PIN; 0.6 of a character width left it 96% covered.
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
  allowed: "Router admin PIN · From the sticker · 58204716").
- **Under**: the line above is a short label line (40 characters or fewer, 4 words or fewer, the label
  taking all but 10 characters); the whole line is the value.
- **PEM block**: from a BEGIN line, every line below in the same column to the END line (dashes
  optional), at most 60 lines, across the block's full width. Without an END line, or when the reader
  returned no lines between BEGIN and END, the cover runs to the bottom of the text region as a lost
  area.
- **Continuation**: a hit that runs to the end of its line continues on the next line when that line
  starts within 2.5 line heights below at the same left edge (within one line height) with 4 or more
  token characters that are not a plain word. The prototype required the line to reach its block's
  right edge; **new**: that requirement is dropped for JWT, link and key hits whose last character is
  a token character or a dash, which closes the held-out misses of a token wrapped after `R7-` and of
  JWTs wrapped inside a box. At most 6 lines are chained.
- **JWT head** (**new**, 0.90): `e[yv][JIl1][A-Za-z0-9_-]{10,}\.e[yv][JIl1][A-Za-z0-9_-]{4,}` at the
  end of a line, a JWT whose third part is on later lines; it starts a continuation.
- **One space in a key** (**new**): on the prefix view, a strong-prefix token followed by a single
  space and 6 or more token characters with no space is read as one token when the joined token
  matches the rule and the parts alone do not (`sk-proj-6Pwp… S9f1s…` on the held-out set).
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

In whole-screen recordings (`capture.target === 'screen'`) only. A **notice** is a changed region that:

- appears in one analysed frame from still surroundings, rectangular (its changed tiles fill 80% or
  more of its box);
- is 12-30% of the frame's width and 5-35% of its height;
- has its right edge within 3% of the frame's right edge, and its top within 15% of the top or its
  bottom within 15% of the bottom (Windows' and browsers' notification corners);
- is still inside (no moves, fewer than 10% of its tiles change per second) while it shows;
- disappears 2-30 s later, or when the recording ends.

Each notice gets a Check cover (0.70, kind `notice`) over its box for its whole life, from the frame
it starts sliding in. **Stacked notices** (finding 5): notices whose boxes touch or overlap in time and
space are covered each, and the union of the stack is covered while two or more show. Decision 8
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
  | email | `<1-4 words> (at, at the rate, অ্যাট, এট, arroba, एट) <domain word> (dot, ডট, punto, डॉट) <tld word>`; and every caption's text run through the screen's email and key rules (Whisper writes `jsmith@gmail.com` as one token) |
  | name | a caption word whose double-metaphone codes equal a listed word's and within edit distance 2 (Latin script); Bangla-script words against Bangla entries by edit distance of their NFC forms |

- Bangla and Hindi words are compared in NFC with punctuation and symbols removed only
  (`[\p{P}\p{S}]`, as `bareWord`, `numbers.ts:42-49`), never "everything not a letter or digit", which
  strips vowel signs and the nukta. য়, ড় and ঢ় are composition exclusions, so every word list is
  normalised with the same NFC at build time. The Bangla lists need the native review of decision 8.
- Measured on Flown's docs read as speech (455,764 words): 8 hits, 0.18 per 10,000 words. A 20-minute
  talk is about 3,000 words.
- **Each hit becomes a private bleep** (§4.4) from its first word's start − 0.05 s to its last word's
  end + 0.05 s (0.15 s for estimated times, as `Bleep` widens), `auto: true`, kind marker in `word`. A
  hit inside an existing bleep adds nothing. Over `MAX_BLEEPS`, neighbouring private bleeps of the same
  group within 1 s are merged first; a found secret is never dropped.

### 7.3 Spoken forms (`spokenForms`, contracts, `src/shared/privacy/spoken.ts`)

`spokenForms(project): SpokenForms`, computed once per `transcript` and `bleeps` array (WeakMap), holds
for each private bleep:

- the caption words at least half inside it, as written and folded;
- for numbers, the digits of the run in that bleep, as a digit string, and its usual written groupings
  (4-4-4-4, 3-3-4, 3-2-4, spaced and dashed);
- for emails said aloud, the address as written (`name@domain.tld`).

`maskPrivate(text, forms): string` replaces every occurrence of a form in `text` (case-insensitive;
digits compared on the digit view, ignoring spaces and dashes between them) with `•` for each of its
letters and digits, keeping spaces and punctuation. A form of fewer than 4 letters or digits is used
only as a whole word. `maskPrivate` returns `text` itself when nothing matched, and when the project
has no private bleeps it is never called.

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
  masked text. This applies to `burnedSegments`, the Languages list, the subtitle files (`trackCues`),
  the sidecars (`exportBundleRun.ts:65-73`) and every export.
- **Tidy and Clean up** (finding 13): what they change under a private bleep is still masked by time,
  and the request they send is masked (§7.6), so the service never saw the words.

### 7.5 Every other text made from captions

| Text | Where it is made | How the private forms are masked |
|---|---|---|
| Chapter names, found or made by AI | `src/shared/chapters/names.ts`, `chaptersRun.ts` | stored: `settleSaid` (below) masks the forms in `chapters[].title` |
| Chapter title cards (finding 12) | `titles[]` made from chapters | stored: `settleSaid` masks `titles[].text` and its lines |
| Graphics made from captions (pop-ups, counters, list cards, quote cards) | drawn from caption words with `maskBleeped` | drawn: `maskBleeped` also applies `maskPrivate` when the project has private bleeps |
| Publishing pack (title, description, posts, chapters) | `publishSegments` (`pack.ts:88-91`), `ProjectPublish` | stored: `settleSaid` masks the saved description; made: its segments come from `maskedSegments` |
| Guide step titles and notes | `stepTitles.ts`, `guideSegments` (`:119`), `GuideSettings` edits | stored: `settleSaid` masks the edited titles and notes; made: from masked segments |
| Short clip and shorter-version names | `clipsRun.ts`, `ShortClipsPanel.tsx` | made from masked segments; the copy's own name is masked by `settleSaid` on the copy |
| Search index | `search/extract.ts:67-73` | `maskPrivate` beside `maskBleeped` |
| Review titles for captions | `captionReview.ts` | private bleeps are not listed as *Bleep* rows; their titles never hold words (§2.7) |
| Transcript text export | `transcriptText.ts` | from `maskedSegments` |

**`settleSaid(next, prev)`** (contracts, the last step of the settle chain at `Editor.tsx:228-230`):
when `next.bleeps` or `next.transcript` differs from `prev`'s and `next` has private bleeps, it masks the
spoken forms in the stored texts above, in the same update. It is idempotent (masked text has no
forms left). It returns `next` itself when nothing changed, so projects without private bleeps settle
exactly as before.

### 7.6 AI requests (`aiTextFor`, contracts)

- **One wrapper**: `aiTextFor(project, providerId, request, requestId)`
  (`src/renderer/src/ai/aiTextFor.ts`) calls `maskRequest(request, project)`
  (`src/shared/privacy/aiRequest.ts`) and then `window.api.aiText`. All 9 call sites of §7.1 call it.
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
3. Maps each cover's box from whole-frame coordinates into the picture: through the crop
   (`rectToCrop`, `crop.ts:149`) when the picture is a crop's copy, then to pixels, rounded outward
   (floor the start, ceil the end), clipped to the picture.
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
graded colour. On a tilted card this is drawn on the card's own canvas, so the warp carries it. It
catches anything that could still bring the text's pixels to the output: resampling at the box's
edge, a decoder showing a neighbouring frame, a sub-frame camera whose view differs from the main one.
It is skipped in the `'overlays'` alpha mode and when no cover is active.

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
- Only the player's preview scene sets it, as `comparedScene` sets `compare` (`player.ts:597-600`).
  `ExportDialog` receives `scene`, not the preview scene (`Editor.tsx:2042-2044`); the exporter,
  `ExportPreview`, thumbnails and guide shots build their scenes without it. Every export entry point
  strips `peek` from the scene it is given (test 25).
- `JoinStills.fresh` (`joinStills.ts:45-46`) keys on the peek state as it does on `compare`; its
  stale-still fallback (`:119`) never returns a still composed with another peek state.
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
| 8 | Export bundle sidecars: subtitles (spoken and translated), chapters, description, thumbnail | `exportBundleRun.ts:65-111`, `src/main/exportBundle.ts:38-84` | thumbnail: row 6. Subtitles: `maskedSegments` and the translation masks (§7.4). Chapters and description: `settleSaid` (§7.5) |
| 9 | Timeline for other editors, *This export* | `src/main/timelineIpc.ts:305-372` | points at the covered export; stems carry the private bleeps (row 11) |
| 10 | Timeline, *The original recordings* | `timelineIpc.ts:174-200` `copyRecordings`, `:322-323`; `timelineRun.ts:91-118`; `BundleOptions.timelineMedia` (`exportBundle.ts:32`, `:63`), user presets (`userPresets.ts:30, 110, 154`), `ExportBundleOptions.tsx:263, 310-319` | **Refused** while `hidesSomething(project)` (any cover, any blur or pixelate shape, any bleep). Renderer: the chip is disabled with `privacy.export.recordingsOff`; `timelineRun` skips the step and the done view says `privacy.export.recordingsSkipped`. Main: `writeTimeline` in recordings mode reads `project.json` itself (`migrateProject`) and refuses with `errors.timeline.hidden` ("This video hides parts of its recordings, so they were not copied.") whatever the renderer sent. The editor saves (`projects:saveSync`) before the timeline step, so main reads what the user sees. A preset choosing it loads unchanged (test 20) |
| 11 | Sound stems | `exporter.ts:184-196` `stemsOf`; `src/main/stemsRun.ts`; `src/shared/render/stems.ts:80-104` | private bleeps are bleeps: `jobSoundGains` carries them (`exporter.ts:162`) |
| 12 | Guide, demo and bug-report screenshots (Actual included) | `guideStills.ts:81-163` (drawFrame `:116`), from `guideProject` (`src/shared/guide/shots.ts:42-79`) via `stillsInput` (`useGuideShots.ts:29-48`) | drawFrame. `guideProject` keeps `covers` through `...rest` (the privacy shapes are kept the same way). The shot cache key `shotSig` (`shots.ts:279-293`) and `planActual` (`:305-310`) gain the covers active at `t` (id, colour, drawn box) and the peek-free flag, so an edit never leaves a stale, uncovered shot in the cache (300 shots or 256 MB) |
| 13 | Guide outputs: PDF, HTML, demo HTML, Markdown folder, HTML+text clipboard, one PNG on the clipboard | `src/main/guide/writeGuide.ts`, `printPdf.ts`, `guideIpc.ts:88, 91-95`; `guideRun.ts:113, 138` | pictures from row 12; titles and notes from masked segments and `settleSaid` (§7.5) |
| 14 | Pictures sent to AI (guide *Write titles* with *Also send the screenshots*) | `visionTitles.ts:44-118`, `guideRun.ts:155`, main `src/main/ai/images.ts:41` | the pictures are row 12's shots; the request goes through `aiTextFor` (§7.6); never on this PC |
| 15 | AI text requests (all 9 call sites) | §7.1 | `aiTextFor` (§7.6) |
| 16 | Transcription with a service | `src/main/ai/transcribe.ts:194` | the warning of §2.13; the sound is not muted (decision 7) |
| 17 | Home thumbnails | `Home.tsx:201-238` `captureThumbnail` (drawImage `:231`, `toDataURL` `:232`), cache `:195-199` | `ProjectSummary` gains `thumbCovers?: NormRect[]`, computed in main by `listProjects` (`src/main/projects.ts:147-159`) with `thumbCovers(project, t)`: the drawn boxes of the covers and of the blur and pixelate shapes active at the thumbnail's time (min(1 s, 15%)), with slack. `captureThumbnail` fills them in Dark after drawing the frame and before `toDataURL`; the cache key adds a hash of the boxes. Absent when there are none, so other projects' summaries and thumbnails are unchanged. Question 13: the crop |
| 18 | Filmstrip on the timeline | `src/main/filmstrip.ts:35-50`, `:161`, cache written `:208`; drawn by `src/renderer/src/editor/Filmstrip.tsx` | the tiles are drawn with the cover boxes active at each tile's time filled in Dark (`fillCoverTiles`, P1); the cache file stays raw on this PC, beside `screen.mp4` itself |
| 19 | Project copies: Duplicate, Make vertical or square, Short clips, Shorter version | `projectCopy.ts:154-235` (write `:229`); `duplicate.ts:75-90`, `clipCopy.ts:141-153`, `short60.ts:269` | covers ride `...project`; clip copies keep the covers over their range; written with the legacy shapes (§4.6) |
| 20 | Share after export | `src/main/share/shareService.ts` (`isExported` gate `:20`), `copyToFolder.ts:152`, `webhookPost.ts:37` | exported files only; posted text is the pack's (row 21) |
| 21 | Publishing copy pack | `pack.ts:88-91`, `publishRun.ts:158` | text only: masked segments, `settleSaid`, `aiTextFor` |
| 22 | Search index | `search/extract.ts:67-73` | `maskPrivate` beside `maskBleeped` (§7.5) |
| 23 | Caption contrast probe | `contrastProbe.ts:55-79` (drawFrame `:67`) | reads the covered frame; emits nothing |
| 24 | Internal readers that output numbers only: scene scan, still detection, the look pass | `sceneScan.ts:289`, `analysisIpc.ts:168`, §5.2 | no pixels leave |
| 25 | Logs and diagnostics | `appLog.ts:57` (`redactLine(…, secretValues())`), `diagnostics.ts:93-96` | no found text is ever logged; listed names join `secretValues()` (§10.6) |
| 26 | Versions | `src/main/versions.ts:267-346` | the version body is written with the legacy shapes (§4.6); restoring keeps the covers |
| 27 | Project folder copies by the user (Explorer) | outside Flown | `project.json` holds covers and the legacy shapes; `screen.mp4` is the raw recording, as today. The export note and the help text say covers apply to what Flown makes |

---

## 10. Privacy and security

### 10.1 What stays where

- The screen's text exists only in the helper's and main's memory while Find runs (§5.7). It is never
  written to disk, logged, sent to the renderer or sent off the PC. `Project.covers` holds boxes,
  times, colours, kinds and random group ids; no text and no hash of text (a hash of a 6-digit code
  can be reversed by trying a million values).
- Private bleeps hold a kind marker, never the word (§4.4).
- The names and never-hide lists are the user's own entries, kept in `project.json` and
  `editor-prefs.json` because the user typed them there. *Cover this text everywhere* adds text to the
  list only when its checkbox is ticked (off by default).
- The look cache holds tile bits and moves, no pixels (§5.2).
- Nothing is uploaded. The only download is the reader's files (§5.12).

### 10.2 The models: checked before parsing

- Main checks every file's size and SHA-256 against `READER_FILES` when Find starts. A mismatch deletes
  the file and sets the state to `damaged`.
- The helper's `open` receives the expected size and SHA-256 of each file (from main, which has them
  compiled in from `readerCatalog.ts`, and the helper compiles in the same pins: both must agree) and
  hashes each file before parsing any; a mismatch answers `{ error: 'model' }` and parses nothing
  (test R2). tract parses only files that passed.
- Models are data: nothing downloaded is ever run. The helper itself is signed and installed with the
  app (`resources/native/ssw-ocr.exe`), never downloaded.

### 10.3 Screen content is untrusted

- Recognised text can be anything a web page or a chat showed. It is only matched by the rules,
  never evaluated, never used as a path or a command, never shown in the UI.
- Every rule is linear-time on a line: lines are cut to 512 characters before matching (longer lines
  are matched in overlapping windows of 512), and test 104 runs every pattern on 64 KB adversarial
  strings with a 50 ms limit.
- QR payloads are screen content like the text: main classes them and forgets them (§6.9). rqrr decodes
  with its own bounds; the helper drops codes whose version is over 40 and payloads over 4,096 bytes.
- **Huge frames**: the helper refuses a video over 7680×4320 or 40 megapixels before decoding
  (`tooLarge`), caps a read to 64 tiles, caps the detector's candidates at 3,000 a tile and lines at
  1,000 a read, and splits lines wider than 1280 at height 48 (§5.5). A malformed or truncated video
  ends the read with an error; ffmpeg runs with `-xerror` off and a time limit of 60 s plus the
  recording's length, as the scene scan (`sceneScan.ts`).

### 10.4 The helper process

- Spawned by main with `shell: false` and `windowsHide`, its path from `resources/native/ssw-ocr.exe`
  when packaged and `native/bin` in development (`SSW_OCR_HELPER` overrides it unpackaged only), as
  `src/main/localAi/engine.ts:331, 483-496` does for `ssw-llm.exe`.
- Below-normal priority. A heartbeat line every 2 s, also while `open` hashes and parses the models
  (finding 25); main kills a helper silent for 20 s.
- ffmpeg runs inside a Windows job object created by the helper with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so killing the helper kills ffmpeg (test R8, Windows only).
- **A crash in one read** is caught (`catch_unwind`) and answered as an error (§5.6); a crash of the
  process is restarted once per Find.
- `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)` at start, so no crash dialog appears.

### 10.5 Windows Error Reporting (question 14, recommended (a))

A crash dump of `ssw-ocr.exe` would hold frames with secrets. `build/installer.nsh` gains, in
`customInstall`, a per-user DWORD `ssw-ocr.exe = 1` under
`HKCU\Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications`, and a new
`customUnInstall` macro that deletes that value. The file has no uninstall macro today
(`build/installer.nsh:44-51` holds `customInstall` only). The helper does not call
`WerAddExcludedApplication` itself, so it imports nothing from `wer.dll`.

### 10.6 Logs and diagnostics

- No log line holds recognised text, a QR payload, a group key or a listed name. Main's scan logs
  counts and times only (`privacy: read 37 lines in 2.81 s`).
- The listed names (Settings and the open project's) join `secretValues()`, which `redactLine` already
  takes (`src/main/appLog.ts:57`, `src/main/diagnostics.ts:93-96`), through a getter
  `privateNames(): string[]` in `src/main/privacy/names.ts` (contracts) that the renderer updates with
  `privacy:names` whenever the lists change. Leading and trailing `*` are removed and entries shorter
  than 3 characters are left out (finding 24).
- Diagnostics include the reader's state and model hashes, never `models.json`'s timing of a project.

### 10.7 IPC

New channels (preload `src/preload/privacy.ts`): `privacy:readerState`, `privacy:downloadReader`,
`privacy:cancelReaderDownload`, `privacy:removeReader`, `privacy:find`, `privacy:stopFind`,
`privacy:follow`, `privacy:everywhere`, `privacy:names`, and the events `privacy:readerProgress` and
`privacy:findProgress`. Every handler validates its request (`validateFindRequest`, contracts): a
project id of the project folder's form, kinds from `PRIVATE_KINDS`, at most 400 names of 80
characters, regions of two letters, no paths. Main finds the project's files itself.

---

## 11. Accessibility

- **Keyboard**: every control of §2 is reachable by Tab in reading order. The Covers row is one tab
  stop with roving focus (`aria-activedescendant` is not used; the focused bar has `tabindex=0`):
  Left and Right move between bars, Home and End go to the first and last, Enter selects, Delete
  removes, Shift+Left and Shift+Right move the nearer end by one frame, Escape returns focus to the
  row. Selection follows focus on the row (finding 36).
- **Names**: each bar's accessible name is `privacy.track.item…` (kind, start, end, and whether it is
  waiting or to check). Review rows read their title, place, places count and badges; *Peek* and
  *Listen* are toggle buttons (`aria-pressed`) whose names include the row's title ("Peek: Email,
  0:42 to 3:10"; finding 33).
- **Live regions**: Find's progress is a polite status, announced at most every 10% and at each phase
  change; its result is announced once. Following announces `privacy.cover.followDone` or
  `followNone`.
- **Focus**:
  - Opening *Find private info…* moves focus to the dialog's first checkbox; closing it returns focus
    to the control that opened it; *Find* returns focus to the section's progress line (finding 31).
  - Review's *Show all changes* and the kind filter keep focus on the control used (finding 32); with
    nothing left of a filtered kind, the list says `privacy.review.emptyKind` and focus moves to the
    filter (finding 34).
  - *Follow*'s *Stop* and *Keep* keep focus in the Cover section; when following ends, focus moves to
    the cover's status line (finding 37).
  - The export note's buttons close the dialog first and move focus to Review or the Find dialog
    (finding 30).
- **Contrast** (WCAG AA, `src/renderer/src/styles.css`): text uses `--text-1`, `--text-2` and
  `--text-3` on `--surface-1` (17:1, 7.2:1, 5.4:1). The Check edge uses `--warning` (#fbbf24) on
  `--surface-2` (10.2:1) beside a text badge, so colour is never the only sign. Waiting bars have a
  dashed edge (a shape, not only a colour). Peek outlines use `--accent-400` 2 px wide (4.0:1 on
  `--surface-1`, over the 3:1 that WCAG asks of graphics) with a 1 px `#000000` halo outside, so they
  show on any frame; the banner uses `--surface-overlay` with `--text-1` (17.5:1).
- **Motion**: the progress line has no animation under `prefers-reduced-motion`; Peek's outlines do
  not blink.
- **Screen sharing**: the UI never shows a found text (§2.7), so reviewing on a shared screen does not
  leak it; Peek shows it only in the preview, with a banner.

---

## 12. Languages

### 12.1 Catalogues

- A new namespace `privacy` (`privacy.json`, `privacy.meta.json`) holds every message of §2 that is
  not in `review`, `commands`, `polish`, `settings` or `errors`. The contracts step writes all of
  them, each with a meta entry (its place, its arguments and their kinds, `maxLength` where the UI
  needs one). A part that needs another message adds it to `privacy.json` only, with its meta entry.
- New keys in existing namespaces: `review.kind.private.{chip,name,all,count}`,
  `commands.title.{addCover,findPrivate,peekCovers}`, `settings.privacy.title`,
  `review.polish.step.privacy`, `review.polish.hint.privacy`, `review.polish.result.privacy`,
  `review.polish.result.privacyCheck`, `review.polish.skip.noReader`, `errors.timeline.hidden` and
  the Versions area name `review.versions.area.covers` ("covers"). No existing message changes.
- The scanner (`scripts/i18n/config.json`: `"scan": "fail"`, `"words": "fail"`) covers every new file
  from its first commit: every new file of §16 is added to `failFor` by the contracts step.
- Kind names inside sentences (`{kind}`) come from their own messages (`privacy.kind.<kind>.name` and
  `.plural`), so a translator sees whole sentences with one argument each.
- English stays the only shipped UI language until the reviewers of `docs/design/output-and-languages.md`
  §15 approve the Bangla messages; the new messages go through the same review.

### 12.2 The English guard

The English guard (`tests/e2e/english-guard.e2e.cjs`, tests 9 and 10 of `output-and-languages.md`)
compares the whole English UI with `tests/e2e/english-guard/baseline.json` (3,748,519 bytes, 51
screenshots). This wave adds to these captures and changes no existing text:

| Capture | What is added |
|---|---|
| `tab-shapes` | the *Private info* section (§2.1) |
| `settings` | the *Private info* nav item |
| `palette-empty` | the three commands, once off `WAITING_COMMANDS` |
| `shortcuts` | the same three rows |
| `review` | the *Private* chip in the kind list (it shows only when a fixture has private rows: none do, so no change expected) |
| `polish`, the export dialog captures | nothing: the Polish row shows only with the reader, the export note only when something is hidden |

- **During the build** every part runs the guard in compare mode. It is expected to fail only on
  additions. The part runs `scripts/i18n/guard-delta.mjs` (new, contracts) on the run's output, which
  passes only when every screen of the baseline is in the run, every text, text attribute and
  accessible name of the baseline is unchanged in the run, every element of the baseline keeps its
  tag, font, colour, direction and alignment, and every difference is an added element or a box that
  moved because an added element pushed it (reported with the element that pushed it). It prints the
  additions for the part's report.
- **At integration** the lead runs `guard-delta.mjs` once more on the merged tree and, only when it
  passes, re-records the baseline with `--record` (two identical runs) in a commit that names this
  feature, as `english-guard.e2e.cjs:12-13` requires.

### 12.3 Commands waiting for their part

`WAITING_COMMANDS: readonly CommandId[] = ['addCover', 'findPrivate', 'peekCovers']` (contracts,
`commands.ts` beside `LANGUAGE_COMMANDS`, `:239`): `PALETTE_COMMANDS` and `listedCommands` leave them
out. P1 removes `addCover` and `peekCovers`, P5 removes `findPrivate`. The tests that pin the palette
and shortcut lists (`outputSeams.test.ts:30`, `i18nCommands.test.ts:99-100`) are extended by the
contracts to leave out `WAITING_COMMANDS`.

### 12.4 Bangla and other scripts

- The PP-OCRv6 character lists hold all 94 printable ASCII characters and no Bengali, Cyrillic,
  Arabic or Devanagari: Bangla on screen is not read in this wave (§2.9).
- Bangla speech is handled (§7.2). Its word lists need the native review of decision 8.

---

## 13. Performance

### 13.1 In the editor

- **Cover index** (`coverIndex(covers)`, contracts): built once per `covers` array (WeakMap); covers
  sorted by start in buckets of one second. `coversAt(index, t, slack)` is O(log n + k). Paths are
  parsed once per cover string and cached (WeakMap on the cover object).
- **Drawing**: §8.6. A 2,000-cover project with 50 keys each parses in under 30 ms once.
- **Timeline**: the Covers row draws bars for the visible time only; groups that overlap draw once.
- **Review**: 2,000 private rows are grouped first (a scroll or a page gives one row), and the list is
  windowed as Review's list is.
- **Saving**: a 2,000-cover project adds about 3.5 MB to `project.json` (§4.2) and up to 4,000 legacy
  shapes (about 1.4 MB).
- **Budgets checked by tests** (×6 on CI): `readCovers` of 2,000 covers and 200,000 keys under 150 ms
  (finding 17); `mergeCovers` of 20,000 found items under 300 ms (finding 7); `coversAt` under 0.02 ms;
  `withLegacyShapes` under 50 ms; `maskRequest` of a 20,000-caption request under 40 ms.

### 13.2 Find

§5.11. On a 4-core laptop Find uses three threads at below-normal priority, leaving one core to the
editor; the preview keeps playing at full rate on the reference PC (checked in decision 8's run).

### 13.3 Size

- Installer: `ssw-ocr.exe`, about 3.4 MB compressed and 14.3 MB installed (the mixed profile, §16.2),
  plus the vendored libphonenumber-js and double-metaphone in `app.asar` (403 KB, about 60 KB brotli).
- Downloaded on request: 27,608,757 bytes of models.

---

## 14. Undo, Versions and Review

### 14.1 One action, one undo step

| Action | How it is one step |
|---|---|
| Add cover, Turn into a cover, Cover the whole video, Keep, Remove, a colour chip | one `store.update` |
| Dragging a bar's end or a handle on the preview | one gesture (`beginGesture` … `endGesture`, `editStore.ts:282-290`), merged by key |
| Typing in a box field | merged by key while the field has focus, then `seal` |
| Find's results (covers, bleeps, record) | one `store.update` through `afterGestures` (§5.10, finding 16) |
| *Follow what is under it* | one update through `afterGestures` when it lands; *Stop* changes nothing |
| *Cover this text everywhere* | one update through `afterGestures` |
| Keep all or Remove all of a kind, Done reviewing | `heldInSlices` with `removeSteps` (`src/shared/review/slices.ts:103`), one step; *Remove all* keeps a version first |
| Polish with *Find private info* | inside Polish's one update between seals (`polishRunner.ts:233-239`) |
| Multi-select delete, nudge, colour, Keep | one update for the whole selection |

**No settle step for covers.** Editing a suggestion makes it the user's inside the edit itself: every
function of P1's `coverEdit.ts` and every group function drops `found` (and `missed`, `thin`) from the
covers it changes. So undo, redo and opening a version never settle a suggestion (finding 19).
`settleSaid` (§7.5) is the only new settle step; it is idempotent.

### 14.2 Versions

- `AREAS` (`src/shared/editor/versions.ts:199-231`) gains `{ name: 'covers', keys: ['covers'] }`, so a
  changed `covers` shows as "covers" rather than "other settings"; `privacy` joins the same area.
  `CHANGED_AREA_NAMES` (`:245`) gains it; `i18nVersionWords.test.ts` is extended.
- The version body is written with the legacy shapes (§4.6); `hashProject` and the summary are
  computed on the project without them. An automatic version is skipped when one with the same hash
  exists (`src/main/versions.ts:287`), unchanged.
- `AUTO_REASONS` (`:20`) is unchanged: *Remove all* in Review uses `'review'`, Polish uses `'polish'`.
- Restoring a version replaces `covers` and `privacy` with the version's, as any other field.

### 14.3 Review

- `ReviewKind` gains `'private'`, inserted **before `'chapter'`** in `REVIEW_KINDS`
  (`src/shared/review/copy.ts:22`), so `REVIEW_KINDS.slice(-2)` stays `['chapter', 'short']`
  (`smartContracts.test.ts:328`). `KIND_WORDS` takes its four keys (§2.7).
- `src/shared/review/privacyReview.ts` (P5; contracts stub returns the project itself) gives the four
  hooks `review.ts` calls for each aggregator, as `smartReview.ts` does: `privacyReviewItems`,
  `privacyPendingCount`, `privacyStatus`, `privacyKeep` and `privacyRemove`. A row's status is read
  from the project (`found` on its covers, `auto` on its bleeps), so undo and redo need nothing more.
- Private bleeps are not listed under *Bleep* (`captionReview.ts:212-213` skips `isPrivateBleep`).
- `clipCopy.withinRange` (`clips/clipCopy.ts:106-113`) Keeps pending rows outside a short clip's
  range; it skips the `private` kind, so a clip copy's private rows stay waiting.
- *Remove* writes the removed suggestions' places to `privacy.rejected` (§5.10), in the same update.

### 14.4 Multi-select and group edit (P1)

`'cover'` joins `GROUP_KINDS` (`src/shared/editor/multiSelect.ts:12`) after `'graphic'`, with its own
track (`ItemTrack` `'covers'`). Each switch that lists the kinds gains its branch, as `'graphic'`
joined (`docs/design/captions-studio.md` §10.5):

| File | What covers do there |
|---|---|
| `multiSelect.ts` (`GROUP_KINDS`, `ItemTrack`, `TRACK_OF`, `projectItems`, `idsOf`) | covers are items of the Covers row |
| `selection.ts` (renderer: `Selection`, `validSelection`, `groupKeyOf`) | `{ kind: 'cover', id }` |
| `groupEdit.ts` (`LookClass` `'cover'`, `GROUP_FIELDS`, `KIND_OF`, `listOf`, `withList`, `mapItems`, `deleteItems`, `lookName`, `copyLook`, `pasteLook`, `LOOK_CLASS_WORDS`) | the colour is the group field; *Copy look* copies it; delete writes rejected places for suggestions; every change drops `found` |
| `groupClipboard.ts` (`ClipItem`, `copy`, `paste`) | covers paste only into their own project, like freezes (`projectId`, `:41-42`); a copy is a snapshot of each cover at copy time (finding 18); paste never reads the OS clipboard |
| `groupMove.ts` (`listOf`, the moves) | a time move applies only to covers with one key; followed covers are left in place and the status line says `privacy.cover.timeKept` |
| `nudge.ts` | arrow keys on the preview move the selected covers' whole paths by one pixel (Shift: ten) |
| `multiSelectControl.ts` (`BLOCKS`, `plainClick`) | Ctrl+click and Shift+click on bars |
| `PreviewStage.tsx` (`previewBoxes`, `EditItem`) | group outlines on the preview |
| `Editor.tsx` (single delete `:906-932`, `TAB_TRACK` `:1112`) | the Shapes tab maps to `'covers'` when a cover is selected |
| `itemClipboard.ts` | a single cover's copy is its snapshot, for its own project only |

Tests that pin these lists are extended: `multiSelectContracts.test.ts:42`, `graphicsSelection.test.ts:89`
(now `GROUP_KINDS.at(-2) === 'graphic'`), `multiSelect.test.ts:58`, `multiSelectCopy.test.ts:18`.

### 14.5 Polish

`PolishStep` gains `'privacy'`, appended after `'director'` in `POLISH_STEPS` (`polish.ts:49`; the
adjacency tests at `smartContracts.test.ts:352`, `studioContracts.test.ts:318-319` and
`editingContracts.test.ts:922` hold). `PolishOptions.privacy: boolean`, `DEFAULT_POLISH_OPTIONS.privacy:
true`, `readPolishOptions` reads a missing value as `false`. `PolishSkip` gains `'no-reader'` (`SKIP_TEXT`, `polishCopy.ts:113`).
`PolishInput.privacy?: PrivacyGathered` (the found covers and bleeps, or null). `polishRunner.ts`
gathers it with `gatherPrivacy(project, captions, signal)` (P5; contracts stub returns `null`) after
that run's captions arrive (`:183`), as a fourth gather; `planPolish` applies it with
`withFoundCovers` in its single update.

---

## 15. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Old projects, settings or presets draw, sound or save differently through shared code (`drawFramePicture`, `maskedSegments`, `migrateProject`, the project writers, AI requests). | Every new path is behind a field absent today; `coverScreen` returns its input with no cover active; test 20 is written first, alone, and never regenerated. |
| 2 | A secret shows through: next to a cover (blur, lens, scaling), at a frame boundary, under motion blur, in a join or a freeze. | The fill is in the screen picture before anything samples it, and again on the output (§8); slack of half a frame (§4.2); A2 and its variants read every pixel of every cover box in exported frames. |
| 3 | A cover ends while the text is still there (scrolls, toasts, zoom). | Evidence of absence (§5.8); lost areas with no time limit; A16 checks every planted item in every frame. |
| 4 | The reader misses text (small fonts, odd fonts, video compression, ClearType). | careful-long; the padded box of §6.1; the 30 real recordings of decision 8; §2.9 says what is not seen; the export note asks to check. |
| 5 | Too many false covers make users turn Find off. | Measured false-hit rates (§6.15); unlabelled random strings off; one Review row per text; *Keep all* and *Remove all* of a kind; removed places are remembered. |
| 6 | A secret said aloud leaks through text made from captions. | Masking by time even when words do not line up (§7.4); translations masked whole; `settleSaid`; `aiTextFor` with a test that no other file calls `aiText` (test 31). |
| 7 | An older Flown shows covered text. | Legacy shapes written by every writer (§4.6); stated residual risk during the rectangle's fades and in older guide shots; older Flown masks private bleeps by time but not by word. |
| 8 | The raw recordings leave through the timeline. | Refused in the renderer and in main, which reads `project.json` itself (§9 row 10). |
| 9 | The models are swapped or damaged. | Size and SHA-256 in main and again in the helper before parsing (§10.2); downloads checked hop by hop. |
| 10 | The mirror does not exist at release. | `READER_MIRROR` null fails `verify-dist` for a release build (§16.2); the upstream files serve the pinned bytes meanwhile for development. |
| 11 | Find takes too long or slows the editor. | Budgets of §5.11; three threads at below-normal priority; two estimates; *Stop* keeps what was found. |
| 12 | Memory on 8 GB laptops. | Helper ≤ 700 MB; small plans dropped after each careful batch; width buckets; tiles (§5.11). |
| 13 | Windows OCR is offered before it is measured. | `WINDOWS_READER_ALLOWED = false` until decision 8's check passes. |
| 14 | The helper or ffmpeg crashes and a dump leaves the PC. | `catch_unwind`, restart once, job object, `SetErrorMode`, the WER exclusion (question 14). |
| 15 | Merge conflicts in shared files (`compositor.ts`, `Editor.tsx`, `review.ts`, `groupEdit.ts`, `commands.ts`, the catalogues). | The contracts step completes every shared seam; one owner per file afterwards (§16.6). |
| 16 | The English guard is re-recorded over a real change. | `guard-delta.mjs` proves every old text and name unchanged first (§12.2). |
| 17 | Invented secrets in the repository are flagged or mistaken for real ones. | Compressed fixtures with a `.gitignore` and a README (question 15); every value invented. |
| 18 | Bangla speech rules are wrong. | Native review (decision 8); Bangla vectors in `rule-vectors.json`; Bangla screen text not claimed. |
| 19 | Pop-up notification rules cover ordinary panels. | Check tier; decision 8's limit of one false hit per 10 minutes, or the default turns off. |

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
   written in full from that file. The contracts add a `--seed` flag to `make-eval-set.mjs`; a second
   held-out set (`--holdout --seed 9000`) is rendered only at test time by A16 and the release check,
   and no part tunes its rules on it.
3. **Types and API**: §4.1 in `src/shared/types.ts`; `src/shared/api/privacy.ts`; `ProjectSummary.
   thumbCovers?` (`src/shared/api/projects.ts`); `PrefKey` `'privacy'` and `PREF_KEYS`
   (`src/shared/api/prefs.ts`); `RenderScene.peek?` (`compositor.ts`, the field only);
   `src/preload/privacy.ts` and its line in `src/preload/index.ts`.
4. **Readers, tables and boundaries in full** (with their tests): `kinds.ts`, `coverPath.ts`,
   `coverData.ts`, `covers.ts`, `protocol.ts` (parsing every helper line strictly), `validateFindRequest`,
   `readPrivacyPrefs` (wired into `prefsIpc.ts`'s sanitisers).
5. **Migration and the writers**: `migrateProject` (§4.7); `src/main/projectFile.ts` and its four
   callers (§4.6); the crop mapping (§4.8).
6. **Drawing**: `coverLayer.ts` (`coverScreen`, `drawCoverOutput`) wired into `compositor.ts` (§8.1,
   §8.2); the `peek` strip at every export entry point; `JoinStills.fresh` keyed on `peek`.
7. **Masking in full** (§7): `spoken.ts`, `maskedSegments` for private bleeps, the translation masks
   and `maskedFor` in `readCaptionTracks`, `maskBleeped` with `maskPrivate`, `search/extract.ts`,
   `captionReview.ts`, `transcriptText.ts`, `settleSaid` at the end of the settle chain
   (`Editor.tsx:228-230`), `aiRequest.ts` and `aiTextFor.ts` with all 9 call sites switched.
8. **Output seams**: the guide's `shotSig` and `planActual` (§9 row 12); the timeline refusal in
   `timelineIpc.ts`, `timelineRun.ts` and `ExportBundleOptions.tsx` (row 10); Home thumbnails (row 17:
   `listProjects` and `captureThumbnail`); the filmstrip's draw calling `fillCoverTiles` (row 18, P1
   stub draws nothing) from `src/renderer/src/editor/Filmstrip.tsx`.
9. **Review, Versions, multi-select, Polish seams**: `'private'` in `REVIEW_KINDS` and `KIND_WORDS`;
   `review.ts`'s aggregator hooks calling `privacyReview.ts` (P5 stubs return the project, zero and
   no rows); the `covers` area in `versions.ts`; `'cover'` in `GROUP_KINDS` with every switch of §14.4
   calling `src/shared/editor/coverGroup.ts` (P1 stubs: covers are not selectable yet,
   `validSelection` drops them); `PolishStep` `'privacy'`, its options, `PolishInput.privacy`,
   `polishRunner.ts` calling `gatherPrivacy` (P5 stub `null`); `clipCopy.withinRange` skipping
   `'private'`.
10. **Commands and mounts**: the three commands with `WAITING_COMMANDS`; mounts of every part's
    component, each a stub rendering nothing: `PrivacySection`, `CoverSection` and `WeakBlurNote` in
    `ShapesPanel.tsx`; `CoverTrack` in `Timeline.tsx`; `CoverHandles` and `PeekBanner` in
    `PreviewStage.tsx`; `PrivacyExportNote` in `ExportDialog.tsx`; `PrivacySettings` in
    `SettingsDialog.tsx` (with `'privacy'` in `SettingsSection` and its nav item hidden while
    `showPrivacySettings()` (P5 stub) is false); `TranscribeNote` and `TranslatedNote` in the captions
    panels (`CaptionsPanel.tsx`'s transcription choices and `LanguagesSection.tsx`); `NotCheckedNote` in
    `src/renderer/src/guide/ShotViewer.tsx`; `FindDialog` in `Editor.tsx`.
11. **Main**: `registerReaderIpc()` (P2 stub answers `{ status: 'none' }` and refuses downloads with
    `errors.feature.notReady`), `registerFindIpc()` (P4 stub answers `{ ok: false, reason: 'failed' }`),
    both called in `src/main/index.ts`; `src/main/privacy/names.ts` (`privateNames`, `setPrivateNames`)
    joined to `secretValues()`.
12. **Catalogues**: `privacy.json` and `privacy.meta.json` complete for §2, the keys of §12.1 in their
    namespaces, every new file in `failFor`; `scripts/i18n/guard-delta.mjs` (§12.2).
13. **Tests 1-40** (§17.1), each its own test, and test 20 green throughout. Both typechecks, all of
    vitest, `npm run i18n:check`, `npm run -s build`, and the English guard in compare mode (no
    difference at all: every mount renders nothing and every command waits).

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
export const MAX_KEYS_PER_COVER = 4000
export function parsePath(path: string): CoverKey[] | null
export function writePath(keys: readonly CoverKey[]): string
export function pathKeys(cover: Pick<Cover, 'path'>): readonly CoverKey[]     // parsed once, cached
export function boxAt(cover: Cover, t: number): NormRect | null              // null outside [start, end)
export function drawnBox(cover: Cover, t: number, slack: number): NormRect | null
export function coverSlack(fps: number): number                             // 0.5 / fps + 0.001
export function unionBox(a: NormRect, b: NormRect): NormRect

// src/shared/privacy/coverData.ts
export const MAX_COVERS = 2000
export const MAX_KEYS = 200000
export const LEGACY_PREFIX = '~cover:'
export const MAX_LEGACY_SHAPES = 4000
export function readCovers(raw: unknown, duration: number): Cover[] | undefined
export function readPrivacy(raw: unknown, duration: number): ProjectPrivacy | undefined
export function readPrivacyPrefs(raw: unknown): PrivacyPrefs | null
export function isPrivateBleep(b: Pick<Bleep, 'word'>): boolean
export function privateBleepWord(kind: PrivateKind): string                 // ':' + kind
export function privateKindOf(b: Pick<Bleep, 'word'>): PrivateKind | null
export function legacyPieces(cover: Cover, slack: number): { start: number; end: number; box: NormRect }[]
export function withLegacyShapes(project: Project): Project
export function withoutLegacyShapes(shapes: unknown): unknown
export function mergeCovers(covers: readonly Cover[], max: number): Cover[]
export function thumbCovers(project: Project, t: number): NormRect[]
export function hidesSomething(project: Pick<Project, 'covers' | 'shapes' | 'bleeps'>): boolean
export function coverCounts(project: Pick<Project, 'covers' | 'bleeps'>): { covers: number; waiting: number; check: number; said: number }

// src/shared/privacy/covers.ts
export interface CoverIndex { readonly covers: readonly Cover[] }
export function coverIndex(covers: readonly Cover[]): CoverIndex             // cached per array
export function coversAt(index: CoverIndex, t: number, slack: number): readonly Cover[]
export function containsOver(outer: Cover, inner: Cover, slack: number): boolean
export function placeOf(box: NormRect): 'topLeft' | 'top' | 'topRight' | 'left' | 'centre' | 'right' | 'bottomLeft' | 'bottom' | 'bottomRight'

// src/shared/privacy/protocol.ts
export const OCR_PROTOCOL = 1
export type Box = [x: number, y: number, w: number, h: number]               // video pixels
export interface ModelPin { file: string; path: string; bytes: number; sha256: string }
export interface LookMove { box: Box; dx: number; dy: number; score: number; alt: [dx: number, dy: number, score: number][] }
export interface LookFrame { t: number; key: boolean; tiles: string; moves: LookMove[] }
export interface ReadVariant { model: 'tiny' | 'small'; text: string; conf: number; spans: [number, number][] }
export interface ReadLine { box: Box; quad: [number, number][]; variants: ReadVariant[]; ring: string; spread: number }
export interface ReadResult { id: number; t: number; lines: ReadLine[]; qr: { quad: [number, number][]; payload: string | null }[] }
export interface FollowStep { t: number; parts: (number | null)[]; dx: number; dy: number; scale: number }
export type HelperCommand =
  | { op: 'open'; protocol: 1; models: ModelPin[] }
  | { op: 'look'; id: number; video: string; ffmpeg: string; k: number; step: number; from: number; to: number }
  | { op: 'read'; id: number; video: string; ffmpeg: string; key: number; reads: { id: number; t: number; areas: Box[] }[] }
  | { op: 'careful'; id: number; lines: number[] }
  | { op: 'release'; id: number }
  | { op: 'follow'; id: number; video: string; ffmpeg: string; key: number; from: number; to: number; dir: 1 | -1; parts: Box[]; candidates: { t: number; dx: number; dy: number }[] }
  | { op: 'suspend' } | { op: 'resume' } | { op: 'stop' }
export type HelperEvent =
  | { alive: number }
  | { opened: { protocol: number; version: string } }
  | { id: number; look: LookFrame[]; done: boolean }
  | { id: number; read: ReadResult }
  | { id: number; follow: FollowStep[]; done: boolean }
  | { id: number; error: 'model' | 'read' | 'video' | 'tooLarge' | 'stopped' | 'bad-command' }
export function parseHelperEvent(line: string): HelperEvent | null           // strict; unknown or malformed → null
export function commandLine(c: HelperCommand): string

// src/shared/api/privacy.ts
export type ReaderState =
  | { status: 'none' } | { status: 'downloading'; done: number; total: number } | { status: 'ready'; bytes: number }
  | { status: 'damaged' } | { status: 'failed'; reason: string } | { status: 'unavailable'; reason: 'helper' | 'cpu' }
export interface FindRequest { projectId: string; requestId: string; kinds: PrivateKind[]; regions: string[]; names: string[]; neverHide: string[]; only?: 'everywhere' }
export interface FindProgress { projectId: string; requestId: string; phase: 'look' | 'read' | 'follow'; done: number; total: number; secondsLeft: number | null }
export interface FoundCover { kind: PrivateKind; score: number; group: string; start: number; end: number; path: string; color: string; lost?: true; thin?: true }
export type FindResult =
  | { ok: true; found: FoundCover[]; failedReads: number; thinned: number; stopped: boolean; reader: string }
  | { ok: false; reason: 'reader' | 'busy' | 'tooLarge' | 'failed'; message: string }
export interface FollowRequest { projectId: string; requestId: string; t: number; box: NormRect; start: number; end: number; path: string }
export type FollowResult = { ok: true; path: string; start: number; end: number; thin: boolean } | { ok: false; reason: 'none' | 'stopped' | 'failed'; message: string }
export interface EverywhereRequest { projectId: string; requestId: string; t: number; box: NormRect }
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
  coverEverywhere(request: EverywhereRequest): Promise<FindResult>
  setPrivateNames(names: string[]): Promise<void>
}
export function validateFindRequest(raw: unknown): FindRequest | null

// src/shared/privacy/spoken.ts
export interface SpokenForms { readonly forms: readonly string[]; readonly digits: readonly string[] }
export function spokenForms(project: Pick<Project, 'transcript' | 'bleeps'>): SpokenForms | null
export function maskChars(text: string): string                             // '•' for each letter and digit
export function maskPrivate(text: string, forms: SpokenForms | null): string
export function maskedForOf(project: Pick<Project, 'transcript' | 'bleeps'>, segmentId: string): string
export function settleSaid(next: Project, prev: Project): Project

// src/shared/privacy/aiRequest.ts
export function maskRequest<R extends object>(request: R, project: Pick<Project, 'transcript' | 'bleeps'>): R

// src/renderer/src/ai/aiTextFor.ts
export function aiTextFor(project: Project, providerId: string, request: AiTextRequest, requestId?: string): Promise<AiTextResult>

// src/renderer/src/render/coverLayer.ts
export function coverScreen(target: CanvasRenderingContext2D, screen: FrameImage, full: FrameImage, scene: RenderScene, t: number): FrameImage
export function drawCoverOutput(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly { toOut: (r: NormRect) => Rect }[]): void

// src/main/projectFile.ts
export function projectFileText(project: Project, form?: 'pretty' | 'compact'): string

// src/main/privacy/names.ts
export function privateNames(): string[]
export function setPrivateNames(names: unknown): void
```

**What the contracts step settled** is recorded here when it is done, as in
`docs/design/output-and-languages.md` §21.0.

### 16.1 Part P1 · Covers in the editor

| File | Exports or change |
|---|---|
| `src/shared/editor/coverEdit.ts` (new) | `type CoverLength = 'three' \| 'toEnd' \| 'whole'`; `function addCover(project: Project, at: { t: number; box: NormRect; length: CoverLength; color: string }, random?: () => number): { project: Project; id: string }`; `function coverFromShape(project: Project, shapeId: string, color: string): { project: Project; id: string } \| null`; `function setCoverBox(project: Project, id: string, t: number, box: NormRect, all: boolean): Project`; `function setCoverEnds(project: Project, id: string, start: number, end: number): Project` (holds the first and last boxes); `function moveCoverTime(project: Project, id: string, dt: number): Project \| null` (null for a cover with more than one key); `function coverWholeVideo(project: Project, id: string): Project`; `function setCoverColour(project: Project, ids: readonly string[], color: string): Project`; `function keepCovers(project: Project, ids: readonly string[]): Project`; `function deleteCovers(project: Project, ids: readonly string[]): Project` (writes `privacy.rejected` for suggestions); `function nudgeCovers(project: Project, ids: readonly string[], dx: number, dy: number): Project`; `interface CoverClip { projectId: string; at: number; covers: Cover[] }`; `function copyCovers(project: Project, ids: readonly string[], at: number): CoverClip`; `function pasteCovers(project: Project, clip: CoverClip, at: number): { project: Project; ids: string[] } \| null` (null for another project); `function duplicateCover(project: Project, id: string): { project: Project; id: string }`; `function withFollowedPath(project: Project, id: string, result: Extract<FollowResult, { ok: true }>): Project` (the union with the old path); `function newCoverId(random: () => number): string`. Every function drops `found`, `missed` and `thin` from the covers it changes |
| `src/shared/editor/coverGroup.ts` (stub from the contracts) | the branches of §14.4: `function coverItems(project: Project): GroupItem[]`; `function coverTrackOf(): ItemTrack`; `function moveCoversInTime(project: Project, ids: readonly string[], dt: number): { project: Project; refused: string[] }`; `function deleteCoverItems(project: Project, ids: readonly string[]): Project`; `function coverLookOf(cover: Cover): CoverLook`; `function pasteCoverLook(project: Project, ids: readonly string[], look: CoverLook): Project`; `function validCoverSelection(project: Project, id: string): boolean` |
| `src/shared/render/coverColour.ts` (new) | `function ringColour(pixels: Uint8ClampedArray, width: number, height: number, box: { x: number; y: number; w: number; h: number }): { color: string; spread: number }`; `function coverColourOf(ring: { color: string; spread: number }, pref: PrivacyPrefs['colour']): string` |
| `src/renderer/src/render/coverGrade.ts` (stub from the contracts) | `function gradedCoverColour(color: string, grade: ColorGrade \| undefined, lut: CubeLut \| null, compare?: boolean): string`; `function drawCoverPeek(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly { toOut: (r: NormRect) => Rect }[]): void` |
| `src/renderer/src/privacy/peek.ts` (new) | `interface PeekState { ids: readonly string[] \| 'all' \| null; listen: string \| null }`; `function peekCovers(ids: readonly string[] \| 'all' \| null): void`; `function listenBleep(id: string \| null): void`; `function clearPeek(): void`; `function peekNow(): PeekState`; `function usePeek(): PeekState`; `function peekedScene<S extends RenderScene>(scene: S): S`; `function listenedGains(gains: readonly SoundGain[], project: Pick<Project, 'bleeps'>): readonly SoundGain[]` |
| `src/renderer/src/privacy/coverPick.ts` (new) | `function ringColourAt(projectId: string, t: number, box: NormRect): Promise<string>` |
| `src/renderer/src/privacy/followRun.ts` (new) | `function runFollow(services: EditorServices, coverId: string, signal: AbortSignal): Promise<'done' \| 'none' \| 'stopped' \| 'failed'>`; `function runEverywhere(services: EditorServices, coverId: string, remember: boolean, signal: AbortSignal): Promise<number \| null>` |
| `src/renderer/src/privacy/filmstripCovers.ts` (stub from the contracts) | `function fillCoverTiles(ctx: CanvasRenderingContext2D, project: Project, tiles: readonly { t: number; x: number; y: number; w: number; h: number }[]): void` |
| `src/renderer/src/privacy/PrivacySection.tsx`, `CoverSection.tsx`, `WeakBlurNote.tsx`, `CoverTrack.tsx`, `CoverHandles.tsx`, `PeekBanner.tsx`, `EverywhereDialog.tsx`, `covers.css` (stubs from the contracts) | `function PrivacySection(props: { services: EditorServices; onFind: () => void }): JSX.Element \| null`; `function CoverSection(props: { services: EditorServices; coverId: string }): JSX.Element \| null`; `function WeakBlurNote(props: { services: EditorServices; shapeId: string }): JSX.Element \| null`; `function CoverTrack(props: CoverTrackProps): JSX.Element \| null`; `function CoverHandles(props: { services: EditorServices; view: PreviewView }): JSX.Element \| null`; `function PeekBanner(): JSX.Element \| null`; `function EverywhereDialog(props: { services: EditorServices; coverId: string; onClose: () => void }): JSX.Element` |
| `src/renderer/src/editor/player.ts`, `joinStills.ts`, `previewAudio.ts` | the preview scene through `peekedScene`; the listened bleep left out of the preview's gains |
| `src/renderer/src/guide/guideRun.ts` | `blurArea` and `blurTypedText` add covers (§2.11), colour from `ringColourAt` at the step's shot time |
| the files of §14.4 | the `'cover'` branches, through `coverGroup.ts` |
| Tests | 41-75 |

P1 removes `addCover` and `peekCovers` from `WAITING_COMMANDS` and wires them (`Editor.tsx`'s command
runner, beside `addBlur` at `:1278-1279`).

### 16.2 Part P2 · The reader

| File | Exports or change |
|---|---|
| `native/ocr/Cargo.toml`, `Cargo.lock` (new) | its own `[workspace]`, `license = "MIT"`, `publish = false`, `rust-version = "1.91"`; `tract-onnx = { version = "=0.23.10", default-features = false }`, `rqrr = "=0.11.0"`, `sha2`, `serde_json`, `windows-sys` (job objects, `SetErrorMode`); profile `release` with `opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "unwind"` (needed for `catch_unwind`), and `opt-level = 3` for `tract-linalg` and `tract-core` (the mixed profile); feature `fixture` (test builds only) |
| `native/ocr/src/main.rs`, `protocol.rs`, `models.rs`, `look.rs`, `read.rs`, `ctc.rs`, `follow.rs`, `qr.rs`, `ffmpeg.rs`, `guard.rs` (new) | the commands and events of `protocol.ts`; heartbeat every 2 s from start (also during `open`); `open` hashes every pin before parsing any; `tooLarge`; look (§5.2); read with tiles, joins, buckets, chunks, spans, rings and QR (§5.5); `careful` and `release` (§5.6); follow with per-part gradient NCC, uniqueness, candidates and scales (§5.8); ffmpeg in a job object with `KILL_ON_JOB_CLOSE`, seeking to key frames; `suspend` and `resume`; `catch_unwind` around each read; `SetErrorMode` at start. The `fixture` feature adds `{ op: 'readImage', png }` for the evaluation PNGs; release builds do not contain it |
| `native/ocr/tests/cli.rs`, `native/ocr/README.md` (new) | R1-R16 (§17.1); the README records the pins, the tract parity method and the measurements of §5.6 |
| `scripts/build-native.mjs` | `--ocr` and `--ocr-host` flags; `cargoOcr`, `buildOcrWindows` (MinGW POSIX, the import allow-list, the budget, copied to `native/bin/ssw-ocr.exe`), `buildOcrHost` |
| `scripts/lib/packaging.cjs` | `function ocrHelper(): string`; `const OCR_IMPORTS = ['KERNEL32.dll', 'ntdll.dll', 'msvcrt.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll']`; `const OCR_BUDGET = { compressed: 3.9e6, installed: 16e6 }`; `function ocrHelperStatus(): …`; `function ocrHelperProblems(file: string): string[]` (brotli 11 with a 2^24 window, as `llmHelperProblems`, `:214-237`); `speechResources` carries it to `resources/native` so it is signed |
| `scripts/verify-dist.mjs` | §4d: the helper's imports, budget and no `readImage` string; for a release build (`FLOWN_RELEASE=1`), `READER_MIRROR` must not be null |
| `scripts/notices.mjs` | `CRATES` gains `native/ocr/Cargo.toml`; `RUST_TITLE` names `ssw-ocr.exe`; `resources/notices/41-paddleocr-models.txt` (Apache-2.0 text, NOTICE, "downloaded when you ask for it") |
| `build/installer.nsh` | the WER exclusion in `customInstall` and a new `customUnInstall` (§10.5) |
| `src/shared/privacy/readerCatalog.ts` (written by the contracts in full; P2 reads it) | `interface ReaderFile { file: string; bytes: number; sha256: string; repo: string; commit: string }`; `const READER_FILES: readonly ReaderFile[]`; `const READER_BYTES = 27608757`; `const READER_ID = 'pp-ocrv6-tiny+small-careful-long'`; `const READER_MIRROR: { repo: string; commit: string } \| null = null`; `const WINDOWS_READER_ALLOWED = false`; `function readerUrls(f: ReaderFile, mirror?: { repo: string; commit: string } \| null): string[]` |
| `src/main/privacy/readerModels.ts` (new) | `function readerDir(): string`; `function readerState(): ReaderState`; `function downloadReader(onState: (s: ReaderState) => void, signal: AbortSignal, deps?: DownloadDeps): Promise<ReaderState>`; `function removeReader(): Promise<ReaderState>`; `function checkReader(): Promise<ModelPin[] \| null>` (sizes and hashes; null and `damaged` on a mismatch); `function recordDecodeSpeed(msPerMegapixel: number): void`; `function decodeSpeed(): number \| null` |
| `src/main/privacy/readerHelper.ts` (new) | `function helperPath(): string \| null`; `class OcrHelper { static start(deps?: HelperDeps): Promise<OcrHelper>; open(pins: ModelPin[]): Promise<void>; look(req: Omit<Extract<HelperCommand, { op: 'look' }>, 'op' \| 'id'>, onFrames: (f: LookFrame[]) => void, signal: AbortSignal): Promise<void>; read(req: Omit<Extract<HelperCommand, { op: 'read' }>, 'op' \| 'id'>, onRead: (r: ReadResult) => void, signal: AbortSignal): Promise<void>; careful(readId: number, lines: number[]): Promise<ReadResult>; release(readId: number): void; follow(req: Omit<Extract<HelperCommand, { op: 'follow' }>, 'op' \| 'id'>, signal: AbortSignal): Promise<FollowStep[]>; suspend(): void; resume(): void; stop(): Promise<void>; kill(): void; readonly exited: Promise<number \| null> }` (20 s silence kills it) |
| `src/main/privacy/readerIpc.ts` (stub from the contracts) | `function registerReaderIpc(): void` |
| `tests/fixtures/fake-ocr-helper.cjs` (new) | a scripted helper for main's tests and the e2e runs: answers from a JSON script (`SSW_OCR_SCRIPT`), can crash on a chosen read, stall, or answer a bad hash |
| Tests | 76-100; Rust R1-R16 |

### 16.3 Part P3 · The text rules

| File | Exports or change |
|---|---|
| `src/shared/privacy/detect/clean.ts` (new) | `interface CleanLine { text: string; map: Int32Array; digit: string; prefix: string; url: string; label: string }`; `function cleanLine(raw: string): CleanLine`; `function foldText(s: string): string` |
| `detect/email.ts`, `cards.ts`, `phones.ts`, `ids.ts`, `keys.ts`, `links.ts`, `labels.ts`, `extra.ts` (new) | one `function find<Kind>(line: CleanLine, ctx: LineContext): Hit[]` each: emails (§6.3); cards, CVV and IBAN (§6.8); phones (§6.8); IDs (§6.8); strong prefixes and PEM lines (§6.4); link secrets (§6.5); strong labels, passwords, PINs and codes (§6.6, §6.7); addresses, dots and random strings (§6.12) |
| `detect/rows.ts` (new) | `function rowRules(lines: readonly DetectLine[], hits: Hit[], ctx: FrameContext): Hit[]` (beside, under, code under a sentence, recovery blocks and grids, PEM blocks, continuation, JWT head, one space in a key, wrap join, §6.10) |
| `detect/names.ts` (new) | `function compileNames(entries: readonly string[], neverHide: readonly string[]): NameMatcher`; `function findNames(line: CleanLine, m: NameMatcher): Hit[]`; `function saidNames(words: readonly CaptionWord[], m: NameMatcher): SaidHit[]` |
| `detect/qr.ts` (new) | `function classQr(payload: string \| null): { kind: 'qr'; score: number; class: 'secret' \| 'personal' \| 'other' \| 'undecoded' }` |
| `detect/score.ts`, `detect/detect.ts` (new) | `interface Hit { kind: PrivateKind; rule: string; score: number; spans: { line: number; start: number; end: number }[]; box: Box }`; `interface DetectOptions { kinds: readonly PrivateKind[]; regions: readonly string[]; names: NameMatcher; frame: { width: number; height: number } }`; `function detectFrame(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions): Hit[]` (every variant, union, dedupe, cover boxes); `function needsCareful(line: ReadLine, hits: readonly Hit[], index: number): boolean` (careful-long's trigger) |
| `detect/said.ts` (new) | `interface SaidHit { kind: PrivateKind; score: number; start: number; end: number; estimated: boolean; group: string }`; `function digitRuns(words: readonly CaptionWord[]): DigitRun[]`; `function detectSaid(transcript: Transcript, options: { kinds: readonly PrivateKind[]; regions: readonly string[]; names: NameMatcher }): SaidHit[]`; `function saidBleeps(hits: readonly SaidHit[], existing: readonly Bleep[] \| undefined, random: () => number): Bleep[]` |
| `detect/tables.ts` (new) | the label lists (en, bn, es, hi), issuer prefixes, IBAN lengths, gitleaks-derived patterns, allow lists, region names per language code |
| `src/shared/privacy/vendor/libphonenumber/**`, `vendor/double-metaphone.js` (generated) | vendored, each file with a GENERATED header naming the package, version and SHA-256 |
| `scripts/vendor-privacy.mjs` (new) | downloads the pinned tarballs, checks SHA-512 integrity and SHA-256, copies the files of §6.14, drops `//# sourceMappingURL` lines; `--check` compares |
| `resources/notices/38-libphonenumber-js.txt`, `39-double-metaphone.txt`, `40-gitleaks-rules.txt` (new) | MIT and Apache-2.0 texts, AUTHORS, versions and hashes |
| `scripts/i18n/allow.json` | the rule tables' word lists as data, each with its reason (P3 only) |
| Tests | 101-135 |

### 16.4 Part P4 · The scan

| File | Exports or change |
|---|---|
| `src/shared/privacy/look.ts` (new) | `function lookScale(width: number, height: number): number`; `function lookStep(fps: number): number`; `interface LookData { k: number; step: number; size: Size; frames: LookFrame[]; keys: number[] }`; `function addLookFrames(data: LookData, frames: readonly LookFrame[]): void`; `function changedTiles(frame: LookFrame, data: LookData): Uint8Array`; `function changedIn(data: LookData, box: Box, from: number, to: number): number[]` (frame indices); `function keyBefore(data: LookData, t: number): number` |
| `src/shared/privacy/plan.ts` (new) | `interface ReadHints { typing: { t: number; end: number }[]; clicks: { t: number; x: number; y: number }[]; pastes: number[]; textCursor: { t: number; end: number }[]; valid: boolean }`; `function hintsOf(cursor: CursorTrack \| null): ReadHints`; `interface PlannedRead { t: number; areas: Box[]; why: 'first' \| 'settle' \| 'reveal' \| 'typing' \| 'periodic'; thin: boolean }`; `interface ReadPlan { reads: PlannedRead[]; units: number; thinned: number }`; `function planReads(look: LookData, hints: ReadHints, size: Size, fps: number, budget: number): ReadPlan`; `function readBudget(duration: number, size: Size): number`; `function firstEstimate(duration: number, fps: number, size: Size, decodeMs: number \| null): number`; `function secondEstimate(plan: ReadPlan, look: LookData, measured: { readSeconds: number \| null }): number` |
| `src/shared/privacy/paths.ts` (new) | `interface Track { keys: CoverKey[]; start: number; end: number; lost: boolean; thin: boolean }`; `interface Matcher { match(t: number, parts: readonly Box[], candidates: readonly Candidate[]): Promise<MatchResult> }`; `function walkForward(start: Placed, look: LookData, reads: ReadIndex, m: Matcher, size: Size): Promise<Track>`; `function walkBackward(start: Placed, look: LookData, m: Matcher, size: Size): Promise<Track>`; `function lostBox(box: Box, candidates: readonly Candidate[], regions: readonly Box[], scored: boolean): Box`; `function absent(group: string, read: ReadResult \| null, best: number \| null): boolean`; `function joinTracks(back: Track, fwd: Track): Track` |
| `src/shared/privacy/notices.ts` (new) | `function findNotices(look: LookData, capture: CaptureInfo): { start: number; end: number; box: Box; stacked: boolean }[]` |
| `src/shared/privacy/found.ts` (new) | `function foundCovers(result: Extract<FindResult, { ok: true }>, size: Size, random: () => number): Cover[]`; `function withFoundCovers(project: Project, result: Extract<FindResult, { ok: true }>, said: readonly Bleep[], record: FindRecord, random: () => number): Project` (§5.10: containment, missed, rejected places, groups, merging, limits); `function limitCovers(covers: readonly Cover[]): Cover[]` |
| `src/main/privacy/scan.ts` (new) | `interface ScanDeps { helper?: () => Promise<OcrHelper>; projectDir?: (id: string) => string; readProject?: (id: string) => Promise<Project>; ffmpeg?: () => string; now?: () => number }`; `function runFind(request: FindRequest, onProgress: (p: FindProgress) => void, signal: AbortSignal, deps?: ScanDeps): Promise<FindResult>`; `function followCover(request: FollowRequest, signal: AbortSignal, deps?: ScanDeps): Promise<FollowResult>`; `function coverEverywhere(request: EverywhereRequest, signal: AbortSignal, deps?: ScanDeps): Promise<FindResult>`; `function forgetReads(projectId: string): void` (called by `stopAnalyses` and when the project closes) |
| `src/main/privacy/findIpc.ts` (stub from the contracts) | `function registerFindIpc(): void` (one Find per project, `privacy:find`, `privacy:stopFind`, `privacy:follow`, `privacy:everywhere`, progress events; `stopAnalyses` stops it) |
| `src/main/privacy/lookCache.ts` (new) | `function readLookCache(projectDir: string, key: LookKey): Promise<LookData \| null>`; `function writeLookCache(projectDir: string, key: LookKey, data: LookData): Promise<void>` |
| `src/main/analysisIpc.ts` | `stopAnalyses` (`:210`) also stops Find and calls `forgetReads` |
| Tests | 136-160 |

### 16.5 Part P5 · Panel, Review, export notes, Polish and Settings

| File | Exports or change |
|---|---|
| `src/shared/review/privacyReview.ts` (stub from the contracts) | `function privacyReviewItems(project: Project): ReviewItem[]` (one row per group, Check rows first); `function privacyPendingCount(project: Project): number`; `function privacyStatus(project: Project, id: string): ReviewStatus`; `function privacyKeep(project: Project, ids: readonly string[]): Project`; `function privacyRemove(project: Project, ids: readonly string[]): Project`; `function privacyKinds(project: Project): PrivateKind[]`; `function doneReviewing(project: Project): Project` |
| `src/renderer/src/privacy/privacyRun.ts` (new; `gatherPrivacy` stub from the contracts) | `function startFind(services: EditorServices, choices: FindChoices): Promise<'done' \| 'stopped' \| 'failed'>` (saves, calls main, runs `detectSaid`, applies through `afterGestures`); `function gatherPrivacy(project: Project, captions: Transcript \| null, signal: AbortSignal): Promise<PrivacyGathered \| null>`; `function useFindProgress(projectId: string): FindProgress \| null` |
| `src/renderer/src/privacy/useReaderState.ts` (new) | `function useReaderState(): ReaderState \| null` (one shared state for the panel, the dialog and Settings, finding 29) |
| `src/renderer/src/privacy/FindDialog.tsx`, `RegionsDialog.tsx` (new; `FindDialog` stub from the contracts) | `function FindDialog(props: { services: EditorServices; onClose: () => void; mode: 'find' \| 'again' }): JSX.Element`; `function RegionsDialog(props: { regions: readonly string[]; onDone: (regions: string[]) => void; onCancel: () => void }): JSX.Element` |
| `src/renderer/src/privacy/PrivacyExportNote.tsx`, `TranscribeNote.tsx`, `TranslatedNote.tsx`, `NotCheckedNote.tsx`, `PrivacySettings.tsx` (stubs from the contracts) | `function PrivacyExportNote(props: { project: Project; onReview: () => void; onFind: () => void; onWait: (waiting: boolean) => void }): JSX.Element \| null`; `function TranscribeNote(props: { project: Project; place: 'service' \| 'local' }): JSX.Element \| null`; `function TranslatedNote(props: { project: Project; language: string }): JSX.Element \| null`; `function NotCheckedNote(props: { project: Project }): JSX.Element \| null`; `function PrivacySettings(): JSX.Element`; `function showPrivacySettings(): boolean` |
| `src/renderer/src/review/ReviewPanel.tsx` | the header (kind filter, *Keep all…*, *Remove all…*, *Done reviewing*, *Find again…*, the progress line), the rows' *Peek* and *Listen*, focus rules of §11 |
| `src/renderer/src/editor/PolishDialog.tsx`, `src/shared/editor/polishCopy.ts` | the row (shown with the reader), its skip reason and result lines (§2.10) |
| `src/renderer/src/privacy/privacyPanel.css` (new) | the dialog, the note and the rows |
| Tests | 161-185 |

P5 removes `findPrivate` from `WAITING_COMMANDS`.

### 16.6 Ownership of shared files, and merge order

**Completed by the contracts and edited by no part afterwards**: `types.ts`, `api/privacy.ts`,
`api/projects.ts`, `api/prefs.ts`, `kinds.ts`, `coverPath.ts`, `coverData.ts`, `covers.ts`,
`readerCatalog.ts`,
`protocol.ts`, `spoken.ts`, `aiRequest.ts`, `aiTextFor.ts`, `coverLayer.ts`, `compositor.ts`,
`engine/project.ts`, `engine/crop.ts`, `projectFile.ts` and its four callers, `cleanup.ts`,
`captionTracks.ts`, `studioData.ts`, `search/extract.ts`, `captionReview.ts`, `transcriptText.ts`,
`guide/shots.ts`, `timelineIpc.ts`, `timelineRun.ts`, `ExportBundleOptions.tsx`, `Home.tsx`,
`projects.ts`, `review/copy.ts`, `review.ts`, `versions.ts`, `polish.ts`, `polishRunner.ts`,
`clipCopy.ts`, `commands.ts`, `ShapesPanel.tsx`, `Timeline.tsx`, `ExportDialog.tsx`,
`SettingsDialog.tsx`, `ShotViewer.tsx`, `Filmstrip.tsx`, the captions panels' mounts, `Editor.tsx` (mounts, the settle
chain), `src/main/index.ts`, `prefsIpc.ts`, `appLog.ts`, `diagnostics.ts`, `preload/*`, the catalogues'
existing namespaces, `guard-delta.mjs`.

**Edited by one part below the contracts' lines**:

| Part | Existing files it edits |
|---|---|
| P1 | `player.ts`, `joinStills.ts`, `previewAudio.ts`, `guideRun.ts`, `PreviewStage.tsx` (handles and group outlines), the files of §14.4, `Editor.tsx` (the command runner's two cases only), `commands.ts` (`WAITING_COMMANDS` only) |
| P2 | `scripts/build-native.mjs`, `scripts/lib/packaging.cjs`, `scripts/verify-dist.mjs`, `scripts/notices.mjs`, `build/installer.nsh`, `electron-builder.config.cjs` (only if `speechResources` cannot carry the helper), `vitest.native.config.ts`, `.gitignore` (`native/ocr/target/`) |
| P3 | `scripts/i18n/allow.json` |
| P4 | `src/main/analysisIpc.ts` (`stopAnalyses`) |
| P5 | `ReviewPanel.tsx`, `PolishDialog.tsx`, `polishCopy.ts`, `commands.ts` (`WAITING_COMMANDS` only) |

**Who writes the code behind each seam**:

| Seam | Code behind it |
|---|---|
| `coverLayer.ts` → `gradedCoverColour`, `drawCoverPeek` | P1 `coverGrade.ts` |
| `ShapesPanel.tsx`, `Timeline.tsx`, `PreviewStage.tsx` mounts; the filmstrip's `fillCoverTiles`; `coverGroup.ts` | P1 |
| `registerReaderIpc`; the reader's state | P2 `readerIpc.ts`, `readerModels.ts` |
| `detectFrame`, `detectSaid`, `classQr`, `needsCareful` | P3 |
| `registerFindIpc`; `withFoundCovers` | P4 |
| `privacyReview.ts`; `gatherPrivacy`; `FindDialog`, the notes, `PrivacySettings` | P5 |

**Merge order**: P1, P3, P2, P4, P5. P3 before P2 because P2's tests use P3's `needsCareful` on fixture
reads; P4 needs both; P5 mounts on everything. After each merge the lead runs both typechecks, all
of vitest, `npm run i18n:check`, `npm run -s build`, the English guard in compare mode with
`guard-delta.mjs`, and the e2e files the part touches.

**Integration** (after P5): A1-A17 under `xvfb-run` (§17.3) with the host helper (`build-native
--ocr-host`) and the downloaded models in a fixed `userData`; then `guard-delta.mjs` on the merged
tree and the baseline re-recorded in a commit naming this feature (§12.2); then `npm run notices --
--check` and `verify-dist`.

**For a person, before release**: the Hugging Face mirror (`READER_MIRROR`); the Windows-only checks
(R8 and R10, Windows OCR, speed and memory at 1080p, 4K and 7680×2160 on the reference PC, the WER
value, the 30 real recordings, pop-up false hits); the native Bangla review; the other account's
optional `private.json` (§18).

---

## 17. Test plan

### 17.1 Unit tests (vitest). Each is its own test and fails without the code of its rule.

By owner: contracts 1-40 (test 20 is the guard, §17.2), P1 41-75, P2 76-100 and Rust R1-R16, P3
101-135, P4 136-160, P5 161-185. Test files are named `tests/autoBlur<Area>.test.ts`; each numbered test
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
   some output cover's drawn box (finding 20).
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
    outside the crop is left out of the view only.
11. **Cover index**: `coversAt` equals a brute-force scan for 2,000 random covers at 10,000 times with
    slack, in under 0.02 ms a call.
12. **`containsOver`**: a path inside an existing cover at every key is contained; one that leaves it at
    one key is not; overlap alone is not.
13. **`mergeCovers`** (finding 7): 20,000 found items to 2,000 in under 300 ms, and twice the items take
    at most 2.3 times as long; every input box at every input key is inside an output cover's drawn
    box.
14. **`thumbCovers` and `hidesSomething`**: the boxes of covers and of blur and pixelate shapes active at
    `t` (with slack); a project with only a bleep hides something and has no thumbnail boxes;
    `listProjects` adds `thumbCovers` only when there are boxes, so other summaries are unchanged.
15. **`coverScreen`**: with no cover active it returns its input (the same object) and makes no canvas;
    with a crop it fills the crop's copy in place at the mapped, outward-rounded pixels; with no crop and
    no grade it copies into a per-target canvas and never draws into the video element or an
    `ImageBitmap` (spies on both).
16. **Everything samples the covered picture**: in the recording fake context's call log
    (`verticalEquivalence.test.ts`'s), a blur shape beside a cover, a magnifier lens over it, every
    motion-blur sub-frame, a title card's blurred background and a join still all draw after the
    cover's fill into the picture they read; `drawCoverOutput` fills once per sub-frame camera;
    nothing is drawn in the `'overlays'` alpha mode.
17. **Peek never reaches an output**: `exportVideo`, `ExportPreview`, `renderThumbnail`,
    `renderGuideStills` and `composeJoinStill` given a scene with `peek` draw the fills;
    `JoinStills.fresh` is false when the peek state changes, and its fallback never returns a still
    of another peek state.
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
22. **`settleSaid`**: adding a private bleep masks its forms in chapter titles, chapter title cards
    (finding 12), the pack's saved description and the guide's edited titles and notes, in the same
    update; a second run changes nothing; without private bleeps it returns `next` itself.
23. **`maskRequest`**: every string is walked (a form inside an unknown nested field is masked);
    segments are masked by time; without private bleeps it returns the same object; for each request
    shape (cleanup, translate, chapters, marks, names, title, summary, youtube, posts) a fixture with a
    spoken secret holds no form after masking.
24. **Other texts**: the search index, Review's caption titles and the transcript text hold no form;
    private bleeps are not listed as *Bleep* rows.
25. **The timeline refusal**: `writeTimeline` in recordings mode reads a `project.json` with a cover, a
    blur shape or a bleep and refuses with `errors.timeline.hidden`, writing nothing, whatever the
    request says; a saved preset and bundle choice of `'recordings'` normalise unchanged; `timelineRun`
    skips the step and reports it; the chip is disabled with its description.
26. **Guide shots**: `shotSig` and `planActual` change when a cover active at `t` changes its box or
    colour, and not when a cover elsewhere in time changes; `guideProject` keeps `covers`.
27. **Review wiring**: `REVIEW_KINDS` has `'private'` before `'chapter'` and `slice(-2)` is unchanged;
    `KIND_WORDS.private` has its four keys; `clipCopy.withinRange` leaves private rows waiting;
    `captionReview` skips private bleeps.
28. **Versions**: `changedAreas` gives "covers" for a changed `covers` or `privacy`;
    `CHANGED_AREA_NAMES` holds it; every old fixture pair gives what it gave before.
29. **Polish seam**: `POLISH_STEPS` ends with `'privacy'` and the adjacency tests hold;
    `DEFAULT_POLISH_OPTIONS.privacy` is true; `readPolishOptions({})` reads it as false; `planPolish`
    with `privacy: null` equals today's plan; with a gathered result it adds the covers and bleeps in
    its one update.
30. **Commands**: the three commands are in `COMMAND_LIST`, left out of `PALETTE_COMMANDS` and
    `listedCommands` by `WAITING_COMMANDS`, and have no default key.
31. **One AI chokepoint**: no file under `src/renderer` but `aiTextFor.ts` contains
    `window.api.aiText(`; each of the 9 call sites calls `aiTextFor`.
32. **`validateFindRequest`**: refuses paths, unknown kinds, 401 names, an 81-character name, regions
    that are not two capital letters and project ids not of the project folder's form; accepts a valid
    request unchanged.
33. **`parseHelperEvent`**: strict; unknown keys, wrong types and lines over 16 MB give `null`;
    `commandLine` and parsing round-trip every command.
34. **Preferences**: `prefsIpc.ts` sanitises `privacy` with `readPrivacyPrefs`; an older
    `editor-prefs.json` without it is written back byte for byte.
35. **Names in logs** (finding 24): with "Priya Raman" listed, a log line holding it is written with
    `<secret>`; `*Acme` redacts "Acme"; a two-letter entry is not used; diagnostics hold no name.
36. **Multi-select seam**: `GROUP_KINDS` ends with `'cover'` (the pinned tests extended); while
    `coverGroup.ts` is the stub, `validSelection` drops covers and every other kind behaves as before.
37. **Stubs render nothing**: every mounted stub returns `null` and every seam stub returns its input.
38. **Catalogues**: every key of §2 and §12.1 is in its catalogue with a meta entry; no English message
    of `37f9355` changed (compared with the catalogues at that commit); every new file is in `failFor`.
39. **`guard-delta.mjs`**: on synthetic baseline and run pairs it passes an added element and a box
    pushed by it, and fails a changed text, a changed accessible name, a removed element, a restyled
    element and a box moved with no added element.
40. **Pins**: `READER_FILES` equals the shipping entries of `scripts/privacy/reader-models.json` (bytes,
    SHA-256, repository, commit) and the files sum to 27,608,757 bytes.

**P1 · Covers in the editor**

41. `addCover`: 3 s at the playhead, 30% × 10% centred on the cursor and clipped; *To the end*; *For the
    whole video*; centred on the frame when the cursor is invalid; one undo step; the new cover is
    selected.
42. `coverFromShape`: a blur shape becomes a cover over its box and times, the shape removed, one step.
43. `setCoverBox`: with `all` false it changes the box from `t` to the next key; with `all` true it
    moves every key; both drop `found`.
44. `setCoverEnds` holds the first and last boxes; `moveCoverTime` is null for a cover with two or more
    keys and moves a one-key cover.
45. `coverWholeVideo` covers 0 to the recording's end with the path's ends held.
46. `deleteCovers` writes a rejected place (kind, union box, times) for each suggestion and none for a
    user's cover.
47. `keepCovers` drops `found`, `missed` and `thin`.
48. `nudgeCovers` moves whole paths by pixels in normalised units, clamped to the frame.
49. Copy and paste (finding 18): a paste holds the cover as it was when copied, even after the source is
    edited; pasting into another project gives null and `privacy.cover.oneProject`; no OS clipboard
    API is called.
50. `duplicateCover` gives a new id and the same path.
51. `withFollowedPath` never covers less than the old path at any time.
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
    results are kept (finding 16); *Stop* changes nothing; focus moves to the cover's status line
    (finding 37).
62. `runEverywhere` adds `text` covers in one step; with *remember* it adds the text to
    `privacy.names` and the open dialogs show the new list (finding 28).
63. `PrivacySection`: its buttons, the remembered length, the count lines, the disclosure with
    `aria-expanded`, the reader line.
64. `CoverSection`: the box fields in percent; the colour chips; *Follow*, *Everywhere*, *Whole video*,
    *Keep* and *Remove*; the lines for found, check, lost, missed and thin.
65. `WeakBlurNote`: the note and *Turn into a cover*; `text.calloutSection.privacyNote` unchanged.
66. `CoverTrack` draws only with covers: bars, dashed waiting edges, the warning edge for Check, hatched
    lost areas, one bar with a count for a group's overlapping covers; each bar's accessible name.
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
74. *Add a cover* and *Peek under covers* run from the palette and are off `WAITING_COMMANDS`.
75. The pinned list tests hold with `'cover'`: `multiSelectContracts.test.ts:42`,
    `graphicsSelection.test.ts:89` (`at(-2) === 'graphic'`), `multiSelect.test.ts:58`,
    `multiSelectCopy.test.ts:18`.

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
83. `read`, `careful` and `release`: the fake helper checks that at most 3 reads' crops are kept.
84. A read error comes back as `{ id, error }` for that read only (finding 23).
85. The helper's detector constants (`native/ocr/src/read.rs`, read as text) equal the tiny detector's
    pinned `inference.yml` values in `reader-models.json`.
86. `ocrHelperProblems`: a fixture importing `wer.dll` fails the allow-list; the budget is measured at
    brotli 11; `speechResources` carries `ssw-ocr.exe`; a build without it says so.
87. `verify-dist` §4d: a release build with `READER_MIRROR` null fails; a binary containing `readImage`
    fails; `OCR_IMPORTS` is checked.
88. Notices: `CRATES` holds `native/ocr/Cargo.toml`, `RUST_TITLE` names `ssw-ocr.exe`,
    `41-paddleocr-models.txt` exists, and `npm run notices -- --check` is up to date.
89. `installer.nsh`: `customInstall` writes the WER value and `customUnInstall` deletes it.
90. `helperPath`: the packaged path, `native/bin` in development, and `SSW_OCR_HELPER` honoured only
    unpackaged.
91. `readerIpc`: requests validated; one state shared by every window (finding 29).
92. The decode speed is recorded after a Find and used by `firstEstimate`.
93. `suspend` and `resume` reach the fake helper when `isToolbarVisible()` turns true and false.
94. `OcrHelper.start` refuses a helper that answers another protocol number.
95. A model pin mismatch reported by the helper (`error: 'model'`) sets the state to `damaged`.
96. The helper is started with `shell: false`, `windowsHide` and below-normal priority.
97. `careful` re-reads exactly the lines `needsCareful` picked on the committed main-set tiny reads (P3's
    function on `tests/fixtures/privacy-eval/reads/main-tiny.json.gz`).
98. The fake helper's crash on one read makes `runFind` (with P4's stub matcher) restart it once and
    continue.
99. The look batches' frame times and key flags parse into `LookData` without loss.
100. `tooLarge` from the helper ends Find with `privacy.run.failed` and the reason.

**Rust (`native/ocr`, `cargo test`, host build with the `fixture` feature and `SSW_OCR_MODELS`)**

- R1. `open` with intact models answers `opened`; the heartbeat runs throughout.
- R2. `open` with one changed byte in any model answers `error: 'model'` and parses nothing (a parse
  counter stays 0).
- R3. `tooLarge` for 7681×4320 and for 41 megapixels, before ffmpeg starts.
- R4. On the 24 evaluation PNGs (`readImage`), careful-long's reads scored with `score_reader.py`'s rules
  give pattern recall and padded coverage within 1 point of §5.6 (ONNX Runtime 100.0 and 100.0).
- R5. Tiles: a 3840×2160 frame is read as 4 tiles; a line across a tile edge comes back as one line.
- R6. A 4,333 px wide line is read in chunks and its text equals ONNX Runtime's within the parity
  tolerance of §5.6.
- R7. Spans: every character's span lies inside its line's box; spans are increasing.
- R8. (Windows) killing the helper kills its ffmpeg (job object).
- R9. A read that panics answers `error: 'read'` and the next read succeeds.
- R10. (Windows) the Windows build reads the evaluation PNGs as the host build does.
- R11. Look on a synthetic scroll video (made by the test with ffmpeg from one PNG) reports the scroll's
  shift per frame within one pixel.
- R12. Look on a window dragged diagonally reports both dx and dy.
- R13. Follow places parts on a selected (inverted) copy of the text.
- R14. Follow refuses a match when two places score within 0.15.
- R15. QR: the 6 codes of the set are decoded or reported as found; payloads come back only in the
  `read` answer, never on stderr.
- R16. Reads seek to the key frame before them: decoding a read at 19 minutes in a 20-minute clip
  decodes at most one key frame interval (counted with `showinfo`).

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
104. Every pattern runs in under 50 ms on 64 KB adversarial strings; lines are cut to 512 characters in
     overlapping windows.
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
132. `saidBleeps`: widening of 0.05 s and 0.15 s for estimated times, kind markers, no bleep inside an
     existing one, merging over 2,000 without dropping a hit.
133. Speech false hits: Flown's docs read as speech give at most 10 hits.
134. Screen false hits: Flown's English UI catalogue gives 0; `docs` at most 2 per 10,000 lines.
135. `scripts/vendor-privacy.mjs --check` passes and every vendored file carries its header.

**P4 · The scan**

136. `lookScale` and `lookStep` for 1080p, 4K and 7680×2160 at 30 and 60 fps.
137. `changedIn` and `keyBefore` on synthetic look data.
138. `planReads`: the first frame; settle reads 0.3 s after bursts; reveals every 0.75 s in a long scroll;
     typing reads after bursts and pastes, with valid and invalid cursor data; periodic reads.
139. The budget: over it, reveals and periodic reads thin and the plan reports `thinned`; settle reads of a
     region within 1 s merge first; first, settle and typing reads are never dropped.
140. Estimates: `firstEstimate` from length, size and rate; `secondEstimate` from the plan and measured
     speeds.
141. `walkForward` on a scripted matcher: holds without changes; follows a clear move; refuses an
     ambiguous one (two within 0.15) and becomes lost.
142. Lost areas (finding 4): a diagonal move with no clear candidate gives a 2-D union box, never a band
     along one axis.
143. The speed guide: a scroll whose profile is ambiguous keeps the last speed as a candidate.
144. Evidence of absence: a cover ends only when the next read lacks the text and the template search
     fails; it ends at the first changed frame with no match; with a match it goes on.
145. Re-anchoring: a read finding the group again corrects the path backward and keeps the lost area.
146. `walkBackward` (finding 3): a scroll before the first read is followed back with the move between f
     and f + 1; the cover covers the text in every frame from its appearance.
147. Zoom: a whole-region change matched at scale 1.25 places the cover.
148. Toasts over a cover: the cover is lost under the toast and placed again after it.
149. `findNotices`: a toast in the bottom right for 5 s is found; one lasting 40 s, one in the middle and
     one in a window recording are not; stacked toasts (finding 5) give each box and the union.
150. `foundCovers`: groups by group key, scores to tiers, colours from rings.
151. `withFoundCovers`: containment drops duplicates, overlap does not; `missed` set and cleared; rejected
     places suppress only their kind; user covers untouched; Find again never covers less anywhere.
152. `limitCovers` keeps at most 2,000 covers without uncovering anything.
153. `runFind` with the fake helper: progress phases; the result holds no text (a JSON scan of it finds none
     of the planted strings).
154. `runFind` and a failed read: a lost area from that frame until the next good read; `failedReads`
     counted (finding 23).
155. *Stop*: the found covers come back with unfinished walks run to the end as lost areas.
156. `followCover` returns a path never smaller than the cover's old one; without the reader, a
     template-only path marked `thin`.
157. `coverEverywhere` uses the last Find's reads when there are some, else a limited Find.
158. `lookCache` round-trips and is ignored when `screen.mp4`'s size or mtime changes.
159. `stopAnalyses` stops Find and forgets its reads.
160. A second `privacy:find` for the same project while one runs answers `busy`.

**P5 · Panel, Review, export notes, Polish and Settings**

161. `privacyReviewItems`: one row per group; Check rows first; titles with kind, times and place;
     badges.
162. `privacyKeep` and `privacyRemove` act on a row's covers and bleeps; Remove writes rejected places.
163. `privacyPendingCount` counts without making rows.
164. Keep all and Remove all of a kind are one undo step through `heldInSlices`; Remove all keeps a version
     first.
165. `doneReviewing` keeps every waiting suggestion in one step; its confirm names the Check rows and
     starts on *Cancel*.
166. The kind filter; with nothing left of a kind, `privacy.review.emptyKind` and focus on the filter
     (finding 34); *Show all changes* keeps focus (finding 32).
167. *Peek* and *Listen* are toggle buttons whose names include the row's title (finding 33).
168. `FindDialog`: defaults from Settings and the project; *listen* disabled without captions; the reader
     line, download and retry; the estimate; focus in and back (finding 31).
169. `RegionsDialog`: at most 5 added; the PC's and the UI language's regions always on.
170. `startFind` saves first, runs `detectSaid` on the captions, applies one update through
     `afterGestures`, and records `captionsSig` at the start (finding 14).
171. The progress line: phases, the second estimate, announcements at most every 10%.
172. `gatherPrivacy` runs on the run's captions and returns covers and bleeps for Polish.
173. Polish: the row shows only with the reader; on for new options, off for saved ones; the result lines.
174. `PrivacyExportNote`: hides, to check, running and captions-changed lines; absent for a project hiding
     nothing; its buttons close the dialog first (finding 30).
175. The export dialog of a project hiding nothing renders exactly as before (snapshot).
176. `TranscribeNote` shows for a service when Find listened or private bleeps exist.
177. `TranslatedNote` shows for a translation not translated again since a private bleep.
178. `NotCheckedNote` shows in `ShotViewer` with *Also send the screenshots* and no Find.
179. `PrivacySettings`: the reader's states and buttons; the lists; regions; colour; one shared state with
     the dialog (finding 29).
180. *Find private info…* runs from the palette and is off `WAITING_COMMANDS`.
181. Review's header shows Find's progress while it runs and *Find again…* after.
182. The said rows: *Said aloud* badge and *Listen*; their titles never hold a word.
183. The export note counts a Check row reviewed by *Keep* as done.
184. `useReaderState` updates every mounted user on one event.
185. The Settings nav item shows only when `showPrivacySettings()` is true and leads to the section.

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
- **AI**: for every fixture and every one of the 9 request builders, the request reaching
  `window.api.aiText` equals its digest.
- **Settings and presets**: stored export settings, bundle choices (`timelineMedia: 'recordings'`
  included), user presets and `editor-prefs.json` normalise and write back byte for byte.
- **Polish**: `planPolish` with saved options equals its digest.
- **Guide**: `shotSig` and `planActual` of every step of the guide fixtures equal their digests.
- **Home**: `listProjects`' summaries of the fixture folder equal their digests.

### 17.3 End to end (`tests/e2e/auto-blur.e2e.cjs`, under `xvfb-run`)

The host helper (`build-native --ocr-host`) and the pinned models in a fixed `userData`; fixture videos
made by the test from the evaluation PNGs with ffmpeg (lossless, `-c:v libx264rgb -qp 0`). Exported
frames are read back with ffmpeg as raw RGB.

- **A1. Find on a recorded fixture.** A 60 s video of eight evaluation frames with scrolls between them:
  *Find private info* with the defaults; Review lists the rows, Check rows first; *Done reviewing*; the
  export's every frame has every planted on-by-default item's box filled with its cover colour exactly
  (no pixel of the item's ink inside its box differs from the fill).
- **A2. Every output covers.** One project with three covers (one moving): MP4, WebM, MOV CineForm, GIF,
  transparent `background`, 120 fps, a batch, a per-chapter part, the thumbnail PNG, the export
  dialog's preview canvas, the guide's shots and its PDF and HTML pictures, a short clip copy and the
  timeline's *This export* mode: every cover box is the cover colour in every frame or picture.
  Variants:
  - **A2a joins**: a crossfade and a slide over a cut inside a cover's time.
  - **A2b vertical follow**: the 9:16 copy with the follow camera.
  - **A2c title-card background**: a title card with the blurred-frame background over a cover.
  - **A2d WebM and hardware raw frames**: the raw-frame route to ffmpeg and the WebCodecs route.
  - **A2e guide pictures**: the PDF's and the HTML folder's images, decoded.
  - **A2f motion blur, a magnifier and a blur shape** beside a cover: no pixel of the text inside the
    cover's box anywhere.
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
- **A12. Multi-select.** Select three covers; delete, undo, nudge, copy and paste them.
- **A13. Polish.** Polish with *Find private info* on a fixture with captions.
- **A14. The guide's buttons.** *Blur an area…* adds a cover coloured from the step's shot frame.
- **A15. Follow and Everywhere.** A user cover over a scrolled email follows it; *Cover this text
  everywhere* covers its other places.
- **A16. The rendered tracking set** (`scripts/privacy/make-track-fixtures.mjs`, new, written in the
  contracts step from the evaluation set's generator): lossless videos at 60 fps of a scrolling list,
  browser zoom in and out, text selected and deselected, a sticky header over a scrolling page, a window
  dragged diagonally, stacked toasts sliding in and out, and the new-seed held-out frames, with every
  planted item's box known in every frame. After Find, every on-by-default item is covered (its whole
  ink inside a cover) in **every frame** it shows in, for every video. A failure prints the item, frame
  and uncovered pixels.
- **A17. The English guard.** `guard-delta.mjs` on the merged tree passes; the baseline is re-recorded
  only then (§12.2).

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
| 3 | A cover lagged one move behind before the first read when following backward | §5.8 backward walk uses the move between f and f + 1; test 146 |
| 4 | A diagonal lost area was drawn as a band along one axis | §5.8 step 5: a 2-D union box; test 142 |
| 5 | Stacked toasts | §6.13 each notice and the stack's union; test 149 |
| 6 | The helper's display scale: reads of HiDPI frames landed off the text | §5.5 reads at the recording's own pixels, tiled, never scaled; covers normalised by the video's size; tests R5, 102 |
| 7 | `limitCovers` was quadratic | §5.10 heap merging, O(n log n); tests 13, 152 |
| 10 | A spoken number said across sentences and number words was not found | §7.2 the digit stream across captions and full stops; test 129 |
| 11 | The matcher was built from the padded span | §6.1 own spans for everything that finds text again; test 127 |
| 12 | Chapter title cards were not masked for spoken secrets | §7.5 `settleSaid` masks `titles[]`; test 22 |
| 13 | Tidy captions kept real words under private bleeps | §7.4 masking by time, whole span when words do not line up; masked requests; tests 18, 23 |
| 14 | `saidStale` was lost when captions changed during Find | §7.7 `captionsSig` taken at Find's start; test 170 |
| 16 | A cover drag overwrote Find or Follow results arriving meanwhile | §5.10 and §14.1 results through `afterGestures`, merged against the current project; tests 61, 170 |
| 17 | `readCovers` was quadratic on huge projects | §4.3 one linear pass; test 3 |
| 18 | Copy and paste of a cover pasted old items or an image | §14.4 snapshots at copy time, own project only, no OS clipboard; tests 49, 72 |
| 19 | Opening a version settled its suggestions | §14.1 no settle step for covers; edits drop `found` themselves; test 52 |
| 20 | Covers past the key limit loaded coarser | §4.2 writers never exceed the limits; §4.3 readers only ever grow boxes; test 2 |
| 22 | A line box rounded past the frame's edge | §6.1 clipped, never rounded past the edge; test 127 |
| 23 | A failed read was dropped silently | §5.6 a lost area and the failed-reads line; tests 84, 154, A10 |
| 24 | Names with a leading star were written to logs | §10.6 stars stripped, names joined to `secretValues()`; test 35 |
| 25 | No heartbeat during the helper's open phase | §10.4 heartbeat from start; tests 81, R1 |
| 26 | A failed reader download was not shown | §2.5 `privacy.find.readerFailed` with *Try again*; test 79 |
| 28 | The names list was not reloaded after *Cover this text everywhere* | §5.9 dialogs read the list again; test 62 |
| 29 | The panel and Settings kept separate reader states | §16.5 `useReaderState`, one shared state; tests 91, 179, 184 |
| 30 | The export note's buttons did not close the dialog | §2.12 and §11 close first, then open; test 174 |
| 31 | Focus going into and back from the Private info panel | §11 focus rules; test 168 |
| 32 | Review's *Show all changes* lost focus | §11; test 166 |
| 33 | Peek and Listen's labels were missing from their accessible names | §2.8 and §11 names include the row's title; test 167 |
| 34 | The filtered empty Review list had no message | §2.7 `privacy.review.emptyKind`; test 166 |
| 35 | The Check bar's line style | §2.3 and §11: dashed waiting edges, `--warning` for Check, a text badge; test 66 |
| 36 | Selection did not follow focus on the Covers row | §11; test 67 |
| 37 | Focus after Follow's *Stop* and *Keep* | §11; test 61 |
| 1, 2, 8, 9, 15, 21, 27 | Not recorded by name (they were in the outputs and finding lenses) | §9's row for every output path, A2 and its variants, and test 20 cover the output lenses; §5.6, §5.10 and §17.1 tests 141-160 the finding lenses |

### 19.2 What the first build left undone, and where it is done now

| Left undone | Done here |
|---|---|
| Multi-select and group edit of covers | §14.4; P1 tests 70-72, 75; A12 |
| A16, the rendered tracking set, run end to end | §17.3 A16; `make-track-fixtures.mjs` written in the contracts step |
| The guide's *Blur an area…* coloured from the step's own shot frame | §8.4 `ringColourAt` at the shot time; test 59; A14 |
| Re-reads decoding from the start of the recording | §5.5 and §5.8 seek to the key frame before; test R16 |
| Numbered tests folded into one file | §17.1: one `it` per number, checked by `autoBlurNumbers.test.ts` |
| A2's variants only as unit tests | §17.3 A2a-A2f end to end |
| libphonenumber-js and double-metaphone not added | §6.14 vendored by `scripts/vendor-privacy.mjs` (no `npm install` needed), with notices |
| tract against ONNX Runtime not measured on the shipped bytes | measured on PaddlePaddle's own files, which are the shipped bytes (§5.6); the contracts step repeats it |
| Character list counts written wrongly (6,908 and 18,712) | 6,904 and 18,708, read from the pinned `inference.yml` files (§0 decision 1) |
| `aiTextFor` masked only private forms | still so, on purpose: ordinary bleeps would change old projects' requests (§7.6) |
| Still for a person | the mirror, the Windows-only checks, the native Bangla review and the other account's `private.json` (§16.6) |
