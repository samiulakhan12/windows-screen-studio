# Output and the app (wave 12): final design

Plan: `docs/PLAN.md`, wave 12 "Output and the app", two items. Roadmap items: LT-22 (pro export
formats: HEVC, AV1, ProRes and WebM with transparency, 4:5, 24/25/120 fps, saved presets, WAV stems,
FCPXML / EDL) and X-05 (the app in Bangla and other languages, with AI-drafted translations reviewed
by people). Written against `rev/wave12-design` at `dd368c7` (everything through wave 8, versions,
Captions Studio phases A and B). Line numbers refer to that commit unless a branch is named.

Two waves merge before the contracts step (§21.0). Wave 12 builds on what they leave:

- **Wave 10, editing polish** (`feat/wave10`, `/home/user/wt-w10b` at `1b9d672`,
  `docs/design/editing-polish.md`; built). It splits `drawFrame` into `drawFramePicture` and
  `drawFrameOverlays` with a `FrameExtras` argument (joins), adds `gradeLayer.ts` (WebGL2), and edits
  the export files this wave also needs: `exporter.ts` (+173 lines: the join feed,
  `prepareEditingAssets`, `effects`, `bed`), `exportJob.ts` (`validEffects`, the library and loop
  cache), `exportIpc.ts` (a `starting` AbortController, `loopableMusic`), `exportArgs.ts` (`bed`,
  `effects` on `ExportIo`), `src/shared/api/export.ts` (`MusicSound.bed`, `ExportJob.effects`),
  `audioPlan.ts` (`bedGraph`, effect inputs), `ExportDialog.tsx` (the missing-LUT question),
  `ExportPreview.tsx`, `compositor.ts`, `commands.ts`, `shortcuts.ts`, `types.ts`, `project.ts` and
  `SettingsDialog.tsx`. It adds about 364 unique UI texts in 27 more renderer files.
