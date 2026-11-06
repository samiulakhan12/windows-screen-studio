# Editing polish (wave 10): final design

Plan: `docs/PLAN.md`, wave 10 "Editing polish", five items. Roadmap items: NW-06 (smooth cuts: the
picture side, per-cut styles and *Smooth all cuts*; the 10 ms audio fades shipped in 0.7.0), LT-12
(magnifier zoom), LT-11 (animated callouts and a chapter progress bar), LT-16 (colour correction and
looks) and LT-13 (music and sound-effects library). Captions Studio item 12 (sound on pops, which
waited for LT-13) is finished here (§10.7).

Written against `rev/wave10-design` at `a988af4`: everything through wave 8 except versions, plus
Captions Studio phase A. Line numbers refer to that commit unless a branch is named.

Two branches merge before the contracts step (§17.0):

- `rev/versions` (`/home/user/wt-ver`, `546e479...a8568e9`; E-12 versions, E-07 filmstrip, E-09
  frame nudge). It appends seven commands to the end of `COMMAND_LIST` and `saveVersion` to the end of
  `DEFAULT_KEYMAP`, puts `<Filmstrip>` right before the cut blocks on the clip track
  (`Timeline.tsx`), keeps a version before Polish runs (`PolishDialog.tsx`), and lists the parts of an
  edit (`AREAS`) and the project files (`namedFiles`) in `src/shared/editor/versions.ts`. Wave 10's
  new fields and files join those lists (§4.6). Its filmstrip is a JPEG sheet ffmpeg tiles from the
  proxy (`src/main/filmstrip.ts`): it shows the recording without colour grading, and that is fine
  for a navigation strip.
- Captions Studio phase B (`/home/user/wt-csb`, `9ed0094`). It adds Review mode rows for Captions
  Studio (`src/shared/review/captionReview.ts`, six kinds in `copy.ts`), routes bleeps through the
  sound finder's gain curve (`jobSoundGains`), and edits `exporter.ts` (`soundOf`),
  `previewAudio.ts` (`spansKey`), `shortcuts.ts` (`reviewHint`), `great.ts` and `GraphicsPanel.tsx`.
  Wave 10's Review rows follow its pattern (§11).

Terms used below:

- **S**: the output frame's shorter side in px. Sizes are fractions of S, like Captions Studio's u.
- **Source time**: seconds of the recording. **Edit time**: output seconds of the clips played back
  to back (`sourceToOutput`, `src/shared/engine/timeline.ts:55`). **Video time**: edit time plus the
  pause-freeze holds (`editToVideo`, `src/shared/engine/freeze.ts:149`). The export's frame i shows
  video time i / fps.
- **Viewing time**: edit seconds measured through clip speeds (`viewAt`, Captions Studio §9.1 rule 2).
  Every animation of this wave runs in viewing time or video time, never in source time.
- **A cut**: a gap of more than 1e-6 s between neighbouring clips, the test of `editHasCuts`
  (`src/shared/render/cutFades.ts:54`). A trimmed start or end is not a cut. Touching clips with two
  speeds (a smart-speed split) are not a cut.
