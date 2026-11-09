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
- **Codec**: the video compression inside it (H.264, HEVC, AV1, VP9, CineForm, Animation, ProRes).
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
- **Shipped language**: a language whose approved messages reach the picker's threshold (§15.6).

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
  already inside the shipped `ffmpeg.exe`; §5.1 lists each one with its licence and patent position,
  and §0 decisions 1–3 are the owner's.
- The installer grows by about 0.3 MB (§19.5). No item reaches the 5 MB line.
- **The English UI does not change while the strings are extracted**: same text, same accessible
  names, same layout. Two guards written before any extraction prove it after every extraction
  commit (§10.6, tests 9 and 10).
- Nothing on the recording side changes: `src/main/recording/*`, `src/main/recordingIpc.ts`,
  `src/main/windows.ts`, `src/shared/recording/*`, `Toolbar.*`, `src/renderer/src/recorder/*`
  (`RecordingOptions.tsx`, `RecordingPresets.tsx` among them) and `src/main/appSettings.ts` belong to
  the other account. Their strings stay in English until the other account agrees; the catalogue
  reserves a namespace for them so they can join without changes elsewhere (§9.5).
- `src/main/security.ts` and the CSP do not change.

The research behind this design is kept outside the repository, in the lead's scratch folder
`w12-design/`: `code/` (the code map, the `ffmpeg.exe -encoders` and `-h encoder=…` dumps run under
wine, the test encodes, the WebCodecs and Intl probes in Electron 44.9.3, the string inventory
`strings.cjs` with `strings-w12.json` and `strings-w10.json`), `formats/` (the encode benchmark
`bin/bench.sh`, the per-encoder dumps `win-enc-*.txt`, and `otio/` with `flown-1.10.fcpxml`, which
validates against Apple's FCPXML 1.10 DTD, `flown.xml`, `flown.edl` and `flown-markers.edl`) and
`i18n/` (the AST counts, the Intl and plural probes, the bundle-size builds, the Bangla rendering and
digit-width screenshots, and the text of Microsoft's Bangla (India) style guide).

---

## 0. Decisions for the owner

Nothing in this wave changes how an existing project looks or sounds, and nothing changes the English
UI that exists today. Every new codec runs through an encoder already inside the shipped `ffmpeg.exe`
(gyan.dev 6.1.1 "essentials", GPL v3, 82,797,568 bytes, pinned in `scripts/lib/packaging.cjs:18-22`).
The installer grows by about 0.3 MB.

1. **HEVC (H.265).** The shipped `ffmpeg.exe` **already contains** the x265 software encoder
   (x265 3.5+113, GPLv2+) and FFmpeg's HEVC decoder; Flown has distributed both since it shipped, and
   import already decodes HEVC (`FEATURES.md:117`). Access Advance's HEVC Advance programme (overview of
   July 2025) charges royalties on "HEVC Software Sold separately from a device": $0.80 a copy in
   Region 1 and $0.40 in Region 2 with its trademark discount, $0.889 and $0.444 without. It took over
   Via LA's HEVC/VVC pool on 15 December 2025. Independent holders (Nokia, InterDigital, Ericsson) are
   suing PC makers, and Dell and HP have turned off hardware HEVC on some PCs. A hardware encoder
   reached through the graphics driver (NVENC, Quick Sync, AMF) or a hardware Media Foundation
   encoder is the PC maker's licensed product; the app ships no HEVC encoder of its own for it.
   Choices:
   - (a) **HEVC through hardware only**: WebCodecs HEVC (Chromium's platform encoder, hardware only),
     then `hevc_nvenc`, `hevc_qsv`, `hevc_amf`, then `hevc_mf` with `-hw_encoding 1`. When none works,
     the HEVC chip is off and says why; the app never falls back to x265. **Recommended.**
   - (b) Also offer x265 in software, and take an HEVC Advance software licence and the risk from
     independent holders.
   - (c) Build a custom `ffmpeg.exe` without libx265 (and decide about the HEVC decoder), so no HEVC
     software encoder is distributed at all. It changes the pin, the notices and the release checks.
     **Recommended for a later release, whichever of (a) or (b) is chosen now**, because the binary
     shipped today contains x265 either way.

   The constant `CODEC_POLICY.hevcSoftware` (`src/shared/render/proFormats.ts`) is `false` for (a);
   (b) is that constant and one test fixture.
2. **ProRes.** FFmpeg's `prores_ks` and `prores_aw` are independent implementations. Apple's ProRes
   white paper (April 2022) calls them unauthorised and warns about "decoding errors, performance
   degradation, incompatibility, and instability". Licensing goes through ProRes@apple.com; "ProRes" is
   Apple's trademark. There is no hardware ProRes encoder on Windows. Choices:
   - (a) Apply to Apple for a licence and its encoder.
   - (b) Ship `prores_ks`, named honestly ("ProRes 422 (FFmpeg's encoder, not certified by Apple)"),
     never with `-vendor apl0`, which would make a file claim Apple made it.
   - (c) **Leave ProRes out of wave 12 and offer CineForm as the editing format.** CineForm is open
     (the GoPro SDK is Apache-2.0 or MIT; FFmpeg's `cfhd` encoder is part of FFmpeg), Premiere Pro and
     DaVinci Resolve read and write it natively on Windows, and it carries transparency.
     **Recommended.** `CODEC_POLICY.prores` is `false`; (b) is that constant, the two chips and their
     tests, already written (§5.4).
3. **The GPL source offer for `ffmpeg.exe`** (not new with this wave, made more visible by it).
   `resources/THIRD_PARTY_NOTICES.txt:338-345` points to ffmpeg.org and the ffmpeg-static release page
   for source. GPLv3 §6 asks for the Corresponding Source of the exact binary: FFmpeg 6.1.1 plus x264,
   x265, libaom, libvpx, the other enabled libraries and the build scripts. **Recommended**: keep that
   source bundle with each Flown release (a release asset of this repository) and point the notice at
   it. The exact files are listed in gyan.dev's build notes (`ffmpeg.exe.README`, installed next to
   the binary).
4. **DNxHR** (`dnxhd`, in the build) is not offered. Avid's patent position was not checked.
   **Recommended: leave it out.**
5. **Which languages ship, in which order.** Bangla first, written in Bangladesh's standard forms
   (আপনি, no Sadhu bhasha, Mozilla's bn-BD and Microsoft's Bangla style guides), one `bn` catalogue
   for Bangladesh and India. Then Spanish (`es`) and Hindi (`hi`) as soon as each has its two
   reviewers. Arabic and Hebrew wait until the right-to-left layout has had its own review (§13).
   **Recommended.**
6. **Who reviews.** Two native speakers per language: a translator-reviewer who corrects the AI draft
   in context, and an approver who signs each string off (§15). For Bangla, the owner and one more
   person; for Spanish and Hindi, two people each whom the owner finds. The UI is about 22,000–25,000
   English words before waves 10 and 11 (§10.1), of which about 10,000–12,000 are seen by most users;
   at 3,500–5,000 post-edited words a day that is 3 to 6 reviewer-days per language for the core
   surfaces, plus a second pass. **Recommended.**
7. **What ships untranslated** (§9.7): brand names, codec and file-type names, technical identifiers,
   keycap names, AI prompts, logs, third-party notices, the user's own content, text written into
   exported files, the recording side's UI until the other account agrees, and any string not yet
   approved (shown in English, string by string). A language appears in the picker when 95% of its
   keys and 100% of the core namespaces (`common`, `keys`, `home`, `editor`, `timeline`, `export`,
   `settings`, `language`, `errors`, `main`; §9.2) are approved. **Recommended.**
8. **The default language.** A missing language setting means English, on existing **and** new
   installs, so nothing changes until the user picks. Settings offers "Follow Windows" and each
   shipped language; Home offers a shipped language once when Windows lists it among the user's
   preferred languages (§2.7). Alternative: new installs follow Windows by themselves. Most Bangladeshi
   PCs run English Windows (Windows 11 has a bn-IN display pack and no bn-BD one), so an automatic
   switch would rarely help them and would surprise others. **Recommended: offer, never switch.**
9. **Digits in the Bangla UI.** Bangla digits (০–৯, CLDR's default for `bn`) for counts, sizes,
   durations, dates, percentages and the timecode; Latin digits always for technical identifiers
   (1080p, 16:9, H.264, 60 fps, 4K, version numbers, keys). Western digits are one choice in Settings.
   Hindi uses Latin digits by default (CLDR's default for `hi`) with Devanagari digits as the choice.
   **Recommended.**
10. **Exported files stay English.** File names (batch preset labels, "Chapter 3", " - chapters.txt",
    stem names), descriptions written into files, subtitle stream names and chapter fallbacks do not
    follow the UI language in this wave, so the same project exports the same files on every PC.
    Alternative: a "language of files" choice per export. **Recommended: English now; revisit when
    Bangla users ask.**
11. **The recording side** (22 files, 310 unique texts, §9.5) stays English in a translated UI until
    the other account agrees: Home's Recording options and presets panel, the recording bar, region
    picker messages, recording errors and key-press names. **Recommended: ask the other account now;
    ship Bangla either way, with one line in the Language section saying the recording controls are
    not translated yet.**
12. **What changes in the English UI.** No existing text, name or layout. New English text appears only
    with new controls (§2). Two things are left as they are on purpose: the language is called
    "Bengali" in `captionTracks.ts:82`, `CaptionsPanel.tsx:71` and `FontPicker.tsx:34,50` but "Bangla"
    in `SPEECH_TIER_NAMES`; and nothing gains bidi-isolation characters in English (§13.3). One
    invisible addition: buttons with shortcuts gain `aria-keyshortcuts` (§14.2), which screen readers
    announce after the name; the names themselves do not change. **Recommended: add it.**
13. **Stem loudness.** Today's export normalises the recording with `loudnorm`, whose gain moves over
    time; stems normalised that way do not add up to the mix (measured residual −23.7 dBFS RMS). Stems
    therefore use one fixed gain, the one the preview already plays (`previewNormalizeGain`,
    `src/shared/audio/soundtrack.ts:154`); the stems then add up to the preview's sound exactly
    (residual −165 dBFS) and differ from the video's soundtrack only by `loudnorm`'s riding.
    **Recommended: accept.**
14. **Measurements and round trips after the build** (required before release):
    - on the reference Windows PC: the quality values of every GPU encoder of §5.4 (none could run
      here: no GPU), WebCodecs HEVC and AV1 on Windows, `av1_amf`'s 1080-line padding, the alpha
      export's speed, the Bangla UI on Windows 10 and 11, and NVDA with eSpeak NG reading it;
    - importing each timeline file into DaVinci Resolve (free, Windows), Premiere Pro (Windows) and
      Final Cut Pro (a Mac). The owner provides Premiere and a Mac, or the feature ships labelled
      "tested with DaVinci Resolve" until they are available.
15. **Installer size.** Nothing in this wave grows the installer by more than 5 MB; all of it adds
    about 0.3 MB (§19.5). Two things that would grow it were considered and are not proposed: adding
    Chromium's locale packs (8.7 MB for all 55, 269 KB for Bangla alone; they would also turn today's
    locale-less dates and numbers into Bangla digits in the English UI on a Bangla Windows, §3.2 row
    19), and a different `ffmpeg.exe` build for SVT-AV1 (a new pinned binary and new release checks).
    **Recommended: neither.**

---

## 1. Summary

- **More codecs.** MP4 gains HEVC and AV1; MOV gains HEVC, CineForm and QuickTime Animation; WebM
  gains AV1. A new **Codec** row under Format picks them; each format's old codec stays its default,
  so saved settings export exactly as before. HEVC runs only on hardware encoders (§0 decision 1).
  AV1 uses the graphics card when it can and libaom on the CPU otherwise (slower, and the dialog says
  by how much). ProRes is built but off (§0 decision 2).
- **Transparent video.** A **Background** row: *Drawn* (today), *Transparent* (no background: the
  card, camera and everything over it stay, the rest is see-through) or *Overlays only* (captions,
  texts, shapes, title cards and the camera, without the recording). Transparent files are WebM with
  VP9 (for web pages) or MOV with CineForm or Animation (for editing software). The same `drawFrame`
  draws them; the dialog's preview shows them over a checkerboard.
- **4:5 and more frame rates.** A 4:5 export shape (1080 × 1350 at 1080p) in the Aspect row, the batch
  "Also" row and a new **Instagram post** destination; 24, 25 and 120 fps beside 30 and 60.
- **Saved presets.** "Save as preset" keeps the current settings under a name; *Your presets* sit
  under the destinations, can be updated, renamed, deleted, saved to a `.flownpreset` file and
  imported from one. An imported file is untrusted data, read through a strict reader (§18.2).
- **Sound stems.** *Also save → Sound stems (WAV)* writes one 32-bit float WAV per sound: voice,
  system sound, music, effects (or one recording stem). They start at 0, have the video's exact
  length, and add up to the sound the preview plays. A new **WAV** format saves the soundtrack alone,
  uncompressed.
- **Timelines for other editors.** *Also save → Timeline* writes FCPXML 1.10 (Final Cut Pro, DaVinci
  Resolve), Premiere XML (Premiere Pro, Resolve) and/or a CMX 3600 EDL, with chapter markers. They use
  either **this export** (the finished video and the stems, correct in every editor) or **the original
  recordings** (cuts, speed changes, pause freezes and crossfades over copies of `screen.mp4`,
  `webcam.mp4` and WAV conversions of the microphone and system sound; zooms, cursor effects,
  backgrounds, captions and layouts are not carried, and the dialog says so).
- **Flown in other languages.** Every UI text moves into JSON catalogues of ICU messages, read by one
  small runtime shared by main, preload and renderer (`intl-messageformat` 12.1.4, BSD-3-Clause,
  9.8 KB gzip). Settings gains a **Language** section (Follow Windows, English, বাংলা, and later
  Español and हिन्दी) and a digits choice; the change applies when Flown restarts. Numbers, dates,
  durations, lists and plurals follow each locale through Intl, and the English UI keeps its exact
  formatting. Bangla uses the bundled Noto Sans Bengali (0 new bytes) with taller lines.
- **Ready for right to left.** CSS moves to logical properties (identical in left-to-right), the page
  gets `lang` and `dir`, the timeline and preview stay left to right, user text is isolated, and a
  mirrored pseudo-locale checks it. No right-to-left language ships in this wave.
- **Translations drafted by an AI service, approved by people.** Drafts are made at development time
  only, with a glossary, descriptions and screenshots; two native speakers correct and approve each
  string in context; only approved strings ship, and anything else shows in English.
- **Checks.** A TypeScript-AST scanner fails the build on any UI text without a key; catalogue checks
  cover syntax, placeholders, plurals, length, glossary terms and stale translations; both run in a
  new CI workflow and in `scripts/predist.mjs`.

---

## 2. What the user sees

### 2.1 Export dialog › Settings

The Settings section of the export dialog (`ExportDialog.tsx:829-960`) keeps its rows and their order.
Two rows are new (Codec, Background), three gain chips (Format, Aspect, Frame rate), and Quality,
Target size and Encoder adapt to the codec. Rows that do not apply are hidden, as GIF and M4A hide
rows today.

**Format** (today: MP4 · MOV · WebM · GIF · M4A). One chip is added at the end:

| Chip | Title (exact) |
|---|---|
| WAV | The soundtrack only, uncompressed (24-bit WAV), nothing is rendered |

The other format chips keep their titles; the Codec row's titles describe the new codecs.

**Codec** (new, under Format; shown for MP4, MOV and WebM). `Choice` chips:

| Format | Chips, in order (default first) |
|---|---|
| MP4 | H.264 · HEVC · AV1 |
| MOV | H.264 · HEVC · CineForm · Animation (· ProRes 422 · ProRes 4444, only with §0 decision 2 (b)) |
| WebM | VP9 · AV1 |

| Chip | Title (exact) |
|---|---|
| H.264 | Plays everywhere |
| HEVC | About a third smaller than H.264 at the same quality. Made by your graphics card. Windows needs Microsoft's HEVC Video Extensions to play it |
| AV1 | About half the size of H.264 at the same quality. Fast with a recent graphics card, slower without one. Plays in browsers, on YouTube and in Windows 11 |
| VP9 | Plays in every browser |
| CineForm | For editing in Premiere Pro, DaVinci Resolve and After Effects: large files that stay sharp through more editing. Can be transparent |
| Animation | QuickTime Animation: lossless and transparent, very large. For short overlays |
| ProRes 422 | For Final Cut Pro and Apple workflows. FFmpeg's ProRes encoder, not certified by Apple |
| ProRes 4444 | ProRes with transparency. FFmpeg's ProRes encoder, not certified by Apple |

States of the HEVC chip (probed when the Settings section first shows MP4 or MOV, §5.9):

| State | Chip | Title |
|---|---|---|
| Probing | disabled | Checking for an HEVC encoder… |
| None found | disabled | This PC has no graphics card that can encode HEVC. Use H.264, or AV1 for smaller files |
| Found | enabled | the title above |

A hint under the row says what will run (replacing the Encoder row's hint for the new codecs):

| Codec and machine | Hint (exact) |
|---|---|
| HEVC, GPU found | HEVC on your graphics card ({names}). |
| AV1, GPU found | AV1 on your graphics card ({names}). |
| AV1, no GPU | AV1 on the processor: about 6 times as long as H.264. |
| CineForm | About {size} a minute at this size. Editing formats ignore Target size. |
| Animation | Lossless: up to {size} a minute at this size, more with motion. |
| ProRes 422 / 4444 | About {size} a minute at this size. |

`{names}` lists the probed encoders as the H.264 hint does today ("NVENC, QSV"); `{size}` comes from
`estimateBytes` (§5.10) with `formatBytes`.

**Background** (new, under Codec; shown for MP4, MOV and WebM). Three chips:

| Chip | Title (exact) |
|---|---|
| Drawn | The background as in the preview |
| Transparent | No background: the recording, the camera and everything over them stay; around them the video is see-through |
| Overlays only | Only what goes over the recording: the camera, captions, texts, images, key presses, title cards and the progress bar. No recording and no background. For laying over another video |

- With MP4, *Transparent* and *Overlays only* are disabled with the title "MP4 cannot be transparent:
  choose WebM, or MOV".
- With MOV or WebM, picking either switches the codec in the same click when it cannot carry
  transparency (MOV → CineForm, WebM's AV1 → VP9) and the hint says "CineForm keeps the transparency."
  or "VP9 keeps the transparency.". Picking a codec that cannot carry it puts Background back to
  *Drawn*.
- Hint while transparent (exact): "Plays transparent in Chrome, Edge and Firefox (WebM), and in
  editing software (MOV). Safari shows WebM on black." When the project has crossfades, dips or
  slides at its cuts, a second line: "Cut styles other than Punch-in play as hard cuts in a
  transparent video." (§6.4). When the card fills the frame (*Transparent* with padding 0), the line
  of §6.1: "With no padding the recording fills the frame: nothing will be see-through. Add padding in
  Style, or choose Overlays only."
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
| 120 fps | For 120 Hz screens. Exports take about twice as long as 60 fps |

120 fps with H.264 at 4K is disabled with the title "H.264 cannot carry 4K at 120 fps: choose HEVC or
AV1, or 1440p"; picking 4K while H.264 is at 120 fps sets 60 fps and says so in the hint.

**Quality** keeps its three chips (Studio · Web · Small file). For the intermediates they pick the
encoder's own levels (§5.4); their titles say what each means:

| Codec | Studio | Web | Small file |
|---|---|---|---|
| CineForm | Film quality (film1) | High | Medium |
| ProRes 422 | 422 HQ | 422 | 422 LT |
| Animation | (Quality hidden: lossless) | | |

**Target size** is disabled for the intermediates, for transparent exports and for WAV, with the hint
"Editing formats are sized by quality, not by a target." or "Transparent videos are sized by quality,
not by a target." or "WAV files are uncompressed.".

**Encoder** keeps *Auto (GPU when available)* and *Software*. For HEVC, *Software* is disabled with the
title "HEVC uses your graphics card only" (§0 decision 1 (a)). For CineForm, Animation and ProRes the
row is hidden: they always run on the processor.

The size line under the preview (`export-size`, `ExportDialog.tsx:713`) keeps its text and adds the
codec when it is not the default: "1080×1350 · 30 fps · HEVC · 2:14".

### 2.2 Destinations and saved presets

- **A new destination** after *Instagram Reels*: **Instagram post** (`instagram-feed`): MP4, 1080, 30
  fps, Studio, 4:5. Its card shows its meta line like the others ("1080×1350 · 30 fps").
- **Save as preset.** The Settings header ("Settings · Custom") gains a small button **Save as
  preset** on its right. It opens an inline row: a text field labelled "Preset name" (placeholder
  "Preset name", up to 60 characters, prefilled with a suggestion built from the settings, e.g. "MOV
  CineForm 1080p30"), **Save** and **Cancel**. Enter saves, Escape cancels. The new preset is selected
  and the header reads "Settings · {name}".
- **Your presets.** Under the built-in cards, a heading "Your presets" and one card per saved preset,
  in the order they were saved, with a generic preset icon, the name and the meta line. Each card has
  a **More** button (⋯, accessible name "More for {name}") with a menu:
  - *Update with these settings* (when the settings differ from the preset),
  - *Rename…* (the same inline field),
  - *Save to a file…* (a save dialog for `{name}.flownpreset`),
  - *Delete* (asks inline: "Delete “{name}”?" with **Delete** and **Cancel**).
- **Import.** A link under the grid, **Import presets…**, opens a file dialog for `.flownpreset` files
  and adds what it can read. Notices (exact): "Imported 1 preset.", "Imported {n} presets.", "This file
  has no presets Flown can read.", "{n} presets were left out: you can keep 50." A preset whose name is
  taken gets " (2)", " (3)".
- **At 50 presets** *Save as preset* is disabled with the title "You have 50 presets. Delete one to
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
| Sound stems (WAV) | One WAV file per sound, to mix in other software: voice, system sound, music and effects |
| Timeline | A timeline file that Final Cut Pro, DaVinci Resolve or Premiere Pro opens |

When *Sound stems* is on, a hint lists exactly what will be written, from the project:
"Saves {list} (32-bit WAV, about 23 MB a minute each)." with `{list}` such as "Voice, System sound and
Music" (`fmt.list`, English "A, B and C" as today's `listPhrase`). Stems without sound are not
written. Without separate microphone and system files: "Saves Recording and Music (…)". With *Even out
loudness* on (`AudioPanel.tsx:141`), a second line: "The stems keep one steady level, as the preview
plays it; the video's own sound is evened out as it plays." (§7.4)

When *Timeline* is on, two rows follow:

- **Timeline for** (toggle chips, at least one on; default the first):
  - *Final Cut Pro and DaVinci Resolve (.fcpxml)*
  - *Premiere Pro (.xml)*
  - *EDL (.edl)*, title "One video track and chapter markers: for any editor"
- **Uses** (radio):
  - *This export* (default), hint "The finished video and its sound, with chapter markers. Looks the
    same in every editor."
  - *The original recordings*, hint "Your cuts, speed changes and pauses over the original screen,
    camera and sound. Zooms, cursor effects, the background, captions, texts and the camera layout
    are not carried. The recordings are copied next to the timeline."

Blocked states, with the reason shown as text like the other chips (`ExportBundleOptions.tsx:56`):
GIF ("GIFs are saved alone"), batch mode ("Stems and timelines work with One file"), one file per
chapter ("Stems and timelines are saved with one file"), a silent project for stems ("This video has no
sound").

Files written next to the video, for "Demo.mp4":

```
Demo.mp4
Demo - Voice.wav            Demo - System sound.wav     Demo - Music.wav     Demo - Effects.wav
Demo.fcpxml                 Demo.xml                    Demo.edl             Demo - markers.edl
Demo media\                 (only with "The original recordings")
  Screen.mp4  Camera.mp4  Voice.wav  System sound.wav  Music.wav  Effects.wav
```

`Demo - markers.edl` is written with the EDL when the video has chapters (DaVinci Resolve imports it
through Timelines › Import › Timeline Markers from EDL). Existing files are never replaced: the
dialog's chosen path is new, and every other file gets " (2)" the way `export:batchPath` does.

### 2.4 Exporting and the done view

- The running view (`RunningView`) adds one step after the video when stems are on: "Writing sound
  stems…", and one for timelines: "Writing the timeline…" (and "Copying the recordings…" for the
  recordings mode). The progress bar covers the video; the extra steps show an indeterminate bar.
- The done view lists every file saved, as today's bundle list does, with **Show in folder**. A
  failed stem or timeline step does not undo the video: the done view shows the video as saved and a
  line "The sound stems could not be saved: {reason}".

### 2.5 Settings › Language

A new first section, **Language** (`SettingsSection` gains `'language'`), in the Settings dialog:

- **Language of Flown** (a `select`, accessible name "Language of Flown"):
  - "Follow Windows ({name})": `{name}` is the language Windows would give (English when Windows' first
    language is not shipped);
  - "English";
  - each shipped language by its own name, then its English name in the English UI: "বাংলা
    (Bangla)", "Español (Spanish)", "हिन्दी (Hindi)". In the Bangla UI: "বাংলা", "English
    (ইংরেজি)".
- **Digits** (shown for Bangla and Hindi): two radio buttons, "বাংলা ০১২৩" and "Western 0123"
  (Hindi: "देवनागरी ०१२३" and "Western 0123"), each with its digits shown so it reads the same in any
  UI language.
- After a change, a notice row: "Flown switches to {name} when it restarts." with **Restart now**.
  Restart now asks the editor to save and close as quitting does today, then relaunches.
- Under the controls (exact, in each language): "Text that is not translated yet stays in English.
  This setting does not change your recordings, captions or exported files." In a translated UI, when
  the recording side is not translated (§0 decision 11), one more line: "The recording controls are
  not translated yet." With Bangla chosen, a third: "Screen readers: NVDA reads Bangla. Windows
  Narrator has no Bangla voice yet." (§14.3)

### 2.6 What changes when Flown is in Bangla

- Every message of the app's own UI, including screen-reader names, tooltips, notices, dialogs,
  notifications, the taskbar buttons' tooltips and the file dialogs' titles and filter names.
- Numbers, sizes, durations, dates and the timecode in Bangla digits (or Western, by choice), with
  Bangla grouping (১২,৩৪,৫৬৭) and Bangla dates ("৭ নভে, ২০২৬").
- The UI font for Bangla letters is Noto Sans Bengali; Latin words keep Segoe UI. Lines are taller
  (1.4 at least) and the two smallest text sizes become 12 px (§12).
- `<html lang="bn">`.
- Not changed: keycaps (Ctrl, Shift, Esc, ←), codec and file names, 1080p, 16:9, the user's project
  names and captions, exported files (§0 decision 10), the recording controls (§0 decision 11), the
  timeline's ruler direction.

### 2.7 The offer on Home

When the language setting is absent, Windows' preferred languages (`app.getPreferredSystemLanguages()`)
include a shipped language other than English, and the offer was not answered before, Home shows a
notice once, at the top of its content, in English and in that language:

> Flown is available in বাংলা. — Flown এখন বাংলায় পাওয়া যায়।  **[বাংলা ব্যবহার করুন]** **[Not now]**

*Use* saves the setting and restarts (Home holds no open project). *Not now* records the answer
(`UiPrefs.offered`) and the notice never returns; Settings › Language stays the way back. The notice is
a `role="region"` with the accessible name "Language", its second sentence in `<span lang="bn">`.

### 2.8 Keyboard and screen readers

- Every new control is a native button, radio, checkbox, select or text field with a visible label;
  the Codec, Background and Frame rate chips are `Choice` groups as today (arrow keys move, Space and
  Enter pick).
- Disabled chips explain why in visible text under the row, as `ExportBundleOptions` does, because a
  disabled button's tooltip is not announced.
- The preset card menu opens with Enter, Space or Shift+F10; Escape closes it and returns focus.
- The progress steps of §2.4 are announced through the existing `aria-live` status of the running view.
- The Language section's restart notice is announced (`role="status"`).
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
| 1 | Where codecs are picked | A Codec row under Format; each format keeps its old codec as default | New format chips per codec ("MP4 HEVC", "MOV CineForm"): eight more chips and stored `format` values older Flown cannot read |
| 2 | HEVC source | Hardware only (§0 decision 1) | x265: a patent licence per copy and litigation risk |
| 3 | AV1 without a GPU | libaom "good", `-cpu-used 6`, with a time warning | libaom realtime (measured no smaller than x264, so pointless); WebCodecs software AV1 (libaom realtime inside Chromium, same problem; kept as a test override only); SVT-AV1 (not in this build) |
| 4 | Editing format | CineForm (open, alpha, native in Premiere and Resolve) | ProRes by default (§0 decision 2); DNxHR (patents unchecked, no alpha) |
| 5 | Transparent formats | WebM/VP9 for the web; MOV with CineForm or Animation for editors | WebCodecs alpha (Chromium refuses `alpha: 'keep'` for VP8, VP9 and AV1: "Alpha encoding is not currently supported"); HEVC with alpha (this x265 takes no `yuva` input); PNG in MOV (slow for editors to play) |
| 6 | Alpha over IPC | Straight RGBA, 4 bytes a pixel, unpremultiplied in the renderer | Premultiplied plus ffmpeg's `unpremultiply` (two readback paths with different conventions); I420A packing (2.5 bytes a pixel, but the intermediates want 4:2:2 or 4:4:4 anyway) |
| 7 | Transparency and cut styles | Crossfade, dip and slide play as hard cuts in transparent exports; punch-in stays | Compositing wave 10's A\* over a transparent frame (its scratch target is opaque; a second alpha path for one rare case) |
| 8 | 4:5 | An export shape (ExportOptions, batch, a destination) | A project shape: an older Flown opening such a project computes `RATIOS['4:5']` as `undefined` and draws NaN (`layout.ts:48-53`) |
| 9 | Frame rates | 24, 25, 30, 60, 120, whole numbers only | 23.976 and 29.97: IVF needs an integer rate (`codec.ts:148`), audio frames would not be whole samples, and editors confuse them with 24 and 30 |
| 10 | Saved presets | `editor-prefs.json` key `exportPresets`, sanitised in main | localStorage (not readable by main, so no file import and export through one reader) |
| 11 | Stems | 32-bit float WAV, one fixed gain, one ffmpeg run writing every stem | 24-bit with a measuring pass to avoid clipping (two runs); `loudnorm` per stem (does not add up); a "Mix" stem (a second mix beside the video's own sound confuses; the WAV format is the mix) |
| 12 | Timeline formats | FCPXML 1.10, xmeml 4, CMX 3600 EDL (+ a marker EDL), written directly | OpenTimelineIO's writers (measured: FCPXML 1.8 without speed or markers; CMX writer puts the clip name in the reel field); OTIO files (Premiere's support is recent; Resolve reads FCPXML anyway) |
| 13 | Timeline media | Two modes: the export (default), or the recordings | Recordings only (most of Flown's look is lost); export only (no re-editing) |
| 14 | i18n runtime | `intl-messageformat` 12.1.4 behind a 150-line `t()` shared by every process | react-intl (14.9 KB, React-only); i18next with ICU (30.5 KB, own syntax by default); Lingui (a Babel or SWC plugin inside electron-vite); Fluent (a syntax translators and AI services know less; its React binding was last released in August 2023) |
| 15 | Message syntax | ICU MessageFormat 1 | MessageFormat 2 (stable in CLDR 47 but shipped by no runtime; `Intl.MessageFormat` is a stage 1 proposal) |
| 16 | Keys | Semantic keys per namespace (`export.codec.hevc.title`) | English text as key (breaks when English copy is edited) |
| 17 | Numbers inside messages | Formatted in code by `fmt`, passed as strings; a plural selects on `count` and shows `{n}`; `#` is never used | `{n, number}` and `#` in messages (ICU groups them, so English would show "1,234 files" where today shows "1234 files") |
| 18 | Changing language | Applies at restart | Live switch (every component and shared helper would need to re-render on a context; strings computed outside React would go stale) |
| 19 | Chromium locale packs | Stay out (`electronLanguages: ['en-US']`) | Adding them: Chromium's default locale would follow Windows and today's eight locale-less `toLocale*()` calls would print Bangla digits in the English UI on a Bangla Windows (measured) |
| 20 | Language detection | `app.getPreferredSystemLanguages()`, first entry, language subtag | `app.getLocale()` (always `en-US` with one pack, measured) |
| 21 | Bangla UI font | Noto Sans Bengali (bundled, tabular digits 0.59 em) | Hind Siliguri (proportional digits 0.49–0.69 em: timecodes would jitter); Nirmala UI alone (three weights; the UI's 74 uses of weight 600 would be synthesised) |
| 22 | Who checks for missing keys | A TypeScript-AST scanner in vitest and predist | ESLint plugins (the repository has no ESLint) |
| 23 | Where translations are reviewed | Files in git and a CSV sheet any spreadsheet opens, plus an in-app key overlay in review builds | A hosted translation service (a server and accounts; optional later: Weblate reads the same JSON) |
| 24 | What reaches users | Only approved strings, built into the shipped catalogue by a script | Shipping drafts marked "machine" (Mozilla's pre-translation trial approved 65.1% of strings unchanged: a third would be wrong) |

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

export interface TimelineRequest {
  projectId: string
  /** The finished export (an approved path of this session). */
  videoPath: string
  kinds: TimelineKind[]
  media: 'export' | 'recordings'
  plan: TimelinePlan          // §8.2, built in the renderer from the project
  /** Stem files written with the export (main checks each is next to `videoPath`). */
  stems: { stem: SoundStem; path: string }[]
}

export interface TimelineResult {
  files: string[]
  /** A step that failed after the video was saved, in the UI language. */
  problem?: string
}

export interface ExportApi {
  // … every call as before …
  /** Working GPU encoders for a codec, best first (cached per session; §5.9). */
  probeCodec(codec: 'hevc' | 'av1'): Promise<FfmpegVideoEncoder[]>
  /** The code of the last export:start or export:finish failure (§9.6). */
  exportErrorCode(): Promise<ExportErrorCode | null>
  writeTimeline(request: TimelineRequest): Promise<TimelineResult>
  /** Save dialog, then writes `text` (a preset file, §4.5). Resolves with the path, or null. */
  savePresetFile(defaultName: string, text: string): Promise<string | null>
  /** Open dialog for .flownpreset; main reads at most 64 KB and returns the presets it can read. */
  openPresetFile(): Promise<{ presets: UserExportPreset[]; skipped: number } | null>
}
```

`ExportCapabilities` keeps `hardwareEncoders` (H.264) unchanged; the other codecs are probed on demand.

### 4.3 Export settings in renderer storage (unchanged keys)

The dialog keeps its five localStorage keys (`ExportDialog.tsx:78-82`). What they hold:

| Key | Today | New, optional |
|---|---|---|
| `export-settings` | `ExportOptions` | `codec`, `alpha`, `userPreset`; `fps` 24, 25, 120; `aspect` '4:5'; `format` 'wav' |
| `export-batch` | `{ presets: string[]; aspects: AspectRatio[] }` | `userPresets?: string[]` (absent when empty); `aspects` may hold '4:5' |
| `export-bundle` | `BundleOptions` without `languages` | `stems?: true`, `timelines?: TimelineKind[]`, `timelineMedia?: 'recordings'` |
| `export-mode`, `export-settings-open` | as today | none |

`normalizeOptions` (`exportPresets.ts:99-113`) is rewritten in the contracts step (§21.0) with these
rules, so stored values without new fields are read **and written back byte for byte** (test 2):

1. The five old keys are read exactly as today, in the same order; `fps` accepts
   `[24, 25, 30, 60, 120]`; `format` accepts `'wav'`; `aspect` accepts `'4:5'`.
2. `codec` is kept only when it is in `FORMAT_CODECS[format]`, allowed by `CODEC_POLICY`, and not the
   format's default; otherwise it is deleted (so picking H.264 again stores nothing).
3. `alpha` is kept only when `canAlpha(format, codec)`; otherwise deleted.
4. `userPreset` is kept when it matches `/^user:[0-9a-f]{12}$/`; whether that preset still exists is
   the dialog's question (a missing one is dropped by `tweakOptions` as it drops a stale `preset`).
5. New keys are written after the old ones, so an old object's key order never changes, and
   `tweakOptions` deletes `undefined` as today.

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
| `ui` | `UiPrefs = { language?: 'system' \| UiLanguage; digits?: 'native' \| 'western'; offered?: UiLanguage[] }` | English, the locale's own digits, nothing offered yet |

```ts
export interface UserExportPreset {
  id: string                 // 'user:' + 12 lower-case hex; never a built-in id (they have no colon)
  name: string               // 1..60 graphemes, no control or bidi-control characters, trimmed
  options: ExportOptions     // through normalizeOptions, without `preset` and `userPreset`
  bundle?: Omit<BundleOptions, 'languages'>   // through normalizeBundle
  saved: number              // ms since 1970
}
```

`prefsIpc.ts` keeps every unknown key of the file as it is (`load()` holds the whole object and
`prefs:set` spreads it), so an older Flown keeps the new keys untouched. Main also reads `ui`
synchronously at start (`readPrefSync`, §9.4).

### 4.5 The preset file (`.flownpreset`)

UTF-8 JSON, at most 64 KB:

```json
{ "flown": "export-presets", "version": 1,
  "presets": [ { "name": "Client review", "options": { "format": "mov", "resolution": 1080, "fps": 30,
    "quality": "high", "encoder": "auto", "codec": "cineform" }, "bundle": { "stems": true } } ] }
```

- Written by `presetFileText(presets)` (ids and `saved` left out; they are made again on import).
- Read in main only, by `readPresetFile(text)` (§18.2): the `flown` and `version` fields must match;
  at most 50 presets; each name cleaned by `cleanPresetName`; options through `normalizeOptions`;
  `bundle` through `normalizeBundle` without `languages`; every other field dropped. Nothing in a
  preset is a path, a URL or code.

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
essentials_build-www.gyan.dev", configure line with `--enable-gpl --enable-version3 --enable-libx265
--enable-libaom --enable-libvpx --enable-mediafoundation --enable-amf --enable-nvenc --enable-libvpl`)
under wine: `-encoders` and `-h encoder=…` for each, and a test encode for every software encoder
(all exit 0). The GPU encoders exist in the binary; whether they run depends on the PC (§5.9).

| Codec | Encoders in the binary | Used by Flown | Licence of the code | Patents and owner's position |
|---|---|---|---|---|
| H.264 | libx264, h264_nvenc, h264_qsv, h264_amf, h264_mf | as today | x264 GPLv2+ (in a GPLv3 binary run as a separate program) | AVC pool (Via LA): already shipped today, unchanged |
| HEVC | **libx265** (x265 3.5+113, 8/10/12-bit, no alpha), hevc_nvenc, hevc_qsv, hevc_amf, hevc_mf | the four hardware encoders and WebCodecs HEVC; libx265 never (§0 decision 1) | x265 GPLv2+ (commercial licence from MulticoreWare) | Access Advance (HEVC Advance and, since 15 Dec 2025, the former Via LA pool) plus independent holders. x265 is **already in the shipped binary**; using only hardware means Flown's code never runs it |
| AV1 | libaom-av1 (no alpha), av1_nvenc, av1_qsv, av1_amf. **Not** in this build: av1_mf, SVT-AV1, rav1e, dav1d | all four | libaom BSD-2 | AOMedia Patent License 1.0, royalty-free. Sisvel's AV1 pool publishes device rates (€0.32 per display device, €0.11 per other device) and none for software. Recommended: ship |
| VP9 | libvpx-vp9 (yuva420p for alpha), vp9_qsv | libvpx-vp9 as today, plus alpha | libvpx BSD-3 | Google's WebM patent grant, royalty-free |
| CineForm | cfhd (yuv422p10le, gbrp12le, gbrap12le) | yes | part of FFmpeg (LGPL code, GPL as built); the GoPro SDK is Apache-2.0 or MIT | Open; no pool |
| QuickTime Animation | qtrle (argb, rgb24) | yes | part of FFmpeg | Apple's 1990s run-length format; no known pool |
| ProRes | prores, prores_aw, prores_ks (yuv422p10le, yuv444p10le, yuva444p10le) | prores_ks only with §0 decision 2 (b) | part of FFmpeg | Apple calls FFmpeg's encoders unauthorised; "ProRes" is Apple's trademark. Owner decides |
| DNxHR | dnxhd | no (§0 decision 4) | part of FFmpeg | not checked |
| Lossless | ffv1, utvideo, png | no | part of FFmpeg | — |
| Audio | pcm_s16le, pcm_s24le, pcm_f32le, flac, alac, aac, aac_mf, libopus | pcm_s24le (WAV format, MOV intermediates), pcm_f32le (stems), aac and libopus as today | FFmpeg; libopus BSD-3 | PCM, Opus, FLAC and ALAC free; AAC already shipped |

Muxers used: mp4, mov, webm, ivf (input), wav with `-rf64 auto` and `-write_bext 1`. Filters used:
`scale` (colour matrices), `format`. Bitstream filters: `hevc_metadata`, `av1_metadata`.

**Installer growth for all of §5–8: 0 bytes.**

### 5.2 Codecs per format

| Format | Codecs (`FORMAT_CODECS`, default first) | Can be transparent | Audio |
|---|---|---|---|
| MP4 | h264, hevc, av1 | no | AAC 192 kb/s (as today) |
| MOV | h264, hevc, cineform, animation, prores-422\*, prores-4444\* | cineform, animation, prores-4444 | AAC for h264 and hevc (as today); PCM 24-bit 48 kHz for the intermediates |
| WebM | vp9, av1 | vp9 | Opus 128 kb/s (as today) |
| GIF | — | — | — |
| M4A | — | — | AAC (as today) |
| WAV | — | — | PCM 24-bit 48 kHz |

\* only with `CODEC_POLICY.prores`. Alpha codecs and their encoders: VP9 → `libvpx-vp9` (yuva420p),
CineForm → `cfhd` (gbrap12le), Animation → `qtrle` (argb), ProRes 4444 → `prores_ks` (yuva444p10le).

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
cores.

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
intermediates: `-c:a pcm_s24le -ar 48000`.

**WAV format.** The soundtrack graph of today's M4A export, unchanged, encoded as `-c:a pcm_s24le -ar
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
tall-frame rules (safe zones, follow framing, camera placement) apply exactly as for 9:16, because
`isTall` already counts 4:5 as tall and `exportPreviewSize` (`exportPlan.ts:71`) already handles it.
The batch "Also" row adds 4:5 (`BATCH_ASPECTS`), file label "4x5".

### 5.9 Probing

`probeCodec('hevc' | 'av1')` runs a 10-frame test encode per GPU encoder, the way `probeEncoder`
(`hwEncoders.ts`) does for H.264, with each encoder's own pixel format (`nv12` for qsv, amf, mf;
`yuv420p` for nvenc) and `-hw_encoding 1` for `hevc_mf`; `av1_amf` and the `_mf` encoders only on
Windows. The probe runs once per codec per session, when the dialog first needs it, and is cached; it
never runs at app start. The renderer probes WebCodecs with `VideoEncoder.isConfigSupported` and
`hardwareAcceleration: 'prefer-hardware'`, as for H.264 today.

### 5.10 Sizes and disk space

`estimateBytes(options, size, seconds)` (`proFormats.ts`) gives an upper estimate from
`MB_PER_MINUTE_1080P60` scaled by pixels × `rateFps`: CineForm YUV 1,500, CineForm RGBA 3,600,
Animation 2,500, ProRes 422 HQ 3,300 (Apple's nominal at 59.94), ProRes 4444 5,000, stems 23.04 per
stem. Before an intermediate, alpha or stem export starts, main compares it with the free space of the
target folder (`fs.statfs`); below 1.2 × the estimate the export does not start and says (exact):
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

| Layer (in drawing order) | Drawn (today) | Transparent (`'background'`) | Overlays only (`'overlays'`) |
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
  44: 50% red reads `[0, 0, 128, 128]`). `getImageData` returns straight values. Transparent jobs
  therefore read every frame with `getImageData` (today's fallback, `encoders.ts:83-97`), and send
  straight `rgba` frames to ffmpeg. There is no unpremultiply step of our own and no second
  convention.
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

Wave 10's crossfade, dip and slide compose A\* on an opaque scratch target (`joinLayer.ts`,
`scratchTarget`). In a transparent export they play as **hard cuts**: `transparentJoins(windows)`
returns no windows, in the export and in the dialog's preview alike. Punch-in stays: it only scales
the content (`punchedCamera`). The dialog's hint says so (§2.1). The project is not changed.

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
- **Music**: `musicBranch` as today, ducked by the same envelope.
- **Effects**: the click, pop, tone and library-effect branches, joined with `amix … normalize=0` as
  `soundtrackGraph` joins them.
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
2. Main resolves the sound inputs for the stems (`resolveSoundInputs` on a copy of the job whose
   `audio.stems` holds `StemJob.gains`, then `cleanVoiceInputs`). That asks for the separate files
   even when the video itself used screen.mp4's mixed track, which `recordingMix`
   (`settings.ts:143`) chooses whenever the gains are default. It runs the stem graph into temporary
   files next to the video and renames each into place.
3. `ExportFinish` reports `stems: { stem, path, bytes }[]`, or `stemsProblem` (a message in the UI
   language) when the step failed. The video is never removed because of a stem.
4. Cancelling during the stem step deletes the stem files written so far, never the video.

Blocked, with the reason under the chip (§2.3): GIF, batch, one file per chapter, a project without
sound.

### 7.7 The WAV format

*Format › WAV* is today's M4A job (`exportAudio`, `exporter.ts:305`; `video: { kind: 'none' }` at 60
fps) with one difference at the end: `-c:a pcm_s24le -ar 48000 -rf64 auto -f wav` instead of AAC in
`-f ipod`. Its graph is the M4A graph byte for byte (test 30), `loudnorm` included, so it is the
video's sound, uncompressed. 24-bit integer is enough here because `loudnorm` keeps the true peak at
−1.5 dBTP. `SAVE_FILTERS` and `EXPORT_EXTENSIONS` gain `wav`.

### 7.8 Sizes

32-bit float stereo at 48 kHz is 384,000 B/s, **23.04 MB a minute per stem**; the 24-bit WAV format is
17.28 MB a minute. A plain WAV holds 4 GiB (3 h 6 min of float stereo); `-rf64 auto` switches to RF64
beyond that, which Premiere, Resolve and Audition read. Disk space is checked before the export as in
§5.10.

---

## 8. Timelines for other editors

### 8.1 Two kinds of timeline

| | *This export* (default) | *The original recordings* |
|---|---|---|
| Purpose | Mix and finish in another editor; add it to a bigger edit | Re-edit Flown's cuts in another editor |
| Video track V1 | the exported video, full length, one event | `screen.mp4` (copied), one event per Flown clip |
| Video track V2 | none | `webcam.mp4` (copied), when the project has a camera, offset by `webcamOffset` |
| Audio tracks | the WAV stems written with this export (§7), full length; without stems, the video's own sound | A1 Voice and A2 System sound (or A1 Recording): WAV copies of the recordings, cut like V1; A3 Music and A4 Effects: the rendered Music and Effects stems (§7), full length, so looping, ducking, volume and fades stay as in Flown |
| Speed changes, pause freezes | already rendered | as speed effects and holds |
| Crossfades (wave 10) | already rendered | as dissolves; dip, slide and punch-in as hard cuts |
| Zooms, cursor effects, background, captions, texts, shapes, camera layouts, colour | already rendered | **not carried** (the dialog says so, §2.3) |
| Chapter markers | yes | yes |
| Media written | nothing new (the export and its stems) | `<base> media\` with `Screen.mp4`, `Camera.mp4`, `Voice.wav`, `System sound.wav` or `Recording.wav`, `Music.wav`, `Effects.wav` |

The recordings mode copies media: the project's files (`LINKED_MEDIA`, `projectCopy.ts:22`) are never
hard-linked out, because an editor that opened the link for writing would change the project. The
microphone and system files are converted to WAV (`-c:a pcm_s24le -ar 48000`), because M4A files
carry the encoder's priming delay in an edit list that some readers ignore (21–44 ms offsets).
ffmpeg honours the edit list, so the WAV starts where the recording starts. With Clean voice on, the
Voice file is the cleaned stem. Before copying, main checks free space for the sum of the files plus
20%.

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
  tracks: { kind: 'video' | 'audio'; name: string; role?: 'dialogue' | 'effects' | 'music'; events: TimelineEvent[] }[]
  /** Chapter markers (outputChapters) and the user's own markers, in timeline frames. */
  markers: { frame: number; name: string; chapter: boolean }[]
  /** Facts about each source a writer needs; the path is filled in by main. */
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
   the video. Source in and out round on the source's own frame grid (60 fps for `screen.mp4`, the
   camera's rate for `webcam.mp4`).
3. Wave 10's crossfade joins become `dissolve` on the second event, length `round(duration × fps)`;
   other join kinds are hard cuts.
4. Music and Effects: one event each from 0 to the end, the stems rendered for this timeline (§7),
   at 0 dB. `gainDb`, `fadeIn` and `fadeOut` stay unused by Flown's own plans; they exist so a later
   version can hand the music over unmixed.
5. Markers: `outputChapters` (`chapters.ts:32`, found chapters of wave 11 included) as chapter
   markers, named by their titles.

### 8.3 FCPXML 1.10 (`src/shared/interchange/fcpxml.ts`)

`function fcpxml(plan: TimelinePlan, paths: Record<TimelineMedia, string>): string`. Written as one
plain `.fcpxml` file, UTF-8, `<!DOCTYPE fcpxml>`, version 1.10 (FCP 10.6 and later; DaVinci Resolve
18 and later). The sample in the research folder (`formats/otio/flown-1.10.fcpxml`) validates against
Apple's FCPXML 1.10 DTD with `xmllint --dtdvalid`.

- `resources`: one `format` per distinct size and rate (`frameDuration="1/{fps}s"`, `width`,
  `height`; `colorSpace="1-1-1 (Rec. 709)"` for the intermediates, none for H.264, HEVC and AV1,
  whose files carry their own tags); one `asset` per media with `start="0s"`, `duration`, `hasVideo`,
  `hasAudio`, `audioRate="48000"`, and a `media-rep kind="original-media" src="file:///C:/…"`.
- `library > event name="Flown" > project name="{name}" > sequence` with `tcStart="0s"`,
  `tcFormat="NDF"`, `audioLayout="stereo"`, `audioRate="48k"`.
- The spine holds V1's events as `asset-clip`s. A speed is a `timeMap` with two `timept`s (linear); a
  hold is a `timeMap` with equal values. V2 and the audio tracks are connected clips (`lane="1"`,
  `lane="-1"` …) with `audioRole="dialogue"`, `"effects"` or `"music"`. An event with `gainDb` gets
  `<adjust-volume amount="{gainDb}dB"/>` (not used by this wave's plans).
- Dissolves are `<transition name="Cross Dissolve">` in the spine.
- Chapter markers are `<chapter-marker start="…" duration="1/{fps}s" value="{name}"/>`, other markers
  `<marker>`.
- Times are rationals `{frames × 1}/{fps}s` (whole frames), never decimals.
- A `uid` is `flown.{projectId}.{n}`, so importing the same export twice is recognised.

### 8.4 Premiere XML (`src/shared/interchange/xmeml.ts`)

`function xmeml(plan: TimelinePlan, paths: Record<TimelineMedia, string>): string`. FCP 7 XML
(`<xmeml version="4">`), which Premiere Pro imports natively (it does not read FCPXML) and DaVinci
Resolve reads too.

- `sequence` with `rate > timebase {fps}` and `ntsc FALSE`, `timecode` from 00:00:00:00, `format`
  with the frame size.
- `media > video > track` and `audio > track` with `clipitem`s: `start`, `end`, `in`, `out` in frames,
  `file id` with `pathurl` `file://localhost/C:/…` (Premiere's own form), `duration`, `rate`.
- A speed is the `Time Remap` filter (`effectid timeremap`, `speed` in percent, `reverse FALSE`); a
  hold is speed 0 with `frameblending FALSE`. Premiere's *Maintain Audio Pitch* is off by default and
  xmeml cannot ask for it; the dialog's hint for this mode says speed changes may change pitch there.
- Dissolves are `transitionitem` *Cross Dissolve*; markers are `marker` elements on the sequence. An
  event with `gainDb` gets the `Audio Levels` filter (linear: −3 dB is 0.707946).

### 8.5 EDL (`src/shared/interchange/edl.ts`)

`function edl(plan: TimelinePlan, paths: Record<TimelineMedia, string>): string` and
`function markerEdl(plan: TimelinePlan): string | null`. CMX 3600, read by Premiere, Resolve and Avid.

- `TITLE: {name in ASCII}` and `FCM: NON-DROP FRAME`.
- **One video track only**: V1's events, with reel `AX`, the record and source timecodes, and the
  comments `* FROM CLIP NAME: {file name}` and `* SOURCE FILE: {path}` that Resolve and Premiere use to
  link media.
- A speed is an `M2 AX {fps × speed} {source tc}` line (`000.0` for a hold). Speed lines are read
  unevenly by editors; the dialog's EDL title says "One video track and chapter markers: for any
  editor".
- Dissolves are `D {frames}` events.
- At most 999 events: beyond that the EDL chip is disabled with the title "This edit has more than
  999 cuts, which EDL cannot hold. Use FCPXML or Premiere XML."
- `markerEdl` writes `<base> - markers.edl`, the form DaVinci Resolve imports through *Timelines ›
  Import › Timeline Markers from EDL* (one event per chapter, `|C:ResolveColorBlue |M:{name} |D:1`).
  Names are reduced to printable ASCII; a name with no ASCII letters becomes "Chapter {n}" (Bangla
  chapter titles stay whole in FCPXML and xmeml, which are UTF-8).
- Lines end in CRLF.

### 8.6 Frame rates, start and paths

- The timeline rate is the export's rate up to 60 fps and 60 above (FCPXML's frame rates and EDL
  timecode stop at 60). Rates are written exactly: `frameDuration="1/24s"`, `<ntsc>FALSE</ntsc>`,
  `FCM: NON-DROP FRAME`. No 23.976 or 29.97 exists in Flown (§3.2 row 9).
- Every timeline starts at 00:00:00:00, like the stems' BWF `time_reference` 0.
- Paths are absolute Windows paths written as file URLs: UTF-8 percent-encoded (Bangla names and
  spaces included), drive letter kept (`file:///C:/Users/…`; xmeml `file://localhost/C:/…`). Names
  and text are XML-escaped. `fileUrl(path)` and `xmlText(s)` live in
  `src/shared/interchange/fileUrl.ts` and are shared by the three writers.
- Final Cut Pro runs on a Mac, so Windows paths need relinking there; DaVinci Resolve and Premiere on
  the same PC open them directly.

### 8.7 Writing

`exportBundleRun.ts` asks for the timeline after the video, the stems and the sidecars:
`writeTimeline(request)` (§4.2). Main checks that `videoPath` is the path this session exported and
that each stem path sits next to it, fills in the media paths (in recordings mode it first copies and
converts the media into `<base> media\`), runs the writers, and writes each file with a temporary
name and a rename. A file name that is taken gets " (2)". Every written file and the media folder are
listed in the done view.

---

## 9. Languages: the runtime and the catalogues

### 9.1 One runtime for every process

`intl-messageformat` 12.1.4 (BSD-3-Clause; with its `@formatjs/*` parts, 9.8 KB gzip in the renderer)
formats ICU MessageFormat messages. It is pinned exactly as a devDependency and bundled by
electron-vite into main, preload and renderer, as React is; `scripts/notices.mjs` adds it to
`BUNDLED`. Around it, about 150 lines of our own in `src/shared/i18n/`:

```ts
// src/shared/i18n/t.ts
export type MessageValues = Record<string, string | number>
/** The message `key` in the UI language with `values`; English when the language has no approved text for it. */
export function t(key: MessageKey, values?: MessageValues): string
/** The same, with rich tags (<kbd>, <b>, <em>, <link>) mapped to the caller's nodes. */
export function tParts<T>(key: MessageKey, values: MessageValues, tags: Partial<Record<RichTag, (chunks: (string | T)[]) => T>>): (string | T)[]
export type RichTag = 'kbd' | 'b' | 'em' | 'link'
/** Set once per process before any text is made (main at start, the renderer before its first render). */
export function setCatalogue(c: { language: UiLanguage; messages: Readonly<Record<string, string>>; formatLocale: string; dir: 'ltr' | 'rtl' }): void
export function uiLanguage(): UiLanguage
export function uiDir(): 'ltr' | 'rtl'
```

- English messages are imported statically (`src/shared/i18n/messages/en/index.ts`), so English needs
  no loading and `t()` works in tests and before `setCatalogue`.
- A key missing from the language's catalogue, or whose translation is stale (§15.6), formats the
  English message: the user sees English for that string only.
- Each message is parsed once, on first use, and cached per language and key (59 ms for 4,000 Bangla
  messages if all were used; 2.2 µs per call afterwards, measured in Electron 44).
- The language changes only at restart (§3.2 row 18), so `t()` is a plain function: shared helpers,
  main-process code and components all call it the same way, and nothing is re-rendered on a switch.
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
| `src/shared/i18n/messages/en/<ns>.json` | key (without the namespace) → English ICU message, exactly today's text | builders, through the extraction (§10) |
| `src/shared/i18n/messages/en/<ns>.meta.json` | key → `{ description, screen?, maxLength?, dnt?: string[], merge?: true }` | builders |
| `translations/glossary.csv` | term, part of speech, note, do-not-translate flag, then one column per language | reviewers (§15.2) |
| `translations/<lang>/<ns>.json` | key → `{ text, state: 'draft' \| 'reviewed' \| 'approved', sourceHash, by?, at?, note? }` | the drafting script, then reviewers |
| `src/shared/i18n/built/<lang>.json`, `<lang>.main.json` | approved, current messages only, for the renderer and for main | `npm run i18n:build` (§16), committed and checked |

- `sourceHash` is the first 12 hex digits of SHA-256 of the English message. When English changes,
  the translation goes stale and is left out of the built catalogue until a reviewer approves it again.
- The built catalogue for main holds the `main`, `errors` and `common` namespaces; main imports it
  statically (about 30 KB for Bangla). The renderer loads `<lang>.json` with a dynamic `import()`,
  which Vite emits as a same-origin chunk under the existing CSP. English has no built file.
- `translations/` and `scripts/i18n/` are not in the app's files list (`appFiles()`), so drafts,
  review notes and the glossary never ship.

**Namespaces** (one JSON file each, one owner each, §21.8): `common`, `keys`, `commands`, `home`,
`editor`, `timeline`, `style`, `zoom`, `camera`, `sound`, `captions`, `text`, `review`, `smart`,
`export`, `settings`, `language`, `errors`, `main`, and `recording` (reserved, empty, §9.5). The
**core** namespaces, which must be fully approved before a language appears in the picker (§0
decision 7), are `common`, `keys`, `home`, `editor`, `timeline`, `export`, `settings`, `language`,
`errors` and `main`.

### 9.3 How messages are written

- **Keys** are semantic and stable: `export.codec.hevc.title`, `editor.notice.zoomAdded`. English
  copy can change without changing keys.
- **Exact English.** A message holds exactly the text the code renders today: the same spaces,
  `&nbsp;` as U+00A0, "…" as U+2026, curly quotes where the code has them. The codemod takes JSX text
  from `ts.transpileModule` output with `jsx: 'react-jsx'`, so JSX whitespace rules are React's.
- **Placeholders** are named after what they hold (`{name}`, `{count}`, `{size}`), never `{0}`.
- **Numbers are formatted by code and passed as strings.** A plural selects on a number and shows the
  formatted one: `{count, plural, one {{n} file} other {{n} files}}` with
  `{ count: 3, n: fmt.count(3) }`. **`#` is not used**: ICU formats `#` with grouping, so English
  would turn "1234 files" into "1,234 files". The checker rejects `#` and `{x, number}` (§16).
- **Plurals** list every category of the language (`Intl.PluralRules(lang).resolvedOptions()`:
  bn and hi one/other, es one/many/other, ar six, he one/two/other) and always `other`.
- **Gender**: English sources avoid "You are …ing" forms whose verbs change with the reader's gender
  in Hindi and Arabic ("Recording…", not "You are recording").
- **No sentences built from pieces.** Where today's code concatenates fragments ("Split the clip" +
  " (S)"), the message becomes one with a placeholder only when the English output stays identical for
  every input; otherwise the fragments stay separate keys, marked `merge: true` in the meta file for a
  later release, and translators see the whole sentence in the description.
- **Apostrophes**: ICU treats `'{` as an escape. Plain apostrophes in words ("Don't") are safe; the
  checker rejects `'{`, `'}` and `'#`.
- **Rich text** only through the four tags of `RichTag`; no HTML in messages.

### 9.4 Choosing the language at start

1. Main, as soon as the app is ready and before any window opens (`src/main/index.ts`, one call in
   `whenReady`), reads `ui` from `editor-prefs.json` with `readPrefSync('ui')` and resolves:
   - `language` absent or `'en'` → English. **Existing and new installs start in English** (§0
     decision 8).
   - `'system'` → the first entry of `app.getPreferredSystemLanguages()`, reduced to its language
     subtag (`bn-IN` and `bn-BD` are both `bn`); English when Flown has not shipped that language.
   - a shipped language → that language. A language that is not shipped (no built catalogue) → English.
2. The format locale: English keeps today's per-call-site profile (§11.2). Other languages use
   `app.getSystemLocale()` when it is the same language (`bn-BD`, `bn-IN`, `es-MX`), else the bare
   language; then the digits choice is added as a tag: `bn` + Western → `bn-BD-u-nu-latn`, `hi` +
   native → `hi-IN-u-nu-deva`. The choice is always a `-u-nu-` tag, because `Intl.DurationFormat` in
   V8 15.2 ignores the `numberingSystem` option and obeys the tag (measured).
3. Main calls `setCatalogue` with its built catalogue, so dialog titles, file filters, notifications,
   taskbar tooltips and error messages come out in the UI language.
4. The renderer's `main.tsx` awaits `bootLanguage()` before `createRoot().render()`: one
   `ui:info` call (about 1 ms), then for a non-English language the catalogue chunk, the UI font
   (§12) and `setCatalogue`. It sets `<html lang dir>` on the main window's page only. English starts
   as today, with no load and no flash; a translated UI never shows English first.
5. The recording windows (`Toolbar`, `Region`, `Notes`, rendered by the same `main.tsx`) keep
   `lang="en"` and English text until the other account agrees (§9.5).

`app.getLocale()` is not used: with only `en-US.pak` it is always `en-US` (measured), and Chromium's
locale packs stay out (§3.2 row 19).

### 9.5 The recording side

The other account's files hold 310 unique candidate texts in 22 files by the first count (RecordingOptions.tsx 53,
Toolbar.tsx 49, `recordingIpc.ts` 27, `keystrokes.ts` 31 key names drawn into the video, …); a
stricter count over 43 TS and TSX files finds 239. They are not edited in this wave.

- The `recording` namespace exists, empty, owned by the other account. `scripts/i18n/pending.json`
  lists their files with the reason "other account: not yet agreed"; the scanner reports their
  strings as pending, never as failures.
- To join later they import `t` and `T` like any file and add keys under `recording.*`. Nothing
  else changes: no file of ours reads their text, and their windows already receive the catalogue
  through `main.tsx`.
- Every function of ours they import keeps its exact output in every language: `formatTime`
  (`engine/project.ts:225`, used by `Toolbar.tsx:188`), `Icon`, the `ffmpeg.ts` runner and its
  English messages, `projects.ts`, `inputEdits`. Our own call sites that show times move to
  `fmt.clock` (§11), and `formatTime` stays ASCII.
- In a translated UI, Home's Recording options and Recording presets panels (mounted at
  `Home.tsx:978` and `:987`) stay English inside a translated page. Settings › Language says so (§2.5)
  and those panels get `lang="en"` on their container (a line in `Home.tsx`, our file), so screen
  readers switch voice.

### 9.6 Code that reads English text

About a dozen places decide something by matching English text. Each is changed so it no longer
depends on the language; in English each decides exactly as today (test 72).

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

### 9.7 What stays untranslated

- Brand names (Flown, Qbexel), codec and container names (H.264, HEVC, AV1, VP9, CineForm, ProRes,
  MP4, WebM, WAV, FCPXML, EDL), file extensions, technical identifiers (1080p, 16:9, 60 fps, 4K,
  version numbers), each written with Latin digits. They are marked `dnt` in the meta file and the
  glossary, and the checker requires them unchanged in every translation.
- Keycap names (§14.1) and `aria-keyshortcuts` values.
- The user's content: project names, captions, transcripts, notes, chapter titles, preset names.
- Everything written into exported files and project files: file names, sidecar suffixes,
  descriptions, subtitle stream names (`languageName`, `Intl.DisplayNames(['en'])`), chapter
  fallbacks, stem names, timeline names (§0 decision 10). Nothing drawn into frames reads the UI
  language: the same project exports the same bytes on every PC. Wave 11's guide words (`GUIDE_WORDS`)
  follow the guide's own language, as wave 11 designed.
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
  options, notification options);
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
   otherwise its fragments stay keys of their own with `merge: true` (§9.3).
5. `<T>` renders a fragment and `t()` a string, so no element is added or removed. Bidi isolation is
   off in English (§13.3).
6. Nothing in CSS changes in an extraction step. Logical properties are part X7 (§13.1), guarded the
   same way.
7. Strings that reach exported files or project files are not extracted to the UI catalogue (§9.7);
   they move to `src/shared/render/outputWords.ts` as plain English constants, so a later "language of
   files" choice has one place to start.
8. A string whose English must change for translation (an English-only grammar trick that cannot be a
   message) is not changed in this wave: it is listed in `scripts/i18n/english-changes.md` for the
   owner (§0 decision 12) and stays a `merge` key.

### 10.4 Steps

| Step | Who | What | Guard |
|---|---|---|---|
| S0 | lead, in the contracts (§21.0) | the runtime, the empty namespace files, the English-guard tour (tests 9 and 10) with no baseline yet | tests 1–8 |
| S1 | parts P1–P7 in parallel | the new features; their new UI text is written as messages from the start | each part's tests |
| S2 | lead, after P1–P7 merge | **records the baseline** of tests 9 and 10 on the merged build: the English UI as it will stay | — |
| S3 | parts X1–X7 in parallel (§21.8) | extraction, file list by file list; X7 the CSS | tests 9 and 10 after every merge; test 69 |
| S4 | lead | turns the scanner from *report* to *fail* (`scripts/i18n/config.json`, `"scan": "fail"`) | test 61 on the whole tree |
| S5 | reviewers (§15) | Bangla drafted, reviewed and approved; `npm run i18n:build` | tests 62, 65 |

The baseline is recorded once, at S2, and changed only when a later feature changes the English UI
on purpose, with that change named in its commit. It is never re-recorded to make an extraction pass.

### 10.5 How the extraction is split

Parts own **files** (the sources they edit) and **namespaces** (the JSON files they add keys to). No
file and no namespace has two owners, so the parts merge without conflicts. Shared copy modules go to
the part whose screens use them.

| Part | Source files | Namespaces |
|---|---|---|
| X1 · Editor shell | `views/Editor.tsx`, `App.tsx`, `Timeline*.tsx`, `Transport*.tsx`, `PreviewStage.tsx`, `CommandPalette.tsx`, the shortcuts editor, `src/shared/editor/commands.ts`, `shortcuts.ts`, `multiSelectCopy.ts` | `editor`, `timeline`, `commands`, `keys` |
| X2 · Panels | `editor/panels/*` for style, background, brand, zoom, cursor, magnifier, spotlight, camera, director, sound, music, voice, sound finder, shapes, texts, callouts, titles, graphics; `voiceCopy.ts`, `soundsCopy.ts`, `directorCopy.ts` | `style`, `zoom`, `camera`, `sound`, `text` |
| X3 · Captions and smart tools | captions panels, Captions Studio controls, transcription, speech and AI-on-this-PC UI, wave 11's guide, chapters and short-clip UI; `speechCopy.ts` | `captions`, `smart` |
| X4 · Review and project tools | review mode, versions, Polish, notes, search, share, publish, import, duplicate; `review/copy.ts`, `polishCopy.ts`, `notesCopy.ts` | `review` |
| X5 · Export, settings, Home and main | `ExportDialog.tsx`, `ExportBundleOptions.tsx`, wave 12's export components, `exportPresets.ts` labels, `exportPlan.ts` `ENCODER_NAMES`, `settings/*`, `Home.tsx` (not the recording panels it mounts), every `src/main` file that is ours (dialogs, notifications, taskbar, errors), `longJobs.ts`; the error codes of §9.6 | `home`, `export`, `settings`, `errors`, `main`, `common` |
| X6 · Shared helpers and formatting | the call sites of `formatClock`, `formatDuration`, `formatBytes`, `sizeText`, `clockTime`, `formatTick`, `formatLevel`, `formatRate`, `zoomText`, the two `lengthText`s and the 8 locale-less `toLocale*()` calls, moved to `fmt` (§11) | none: X6 adds no message |
| X7 · Right-to-left styles | every `*.css` file except the `:lang()` block P6 adds to `styles.css` | none |

The exact file lists are generated at S2 from the merged tree by `scripts/i18n/split.mjs` into
`scripts/i18n/parts.json`, with these rules, and the lead resolves any file two rules claim before S3
starts. X6 edits only the lines that call a formatter, in files the other parts also edit; it merges
**first** in S3, and the other X parts rebase on it (call-site lines are not lines they extract).

### 10.6 The English guards (tests 9 and 10)

`tests/e2e/english-guard.e2e.cjs` drives a fixed tour of the app under xvfb with English and the
`ui` preference absent: Home (with and without projects), the editor on two fixture projects (one
16:9 with camera, captions, chapters and music; one 9:16), every panel tab, the timeline with a
selection, the command palette with an empty and a typed query, the shortcuts editor, Review mode,
Versions, Polish, the export dialog in every format and mode with Settings open, *Also save* all on,
the running and done views of a short export, Settings in every section, a notice, an error notice,
and a native dialog title (through a test hook in main that records the options of
`dialog.showSaveDialog` and notifications instead of showing them). The recording windows are
included; they must not change either.

- **Test 9, text and names**: for each screen, `document.title`, `body.innerText`, and for every
  element its `aria-label`, `title`, `placeholder`, `alt`, `aria-valuetext`, `aria-describedby` text,
  `role` and accessible name, plus the main-process strings recorded by the hook. Compared with the
  baseline **exactly**, string for string.
- **Test 10, layout**: for every element with text, its tag, box (rounded to 0.5 px), computed font
  family, size, weight, line height, colour, `direction` and `text-align`; and a screenshot of each
  screen compared pixel for pixel with the baseline, allowing 0.1% of pixels to differ by at most 2
  levels (font anti-aliasing under xvfb). Any box that moves fails.

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
}
```

- Units and codec names stay Latin in every language (`MB`, `fps`, `kbps`, `px`, `1080p`).
- The timecode on the timeline, the transport and Review mode uses `fmt.clock`: Bangla digits in the
  Bangla UI by default (§0 decision 9), Western digits by choice.
- Text that must stay ASCII never goes through `fmt`: YouTube chapter stamps (`formatTimestamp`,
  `chapters.ts:50`), file names, timecodes inside exported files, ffmpeg arguments, logs.
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
| Date and time (medium, short time) | ৭ নভে, ২০২৬, ২:০৫ PM | | 7 नव॰ 2026, 2:05 pm | 7 nov 2026, 14:05 |
| List of three | A, B এবং C | | | |
| 2 min 5 s (long) | ২ মিনিট, ৫ সেকেন্ড | | 2 मिनट और 5 सेकंड | |
| Relative | ৩ মিনিট আগে, গতকাল | | | |

Empty cells were not measured; P6's test 53 records them. Spanish (`es`) does not group four-digit
numbers (1234, but 12.345).

- Indian grouping (১২,৩৪,৫৬৭) is CLDR's for `bn` and `hi`, which matches the Bangla style guides
  (10,00,000).
- Digits are a tag on the format locale, never an option (§9.4). Hindi defaults to Western digits
  (CLDR) with Devanagari digits (০ → ०) as the choice.
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

`--font-mono` (timecodes) keeps Cascadia Mono first: it has no Bangla digits, so they come from the
Bengali face, whose digits are tabular.

### 12.2 Line height and size

Bangla and Devanagari marks above and below the letters need room. Measured with Noto Sans Bengali at
100 px: with `line-height: 1` the top marks are clipped by 0.145 em (chandrabindu and reph, screenshot
`i18n/probe3/shot3.png`), at 1.25 by 0.02 em, at 1.45 not at all. So P6 adds one block to
`styles.css`, which changes nothing in English:

```css
:root:lang(bn), :root:lang(hi) {
  --leading-tight: 1.4;
  --leading-normal: 1.6;
  --text-2xs: 12px;
  --text-xs: 12px;
  --tracking-caps: 0;
}
```

and `:lang(bn)`/`:lang(hi)` overrides for the three `line-height: 1` rules (`titles.css:44`,
`editor.css:845`, `commands.css:20`) and the fixed pixel line heights of 10–18 px, each raised to at
least 1.4 times its font size. Letter spacing is 0 in these scripts (spacing pulls conjuncts apart);
`text-transform: uppercase` has no effect on them and stays.

### 12.3 Longer text

Translations run longer than English (Microsoft's planning figure is +40%, and short strings can
double). The `en-XA` pseudo-locale (§16.3) adds 40% and brackets to every message in development, and
the e2e check flags any element with `text-overflow: ellipsis` whose `scrollWidth` exceeds its
`clientWidth` in it. Fixed-width controls that cannot grow get a `maxLength` in their meta entry,
which the checker enforces per language.

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
each computes to the same value, so the English guards (tests 9 and 10) prove nothing moved.

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

Buttons and menu items that have a shortcut gain `aria-keyshortcuts` with the shortcut in its fixed
syntax (`Control+Shift+Z`, `Shift+R`), built by `ariaKeys(accelerators)` in `shortcuts.ts`. It is
never translated. Screen readers announce it after the name; the names do not change (§0 decision
12). It is added by X1 after its extraction, as a separate commit, and is outside what test 9 compares.

### 14.3 Screen readers

- `<html lang>` is the bare language (`bn`, not `bn-BD`): NVDA with Chrome reads a region subtag that
  has no matching voice in English (PowerMapper's tests with NVDA 2025.3).
- NVDA's bundled eSpeak NG has a Bangla voice. Windows Narrator has none (Microsoft's list of Narrator
  voices has Hindi, Spanish and Arabic, not Bangla). Settings › Language says so for Bangla (§2.5):
  "Screen readers: NVDA reads Bangla. Windows Narrator has no Bangla voice yet."
- Every accessible name, description, live-region message and role description is a message and is
  translated with the visible text; the guard tour (test 9) lists them, so none is missed.
- English parts left inside a translated page (the recording panels, §9.5) carry `lang="en"` so the
  reader switches voice.
- Live regions (`aria-live`, 109 regions) announce the translated text; announcements are built as
  whole messages, never by joining fragments, so the reader does not pause mid-sentence.

---

## 15. Translations: drafted by an AI service, approved by people

### 15.1 Who

Per language, two native speakers (§0 decision 6):

- a **translator-reviewer**, who corrects the draft in context and marks each string *reviewed*;
- an **approver**, who reads each reviewed string on its screen and marks it *approved*, or sends it
  back with a note.

For Bangla: the owner and one more person, both writing Bangladesh's standard Bangla. For Spanish and
Hindi: two people each, found by the owner. One person never approves their own correction.

### 15.2 Glossary first

Before any draft, the two reviewers agree a glossary in `translations/glossary.csv` (term, part of
speech, note, do-not-translate, then `bn`, `es`, `hi`): about 200–300 terms (export, clip, cut,
timeline, playhead, zoom, caption, chapter, preset, stem, render, track, project, recording, undo,
the panel names, the command categories). The do-not-translate list holds the brand, codec, format and
unit names of §9.7. Sources: Microsoft's Bangla (India) style guide and terminology, Mozilla's bn-BD
style guide: address the user as আপনি; no Sadhu bhasha; keep brand names; the dari `।` ends sentences;
Indian grouping 10,00,000; dates day, month, year; the week starts on Sunday. Each choice is made once,
in the glossary (for example "Export": রপ্তানি, the native word, or এক্সপোর্ট, the transliteration
software users meet elsewhere).

### 15.3 Drafts, at development time only

`node scripts/i18n/draft.mjs --lang bn --ns <ns>` is run by a person on their own PC with their own key
for an AI service they choose. It is not part of the app, never ships, and the app never calls it.

- It sends only: the English messages of one namespace, each message's description, placeholders,
  the plural categories the language needs, `maxLength`, the glossary rows, and the guard tour's
  screenshot of the message's screen (§10.6; fixture projects only, never a user's data).
- It asks for ICU output with the placeholders unchanged, and writes `translations/bn/<ns>.json` with
  `state: 'draft'` and the English `sourceHash`.
- Its output goes straight through the catalogue checks (§16.2); a draft that fails them is marked
  `state: 'draft'` with the check's message as its note, never dropped silently.
- An optional second pass asks the service to score each draft for errors (in the style of GEMBA-MQM);
  the score only sorts the reviewers' list, it approves nothing.

### 15.4 Review in context

- **The sheet.** `npm run i18n:sheet -- export --lang bn` writes `translations/bn/review.csv` (key,
  English, description, screen, draft, final, state, by, note), which any spreadsheet opens.
  `… import` reads it back, checks every row (§16.2), and records state, person and date. Git keeps the
  history. A self-hosted Weblate can read the same JSON files later; nothing needs it now.
- **The review build.** `FLOWN_I18N_REVIEW=1 npm run dev -- --lang bn` (never in a packaged build:
  `app.isPackaged` turns it off) shows a small overlay: hovering any text shows its key and state, and
  Ctrl+Alt+K copies the key. Strings still in draft are shown with a dotted underline, so reviewers
  see what is not yet approved.
- **Order**: the core namespaces first (§9.2), then the rest by how often their screens open.

### 15.5 Effort

The UI is 22,000–25,000 English words before wave 11 (§10.1); about 10,000–12,000 are on the core
surfaces. Post-editing a good draft runs at about 3,500–5,000 words a day against 2,000–3,000 for
translating from nothing, and Mozilla's pre-translation trial had 65.1% of drafts approved unchanged
and 94.6% usable. That puts the core surfaces at **3 to 6 reviewer-days per language**, the rest at
about as much again, and the approver's pass at about a third of that.

### 15.6 What ships

- `npm run i18n:build` writes the built catalogues (§9.2) from strings that are `approved` **and**
  whose `sourceHash` matches today's English. Everything else falls back to English, string by
  string.
- A language appears in the picker when 95% of all its keys and 100% of the core namespaces are
  approved and current. `src/shared/i18n/built/shipped.json` lists those languages; Settings and the
  Home offer read it.
- When an English message changes, its translations become stale: they leave the built catalogue at
  the next build, and the sheet lists them first.
- Each release's notes say which languages ship and how complete each is.

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
  `setThumbarButtons` tooltips;
- `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` and `new Intl.*(…)` with no locale or
  `undefined` in UI code;
- `t('…')` with a key that does not exist in English.

Exceptions live in `scripts/i18n/allow.json`, each with a reason (font stacks, ids, ffmpeg arguments,
CSS values, AI prompts in `src/main/ai/*`, log lines, test ids). The other account's files are listed
in `scripts/i18n/pending.json` and reported as pending, never as failures (§9.5).

### 16.2 The catalogue checks (`scripts/i18n/check.mjs`)

For English: every key used exists, no key is unused, every message parses
(`@formatjs/icu-messageformat-parser` 3.5.22, a devDependency), every meta entry exists.

For each translation:

- it parses; its placeholder names equal English's; its rich tags equal English's;
- each plural lists `other` and only categories of `new Intl.PluralRules(lang)`;
- no `#` and no `{x, number}` (§9.3); no `'{`, `'}` or `'#`;
- every do-not-translate term of the English message is present unchanged;
- no bidi control characters, no HTML, no `<` outside the four rich tags;
- the length is within `maxLength`, counted in graphemes (`Intl.Segmenter`);
- the blank lines of the English message are kept (`splitError`, §9.6);
- in `bn` and `hi`, no run of Latin letters other than do-not-translate terms and placeholders;
- `sourceHash` is current, or the string is reported stale.

`--check` mode of `i18n:build` fails when the committed built catalogues differ from what the
translation files give.

### 16.3 Pseudo-locales (development only)

`en-XA`: accented letters, brackets and +40% length (`[Ēẋƥōŕţ ţĥĕ ṽĩďēō ·····]`), to find text that
was missed (anything still plain ASCII in the guard tour) and text that is cut off (§12.3). `ar-XB`:
reversed text with right-to-left marks and `dir="rtl"` (§13.4). Generated by `npm run i18n:pseudo`
into a gitignored folder; selectable only with `FLOWN_I18N_PSEUDO=en-XA` in an unpackaged build.

### 16.4 Where the checks run

- **Vitest**: tests 61–68 run with every `npm test`.
- **CI**: a new workflow `.github/workflows/checks.yml` on every push and pull request, Ubuntu,
  `contents: read`: `npm ci`, `npm run typecheck`, `npm run i18n:check` (scanner, catalogue checks,
  built-catalogue check) and the i18n vitest files. No secrets; it publishes nothing.
- **Release**: `scripts/predist.mjs` runs `npm run i18n:check` as a new step 5, so an installer
  cannot be built with a string that has no key or a catalogue that does not match its sources.

Until step S4 (§10.4) the scanner's findings are a report; after S4 they fail every check above.

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
  `lang="en"`; NVDA reads Bangla (§14.3); the restart notice is `role="status"`.
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

- at most 64 KB (larger files are refused unread past the limit); UTF-8; JSON; `flown` must be
  `"export-presets"` and `version` must be `1`;
- at most 50 presets; each `name` through `cleanPresetName` (trimmed, 1–60 graphemes, no control,
  bidi-control or private-use characters, no path separators); `options` through `normalizeOptions`
  (only known keys and values: formats, codecs allowed by `CODEC_POLICY`, rates, sizes); `bundle`
  through `normalizeBundle`; every other field dropped;
- a preset holds no path, URL, file name or command. Output paths come only from the save dialog, as
  today; batch file names go through `safeFileName`.

The same reader sanitises the `exportPresets` preference (`prefsIpc.ts`), so a hand-edited
`editor-prefs.json` is held to the same rules. Test 5 feeds both readers hostile input (deep nesting,
200 presets, 10 MB names, `__proto__` keys, wrong types, bidi controls).

### 18.3 Files written

- Stems and timelines are written only next to the path the user chose in this session's save dialog
  (`approvedPaths`), with names main derives; existing files are never replaced (" (2)"); every file
  is written to a temporary name and renamed.
- The recordings mode copies media out of the project folder and never opens a project file for
  writing (`projectCopy.ts:9`'s rule).
- Timeline files escape every name for XML and percent-encode every path (§8.6); a project or chapter
  name cannot break out of its attribute.

### 18.4 ffmpeg arguments

Codec arguments are built from fixed tables (§5.4) and numbers checked by `validateJob`; no user text
reaches them except paths, as today. The BWF `description` of a stem is a fixed English word.

### 18.5 The language preference

`ui` is read by `readUiPrefs`: `language` must be `'system'` or a `UiLanguage`, `digits` `'native'` or
`'western'`, `offered` an array of at most 8 `UiLanguage`s; anything else is absent. A language
without a built catalogue falls back to English.

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

- A transparent frame sends 4 bytes a pixel instead of 1.5: 8.3 MB per 1080p frame. Readback with
  `getImageData` is synchronous. Expect a transparent export to take 1.5 to 2 times as long as an opaque
  one through the raw route; P2 measures it on the reference clip and the dialog's hint gives the
  measured factor.
- 120 fps draws twice the frames. Motion blur takes 5 sub-frames at 120 fps instead of 10
  (`blurSamplesFor`, §5.6), so the drawing cost per second of video is about twice 60 fps, not four
  times.

### 19.3 Stems and timelines

The stem graph decodes the inputs once and writes all stems in one ffmpeg run. Budgets, measured by
P3 and P4: under 2 s for the 30 s e2e project and under 60 s for a 10-minute project with four stems;
a timeline file for 3,000 cuts under 2 MB, written in under 100 ms. The recordings mode's copying is
bound by the disk.

### 19.4 Start-up and memory

- English: no catalogue to load; `t()` on the static English messages; one more IPC call before the
  first render (about 1 ms).
- Bangla: the catalogue chunk (about 450 KB of JSON, estimated) and the UI font (249,868 B, read from
  the bundle) load before the first render; P6's budget for both is 50 ms. Messages are parsed on
  first use (about 15 µs each: 59 ms for 4,000, measured) and cached; the cache holds only messages
  that were shown.

### 19.5 Installer

| Item | Installer growth |
|---|---|
| Every codec, stem and timeline feature | 0 bytes: all encoders are in the shipped `ffmpeg.exe` (§5.1) |
| `intl-messageformat` and its parts | about 10 KB |
| Bangla catalogue (renderer and main) | about 55–75 KB (about 300 KB of JSON, compressed by the installer) |
| Hindi catalogue | about the same as Bangla |
| Spanish catalogue | about 25 KB |
| UI fonts | 0 bytes (already bundled for captions) |
| Chromium locale packs | 0 bytes (they stay out) |
| **Total** | **under 0.3 MB** |

Nothing in this wave comes near the 5 MB line. The installer itself stays as it is: its own pages
follow the Windows language among electron-builder's 26 bundled languages (Spanish and Arabic
included). NSIS has no Bengali language file, so the installer stays English for Bangla users, and
Flown switches after its first start when they choose.

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
  `tests/e2e/english-guard.e2e.cjs` and its tour `tests/e2e/uiTour.cjs` (tests 9 and 10) without a
  baseline; the baseline is recorded at step S2 (§10.4).
- **Types**: `src/shared/types.ts` (§4.1); `src/shared/api/export.ts` (§4.2, plus
  `ExportFinish.stems?: { stem: SoundStem; path: string; bytes: number }[]` and
  `ExportFinish.stemsProblem?: string`; `ExportRoute`'s WebCodecs codec gains `'hevc' | 'av1'` in
  `exportPlan.ts`); `src/shared/api/prefs.ts` (`PrefKey` gains `'exportPresets' | 'ui'`, with
  `PREF_KEYS`); `src/shared/api/ui.ts` (new, below); `RenderScene.alpha` (`compositor.ts`, the field
  only).

  ```ts
  // src/shared/api/ui.ts
  export type UiLanguage = 'en' | 'bn' | 'es' | 'hi'
  export interface UiPrefs { language?: 'system' | UiLanguage; digits?: 'native' | 'western'; offered?: UiLanguage[] }
  export interface UiInfo {
    language: UiLanguage
    formatLocale: string
    dir: 'ltr' | 'rtl'
    digits: 'native' | 'western'
    /** The language "Follow Windows" gives now. */
    system: UiLanguage
    /** A shipped language Windows lists that Home may offer once (§2.7), or null. */
    offer: UiLanguage | null
    shipped: UiLanguage[]
    prefs: UiPrefs
  }
  export interface UiApi {
    uiInfo(): Promise<UiInfo>
    setUiPrefs(prefs: UiPrefs): Promise<void>
    /** Closes every window the way quitting does (the editor saves), then starts Flown again. */
    relaunch(): Promise<void>
  }
  ```
- **Readers and tables, in full and frozen with their tests** (they are security or compatibility
  boundaries):
  - `src/shared/render/proFormats.ts` tables: `FORMAT_CODECS`, `DEFAULT_CODEC`, `ALPHA_CODECS`,
    `CODEC_POLICY = { hevcSoftware: false, prores: false }`, `codecOf(o: ExportOptions): ExportCodec`,
    `canAlpha(format: ExportFormat, codec: ExportCodec): boolean`, `isIntermediate(codec): boolean`,
    `EXPORT_FPS: readonly ExportFps[]`.
  - `normalizeOptions` (`exportPresets.ts`) and `normalizeBundle` (`exportBundle.ts`) with the rules
    of §4.3; the batch reader's `userPresets` and `'4:5'`.
  - `RATIOS['4:5']` (`layout.ts`); the `migrateProject` guard of §4.6.
  - `src/shared/render/userPresets.ts`: `USER_PRESET_LIMIT = 50`, `PRESET_FILE_LIMIT = 65536`,
    `function cleanPresetName(raw: unknown): string | null`,
    `function readUserPresets(raw: unknown): UserPresetStore | null`,
    `function readPresetFile(text: string): { presets: UserExportPreset[]; skipped: number } | null`,
    `function presetFileText(presets: readonly UserExportPreset[]): string`,
    `function newPresetId(random: () => number): string`.
  - `validateJob` (`exportJob.ts`) for `codec`, `alpha`, `stems`, `fps` 24/25/120 and format `wav`:
    the codec must be in `FORMAT_CODECS[format]` and allowed by `CODEC_POLICY`; `alpha` needs
    `canAlpha` and a raw `rgba` or `bgra` input; `stems` needs a non-GIF, non-batch job with sound.
  - `src/shared/i18n/locale.ts`: `function readUiPrefs(raw: unknown): UiPrefs | null`.
- **The i18n runtime, in full** (§9.1): `src/shared/i18n/t.ts`, `src/shared/i18n/isolate.ts`
  (`function isolate(value: string, dir?: 'ltr' | 'rtl'): string`), `src/shared/i18n/fmt.ts` with the
  **English profile only** (§11.2; other languages return the English output until P6), the empty
  namespace files `src/shared/i18n/messages/en/<ns>.json` and `.meta.json` for every namespace of
  §9.2, their `index.ts` and the `MessageKey` type, `src/renderer/src/i18n/T.tsx`, and
  `"resolveJsonModule": true` in both tsconfigs. `intl-messageformat` 12.1.4 is added to
  `devDependencies` (exact version) and to `BUNDLED` in `scripts/notices.mjs`.
- **IPC and preload, in full**: channels `export:probeCodec`, `export:errorCode`,
  `export:writeTimeline`, `export:savePresetFile`, `export:openPresetFile`, `ui:info`,
  `ui:setPrefs`, `ui:relaunch`, each registered with a stub in its owner's new file (below);
  `src/preload/ui.ts` (new) and the new calls in `src/preload/export.ts` and `index.ts`.
- **Seams, completed** (each calls a stub in the owning part's new file; stubs keep today's
  behaviour):
  - `exportArgs.ts` `ffmpegPlan`: a job with a non-default `codec` → `proPlan` (P1,
    `src/main/proArgs.ts`); format `wav` → `wavPlan` (P3, `src/main/stemsArgs.ts`).
  - `exportPlan.ts` `exportRoutes`: a non-default codec or `alpha` → `codecRoutes` (P1,
    `src/shared/render/codecRoutes.ts`).
  - `codec.ts` `ivfFileHeader` gains `fourcc: 'VP90' | 'AV01' = 'VP90'`; `encoders.ts`
    `WebCodecsSink`'s `framing` gains `'ivf-av01'`.
  - `exporter.ts`: `prepareRoute` sends WebCodecs routes for `'hevc'` and `'av1'` to `proSink` (P1,
    `src/renderer/src/render/proEncoders.ts`); `soundOf` adds `stems: stemJobOf(project, options,
    analysis)` (P3, `src/shared/render/stems.ts`).
  - `exportBundleRun.ts`: after the sidecars, `writeTimelineStep` (P4,
    `src/renderer/src/editor/timelineRun.ts`).
  - `src/main/index.ts`: `initUiLanguage()` first in `whenReady`, then `registerUiIpc()`,
    `registerCodecProbeIpc()`, `registerTimelineIpc()`, `registerPresetFileIpc()`.
  - `src/renderer/src/main.tsx`: `await bootLanguage(view)` before rendering (P6, stub returns
    English).
  - `SettingsDialog.tsx`: `SettingsSection` gains `'language'`, first in the list, mounting
    `LanguageSection` (P6, stub `null`). `Home.tsx`: `<LanguageOffer />` at the top of the content
    (P6, stub `null`) and `lang="en"` on the two recording panels' containers (§9.5). `App.tsx`:
    `<ReviewOverlay />` (P7, stub `null`).
  - `prefsIpc.ts`: sanitisers for `'exportPresets'` (`readUserPresets`) and `'ui'` (`readUiPrefs`);
    `export function readPrefSync(key: PrefKey): unknown`.
  - `package.json` scripts `i18n:check`, `i18n:build`, `i18n:sheet`, `i18n:pseudo`, `i18n:extract`,
    pointing at P7's files (stubs that print "not ready" and exit 0); `scripts/predist.mjs` step 5
    calling `scripts/i18n/check.mjs --report`.
- Contracts tests: 1–8, and the tour of 9–10 without a baseline. Both typechecks and all of vitest
  pass.

### 21.1 Part P1 · Codecs, frame rates and 4:5

| File | Exports or change |
|---|---|
| `src/shared/render/proFormats.ts` (functions; the tables are the contracts') | `function rateFps(fps: number): number`; `function blurSamplesFor(fps: number): number` (10 up to 60, 5 at 120); `function estimateBytes(o: ExportOptions, size: { width: number; height: number }, seconds: number, stems?: number): number`; `const MB_PER_MINUTE_1080P60: Readonly<Record<'cineform' \| 'cineform-alpha' \| 'animation' \| 'prores-422' \| 'prores-4444' \| 'stem', number>>` |
| `src/shared/render/codecLevels.ts` (new) | `function hevcLevel(width: number, height: number, fps: number): number` (level × 30); `function av1Level(width: number, height: number, fps: number): { level: string; seqLevelIdx: number }`; `function hevcCodecString(width: number, height: number, fps: number): string`; `function av1CodecString(width: number, height: number, fps: number): string`; `function h264Fits(width: number, height: number, fps: number): boolean` (level 5.2 or lower) |
| `src/shared/render/codecRoutes.ts` (new) | `interface CodecCaps { webcodecs: { hevc: boolean; av1: boolean }; gpu: { hevc: HevcEncoder[]; av1: Av1Encoder[] }; overrides: ExportCapabilities['overrides'] }`; `function codecRoutes(o: Pick<ExportOptions, 'format' \| 'codec' \| 'alpha' \| 'encoder' \| 'targetSizeMB' \| 'resolution' \| 'aspect'>, caps: CodecCaps, size: { width: number; height: number }): ExportRoute[]`; `function amfAv1Fits(width: number, height: number): boolean` |
| `src/shared/render/exportPlan.ts` | `ENCODER_NAMES` gains the HEVC, AV1 and intermediate encoders; `EXPORT_BLUR_SAMPLES` use goes through `blurSamplesFor` (the value for 30 and 60 fps is unchanged) |
| `src/main/proArgs.ts` (new) | `function proVideoArgs(job: ExportJob, encoder: FfmpegVideoEncoder): string[]`; `function proAudioArgs(job: ExportJob): string[]` (PCM for intermediates, else today's); `function copyProArgs(kind: 'hevc' \| 'av1'): string[]`; `function proPlan(job: ExportJob, given: PlanPaths): FfmpegPlan` |
| `src/main/codecProbe.ts` (new) | `const HEVC_ENCODERS: HevcEncoder[]`; `const AV1_ENCODERS: Av1Encoder[]`; `function probeCodecArgs(encoder: HevcEncoder \| Av1Encoder): string[]`; `function probeCodec(codec: 'hevc' \| 'av1', run?: (args: string[]) => Promise<boolean>): Promise<FfmpegVideoEncoder[]>` (once per codec per session); `function registerCodecProbeIpc(): void` |
| `src/main/hwEncoders.ts` | `encoderPixelFormat` and `gpuEncoderOptions` take the HEVC and AV1 encoders (`-hw_encoding 1` for `hevc_mf`); the H.264 list and probe do not change |
| `src/main/exportArgs.ts` | `isTwoPass` adds `libaom-av1` (and `libx265` when `CODEC_POLICY.hevcSoftware`) |
| `src/renderer/src/render/proEncoders.ts` (new) | `function hevcConfigs(width: number, height: number, fps: number, bitrate: number): VideoEncoderConfig[]`; `function av1Configs(width: number, height: number, fps: number, bitrate: number): VideoEncoderConfig[]`; `function webCodecsSupport(width: number, height: number, fps: number): Promise<{ hevc: boolean; av1: boolean }>`; `function proSink(route: Extract<ExportRoute, { video: 'webcodecs' }>, canvas: HTMLCanvasElement, fps: number, bitrate: number, startJob: (color: ColorTags) => Promise<void>): FrameSink` |
| Tests | 11–24 |

### 21.2 Part P2 · Transparency

| File | Exports or change |
|---|---|
| `src/shared/render/alpha.ts` (new) | `function alphaOf(o: ExportOptions): RenderScene['alpha']`; `function seeThrough(project: Project, alpha: 'background' \| 'overlays', w: number, h: number): boolean` (false when the card fills the frame); `function transparentJoins(windows: readonly JoinWindow[]): readonly JoinWindow[]` (always empty) |
| `src/renderer/src/render/compositor.ts` | the `alpha` branch of `drawFramePicture` (§6.2) |
| `src/renderer/src/render/encoders.ts` | `RawFrameSink` gains a fifth parameter `alpha = false`: frames read with `getImageData`, sent as `'rgba'` |
| `src/renderer/src/editor/exporter.ts` | the canvas with `alpha: true`; `scene.alpha`; `transparentJoins` in the plan; the alpha `RawFrameSink` |
| `src/renderer/src/editor/ExportPreview.tsx`, `alphaPreview.css` (new) | the alpha canvas over the checkerboard (§6.5) |
| Tests | 25–29 |

### 21.3 Part P3 · Stems and the WAV format

| File | Exports or change |
|---|---|
| `src/shared/render/stems.ts` (new) | `const STEM_FILE_WORDS: Readonly<Record<SoundStem, string>>` ('Voice', 'System sound', 'Recording', 'Music', 'Effects'); `function stemJobOf(project: Project, options: ExportOptions, analysis: AudioAnalysis \| null): StemJob \| undefined`; `function stemsOfJob(job: ExportJob, files: SoundFiles): SoundStem[]`; `function stemSamples(frames: number, fps: number): number`; `function stemPlan(job: ExportJob, files: SoundFiles, first: number): { args: string[]; graph: string; outputs: { stem: SoundStem; label: string }[] }` |
| `src/shared/render/audioPlan.ts` | `RecordingPart.gainDb?: number` (one fixed gain instead of `normalize`); `recordingGraph`, `musicBranch`, the effect branch builders and `fadeFilters` exported; every graph today's jobs build is unchanged (test 3) |
| `src/main/stemsArgs.ts` (new) | `function stemOutputArgs(stem: SoundStem, path: string): string[]`; `function wavPlan(job: ExportJob, given: PlanPaths): FfmpegPlan`; `function stemPaths(output: string, stems: readonly SoundStem[], exists: (p: string) => boolean): Partial<Record<SoundStem, string>>`; `function writeStems(job: ExportJob, output: string, inputs: SoundInputs, signal: AbortSignal): Promise<{ stem: SoundStem; path: string; bytes: number }[]>` |
| `src/main/exportIpc.ts` | after `moveIntoPlace`: `writeStems` (§7.6), `ExportFinish.stems` / `stemsProblem`, cancel removes partial stems; `SAVE_FILTERS` gains WAV |
| `src/main/exportJob.ts` | `EXPORT_EXTENSIONS` gains `wav` |
| Tests | 30–35 |

### 21.4 Part P4 · Timelines

| File | Exports or change |
|---|---|
| `src/shared/interchange/timelinePlan.ts` (new) | the types and the two builders of §8.2 |
| `src/shared/interchange/fcpxml.ts`, `xmeml.ts`, `edl.ts` (new) | `function fcpxml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>, projectId: string): string`; `function xmeml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string`; `function edl(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string`; `function markerEdl(plan: TimelinePlan): string \| null`; `const EDL_EVENT_LIMIT = 999` |
| `src/shared/interchange/fileUrl.ts` (new) | `function fileUrl(windowsPath: string, form: 'fcpxml' \| 'xmeml'): string`; `function xmlText(s: string): string`; `function xmlAttr(s: string): string`; `function asciiName(s: string, fallback: string): string` |
| `src/main/timelineIpc.ts` (new) | `function registerTimelineIpc(): void`; `function writeTimeline(request: TimelineRequest, deps?: TimelineDeps): Promise<TimelineResult>`; `function copyRecordings(projectId: string, folder: string, voice: VoiceStrength \| null, deps?: TimelineDeps): Promise<Partial<Record<TimelineMedia, string>>>`; `function timelinePaths(video: string, kinds: readonly TimelineKind[], withMarkers: boolean, exists: (p: string) => boolean): Partial<Record<TimelineKind \| 'markers', string>>` |
| `src/renderer/src/editor/timelineRun.ts` (new) | `function writeTimelineStep(project: Project, request: Omit<TimelineRequest, 'plan'>, exported: { fps: number; frames: number; width: number; height: number }): Promise<TimelineResult>` |
| Tests | 36–44 |

### 21.5 Part P5 · Export dialog and presets

| File | Exports or change |
|---|---|
| `src/shared/render/exportRows.ts` (new, pure) | `interface CodecUiCaps { hevc: 'probing' \| 'none' \| FfmpegVideoEncoder[] \| 'webcodecs'; av1Gpu: boolean; h264Gpu: boolean }`; `interface RowsState { …the chips, which are disabled and the message key of each reason, and each row's hint… }`; `function settingsRows(o: ExportOptions, caps: CodecUiCaps, ctx: { seeThrough: boolean; joins: boolean; size: { width: number; height: number } }): RowsState`; `function pickCodec(o: ExportOptions, codec: ExportCodec): ExportOptions`; `function pickBackground(o: ExportOptions, alpha: ExportSettings['alpha'] \| undefined): ExportOptions` (switches the codec in the same step, §2.1); `function pickFps(o: ExportOptions, fps: ExportFps): ExportOptions`; `function pickResolution(o: ExportOptions, r: ExportSettings['resolution']): ExportOptions` (4K at 120 fps with H.264 → 60 fps); `function sizeLine(o: ExportOptions, size: { width: number; height: number }, seconds: number): string` |
| `src/shared/render/userPresetsEdit.ts` (new) | `function savePreset(store: UserPresetStore, name: string, options: ExportOptions, bundle: Omit<BundleOptions, 'languages'> \| undefined, now: number, random: () => number): UserPresetStore`; `function renamePreset(store: UserPresetStore, id: string, name: string): UserPresetStore`; `function updatePreset(store: UserPresetStore, id: string, options: ExportOptions, bundle: Omit<BundleOptions, 'languages'> \| undefined): UserPresetStore`; `function deletePreset(store: UserPresetStore, id: string): UserPresetStore`; `function importPresets(store: UserPresetStore, incoming: readonly UserExportPreset[], now: number, random: () => number): { store: UserPresetStore; added: number; skipped: number }`; `function suggestName(o: ExportOptions): string`; `function uniqueName(taken: readonly string[], name: string): string` |
| `src/shared/render/alsoSave.ts` (new) | `function stemsBlocked(o: ExportOptions, mode: 'single' \| 'batch', perChapter: boolean, hasSound: boolean): MessageKey \| null`; `function timelineBlocked(o: ExportOptions, mode: 'single' \| 'batch', perChapter: boolean): MessageKey \| null`; `function edlBlocked(cuts: number): MessageKey \| null`; `function stemsHint(stems: readonly SoundStem[]): string` |
| `src/shared/render/exportPresets.ts` | `instagram-feed` in `EXPORT_PRESETS`; `BATCH_ASPECTS` gains `'4:5'` (file label `4x5`); `batchItems` takes user presets; `EXPORT_PRESET_FILE_LABELS` (§9.6) |
| `src/renderer/src/editor/exportRows.tsx` (new) | `function CodecRow(props: { rows: RowsState; options: ExportOptions; onChange: (o: ExportOptions) => void }): JSX.Element \| null`; `function BackgroundRow(…same props…): JSX.Element \| null`; `function FrameRateRow(…same props…): JSX.Element` |
| `src/renderer/src/editor/UserPresets.tsx` (new) | `function UserPresets(props: { store: UserPresetStore; selected: string \| null; options: ExportOptions; bundle: Omit<BundleOptions, 'languages'>; onPick: (p: UserExportPreset) => void; onStore: (s: UserPresetStore) => void; batch?: { checked: readonly string[]; onToggle: (id: string) => void } }): JSX.Element`; `function SavePresetField(props: { suggestion: string; taken: readonly string[]; onSave: (name: string) => void; onCancel: () => void }): JSX.Element` |
| `src/renderer/src/editor/exportPro.css` (new) | the new rows, cards and menus |
| `src/renderer/src/editor/ExportDialog.tsx` | the rows, chips, hints, presets, batch, running and done views of §2.1–2.4, with the probes (`probeCodec`, `webCodecsSupport`) |
| `src/renderer/src/editor/ExportBundleOptions.tsx` | the Sound stems and Timeline chips and the Timeline rows (§2.3) |
| `src/main/presetFiles.ts` (new) | `function registerPresetFileIpc(): void` (`export:savePresetFile`, `export:openPresetFile` through `readPresetFile`) |
| Tests | 45–50 |

### 21.6 Part P6 · Language runtime, settings and fonts

| File | Exports or change |
|---|---|
| `src/shared/i18n/locale.ts` (the contracts wrote `readUiPrefs`) | `function languageOf(tag: string): string`; `function formatLocaleOf(language: UiLanguage, systemLocale: string, digits: 'native' \| 'western' \| undefined): string`; `function dirOf(language: string): 'ltr' \| 'rtl'`; `function resolveUiLanguage(prefs: UiPrefs \| null, preferred: readonly string[], systemLocale: string, shipped: readonly UiLanguage[]): UiInfo`; `const LANGUAGE_NAMES: Readonly<Record<UiLanguage, { own: string; english: string }>>` |
| `src/shared/i18n/fmt.ts` | the other languages' branch of every function (§11.3); the English profile stays as the contracts wrote it |
| `src/main/i18n.ts` (new) | `function initUiLanguage(): UiInfo`; `function registerUiIpc(): void`; `function relaunchApp(): void` |
| `src/renderer/src/i18n/boot.ts` (new) | `function bootLanguage(view: 'main' \| 'recorder'): Promise<UiInfo>` |
| `src/renderer/src/i18n/uiFonts.ts` (new) | `function loadUiFont(language: UiLanguage): Promise<boolean>` |
| `src/renderer/src/i18n/scripts.css` (new) | the `:lang(bn)`, `:lang(hi)` tokens and overrides of §12.2 (no edit to any other CSS file) |
| `src/renderer/src/settings/LanguageSection.tsx` (new) | `function LanguageSection(): JSX.Element` (§2.5) |
| `src/renderer/src/home/LanguageOffer.tsx` (new) | `function LanguageOffer(): JSX.Element \| null` (§2.7) |
| `src/shared/i18n/messages/en/language.json` | the Language section's and the offer's messages |
| Tests | 51–60 |

### 21.7 Part P7 · Checks and translation tools

| File | Exports or change |
|---|---|
| `scripts/i18n/lib/scan.cjs`, `scripts/i18n/scan.mjs` (new) | `scanSource(file: string, text: string, rules: ScanRules): Finding[]` with `Finding = { file, line, kind: 'jsx' \| 'attr' \| 'sink' \| 'locale' \| 'key', text }` |
| `scripts/i18n/lib/catalogue.cjs`, `scripts/i18n/check.mjs` (new) | `checkMessage(lang: string, english: string, meta: MetaEntry, translated: TranslationEntry, glossary: GlossaryRow[]): Problem[]`; `checkEnglish(messages, meta, usedKeys): Problem[]` |
| `scripts/i18n/build-catalogues.mjs` (new) | writes `src/shared/i18n/built/*.json` and `shipped.json`; `--check` |
| `scripts/i18n/extract.mjs`, `lib/extract.cjs` (new) | the codemod of §10.2 |
| `scripts/i18n/split.mjs` (new) | `scripts/i18n/parts.json` (§10.5) |
| `scripts/i18n/pseudo.mjs`, `sheet.mjs`, `draft.mjs` (new) | §16.3, §15.4, §15.3 |
| `scripts/i18n/allow.json`, `pending.json`, `config.json` (new) | §16.1 (`"scan": "report"` until S4) |
| `translations/glossary.csv`, `translations/README.md` (new) | the glossary's columns and the review steps of §15 |
| `src/renderer/src/i18n/reviewOverlay.tsx` (new) | `function ReviewOverlay(): JSX.Element \| null` (unpackaged builds with `FLOWN_I18N_REVIEW=1` only) |
| `.github/workflows/checks.yml` (new) | §16.4 |
| `scripts/predist.mjs` | step 5 runs `check.mjs` without `--report` once `config.json` says `"fail"` |
| Tests | 61–68, and the harness of 69 |

### 21.8 Extraction parts X1–X7 (step S3)

They start after the S2 baseline, each on the file list `scripts/i18n/parts.json` gives it (§10.5) and
the namespaces it owns. Each runs the codemod on its files, edits by hand what the codemod leaves,
adds its rows to `extraction-log.json` (one file per part: `scripts/i18n/log/x1.json` …, so no two
parts write the same file), and passes tests 9, 10 and 69 before it asks to merge.

| Part | Owns | Also | Tests |
|---|---|---|---|
| X6 · Formatting call sites (merges first) | the formatter call lines of §10.5 | `scripts/i18n/fmt-sites.json` | 73 |
| X1 · Editor shell | §10.5 row X1; namespaces `editor`, `timeline`, `commands`, `keys` | the command palette searches the UI-language title, the English title and the keywords; `CommandCategory` stays an id, with labels in `commands.category.*`; `ariaKeys` and `aria-keyshortcuts` (§14.2) as a separate commit | 70, 71 |
| X2 · Panels | §10.5 row X2; `style`, `zoom`, `camera`, `sound`, `text` | wave 10's moods and cut-style names | 69 rows |
| X3 · Captions and smart tools | §10.5 row X3; `captions`, `smart` | the UI digits never change caption content digits (`CaptionSettings.digits`) | 77 |
| X4 · Review and project tools | §10.5 row X4; `review` | `KIND_WORDS` (`review/copy.ts:18-36`) as plural messages | 78 |
| X5 · Export, settings, Home, main | §10.5 row X5; `home`, `export`, `settings`, `errors`, `main`, `common` | the error codes of §9.6; main's dialogs, filters, notifications and taskbar tooltips through main's `t()` | 72, 75 |
| X7 · Right-to-left styles | every `*.css` file but `i18n/scripts.css` | `direction: ltr` on the time-axis containers (§13.1) | 76 |

### 21.9 Not touched, ownership and merging

**Not touched by any part**: the recording side (listed at the top), `src/main/security.ts`, the CSP,
`windows.ts`, `appSettings.ts`, `electron-builder.config.cjs` (`electronLanguages` stays `['en-US']`),
`formatTime` and `formatTimestamp`, the project format beyond the guard of §4.6, `frameView.ts`, wave
10's join planning (`joins.ts` is read, not changed), wave 11's `GUIDE_WORDS`.

**Ownership in S1.** The files the contracts complete are edited by no part, except where this table
names an owner for code below the contracts' lines:

| Part | Existing files it edits |
|---|---|
| P1 | `exportPlan.ts` (`ENCODER_NAMES`, blur samples), `hwEncoders.ts`, `exportArgs.ts` (`isTwoPass`) |
| P2 | `compositor.ts` (`drawFramePicture`'s branch), `encoders.ts` (`RawFrameSink`), `exporter.ts`, `ExportPreview.tsx` |
| P3 | `audioPlan.ts`, `exportIpc.ts`, `exportJob.ts` (`EXPORT_EXTENSIONS`) |
| P4 | `exportBundleRun.ts` (below the contracts' call) |
| P5 | `ExportDialog.tsx`, `ExportBundleOptions.tsx`, `exportPresets.ts` (below `normalizeOptions`) |
| P6 | `fmt.ts` (the non-English branch) |
| P7 | `scripts/predist.mjs` (step 5) |

**Merge order.** S1: P1, P2, P3, P4, then P5 (it mounts the others' rows), with P6 and P7 at any
point. After S1 the lead runs both typechecks, all of vitest, `npm run build`, `npm run i18n:check
-- --report`, and under `xvfb-run`: `output-formats`, `languages`, `export`, `export-pack`, `render`,
`audit-audio-export`, `clean-voice`, `editing-polish`, `smart-tools`, `captions-studio`,
`vertical-video`, `versions`, `commands`, `ui`, `smoke`, `packaging`. Then S2 (the baseline), then
S3: X6 first, then X1–X5 and X7 in any order, each followed by tests 9, 10, 69 and the e2e list
above. Then S4 and S5 (§10.4).

---

## 22. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Old settings, presets or projects export differently through shared code (`normalizeOptions`, `exportRoutes`, `ffmpegPlan`, `drawFrame`, `planSoundtrack`). | Every new path is behind a field that is absent today; tests 1–4 are written before any change and never regenerated; argument lists and graphs are compared character for character. |
| 2 | The English UI changes during extraction (a lost space, a different number format, a moved box). | The codemod copies React's own whitespace; `fmt`'s English profile is today's code; test 69 per message; tests 9 and 10 on the whole UI after every merge; the baseline is recorded once (§10.4). |
| 3 | HEVC is exposed through a software encoder by accident (`hevc_mf` picking Windows' inbox or the Store extension's encoder). | `-hw_encoding 1` in the probe and in every encode (test 12); `CODEC_POLICY.hevcSoftware` false; no route lists `libx265` (test 15). |
| 4 | HEVC or ProRes patent or trademark claims. | §0 decisions 1 and 2: hardware-only HEVC, ProRes off, honest naming if it is ever on, never `apl0` (test 23). The binary already shipped is the owner's decision 1 (c). |
| 5 | GPU encoder settings untested (no GPU here); `av1_amf` pads 1080 lines. | Starting values from vendor options measured with `-h encoder=…`; calibration on the reference PC before release (§0 decision 14); `av1_amf` only for sizes it does not pad (test 13); every GPU route falls back to the next. |
| 6 | Transparent export looks different from the dialog's preview, or has dark edges. | One drawing path with one option (§6.2); straight alpha read with `getImageData` in both; e2e F5–F6 compare preview and export and check a 50% grey shadow and a red edge. |
| 7 | Editors read transparent files as opaque. | VP9 is for browsers, CineForm and Animation for editors (§2.1); tests decode with libvpx (§6.6); Resolve and Premiere imports checked on the reference PC (§0 decision 14). |
| 8 | Stems do not line up with the video or with each other. | One graph, one start (sample 0), one length (`stemSamples`, test 33); BWF `time_reference` 0; the known 20 ms microphone offset (issue #61) is the same in the video and in its stems. |
| 9 | Stems disagree with the video's loudness. | One fixed gain, the preview's (§7.4), stated in the dialog's hint; the video keeps `loudnorm`. |
| 10 | A timeline opens wrong in Premiere, Resolve or Final Cut (speed, offsets, paths, 24 versus 23.976). | Written directly, golden files (tests 37–39); exact rates, start at 0, cumulative rounding (test 36); WAV copies instead of M4A (§8.1); round trips in each editor before release, or the feature is labelled with the editors it was checked in. |
| 11 | Disk fills during an intermediate, stems or the recordings copy. | `estimateBytes` and `statfs` before starting (test 22); the video is never removed for a failed stem or timeline. |
| 12 | A hostile `.flownpreset` file. | Main-only reader with size, count and field limits, frozen with test 5; presets hold no paths (§18.2). |
| 13 | Translations wrong or offensive; machine drafts shipped by mistake. | Glossary first; two people per string; only `approved` and current strings reach the built catalogue (test 65); the release checks it (§16.4). |
| 14 | Translated text overflows or is cut. | `en-XA` +40% in development (test 64, e2e L9); `maxLength` per message; Bangla line heights (§12.2). |
| 15 | Bangla marks clipped, or timecodes jitter. | Line height 1.4 or more; Noto Sans Bengali with tabular digits (§12.1); e2e L4 measures ink bounds. |
| 16 | A translated UI flashes English, or breaks a decision that read English text. | The language and catalogue load before the first render (§9.4); every English-text decision moved to codes or flags (§9.6, test 72). |
| 17 | The recording side changes in a translated UI (digits in the recording bar, messages from `ffmpeg.ts`). | Their files are not edited (test 74); `formatTime` and `ffmpeg.ts`'s messages keep their output; their windows keep `lang="en"`. |
| 18 | Merge conflicts with waves 10 and 11 or between parts (`ExportDialog.tsx`, `exporter.ts`, `exportIpc.ts`, `audioPlan.ts`, `commands.ts`, `Editor.tsx`, the catalogues). | Contracts after both waves merge; one owner per file and per namespace (§21.9, §10.5); extraction after the feature parts; one log file per X part. |
| 19 | A translation is sent somewhere at runtime. | Catalogues are bundled; no fetch exists for them; the drafting script is not in the app (test 60). |
| 20 | The language preference breaks an older Flown. | `ui` and `exportPresets` are new keys in `editor-prefs.json`; `prefsIpc.ts` keeps unknown keys; an older Flown ignores them (test 5). |
| 21 | 120 fps or alpha exports are much slower than users expect. | Hints state the cost ("about twice as long as 60 fps"); blur samples halve at 120 fps; the alpha factor is measured by P2 and shown. |

---

## 23. Test plan

### 23.1 Unit tests (vitest). Each fails without the code of its rule.

**Contracts and guards** (§21.0)

1. **Projects**: the fixtures of the earlier guards (`tests/fixtures/vertical-old-projects.json`, the
   captions, wave 10 and wave 11 fixtures) migrate to byte-equal JSON; a project with
   `style.aspectRatio: '4:5'` reads as `'auto'`; no project gains a key.
2. **Stored export settings**: 40 stored values of `export-settings`, `export-batch` and
   `export-bundle` written by the release before this wave (every format, preset, aspect, quality, encoder, size target,
   subtitle streams) go through `normalizeOptions`/`normalizeBundle` and `tweakOptions` and are written
   back byte for byte; `codec: 'h264'` on MP4 is deleted; `codec: 'prores-422'` is deleted while
   `CODEC_POLICY.prores` is false; `alpha` on MP4 is deleted; `fps: 24` is kept and `fps: 23.976`
   becomes 60 as today's `pick` does.
3. **Arguments and graphs**: `ffmpegPlan` for every format × quality × encoder × size target × fps 30
   and 60 (GIF fits included) and `planSoundtrack` for the audio fixtures equal the digests taken in
   the contracts commit, character for character.
4. **Drawing**: `drawFrame` call logs (recording fake context, as `verticalEquivalence.test.ts`) for
   six fixture projects at 24 times, with `alpha` absent, equal the snapshots.
5. **Preset readers**: `readUserPresets`, `readPresetFile`, `cleanPresetName` and `readUiPrefs` on
   hostile input (65 KB file, 200 presets, nesting 1,000 deep, `__proto__` and `constructor` keys,
   wrong types, names with U+202E, NUL, `\`, 61 graphemes): limits held, nothing thrown, unknown
   fields dropped; `presetFileText` → `readPresetFile` round-trips; ids never equal a built-in id.
6. **`validateJob`**: a codec outside `FORMAT_CODECS[format]`, `prores-4444` with the policy off,
   `alpha` with H.264 or with `yuv420p`, `stems` on a GIF, `fps: 23.976` and `fps: 121` are refused;
   every job of test 3 passes unchanged.
7. **Runtime**: `t()` falls back to English for a missing key and for a stale translation; plural
   selection uses `count` and shows `n`; `#` is never needed; rich tags map to the caller's nodes;
   `<T>` renders no wrapper element; isolation adds nothing in English and FSI/PDI around `user`
   placeholders in other languages.
8. **English profile**: every `fmt` function in English equals the helper it replaces over the value
   grids of §11.2; `fmt.list(['A', 'B', 'C'])` is "A, B and C".

**English guards** (§10.6; run under xvfb by `tests/e2e/english-guard.e2e.cjs`)

9. **Text and accessible names** of the tour equal the S2 baseline exactly.
10. **Layout** of the tour equals the S2 baseline: boxes within 0.5 px, computed fonts and colours
    equal, screenshots within the stated tolerance.

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
    libaom for AV1; alpha codecs give raw `rgba` routes only.
16. Levels: `hevcLevel` (1080p60 → 123, 1080p120 → 150, 2160p60 → 153, 2160p120 → 156), `av1Level`,
    `h264Fits(3840, 2160, 120)` false and `(2560, 1440, 120)` true; the codec strings.
17. `ivfFileHeader` with `'AV01'`; the default stays byte for byte `'VP90'`.
18. `hevcConfigs`/`av1Configs` ask for `prefer-hardware` (HEVC) and give Annex B for HEVC.
19. Frame rates: `rateFps` (30 → 30, 60 → 60, 120 → 90); `blurSamplesFor` (60 → 10, 120 → 5); samples
    per frame at 48 kHz are whole for 24, 25, 30, 60, 120.
20. 4:5: `outputSize` gives 720×900, 1080×1350, 1440×1800, 2160×2700; `isTall` is true; the batch
    label is `4x5`; `exportProject` applies it to the copy only.
21. Intermediate arguments (CineForm opaque and alpha, Animation): pixel formats, BT.709 tags, PCM
    24-bit audio, `+write_colr` without `+faststart`.
22. `estimateBytes` for each codec at 1080p60 and 2160p30; the free-space check refuses below 1.2 ×
    the estimate with `disk-full`.
23. **ProRes** (policy switched on inside the test): profiles 1, 2, 3 and 4 with `-alpha_bits 16` or
    0; **no argument list ever contains `-vendor`**; with the policy off (as shipped) neither chip
    exists.
24. `probeCodec` runs once per codec per session, never at start, with each encoder's pixel format;
    `av1_amf` and the `_mf` encoders only on Windows.

**P2 · Transparency**

25. `drawFrame` with `alpha: 'background'`: no background call, the card and recording drawn; with
    `'overlays'`: no card or recording, the camera and overlays drawn; without `alpha` the call log of
    test 4.
26. A drawn transparent frame read back with the alpha `RawFrameSink` gives straight RGBA: a 50% red
    pixel reads `[255, 0, 0, 128]` within 1; the job's pixel format is `'rgba'`.
27. `seeThrough` is false for `auto` with padding 0 and true with padding 40; the hint's message key
    follows it.
28. `transparentJoins` drops crossfade, dip and slide windows; punch-in still scales the content.
29. With the Linux ffmpeg: a 1 s transparent VP9 WebM decoded with `-c:v libvpx-vp9` has alpha 0 in
    the corner and 255 in the card; a CineForm RGBA MOV keeps both.

**P3 · Stems and WAV**

30. The WAV format's soundtrack graph equals the M4A job's graph byte for byte; its output arguments
    are `-c:a pcm_s24le -ar 48000 -rf64 auto -f wav`.
31. With the Linux ffmpeg, on the audio fixtures at 1× speed: the stems' sum equals the soundtrack
    built with `gainDb` in place of `normalize`, residual below −120 dBFS.
32. `gainDb` is `20·log10(previewNormalizeGain)`, clamped to ±30; stems are 32-bit float and a peak
    at +3 dBFS is kept.
33. Every stem is exactly `stemSamples(frames, fps)` long at 24, 25, 30, 60 and 120 fps, and starts at
    sample 0.
34. Which stems: a project without separate files gives `recording`; default stem gains still give
    `voice` and `system`; silent stems are left out; Clean voice gives the cleaned file.
35. `stemPaths` adds " (2)" for taken names and never returns the video's path; cancelling removes the
    stems written so far and keeps the video.

**P4 · Timelines**

36. `recordingsTimeline` on a project with 1,000 clips at mixed speeds and 3 pause freezes: the last
    event ends on the video's last frame; no gap or overlap; holds have speed 0; crossfades become
    dissolves; source frames on each source's grid.
37. `fcpxml` equals the golden file for the export mode and the recordings mode (speed, hold,
    dissolve, chapter markers, roles, Bangla name); the golden file was checked against Apple's
    FCPXML 1.10 DTD with `xmllint --dtdvalid` when it was made.
38. `xmeml` equals its golden file (time remap, markers, `pathurl` form).
39. `edl` and `markerEdl` equal their golden files; `FCM: NON-DROP FRAME`; CRLF; 1,000 cuts →
    `edlBlocked`; a Bangla chapter becomes "Chapter 2" in the marker EDL only.
40. `fileUrl` for `C:\Users\রহিম\My Videos\a#b.mp4` and the XML escaping of `<`, `&`, `"`, `'`.
41. Export mode: V1 the video, the stems as audio tracks, chapter markers in timeline frames.
42. `copyRecordings` copies (never links), converts mic and system to WAV with ffmpeg, uses the
    cleaned voice with Clean voice on, checks free space first, and never opens a project file for
    writing.
43. Rates: an export at 120 fps gives a 60 fps timeline; 24 and 25 are exact.
44. `writeTimeline` refuses a `videoPath` this session did not export and a stem path not next to it.

**P5 · Export dialog and presets**

45. `savePreset`, `renamePreset`, `updatePreset`, `deletePreset`, `importPresets`: the 50 limit,
    `uniqueName` (" (2)"), ids, `saved`; subtitle languages never stored.
46. `batchItems` with user presets gives "{project} - {preset name}.{ext}" through `safeFileName`; a
    Bangla name stays Bangla.
47. `settingsRows`: the HEVC chip in its three probe states; MP4 disables the transparent backgrounds;
    `pickBackground` on MOV/H.264 picks CineForm and on WebM/AV1 picks VP9 in the same step; `pickCodec`
    back to a non-alpha codec resets Background; 4K at 120 fps with H.264 is disabled, and
    `pickResolution` to 4K at 120 sets 60.
48. `stemsBlocked` and `timelineBlocked` for GIF, batch, one file per chapter, a silent project.
49. `sizeLine` adds the codec only when it is not the default ("1080×1350 · 30 fps · HEVC · 2:14").
50. `instagram-feed` gives MP4, 1080, 30 fps, Studio, 4:5; `matchesPreset` and `tweakOptions` keep it
    selected and drop it on any change.

**P6 · Language runtime, settings and fonts**

51. `resolveUiLanguage`: absent and `'en'` → English; `'system'` with `['bn-IN', 'en-US']` → `bn` when
    shipped, English when not; a language without a built catalogue → English; `offer` only when
    `language` is absent and the language is not in `offered`.
52. `formatLocaleOf`: `bn` + `bn-BD` + Western → `bn-BD-u-nu-latn`; `bn` + `en-US` → `bn`; `hi` + native
    → `hi-u-nu-deva`; `Intl.DurationFormat` with the tag gives Western digits where the option alone
    does not.
53. `fmt` in `bn`, `bn-u-nu-latn`, `hi` and `es` over the grids of §11.3 (the empty cells recorded);
    `fmt.clock` in Bangla digits; units stay Latin.
54. Plurals: a message with bn one/other, es one/many/other and ar's six categories selects as
    `Intl.PluralRules` does for 0, 1, 2, 3, 11, 100 and 1,000,000.
55. The built catalogue loads; a key it lacks formats English; `setCatalogue` before the first render.
56. Main: dialog titles, filter names, notification texts and taskbar tooltips come from main's
    catalogue in `bn`, and equal today's English in `en`.
57. Language section: choosing বাংলা writes `ui.language: 'bn'` and shows the restart notice; Restart
    now calls `relaunch`; Follow Windows names the language it would give.
58. The offer: shown once when Windows lists a shipped language and `language` is absent; *Not now*
    writes `offered`; *Use* writes the language and relaunches.
59. Fonts: `loadUiFont('bn')` registers "Flown UI Bengali" from the bundled file with no new asset
    in the build output; `scripts.css` raises the tokens under `:lang(bn)` only.
60. **No network**: a Bangla session through the tour with every request logged makes no request
    outside `file:`, `studio-media:` and the dev server; no source file under `src/` imports from
    `scripts/i18n/`.

**P7 · Checks and translation tools**

61. The scanner finds JSX text, each listed attribute, each sink and a locale-less `toLocaleString` in
    fixture files; ignores allowed literals; reports the other account's files as pending.
62. The catalogue checks reject: a parse error, a missing or extra placeholder, a missing `other`, a
    category the language lacks, `#`, `'{`, a dropped do-not-translate term, a bidi control, `<script>`,
    a text over `maxLength` in graphemes, a lost blank line, Latin words in a `bn` text.
63. English checks: an unused key, a used key that does not exist, a missing meta entry.
64. `en-XA` adds 40% and brackets and keeps placeholders; `ar-XB` keeps placeholders and sets `rtl`.
65. `i18n:build` takes only `approved` strings with a current `sourceHash`; `--check` fails on a stale
    built file; `shipped.json` follows the 95% and core rules of §15.6.
66. The review sheet exports and imports without loss, rejects a row that fails the checks, and
    records who and when.
67. `ReviewOverlay` renders nothing in a packaged build or without `FLOWN_I18N_REVIEW`.
68. `predist.mjs` fails when `config.json` says `"fail"` and a string has no key.

**Extraction parts** (§21.8)

69. Every row of `scripts/i18n/log/*.json`: the English message formatted with the row's sample
    values equals the literal it replaced; for plurals, the samples 0, 1, 2 and 1000 each.
70. The command palette finds a command by its UI-language title, its English title and its English
    keywords; `COMMAND_CATEGORIES` stays the same list of ids; categories' English labels are today's.
71. `withShortcut`, `orPress`, `reviewHint`, `undoHint`, `zoomLevelKeysHint` give today's English
    for the default keymap and for an edited one; in `bn` the keycaps stay Latin.
72. **Error codes**: for every English message main can produce for an export (the `KNOWN_ERRORS`, the
    `toIpcError` and `renameError` texts, `validateJob`'s), the code-based fallback decision equals
    today's `NOT_ENCODER_RELATED` regex decision; cancel, `startsWith` and LUT-question decisions work
    with `en-XA` messages.
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

1. **F1 Old settings unchanged.** With the previous release's stored `export-settings` (MP4, 1080, 60 fps, Studio),
   export: the file's codec, size, frame count and ffprobe tags equal the previous release's export of the same
   project; localStorage values are byte for byte the same after closing the dialog.
2. **F2 HEVC chip.** On Linux (no GPU, no WebCodecs HEVC): the HEVC chip is disabled with "This PC has
   no graphics card that can encode HEVC. Use H.264, or AV1 for smaller files" shown under the row.
3. **F3 AV1.** MP4 + AV1 + Software at 720p: ffprobe shows `av1`, the hint says about 6 times as
   long; WebM + AV1 likewise.
4. **F4 Frame rates and 4:5.** 24, 25 and 120 fps exports have 240, 250 and 1,200 frames; 4:5 at 1080
   is 1080×1350; the Instagram post destination gives the same file.
5. **F5 Transparent WebM.** Background *Transparent*, WebM: decoded with libvpx, the corner pixel has
   alpha 0 and the card's centre 255; the dialog's preview canvas at 1.0 s matches the decoded frame
   within 2 percentage points per colour class.
6. **F6 Edges.** A shadow pixel's decoded alpha is within 3 levels of the alpha the dialog's preview
   canvas holds at the same place (straight alpha end to end); a red card-edge pixel keeps its hue
   within 10° (no dark fringe).
7. **F7 Overlays only, CineForm.** MOV + CineForm + *Overlays only*: the caption and camera are
   opaque, the rest transparent; ffprobe shows `cfhd` and `gbrap12le`; the crossfade project's cut is
   a hard cut and the hint says so.
8. **F8 Stems.** *Also save → Sound stems*: Voice, System sound, Music and Effects are written, each
   exactly 480,000 samples, float, 48 kHz; their sum equals a render of the same graph with the fixed
   gain within −90 dBFS; a silent project shows the blocked reason.
9. **F9 WAV format.** The WAV file's samples equal the M4A export's decoded samples within AAC's error
   (correlation ≥ 0.999) and its length is the video's.
10. **F10 Timelines, export mode.** FCPXML, Premiere XML and EDL written next to the video; each names
    the video and stems by absolute path; chapter markers at 0 and 5 s.
11. **F11 Timelines, recordings mode.** `<base> media\` holds the copies and WAVs; the FCPXML's
    2× clip has a `timeMap`; the project folder's files are unchanged (bytes and modification times).
12. **F12 Presets.** Save as preset "Client review" (MOV, CineForm, stems on), close and reopen the
    dialog: the preset is there; Save to a file, delete, Import: it comes back; a 70 KB file is refused
    with "This file has no presets Flown can read."
13. **F13 Keyboard only.** Reach Codec, Background and Frame rate with Tab, change them with arrows,
    open a preset's menu with Shift+F10 and close it with Escape: focus returns to its button.
14. **F14 Offline.** The whole file runs with network requests blocked and logged: none.

### 23.4 End to end: `tests/e2e/languages.e2e.cjs`

Run with a test catalogue built from the `en-XA` pseudo-locale plus a small Bangla fixture catalogue
(`tests/fixtures/i18n/bn.json`, approved by the fixture, not a real translation), selected with
`SSW_I18N_CATALOGUE_DIR` in an unpackaged build.

1. **L1 English by default.** No `ui` preference: `<html lang="en">`, no catalogue chunk requested.
2. **L2 Settings › Language.** Choose বাংলা: the restart notice appears (`role="status"`); Restart now
   relaunches; `<html lang="bn" dir="ltr">`; a Home string comes from the fixture catalogue.
3. **L3 Fallback.** A key the fixture lacks shows its English text.
4. **L4 Fonts.** `document.fonts.check('16px "Flown UI Bengali"')` is true; a label with ঁ and র্ has
   its ink inside its box (no clipping) at 100% and 150% zoom.
5. **L5 Digits.** A 2:05 duration shows "২:০৫"; after choosing Western digits and restarting, "2:05";
   `1080p` and `60 fps` stay Latin in both.
6. **L6 Keys.** Shortcut labels show "Ctrl + Z"; buttons with shortcuts carry `aria-keyshortcuts`.
7. **L7 Main strings.** The export save dialog's title and filter names (recorded by the test hook)
   and a finished-export notification are in Bangla.
8. **L8 Offer.** With `SSW_PREFERRED_LANGUAGES=bn-BD,en-US` and no `ui` preference, Home shows the
   offer once; *Not now* hides it for good; its second sentence has `lang="bn"`.
9. **L9 Overflow.** Under `en-XA`, no element with ellipsis in the tour overflows its box, and no plain
   ASCII text is left outside the recording panels, brand and codec names.
10. **L10 Right to left.** Under `ar-XB`: panels mirror; the timeline and preview do not; nothing
    overlaps.
11. **L11 Recording side.** In Bangla, the recording panels on Home and the recording bar are English
    with `lang="en"`, and their text equals the English baseline.
12. **L12 Exports stay English.** A batch export in Bangla writes the same file names and the same
    description sidecar as in English.

---

## 24. Later

- Arabic and Hebrew, after a right-to-left review of every screen with the `ar-XB` pass as its start.
- A "language of exported files" choice (file names, sidecars, stem and chapter names), starting from
  `outputWords.ts` (§10.3).
- Bidi isolation in the English UI, for project names in right-to-left scripts (§13.3).
- A Bangla installer through custom NSIS language files.
- HEVC through x265 or a custom `ffmpeg.exe` without it (§0 decision 1).
- ProRes, if Apple licenses it (§0 decision 2); DNxHR once its patent position is known.
- SVT-AV1 with a different `ffmpeg.exe` build.
- OpenTimelineIO files, once Premiere's import is settled.
- Merging the `merge: true` fragments into whole messages, with the owner's approval of the English
  changes it needs (§10.3 rule 8).