- **Wave 11, smart tools** (`feat/wave11`, `/home/user/wt-w11b`; contracts made at `dacda77`, parts
  being built; `docs/design/smart-tools.md` §20). It adds `rememberExported` to `exportIpc.ts`, a
  "Make short clips…" link in the export dialog's done view, "n of them not reviewed yet" in
  `ExportBundleOptions.tsx`, exports `prepareFrames` and `openSource` from `exporter.ts`, five
  `PrefKey`s and their sanitisers in `prefsIpc.ts`, `'localAi'` in `SettingsSection`, eight commands,
  about 40 new UI files, and `GUIDE_WORDS` (English and Bangla words written into guide documents;
  `smart-tools.md` §15 leaves the app's own UI to this wave). It touches no drawing layer,
  `windows.ts`, `appSettings.ts` or `Home.tsx`.

Wave 12 edits those files only after both waves have merged, and puts its own code in new files
behind seams the contracts step completes (§21).

Terms used below:

- **Format**: the container chip of the export dialog (MP4, MOV, WebM, GIF, M4A and, new, WAV).
- **Codec**: the video compression inside it (H.264, HEVC, AV1, VP9, CineForm, Animation (the
  *Lossless* chip), ProRes).
  **Default codec**: H.264 for MP4 and MOV, VP9 for WebM: what each format meant before this wave.
- **Intermediate**: a large, lightly compressed file meant for editing software (CineForm, Animation,
  ProRes). Its size is set by quality only.
- **Straight alpha**: colour stored apart from its opacity (what VP9 with alpha, CineForm, ProRes 4444
  and QuickTime Animation expect). **Premultiplied**: colour already multiplied by opacity (what a
  Chromium canvas holds and what a `VideoFrame` made from it reads back as).
- **Stem**: one WAV file per kind of sound on the output timeline: voice, system sound, music,
  effects (or one "recording" stem when the recording has no separate microphone and system files).
- **Timeline file**: an FCPXML, Premiere XML (xmeml) or EDL file that another editor imports.
- **Message**: one UI text in ICU MessageFormat. **Key**: its name (`export.codec.hevc.title`).
  **Namespace**: the first part of a key and the catalogue file it lives in (`export`).
  **Catalogue**: the messages of one language.
- **UI language**: the language of the messages (`en`, `bn`, `es`, `hi`). **Format locale**: the BCP 47
  tag Intl formats numbers and dates with (`en-US`, `bn-BD-u-nu-beng`).
- **English profile**: the exact formatting each call site uses today (en-US where it names no
  locale, en-GB for `versionTime`, `String(n)` where it interpolates). The English UI keeps it.
- **Shipped language**: a language whose approved messages reach the picker's threshold (§15.6). A
  **preview** is a shipped language whose recording-side texts are not translated yet (§0 decision 11).

The rules of the earlier waves hold:

- Preview and export draw the same frames and play the same sound. One drawing path (`drawFrame`).
  A transparent export is drawn by the same code with one option, and the export dialog's preview
  draws it the same way over a checkerboard (§6).
- Old projects, settings and export presets load and behave byte for byte as before. Every new field
  is optional and absent by default. **No project file gains a field in this wave**: 4:5 is an export
  shape only, never saved in a project (§4.6). Stored export settings, batch choices, bundle choices
  and preferences that hold no new field are written back unchanged (§4.3, test 2).
- One user action is one undo step. This wave adds no project edit, so it adds no undo step (§20).
- Everything works with the keyboard and a screen reader. The app UI meets WCAG AA contrast with the
  tokens of `src/renderer/src/styles.css`.
- Everything runs offline by default. Nothing downloads. **Translations are never fetched or sent
  anywhere while the app runs**: catalogues live in `app.asar` and change only with app updates.
- Only codecs and data whose licences allow commercial redistribution. Every encoder used here is
  already inside the shipped `ffmpeg.exe`; §5.1 lists what the binary holds (used or not) with each
  licence and patent position, and §0 decisions 1–3 are the owner's.
- The installer grows by about 0.3–0.4 MB (§19.5). No item reaches the 5 MB line.
- **The English UI does not change while the strings are extracted**: same text, same accessible
  names, same layout. Two guards written before any extraction prove it after every extraction
  commit (§10.6, tests 9 and 10). They run on a fixed clock and fixed data, so they compare only
  what the extraction could change.
- Nothing on the recording side changes: `src/main/recording/*`, `src/main/recordingIpc.ts`,
  `src/main/windows.ts`, `src/shared/recording/*`, `Toolbar.*`, `src/renderer/src/recorder/*`
  (`RecordingOptions.tsx`, `RecordingPresets.tsx` among them) and `src/main/appSettings.ts` belong to
  the other account. Their strings stay in English until the other account agrees; the catalogue
  reserves a namespace for them so they can join without changes elsewhere (§9.5). Until then a
  language that otherwise ships is shown as a preview (§0 decision 11).
- `src/main/security.ts` and the CSP do not change.

The research behind this design is kept outside the repository, in the lead's scratch folder
`w12-design/`: `code/` (the code map, the `ffmpeg.exe -encoders` and `-h encoder=…` dumps run under
wine, the test encodes, the WebCodecs and Intl probes in Electron 44.9.3, the string inventory
`strings.cjs` with `strings-w12.json` and `strings-w10.json`), `formats/` (the encode benchmark
`bin/bench.sh`, the per-encoder dumps `win-enc-*.txt`, and `otio/` with `flown-1.10.fcpxml`, which
validates against Apple's FCPXML 1.10 DTD, `flown.xml`, `flown.edl` and `flown-markers.edl`),
`i18n/` (the AST counts, the Intl and plural probes, the bundle-size builds, the Bangla rendering and
digit-width screenshots, and the text of Microsoft's Bangla (India) style guide) and `designer-r2/`
(Access Advance's HEVC Advance Program Overview of July 2026, `hevc-2026.pdf`).

---

## 0. Decisions for the owner

**Decided by the owner on 9 November 2026: every recommendation below is accepted.** HEVC through the
graphics card only for now and an `ffmpeg.exe` without libx265 and the HEVC decoder in the first
release after this wave (1 a, then c); no ProRes, CineForm for editing (2 c); `ffmpeg.exe` built in CI
from a pinned public script with its source published (3 b, with 3 a until then); no DNxHR (4);
Bangla first, then Spanish and Hindi (5); two reviewers per language with signed rights (6); the
shipping rule of 7; offer a language once and never switch (8); Bangla digits for prose quantities (9);
exported files stay English (10); the recording side is asked now and Bangla ships as a preview until
it is translated (11); the English UI unchanged (12); one fixed gain for stems (13); the checks of 14
before release (15 as written). Still needed from people: the second Bangla reviewer and the signed
rights of both (6), the other account's agreement for the recording side (11), and the checks on
Windows and in other editors (14). Until the reviewers approve, Bangla does not reach the picker
(the shipping rule of 7); the build ends at step S4 (section 10.4).

Nothing in this wave changes how an existing project looks or sounds, and nothing changes the English
UI that exists today. Every new codec runs through an encoder already inside the shipped `ffmpeg.exe`
(gyan.dev 6.1.1 "essentials", GPL v3, 82,797,568 bytes, pinned in `scripts/lib/packaging.cjs:18-22`).
The installer grows by about 0.3–0.4 MB. Each decision below has a recommendation; the section named
holds the details.

1. **HEVC (H.265).** The shipped `ffmpeg.exe` already contains the x265 encoder (3.5-153-gce8642f22,
   GPLv2+) and FFmpeg's HEVC decoder; Flown has distributed both since it first shipped. Patent
   royalties attach to each copy distributed that contains an HEVC encoder or decoder, not to use.
   Two pools, plus independent holders (§5.1): HEVC Advance ("All HEVC Software" from 1 July 2026:
   $1.00 a copy in Region 1 and $0.50 in Region 2 with its logo discount, $1.111 and $0.555 without,
   $1.333 and $0.667 at standard rates) and VCL Advance (the former Via LA pool, a separate licence:
   100,000 units a year free, then $0.30 and $0.20). Bangladesh and India are Region 2.
   - (a) HEVC export through the graphics card only (WebCodecs, NVENC, Quick Sync, AMF, Media
     Foundation hardware). This limits what Flown runs, not what it distributes.
   - (b) Also x265 in software, with licences from both pools. Before signing, counsel checks GPLv2 §7
     and GPLv3 §11–12: a patent licence that covers only Flown's copies of a GPL program may conflict
     with them.
   - (c) Ship an `ffmpeg.exe` built without libx265 and without the HEVC decoder (decision 3). Only
     this ends the exposure from the binary. HEVC import then needs Windows' own decoder or a clear
     refusal; that plan belongs to (c), not to this wave.

   **Recommended: (a) now, (c) in the first release after wave 12.** `CODEC_POLICY.hevcSoftware` is
   `false`; (b) is that constant and one test fixture.
2. **ProRes and CineForm.** Apple calls FFmpeg's ProRes encoders unauthorised, "ProRes" is its
   trademark, and Windows has no hardware ProRes encoder. CineForm carries less risk, not none:
   GoPro holds CineForm-family patents, the Apache-2.0 grant of GoPro's SDK covers GoPro's code and
   not FFmpeg's independent `cfhd`, and "CineForm" is GoPro's trademark (§5.1).
   - (a) Apply to Apple for a ProRes licence.
   - (b) Ship `prores_ks`, named honestly, never tagged `apl0`.
   - (c) Leave ProRes out and offer CineForm for editing.

   **Recommended: (c)**, accepting that lower risk; before release, look up GoPro's patent
   declaration for SMPTE ST 2073 (VC-5). `CODEC_POLICY.prores` is `false`. `CODEC_POLICY.cineform`
   is `true` and turns CineForm off without code changes; QuickTime Animation then carries
   transparent MOV exports, and the *For editing* and *Transparent overlay* destinations are hidden.
3. **Corresponding Source for `ffmpeg.exe`.** `ffmpeg.exe.README` names FFmpeg's commit
   (`e38092ef93`) and each library's version, but not gyan.dev's build scripts and patches, which
   GPLv3 §1 counts as Corresponding Source. The notice today points only at ffmpeg.org
   (`resources/THIRD_PARTY_NOTICES.txt:338-345`).
   - (a) Get gyan.dev's exact scripts and patches in writing, and publish them with the sources of
     the listed versions as a release asset.
   - (b) Build `ffmpeg.exe` in CI from a pinned public build script (BtbN FFmpeg-Builds or
     media-autobuild_suite) and publish the source and scripts as a release asset.

   **Recommended: (b)**, which also carries out 1 (c) and leaves out the unused patent-relevant
   libraries of §5.1; (a) until (b) ships.
4. **DNxHR** (`dnxhd`, in the build) is not offered; Avid's patent position was not checked.
   **Recommended: leave it out.**
5. **Languages and their order.** Bangla first, in Bangladesh's standard forms (Bangla Academy's
   spelling rules, Microsoft's Bangla (Bangladesh) style guide, §15.2), one `bn` catalogue for
   Bangladesh and India. Then Spanish (`es`) and Hindi (`hi`), each when it has two reviewers. Arabic
   and Hebrew after a right-to-left review (§13). **Recommended.**
6. **Reviewers and their rights.** Two native speakers per language: one corrects the drafts in
   context, the other approves (§15). Each signs a short contributor licence or assignment, or works
   under a contract, before their first string is accepted; `translations/reviewers.json` lists them
   and the checks refuse anyone else. For Bangla, the owner and one more person. About 3 to 6
   reviewer-days per language for the core screens. The AI service used for drafts must allow
   commercial use of its output. **Recommended.**
7. **What ships untranslated** (§9.7) and when a language ships: when 95% of its keys and 100% of
   the core namespaces are approved (§9.2; the core now includes captions and the inspector panels).
   Anything not approved shows in English, string by string. **Recommended.**
8. **The default language.** English until the user picks, on new installs too. Home offers a
   shipped language once, when Windows lists it or Flown already knows offline that the user works
   in it (a Bangla speech model, a project with Bangla captions, §2.7). **Recommended: offer, never
   switch.**
9. **Digits in the Bangla UI.** Prose quantities (counts, sizes, durations, dates, the timecode) in
   Bangla digits; technical lines (the size line, resolutions, frame rates, codec hints) in Latin
   digits as whole messages, so no line mixes the two (§11.3). Western digits everywhere are one
   choice in Settings. **Recommended.**
10. **Exported files stay English** (file names, sidecars, stems, timelines, guide words for Spanish
    and Hindi) in every UI language, so a project exports the same files on every PC.
    **Recommended; revisit when users ask.**
11. **The recording side** (22 files, 310 texts, §9.5) stays English until the other account agrees.
    Until it is translated, a shipped language shows as a preview: "বাংলা (প্রিভিউ) · Bangla
    (preview)" in the picker and the offer, and the release notes name the English parts.
    **Recommended: ask now, so their keys are drafted and reviewed with the core.**
12. **The English UI.** No visible change, and no bidi-isolation characters in English (§13.3).
    `aria-keyshortcuts` is added only where a control's tooltip does not already name its shortcut,
    after an NVDA check (§14.2). "Bengali" in the captions lists against "Bangla" in new text is
    listed in `scripts/i18n/english-changes.md` for one later, deliberate change. **Recommended.**
13. **Stem loudness.** One fixed gain, the one the preview plays, instead of the video's
    time-varying `loudnorm`, so the stems add up to the preview's sound (§7.4). **Recommended:
    accept.**
14. **Checks on Windows and in other editors, required before release**: the GPU encoders' quality
    values, WebCodecs HEVC and AV1, `av1_amf`'s padding, the alpha export's speed, the Bangla UI on
    Windows 10 and 11 with NVDA (`aria-keyshortcuts` included), timeline imports into DaVinci
    Resolve, Premiere Pro and Final Cut Pro, and which of WebM, AV1, CineForm, QuickTime Animation
    and 32-bit float PCM in MOV each editor opens (§8.5, `EDITOR_OPENS`). The owner provides Premiere
    and a Mac, or the timeline chips ship labelled with the editors checked.
15. **Installer size.** About 0.3–0.4 MB more (§19.5). Chromium's locale packs (8.7 MB) and a second
    `ffmpeg.exe` for SVT-AV1 are not proposed. **Recommended.**

---

## 1. Summary

- **More codecs.** MP4 gains HEVC and AV1; MOV gains HEVC, CineForm and QuickTime Animation (shown as
  *Lossless*); WebM gains AV1. A new **Codec** row under Format picks them; each format's old codec
  stays its default, so saved settings export exactly as before. HEVC runs only on hardware encoders
  and its chip shows only where one exists (§0 decision 1). AV1 uses the graphics card when it can
  and libaom on the CPU otherwise (slower, and the dialog says roughly how long). ProRes is built but
  off (§0 decision 2).
- **Transparent video.** For MOV and WebM, a **Background** row: *With background* (today),
  *Transparent* (no background: the card, camera and everything over it stay, the rest is
  see-through) or *Overlays only* (captions, texts, shapes, title cards and the camera, without the
  recording). Transparent files are WebM with VP9 (for web pages) or MOV with CineForm or Lossless
  (for editing software). The same `drawFrame` draws them, crossfades and dips included; the dialog's
  preview shows them over a checkerboard.
- **4:5 and more frame rates.** A 4:5 export shape (1080 × 1350 at 1080p) in the Aspect row, the batch
  "Also" row and a new **Portrait post** destination; 24, 25 and 120 fps beside 30 and 60.
- **Destinations for editors.** *For editing* (MOV, CineForm) and *Transparent overlay* (MOV,
  CineForm, Overlays only) sit with the other destinations, so nobody has to know a codec's name.
- **Saved presets.** "Save as preset" keeps the current settings under a name; *Your presets* sit
  above the destinations, can be updated, renamed, deleted, saved to a `.flownpreset` file and
  imported from one. An imported file is untrusted data, read through a strict reader in main
  (§18.2), and the dialog says when a preset's codec cannot be made here.
- **Sound stems.** *Also save → Sound stems (WAV)* writes one 32-bit float WAV per sound: voice,
  system sound, music, effects (or one recording stem). They start at 0, have the video's exact
  length, and add up to the sound the preview plays. A new **WAV** format saves the soundtrack alone,
  uncompressed.
- **Timelines for other editors.** *Also save → Timeline* asks which editor the timeline is for
  (DaVinci Resolve, Premiere Pro, Final Cut Pro, or another editor through an EDL) and writes FCPXML
  1.10, Premiere XML or a CMX 3600 EDL, with chapter markers. They use either **this export** (the
  finished video, picture only when stems are written, and the stems) or **the original recordings**
  (cuts, speed changes, pause freezes and crossfades over copies of `screen.mp4` without its sound,
  the camera on a track turned off, and WAV conversions of the microphone and system sound; zooms,
  cursor effects, backgrounds, captions and layouts are not carried, and the dialog says so). The
  done view says how to open each file in its editor.
- **Flown in other languages.** Every UI text moves into JSON catalogues of ICU messages, read by one
  small runtime shared by main and renderer (`intl-messageformat` 12.1.4, BSD-3-Clause, 9.8 KB gzip).
  Settings gains a **Language** section once a language ships (Follow Windows, English, বাংলা, and
  later Español and हिन्दी) and a digits choice; the change applies when Flown restarts, never while
  an export or a recording is running. Numbers, dates, durations, lists and plurals follow each
  locale through Intl, and the English UI keeps its exact formatting. Bangla uses the bundled Noto
  Sans Bengali (0 new bytes) with taller lines and a one-step larger type scale. Drawn frames never
  follow the UI language.
- **Ready for right to left.** CSS moves to logical properties (identical in left-to-right), the page
  gets `lang` and `dir`, the timeline and preview stay left to right, user text is isolated, and a
  mirrored pseudo-locale checks it. No right-to-left language ships in this wave.
- **Translations drafted by an AI service, approved by people.** Drafts are made at development time
  only, with a glossary tried on Bangladeshi users, descriptions and screenshots; two native speakers
  who have signed a contributor agreement correct and approve each string in context; only strings
  approved by both ship, and anything else shows in English.
- **Checks.** A TypeScript-AST scanner fails the build on any UI text without a key (confirmation
  questions included); catalogue checks cover syntax, placeholders, plurals, length, glossary terms,
  digits, normalisation, reviewers and stale translations; both run in a new CI workflow and in
  `scripts/predist.mjs`.

---

## 2. What the user sees

### 2.1 Export dialog › Settings

The Settings section of the export dialog (`ExportDialog.tsx:829-960`) keeps its rows and their order.
One row is new everywhere (Codec, under Format) and one for MOV and WebM only (Background, under
Codec); three rows gain chips (Format, Aspect, Frame rate); Quality, Target size and Encoder adapt to
the codec. Rows that do not apply are hidden, as GIF and M4A hide rows today. With today's default
(MP4, H.264) the only differences are the Codec row and the new chips: no standing warning, no
disabled chip without a reason.

**Format** (today: MP4 · MOV · WebM · GIF · M4A). One chip is added at the end:

| Chip | Title (exact) |
|---|---|
| WAV | The soundtrack only, uncompressed (32-bit float WAV), nothing is rendered |

The other format chips keep their titles while the codec is the format's default. With another codec
the selected chip's title names what is made: "{codec} video with {audio} audio", for example "HEVC
video with AAC audio" or "CineForm video with uncompressed audio".

**Codec** (new, under Format; shown for MP4, MOV and WebM). `Choice` chips:

| Format | Chips, in order (default first) |
|---|---|
| MP4 | H.264 · HEVC · AV1 |
| MOV | H.264 · HEVC · CineForm (for editing) · Lossless (· ProRes 422 · ProRes 4444, only with §0 decision 2 (b)) |
| WebM | VP9 · AV1 |

| Chip | Title (exact) |
|---|---|
| H.264 | Plays everywhere |
| HEVC | About a third smaller than H.264 at the same quality. Made by your graphics card. Windows needs Microsoft's HEVC Video Extensions to play it |
| AV1 | About half the size of H.264 at the same quality. Fast with a recent graphics card, slower without one. Plays in browsers, on YouTube and in Windows 11 |
| VP9 | Plays in every browser |
| CineForm (for editing) | GoPro CineForm, for editing in Premiere Pro, DaVinci Resolve and After Effects: large files that stay sharp through more editing. Can be transparent |
| Lossless | QuickTime Animation: lossless and transparent, very large. For short overlays |
| ProRes 422 | For Final Cut Pro and Apple workflows. FFmpeg's ProRes encoder, not certified by Apple |
| ProRes 4444 | ProRes with transparency. FFmpeg's ProRes encoder, not certified by Apple |

The HEVC chip depends on the probe, which runs when the Settings section first shows MP4 or MOV
(§5.9):

| Probe | HEVC chip |
|---|---|
| Running | shown, disabled, title "Checking for an HEVC encoder…" |
| Found an encoder | shown and enabled |
| Found none | not shown |

When stored settings or a preset ask for a codec this PC cannot make (HEVC where the probe found
nothing), the dialog uses the format's default codec and says so under the row (exact): "This PC
cannot make HEVC, so this export uses H.264." That is the only case in which the HEVC question is
mentioned on a PC without an HEVC encoder.

A hint under the row says what will run (replacing the Encoder row's hint for the new codecs):

| Codec and machine | Hint (exact) |
|---|---|
| HEVC, GPU found | HEVC on your graphics card ({names}). |
| AV1, GPU found | AV1 on your graphics card ({names}). |
| AV1, no GPU | AV1 on the processor takes about 6 times as long as H.264: roughly {time} for this video. |
| CineForm | About {size} for this {length} video. Editing formats ignore Target size. |
| Lossless | Up to {size} for this {length} video, more with motion. |
| ProRes 422 / 4444 | About {size} for this {length} video. |

`{names}` lists the probed encoders as the H.264 hint does today ("NVENC, QSV"), or "WebCodecs" when
Chromium's own encoder makes the codec on the graphics card (its first route; for AV1 also while the
ffmpeg probe still runs, so the brackets are never empty); `{size}` comes from
`estimateBytes` and `{time}` from `encodeSecondsEstimate` over the video's length (§5.10); `{length}`
is the video's duration.

**Background** (new, under Codec; **shown for MOV and WebM only**). Three chips:

| Chip | Title (exact) |
|---|---|
| With background | The background as in the preview |
| Transparent | No background: the recording, the camera and everything over them stay; around them the video is see-through |
| Overlays only | Only what goes over the recording: the camera, captions, texts, images, key presses, title cards and the progress bar. No recording and no background. For laying over another video |

- MP4 shows no Background row: MP4 cannot be transparent, and a row of disabled chips on the format
  almost everyone exports would be noise. The way in from MP4 is the *Transparent overlay*
  destination (§2.2) or the MOV and WebM chips.
- Picking *Transparent* or *Overlays only* switches a codec that cannot carry transparency in the
  same click (MOV: H.264 or HEVC → CineForm; WebM: AV1 → VP9), and the hint says "CineForm keeps the
  transparency." or "VP9 keeps the transparency.". The dialog remembers the codec it replaced: picking
  *With background* again in the same dialog session puts it back, with the hint "Back to {codec}.".
  Picking a codec that cannot carry transparency puts Background back to *With background*. With
  `CODEC_POLICY.cineform` off, MOV switches to Lossless instead.
- Hint while transparent (exact): "Plays transparent in Chrome, Edge and Firefox (WebM), and in
  editing software (MOV). Safari shows WebM on black." When the card fills the frame (*Transparent*
  with padding 0), the line of §6.1: "With no padding the recording fills the frame: nothing will be
  see-through. Add padding in Style, or choose Overlays only."
- Cut styles (crossfades, dips, slides) play in a transparent video as they do in the preview (§6.4).
- The dialog's preview shows a transparent export over a checkerboard (§6.5).

**Resolution** is unchanged.

**Aspect** (today: Project · 16:9 · 9:16 · 1:1 · 4:3). One chip is added: **4:5**, with the title
"Export in 4:5 (1080×1350 at 1080p); the project keeps its own shape". The size note of each
resolution chip already shows the exact pixels (`resolutionOptions`, `ExportDialog.tsx:567`).

**Frame rate** (today: 30 fps · 60 fps). Now five chips:

| Chip | Title (exact) |
|---|---|
| 24 fps | The film rate. Scrolling looks less smooth than at 30 |
| 25 fps | The TV rate in Europe, Africa, South Asia and Australia |
| 30 fps | (no title, as today) |
| 60 fps | (no title, as today) |
| 120 fps | For 120 Hz screens. Most sites play at most 60 fps. Exports take about twice as long as 60 fps |

120 fps with H.264 at 4K is disabled, with the reason under the row: "H.264 cannot carry 4K at 120
fps. Choose HEVC or AV1, or 1440p." Picking 4K while H.264 is at 120 fps sets 60 fps and the hint
says "4K with H.264 is exported at 60 fps.".

**Quality** keeps its three chips (Studio · Web · Small file) for the delivery codecs. For the
intermediates the chips read **Best · High · Medium** and pick the encoder's own levels (§5.4):

| Codec | Best | High | Medium |
|---|---|---|---|
| CineForm | film1 (title "CineForm Film quality") | high ("CineForm High") | medium ("CineForm Medium") |
| ProRes 422 | 422 HQ ("ProRes 422 HQ") | 422 ("ProRes 422") | 422 LT ("ProRes 422 LT") |
| Lossless | (Quality hidden: lossless) | | |

**Target size** is disabled for the intermediates, for transparent exports and for WAV, with the hint
"Editing formats are sized by quality, not by a target." or "Transparent videos are sized by quality,
not by a target." or "WAV files are uncompressed.".

**Encoder** keeps *Auto (GPU when available)* and *Software*. For HEVC, *Software* is disabled with the
reason "HEVC uses your graphics card only" (§0 decision 1 (a)). For the intermediates the row is
hidden: they always run on the processor.

The size line under the preview (`export-size`, `ExportDialog.tsx:713`) keeps its text and adds the
codec when it is not the default: "1080×1350 · 30 fps · HEVC · 2:14". It is a technical line: its
digits stay Latin in every language (§11.3).

### 2.2 Destinations and saved presets

- **New built-in destinations.** `ExportPreset` gains optional `codec` and `alpha`, and `PresetIcon`
  gains `'portrait'`, `'editing'` and `'overlay'`:

  | Card | Id | Settings | Title (exact) |
  |---|---|---|---|
  | Portrait post | `portrait-post` | MP4, 1080, 30 fps, Studio, 4:5 | 4:5, for Instagram, Facebook and LinkedIn feeds |
  | For editing | `editing` | MOV, CineForm, 1080, 60 fps, Best | A large MOV that stays sharp in Premiere Pro, DaVinci Resolve and After Effects |
  | Transparent overlay | `overlay` | MOV, CineForm, Overlays only, 1080, 60 fps, Best | Captions, texts and the camera on a see-through background, to lay over another video |

  *Portrait post* follows *Square post*; the other two follow *Email*. Each card shows its meta line
  like the others ("1080×1350 · 30 fps", "MOV · CineForm · 1080p60"). With `CODEC_POLICY.cineform`
  off the last two are hidden.
- **Save as preset.** A small button **Save as preset** follows the Settings header as its own
  control, never inside the header's toggle button (`ExportDialog.tsx:849`), and shows only while
  Settings is open. It opens an inline row: a text field labelled "Preset name" (placeholder "Preset
  name", up to 60 characters, prefilled with a suggestion built from the settings, e.g. "MOV CineForm
  1080p30"), **Save** and **Cancel**. Enter saves, Escape cancels. The new preset is selected and the
  header reads "Settings · {name}".
- **Your presets.** A heading "Your presets" and one card per saved preset, in the order they were
  saved, with a generic preset icon, the name and the meta line. Once at least one exists, *Your
  presets* sit **above** the built-in destinations. Each card has a **More** button (⋯, accessible
  name "More for {name}") with a menu:
  - *Update with these settings* (when the settings differ from the preset),
  - *Rename…* (the same inline field),
  - *Save to a file…* (a save dialog for `{name}.flownpreset`),
  - *Delete* (asks inline: "Delete “{name}”?" with **Delete** and **Cancel**).
- **Import.** A link under the grid, **Import presets…**, opens a file dialog for `.flownpreset` files
  and adds what it can read. Notices (exact):

  | Case | Notice |
  |---|---|
  | One or more read | "Imported 1 preset." / "Imported {n} presets." (one plural message) |
  | Nothing readable | "This file has no presets Flown can read." |
  | Over 64 KB | "This file is too large to be a Flown preset file." |
  | Over the limit | "You can keep 50 presets, so {n} were not imported." |
  | A codec Flown does not make | "{n} presets use ProRes, which Flown does not make: they export as MOV with CineForm." (§4.3 rule 2) |

  A preset whose name is taken gets " (2)", " (3)".
- **A preset whose codec this PC cannot make** (a colleague's HEVC preset on a PC without an HEVC
  encoder): picking it applies its settings with the format's default codec and shows under Codec
  (exact): "This preset uses HEVC, which this PC cannot make: it exports H.264." The preset stays
  selected (`matchesUserPreset` compares with the codec this PC would use). In batch mode, its row
  shows the same line before the export starts.
- **At 50 presets** *Save as preset* is disabled with the reason "You have 50 presets. Delete one to
  save another."
- **Batch** shows *Your presets* as checkboxes too; each gives a file named "{project} - {preset
  name}.{ext}", made safe for Windows by `safeFileName` (Bangla names stay Bangla).
- A user preset keeps every export setting and the *Also save* choices, never the subtitle languages
  (those belong to one project, as today).

### 2.3 Also save: sound stems and timelines

`ExportBundleOptions.tsx` (*Also save*: Chapter list · Thumbnail · Description) gains two chips at the
end:

| Chip | Title (exact) |
|---|---|
| Sound stems (WAV) | One 32-bit float WAV file per sound, to mix in other software: voice, system sound, music and effects |
| Timeline | A timeline for DaVinci Resolve, Premiere Pro or Final Cut Pro, with chapter markers |

When *Sound stems* is on, a hint lists exactly what will be written, from the project: "Saves {list}
(32-bit float WAV, about {size} each)." with `{list}` such as "Voice, System sound and Music"
(`fmt.list`, English "A, B and C" as today's `listPhrase`) and `{size}` for this video's length.
Stems without sound are not written. Without separate microphone and system files: "Saves Recording
and Music (…)". With *Even out loudness* on (`AudioPanel.tsx:141`), a second line: "The stems are not
evened out like the video's sound, so their level can differ a little." (§7.4)

When *Timeline* is on, two rows follow:

- **Open in** (toggle chips, at least one on; remembered with the other *Also save* choices; the
  first time, DaVinci Resolve):

  | Chip | Title (exact) |
  |---|---|
  | DaVinci Resolve | Writes an FCPXML file. In Resolve: File › Import › Timeline… |
  | Premiere Pro | Writes a Premiere XML file. In Premiere: File › Import… |
  | Final Cut Pro | Writes an FCPXML file for a Mac. Made on Windows: keep the files together and, on the Mac, use File › Relink Files… |
  | Other editor (EDL) | A CMX 3600 EDL with the finished video, for editors that read EDL |

  Resolve and Final Cut Pro share one `.fcpxml` file.
- **Uses** (radio):
  - *This export* (default), hint "The finished video and its sound, with chapter markers. Looks the
    same in every editor."
  - *The original recordings*, hint "Your cuts, speed changes and pauses over the original screen,
    camera and sound. Zooms, cursor effects, the background, captions, texts and the camera layout
    are not carried, and the camera is on track 2, turned off. The recordings are copied next to the
    timeline." With Premiere Pro chosen, one more line: "Speed changes may change the pitch in
    Premiere Pro." (§8.4)

Blocked states, with the reason shown as text under the chip, as the other chips do
(`ExportBundleOptions.tsx:56`):

| Chip | Case | Reason (exact) |
|---|---|---|
| Sound stems, Timeline | GIF | GIFs are saved alone |
| Sound stems, Timeline | batch mode | Stems and timelines work with One file |
| Sound stems, Timeline | one file per chapter | Stems and timelines are saved with one file |
| Sound stems | a silent project | This video has no sound |
| Timeline | M4A or WAV | Timelines need a video |
| Final Cut Pro | WebM, or AV1 in MP4 (export mode) | Final Cut Pro cannot open {codec} files. Choose H.264 or HEVC. |
| Other editor (EDL) | *The original recordings* | An EDL can hold the finished video only. Choose This export. |

Sound stems are offered with every format except GIF, M4A and WAV included. A pair of editor and
codec not yet checked on a real installation (§0 decision 14: Premiere Pro or Resolve with WebM, AV1
or Lossless; Final Cut Pro with CineForm or Lossless) is not blocked; the chip shows a line "Not
checked yet with {editor}: it may not open {codec} files.". Each check turns its line into nothing or
into a block (`EDITOR_OPENS`, §8.5).

Files written next to the video, for "Demo.mp4":

```
Demo.mp4
Demo - Voice.wav            Demo - System sound.wav     Demo - Music.wav     Demo - Effects.wav
Demo.fcpxml                 (DaVinci Resolve, Final Cut Pro)
Demo.xml                    (Premiere Pro)
Demo.edl                    (Other editor)
Demo - Resolve markers.edl  (DaVinci Resolve, when the video has chapters)
Demo media\                 (only with "The original recordings")
  Screen.mp4  Camera.mp4  Voice.wav  System sound.wav  Music.wav  Effects.wav
```

In the media folder, `Music.wav` and `Effects.wav` are written only when stems are off; with stems on
the timeline uses the stems next to the video. Existing files are never replaced: the dialog's chosen
path is new, and every other file gets " (2)" the way `export:batchPath` does.

### 2.4 Exporting and the done view

- The running view (`RunningView`) adds one step after the video when stems are on: "Writing sound
  stems…", and one for timelines: "Writing the timeline…" (and "Copying the recordings…" for the
  recordings mode). The progress bar covers the video; the extra steps show an indeterminate bar.
- The done view lists every file saved, as today's bundle list does, with **Show in folder**. Each
  timeline file carries one line that says how to open it (exact):

  | File | Line |
  |---|---|
  | `Demo.fcpxml`, for Resolve | In DaVinci Resolve: File › Import › Timeline… |
  | `Demo.fcpxml`, for Final Cut Pro | In Final Cut Pro: File › Import › XML…, then File › Relink Files… for the media |
  | `Demo.xml` | In Premiere Pro: File › Import… |
  | `Demo.edl` | In your editor: import the EDL and link it to Demo.mp4 |
  | `Demo - Resolve markers.edl` | In DaVinci Resolve: right-click the timeline in the Media Pool, then Timelines › Import › Timeline Markers from EDL… |

- A failed stem or timeline step does not undo the video: the done view shows the video as saved and
  a line "The sound stems could not be saved: {reason}".

### 2.5 Settings › Language

The section exists only when `shipped.json` lists a language other than English (always in
development and review builds), so an English install sees no change until a language ships. Then
**Language** is the first section of the Settings dialog (`SettingsSection` gains `'language'`):

- In a non-English UI the section heading and the select's label carry the English word too: "ভাষা ·
  Language", "Flown-এর ভাষা · Language of Flown", so someone who switched by mistake finds the way
  back.
- **Language of Flown** (a `select`, accessible name "Language of Flown"):
  - "Follow Windows ({name})": `{name}` is the language Windows would give (English when Windows'
    first language is not shipped);
  - "English";
  - each shipped language by its own name, then its English name in the English UI: "বাংলা
    (Bangla)", "Español (Spanish)", "हिन्दी (Hindi)". In the Bangla UI: "বাংলা", "English
    (ইংরেজি)". A language shown as a preview (§0 decision 11) reads "বাংলা (প্রিভিউ) · Bangla
    (preview)" in every UI language.
- **Digits** (shown for Bangla and Hindi): two radio buttons, each showing its digits. In the English
  UI "বাংলা ০১২৩" and "Western 0123"; in the Bangla UI "বাংলা ০১২৩" and "ইংরেজি 0123"; for Hindi
  "देवनागरी ०१२३" and "Western 0123" ("अंग्रेज़ी 0123" in the Hindi UI).
- After a change, a notice (`role="status"`): "Flown switches to {name} when it restarts." with
  **Restart now**. Restart now asks main to relaunch (§9.4). Main refuses while anything would be
  lost: whatever `busyReason()` (`src/main/updates/updatesIpc.ts:30`) names (a recording,
  processing, an export, captions, sound analysis, an import, Clean voice, a copy, a share) and a
  running download (a speech model, caption fonts, music, a local AI model). The notice then adds the
  reason, e.g. "Finish or stop the export first.", and Restart now stays and checks again when
  pressed. From the editor, the project is saved as quitting saves it, and it opens again after the
  restart.
- Under the controls (exact, in each language): "Text that is not translated yet stays in English.
  This setting does not change your recordings, captions or exported files." While the language is a
  preview: "The recording controls are not translated yet." With Bangla chosen: "To hear Flown in
  Bangla, use a screen reader with a Bangla voice, such as NVDA." (§14.3)
- The command palette has **Language…** (keywords: language, ভাষা, Bangla, বাংলা, English, Español,
  हिन्दी), which opens this section; it exists only when the section does.

### 2.6 What changes when Flown is in Bangla

- Every message of the app's own UI, including screen-reader names, tooltips, notices, dialogs,
  confirmation questions (with buttons named after the action, "মুছুন" and "বাতিল", §9.6),
  notifications, the taskbar buttons' tooltips and the file dialogs' titles and filter names.
- Counts, sizes, durations, dates and the timecode in Bangla digits (or Western, by choice), with
  Bangla grouping (১২,৩৪,৫৬৭) and dates with full month names ("৭ নভেম্বর ২০২৬"). Technical lines
  (the size line, resolutions, frame rates, codec hints) keep Latin digits as whole lines.
- Number fields accept Bangla and Western digits (§11.1).
- The UI font for Bangla letters is Noto Sans Bengali; Latin words keep Segoe UI. The type scale is
  one step larger (11.5, 12, 13, 14 and 16 px) and lines are taller (1.4 and 1.6, §12).
- `<html lang="bn">`.
- Not changed: keycaps (Ctrl, Shift, Esc, ←), codec and file names, 1080p, 16:9, the user's project
  names and captions, exported files (§0 decision 10), the recording bar and Home's recording panels
  while the language is a preview (§0 decision 11), the timeline's direction, and the drawn frames,
  which are byte for byte those of the English UI (§9.7).

### 2.7 The offer on Home

Home shows a notice once, at the top of its content, when all of these hold: the language setting is
absent; the offer was not answered before; and a shipped language L other than English is either in
Windows' preferred languages (`app.getPreferredSystemLanguages()`) or known offline: a speech model
made for L is installed (`src/main/speech/models.ts`), or a project with captions or a transcript in
L was opened (`UiPrefs.seen`, written once by the editor). Most Bangladeshi PCs run English Windows
and type Bangla through Avro or Bijoy, which add no Windows language, so the second signal reaches
the people the first misses. Nothing is sent anywhere to decide it.

> Flown is available in Bangla. — Flown এখন বাংলায় পাওয়া যায়।  **[বাংলা ব্যবহার করুন · Use Bangla]** **[এখন না · Not now]**

- *Use Bangla* saves the setting and relaunches when nothing is busy. While Home records or processes
  (`recordingBusy`, `Home.tsx:717`) or main is busy, it saves the setting and says instead (exact):
  "Flown opens in Bangla the next time it starts. — পরের বার চালু হলে Flown বাংলায় খুলবে।"
- *Not now* records the answer (`UiPrefs.offered`) and the notice never returns; Settings › Language
  and the palette's *Language…* stay the way back.
- The notice is a `role="region"` with the accessible name "Language"; its Bangla parts are in
  `<span lang="bn">`.

### 2.8 Keyboard and screen readers

- Every new control is a native button, radio, checkbox, select or text field with a visible label;
  the Codec, Background and Frame rate chips are `Choice` groups as today (arrow keys move, Space and
  Enter pick).
- *Save as preset* is its own button after the Settings header, never a button inside a button.
- Disabled chips explain why in visible text under the row, as `ExportBundleOptions` does, because a
  disabled button's tooltip is not announced.
- The preset card menu opens with Enter, Space or Shift+F10; Escape closes it and returns focus.
- The progress steps of §2.4 are announced through the existing `aria-live` status of the running view.
- The Language section's restart notice and its busy reason are announced (`role="status"`).
- In a translated UI every accessible name is translated; keycaps and `aria-keyshortcuts` values stay
  as they are (§14).

---

## 3. Decisions

### 3.1 How this design was chosen

Three research passes measured the shipped `ffmpeg.exe` under wine (every encoder, pixel format and
option used here, plus test encodes and a speed and size benchmark on synthetic 1080p60 screen
content), Electron 44.9.3's WebCodecs (codec support, alpha, speed) and Intl (ICU 78.2, CLDR 48:
numbers, dates, durations, plurals for bn, hi, es, ar and he), five i18n libraries (built and
measured with esbuild), the app's text (a TypeScript-AST inventory of every candidate string), and
the interchange formats (sample files validated against Apple's DTD and parsed with OpenTimelineIO).
Where a measurement was impossible here (GPU encoders, Windows-only behaviour, other editors'
imports), the design says so and §0 decision 14 lists it.

### 3.2 Decision table

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| 1 | Where codecs are picked | A Codec row under Format; each format keeps its old codec as default; two destinations for editing and overlays | New format chips per codec ("MP4 HEVC", "MOV CineForm"): eight more chips and stored `format` values older Flown cannot read |
| 2 | HEVC source | Hardware only (§0 decision 1); the chip shows only where an encoder exists | x265: a patent licence per copy and litigation risk; a disabled chip with a standing reason on every PC without an encoder |
| 3 | AV1 without a GPU | libaom "good", `-cpu-used 6`, with a time estimate | libaom realtime (measured no smaller than x264, so pointless); WebCodecs software AV1 (libaom realtime inside Chromium, same problem; kept as a test override only); SVT-AV1 (not in this build) |
| 4 | Editing format | CineForm (no pool, alpha, native in Premiere and Resolve), behind `CODEC_POLICY.cineform` | ProRes by default (§0 decision 2); DNxHR (patents unchecked, no alpha) |
| 5 | Transparent formats | WebM/VP9 for the web; MOV with CineForm or Lossless (QuickTime Animation) for editors | WebCodecs alpha (Chromium refuses `alpha: 'keep'` for VP8, VP9 and AV1: "Alpha encoding is not currently supported"); HEVC with alpha (this x265 takes no `yuva` input); PNG in MOV (slow for editors to play) |
| 6 | Alpha readback | `VideoFrame` copies as for opaque frames, unpremultiplied in the renderer with `getImageData`'s rounding, sent as straight BGRA; P2 measures `getImageData` too and keeps it only if it is not slower | `getImageData` on every frame by default (Chromium can move a canvas read back that often to software rendering, and then the whole compositor slows); premultiplied frames and ffmpeg's `unpremultiply` (two conventions) |
| 7 | Transparency and cut styles | Crossfade, dip and slide kept: A\* composed on a transparent scratch target; a dip fades to transparent | Hard cuts (the export would show cuts the preview never shows) |
| 8 | 4:5 | An export shape (ExportOptions, batch, a destination), with the app safe zones off | A project shape: an older Flown opening such a project computes `RATIOS['4:5']` as `undefined` and draws NaN (`layout.ts:48-53`); Reels' safe zones on a feed post (no app buttons cover it) |
| 9 | Frame rates | 24, 25, 30, 60, 120, whole numbers only | 23.976 and 29.97: IVF needs an integer rate (`codec.ts:148`), audio frames would not be whole samples, and editors confuse them with 24 and 30 |
| 10 | Saved presets | `editor-prefs.json` key `exportPresets`, sanitised in main; files written by main only | localStorage (not readable by main, so no file import and export through one reader); the renderer writing file text |
| 11 | Stems | 32-bit float WAV, one fixed gain, each stem with the mix's own channel step, one ffmpeg run writing every stem | 24-bit with a measuring pass to avoid clipping (two runs); `loudnorm` per stem (does not add up); a "Mix" stem (a second mix beside the video's own sound confuses; the WAV format is the mix) |
| 12 | Timeline formats | Chosen by editor ("Open in"): FCPXML 1.10 for Resolve and Final Cut, xmeml 4 for Premiere, CMX 3600 EDL for others, a marker EDL for Resolve; written directly | Chosen by file format (people know their editor, not its formats); OpenTimelineIO's writers (measured: FCPXML 1.8 without speed or markers; the CMX writer puts the clip name in the reel field); OTIO files (Premiere's support is recent; Resolve reads FCPXML anyway) |
| 13 | Timeline media | Two modes: the export (default), or the recordings; EDL with the export only | Recordings only (most of Flown's look is lost); export only (no re-editing); EDL over the recordings (a 60 fps source's timecode in a 25 fps EDL rounds to 40 ms) |
| 14 | i18n runtime | `intl-messageformat` 12.1.4 behind a 150-line `t()` shared by main and renderer | react-intl (14.9 KB, React-only); i18next with ICU (30.5 KB, own syntax by default); Lingui (a Babel or SWC plugin inside electron-vite); Fluent (a syntax translators and AI services know less; its React binding was last released in August 2023) |
| 15 | Message syntax | ICU MessageFormat 1 | MessageFormat 2 (stable in CLDR 47 but shipped by no runtime; `Intl.MessageFormat` is a stage 1 proposal) |
| 16 | Keys | Semantic keys per namespace (`export.codec.hevc.title`) | English text as key (breaks when English copy is edited) |
| 17 | Numbers inside messages | Formatted in code by `fmt`, passed as strings; a plural selects on `count` and shows `{n}`; `#` is never used | `{n, number}` and `#` in messages (ICU groups them, so English would show "1,234 files" where today shows "1234 files") |
| 18 | Changing language | Applies at restart, refused while work would be lost; the editor's project reopens | Live switch (every component and shared helper would need to re-render on a context; strings computed outside React would go stale); relaunching at once (quitting stops and deletes a running export, `exportIpc.ts:333-340`) |
| 19 | Chromium locale packs | Stay out (`electronLanguages: ['en-US']`) | Adding them: Chromium's default locale would follow Windows and today's eight locale-less `toLocale*()` calls would print Bangla digits in the English UI on a Bangla Windows (measured) |
| 20 | Language detection | `app.getPreferredSystemLanguages()`, plus offline signs of use (a Bangla speech model, Bangla captions) | `app.getLocale()` (always `en-US` with one pack, measured); Windows' list alone (most Bangla users run English Windows) |
| 21 | Bangla UI font | Noto Sans Bengali (bundled, tabular digits 0.59 em), also in the mono stack for timecodes | Hind Siliguri (proportional digits 0.49–0.69 em: timecodes would jitter); Nirmala UI alone (three weights; the UI's 74 uses of weight 600 would be synthesised) |
| 22 | Who checks for missing keys | A TypeScript-AST scanner in vitest and predist | ESLint plugins (the repository has no ESLint) |
| 23 | Where translations are reviewed | Files in git, a UTF-8 sheet with a byte-order mark that Excel opens correctly, a review pack of screenshots with keys, and an in-app key overlay for developers | A hosted translation service (a server and accounts; optional later: Weblate reads the same JSON); plain CSV (Excel on Windows reads it as ANSI and saves `?` for Bangla) |
| 24 | What reaches users | Only strings approved by two listed people, built into the shipped catalogue by a script | Shipping drafts marked "machine" (Mozilla's pre-translation trial approved 65.1% of strings unchanged: a third would be wrong) |
| 25 | Camera in a recordings-mode timeline | Track 2, turned off | A picture-in-picture transform at Flown's camera position: Flown's camera moves with layouts, the director and follow framing, so one transform is wrong for most videos |
| 26 | Transparency from MP4 | No Background row on MP4; the *Transparent overlay* destination | Two disabled chips and a standing sentence on every MP4 export; a standing hint under Format; switching the format on a click |
| 27 | Digits in the Bangla UI | Per message: technical lines Latin as a whole (`digits: 'latn'`) | Per token (one line showing "1080×1350 · 30 fps · ২:১৪") |
| 28 | Number fields in a translated UI | Text fields with `inputmode="decimal"`, showing `fmt` digits and reading both scripts; English keeps `type="number"` | `type="number"` everywhere (Chromium formats it with the app's en-US locale and rejects ২৫ typed through Avro or Bijoy) |
| 29 | Bangla and Hindi plurals | `other` only | Every CLDR category (`one` is `i = 0 or n = 1` for bn and hi, so a "একটি ফাইল" branch would also show for 0) |
| 30 | Confirmation questions | `askConfirm`: `window.confirm` in English exactly as today, Flown's own dialog with translated action buttons elsewhere | `window.confirm` everywhere (Chromium labels its buttons OK and Cancel in English, and "OK" answers a delete question badly) |
| 31 | Messages added while features are built | The contracts write them, one namespace per feature part | Each part appends to shared namespaces (every pair of parts would conflict on the same JSON files) |
| 32 | Drawn frames and the UI language | Every canvas pinned to `lang="en"` in a translated UI (one hook) | Canvases inheriting `<html lang="bn">` (caption text could fall back to other fonts or shape differently) |
| 33 | `ffmpeg.exe` | Today's pinned gyan.dev binary in this wave; a CI build from a public script next (§0 decision 3) | A new binary inside this wave (new release checks while the formats are built on it) |

---

## 4. Data model and migration

### 4.1 `src/shared/types.ts` (additive)

```ts
/** mp4, mov, webm, gif, m4a as before; wav: the soundtrack uncompressed (audio only, wave 12). */
export type ExportFormat = 'mp4' | 'gif' | 'webm' | 'mov' | 'm4a' | 'wav'

/** The video codec of an export (output-and-languages §5.2). */
export type ExportCodec = 'h264' | 'hevc' | 'av1' | 'vp9' | 'cineform' | 'animation' | 'prores-422' | 'prores-4444'

/** Whole-number export frame rates (no 23.976 or 29.97: §3.2 row 9). */
export type ExportFps = 24 | 25 | 30 | 60 | 120

/** 'auto' and the four project shapes, plus '4:5', which only exports use (§4.6). */
export type AspectRatio = 'auto' | '16:9' | '9:16' | '1:1' | '4:3' | '4:5'

export interface ExportSettings {
  format: ExportFormat
  resolution: 720 | 1080 | 1440 | 2160
  fps: ExportFps                 // was 30 | 60
  quality: 'high' | 'medium' | 'small'
  encoder: 'auto' | 'software'
  preset?: string
  targetSizeMB?: number
  subtitleStreams?: true
  /** The codec when it is not the format's default (DEFAULT_CODEC); absent: H.264 for MP4 and MOV, VP9 for WebM, as before. */
  codec?: ExportCodec
  /** A see-through background (§6); absent: drawn, as before. */
  alpha?: 'background' | 'overlays'
  /** Id of the user preset these settings came from ('user:' + 12 hex), while they still match it. */
  userPreset?: string
}
```

- `ASPECT_RATIOS` (`src/shared/editor/styleDefaults.ts:58`, the Style panel's list and the style
  sanitiser) **does not change**: 4:5 can never become a project's shape.
- `RATIOS` (`src/shared/engine/layout.ts:15`) gains `'4:5': 4 / 5`, so `outputSize` gives 720×900,
  1080×1350, 1440×1800 and 2160×2700. All are under `MAX_EXPORT_SIDE` 4096 (`exportPlan.ts:20`), and
  `isTall` (`reframeData.ts:57`, `h ≥ 1.25 w`) counts each as tall, as `tallAs` already expects.
  `exportProject` turns the app safe zones off in a 4:5 copy (§5.8).
- `CropAspect` (`src/shared/editor/cropEdit.ts:14`) does not change.

### 4.2 `src/shared/api/export.ts` (additive)

```ts
export type HevcEncoder = 'hevc_nvenc' | 'hevc_qsv' | 'hevc_amf' | 'hevc_mf' | 'libx265'
export type Av1Encoder = 'av1_nvenc' | 'av1_qsv' | 'av1_amf' | 'libaom-av1'
export type IntermediateEncoder = 'cfhd' | 'qtrle' | 'prores_ks'
export type FfmpegVideoEncoder = H264Encoder | 'libvpx-vp9' | HevcEncoder | Av1Encoder | IntermediateEncoder

export type VideoInput =
  | { kind: 'raw'; encoder: FfmpegVideoEncoder; pixelFormat: RawPixelFormat }
  | { kind: 'h264'; color: ColorTags }
  | { kind: 'vp9'; color: ColorTags }
  /** An HEVC Annex B stream from WebCodecs (hardware only); ffmpeg only muxes it. */
  | { kind: 'hevc'; color: ColorTags }
  /** An AV1 stream from WebCodecs, framed as IVF with fourcc 'AV01'; ffmpeg only muxes it. */
  | { kind: 'av1'; color: ColorTags }
  | { kind: 'none' }

/** The sounds a stem export writes, each only when it has sound (§7). */
export type SoundStem = 'voice' | 'system' | 'recording' | 'music' | 'effects'

export interface StemJob {
  /** In this order; 'recording' only when the project has no separate microphone and system files. */
  stems: SoundStem[]
  /** One gain (dB, −30..30) for the recording's stems instead of loudnorm; absent: not normalised. */
  gainDb?: number
  /** The separate files' gains as the project sets them (absent: 1), used even where the video mixed screen.mp4's track. */
  gains?: Partial<Record<StemKind, number>>
}

export interface ExportJob {
  // … every field as before …
  /** The codec when it is not the format's default; absent: as before. Main checks it against `video`. */
  codec?: ExportCodec
  /** Frames carry straight alpha (raw 'rgba' or 'bgra' only), for an alpha codec. */
  alpha?: true
  /** Also write WAV stems next to the output (§7). */
  stems?: StemJob
}

/** Why an export failed, for the renderer's choice of falling back to the next encoder (§9.6). */
export type ExportErrorCode = 'disk-full' | 'permission' | 'in-use' | 'read-only' | 'missing-input' | 'unreadable'
  | 'not-chosen' | 'invalid-job' | 'no-sound' | 'cancelled' | 'encoder' | 'unknown'

export type TimelineKind = 'fcpxml' | 'xmeml' | 'edl'
/** The editors a timeline is written for (§2.3); 'resolve' and 'finalcut' share the .fcpxml. */
export type TimelineEditor = 'resolve' | 'premiere' | 'finalcut' | 'edl'

export interface TimelineRequest {
  projectId: string
  /** The finished export (an approved path of this session). */
  videoPath: string
  editors: TimelineEditor[]
  media: 'export' | 'recordings'
  /** §8.2, built in the renderer from the project; checked by main before anything is written (§18.3). */
  plan: TimelinePlan
  /** Stem files written with the export (main checks each is next to `videoPath`). */
  stems: { stem: SoundStem; path: string }[]
}

export interface TimelineResult {
  /** Every file or folder written, with what it is for, so the done view can say how to open it. */
  files: { path: string; for: TimelineEditor | 'resolve-markers' | 'media' }[]
  /** A step that failed after the video was saved, in the UI language. */
  problem?: string
}

export interface PresetFileRead {
  presets: UserExportPreset[]
  /** Presets left out over the limit of 50. */
  skipped: number
  /** Presets whose codec Flown does not make, and the codec they export with instead (§4.3 rule 2). */
  changed: { from: ExportCodec; to: ExportCodec; count: number }[]
}

export interface ExportApi {
  // … every call as before …
  /** Working GPU encoders for a codec, best first (cached per session; §5.9). */
  probeCodec(codec: 'hevc' | 'av1'): Promise<FfmpegVideoEncoder[]>
  /** The code of the last export:start or export:finish failure (§9.6). */
  exportErrorCode(): Promise<ExportErrorCode | null>
  writeTimeline(request: TimelineRequest): Promise<TimelineResult>
  /** Save dialog for `{defaultName}.flownpreset`; main writes the presets itself (§18.2). Resolves with the path, or null. */
  savePresetFile(defaultName: string, presets: UserExportPreset[]): Promise<string | null>
  /** Open dialog for .flownpreset; main reads at most 64 KB. Null when cancelled. */
  openPresetFile(): Promise<PresetFileRead | { refused: 'too-large' | 'unreadable' } | null>
}
```

`ExportCapabilities` keeps `hardwareEncoders` (H.264) unchanged; the other codecs are probed on demand.

### 4.3 Export settings in renderer storage (unchanged keys)

The dialog keeps its five localStorage keys (`ExportDialog.tsx:78-82`). What they hold:

| Key | Today | New, optional |
|---|---|---|
| `export-settings` | `ExportOptions` | `codec`, `alpha`, `userPreset`; `fps` 24, 25, 120; `aspect` '4:5'; `format` 'wav' |
| `export-batch` | `{ presets: string[]; aspects: AspectRatio[] }` | `userPresets?: string[]` (absent when empty); `aspects` may hold '4:5' |
| `export-bundle` | `BundleOptions` without `languages` | `stems?: true`, `timelines?: TimelineEditor[]`, `timelineMedia?: 'recordings'` |
| `export-mode`, `export-settings-open` | as today | none |

`normalizeOptions` (`exportPresets.ts:99-113`) is rewritten in the contracts step (§21.0) with these
rules, so stored values without new fields are read **and written back byte for byte** (test 2):

1. The five old keys are read exactly as today, in the same order; `fps` accepts
   `[24, 25, 30, 60, 120]`; `format` accepts `'wav'`; `aspect` accepts `'4:5'`.
2. `codec` is kept only when it is in `FORMAT_CODECS[format]` and not the format's default (so
   picking H.264 again stores nothing). A codec `CODEC_POLICY` forbids becomes its nearest allowed
   codec (`nearestCodec`: ProRes 422 and ProRes 4444 → CineForm → Lossless → the default), keeping
   `alpha` when the new codec carries it; the preset readers report each change (§4.5). Any other
   value is deleted.
3. `alpha` is kept only when `canAlpha(format, codec)`; otherwise deleted.
4. `userPreset` is kept when it matches `/^user:[0-9a-f]{12}$/`; whether that preset still exists is
   the dialog's question: it drops an id whose preset is gone, as `tweakOptions` drops a stale
   `preset`.
5. New keys are written after the old ones, so an old object's key order never changes, and
   `tweakOptions` deletes `undefined` as today.

Whether this PC can make a stored codec (HEVC) is never the reader's question: the dialog answers it
after the probe (§2.1), so the same stored value behaves the same on every PC that can make it.

`matchesPreset` (`exportPresets.ts:68`) also compares `codec` and `alpha` with the preset's, absent
equal to absent, so every built-in preset of today matches exactly as before and picking HEVC or a
transparent background makes the settings "Custom". `matchesUserPreset(o, preset, usable)` compares
with a user preset, taking the codec this PC would use (§2.2).

`normalizeBundle` (`exportBundle.ts:38`) keeps the six boolean keys exactly as today. **The new
fields are not added to `NO_BUNDLE`**: they are read only when present and valid, so an old object
gains no `"stems": false`.

An older Flown reading settings written by this one drops what it does not know: `normalizeOptions`
copies only known keys, `pick` turns 24 fps into 60 and `wav` into `mp4`, and `normalizeBundle` reads
only its six booleans.

### 4.4 Preferences (`userData/editor-prefs.json`)

`PrefKey` (`src/shared/api/prefs.ts:6`, with wave 11's five keys) gains two. Each has a sanitiser in
`src/main/prefsIpc.ts` that turns anything malformed into "absent":

| Key | Value | Absent |
|---|---|---|
| `exportPresets` | `UserPresetStore = { version: 1; presets: UserExportPreset[] }`, at most 50 (§4.5) | No user presets |
| `ui` | `UiPrefs = { language?: 'system' \| UiLanguage; digits?: 'native' \| 'western'; offered?: UiLanguage[]; seen?: UiLanguage[] }` | English, the locale's own digits, nothing offered or seen yet |

```ts
export interface UserExportPreset {
  id: string                 // 'user:' + 12 lower-case hex; never a built-in id (they have no colon)
  name: string               // 1..60 graphemes, NFC, trimmed; no Cc, bidi-control or private-use characters (ZWJ and ZWNJ kept)
  options: ExportOptions     // through normalizeOptions, without `preset` and `userPreset`
  bundle?: Omit<BundleOptions, 'languages'>   // through normalizeBundle
  saved: number              // ms since 1970
}
```

`prefsIpc.ts` keeps every unknown key of the file as it is (`load()` holds the whole object and
`prefs:set` spreads it), so an older Flown keeps the new keys untouched. Main reads `ui`
synchronously at start (`readPrefSync`, §9.4) and writes it only through `writePrefSync(key, value)`,
which the contracts add to `prefsIpc.ts` on the same cache that `prefs:set` uses
(`prefsIpc.ts:25-54`). A write from main and a later `prefs:set` from the renderer therefore never
put back a stale `ui`.

### 4.5 The preset file (`.flownpreset`)

UTF-8 JSON, at most 64 KB:

```json
{ "flown": "export-presets", "version": 1,
  "presets": [ { "name": "Client review", "options": { "format": "mov", "resolution": 1080, "fps": 30,
    "quality": "high", "encoder": "auto", "codec": "cineform" }, "bundle": { "stems": true } } ] }
```

- Written by main only: `savePresetFile(defaultName, presets)` serialises with
  `presetFileText(presets)` (ids and `saved` left out; they are made again on import), reads the text
  back through `readPresetFile`, refuses anything over 64 KB, and always ends the name in
  `.flownpreset` (§18.2). The renderer never hands main file text.
- Read in main only, by `readPresetFile(text)` (§18.2): the `flown` and `version` fields must match;
  at most 50 presets; each name cleaned by `cleanPresetName`; options through `normalizeOptions`,
  whose codec changes are counted in `changed`; `bundle` through `normalizeBundle` without
  `languages`; every other field dropped. Nothing in a preset is a path, a URL or code.

### 4.6 Projects: nothing new

No project field is added, read or migrated in this wave:

- 4:5 lives in `ExportOptions.aspect` and `exportProject` (`exportPlan.ts:48`) applies it to the copy
  of the project an export draws, as it applies 9:16 today. That copy is never saved.
- Transparency, codecs, frame rates, stems and timelines are export settings.
- `migrateProject` gains one guard that changes nothing for any project written so far: a
  `style.aspectRatio` outside `ASPECT_RATIOS` reads as `'auto'`, so a hand-edited or future project with
  '4:5' never reaches `RATIOS` with a value it lacks. Every project of today has a value in the list
  (test 1 runs the fixtures of the earlier guards through it, byte for byte).

### 4.7 Version records

`versions.ts` keeps projects only; export settings and presets are not part of a version. Nothing
changes there.

---

## 5. Export formats

### 5.1 What the shipped `ffmpeg.exe` holds, and the licence and patent position of each encoder

Measured by running the shipped binary (`node_modules/ffmpeg-static/ffmpeg.exe`, "6.1.1-
essentials_build-www.gyan.dev", FFmpeg commit `e38092ef93`) under wine: `-encoders` (117 video and 88
audio encoders) and `-h encoder=…` for each one used here, and a test encode for every software
encoder used (all exit 0). The GPU encoders exist in the binary; whether they run depends on the PC
(§5.9).

Its build notes (`ffmpeg.exe.README`, installed next to the binary) list every external library:
avisynth (AviSynthPlus v3.7.3-38), bzlib, gmp, gnutls, iconv, libaom (v3.8.0-180-g0eeb62d344), libass,
libfontconfig, libfreetype, libfribidi, libgme, libgsm, libharfbuzz, libmp3lame (3.100),
libopencore_amrnb and libopencore_amrwb (0.1.6), libopenjpeg, libopenmpt, libopus (v1.4-9-gc8549975),
librubberband, libspeex, libsrt, libssh, libtheora, libvidstab, libvmaf, libvo_amrwbenc (0.1.3),
libvorbis, libvpx (v1.13.1-601-g655da33b8), libwebp, libx264 (v0.164.3172), libx265
(3.5-153-gce8642f22), libxml2, libxvid (1.3.7), libzimg, libzmq, lzma, mediafoundation, sdl2 and zlib;
for hardware: amf (1.4.32), cuda, cuda_llvm, cuvid, d3d11va, dxva2, ffnvcodec, libmfx, libvpl, nvdec
and nvenc.

| Codec | Encoders in the binary | Used by Flown | Licence of the code | Patents and the owner's position |
|---|---|---|---|---|
| H.264 | libx264, h264_nvenc, h264_qsv, h264_amf, h264_mf | as today | x264 GPLv2+ (in a GPLv3 binary run as a separate program) | Via LA's AVC/H.264 pool: shipped today, unchanged |
| HEVC | **libx265** (3.5-153-gce8642f22, 8/10/12-bit, no alpha), hevc_nvenc, hevc_qsv, hevc_amf, hevc_mf; FFmpeg's HEVC decoder | the four hardware encoders and WebCodecs HEVC; libx265 never (§0 decision 1) | x265 GPLv2+ (commercial licence from MulticoreWare) | Royalties attach to each distributed copy that contains an HEVC encoder or decoder. **HEVC Advance** (Program Overview, July 2026; rates from 1 July 2026): "All HEVC Software" $1.00 Region 1 / $0.50 Region 2 with the logo discount, $1.111 / $0.555 without it, $1.333 / $0.667 at standard rates; a $25,000 annual enterprise credit, whose footnote excludes "certain types of HEVC Software". **VCL Advance** (the former Via LA HEVC/VVC pool, owned by Access Advance since 15 December 2025, a separate licence): units 1–100,000 a year free for one entity of a group, then $0.30 Region 1 / $0.20 Region 2; whether it covers software is to be confirmed with its administrator. **Independent holders** (Nokia, InterDigital, Ericsson) license on their own and sue PC makers; Dell and HP have turned hardware HEVC off on some PCs. Bangladesh and India are Region 2. The shipped binary already contains x265 and the decoder; only §0 decision 1 (c) removes them |
| AV1 | libaom-av1 (no alpha), av1_nvenc, av1_qsv, av1_amf. **Not** in this build: av1_mf, SVT-AV1, rav1e, dav1d | all four | libaom BSD-2 | Royalty-free licence from its developers (AOMedia Patent License 1.0). A pool for devices exists (Sisvel: €0.32 per display device, €0.11 per other device) and publishes no software rate; Sisvel says software may follow |
| VP9 | libvpx-vp9 (yuva420p for alpha), vp9_qsv | libvpx-vp9 as today, plus alpha | libvpx BSD-3 | Royalty-free licence from its developers (Google's WebM grant); a Sisvel VP9 pool for devices exists |
| CineForm | cfhd (yuv422p10le, gbrp12le, gbrap12le) | yes, while `CODEC_POLICY.cineform` | part of FFmpeg (LGPL code, GPL as built) | No pool. GoPro holds CineForm-family patents (for example US 9,736,384 and its continuations through US 11,297,337, on compressing single-sensor RAW images; Google Patents lists 9,736,384 as lapsed). The Apache-2.0 patent grant of GoPro's SDK covers GoPro's code, not FFmpeg's independent `cfhd`; the SDK's MIT option carries none. "CineForm" is GoPro's trademark: the chip names it as GoPro's. GoPro's declaration for SMPTE ST 2073 (VC-5) is to be looked up before release (§0 decision 2) |
| QuickTime Animation | qtrle (argb, rgb24) | yes (the *Lossless* chip) | part of FFmpeg | Apple's 1990s run-length format; no known pool |
| ProRes | prores, prores_aw, prores_ks (yuv422p10le, yuv444p10le, yuva444p10le) | prores_ks only with §0 decision 2 (b) | part of FFmpeg | Apple calls FFmpeg's encoders unauthorised; "ProRes" is Apple's trademark. Owner decides |
| DNxHR | dnxhd | no (§0 decision 4) | part of FFmpeg | not checked |
| Lossless intermediates | ffv1, utvideo, png | ffv1 (GIF's intermediate) and png (thumbnails), as today | part of FFmpeg | none known |
| Audio, used | aac, libopus, pcm_f32le, pcm_s16le, libmp3lame | aac and libopus as today; pcm_f32le for stems, the WAV format and the intermediates; pcm_s16le and libmp3lame as today, for speech uploads (`src/main/ai/transcribe.ts:153,163`) | FFmpeg; libopus BSD-3; LAME LGPL | AAC already shipped; MP3's patents ended in 2017; PCM free. Opus: royalty-free licence from its developers (shipped today in WebM). A pool for devices exists (Vectis: Dolby, Fraunhofer, NTT), and in December 2025 Dolby sued Acer, a PC maker, at the Unified Patent Court over an Opus patent; counsel's review for §0 decision 1 covers Opus too |
| **Present, never used** | video: h261, h263, h263p, mpeg1video, mpeg2video, mpeg2_qsv, mpeg4, libxvid, msmpeg4v2, msmpeg4, wmv1, wmv2, dvvideo, libtheora, libvpx (VP8), libwebp, mjpeg and other image encoders; audio: ac3, ac3_fixed, ac3_mf, eac3, dca, truehd, mlp, aptx, aptx_hd, sbc, libopencore_amrnb, libvo_amrwbenc, aac_mf, mp3_mf, mp2, wmav1, wmav2, libgsm, libspeex, libvorbis and others; every decoder | none | various | Some are under patent programmes or may carry remaining patents (AMR, AC-3 and E-AC-3, DTS, TrueHD, aptX, MPEG-4 Part 2, WMV). Flown cannot reach them: every `-c:v` and `-c:a` value comes from fixed tables, and test 81 checks every value the argument builders can emit against `ALLOWED_ENCODERS`. §0 decision 3 (b)'s build leaves the unused patent-relevant libraries out |

Muxers used: mp4, mov, webm, ivf (input), wav with `-rf64 auto` and `-write_bext 1`. Filters used:
`scale` (colour matrices), `format`. Bitstream filters: `hevc_metadata`, `av1_metadata`.

**Installer growth for all of §5–8: 0 bytes.**

### 5.2 Codecs per format

| Format | Codecs (`FORMAT_CODECS`, default first) | Can be transparent | Audio |
|---|---|---|---|
| MP4 | h264, hevc, av1 | no | AAC 192 kb/s (as today) |
| MOV | h264, hevc, cineform, animation, prores-422\*, prores-4444\* | cineform, animation, prores-4444 | AAC for h264 and hevc (as today); PCM 32-bit float, 48 kHz, for the intermediates |
| WebM | vp9, av1 | vp9 | Opus 128 kb/s (as today) |
| GIF | — | — | — |
| M4A | — | — | AAC (as today) |
| WAV | — | — | PCM 32-bit float, 48 kHz |

\* only with `CODEC_POLICY.prores`; `cineform` only with `CODEC_POLICY.cineform` (on). Alpha codecs and
their encoders: VP9 → `libvpx-vp9` (yuva420p), CineForm → `cfhd` (gbrap12le), Animation → `qtrle`
(argb), ProRes 4444 → `prores_ks` (yuva444p10le).

### 5.3 Routes, in the order tried

`exportRoutes` (`exportPlan.ts:133-153`) keeps every route it gives today for the default codecs. For
the others it delegates to `codecRoutes` (`src/shared/render/codecRoutes.ts`):

| Codec | Auto | Software |
|---|---|---|
| HEVC | WebCodecs HEVC on the GPU → `hevc_nvenc` → `hevc_qsv` → `hevc_amf` → `hevc_mf` (each only when probed) | not offered (with §0 decision 1 (b): libx265) |
| AV1 | WebCodecs AV1 on the GPU → `av1_nvenc` → `av1_qsv` → `av1_amf` (only for sizes it does not pad, §5.4) → `libaom-av1` | `libaom-av1` |
| VP9 with alpha | `libvpx-vp9` (raw RGBA) | the same |
| CineForm, Animation, ProRes | the ffmpeg encoder (raw RGB or RGBA) | the same |

The test override `SSW_EXPORT_VIDEO_ENCODER=webcodecs-software` adds WebCodecs' software AV1 first, as
it does for H.264 today, so the WebCodecs path runs under Linux e2e. A failed route falls back to the
next one unless its error code says no encoder can fix it (§9.6).

### 5.4 Encoder arguments per codec and quality

Common to every raw-frame input: `-f rawvideo -pix_fmt {p} -s {w}x{h} -framerate {fps} -i pipe:0`, and
`G = fps × 2` (a keyframe every 2 s, as today). `{p}` is `yuv420p` (converted in the renderer, as
today) for HEVC and AV1, `bgr0` or `rgb0` for opaque intermediates and `bgra` or `rgba` (straight) for
alpha, in the byte order the canvas reads back (`rawReadback`, `codec.ts:12`). Existing H.264 and VP9
argument lists do not change by a byte (test 3).

**HEVC** (MP4, MOV). Filter `[0:v]scale=out_color_matrix=bt601:out_range=tv,format={nv12|yuv420p}[vout]`
(today's `yuvFilter`; nv12 for qsv, amf and mf, yuv420p for nvenc). Starting values, to calibrate on
the reference PC against the bench clip for SSIM-Y ≥ 0.9975 (§0 decision 14):

| Encoder | Studio · Web · Small file | Size target (B bit/s) |
|---|---|---|
| hevc_nvenc | `-c:v hevc_nvenc -preset p5 -tune hq -rc vbr -cq {22\|26\|30} -b:v 0 -spatial-aq 1 -profile:v main -g G` | `-rc vbr -b:v B -maxrate 1.5B -bufsize 2B` instead of `-cq … -b:v 0` |
| hevc_qsv | `-c:v hevc_qsv -preset medium -global_quality {23\|27\|31} -g G` | `-b:v B -maxrate 1.5B -bufsize 2B` |
| hevc_amf | `-c:v hevc_amf -quality balanced -rc cqp -qp_i {20\|24\|28} -qp_p {22\|26\|30} -g G` | `-rc vbr_peak -b:v B -maxrate 1.5B -bufsize 2B` |
| hevc_mf | `-c:v hevc_mf -hw_encoding 1 -b:v {round(0.7 × targetBitrate)} -g G` | `-b:v B -maxrate 1.5B -bufsize 2B` |
| libx265 (decision 1 (b) only) | `-c:v libx265 -preset fast -crf {21\|25\|29} -g G -x265-params log-level=error` | two passes, `-b:v B -pass {1\|2} -passlogfile {log}` (verified in this build) |

Then `-bsf:v hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=6:video_full_range_flag=0`,
`colorTagArgs(EXPORT_COLOR)` and `-tag:v hvc1` (QuickTime and Apple devices need `hvc1`). `hevc_mf`
must carry `-hw_encoding 1` in the probe and in every encode, exactly as `h264_mf` does
(`gpuEncoderOptions`, `hwEncoders.ts:26`): without it ffmpeg can pick a software Media Foundation
encoder (Windows' inbox `Mfh265enc.dll` or the one in HEVC Video Extensions), which is the very encoder
§0 decision 1 keeps out.

WebCodecs HEVC: `VideoEncoderConfig { codec: hevcCodecString(w, h, fps) /* 'hvc1.1.6.L{level×30}.B0' */,
hardwareAcceleration: 'prefer-hardware', hevc: { format: 'annexb' }, latencyMode: 'quality', bitrate,
bitrateMode }` with the H.264 route's bit rates × 0.7. Main muxes it: `-f hevc -r {fps} -i pipe:0 …
-map 0:v:0 -c:v copy -bsf:v hevc_metadata=… -tag:v hvc1`.

HEVC levels (`hevcLevel`, Main tier): the lowest of 3.1, 4, 4.1, 5, 5.1, 5.2, 6, 6.1 whose luma picture
size (983,040 / 2,228,224 / 2,228,224 / 8,912,896 / … / 35,651,584) and luma rate (33,177,600 /
66,846,720 / 133,693,440 / 267,386,880 / 534,773,760 / 1,069,547,520 / 1,069,547,520 / 2,139,095,040)
hold the export: 1080p60 is 4.1, 1080p120 is 5, 2160p60 is 5.1, 2160p120 is 5.2, 2160×2700 at 30 is 5.

**AV1** (MP4, WebM). Filter as HEVC. Then:

| Encoder | Studio · Web · Small file | Size target |
|---|---|---|
| av1_nvenc (RTX 40 and later) | `-c:v av1_nvenc -preset p5 -tune hq -rc vbr -cq {30\|34\|38} -b:v 0 -spatial-aq 1 -g G` (starting values) | `-rc vbr -b:v B -maxrate 1.5B -bufsize 2B` |
| av1_qsv (Arc, Core Ultra and later) | `-c:v av1_qsv -preset medium -global_quality {30\|34\|38} -g G` (starting values) | `-b:v B -maxrate 1.5B -bufsize 2B` |
| av1_amf (RX 7000 and later) | `-c:v av1_amf -quality balanced -rc cqp -qp_i {q} -qp_p {q+8} -g G`, q on its 0–255 scale, set by calibration | `-rc vbr_peak -b:v B -maxrate 1.5B -bufsize 2B` |
| libaom-av1 | `-c:v libaom-av1 -usage good -cpu-used 6 -row-mt 1 -tiles 2x2 -crf {30\|34\|38} -b:v 0 -g G` | two passes, `-b:v B -pass {1\|2} -passlogfile {log}` (verified) |

Then `-bsf:v av1_metadata=color_primaries=1:transfer_characteristics=1:matrix_coefficients=6:color_range=tv`
and `colorTagArgs(EXPORT_COLOR)`. **AMD's encoder in this 6.1 build pads 1920×1080 to 1920×1082**
(ffmpeg trac #10266, fixed in 2024, after 6.1): `av1_amf` is used only when the width is a multiple of
64 and the height a multiple of 16 (1280×720, 2560×1440, 3840×2160), and skipped otherwise.

WebCodecs AV1: `{ codec: av1CodecString(w, h, fps) /* 'av01.0.{level}M.08' */,
hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality', bitrate, bitrateMode }` with bit
rates × 0.55, framed by the existing IVF writer with fourcc `AV01` (`ivfFileHeader` gains a `fourcc`
argument, default `'VP90'`), muxed with `-f ivf -i pipe:0 … -c:v copy -bsf:v av1_metadata=…`. Levels
(`av1Level`, `seq_level_idx`): 4.0 (08) up to 1080p60, 4.1 (09) for 1080p120, 5.0 (12) for 1440p60 and
2160p30, 5.1 (13) for 2160p60, 5.2 (14) for 2160p120.

Measured on the 10 s 1080p60 bench clip, 4 vCPU (`formats/bin/bench.sh`):

| Encode | MB/min | Wall s | SSIM-Y |
|---|---|---|---|
| x264 veryfast crf 18 (today's Studio) | 8.88 | 7.2 | 0.99766 |
| x265 fast crf 22 | 5.77 | 16.9 | 0.99748 |
| libaom good cpu-used 6 crf 32 | 3.82 | 45.2 | 0.99765 |
| libaom realtime cpu-used 8 crf 32 | 6.92 | 11.0 | 0.99565 |
| VP9 realtime crf 27 (today's WebM) | 13.20 | 12.3 | 0.99799 |

So AV1 matches today's H.264 Studio at 43% of the size and about 6 times the time; HEVC (where the GPU
makes it) at about 65%.

**VP9 with alpha** (WebM). Input `bgra` or `rgba`, straight. Filter
`[0:v]scale=out_color_matrix=bt601:out_range=tv,format=yuva420p[vout]`; then today's
`vp9EncoderArgs(job)` unchanged (`-deadline realtime -cpu-used 7 -crf {27|33|39} -b:v 0`, row-mt,
tiles, `-g G`); `colorTagArgs(EXPORT_COLOR)`. libvpx writes `alpha_mode: 1` itself (measured). Size
targets are off for alpha (§5.7). Measured on the alpha clip: 7.4 MB/min at realtime crf 30.

**CineForm** (MOV). Opaque: input `bgr0`/`rgb0`, filter
`scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le`, `-c:v cfhd -quality {film1|high|medium}`,
`-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv`. With alpha: input
`bgra`/`rgba`, filter `format=gbrap12le`, `-c:v cfhd -quality {film1|high|medium}`,
`-color_primaries bt709 -color_trc bt709` (RGB: no matrix tag). Measured: YUV "high" 1,019 MB/min,
RGBA "high" 2,395 MB/min, RGBA "film1" 2,596 MB/min at 1080p60, encoding faster than real time on 4
cores. `cfhd` takes only widths that are a multiple of 16 ("Width must be multiple of 16.", so 1080 wide
fails): `exportSize` rounds a CineForm frame's width up to the next multiple of 16 (9:16, 1:1 and 4:5
at 1080p are 1088 wide; down instead when that would pass `maxWidth`), so the preview, the job and the
timeline plan agree, and the recording is fitted inside as with any size.

**Animation** (MOV). Input `bgra`/`rgba` (alpha) or `bgr0`/`rgb0`; `-pix_fmt argb` or `rgb24`;
`-c:v qtrle`; `-color_primaries bt709 -color_trc bt709`. Lossless (598 of 600 frames bit-exact, the
other two a timestamp artefact of the test master); 812 MB/min on the alpha clip, much more with
motion.

**ProRes** (MOV, only with `CODEC_POLICY.prores`). 422: input `bgr0`/`rgb0`, filter
`scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le`, `-c:v prores_ks -profile:v {3|2|1}`
(HQ, 422, LT). 4444: `format=yuva444p10le` with alpha or `yuv444p10le` without, `-c:v prores_ks
-profile:v 4 -alpha_bits {16|0}`. Tags as CineForm YUV. **Never `-vendor apl0`** (test 23). Apple's
nominal rates at 1080p29.97 are HQ 220 and 4444 330 Mb/s; double at 59.94.

**Containers.** MP4 and MOV with H.264 or HEVC keep `-movflags +faststart+write_colr`. The
intermediates use `-movflags +write_colr` only: `+faststart` rewrites the whole file at the end, which
for a 3 GB file doubles the disk writes for no gain in editing software. WebM as today. Audio for the
intermediates: `-c:a pcm_f32le -ar 48000` (§7.7 says why float; whether each editor reads float PCM
in MOV is a §0 decision 14 check, with `pcm_s24le` as the fallback if one does not).

**WAV format.** The soundtrack graph of today's M4A export, unchanged, encoded as `-c:a pcm_f32le -ar
48000 -rf64 auto -f wav`. Its sound is the video's sound, byte for byte before encoding (test 30).

### 5.5 Colour

- HEVC and AV1 convert and tag exactly as H.264 and VP9 today (`EXPORT_COLOR`: BT.601 matrix, limited
  range, BT.709 primaries and transfer, `exportArgs.ts:20`), so the dialog's preview and the exported
  file show the same colours in Chromium, as today.
- The intermediates use the **BT.709** matrix and tag 1-1-1: editing software assumes BT.709 for HD,
  and FCPXML names "1-1-1 (Rec. 709)" and "6-1-6 (Rec. 601 NTSC)" but not today's 1-1-6. Their pixels
  are the same sRGB bytes; only the matrix of the conversion differs.
- Wave 10's colour grade runs before drawing, so every codec carries the graded picture.

### 5.6 Frame rates (24, 25, 120)

- `ExportSettings.fps` widens; `validateJob` already accepts 1..120 (`exportJob.ts:230`).
- Export frames come from source time with half a frame of slack (`frameIndexAt`,
  `src/shared/render/frameTiming.ts:20`). From a 60 fps screen proxy, 24 fps steps 3, 2, 3, 2 source
  frames and 25 fps steps 2, 3, 2, 2, 3; zoom, cursor and animations are drawn at output time and stay
  smooth, only scrolling content judders a little (the 24 fps chip's title says so). 120 fps shows each
  60 fps source frame twice while zoom and cursor move at 120 Hz.
- Audio frames are whole samples at 48 kHz for every rate (2,000, 1,920, 1,600, 800, 400 samples).
- Motion blur: `EXPORT_BLUR_SAMPLES` stays 10 up to 60 fps; at 120 fps it is 5, the same sub-frames per
  second, so 120 fps costs about twice 60 fps instead of four times. 120 fps never existed, so no old
  export changes.
- Bit rates of rate-driven encoders scale with `rateFps(fps)` = `fps` up to 60, `60 + (fps − 60) / 2`
  above: twice the frames do not need twice the bits. `rateFps(fps) === fps` for every rate of today.
- H.264 levels: 1080p120 is 5.1 and 1440p120 is 5.2, which `avcLevel` (`codec.ts:57`) already gives;
  2160p120 would be 6.0, which many hardware and WebCodecs H.264 encoders refuse, so 4K at 120 fps is
  offered only with HEVC or AV1 (§2.1).
- Timelines are written at the export's rate up to 60 fps and at 60 above (FCPXML's frame rates and
  EDL timecode stop at 60; §8.6).

### 5.7 Size targets

Unchanged for H.264, VP9 and GIF. HEVC and AV1 GPU encoders use one pass at the target bit rate with
the VBV limits above; libaom (and libx265 under decision 1 (b)) use today's two-pass plan
(`isTwoPass`, `exportArgs.ts:239`, extended to them) over the lossless x264 intermediate. Off for the
intermediates (sized by quality), for alpha (the intermediate is 4:2:0 without alpha) and for WAV.

### 5.8 4:5

Sizes in §4.1. Levels for 1080×1350: H.264 4.0 up to 30 fps, 4.2 at 60, 5.1 at 120; HEVC 4, 4.1, 5. The
tall-frame rules (follow framing, camera placement) apply as for 9:16, because `isTall` already
counts 4:5 as tall and `exportPreviewSize` (`exportPlan.ts:71`) already handles it.

One rule does not: the app safe zones. `textArea` (`src/shared/render/safeZones.ts:95-103`) confines
captions, key presses, the logo and lower thirds to `COMMON_SAFE` in any tall frame when
`reframe.appSafe` is on, and that box is the part of a 1080×1920 Reels, TikTok and Shorts frame that
their buttons leave free. A 4:5 feed post has no such buttons over it. So `exportProject`
(`exportPlan.ts:48`) sets `reframe.appSafe` to false in the copy it makes for a 4:5 export (never in
the project). `textArea` itself does not change, so every frame of today is placed as before, and the
dialog's preview, which draws the same copy, shows the same placement (test 20).

The batch "Also" row adds 4:5 (`BATCH_ASPECTS`), file label "4x5".

### 5.9 Probing

`probeCodec('hevc' | 'av1')` runs a 10-frame test encode per GPU encoder, the way `probeEncoder`
(`hwEncoders.ts`) does for H.264, with each encoder's own pixel format (`nv12` for qsv, amf, mf;
`yuv420p` for nvenc) and `-hw_encoding 1` for `hevc_mf`; `av1_amf` and the `_mf` encoders only on
Windows. The probe runs once per codec per session, when the dialog first needs it, and is cached; it
never runs at app start. The renderer probes WebCodecs with `VideoEncoder.isConfigSupported` and
`hardwareAcceleration: 'prefer-hardware'`, as for H.264 today.

### 5.10 Sizes, times and disk space

`estimateBytes(options, size, seconds)` (`proFormats.ts`) gives an upper estimate from
`MB_PER_MINUTE_1080P60` scaled by pixels × `fps / 60` for CineForm and ProRes (they code every frame
on its own, so 120 fps is twice 60 fps: measured 2.0× with `cfhd`) and × `rateFps / 60` for Animation
(it codes the changes from the frame before): CineForm YUV 1,500, CineForm RGBA 3,600, Animation 2,500,
ProRes 422 HQ 3,300 (Apple's nominal at 59.94), ProRes 4444 5,000, stems 23.04 per stem. The dialog's
hints give it for the whole video (§2.1).

`encodeSecondsEstimate(options, size, seconds)` gives the AV1 hint's time on the processor:
`seconds × 4.5 × (w × h) / (1920 × 1080) × rateFps(fps) / 60`, from the benchmark (45.2 s for 10 s of
1080p60 on 4 vCPU, §5.4). It is a rough figure and the hint says "roughly"; P1 recalibrates the
factor on the reference PC.

Before an intermediate, alpha or stem export starts, main compares the estimate with the free space of
the target folder (`fs.statfs`); below 1.2 × the estimate the export does not start and says (exact):
"This export needs about {size} and the folder has {free} free. Choose another folder or a smaller
format." (error code `disk-full`).

---

## 6. Transparent video (alpha) through the compositor

### 6.1 What is see-through

`RenderScene` (`compositor.ts`, wave 10's version) gains one optional field, set only by an export
with a transparent Background and by the export dialog's preview of it:

```ts
/** A see-through export (output-and-languages §6); absent: the frame is drawn opaque, as before. */
alpha?: 'background' | 'overlays'
```

| Layer (in drawing order) | With background (today) | Transparent (`'background'`) | Overlays only (`'overlays'`) |
|---|---|---|---|
| Background (colour, gradient, image, animated) | yes | **no**: the frame starts cleared | no |
| Card: shadow, border, device frame, black content well | yes | yes (the shadow is semi-transparent black; a glass border shows its tint without the blurred backdrop) | no |
| Recording, with grade, crop, camera moves, motion blur, punch-in | yes | yes | no |
| Privacy shapes, cursor, magnifiers, shapes, spotlights (inside the card) | yes | yes | no |
| 3D tilt | yes | yes (the warped card over a clear frame) | no |
| Camera bubble or camera layout | yes | yes | yes |
| Image overlays, key presses, texts, graphics, captions, title cards, progress bar, watermark | yes | yes | yes |

- The split follows the code that already exists: `drawFramePicture` draws the picture,
  `drawFrameOverlays` what goes over it (`compositor.ts:141`, `:293` on `feat/wave10`). Overlays only
  draws no picture but keeps the camera, which `drawFramePicture` draws last (`drawWebcamLayer`).
- A full-frame title card stays opaque: it covers the frame by design.
- With the aspect *Project* on `auto` and padding 0 the card fills the frame, so nothing is
  see-through. The Background row then says (exact): "With no padding the recording fills the
  frame: nothing will be see-through. Add padding in Style, or choose Overlays only."
- Privacy shapes are not drawn in Overlays only: they blur the recording, which is not there.

### 6.2 The drawing change

In `drawFramePicture`, and nowhere else:

1. `alpha` absent: every line runs as today (guard test 4 compares call logs).
2. `alpha` set: `ctx.clearRect(0, 0, w, h)` takes the place of `paintStaticLayer`,
   `paintBackgroundLayer` and the tilted branch's background. The card is painted with
   `paintCardLayer(ctx, w, h, spec, geom, null)` when still and `paintStillCard(ctx, w, h, spec, geom,
   null, layoutMove)` when moving. Both already draw on a transparent layer (`staticLayer.ts:569` on
   `feat/wave10` gets its context without `alpha: false`).
3. `'overlays'`: after clearing, the function skips the card, the recording and the layers inside the
   card clip, draws the camera and returns the frame context. The overlays draw as usual.

The cached opaque layers (`staticLayer.ts:467`, `:527`, `:636`) are not used by a transparent frame,
so their keys and contents do not change.

### 6.3 Canvas, readback and pixel formats

- The export canvas (`exporter.ts`, `getContext('2d', { alpha: false, willReadFrequently: cpu })`)
  gets `alpha: true` only for a transparent job.
- A canvas with alpha reads back through `VideoFrame` as **premultiplied** BGRA (measured in Electron
  44: 50% red reads `[0, 0, 128, 128]`); `getImageData` returns straight values. Transparent jobs
  read each frame through `VideoFrame` exactly as opaque raw jobs do today, and `alphaRawSink`
  (P2, `src/renderer/src/render/alphaReadback.ts`) unpremultiplies it in the renderer with the
  rounding `getImageData` uses (`c' = round(c × 255 / a)`, and 0 where `a` is 0) before sending
  straight `bgra` to ffmpeg. ffmpeg always receives straight alpha; there is one convention.
- Why not `getImageData` on every frame: Chromium can move a 2D canvas whose pixels are read back
  that often to software rendering (the heuristic behind `willReadFrequently`), and then every later
  drawing step of the export (motion-blur sub-frames, shadows, the grade) runs on the CPU. P2
  measures both readbacks on a GPU canvas with the reference clip and keeps `getImageData` (with
  `willReadFrequently: true` chosen on purpose) only if it is not slower. Test 26 requires both
  readbacks to give the same bytes on a drawn frame.
- Chromium stores canvases premultiplied in 8 bits, so a pixel at 4% opacity keeps about 10 levels
  of colour. That is the canvas's limit, the same in preview and export, and invisible over any
  background.
- Bytes over IPC: 4 a pixel (8.3 MB per 1080p frame), against 1.5 for today's I420. §19 has the cost.
- ffmpeg converts per codec (§5.4): `yuva420p` for VP9, `gbrap12le` for CineForm, `argb` for
  Animation, `yuva444p10le` for ProRes 4444.
- Fully transparent pixels read back as black with alpha 0. VP9's 4:2:0 chroma mixes that black's
  neutral chroma into edge pixels: edges lose a little saturation, not brightness (luma is per pixel).
  e2e step F6 checks a 50% grey shadow and a red card edge.

### 6.4 Cut styles in a transparent video

Crossfades, dips and slides stay in a transparent export, as the preview plays them.

- Wave 10 composes A\* (the frame the cut leaves) with `drawFramePicture` on a scratch target made
  with `alpha: false` (`joinLayer.ts:59`, `scratchTarget`) and copies it into an opaque canvas
  (`composeJoinStill`, `joinLayer.ts:117`). P2 gives both an `alpha` argument: for a transparent
  export, A\* is drawn with the same `scene.alpha` on a second scratch target made with `alpha:
  true` and copied into a canvas with `alpha: true`. The join still cache keys gain the alpha mode,
  so an opaque and a transparent export never share a still.
- `endJoin` (`joinLayer.ts:32`) needs no change for crossfades and slides: it draws A\* at its alpha
  and offset over the live picture, which works the same over a transparent frame.
- A dip fills its colour over the picture today (`joinLayer.ts:46-50`). In a transparent export the
  background is gone, and the dip's colour belongs with it: the picture fades to transparent instead,
  drawn with `globalCompositeOperation = 'destination-out'` at the dip's alpha. The overlays, drawn
  after it, stay as they are, as over a dip today.
- Punch-in only scales the content (`punchedCamera`) and needs nothing.
- The dialog's preview draws through the same code, so preview and export match at every join frame
  (test 28, e2e F7). Without `alpha` nothing changes (test 4's call logs).

### 6.5 The dialog's preview

`ExportPreview.tsx` draws a transparent export with the same `RenderScene.alpha` into a canvas made
with `alpha: true`, and shows a checkerboard behind the canvas with CSS (8 px squares of
`--surface-2` and `--surface-3`). The canvas pixels are the export's pixels; the checkerboard is
never drawn into them. The editor's own preview does not change: the background is part of the
project, transparency is part of one export.

### 6.6 What the codecs keep

| Codec | Alpha kept | Measured on the alpha clip (1080p60, 10 s) |
|---|---|---|
| VP9 (WebM) | 8-bit, 4:2:0 colour | alpha PSNR 56.9 dB at realtime crf 30, 7.4 MB/min |
| CineForm RGBA 12-bit | 12-bit | alpha PSNR 51.0 dB at "high", 2,395 MB/min |
| Animation | lossless | 812 MB/min, more with motion |
| ProRes 4444 (decision 2 (b) only) | lossless alpha, 10-bit colour | 2,351 MB/min |

FFmpeg's own VP9 decoder ignores alpha (measured: alpha PSNR 3.2 dB, fully opaque). Every test that
reads a transparent WebM decodes with `-c:v libvpx-vp9` before `-i`.

---

## 7. Sound stems and the WAV format

### 7.1 What is written

| Stem | File (`<base>` is the video's name without extension) | Sound | Written when |
|---|---|---|---|
| Voice | `<base> - Voice.wav` | the `mic` stem, or Clean voice's cleaned stem (`cleanVoiceInputs`, `voiceIpc.ts:51-67`) | the project has separate files and the microphone is heard |
| System sound | `<base> - System sound.wav` | the `system` stem | the project has separate files and system sound is heard |
| Recording | `<base> - Recording.wav` | screen.mp4's mixed track | the project has no separate files (`stemsOf`, `settings.ts:100`, is empty) |
| Music | `<base> - Music.wav` | the music branch (`musicGraph` or wave 10's `bedGraph`), ducked | music is on |
| Effects | `<base> - Effects.wav` | clicks, pops and dings, bleep tones, wave 10's library effects | any of them sounds |

A stem that would be silent is not written. Names are English in every UI language (§0 decision 10)
and made unique by main (" (2)") the way `export:batchPath` does.

### 7.2 One graph, several outputs

`stemPlan(job, files, first)` (`src/shared/render/stems.ts`) builds one ffmpeg run with today's
inputs (`planSoundtrack`, `audioPlan.ts:483` on `feat/wave10`) and one output per stem. Each stem is
today's branch, built by today's functions, so every filter the video's soundtrack applies is applied
the same way:

- **Voice and System sound**: `recordingGraph` with `rec.stems` holding that one stem. The
  sound-finder gains, cut fades, holds, speed changes and the master volume are applied to each stem
  separately. Each of them is a gain or a time operation on that stem alone, so nothing is lost.
- **Recording**: `recordingGraph` on the mixed track, as today without stems.
- **Music**: `musicBranch` as today (with its own `STEREO`, `audioPlan.ts:306`), ducked by the same
  envelope.
- **Effects**: the click, pop, tone and library-effect branches, joined with `amix … normalize=0` as
  `soundtrackGraph` joins them.
- **The channel step of the mix.** Each stem gets exactly the step its branch gets when the mix
  joins it, before `aformat`: Voice, System sound and Recording go through `STEREO`
  (`pan=stereo|FL=FL+FC|FR=FR+FC`, `audioPlan.ts:84`), as `recordingGraph` does for each stem when it
  mixes several (`:231`) and `soundtrackGraph` does under music (`:429`); each effect track goes
  through `STEREO,aresample=rematrix_maxval=1`, as the effect tracks join the mix (`:437`). A
  single-stem `recordingGraph` adds no `STEREO` (`:226-228`), and without this step `aformat`'s own
  upmix would put a mono microphone or a mono click 3 dB lower on each side than the video and the
  preview play it. Test 31 covers a mono microphone and a project with effects only.
- Every stem then gets the soundtrack's own start and end fades (`fadeFilters`), which are gains on
  each sample, and `aformat=sample_fmts=flt:channel_layouts=stereo`.

Each output:

```
-map [voice] -c:a pcm_f32le -ar 48000 -rf64 auto -write_bext 1 -metadata time_reference=0
  -metadata originator=Flown -metadata "description=Voice" -f wav "<base> - Voice.wav"
```

### 7.3 Length and start

Every stem starts at sample 0 and is exactly `N = round(frames / fps × 48000)` samples long, ending
in `apad=whole_len=N,atrim=end_sample=N`. That is the video's own length in samples: 2,000 samples a
frame at 24 fps, 1,920 at 25, 1,600 at 30, 800 at 60 and 400 at 120, all whole. BWF
`time_reference` 0 matches the timelines' 00:00:00:00 start (§8).

### 7.4 Loudness

Today's video soundtrack normalises the recording with `loudnorm` (`NORMALIZE_FILTERS`,
`audioPlan.ts:51`), whose gain moves over time. Normalised one by one, stems would not add up
(measured residual −23.7 dBFS RMS against −15.8 LUFS). So, when normalisation is on, the stems carry
**one fixed gain**: `StemJob.gainDb = 20·log10(previewNormalizeGain(project, analysis))`
(`soundtrack.ts:154`, the gain the preview plays), clamped to −30…30 dB, applied to Voice, System
sound and Recording where `loudnorm` sits today. Measured: the stems then add up to the same mix with
a residual of −165 dBFS (float noise) and an integrated loudness of −16.0 LUFS.

Stems are 32-bit float, so a peak above 0 dBFS (music at gain 2, a loud click) is kept, never
clipped, and the receiving editor can lower it. No measuring pass and no limiter.

The video's soundtrack is not changed: test 3 compares its graph character for character.

### 7.5 What adds up exactly

- **Clips at 1× speed**: the stems add up to the soundtrack with the fixed gain in place of
  `loudnorm`, sample for sample (test 31: residual below −120 dBFS).
- **Clips at other speeds**: each stem is stretched on its own by `atempo`. Stretched stems sound
  right together but do not cancel against a stretch of their sum (measured residual −26 to −28 dBFS
  RMS at 0.5×, 1.5× and 2×). The stems are what an editor needs; the video keeps its own soundtrack.
- **Preview**: the preview plays the fixed gain too, through its peak limiter
  (`previewAudio.ts:367-380`). Below the limiter's threshold the stems match it.

### 7.6 When stems are written

1. The video finishes as today (`export:finish`, `moveIntoPlace`).
2. `export:finish` calls `writeStemsStep` (P3, `src/main/stemsRun.ts`; the call is the contracts').
   It resolves the sound inputs for the stems (`resolveSoundInputs` on a copy of the job whose
   `audio.stems` holds `StemJob.gains`, then `cleanVoiceInputs`). That asks for the separate files
   even when the video itself used screen.mp4's mixed track, which `recordingMix`
   (`settings.ts:143`) chooses whenever the gains are default. It runs the stem graph into temporary
   files next to the video and renames each into place.
3. `ExportFinish` reports `stems: { stem, path, bytes }[]`, or `stemsProblem` (a message in the UI
   language) when the step failed. The video is never removed because of a stem.
4. Cancelling during the stem step deletes the stem files written so far, never the video.

Stems are offered with every format except GIF, M4A and WAV included. Blocked, with the reason under
the chip (§2.3): GIF, batch, one file per chapter, a project without sound.

### 7.7 The WAV format

*Format › WAV* is today's M4A job (`exportAudio`, `exporter.ts:305`; `video: { kind: 'none' }` at 60
fps) with one difference at the end: `-c:a pcm_f32le -ar 48000 -rf64 auto -f wav` instead of AAC in
`-f ipod`. Its graph is the M4A graph byte for byte (test 30), `loudnorm` included, so it is the
video's sound, uncompressed.

It is 32-bit float, not 24-bit integer, because the graph can go above 0 dBFS: `loudnorm` runs only on
the recording and only with *Even out loudness* on, and music (gain up to 2), clicks, pops and library
effects are mixed after it with `amix … normalize=0`. AAC keeps such peaks; 24-bit integer would clip
them. The MOV intermediates' audio is float for the same reason. `SAVE_FILTERS` and
`EXPORT_EXTENSIONS` gain `wav` (the contracts, §21.0).

### 7.8 Sizes

32-bit float stereo at 48 kHz is 384,000 B/s: **23.04 MB a minute** for each stem and for the WAV
format alike. A plain WAV holds 4 GiB (3 h 6 min of float stereo); `-rf64 auto` switches to RF64
beyond that, which Premiere, Resolve and Audition read. Disk space is checked before the export as in
§5.10.

---

## 8. Timelines for other editors

### 8.1 Two kinds of timeline

| | *This export* (default) | *The original recordings* |
|---|---|---|
| Purpose | Mix and finish in another editor; add it to a bigger edit | Re-edit Flown's cuts in another editor |
| Sequence size and rate | the export's size; its rate up to 60 fps | `screen.mp4`'s own size (probed); the export's rate up to 60 fps |
| Video track V1 | the exported video, full length, one event. **Picture only when stems are written** (FCPXML `srcEnable="video"`, no xmeml audio clip items for it); with its own sound otherwise | `Screen.mp4`: `screen.mp4` remuxed without its sound (`-map 0:v -c:v copy -an`), one event per Flown clip |
| Video track V2 | none | `Camera.mp4` (remuxed the same way), when the project has a camera, offset by `webcamOffset`, **turned off** (FCPXML `enabled="0"`, xmeml `<enabled>FALSE</enabled>`) |
| Audio tracks | the WAV stems written with this export (§7), full length; without stems, none (the video's own sound plays) | A1 Voice and A2 System sound (or A1 Recording): WAV copies of the recordings, cut like V1. A3 Music and A4 Effects: with stems on, the stems next to the video; with stems off, the timeline step renders those two itself (`stemPlan` with only Music and Effects) into the media folder. Either way looping, ducking, volume and fades stay as in Flown |
| Speed changes, pause freezes | already rendered | as speed effects and holds |
| Crossfades (wave 10) | already rendered | as dissolves; dip, slide and punch-in as hard cuts |
| Zooms, cursor effects, background, captions, texts, shapes, camera layouts, colour | already rendered | **not carried** (the dialog says so, §2.3) |
| Chapter markers | yes | yes |
| EDL | yes (one event, §8.5) | not offered |
| Media written | nothing new (the export and its stems) | `<base> media\` with `Screen.mp4`, `Camera.mp4`, `Voice.wav`, `System sound.wav` or `Recording.wav`, and `Music.wav` and `Effects.wav` when stems are off |

Why V1 is picture only with stems, and why the recordings lose their sound: otherwise the editor plays
the sound twice, the video's own track (or screen.mp4's mixed track) and the stems on top. The two
copies would not even double cleanly: the video's sound is ridden by `loudnorm` and the stems carry
one fixed gain (§7.4), so together they comb.

Why the camera is turned off: on V2, full frame, it would cover the screen recording, and Flown's
camera moves over time (layouts, the director, follow framing), so no single picture-in-picture
placement would be right. The user turns the track on and places it.

The recordings mode copies media: the project's files (`LINKED_MEDIA`, `projectCopy.ts:22`) are never
hard-linked out, because an editor that opened the link for writing would change the project. The
microphone and system files are converted to WAV (`-c:a pcm_s24le -ar 48000`; the recordings
themselves never exceed 0 dBFS), because M4A files carry the encoder's priming delay in an edit list
that some readers ignore (21–44 ms offsets). ffmpeg honours the edit list, so the WAV starts where the
recording starts. With Clean voice on, the Voice file is the cleaned stem. Before copying, main checks
free space for the sum of the files plus 20%.

### 8.2 The plan (`src/shared/interchange/timelinePlan.ts`, pure)

```ts
export type TimelineMedia = 'video' | 'screen' | 'camera' | SoundStem
export interface TimelineEvent {
  media: TimelineMedia
  /** Timeline frames, [recIn, recOut). */
  recIn: number
  recOut: number
  /** Source frames at the source's own rate, [srcIn, srcOut). For a hold, srcOut = srcIn + 1. */
  srcIn: number
  srcOut: number
  /** Constant speed (1 = normal); 0 for a hold. */
  speed: number
  /** A dissolve into this event from the one before it, in timeline frames. */
  dissolve?: number
  /** Level in dB and fades in timeline frames (music only). */
  gainDb?: number
  fadeIn?: number
  fadeOut?: number
}
export interface TimelinePlan {
  name: string
  /** The timeline's rate: the export's rate up to 60, else 60. Whole numbers only. */
  fps: 24 | 25 | 30 | 60
  width: number
  height: number
  /** Length in timeline frames. */
  frames: number
  tracks: { kind: 'video' | 'audio'; name: string; role?: 'dialogue' | 'effects' | 'music'; enabled: boolean; events: TimelineEvent[] }[]
  /** V1's own sound is left out (stems written alongside it). */
  pictureOnly: boolean
  /** Chapter markers (outputChapters) and the user's own markers, in timeline frames. */
  markers: { frame: number; name: string; chapter: boolean }[]
  /** Facts about each source from the project's record of its files (rate, length, size, streams); main checks them against ffprobe and fills in the paths. */
  media: Partial<Record<TimelineMedia, { fps: number; frames: number; width?: number; height?: number; audio: boolean; video: boolean }>>
}
export function exportTimeline(project: Project, exported: { fps: number; frames: number; width: number; height: number }, stems: readonly SoundStem[]): TimelinePlan
export function recordingsTimeline(project: Project, fps: number, media: TimelinePlan['media']): TimelinePlan
```

Rules of `recordingsTimeline`:

1. Each Flown clip `{ start, end, speed }` (`types.ts:852`) becomes one event per track it has
   sound or picture on. Pause freezes (`planOf`, `freeze.ts:134`) become holds: on video an event at
   speed 0 of the held frame; on audio a gap.
2. Record in and out are computed from the **exact cumulative output time**, rounded once per edge
   (`Math.round(t × fps)`), never by adding rounded durations, so 1,000 cuts end on the same frame as
   the video. Source in and out round on **each source's own frame grid** (`media.screen.fps`,
   `media.camera.fps`): the capture rate, 30 or 60, for a recording, and an imported video's own rate
   (import-video.md §2.3); never an assumed 60.
3. Wave 10's crossfade joins become `dissolve` on the second event, length `round(duration × fps)`;
   other join kinds are hard cuts.
4. Music and Effects: one event each from 0 to the end, at 0 dB, from the stems (§8.1). `gainDb`,
   `fadeIn` and `fadeOut` stay unused by Flown's own plans; they exist so a later version can hand the
   music over unmixed.
5. Markers: `outputChapters` (`chapters.ts:32`, found chapters of wave 11 included) as chapter
   markers, named by their titles.
6. The size is `media.screen`'s; V2 is `enabled: false`; `pictureOnly` is false (the remuxed
   recordings have no sound to leave out).

`exportTimeline` sets `pictureOnly` when `stems` is not empty.

### 8.3 FCPXML 1.10 (`src/shared/interchange/fcpxml.ts`)

`function fcpxml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>, projectId: string): string`.
Written as one plain `.fcpxml` file, UTF-8, `<!DOCTYPE fcpxml>`, version 1.10 (FCP 10.6 and later;
DaVinci Resolve 18 and later). The sample in the research folder (`formats/otio/flown-1.10.fcpxml`)
validates against Apple's FCPXML 1.10 DTD with `xmllint --dtdvalid`.

- `resources`: one `format` per distinct size and rate (`frameDuration="1/{fps}s"`, `width`,
  `height`; `colorSpace="1-1-1 (Rec. 709)"` for the intermediates, none for H.264, HEVC and AV1,
  whose files carry their own tags); one `asset` per media with `start="0s"`, `duration`, `hasVideo`,
  `hasAudio` from the probed facts (`"0"` for the remuxed `Screen.mp4` and `Camera.mp4`),
  `audioRate="48000"`, and a `media-rep kind="original-media" src="file:///C:/…"`.
- `library > event name="Flown" > project name="{name}" > sequence` with `tcStart="0s"`,
  `tcFormat="NDF"`, `audioLayout="stereo"`, `audioRate="48k"`, and the plan's size.
- The spine holds V1's events as `asset-clip`s, with `srcEnable="video"` when `pictureOnly`. A speed
  is a `timeMap` with two `timept`s (linear); a hold is a `timeMap` with equal values. V2 and the
  audio tracks are connected clips (`lane="1"`, `lane="-1"` …) with `audioRole="dialogue"`,
  `"effects"` or `"music"`; V2's clips carry `enabled="0"`. An event with `gainDb` gets
  `<adjust-volume amount="{gainDb}dB"/>` (not used by this wave's plans).
- Dissolves are `<transition name="Cross Dissolve">` in the spine.
- Chapter markers are `<chapter-marker start="…" duration="1/{fps}s" value="{name}"/>`, other markers
  `<marker>`.
- Times are rationals `{frames × 1}/{fps}s` (whole frames), never decimals.
- A `uid` is `flown.{projectId}.{n}`, so importing the same export twice is recognised.

### 8.4 Premiere XML (`src/shared/interchange/xmeml.ts`)

`function xmeml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string`. FCP 7 XML
(`<xmeml version="4">`), which Premiere Pro imports natively (it does not read FCPXML) and DaVinci
Resolve reads too.

- `sequence` with `rate > timebase {fps}` and `ntsc FALSE`, `timecode` from 00:00:00:00, `format`
  with the plan's frame size, so V1 fills it without a transform in both modes.
- `media > video > track` and `audio > track` with `clipitem`s: `start`, `end`, `in`, `out` in frames,
  `file id` with `pathurl` `file://localhost/C:/…` (Premiere's own form), `duration`, `rate`. V1's
  file has no linked audio clip items when `pictureOnly`; V2's clip items carry
  `<enabled>FALSE</enabled>`.
- A speed is the `Time Remap` filter (`effectid timeremap`, `speed` in percent, `reverse FALSE`); a
  hold is speed 0 with `frameblending FALSE`. Premiere's *Maintain Audio Pitch* is off by default and
  xmeml cannot ask for it; the dialog's hint for the recordings mode says speed changes may change
  pitch there.
- Dissolves are `transitionitem` *Cross Dissolve*; markers are `marker` elements on the sequence. An
  event with `gainDb` gets the `Audio Levels` filter (linear: −3 dB is 0.707946).

### 8.5 EDL and the editors' formats (`src/shared/interchange/edl.ts`)

`function edl(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string` and
`function markerEdl(plan: TimelinePlan): string | null`. CMX 3600, read by Premiere, Resolve and Avid.

- Written for *This export* only. Over the recordings, each source has its own rate and the EDL one:
  a 60 fps source's timecode in a 25 fps EDL would round every cut to 40 ms, and editors read speed
  lines unevenly. The chip says so (§2.3).
- `TITLE: {name in ASCII}` and `FCM: NON-DROP FRAME`; one `AA/V` event with reel `AX`, the record and
  source timecodes, and the comments `* FROM CLIP NAME: {file name}` and `* SOURCE FILE: {path}` that
  Resolve and Premiere use to link media. An EDL cannot name the stems; its event takes the video with
  its own sound. At 120 fps the source timecode is written at the timeline's 60 fps (exactly half the
  frames). The writer refuses a plan of more than `EDL_EVENT_LIMIT` (999) events.
- `markerEdl` writes `<base> - Resolve markers.edl` when *DaVinci Resolve* is chosen and the video
  has chapters, the form Resolve imports through *Timelines › Import › Timeline Markers from EDL*
  (one event per chapter, `|C:ResolveColorBlue |M:{name} |D:1`). Other editors would read it as a
  sequence of one-frame events, so it is never written for them. Names are reduced to printable
  ASCII; a name with no ASCII letters becomes "Chapter {n}" (Bangla chapter titles stay whole in
  FCPXML and xmeml, which are UTF-8).
- Lines end in CRLF.

`EDITOR_OPENS` (`src/shared/render/alsoSave.ts`) records, per editor and per video codec, `'yes'`,
`'no'` or `'unchecked'`. At the start: Final Cut Pro with WebM (VP9 or AV1) or AV1 in MP4 is `'no'`
(blocked, §2.3); H.264 and HEVC are `'yes'` everywhere; Premiere Pro and Resolve with WebM, AV1 or
Lossless, and Final Cut Pro with CineForm or Lossless, are `'unchecked'` (a warning line). §0 decision
14's round trips set each `'unchecked'` cell, and nothing else changes it.

### 8.6 Frame rates, start, names and paths

- The timeline rate is the export's rate up to 60 fps and 60 above (FCPXML's frame rates and EDL
  timecode stop at 60). Rates are written exactly: `frameDuration="1/24s"`, `<ntsc>FALSE</ntsc>`,
  `FCM: NON-DROP FRAME`. No 23.976 or 29.97 exists in Flown (§3.2 row 9).
- Every timeline starts at 00:00:00:00, like the stems' BWF `time_reference` 0.
- Paths are absolute Windows paths written as file URLs: UTF-8 percent-encoded (Bangla names and
  spaces included), drive letter kept (`file:///C:/Users/…`; xmeml `file://localhost/C:/…`).
- Names and text are escaped by `xmlText` and `xmlAttr` (`src/shared/interchange/fileUrl.ts`, shared
  by the three writers): `<`, `&`, `"` and `'` escaped; the characters XML 1.0 forbids (U+0000–U+0008,
  U+000B, U+000C, U+000E–U+001F, U+FFFE, U+FFFF and lone surrogates) dropped, so a pasted or AI-made
  chapter title cannot make the file unreadable; a newline in an attribute written as `&#10;`.
- Final Cut Pro runs on a Mac, so Windows paths need relinking there (the chip and the done view say
  so); DaVinci Resolve and Premiere on the same PC open them directly.

### 8.7 Writing

`exportBundleRun.ts` asks for the timeline after the video, the stems and the sidecars:
`writeTimeline(request)` (§4.2). Main checks that `videoPath` is the path this session exported, that
each stem path sits next to it, and that the plan is well formed (`checkTimelinePlan`, §18.3); then it
probes the media with ffprobe and refuses a plan whose rates, sizes or lengths disagree with the
files, fills in the paths (in recordings mode it first remuxes, converts and, when stems
are off, renders Music and Effects into `<base> media\`), runs the writers, and writes each file with
a temporary name and a rename. A file name that is taken gets " (2)". Every written file and the
media folder are listed in the done view, each with the line that says how to open it (§2.4).

---

## 9. Languages: the runtime and the catalogues

### 9.1 One runtime for every process

`intl-messageformat` 12.1.4 (BSD-3-Clause; with its `@formatjs/*` parts, 9.8 KB gzip in the renderer)
formats ICU MessageFormat messages. It is pinned exactly as a devDependency and bundled by
electron-vite into main and the renderer, as React is (the preload makes no text and does not import
it); `scripts/notices.mjs` adds it to `BUNDLED`. Around it, about 150 lines of our own in
`src/shared/i18n/`:

```ts
// src/shared/i18n/t.ts
export type MessageValues = Record<string, string | number>
/** The message `key` in the UI language with `values`; English when the language has no approved text for it. */
export function t(key: MessageKey, values?: MessageValues): string
/** The same, with rich tags (<kbd>, <b>, <em>, <link>) mapped to the caller's nodes. */
export function tParts<T>(key: MessageKey, values: MessageValues, tags: Partial<Record<RichTag, (chunks: (string | T)[]) => T>>): (string | T)[]
export type RichTag = 'kbd' | 'b' | 'em' | 'link'
/** Registers messages for a language; the process's entry registers English (§9.1), never t.ts itself. */
export function registerMessages(language: UiLanguage, messages: Readonly<Record<string, string>>): void
/** Set once per process before any text is made (main at start, the renderer before its first render). `latn`: keys whose numbers stay Latin (§9.3). */
export function setCatalogue(c: { language: UiLanguage; messages: Readonly<Record<string, string>>; latn?: readonly string[]; formatLocale: string; dir: 'ltr' | 'rtl' }): void
export function uiLanguage(): UiLanguage
export function uiDir(): 'ltr' | 'rtl'
```

- **English is registered per process, not imported by `t.ts`.** The renderer's `main.tsx` and the
  vitest setup import `src/shared/i18n/messages/en/index.ts` (every namespace); `src/main/index.ts`
  imports `src/shared/i18n/messages/en/main.ts` (`common`, `errors` and `main` only). The preload
  imports nothing from `src/shared/i18n`: it makes no UI text. Meta files are never imported at
  runtime. So main and the preload do not carry or parse the renderer's 4,700 messages; test 86 walks
  main's import graph and fails on any key outside main's three namespaces.
- A key missing from the language's catalogue, or whose translation is stale (§15.6), formats the
  English message: the user sees English for that string only.
- Each message is parsed once, on first use, and cached per language and key (59 ms for 4,000 Bangla
  messages if all were used; 2.2 µs per call afterwards, measured in Electron 44).
- The language changes only at restart (§3.2 row 18), so `t()` is a plain function: shared helpers,
  main-process code and components all call it the same way, and nothing is re-rendered on a switch.
- **`t()` never runs at module scope.** Text is made where it is shown. Tables that are built when a
  module loads (`COMMAND_LIST` titles, `commands.ts:32`; `SAVE_FILTERS`, `exportIpc.ts:69`;
  `EXPORT_PRESETS` labels; `ENCODER_NAMES`; `RESOLUTION_LABELS`; `KIND_WORDS`; `SPEECH_TIER_NAMES`;
  `BUSY_COPY`; …) hold `MessageKey`s and resolve them where they are used. Main's renderer-facing
  tables become functions (`saveFilters()`). The scanner reports any `t()` outside a function
  (`module-scope-t`, §16.1). Both processes also set their language before their text-making modules
  run (§9.4), so a slip shows English loudly in L9 rather than staying English quietly.
- In the renderer, `src/renderer/src/i18n/T.tsx` exports
  `function T(props: { k: MessageKey; values?: MessageValues; tags?: Partial<Record<RichTag, (chunks: ReactNode[]) => ReactNode>> }): JSX.Element`,
  which renders a fragment (no wrapper element), so the DOM around it does not change.
- `MessageKey` is a union type built from the English JSON files with template literal types
  (`` `${'export'}.${keyof typeof exportEn & string}` | … ``). Each namespace file is its own import,
  so parts that add keys to different namespaces never touch the same file (§21.8). Both tsconfigs
  gain `"resolveJsonModule": true`.

### 9.2 Catalogue files

| Path | Holds | Who writes it |
|---|---|---|
| `src/shared/i18n/messages/en/<ns>.json` | key (without the namespace) → English ICU message, exactly today's text | the contracts (new features' text), then the extraction (§10) |
| `src/shared/i18n/messages/en/<ns>.meta.json` | key → `{ description, screen?, maxLength?, dnt?: string[], merge?: true, digits?: 'latn', user?: string[] }` | the same |
| `translations/glossary.csv` | term, part of speech, note, do-not-translate flag, then one column per language | reviewers (§15.2) |
| `translations/reviewers.json` | `{ id, name, languages, agreement: 'licence' \| 'assignment' \| 'contract', signed }` per person | the owner (§15.1) |
| `translations/<lang>/<ns>.json` | key → `{ text, state: 'draft' \| 'reviewed' \| 'approved', sourceHash, draftedWith?, reviewedBy?, reviewedAt?, approvedBy?, approvedAt?, note? }` | the drafting script, then reviewers |
| `src/shared/i18n/built/<lang>.json`, `<lang>.main.json` | `{ messages, latn }`: approved, current messages only, and the keys whose numbers stay Latin (§9.3), for the renderer and for main | `npm run i18n:build` (§16), committed and checked |
| `src/shared/i18n/built/shipped.json` | `{ language, preview }[]`: the languages in the picker, and whether each is still a preview (§0 decision 11) | the same |

- `sourceHash` is the first 12 hex digits of SHA-256 of the English message. When English changes,
  the translation goes stale and is left out of the built catalogue until it is approved again.
- The built catalogue for main holds the `main`, `errors` and `common` namespaces; main imports it
  statically (about 30 KB for Bangla). The renderer loads `<lang>.json` (about 450 KB for Bangla) with
  a dynamic `import()`, which Vite emits as a same-origin chunk under the existing CSP. English has no
  built file.
- `translations/` and `scripts/i18n/` are not in the app's files list (`appFiles()`), so drafts,
  review notes, reviewers' names and the glossary never ship.

**Namespaces** (one JSON file each, one owner each, §21.8): `common`, `keys`, `commands`, `home`,
`editor`, `timeline`, `style`, `zoom`, `camera`, `sound`, `captions`, `text`, `review`, `smart`,
`export`, `settings`, `errors`, `main`; one per feature part of this wave, filled by the contracts:
`codecs` (P1), `alpha` (P2), `stems` (P3), `timelines` (P4), `presets` (P5), `language` (P6); and
`recording` (reserved, empty, §9.5).

The **core** namespaces, which must be fully approved before a language appears in the picker (§0
decision 7), are every namespace except `commands`, `review`, `smart` and `recording`: the screens
of a first session, the inspector panels used on every project, and captions, the main reason Bangla
users come to Flown (its Bangla speech model).

### 9.3 How messages are written

- **Keys** are semantic and stable: `export.codec.hevc.title`, `editor.notice.zoomAdded`. English
  copy can change without changing keys.
- **Exact English.** A message holds exactly the text the code renders today: the same spaces,
  `&nbsp;` as U+00A0, "…" as U+2026, curly quotes where the code has them. The codemod takes JSX text
  from `ts.transpileModule` output with `jsx: 'react-jsx'`, so JSX whitespace rules are React's.
- **Placeholders** are named after what they hold (`{name}`, `{count}`, `{size}`), never `{0}`.
  Placeholders that carry the user's own text are listed in the meta entry's `user` (§13.3).
- **Numbers are formatted by code and passed as strings.** A plural selects on a number and shows the
  formatted one: `{count, plural, one {{n} file} other {{n} files}}` with
  `{ count: 3, n: fmt.count(3) }`. **`#` is not used**: ICU formats `#` with grouping, so English
  would turn "1234 files" into "1,234 files". The checker rejects `#` and `{x, number}` (§16).
- **Plurals** keep `other` in every language and use only categories of
  `Intl.PluralRules(lang)`: es one/many/other, ar six, he one/two/other. **In `bn` and `hi` a plural
  holds only `other`**, and the drafts are asked for only `other`. Bangla and Hindi nouns do not
  change with number, and CLDR's `one` for both is `i = 0 or n = 1`, so a `one` branch would also
  show for 0: "একটি ফাইল" for no files. A `one` branch that holds a number word or a digit (এক, একটি,
  ১, एक, १) instead of `{n}` is rejected (test 62); test 54 formats count 0 through every Bangla
  plural.
- **Gender**: English sources avoid "You are …ing" forms whose verbs change with the reader's gender
  in Hindi and Arabic ("Recording…", not "You are recording").
- **No sentences built from pieces.** Where today's code concatenates fragments ("Split the clip" +
  " (S)"), the message becomes one with a placeholder when the English output stays identical for
  every input. Otherwise the fragments stay separate keys, marked `merge: true`, and the group also
  gets one whole-sentence message, `<key>.whole`, which the code uses **only when the UI language is
  not English**. English keeps today's code path (tests 9 and 10 hold); Bangla, which puts the verb
  last and attaches case endings (-এর, -কে, -তে) to what a placeholder holds, gets a sentence its
  reviewers can order. The build reports the merge groups per namespace before S5, and a core
  namespace with an unapproved `.whole` keeps the language out of the picker (test 85).
- **Digits per message.** A meta entry with `digits: 'latn'` marks a technical line: the size line,
  the Resolution, Aspect and Frame rate notes, the codec and encoder hints. For such a key `t()` turns
  native digits in its values into Latin ones, and the checker refuses native digits in its
  translation. Prose follows the user's choice (§11.3).
- **Normalisation.** Every message is NFC (the checker enforces it). ZWJ and ZWNJ (U+200D, U+200C)
  are kept: Bangla needs them (র‍্যা in র‍্যাম).
- **Apostrophes**: ICU treats `'{` as an escape. Plain apostrophes in words ("Don't") are safe; the
  checker rejects `'{`, `'}` and `'#`.
- **Rich text** only through the four tags of `RichTag`; no HTML in messages.

### 9.4 Choosing the language at start, and restarting

1. Main calls `initUiLanguage()` first in `whenReady` (`src/main/index.ts`), before any window opens
   and before any module makes text. It reads `ui` from `editor-prefs.json` with `readPrefSync('ui')`
   and resolves:
   - `language` absent or `'en'` → English. **Existing and new installs start in English** (§0
     decision 8).
   - `'system'` → the first entry of `app.getPreferredSystemLanguages()`, reduced to its language
     subtag (`bn-IN` and `bn-BD` are both `bn`); English when Flown has not shipped that language.
   - a shipped language → that language. A language that is not shipped (no built catalogue) → English.

   It also reads `--flown-open=<id>` from the command line of a relaunch (step 6).
2. The format locale: English keeps today's per-call-site profile (§11.2). Other languages use
   `app.getSystemLocale()` when it is the same language (`bn-BD`, `bn-IN`, `es-MX`), else the bare
   language; then the digits choice is added as a tag: `bn` + Western → `bn-BD-u-nu-latn`, `hi` +
   native → `hi-IN-u-nu-deva`. The choice is always a `-u-nu-` tag, because `Intl.DurationFormat` in
   V8 15.2 ignores the `numberingSystem` option and obeys the tag (measured).
3. Main calls `setCatalogue` with its built catalogue, so dialog titles, file filters, notifications,
   taskbar tooltips and error messages come out in the UI language.
4. The renderer's `main.tsx` imports only the styles and the boot code statically. It awaits
   `bootLanguage(view)` and then loads its view with a dynamic import (`const { App } = await
   import('./App')`, and likewise `NotesWindow`, `RegionPicker`, `Toolbar`) before
   `createRoot().render()`. `bootLanguage` makes one `ui:info` call (about 1 ms); for a non-English
   language it then loads the catalogue chunk and the UI font (§12), calls `setCatalogue`, pins the
   canvases' language (§9.7) and sets `<html lang dir>`. It is bounded at 1.5 s and wrapped in
   `try`/`catch`: any failure renders English and logs the reason (`appLog.ts`), never a blank window.
   English starts as today, with no catalogue load and no flash; a translated UI never shows English
   first. The first-render times of the main and toolbar windows are measured at S0 and S2 against
   the budgets of §19.4.
5. Views: the main window, the Notes window (`views/NotesWindow.tsx`) and the region picker
   (`views/RegionPicker.tsx`) follow the UI language; their files are ours (§9.5). The recording bar
   (`Toolbar.*`, the other account's) keeps `lang="en"` and English until they agree.
6. **Restarting.** `ui:relaunch(projectId?)` runs `relaunchBlocker()` in main: `busyReason()`
   (`src/main/updates/updatesIpc.ts:30`) or, when that is null, a running download (speech model,
   caption fonts, music, local AI model), with the reason `"Wait for the download to finish, or stop
   it."`. The renderer adds Home's own `recordingBusy` (`Home.tsx:717`). When something is busy the
   call returns `{ ok: false, reason }` and nothing quits. Otherwise main asks the editor to save as
   quitting does, then calls `app.relaunch({ args })` with the current arguments plus
   `--flown-open=<projectId>` when the editor was open, and `app.quit()`. After the restart
   `uiInfo().reopen` gives that id once, and `App.tsx` opens the project when it still exists.

`app.getLocale()` is not used: with only `en-US.pak` it is always `en-US` (measured), and Chromium's
locale packs stay out (§3.2 row 19).

### 9.5 The recording side

The other account's files are exactly those the rules at the top name: `src/main/recording/*`,
`src/main/recordingIpc.ts`, `src/main/windows.ts`, `src/shared/recording/*`, `Toolbar.*`,
`src/renderer/src/recorder/*` (with `RecordingOptions.tsx`, `RecordingPresets.tsx` and
`recorder/cameraBubble.tsx`) and `src/main/appSettings.ts`. They hold 310 unique candidate texts in 22
files by the first count (RecordingOptions.tsx 53, Toolbar.tsx 49, `recordingIpc.ts` 27,
`keystrokes.ts` 31 key names drawn into the video, …); a stricter count over 43 TS and TSX files finds
239. They are not edited in this wave. `views/RegionPicker.tsx`, `views/CameraBubble.tsx`,
`views/NotesWindow.tsx` and `views/recordingIcons.tsx` (SVG paths only) are not on that list: they
are ours and are extracted (X5, X5, X4; §10.5).

- The `recording` namespace exists, empty, owned by the other account. `scripts/i18n/pending.json`
  lists their files with the reason "other account: not yet agreed"; the scanner reports their
  strings as pending, never as failures.
- To join later they import `t` and `T` like any file and add keys under `recording.*`. Until the
  `recording` namespace is approved in a language, that language is a preview (§0 decision 11,
  `shipped.json`).
- **Our code that reads their text** changes now, so their joining later changes nothing on our side:
  - `CORNER_NAMES` (`src/shared/recording/cameraBubble.ts:18`), shown by `CameraPanel.tsx:426-427`,
    `LayoutTrack.tsx:193,208` and `layoutCommands.ts:89`: those sites take our own messages
    `camera.corner.<corner>` by the `Corner` id, and English gives today's words.
  - `friendlyError(err).message` (`src/shared/recording/errors.ts`), shown by `Home.tsx:83,467,590`
    and `NotesDialog.tsx:133`: in a translated UI wrapped in `<span lang="en">`, so screen readers
    read it with an English voice; English adds no wrapper.
  - `Home.tsx:672` refreshes the source list when `state.message === SOURCE_GONE` or the message
    matches `/no longer available/` (the texts of `recordingIpc.ts:204-205`). The first compares
    with their exported constant and stays. The regex works only while their texts are English;
    `pending.json` records the request that goes with their agreement: a code for "source gone",
    so Home stops reading English. Test 72 covers today's decisions.
- Every function of ours they import keeps its exact output in every language: `formatTime`
  (`engine/project.ts:225`, used by `Toolbar.tsx:188`), `Icon`, the `ffmpeg.ts` runner and its
  English messages, `projects.ts`, `inputEdits`. Our own call sites that show times move to
  `fmt.clock` (§11), and `formatTime` stays ASCII.
- In a translated UI, Home's Recording options and Recording presets panels (mounted at
  `Home.tsx:978` and `:987`) stay English inside a translated page, with `lang="en"` on their
  containers (only in a translated UI), so screen readers switch voice. Settings › Language says so
  (§2.5).

### 9.6 Code that reads English text, and Chromium's English

About a dozen places decide something by matching English text, and six ask through Chromium's own
English dialog. Each is changed so it no longer depends on the language; in English each decides and
shows exactly as today (tests 72 and 80).

| Place | Today | After |
|---|---|---|
| `exporter.ts:86` `NOT_ENCODER_RELATED` | a regex over main's English messages decides whether the next encoder is tried | `exportErrorCode()` (§4.2): fall back unless the code is one of `disk-full`, `permission`, `in-use`, `read-only`, `missing-input`, `unreadable`, `not-chosen`, `invalid-job`, `no-sound`, `cancelled`. Main sets the code where it maps the error (`toIpcError`, `exportJob.ts:63`; `KNOWN_ERRORS`, `ffmpeg.ts:22`, whose English texts stay for the recording side) |
| `ExportDialog.tsx:1294` | lower-cases a progress detail to put it inside a sentence | `fmt.inSentence(text)`: English lower-cases the first letter as today; other languages leave it |
| `ExportDialog.tsx:240` `splitError` | splits message and detail on a blank line | unchanged; the checker requires translations to keep English's blank lines |
| `captionItems.ts:187` `=== 'Cancelled.'` | compares a message with the English text | compares with `t('errors.cancelled')`, which main formats from the same catalogue, or the English text |
| `duplicateFlow.ts:76`, `Editor.tsx:611` `startsWith(prefix)` | finds a message by its English start | the result carries a `kind` field; the text is only shown |
| `overlayLayer.ts:217` `/GIF\|image/` | reads an error message | the loader returns `{ kind: 'gif' \| 'image' }` |
| wave 10's `LutQuestion` `.endsWith('without them?')` | tells the missing-LUT question by its English ending | the question object carries `missingLuts: true` |
| `exportPresets.ts:153,159` | preset labels become file names | file names stay English: `batchItems` takes labels from `EXPORT_PRESET_FILE_LABELS`, today's labels as data (§0 decision 10) |
| `window.confirm` at `Home.tsx:704` and `:874` (delete an unfinished recording, delete a project), `Editor.tsx:542` (leave with unsaved changes) and `:598` (the duplicate flow's `confirm`), `CaptionsPanel.tsx:395` (replace captions), `SpeakersSection.tsx:54` (replace speakers) | Chromium's dialog, whose buttons read "OK" and "Cancel" in English in every UI language; the scanner's sinks did not include it | `askConfirm(message, action)` (P6, `src/renderer/src/i18n/askConfirm.ts`): in English it calls `window.confirm(message)` exactly as today; in other languages it asks main (`ui:confirm`) for a `dialog.showMessageBox` whose buttons are the action and Cancel in the UI language ("মুছুন" and "বাতিল"). The X part that owns each file switches its call (§10.5); `confirm`, `window.confirm`, `alert` and functions passed as `confirm:` are scanner sinks (§16.1) |
| `CORNER_NAMES`, `friendlyError`, `/no longer available/` | the recording side's English inside our panels | §9.5 |

### 9.7 What stays untranslated

- Brand names (Flown, Qbexel), codec and container names (H.264, HEVC, AV1, VP9, CineForm, ProRes,
  MP4, WebM, WAV, FCPXML, EDL), editor names (DaVinci Resolve, Premiere Pro, Final Cut Pro), file
  extensions, technical identifiers (1080p, 16:9, 60 fps, 4K, version numbers), each written with
  Latin digits. They are marked `dnt` in the meta file and the glossary, and the checker requires them
  unchanged in every translation.
- Keycap names (§14.1) and `aria-keyshortcuts` values.
- The user's content: project names, captions, transcripts, notes, chapter titles, preset names.
- Everything written into exported files and project files: file names, sidecar suffixes,
  descriptions, subtitle stream names (`languageName`, `Intl.DisplayNames(['en'])`), chapter
  fallbacks, stem names, timeline names (§0 decision 10). Wave 11's guide words (`GUIDE_WORDS`): a
  Bangla guide keeps wave 11's Bangla words; Spanish and Hindi guides keep the English words in this
  wave, as every exported file does. When wave 11 merges, the contracts commit changes
  `smart-tools.md`'s sentence "Other languages use the English words with their own narration until
  the app is translated (X-05, wave 12)" to point at §24 here instead.
- **Drawn frames.** Nothing drawn into frames reads the UI language: the same project exports the
  same bytes on every PC and in every UI language.
  - The export and preview canvases live in the main window's document, and a canvas context's
    `lang` defaults to inheriting the document's. In a translated UI, `pinCanvasLanguage()` (P6,
    `src/renderer/src/i18n/canvasLang.ts`, installed by `bootLanguage`) wraps
    `HTMLCanvasElement.prototype.getContext` once: every canvas gets `lang="en"` when it has none,
    and every 2D context `ctx.lang = 'en'` where the property exists. Caption text then falls back and
    shapes exactly as in English. English installs nothing. Test 84 and e2e L13 (an exported frame's
    bytes in bn and en) hold it.
  - The `Intl.Segmenter` calls in captions, search and notes code (`captions/words.ts:37,58,60`,
    `studioLayout.ts:133`, `motion.ts:369`, `cleanup.ts:843`, `transcriptTiming.ts:72`,
    `search/normalize.ts:33`, `search/snippet.ts:47`, `notes/blocks.ts:43`) keep their locales: the
    renderer's default stays `en-US` (no locale packs), and the scanner's locale rule exempts
    `Intl.Segmenter`, because word and grapheme boundaries must not change with the UI.
- AI prompts (`src/main/ai/*`), model names, logs and diagnostics (`appLog.ts`), third-party notices.
- The recording side until the other account agrees (§9.5).
- Any string not approved in a language: English, string by string.

---

## 10. Extracting the strings without changing the English UI

### 10.1 How much text

Counted with the TypeScript compiler API at `dd368c7` (research scripts `code/strings.cjs` and
`i18n/scripts/count.cjs`):

| | Files with text | Candidate items | Unique texts |
|---|---|---|---|
| Renderer | 148 | 3,298 | 2,441 |
| Shared | 111 | 2,254 | 1,841 |
| Main | 63 | 500 | 377 |
| **Ours, union** | 322 | 6,052 | **4,377** (about 24,700 words) |
| After wave 10 | | | 4,740 (about 26,600 words) |
| The other account's (§9.5) | 22 | 398 | 310 |

About 18% of the loosest bucket is not UI text (font stacks, key ids, copyright lines), so the
realistic size is **3,600–4,400 messages and 22,000–25,000 words**, plus wave 11's new panels. Patterns
to rewrite, not just move: 677 templates built from prose, 88 hand-written plurals (`n === 1 ? … :
…`) in 46 files, 312 `aria-label`s (105 templated), 98 `showNotice(` calls in `Editor.tsx`, 289
`throw new Error('…')` that reach the UI, the English sentence helpers of `shortcuts.ts:243-330`, and
`CommandCategory`, an English word used as both id and label (`commands.ts:7-10`). The biggest files:
`commands.ts` 379, `Editor.tsx` 211, `StudioControls.tsx` 168, `CaptionsPanel.tsx` 160,
`ExportDialog.tsx` 155, `speechCopy.ts` 141, `shortcuts.ts` 138.

### 10.2 The codemod (`scripts/i18n/extract.mjs`, part P7)

`node scripts/i18n/extract.mjs --files <list> --ns <namespace>` proposes, for the files given:

- JSX text (taken from `ts.transpileModule` output, so whitespace is what React renders), the UI
  attributes `aria-label`, `title`, `placeholder`, `alt`, `aria-valuetext`, `label`, and string
  arguments to known sinks (`showNotice`, `setStatus`, `new Error` in UI-reaching code, dialog
  options, notification options, confirmation questions);
- template literals as messages with named placeholders (`{name}` for `${project.name}`);
- `n === 1 ? 'x' : 'xs'` and its variants as ICU plurals with `count` and `n` (§9.3);
- a key (`<ns>.<component>.<slug>`), a meta entry (`description`: the component and the sentence
  around it; `screen`: the guard tour's screen that shows it), and a row in
  `scripts/i18n/extraction-log.json`: `{ key, file, line, english, sample }` where `english` is the
  literal it replaced and `sample` the values that reproduce it.

It writes a patch for a person to read, never commits, and never edits a file outside `--files`.
The builder checks each change by hand; anything the codemod cannot make identical stays as it was and
is listed for a hand edit.

### 10.3 Rules that keep English identical

1. A message's English text is the exact string the code renders today (test 69 formats every
   logged message with its sample values and compares it with the logged literal).
2. Numbers, sizes, times and dates keep each call site's exact English formatting through the English
   profile of `fmt` (§11.2): `String(n)`, `toFixed(1)`, `toLocaleString('en-US')`, `en-GB` for
   `versionTime`.
3. Lists keep today's "A, B and C" (`listPhrase`, `shortcuts.ts:271`) in English.
   `Intl.ListFormat('en')` would write "A, B, and C", so `fmt.list` uses `Intl.ListFormat` only for
   other languages.
4. A sentence made of fragments becomes one message only when every input gives the same English;
   otherwise its fragments stay keys of their own with `merge: true`, plus a `.whole` message used
   only in other languages (§9.3).
5. `<T>` renders a fragment and `t()` a string, so no element is added or removed. Bidi isolation is
   off in English (§13.3). Wrappers that a translated UI needs (`lang="en"` around the recording
   side's text, §9.5) are added only when the UI language is not English.
6. Nothing in CSS changes in an extraction step. Logical properties are part X7 (§13.1), guarded the
   same way.
7. Strings that reach exported files or project files are not extracted to the UI catalogue (§9.7);
   they move to `src/shared/render/outputWords.ts` as plain English constants, so a later "language of
   files" choice has one place to start.
8. A string whose English must change for translation (an English-only grammar trick that cannot be a
   message) is not changed in this wave: it is listed in `scripts/i18n/english-changes.md` for the
   owner (§0 decision 12) and stays a `merge` group with its `.whole` message.
9. Text is never made at module scope (§9.1); a table the codemod meets holds keys after it.

### 10.4 Steps

| Step | Who | What | Guard |
|---|---|---|---|
| S0 | lead, in the contracts (§21.0) | the runtime; the namespace files with every message the new features show, written in full; the deterministic English-guard tour (tests 9 and 10) with no baseline yet; the size and first-render measurements of §19.4 | tests 1–8 |
| S1 | parts P1–P7 in parallel | the new features; their UI text only through keys the contracts wrote or in the part's own namespace; the scanner fails for every file P1–P7 create (`config.json`, `failFor`) | each part's tests |
| S2 | lead, after P1–P7 merge | **records the baseline** of tests 9 and 10 on the merged build, running the tour twice and accepting it only when both runs are identical; fills and freezes `common` from the inventory (words used in three or more files: Cancel, Close, Save, Delete, …); generates `parts.json`; measures size and first-render again | — |
| S3a | X6 alone | formatter call sites to `fmt` (§10.5), merged before any other X part starts | tests 9, 10, 73 |
| S3b | X1–X5 and X7 in parallel, each branched from the merged S3a | extraction, file list by file list; X7 the CSS | tests 9 and 10 after every merge; test 69 |
| S4 | lead | turns the scanner from *report* to *fail* for the whole tree (`"scan": "fail"`) | test 61 on the whole tree |
| S5 | reviewers (§15) | Bangla drafted, reviewed and approved; the merge-group report; `npm run i18n:build`; the installer built and its size compared with S0's | tests 62, 65, 85 |

The baseline is recorded once, at S2, and changed only when a later feature changes the English UI
on purpose, with that change named in its commit. It is never re-recorded to make an extraction pass.

### 10.5 How the extraction is split

Parts own **files** (the sources they edit) and **namespaces** (the JSON files they add keys to). No
file and no namespace has two owners, so the parts merge without conflicts. Shared copy modules go to
the part whose screens use them. `common` is filled and frozen by the lead at S2; the X parts use it
and none adds to it.

| Part | Source files | Namespaces |
|---|---|---|
| X1 · Editor shell | `views/Editor.tsx` (its two `confirm` sites included), `App.tsx`, `Timeline*.tsx`, `Transport*.tsx`, `PreviewStage.tsx`, `CommandPalette.tsx`, the shortcuts editor, `src/shared/editor/commands.ts`, `shortcuts.ts`, `multiSelectCopy.ts` | `editor`, `timeline`, `commands`, `keys` |
| X2 · Panels | `editor/panels/*` for style, background, brand, zoom, cursor, magnifier, spotlight, camera, director, sound, music, voice, sound finder, shapes, texts, callouts, titles, graphics; `mixedControls.tsx`, `LayoutTrack.tsx`, `layoutCommands.ts` (the corner names, §9.5); `voiceCopy.ts`, `soundsCopy.ts`, `directorCopy.ts`; the number fields of `GraphicsPanel.tsx:536`, `ShapesPanel.tsx:421` and `mixedControls.tsx:195` move to `NumberField` | `style`, `zoom`, `camera`, `sound`, `text` |
| X3 · Captions and smart tools | captions panels (`CaptionsPanel.tsx`'s and `SpeakersSection.tsx`'s `confirm` sites included), Captions Studio controls, transcription, speech and AI-on-this-PC UI, wave 11's guide, chapters and short-clip UI; `speechCopy.ts` | `captions`, `smart` |
| X4 · Review and project tools | review mode, versions, Polish, notes (`NotesDialog.tsx`, `views/NotesWindow.tsx`), search, share, publish, import, duplicate; `review/copy.ts`, `polishCopy.ts`, `notesCopy.ts` | `review` |
| X5 · Export, settings, Home and main | `ExportDialog.tsx` (its Target size field to `NumberField`), `ExportBundleOptions.tsx`, `exportPresets.ts` labels, `exportPlan.ts` `ENCODER_NAMES`, `settings/*`, `Home.tsx` (not the recording panels it mounts; its two `confirm` sites and the recording-side reads of §9.5 included), `views/RegionPicker.tsx`, `views/CameraBubble.tsx`, `src/shared/updates/updates.ts` (`BUSY_COPY`), every `src/main` file that is ours (dialogs, notifications, taskbar, errors), `longJobs.ts`; the error codes of §9.6 | `home`, `export`, `settings`, `errors`, `main` |
| X6 · Shared helpers and formatting | the call sites of `formatClock`, `formatDuration`, `formatBytes`, `sizeText`, `clockTime`, `formatTick`, `formatLevel`, `formatRate`, `zoomText`, the two `lengthText`s and the 8 locale-less `toLocale*()` calls, moved to `fmt` (§11) | none: X6 adds no message |
| X7 · Right-to-left styles | every `*.css` file except `src/renderer/src/i18n/scripts.css` (P6's, imported once from `main.tsx`); `styles.css` is X7's alone | none |

The exact file lists are generated at S2 from the merged tree by `scripts/i18n/split.mjs` into
`scripts/i18n/parts.json`, with these rules, and the lead resolves any file two rules claim before S3
starts. X6 runs alone and merges first (S3a): at least 53 formatter calls sit inside prose templates
(`longJobs.ts:127`, `speechCopy.ts:308`, `OverlayTrack.tsx:142`, `LayoutTrack.tsx:208`,
`polishCopy.ts:196`, `soundsCopy.ts:57`, …), the very lines X1–X5 turn into `t()` calls, so the
others branch from X6's merged result instead of resolving those lines by hand.

### 10.6 The English guards (tests 9 and 10)

`tests/e2e/english-guard.e2e.cjs` drives a fixed tour of the app under xvfb with English and the
`ui` preference absent: Home (with and without projects), the editor on two fixture projects (one
16:9 with camera, captions, chapters and music; one 9:16), every panel tab, the timeline with a
selection, the command palette with an empty and a typed query, the shortcuts editor, Review mode,
Versions, Polish, the export dialog in every format and mode with Settings open, *Also save* all on,
the running and done views of a short export, Settings in every section, a notice, an error notice, a
confirmation question, and a native dialog title (through a test hook in main that records the
options of `dialog.showSaveDialog`, `dialog.showMessageBox`, `window.confirm` and notifications
instead of showing them). The recording windows are included; they must not change either. The tour
runs with an empty shipped list, so the Language section and the palette's *Language…* are absent, as
in an English install before any language ships.

**The tour is deterministic**, so a difference means the extraction changed something:

- **Clock**: `SSW_FIXED_NOW=2026-03-12T14:02:00Z` fixes `Date.now()` and `new Date()` in main before
  its modules load; every window gets Playwright 1.56's `clock.install` at the same time; the
  process runs with `TZ=UTC`. Home's dates (`Home.tsx:305,308,826`) and the update-check time
  (`useUpdates.ts:73`) are then the same on every run.
- **Data**: a fresh copy of a fixed `userData` (projects, preferences, speech settings, storage) for
  every run; network blocked; update checks answered by `SSW_UPDATES_FAKE` with a fixed "up to date".
- **Motion**: an injected stylesheet turns off animations, transitions and the caret
  (`caret-color: transparent`). Before each capture the tour waits for a settled signal from a test
  hook that counts pending loads: fonts, thumbnails, the filmstrip and waveforms.
- **Masks**: what changes by nature (the running view's fps and time left, the done view's seconds
  and bytes, Storage's sizes and free space, the version number) is listed as selectors in
  `tests/e2e/uiTour.cjs` and replaced by a placeholder in the baseline and in each run alike. No
  source file changes for it.
- At S2 the tour runs twice; the baseline is accepted only when both runs are identical.

- **Test 9, text and names**: for each screen, `document.title`, `body.innerText`, and for every
  element its `aria-label`, `title`, `placeholder`, `alt`, `aria-valuetext`, `aria-describedby` text,
  `role` and accessible name, plus the main-process strings recorded by the hook. Compared with the
  baseline **exactly**, string for string.
- **Test 10, layout**: for every element with text, its tag, box (rounded to 0.5 px), computed font
  family, size, weight, line height, colour, `direction` and `text-align`; and a screenshot of each
  screen compared pixel for pixel with the baseline, allowing 0.1% of pixels to differ by at most 2
  levels (font anti-aliasing under xvfb). Any box that moves fails. Logical keywords are compared
  through the element's computed `direction`: `text-align: start` and `end` map to `left` and `right`
  before comparing, because X7 turns `text-align: left` into `start`, which `getComputedStyle`
  reports as `start` although nothing moved; any other logical keyword the guard reads maps the same
  way.

Both run after every X part merges, by the lead under xvfb like the other e2e files, and before
each release.

---

## 11. Numbers, dates and digits per locale

### 11.1 `fmt` (`src/shared/i18n/fmt.ts`)

One module formats everything the UI shows. Every function takes the format locale set by
`setCatalogue` (§9.4) and **never** the runtime's default locale, which differs between main
(`bn-BD` on a Bangla Windows) and the renderer (`en-US`), measured.

```ts
export const fmt: {
  count(n: number): string                               // 1234 (en) · ১২৩৪ (bn)
  number(n: number, digits?: { min?: number; max?: number }): string
  percent(ratio: number): string                         // 0.5 → "50%" · "৫০%"
  bytes(n: number): string                               // formatBytes: "1.5 MB" · "১.৫ MB"
  duration(seconds: number): string                      // formatDuration: "2:05" / "1 h 2 min" as today
  clock(seconds: number, hours?: boolean): string        // formatTime/formatClock: "1:02.5" · "১:০২.৫"
  date(ms: number, style: 'day' | 'dayYear' | 'dayTime' | 'version'): string
  time(ms: number): string
  relative(ms: number, now: number): string              // "3 minutes ago" · "৩ মিনিট আগে"
  list(items: readonly string[], kind?: 'and' | 'or'): string
  inSentence(text: string): string                       // §9.6
  /** Reads a number typed or pasted in any digits Flown shows (0–9, ০–৯, ०–९); NaN otherwise. */
  parseNumber(text: string): number
}
```

- Units and codec names stay Latin in every language (`MB`, `fps`, `kbps`, `px`, `1080p`).
- The timecode on the timeline, the transport and Review mode uses `fmt.clock`: Bangla digits in the
  Bangla UI by default (§0 decision 9), Western digits by choice.
- Text that must stay ASCII never goes through `fmt`: YouTube chapter stamps (`formatTimestamp`,
  `chapters.ts:50`), file names, timecodes inside exported files, ffmpeg arguments, logs.
- **Number fields.** `NumberField` (P6, `src/renderer/src/i18n/NumberField.tsx`) takes the props of
  today's `<input type="number">` sites (`ExportDialog.tsx:914`, `GraphicsPanel.tsx:536`,
  `ShapesPanel.tsx:421`, `mixedControls.tsx:195`). In English it renders exactly that input, same
  attributes, so nothing changes. In other languages it renders a text field with
  `inputmode="decimal"` that shows `fmt` digits, reads typed and pasted digits of any script through
  `fmt.parseNumber`, keeps `min`, `max` and `step`, and steps with ArrowUp and ArrowDown. Chromium
  formats `type="number"` with the app's en-US locale and refuses ২৫ typed through Avro or Bijoy; a
  text field does neither. Every other numeric or time text field parses with `fmt.parseNumber`, never
  `Number()`.
- `Intl.DurationFormat`, `Intl.Locale.prototype.getTextInfo` and `Intl.ListFormat` are used through
  small local type declarations; the tsconfigs' `lib` stays `ES2022`.

### 11.2 The English profile

English keeps each call site's output byte for byte. `fmt` in English calls today's code, moved, not
rewritten:

| Today | English profile |
|---|---|
| `formatBytes` (`ExportDialog.tsx:233`), `sizeText` (`longJobs.ts:106`) | the same code: `toFixed(2)` GB, `toFixed(1)` MB, whole KB |
| `formatTime` (`project.ts:225`) at our call sites; `formatClock`, `clockTime`, `formatTick` | the same code, with ASCII digits |
| `formatDuration` (`ExportDialog.tsx:163`), the two `lengthText`s | the same code |
| the 8 calls with no locale (`Home.tsx:305,308,826`, `search/rows.ts:22`, `useUpdates.ts:73-74`, `StorageSection.tsx:17`, `FontPicker.tsx:173`) | the same options with `'en-US'` named, which is what they give today with only `en-US.pak` |
| `versionTime` (`versions.ts:382`) | `'en-GB'` as today ("12 Mar 14:02") |
| `notesCopy.ts:82`, `scriptDraft.ts:57,96` | `'en-US'` as today |
| `listPhrase` (`shortcuts.ts:271`) | the same code ("A, B and C") |
| interpolated numbers (`${n}`) | `String(n)` |

`formatTime` itself does not change (the recording side imports it). Test 8 runs every English
`fmt` function against the old helpers over grids of values (0, 0.4, 1, 59.99, 3,599.5, 1e9 bytes,
dates around midnight and new year) and requires equal strings.

### 11.3 Other languages

Other languages use `Intl` with the format locale, measured in Electron 44 (ICU 78.2, CLDR 48):

| | bn (Bangla digits) | bn-u-nu-latn (Western) | hi | es |
|---|---|---|---|---|
| 1234567.891 | ১২,৩৪,৫৬৭.৮৯১ | 12,34,567.891 | 12,34,567.891 | 1.234.567,891 |
| Date and time (CLDR medium) | ৭ নভে, ২০২৬, ২:০৫ PM | | 7 नव॰ 2026, 2:05 pm | 7 nov 2026, 14:05 |
| List of three | A, B এবং C | | | |
| 2 min 5 s (long) | ২ মিনিট, ৫ সেকেন্ড | | 2 मिनट और 5 सेकंड | |
| Relative | ৩ মিনিট আগে, গতকাল | | | |

Empty cells were not measured; P6's test 53 records them. Spanish (`es`) does not group four-digit
numbers (1234, but 12.345).

- **Bangla dates** do not use CLDR's medium form: abbreviated months ("নভে") are rare in Bangladeshi
  writing, and it puts a Latin "PM" inside Bangla text. The `bn` profile of `fmt.date` uses full month
  names ("৭ নভেম্বর ২০২৬"), and `fmt.time` uses either a Bangla day period (`dayPeriod: 'short'`,
  e.g. "বিকাল ২:০৫") or a 24-hour clock ("১৪:০৫"): the reviewers choose one before S5, and test 53
  records the choice.
- Indian grouping (১২,৩৪,৫৬৭) is CLDR's for `bn` and `hi`, which matches the Bangla style guides
  (10,00,000).
- **Digits are chosen per message, not per number.** The user's choice (§2.5) sets the format
  locale's `-u-nu-` tag (§9.4), so prose quantities follow it. Messages marked `digits: 'latn'`
  (§9.3) show every number in Latin digits, so a technical line such as the size line reads
  "1080×1350 · 30 fps · HEVC · 2:14" whole, never "1080×1350 · 30 fps · HEVC · ২:১৪". e2e step L15
  fails on any text node of the Bangla tour that holds both 0–9 and ০–৯ outside do-not-translate
  identifiers.
- Hindi defaults to Western digits (CLDR) with Devanagari digits (०–९) as the choice.
- Wave 11's cost line keeps "$" in English; other languages format the currency with the format
  locale (`bn`: "১২.৫০ US$").

---

## 12. Fonts and typography for each script

### 12.1 Fonts (0 new bytes)

Every font below is already bundled for captions (`resources/fonts/`, imported with Vite `?url` in
`catalogFonts.ts:32-33`). P6 registers the UI faces with `new FontFace(family, 'url(' + url + ')')`
from those same imports in `bootLanguage()`, so the build emits no new asset and the CSP does not
change. The face loads before the first render (bounded at 1 s, after which the fallback shows).

| Script (languages) | `--font-sans` under `:lang()` | Notes |
|---|---|---|
| Latin (en, es) | as today: `'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', system-ui, …` | unchanged |
| Bengali (bn) | `'Segoe UI Variable Text', 'Segoe UI', 'Flown UI Bengali', 'Nirmala UI', sans-serif` | Flown UI Bengali = Noto Sans Bengali, variable 100–900 (249,868 B). Latin words keep Segoe UI. Its Bangla digits are all 0.59 em wide, so timecodes do not jitter; Hind Siliguri's are 0.49–0.69 em and is not used. Nirmala UI has three weights only, so the 74 uses of weight 600 would be synthesised |
| Devanagari (hi) | `…, 'Flown UI Devanagari', 'Nirmala UI', sans-serif` | Noto Sans Devanagari (272,320 B), tabular digits 0.52 em |
| Arabic (later) | `…, 'Flown UI Arabic', 'Segoe UI', sans-serif` | Noto Sans Arabic (368,624 B) |
| Hebrew (later) | `…, 'Flown UI Hebrew', 'Segoe UI', sans-serif` | Noto Sans Hebrew (61,856 B) |

`--font-mono` (timecodes) keeps Cascadia Mono first. Cascadia has no Bangla or Devanagari digits, and
a face registered with `FontFace` is used only where its family is named, so `scripts.css` also sets
`--font-mono: 'Cascadia Mono', 'Flown UI Bengali', 'Cascadia Code', Consolas, ui-monospace,
monospace` under `:lang(bn)` and the same with `'Flown UI Devanagari'` under `:lang(hi)`. Without it
the digits would fall back to whatever system font has them (Nirmala UI on Windows, another under
xvfb). e2e L4 checks the timecode's resolved font and that the ten digits have one width.

### 12.2 Line height and size

Bangla and Devanagari marks above and below the letters need room. Measured with Noto Sans Bengali at
100 px: with `line-height: 1` the top marks are clipped by 0.145 em (chandrabindu and reph, screenshot
`i18n/probe3/shot3.png`), at 1.25 by 0.02 em, at 1.45 not at all. Conjuncts at 12–13 px are also
small. So `src/renderer/src/i18n/scripts.css` (P6's, imported once from `main.tsx`; `styles.css` is
not edited by P6) holds one block, which changes nothing in English:

```css
:root:lang(bn), :root:lang(hi) {
  --leading-tight: 1.4;
  --leading-normal: 1.6;
  --text-2xs: 11.5px;   /* 10.5 in English */
  --text-xs: 12px;      /* 11 */
  --text-sm: 13px;      /* 12 */
  --text-md: 14px;      /* 13: the body */
  --text-lg: 16px;      /* 15 */
  --tracking-caps: 0;
}
```

The type scale moves up one step as a set (`styles.css:98-102`), so its steps keep their order
instead of three sizes collapsing into 12 px. `scripts.css` also overrides, under
`:lang(bn)`/`:lang(hi)`, the three `line-height: 1` rules (`titles.css:44`, `editor.css:845`,
`commands.css:20`) and the fixed pixel line heights of 10–18 px, each raised to at least 1.4 times its
font size. Letter spacing is 0 in these scripts (spacing pulls conjuncts apart); `text-transform:
uppercase` has no effect on them and stays. The `bn-XA` tour (§12.3) checks that the larger set fits;
the Bangla reviewers sign off its readability on a real screen at 100% Windows scaling before S5.

### 12.3 Longer and taller text

Translations run longer than English (Microsoft's planning figure is +40%, and short strings can
double), and Bangla's real risk is height: taller lines inside fixed-height chips, tabs, timeline
track headers, toolbar buttons and the export dialog's chip rows.

- `en-XA` (§16.3) adds 40% and brackets to every message in development.
- `bn-XA` writes every message in Bengali letters with reph, chandrabindu, below-base forms and
  conjuncts, about 30% longer, in Noto Sans Bengali at the Bangla sizes above.
- The guard tour runs under each, and e2e L4 and L9 fail any element whose text overflows its box in
  either direction (`scrollWidth > clientWidth` or `scrollHeight > clientHeight`), fixed-height
  controls included. The same run with the real catalogue is repeated before release, and its
  screenshots go to the reviewers (§15.4).
- Fixed-width controls that cannot grow get a `maxLength` in their meta entry, which the checker
  enforces per language.

### 12.4 Contrast

Colours do not change in any language. Larger Bangla text keeps or improves contrast; every text
colour token already meets WCAG AA on its surfaces (`styles.css:23`).

---

## 13. Right-to-left readiness

No right-to-left language ships in this wave (§0 decision 5). The app is made ready so Arabic and
Hebrew can follow with a review of their own.

### 13.1 Logical properties (part X7)

The 55 CSS files (12,484 lines) have no logical properties and about 200 physical left/right sites
(`left` 54, `text-align` 25, `inset` 25, `margin-left` 24, `right` 21, `padding-left` 17,
`translateX` 12, `border-left` 10, `margin-right` 9, …). X7 converts them: `margin-left` →
`margin-inline-start`, `left` → `inset-inline-start`, `text-align: left` → `start`, and so on
(Chromium supports these since version 87; Electron 44 is Chromium 152). In a left-to-right page
each computes to the same box, so the English guards (tests 9 and 10) prove nothing moved; test 10
compares alignment after mapping `start` and `end` through the computed direction (§10.6).

What stays physical, on purpose:

- the timeline, its ruler, waveform, playhead, clips and markers; the transport; the preview and its
  handles; sliders for time; the 63 inline `left:`/`right:` positions in TSX, which place things on
  the time axis. Their containers get `direction: ltr` in CSS (X7), so they stay left to right in a
  right-to-left page. Material's guidance for media controls says they show "the direction of the
  tape, not the direction of time"; guidelines differ for progress bars (Apple flips them, Mozilla
  mirrors them), and a Moodle bug (MDL-61020) treated a mirrored video timeline as a bug and fixed it;
- `translateX` used for animation of things on the time axis.

### 13.2 Direction of the page

`bootLanguage()` sets `<html dir>` from `new Intl.Locale(lang).getTextInfo().direction` (`'rtl'` for
ar, he, ur). Icons that point in reading direction (back, forward, chevrons of disclosure, the
"next" arrows) mirror with `:dir(rtl)` (`transform: scaleX(-1)`); icons of real objects (play, the
cursor, the camera) do not. Arrow keys follow the visual direction everywhere except on the timeline,
where → always moves later in time.

### 13.3 Mixed direction text

User text (project names, chapter titles, file names, preset names, caption text in lists) can be in
any script inside a sentence of another. Without isolation an Arabic project name pulls a following
number into its run (screenshot `i18n/probe2`).

- In the page, `<T>` wraps placeholders marked `user` in the meta file in `<bdi>`.
- In plain strings (`aria-label`, `title`, notifications, dialog titles, the window title) `t()` wraps
  the same placeholders in U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE;
  intl-messageformat adds none by itself (tested).
- In a right-to-left UI, keycaps, timecodes, sizes and paths are isolated as left to right
  (U+2066 … U+2069).
- Copying text to the clipboard strips the isolate characters.
- **English does not isolate** (§0 decision 12): `<T>` and `t()` add no element and no character when
  the UI language is English, so the English UI stays byte for byte as it is. Turning isolation on in
  English, where it would help Arabic project names, is listed for later (§24).

### 13.4 Checking it

The `ar-XB` pseudo-locale (development only: every message reversed and wrapped in right-to-left
marks, `dir="rtl"`) is run through the guard tour. The e2e step L10 checks that panels mirror (the
inspector's labels start on the right), that the timeline and preview keep their direction (the
playhead moves right as time passes), and that nothing overlaps.

---

## 14. Keyboard shortcuts and screen readers

### 14.1 Keycaps stay as they are

Shortcut labels keep their keycaps in Latin script in every language: "Ctrl", "Shift", "Alt", "Esc",
"Page Up", "←", the letter keys and " + " between them (`shortcutKeys`, `shortcutLabel`,
`shortcuts.ts:236-245`, unchanged). Microsoft's Bangla (India) style guide §5.4.3: "Names of keys
appearing on keyboard should not be translated." Sentences around them become messages with a
`{keys}` placeholder:

| Helper | English (unchanged) | Message |
|---|---|---|
| `withShortcut` | "Split the clip at the playhead (S)" | `keys.withShortcut`: `{text} ({keys})` |
| `orPress` | "Double-click to add text, or press T" | `keys.orPress`: `{text}, or press {keys}` |
| `reviewHint` | ". Review (Shift + R)" / ". Review mode lists them" | `keys.reviewHint`, `keys.reviewHintNoKey` |
| `undoHint` | " · Ctrl + Z to undo" | `keys.undoHint`: ` · {keys} to undo` |
| `zoomLevelKeysHint` | "1–4 set its zoom level, 0 pulls back" | `keys.zoomLevels.*` with `{count, plural, …}` for "set"/"sets" |
| `listPhrase` | "A, B and C" | `fmt.list` (§11.2) |

Matching shortcuts already works with Bangla and Hindi keyboard layouts: `eventKeyName`
(`shortcuts.ts:302-317`) maps a letter of another alphabet to its Latin key through `e.code`.

### 14.2 `aria-keyshortcuts`

Many buttons already carry their shortcut in their tooltip (`withShortcut`: `title="Pause (Space)"`
with `aria-label="Pause"`), and Chromium exposes that title as the accessible description. Adding
`aria-keyshortcuts` there could make NVDA say the shortcut twice ("Pause, button, Pause (Space),
Space"). So `aria-keyshortcuts` (the shortcut in its fixed syntax, `Control+Shift+Z`, `Shift+R`,
built by `ariaKeys(accelerators)` in `shortcuts.ts`, never translated) is added only to controls and
menu items whose tooltip does not already name the shortcut, such as command-palette rows and menu
items. Names and tooltips do not change (§0 decision 12). X1 adds it after its extraction, as a
separate commit, only after the NVDA check of §0 decision 14 has listened to both cases; it is outside
what test 9 compares.

### 14.3 Screen readers

- `<html lang>` is the bare language (`bn`, not `bn-BD`): NVDA with Chrome reads a region subtag that
  has no matching voice in English (PowerMapper's tests with NVDA 2025.3).
- NVDA's bundled eSpeak NG has a Bangla voice; Windows Narrator's voice list has no Bangla one today.
  Settings › Language says, without naming another company's product (§2.5): "To hear Flown in
  Bangla, use a screen reader with a Bangla voice, such as NVDA."
- Every accessible name, description, live-region message and role description is a message and is
  translated with the visible text; the guard tour (test 9) lists them, so none is missed.
- English parts left inside a translated page (the recording panels and the recording side's
  messages, §9.5) carry `lang="en"` so the reader switches voice.
- Live regions (`aria-live`, 109 regions) announce the translated text; announcements are built as
  whole messages, never by joining fragments, so the reader does not pause mid-sentence.

---

## 15. Translations: drafted by an AI service, approved by people

### 15.1 Who, and with what rights

Per language, two native speakers (§0 decision 6):

- a **translator-reviewer**, who corrects the draft in context and marks each string *reviewed*;
- an **approver**, who reads each reviewed string on its screen and marks it *approved*, or sends it
  back with a note.

Their corrections and approvals are their own work. Before a person's first string is accepted, they
sign a short contributor licence or an assignment to Qbexel, or work under a contract that assigns
the work, so Qbexel may ship, change and relicense the text in a commercial app. The owner records
each person in `translations/reviewers.json` (`id`, name, languages, kind of agreement, date signed);
the checks refuse a `reviewedBy` or `approvedBy` that is not listed for that language (§16.2).

For Bangla: the owner and one more person, both writing Bangladesh's standard Bangla. For Spanish and
Hindi: two people each, found by the owner. One person never approves a string they reviewed, and
the built catalogue counts only strings where both people are recorded and differ (§15.6).

### 15.2 Glossary first

Before any draft, the two reviewers agree a glossary in `translations/glossary.csv` (term, part of
speech, note, do-not-translate, then `bn`, `es`, `hi`): about 200–300 terms (export, clip, cut,
timeline, playhead, zoom, caption, chapter, preset, stem, render, track, project, recording, undo,
the panel names, the command categories). The do-not-translate list holds the brand, codec, format,
editor and unit names of §9.7.

Sources for Bangla:

- **Spelling**: Bangla Academy's প্রমিত বাংলা বানানের নিয়ম (ইংরেজি, সরকারি, ক্যামেরা).
- **UI conventions**: Microsoft's Bangla (Bangladesh) style guide: address the user as আপনি; no
  Sadhu bhasha; keep brand names; the dari `।` ends sentences; Indian grouping 10,00,000; dates day,
  month, year; the week starts on Sunday. Microsoft's Bangla (India) guide is used only for its rule
  on key names (§14.1).
- **Words**: the word a Bangladeshi YouTuber or teacher uses for the tool, and the English loanword in
  Bangla script when that is the common one: এক্সপোর্ট (not রপ্তানি), আনডু (not পূর্বাবস্থায়
  ফেরান), কপি (not অনুলিপি), ক্লিপ, জুম. Formal coinages read as unfamiliar to the creators Flown
  is for.
- **Tried on people**: before any draft, the 30 most visible terms (the main buttons, panel names,
  Export, Undo, Captions, Zoom, …) are shown to five target users (creators and teachers in
  Bangladesh), and the glossary records what they understood and preferred.

Each choice is made once, in the glossary.

### 15.3 Drafts, at development time only

`node scripts/i18n/draft.mjs --lang bn --ns <ns>` is run by a person on their own PC with their own key
for an AI service they choose. It is not part of the app, never ships, and the app never calls it.

- **Before it is used**, the chosen service's terms must allow commercial use of its output.
  `translations/README.md` names the service used for each language, and each entry records it
  (`draftedWith`).
- It sends only: the English messages of one namespace, each message's description, placeholders,
  the plural categories the language needs, `maxLength`, the glossary rows, and the guard tour's
  screenshot of the message's screen (§10.6; fixture projects only, never a user's data).
- It asks for ICU output with the placeholders unchanged, for `bn` and `hi` plurals with only `other`
  (§9.3), and for `.whole` sentences in the language's own word order. It writes
  `translations/bn/<ns>.json` with `state: 'draft'` and the English `sourceHash`.
- Its output goes straight through the catalogue checks (§16.2); a draft that fails them is marked
  `state: 'draft'` with the check's message as its note, never dropped silently.
- An optional second pass asks the service to score each draft for errors (in the style of GEMBA-MQM);
  the score only sorts the reviewers' list, it approves nothing.

### 15.4 Review in context

- **The review pack.** `npm run i18n:pack -- --lang bn` runs the guard tour (§10.6) under the draft
  catalogue and saves one screenshot per screen with each string's key drawn beside its text, plus
  the `bn-XA` overflow screenshots (§12.3), as a folder with one HTML page. A reviewer who is not a
  developer opens that page; nothing has to be installed or built.
- **The sheet.** `npm run i18n:sheet -- export --lang bn` writes `translations/bn/review.csv` with a
  UTF-8 byte-order mark, so Excel on Windows reads Bangla correctly (without it, Excel reads UTF-8 as
  ANSI). Columns: key, English, description, screen (a link to the pack's picture), draft, final,
  state, reviewer, approver, note. A cell that starts with `=`, `+`, `-` or `@` ("-3 dB") gets a
  leading apostrophe, removed again on import, so no cell is ever a formula. `translations/README.md`
  tells reviewers to save with Excel's "CSV UTF-8".
- **Import refuses damage**: `… import` refuses a file that is not valid UTF-8 or holds U+FFFD, and any
  row whose `bn` or `hi` text has a run of `?`, has no letter of the language's script where the
  English has letters, or starts with `#` or a formula's remains. Then it checks every row (§16.2),
  records the reviewer or the approver and the date, and refuses to record one person as both.
  Git keeps the history. A self-hosted Weblate can read the same JSON files later; nothing needs it
  now.
- **The review build.** For developers: `FLOWN_I18N_REVIEW=1 npm run dev -- --lang bn` (never in a
  packaged build: `app.isPackaged` turns it off) shows a small overlay: hovering any text shows its
  key and state, and Ctrl+Alt+K copies the key. Strings still in draft are shown with a dotted
  underline.
- **Order**: the core namespaces first (§9.2), the recording namespace with them once the other
  account agrees, then the rest by how often their screens open.

### 15.5 Effort

The UI is 22,000–25,000 English words before wave 11 (§10.1); about 10,000–12,000 are on the core
surfaces. Post-editing a good draft runs at about 3,500–5,000 words a day against 2,000–3,000 for
translating from nothing, and Mozilla's pre-translation trial had 65.1% of drafts approved unchanged
and 94.6% usable. That puts the core surfaces at **3 to 6 reviewer-days per language**, the rest at
about as much again, and the approver's pass at about a third of that.

### 15.6 What ships

- `npm run i18n:build` writes the built catalogues (§9.2) from strings that are `approved`, whose
  `sourceHash` matches today's English, and whose `reviewedBy` and `approvedBy` are both set, differ,
  and are both listed in `reviewers.json` for that language. Everything else falls back to English,
  string by string.
- A language appears in the picker when 95% of all its keys and 100% of the core namespaces
  (`.whole` messages included) are approved and current. `src/shared/i18n/built/shipped.json` lists
  those languages, each with `preview: true` while its `recording` namespace is not approved (§0
  decision 11); Settings and the Home offer read it.
- When an English message changes, its translations become stale: they leave the built catalogue at
  the next build, and the sheet lists them first.
- Each release's notes say which languages ship, how complete each is, and, for a preview, which
  parts stay English.

---

## 16. Checks: every string has a key

### 16.1 The scanner (`scripts/i18n/scan.mjs`)

Built on the TypeScript compiler API (5.9.3, already a devDependency; the repository has no ESLint).
It walks `src/` and reports:

- JSX text with a letter in it;
- the attributes `aria-label`, `title`, `placeholder`, `alt`, `aria-valuetext`, `aria-roledescription`
  and `label` with a literal or template value;
- string literals and templates passed to UI sinks: `showNotice`, `setStatus`, `t`-less
  `new Error(...)` in files that reach the UI, `dialog.show*Dialog` options, `new Notification`,
  `setThumbarButtons` tooltips, and `confirm`, `window.confirm`, `alert` and any function passed as a
  `confirm:` property (§9.6);
- `t()` or `<T>` evaluated at module scope (`module-scope-t`, §9.1);
- `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` and `new Intl.*(…)` with no locale or
  `undefined` in UI code, except `Intl.Segmenter` (§9.7);
- `t('…')` with a key that does not exist in English.

Exceptions live in `scripts/i18n/allow.json`, each with a reason (font stacks, ids, ffmpeg arguments,
CSS values, AI prompts in `src/main/ai/*`, log lines, test ids, the development-only review overlay).
The other account's files are listed in `scripts/i18n/pending.json` and reported as pending, never as
failures (§9.5). Every file that parts P1–P7 create is listed in `config.json`'s `failFor` from S0, so
new code is held to the rule from its first commit, before S4 turns the rule on for the whole tree.

### 16.2 The catalogue checks (`scripts/i18n/check.mjs`)

For English: every key used exists, no key is unused, every message parses
(`@formatjs/icu-messageformat-parser` 3.5.22, a devDependency), every message is NFC, every meta entry
exists, and every `merge: true` group has a `.whole` message.

For each translation:

- it parses; its placeholder names equal English's; its rich tags equal English's;
- each plural lists `other` and only categories of `new Intl.PluralRules(lang)`; in `bn` and `hi`, a
  `one` branch holding a number word or a digit (এক, একটি, ১, एक, १) instead of `{n}` is refused
  (§9.3);
- no `#` and no `{x, number}` (§9.3); no `'{`, `'}` or `'#`;
- every do-not-translate term of the English message is present unchanged;
- NFC; no bidi control characters; ZWJ and ZWNJ allowed; no HTML, no `<` outside the four rich tags;
- in a message marked `digits: 'latn'`, no native digits;
- the length is within `maxLength`, counted in graphemes (`Intl.Segmenter`);
- the blank lines of the English message are kept (`splitError`, §9.6);
- in `bn` and `hi`, no run of Latin letters other than do-not-translate terms and placeholders, and no
  run of `?`;
- a `reviewed` or `approved` state names a person listed in `translations/reviewers.json` for that
  language; `approvedBy` differs from `reviewedBy`;
- `sourceHash` is current, or the string is reported stale.

`--check` mode of `i18n:build` fails when the committed built catalogues differ from what the
translation files give. The build also reports the merge groups per namespace (§9.3).

Test 86 checks the bundles: the import graph from `src/main/index.ts` (resolved with the compiler's
`ts.resolveModuleName`) uses only `common`, `errors` and `main` keys; the preload imports nothing from
`src/shared/i18n`; no file under `src/` imports a `.meta.json`.

### 16.3 Pseudo-locales (development only)

- `en-XA`: accented letters, brackets and +40% length (`[Ēẋƥōŕţ ţĥĕ ṽĩďēō ·····]`), to find text
  that was missed (anything still plain ASCII in the guard tour) and text that is cut off (§12.3).
- `bn-XA`: every message's letters replaced by Bengali syllables with reph (র্ক), chandrabindu (ঁ),
  below-base forms (ক্র, ু, ৃ) and conjuncts, about +30% longer, placeholders kept, to find text that
  does not fit in height or width at the Bangla sizes (§12.3) before any translation exists.
- `ar-XB`: reversed text with right-to-left marks and `dir="rtl"` (§13.4).

Generated by `npm run i18n:pseudo` into a gitignored folder; selectable only with
`FLOWN_I18N_PSEUDO=en-XA` (or `bn-XA`, `ar-XB`) in an unpackaged build.

### 16.4 Where the checks run

- **Vitest**: tests 61–68, 85 and 86 run with every `npm test`.
- **CI**: a new workflow `.github/workflows/checks.yml` on every push and pull request, on Ubuntu,
  with `permissions: contents: read` at workflow level. `actions/checkout` and `actions/setup-node`
  are pinned by full commit SHA, and checkout runs with `persist-credentials: false`. It installs
  with `npm ci --ignore-scripts`: typecheck, the i18n checks and their vitest files need neither
  Electron's binary nor ffmpeg-static's download, so no install script runs and nothing is fetched
  beyond the npm packages. Then `npm run typecheck`, `npm run i18n:check` (scanner, catalogue checks,
  built-catalogue check) and the i18n vitest files. No secrets; it publishes nothing.
- **Release**: `scripts/predist.mjs` runs `npm run i18n:check` as a new step 5, so an installer
  cannot be built with a string that has no key or a catalogue that does not match its sources.
  `verify-dist` fails when the packaged `src/shared/i18n/built/` files grow by more than 1 MB over
  the previous release.

Until step S4 (§10.4) the scanner's findings outside `failFor` are a report; after S4 they fail every
check above.

---

## 17. Accessibility

- **Every new control** is a native button, radio, checkbox, select or text field with a visible label
  (§2.8). The Codec, Background and Frame rate rows are `Choice` groups like the rows today: one tab
  stop, arrow keys move, Space and Enter pick.
- **Disabled chips say why** in visible text under the row, because a disabled button's tooltip is
  not announced and cannot be focused.
- **Preset menus** open with Enter, Space or Shift+F10, are `role="menu"` with `menuitem`s, close
  with Escape and return focus to their button. Rename and delete happen inline with focus moved
  into the field or the confirmation.
- **Progress**: the stem, timeline and copy steps are announced through the running view's existing
  `aria-live` status; the done view's file list is a list with one link per file.
- **The checkerboard** behind a transparent preview is decoration: the preview's accessible name
  says "Preview of a transparent video".
- **Language**: `<html lang>` follows the UI language; English parts inside a translated page carry
  `lang="en"`; NVDA reads Bangla (§14.3); the restart notice and its busy reason are `role="status"`;
  the Language section's heading and label carry the English word in other languages (§2.5).
- **Confirmations** in a translated UI are Flown's own dialogs with buttons named after the action
  (§9.6); in English they are today's.
- **Number fields** accept the digits the UI shows and the user types, in any script (§11.1).
- **Contrast**: no colour changes. New rows use `--text`/`--muted` on `--surface-1` and `--surface-2`,
  which meet WCAG AA (`styles.css:23`).
- **Keyboard shortcuts** keep working in every keyboard layout (§14.1); `aria-keyshortcuts` tells
  screen-reader users which key does what (§14.2).
- **Bangla text** has room above and below (§12.2), so marks are never cut off at any zoom.

---

## 18. Security

### 18.1 Translations never travel

- Catalogues are JSON inside `app.asar`, loaded from the bundle; they change only with an app update,
  which is signed like every update.
- The app makes no network request for anything in this wave. No code path in the app fetches,
  sends or checks a translation; the drafting script (§15.3) lives in `scripts/`, which is not in the
  app's files. Test 60 runs a translated session with every request logged and finds none to the
  network.
- Messages are rendered as text (React escapes them, `t()` returns strings). Rich text comes only
  from the four tags of `RichTag`, mapped by the caller to its own elements; a message cannot make
  a link, an attribute or a script.

### 18.2 Preset files are untrusted

A `.flownpreset` file may come from anyone. Main reads it (`openPresetFile`), never the renderer:

- at most 64 KB (larger files are refused unread past the limit, and the dialog says the file is too
  large); UTF-8; JSON; `flown` must be `"export-presets"` and `version` must be `1`;
- at most 50 presets; each `name` through `cleanPresetName` (NFC, trimmed, 1–60 graphemes; Cc
  characters, bidi controls, private-use characters and path separators removed; ZWJ and ZWNJ kept);
  `options` through `normalizeOptions` (only known keys and values: formats, codecs, rates, sizes; a
  codec the policy forbids becomes its nearest allowed one and is counted in `changed`); `bundle`
  through `normalizeBundle`; every other field dropped;
- a preset holds no path, URL, file name or command. Output paths come only from the save dialog, as
  today; batch file names go through `safeFileName`.

Main also writes preset files itself. `savePresetFile(defaultName, presets)` takes presets, not text:
main serialises them with `presetFileText`, reads the result back through `readPresetFile` and refuses
to write anything that does not read back the same or exceeds 64 KB, and the save dialog's name always
ends in `.flownpreset`. A renderer cannot use the call to write arbitrary text to a path the user
types.

The same reader sanitises the `exportPresets` preference (`prefsIpc.ts`), so a hand-edited
`editor-prefs.json` is held to the same rules. Test 5 feeds both readers hostile input (deep nesting,
200 presets, 10 MB names, `__proto__` keys, wrong types, bidi controls, য় in both of its encodings).

### 18.3 Files written

- Stems and timelines are written only next to the path the user chose in this session's save dialog
  (`approvedPaths`), with names main derives; existing files are never replaced (" (2)"); every file
  is written to a temporary name and renamed.
- The recordings mode copies media out of the project folder and never opens a project file for
  writing (`projectCopy.ts:9`'s rule).
- `TimelineRequest.plan` comes from the renderer, so main checks it before writing anything
  (`checkTimelinePlan`, `src/shared/interchange/planCheck.ts`, frozen with test 44): every frame
  number a finite integer ≥ 0; `recIn < recOut` and `srcIn ≤ srcOut` on every event; events in order
  without overlap on each track; at most 20,000 events and 1,000 markers; names at most 500
  characters; rates in `[24, 25, 30, 60]`; sizes within `MAX_EXPORT_SIDE`. A plan that fails gives a
  `problem` and no file.
- Timeline files escape every name for XML, drop the characters XML 1.0 forbids, write newlines in
  attributes as `&#10;` and percent-encode every path (§8.6); a project or chapter name cannot break
  out of its attribute or make the file unreadable.

### 18.4 ffmpeg arguments

Codec arguments are built from fixed tables (§5.4) and numbers checked by `validateJob`; no user text
reaches them except paths, as today. The BWF `description` of a stem is a fixed English word.

### 18.5 The language preference

`ui` is read by `readUiPrefs`: `language` must be `'system'` or a `UiLanguage`, `digits` `'native'` or
`'western'`, `offered` and `seen` arrays of at most 8 `UiLanguage`s; anything else is absent. A
language without a built catalogue falls back to English. `ui:confirm` shows only the message and the
two labels the renderer gives, in a dialog owned by the window that asked; it returns a boolean.

---

## 19. Performance and size

### 19.1 Export speed

Measured on 4 vCPU (§5.4), 1080p60 screen content, software encoders; GPU encoders were not available:

| Codec | Encoder | Frames a second | Size against today's H.264 Studio |
|---|---|---|---|
| H.264 (today) | x264 veryfast | about 83 (600 frames in 7.2 s) | 100% |
| AV1 | libaom good, cpu-used 6 | about 13 | 43% |
| AV1 | libaom realtime, cpu-used 8 | about 55 | 78% (not offered) |
| VP9 with alpha | libvpx realtime | about 42 | — |
| CineForm | cfhd | about 73–77 | 115× |
| Animation | qtrle | about 63 | lossless |

These include about 6.5 s of decoding the test master. Drawing and readback come on top, as today.
With a GPU, HEVC and AV1 run on the graphics card at H.264's speed or close to it (§0 decision 14
measures it).

### 19.2 Transparency and 120 fps

- A transparent frame sends 4 bytes a pixel instead of 1.5: 8.3 MB per 1080p frame. The `VideoFrame`
  readback stays on the GPU path as today; the unpremultiply is one pass over the frame in the
  renderer. Expect a transparent export to take 1.5 to 2 times as long as an opaque one through the
  raw route; P2 measures it on the reference clip, with both readbacks (§6.3), and the dialog's hint
  gives the measured factor.
- 120 fps draws twice the frames. Motion blur takes 5 sub-frames at 120 fps instead of 10
  (`blurSamplesFor`, §5.6), so the drawing cost per second of video is about twice 60 fps, not four
  times.

### 19.3 Stems and timelines

The stem graph decodes the inputs once and writes all stems in one ffmpeg run. Budgets, measured by
P3 and P4: under 2 s for the 30 s e2e project and under 60 s for a 10-minute project with four stems;
a timeline file for 3,000 cuts under 2 MB, written in under 100 ms. The recordings mode's copying is
bound by the disk.

### 19.4 Start-up, memory and bundles

- English: no catalogue to load; `t()` on the registered English messages; one more IPC call before
  the first render (about 1 ms); the view loads through one dynamic import (§9.4).
- Bangla: the catalogue chunk (about 450 KB of JSON) and the UI font (249,868 B, read from the bundle)
  load before the first render; P6's budget for both is 50 ms. Messages are parsed on first use
  (about 15 µs each: 59 ms for 4,000, measured) and cached; the cache holds only messages that were
  shown.
- Main carries only the `common`, `errors` and `main` English namespaces and Bangla's 30 KB `main`
  catalogue; the preload carries no catalogue (§9.1, test 86).
- Measured at S0 and again at S2 on the reference clip project, with these budgets: the renderer's
  JavaScript at most 250 KB larger (the English strings move from code into JSON, with keys added);
  the main window's first render at most 30 ms later; the recording bar's first render at most 20 ms
  later. A part that exceeds a budget reports it before merging.

### 19.5 Installer

| Item | Installer growth |
|---|---|
| Every codec, stem and timeline feature | 0 bytes: all encoders are in the shipped `ffmpeg.exe` (§5.1) |
| `intl-messageformat` and its parts | about 10 KB |
| English catalogue (keys added to strings that ship today) | about 30–40 KB |
| Bangla catalogue (renderer and main) | about 100 KB (about 480 KB of JSON; Bangla text compresses about 4.8× with the installer's xz) |
| Hindi catalogue | about the same as Bangla |
| Spanish catalogue | about 45 KB |
| UI fonts | 0 bytes (already bundled for captions) |
| Chromium locale packs | 0 bytes (they stay out) |
| **Total** | **about 0.3–0.4 MB**, waves 10 and 11's texts included |

Nothing in this wave comes near the 5 MB line. At S5 the lead builds the installer and records the
real difference against S0's; `verify-dist` fails if the catalogues grow by more than 1 MB (§16.4).
The installer itself stays as it is: its own pages follow the Windows language among
electron-builder's 26 bundled languages (Spanish and Arabic included). NSIS has no Bengali language
file, so the installer stays English for Bangla users, and Flown switches after its first start when
they choose.

---

## 20. Undo

This wave adds no project edit: codecs, transparency, frame rates, 4:5, stems and timelines are
export settings, and the language is an app preference. So it adds no undo step, and every edit
keeps exactly one step as before.

- Saving, renaming, updating and deleting a user preset change a preference, not the project; Delete
  asks first ("Delete “{name}”?"), and an imported preset can be deleted again.
- Changing the language takes effect at restart and can be changed back the same way.
- Extraction changes no edit's behaviour; the undo labels (`undoHint`, history entries) are messages
  whose English is unchanged.

---

## 21. Files, exported signatures and builder parts

### 21.0 Contracts step (first; frozen afterwards)

Made by the lead on `rev/wave12-design` after wave 10 (`feat/wave10`) and wave 11 (`feat/wave11`, all
six parts) have merged, before any part starts. Changed later only with every part's agreement,
recorded here. The contracts complete every seam two parts would share: each existing file below is
completed here, calls only functions that live in one part's new files, and is not edited by any part
afterwards unless §21.9 names that part as its owner.

- **Guards first**, against the merged code before any other change, in
  `tests/outputEquivalence.test.ts`: test 1 (projects), test 2 (stored export settings), test 3
  (ffmpeg arguments and soundtrack graphs), test 4 (`drawFrame` call logs). Then
  `tests/e2e/english-guard.e2e.cjs` and its tour `tests/e2e/uiTour.cjs` (tests 9 and 10) with the
  deterministic set-up of §10.6 (`SSW_FIXED_NOW`, the fixed `userData`, the motion stylesheet, the
  settled signal, the masks) and no baseline; the baseline is recorded at S2 (§10.4). Then the
  measurements of §19.4.
- **Types**: `src/shared/types.ts` (§4.1); `src/shared/api/export.ts` (§4.2, plus
  `ExportFinish.stems?: { stem: SoundStem; path: string; bytes: number }[]` and
  `ExportFinish.stemsProblem?: string`; `ExportRoute`'s WebCodecs codec gains `'hevc' | 'av1'` in
  `exportPlan.ts`); `ExportPreset.codec?`, `ExportPreset.alpha?` and the three new `PresetIcon`s
  (`exportPresets.ts`); `src/shared/api/prefs.ts` (`PrefKey` gains `'exportPresets' | 'ui'`, with
  `PREF_KEYS`); `src/shared/api/ui.ts` (new, below); `RenderScene.alpha` (`compositor.ts`, the field
  only).

  ```ts
  // src/shared/api/ui.ts
  export type UiLanguage = 'en' | 'bn' | 'es' | 'hi'
  export interface UiPrefs { language?: 'system' | UiLanguage; digits?: 'native' | 'western'; offered?: UiLanguage[]; seen?: UiLanguage[] }
  export interface UiInfo {
    language: UiLanguage
    formatLocale: string
    dir: 'ltr' | 'rtl'
    digits: 'native' | 'western'
    /** The language "Follow Windows" gives now. */
    system: UiLanguage
    /** A shipped language Home may offer once (§2.7), or null. */
    offer: UiLanguage | null
    shipped: UiLanguage[]
    /** Shipped languages shown as a preview (§0 decision 11). */
    preview: UiLanguage[]
    prefs: UiPrefs
    /** The project to open after a relaunch from the editor; given once. */
    reopen: string | null
  }
  export type RelaunchResult = { ok: true } | { ok: false; reason: string }
  export interface UiApi {
    uiInfo(): Promise<UiInfo>
    setUiPrefs(prefs: UiPrefs): Promise<void>
    /** Relaunches unless work would be lost (§9.4); the editor saves first and its project reopens. */
    relaunch(reopenProjectId?: string): Promise<RelaunchResult>
    /** Records that the user works in `language` (a project with captions or a transcript in it was opened). */
    noteLanguageSeen(language: UiLanguage): Promise<void>
    /** A confirmation in the UI language, its buttons named by the caller (§9.6); true when the action was chosen. */
    confirm(request: { message: string; action: string; cancel: string }): Promise<boolean>
  }
  ```
- **Readers and tables, in full and frozen with their tests** (they are security or compatibility
  boundaries):
  - `src/shared/render/proFormats.ts` tables: `FORMAT_CODECS`, `DEFAULT_CODEC`, `ALPHA_CODECS`,
    `CODEC_POLICY = { hevcSoftware: false, prores: false, cineform: true }`,
    `function codecOf(o: ExportOptions): ExportCodec`,
    `function canAlpha(format: ExportFormat, codec: ExportCodec): boolean`,
    `function isIntermediate(codec: ExportCodec): boolean`,
    `function nearestCodec(codec: ExportCodec, format: ExportFormat): ExportCodec`,
    `const EXPORT_FPS: readonly ExportFps[]`,
    `const ALLOWED_ENCODERS: readonly string[]` (every `-c:v` and `-c:a` value Flown may emit, §5.1).
  - `normalizeOptions` (`exportPresets.ts`) and `normalizeBundle` (`exportBundle.ts`) with the rules
    of §4.3; `matchesPreset` with `codec` and `alpha`; the batch reader's `userPresets` and `'4:5'`.
  - `RATIOS['4:5']` (`layout.ts`); `exportProject`'s 4:5 copy with `reframe.appSafe` off (§5.8); the
    `migrateProject` guard of §4.6.
  - `src/shared/render/userPresets.ts`: `USER_PRESET_LIMIT = 50`, `PRESET_FILE_LIMIT = 65536`,
    `function cleanPresetName(raw: unknown): string | null`,
    `function readUserPresets(raw: unknown): UserPresetStore | null`,
    `function readPresetFile(text: string): PresetFileRead | null`,
    `function presetFileText(presets: readonly UserExportPreset[]): string`,
    `function newPresetId(random: () => number): string`.
  - `validateJob` (`exportJob.ts`) for `codec`, `alpha`, `stems`, `fps` 24/25/120 and format `wav`
    (with `FORMATS`, `KINDS` and `EXPORT_EXTENSIONS`): the codec must be in `FORMAT_CODECS[format]`
    and allowed by `CODEC_POLICY`; `alpha` needs `canAlpha` and a raw `rgba` or `bgra` input; `stems`
    needs a non-GIF, non-batch job with sound; `wav` is audio-only like `m4a`.
  - `src/shared/interchange/planCheck.ts`: `function checkTimelinePlan(plan: unknown): string | null`
    (§18.3).
  - `src/shared/i18n/locale.ts`: `function readUiPrefs(raw: unknown): UiPrefs | null`.
- **The i18n runtime, in full** (§9.1): `src/shared/i18n/t.ts` (no English import of its own;
  `registerMessages(language, messages)`), `messages/en/index.ts` and `messages/en/main.ts`,
  `src/shared/i18n/isolate.ts` (`function isolate(value: string, dir?: 'ltr' | 'rtl'): string`),
  `src/shared/i18n/fmt.ts` with the **English profile only** (§11.2; other languages return the
  English output until P6), `src/renderer/src/i18n/T.tsx`, the `MessageKey` type, and
  `"resolveJsonModule": true` in both tsconfigs. `intl-messageformat` 12.1.4 is added to
  `devDependencies` (exact version) and to `BUNDLED` in `scripts/notices.mjs`.
- **Every namespace file of §9.2** (`src/shared/i18n/messages/en/<ns>.json` and `.meta.json`):
  empty for the namespaces the X parts fill later; **complete** for `codecs`, `alpha`, `stems`,
  `timelines`, `presets` and `language`, with every message and meta entry the new features show
  (§2 gives each exact text, `digits: 'latn'` marked where §9.3 says); and, in `errors` and `main`,
  the texts main shows for the new features (the disk-space refusal, the stem and timeline problems,
  the preset file dialog's title and filter). The P parts reference these keys; a part that needs
  another message adds it to its own namespace file only.
- **IPC and preload, in full**: channels `export:probeCodec`, `export:errorCode`,
  `export:writeTimeline`, `export:savePresetFile`, `export:openPresetFile`, `ui:info`,
  `ui:setPrefs`, `ui:relaunch`, `ui:noteSeen`, `ui:confirm`, each registered with a stub in its
  owner's new file (below); `src/preload/ui.ts` (new) and the new calls in `src/preload/export.ts`
  and `index.ts`. The preload imports nothing from `src/shared/i18n`.
- **Seams, completed** (each calls a stub in the owning part's new file; stubs keep today's
  behaviour):
  - `exportArgs.ts` `ffmpegPlan`: a job with a non-default `codec` → `proPlan` (P1,
    `src/main/proArgs.ts`); format `wav` → `wavPlan` (P3, `src/main/stemsArgs.ts`).
  - `exportPlan.ts`: `exportRoutes(settings, caps, codecCaps?, size?)` sends a non-default codec or
    `alpha` to `codecRoutes` (P1, `src/shared/render/codecRoutes.ts`); `isAudioOnly` is true for
    `wav`; `routeLabel` gives "Audio only (WAV)" for it.
  - `exportPresets.ts`: `FORMAT_EXTENSIONS` and `FORMAT_LABELS` gain `wav`. `exportBundle.ts`:
    `sidecarBlocked` treats `wav` like `m4a` (no thumbnail).
  - `exportIpc.ts`: `SAVE_FILTERS` becomes `saveFilters()`, made when the dialog opens, with WAV;
    `export:finish` calls `writeStemsStep(job, output, signal)` (P3, `src/main/stemsRun.ts`) after
    `moveIntoPlace`, and a cancel during it reaches the step's signal.
  - `codec.ts` `ivfFileHeader` gains `fourcc: 'VP90' | 'AV01' = 'VP90'`; `encoders.ts`
    `WebCodecsSink`'s `framing` gains `'ivf-av01'`.
  - `exporter.ts`, completed here and edited by no part afterwards: the export canvas gets
    `alpha: !!scene.alpha`; `scene.alpha = alphaOf(options)` (P2, `src/shared/render/alpha.ts`);
    `codecCapsFor(settings)` (P1, `src/renderer/src/render/proEncoders.ts`) is passed with the size to
    `exportRoutes`; `prepareRoute` builds raw sinks through `rawSinkFor(route, base, canvas, ctx,
    startJob)` (P1; the stub is today's `new RawFrameSink(…, base.format !== 'gif')`) and sends
    WebCodecs routes for `'hevc'` and `'av1'` to `proSink` (P1); lines 563 and 723 take
    `blurSamplesFor(fps)` (P1, `proFormats.ts`; the stub returns 10, today's
    `EXPORT_BLUR_SAMPLES`); `soundOf` adds `stems: stemJobOf(project, options, analysis)` (P3,
    `src/shared/render/stems.ts`).
  - `exportBundleRun.ts`: after the sidecars, `writeTimelineStep` (P4,
    `src/renderer/src/editor/timelineRun.ts`).
  - `src/main/index.ts`: imports `messages/en/main.ts`; `initUiLanguage()` first in `whenReady`, then
    `registerUiIpc()`, `registerCodecProbeIpc()`, `registerTimelineIpc()`, `registerPresetFileIpc()`.
  - `src/renderer/src/main.tsx`: imports `messages/en/index.ts`, awaits `bootLanguage(view)` (P6, stub
    returns English at once), then imports its view dynamically and renders (§9.4).
  - `App.tsx`: `reopenAfterRelaunch(openProject)` (P6, stub does nothing) and `<ReviewOverlay />` (P7,
    stub `null`). `Editor.tsx`: `noteProjectLanguages(project)` where a project opens (P6, stub does
    nothing).
  - `SettingsDialog.tsx`: `SettingsSection` gains `'language'`, first in the list, mounting
    `LanguageSection` (P6) only when `showLanguageSection(info)` (P6, stub `false`).
  - `Home.tsx`: `<LanguageOffer />` at the top of the content (P6, stub `null`), and on the two
    recording panels' containers `lang={uiLanguage() === 'en' ? undefined : 'en'}` (§9.5).
  - `commands.ts`: the *Language…* command, available only when `showLanguageSection` is true.
  - `prefsIpc.ts`: sanitisers for `'exportPresets'` (`readUserPresets`) and `'ui'` (`readUiPrefs`);
    `export function readPrefSync(key: PrefKey): unknown` and
    `export function writePrefSync(key: PrefKey, value: unknown): void` on the same cache (§4.4).
  - `package.json` scripts `i18n:check`, `i18n:build`, `i18n:sheet`, `i18n:pack`, `i18n:pseudo`,
    `i18n:extract`, pointing at P7's files (stubs that print "not ready" and exit 0);
    `scripts/predist.mjs` step 5 calling `scripts/i18n/check.mjs --report`;
    `scripts/i18n/config.json` with `"scan": "report"` and `failFor` listing every new file of
    §21.1–21.7.
- Contracts tests: 1–8, and the tour of 9–10 without a baseline. Both typechecks and all of vitest
  pass.

**What the contracts step settled (9 November 2026).** Recorded here for every part; each is in the
code and its tests:

1. **The message formatter.** `intl-messageformat` could not be added to this checkout (dependencies
   are not installed in the build worktrees), so `src/shared/i18n/icu.ts` parses and formats the
   subset §9.3 allows (arguments, `plural` with `=n` and `offset`, `select`, the four rich tags, ICU's
   apostrophe quoting), with the same syntax. P7's checks parse with its `parseIcu` and `argumentsOf`.
   Adding `intl-messageformat` 12.1.4 later replaces `icu.ts` only; `scripts/notices.mjs` gains it then.
2. **`setCatalogue` takes `user`** (key → placeholders holding the user's text, from the meta files'
   `user`), because meta files are never imported at runtime; P7's build writes it into the built
   catalogue next to `latn`.
3. **`writeStemsStep(job, output, signal, projectId)` and `renderStems(…, signal, projectId)`** take the
   project: the stems are cut from its recordings, which a job does not name.
4. **`ExportInput.stems?: true`** asks the exporter for stems (P5 sets it from *Also save*); `soundOf`
   calls `stemJobOf`, and loads the sound analysis for its fixed gain, only then.
5. **`rawSinkFor`'s route is `Extract<ExportRoute, { video: 'ffmpeg' }>`** (raw frames go to ffmpeg).
6. **`ffmpegPlan` sends a transparent job to `proPlan`** as well as a non-default codec: WebM's VP9 with
   alpha keeps the default codec.
7. **`fmt`'s English profile** needs the shapes today's helpers have: `clock(seconds, style)` with the
   five `ClockStyle`s (formatTime, formatClock and both tenths, clockTime, share's lengthText) in place
   of `hours?`, `tick` (formatTick), `seconds` (the sounds list's lengthText), `factor` (formatLevel,
   formatRate, zoomText), `count(n, { grouping })` (`toLocaleString('en-US')` of notes and script
   drafts) and `time(ms, 'short' | 'seconds')`; `relative` is storage's usedAgo in English. P6 writes
   the other languages' branch of each.
8. **`readPresetFile`** returns presets with id `''` and saved `0`; `importPresets` makes both.
9. **`boot.ts` also exports `currentUiInfo()`**: Settings, the palette and the shortcuts editor read the
   booted info. *Language…* is in `COMMAND_LIST` and left out of the palette and the shortcuts editor
   through `LANGUAGE_COMMANDS` until `showLanguageSection` is true.
10. **The batch reader** is `readBatchChoice` (`exportPresets.ts`), used by the dialog's `loadBatch`.
11. **Stubs that would run a new path before its part** throw `errors.feature.notReady`; every other stub
    keeps today's behaviour.
12. **`checkTimelinePlan`** also refuses an event past the plan's end, an event whose media the plan does
    not describe, and more than 16 tracks; source files may be up to 16,384 pixels a side (the
    sequence keeps to `MAX_EXPORT_SIDE`).
13. **The recording panels on Home** are wrapped in `display: contents` elements that carry `lang` in a
    translated UI only, since their files are the other account's.

### 21.1 Part P1 · Codecs, frame rates and 4:5

| File | Exports or change |
|---|---|
| `src/shared/render/proFormats.ts` (functions; the tables are the contracts') | `function rateFps(fps: number): number`; `function blurSamplesFor(fps: number): number` (10 up to 60, 5 at 120); `function estimateBytes(o: ExportOptions, size: { width: number; height: number }, seconds: number, stems?: number): number`; `function encodeSecondsEstimate(o: ExportOptions, size: { width: number; height: number }, seconds: number): number`; `const MB_PER_MINUTE_1080P60: Readonly<Record<'cineform' \| 'cineform-alpha' \| 'animation' \| 'prores-422' \| 'prores-4444' \| 'stem', number>>` |
| `src/shared/render/codecLevels.ts` (new) | `function hevcLevel(width: number, height: number, fps: number): number` (level × 30); `function av1Level(width: number, height: number, fps: number): { level: string; seqLevelIdx: number }`; `function hevcCodecString(width: number, height: number, fps: number): string`; `function av1CodecString(width: number, height: number, fps: number): string`; `function h264Fits(width: number, height: number, fps: number): boolean` (level 5.2 or lower) |
| `src/shared/render/codecRoutes.ts` (new) | `interface CodecCaps { webcodecs: { hevc: boolean; av1: boolean }; gpu: { hevc: HevcEncoder[]; av1: Av1Encoder[] }; overrides: ExportCapabilities['overrides'] }`; `function codecRoutes(o: Pick<ExportOptions, 'format' \| 'codec' \| 'alpha' \| 'encoder' \| 'targetSizeMB' \| 'resolution' \| 'aspect'>, caps: CodecCaps, size: { width: number; height: number }): ExportRoute[]`; `function amfAv1Fits(width: number, height: number): boolean` |
| `src/shared/render/exportPlan.ts` | `ENCODER_NAMES` gains the HEVC, AV1 and intermediate encoders |
| `src/main/proArgs.ts` (new) | `function proVideoArgs(job: ExportJob, encoder: FfmpegVideoEncoder): string[]`; `function proAudioArgs(job: ExportJob): string[]` (float PCM for intermediates, else today's); `function copyProArgs(kind: 'hevc' \| 'av1'): string[]`; `function proPlan(job: ExportJob, given: PlanPaths): FfmpegPlan` |
| `src/main/codecProbe.ts` (new) | `const HEVC_ENCODERS: HevcEncoder[]`; `const AV1_ENCODERS: Av1Encoder[]`; `function probeCodecArgs(encoder: HevcEncoder \| Av1Encoder): string[]`; `function probeCodec(codec: 'hevc' \| 'av1', run?: (args: string[]) => Promise<boolean>): Promise<FfmpegVideoEncoder[]>` (once per codec per session); `function registerCodecProbeIpc(): void` |
| `src/main/hwEncoders.ts` | `encoderPixelFormat` and `gpuEncoderOptions` take the HEVC and AV1 encoders (`-hw_encoding 1` for `hevc_mf`); the H.264 list and probe do not change |
| `src/main/exportArgs.ts` | `isTwoPass` adds `libaom-av1` (and `libx265` when `CODEC_POLICY.hevcSoftware`) |
| `src/renderer/src/render/proEncoders.ts` (new) | `function hevcConfigs(width: number, height: number, fps: number, bitrate: number): VideoEncoderConfig[]`; `function av1Configs(width: number, height: number, fps: number, bitrate: number): VideoEncoderConfig[]`; `function webCodecsSupport(width: number, height: number, fps: number): Promise<{ hevc: boolean; av1: boolean }>`; `function codecCapsFor(settings: ExportSettings): Promise<CodecCaps \| undefined>`; `function rawSinkFor(route: Extract<ExportRoute, { video: 'raw' }>, base: JobBase, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, startJob: StartJob): FrameSink` (RGB for intermediates, I420 as today otherwise, P2's `alphaRawSink` for alpha jobs); `function proSink(route: Extract<ExportRoute, { video: 'webcodecs' }>, canvas: HTMLCanvasElement, fps: number, bitrate: number, startJob: (color: ColorTags) => Promise<void>): FrameSink` |
| `src/shared/i18n/messages/en/codecs.json` | messages beyond those the contracts wrote, if any |
| Tests | 11–24, 81 |

### 21.2 Part P2 · Transparency

| File | Exports or change |
|---|---|
| `src/shared/render/alpha.ts` (new) | `function alphaOf(o: ExportOptions): RenderScene['alpha']`; `function seeThrough(project: Project, alpha: 'background' \| 'overlays', w: number, h: number): boolean` (false when the card fills the frame) |
| `src/renderer/src/render/compositor.ts` | the `alpha` branch of `drawFramePicture` (§6.2) |
| `src/renderer/src/render/joinLayer.ts` | `scratchTarget(raster, w, h, alpha?)`, `composeJoinStill(…, alpha?)`, the alpha mode in the still cache keys, and the dip to transparent in `endJoin` (§6.4) |
| `src/renderer/src/render/alphaReadback.ts` (new) | `function alphaRawSink(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, startJob: StartJob, readback?: 'videoframe' \| 'imagedata'): FrameSink`; `function unpremultiply(src: Uint8ClampedArray \| Uint8Array, out: Uint8Array): void` (`getImageData`'s rounding) |
| `src/renderer/src/editor/ExportPreview.tsx`, `alphaPreview.css` (new) | the alpha canvas over the checkerboard (§6.5) |
| Tests | 25–29 |

### 21.3 Part P3 · Stems and the WAV format

| File | Exports or change |
|---|---|
| `src/shared/render/stems.ts` (new) | `const STEM_FILE_WORDS: Readonly<Record<SoundStem, string>>` ('Voice', 'System sound', 'Recording', 'Music', 'Effects'); `function stemJobOf(project: Project, options: ExportOptions, analysis: AudioAnalysis \| null): StemJob \| undefined`; `function stemsOfJob(job: ExportJob, files: SoundFiles): SoundStem[]`; `function stemSamples(frames: number, fps: number): number`; `function stemPlan(job: ExportJob, files: SoundFiles, first: number, only?: readonly SoundStem[]): { args: string[]; graph: string; outputs: { stem: SoundStem; label: string }[] }` (`only` lets P4 render Music and Effects alone) |
| `src/shared/render/audioPlan.ts` | `RecordingPart.gainDb?: number` (one fixed gain instead of `normalize`); `recordingGraph`, `musicBranch`, the effect branch builders, `fadeFilters` and `STEREO` exported; every graph today's jobs build is unchanged (test 3) |
| `src/main/stemsArgs.ts` (new) | `function stemOutputArgs(stem: SoundStem, path: string): string[]`; `function wavPlan(job: ExportJob, given: PlanPaths): FfmpegPlan`; `function stemPaths(output: string, stems: readonly SoundStem[], exists: (p: string) => boolean): Partial<Record<SoundStem, string>>` |
| `src/main/stemsRun.ts` (new) | `function writeStemsStep(job: ExportJob, output: string, signal: AbortSignal): Promise<{ stems?: { stem: SoundStem; path: string; bytes: number }[]; stemsProblem?: string }>`; `function renderStems(job: ExportJob, folder: string, only: readonly SoundStem[], names: Partial<Record<SoundStem, string>>, signal: AbortSignal): Promise<Partial<Record<SoundStem, string>>>` (used by P4) |
| Tests | 30–35 |

### 21.4 Part P4 · Timelines

| File | Exports or change |
|---|---|
| `src/shared/interchange/timelinePlan.ts` (new) | the types and the two builders of §8.2 |
| `src/shared/interchange/fcpxml.ts`, `xmeml.ts`, `edl.ts` (new) | `function fcpxml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>, projectId: string): string`; `function xmeml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string`; `function edl(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string`; `function markerEdl(plan: TimelinePlan): string \| null`; `const EDL_EVENT_LIMIT = 999` |
| `src/shared/interchange/fileUrl.ts` (new) | `function fileUrl(windowsPath: string, form: 'fcpxml' \| 'xmeml'): string`; `function xmlText(s: string): string`; `function xmlAttr(s: string): string` (both drop the characters XML 1.0 forbids; `xmlAttr` writes newlines as `&#10;`); `function asciiName(s: string, fallback: string): string` |
| `src/main/timelineIpc.ts` (new) | `function registerTimelineIpc(): void`; `function writeTimeline(request: TimelineRequest, deps?: TimelineDeps): Promise<TimelineResult>`; `function copyRecordings(projectId: string, folder: string, voice: VoiceStrength \| null, deps?: TimelineDeps): Promise<Partial<Record<TimelineMedia, string>>>` (screen and camera remuxed with `-an`, sound converted to WAV, Music and Effects rendered through P3's `renderStems` when stems are off); `function timelinePaths(video: string, editors: readonly TimelineEditor[], withMarkers: boolean, exists: (p: string) => boolean): { path: string; for: TimelineEditor \| 'resolve-markers' }[]` |
| `src/renderer/src/editor/timelineRun.ts` (new) | `function writeTimelineStep(project: Project, request: Omit<TimelineRequest, 'plan'>, exported: { fps: number; frames: number; width: number; height: number }): Promise<TimelineResult>` |
| Tests | 36–44 |

### 21.5 Part P5 · Export dialog and presets

| File | Exports or change |
|---|---|
| `src/shared/render/exportRows.ts` (new, pure) | `interface CodecUiCaps { hevc: 'probing' \| 'none' \| FfmpegVideoEncoder[] \| 'webcodecs'; av1Gpu: boolean; h264Gpu: boolean }`; `interface RowsState { …the chips shown, which are disabled and the message key of each reason, each row's hint… }`; `function settingsRows(o: ExportOptions, caps: CodecUiCaps, ctx: { seeThrough: boolean; size: { width: number; height: number }; seconds: number }): RowsState`; `function usableCodec(o: ExportOptions, caps: CodecUiCaps): { options: ExportOptions; notice: MessageKey \| null }`; `function pickCodec(o: ExportOptions, codec: ExportCodec): ExportOptions`; `function pickBackground(o: ExportOptions, alpha: ExportSettings['alpha'] \| undefined, replaced: ExportCodec \| null): { options: ExportOptions; replaced: ExportCodec \| null }` (switches the codec in the same step and gives it back on *With background*, §2.1); `function pickFps(o: ExportOptions, fps: ExportFps): ExportOptions`; `function pickResolution(o: ExportOptions, r: ExportSettings['resolution']): ExportOptions` (4K at 120 fps with H.264 → 60 fps); `function sizeLine(o: ExportOptions, size: { width: number; height: number }, seconds: number): string` |
| `src/shared/render/userPresetsEdit.ts` (new) | `function savePreset(store: UserPresetStore, name: string, options: ExportOptions, bundle: Omit<BundleOptions, 'languages'> \| undefined, now: number, random: () => number): UserPresetStore`; `function renamePreset(store: UserPresetStore, id: string, name: string): UserPresetStore`; `function updatePreset(store: UserPresetStore, id: string, options: ExportOptions, bundle: Omit<BundleOptions, 'languages'> \| undefined): UserPresetStore`; `function deletePreset(store: UserPresetStore, id: string): UserPresetStore`; `function importPresets(store: UserPresetStore, incoming: readonly UserExportPreset[], now: number, random: () => number): { store: UserPresetStore; added: number; skipped: number }`; `function suggestName(o: ExportOptions): string`; `function uniqueName(taken: readonly string[], name: string): string` (compares NFC forms) |
| `src/shared/render/alsoSave.ts` (new) | `const EDITOR_OPENS: Readonly<Record<TimelineEditor, Readonly<Record<ExportCodec, 'yes' \| 'no' \| 'unchecked'>>>>`; `function stemsBlocked(o: ExportOptions, mode: 'single' \| 'batch', perChapter: boolean, hasSound: boolean): MessageKey \| null`; `function timelineBlocked(o: ExportOptions, mode: 'single' \| 'batch', perChapter: boolean): MessageKey \| null` (GIF, M4A, WAV, batch, per chapter); `function editorBlocked(editor: TimelineEditor, o: ExportOptions, media: 'export' \| 'recordings'): MessageKey \| null`; `function editorWarning(editor: TimelineEditor, o: ExportOptions, media: 'export' \| 'recordings'): MessageKey \| null`; `function timelineKindsFor(editors: readonly TimelineEditor[]): TimelineKind[]`; `function stemsHint(stems: readonly SoundStem[], seconds: number): string` |
| `src/shared/render/exportPresets.ts` | `portrait-post`, `editing` and `overlay` in `EXPORT_PRESETS` (the last two only while `CODEC_POLICY.cineform`); `BATCH_ASPECTS` gains `'4:5'` (file label `4x5`); `batchItems` takes user presets; `EXPORT_PRESET_FILE_LABELS` (§9.6); `function matchesUserPreset(o: ExportOptions, preset: UserExportPreset, usable: (codec: ExportCodec) => boolean): boolean` |
| `src/renderer/src/editor/exportRows.tsx` (new) | `function CodecRow(props: { rows: RowsState; options: ExportOptions; onChange: (o: ExportOptions) => void }): JSX.Element \| null`; `function BackgroundRow(…same props…): JSX.Element \| null`; `function FrameRateRow(…same props…): JSX.Element` |
| `src/renderer/src/editor/UserPresets.tsx` (new) | `function UserPresets(props: { store: UserPresetStore; selected: string \| null; options: ExportOptions; bundle: Omit<BundleOptions, 'languages'>; onPick: (p: UserExportPreset) => void; onStore: (s: UserPresetStore) => void; batch?: { checked: readonly string[]; onToggle: (id: string) => void } }): JSX.Element`; `function SavePresetField(props: { suggestion: string; taken: readonly string[]; onSave: (name: string) => void; onCancel: () => void }): JSX.Element` |
| `src/renderer/src/editor/exportPro.css` (new) | the new rows, cards and menus |
| `src/renderer/src/editor/ExportDialog.tsx` | the rows, chips, hints, presets, batch, running and done views of §2.1–2.4, with the probes (`probeCodec`, `webCodecsSupport`) |
| `src/renderer/src/editor/ExportBundleOptions.tsx` | the Sound stems and Timeline chips and the Open in and Uses rows (§2.3) |
| `src/main/presetFiles.ts` (new) | `function registerPresetFileIpc(): void` (`export:savePresetFile` through `presetFileText` and a read-back, `export:openPresetFile` through `readPresetFile`) |
| Tests | 45–50 |

### 21.6 Part P6 · Language runtime, settings and fonts

| File | Exports or change |
|---|---|
| `src/shared/i18n/locale.ts` (the contracts wrote `readUiPrefs`) | `function languageOf(tag: string): string`; `function formatLocaleOf(language: UiLanguage, systemLocale: string, digits: 'native' \| 'western' \| undefined): string`; `function dirOf(language: string): 'ltr' \| 'rtl'`; `function resolveUiLanguage(prefs: UiPrefs \| null, preferred: readonly string[], systemLocale: string, shipped: readonly { language: UiLanguage; preview: boolean }[], known: readonly UiLanguage[]): UiInfo`; `const LANGUAGE_NAMES: Readonly<Record<UiLanguage, { own: string; english: string }>>` |
| `src/shared/i18n/fmt.ts` | the other languages' branch of every function (§11.3) and `parseNumber`; the English profile stays as the contracts wrote it |
| `src/main/i18n.ts` (new) | `function initUiLanguage(): UiInfo`; `function registerUiIpc(): void`; `function relaunchBlocker(): string \| null`; `function relaunchApp(reopenProjectId?: string): RelaunchResult`; `function knownLanguages(): UiLanguage[]` (speech models made for a language, `UiPrefs.seen`) |
| `src/renderer/src/i18n/boot.ts` (new) | `function bootLanguage(view: 'main' \| 'notes' \| 'region' \| 'toolbar'): Promise<UiInfo>` (1.5 s bound, English on any failure); `function reopenAfterRelaunch(open: (projectId: string) => void): void`; `function showLanguageSection(info: UiInfo): boolean` |
| `src/renderer/src/i18n/uiFonts.ts` (new) | `function loadUiFont(language: UiLanguage): Promise<boolean>` |
| `src/renderer/src/i18n/canvasLang.ts` (new) | `function pinCanvasLanguage(): void` (§9.7) |
| `src/renderer/src/i18n/askConfirm.ts` (new) | `function askConfirm(message: string, action: MessageKey): Promise<boolean>` |
| `src/renderer/src/i18n/NumberField.tsx` (new) | `function NumberField(props: InputHTMLAttributes<HTMLInputElement> & { value: number; onValue: (n: number) => void }): JSX.Element` |
| `src/renderer/src/i18n/scripts.css` (new) | the `:lang(bn)`, `:lang(hi)` fonts, tokens and overrides of §12.1–12.2 (no edit to any other CSS file) |
| `src/renderer/src/settings/LanguageSection.tsx` (new) | `function LanguageSection(): JSX.Element` (§2.5) |
| `src/renderer/src/home/LanguageOffer.tsx` (new) | `function LanguageOffer(): JSX.Element \| null` (§2.7) |
| `src/shared/i18n/messages/en/language.json` | messages beyond those the contracts wrote, if any |
| Tests | 51–60, 79, 80, 82, 83, 84 |

`boot.ts` also exports `function noteProjectLanguages(project: Project): void`, which calls
`noteLanguageSeen` once for a shipped language the project's captions or transcript are in; the
contracts call it where `Editor.tsx` opens a project (stub does nothing).

### 21.7 Part P7 · Checks and translation tools

| File | Exports or change |
|---|---|
| `scripts/i18n/lib/scan.cjs`, `scripts/i18n/scan.mjs` (new) | `scanSource(file: string, text: string, rules: ScanRules): Finding[]` with `Finding = { file, line, kind: 'jsx' \| 'attr' \| 'sink' \| 'module-scope-t' \| 'locale' \| 'key', text }`; the `failFor` list; `mainNamespaces(entry: string): Set<string>` (test 86) |
| `scripts/i18n/lib/catalogue.cjs`, `scripts/i18n/check.mjs` (new) | `checkMessage(lang: string, english: string, meta: MetaEntry, translated: TranslationEntry, glossary: GlossaryRow[], reviewers: Reviewer[]): Problem[]`; `checkEnglish(messages, meta, usedKeys): Problem[]` |
| `scripts/i18n/build-catalogues.mjs` (new) | writes `src/shared/i18n/built/*.json` (with `latn`) and `shipped.json` (with `preview`); the merge-group report; `--check` |
| `scripts/i18n/extract.mjs`, `lib/extract.cjs` (new) | the codemod of §10.2 |
| `scripts/i18n/split.mjs` (new) | `scripts/i18n/parts.json` (§10.5) |
| `scripts/i18n/pseudo.mjs`, `sheet.mjs`, `pack.mjs`, `draft.mjs` (new) | `en-XA`, `bn-XA`, `ar-XB` (§16.3); the sheet with its byte-order mark, formula guard and import refusals (§15.4); the review pack (§15.4); the drafts (§15.3) |
| `scripts/i18n/allow.json`, `pending.json`, `config.json` (new; `config.json` from the contracts) | §16.1 |
| `translations/glossary.csv`, `translations/reviewers.json`, `translations/README.md` (new) | the glossary's columns, the reviewers' record and the review steps of §15 (the service used per language, "CSV UTF-8") |
| `src/renderer/src/i18n/reviewOverlay.tsx` (new) | `function ReviewOverlay(): JSX.Element \| null` (unpackaged builds with `FLOWN_I18N_REVIEW=1` only) |
| `.github/workflows/checks.yml` (new) | §16.4 |
| `scripts/predist.mjs`, `scripts/verify-dist` | step 5 runs `check.mjs` without `--report` once `config.json` says `"fail"`; the 1 MB catalogue growth check |
| Tests | 61–68, 85, 86, and the harness of 69 |

### 21.8 Extraction parts X1–X7 (step S3)

X6 starts after the S2 baseline, alone (S3a); the others start from X6's merged result (S3b). Each
works on the file list `scripts/i18n/parts.json` gives it (§10.5) and the namespaces it owns, runs the
codemod on its files, edits by hand what the codemod leaves, adds its rows to its own log file
(`scripts/i18n/log/x1.json` …, so no two parts write the same file), and passes tests 9, 10 and 69
before it asks to merge. `common` is the lead's, frozen at S2.

| Part | Owns | Also | Tests |
|---|---|---|---|
| X6 · Formatting call sites (S3a, alone) | the formatter call lines of §10.5 | `scripts/i18n/fmt-sites.json` | 73 |
| X1 · Editor shell | §10.5 row X1; namespaces `editor`, `timeline`, `commands`, `keys` | the command palette searches the UI-language title, the English title and the keywords, all in NFC; `CommandCategory` stays an id, with labels in `commands.category.*`; `askConfirm` at `Editor.tsx:542,598`; `ariaKeys` and `aria-keyshortcuts` (§14.2) as a separate commit after the NVDA check | 70, 71 |
| X2 · Panels | §10.5 row X2; `style`, `zoom`, `camera`, `sound`, `text` | wave 10's moods and cut-style names; `camera.corner.*` (§9.5); `NumberField` at its three sites | 69 rows |
| X3 · Captions and smart tools | §10.5 row X3; `captions`, `smart` | the UI digits never change caption content digits (`CaptionSettings.digits`); `askConfirm` at `CaptionsPanel.tsx:395` and `SpeakersSection.tsx:54` | 77 |
| X4 · Review and project tools | §10.5 row X4; `review` | `KIND_WORDS` (`review/copy.ts:18-36`) as plural messages; the Notes window | 78 |
| X5 · Export, settings, Home, main | §10.5 row X5; `home`, `export`, `settings`, `errors`, `main` | the error codes of §9.6; `askConfirm` at `Home.tsx:704,874`; the recording-side reads of §9.5; `NumberField` for Target size; main's dialogs, filters, notifications and taskbar tooltips through main's `t()` | 72, 75 |
| X7 · Right-to-left styles | every `*.css` file but `i18n/scripts.css` | `direction: ltr` on the time-axis containers (§13.1) | 76 |

### 21.9 Not touched, ownership and merging

**Not touched by any part**: the recording side (listed at the top), `src/main/security.ts`, the CSP,
`windows.ts`, `appSettings.ts`, `electron-builder.config.cjs` (`electronLanguages` stays `['en-US']`),
`formatTime` and `formatTimestamp`, `textArea` and `COMMON_SAFE` (`safeZones.ts`), the project format
beyond the guard of §4.6, `frameView.ts`, wave 10's join planning (`joins.ts` is read, not changed),
wave 11's `GUIDE_WORDS`.

**Ownership in S1.** The files the contracts complete are edited by no part, except where this table
names an owner for code below the contracts' lines:

| Part | Existing files it edits |
|---|---|
| P1 | `exportPlan.ts` (`ENCODER_NAMES`), `hwEncoders.ts`, `exportArgs.ts` (`isTwoPass`) |
| P2 | `compositor.ts` (`drawFramePicture`'s branch), `joinLayer.ts`, `ExportPreview.tsx` |
| P3 | `audioPlan.ts` |
| P4 | `exportBundleRun.ts` (below the contracts' call) |
| P5 | `ExportDialog.tsx`, `ExportBundleOptions.tsx`, `exportPresets.ts` (below `matchesPreset`) |
| P6 | `fmt.ts` (the non-English branch) |
| P7 | `scripts/predist.mjs` (step 5), `verify-dist` |

**Who writes the code behind each seam:**

| Seam (file: call) | Code behind it |
|---|---|
| `exportArgs.ts`: `proPlan`; `wavPlan` | P1 `proArgs.ts`; P3 `stemsArgs.ts` |
| `exportPlan.ts`: `codecRoutes` | P1 `codecRoutes.ts` |
| `exporter.ts`: `codecCapsFor`, `rawSinkFor`, `proSink`, `blurSamplesFor` | P1 `proEncoders.ts`, `proFormats.ts` |
| `exporter.ts`: `alphaOf`; `rawSinkFor` → `alphaRawSink` | P2 `alpha.ts`, `alphaReadback.ts` |
| `exporter.ts`: `stemJobOf` | P3 `stems.ts` |
| `exportIpc.ts`: `writeStemsStep` | P3 `stemsRun.ts` |
| `exportBundleRun.ts`: `writeTimelineStep` | P4 `timelineRun.ts` |
| `src/main/index.ts`: `registerCodecProbeIpc`, `registerTimelineIpc`, `registerPresetFileIpc`, `initUiLanguage` and `registerUiIpc` | P1, P4, P5, P6 |
| `main.tsx`: `bootLanguage`; `App.tsx`: `reopenAfterRelaunch`, `ReviewOverlay`; `Editor.tsx`: `noteProjectLanguages` | P6; P6, P7; P6 |
| `SettingsDialog.tsx`, `commands.ts`: `showLanguageSection`, `LanguageSection`; `Home.tsx`: `LanguageOffer` | P6 |

**Merge order.** S1: P1, P2, P3, P4, then P5 (it mounts the others' rows), with P6 and P7 at any
point. After S1 the lead runs both typechecks, all of vitest, `npm run build`, `npm run i18n:check
-- --report`, and under `xvfb-run`: `output-formats`, `languages`, `export`, `export-pack`, `render`,
`audit-audio-export`, `clean-voice`, `editing-polish`, `smart-tools`, `captions-studio`,
`vertical-video`, `versions`, `commands`, `ui`, `smoke`, `packaging`. Then S2 (the baseline, run
twice), then S3a (X6 alone, then tests 9, 10, 73), then S3b (X1–X5 and X7 in any order, each followed
by tests 9, 10, 69 and the e2e list above). Then S4 and S5 (§10.4).

---

## 22. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Old settings, presets or projects export differently through shared code (`normalizeOptions`, `matchesPreset`, `exportRoutes`, `ffmpegPlan`, `drawFrame`, `planSoundtrack`, `exportProject`). | Every new path is behind a field that is absent today; tests 1–4 are written before any change and never regenerated; argument lists and graphs are compared character for character. |
| 2 | The English UI changes during extraction (a lost space, a different number format, a moved box). | The codemod copies React's own whitespace; `fmt`'s English profile is today's code; test 69 per message; tests 9 and 10 on the whole UI after every merge, on a deterministic tour; the baseline is recorded once, from two identical runs (§10.4, §10.6). |
| 3 | HEVC is exposed through a software encoder by accident (`hevc_mf` picking Windows' inbox or the Store extension's encoder). | `-hw_encoding 1` in the probe and in every encode (test 12); `CODEC_POLICY.hevcSoftware` false; no route lists `libx265` (test 15); `ALLOWED_ENCODERS` (test 81). |
| 4 | HEVC, ProRes or CineForm patent or trademark claims; the binary already distributes x265 and an HEVC decoder. | §0 decisions 1–3: hardware-only HEVC now and a binary without HEVC next; ProRes off and never `apl0` (test 23); CineForm behind its own policy flag with GoPro's ST 2073 declaration checked before release. |
| 5 | GPU encoder settings untested (no GPU here); `av1_amf` pads 1080 lines. | Starting values from vendor options measured with `-h encoder=…`; calibration on the reference PC before release (§0 decision 14); `av1_amf` only for sizes it does not pad (test 13); every GPU route falls back to the next. |
| 6 | Transparent export looks different from the dialog's preview, has dark edges, or loses its cut styles. | One drawing path with one option (§6.2); one straight-alpha convention, both readbacks equal (test 26); joins composed on a transparent scratch (§6.4, test 28); e2e F5–F7 compare preview and export, a 50% grey shadow, a red edge and a crossfade frame. |
| 7 | Editors read transparent files as opaque, or cannot open a codec at all. | VP9 is for browsers, CineForm and Lossless for editors (§2.1); tests decode with libvpx (§6.6); `EDITOR_OPENS` blocks the known failures and warns on the unchecked pairs until the round trips of §0 decision 14. |
| 8 | Stems do not line up with the video or with each other. | One graph, one start (sample 0), one length (`stemSamples`, test 33); BWF `time_reference` 0; the known 20 ms microphone offset (issue #61) is the same in the video and in its stems. |
| 9 | Stems disagree with the video's loudness or level. | One fixed gain, the preview's (§7.4), stated in the dialog's hint; the video keeps `loudnorm`; each stem gets the mix's own channel step (test 31 with a mono microphone and effects only). |
| 10 | A timeline opens wrong in Premiere, Resolve or Final Cut (speed, offsets, paths, 24 versus 23.976, sound playing twice, the camera covering the screen). | Written directly, golden files (tests 37–39); exact rates, start at 0, cumulative rounding, each source on its own rate (test 36); V1 picture only with stems and recordings without sound (test 41); the camera on a track turned off; WAV copies instead of M4A (§8.1); round trips in each editor before release, or the chips labelled with the editors checked. |
| 11 | Disk fills during an intermediate, stems or the recordings copy. | `estimateBytes` and `statfs` before starting (test 22); the video is never removed for a failed stem or timeline. |
| 12 | A hostile `.flownpreset` file, or a renderer writing arbitrary text through the preset save call. | Main-only reader with size, count and field limits, frozen with test 5; presets hold no paths (§18.2); main serialises and re-reads every file it writes. |
| 13 | Translations wrong or offensive; machine drafts shipped by mistake. | Glossary first, tried on users; two listed people per string, recorded and checked (test 65); only approved, current strings reach the built catalogue; the release checks it (§16.4). |
| 14 | Translated text overflows, is cut, or is clipped in height. | `en-XA` and `bn-XA` tours in development (e2e L4, L9); `maxLength` per message; Bangla line heights and sizes (§12.2). |
| 15 | Bangla marks clipped, or timecodes jitter. | Line height 1.4 or more; Noto Sans Bengali with tabular digits, in the mono stack too (§12.1); e2e L4 measures ink bounds, the timecode's font and the digits' widths. |
| 16 | A translated UI flashes English, shows a blank window, or breaks a decision that read English text. | The language and catalogue load before the first render, with a 1.5 s bound and an English fallback (§9.4); no text at module scope (§9.1); every English-text decision moved to codes or flags (§9.6, test 72). |
| 17 | The recording side changes in a translated UI (digits in the recording bar, messages from `ffmpeg.ts`). | Their files are not edited (test 74); `formatTime` and `ffmpeg.ts`'s messages keep their output; the recording bar keeps `lang="en"`; their text inside our panels is wrapped in `lang="en"`. |
| 18 | Merge conflicts with waves 10 and 11 or between parts (`ExportDialog.tsx`, `exporter.ts`, `exportIpc.ts`, `audioPlan.ts`, `commands.ts`, `Editor.tsx`, the catalogues). | Contracts after both waves merge; `exporter.ts` and `exportIpc.ts` completed by the contracts and edited by no part; one owner per file and per namespace (§21.9, §10.5); the features' messages written by the contracts; X6 alone before the other X parts; one log file per X part. |
| 19 | A translation is sent somewhere at runtime. | Catalogues are bundled; no fetch exists for them; the drafting script is not in the app (test 60). |
| 20 | The language preference breaks an older Flown, or is lost to a stale write. | `ui` and `exportPresets` are new keys in `editor-prefs.json`; `prefsIpc.ts` keeps unknown keys; an older Flown ignores them (test 5); main writes through the renderer's own cache (`writePrefSync`). |
| 21 | 120 fps or alpha exports are much slower than users expect. | Hints state the cost ("about twice as long as 60 fps"); blur samples halve at 120 fps; the alpha factor is measured by P2 and shown; the alpha readback avoids pushing the canvas to software rendering (§6.3). |
| 22 | Changing the language loses work: a running export stopped and deleted, a project left behind. | Relaunch refused while anything is busy, with the reason; the editor saves and its project reopens (§9.4, test 79, e2e L2). |
| 23 | Qbexel ships text it has no right to. | Contributor licence or assignment before a reviewer's first string; `reviewers.json` checked by the build; the AI service's terms checked before drafting (§15.1, §15.3). |
| 24 | A spreadsheet round trip turns approved Bangla into `?` or formulas. | Byte-order mark, formula guard, import refusals (§15.4, test 66); the `?`-run and script checks of §16.2. |
| 25 | Drawn frames change with the UI language (caption fallback fonts or shaping under `lang="bn"`). | `pinCanvasLanguage` (§9.7, test 84); e2e L13 compares an exported frame's bytes in bn and en. |

---

## 23. Test plan

### 23.1 Unit tests (vitest). Each fails without the code of its rule.

**Contracts and guards** (§21.0)

1. **Projects**: the fixtures of the earlier guards (`tests/fixtures/vertical-old-projects.json`, the
   captions, wave 10 and wave 11 fixtures) migrate to byte-equal JSON; a project with
   `style.aspectRatio: '4:5'` reads as `'auto'`; no project gains a key.
2. **Stored export settings**: 40 stored values of `export-settings`, `export-batch` and
   `export-bundle` written by the release before this wave (every format, preset, aspect, quality,
   encoder, size target, subtitle streams) go through `normalizeOptions`/`normalizeBundle` and
   `tweakOptions` and are written back byte for byte; every built-in preset of today still matches
   (`matchesPreset`); `codec: 'h264'` on MP4 is deleted; `codec: 'prores-422'` becomes `'cineform'`
   while `CODEC_POLICY.prores` is false, and `prores-4444` with `alpha` becomes `'cineform'` with
   `alpha` kept; `alpha` on MP4 is deleted; `fps: 24` is kept and `fps: 23.976` becomes 60 as today's
   `pick` does.
3. **Arguments and graphs**: `ffmpegPlan` for every format × quality × encoder × size target × fps 30
   and 60 (GIF fits included) and `planSoundtrack` for the audio fixtures equal the digests taken in
   the contracts commit, character for character.
4. **Drawing**: `drawFrame` call logs (recording fake context, as `verticalEquivalence.test.ts`) for
   six fixture projects at 24 times, with `alpha` absent, equal the snapshots; so do the logs of
   `composeJoinStill` and `endJoin` for wave 10's join fixtures.
5. **Preset readers**: `readUserPresets`, `readPresetFile`, `cleanPresetName` and `readUiPrefs` on
   hostile input (65 KB file, 200 presets, nesting 1,000 deep, `__proto__` and `constructor` keys,
   wrong types, names with U+202E, NUL, `\`, 61 graphemes): limits held, nothing thrown, unknown
   fields dropped; names are NFC, ZWJ and ZWNJ are kept (র‍্যা), য় typed as U+09DF and as য + ় give
   one name; a file with two ProRes presets reports `changed: [{ from: 'prores-422', to: 'cineform',
   count: 2 }]`; `presetFileText` → `readPresetFile` round-trips; ids never equal a built-in id.
6. **`validateJob`**: a codec outside `FORMAT_CODECS[format]`, `prores-4444` with the policy off,
   `alpha` with H.264 or with `yuv420p`, `stems` on a GIF, `fps: 23.976` and `fps: 121` are refused;
   `wav` is accepted as audio-only; every job of test 3 passes unchanged.
7. **Runtime**: `t()` falls back to English for a missing key and for a stale translation; plural
   selection uses `count` and shows `n`; `#` is never needed; rich tags map to the caller's nodes;
   `<T>` renders no wrapper element; isolation adds nothing in English and FSI/PDI around `user`
   placeholders in other languages; `t()` before any `registerMessages` throws in tests (so a
   module-scope call cannot pass silently).
8. **English profile**: every `fmt` function in English equals the helper it replaces over the value
   grids of §11.2; `fmt.list(['A', 'B', 'C'])` is "A, B and C".

**English guards** (§10.6; run under xvfb by `tests/e2e/english-guard.e2e.cjs`)

9. **Text and accessible names** of the tour equal the S2 baseline exactly.
10. **Layout** of the tour equals the S2 baseline: boxes within 0.5 px, computed fonts and colours
    equal, alignment compared through the computed direction, screenshots within the stated
    tolerance. The harness refuses a baseline unless two runs were identical.

**P1 · Codecs, frame rates and 4:5**

11. HEVC arguments for `hevc_nvenc`, `hevc_qsv`, `hevc_amf`, `hevc_mf` × Studio, Web, Small file and
    a size target equal §5.4's strings, each with `hevc_metadata`, `colorTagArgs(EXPORT_COLOR)`,
    `-tag:v hvc1`, `-g` = 2 × fps; the WebCodecs copy route uses `-f hevc` and `-c:v copy`.
12. `hevc_mf` carries `-hw_encoding 1` in `probeCodecArgs` and in every encode.
13. AV1 arguments for the four encoders; `av1_amf` is skipped for 1920×1080 and 1080×1350 and used for
    1280×720, 2560×1440 and 3840×2160.
14. Two-pass plans for `libaom-av1` (and `libx265` with the policy on): pass 1 to `-f null`, pass 2
    with `-passlogfile`, over today's lossless intermediate.
15. `codecRoutes`: the order of §5.3 for each codec with and without each capability; HEVC with no
    GPU gives no route; no route ever lists `libx265` while the policy is off; *Software* gives
    libaom for AV1; alpha codecs give raw `bgra`/`rgba` routes only.
16. Levels: `hevcLevel` (1080p60 → 123, 1080p120 → 150, 2160p60 → 153, 2160p120 → 156), `av1Level`,
    `h264Fits(3840, 2160, 120)` false and `(2560, 1440, 120)` true; the codec strings.
17. `ivfFileHeader` with `'AV01'`; the default stays byte for byte `'VP90'`.
18. `hevcConfigs`/`av1Configs` ask for `prefer-hardware` (HEVC) and give Annex B for HEVC.
19. Frame rates: `rateFps` (30 → 30, 60 → 60, 120 → 90); `blurSamplesFor` (60 → 10, 120 → 5); samples
    per frame at 48 kHz are whole for 24, 25, 30, 60, 120.
20. 4:5: `outputSize` gives 720×900, 1080×1350, 1440×1800, 2160×2700; `isTall` is true; the batch
    label is `4x5`; `exportProject` applies it to the copy only, with `reframe.appSafe` off, so
    `textArea` at 1080×1350 with `appSafe` on in the project gives the full-frame placement; a 9:16
    copy keeps `COMMON_SAFE`.
21. Intermediate arguments (CineForm opaque and alpha, Animation): pixel formats, BT.709 tags,
    `pcm_f32le` audio, `+write_colr` without `+faststart`; `rawSinkFor` gives RGB frames for them.
22. `estimateBytes` for each codec at 1080p60 and 2160p30; `encodeSecondsEstimate` for AV1 at 1080p60;
    the free-space check refuses below 1.2 × the estimate with `disk-full`.
23. **ProRes** (policy switched on inside the test): profiles 1, 2, 3 and 4 with `-alpha_bits 16` or
    0; **no argument list ever contains `-vendor`**; with the policy off (as shipped) neither chip
    exists.
24. `probeCodec` runs once per codec per session, never at start, with each encoder's pixel format;
    `av1_amf` and the `_mf` encoders only on Windows.

**P2 · Transparency**

25. `drawFrame` with `alpha: 'background'`: no background call, the card and recording drawn; with
    `'overlays'`: no card or recording, the camera and overlays drawn; without `alpha` the call log of
    test 4.
26. Readback: a drawn transparent frame read through `alphaRawSink` with `'videoframe'` and with
    `'imagedata'` gives the same bytes; a 50% red pixel reads `[255, 0, 0, 128]` within 1 (straight);
    `unpremultiply` matches `getImageData` on 1,000 random premultiplied pixels; the job's pixel
    format is straight `bgra`.
27. `seeThrough` is false for `auto` with padding 0 and true with padding 40; the hint's message key
    follows it.
28. Joins in a transparent export: a crossfade's middle frame drawn for the dialog's preview and for
    the export is the same; the A\* still is drawn on an alpha scratch target and cached apart from
    the opaque one; a dip at alpha 0.5 halves the picture's alpha (`destination-out`) and leaves the
    overlays; punch-in still scales the content.
29. With the Linux ffmpeg: a 1 s transparent VP9 WebM decoded with `-c:v libvpx-vp9` has alpha 0 in
    the corner and 255 in the card; a CineForm RGBA MOV keeps both.

**P3 · Stems and WAV**

30. The WAV format's soundtrack graph equals the M4A job's graph byte for byte; its output arguments
    are `-c:a pcm_f32le -ar 48000 -rf64 auto -f wav`.
31. With the Linux ffmpeg, on the audio fixtures at 1× speed: the stems' sum equals the soundtrack
    built with `gainDb` in place of `normalize`, residual below −120 dBFS; with a mono-microphone
    fixture and with an effects-only project too (each stem through the mix's channel step).
32. `gainDb` is `20·log10(previewNormalizeGain)`, clamped to ±30; stems are 32-bit float and a peak
    at +3 dBFS is kept.
33. Every stem is exactly `stemSamples(frames, fps)` long at 24, 25, 30, 60 and 120 fps, and starts at
    sample 0.
34. Which stems: a project without separate files gives `recording`; default stem gains still give
    `voice` and `system`; silent stems are left out; Clean voice gives the cleaned file;
    `stemPlan(…, ['music', 'effects'])` writes those two only.
35. `stemPaths` adds " (2)" for taken names and never returns the video's path; cancelling removes the
    stems written so far and keeps the video.

**P4 · Timelines**

36. `recordingsTimeline` on a project with 1,000 clips at mixed speeds and 3 pause freezes: the last
    event ends on the video's last frame; no gap or overlap; holds have speed 0; crossfades become
    dissolves; source frames on each source's own grid, for a 30 fps and a 60 fps capture and a 25
    fps imported video; the size is the screen recording's; V2 is disabled.
37. `fcpxml` equals the golden file for the export mode with and without stems (V1 `srcEnable="video"`
    only with stems) and for the recordings mode (speed, hold, dissolve, chapter markers, roles, a
    Bangla name, `hasAudio="0"` on `Screen.mp4` and `Camera.mp4`, V2's clips `enabled="0"`); the
    golden file was checked against Apple's FCPXML 1.10 DTD with `xmllint --dtdvalid` when it was
    made.
38. `xmeml` equals its golden files (time remap, markers, `pathurl` form; no audio clip items for V1
    with stems and present without; V2 `<enabled>FALSE</enabled>`; sequence size equal to V1's).
39. `edl` and `markerEdl` equal their golden files; `FCM: NON-DROP FRAME`; CRLF; one event; a 120 fps
    export's source timecode at 60; `markerEdl` only when `resolve` is among the editors, named
    `<base> - Resolve markers.edl`; a Bangla chapter becomes "Chapter 2" in the marker EDL only.
40. `fileUrl` for `C:\Users\রহিম\My Videos\a#b.mp4`; `xmlText` and `xmlAttr` escape `<`, `&`, `"`,
    `'`, drop U+0001, U+000B, U+FFFE and a lone surrogate, and write a newline in an attribute as
    `&#10;`; the result parses with an XML 1.0 parser.
41. Export mode: V1 the video, the stems as audio tracks and `pictureOnly` true; without stems
    `pictureOnly` false and no audio tracks; chapter markers in timeline frames.
42. `copyRecordings` copies (never links), remuxes `screen.mp4` and `webcam.mp4` with `-an`, converts
    mic and system to WAV with ffmpeg, uses the cleaned voice with Clean voice on, renders Music and
    Effects only when stems are off, checks free space first, and never opens a project file for
    writing.
43. Rates: an export at 120 fps gives a 60 fps timeline; 24 and 25 are exact.
44. `writeTimeline` refuses a `videoPath` this session did not export, a stem path not next to it, and
    a plan `checkTimelinePlan` refuses (a non-integer frame, `recIn ≥ recOut`, overlapping events,
    20,001 events, a 501-character name), writing no file; it refuses a plan whose rates or sizes
    disagree with ffprobe.

**P5 · Export dialog and presets**

45. `savePreset`, `renamePreset`, `updatePreset`, `deletePreset`, `importPresets`: the 50 limit,
    `uniqueName` (" (2)", NFC), ids, `saved`; subtitle languages never stored.
46. `batchItems` with user presets gives "{project} - {preset name}.{ext}" through `safeFileName`; a
    Bangla name stays Bangla.
47. `settingsRows`: the HEVC chip probing (disabled), found (enabled) and none (absent); `usableCodec`
    turns stored HEVC into H.264 with its notice when none was found; MP4 shows no Background row;
    `pickBackground` on MOV/H.264 picks CineForm and on WebM/AV1 picks VP9 in the same step, and
    *With background* gives the replaced codec back; `pickCodec` back to a non-alpha codec resets
    Background; 4K at 120 fps with H.264 is disabled, and `pickResolution` to 4K at 120 sets 60; the
    intermediates show Best · High · Medium.
48. `stemsBlocked` and `timelineBlocked` for GIF, batch, one file per chapter and a silent project;
    stems allowed and timelines blocked ("Timelines need a video") for M4A and WAV; `editorBlocked`
    for Final Cut Pro with WebM and with AV1 in MP4, and for EDL with the recordings;
    `editorWarning` for each `'unchecked'` cell of `EDITOR_OPENS`; `timelineKindsFor(['resolve',
    'finalcut'])` is one `fcpxml`.
49. `sizeLine` adds the codec only when it is not the default ("1080×1350 · 30 fps · HEVC · 2:14").
50. `portrait-post` gives MP4, 1080, 30 fps, Studio, 4:5; `editing` and `overlay` give MOV, CineForm
    (and Overlays only) and are absent with `CODEC_POLICY.cineform` off; `matchesPreset` and
    `tweakOptions` keep each selected and drop it on any change, a codec or alpha change included;
    `matchesUserPreset` keeps a colleague's HEVC preset selected on a PC that exports it as H.264,
    and batch flags it before starting.

**P6 · Language runtime, settings and fonts**

51. `resolveUiLanguage`: absent and `'en'` → English; `'system'` with `['bn-IN', 'en-US']` → `bn` when
    shipped, English when not; a language without a built catalogue → English; `offer` only when
    `language` is absent and the language is not in `offered`, and also when Windows lists only
    English but a Bangla speech model is installed or `seen` holds `bn`; `preview` follows
    `shipped.json`.
52. `formatLocaleOf`: `bn` + `bn-BD` + Western → `bn-BD-u-nu-latn`; `bn` + `en-US` → `bn`; `hi` + native
    → `hi-u-nu-deva`; `Intl.DurationFormat` with the tag gives Western digits where the option alone
    does not.
53. `fmt` in `bn`, `bn-u-nu-latn`, `hi` and `es` over the grids of §11.3 (the empty cells recorded);
    Bangla dates with full month names and the reviewers' time form; `fmt.clock` in Bangla digits;
    units stay Latin.
54. Plurals: a message with bn `other` only, es one/many/other and ar's six categories selects as
    `Intl.PluralRules` does for 0, 1, 2, 3, 11, 100 and 1,000,000; every Bangla plural of the built
    catalogue formats count 0 without a number word.
55. The built catalogue loads; a key it lacks formats English; `setCatalogue` before the first render;
    `bootLanguage` renders English when `ui:info` fails or the catalogue import takes longer than
    1.5 s.
56. Main: dialog titles, filter names, notification texts and taskbar tooltips come from main's
    catalogue in `bn`, and equal today's English in `en`.
57. Language section: absent while only English ships; choosing বাংলা writes `ui.language: 'bn'` and
    shows the restart notice; Restart now calls `relaunch` and shows its reason when refused; Follow
    Windows names the language it would give; the heading reads "ভাষা · Language" in the Bangla UI.
58. The offer: shown once when Windows lists a shipped language, or a Bangla speech model is
    installed, and `language` is absent; *Not now* writes `offered`; *Use Bangla* writes the language
    and relaunches, or, while Home records or processes, says Flown opens in Bangla next time.
59. Fonts: `loadUiFont('bn')` registers "Flown UI Bengali" from the bundled file with no new asset
    in the build output; `scripts.css` raises the tokens and adds the face to `--font-mono` under
    `:lang(bn)` only.
60. **No network**: a Bangla session through the tour with every request logged makes no request
    outside `file:`, `studio-media:` and the dev server; no source file under `src/` imports from
    `scripts/i18n/`.

**P7 · Checks and translation tools**

61. The scanner finds JSX text, each listed attribute, each sink (`confirm`, `window.confirm`,
    `alert` and a `confirm:` property included), a `t()` at module scope and a locale-less
    `toLocaleString` in fixture files; ignores `new Intl.Segmenter(undefined, …)` and allowed
    literals; reports the other account's files as pending; fails a `failFor` file before S4.
62. The catalogue checks reject: a parse error, a missing or extra placeholder, a missing `other`, a
    category the language lacks, a Bangla `one` branch holding "একটি", `#`, `'{`, a dropped
    do-not-translate term, a bidi control, a non-NFC text, a native digit in a `digits: 'latn'`
    message, `<script>`, a text over `maxLength` in graphemes, a lost blank line, Latin words or a
    `?` run in a `bn` text; they accept ZWJ and ZWNJ.
63. English checks: an unused key, a used key that does not exist, a missing meta entry, a merge group
    without `.whole`.
64. `en-XA` adds 40% and brackets and keeps placeholders; `bn-XA` writes Bengali letters with reph,
    chandrabindu and below-base forms and keeps placeholders; `ar-XB` keeps placeholders and sets
    `rtl`.
65. `i18n:build` takes only `approved` strings with a current `sourceHash`, both `reviewedBy` and
    `approvedBy` set, different and listed in `reviewers.json` for the language; it drops a string
    approved by its own reviewer or by an unlisted person; `--check` fails on a stale built file;
    `shipped.json` follows the 95% and core rules of §15.6 and sets `preview` while `recording` is not
    approved.
66. The review sheet: export writes a byte-order mark and puts an apostrophe before `-3 dB` and
    `=SUM(A1)`; import removes it, round-trips without loss, refuses a file with U+FFFD or invalid
    UTF-8, refuses a row of `????`, a Bangla row with no Bengali letter and a row that fails the
    checks, records who and when, and refuses one person as reviewer and approver.
67. `ReviewOverlay` renders nothing in a packaged build or without `FLOWN_I18N_REVIEW`.
68. `predist.mjs` fails when `config.json` says `"fail"` and a string has no key; `verify-dist` fails
    when the built catalogues grow by more than 1 MB.

**Extraction parts** (§21.8)

69. Every row of `scripts/i18n/log/*.json`: the English message formatted with the row's sample
    values equals the literal it replaced; for plurals, the samples 0, 1, 2 and 1000 each.
70. The command palette finds a command by its UI-language title, its English title and its English
    keywords, comparing NFC forms (য় typed either way); `COMMAND_CATEGORIES` stays the same list of
    ids; categories' English labels are today's; *Language…* exists only when the section does.
71. `withShortcut`, `orPress`, `reviewHint`, `undoHint`, `zoomLevelKeysHint` give today's English
    for the default keymap and for an edited one; in `bn` the keycaps stay Latin.
72. **Error codes and the recording side's text**: for every English message main can produce for an
    export (the `KNOWN_ERRORS`, the `toIpcError` and `renameError` texts, `validateJob`'s), the
    code-based fallback decision equals today's `NOT_ENCODER_RELATED` regex decision; cancel,
    `startsWith` and LUT-question decisions work with `en-XA` messages; `camera.corner.*` in English
    equals `CORNER_NAMES`; Home's source refresh decides as today for `SOURCE_GONE` and both texts of
    `recordingIpc.ts:204-205`; `friendlyError` text is wrapped in `lang="en"` in `bn` only.
73. Every formatter call site in `scripts/i18n/fmt-sites.json` gives the same English as the helper it
    replaced over the grids of §11.2.
74. **The recording side is untouched**: `git diff` of their files against the S2 base is empty;
    `formatTime(3725.4, false)` and the `ffmpeg.ts` messages are unchanged; the scanner lists them as
    pending.
75. Main's messages (dialogs, filters, notifications, taskbar) in English equal the main-process
    strings recorded by the guard tour.
76. Under `ar-XB`: the inspector's labels start on the right; the timeline, ruler, preview and
    transport keep `direction: ltr`; under English test 10 passes.
77. Changing the UI digits does not change caption rendering: `drawFrame` call logs of a Bangla
    caption project are the same with `ui.digits` native and Western.
78. `KIND_WORDS` as plural messages give today's English for 0, 1, 2 and 1000 of each kind.

**Added with this wave's runtime and checks** (owners in §21)

79. **Relaunch** (P6): `relaunchBlocker` gives each `BUSY_COPY` reason and the download reason; a
    refused relaunch quits nothing; a relaunch with a project id passes `--flown-open=<id>`, and
    `uiInfo().reopen` returns it once.
80. **`askConfirm`** (P6): in English it calls `window.confirm` with exactly the message (recorded by
    the hook) and nothing else; in `bn` it calls `ui:confirm` with the translated action and Cancel
    labels and returns the choice.
81. **Encoder allow-list** (P1): every `-c:v` and `-c:a` value the argument builders can emit, over
    every table, quality, size target and policy setting, is in `ALLOWED_ENCODERS`; `libx265` and
    `prores_ks` appear only with their policy flags on.
82. **Digits per message** (P6): in `bn` with native digits, a `digits: 'latn'` message given
    `fmt.count(1080)` shows "1080"; a prose message shows "১০৮০"; with Western digits both show
    "1080".
83. **Number fields** (P6): `fmt.parseNumber` reads "২৫", "२५", "25" and " 25 " as 25 and "2৫x" as NaN;
    `NumberField` in English renders the same `<input type="number">` attributes as the site it
    replaces; in `bn` a text field with `inputmode="decimal"` that shows "২৫" and steps within `min`
    and `max` with ArrowUp and ArrowDown.
84. **Canvas language** (P6): after `pinCanvasLanguage()`, a new canvas has `lang="en"` and its 2D
    context `lang` is `'en'` where the property exists; English never installs the hook.
85. **Merge groups** (P7): every `merge: true` group in English has a `.whole` message; the build's
    report counts groups per namespace; `shipped.json` leaves out a language with an unapproved
    `.whole` in a core namespace.
86. **Bundles** (P7): the import graph from `src/main/index.ts` uses only `common`, `errors` and `main`
    keys; the preload imports nothing from `src/shared/i18n`; no file under `src/` imports a
    `.meta.json`.

### 23.2 Equivalence guards

Tests 1–4 are written in the contracts commit against the code after waves 10 and 11 have merged, in
`tests/outputEquivalence.test.ts`, before any shared file changes. Tests 9 and 10 have their baseline
recorded at S2. With the earlier guards (`verticalEquivalence`, `captionsStudioEquivalence`, wave
10's and wave 11's) they must pass after every part merges. Snapshots are never regenerated to make a
change pass.

### 23.3 End to end: `tests/e2e/output-formats.e2e.cjs`

**Fixtures**: the 10 s, 30 fps render fixture at 1280×720 with a 40 px padding, a gradient background,
a camera, captions, two chapters, music and clicks; mic and system stems; a second project at 9:16; a
third with a 2× clip, a pause freeze and a crossfade (wave 10). Exports go to a temporary folder.

1. **F1 Old settings unchanged.** With the previous release's stored `export-settings` (MP4, 1080, 60
   fps, Studio), export: the file's codec, size, frame count and ffprobe tags equal the previous
   release's export of the same project; localStorage values are byte for byte the same after closing
   the dialog.
2. **F2 HEVC chip.** On Linux (no GPU, no WebCodecs HEVC): after the probe the HEVC chip is absent and
   no line mentions HEVC; with stored `export-settings` holding `codec: 'hevc'`, the line "This PC
   cannot make HEVC, so this export uses H.264." shows and the export is H.264.
3. **F3 AV1.** MP4 + AV1 + Software at 720p: ffprobe shows `av1`, the hint gives a time for this
   video; WebM + AV1 likewise.
4. **F4 Frame rates and 4:5.** 24, 25 and 120 fps exports have 240, 250 and 1,200 frames; 4:5 at 1080
   is 1080×1350; the Portrait post destination gives the same file; its captions sit where the
   dialog's preview shows them, not in `COMMON_SAFE`.
5. **F5 Transparent WebM.** Background *Transparent*, WebM: decoded with libvpx, the corner pixel has
   alpha 0 and the card's centre 255; the dialog's preview canvas at 1.0 s matches the decoded frame
   within 2 percentage points per colour class.
6. **F6 Edges.** A shadow pixel's decoded alpha is within 3 levels of the alpha the dialog's preview
   canvas holds at the same place (straight alpha end to end); a red card-edge pixel keeps its hue
   within 10° (no dark fringe).
7. **F7 Overlays only, CineForm, joins.** MOV + CineForm + *Overlays only*: the caption and camera are
   opaque, the rest transparent; ffprobe shows `cfhd` and `gbrap12le`. On the crossfade project the
   middle frame of the crossfade, decoded, matches the dialog's preview at the same time within 2
   points per colour class: the crossfade is kept.
8. **F8 Stems.** *Also save → Sound stems*: Voice, System sound, Music and Effects are written, each
   exactly 480,000 samples, float, 48 kHz; their sum equals a render of the same graph with the fixed
   gain within −90 dBFS; a silent project shows the blocked reason; with M4A, stems are offered and
   Timeline says "Timelines need a video".
9. **F9 WAV format.** The WAV file is 32-bit float; its samples equal the M4A export's decoded samples
   within AAC's error (correlation ≥ 0.999) and its length is the video's.
10. **F10 Timelines, export mode.** Open in Resolve, Premiere and Other: `Demo.fcpxml`, `Demo.xml`,
    `Demo.edl` and `Demo - Resolve markers.edl` written next to the video; each names the video and
    stems by absolute path; the FCPXML's V1 has `srcEnable="video"` with stems and not without;
    chapter markers at 0 and 5 s; the done view shows each file's line on how to open it.
11. **F11 Timelines, recordings mode.** `<base> media\` holds the copies and WAVs; ffprobe finds no
    audio stream in `Screen.mp4`; the FCPXML's 2× clip has a `timeMap` and its V2 clips
    `enabled="0"`; the sequence is the screen recording's size; the EDL chip is disabled with its
    reason; the project folder's files are unchanged (bytes and modification times).
12. **F12 Presets.** Save as preset "Client review" (MOV, CineForm, stems on), close and reopen the
    dialog: the preset is there, above the destinations; Save to a file, delete, Import: it comes
    back; a 70 KB file is refused with "This file is too large to be a Flown preset file."; a file
    with a ProRes preset imports as CineForm with the notice of §2.2.
13. **F13 Keyboard only.** Reach Codec, Background and Frame rate with Tab, change them with arrows,
    reach *Save as preset* as its own stop after the Settings header, open a preset's menu with
    Shift+F10 and close it with Escape: focus returns to its button.
14. **F14 Offline.** The whole file runs with network requests blocked and logged: none.
15. **F15 Editors.** WebM + Timeline: the Final Cut Pro chip is disabled with "Final Cut Pro cannot
    open VP9 files. Choose H.264 or HEVC."; MOV + Lossless + Premiere Pro shows the "Not checked yet"
    line.
16. **F16 MP4 and transparency.** MP4 shows no Background row; the *Transparent overlay* destination
    gives MOV, CineForm, Overlays only; on MOV + HEVC, *Transparent* switches to CineForm and *With
    background* switches back to HEVC (with a fake probe that found `hevc_nvenc`).

### 23.4 End to end: `tests/e2e/languages.e2e.cjs`

Run with a test catalogue built from the `en-XA` pseudo-locale plus a small Bangla fixture catalogue
(`tests/fixtures/i18n/bn.json`, approved by the fixture, not a real translation), selected with
`SSW_I18N_CATALOGUE_DIR` in an unpackaged build, and a fixture `shipped.json`.

1. **L1 English by default.** No `ui` preference: `<html lang="en">`, no catalogue chunk requested;
   with an empty shipped list, Settings has no Language section and the palette no *Language…*.
2. **L2 Settings › Language and restarting.** Choose বাংলা: the restart notice appears
   (`role="status"`). Start an export, press Restart now: the notice adds "Finish or stop the export
   first.", Flown keeps running and the export finishes. Press Restart now again from the editor:
   Flown relaunches with `<html lang="bn" dir="ltr">`, the same project open, and a Home string from
   the fixture catalogue.
3. **L3 Fallback.** A key the fixture lacks shows its English text.
4. **L4 Fonts and height.** `document.fonts.check('16px "Flown UI Bengali"')` is true; a label with ঁ
   and র্ has its ink inside its box at 100% and 150% zoom; the timecode's digits resolve to Flown UI
   Bengali and the ten digits have one width; under `bn-XA` no element of the tour overflows its box
   in height or width, fixed-height controls included.
5. **L5 Digits.** A 2:05 duration shows "২:০৫"; the size line keeps "1080×1350 · 30 fps"; typing
   "২৫" into Target size gives 25 MB; after choosing Western digits and restarting, "2:05", and "২৫"
   typed still gives 25; `1080p` and `60 fps` stay Latin in both.
6. **L6 Keys.** Shortcut labels show "Ctrl + Z"; `aria-keyshortcuts` sits only on controls whose
   tooltip does not name the shortcut.
7. **L7 Main strings.** The export save dialog's title and filter names (recorded by the test hook)
   and a finished-export notification are in Bangla.
8. **L8 Offer.** With `SSW_PREFERRED_LANGUAGES=bn-BD,en-US` and no `ui` preference, Home shows the
   offer once; *Not now* hides it for good; its Bangla parts have `lang="bn"`. With
   `SSW_PREFERRED_LANGUAGES=en-US` and the Bangla speech model fixture installed, the offer shows
   too; *Use Bangla* during processing says Flown opens in Bangla next time and does not quit.
9. **L9 Overflow.** Under `en-XA`, no element in the tour overflows its box, and no plain ASCII text is
   left outside the recording panels, brand, editor and codec names.
10. **L10 Right to left.** Under `ar-XB`: panels mirror; the timeline and preview do not; nothing
    overlaps.
11. **L11 Recording side.** In Bangla, the recording panels on Home and the recording bar are English
    with `lang="en"`, and their text equals the English baseline; a `friendlyError` message shown on
    Home sits in `lang="en"`.
12. **L12 Exports stay English.** A batch export in Bangla writes the same file names and the same
    description sidecar as in English.
13. **L13 Drawn frames.** The same frame exported (PNG through the thumbnail path) in `bn` and in `en`
    is byte for byte the same, captions included; so are the dialog preview canvas's pixels.
14. **L14 Confirmations.** In Bangla, deleting a project asks through the recorded `showMessageBox`
    with the buttons "মুছুন" and "বাতিল"; in English, through `window.confirm` with today's text.
15. **L15 Mixed digits.** No text node of the Bangla tour holds both 0–9 and ০–৯ outside
    do-not-translate identifiers.

---

## 24. Later

- An `ffmpeg.exe` built in CI from a public script, without libx265, the HEVC decoder and the unused
  patent-relevant libraries, with HEVC import through Windows' own decoder or a clear refusal (§0
  decisions 1 (c) and 3), in the first release after wave 12.
- Arabic and Hebrew, after a right-to-left review of every screen with the `ar-XB` pass as its start.
- The recording side's strings, once the other account agrees; then Bangla leaves preview.
- A "language of exported files" choice (file names, sidecars, stem and chapter names, and wave 11's
  guide words for Spanish and Hindi), starting from `outputWords.ts` (§10.3).
- Bidi isolation in the English UI, for project names in right-to-left scripts (§13.3).
- The English changes listed in `scripts/i18n/english-changes.md` ("Bengali" to "Bangla" in the
  captions lists, and the `merge` groups whose English must change to become one message), each with
  the owner's approval.
- A Bangla installer through custom NSIS language files.
- ProRes, if Apple licenses it (§0 decision 2); DNxHR once its patent position is known.
- SVT-AV1 with a different `ffmpeg.exe` build.
- A picture-in-picture transform for the camera in recordings-mode timelines, once Flown's camera
  path can be written as keyframes; an EDL over the recordings.
- OpenTimelineIO files, once Premiere's import is settled.