- **A, B**: the clip before a cut and the clip after it. **T**: the cut's video time, B's start in
  video time. A pause hold at that instant comes first (`editToVideo`'s rule), so T is then the
  hold's start.
- **A\***: A's last kept frame, as a still (§5.3).

The rules of the earlier waves hold:

- Preview and export draw the same frames and play the same sound at any fps and after any seek. One
  drawing path (`drawFrame`); every new motion is a pure function of time.
- Old projects and settings load, draw and save byte for byte as before. Every new field is
  optional, every new drawing step returns at once without its field, and an equivalence guard
  written before any part starts pins this (§19.2).
- One user action is one undo step.
- Everything works with the keyboard and a screen reader. The app UI meets WCAG AA contrast with the
  tokens of `src/renderer/src/styles.css`.
- Everything runs offline by default. Nothing downloads unless the user asks.
- Only assets whose licences allow commercial redistribution without conditions the app cannot meet:
  CC0 or public domain for music and sounds; MIT, Apache-2.0, BSD or CC0 for LUTs and code. Each file
  is pinned by SHA-256 and capped in size.
- New automatic changes are listed in Review mode with Keep and Remove.
- Bangla and other scripts work wherever text is drawn.
- Nothing on the recording side changes: `src/main/recording/*`, `src/main/recordingIpc.ts`,
  `src/main/windows.ts`, `src/shared/recording/*`, `Toolbar.*`, `src/renderer/src/recorder/*`,
  `RecordingOptions.tsx` and `appSettings.ts` belong to the other account. `src/main/security.ts`
  and the CSP do not change.

The research behind this design is kept outside the repository, in the lead's scratch folder
`w10-design/`: `code/` (per-frame benchmarks in Electron 44.9.3), `colour/` (WebGL2 accuracy and
LUT error measurements), `audio-library/` (licence evidence, loop analysis, the prepared files and
`catalogue-draft.json`) and `cuts-callouts/` (the survey of other tools).

---

## 0. Decisions for the owner

Nothing in this wave changes how an existing project looks: every new feature is off until the
user turns it on, or until Polish or Auto colour turns it on and Review mode lists it. Decision 2
changes how existing projects *sound* in one narrow case. No asset outside the allowed licences is
used, and the installer grows by 3.06 MB, under the 5 MB line.

1. **Where the 8 extra music beds download from.** Four beds ship in the installer; eight more
   (6,558,574 bytes) download on request (§10.3). The Free Music Archive serves only the original
   MP3s, not the prepared loops, and its file paths have changed over time, so it cannot be the
   pinned source. Choices:
   - (a) **A release asset on the app's own GitHub repository**
     (`samiulakhan12/windows-screen-studio`, tag `sound-library-1`, never reused). The auto-updater
     already trusts that repository. **Recommended.**
   - (b) A Qbexel repository on Hugging Face at a pinned commit (the pattern `CAPTION_MIRROR` was
     built for, `src/shared/captions/fontCatalog.ts:91`).
   - (c) No download: bundle all 12 beds. The installer then grows by about 9.6 MB, over the 5 MB
     line.

   Every file is pinned by bytes and SHA-256 either way, so the host is trusted for availability
   only. Until the source exists, the eight rows are not shown and the four bundled beds work alone.
2. **Fix the loop glitch in users' own music.** Today's export loops music with
   `-stream_loop -1` (`src/shared/render/audioPlan.ts:465`). For Opus and M4A files this puts a
   glitch at every loop point: on a 0.5-amplitude test sine the error at each seam was 0.50 to 0.89,
   against a codec floor of 0.015 (ffmpeg 7.0.2, the app's own). MP3, Vorbis, WAV and FLAC loop
   cleanly. The fix (§10.4) decodes such a file once into the project's `.cache/` and loops that.
   It changes the exported sound of existing projects only where the music loops, and only by
   removing the glitch. Project files do not change. **Recommended: fix it in this wave.**
3. **Polish gets a "Smooth cuts" step, on by default.** It sets every cut to Soft (0.15 s) when the
   video has cuts and the user has not chosen a cut style. It is listed in Review mode. Saved Polish
   options without the step read it as off, so a user's saved choice never changes silently.
   **Recommended: on by default for new Polish options.**
4. **CC0 music and Content ID.** CC0 music is sometimes claimed by third parties on video sites. The
   app shows the credit ("Music: Sweet Sun by Loyalty Freak Music (CC0)") and offers it to the
   publishing pack's description, which helps a user dispute a false claim. **Recommended: accept,
   with the credit line.**
5. **A listening pass before release.** A person listens to all 12 beds (no vocals; the loop point
   sounds clean) and the 16 effects (levels). The loop points were found by analysis and have not
   been checked by ear. **Required before release.**
6. **Measurements on the reference Windows PC** after the build: the colour shader's cost with a
   real GPU (estimated, not measured, §15), the preview with soft cuts, and the installer's size.

---

## 1. Summary

- **Smooth cuts.** Every cut can have a style: **Hard cut** (today), **Soft** (A's last frame fades
  into B over 0.15 s), **Dip to colour** (0.5 s through black, white or a brand colour), **Slide**
  (B pushes A's last frame out over 0.4 s) or **Punch-in** (B shown 1.10× larger, then the next clip
  back at 1.0×). One style for every cut, and an optional style per cut. **Smooth all cuts** sets
  every cut to Soft in one undo step. The video never changes length, and no frame from inside a cut
  is ever shown, so nothing the user cut out comes back and every caption, chapter and click keeps
  its time. The sound at cuts stays as shipped (10 ms fades).
- **Magnifier.** A round loupe (or rounded rectangle) that shows a detail 1.5–4× larger (2.5× by
  default) while the rest of the screen stays visible. It sits on its content like a spotlight, or
  follows the cursor. It grows in over 0.30 s and shrinks away over 0.22 s. Text inside it stays
  sharp, and blurred or pixelated areas stay hidden inside it.
- **Animated callouts.** Texts, shapes and title cards can appear and disappear with the motions
  Captions Studio's graphics use (fade, pop, rise, drop, slide, grow, typewriter), plus **Draw** for
  arrows, lines, boxes and ellipses and **Wipe** for highlights and text. Two new text styles:
  **Step badge** (a numbered circle: 1 2 3, A B C or Bangla ১ ২ ৩, numbered automatically in time
  order) and **Speech bubble** (a rounded box with a tail that points at something). Items without
  a chosen motion keep today's fades exactly.
- **Chapter progress bar.** A thin bar, split at the chapters, that fills as the video plays, with
  the current chapter's name (or all of them, or none). At the bottom of wide videos and at the top
  of tall ones, inside the safe zones. Captions, key presses and lower thirds keep clear of it.
- **Colour.** Temperature, tint, brightness, contrast and saturation (plus highlights, shadows,
  vibrance, and exposure for the camera), eight looks (Natural, Warm, Cool, Vivid, Soft, Cinematic,
  Mono, Vintage) and the user's own `.cube` LUTs, for the screen and the camera separately.
  **Auto colour** balances the camera from a few frames, offline. One WebGL2 shader grades each
  picture before it is drawn; PCs without WebGL2 use the same maths on the CPU. Captions, the
  background and overlays are never graded.
- **Music and sound effects.** Twelve CC0 music beds in five moods (four in the installer, eight on
  request), each prepared to loop seamlessly and mastered to −16 LUFS, and sixteen CC0 sound effects
  (whooshes, pops, clicks, chimes) in the installer. Effects can sound on zooms, title cards, texts
  and shapes as they appear, and on Captions Studio's pop-ups. The installer grows by 3.06 MB.
- **Automatic changes.** Polish's new Smooth cuts step and Auto colour each make one Review mode row
  with Keep and Remove.
- **No new Inspector tab.** The rail holds 13 tabs at the minimum window size (`954036a`). Each
  feature adds a section to an existing tab.

---

## 2. What the user sees

### 2.1 Smooth cuts

**On the timeline.** Each cut block (`GapBlock`, `Timeline.tsx:869`) shows a 10 px mark for its
style in its top-left corner when it is wide enough (at least 22 px, as the Restore button): none for
a hard cut; a two-tone square for Soft; a filled dot for Dip; an arrow for Slide; a small "+" square
for Punch-in. Its tooltip and accessible name say the style: "Cut: 1:23.4 – 1:25.0 (1.6 s not in the
video). Soft, 0.15 s."

**Clip tab, with no cut selected.** A section **Cuts**, shown when the video has at least one cut:

- "37 cuts. A cut jumps from one moment of the recording to the next."
- **Every cut**: a select with *Hard cut* (default), *Soft*, *Dip to colour*, *Slide*, *Punch-in*.
- The style's options below it (see the table).
- **Smooth all cuts** (button): sets Every cut to Soft, 0.15 s. Notice: "Soft cuts at 37 cuts ·
  Ctrl + Z to undo". The button is disabled, with the hint "Every cut is already soft", when it
  would change nothing.
- When some cuts have their own style: "3 cuts have their own style." and a button **Use for all
  cuts** that clears them (one undo step).

**Clip tab, with a cut selected** (`selection.kind === 'gap'`, `ClipPanel.tsx:86`). Under Restore, a
section **Cut style**: a radio group *Same as every cut (Soft)*, *Hard cut*, *Soft*, *Dip to colour*,
*Slide*, *Punch-in*, then the chosen style's options. Trimmed starts and ends have no Cut style
section.

| Style | Options (defaults) | Hint (exact copy) |
|---|---|---|
| Hard cut | none | "Jumps straight to the next clip." |
| Soft | Length 0.05–0.5 s (0.15) | "The last frame before the cut fades into the next clip. Hides small jumps. The video keeps its length." |
| Dip to colour | Length 0.2–1.2 s (0.5); Colour: Black, White, the brand colours, Other… | "Fades to a colour and back. For the start of a new part." |
| Slide | Length 0.25–0.7 s (0.4); From: Right, Left, Top, Bottom (Right) | "The next clip pushes the last frame out of the picture." |
| Punch-in | Size 105–120 % (110) | "The next clip is shown a little larger, the one after it at normal size again. For talking-head cuts." |

With **Calm motion** on (§7.5), Slide draws as Soft and its row says "(Soft while Calm motion is on)".

A Dip whose middle is less than 1 s after another Dip's draws as Soft (§5.2, the flash rule). The
panel then says: "Drawn as Soft: it is less than a second after another dip."

**Command palette**: *Smooth all cuts*, *Use hard cuts everywhere*, *Go to next cut* (moves the
playhead to the next cut and selects it, which opens Cut style).

**Sound.** Unchanged: every cut keeps its 10 ms fade out and in (`CUT_FADE`).

### 2.2 Magnifier

**Shapes tab**: two buttons next to *Add spotlight*: **Add magnifier** and **Add magnifier on the
cursor**. A magnifier starts at the playhead and lasts 3 s (`DEFAULT_SHAPE_LENGTH`). It is round,
0.30 S across (324 px at 1080p), centred on what the preview shows (or on the cursor), at 2.5×.

It is a kind of spotlight, so it sits on the spotlight row of the timeline, is selected, moved,
resized, copied, nudged, snapped and multi-selected exactly as spotlights are, and stays on its
content while the camera zooms.

**Panel of a selected magnifier** (Shapes tab):

- **Zoom**: slider 1.5×–4× in steps of 0.25 (2.5×). Value text "2.5 times".
- **Shape**: *Round* (default), *Rounded rectangle*.
- **Follows**: *A place on the screen* (default), *The cursor*.
- **Dim the rest**: 0–40 % (0).
- Hint: "Shows a detail larger while the rest of the screen stays in view. Blurred and pixelated
  areas stay hidden inside it."

### 2.3 Animated callouts

**Text tab, a text selected.** **Style** gains two choices: *Pill*, *Title*, **Step badge**,
**Speech bubble**. A section **Animation**:

- **Appear**: *Default* (today's short fade), *Fade*, *Pop*, *Rise*, *Drop*, *Slide from left*,
  *Slide from right*, *Grow*, *Typewriter*, *Wipe*.
- **Disappear**: *Default*, *Fade*, *Pop*, *Rise*, *Slide left*, *Slide right*, *Grow*.
- **Speed**: "Appears in 0.25 s", a slider 0.1–1.5 s (shown when Appear is not Default).
- **Sound**: *Same as the project* (§2.6), *None*, then the effects of the library with a Play
  button.

**Shapes tab, a shape selected.** The same section. Appear offers what fits the shape:

| Shape | Appear choices (default motion when picked) | Disappear |
|---|---|---|
| Arrow, line | Default, **Draw** (0.35 s), Fade, Pop, Grow | Default, Fade, Pop, Grow |
| Rectangle, ellipse | Default, **Draw** (0.45 s), Fade, Pop, Grow | Default, Fade, Pop, Grow |
| Highlight | Default, **Wipe** (0.28 s), Fade | Default, Fade |
| Blur, pixelate | none | none |

For blur and pixelate the section says: "Blur and pixelate are fully on for their whole time, so
nothing they hide shows."

**Title cards** (Text tab, a title selected): Appear *Default* (today's fade and rise), *Pop*,
*Rise*, *Slide from left*, *Slide from right*, *Grow*, *Typewriter*, *Wipe*; Disappear *Default*,
*Fade*, *Pop*, *Rise*, *Grow*; Sound.

**Step badge.** Added from the Text tab (**Add step badge**) or the palette. Options:

- **Number**: *Automatic* (default; shows the number it gets, "3") or *Your own text* (a short field,
  at most 3 characters).
- **Count with**: *1 2 3* (default), *A B C*, and the native digits of the caption language when it
  has its own (for Bangla: *১ ২ ৩*; the choice is labelled with the language: "১ ২ ৩ (Bangla
  digits)").
- **Colour**: the brand colours first, then the shape palette; default #0060df.
- Automatic badges are numbered in start-time order. Moving one past another renumbers both.

**Speech bubble.** Added from the Text tab (**Add speech bubble**) or the palette. Its text is edited
like any text. In the preview a round handle at the tail's tip is dragged to point at something
(arrow keys move it 1 % of the frame, Shift 10 %). **Colour**: *White* (default, dark text), *Dark*
(#1d1d24, white text), the brand colours. **Tail**: *Pointing* (default) or *None*.

### 2.4 Chapter progress bar

**Text tab**, in the Chapters section: **Chapter bar on the video** (switch, off). When on:

- **Place**: *Auto* (default: bottom in wide and square videos, top in tall ones), *Top*, *Bottom*.
- **Look**: *Floating* (default; rounded, inset from the edges), *Edge* (full width, flush).
- **Names**: *Current chapter* (default), *All chapters*, *None*.
- **Colour**: the brand colours first, then white (default without a brand).
- **Hide between chapters**: switch (off). On: the bar shows for 3 s after each chapter starts.
- With fewer than two chapters: "Add chapters to split the bar. With one or none it is a plain
  progress bar."

### 2.5 Colour

**Effects tab**: section **Screen colour**. **Camera tab**: section **Colour** (shown with a camera).
Both have:

- **Look**: chips with a thumbnail and a text label: *None* (default), *Natural*, *Warm*, *Cool*,
  *Vivid*, *Soft*, *Cinematic*, *Mono*, *Vintage*. **Strength** 0–100 % (100) when a look is picked.
  In Screen colour, Mono and Soft carry the hint "Lowers the contrast of text on screen."
- Sliders, each −100 to +100 with a centre detent and a value text: **Temperature** ("Cooler" /
  "Warmer"), **Tint** ("Greener" / "More magenta"), **Brightness**, **Contrast**, **Saturation**.
  **More** (a disclosure): **Highlights**, **Shadows**, **Vibrance**, and for the camera **Exposure**
  (−2 to +2 stops).
- **LUT**: **Import a LUT (.cube)…**. Once imported: its title, its size ("33 × 33 × 33"),
  **Strength** 0–100 % (100) and **Remove**.
- **Compare** (a toggle button): the preview shows the picture without colour while it is pressed.
  It is never saved and never exported.
- **Reset colour**.
- Camera only: **Auto colour** (button). Hint: "Balances the camera's colour and brightness from a
  few frames, on this PC. Review mode lists it." Notice after: "Camera colour balanced · Ctrl + Z
  to undo".
- On a PC without WebGL2: "This PC grades colour without graphics acceleration, so the preview may
  play less smoothly. The export looks the same."

### 2.6 Music and sound effects

**Audio tab, Music section.** Above today's *Choose music…* (renamed **Your own file…**), a
**Library** list:

- Mood filter chips (text, not colour): *All*, *Calm*, *Upbeat*, *Corporate*, *Lo-fi*, *Cinematic*.
- One row per bed: title, artist, mood, length ("1:43"), a **Play** toggle (plays a preview from the
  library, outside the project) and **Use**. A bed not downloaded yet shows **Download (1.0 MB)**
  instead of Use, and a progress bar while it downloads.
- After Use: "Music: Sweet Sun by Loyalty Freak Music (CC0)" under the music row. Volume, ducking,
  loop and fades are today's controls and keep their values when one bed replaces another.

**Audio tab, Sound effects section.**

- **Volume**: 0–100 % (35 %).
- **Zooming in**, **Zooming out**, **Title cards appear**, **Texts and shapes appear**: each a
  select (*None* by default, then the effects that fit it first) with a **Play** button.
- A link **Whoosh on zooms** sets Zooming in to *Whoosh* and Zooming out to *Whoosh out* in one
  step.

**Captions Studio graphics** (Graphics tab): the Sound select keeps *None*, *Pop* and *Ding* (now
labelled *Classic pop* and *Classic ding*; they sound exactly as before) and adds the library
effects. *Make my captions great*'s sound option gets the same list.

**Settings › Downloads**: a group **More music** with "8 tracks, 6.6 MB", **Download all** and
**Remove**, beside the caption fonts.

### 2.7 Polish and Review mode

- **Polish dialog**: a row **Smooth cuts** after *Remove silences*: "Soft cuts at every cut". It
  skips with "No cuts to smooth" or "Your cut style is kept" (when Every cut is already set).
- **Review mode** rows:
  - *Cuts* chip: "Soft cuts at every cut (37)", detail "Polish". Keep makes it the user's; Remove
    puts back the cut style there was before (a hard cut, usually).
  - *Colour* chip: "Camera colour balanced", detail "Auto colour". Remove puts back the camera's
    colour as it was.
  - Captions Studio's pop-up rows name a library sound: "Pop-up: Save (with Soft pop)".

### 2.8 Command palette

New commands, appended after the versions branch's, with no default keys (so no key changes for
anyone): *Smooth all cuts*, *Use hard cuts everywhere*, *Go to next cut* (Playback), *Add magnifier*,
*Add magnifier on the cursor*, *Add step badge*, *Add speech bubble* (Add), *Chapter bar on the
video* (toggle, Effects), *Compare with original colour* (toggle, Effects), *Auto colour for the
camera* (Camera), *Music library…* (Panels: opens the Audio tab at the Library). Users can give them
keys in the shortcuts editor.

### 2.9 Keyboard and screen readers

§12 lists every control's role, name and keys.

---

## 3. Decisions

### 3.1 How this design was chosen

Four researchers mapped the code, measured per-frame costs in Electron 44.9.3 on the reference rig
Captions Studio used (CPU raster, 4-core Xeon, no GPU), surveyed other tools (Screen Studio, Tella,
Descript, Camtasia, ScreenFlow, Loom, CapCut, Premiere, DaVinci Resolve, Final Cut Pro, PixPin,
Snagit, Windows Magnifier), checked the licence of every music and sound source on its own page,
prepared and measured every file, and measured WebGL2 accuracy and LUT errors. The choices below
follow from those measurements.

### 3.2 Decision table

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| 1 | The second picture at a cut | **A\***, A's last kept frame, held under a transition that starts at the cut | *Frames from inside the cut* (Camtasia's "Use trimmed content", Descript's handles): would show what the user removed on purpose, often to hide it, with no privacy box over it; needs a second decoder in the export and a second playing `<video>` in the preview. *Overlapping the clips* (Final Cut's "Lose time"): shortens the video and moves every caption, chapter, click and pop; `edit-by-text.md` §12 rejected it for the same reason. *Centred dissolves*: show a frozen B face while A's words still play. |
| 2 | Where cut styles are stored | `Project.joins`: a default for every cut plus overrides keyed by B's clip id | *On `Clip`*: `splitAt` and `cutRange` copy clip fields onto new pieces (`timeline.ts:115`, `:135`), so a new cut inside B would inherit B's style; `restoreRange` drops the right clip's fields (`clips.ts:69-72`). |
| 3 | Styles offered | Soft, Dip to colour, Slide, Punch-in | *Glide* (Tella's camera glide): needs `frameCamera` to change (frozen, `frameView.ts:8`) and looks like a hard cut when both sides are framed alike; Later. *Cross-zoom*: energetic, not tutorial-like; Later. *Morph Cut / Smooth Cut / generated bridges*: optical flow or a model, and they fail on moving backgrounds. |
| 4 | Sound at cuts | Unchanged: 10 ms linear fades | *Crossfades, J and L cuts*: would play removed words and need two sound pieces at once in the preview (`edit-by-text.md` §4.9). *A dip that fades the sound*: needs per-cut fade lengths in the job and in main's checks; Later. NLE video transitions leave the sound alone too. |
| 5 | Soft's length | 0.15 s (4.5 frames at 30 fps) | *1 s* (Premiere's and Resolve's default): for scene changes; on a jump cut it reads as a double exposure. Resolve's manual: "2- to 6-frame Smooth Cut transitions often work best to disguise jump cuts". |
| 6 | Dips and flashing | A dip less than 1.0 s after the previous dip draws as Soft | WCAG 2.3.1 allows three flashes a second; edit-by-text can put cuts 0.2 s apart. One a second is stricter and still allows a dip per section. |
| 7 | Magnifier data | A `Spotlight` with `magnify` | *A new item list*: about 27 files mention `spotlights` (selection, multi-select, clipboard, group moves, snapping, crop, reframe, director corners, panels); a variant gets all of it. *A zoom kind*: 99 uses of `.zooms` in 31 files would each have to skip it, and auto zoom regenerates zooms wholesale. |
| 8 | What the loupe shows | The scene drawn again through a lens camera from the full-resolution frame, with privacy shapes and the cursor drawn again inside | *Sampling the output canvas*: blurry (2.5× of output pixels). *Sampling `fc.screen` alone*: would show what a blur or pixelate box hides. |
| 9 | Callout motion | Captions Studio's `itemPose` (`motion.ts:841`) and `ItemMotion`, plus `draw` and `wipe` | *A new engine*: a second set of easings and calm rules to keep in step. |
| 10 | Old items | No motion field = today's fade, drawn by today's code | *Migrating old items to a motion*: would change how they look. |
| 11 | Chapter bar | Burned into the frame, on video time, inside the text area | *Metadata only*: that is what the export's chapters already do (`outputChapters`); the bar is for videos watched where chapters are not shown. |
| 12 | Colour engine | One WebGL2 shader (exact 1D curve + linear-light saturation + tetrahedral 3D LUT), the same maths on the CPU when WebGL2 is missing | *`ctx.filter` CSS functions*: +22 ms at 1080p on the CPU, banned on the frame canvas by Captions Studio, and their maths has no CPU twin. *SVG `feColorMatrix`*: +9.3 ms on the CPU, but no 3D LUT and Skia's GPU and CPU filters may differ. *Everything baked into one 33³ LUT*: up to 14 of 256 levels wrong on saturated colours (measured). *Hardware trilinear filtering*: about 1 % of values one level off any CPU reference (measured). |
| 13 | Where the grade runs | On each source picture before it is drawn (screen after the crop copy, camera after its mask lookup) | *On the finished frame*: would grade captions, the background, logos and text, and privacy blur would sample ungraded pixels. |
| 14 | Looks | Eight parameter sets in code (0 bytes) and the user's own `.cube` files | *A bundled LUT pack*: none found with a clean licence and origin. three.js's LUTs say "Copyright (C) 2017 RocketStock"; OBS's are GPL-2.0; RawTherapee's, spektrafilm's and cyangraphics' are CC BY-SA 4.0; GPUImage's come from DeviantArt Photoshop actions; Q-DDL's are CC BY 4.0. |
| 15 | Auto colour | Shades-of-Gray (p = 6) on the background pixels, gentle levels, offline, stored as ordinary values | *A skin-tone target*: lightens darker skin. *Live auto white balance*: would differ with seek order and fps. |
| 16 | Music source | CC0 tracks from the Free Music Archive | *Pixabay*: its terms forbid standalone redistribution and compiling content into a competing service. *Mixkit*: its own licence. *CC BY*: the credit must travel with every video, which the app cannot guarantee. *CC BY-NC / ND*: not commercial. *BigSoundBank*: "CC0-like" without saying which licence applies. *John Bartmann's "Album One"*: the page says CC0, the files' tags say BY-NC-ND. |
| 17 | What ships | 4 beds and 16 effects in the installer (3.06 MB); 8 beds on request (6.56 MB) | *All 12 bundled*: +9.6 MB. *None bundled*: no music offline. |
| 18 | Bed format | Ogg Opus 64 kb/s stereo, cut at an analysed loop point with a 1 s equal-power crossfade baked in and a 0.25 s pad | *MP3 / AAC*: larger, and AAC loops badly through ffmpeg (row 19). |
| 19 | Looping in the export | `atrim` + `aloop` in the filter graph, sample-exact (a 300 s render matched the decoded file with a maximum difference of 0.0) | *`-stream_loop -1`*: glitches at every seam for Opus and M4A (§0 decision 2). |
| 20 | Looping in the preview | `AudioBufferSourceNode` with `loopStart` and `loopEnd` | *`<audio loop>`*: loops the whole file, not from the loop point, and not sample-accurately. |
| 21 | Preview `AudioContext` rate | Unchanged (the device's) | *Forcing 48 kHz*: would change the preview of every old project; loop points in seconds work at any rate, and the baked crossfade hides a sub-sample seam. |
| 22 | Effect files | Ogg Opus, mono, shipped through `extraResources` | *Inside `app.asar`*: ffmpeg, a separate process, cannot read files there (`asarUnpack` covers only ffmpeg and uiohook, `electron-builder.config.cjs:45`). *Synthesised*: whooshes and real pops cannot be. |
| 23 | Effects' level | One volume, 0.35 by default, the synthesised pop's `POP_VOLUME` (`popSound.ts:37`) | *0.5*: 3 dB louder than today's pops. |
| 24 | Inspector | No new tab | *A 14th tab*: the rail is at its width limit (`954036a`, `tests/inspectorRailCss.test.ts`). |

---

## 4. Data model and migration

### 4.1 `src/shared/types.ts` (additive)

Every new field is optional. Nothing existing changes type except two widened unions
(`AnnotationStyle`, `GraphicBase.sound`), whose old values keep their meaning.

```ts
/* ---------- Smooth cuts (NW-06, §5) ---------- */

/** 'cut' is a hard cut (used to give one cut no style while every other cut has one). */
export type JoinKind = 'cut' | 'soft' | 'dip' | 'slide' | 'punch'
export type SlideFrom = 'left' | 'right' | 'top' | 'bottom'

/** How the picture goes from one clip to the next at a cut. */
export interface CutJoin {
  kind: JoinKind
  /** Output seconds. soft 0.05..0.5 (0.15); dip 0.2..1.2 (0.5, both halves); slide 0.25..0.7 (0.4). Absent: the kind's default. */
  duration?: number
  /** dip: #rrggbb; absent: #000000. */
  color?: string
  /** slide: the side the next clip comes in from; absent: 'right'. */
  from?: SlideFrom
  /** punch: 1.05..1.2; absent: 1.1. */
  scale?: number
}

/** A cut's own style: the cut just before clip `clip`. */
export interface CutStyle extends CutJoin {
  /** Clip.id of the clip after the cut (B). */
  clip: string
}

export interface ProjectJoins {
  /** What every cut without its own style gets; absent: a hard cut. */
  all?: CutJoin
  /** Cuts with their own style: at most one per clip id. */
  cuts?: CutStyle[]
  /** Polish set `all` and Review has not kept or removed it: what `all` was before (null: absent). */
  auto?: { by: 'polish'; was: CutJoin | null }
}

/* ---------- Magnifier (LT-12, §6) ---------- */

export interface Spotlight {
  // ...today's fields, unchanged...
  /**
   * A magnifier: the lit area (x, y, w, h, or the area around the cursor) shows what is under its
   * centre this many times larger, 1.5..4. Absent: a plain spotlight.
   */
  magnify?: number
}

/* ---------- Animated callouts (LT-11, §7) ---------- */

export type CalloutMotionKind = ItemMotionKind | 'draw' | 'wipe'
export interface CalloutMotion {
  kind: CalloutMotionKind
  /** Viewing seconds, 0.1..1.5. */
  duration: number
  /** 0..1. */
  strength: number
}

/** A sound effect of the library (src/shared/audio/soundLibrary.ts): 'sfx:' + its id. */
export type SfxRef = `sfx:${string}`

export type AnnotationStyle = 'pill' | 'title' | 'badge' | 'bubble'

export interface Annotation {
  // ...today's fields, unchanged...
  /** Absent: today's fade (ANNOTATION_FADE) and grow, drawn by today's code. */
  enter?: CalloutMotion
  exit?: CalloutMotion
  /** 'badge' and 'bubble': the fill, #rrggbb; absent: badge #0060df, bubble #ffffff. */
  color?: string
  /** 'badge': 'auto' numbers it in start order; absent: `text` is drawn. */
  number?: 'auto'
  /** 'badge' numbering; absent: '1'. */
  numbering?: '1' | 'A' | 'native'
  /** 'bubble': where the tail points, normalised to the output frame like x and y; absent: no tail. */
  tail?: { x: number; y: number }
  /** Sound as it appears: 'none', or an effect; absent: the project's rule (SoundFx.callouts). */
  sound?: 'none' | SfxRef
}

export interface Shape {
  // ...today's fields, unchanged...
  /** Never on 'blur' or 'pixelate' (the reader drops them). Absent: today's fade (SHAPE_FADE). */
  enter?: CalloutMotion
  exit?: CalloutMotion
  sound?: 'none' | SfxRef
}

export interface TitleCard {
  // ...today's fields, unchanged...
  /** Absent: today's fade and rise (titlePhase). */
  enter?: CalloutMotion
  exit?: CalloutMotion
  sound?: 'none' | SfxRef
}

interface GraphicBase {
  // ...
  /** 'pop' and 'ding': today's synthesised sounds, unchanged. */
  sound?: 'pop' | 'ding' | SfxRef
}

export interface ChapterBar {
  show: boolean
  place: 'auto' | 'top' | 'bottom'
  style: 'float' | 'edge'
  labels: 'none' | 'current' | 'all'
  /** The played part, #rrggbb; absent: the brand's first colour, else #ffffff. */
  color?: string
  /** Shown for 3 s after each chapter starts, then hidden. */
  autoHide?: boolean
}

export interface EffectSettings {
  // ...today's fields, unchanged...
  /** Calm motion for callouts, the magnifier and slides (§7.5); absent: off. Captions keep their own. */
  calm?: boolean
}

/* ---------- Colour (LT-16, §9) ---------- */

export type LookId = 'natural' | 'warm' | 'cool' | 'vivid' | 'soft' | 'cinematic' | 'mono' | 'vintage'

export interface ColorGrade {
  /** Each −1..1; absent: 0. */
  temperature?: number
  tint?: number
  brightness?: number
  contrast?: number
  saturation?: number
  highlights?: number
  shadows?: number
  vibrance?: number
  /** Camera only: −2..2 stops. */
  exposure?: number
  look?: LookId
  /** 0..1; absent: 1. */
  lookStrength?: number
  lut?: ColorLut
}

export interface ColorLut {
  /** Project file lut-<n>.cube. */
  file: string
  /** Lower-case hex SHA-256 of the file as imported. */
  sha256: string
  /** The file's TITLE, else its name: plain text, at most 80 characters. */
  title: string
  /** LUT_3D_SIZE, 2..65. */
  size: number
  /** 0..1; absent: 1. */
  strength?: number
}

export interface ProjectGrade {
  screen?: ColorGrade
  camera?: ColorGrade
  /** Auto colour set the camera grade and Review has not kept or removed it: the grade before (null: none). */
  auto?: { camera: ColorGrade | null }
}

/* ---------- Music and sound effects (LT-13, §10) ---------- */

export interface MusicSettings {
  // ...today's fields, unchanged...
  /** A library bed: its catalogue id. `path` is its copy in the project (music-<n>.ogg). Absent: the user's own file. */
  library?: { id: string }
}

export interface SoundFx {
  zoomIn?: SfxRef
  zoomOut?: SfxRef
  titles?: SfxRef
  callouts?: SfxRef
  /** 0..1; absent: 0.35. */
  volume?: number
}

export interface Project {
  // ...today's fields, unchanged...
  /** Cut styles (NW-06). Absent: every cut is a hard cut (every project from before). */
  joins?: ProjectJoins
  /** Colour of the screen and the camera (LT-16). Absent: none. */
  grade?: ProjectGrade
  /** The chapter progress bar (LT-11). Absent: none. */
  chapterBar?: ChapterBar
  /** Sound effects on zooms, titles and callouts (LT-13). Absent: none. */
  soundFx?: SoundFx
}
```

`src/shared/api/export.ts` (additive):

```ts
export interface ExportJob {
  // ...
  /** Library sound effects: each effect once, output seconds, its gain. Main maps ids to files. */
  effects?: { id: string; times: number[]; gain: number }[]
}
export interface MusicSound {
  // ...
  /** The library bed this file is (main reads its loop from the catalogue and checks the file's hash). */
  bed?: string
}
```

### 4.2 Readers

All in `src/shared`, pure, idempotent, and each returns `undefined` for absent input so
`optional()` adds no key.

- **`readJoins`** (`src/shared/engine/joinData.ts`, new). Not an object: undefined. `all` through
  `readCutJoin`. `cuts`: an array of at most `MAX_CUT_STYLES` (20,000) entries; each needs a string
  `clip` of 1–64 characters and a readable join; a repeated `clip` keeps the first. `auto` needs
  `by: 'polish'` and `was` a readable join or null. **`readCutJoin`**: `kind` in the set, else null;
  `duration` clamped to the kind's range (§5.2), non-finite dropped; `color` must match
  `/^#[0-9a-f]{6}$/i` and is lower-cased; `from` in the set; `scale` clamped to 1.05..1.2; fields
  that do not belong to the kind are dropped. An object with nothing readable left: undefined.
- **`readProjectGrade`**, **`readColorGrade`** (`src/shared/render/gradeData.ts`, new). Each number
  must be finite, then is clamped to its range; a value of 0 is kept as written (the reader never
  adds or drops a key of a valid grade, so a load and a save give the same bytes). `look` not in
  `LOOK_IDS`: dropped. `lut`: `file` must match `LUT_FILE_RE` (`/^lut-[1-9][0-9]{0,8}\.cube$/`),
  `sha256` `/^[0-9a-f]{64}$/`, `size` an integer 2..65, `title` a string, cut to 80 characters with
  C0, C1 and bidi controls (U+202A–202E, U+2066–2069) removed; otherwise `lut` is dropped.
  `exposure` on a screen grade is dropped. A grade with no keys: undefined.
- **`readChapterBar`** (`src/shared/render/chapterBarData.ts`, new). `show` must be a boolean, else
  undefined. Other fields: unknown values read as the defaults (`'auto'`, `'float'`, `'current'`).
- **`readSoundFx`**, **`readSfxRef`** (`src/shared/audio/soundFxData.ts`, new). A reference must be
  `'sfx:'` plus an id of `SOUND_EFFECTS`, else it is dropped; `volume` clamped to 0..1.
- **`readCalloutMotion(raw, allowed)`** (`src/shared/render/calloutData.ts`, new). `kind` must be in
  `allowed` (§7.1 lists what each item allows; `'blur'` is never allowed, because blur on the frame
  canvas is banned for cost, Captions Studio §9.7), `duration` clamped to 0.1..1.5, `strength` to
  0..1.
- **`readShape`** (`src/shared/engine/shapeData.ts:15`) keeps `enter`, `exit` and `sound` for the
  non-privacy kinds and drops them for blur and pixelate. **`readSpotlight`** (`:37`) keeps
  `magnify`, clamped to 1.5..4, non-finite dropped. **`readTitleCard`**
  (`src/shared/engine/titleData.ts:33`) keeps `enter`, `exit` and `sound`.
- **Annotations** are loaded as raw objects today (no reader). That stays: the drawing code reads the
  new fields through `calloutOf(a)` (`calloutData.ts`), memoised per object in a `WeakMap`, so a
  damaged value draws as if absent and the file is left as it was.
- **`Graphic.sound`** (`src/shared/captions/studioData.ts:617`): `'pop'`, `'ding'`, or an `SfxRef`
  of the catalogue; anything else is dropped.
- **`MusicSettings.library`**: read where music is read (`audioLook`, `src/shared/audio/settings.ts`);
  an id not in `MUSIC_BEDS` is ignored there (the file plays as a user's own file).

### 4.3 Migration (`src/shared/engine/project.ts`)

`migrateProject` (`:133`) takes the four new keys out of `rest` and adds them back through the
readers:

```ts
...optional('joins', readJoins(joins)),
...optional('grade', readProjectGrade(grade)),
...optional('chapterBar', readChapterBar(chapterBar)),
...optional('soundFx', readSoundFx(soundFx)),
```

`effects` is spread (`:193`), so `effects.calm` passes through; `audio` is spread
(`migrateAudio`, `:49`), so `music.library` passes through. Shapes, spotlights and title cards go
through their readers as today.

### 4.4 Old projects and settings load, draw, sound and save unchanged

- No reader adds a key: each returns undefined for absent input (§19.1 test 1).
- Each drawing step of this wave is reached through a guard that returns at once without its field:
  `joinAt` returns null without `joins`; `punchAt` returns 1; `drawMagnifierLayer` returns when no
  spotlight has `magnify`; the callout code is reached only when `enter` or `exit` is set or the
  style is `badge` or `bubble`; `drawChapterBar` returns without `chapterBar.show`; `gradeScreen`
  and `gradeCamera` return their input without a grade, and no WebGL context is made. The frame's
  call log for every fixture of `tests/fixtures/vertical-old-projects.json` and
  `tests/fixtures/wave8-old-projects.json` (phase B) equals the log taken before the contracts step
  (§19.2).
- `textArea` (`src/shared/render/safeZones.ts:95`) changes only with `chapterBar.show`.
- The audio graph strings of a job without `effects`, `bed` or a looped Opus or M4A file are
  unchanged character for character (`audioPlan` tests). With §0 decision 2, a job that loops an
  Opus or M4A file reads its decoded copy instead (§10.4); the graph around it is unchanged.
- Prefs: no new pref keys. Settings › Downloads stores what is downloaded in a new file
  (`userData/sound-library/library.json`); an app without it shows nothing downloaded.

### 4.5 An older Flown opening a newer project

Older readers rebuild shapes, spotlights and title cards from known fields, so they drop motions,
sounds and `magnify` on save: a magnifier becomes a plain spotlight with no dimming (invisible).
Annotations keep their raw fields; an older Flown draws a badge or bubble's text as a *Title*.
`joins`, `grade`, `chapterBar` and `soundFx` pass through `...rest` untouched and are ignored.
`Graphic.sound = 'sfx:…'` is dropped by the older reader. This is the same degradation earlier
waves accepted.

### 4.6 Versions, Duplicate and project files

- **Versions** (`src/shared/editor/versions.ts` on `rev/versions`): `AREAS` gains `{ name: 'smooth
  cuts', keys: ['joins'] }`, `{ name: 'colour', keys: ['grade'] }`, `{ name: 'chapter bar', keys:
  ['chapterBar'] }`, and the `sound` area's keys become `['audio', 'soundFx']`. Magnifiers are
  spotlights, counted and compared under "shapes and spotlights". `namedFiles` adds each grade's
  `lut.file` as `'colour LUT'`. A restored version whose LUT or music file was pruned shows the
  versions branch's "is no longer in the project folder" line; a library bed is copied again from
  the catalogue when it is missing (§10.3).
- **Duplicate and Make a vertical version** (`src/shared/editor/duplicate.ts`,
  `src/main/projectCopy.ts`): the new fields copy as they are; clip ids are kept, so `joins.cuts`
  still points at the right clips. `refitItems` moves a bubble's `tail` with its text, as it moves
  `x` and `y`. A chapter bar on *Auto* moves to the top in the tall copy by itself.
- **Project files**: `lut-<n>.cube` joins `MEDIA_FILE_RE` (`src/main/mediaProtocol.ts:12`), so
  `copiedFile` copies it (`projectCopy.ts:52`), and `isAssetFile` (`src/main/assetIpc.ts:124`).
  `ASSET_SPECS.lut` (16 MiB, `checkCube`) uses `store()` (`:227`), which copies to a temporary name
  and renames, and prunes like music: the three newest picks plus every LUT the saved project names.
  A library bed is stored by the same `store()` as `music-<n>.ogg`, so everything downstream of a
  music pick works unchanged.

---

## 5. Smooth cuts: timing, drawing and sound

### 5.1 The cuts

`cutsOf(clips, plan)` (`src/shared/render/joins.ts`) lists each cut once, in order: for every
`i ≥ 1` with `clips[i].start − clips[i − 1].end > 1e-6`, the index `i`, B's id `clips[i].id`, the
edit time of B's start (the summed lengths of the clips before it) and T = `editToVideo(plan, edit)`.
It is O(clips) and memoised on the identity of `clips` and the freeze plan. Edit-by-text can make
thousands of clips; nothing per frame scans them (§5.4).

### 5.2 The join of a cut

`resolvedJoin(project, i)`:

1. The entry of `joins.cuts` whose `clip` is `clips[i].id`; else `joins.all`; else none. Kind
   `'cut'` is none.
2. Lengths, with `len(X) = (X.end − X.start) / X.speed` (edit seconds):
   - Soft and Slide: `d = min(duration ?? default, len(B) / 2)`.
   - Dip: half-length `h = min((duration ?? 0.5) / 2, len(A) / 2, len(B) / 2)`.
   - A Soft or Slide with `d < 2/30` s, or a Dip with `2h < 2/30` s, is a hard cut (it would last
     less than two frames at 30 fps).
3. Calm motion (`effects.calm`): Slide becomes Soft, with `d = min(d, 0.5)`.
4. **Flash rule** (always on): walking the cuts in order, a Dip whose T is less than 1.0 s of video
   time after the T of the last cut drawn as a Dip is drawn as Soft with `d = min(0.15, len(B) / 2)`.
   A full-frame dip to black or white is a general flash (WCAG 2.3.1: "a pair of opposing changes
   in relative luminance of 10% or more"); one a second stays well under the three a second WCAG
   allows.

| Kind | Default | Range | Window | Needs A\* |
|---|---|---|---|---|
| Soft | 0.15 s | 0.05–0.5 s | [T, T + d) | yes |
| Dip to colour | 0.5 s (0.25 s each side) | 0.2–1.2 s | [T − h, T + h) | no |
| Slide | 0.4 s | 0.25–0.7 s | [T, T + d) | yes |
| Punch-in | scale 1.10 | 1.05–1.20 | the whole of B | no |

Why these numbers: Resolve's "2- to 6-frame Smooth Cut" is 0.07–0.2 s at 30 fps; Material's
guidance is that transitions over 0.4 s feel slow, and full-screen ones go up to 0.375 s; editors
report that a centred dip spends half its length on the colour, so 0.5 s gives 0.25 s each way.

### 5.3 A\*, the outgoing still

A's last kept frame, defined from A's end and the proxies' frame rates only, so preview and export
pick the same frames at any export fps:

- Screen: `a* = max(A.start, (⌈A.end · 60 − 1e-6⌉ − 1) / 60)`, the start of the screen proxy frame
  that holds A's last instant (`SCREEN_PROXY_FPS` 60, `src/renderer/src/editor/media.ts:8`).
- Camera: `c* = (⌈(A.end − webcamOffset) · 30 − 1e-6⌉ − 1) / 30` in camera time, the last camera
  proxy frame before A's end (`WEBCAM_PROXY_FPS` 30, `media.ts:9`).
- The picture: `pictureTime(clips, plan, a*)` (`freeze.ts:326`), so a continue freeze still that
  covers A's end is what A\* shows.

A\* is the frame's picture (§5.6) drawn once at `t = pictureTime(a*)`, `soundTime = a*`, with
`blurSamples: 1`, from the screen frame covering `a*` and the camera frame covering `c*`. It is
sharp, as every frozen frame is (`exporter.ts:492`).

Any instant the preview or the export draws from A is earlier than A's end, so it lies in a screen
frame at or before a\*'s and a camera frame at or before c\*'s. Adding a\* and c\* to the decoders'
feeds therefore never makes them go back a frame (§5.8).

A\* is a kept frame: every privacy shape active at a\* (with the half-frame slack of
`shapesLayer.ts:37`) covers it. No frame from inside a cut is ever decoded for drawing.

### 5.4 Windows and progress

`joinPlan(project)` returns the windows of every cut with a Soft, Slide or Dip join, in order:
`{ index, clip, kind, from, to, at: T, still: { screen: a*, camera: c* } | null, color?, dir? }`.
It is memoised on the identity of `clips`, `joins`, `freezes`, `effects` and `webcamOffset`.
`joinAt(windows, v)` finds the window holding video time v by binary search (O(log n)) and returns
it with its progress `p`: `(v − T) / d` for Soft and Slide, `(v − (T − h)) / 2h` for a Dip.

Windows never overlap. A Soft or Slide window of cut i ends by `T_i + len(B_i) / 2`. Any window of
cut i + 1 starts no earlier than `T_{i+1} − len(B_i) / 2 ≥ T_i + len(B_i) / 2`, since
`T_{i+1} ≥ T_i + len(B_i)` (holds inside B only add time). A Dip's first half is bounded by
`len(A) / 2` the same way. So at most one A\* is needed at a time.

`punchAt(project, t)`: walking the clips once (memoised), a state `on` starts false; at each clip
that follows a cut, `on` becomes `!on` if that cut's join is Punch-in, else false; a clip that
touches the one before (a speed split) keeps it. The clip holding source time t is drawn at
`scale` (1.10 by default) while `on`, else 1. A pause hold shows its held frame's clip.

### 5.5 Poses

For a w × h frame, with `e = cubicBezier(0.2, 0, 0, 1)(p)` (Material's standard easing,
`src/shared/engine/easing.ts:11`):

| Kind | B (live picture) | A\* | Colour |
|---|---|---|---|
| Soft | as drawn | drawn over B at α = 1 − p (linear, as NLE dissolves and the cut fades are) | none |
| Slide, from right | moved by dx = w · (1 − e) | moved by dx = −w · e, α 1 | none |
| Slide, from left / top / bottom | dx = −w · (1 − e) / dy = −h · (1 − e) / dy = h · (1 − e) | dx = w · e / dy = h · e / dy = −h · e | none |
| Dip | A's live frames before T, B's after | none | a full-frame fill of the colour at α = 2p while p < 0.5, then 2 − 2p |
| Punch-in | the whole picture scaled by s about the frame's centre (w/2, h/2), for all of B | none | none |

The two slide pictures cover the frame together, edge to edge, and the canvas is opaque
(`alpha: false`), so no gap shows.

### 5.6 Drawing (`drawFrame`, `src/renderer/src/render/compositor.ts:87`)

`drawFrame` is split into two exported halves with no change in what it draws:

- `drawFramePicture(...)`: today's lines from the background (`:141`) through `drawWebcamLayer`
  (`:225`). It returns the top frame context.
- `drawFrameOverlays(top, soundTime, video)`: image overlays, `noteStudioFrame`, key presses, texts,
  graphics, captions, title cards, the chapter bar (§8) and the watermark, in today's order.

`drawFrame` gets one optional last parameter:

```ts
export interface FrameExtras {
  /** Video seconds of this frame (holds included). Absent: videoTimeAt(soundTime) (wrong only inside a pause hold). */
  video?: number
  /** The join this frame is in (joinAt) and A* as composed (composeJoinStill); a null still draws a hard cut. */
  join?: { at: JoinAt; still: CanvasImageSource | null } | null
}
```

and draws:

1. With a Slide, `ctx.translate` by B's offset; with Punch-in, the scale about the centre.
2. `drawFramePicture` for B, as today.
3. The join: A\* with its α and offset (Soft, Slide), or the Dip's fill.
4. `drawFrameOverlays`, once, for B's time: captions, texts, titles and graphics are never faded,
   moved or doubled by a join.

`composeJoinStill(target, w, h, window, scene, stills)` (`joinLayer.ts`) draws A\* with
`drawFramePicture`, under A's own Punch-in scale, into a canvas of the frame's size, in the target's
raster mode (CPU when the export canvas is), and caches it by `${clip}|${w}x${h}` and the project's identity: at most 2
canvases in the export, 4 in the preview.

**Background blur on the camera.** A\*'s camera frame needs its person mask like any other frame,
or the blurred room would show for 0.15 s. The export prepares it with `masks.prepare` before
composing, as it does for every frame (`exporter.ts:517`). The preview segments the still with the
camera's segmenter; the still counts as ready only when its mask is. Where segmentation failed for
the session, live frames are drawn unblurred today, and A\* is the same.

### 5.7 Preview (`src/renderer/src/editor/player.ts`)

- **Stills.** `JoinStills` (new) holds two `FreezeStills` (`freezeStills.ts:12`): one on the
  screen proxy, one on the camera proxy. They make exact stills through the export's own seek path
  (`seekToFrame`, `seekedFrame`, `media.ts:100`, `:116`). Composed A\* canvases are kept in an LRU
  of 4 at the preview's size.
- **Video time.** The player passes the frame's video time: inside a hold `h.start + elapsed`;
  otherwise `editToVideo(plan, o)`, plus the length of a hold at exactly `o` once the player has
  left it (`frameVideoTime`, joins.ts). Without that, the first live frame after a hold at T would
  read as T and show A\* again for a frame.
- **Ahead of time.** At play and after every jump, the windows of the next three cuts after the
  playhead ask for their stills. FreezeStills already makes the stills of freezes ahead this way.
- **Not ready yet.** Paused, or after a seek into a window, the still is asked for; until it is
  ready the preview draws B alone (a hard cut) and redraws when it is, as the continue-freeze
  preview does today.
- **Seeking at the jump.** At a cut the player seeks the `<video>` (`jumpTo`, `player.ts:572`);
  the first frame of B is drawn with A\* at α ≈ 1, which also hides the jump's seek latency.

### 5.8 Export (`src/renderer/src/editor/exporter.ts`)

- `planJob` (`:260`) adds `joinPlan(project)`.
- `joinFeed(pictures, times, windows, fps, webcamOffset)` (pure, joins.ts) returns the screen feed
  (pictures with each window's a\* inserted before the window's first output frame
  `i0 = ⌈T · fps − 1e-9⌉`), the camera feed (`times − webcamOffset` with each c\* inserted at the
  same place), and for each output frame its index in the feeds. A window with no output frame (a
  short one in a 10 fps GIF) adds nothing.
- `openSource` (`:443`, `:452`) gets the feeds instead of `pictures` and `times − offset`. The loop
  draws frame i from its feed index. Before frame i0 it takes the still entries, prepares the camera
  mask, composes A\*, and calls `next()` on both sources.
- Both feeds stay non-decreasing by frame (§5.3). `planFeed` (`feedPlan.ts:16`) allows repeats, so
  an a\* in the same frame as A's last output frame decodes nothing extra (test 12 checks 10, 15,
  24, 25, 30, 50, 60 and 120 fps).
- Thumbnails (`renderThumbnail`, `:583`) and the contrast probe never draw a join.
- The export dialog's preview (`ExportPreview.tsx:99`) uses its own `JoinStills`.

### 5.9 Freezes, speed, transitions and other layers

- **A pause freeze at B's start**: T is the hold's start, so the window runs over the held frame of
  B (the clocks hold, video time runs). The export draws it at `i / fps`; the preview from the hold's
  elapsed time.
- **A continue freeze covering A's end**: A\* is that still (§5.3).
- **Speed**: d is in video seconds, the same at any clip speed; lengths are in edit seconds.
- **Layout and zoom transitions** run in source time and are cut through, as today
  (`LAYOUT_TRANSITION` 0.4, `ZOOM_TRANSITION` 0.7). A\* carries A's layout and camera, so a Soft cut
  blends the two framings.
- **Motion blur**: B as always; A\* is sharp.
- **Tilt, device frames, magnifiers, privacy, cursor, shapes, spotlights, camera**: all part of the
  picture, so A\* has them as they were at a\*.

### 5.10 Sound

Unchanged. Every cut keeps its 10 ms linear fade out and in (`CUT_FADE`, `cutFades.ts:11`), in the
export's graph (`audioPlan.ts:233-245`) and the preview's `cut` gain (`previewAudio.ts:669-697`).
Speech carries the content of a tutorial, NLE video transitions leave the sound alone, and every
longer or overlapping fade would play removed words. Music runs on through cuts as today.

### 5.11 Preview equals export, at any fps and after any seek

`joinPlan`, `joinAt`, `punchAt`, the poses and the still times are pure functions of the project
and the video time. A\* depends on A's end and the proxies' rates only. The export draws video time
`i / fps`; the preview draws the video time of the frame it shows, through holds. Seeking into the
middle of a window draws the same frame as playing into it.

### 5.12 Cost

Measured on the reference rig (CPU raster, Electron 44.9.3): a second full-frame draw at an alpha
costs +1.05 ms per frame at 1080p and +23 ms at 4K; a full-frame fill at an alpha +0.5 ms and +3 ms.
Composing A\* costs one picture draw, about 8.8 ms at 1080p and 21.9 ms at 4K, once per cut. A\*
takes 8 MB at 1080p and 33 MB at 4K. The budget is in §15.

---

## 6. Magnifier

### 6.1 Data

A magnifier is a `Spotlight` with `magnify` (1.5..4). *Add magnifier* makes one with
`mode: 'region'` (or `'cursor'`), `shape: 'ellipse'`, `dim: 0`, `feather: 0`, `magnify: 2.5`, 3 s
long from the playhead, centred on the preview's view, and 0.30 S across in the view at the
playhead: `w = 0.30 S / (rect.w · cam.scale)`, `h = 0.30 S / (rect.h · cam.scale)` (normalised to
the whole recording, like every spotlight). Its box is the lens itself, so the preview's handles,
snapping, the camera director's corners and crop and reframe all treat it as what is drawn.

### 6.2 Grow in and out

In viewing time: `from = viewAt(start)`, `to = viewAt(end)`, `now = viewAt(t)`,
`dIn = min(0.30, (to − from) / 2)`, `dOut = min(0.22, (to − from) / 2)`.

- Entering (`now − from < dIn`): `g = emphDecel((now − from) / dIn)`.
- Leaving (`to − now < dOut`): `g = 1 − emphAccel(1 − (to − now) / dOut)`.
- Otherwise `g = 1`.
- Size factor `r = 0.6 + 0.4 g`; zoom `z = 1 + (magnify − 1) · g`; opacity `α = min(1, 2.5 g)`.
- Calm motion: `r = 1`, `z = magnify`, and α runs linearly over `max(0.2, dIn)` and
  `max(0.2, dOut)` (each at most half the item).
- A cursor magnifier is also multiplied by `cursorSpotlightPresence` (`spotlightLayer.ts`), so it
  fades out while the cursor is off the recording, as the cursor spotlight does.

### 6.3 The lens

- Centre P, normalised to the recording: `(x + w/2, y + h/2)`, or the visible cursor's position in
  cursor mode (`visibleCursorAt`, the point the cursor layer draws).
- On screen: centre `L = fc.toOut(P)`; half sizes `rx = r · w · rect.w · cam.scale / 2`,
  `ry = r · h · rect.h · cam.scale / 2`. Round: an ellipse path (a circle when the box is square in
  pixels). Rounded rectangle: corner radius `0.18 · min(2rx, 2ry)`.
- **Lens camera**: `s' = cam.scale · z`, and on each axis
  `cx' = P.x + 0.5 / s' − (P.x − cam.cx + 0.5 / cam.scale) / z` (the same for y). Then
  `toOutput(rect, lensCam)(P) = toOutput(rect, cam)(P)`: what is under the lens's centre stays where
  it is and grows z times around it. `lensCamera(cam, P, z)` is pure (`src/shared/render/magnifier.ts`).

### 6.4 Drawing (`drawMagnifierLayer(fc)`, `magnifierLayer.ts`)

Called in `drawFrame` between `drawCursorLayer` and `drawShapesLayer` (`compositor.ts:213-214`), on
the card's canvas `c`, inside the card's clip. For each active magnifier, in list order:

1. Shadow: the lens path filled black with `shadowOffsetY = 0.006 S`, `shadowBlur = 0.02 S`,
   colour α `0.35 · α`.
2. Clip to the lens path. Draw the screen through the lens camera: `viewSource(lensCam, rect, slot)`
   from `fc.screen` (the full-resolution frame, the crop's copy, graded), smoothing `'high'`.
3. With `lens = { ...fc, cam: lensCam, toOut: toOutput(rect, lensCam) }`, draw
   `drawPrivacyLayer(lens)` and `drawCursorLayer(lens)`. Blurred and pixelated areas stay hidden at
   any zoom; the cursor and click effects are magnified as a zoom would show them, so in cursor mode
   the magnified pointer tip sits at the lens's centre.
4. Restore. Ring: white, width `max(2 px, 0.004 S)`, then a 1 px black line at α 0.25 just outside
   it, so the lens shows on white pages too.

Everything at the magnifier's α. **Dim the rest** is drawn by `drawSpotlightLayer`, unchanged, after
the shapes: a magnifier is a lit area of its lens's shape with no feather. The order is privacy,
cursor, magnifiers, shapes, then spotlight dimming: arrows and boxes stay visible over a lens, and a
lens stays bright inside a dimmed screen.

- **Tilt**: on `c`, so the lens tilts with the card, like spotlights.
- **Following** (tall frames): `viewSource` clips to the slot, as the card does.
- **Motion blur**: the lens is drawn with the frame's camera only, sharp.
- **Inside a zoom**: z multiplies the zoom. When output pixels per recorded pixel times z passes 4,
  the panel says: "Shown larger than the recording's pixels: it may look soft."
- **Crop**: `fc.screen` is the crop's copy, so nothing outside the crop is sampled.
- **Smooth cuts**: A\* includes the magnifier as it was at a\*.

Cost, measured: +1.9 ms per frame at 1080p and +9 ms at 4K for a shadowed disc, a clipped 2× draw
and the ring. Privacy shapes and the cursor inside the lens cost what they cost outside it.

---

## 7. Animated callouts

### 7.1 One motion engine

`calloutPose(start, end, t, clips, enter, exit, u, calm)` (`src/shared/render/callouts.ts`) returns
Captions Studio's `ChunkPose` (`motion.ts:100`: alpha, dx, dy, scale, scaleX, rotate, blur, reveal)
plus `drawn` (0..1), or null outside the item.

- The kinds of `ItemMotion` go through `itemPose` (`motion.ts:841`) unchanged: viewing time, each
  side at most half the item, Calm clamps, exits play the kind backwards with inCubic.
- `'draw'` (enter only): `drawn = 1 − (1 − p)³`, α 1.
- `'wipe'` (enter only): `reveal = emphDecel(p)`, from the reading start.
- `u` is the item's em: the font px for texts and titles, `min(box w, box h)` in px for shapes.
- An item with `enter` and no `exit` disappears with a fade of its old length (0.15 s for texts and
  shapes, 0.35 s for titles), and the other way round.

What each item allows (the reader drops anything else; `'blur'` never, `'draw'` and `'wipe'` only on
enter):

| Item | Enter kinds | Exit kinds | Default when picked (enter / exit) |
|---|---|---|---|
| Text: pill, title | fade, pop, rise, drop, slide-left, slide-right, grow, typewriter, wipe | fade, pop, rise, slide-left, slide-right, grow | rise 0.25 s, strength 1 / fade 0.18 s |
| Step badge | fade, pop, rise, drop, grow | fade, pop, grow | pop 0.24 s / fade 0.18 s |
| Speech bubble | fade, pop, rise, grow, typewriter | fade, pop, grow | pop 0.26 s from the tail's tip / pop 0.18 s at strength 0.25 (scale 1 → 0.9 toward the tip) |
| Arrow, line | draw, fade, pop, grow | fade, pop, grow | draw 0.35 s / fade 0.18 s |
| Rectangle, ellipse | draw, fade, pop, grow | fade, pop, grow | draw 0.45 s / fade 0.18 s |
| Highlight | wipe, fade | fade | wipe 0.28 s / fade 0.18 s |
| Blur, pixelate | none | none | never animated (`isPrivacyKind`) |
| Title card | fade, pop, rise, slide-left, slide-right, grow, typewriter, wipe | fade, pop, rise, grow | rise 0.35 s / fade 0.35 s |

Exits are never longer than entrances in the defaults (Material: exits shorter than entrances).

### 7.2 Drawing

- **Texts** (`drawAnnotations`, `src/renderer/src/render/textOverlays.ts:16`). An annotation without
  `enter`, `exit` and a new style is drawn by today's lines, untouched. Otherwise: the box is
  measured as today (`annotationMetrics`, extended for badges and bubbles), then `translate(cx + dx,
  cy + dy)`, `scale(scale · scaleX, scale)` about the box's centre (a bubble about its tail's tip),
  `globalAlpha = alpha`, and with `reveal < 1` a clip from the reading start (the right edge for
  right-to-left text) to `reveal · boxW`. Typewriter reveals whole graphemes through
  `typewriterClip` (`motion.ts:983`), with the prefix advances measured once per text and font.
- **Arrows and lines** (`drawShapesLayer`): the shaft is drawn from the tail to
  `tail + (tip − tail) · drawn`. The head (`arrowGeometry`, `src/shared/render/shapes.ts:167`)
  appears when `drawn ≥ 0.8`, scaled `0.6 + 0.4 · back((drawn − 0.8) / 0.2, 1.7)` about the tip
  (`EASE.out` with Calm motion).
- **Rectangles and ellipses**: `setLineDash([L · drawn, L])` with round caps, from the top-left
  corner clockwise, `L = 2(w + h)` in px; an ellipse starts at −135° (half past ten) clockwise with
  Ramanujan's perimeter `L = π(3(a + b) − √((3a + b)(a + 3b)))`. A filled shape reveals its fill
  left to right under the outline as it draws.
- **Highlights**: a clip of width `w · reveal`, left to right.
- **Title cards** (`drawTitleCardsLayer`): a full-frame card's background keeps `titlePhase`'s
  background opacity; the text and a lower third's band take the pose.

### 7.3 Step badges

- Font px `f = size · S` (default `size` 0.034, so 37 px at 1080p), weight 700.
- One glyph: a circle `D = 1.75 f` across (65 px at 1080p). Two glyphs: the font at `0.85 f` in the
  same circle. Three glyphs (own text is at most 3 characters): a pill `1.75 f` high and
  `text width + 0.9 f` wide.
- White ring `0.004 S` wide; shadow `offsetY 0.004 S`, `blur 0.012 S`, black α 0.35.
- Fill `color ?? #0060df`. The label is white or #111111, whichever has the higher contrast with the
  fill (`contrastRatio`, `src/shared/captions/colors.ts:39`). #0060df gives white 5.61:1.
- **Numbering** (`badgeLabels(project)`, memoised on `annotations`): badges with `number: 'auto'`,
  sorted by `(start, id)`, get k = 1, 2, 3… `'1'`: Western digits. `'A'`: A–Z, then AA, AB…
  `'native'`: `withDigits(String(k), 'native', language)` (`src/shared/captions/words.ts:259`) in
  the caption language (Bangla gives ১ ২ ৩); Western when the language has no digits of its own.
- Badges number by time, not by drawing order, so seeking, preview and export agree.

### 7.4 Speech bubbles

- Text px `f = size · S` (default `size` 0.045), weight 600.
- Body padding `0.45 f` top and bottom, `0.7 f` left and right; corner radius
  `min(0.5 · body height, 0.6 f)`; at most `0.42 w` wide in a wide frame and `0.8 w` in a tall one.
- **Wrapping**: greedy by words (`Intl.Segmenter`, word granularity) to the maximum width; text
  without spaces wraps between graphemes, never inside one, so a Bangla conjunct or a vowel sign
  stays with its letter. Line height 1.3, or 1.4 when the text has Bengali, Devanagari or Thai
  (`scriptScale`, `src/shared/captions/fontStack.ts:194`).
- **Tail**: on the body edge nearest the target; base `clamp(0.6 f, ≤ 0.15 × that edge)` wide and at
  least the corner radius from the corners; length clamped to 0.5–3 f toward the target. No tail
  when the target is inside the body or closer than 0.5 f.
- One path for body and tail (`bubblePath`, moved from `studioLayer.ts:1079` to
  `src/renderer/src/render/bubblePath.ts` and shared with Captions Studio's Speech Bubble look,
  whose drawing does not change), so the shadow and the edge join without a seam.
- Fill `color ?? #ffffff`; text #111111 or white by contrast (#ffffff: 18.9:1); shadow
  `offsetY 0.006 S`, `blur 0.02 S`, black α 0.25.
- Right-to-left text (first strong character Arabic or Hebrew, `RTL_FIRST`) is drawn with
  `direction = 'rtl'` and right-aligned.

### 7.5 Calm motion

`effects.calm` (Effects tab: "Calm motion: texts, shapes, the magnifier and slides move less.
Captions have their own setting in the Captions tab.") applies Captions Studio's calm clamps to every
callout (§9.5 there: scale 0.96–1.04, movement at most 0.15 em, no rotation or overshoot, pop and
drop become grow, durations at least 0.2 s), turns Draw into a fade, turns Slide cuts into Soft
(§5.2) and the magnifier's growth into a fade (§6.2). Typewriter and Wipe stay. As in Captions
Studio, it is never written from Windows' animation setting: the same project exports the same
motion on every PC.

### 7.6 Fonts

Pill and title texts keep today's font stack, so old projects draw as before. Badges and bubbles use
`projectFontStack(project, a.font, CALLOUT_FONT)`, where `CALLOUT_FONT` is `ANNOTATION_FONT`
followed by the bundled script fonts of Captions Studio (Noto Sans Bengali, Devanagari, Arabic,
Hebrew and Thai, and the colour emoji font: `CATALOG_FALLBACK`, `titleCardLayer.ts:27`, exported for this). The export
loads them before the first frame with `prepareCaptionFonts` (`exporter.ts:109`), so a Bangla
bubble draws the same on every PC.

### 7.7 Cost

A pose is a few multiplications; a draw-on stroke costs what the stroke costs. Budget: 0.3 ms per
animated item at 1080p, 1 ms at 4K (§15). Bubble lines are laid out once per text, font and width,
cached by content.

---

## 8. Chapter progress bar

`drawChapterBar(fc, video)` (`chapterBarLayer.ts`), between the title cards and the watermark
(`compositor.ts:236-237`), reads `chapterBarLayout(project, w, h, area)` (pure, `chapterBar.ts`).

- **Segments**: `outputChapters(chapters, clips, plan)` (`src/shared/render/chapters.ts:32`; video
  seconds, holds included), plus an unlabelled first segment when the first chapter starts after
  0.1 s, ending at `videoDuration`. With fewer than two chapters: one segment, a plain progress bar.
- **Area**: `R = textAreaWithoutBar(...) ?? the whole frame` (today's `textArea`, renamed and
  exported; see "Room for the bar" below), inset `i = 0.03 S` (32 px at 1080p).
- **Place**: *Auto* is the top when the frame is tall (`isTall`, `reframeData.ts:57`), else the
  bottom. In a tall frame with app-safe zones on, R is `COMMON_SAFE` (`safeZones.ts:72`), so the bar
  sits below the apps' top buttons.
- **Floating**: from `R.x + i` to `R.x + R.w − i`; thickness `th = 0.008 S` (8.6 px at 1080p); at
  `y = R.y + R.h − i − th` (bottom) or `R.y + i` (top); round ends.
- **Edge**: the frame's full width, `th = 0.006 S`, flush with the frame's bottom or top, square
  ends. In a tall frame with app-safe zones on, Edge draws as Floating (the edges are covered).
- **Segments on the bar**: gap `g = max(2 px, 0.005 S)`; segment k spans its share of the length,
  less `g/2` at each inner end; one narrower than `g/2` is drawn `g/2` wide, centred on its share.
- **Colours**: under each segment black α 0.30, then white α 0.35 (not played), then the played
  part from the segment's start to video time v in the bar's colour (`color` ?? the brand's first
  colour ?? #ffffff) at α 1 with a 1 px black α 0.25 outline. Without a brand, white over the dark
  backing is visible on light and dark pages alike.
- **Current segment**: grows from th to 1.5 th over 0.15 s of video time after its start, linearly.
- **Fill**: linear in video time, never eased. Video time comes from `FrameExtras.video`, so the bar
  keeps moving through pause holds.
- **Fades**: the bar fades in over 0.3 s from v = 0. With *Hide between chapters*, it shows from
  each segment's start for 3 s, with 0.3 s fades in and out.
- **Names**: weight 600, `0.03 S` (32 px at 1080p), white with a shadow (`blur 0.004 S`, black
  α 0.6), `0.01 S` from the bar on the inner side. *Current chapter*: at the current segment's start,
  moved left so it stays inside the bar, crossfading over 0.2 s at a chapter change. *All
  chapters*: each centred over its segment, shortened with an ellipsis by graphemes to the
  segment's width less 0.4 em, and left out when fewer than three graphemes fit. Names are hidden
  while a Captions Studio chapter-title card (`auto.by === 'chapter'`) shows, so a name is not read
  twice. The font is the title cards' stack with the bundled script fonts (`cardFont`,
  `titleCardLayer.ts:37`); right-to-left names are drawn right-to-left.
- **Room for the bar**: with `chapterBar.show`, `textArea` (`safeZones.ts:95`) returns
  `textAreaWithoutBar` less a band at the bar's edge of `i + 1.5 th`, plus `0.01 S + 1.3 · 0.03 S`
  when names are shown. Captions, key presses, the logo and lower thirds, which all place
  themselves in `textArea`, keep clear of the bar. Without the bar nothing changes.
- **Cost**: a few rounded rectangles and at most one text per segment: under 0.5 ms at 1080p.

---

## 9. Colour correction and looks

### 9.1 Where the grade runs

Each source picture is graded at its own resolution, before it is drawn, as a pure per-pixel
function. The composed frame is never graded: captions, texts, title cards, graphics, the background
wallpaper, image overlays and the watermark keep their colours.

- **Screen** (`compositor.ts:104-107`): right after the crop copy,
  `screen = gradeScreen(ctx, screen, grade.screen, lut)`. The graded picture is what `drawView`, the
  motion-blur sub-frames and `fc.screen` use, so privacy blur and pixelate boxes, the magnifier and
  A\* are graded too. A canvas source skips `rgbCopy` (`:173`), so motion blur costs nothing more.
- **Camera** (`webcamLayer.ts:83-107`): the person mask is looked up with the raw frame
  (`maskOf(img)`, `:126`, keyed by image identity), then the picture is graded, then drawn or blurred. The
  blur composite's cache (`drawBlurred`, `:202-264`, keyed today on `b.image !== pic.image`) keys
  on the raw frame's identity plus `gradeKey(grade)`, because the graded canvas is reused every frame
  and its identity never changes.
- Thumbnails, the contrast probe (`contrastProbe.ts:64`) and freeze stills go through `drawFrame`,
  so they are graded. The versions branch's filmstrip is not (ffmpeg tiles raw proxy frames); it is
  a navigation strip.
- **Identity**: a grade whose resolved parameters are all zero, with no look and no LUT, is no grade:
  `gradeScreen` returns its input, nothing is copied, and no WebGL context is made. Old projects draw
  their bytes.

### 9.2 The maths (`src/shared/render/colorGrade.ts`)

Canvas pixels are 8-bit sRGB-encoded (2D canvas `colorSpace` 'srgb'; WebGL `drawingBufferColorSpace`
and `unpackColorSpace` 'srgb', confirmed in Electron 44 / Chromium 152). Decode: `l = e / 12.92` for
`e ≤ 0.04045`, else `((e + 0.055) / 1.055)^2.4`; encode with the inverse (threshold 0.0031308).
Luminance weights (linear sRGB / Rec.709): `W = (0.2126, 0.7152, 0.0722)`.

**Resolved parameters**: the look's parameters times `lookStrength`, plus the sliders, each clamped
to its range. A look and the sliders therefore add up (Warm at 100 % with Temperature −10 gives
temperature 0.25).

**Per channel** (stages 1–6), baked into an exact 256-entry table per channel, indexed by the input's
8-bit code, so they have no interpolation error (baking takes 0.30 ms in JS):

1. **White balance**, in linear light: the gains are the linear sRGB of the Planckian light at
   `CCT = 1e6 / (1e6 / 6504 + 60 · temperature)` (Kim et al. 2002 spline, xy → XYZ → linear sRGB),
   then green × `2^(−0.25 · tint)`, normalised so that `W · gains = 1` (brightness kept).
   Temperature +1 is 4678 K: gains 1.217, 0.969, 0.671; −1 is 10666 K: 0.820, 1.010, 1.429. Tint
   +1: 1.128, 0.949, 1.128.
2. **Exposure** (camera): `l · 2^exposure`, clamped to 0..1.
3. **Brightness**, encoded: `e^(2^(−0.7 · brightness))`. Black and white stay where they are, so a
   white page never clips.
4. **Contrast**, encoded, an S-curve about 0.5 (close to 18 % grey, 0.461) with `k = 2^contrast`:
   `0.5 · (e / 0.5)^k` below 0.5, `1 − 0.5 · ((1 − e) / 0.5)^k` above. Monotonic, ends fixed,
   never clips.
5. **Shadows and highlights**, encoded:
   `e + shadows · 0.945 · e(1 − e)² + highlights · 0.945 · e²(1 − e)` (Bernstein bumps peaking at
   1/3 and 2/3; 0.945 = 0.14 × 6.75). Monotonic for every value in −1..1 (the bound is 4/27 for
   0.14 · amount). No local tone mapping: it costs a blur and flickers.
6. **Fade** (looks only), with f the look's fade amount (0..1): `0.08 f + e · (1 − 0.08 f)`.

The table holds the result decoded to linear light, as 32-bit floats.

**Across channels** (in the shader, or the CPU path):

7. **Saturation and vibrance**, in linear light about the pixel's luminance `Y = W · c`:
   `S = (1 + saturation) · (1 + vibrance · (1 − sat)²)`, with `sat = (max − min) / max` of the
   encoded input (0 when max is 0); `c' = max(0, Y + (c − Y) · S)`. Luminance is kept.
8. **Split toning** (looks only): `c' += kS · (1 − y)² · teal + kH · y² · orange`, y the encoded
   luminance, with `teal = (−0.4298, 0.0702, 0.5702)` and `orange = −teal`: both have zero
   luminance.
9. Encode to sRGB.
10. **LUT** (`.cube`), on the encoded values (what creative LUTs expect): the input mapped through
    the file's domain and clamped to 0..1, tetrahedral interpolation, mixed with the graded value by
    `strength`.
11. Clamp to 0..1, round to 8 bits (`round(v · 255)`). No dither: it would make output
    non-deterministic and cost bitrate.

Why not bake everything into one 3D LUT: measured against the exact maths, a 33³ LUT is off by up to
14 of 256 levels for Vivid, 12 for Cinematic, 6 for a strong brightness change and 30 for a strong
warm plus saturation, all where saturation clips at the gamut's edge, a kink a LUT cannot follow.
The exact table plus the shader's cross-channel step has none of that.

### 9.3 Shader, CPU path and parity (`src/renderer/src/render/gradeLayer.ts`)

**One WebGL2 context** for the app (`alpha: false`, `antialias: false`, `preserveDrawingBuffer:
false`), on an `OffscreenCanvas`. Per grade: upload the picture from a 2D canvas copy
(`texImage2D`, `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`, no premultiply), draw one full-screen
triangle, then copy the result in the same task into a 2D canvas per target and source (screen,
camera), as `tiltLayer.ts:318` does. Textures:

| Texture | Format | Size |
|---|---|---|
| The picture | RGBA8, `texelFetch` (no filtering) | the picture's size |
| The per-channel table | RGBA32F, 256 × 1, `texelFetch` | 4 KiB |
| A LUT | RGBA32F 3D, N³, `texelFetch` only (unfiltered float textures are core WebGL2) | 33³: 562 KiB; 65³: 4.4 MiB |

The fragment shader, in outline:

```glsl
#version 300 es
precision highp float;
uniform sampler2D pic; uniform sampler2D table; uniform highp sampler3D lut;
uniform float S0, vib, kS, kH; uniform vec3 teal; uniform int lutN; uniform float lutMix;
uniform vec3 dMin, dScale;
out vec4 o;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec3 e8 = texelFetch(pic, at, 0).rgb;                     // exact k/255
  ivec3 k = ivec3(round(e8 * 255.0));
  vec3 l = vec3(texelFetch(table, ivec2(k.r, 0), 0).r,     // stages 1-6, linear
                texelFetch(table, ivec2(k.g, 0), 0).g,
                texelFetch(table, ivec2(k.b, 0), 0).b);
  // stages 7-9 as §9.2; stage 10: tetrahedral(lut, (encode(l) - dMin) * dScale) mixed by lutMix
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
```

Tetrahedral interpolation is done in the shader with eight `texelFetch`es (OpenColorIO's and
Resolve's default), not hardware trilinear filtering: measured in Electron 44.9.3, hardware filtering
put about 1 % of values one level off any CPU reference (half-float storage and 8-bit filter
weights), while `texelFetch` tetrahedral matched a JS reference except for at most 7 of 786,432
values, each one level.

**Upload is exact.** Measured: `putImageData` round trip 0 of 786,432 values differ; a 2D canvas →
`texImage2D` → `texelFetch` passthrough 0 differ. An I420 `VideoFrame` drawn four ways (a GPU canvas,
a `willReadFrequently` canvas, `texImage2D(VideoFrame)`, and `copyTo` RGBA) was bit-identical in this
build. With hardware decoding, Chromium's video upload and Skia's `drawImage` may differ, so the
grade's input is **always a 2D-canvas copy** (the crop's copy, or a copy made for the grade), as
`cropFrame` and `rgbCopy` do. It is then exactly what the ungraded path would draw, in preview
(`<video>`) and export (`VideoFrame`) alike.

**The CPU path** (no WebGL2): the same maths in `gradePixelsCpu` (shared, pure): the table stores
linear values, saturation runs in linear light with a 4,097-entry encode table, a LUT is tetrahedral
on its Float32 data. `drawImage` into a `willReadFrequently` canvas, `getImageData`, grade,
`putImageData`. When a grade has no cross-channel stage (no saturation, vibrance, split or LUT), the
CPU path is a single 8-bit lookup per channel. Measured end to end in Electron: 11.5 ms at 720p,
41.9 ms at 1080p and 90.1 ms at 4K with saturation; the pure maths alone take 6.5 ms (table only)
and 17.0 ms (with saturation) at 1080p on one core.

**One backend per session.** `gradeBackend()` decides once, at the first grade: WebGL2 when a
context can be made and a self-test (a 64 × 64 pattern of every look plus a 17³ LUT) matches
`gradePixelsCpu` within one level; otherwise the CPU path, for the preview and the export alike, and
the panel shows the notice of §2.5. Since Chrome 139, WebGL is refused on GPU-blocklisted PCs unless
`--enable-unsafe-swiftshader` is set, so those PCs get the CPU path. On context loss the context is
made again; if that fails, the session switches to the CPU path, preview and export together.

**Never 'display-p3'**: not the 2D canvases' `colorSpace`, not the WebGL drawing buffer nor the
unpack colour space. Exports stay sRGB bytes, tagged BT.709 as today (`exportArgs.ts:20`).

### 9.4 Looks (`src/shared/render/looks.ts`, parameter sets, 0 bytes)

| Look | Parameters |
|---|---|
| Natural | contrast 0.08, vibrance 0.15 |
| Warm | temperature 0.35, tint 0.05, contrast 0.06, vibrance 0.10 |
| Cool | temperature −0.30, tint −0.05, contrast 0.08, saturation −0.05 |
| Vivid | contrast 0.20, saturation 0.12, vibrance 0.30 |
| Soft | contrast −0.12, highlights −0.30, fade 0.5, saturation −0.12 |
| Cinematic | contrast 0.15, saturation −0.10, temperature 0.05, split kS 0.06 (teal shadows), kH 0.05 (orange highlights) |
| Mono | saturation −1, contrast 0.18, shadows 0.10 |
| Vintage | temperature 0.25, saturation −0.35, fade 0.6, contrast −0.05, split kH 0.04 |

Names are generic, never film brands. The chips' thumbnails are drawn by the same grade on a small
still of the project (the frame at the playhead, 96 × 54), and always carry a text label.

### 9.5 LUT files (`src/shared/render/cubeLut.ts`, `src/main/lutImport.ts`)

`.cube` files are untrusted. One strict parser, `parseCube(text)`, used in main before the file is
copied and in the renderer before it is drawn:

| Rule | Value |
|---|---|
| File size | at most 16 MiB (a 65³ file is 7–10 MiB of text) |
| Text | UTF-8 with `TextDecoder('utf-8', { fatal: true })`; a BOM is skipped; CRLF and tabs accepted; a NUL byte rejects the file |
| Lines | at most 1,024 characters; `#` starts a comment |
| Keywords | case-insensitive; only before the first data line; each at most once |
| `LUT_3D_SIZE` | an integer 2..65 (required) |
| `LUT_1D_SIZE` | an integer 2..65,536 (Resolve's shaper, applied first) |
| `DOMAIN_MIN`, `DOMAIN_MAX`, `LUT_1D_INPUT_RANGE`, `LUT_3D_INPUT_RANGE` | finite, max > min |
| `TITLE` | quoted, at most 256 characters; controls and bidi overrides removed; shown as plain text, cut to 80 |
| `LUT_IN_VIDEO_RANGE`, `LUT_OUT_VIDEO_RANGE` | accepted and ignored |
| Other keywords, `LUT_2D` | the file is rejected |
| Numbers | `^[+-]?(\d+\.?\d*\|\.\d+)([eE][+-]?\d{1,3})?$`, finite, \|v\| ≤ 16; no NaN, Infinity or hex |
| Data | exactly N1 + N3³ lines of three numbers, red fastest, then green, then blue; nothing after |

Measured: a 17³ file parses in 8.6 ms, 33³ in 14–15 ms, 65³ in 100–105 ms; NaN, 1e999, size 4096, a
short file, an extra line and a keyword after the data are all rejected. A rejection says why:
"This LUT could not be used: line 1,204 has 2 numbers, not 3."

**Import.** *Import a LUT (.cube)…* opens main's file dialog (the `pickAsset` pattern, kind `'lut'`,
`ASSET_SPECS.lut`, 16 MiB). Main reads the file, parses it (rejecting before anything is copied),
hashes it (SHA-256), copies it as `lut-<n>.cube` through `store()`, and returns
`{ file, sha256, title, size }`. One store update sets `grade.screen.lut` or `grade.camera.lut`.

**Load.** The renderer fetches `studio-media://project/<id>/lut-<n>.cube` (at most 16 MiB), checks
its SHA-256 with `crypto.subtle.digest`, parses it with the same parser, and uploads it. A file that
is missing, changed or unreadable is drawn without (the grade's other stages stay), the Colour
section says "The LUT file is missing or has changed. Import it again.", and the export says the same
before it starts and asks whether to go on without it.

### 9.6 Auto colour (camera only, offline; `src/shared/editor/autoColour.ts`)

- **Frames**: about 12, spread over the kept clips, sampled and segmented as the camera director
  does (`measureFraming`, `directorAnalysis.ts:127`; `segmentPicture`, `personSegmenter.ts:102`;
  long side 256 px, `SEGMENT_SIZE`). About 1–2 s; nothing is uploaded.
- **Illuminant**: Shades-of-Gray with Minkowski p = 6, in linear light, over background pixels (mask
  below 0.3), or the whole frame without a mask. Pixels with a channel ≥ 250, a maximum below 12, or
  chroma above 0.6 are left out. The per-channel median across frames. (Median angular error on the
  Gehler-Shi set: Gray-World 6.28°, Shades-of-Gray 4.01°.)
- **Temperature and tint**: a grid search over the gains of §9.2 stage 1 in steps of 0.01 for the
  closest match; 70 % of it is applied, and `|temperature| ≤ 0.6`. Webcams balance already, and a
  coloured wall makes grey-world overshoot.
- **Levels**: luminance percentiles p0.5 and p99.5 of the whole frame; contrast is raised only when
  black is above 0.04 or white below 0.92 (encoded), by at most the amount that stretches 1.25×.
  Brightness is raised only when the median is below 0.38, by at most the equivalent of 0.7 stops.
- **Never a skin target**: exposure is never set from skin tone, which would lighten darker skin.
  The face box (`faceBoxOfMask`, `faceFraming.ts:80`) only guards against clipping: its p90 must
  stay below 0.95.
- **Result**: ordinary stored values in `grade.camera`, plus `grade.auto = { camera: <before> }`, in
  one update. Never recomputed while drawing, so it is the same at any seek and fps. One Review row
  (§11). Not offered for the screen, whose colours are the apps' own.

### 9.7 Screen and camera

The two grades are independent: a warm look on the camera never tints the screen. The screen's panel
has no Exposure (screen recordings are not exposed) and no Auto colour; its Mono and Soft chips carry
the contrast hint. Both have LUTs. A camera hidden in a layout costs nothing (the layer returns before
grading).

---

## 10. Music and sound-effects library

### 10.1 The catalogue (`src/shared/audio/soundLibrary.ts`, pure, no runtime imports)

One module, like `fontCatalog.ts`. Each bed: `id`, `mood`, `title`, `artist`, `album`, `licence`
(`'CC0-1.0'`), `page`, `upstream { url, bytes, sha256 }`, `prepared { file, bytes, sha256, samples,
loopStart, pad }`, `bundled`. Each effect: `id`, `title`, `source`, `page`, `licence`, `prepared {
file, bytes, sha256 }`, `seconds`, `peakAt`, `uses`. Ids never change; a changed file gets a new id.

The **upstream** bytes and SHA-256 below were measured on the files downloaded for this design. The
**prepared** files are made by `scripts/build-sound-library.mjs` from the pinned upstream files with a
pinned ffmpeg and libopus (§10.2); the script writes their bytes and SHA-256 into the catalogue, and
`--check` proves the committed files match it. The prepared sizes below are from the research
encodes (ffmpeg 6.1.1, libopus 1.4); the build's own encodes may differ by a few bytes and the
catalogue records whatever the build produced.

**Music beds** (all CC0 1.0 on their Free Music Archive pages; artists' pages say "public domain" or
"Do whatever you want with this, it's CC0"; 48 kHz stereo; one pass = the prepared file's length;
the loop repeats from *loop start* to the end):

| Id | Title — artist (album) | Mood | One pass | Loop start | Prepared bytes | Where | Upstream bytes, SHA-256 |
|---|---|---|---|---|---|---|---|
| `calm-winter-rain` | Winter Rain — John Bartmann (Softly, Boldly With A Piano) | Calm | 83.21 s | 22.663 s | 678,742 | installer | 2,700,970, `9d773eee8f5d7f9bc236b4e0cdf97b0fcc44b5e77f63544b11904a10dbf0d63f` |
| `calm-drifting-piano` | Drifting Piano — HoliznaCC0 (Background Music) | Calm | 83.37 s | 25.774 s | 680,070 | download | 4,420,963, `5d1d80af901c244bcedb618b5350b83874167258ba4fa17da83a2a005a26f95e` |
| `calm-gentle-rain` | Gentle Rain — John Bartmann (Royalty Free Soundtrack Music Album Two) | Calm | 123.01 s | 75.000 s | 1,002,198 | download | 7,805,133, `3296ddca9b6ebd55d062b3ef786704c6b2001475d3c14bf5312e96d461d9d414` |
| `upbeat-sweet-sun` | Sweet Sun — Loyalty Freak Music (POSITIVE ATTITUDE !) | Upbeat | 103.63 s | 33.808 s | 844,568 | installer | 4,843,926, `0e78c97159d005e5727fb8c406c1613047f17bfe74450d37e941dafbfe0975fa` |
| `upbeat-champ-de-tournesol` | Champ de tournesol — Komiku (It's time for adventure !) | Upbeat | 81.61 s | 21.316 s | 665,729 | download | 4,878,533, `1cd0a1029eadfa6d1bb0b200019e8c4ad761582b78176a2c7750afa5ed5c694e` |
| `corporate-utopian-future` | Utopian Future — John Bartmann (Machine Learning) | Corporate | 99.22 s | 20.805 s | 808,738 | installer | 2,225,388, `d8f391ab15665291a81388ba4b5dbc64ca9efd84bcd4c6cd1f5d8cc2a10c3676` |
| `corporate-hopeful-start` | Hopeful Start — John Bartmann (Royalty Free Soundtrack Music Album Two) | Corporate | 80.73 s | 19.551 s | 658,611 | download | 6,058,897, `63a7d38d67b013a1c7d15847c21155fad98c960e99d666430d0e759ba0c7cabf` |
| `lofi-tranquil-mindscape` | Tranquil Mindscape — HoliznaCC0 (Public Domain Lofi) | Lo-fi | 84.49 s | 20.248 s | 689,278 | installer | 6,143,203, `488d9693c13e44c5213c0647ee89ea91b21e17d9ac602225a78ee089720134c0` |
| `lofi-walking-away` | Walking Away — HoliznaCC0 (Public Domain Lofi) | Lo-fi | 143.26 s | 72.586 s | 1,166,780 | download | 6,243,043, `fd8a618a4076b76f02f69414d6beb4ad7ddf3b8c26164085bd6dc1a9fd2f7610` |
| `lofi-coexistenz` | Coexistenz — Loyalty Freak Music (TO CHILL AND STAY AWAKE) | Lo-fi | 92.20 s | 34.598 s | 751,639 | download | 6,307,619, `a30737e60dd04961b645312d9a33683b8cc7b2d591ed22892ef552dd1750c9f0` |
| `cinematic-epic-vista` | Epic Vista — John Bartmann (Making Soundtracks Is Easy) | Cinematic | 100.17 s | 44.861 s | 816,574 | download | 3,375,327, `661660444ace059869b9c19f0fc466c92b3cebb18112506bf7a906f4f4dc957a` |
| `cinematic-birth-of-the-machines` | Birth of the Machines — John Bartmann (Machine Learning) | Cinematic | 100.24 s | 26.424 s | 816,973 | download | 2,212,863, `48777b66ccb5b6bcf20732dd6b30768734d6ed202ed571e59f993db0bb2bfff2` |

Upstream URLs (all `https://files.freemusicarchive.org/storage-freemusicarchive-org/`):
`tracks/K6s6VIyPSow7rtcn9s1qxUNUeNuJunVJpyZxenXP.mp3` (Winter Rain),
`tracks/uGFgbWaUKc0LLRnbLShVKZ7yhiK5nsxczsKgpcvW.mp3` (Drifting Piano),
`music/ccCommunity/John_Bartmann/Royalty-Free_Soundtrack_Music_Album_Two/John_Bartmann_-_11_-_Gentle_Rain.mp3`,
`music/no_curator/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_04_-_Sweet_Sun.mp3`,
`music/no_curator/Komiku/Its_time_for_adventure_/Komiku_-_03_-_Champ_de_tournesol.mp3`,
`tracks/xW9Yx97WQo8L5xuHu0O3AmtOFb1EKZBvdYLKmftN.mp3` (Utopian Future),
`music/ccCommunity/John_Bartmann/Royalty-Free_Soundtrack_Music_Album_Two/John_Bartmann_-_10_-_Hopeful_Start.mp3`,
`tracks/uxGaqYrlWHy1w4jA6fJki0NlNx6xkkFG5BMwI8JN.mp3` (Tranquil Mindscape),
`tracks/WOtcP3GhbgTD8CuC6sEgpQOEXMyNeXYbTNmHjgN6.mp3` (Walking Away),
`music/Music_for_Video/Loyalty_Freak_Music/TO_CHILL_AND_STAY_AWAKE/Loyalty_Freak_Music_-_01_-_Coexistenz.mp3`,
`tracks/S7EzhO3lpwufLCPHNsxPukPtfXK6UenUQckrngC6.mp3` (Epic Vista),
`tracks/zfkn5NZ2I2TnBTugoEViMwaagx4gQknIc6Zizxji.mp3` (Birth of the Machines). Each track page
(listed in the catalogue's `page`) reads "<title> by <artist> is licensed under a CC0 1.0 Universal
License". The pages, all under `https://freemusicarchive.org/music/`:
`John_Bartmann/softly-boldly-with-a-piano/winter-rain/`,
`holiznacc0/background-music/drifting-piano/`,
`John_Bartmann/Royalty-Free_Soundtrack_Music_Album_Two/gentle-rain/`,
`Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_04_Sweet_Sun/`,
`Komiku/Its_time_for_adventure_/Komiku_-_Its_time_for_adventure_-_03_Champ_de_tournesol/`,
`John_Bartmann/machine-learning/utopian-future/`,
`John_Bartmann/Royalty-Free_Soundtrack_Music_Album_Two/hopeful-start/`,
`holiznacc0/public-domain-lofi/tranquil-mindscape-lofi-happy-reflection/`,
`holiznacc0/public-domain-lofi/walking-away-lofi-peaceful-motivating/`,
`Loyalty_Freak_Music/TO_CHILL_AND_STAY_AWAKE/Loyalty_Freak_Music_-_TO_CHILL_AND_STAY_AWAKE_-_01_Coexistenz/`,
`John_Bartmann/making-soundtracks-is-easy/epic-vista-moving-orchestral-electronic-commercial-soundtrack-music/`,
`John_Bartmann/machine-learning/birth-of-the-machines/`. The upstream files are pinned for provenance and to rebuild the prepared files; the app never
downloads them.

Notes for the build: Drifting Piano is at −27.2 LUFS upstream and needs +11.1 dB (listen for hiss);
Utopian Future reached only −17.3 LUFS under the true-peak cap, so its preparation adds a gentle
true-peak limiter; Champ de tournesol has the weakest loop (similarity 0.657), and a shorter loop of
44.582–80.730 s scored 0.768 and is the one to try first by ear.

**Sound effects** (16, all in the installer; mono 48 kHz; *peak* is the time from the start to the
loudest moment, used to line a sound up with the picture):

| Id | Title in the UI | Source (CC0) | Length | Peak | Prepared bytes | Offered for |
|---|---|---|---|---|---|---|
| `whoosh-in` | Whoosh | qubodup, "Swish - bamboo stick weapon swhoshes", swosh-03 | 0.576 s | 0.075 s | 3,496 | zoom in, titles |
| `whoosh-out` | Whoosh out | same pack, swosh-13 | 0.508 s | 0.116 s | 3,120 | zoom out |
| `whoosh-soft` | Soft whoosh | same pack, swosh-16 | 0.437 s | 0.073 s | 2,712 | zooms, titles, slides |
| `swish-quick` | Quick swish | artisticdude, "Swishes Sound Pack", swish-9 | 0.154 s | 0.059 s | 1,222 | callouts |
| `pop` | Pop | cogitollc, "Pop sounds", pop1 | 0.207 s | 0.036 s | 1,533 | callouts, badges, pop-ups |
| `pop-soft` | Soft pop | cogitollc, "Pop sounds", pop3 | 0.125 s | 0.045 s | 1,027 | callouts, pop-ups |
| `pop-bubble` | Bubble pop | wubitog, "3 Pop Sounds", pop1 | 0.236 s | 0.010 s | 1,693 | bubbles, pop-ups |
| `click` | Click | Kenney, Interface Sounds, click_001 | 0.097 s | 0.006 s | 680 | callouts |
| `tick` | Tick | Kenney, tick_002 | 0.020 s | 0.005 s | 420 | badges |
| `bell` | Bell | PWL, "Bell dings/chimes", bell_ding2 | 1.352 s | 0.030 s | 8,098 | titles |
| `chime` | Chime | Kenney, confirmation_001 | 0.290 s | 0.006 s | 2,760 | titles, callouts |
| `success` | Success | qubodup, "6 user interface ding clicks", dingCling-positive | 0.294 s | 0.103 s | 3,149 | callouts |
| `rise` | Rise | Kenney, maximize_004 | 0.402 s | 0.354 s | 3,366 | callouts |
| `fall` | Fall | Kenney, minimize_004 | 0.401 s | 0.048 s | 2,937 | callouts |
| `bubble-in` | Bubble | Kenney, question_001 | 0.487 s | 0.166 s | 3,254 | bubbles |
| `drop` | Drop | Kenney, drop_002 | 0.188 s | 0.006 s | 1,864 | badges |

Total 41,331 bytes. Upstream files (each from `https://opengameart.org/sites/default/files/`):

| File | Bytes | SHA-256 | Page and licence |
|---|---|---|---|
| `kenney_interfaceSounds.zip` | 834,536 | `f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232` | https://opengameart.org/content/interface-sounds and https://kenney.nl/assets/interface-sounds: CC0; kenney.nl: "public domain licensed (CC0)… Attribution is not required"; the zip's License.txt says CC0 |
| `swoshes.7z` | 4,858,146 | `2d55b26f918a4d8042e2c97a4db81392757195f5aaac9039f5ec2c557b6f11f2` | https://opengameart.org/content/swish-bamboo-stick-weapon-swhoshes: CC0, attribution "[optional]" |
| `dingclicks.7z` | 43,474 | `d73c088f6c2950db351c894ec74a6a0c9d02a497d8747e5409f8f3af64fc7a6c` | https://opengameart.org/content/6-user-interface-ding-clicks: CC0; info.txt "Public Domain Dedication or CC0" |
| `swishes.zip` | 385,150 | `7980215241b739a787dcf26f660ce510bb237900968789395a86911619795693` | https://opengameart.org/content/swishes-sound-pack: CC0 |
| `pop1.ogg` | 6,607 | `a00ec6f278e2237d1b95dd0a53dfd2398ea44a7497794b38ab4b28602573d763` | https://opengameart.org/content/pop-sounds: CC0 |
| `pop3.ogg` | 5,638 | `3b9a801da20f92d720ff2c0076914228086107ec6792411494bf25ee6f8eb3ed` | same page: CC0 |
| `3pops.zip` | 90,641 | `b54c299913b6502e5d07ba62bcc6726f13498ee848d49f25fc4390e0b6103a82` | https://opengameart.org/content/3-pop-sounds: CC0, "No Attribution Required" |
| `bell_ding2.wav` | 254,020 | `e4a764a1e0a6284f5a5ec80caf3d44c76d3ff8db17ddab8b42abb6b143e83529` | https://opengameart.org/content/bell-dingschimes: CC0, "Releasing as public domain" |

Six more measured CC0 effects (typing, keypress, shutter, scroll, toggle, error) wait for sound items
on the timeline (§20): no feature of this wave would play them.

### 10.2 Preparing the files (`scripts/build-sound-library.mjs`)

Run by a person with network access, never by the app or CI. It downloads each upstream file, checks
its bytes and SHA-256 (any mismatch stops it), and prepares:

- **Beds**: decode, resample to 48 kHz stereo, cut `[0, loopEnd)` at the analysed sample positions,
  bake a 1.0 s equal-power crossfade (the last second fades into the second before `loopStart`, so
  the file's end continues straight on at `loopStart`), append a 0.25 s pad (12,000 samples) of the
  loop's continuation (never played; it absorbs Opus's end-of-stream noise: without it the seam step
  was 0.096 against a body p99.9 of 0.034), gain to −16 LUFS integrated over one pass plus one loop
  with true peak ≤ −1.5 dBTP, encode Ogg Opus 64 kb/s constrained VBR. Header gain 0 and no R128
  tags (decoders differ on applying them; the gain is in the samples).
- **Effects**: decode, mono, trim silence at −60 dBFS, 2 ms fade in and 5 ms out, gain so the loudest
  400 ms is −20 LUFS unless the true peak would pass −1 dBTP (measured again after encoding, the gain
  lowered until it holds; Opus can add up to 1.5 dB), 20 ms of silence after, Ogg Opus 48 kb/s VBR.
  Short clicks reach only −31 to −26 LUFS under the peak cap; that is their natural level.
- It records the ffmpeg and libopus versions it used in `resources/sound-library/SOUNDS.md` with
  every file's source, licence, bytes and SHA-256, and writes the catalogue's prepared fields.
  `--check` re-hashes the committed files against the catalogue without a network.

### 10.3 What ships and what downloads

- **In the installer**: `resources/sound-library/` (4 beds, 3,021,326 bytes; 16 effects, 41,331
  bytes; `SOUNDS.md`), shipped through `extraResources` outside `app.asar`, because ffmpeg reads
  them from a real path. Opus does not compress further (xz −9e saved 0.01 %), so the installer
  grows by about **3.06 MB**. `SOUND_LIBRARY_BUDGET = { compressed: 3.2e6, installed: 3.2e6 }` in
  `scripts/lib/packaging.cjs`; `verify-dist` checks every file's hash in the built app.
- **On request**: the 8 other beds, **6,558,574 bytes** (0.66–1.17 MB each), into
  `userData/sound-library/`, from the source chosen in §0 decision 1. Each through
  `downloadPinned` (`src/main/speech/download.ts:242`): https on port 443, no query, the allowed
  prefix only (re-checked on every redirect), never more than the pinned bytes, SHA-256 checked,
  resume, retries and `Retry-After`; a `.part` file renamed only after the check. Cap: the pinned
  bytes per file, 12 MB for the whole library. The allowed prefix is added for these files only
  (`allowSoundUrl`, `src/main/soundLibrary/store.ts`); the font store's list does not change.
- **Missing bed**: a project whose `music-<n>.ogg` is gone but has `music.library` gets a notice
  "The music file is missing. Copy it from the library again?" with one button, which copies (or
  downloads) the bed again by id. This also mends a version that points at a pruned pick.
- **Notices**: `resources/notices/37-sound-library.txt` lists every file, its author, source page
  and licence (CC0 needs no credit; the list is for provenance). `scripts/notices.mjs` folds it
  into `THIRD_PARTY_NOTICES.txt`.

### 10.4 Looping

**Library beds in the export** (`musicGraph`, `audioPlan.ts:300`): with `bed`, main reads `samples`
(E) and `loopStart` (S) from the catalogue (never from the renderer) and checks the project file's
SHA-256 against the catalogue's; on a mismatch it loops the whole file as today. The graph (verified
with ffmpeg 7.0.2):

```
[m]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=E,asplit[h][b];
[b]atrim=start_sample=S,asetpts=PTS-STARTPTS,aloop=loop=-1:size=E-S[l];
[h][l]concat=n=2:v=0:a=1
```

then today's volume, fades, ducking and padding. No `-stream_loop`. A 300 s render of Utopian Future
matched `decoded[0:E] + repeat(decoded[S:E])` with a maximum difference of 0.0, and the steps at the
seams (0.0132) were below the body's 99.9th percentile step (0.0335). `aloop` holds E − S samples:
at most 78 s, about 30 MB as stereo float.

**Library beds in the preview** (`previewAudio.ts`): the bed is decoded once with
`decodeAudioData` (from the project file through `studio-media://`) and played by an
`AudioBufferSourceNode` with `loop = true`, `loopStart = S / 48000`, `loopEnd = E / 48000`, started
at `bedTime(out)` = `out` while `out < E/48000`, else `S/48000 + (out − S/48000) mod ((E − S)/48000)`
(shared, pure). It connects to today's music gain chain, so volume, fades and ducking are today's.
On a seek it starts again at the new `bedTime`; across cuts it plays on, as music does today. The
context keeps the device's rate (§3.2 row 21): loop points in seconds land between samples at
44.1 kHz, and the baked crossfade hides it. At preview speeds other than 1× the source's
`playbackRate` follows the preview speed, so the pitch moves like a tape; playing backwards it is
silent, as the recording is. Memory: the longest bundled bed, 103.6 s, is about 40 MB decoded.

**Users' own music** (§0 decision 2): when music loops and its file is not WAV, FLAC, MP3 or Vorbis
(that is, Opus, M4A or AAC), main decodes it once with the app's ffmpeg into
`.cache/music-<n>.<first 16 hex of its SHA-256>.flac` and the job reads that file with today's
`-stream_loop -1`, which is exact on FLAC (measured error 0.0). The cache is made only when the music
is shorter than the video. The preview keeps its `<audio loop>`.

### 10.5 Loudness, ducking, fades and volume

- Beds are at −16 LUFS integrated with true peak ≤ −1.5 dBTP, the same target as the recording's
  normalisation (`LOUDNESS_TARGET`, `src/shared/audio/loudness.ts:12`).
- A bed uses today's `MusicSettings` and defaults (`DEFAULT_MUSIC`: volume 0.35, ducking 0.7, loop,
  fade in 1 s, out 2 s; `settings.ts:37`). Between phrases it sits at about −25.1 LUFS (0.35 is
  −9.12 dB), and while someone speaks the ducked gain is 0.35 × 0.3 = 0.105 (−19.6 dB), about
  −35.6 LUFS: roughly 19.6 dB under speech normalised to −16. Ducking (`DUCK_TIMING` 0.15 / 0.45 s,
  `musicDucking`, `duckExpression`) and `musicEnd` need no change.
- Effects: one **Volume** (`soundFx.volume`, default 0.35, the synthesised pop's `POP_VOLUME`). A
  file at −20 LUFS at 0.35 plays at −29.1 LUFS, beside today's pop at −30.5. Effects are not ducked
  and do not duck the music. The synthesised pop and ding keep `POP_VOLUME`, so old projects sound
  the same.
- The whole soundtrack's fades (`AudioSettings.fadeIn` / `fadeOut`) apply to effects too, as they do
  to today's pops.

### 10.6 When effects sound (`sfxJob`, `src/shared/render/sfxJob.ts`, pure)

One function gives every library effect's times in video seconds, for the export job and the
preview alike, through `sourceToOutput` and `editToVideo` as `popJob` does (`popSound.ts:140`):

- **Zooming in**, for each zoom with `tin > 0` that does not pan from the previous zoom
  (`zoomTimings`, `src/shared/engine/zoom.ts:650`: `fromPrev` false): at the video time of source
  `seg.start + tin / 2`, the fastest point of easeInOutCubic, minus the effect's `peakAt`. For a
  0.7 s transition and Whoosh that is 0.275 s after the zoom starts.
- **Zooming out**, for each zoom with `tout > 0` that does not pan into the next (`toNext` false): at
  source `seg.end − tout / 2`, minus `peakAt`. `zoomTimings` already merges connected zooms, so a pan
  never gets a whoosh for a move that does not happen. Auto zooms are regenerated wholesale, which is
  why zoom sounds are a project rule and not a field on each zoom.
- **Title cards**, **texts and shapes**: at the video time of the item's start, plus half its enter
  motion (`enter.duration`, or its old fade: 0.35 s titles, 0.15 s texts and shapes), minus
  `peakAt`. The item's own `sound` wins over the rule; `'none'` silences it. Privacy shapes never
  sound.
- **Captions Studio's pop-ups** with an `SfxRef` sound: at `popJob`'s time (when the graphic starts
  to show), minus `peakAt`. `popJob` keeps `'pop'` and `'ding'` and skips `SfxRef`s, so old projects'
  pops are unchanged (§10.7).
- An item whose start lies in a cut never sounds (`shownFrom`, as `popJob`). Times below 0 become 0.
  Times of one effect closer than 0.05 s merge into the first. Each effect has at most 500 times
  (`MAX_POP_TIMES`), at most 16 effects per job.
- Gain per effect: `soundFx.volume ?? 0.35`.

### 10.7 Captions Studio item 12: sound on pops

`Graphic.sound` takes an `SfxRef` besides `'pop'` and `'ding'` (§4.1). The Graphics tab's Sound
select and *Make my captions great*'s sound option (`great.ts:40`, `:107`; `graphicRules.ts:35`)
list the library effects after *Classic pop* and *Classic ding*. `readGreatOptions` accepts an
`SfxRef` of the catalogue and reads anything else as `'none'`. A pop-up made by *Make my captions
great* is already a Review row (phase B's `graphic` kind); its title names the sound.

### 10.8 Export job and main (`src/main/exportJob.ts`, `src/shared/render/audioPlan.ts`)

- `ExportJob.effects?: { id, times, gain }[]`; `validEffects`: an array of at most 16, each `id` a
  catalogue effect and each once, `times` at most 500 finite numbers in 0..1e7, `gain` in 0..2.
  `MusicSound.bed?`: a catalogue bed id.
- `resolveSoundInputs` (`:271`) maps each effect id to its file by the catalogue: the bundled folder
  (`process.resourcesPath/sound-library/`, or `resources/sound-library/` unpackaged). The renderer
  never sends a path. A bed id is checked against the project's music file (§10.4).
- `planSoundtrack` (`audioPlan.ts:438`) adds one `-i <file>` per effect in the job and builds its
  track with `clickTrackGraph` (`:268`): mono, each sound on its exact sample, cut short where the
  next sound of the same effect starts. It mixes into `soundtrackGraph` (`amix normalize=0`) like
  the pops.
- A job without `effects` and `bed` builds today's graph character for character.

### 10.9 Preview (`src/renderer/src/editor/previewAudio.ts`)

- Effects are decoded once from `studio-media://sounds/<file>` (a new host of the media protocol
  that serves only catalogue file names, from the bundled folder or `userData/sound-library/`) and
  scheduled from `sfxJob` by `effectsStep` (`:863`) `EFFECTS_AHEAD` (0.25 s) ahead, like pops.
- A voice of a library effect stops (`stop(when)`) where the next sound of the same effect starts,
  as the export's click track cuts it. Today's synthesised pops keep their behaviour.
- `needsAudioGraph` (`settings.ts`) is true with library effects or a bed.

### 10.10 Credits

The Audio tab shows "Music: <title> by <artist> (CC0)" for a library bed. `musicCredit(project)`
(`soundLibrary.ts`) returns that line, and the publishing pack's YouTube description (`composeYoutubeDescription`, `src/shared/publish/youtube.ts:77`) offers it as a last line
(*Add the music credit*, on by default when a bed is used). It is the best answer to a false
Content ID claim (§0 decision 4).

---

## 11. Automatic changes, Polish and Review mode

**What is automatic.** Only two things in this wave change a project without the user choosing the
exact result: Polish's *Smooth cuts* step and *Auto colour*. Each writes a record of what was there
before, and Review mode lists it with Keep and Remove. Everything else (Smooth all cuts, a cut's
style, magnifiers, callouts, the chapter bar, looks, sliders, LUTs, music, effect rules) is a choice
the user makes and sees, and is not listed. Pop-ups that *Make my captions great* makes with a library
sound are already listed by phase B's `graphic` rows.

**Polish** (`src/shared/editor/polish.ts`):

- `PolishStep` gains `'smoothCuts'`, after `'silences'` in `POLISH_STEPS`, so cuts that Remove
  silences makes are smoothed too. `PolishOptions.smoothCuts: boolean`; `DEFAULT_POLISH_OPTIONS`
  has `true` (§0 decision 3); `readPolishOptions` reads a missing value as `false`.
- `PolishSkip` gains `'no-cuts'` ("No cuts to smooth") and `'kept-style'` ("Your cut style is
  kept": `joins.all` is set and is not a hard cut).
- The step sets `joins.all = { kind: 'soft', duration: 0.15 }` and
  `joins.auto = { by: 'polish', was: <joins.all before, or null> }`, inside Polish's one update.
  `STEP_LABEL.smoothCuts` "Smooth cuts"; summary line "Soft cuts at 37 cuts". Per-cut styles are
  kept.

**Review mode** (`src/shared/review/editingReview.ts`, hooked into `review.ts` the way
`captionReview.ts` is in phase B):

| Key | Kind (chip) | Title | Detail | Keep | Remove |
|---|---|---|---|---|---|
| `join:all` | `join` (*Cuts*) | "Soft cuts at every cut (37)" (the count now) | "Polish" | drops `joins.auto` | `joins.all = was` (deleted when null), drops `joins.auto`; an empty `joins` is deleted |
| `colour:camera` | `colour` (*Colour*) | "Camera colour balanced" | "Auto colour" | drops `grade.auto` | `grade.camera = was` (deleted when null), drops `grade.auto`; an empty `grade` is deleted |

- Time: `join:all` at the first cut's B start; `colour:camera` at the first clip's start. Listed
  after Captions Studio's kinds at equal times.
- Status: pending while the `auto` record exists; after that, kept when the field still equals what
  the automation set, removed otherwise (the pattern of `FRAMING_KEY`, `review.ts:33`).
- `KIND_WORDS` (`copy.ts`): `join: { chip: 'Cuts', name: 'cut style', all: 'Remove all cut
  styles', one: 'cut style', plural: 'cut styles' }`; `colour: { chip: 'Colour', name: 'colour',
  all: 'Remove all colour changes', one: 'colour change', plural: 'colour changes' }`.
- Each Keep or Remove is one store update, so one undo step; *Keep all* and *Remove all* include them.
- Editing the field by hand (choosing another cut style, moving a colour slider) is a decision:
  the record is dropped in the same update (`settleJoins`, `settleGrade`), as an edit by hand keeps an
  automatic zoom.

**Settle** (the chain at `Editor.tsx:198`): `settleJoins(next, prev)` drops `joins.cuts` entries
whose clip no longer exists or no longer follows a cut (after a restore, a trim, a Review Remove of a
silence cut), and the `auto` record when `all` was changed by hand. `settleGrade(next, prev)` drops
`grade.auto` when the camera grade was changed by hand. Both return `next` itself when nothing
applies, so old projects pass through untouched.

---

## 12. Accessibility

Every control is a native element or has the matching ARIA role, a visible label, and a value text
where it is a slider. New CSS uses the tokens of `src/renderer/src/styles.css` and joins
`tests/labelContrast.test.ts`.

| Control | Role and name | Keys | Value text / announcement |
|---|---|---|---|
| Every cut, Cut style | `select`; `radiogroup` "Cut style" | arrows | — |
| Length | slider "Length" | arrows 0.01 s, Page Up/Down 0.1 s | "0.15 seconds" |
| Dip colour | `radiogroup` of swatches, each named ("Black", "White", "Brand colour 1, #0060df") | arrows | — |
| Slide from | `radiogroup` "Comes in from" | arrows | — |
| Smooth all cuts | button | Enter, Space | live region: "Soft cuts at 37 cuts. Ctrl + Z to undo." |
| Cut block on the timeline | its name includes the style ("Cut, 1.6 s, soft") | *Go to next cut* selects it and focuses Cut style | — |
| Magnifier zoom | slider "Zoom" | arrows 0.25, Page 1 | "2.5 times" |
| Dim the rest | slider | arrows 5 % | "20 percent" |
| Appear, Disappear, Sound | `select` | arrows | — |
| Play an effect | toggle button `aria-pressed` "Play Whoosh" | Space | — |
| Badge number | `radiogroup`; text field `maxlength=3` | — | — |
| Count with | `radiogroup`; the Bangla choice's sample has `lang="bn"` | arrows | "Bangla digits, ১ ২ ৩" |
| Bubble tail (preview) | focusable handle "Tail points to 52 %, 40 %" | arrows 1 %, Shift 10 % | live: new position |
| Chapter bar | `switch`; `radiogroup`s | Space, arrows | — |
| Looks | `radiogroup` of chips with text labels; thumbnails `alt=""` | arrows | — |
| Colour sliders | slider per control | arrows 1, Page 10, Home resets to 0 | "Warmer, +20"; "Cooler, −15"; "No change" at 0 |
| Compare | toggle button `aria-pressed` | Space | — |
| Import a LUT, Auto colour, Reset colour | buttons | Enter | live: notice text |
| Music library | `list`; per row: title, artist, mood (text chip), length ("1 minute 43 seconds" for screen readers) | Tab through rows | — |
| Play preview | toggle `aria-pressed` "Play preview of Sweet Sun" | Space; Esc stops while focus is in the list | live: "Playing preview: Sweet Sun, 1 minute 43 seconds" / "Stopped" |
| Use / Download | buttons "Use Sweet Sun", "Download Drifting Piano, 1.0 megabytes" | Enter | after Use, the button reads "In use" (`aria-disabled`, still focusable); a download has a `progressbar` with value text |
| Mood filter | `radiogroup` of chips | arrows | — |

Never colour alone: cut marks have shapes, looks have names, moods are words. The Compare and hover
previews are preview-only. Windows' animation setting affects only the editor's UI (thumbnails stay
still, previews never play by themselves); the video's motion is the project's Calm motion choice
(§7.5).

---

## 13. Bangla and other scripts

- **Step badges** count in native digits (`withDigits`, the caption language's): ১ ২ ৩ … ১০. Own
  text up to 3 characters in any script.
- **Speech bubbles** wrap by words and, without spaces, between graphemes (`Intl.Segmenter`), never
  inside a cluster: a conjunct or a vowel sign stays with its letter. Line height 1.4 with Bengali,
  Devanagari or Thai. Right-to-left text is drawn right-to-left. The font stack ends in the bundled
  script fonts (§7.6), loaded before the export.
- **Typewriter and Wipe** on texts reveal whole graphemes, from the reading start.
- **Chapter bar names**: the title cards' stack with the bundled script fonts; shortened by
  graphemes; right-to-left names drawn right-to-left. The bar itself fills left to right in every
  language in this wave (§20).
- **LUT titles** are plain text with bidi controls removed, shown with `dir="auto"`. **Music titles**
  are Latin (with accents: "Champ de tournesol"); moods are UI words for X-05 to translate.
- **Search** (`src/shared/search/extract.ts:82-100`): a bubble's text is an annotation's text and is
  indexed as today; an automatic badge has no text. The index stays at version 5.

---

## 14. Security

1. **LUT files are untrusted.** Main checks the size (16 MiB) before reading, parses strictly (§9.5:
   linear time, at most 65³ entries plus a 65,536-entry shaper, no `eval`, no regular expression
   that can backtrack badly), and copies only a file that parsed. The title is sanitised. The
   renderer re-checks the SHA-256 and parses again before uploading; the texture is at most 4.4 MiB.
2. **Audio files.** The user's own music is checked as today (`looksLikeAudio`, 500 MB). Library
   files: the media protocol's `sounds` host serves only names of `soundFileRe()` (built from the
   catalogue, no path parts) from the bundled folder or `userData/sound-library/`. Bundled files are
   hash-checked by a unit test and by `verify-dist`; downloaded files on download, and again by main
   before a bed is copied into a project (a changed file is deleted and offered again for download).
3. **Pinned downloads** (§10.3): one exact prefix for the chosen source, https on port 443, no
   credentials, query or fragment, every redirect re-checked (for GitHub release assets, the asset
   CDN host only for redirects from the allowed prefix), never more than the pinned bytes, SHA-256
   checked, `.part` renamed after the check, free space checked first, `Retry-After` honoured up to
   60 s.
4. **Paths.** The renderer sends ids (effects, beds) and project file names (`lut-<n>.cube`,
   `music-<n>.<ext>`, checked against `LUT_FILE_RE` and `MUSIC_FILE_RE`), never paths. Main resolves
   them inside the project folder or the library folders and checks the result stays inside
   (`within`, as `projectCopy.ts` does).
5. **IPC.** New channels `soundLibrary:list`, `soundLibrary:download`, `soundLibrary:cancel`,
   `soundLibrary:remove`, `soundLibrary:useBed`, and the existing `pickAsset` with kind `'lut'`. Each
   checks the sender with `fromApp(e)` (`src/main/assetsIpc.ts:16`) and validates every argument
   (ids against the catalogue, the project id's format).
6. **Export job.** `validEffects` and the bed check run in main (§10.8); the job carries no paths.
7. **Decoding users' music** into `.cache/` (§10.4) runs the bundled ffmpeg with an argument list
   (no shell) on a file name main built.
8. **CSP and windows**: unchanged. `media-src` and `connect-src` already allow `studio-media:`
   (`index.html:8`); downloads run in main, so the renderer gets no new origin.
9. **WebGL**: the shader sources are constants with no user text; context loss falls back to the
   CPU path.

---

## 15. Performance budget

Reference rig: Electron 44.9.3, Chromium CPU raster, 4-core Xeon, no GPU (as Captions Studio §9.8).
Today's default frame costs 8.8 ms at 1080p and 21.9 ms at 4K; a moving 2× zoom with motion blur and
the export's 10 sub-frames 20.3 / 104.2 ms; a zoom moving in 45.2 / 167.2 ms. Added per frame:

| Feature | 1080p measured | 1080p budget | 4K measured | 4K budget | When |
|---|---|---|---|---|---|
| Soft or Slide (A\* over B) | +1.05 ms | 2 ms | +23 ms | 25 ms | inside a window only |
| Composing A\* | about 8.8 ms | 12 ms | about 21.9 ms | 30 ms | once per cut |
| Dip | +0.5 ms | 1 ms | +3 ms | 4 ms | inside a window only |
| Punch-in | not measured (a transform) | 1 ms | — | 6 ms | the punched clip |
| Magnifier | +1.9 ms | 3 ms | +9 ms | 12 ms | while shown, plus privacy and cursor inside it |
| One animated callout | — | 0.3 ms | — | 1 ms | while moving |
| Chapter bar | — | 0.5 ms | — | 1.5 ms | always when on |
| Colour, WebGL2 | estimated 2–3 ms on an Intel UHD 620 (not measured: no GPU here) | 4 ms | estimated 8–12 ms | 14 ms | always when graded |
| Colour, CPU path | 41.9 ms | 45 ms | 90.1 ms | 95 ms | PCs without WebGL2 only |

- **Preview**: a 60 fps proxy gives 16.7 ms a frame. With a GPU, every row fits. Without WebGL2 the
  colour notice says the preview may stutter; the export is not affected.
- **Export on the rig**, worst case at 1080p: a moving zoom (45.2) + a soft cut (1.05) + a magnifier
  (1.9) + callouts and bar (1) + CPU colour (41.9) ≈ 91 ms a frame.
- **Memory**: one A\* at a time in the export (8 MB at 1080p, 33 MB at 4K), four in the preview at
  its size; two `FreezeStills` LRUs of 6; a LUT texture up to 4.4 MiB; a decoded bed up to 40 MB in
  the preview; `aloop` up to 30 MB in the export.
- **Per-frame lookups**: `joinAt` is a binary search on a memoised plan; `punchAt` a lookup in a
  memoised per-clip array; `sfxJob` runs once per export and once per change in the preview.
- **Measuring on Windows**: the export logs per-frame decode, draw and encode times
  (`exporter.ts:541-544`). The e2e test logs them for a graded project with soft cuts (§19.3).
  `tests/editingPerf.test.ts` holds the pure parts (joinPlan of 20,000 clips under 20 ms, joinAt
  under 2 µs, curve baking under 1 ms, parsing a 33³ cube under 40 ms).

---

## 16. Undo

One user action is one `store.update`:

- Smooth all cuts; Use hard cuts everywhere; Use for all cuts; a cut's style, length, colour or
  direction (a slider drag merges through the gesture key, `editStore.ts:9-18`).
- Add magnifier; any magnifier setting.
- A callout's motion, speed or sound; a style change; adding a badge or a bubble; dragging a tail.
- The chapter bar's switch and each of its settings.
- A look; a slider drag; Import a LUT (the file copy is not undoable, as music picks are not; the
  update that uses it is); Remove LUT; Reset colour; Auto colour.
- Use a bed (the copy first, then one update); a sound-effect rule; *Whoosh on zooms* (both rules in
  one update); the effects volume.
- Polish (with its Smooth cuts step) stays one undo step. Keep and Remove in Review are one each.
- A download is not an edit and has no undo.

---

## 17. Files, exported signatures and builder parts

### 17.0 Contracts step (first; frozen afterwards)

Made by the lead on `rev/wave10-design` after `rev/versions` and Captions Studio phase B (with its
review fixes) have merged, before any part starts. Changed later only with every part's agreement,
recorded here.

- **Types**: `src/shared/types.ts` (§4.1); `src/shared/api/export.ts` (`effects`, `bed`);
  `src/shared/api/soundLibrary.ts` (new: `SoundLibraryState { id: string; state: 'bundled' |
  'downloaded' | 'missing' | 'downloading'; bytes: number; progress?: number }`, the channel names,
  `SoundLibraryApi`) and `src/preload/soundLibrary.ts` (stub).
- **Readers, in full** (§4.2): `src/shared/engine/joinData.ts`, `src/shared/render/gradeData.ts`,
  `src/shared/render/chapterBarData.ts`, `src/shared/audio/soundFxData.ts`,
  `src/shared/render/calloutData.ts` (with `calloutOf(a: Annotation)`); `readShape`,
  `readSpotlight`, `readTitleCard`, the `Graphic.sound` reader; `migrateProject` (§4.3).
- **`src/shared/render/cubeLut.ts`, in full**: `CUBE_LIMITS`, `interface CubeLut { title: string;
  size: number; data: Float32Array; shaper: { size: number; data: Float32Array; min: number; max:
  number } | null; domainMin: [number, number, number]; domainMax: [number, number, number] }`,
  `class CubeError extends Error { readonly line: number }`, `function parseCube(bytes: Uint8Array):
  CubeLut`. It is a security boundary that main and the renderer share, so it is frozen with its
  tests (§19.1 test 5).
- **Data, final**: `src/shared/audio/soundLibrary.ts` (`MUSIC_BEDS`, `SOUND_EFFECTS`,
  `SOUND_LIBRARY_SOURCE` (null until §0 decision 1 is made), `soundBed(id)`, `soundEffect(id)`,
  `soundFileRe(): RegExp`, `musicCredit(project: Project): string | null`); `resources/sound-library/`
  (4 beds, 16 effects, `SOUNDS.md`) committed after `scripts/build-sound-library.mjs --check` passes;
  `resources/notices/37-sound-library.txt`; `src/shared/render/looks.ts` (`LOOKS`, §9.4).
- **Packaging**: the `extraResources` entry (`soundLibraryResource()` in `scripts/lib/packaging.cjs`)
  and `SOUND_LIBRARY_BUDGET`.
- **Guarded hooks with stubs** (each stub returns its input or does nothing, so a part merged before
  another never changes how anything draws or sounds):
  - `compositor.ts`: `drawFrame` split into `drawFramePicture` and `drawFrameOverlays`; the
    `FrameExtras` parameter; calls to `beginJoin`, `endJoin`, `punchAt` (P1), `drawMagnifierLayer`,
    `drawChapterBar` (P2), `gradeScreen` (P4).
  - `webcamLayer.ts`: `gradeCamera` (P4). `safeZones.ts`: `textAreaWithoutBar` and the band (P2).
  - `textOverlays.ts`, `shapesLayer.ts`, `titleCardLayer.ts`: a branch into `drawCallout`,
    `shapeCalloutPose`, `titleCalloutPose` (P3), taken only with the new fields.
  - `popSound.ts`: `popJob` skips `SfxRef` sounds (one line).
  - `exporter.ts`: `soundOf` sets `effects` from `sfxJob(project)` (P5; the stub returns `[]`, and
    an empty list is left out of the job) and `musicOf` sets `bed` from `music.library`.
  - `review.ts` and `copy.ts`: the kinds `join` and `colour`, `KIND_WORDS`, and the hooks into
    `editingReview.ts` (stubs returning no items).
  - `polish.ts`, `polishCopy.ts`, `PolishDialog.tsx`, `polishRunner.ts`: `'smoothCuts'` in
    `PolishStep` and `POLISH_STEPS`, its label and skip texts, and a runner entry that skips it as
    `'off'`, so every `Record<PolishStep, …>` compiles. P1 makes it run.
  - `commands.ts` and `shortcuts.ts`: the 11 command ids of §2.8 (titles, categories, keywords) after
    the versions branch's, each with `[]` in `DEFAULT_KEYMAP`. `Editor.tsx`: each command opens its
    tab until its part wires it; the settle chain gains `settleJoins` and `settleGrade` (stubs).
  - One mount line each for the new sections (stubs returning null): `ClipPanel.tsx` (`CutsSection`,
    `CutStyleSection`), `ShapesPanel.tsx` (`MagnifierSection`, `CalloutSection`), `TextPanel.tsx`
    (`CalloutSection`, `BadgeSection`, `BubbleSection`, `ChapterBarSection`), `EffectsPanel.tsx`
    (`ScreenColourSection`, `CalmMotionRow`), `CameraPanel.tsx` (`CameraColourSection`),
    `AudioPanel.tsx` (`MusicLibrarySection`, `SoundEffectsSection`), the Downloads settings
    (`MusicDownloadsSection`).
  - `versions.ts` `AREAS` and `namedFiles` (§4.6); `MEDIA_FILE_RE` (`lut-<n>.cube`) and the
    `sounds` host (stub: 404); `ASSET_SPECS.lut` with `checkCube` (calls `parseCube`).
- **Equivalence guard** (§19.2), written and passing against the code before the hooks go in, and
  passing again after.
- `tests/editingContracts.test.ts` (§19.1 tests 1–7).
- The `data-testid` list of §2 as a comment block at the top of `tests/e2e/editing-polish.e2e.cjs`.

### 17.1 Part P1 · Smooth cuts

| File | Exports or change |
|---|---|
| `src/shared/render/joins.ts` (new) | `const JOIN_DEFAULTS: Readonly<Record<'soft' \| 'dip' \| 'slide', { duration: number; min: number; max: number }>>`; `const PUNCH_SCALE: { default: 1.1; min: 1.05; max: 1.2 }`; `const FLASH_GAP = 1.0`; `interface CutRef { index: number; clip: string; edit: number; video: number }`; `function cutsOf(clips: readonly Clip[], plan: FreezePlan): readonly CutRef[]`; `function resolvedJoin(project: Pick<Project, 'clips' \| 'joins' \| 'effects'>, index: number): CutJoin \| null`; `interface JoinWindow { index: number; clip: string; kind: 'soft' \| 'dip' \| 'slide'; from: number; to: number; at: number; still: { screen: number; camera: number } \| null; color?: string; dir?: SlideFrom }`; `function joinPlan(project: Pick<Project, 'clips' \| 'joins' \| 'freezes' \| 'effects' \| 'webcamOffset'>): readonly JoinWindow[]`; `interface JoinAt { window: JoinWindow; p: number }`; `function joinAt(windows: readonly JoinWindow[], video: number): JoinAt \| null`; `function stillTimes(aStart: number, aEnd: number, webcamOffset: number): { screen: number; camera: number }`; `function punchAt(project: Pick<Project, 'clips' \| 'joins' \| 'effects'>, t: number): number`; `function joinPose(at: JoinAt, w: number, h: number): { live: { dx: number; dy: number }; still: { alpha: number; dx: number; dy: number } \| null; fill: { color: string; alpha: number } \| null }`; `function frameVideoTime(clips: Clip[], plan: FreezePlan, t: number, hold: { start: number; elapsed: number } \| null, leftHoldAt: number \| null): number`; `interface JoinFeed { screen: number[]; camera: number[]; frame: Int32Array; stills: { before: number; screen: number; camera: number; window: number }[] }`; `function joinFeed(pictures: readonly number[], times: readonly number[], windows: readonly JoinWindow[], fps: number, webcamOffset: number): JoinFeed` |
| `src/shared/editor/joinsEdit.ts` (new) | `function smoothAllCuts(project: Project): Project`; `function hardCutsEverywhere(project: Project): Project`; `function withJoinAll(project: Project, join: CutJoin \| null): Project`; `function withCutJoin(project: Project, clip: string, join: CutJoin \| null): Project` (null: same as every cut); `function useForAllCuts(project: Project): Project`; `function settleJoins(next: Project, prev: Project): Project`; `function cutCount(project: Project): number`; `function joinLabel(join: CutJoin \| null): string`; `function nextCutAfter(project: Project, t: number): { start: number; end: number } \| null` |
| `src/shared/review/joinReview.ts` (new), `editingReview.ts` | `function joinReviewItems(project: Project): ReviewItem[]`; `function joinItemStatus(project: Project, item: ReviewItem): ReviewStatus`; `function keepJoinItems(project: Project, items: readonly ReviewItem[]): Project`; `function removeJoinItems(project: Project, items: readonly ReviewItem[]): Project` |
| `src/renderer/src/render/joinLayer.ts` (new) | `function beginJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join'], punch: number): void`; `function endJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join']): void`; `function composeJoinStill(target: CanvasRenderingContext2D, w: number, h: number, window: JoinWindow, scene: RenderScene, stills: { screen: FrameImage; camera: FrameImage \| null }, background: HTMLImageElement \| null): HTMLCanvasElement` |
| `src/renderer/src/editor/joinStills.ts` (new) | `class JoinStills { constructor(screenUrl: string, webcamUrl: string \| null, onReady: () => void, segment?: (still: ImageBitmap) => Promise<void>); still(window: JoinWindow, w: number, h: number, compose: (s: { screen: FrameImage; camera: FrameImage \| null }) => HTMLCanvasElement): CanvasImageSource \| null; prepare(windows: readonly JoinWindow[]): void; dispose(): void }` |
| `compositor.ts` | The P1 hooks made real; nothing else. |
| `player.ts`, `ExportPreview.tsx` | Video time per frame (`frameVideoTime`), the join and its still, stills of the next three cuts. |
| `exporter.ts` | `joinPlan` in the plan; `joinFeed` for both sources; A\* composed before each window. |
| `src/renderer/src/editor/panels/CutsSection.tsx`, `CutStyleSection.tsx`, `cuts.css` (new) | `function CutsSection(props: { project: Project }): JSX.Element \| null`; `function CutStyleSection(props: { project: Project; gap: { start: number; end: number } }): JSX.Element \| null` |
| `Timeline.tsx` | `GapBlock`'s mark and accessible name (after the versions branch's `Filmstrip`). |
| `polish.ts`, `polishCopy.ts`, `PolishDialog.tsx`, `polishRunner.ts` | The Smooth cuts step made to run. |
| `Editor.tsx` | Handlers of *Smooth all cuts*, *Use hard cuts everywhere*, *Go to next cut*; `settleJoins`. |
| Tests | 8–24 (§19.1) |

### 17.2 Part P2 · Magnifier and chapter bar

| File | Exports or change |
|---|---|
| `src/shared/render/magnifier.ts` (new) | `const MAGNIFIER: { enter: 0.3; exit: 0.22; size: 0.3; zoom: 2.5; min: 1.5; max: 4; step: 0.25; ring: 0.004; shadowY: 0.006; shadowBlur: 0.02; shadowAlpha: 0.35; corner: 0.18 }`; `function isMagnifier(s: Spotlight): boolean`; `function magnifierPhase(s: Spotlight, t: number, clips: Clip[], calm: boolean): { r: number; z: number; alpha: number } \| null`; `function lensCamera(cam: Camera, centre: { x: number; y: number }, z: number): Camera`; `function lensBox(s: Spotlight, centre: { x: number; y: number }, rect: Rect, cam: Camera, r: number, toOut: (x: number, y: number) => { x: number; y: number }): { cx: number; cy: number; rx: number; ry: number }`; `function newMagnifier(project: Project, t: number, view: { rect: Rect; cam: Camera; w: number; h: number; centre: { x: number; y: number } }, mode: 'region' \| 'cursor'): { project: Project; id: string }` |
| `src/renderer/src/render/magnifierLayer.ts` (new) | `function drawMagnifierLayer(fc: FrameContext): void` |
| `src/shared/render/chapterBar.ts` (new) | `const CHAPTER_BAR: { inset: 0.03; thick: 0.008; edgeThick: 0.006; gap: 0.005; label: 0.03; labelGap: 0.01; grow: 1.5; growTime: 0.15; fade: 0.3; show: 3; cross: 0.2 }`; `interface BarSegment { from: number; to: number; title: string \| null; x0: number; x1: number }`; `interface BarLayout { edge: 'top' \| 'bottom'; x0: number; x1: number; y: number; th: number; gap: number; round: boolean; color: string; labels: ChapterBar['labels']; segments: BarSegment[] }`; `function chapterBarLayout(project: Project, w: number, h: number, area: Rect \| null): BarLayout \| null`; `function barBand(project: Project, w: number, h: number): { edge: 'top' \| 'bottom'; size: number } \| null`; `function barState(layout: BarLayout, video: number, project: Project): { alpha: number; current: number; grow: number; labelAlpha: number }` |
| `src/renderer/src/render/chapterBarLayer.ts` (new) | `function drawChapterBar(fc: FrameContext, video: number): void` |
| `src/shared/render/safeZones.ts` | `export function textAreaWithoutBar(project: Project, w: number, h: number, vw: number, vh: number, t: number): Rect \| null` (today's body); `textArea` subtracts `barBand` when the bar shows. |
| `src/renderer/src/editor/panels/MagnifierSection.tsx`, `ChapterBarSection.tsx`, `magnifier.css` (new) | `function MagnifierSection(props: { project: Project; selection: Selection }): JSX.Element`; `function ChapterBarSection(props: { project: Project }): JSX.Element` |
| `Editor.tsx` | Handlers of *Add magnifier*, *Add magnifier on the cursor*, *Chapter bar on the video*. |
| Tests | 25–35 |

### 17.3 Part P3 · Animated callouts

| File | Exports or change |
|---|---|
| `src/shared/render/callouts.ts` (new) | `type CalloutItem = 'text' \| 'badge' \| 'bubble' \| 'arrow' \| 'box' \| 'highlight' \| 'title'`; `const CALLOUT_KINDS: Readonly<Record<CalloutItem, { enter: readonly CalloutMotionKind[]; exit: readonly CalloutMotionKind[] }>>`; `const CALLOUT_DEFAULTS: Readonly<Record<CalloutItem, { enter: CalloutMotion; exit: CalloutMotion }>>`; `function calloutItemOf(kind: AnnotationStyle \| ShapeKind \| 'title'): CalloutItem \| null`; `interface CalloutPose extends ChunkPose { drawn: number }`; `function calloutPose(start: number, end: number, t: number, clips: Clip[], enter: CalloutMotion \| undefined, exit: CalloutMotion \| undefined, u: number, calm: boolean, oldFade: number): CalloutPose \| null`; `function badgeLabels(project: Project): ReadonlyMap<string, string>`; `function badgeTextColor(fill: string): '#ffffff' \| '#111111'`; `function badgeBox(label: string, px: number, measure: (text: string, px: number) => number): { w: number; h: number; px: number; radius: number }`; `function wrapCallout(text: string, maxWidth: number, measure: (s: string) => number): string[]`; `function bubbleTail(body: Rect, target: { x: number; y: number } \| null, f: number, radius: number): { base: [{ x: number; y: number }, { x: number; y: number }]; tip: { x: number; y: number } } \| null`; `function rectPerimeter(w: number, h: number): number`; `function ellipsePerimeter(a: number, b: number): number` |
| `src/shared/editor/calloutsEdit.ts` (new) | `function addBadge(project: Project, t: number): { project: Project; id: string }`; `function addBubble(project: Project, t: number): { project: Project; id: string }`; `function withCallout(project: Project, ref: { kind: 'annotation' \| 'shape' \| 'title'; id: string }, patch: { enter?: CalloutMotion \| null; exit?: CalloutMotion \| null; sound?: 'none' \| SfxRef \| null }): Project` |
| `src/shared/render/overlays.ts` | `annotationMetrics` covers badges and bubbles, so the preview's handle matches what is drawn. |
| `textOverlays.ts`, `shapesLayer.ts`, `titleCardLayer.ts`, `src/shared/render/titleCards.ts` | The P3 hooks made real (§7.2–7.4). |
| `src/renderer/src/render/bubblePath.ts` (new), `studioLayer.ts` | `export function bubblePath(c: CanvasRenderingContext2D, r: Rect, radius: number, tail: number, target: { x: number; y: number } \| null): void`, moved; `studioLayer.ts` imports it. |
| `src/renderer/src/editor/panels/CalloutSection.tsx`, `BadgeSection.tsx`, `BubbleSection.tsx`, `CalmMotionRow.tsx`, `callouts.css` (new) | each `(props: { project: Project; selection: Selection }) => JSX.Element \| null` (`CalmMotionRow`: `{ project }`) |
| `PreviewStage.tsx` | The bubble's tail handle (drag and arrow keys). |
| `src/shared/editor/duplicate.ts`, `groupEdit.ts` | `refitItems` moves `tail`; *Copy look* carries `enter`, `exit`, `sound`, `color`, `numbering`. |
| `Editor.tsx` | Handlers of *Add step badge*, *Add speech bubble*. |
| Tests | 36–45 |

### 17.4 Part P4 · Colour

| File | Exports or change |
|---|---|
| `src/shared/render/colorGrade.ts` (new) | `interface ResolvedGrade { temperature: number; tint: number; exposure: number; brightness: number; contrast: number; highlights: number; shadows: number; fade: number; saturation: number; vibrance: number; split: { kS: number; kH: number }; lutStrength: number }`; `function resolveGrade(g: ColorGrade \| undefined, which: 'screen' \| 'camera'): ResolvedGrade \| null` (null: identity); `function whiteBalanceGains(temperature: number, tint: number): [number, number, number]`; `function gradeTable(g: ResolvedGrade): Float32Array` (768 linear values); `function gradeKey(g: ResolvedGrade \| null, lut: CubeLut \| null): string`; `function lutSample(lut: CubeLut, r: number, g: number, b: number): [number, number, number]` (tetrahedral); `function gradePixel(rgb: readonly [number, number, number], g: ResolvedGrade, table: Float32Array, lut: CubeLut \| null): [number, number, number]` (the reference); `function gradePixelsCpu(data: Uint8ClampedArray, g: ResolvedGrade, table: Float32Array, lut: CubeLut \| null): void` |
| `src/renderer/src/render/gradeLayer.ts` (new) | `function gradeBackend(): 'gl' \| 'cpu'`; `function gradeScreen(target: CanvasRenderingContext2D, frame: FrameImage, grade: ColorGrade \| undefined, lut: CubeLut \| null): FrameImage`; `function gradeCamera(target: CanvasRenderingContext2D, frame: FrameImage, grade: ColorGrade \| undefined, lut: CubeLut \| null): FrameImage`; `function releaseGrade(target: CanvasRenderingContext2D): void`; `function forceGradeBackend(b: 'gl' \| 'cpu' \| null): void` (tests and e2e only) |
| `src/renderer/src/render/lutCache.ts` (new) | `function lutFor(project: Project, which: 'screen' \| 'camera'): CubeLut \| null`; `function lutProblem(project: Project, which: 'screen' \| 'camera'): string \| null`; `function onLutReady(cb: () => void): () => void` |
| `compositor.ts`, `webcamLayer.ts` | The P4 hooks made real; the blur composite's cache key. |
| `src/shared/editor/colourEdit.ts` (new) | `function withGrade(project: Project, which: 'screen' \| 'camera', patch: Partial<ColorGrade> \| null): Project`; `function withLook(project: Project, which: 'screen' \| 'camera', look: LookId \| null, strength?: number): Project`; `function withLut(project: Project, which: 'screen' \| 'camera', lut: ColorLut \| null): Project`; `function settleGrade(next: Project, prev: Project): Project` |
| `src/shared/editor/autoColour.ts` (new) | `interface ColourSample { pixels: Uint8ClampedArray; mask: Uint8ClampedArray \| null; w: number; h: number; face: Rect \| null }`; `function autoCameraGrade(samples: readonly ColourSample[]): ColorGrade \| null`; `function withAutoColour(project: Project, grade: ColorGrade): Project` |
| `src/renderer/src/editor/autoColourRun.ts` (new) | `async function runAutoColour(deps: { project: Project; webcamUrl: string; signal: AbortSignal }): Promise<ColorGrade \| null>` |
| `src/shared/review/colourReview.ts` (new), `editingReview.ts` | `colourReviewItems`, `colourItemStatus`, `keepColourItems`, `removeColourItems` (as P1's) |
| `src/main/lutImport.ts` (new), `src/main/assetIpc.ts` | `async function importLut(projectDir: string, source: string): Promise<{ file: string; sha256: string; title: string; size: number }>`; the `'lut'` kind's pick. |
| `src/renderer/src/editor/panels/ScreenColourSection.tsx`, `CameraColourSection.tsx`, `ColourControls.tsx`, `colour.css` (new) | `function ScreenColourSection(props: { project: Project }): JSX.Element`; `function CameraColourSection(props: { project: Project }): JSX.Element \| null`; `function ColourControls(props: { project: Project; which: 'screen' \| 'camera' }): JSX.Element` |
| `Editor.tsx`, `player.ts` | *Compare with original colour* (a preview-only flag on the player's scene), *Auto colour for the camera*; `settleGrade`. |
| Tests | 46–58 |

### 17.5 Part P5 · Music and sound effects

| File | Exports or change |
|---|---|
| `src/shared/audio/soundLibrary.ts` | Adds `function bedTime(bed: MusicBed, out: number): number`; `function bedLoop(bed: MusicBed): { start: number; end: number }` (samples at 48 kHz). |
| `src/shared/render/sfxJob.ts` (new) | `const SFX_VOLUME = 0.35`; `const MAX_SFX = 16`; `function sfxJob(project: Project): { id: string; times: number[]; gain: number }[]` |
| `src/shared/render/audioPlan.ts` | `function bedGraph(m: MusicPart, loop: { start: number; end: number }, duration: number, out?: string): string`; `planSoundtrack` adds effect inputs and the bed graph. |
| `src/main/exportJob.ts` | `validEffects`, the bed check, `resolveSoundInputs` for effects, beds and the loop cache. |
| `src/main/soundLibrary/paths.ts`, `store.ts`, `ipc.ts` (new) | `function bundledSoundDir(): string`; `function soundPath(file: string): string \| null`; `function allowSoundUrl(url: URL, testBase?: string \| null): boolean`; `async function listLibrary(): Promise<SoundLibraryState[]>`; `async function downloadBed(id: string, opts: { signal: AbortSignal; onProgress(p: number): void }): Promise<SoundLibraryState>`; `async function removeDownloadedBeds(): Promise<void>`; `async function useBed(projectDir: string, id: string): Promise<{ file: string }>`; `function registerSoundLibraryIpc(): void` (sender checks) |
| `src/main/musicLoopCache.ts` (new) | `async function loopableMusic(projectDir: string, file: string, ffmpeg: string): Promise<string>` (§0 decision 2) |
| `src/main/mediaProtocol.ts`, `src/preload/soundLibrary.ts` | The `sounds` host; the preload API. |
| `src/renderer/src/editor/previewAudio.ts`, `src/shared/audio/settings.ts` | The bed's buffer loop, library effects, the stop rule; `needsAudioGraph`; `audioLook` reads `library`. |
| `src/renderer/src/editor/panels/MusicLibrarySection.tsx`, `SoundEffectsSection.tsx`, `soundLibrary.css`, `src/renderer/src/settings/MusicDownloadsSection.tsx` (new) | `function MusicLibrarySection(props: { project: Project }): JSX.Element`; `function SoundEffectsSection(props: { project: Project }): JSX.Element`; `function MusicDownloadsSection(): JSX.Element` |
| `GraphicsPanel.tsx`, `src/shared/captions/great.ts`, `graphicRules.ts` | Library sounds in the Sound select and in *Make my captions great*. |
| `src/shared/publish/youtube.ts` | The music credit line. |
| `scripts/verify-dist.mjs` | Every sound file's hash in the built app. |
| Tests | 59–73 |

### 17.6 Not touched, and merging

**Not touched by any part**: the recording side (listed at the top), `Home.tsx`,
`src/main/security.ts`, the CSP, the window options, `appSettings.ts`, `cutFades.ts` and the
preview's cut fades, `exportFrameTimes`, `videoFrames`, `outputDuration` (no length changes),
`frameView.ts` (frozen), `itemPose` and `motion.ts` (reused, not changed), the legacy caption code.

**Ownership of shared files**: the hook lines in `compositor.ts`, `webcamLayer.ts`,
`textOverlays.ts`, `shapesLayer.ts`, `titleCardLayer.ts`, `safeZones.ts`, `review.ts` and the
panels' mount lines are the contracts'; each part fills in the bodies of its own hooks, which live in
its own new files. `Editor.tsx` gets one handler block per part, in separate places of the command
map. `exporter.ts` is P1's; P5 adds no line there, because the contracts put two one-line hooks into
`soundOf` and `musicOf` (`effects: sfxJob(project)` and `bed: project.audio.music?.library?.id`,
with `sfxJob` a stub returning `[]` until P5). `Timeline.tsx` is P1's. `previewAudio.ts` is P5's.

**Merge order**: P4, P1, P2, P3, P5 (colour first, because A\* and the magnifier draw from the graded
frame and their tests then run on real grading). Then both typechecks, all of vitest, `npm run
build`, `node scripts/build-sound-library.mjs --check`, and under `xvfb-run`: `editing-polish`,
`render`, `export`, `export-pack`, `freeze`, `edit-by-text`, `review-mode`, `polish`,
`one-click-polish`, `captions-studio`, `titles`, `shapes`, `camera`, `tilt`, `vertical-video`,
`multi-select`, `brand-kit`, `style-pack`, `audio-pack`, `audit-audio-export`, `clean-voice`,
`sound-finder`, `versions`, `commands`, `ui`, `search`, `bangla-captions`, `publish-pack`,
`packaging`.

---

## 18. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Old projects change through shared code (`drawFrame`'s split, `textArea`, the readers, `migrateProject`, `popJob`, `planSoundtrack`). | Every new step is behind a guard that returns at once without its field; the equivalence guard is written before the contracts and never regenerated (§19.2); audio graph strings are compared character for character. |
| 2 | A Soft cut shows a frame the user cut out. | A\* is A's last *kept* frame (§5.3) and is drawn with every privacy shape active at it; nothing inside a cut is decoded for drawing; e2e step E5 checks a secret inside a cut never appears. |
| 3 | The export's decoder is fed a time that goes backwards (it throws "The video decoder skipped a frame", `frameSource.ts:173`). | A\* and its camera frame are defined as the last proxy frames before A's end, so they never precede A's output frames by frame; a property test over 200 random edits at eight frame rates (test 12). |
| 4 | The preview's still is late and the cut looks hard. | Stills of the next three cuts are made ahead; until ready a hard cut is drawn, exactly as the continue-freeze preview does; the export is not affected. |
| 5 | The camera's blurred room flashes in A\*. | A\*'s camera frame gets its person mask before composing, in preview and export alike (§5.6). |
| 6 | Flashing dips. | The flash rule (§5.2): a dip within 1 s of another draws as Soft. |
| 7 | The magnifier reveals a blurred secret. | Privacy shapes are drawn again inside the lens through the lens camera (§6.4); test 29 and e2e E6. |
| 8 | Colour differs between preview and export, or between GPU and CPU PCs. | One backend per session for both; the input is always a 2D-canvas copy; the shader matches the JS reference within one level (measured: at most 10 of 786,432 values); a self-test chooses the CPU path when it does not. |
| 9 | The CPU colour path is slow (41.9 ms at 1080p). | Only on PCs without WebGL2; a notice says so; table-only grades take one lookup per channel; the export is correct, only slower. |
| 10 | GPU cost of colour on real laptops is not measured. | Estimated 2–3 ms at 1080p; measured on the reference Windows PC after the build (§0 decision 6), with the export's per-frame log. |
| 11 | A malicious `.cube` file. | Strict linear parser with caps, rejected before copying, re-checked by hash and parsed again before use (§9.5, §14). |
| 12 | Music loop points sound wrong, or a bed has vocals. | The listening pass before release (§0 decision 5); a bed can be dropped by removing its catalogue row (ids never reused). |
| 13 | CC0 music gets a false Content ID claim. | The credit line in the app and in the YouTube description (§10.10). |
| 14 | The download source for the 8 beds does not exist at release. | Those rows are hidden until `SOUND_LIBRARY_SOURCE` is set; the 4 bundled beds work alone. |
| 15 | Preview and export sound differ for library sounds (Opus decoding, overlapping voices). | Same files decoded by both; voices cut where the next one starts, as the export does; an acceptance test renders through `OfflineAudioContext` and through ffmpeg (test 69). If Chromium's Opus pre-skip handling differs, main serves a WAV decoded by its own ffmpeg (`userData/sound-cache/<sha256>.wav`) to the preview. |
| 16 | The loop fix (§0 decision 2) changes old exports' sound. | Only users' looping Opus, M4A and AAC music, only by removing the glitch; owner decision; project files unchanged. |
| 17 | Merge conflicts with the versions branch and phase B (`commands.ts`, `shortcuts.ts`, `Editor.tsx`, `Timeline.tsx`, `review.ts`, `copy.ts`, `PolishDialog.tsx`, `exporter.ts`, `previewAudio.ts`, `great.ts`, `GraphicsPanel.tsx`). | The contracts step comes after both merge; every shared file has one owner (§17.6); new UI lives in new files mounted with one line each. |
| 18 | Many cuts (edit-by-text makes thousands of clips). | `joinPlan` is built once per change (20,000 clips under 20 ms), `joinAt` is a binary search, and windows are clamped to half a clip; tiny clips get a hard cut. |
| 19 | Callout motion feels busy on tutorials. | Old items keep today's fades; defaults are short (0.18–0.45 s), exits shorter than entrances; Calm motion; no "during" loops in this wave. |
| 20 | Badges and bubbles look different across PCs (fonts). | They use the bundled script fonts, loaded before the export (§7.6). |
| 21 | The chapter bar overlaps captions. | `textArea` shrinks by the bar's band, so every text placed in it keeps clear (§8). |
| 22 | E2E pixels under Xvfb vary by a level or two. | Colour classes and mixes are checked within tolerances, never exact values, except where the guard compares a build with itself. |

---

## 19. Test plan

### 19.1 Unit tests (vitest). Each fails without the code of its rule.

**Contracts and the guard** (§17.0)

1. **Migration**: the fixtures of `tests/fixtures/vertical-old-projects.json` and
   `tests/fixtures/wave8-old-projects.json`, a Captions Studio project and a project with every
   wave-8 field migrate to byte-equal JSON; no new key appears; each new reader returns undefined
   for absent input and is idempotent (`read(read(x)) = read(x)`).
2. `readJoins` and `readCutJoin`: an unknown kind is dropped; a repeated clip keeps the first;
   durations clamp to the kind's range; a colour is lower-cased; fields of another kind are dropped;
   an empty object reads undefined; 20,001 entries read as 20,000; `auto` with a bad `was` is dropped.
3. `readColorGrade` and `readProjectGrade`: clamps; non-finite values dropped; 0 kept as written; an
   unknown look dropped; `lut` dropped for a bad file name, hash, size or a non-string title; a title
   with U+202E and a NUL comes back without them and cut to 80; `exposure` dropped on the screen.
4. `readChapterBar`, `readSoundFx`, `readSfxRef`, `readCalloutMotion` (`'blur'` rejected for every
   item; `'draw'` only on enter and only for arrows, lines, boxes; `'wipe'` only on enter), `readShape`
   (motions dropped on blur and pixelate), `readSpotlight` (`magnify` clamped, NaN dropped),
   `readTitleCard`, `Graphic.sound` (`'sfx:nope'` dropped).
5. **`parseCube`**: accepts sizes 2, 17, 33 and 65, a Resolve shaper plus 3D file, `DOMAIN_*` and
   `*_INPUT_RANGE`, CRLF, a BOM, tabs and comments; rejects a NUL byte, size 66, a 1D size of 65,537,
   `NaN`, `1e999`, `17.5` (> 16), `0x1F`, a short file, an extra line, a keyword after the data,
   `LUT_2D_SIZE`, an unknown keyword, a 1,025-character line, invalid UTF-8 and 16 MiB + 1 byte; the
   error names the line; a 65³ file parses in under 150 ms.
6. **Catalogue**: ids are unique; every bundled file exists with its pinned bytes and SHA-256;
   `build-sound-library.mjs --check` passes; download rows have no file in `resources/`; the bundled
   total fits `SOUND_LIBRARY_BUDGET`; every licence is `'CC0-1.0'`; `SOUNDS.md` and
   `37-sound-library.txt` list every file.
7. **Contracts**: each stub is an identity (a frame drawn with and without the hooks has the same call
   log); `settleJoins` and `settleGrade` return `next` itself for old projects; `editingReview`
   lists nothing for old projects; the Smooth cuts step compiles and skips as `'off'`; the 11
   commands exist with `[]` keys and no key conflicts (`commands.test.ts`).

**P1 · Smooth cuts**

8. `cutsOf`: trims are not cuts; touching clips with two speeds are not cuts; a gap of 1e-6 s is
   not and 2e-6 s is; T includes the holds before it; a hold at B's start makes T the hold's start.
9. `resolvedJoin`: an override beats `all`; an override of kind `'cut'` gives none; Soft clamps to
   `len(B) / 2`; a 0.1 s clip with Soft 0.15 gets 0.05 s, under 2/30, so a hard cut; a Dip's half is
   bounded by both clips; Calm motion turns Slide into Soft.
10. **Flash rule**: dips with T at 0.5, 1.2, 1.9 and 3.5 s draw as dip, soft, dip, dip.
11. **Windows**: for 1,000 random edits with freezes the windows never overlap; `joinAt` equals a
    linear scan; p is 0 at the start and below 1 at the end.
12. **Still times and the feed**: `stillTimes` gives the start of the 60 fps frame that holds
    `A.end − ε` and of the 30 fps camera frame that holds `A.end − offset − ε`; for 200 random edits
    with freezes and offsets, at 10, 15, 24, 25, 30, 50, 60 and 120 fps, both feeds of `joinFeed`
    never go back a proxy frame; a window with no output frame adds no still; `frame` maps every
    output frame.
13. `frameVideoTime`: inside a hold, `start + elapsed`; the first frame after a hold at T reads
    `T + length`; without holds it equals `editToVideo`.
14. `punchAt`: joins punch, punch, soft, punch give scales 1.1, 1, 1, 1.1; a speed split keeps the
    state; the join's `scale` is used; a hold shows its held frame's clip's scale.
15. `joinPose`: Soft α = 1 − p; for the four Slide directions the two pictures are exactly one frame
    apart and cover it; a Dip's α is 0 at its ends and 1 at its middle.
16. `joinsEdit`: `smoothAllCuts` is one project out with `all` Soft 0.15 and overrides kept;
    `useForAllCuts` clears overrides; `withCutJoin(…, null)` removes one; `settleJoins` drops an
    override whose clip was merged by `restoreRange` or no longer follows a cut, keeps the rest,
    drops `auto` when `all` changed by hand, and returns `next` itself when nothing applies.
17. **Why not on `Clip`**: `splitAt` inside B keeps B's override on the cut before B only;
    `cutRange` inside B makes a new cut with the default style.
18. **Drawing** (recording fake context, as `verticalEquivalence.test.ts`): Soft draws A\* after the
    picture at α = 1 − p and before the overlays; captions, texts and titles are drawn once; Slide's
    transforms; the Dip's fill; Punch-in's transform about the centre; a null still draws a hard cut.
19. `composeJoinStill`: draws the picture only (no captions, texts, title cards, graphics, bar or
    watermark), with `blurSamples` 1, at `pictureTime(a*)`; the export path prepares the camera
    still's mask first.
20. `joinReview`: Polish's record makes one row with the cut count; Keep drops `auto`; Remove puts
    `was` back and deletes an empty `joins`; statuses after each; Keep all and Remove all include it;
    each is one project out.
21. **Polish**: the step runs after Remove silences and smooths the cuts it made; skips with
    `'no-cuts'` and `'kept-style'`; saved options without `smoothCuts` read false; the default is
    true; the whole Polish is still one undo step.
22. The cut block's mark and accessible name for each style (`timelineCuts.test.ts`).
23. `CutsSection` and `CutStyleSection` (testing-library): the radio group; the Length value text
    "0.15 seconds"; the flash-rule note; *Smooth all cuts* disabled when every cut is soft; no Cut
    style for a trimmed start.
24. **Player** (fakes): video time through a hold; stills asked for the next three cuts at play; a
    window whose still is not ready draws a hard cut and redraws on `onReady`.

**P2 · Magnifier and chapter bar**

25. `magnifierPhase`: g = 0 at the start and the end, 1 in between; r and z from g; `dIn` and
    `dOut` at most half the item; Calm motion changes only α; a cursor magnifier is multiplied by the
    cursor's presence.
26. `lensCamera`: for 1,000 random cameras, centres and zooms, the centre maps to the same output
    point under both cameras (within 1e-9) and the scale is `cam.scale · z`.
27. `newMagnifier`: 0.30 S across in the view at the playhead with and without a zoom; 2.5×; 3 s;
    dim 0; one project out.
28. `drawMagnifierLayer` (fake context): nothing without `magnify`; inside the lens clip, the screen
    through the lens camera, then the privacy and cursor layers through it; the ring and hairline; in
    `drawFrame` it comes after the cursor and before the shapes.
29. **Privacy in the lens**: a blur shape under a lens is drawn again inside the clip, at the box
    `toOutput(rect, lensCam)` gives, which covers the magnified secret.
30. A magnifier is selected, moved, copied, nudged and snapped as a spotlight (the multi-select,
    clipboard and snapping tests gain one magnifier each); it survives a load and save.
31. `chapterBarLayout`: segments from `outputChapters` with the intro segment; holds included; one
    segment with fewer than two chapters; the gap and the minimum width; Floating and Edge at
    1920 × 1080 and 1080 × 1920 with app-safe zones (inside `COMMON_SAFE`; Edge drawn as Floating).
32. `barState`: the fill is linear in video time and moves through a hold; the current segment grows
    over 0.15 s; fades; *Hide between chapters* shows 3 s; names hidden while an automatic chapter
    title card shows.
33. **Room for the bar**: `textArea` shrinks by the band with and without names; a Studio caption
    block and a legacy caption sit above the bar; without the bar `textArea` returns today's values
    for every fixture.
34. Names: *Current* clamped inside the bar; *All* shortened by graphemes with a Bangla name
    ("অধ্যায় তিন" never cut inside a conjunct); fewer than three graphemes hidden.
35. `MagnifierSection` and `ChapterBarSection`: value texts, radio groups, one update per change.

**P3 · Animated callouts**

36. `calloutPose`: equals `itemPose` for every `ItemMotion` kind; Draw gives `1 − (1 − p)³`; Wipe
    gives `emphDecel`; each side at most half the item; a missing exit fades over the old length;
    Calm clamps; durations in viewing time on a 2× clip.
37. Texts, shapes and title cards without the new fields have today's call logs (part of §19.2).
38. **Draw-on**: an arrow's shaft length and its head from `drawn = 0.8`; a rectangle's dash
    `[L · drawn, L]` with `L = 2(w + h)`; an ellipse's perimeter by Ramanujan (within 0.01 % of a
    numeric integral); a filled box's reveal; a highlight's wipe width.
39. A blur shape with `enter` in the file reads without it and covers fully from its first frame.
40. **Badges**: numbering by start, ties by id; moving a badge renumbers; A–Z then AA; Bangla gives
    ১…১০; a language without its own digits gives Western; `badgeTextColor('#0060df')` is white
    (5.61:1) and `('#ffd60a')` is #111111; the boxes for 1, 2 and 3 glyphs.
41. **Bubbles**: `wrapCallout` by words; "ক্ষমতা" never split inside "ক্ষ"; Chinese wraps between
    graphemes; the tail sits on the nearest edge, is left out inside or near the body, and its base
    clamps; Arabic text is right-to-left.
42. `annotationMetrics` for badges and bubbles equals the drawn boxes (the preview's handle).
43. **Title cards**: the background keeps `titlePhase`'s opacity; the text takes the pose.
44. `bubblePath` moved: Captions Studio's Speech Bubble look has the same call log as before.
45. `CalloutSection`: Draw only for arrows, lines and boxes, Wipe for highlights and text, nothing
    for blur; one update per change; *Copy look* carries the motions; `refitItems` moves the tail.

**P4 · Colour**

46. `whiteBalanceGains`: the values of §9.2 within 0.002; `W · gains = 1`.
47. `gradeTable`: monotonic per channel for every slider at ±1; black and white fixed by brightness
    and contrast; a zero grade gives the identity.
48. `resolveGrade`: no look, no LUT and zeros give null; a look times its strength plus the sliders,
    clamped; `exposure` ignored on the screen.
49. `gradePixel` and `gradePixelsCpu` agree on a 64 × 64 pattern for every look and a 17³ LUT.
50. Saturation keeps luminance (within 1e-6 before clipping); Mono gives R = G = B.
51. `lutSample`: exact on the grid and on the grey axis; an identity 33³ LUT changes nothing by more
    than one level; strength mixes; the domain maps; a shaper runs first.
52. **Why not one baked LUT**: a 33³ bake of Vivid differs from `gradePixel` by at least 10 levels
    somewhere (so a later "optimisation" fails this test).
53. **Auto colour** on synthetic frames: a warm cast (gains 1.2, 1, 0.75) loses at least 60 % of its
    angle; `|temperature| ≤ 0.6`; a dark frame gains at most 0.7 stops; a dark-skinned face over a
    bright wall does not raise exposure; the same input gives the same output.
54. `colourEdit` and `settleGrade`: one project out per action; a hand edit of the camera grade drops
    `grade.auto`; Reset deletes an empty grade.
55. `colourReview`: Keep, Remove and statuses, as test 20.
56. `gradeLayer` (fakes): an identity grade returns the same `FrameImage` and makes no context; the
    blur cache keys on the raw frame and the grade; the backend is chosen once; a lost context that
    cannot be made again switches the session to the CPU path.
57. LUT loading: a changed or missing file is not used and `lutProblem` says so.
58. `importLut` (main): a bad file is rejected before anything is copied; a good one is stored as
    `lut-<n>.cube`, pruned to the three newest plus the saved project's; `MEDIA_FILE_RE`,
    `copiedFile` and `namedFiles` accept it.

**P5 · Music and sound effects**

59. `bedTime`: linear before E; from S after; continuous at E.
60. `bedGraph`: the exact graph string for a catalogue bed; `musicGraph` without a bed gives today's
    strings exactly.
61. `sfxJob`, zooms: zoom in at `seg.start + tin/2` less `peakAt`, in video time; none for a pan
    from the previous zoom; zoom out only with `tout > 0` and no pan into the next; none for a zoom
    starting in a cut; holds shift the times.
62. `sfxJob`, titles and callouts: half the enter duration (or the old fade) less `peakAt`; an item's
    sound beats the rule; `'none'` silences; privacy shapes never sound; merging within 0.05 s; 500
    times and 16 effects at most; the gain is the volume.
63. A graphic with an `SfxRef` sounds at `popJob`'s time; `popJob` is unchanged for `'pop'` and
    `'ding'`.
64. `planSoundtrack` with effects: one `-i` per effect at its resolved file, a click track each,
    mixed; a job without effects or a bed gives today's graph string exactly.
65. `validEffects`: an unknown id, a repeated id, 17 effects, 501 times, a gain of 2.1 and an id like
    `../x` are rejected; an unknown bed id is rejected; a bed file whose hash differs loops whole.
66. **Loop cache**: a looping Opus music is decoded once to `.cache/…flac` (by its hash) and the job
    reads that file; MP3, WAV, FLAC and Vorbis are not; music longer than the video is not.
67. **Library store**: `allowSoundUrl` takes only the prefix (https, port 443, no query, no `..`);
    redirects to the asset host only from the prefix; a download stops at the pinned bytes, a wrong
    hash deletes the `.part`; `library.json` lists checked files only; `useBed` re-hashes the source
    and copies it as `music-<n>.ogg`; `fromApp` rejects another frame.
68. The `sounds` host serves catalogue names only; `../`, other names and project files get 404.
69. **Preview sound** (fakes, and one `OfflineAudioContext` render compared with ffmpeg's): the bed's
    `loopStart`, `loopEnd` and start offset after a seek; library voices stop at the next sound of
    the same effect; times match the export's exactly and levels within −60 dB; old projects' graph
    is unchanged.
70. `readGreatOptions` takes a catalogue `SfxRef`; *Make my captions great* puts it on the pop-ups.
71. `musicCredit` and the YouTube description's credit line.
72. Packaging: `SOUND_LIBRARY_BUDGET` holds; `extraResources` has `sound-library`; `verify-dist`
    checks the hashes (`packaging.test.ts`).
73. `MusicLibrarySection`: mood chips; Play toggles and Esc; *Use* is one update keeping volume,
    ducking and fades; download rows and their progress; the live region's text.

**Performance** (`tests/editingPerf.test.ts`): `joinPlan` of 20,000 clips under 20 ms; `joinAt`
under 2 µs; `gradeTable` under 1 ms; `parseCube` of a 33³ file under 40 ms; `sfxJob` of 2,000 zooms
and 500 callouts under 10 ms.

### 19.2 Equivalence guard for old projects

Written first, before the contracts' hooks, and never regenerated: for every fixture of
`vertical-old-projects.json`, `wave8-old-projects.json` and the Captions Studio fixtures, the
`drawFrame` call logs at 24 sampled times (cuts, freezes, zooms, spotlights, texts and title cards
included) and the export job's sound graph strings are recorded; after the contracts and after every
part they are the same. With §0 decision 2, a fixture that loops an Opus music changes only its
music input's file name (the decoded copy); the guard records that case separately.

### 19.3 End to end: `tests/e2e/editing-polish.e2e.cjs`

Fixtures: a recording whose screen is red before 4 s, has a green "secret" square from 4 to 6 s,
and is blue after; a camera file with a warm cast; captions; three chapters; a pause freeze.

- **E1 Old projects**: an old fixture exports the same frames (pixel hashes) as the baseline the
  contracts step saved on the same machine, and the same audio.
- **E2 Smooth all cuts**: cut 4–6 s; *Smooth all cuts*; the notice; Ctrl + Z and redo. Paused in the
  window after a seek, the preview shows red and blue mixed once the still is ready. Exports at 24 and
  30 fps: the frame at T + 0.075 s is about half red, half blue (α 0.5 ± 0.1); the video's length is
  unchanged.
- **E3 Dip and the flash rule**: two dips 0.6 s apart: the frames never reach black at the second.
- **E4 Slide and Punch-in**: the frame at T + 0.2 s of a Slide shows blue on the right and red on the
  left; a punched clip's card is 1.10× larger.
- **E5 Nothing from inside a cut**: no exported frame of any window shows the green secret.
- **E6 Magnifier**: over a fine checker the lens shows larger squares; a blur box under the lens
  stays blurred; the preview and the export agree at the same time within tolerance.
- **E7 Callouts**: two step badges show 1 and 2; with Bangla captions and *১ ২ ৩* they show ১ and ২
  (glyph pixels compared with a reference drawn in the test); an arrow with Draw has no tip at 0.1 s
  and has one at 0.4 s; a speech bubble with Bangla text draws its tail toward the target.
- **E8 Chapter bar**: the fill grows linearly, keeps moving through the pause freeze, and captions
  sit above it.
- **E9 Colour**: Warm on the camera warms the camera and leaves the screen; Mono on the screen greys
  it; preview and export agree within 2 levels; with `forceGradeBackend('cpu')` the export agrees with
  the WebGL one within 1 level; Compare shows the original in the preview and the export is still
  graded.
- **E10 LUTs**: an identity 17³ cube changes nothing beyond 1 level; a red–blue swap cube swaps
  them; a malformed cube shows its line; deleting the file shows the missing notice and the export's
  question.
- **E11 Auto colour**: on the warm camera, the camera grade is set, Review lists "Camera colour
  balanced", and Remove puts it back.
- **E12 Music**: *Use* Sweet Sun; a 120 s export has no step at the loop seam larger than 1.5× the
  body's p99.9; the music ducks under speech; the credit shows; Space plays a preview and Esc stops
  it, announced in the live region.
- **E13 Downloads**: a bed downloads from the test server with progress; a corrupted copy is
  rejected with the message and leaves no file.
- **E14 Effects**: *Whoosh on zooms*; the export has the whoosh's peak at the zoom's start + 0.35 s
  (± 10 ms: 0.275 s start plus the 0.075 s peak); a Captions Studio pop-up with Soft pop sounds at its
  pop time.
- **E15 Polish and Review**: Polish with Smooth cuts is one undo step; Review lists "Soft cuts at
  every cut (1)"; Remove gives hard cuts back.
- **E16 Keyboard**: *Go to next cut* from the palette, Soft with the arrow keys, Length with Page Up;
  names checked; the Inspector still has 13 tabs.
- **E17 Versions**: after a version is saved, smoothing the cuts and grading the camera makes the
  comparison name "smooth cuts" and "colour".
- **E18 Cost**: the export's per-frame decode, draw and encode times for a 1080p graded project with
  Soft cuts and a magnifier are printed (and below a generous ceiling of 400 ms a frame under
  SwiftShader).

---

## 20. Later

- **Glide** (the camera glides from A's framing to B's) and **cross-zoom** cut styles.
- **Sound with dips** ("fade the sound too"), J and L cuts, and a swish on cuts.
- **Sound items on the timeline**, which would bring the six measured effects not shipped now
  (typing, keypress, shutter, scroll, toggle, error), a shutter on freezes and a chime on chapters.
- **Callouts**: "during" motions (an arrow's nudge, a badge's pulse), a bubble's tail anchored to the
  recording, right-to-left wipes and a right-to-left chapter bar.
- **Colour** in style presets, the brand kit and *Save as default*; film looks generated offline
  with the MIT-licensed spectral_film_lut (a 33³ half-float LUT is 215,622 bytes each); LUT
  thumbnails; local tone mapping.
- A 13th bed: Satie's Gymnopédie No. 1 (public domain, Musopen via Wikimedia Commons, 3,696,351
  bytes), once it is downloaded and measured (Wikimedia returned HTTP 429 during research).
- Kinoton's CC0 whooshes on Freesound (better than the bundled ones; a login is needed to download).
