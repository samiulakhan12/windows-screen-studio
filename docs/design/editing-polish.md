# Editing polish (wave 10): final design

Plan: `docs/PLAN.md`, wave 10 "Editing polish", five items. Roadmap items: NW-06 (smooth cuts: the
picture side, per-cut styles and *Smooth all cuts*; the 10 ms audio fades shipped in 0.7.0), LT-12
(magnifier zoom), LT-11 (animated callouts and a chapter progress bar), LT-16 (colour correction and
looks) and LT-13 (music and sound-effects library). Captions Studio item 12 (sound on pops, which
waited for LT-13) is finished here (§10.7).

Written against `rev/wave10-design` at `a988af4`: everything through wave 8 except versions, plus
Captions Studio phase A. Line numbers refer to that commit unless a branch is named. This is the
second version: it takes the product, engineering and licence reviews of the first (`37ee743`).
§3.3 lists where it departs from them.

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
- **Camera-led**: at a source time, the camera shows (`webcam.show && hasWebcam`) and the layout
  there (`layoutPhaseAt(project, t).to`, `src/shared/engine/layout.ts:347`) is `'camera-only'` or
  `'camera-large'`.

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
LUT error measurements), `audio-library/` (licence evidence, loop analysis, the first prepared files
and `catalogue-draft.json`), `cuts-callouts/` (the survey of other tools), and `rev2/` and `rev3/`
(the replacement beds, the artists' own pages, speech-fit measurements and the 300 s loop checks).

---

## 0. Decisions for the owner

Nothing in this wave changes how an existing project looks: every new feature is off until the
user turns it on, or until Polish or Auto colour turns it on and Review mode lists it. Decision 2
changes how existing projects *sound* in one narrow case. No asset outside the allowed licences is
used, and the installer grows by 2.78 MB, under the 5 MB line.

1. **Where the 8 extra music beds download from.** Four beds ship in the installer; eight more
   (7,123,720 bytes) download on request (§10.3). The Free Music Archive serves only the original
   MP3s, and its file paths have changed over time, so it cannot be the pinned source. Choices:
   - (a) **A release in a separate repository**, `samiulakhan12/flown-sound-library`, tag
     `sound-library-1` (never reused), with GitHub's immutable releases turned on. The app's own
     release feed is never touched. **Recommended.**
   - (b) A release on the app's repository (`samiulakhan12/windows-screen-studio`). It must be a
     prerelease, or made with `make_latest=false`: the updater (electron-updater 6.8.10,
     `allowPrerelease = false`, `src/main/updates/electronUpdaterPort.ts:25`) asks GitHub for
     `/releases/latest` and then fetches `latest.yml` from that tag. A sound release marked Latest
     has no `latest.yml`, so every installed Flown would fail to update until the next app release.
   - (c) A Qbexel repository on Hugging Face at a pinned commit.
   - (d) No download: bundle all 12 beds. The installer then grows by about 9.90 MB, over the 5 MB
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
3. **Polish gets a "Smooth cuts" step, on by default.** It sets every cut to *Smooth*: a crossfade
   where the screen fills the picture, a punch-in where the camera fills most of it on both sides
   (§5.2). It runs only when the video has cuts and the user has not chosen a cut style, and Review
   mode lists it. Saved Polish options without the step read it as off. **Recommended: on by default
   for new Polish options.**
4. **CC0 music and Content ID.** All 12 beds now come from two artists whose own pages agree with
   CC0, HoliznaCC0 and Loyalty Freak Music (§10.1). John Bartmann's six beds were removed: his own
   FAQ says CC-BY 4.0 and that his distributor flags uncredited videos (§3.2 row 22). False claims
   can still happen; Loyalty Freak Music's FAQ says they come from people who registered her music
   without the right, and tells users to dispute them. Her FAQ also asks, outside the licence, for
   credit where possible, that her music is never registered with Content ID, and that it is not
   used to promote hateful views; the app shows the credit by default and registers nothing.
   **Recommended: accept, with the credit line on by default.**
5. **A listening pass before release.** A person listens to all 12 beds under a voice, with the
   criteria of §10.1 (no vocals, nothing busy in the speech band, steady energy, no game feel, a
   clean loop point), and to the 16 effects (levels). The loop points were found by analysis only.
   Each mood has a measured spare to swap in. **Required before release.**
6. **Measurements on the reference Windows PC** after the build: the colour shader's cost on a real
   GPU and the copies grading needs (estimated, not measured, §15), the preview with crossfades,
   the installer's size, and one real download through the chosen host (§10.3). **Required after
   the build.**

---

## 1. Summary

- **Smooth cuts.** Every cut can have a style: **Hard cut** (today), **Smooth** (chosen per cut from
  the layout: a crossfade on the screen, a punch-in on the camera), **Crossfade** (A's last frame
  fades into B over 0.15 s), **Dip to colour** (0.5 s through black, white or a brand colour),
  **Slide** (B pushes A's last frame out over 0.4 s) or **Punch-in** (B shown 1.10× closer, then the
  next clip back at 1.0×; the screen's view or the camera's framing zooms, never the background or
  the layout). One style for every cut, and an optional style per cut. **Smooth all cuts** sets every
  cut to Smooth in one undo step. The video never changes length, and no frame from inside a cut is
  ever shown, so nothing the user cut out comes back and every caption, chapter and click keeps its
  time. The sound at cuts stays as shipped (10 ms fades). Every cut has a marker on the timeline, and
  the Cut style section steps from cut to cut and plays each one.
- **Magnifier.** A round loupe (or rounded rectangle) that shows a detail 1.5–4× larger, from the
  recording's own pixels, while the rest of the screen stays visible. Its default zoom is picked
  from the recording's resolution (2× on a recording shown 1:1). It sits on its content like a
  spotlight, or follows the cursor, and lands on the cursor when it is added. It grows in over
  0.30 s and shrinks away over 0.22 s. Blurred or pixelated areas stay hidden inside it. It can be
  added from the Zoom tab too.
- **Animated callouts.** Texts, shapes and title cards can come in and go out with the motions
  Captions Studio's graphics use (fade, pop, rise, drop, slide, grow, typewriter), plus **Draw** for
  arrows, lines, boxes and ellipses and **Wipe** for highlights and text. New badges, bubbles and
  marks come with their kind's motion; items made before keep today's fades exactly. Two new text
  styles: **Step badge** (a numbered circle: 1 2 3, A B C or Bangla ১ ২ ৩, numbered automatically in
  time order and again at each chapter) and **Speech bubble** (a rounded box with a tail). Badges
  and bubble tails stay on their spot in the recording while the camera zooms, as shapes do.
- **Progress bar.** A thin bar that fills as the video plays, split at the chapters when there are
  any, with the current chapter's name (or all of them, or none) on a dark pill. At the top unless
  the captions are there, inside the safe zones, hidden under full-frame title cards. Captions, key
  presses and lower thirds keep clear of it.
- **Colour.** Temperature, tint, brightness, contrast and saturation (plus highlights, shadows,
  vibrance, and exposure for the camera), looks (eight for the camera; Natural, Vivid and Mono for
  the screen) and the user's own `.cube` LUTs, for the screen and the camera separately. **Auto
  colour** balances the camera from a few frames, offline. One WebGL2 shader grades each picture
  before it is drawn; PCs without WebGL2 use the same maths on the CPU. Captions, the background and
  overlays are never graded.
- **Music and sound effects.** Twelve CC0 music beds in five moods (four in the installer, eight on
  request), each prepared to loop seamlessly and mastered to −16 LUFS, and sixteen CC0 sound effects
  (whooshes, pops, clicks, chimes) in the installer. Effects can sound on zooms, title cards, texts
  and shapes as they appear, and on Captions Studio's pop-ups. A sound set by a rule plays at most
  once every 3 s. The installer grows by 2.78 MB.
- **Automatic changes.** Polish's new Smooth cuts step and Auto colour each make one Review mode row
  with Keep and Remove.
- **No new Inspector tab.** The rail holds 13 tabs at the minimum window size (`954036a`). Each
  feature adds a section to an existing tab.

---

## 2. What the user sees

### 2.1 Smooth cuts

**On the timeline.** Every cut gets a marker of fixed size, whatever the width of its cut block
(`GapBlock`, `Timeline.tsx:869`; at the fit scale a 10-minute video gives a 1 s cut 1–2 px). The
marker is a 12 px glyph centred on the block at the clip track's top edge, inside a 24 × 24 px hit
target that selects the cut. Glyphs: a thin bar for a hard cut; a square split on its diagonal for
Smooth; two overlapping squares for Crossfade; a filled dot for Dip; an arrow for Slide; a small "+"
square for Punch-in. Markers closer than 12 px merge into one marker with a count ("3"); a click
selects the first of them, and *Next cut* walks the rest. The marker's tooltip and accessible name:
"Cut 5 of 37: 1:23.4 – 1:25.0 (1.6 s not in the video). Crossfade, 0.15 s."

**Clip tab, with no cut selected.** A section **Cuts**, shown when the video has at least one cut:

- "37 cuts. A cut jumps from one moment of the recording to the next."
- **Every cut**: a select with *Hard cut* (default), *Smooth*, *Crossfade*, *Dip to colour*,
  *Slide*, *Punch-in*.
- The style's options below it (see the table).
- **Smooth all cuts** (button): sets Every cut to Smooth. Notice: "Smoothed 37 cuts · Ctrl + Z to
  undo", or, when some cuts have their own style, "Smoothed 34 cuts · 3 keep their own style · Ctrl
  + Z to undo". The button is disabled, with the hint "Every cut is already smooth", when it would
  change nothing.
- When some cuts have their own style: "3 cuts have their own style." and a button **Give them the
  same style** that clears them (one undo step).

**Clip tab, with a cut selected** (`selection.kind === 'gap'`, `ClipPanel.tsx:86`). Under Restore, a
section **Cut style**:

- "Cut 5 of 37", and three buttons: **Previous cut**, **Next cut**, **Play this cut** (plays from
  1 s of video before the cut to 1 s after it, then stops where it started).
- A radio group *Same as every cut (Smooth)*, *Hard cut*, *Smooth*, *Crossfade*, *Dip to colour*,
  *Slide*, *Punch-in*, then the chosen style's options.
- With Smooth (its own or every cut's), one line says what this cut gets: "Here: a crossfade (the
  screen fills the picture)." or "Here: a punch-in (the camera fills most of the picture on both sides)."

Trimmed starts and ends have no Cut style section.

| Style | Options (defaults) | Hint (exact copy) |
|---|---|---|
| Hard cut | none | "Jumps straight to the next clip." |
| Smooth | Crossfade length 0.05–0.5 s (0.15); Punch-in size 105–120 % (110) | "A crossfade where the screen fills the picture, a punch-in where the camera fills most of it. The video keeps its length." |
| Crossfade | Length 0.05–0.5 s (0.15) | "The last frame before the cut fades into the next clip. Hides small jumps on the screen. The video keeps its length." |
| Dip to colour | Length 0.2–1.2 s (0.5); Colour: Black, White, the brand colours, Other… | "Fades to a colour and back. For the start of a new part." |
| Slide | Length 0.25–0.7 s (0.4); From: Right, Left, Top, Bottom (Right) | "The next clip pushes the last frame out of the picture." |
| Punch-in | Size 105–120 % (110) | "The next clip is shown a little closer: the camera in the camera layouts and side by side, otherwise the screen. The clip after it goes back. For talking-head cuts." |

With **Calm motion** on (§7.5), Slide draws as a crossfade and its row says "(Crossfade while Calm
motion is on)".

A Dip whose middle is less than 1 s after another Dip's draws as a crossfade (§5.2, the flash rule).
The panel then says: "Shown as a crossfade so dips don't flash too often."

**Command palette**: *Smooth all cuts*, *Use hard cuts everywhere*, *Go to next cut*, *Go to previous
cut* (each moves the playhead to the cut and selects it, which opens Cut style), *Play this cut*.

**Sound.** Unchanged: every cut keeps its 10 ms fade out and in (`CUT_FADE`).

### 2.2 Magnifier

**Shapes tab**: two buttons next to *Add spotlight*: **Add magnifier** and **Add magnifier on the
cursor**. **Zoom tab**: a row "Show a detail larger without zooming:" with the same **Add
magnifier** button, because users look for it there. A magnifier starts at the playhead and lasts
3 s (`DEFAULT_SHAPE_LENGTH`). It is round and 0.30 S across (324 px at 1080p). It is centred on the
cursor when the cursor shows at the playhead, else on what the preview shows. Its zoom is picked
from the recording's resolution (§6.1): 2× on a recording shown 1:1, at most 2.5×.

It is a kind of spotlight, so it sits on the spotlight row of the timeline, is selected, moved,
resized, copied, nudged, snapped and multi-selected exactly as spotlights are, and stays on its
content while the camera zooms. On the timeline it has its own icon (a magnifying glass) and name:
"Magnifier, 2 times" in the block's label, tooltip and accessible name.

**Panel of a selected magnifier** (Shapes tab):

- **Zoom**: slider 1.5×–4× in steps of 0.25. Value text "2 times". When the lens would show more
  than 2.5 output pixels per recorded pixel: "Shown larger than the recording's pixels: it may look
  soft."
- **Shape**: *Round* (default), *Rounded rectangle*.
- **Follows**: *A place on the screen* (default), *The cursor*.
- **Darkness**: 0–40 % (0), the spotlight panel's word for the same thing.
- Hint: "Shows a detail larger, from the recording's own pixels, while the rest of the screen
  stays in view. Blurred and pixelated areas stay hidden inside it."

### 2.3 Animated callouts

**Text tab, a text selected.** **Style** gains two choices: *Pill*, *Title*, **Step badge**,
**Speech bubble**. A section **Animation**, with the labels the Graphics tab already uses
(`ITEM_MOTIONS`, `src/shared/editor/groupEdit.ts:97`):

- **Comes in**: *Default* (today's short fade), *Fade*, *Pop*, *Rise*, *Drop*, *Slide left*,
  *Slide right*, *Grow*, *Typewriter*, *Wipe*.
- **Goes out**: *Default*, *Fade*, *Pop*, *Rise*, *Slide left*, *Slide right*, *Grow*.
- **Speed**: "Comes in over 0.25 s", a slider 0.1–1.5 s (shown when Comes in is not Default).
- **Sound**: *Same as the project* (§2.6), *None*, then the effects of the library with a Play
  button.

**Shapes tab, a shape selected.** The same section. Comes in offers what fits the shape:

| Shape | Comes in (default when picked) | Goes out |
|---|---|---|
| Arrow, line | Default, **Draw** (0.35 s), Fade, Pop, Grow | Default, Fade, Pop, Grow |
| Rectangle, ellipse | Default, **Draw** (0.45 s), Fade, Pop, Grow | Default, Fade, Pop, Grow |
| Highlight | Default, **Wipe** (0.28 s), Fade | Default, Fade |
| Blur, pixelate | none | none |

For blur and pixelate the section says: "Blur and pixelate are fully on for their whole time, so
nothing they hide shows."

**New items come with motion.** A badge, bubble, arrow, line, rectangle, ellipse or highlight added
in this version gets its kind's default motion (§7.1): a badge pops in, an arrow draws itself. Texts
and title cards are added as today. Items made before keep their fades, and *Default* is always one
choice away.

**Several selected.** The multi-select panel gains *Comes in*, *Goes out* and *Sound* for texts,
marks and title cards (group fields `text.enter`, `text.exit`, `text.sound`, `mark.enter`,
`mark.exit`, `mark.sound`, `title.enter`, `title.exit`, `title.sound`), offering the motions every
selected item allows. One change is one undo step.

**Title cards** (Text tab, a title selected): Comes in *Default* (today's fade and rise), *Pop*,
*Rise*, *Slide left*, *Slide right*, *Grow*, *Typewriter*, *Wipe*; Goes out *Default*, *Fade*,
*Pop*, *Rise*, *Grow*; Sound.

**Step badge.** Added from the Text tab (**Add step badge**) or the palette. When the cursor shows
at the playhead, the badge lands just beside it (its centre 1.2 badge widths up and to the left of
the pointer's tip, kept inside the frame); otherwise at the centre of what the preview shows. It
stays on its spot in the recording while the camera zooms and pans, as shapes do. Options:

- **Number**: *Automatic* (default; shows the number it gets, "3") or *Your own text* (a short field,
  at most 3 letters as a reader counts them: "ক্ষা" is one; checked as it is typed).
- **Count with**: *1 2 3*, *A B C*, *১ ২ ৩ (Bangla digits)*, and the digits of any other language
  the project's captions or transcript use when that language has its own. Default: Bangla digits
  when the caption or transcript language is Bangla, else *1 2 3*.
- **Restart at each chapter** (switch; on when the project has chapters) and, on one badge, **Start
  from** (a number): this badge takes that number, and the automatic badges after it count on.
- **Colour**: the brand colours first, then the shape palette. A new badge takes the brand kit's
  first colour, else #0060df.
- **Follows the zoom** (switch, on). Off: it stays at one place in the frame. Turned on for a
  badge outside the picture (on the padding), it takes the picture's nearest point at its start.
- In the preview, its handle is dragged or moved with the arrow keys (1 % of the frame, Shift
  10 %). While it follows the zoom it stays on the picture: dragged or moved past the picture's
  edge it stops there (off the picture it would not be drawn), and its handle keeps the focus.
- Automatic badges are numbered in start-time order. Moving one past another renumbers both.

**Speech bubble.** Added from the Text tab (**Add speech bubble**) or the palette. Its tail points
at the cursor when the cursor shows at the playhead (the body sits above it, toward the frame's
centre), else at the centre of the preview. The text field takes focus at once, with the placeholder
"Type the bubble's text". The tail's tip stays on its spot in the recording while the camera zooms;
the body moves with it and stays inside the frame. In the preview a round handle at the tail's tip
is dragged to point at something (arrow keys move it 1 % of the frame, Shift 10 %; it stops at the
picture's edge, as a badge does); dragging the body moves it around the tip. While a zoom or the
layout hides the tip, dragging the body still moves only the body (beside the picture's edge, where
it is drawn then); the tip stays on its spot. **Colour**: *White* (default, dark text, a thin outline), *Dark*
(#1d1d24, white text), the brand colours. **Tail**: *Pointing* (default) or *None*. *Pointing*
on a bubble without a tail points down at what shows 0.12 S below the body, kept on the picture
at the bubble's start (a bubble near the bottom points at the picture's edge, its body above it).

### 2.4 Progress bar

**Text tab**, in the Chapters section: **Progress bar on the video** (switch, off): "A thin bar that
fills as the video plays, split at your chapters when there are any." The Effects tab has a row
**Progress bar…** that opens it, and the palette finds it by "progress". When on:

- **Place**: *Auto* (default: the top, or the bottom when the captions sit in the top half), *Top*,
  *Bottom*.
- **Look**: *Floating* (default; rounded, inset from the edges), *Edge* (full width, flush).
- **Chapter names**: *Current chapter* (default), *All chapters*, *None*. Shown with two chapters
  or more.
- **Colour**: the brand colours first, then white (default without a brand).
- **Show only when a chapter starts**: switch (off). On: the bar shows for 3 s after each chapter
  starts.
- With fewer than two chapters: "Add chapters to split the bar. With one or none it is a plain
  progress bar."

The bar fades out while a full-frame title card shows, and back in after it.

### 2.5 Colour

**Effects tab**: section **Screen colour**. **Camera tab**: section **Colour** (shown with a camera).
Both have:

- **Look**: chips with a thumbnail and a text label. Camera: *None* (default), *Natural*, *Warm*,
  *Cool*, *Vivid*, *Soft*, *Cinematic*, *Mono*, *Vintage*. Screen: *None*, *Natural*, *Vivid*,
  *Mono* (the others tint white pages and brand colours). **Strength** 0–100 % (100) when a look is
  picked. The screen's Mono carries the hint "Coloured text may become harder to read."
- Sliders, each −100 to +100 with a centre detent and a value text: **Temperature** ("Cooler" /
  "Warmer"), **Tint** ("Greener" / "More magenta"), **Brightness**, **Contrast**, **Saturation**.
  **More** (a disclosure): **Highlights**, **Shadows**, **Vibrance**, and for the camera **Exposure**
  (−2 to +2 stops). Each slider not at 0 has a small **Reset** button beside it ("Reset
  Temperature").
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
  library, outside the project) and **Use**. A bed not downloaded yet has one button, **Download and
  use (1.0 MB)**, with a progress bar while it downloads; when done it is in use and the button
  reads "In use". Its Play is disabled until then, with the hint "Download to listen".
- After Use: "Music: Sweet Sun by Loyalty Freak Music (CC0)" under the music row. Volume, ducking,
  loop and fades are today's controls and keep their values when one bed replaces another.

**Audio tab, Sound effects section.**

- **Volume**: 0–100 % (35 %).
- **Zooming in**, **Zooming out**, **Title cards appear**, **Texts and shapes appear**: each a
  select (*None* by default, then the effects that fit it first) with a **Play** button, and beside a
  rule that is set, how often it plays: "Plays 24 times".
- A link **Soft whoosh when zooming in** sets Zooming in to *Soft whoosh*.
- Hint: "A sound set here plays at most once every 3 seconds. A sound set on one item always plays."

**Captions Studio graphics** (Graphics tab): the Sound select keeps *None*, then a group
**Original** with *Original pop* and *Original ding* (they sound exactly as before), then the library
effects in their own group. *Make my captions great*'s sound option gets the same list.

**Settings › Downloads**: a group **More music** with "8 tracks, 7.1 MB", **Download all** and
**Remove**, beside the caption fonts.

### 2.7 Polish and Review mode

- **Polish dialog**: a row **Smooth cuts** after *Remove silences*: "Crossfades on the screen,
  punch-ins on the camera". It skips with "No cuts to smooth" or "Your cut style is kept" (when
  Every cut has been chosen, *Hard cut* included).
- **Review mode** rows:
  - *Cuts* chip: "Smooth cuts at 37 cuts", detail "Polish". Keep makes it the user's; Remove puts
    back the cut style there was before (a hard cut, usually).
  - *Colour* chip: "Camera colour balanced", detail "Auto colour". Remove puts back the camera's
    colour as it was.
  - Captions Studio's pop-up rows name a library sound: "Pop-up: Save (with Soft pop)".

### 2.8 Command palette

New commands, appended after the versions branch's, with no default keys (so no key changes for
anyone): *Smooth all cuts*, *Use hard cuts everywhere*, *Go to next cut*, *Go to previous cut*, *Play
this cut* (Playback), *Add magnifier*, *Add magnifier on the cursor*, *Add step badge*, *Add speech
bubble* (Add), *Progress bar on the video* (toggle, Effects; keywords "progress", "chapter bar"),
*Compare with original colour* (toggle, Effects), *Auto colour for the camera* (Camera), *Music
library…* (Panels: opens the Audio tab at the Library). Users can give them keys in the shortcuts
editor.

### 2.9 Keyboard and screen readers

§12 lists every control's role, name and keys.

---

## 3. Decisions

### 3.1 How this design was chosen

Four researchers mapped the code, measured per-frame costs in Electron 44.9.3 on the reference rig
Captions Studio used (CPU raster, 4-core Xeon, no GPU), surveyed other tools (Screen Studio, Tella,
Descript, Camtasia, ScreenFlow, Loom, CapCut, Premiere, DaVinci Resolve, Final Cut Pro, PixPin,
Snagit, Windows Magnifier), checked the licence of every music and sound source on its own page and
on its artist's own site, prepared and measured every file, and measured WebGL2 accuracy and LUT
errors. Three reviews (product, engineering, licences) then checked the first version against the
code and the sources. The choices below follow from those measurements and reviews.

### 3.2 Decision table

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| 1 | The second picture at a cut | **A\***, A's last kept frame, held under a transition that starts at the cut | *Frames from inside the cut* (Camtasia's "Use trimmed content", Descript's handles): would show what the user removed on purpose, often to hide it, with no privacy box over it; needs a second decoder in the export and a second playing `<video>` in the preview. *Overlapping the clips* (Final Cut's "Lose time"): shortens the video and moves every caption, chapter, click and pop; `edit-by-text.md` §12 rejected it for the same reason. *Centred dissolves*: show a frozen B face while A's words still play. |
| 2 | Where cut styles are stored | `Project.joins`: a default for every cut plus overrides keyed by B's clip id | *On `Clip`*: `splitAt` and `cutRange` copy clip fields onto new pieces (`timeline.ts:115`, `:135`), so a new cut inside B would inherit B's style; `restoreRange` drops the right clip's fields (`clips.ts:69-72`). |
| 3 | Styles offered | Smooth, Crossfade, Dip to colour, Slide, Punch-in | *Glide* (Tella's camera glide): needs `frameCamera` to change (frozen, `frameView.ts:8`) and looks like a hard cut when both sides are framed alike; Later. *Cross-zoom*: energetic, not tutorial-like; Later. *Morph Cut / Smooth Cut / generated bridges*: optical flow or a model, and they fail on moving backgrounds. |
| 4 | Sound at cuts | Unchanged: 10 ms linear fades | *Crossfades, J and L cuts*: would play removed words and need two sound pieces at once in the preview (`edit-by-text.md` §4.9). *A dip that fades the sound*: needs per-cut fade lengths in the job and in main's checks; Later. NLE video transitions leave the sound alone too. |
| 5 | Crossfade's length | 0.15 s (4.5 frames at 30 fps) | *1 s* (Premiere's and Resolve's default): for scene changes; on a jump cut it reads as a double exposure. A still screen's small jump hides in 4–5 frames. Resolve's "2- to 6-frame Smooth Cut" is an optical-flow morph, not a dissolve: only its length is borrowed, and on faces a plain dissolve ghosts (row 6). |
| 6 | What *Smooth* and Polish do | Per cut, from the layout: Punch-in when both sides are camera-led, else Crossfade (§5.2) | *Crossfade everywhere*: a 0.15 s fade of a frozen face over a live face reads as a ghost and a stutter, and Remove silences and edit-by-text put such cuts every few seconds. *Leave camera cuts hard*: punch-in is the usual way to soften a talking-head jump cut. |
| 7 | What Punch-in scales | The content: the screen's zoom camera, or the camera's framing zoom in a camera-led or side-by-side layout (§5.6) | *The whole composed picture about the frame's centre*: the camera bubble grows toward the corner and can be cut by the frame edge or land in safe zones; the card's padding and corners jump on every other clip; in camera-only it zooms about the frame's centre, not the face. |
| 8 | Dips and flashing | A dip less than 1.0 s after the previous dip draws as a crossfade | WCAG 2.3.1 allows three flashes a second; edit-by-text can put cuts 0.2 s apart. One a second is stricter and still allows a dip per section. |
| 9 | Which frame A\* is | The frame that holds A's last instant, from each track's own frame times, asked for with the decoder's own rule (§5.3) | *Fixed 60 and 30 fps formulas*: real proxies run at the capture rate, an import's rate or the camera's own; and the export picks the frame nearest a time (half-frame slack), so a still asked for after A's last frame could go back a frame and stop the decoder. |
| 10 | Keeping A\*'s frames in the export | A copy into a canvas (one `drawImage`) when the feed reaches the frame | *Cloning the `VideoFrame`*: the clone holds a decoder output buffer, and the decoder keeps at most 3 ready frames (`MAX_READY`, `frameSource.ts:38`), so a held clone can stall it. |
| 11 | Magnifier data | A `Spotlight` with `magnify` | *A new item list*: about 27 files mention `spotlights` (selection, multi-select, clipboard, group moves, snapping, crop, reframe, director corners, panels); a variant gets all of it. *A zoom kind*: 99 uses of `.zooms` in 31 files would each have to skip it, and auto zoom regenerates zooms wholesale. |
| 12 | What the loupe shows | The scene drawn again through a lens camera from the full-resolution frame, with privacy shapes and the cursor drawn again inside | *Sampling the output canvas*: blurry (2.5× of output pixels). *Sampling `fc.screen` alone*: would show what a blur or pixelate box hides. |
| 13 | Magnifier's default zoom | From the recording's resolution: at most 2 output pixels per recorded pixel, 1.5–2.5× (§6.1) | *2.5× always*: on a 1080p recording in a padded card that is already 2.1 output pixels per recorded pixel, and inside an auto zoom 3–5, which looks soft. |
| 14 | Callout motion | Captions Studio's `itemPose` (`motion.ts:841`) and `ItemMotion`, plus `draw` and `wipe` | *A new engine*: a second set of easings and calm rules to keep in step. |
| 15 | Old and new items | No motion field = today's fade, drawn by today's code; new badges, bubbles and marks are written with their kind's motion | *Migrating old items to a motion*: would change how they look. *New items without motion*: most users would never see the feature. |
| 16 | Where badges and bubble tails sit | On the recording, as shapes are (`pin`, drawn through `fc.toOut`) | *In the output frame, as texts are*: almost every Flown video has auto zooms, and a badge or a tail that stays put while the camera moves points at the wrong thing. *A warning only*: leaves the user to fix it by hand. |
| 17 | Progress bar | Burned into the frame, on video time, inside the text area, at the edge away from the captions | *Metadata only*: that is what the export's chapters already do (`outputChapters`); the bar is for videos watched where chapters are not shown. *Always at the bottom*: that is where captions and web players' own scrubbers sit. |
| 18 | Colour engine | One WebGL2 shader (exact 1D curve + linear-light saturation + tetrahedral 3D LUT), the same maths on the CPU when WebGL2 is missing | *`ctx.filter` CSS functions*: +22 ms at 1080p on the CPU, banned on the frame canvas by Captions Studio, and their maths has no CPU twin. *SVG `feColorMatrix`*: +9.3 ms on the CPU, but no 3D LUT and Skia's GPU and CPU filters may differ. *Everything baked into one 33³ LUT*: up to 14 of 256 levels wrong on saturated colours (measured). *Hardware trilinear filtering*: about 1 % of values one level off any CPU reference (measured). |
| 19 | Where the grade runs | On each source picture before it is drawn (screen after the crop copy, camera after its mask lookup) | *On the finished frame*: would grade captions, the background, logos and text, and privacy blur would sample ungraded pixels. |
| 20 | Looks | Eight parameter sets in code (0 bytes) and the user's own `.cube` files; the screen gets Natural, Vivid and Mono only | *A bundled LUT pack*: none found with a clean licence and origin. three.js's LUTs say "Copyright (C) 2017 RocketStock"; OBS's are GPL-2.0; RawTherapee's, spektrafilm's and cyangraphics' are CC BY-SA 4.0; GPUImage's come from DeviantArt Photoshop actions; Q-DDL's are CC BY 4.0. *All eight on the screen*: Warm, Cool, Soft, Cinematic and Vintage tint white pages, greys and brand colours. |
| 21 | Auto colour | Shades-of-Gray (p = 6) on the background pixels, gentle levels, offline, stored as ordinary values | *A skin-tone target*: lightens darker skin. *Live auto white balance*: would differ with seek order and fps. |
| 22 | Music source | CC0 tracks from the Free Music Archive by artists whose own pages agree with CC0: HoliznaCC0 and Loyalty Freak Music | *Pixabay*: its terms forbid standalone redistribution and compiling content into a competing service. *Mixkit*: its own licence. *CC BY*: the credit must travel with every video, which the app cannot guarantee. *CC BY-NC / ND*: not commercial. *BigSoundBank*: "CC0-like" without saying which licence applies. *All of John Bartmann's catalogue*: his FMA pages say CC0, but his own FAQ (johnbartmann.com/faq, 2026-11-06) says "Creative Commons CC-BY 4.0 or public domain. Do credit me", that uncredited videos "will get flagged by We Are Era Music", and "Can I resell your music? No"; his "Album One" files' tags say BY-NC-ND. *Komiku's "It's time for adventure !"*: game-styled under a voice, and the weakest loop (0.657). |
| 23 | What ships | 4 beds and 16 effects in the installer (2,776,623 bytes); 8 beds on request (7,123,720 bytes) | *All 12 bundled*: +9.90 MB. *None bundled*: no music offline. |
| 24 | Which beds are bundled | Per mood, the smallest bed that passes the speech screen of §10.1 | *By ear alone*: not repeatable; the listening pass still decides (§0 decision 5). |
| 25 | Where the 8 beds download from | A release in a separate repository (§0 decision 1) | *A normal release on the app's repository*: it would become "Latest" and stop every installed Flown from updating. |
| 26 | Bed format | Ogg Opus 64 kb/s stereo, cut at an analysed loop point with a 1 s equal-power crossfade baked in and a 0.25 s pad | *MP3 / AAC*: larger, and AAC loops badly through ffmpeg (row 27). |
| 27 | Looping in the export | `atrim` + `aloop` in the filter graph, sample-exact (300 s renders matched the decoded files with a maximum difference of 0.0) | *`-stream_loop -1`*: glitches at every seam for Opus and M4A (§0 decision 2). |
| 28 | Looping in the preview | `AudioBufferSourceNode` with `loopStart` and `loopEnd`, kept on the music's drift loop | *`<audio loop>`*: loops the whole file, not from the loop point, and not sample-accurately. |
| 29 | Preview `AudioContext` rate | Unchanged (the device's) | *Forcing 48 kHz*: would change the preview of every old project; loop points in seconds work at any rate, and the baked crossfade hides a sub-sample seam. |
| 30 | Effect files | Ogg Opus, mono, shipped through `extraResources` | *Inside `app.asar`*: ffmpeg, a separate process, cannot read files there (`asarUnpack` covers only ffmpeg and uiohook, `electron-builder.config.cjs:45`). *Synthesised*: whooshes and real pops cannot be. |
| 31 | Effects' level | One volume, 0.35 by default, the synthesised pop's `POP_VOLUME` (`popSound.ts:37`) | *0.5*: 3 dB louder than today's pops. |
| 32 | Whoosh on zooms | *Soft whoosh* on zooming in only; a rule plays at most once every 3 s | *Whooshes in and out, merged only within 0.05 s*: auto zoom makes a pair every few seconds, the most dated trope in screen videos; the plain *Whoosh* is a bamboo-stick swish, sharp for a UI zoom. |
| 33 | Inspector | No new tab | *A 14th tab*: the rail is at its width limit (`954036a`, `tests/inspectorRailCss.test.ts`). |

### 3.3 Where this design departs from the review

Every blocker and major point of the three reviews is taken. These details differ from what a
reviewer proposed:

- **Fonts for badges, bubbles and bar names** are listed by the contracts in full
  (`editingFonts.ts`, §7.6) instead of being filled in by two parts: one hook file filled by P2 and
  P3 would be edited by both.
- **Previous cut and Next cut** get buttons and palette commands, but no default key: the wave's
  rule is that new commands take no key someone may already use.
- **Motion labels** reuse the Graphics tab's shipped words (*Comes in*, *Goes out*, *Slide left*,
  *Slide right*) rather than renaming them, so Captions Studio's UI does not change.
- **Smooth on camera layouts** uses Punch-in rather than a hard cut (the review offered both). A cut
  whose two sides differ (camera-large to the bubble layout) gets a crossfade.
- **Archives** are unpacked with 7-Zip rather than an npm package: two of them are `.7z`, no 7z
  reader is a dependency today, and one pinned binary covers zip and 7z (§10.2).
- **Two download beds exceed the speech-band screen** (Drifting Piano, Walking Away) and stay in the
  list: the screen is a proxy, the listening pass decides, and each mood has a spare ready (§10.1).

---

## 4. Data model and migration

### 4.1 `src/shared/types.ts` (additive)

Every new field is optional. Nothing existing changes type except two widened unions
(`AnnotationStyle`, `GraphicBase.sound`), whose old values keep their meaning.

```ts
/* ---------- Smooth cuts (NW-06, §5) ---------- */

/**
 * 'cut' is a hard cut (used to give one cut no style while every other cut has one, and stored
 * by "Use hard cuts everywhere"). 'smooth' is a crossfade or a punch-in, chosen per cut (§5.2).
 */
export type JoinKind = 'cut' | 'smooth' | 'crossfade' | 'dip' | 'slide' | 'punch'
export type SlideFrom = 'left' | 'right' | 'top' | 'bottom'

/** How the picture goes from one clip to the next at a cut. */
export interface CutJoin {
  kind: JoinKind
  /**
   * Output seconds. crossfade, and smooth's crossfades: 0.05..0.5 (0.15); dip 0.2..1.2 (0.5, both
   * halves); slide 0.25..0.7 (0.4). Absent: the kind's default.
   */
  duration?: number
  /** dip: #rrggbb; absent: #000000. */
  color?: string
  /** slide: the side the next clip comes in from; absent: 'right'. */
  from?: SlideFrom
  /** punch, and smooth's punch-ins: 1.05..1.2; absent: 1.1. */
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
  // ...today's fields, unchanged (x and y: the centre in the output frame)...
  /** Absent: today's fade (ANNOTATION_FADE) and grow, drawn by today's code. */
  enter?: CalloutMotion
  exit?: CalloutMotion
  /** 'badge' and 'bubble': the fill, #rrggbb; absent: badge #0060df, bubble #ffffff. */
  color?: string
  /** 'badge': 'auto' numbers it (§7.3); absent: `text` is drawn (at most 3 graphemes). */
  number?: 'auto'
  /** 'badge' digits: '1', 'A', or a language code with digits of its own (nativeNumbering: 'bn', 'hi', 'ar', 'fa'); absent: '1'. */
  numbering?: string
  /** 'badge': this badge takes this number, and automatic badges after it count on (1..999). */
  startAt?: number
  /**
   * A point of the recording, normalised like shapes, so it stays on its content while the camera
   * zooms. 'badge': its centre. 'bubble': its tail's tip. Absent: a badge sits at x, y (it does
   * not follow the zoom); a bubble has no tail.
   */
  pin?: { x: number; y: number }
  /** 'bubble' with a pin: the body's centre relative to the tip, in units of S. */
  body?: { dx: number; dy: number }
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

/** The progress bar (shown to users as "Progress bar"; split at the chapters). */
export interface ChapterBar {
  show: boolean
  /** 'auto': the top, or the bottom when the captions sit in the top half. */
  place: 'auto' | 'top' | 'bottom'
  style: 'float' | 'edge'
  labels: 'none' | 'current' | 'all'
  /** The played part, #rrggbb; absent: the brand's first colour, else #ffffff. */
  color?: string
  /** Shown for 3 s after each chapter starts, then hidden. */
  onlyAtChapters?: boolean
}

export interface EffectSettings {
  // ...today's fields, unchanged...
  /** Calm motion for callouts, the magnifier and slide cuts (§7.5); absent: off. Captions keep their own. */
  calm?: boolean
  /** Automatic step badges start again at 1 at each chapter; absent: yes when the project has chapters. */
  badgesByChapter?: boolean
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
  /** The screen takes 'natural', 'vivid' and 'mono' only (the reader drops the others there). */
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
  /** Auto colour set the camera grade and Review has not kept or removed it: the grade before its first run (null: none). */
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
  /** The progress bar (LT-11). Absent: none. */
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

`src/renderer/src/render/compositor.ts`: `RenderScene` gains `compare?: boolean` (the preview's
*Compare*; never saved, never set by the export).

### 4.2 Readers

All in `src/shared`, pure, idempotent, and each returns `undefined` for absent input so
`optional()` adds no key.

- **`readJoins`** (`src/shared/engine/joinData.ts`, new). Not an object: undefined. `all` through
  `readCutJoin`. `cuts`: an array of at most `MAX_CUT_STYLES` (20,000) entries; each needs a string
  `clip` of 1–64 characters and a readable join; a repeated `clip` keeps the first. `auto` needs
  `by: 'polish'` and `was` a readable join or null. **`readCutJoin`**: `kind` in the set, else null;
  `duration` clamped to the kind's range (§5.2), non-finite dropped; `color` must match
  `/^#[0-9a-f]{6}$/i` and is lower-cased; `from` in the set; `scale` clamped to 1.05..1.2; fields
  that do not belong to the kind are dropped (`'smooth'` keeps `duration` and `scale`). An object
  with nothing readable left: undefined.
- **`readProjectGrade`**, **`readColorGrade`** (`src/shared/render/gradeData.ts`, new). Each number
  must be finite, then is clamped to its range; a value of 0 is kept as written (the reader never
  adds or drops a key of a valid grade, so a load and a save give the same bytes). `look` not in
  `LOOK_IDS`: dropped; on the screen only `natural`, `vivid` and `mono` are kept. `lut`: `file` must
  match `LUT_FILE_RE` (`/^lut-[1-9][0-9]{0,8}\.cube$/`), `sha256` `/^[0-9a-f]{64}$/`, `size` an
  integer 2..65, `title` a string, cut to 80 characters with C0, C1 and bidi controls
  (U+202A–202E, U+2066–2069) removed; otherwise `lut` is dropped. `exposure` on a screen grade is
  dropped. `auto.camera`: a readable grade or null. A grade with no keys: undefined.
- **`readChapterBar`** (`src/shared/render/chapterBarData.ts`, new). `show` must be a boolean, else
  undefined. Other fields: unknown values read as the defaults (`'auto'`, `'float'`, `'current'`);
  `onlyAtChapters` must be a boolean.
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
  damaged value draws as if absent and the file is left as it was. `calloutOf` reads `pin` (finite,
  clamped to −1..2 like spotlights), `body` (finite, clamped to −1..1), `numbering` (`'1'`, `'A'` or
  a language code whose `nativeNumbering` is not Latin, `words.ts:237`), `startAt` (an integer
  1..999), and a badge's own text cut to its first 3 graphemes (`Intl.Segmenter`).
- **`effects.badgesByChapter`**: a boolean, else read as absent.
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

`effects` is spread (`:193`), so `effects.calm` and `effects.badgesByChapter` pass through; `audio`
is spread (`migrateAudio`, `:49`), so `music.library` passes through. Shapes, spotlights and title
cards go through their readers as today.

### 4.4 Old projects and settings load, draw, sound and save unchanged

- No reader adds a key: each returns undefined for absent input (§19.1 test 1).
- Each drawing step of this wave is reached through a guard that returns at once without its field:
  `joinAt` returns null without `joins`; `punchAt` returns 1; `drawMagnifierLayer` returns when no
  spotlight has `magnify`; the callout code is reached only when `enter` or `exit` is set or the
  style is `badge` or `bubble`; `drawChapterBar` returns without `chapterBar.show`; `gradeScreen`
  and `gradeCamera` return their input without a grade, and no WebGL context is made;
  `editingFontIds` returns no ids. The frame's call log for every fixture of
  `tests/fixtures/vertical-old-projects.json` and `tests/fixtures/wave8-old-projects.json` (phase B)
  equals the log taken before the contracts step (§19.2).
- `textArea` (`src/shared/render/safeZones.ts:95`) changes only with `chapterBar.show`.
- The audio graph strings of a job without `effects`, `bed` or a looped Opus or M4A file are
  unchanged character for character (`audioPlan` tests). With §0 decision 2, a job that loops an
  Opus or M4A file reads its decoded copy instead (§10.4); the graph around it is unchanged.
- Prefs: no new pref keys. Settings › Downloads stores what is downloaded in a new file
  (`userData/sound-library/library.json`); an app without it shows nothing downloaded.

### 4.5 An older Flown opening a newer project

Older readers rebuild shapes, spotlights and title cards from known fields, so they drop motions,
sounds and `magnify` on save: a magnifier becomes a plain spotlight with no dimming (invisible).
Annotations keep their raw fields; an older Flown draws a badge or bubble's text as a *Title* at its
`x`, `y`. Those are kept up to date: adding, dragging or nudging a pinned badge or bubble also writes
where it shows in the frame at its start, so the older drawing lands near it. `joins`, `grade`,
`chapterBar` and `soundFx` pass through `...rest` untouched and are ignored. `Graphic.sound =
'sfx:…'` is dropped by the older reader. This is the same degradation earlier waves accepted.

### 4.6 Versions, Duplicate and project files

- **Versions** (`src/shared/editor/versions.ts` on `rev/versions`): `AREAS` gains `{ name: 'smooth
  cuts', keys: ['joins'] }`, `{ name: 'colour', keys: ['grade'] }`, `{ name: 'progress bar', keys:
  ['chapterBar'] }`, and the `sound` area's keys become `['audio', 'soundFx']`. Magnifiers are
  spotlights, counted and compared under "shapes and spotlights". `namedFiles` adds each grade's
  `lut.file` as `'colour LUT'`. A restored version whose LUT or music file was pruned shows the
  versions branch's "is no longer in the project folder" line; a library bed is copied again from
  the catalogue when it is missing (§10.3). Versions never keep `.cache/`.
- **Duplicate and Make a vertical version** (`src/shared/editor/duplicate.ts`,
  `src/main/projectCopy.ts`): the new fields copy as they are; clip ids are kept, so `joins.cuts`
  still points at the right clips. Pins are in recording coordinates and bubble bodies in units of
  S, so `refitItems` leaves them as they are (it moves `x` and `y` as today). A progress bar on
  *Auto* finds its edge again in the tall copy. `.cache/` is not copied.
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
2. **Smooth** becomes Punch-in (with its `scale`) when A's end and B's start are both camera-led
   (the terms list; A's side at `A.end − 1e-6`, B's at `B.start`), else Crossfade (with its
   `duration`). A cut from a camera-large clip to a bubble-layout clip therefore gets a crossfade.
3. Lengths, with `len(X) = (X.end − X.start) / X.speed` (edit seconds):
   - Crossfade and Slide: `d = min(duration ?? default, len(B) / 2)`.
   - Dip: half-length `h = min((duration ?? 0.5) / 2, len(A) / 2, len(B) / 2)`.
   - A Crossfade or Slide with `d < 2/30` s, or a Dip with `2h < 2/30` s, is a hard cut (it would
     last less than two frames at 30 fps).
4. Calm motion (`effects.calm`): Slide becomes Crossfade, with `d = min(d, 0.5)`.
5. **Flash rule** (always on): walking the cuts in order, a Dip whose T is less than 1.0 s of video
   time after the T of the last cut drawn as a Dip is drawn as Crossfade with
   `d = min(0.15, len(B) / 2)`. A full-frame dip to black or white is a general flash (WCAG 2.3.1:
   "a pair of opposing changes in relative luminance of 10% or more"); one a second stays well under
   the three a second WCAG allows.

| Kind | Default | Range | Window | Needs A\* |
|---|---|---|---|---|
| Crossfade | 0.15 s | 0.05–0.5 s | [T, T + d) | yes |
| Dip to colour | 0.5 s (0.25 s each side) | 0.2–1.2 s | [T − h, T + h) | no |
| Slide | 0.4 s | 0.25–0.7 s | [T, T + d) | yes |
| Punch-in | scale 1.10 | 1.05–1.20 | the whole of B | no |
| Smooth | one of Crossfade and Punch-in, per cut | as those | as those | as those |

Why these numbers: a still screen's small jump hides in 4–5 frames (0.15 s at 30 fps); Material's
guidance is that transitions over 0.4 s feel slow, and full-screen ones go up to 0.375 s; editors
report that a centred dip spends half its length on the colour, so 0.5 s gives 0.25 s each way.

### 5.3 A\*, the outgoing still

A\* is A's last kept frame of the screen and of the camera, composed as the frame's picture (§5.6).
Which frame that is comes from each track's own frame times and the export decoder's own rule, so
preview and export pick the same frame at any output rate and for any proxy rate.

- **Frame times.** Each proxy's frames come from its sample table: `openTrack(url)`
  (`src/renderer/src/render/frameSource.ts:28`) gives the samples' presentation times. The export
  already opens both tracks (`openSource`, `exporter.ts:380`); the preview's `JoinStills` opens them
  too, once per editor session (it reads the MP4 index by range, not the media). Real proxies run at
  the capture's rate (30 or 60), an import's own rate (24, 25, 29.97…) or the camera's
  (`manifest.webcamFps`, often 60), so no rate is assumed. When a track cannot be indexed, preview
  and export both fall back to the rates `openSource` falls back to (`media.ts:8-9`: 60 for the
  screen, 30 for the camera).
- **The instant.** The screen's is `u = A.end − 1e-6`; the camera's is `A.end − webcamOffset −
  1e-6` (none when the camera does not show at A's end). When a continue freeze holds A's end, the
  screen's instant is the freeze's picture time `p = pictureTime(clips, plan, A.end − 1e-6)`
  (`freeze.ts:326`).
- **The frame k\*.** Normally the frame that holds u: the last frame, in presentation order, that
  starts at or before u, and never before the frame that holds `A.start`. Its start lies inside A,
  so its content was kept. Under a continue freeze, the frame the freeze itself shows: the decoder's
  rule at p.
- **Asking for it.** `askTime(k) = start(k) − h + 1e-6`, where h is half the track's median frame
  duration (`frameDuration`, `frameTiming.ts:4`). `presentationIndex` (`mp4.ts:271`) picks the last
  frame that starts at or before `t + h`, which is k. The element path's `frameIndexAt`
  (`frameTiming.ts:20`) gives k on a constant-rate track too.

**Why the rule matters.** The export does not pick the frame that covers a time; it picks the
nearest one. `planFeed` asks `presentationIndex(order, t, frame / 2)` (`feedPlan.ts:25`) and
`frameIndexAt` adds 0.5. So A's last output frame may already have asked for k\* + 1, the frame that
starts just after `A.end` (by less than half a frame, as today's exports already show it). A still
asked for after that would go back a frame, and `DecoderFrameSource.get` would throw "The video
decoder skipped a frame" (`frameSource.ts:174`), sending the rest of the export to the slow seeking
path. The engineering review estimated that the first version's fixed formulas would hit about a
quarter of cuts at 30 fps output and half at 60 fps. §5.8 therefore inserts each still where its
frame falls in the feed.

A\* is drawn once at `t = p` (or u), `soundTime = A.end − 1e-6`, with `blurSamples: 1`, from the
screen frame k\* and the camera frame k\*. It is sharp, as every frozen frame is (`exporter.ts:492`).
Every privacy shape active at u (with the half-frame slack of `shapesLayer.ts:37`) covers it. No
frame from inside a cut is decoded for drawing that today's export does not already show.

### 5.4 Windows and progress

`joinPlan(project)` returns the windows of every cut with a Crossfade, Slide or Dip join, in order:
`{ index, clip, kind, from, to, at: T, still: { screen: number; held: boolean; camera: number | null
} | null, color?, dir? }`, where `screen` and `camera` are the instants of §5.3 and `held` says the
screen's comes from a continue freeze. It is memoised on the identity of `clips`, `joins`,
`freezes`, `effects`, `layouts`, `webcam` and `webcamOffset`. `stillFrame(track, instant, held,
aStart)` turns an instant into `{ index: k*, ask: askTime(k*) }` on a track's frame times.
`joinAt(windows, v)` finds the window holding video time v by binary search (O(log n)) and returns
it with its progress `p`: `(v − T) / d` for Crossfade and Slide, `(v − (T − h)) / 2h` for a Dip.

Windows never overlap. A Crossfade or Slide window of cut i ends by `T_i + len(B_i) / 2`. Any window
of cut i + 1 starts no earlier than `T_{i+1} − len(B_i) / 2 ≥ T_i + len(B_i) / 2`, since
`T_{i+1} ≥ T_i + len(B_i)` (holds inside B only add time). A Dip's first half is bounded by
`len(A) / 2` the same way. So at most one A\* is needed at a time.

`punchAt(project, t)`: walking the clips once (memoised), a state `on` starts false; at each clip
that follows a cut, `on` becomes `!on` if that cut's join resolves to Punch-in (its own, or Smooth's),
else false; a clip that touches the one before (a speed split) keeps it. The clip holding source
time t is drawn at `scale` (1.10 by default) while `on`, else 1. A pause hold shows its held frame's
clip.

### 5.5 Poses

For a w × h frame, with `e = cubicBezier(0.2, 0, 0, 1)(p)` (Material's standard easing,
`src/shared/engine/easing.ts:11`):

| Kind | B (live picture) | A\* | Colour |
|---|---|---|---|
| Crossfade | as drawn | drawn over B at α = 1 − p (linear, as NLE dissolves and the cut fades are) | none |
| Slide, from right | moved by dx = w · (1 − e) | moved by dx = −w · e, α 1 | none |
| Slide, from left / top / bottom | dx = −w · (1 − e) / dy = −h · (1 − e) / dy = h · (1 − e) | dx = w · e / dy = h · e / dy = −h · e | none |
| Dip | A's live frames before T, B's after | none | a full-frame fill of the colour at α = 2p while p < 0.5, then 2 − 2p |
| Punch-in | the content shown closer by s for all of B (§5.6); the background, card, shadows and the camera's box never move | none | none |

The two slide pictures cover the frame together, edge to edge, and the canvas is opaque
(`alpha: false`), so no gap shows.

### 5.6 Drawing (`drawFrame`, `src/renderer/src/render/compositor.ts:87`)

`drawFrame` is split into two exported halves with no change in what it draws:

- `drawFramePicture(...)`: today's lines from the background (`:141`) through `drawWebcamLayer`
  (`:225`). It returns the top frame context.
- `drawFrameOverlays(top, soundTime, video)`: image overlays, `noteStudioFrame`, key presses, texts,
  graphics, captions, title cards, the progress bar (§8) and the watermark, in today's order.

`drawFrame` gets one optional last parameter:

```ts
export interface FrameExtras {
  /** Video seconds of this frame (holds included). Absent: videoTimeAt(soundTime) (wrong only inside a pause hold). */
  video?: number
  /** The join this frame is in (joinAt) and A* as composed (composeJoinStill); a null still draws a hard cut. */
  join?: { at: JoinAt; still: CanvasImageSource | null } | null
}
```

**Punch-in scales the content, not the composition.** `punchedCamera(cam, project, t)` (joins.ts)
returns `{ ...cam, scale: cam.scale · s }` with `s = punchAt(project, t)`, keeping the camera's
centre, or `cam` itself when s is 1 or the layout at t is camera-led or side-by-side. Inside
`drawFramePicture`:

- The screen: every camera the frame uses goes through `punchedCamera`: the frame's camera from
  `frameView`, before the frame context `fc` is built (so `toOut` and every layer that maps through
  it, shapes, spotlights, magnifiers, cursor, follow), and the motion-blur sub-frames' cameras
  (`shutterCameras`, `shapesLayer.ts:66`). Zooming in about the camera's own centre never shows
  outside the recording.
- The camera, in a camera-led or side-by-side layout: the framing zoom is multiplied instead
  (`look.zoom · s` in `webcamLayer.ts:104`, which `cameraSourceRect` clamps to 3), about the face
  framing's centre (`cropX`, `cropY`). The screen is not punched then.
- Never scaled: the background, the card's geometry, padding and corners, shadows, the camera's box,
  and the bubble's shape and position.

`PreviewStage.tsx` places shape, spotlight, magnifier and callout handles with `frameCamera`
(`:134`, `:360`, `:824`); each call goes through `punchedCamera` too, so handles sit on what is
drawn (P1, §17.1).

`drawFrame` draws:

1. With a Slide, `ctx.translate` by B's offset.
2. `drawFramePicture` for B, as today, with the punch inside it.
3. The join: A\* with its α and offset (Crossfade, Slide), or the Dip's fill.
4. `drawFrameOverlays`, once, for B's time: captions, texts, titles and graphics are never faded,
   moved or doubled by a join.

**Composing A\*.** `composeJoinStill(scratch, out, w, h, window, scene, stills, background)`
(`joinLayer.ts`) draws A\* with `drawFramePicture`, under A's own punch, onto `scratch`, one fixed
target per raster mode (one in the preview, one in the export, CPU when the export canvas is), then
copies it with one `drawImage` into `out`, a plain canvas of the frame's size that no layer ever
draws on. Every layer keeps per-target state in WeakMaps keyed by the target's context:
`cropCopies` and `rgbCopies` (`compositor.ts:241`, `:268`), the grade copies, the tilt layer's card
canvas and its own WebGL context, the camera's blur canvases, the spotlight layer's canvas
(`spotlightLayer.ts:105`). One scratch target means one set of them, whatever the number of cuts.
The `out` canvases are kept by `${clip}|${w}x${h}` and the project's identity: at most 2 in the
export, 4 in the preview. When `JoinStills` or the export ends, it calls `releaseTilt(scratch)`
(`tiltLayer.ts:210`) and `releaseGrade(scratch)` and drops the scratch canvas.

**Background blur on the camera.** A\*'s camera frame needs its person mask like any other frame,
or the blurred room would show for 0.15 s. The export prepares it with `masks.prepare` before
composing, as it does for every frame (`exporter.ts:517`). The preview segments the still with the
camera's segmenter; the still counts as ready only when its mask is. Where segmentation failed for
the session, live frames are drawn unblurred today, and A\* is the same.

### 5.7 Preview (`src/renderer/src/editor/player.ts`)

- **Stills.** `JoinStills` (new) holds two `FreezeStills` (`freezeStills.ts:12`), one on the screen
  proxy and one on the camera proxy, and each track's frame times (§5.3). It asks for frame k\* at
  `askTime(k*)` through the export's own seek path (`seekToFrame`, `seekedFrame`, `media.ts:100`,
  `:116`) at the track's own rate (1 / its median frame duration), so the preview lands on the same
  frame the export copies.
- **Composed ahead.** When a window's stills (and the camera's mask) are ready, A\* is composed at
  once, in a task of its own outside the frame callback. The frame that starts the window then only
  draws it (+1.05 ms at 1080p), instead of composing it (about 8.8 ms) on that frame.
- **Video time.** The player passes the frame's video time: inside a hold `h.start + elapsed`;
  otherwise `editToVideo(plan, o)`, plus the length of a hold at exactly `o` once the player has
  left it (`frameVideoTime`, joins.ts). Without that, the first live frame after a hold at T would
  read as T and show A\* again for a frame.
- **Ahead of time.** At play and after every jump, the windows of the next three cuts after the
  playhead ask for their stills. FreezeStills already makes the stills of freezes ahead this way.
- **Not ready yet.** Paused, or after a seek into a window, the still is asked for; until it is
  ready the preview draws B alone (a hard cut) and redraws when it is, as the continue-freeze
  preview does today. While playing, a window whose A\* was not ready at its first frame stays a
  hard cut until it ends, so the old frame never flashes back after B has shown.
- **Made again.** Each A\* keeps what it was drawn with: the project, Compare, and each grade's LUT
  as `lutFor` gave it (null while it loads). When one of them differs from the frame's (an edit,
  Compare turned on or off, a LUT that became ready), it is composed again. After an edit that A\*
  is not drawn, and the frame is "not ready yet" until then. After Compare or a LUT only, it is
  still drawn, in its old colours, until the new one is ready (a frame or two), so a window that
  has shown A\* never shows B alone and then A\* again.
- **Seeking at the jump.** At a cut the player seeks the `<video>` (`jumpTo`, `player.ts:572`);
  the first frame of B is drawn with A\* at α ≈ 1, which also hides the jump's seek latency.
- **Play this cut** plays from `T − 1` to `T + 1` s of video time and stops back where it started.

### 5.8 Export (`src/renderer/src/editor/exporter.ts`)

- `planJob` (`:260`) adds `joinPlan(project)`.
- After `openTrack` of each source, `joinFeed(input)` (pure, joins.ts) builds the feeds, with
  `input = { pictures, cameraTimes, windows, fps, screen: TrackTimes, camera: TrackTimes | null }`
  and `TrackTimes = { starts: Float64Array; half: number }` (the presentation-ordered frame starts,
  or a constant-rate grid from the fallback rate):
  - Each window with a still has a screen entry `askTime(k*)` and, with a camera, a camera entry.
  - Each entry goes into its own feed at its sorted position by presentation index: right before the
    first entry whose index is greater than k\*. That can be before some of A's last output frames,
    wherever the feed first reaches k\*. When an entry with index k\* already exists (an output
    frame of A asked for it), the still shares that entry and nothing is inserted.
  - So each feed's indices never decrease, and the decoder's skip rule never fires. `planFeed`
    already allows repeats; a shared frame is decoded once.
  - It returns `{ screen: number[]; camera: number[]; draw: { screen: Int32Array; camera: Int32Array
    }; stills: { window: number; screen: number; camera: number | null }[] }`: the feeds, the
    position each output frame draws from, and each still's positions.
  - A window with no output frame (a short one in a 10 fps GIF) adds no still. A still whose frame
    the feed only reaches after the window's first output frame (a cut shorter than half a frame)
    makes that window a hard cut.
- `openSource` (`:380`) gets the feeds instead of `pictures` and `times − offset`; the element
  fallback (`ResilientFrameSource`) gets the same feeds, so it seeks the same frames.
- The loop drives each source through its whole feed in order. At a still's position it gets the
  frame and copies it into a still canvas with one `drawImage` (§3.2 row 10), then calls `next()`.
  When a window's screen and camera copies both exist, it prepares the camera mask, composes A\* on
  the scratch target into an `out` canvas, and drops the copies. A\* waits there until the window's
  first output frame `i0 = ⌈T · fps − 1e-9⌉`.
- Every output frame inside a window draws its join, also when no window has a still: a project
  whose cuts are all dips has no A\*, and each dip still draws its colour.
- Thumbnails (`renderThumbnail`, `:583`) and the contrast probe never draw a join.
- The export dialog's preview (`ExportPreview.tsx:99`) uses its own `JoinStills`.

### 5.9 Freezes, speed, transitions and other layers

- **A pause freeze at B's start**: T is the hold's start, so the window runs over the held frame of
  B (the clocks hold, video time runs). The export draws it at `i / fps`; the preview from the hold's
  elapsed time.
- **A continue freeze covering A's end**: A\* is the frame that freeze shows (§5.3).
- **Speed**: d is in video seconds, the same at any clip speed; lengths are in edit seconds.
- **Layout and zoom transitions** run in source time and are cut through, as today
  (`LAYOUT_TRANSITION` 0.4, `ZOOM_TRANSITION` 0.7). A\* carries A's layout and camera, so a
  crossfade blends the two framings.
- **Motion blur**: B as always; A\* is sharp.
- **Tilt, device frames, magnifiers, privacy, cursor, shapes, spotlights, camera**: all part of the
  picture, so A\* has them as they were at A's end.

### 5.10 Sound

Unchanged. Every cut keeps its 10 ms linear fade out and in (`CUT_FADE`, `cutFades.ts:11`), in the
export's graph (`audioPlan.ts:233-245`) and the preview's `cut` gain (`previewAudio.ts:669-697`).
Speech carries the content of a tutorial, NLE video transitions leave the sound alone, and every
longer or overlapping fade would play removed words. Music runs on through cuts as today.

### 5.11 Preview equals export, at any fps and after any seek

`joinPlan`, `joinAt`, `punchAt`, `punchedCamera`, the poses and the still instants are pure
functions of the project and the video time. Which frame A\* is depends on A's end and the tracks'
own frame times, read by preview and export from the same files with the same rule. The export draws
video time `i / fps`; the preview draws the video time of the frame it shows, through holds. Seeking
into the middle of a window draws the same frame as playing into it.

### 5.12 Cost

Measured on the reference rig (CPU raster, Electron 44.9.3): a second full-frame draw at an alpha
costs +1.05 ms per frame at 1080p and +23 ms at 4K; a full-frame fill at an alpha +0.5 ms and +3 ms.
Composing A\* costs one picture draw, about 8.8 ms at 1080p and 21.9 ms at 4K, plus one full-frame
copy; the export also copies the two still frames (one full-frame draw each). All of it once per
cut, never inside the frame that starts the window. A\* takes 8 MB at 1080p and 33 MB at 4K. Punch-in
changes a camera's scale and costs nothing measurable. The budget is in §15.

---

## 6. Magnifier

### 6.1 Data

A magnifier is a `Spotlight` with `magnify` (1.5..4). *Add magnifier* makes one with
`mode: 'region'` (or `'cursor'`), `shape: 'ellipse'`, `dim: 0`, `feather: 0`, 3 s long from the
playhead, 0.30 S across in the view at the playhead: `w = 0.30 S / (rect.w · cam.scale)`,
`h = 0.30 S / (rect.h · cam.scale)` (normalised to the whole recording, like every spotlight). Its
box is the lens itself, so the preview's handles, snapping, the camera director's corners and crop
and reframe all treat it as what is drawn.

- **Where.** Centred on the visible cursor at the playhead (`visibleCursorAt`) when it shows and lies
  inside the view; otherwise on the view's centre.
- **How much.** With `ppr = rect.w · cam.scale / project.width`, the output pixels per recorded pixel
  at the playhead, `magnify` is the largest step of 0.25 in 1.5..2.5 with `magnify · ppr ≤ 2`, or
  1.5 when none fits. A recording shown 1:1 gets 2×; a 1080p recording in a card at 85 % gets
  2.25×; a 4K recording in a 1080p export gets 2.5×.

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
3. With `lens = { ...fc, cam: lensCam, toOut: toOutput(rect, lensCam), options: { ...fc.options,
   blurSamples: 1 } }`, draw `drawPrivacyLayer(lens)` and `drawCursorLayer(lens)`. There is no
   shutter inside the lens, so a privacy box is never swept with cameras of another scale
   (`shutterCameras` would otherwise return the frame's cameras). Blurred and pixelated areas stay
   hidden at any zoom; the cursor and click effects are magnified as a zoom would show them, so in
   cursor mode the magnified pointer tip sits at the lens's centre.
4. Restore. Ring: white, width `max(2 px, 0.004 S)`, then a 1 px black line at α 0.25 just outside
   it, so the lens shows on white pages too.

Everything at the magnifier's α. **Darkness** is drawn by `drawSpotlightLayer` after the shapes,
with one change (P2): for a spotlight with `magnify`, the lit area and its alpha come from
`magnifierPhase`: the lens's box scaled by r about its centre, with no feather, at α. So the
dimming grows and shrinks with the lens and no ring of bright, unmagnified screen shows around it.
The order is privacy, cursor, magnifiers, shapes, then spotlight dimming: arrows and boxes stay
visible over a lens, and a lens stays bright inside a dimmed screen.

- **Tilt**: on `c`, so the lens tilts with the card, like spotlights.
- **Following** (tall frames): `viewSource` clips to the slot, as the card does.
- **Motion blur**: the lens is drawn with the frame's camera only, sharp.
- **Inside a zoom**: z multiplies the zoom. When `ppr · z` passes 2.5 at the item's start, the panel
  says: "Shown larger than the recording's pixels: it may look soft."
- **Crop**: `fc.screen` is the crop's copy, so nothing outside the crop is sampled.
- **Punch-in**: the lens follows the punched camera like every layer that maps through `fc`.
- **Smooth cuts**: A\* includes the magnifier as it was at A's end.
- **Names**: `spotlightName(s)` and `spotlightIcon(s)` (magnifier.ts) give the timeline block, its
  tooltip and accessible name: "Magnifier, 2 times" with a magnifying-glass icon, or today's
  spotlight name and icon.

Cost, measured: +1.9 ms per frame at 1080p and +9 ms at 4K for a shadowed disc, a clipped 2× draw
and the ring. Privacy shapes and the cursor inside the lens cost what they cost outside it.

---

## 7. Animated callouts

### 7.1 One motion engine

`calloutPose(start, end, t, clips, enter, exit, u, calm, oldFade)` (`src/shared/render/callouts.ts`)
returns Captions Studio's `ChunkPose` (`motion.ts:100`: alpha, dx, dy, scale, scaleX, rotate, blur,
reveal) plus `drawn` (0..1), or null outside the item.

- The kinds of `ItemMotion` go through `itemPose` (`motion.ts:841`) unchanged: viewing time, each
  side at most half the item, Calm clamps, exits play the kind backwards with inCubic.
- `'draw'` (enter only): `drawn = 1 − (1 − p)³`, α 1.
- `'wipe'` (enter only): `reveal = emphDecel(p)`, from the reading start.
- `u` is the item's em: the font px for texts and titles, `min(box w, box h)` in px for shapes.
- An item with `enter` and no `exit` disappears with a fade of its old length (0.15 s for texts and
  shapes, 0.35 s for titles), and the other way round.

What each item allows (the reader drops anything else; `'blur'` never, `'draw'` and `'wipe'` only on
enter), and the motion a new item gets:

| Item | Enter kinds | Exit kinds | Default (enter / exit), written into new items |
|---|---|---|---|
| Text: pill, title | fade, pop, rise, drop, slide-left, slide-right, grow, typewriter, wipe | fade, pop, rise, slide-left, slide-right, grow | rise 0.25 s, strength 1 / fade 0.18 s (when picked; new texts get none) |
| Step badge | fade, pop, rise, drop, grow | fade, pop, grow | pop 0.24 s / fade 0.18 s |
| Speech bubble | fade, pop, rise, grow, typewriter | fade, pop, grow | pop 0.26 s from the tail's tip / pop 0.18 s at strength 0.25 (scale 1 → 0.9 toward the tip) |
| Arrow, line | draw, fade, pop, grow | fade, pop, grow | draw 0.35 s / fade 0.18 s |
| Rectangle, ellipse | draw, fade, pop, grow | fade, pop, grow | draw 0.45 s / fade 0.18 s |
| Highlight | wipe, fade | fade | wipe 0.28 s / fade 0.18 s |
| Blur, pixelate | none | none | never animated (`isPrivacyKind`) |
| Title card | fade, pop, rise, slide-left, slide-right, grow, typewriter, wipe | fade, pop, rise, grow | rise 0.35 s / fade 0.35 s (when picked; new cards get none) |

Exits are never longer than entrances in the defaults (Material: exits shorter than entrances).

**New items.** `addBadge`, `addBubble` (calloutsEdit.ts) and `addShapeAt`
(`src/renderer/src/editor/playheadItems.ts:77`, through `withDefaultMotion(shape)`) write the
defaults above into new badges, bubbles, arrows, lines, rectangles, ellipses and highlights. A new
shape still starts so that it is fully shown at the playhead (`shapeForPlayhead`), now one enter
motion earlier instead of one fade. A new badge or bubble starts one entrance of viewing time
before the playhead, each clip at its own speed (a faster chapter's first badge still has its
entrance end on the chapter's start), and never before a cut. Old items are never given a motion.

**Several items.** `GROUP_FIELDS` (`groupEdit.ts:165`) gains `text.enter`, `text.exit`,
`text.sound`, `mark.enter`, `mark.exit`, `mark.sound`, `title.enter`, `title.exit` and
`title.sound`. Each is a select offering the kinds every selected item allows (the intersection of
the table's rows, plus *Default*), and each change is one update. *Copy look* carries `enter`, `exit`,
`sound`, `color` and `numbering`.

### 7.2 Drawing

- **Texts** (`drawAnnotations`, `src/renderer/src/render/textOverlays.ts:16`). An annotation without
  `enter`, `exit` and a new style is drawn by today's lines, untouched. Otherwise: the box is
  measured as today (`annotationMetrics`, extended for badges and bubbles), then `translate(cx + dx,
  cy + dy)`, `scale(scale · scaleX, scale)` about the box's centre (a bubble about its tail's tip),
  `globalAlpha = alpha`, and with `reveal < 1` a clip from the reading start (the right edge for
  right-to-left text) to `reveal · boxW`. Typewriter reveals whole graphemes through
  `typewriterClip` (`motion.ts:983`), with the prefix advances measured once per text and font.
- **Title cards** (`drawTitleCardsLayer`): Wipe clips the card (with a lower third's band or a
  quote's panel) from its reading start, the right edge when the card's first letter is from a
  right-to-left script. Typewriter keeps the band, panel and quote mark whole and types the lines,
  the title's and then the subtitle's, by whole graphemes in reading order (`typewriterWidths`),
  each line clipped from its text's own reading start: the title and the subtitle each take the
  direction of their own first letter, so an English name over an Arabic role types the role from
  its right edge. While it types, the lines are drawn as they come rather than from the card's
  cached picture.
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

The contracts put the branches into `textOverlays.ts`, `shapesLayer.ts` and `titleCardLayer.ts`;
the code they call lives in P3's new `calloutLayer.ts` (§17.3).

### 7.3 Step badges

- Font px `f = size · S` (default `size` 0.045, so 49 px at 1080p, the caption default), weight 700.
- One grapheme: a circle `D = 1.75 f` across (85 px at 1080p, 0.079 S). Two graphemes: the font at
  `0.85 f` in the same circle. Three: a pill `1.75 f` high and `text width + 0.9 f` wide. Graphemes
  are counted with `Intl.Segmenter`, so a Bangla conjunct or an emoji with a skin tone is one.
- White ring `0.004 S` wide; shadow `offsetY 0.004 S`, `blur 0.012 S`, black α 0.35.
- Fill `color ?? #0060df` (a new badge is written with the brand kit's first colour when there is
  one). The label is white or #111111, whichever has the higher contrast with the fill
  (`contrastRatio`, `src/shared/captions/colors.ts:39`). #0060df gives white 5.61:1.
- **Where**: with a `pin`, centred on `top.toOut(pin)`, the frame's camera (punch included), in
  `drawFrameOverlays`; while that point is outside the visible picture (outside the card's slot, or
  a layout that hides the screen), the badge is not drawn. Without a pin, at `x`, `y` in the frame.
  The preview's handles, Ctrl/Shift+click on the paused preview and a group's outlines find a badge
  or a bubble where it is drawn (`calloutPlace`, a bubble by its body); a badge that is not drawn
  has no box there.
- **Numbering** (`badgeLabels(project)`, memoised on `annotations`, `chapters`, `clips` and
  `effects`): badges with `number: 'auto'`, sorted by `(start, id)`, get k = 1, 2, 3… The count
  starts again at 1 at each chapter's start (output time, `outputChapters`) unless
  `effects.badgesByChapter === false` or the project has fewer than two chapters. A badge counts in
  the chapter where its entrance has finished (its start plus its entrance in viewing time, at most
  half the badge; no entrance: today's 0.15 s fade), so a badge added at a chapter's start, which
  pops in just before the playhead, counts in that chapter; within a chapter the order stays
  `(start, id)`. A badge with
  `startAt` shows that number and the next counts on from it. Badges with their own text do not
  count, nor do badges a cut removes whole (no kept moment: the video never shows them, so they
  get no number and the steps seen go 1, 2, 3 without a gap).
- **Digits**: `'1'` Western; `'A'` A–Z, then AA, AB…; a language code: `withDigits(String(k),
  'native', code)` (`src/shared/captions/words.ts:259`), so `'bn'` gives ১ ২ ৩. *Count with* always
  offers Bangla digits, and the digits of the caption and transcript languages when they have their
  own. A new badge gets `'bn'` when the caption or transcript language is Bangla.
- Badges number by time, not by drawing order, so seeking, preview and export agree.

### 7.4 Speech bubbles

- Text px `f = size · S` (default `size` 0.045), weight 600.
- Body padding `0.45 f` top and bottom, `0.7 f` left and right; corner radius
  `min(0.5 · body height, 0.6 f)`; at most `0.42 w` wide in a wide frame and `0.8 w` in a tall one.
- **Wrapping**: greedy by words (`Intl.Segmenter`, word granularity) to the maximum width; text
  without spaces wraps between graphemes, never inside one, so a Bangla conjunct or a vowel sign
  stays with its letter. Line height 1.3, or 1.4 when the text has Bengali, Devanagari or Thai
  (`scriptScale`, `src/shared/captions/fontStack.ts:194`).
- **Where**: the tip is `top.toOut(pin)`; the body's centre is `tip + body · S`, then moved by the
  least amount that keeps the whole body inside the text area (`textArea`, so captions, the safe
  zones and the progress bar's band are respected). The body therefore stays on screen near its
  tail while the camera zooms. While the tip is outside the visible picture, the tail is left out
  and the body keeps its last clamped place relative to the frame.
- **Tail**: on the body edge nearest the tip; base `clamp(0.6 f, ≤ 0.15 × that edge)` wide and at
  least the corner radius from the corners; length clamped to 0.5–3 f toward the tip. No tail when
  the tip is inside the body or closer than 0.5 f.
- One path for body and tail (`bubblePath`, moved from `studioLayer.ts:1079` to
  `src/renderer/src/render/bubblePath.ts` and shared with Captions Studio's Speech Bubble look,
  whose drawing does not change), so the shadow and the edge join without a seam.
- Fill `color ?? #ffffff`; text #111111 or white by contrast (#ffffff: 18.9:1); shadow
  `offsetY 0.006 S`, `blur 0.02 S`, black α 0.25. A fill whose luminance is above 0.7 (white,
  light brand colours) also gets a 1 px outline, black α 0.15, along the same path, so the bubble
  shows on white app pages.
- Right-to-left text (first strong character Arabic or Hebrew, `RTL_FIRST`) is drawn with
  `direction = 'rtl'` and right-aligned.
- **Adding** (`addBubble`): with the cursor showing at the playhead (`cursorPosFor`,
  `playheadItems.ts:38`), `pin` is the pointer's tip and `body = (±0.12, −0.10)`, the sign of dx
  toward the frame's centre; otherwise `pin` is the view's centre. The text field then takes focus.

### 7.5 Calm motion

`effects.calm` (Effects tab: "Calm motion: texts, shapes, the magnifier and slide cuts move less.
Captions have their own setting in the Captions tab.") applies Captions Studio's calm clamps to every
callout (§9.5 there: scale 0.96–1.04, movement at most 0.15 em, no rotation or overshoot, pop and
drop become grow, durations at least 0.2 s), turns Draw into a fade, turns Slide cuts into
crossfades (§5.2) and the magnifier's growth into a fade (§6.2). Typewriter and Wipe stay. As in
Captions Studio, it is never written from Windows' animation setting: the same project exports the
same motion on every PC.

### 7.6 Fonts

Pill and title texts keep today's font stack, so old projects draw as before. Badges, bubbles and
progress-bar names use the bundled script fonts of Captions Studio (Noto Sans Bengali, Devanagari,
Arabic, Hebrew and Thai, and the colour emoji font: `CATALOG_FALLBACK`, `titleCardLayer.ts:27`).
Badges and bubbles use `projectFontStack(project, a.font, CALLOUT_FONT)`, where `CALLOUT_FONT` is
`ANNOTATION_FONT` followed by `CATALOG_FALLBACK`; bar names use `cardFont` (`titleCardLayer.ts:37`).
The contracts export both from `titleCardLayer.ts`.

They must be loaded before the export's first frame. `editingFontIds(project)`
(`src/shared/render/editingFonts.ts`, written in full by the contracts) returns the
`CATALOG_FALLBACK` ids when any annotation has style `'badge'` or `'bubble'`, or the progress bar
shows names; `catalogIdsOf` (`src/renderer/src/render/fontLoader.ts:380`) adds them, so
`prepareCaptionFonts` (`exporter.ts:109`) loads them before the first frame and the missing-fonts
list names them. A Bangla bubble therefore draws the same on every PC from frame 0.

### 7.7 Cost

A pose is a few multiplications; a draw-on stroke costs what the stroke costs. Budget: 0.3 ms per
animated item at 1080p, 1 ms at 4K (§15). Bubble lines are laid out once per text, font and width,
cached by content.

---

## 8. Progress bar

`drawChapterBar(fc, video)` (`chapterBarLayer.ts`), between the title cards and the watermark
(`compositor.ts:236-237`), reads `chapterBarLayout(project, w, h, area)` (pure, `chapterBar.ts`).
Users see it as the **Progress bar**; the code keeps the name `chapterBar`.

- **Segments**: `outputChapters(chapters, clips, plan)` (`src/shared/render/chapters.ts:32`; video
  seconds, holds included), plus an unlabelled first segment when the first chapter starts after
  0.1 s, ending at `videoDuration`. With fewer than two chapters: one segment, a plain progress bar.
- **Area**: `R = textAreaWithoutBar(...) ?? the whole frame` (today's `textArea`, renamed and
  exported; see "Room for the bar" below), inset `i = 0.03 S` (32 px at 1080p).
- **Place**: *Auto* is the top, unless the captions show and sit in the top half of the frame
  (`captionsAtTop(project, w, h)`, from the caption placement `textArea` already uses), then the
  bottom. Web players draw their own scrubber at the bottom, and captions sit there by default. In a
  tall frame with app-safe zones on, R is `COMMON_SAFE` (`safeZones.ts:72`), so the bar sits below
  the apps' top buttons.
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
- **Fades**: the bar fades in over 0.3 s from v = 0. With *Show only when a chapter starts*, it
  shows from each segment's start for 3 s, with 0.3 s fades in and out. While a full-frame title
  card shows, the bar's alpha is multiplied by `1 − b`, b being the card's background opacity from
  `titlePhase`, so it fades out and back in with the card and never sits on an intro.
- **Names**: weight 700, white, on a pill of black α 0.55 (padding 0.2 em top and bottom, 0.5 em
  left and right, fully rounded), `0.01 S` from the bar on the inner side. Size: `0.042 S` in wide
  and square frames (45 px at 1080p), `0.036 S` in tall ones (39 px at 1080 × 1920). A 16:9 export
  shown 390 pt wide on a phone held upright draws them at about 9 pt; the first version's 0.03 S gave
  6.5 pt. *Current chapter*: at the current segment's start, moved left so it stays inside the bar,
  crossfading over 0.2 s at a chapter change. *All chapters*: each centred over its segment,
  shortened with an ellipsis by graphemes to the segment's width less 0.4 em, and left out when
  fewer than three graphemes fit. Names are hidden while a Captions Studio chapter-title card
  (`auto.by === 'chapter'`) shows, so a name is not read twice. The font is `cardFont`'s stack
  (§7.6); right-to-left names are drawn right-to-left.
- **Room for the bar**: with `chapterBar.show`, `textArea` (`safeZones.ts:95`) returns
  `textAreaWithoutBar` less a band at the bar's edge of `i + 1.5 th`, plus `0.01 S + 1.4 ·` the name
  size when names are shown (0.111 S in a wide frame, 120 px at 1080p). Captions, key presses, the
  logo and lower thirds, which all place themselves in `textArea`, keep clear of the bar. Without
  the bar nothing changes.
- **Cost**: a few rounded rectangles and at most one text and pill per segment: under 0.5 ms at
  1080p.

---

## 9. Colour correction and looks

### 9.1 Where the grade runs

Each source picture is graded at its own resolution, before it is drawn, as a pure per-pixel
function. The composed frame is never graded: captions, texts, title cards, graphics, the background
wallpaper, image overlays and the watermark keep their colours.

- **Screen** (`compositor.ts:104-107`): right after the crop copy,
  `screen = gradeScreen(ctx, screen, grade.screen, lut, scene.compare)`. The graded picture is what
  `drawView`, the motion-blur sub-frames and `fc.screen` use, so privacy blur and pixelate boxes,
  the magnifier and A\* are graded too. A canvas source skips `rgbCopy` (`:173`), so motion blur
  costs nothing more.
- **Camera** (`webcamLayer.ts:83-107`): the person mask is looked up with the raw frame
  (`maskOf(img)`, `:126`, keyed by image identity), then the picture is graded, then drawn or
  blurred. The blur composite's cache (`drawBlurred`, `:202-264`, keyed today on `b.image !==
  pic.image`) keys on the raw frame's identity plus `gradeKey(grade)`, because the graded canvas is
  reused every frame and its identity never changes.
- **Compare**: `RenderScene.compare` (the preview's toggle) makes both grades return their input.
  The export never sets it.
- Thumbnails, the contrast probe (`contrastProbe.ts:54`) and freeze stills go through `drawFrame`,
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
10. **LUT** (`.cube`), on the encoded values (what creative LUTs expect): a shaper first when the
    file has one (linear interpolation between its entries, after its input range), then the input
    mapped through the file's domain and clamped to 0..1, tetrahedral interpolation, mixed with the
    graded value by `strength`.
11. Clamp to 0..1, round to 8 bits (`round(v · 255)`). No dither: it would make output
    non-deterministic and cost bitrate.

Why not bake everything into one 3D LUT: measured against the exact maths, a 33³ LUT is off by up to
14 of 256 levels for Vivid, 12 for Cinematic, 6 for a strong brightness change and 30 for a strong
warm plus saturation, all where saturation clips at the gamut's edge, a kink a LUT cannot follow.
The exact table plus the shader's cross-channel step has none of that.

### 9.3 Shader, CPU path and parity (`src/renderer/src/render/gradeLayer.ts`)

**One WebGL2 context** for the app (`alpha: false`, `antialias: false`, `preserveDrawingBuffer:
false`), on an `OffscreenCanvas`. Per grade: upload the picture from a 2D canvas copy
(`texImage2D`, `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`, `UNPACK_FLIP_Y_WEBGL = false`, no
premultiply), draw one full-screen triangle, then copy the result in the same task into a 2D canvas
per target and source (screen, camera), as `tiltLayer.ts:318` does. Textures:

| Texture | Format | Size |
|---|---|---|
| The picture | RGBA8, `texelFetch` (no filtering) | the picture's size |
| The per-channel table | RGBA32F, 256 × 1, `texelFetch` | 4 KiB |
| A LUT | RGBA32F 3D, N³, `texelFetch` only (unfiltered float textures are core WebGL2) | 33³: 574,992 bytes; 65³: 4,394,000 bytes (4.2 MiB) |
| A shaper | RGBA32F 2D, 256 × ⌈N1 / 256⌉, entry i at (i mod 256, ⌊i / 256⌋), `texelFetch` | 65,536 entries: 1 MiB, 256 × 256, under WebGL2's guaranteed 2,048 |

With the largest LUT and shaper the textures take 5,442,576 bytes (5.2 MiB).

The fragment shader, in outline:

```glsl
#version 300 es
precision highp float;
uniform sampler2D pic; uniform sampler2D table; uniform highp sampler3D lut; uniform sampler2D shaper;
uniform float S0, vib, kS, kH; uniform vec3 teal; uniform int lutN, shaperN; uniform float lutMix;
uniform vec3 dMin, dScale; uniform float sMin, sScale; uniform int H;
out vec4 o;
void main() {
  // Row 0 of the uploaded texture is the picture's top row; row 0 of gl_FragCoord is the bottom.
  ivec2 at = ivec2(int(gl_FragCoord.x), H - 1 - int(gl_FragCoord.y));
  vec3 e8 = texelFetch(pic, at, 0).rgb;                     // exact k/255
  ivec3 k = ivec3(round(e8 * 255.0));
  vec3 l = vec3(texelFetch(table, ivec2(k.r, 0), 0).r,     // stages 1-6, linear
                texelFetch(table, ivec2(k.g, 0), 0).g,
                texelFetch(table, ivec2(k.b, 0), 0).b);
  // stages 7-9 as §9.2; stage 10: the shaper (two texelFetches per channel, linear), then
  // tetrahedral(lut, (shaped - dMin) * dScale) mixed by lutMix
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
on its Float32 data after the same shaper. `drawImage` into a `willReadFrequently` canvas,
`getImageData`, grade, `putImageData`. When a grade has no cross-channel stage (no saturation,
vibrance, split or LUT), the CPU path is a single 8-bit lookup per channel. Measured end to end in
Electron: 11.5 ms at 720p, 41.9 ms at 1080p and 90.1 ms at 4K with saturation; the pure maths alone
take 6.5 ms (table only) and 17.0 ms (with saturation) at 1080p on one core.

**One backend per session.** `gradeBackend()` decides once, at the first grade: WebGL2 when a
context can be made and a self-test matches `gradePixelsCpu` within one level. The self-test pattern
is 64 × 64, different top to bottom (a vertical ramp under every look, so a flipped picture fails),
with a 17³ LUT and a 1,024-entry shaper. Otherwise the CPU path, for the preview and the export
alike; the panel shows the notice of §2.5, and the log says why ("Colour grading uses the CPU: the
self-test differed in 3,112 values", or "no WebGL2 context"). Since Chrome 139, WebGL is refused on
GPU-blocklisted PCs unless `--enable-unsafe-swiftshader` is set, so those PCs get the CPU path. On
context loss the context is made again; if that fails, the session switches to the CPU path, preview
and export together.

**Never 'display-p3'**: not the 2D canvases' `colorSpace`, not the WebGL drawing buffer nor the
unpack colour space. Exports stay sRGB bytes, tagged BT.709 as today (`exportArgs.ts:20`).

### 9.4 Looks (`src/shared/render/looks.ts`, parameter sets, 0 bytes)

| Look | Parameters | Offered for |
|---|---|---|
| Natural | contrast 0.08, vibrance 0.15 | camera, screen |
| Warm | temperature 0.35, tint 0.05, contrast 0.06, vibrance 0.10 | camera |
| Cool | temperature −0.30, tint −0.05, contrast 0.08, saturation −0.05 | camera |
| Vivid | contrast 0.20, saturation 0.12, vibrance 0.30 | camera, screen |
| Soft | contrast −0.12, highlights −0.30, fade 0.5, saturation −0.12 | camera |
| Cinematic | contrast 0.15, saturation −0.10, temperature 0.05, split kS 0.06 (teal shadows), kH 0.05 (orange highlights) | camera |
| Mono | saturation −1, contrast 0.18, shadows 0.10 | camera, screen |
| Vintage | temperature 0.25, saturation −0.35, fade 0.6, contrast −0.05, split kH 0.04 | camera |

Warm, Cool, Soft, Cinematic and Vintage tint white pages, greys and brand colours, which in a
tutorial only makes the UI look wrong, so the screen does not offer them. Names are generic, never
film brands. The chips' thumbnails are drawn by the same grade on a small still of the project (the
frame at the playhead, 96 × 54), and always carry a text label.

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
| `LUT_1D_SIZE` | an integer 2..65,536 (Resolve's shaper, applied first; the GPU reads it from a 2D texture, §9.3) |
| `DOMAIN_MIN`, `DOMAIN_MAX`, `LUT_1D_INPUT_RANGE`, `LUT_3D_INPUT_RANGE` | finite, and max − min at least 1e-6 on each channel (a smaller span would make the shader's float32 scale infinite) |
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
its SHA-256 with `crypto.subtle.digest`, parses it with the same parser, and uploads it. That takes
up to about 100 ms for a 65³ file, so `lutFor(project, which)` (synchronous, used by the frame loop)
returns null until it is done. Nothing that must match the preview may draw before then:
`prepareLuts(project)` (lutCache.ts) loads both grades' LUTs and is awaited by `exporter.prepare()`,
`renderThumbnail` and the contrast probe's caller (all through `prepareEditingAssets`, §17.0). The
preview redraws when a LUT becomes ready (`onLutReady`). A file that is missing, changed or
unreadable is drawn without (the grade's other stages stay), the Colour section says "The LUT file is
missing or has changed. Import it again.", and the export dialog asks before the export starts:
"The camera's LUT is missing or has changed. Export without it?" (*Export without it* / *Cancel*;
either answer hands the focus back to the dialog's Export button before the question goes).

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
  one update. When `grade.auto` already exists (a second run before Review settled the first), its
  `camera` is kept and only `grade.camera` is replaced, so Review's Remove still puts back the
  user's own colour. Never recomputed while drawing, so it is the same at any seek and fps. One
  Review row (§11). Not offered for the screen, whose colours are the apps' own.

### 9.7 Screen and camera

The two grades are independent: a warm look on the camera never tints the screen. The screen's panel
has no Exposure (screen recordings are not exposed), no Auto colour, and only the looks that keep
neutrals neutral or are plainly a choice (Natural, Vivid, Mono). Both have LUTs. A camera hidden in a
layout costs nothing (the layer returns before grading).

---

## 10. Music and sound-effects library

### 10.1 The catalogue (`src/shared/audio/soundLibrary.ts`, pure, no runtime imports)

One module, like `fontCatalog.ts`. Each bed: `id`, `mood`, `title`, `artist`, `album`, `licence`
(`'CC0-1.0'`), `page`, `upstream { url, bytes, sha256 }`, `prepared { file, bytes, sha256, samples,
loopStart, loopEnd, pad }`, `bundled`. Each effect: `id`, `title`, `group` (`'whoosh' | 'pop' |
'click' | 'chime'`), `source`, `page`, `licence`, `member { archive, path, bytes, sha256 } | null`,
`prepared { file, bytes, sha256 }`, `seconds`, `peakAt`, `uses`. Ids never change; a changed file gets
a new id. `ARTISTS` holds each artist's evidence (below), and `REJECTED_ARTISTS` holds
`'John Bartmann'`.

**Licence rule for music.** A bed is allowed only when (1) its own Free Music Archive page says "CC0
1.0 Universal", (2) the file's tags say nothing else, and (3) the artist's own site or biography
agrees with CC0, and neither requires credit nor has the music enforced through Content ID. The
evidence for (3) is kept per artist: the page's URL, the date it was fetched, the sentence, and the
SHA-256 of the saved page text (`scripts/sound-library/evidence/<artist>.txt`, in the repository,
not shipped). `SOUNDS.md` repeats it, and test 6 checks every bed's artist has it.

| Artist | Evidence (fetched 2026-11-06) |
|---|---|
| HoliznaCC0 | The artist's biography on the Free Music Archive (`https://freemusicarchive.org/music/holiznacc0/`): "…which is giving out truly unique and creative music for free as public domain". Every track page used says CC0 1.0. |
| Loyalty Freak Music (Rrrrrose Azerty) | `https://loyaltyfreakmusic.com/faq/`: "98 % of my work is under Creative Commons 0, so you can remix, use it in a commercial way and don't even need to credit me to use it… Check the description of the album to see the license". Claims on her music come from people who put it on a distribution service; "You can still dispute the claim". Each album used says CC0 1.0 on its tracks' pages; "Go to the Picnic"'s tags say "Public Domain". |
| John Bartmann (rejected) | `https://www.johnbartmann.com/faq`: "Creative Commons CC-BY 4.0 or public domain. Do credit me"; uncredited videos "will get flagged by We Are Era Music (aka Frequency Digital)"; "Can I resell your music? No". |

**Speech screen.** A bed must sit under a voice. Measured on each prepared file
(`w10-design/rev2/scripts/speechfit.py`): the share of energy in the speech-presence band 1–4 kHz,
the EBU R128 loudness range (LRA, steadiness), and onsets per second. A bundled bed must have at most
10 % in the band, an LRA of at most 5 LU and at most 4.5 onsets a second; per mood, the smallest
bed that passes is bundled. The listening pass (§0 decision 5) then checks every bed by ear: no
vocals, no busy lead melody in the speech band, steady energy, no game or chiptune feel, a clean loop
point. Tranquil Mindscape (34.6 % in the band) was dropped for this; Champ de tournesol for its game
feel and weakest loop.

The **upstream** bytes and SHA-256 below were measured on the files downloaded for this design. The
**prepared** files are made by `scripts/build-sound-library.mjs` from the pinned upstream files
(§10.2); the prepared sizes below are from the research encodes (ffmpeg 6.1.1, libopus 1.4,
`-map_metadata -1 -fflags +bitexact`). The build's first run records its own bytes and SHA-256, and
from then on they never change.

**Music beds** (all CC0 1.0 on their Free Music Archive pages; 48 kHz stereo; E is the loop's end in
samples, so one pass is E / 48000 s; each file holds E + 12,000 samples, the last 0.25 s being the
pad; the loop repeats from *loop start* to E):

| Id | Title — artist (album) | Mood | One pass | Loop start | Loop body | Band 1–4 kHz, LRA, onsets/s | Seam step / body p99.9 | Prepared bytes | Where |
|---|---|---|---|---|---|---|---|---|---|
| `calm-spring-on-the-horizon` | Spring On The Horizon — HoliznaCC0 (Background Music) | Calm | 74.129 s | 24.474 s | 49.655 s | 4.4 %, 3.5 LU, 1.37 | 0.0060 / 0.0338 | 604,864 | installer |
| `calm-drifting-piano` | Drifting Piano — HoliznaCC0 (Background Music) | Calm | 83.124 s | 25.774 s | 57.350 s | **14.0 %**, 2.4 LU, 1.99 | 0.0058 / 0.0652 | 678,125 | download |
| `calm-old-key` | Old Key — Loyalty Freak Music (MINIMAL AMBIENT BOUNCE) | Calm | 81.376 s | 17.369 s | 64.008 s | 1.0 %, 4.8 LU, 2.17 | 0.0227 / 0.0346 | 663,740 | download |
| `upbeat-sweet-sun` | Sweet Sun — Loyalty Freak Music (POSITIVE ATTITUDE !) | Upbeat | 103.376 s | 33.808 s | 69.568 s | 6.3 %, 2.6 LU, 2.91 | 0.0086 / 0.1340 | 842,458 | installer |
| `upbeat-go-to-the-picnic` | Go to the Picnic — Loyalty Freak Music (POSITIVE ATTITUDE !) | Upbeat | 125.924 s | 12.817 s | 113.106 s | 3.5 %, 2.2 LU, 3.02 | 0.0052 / 0.0929 | 1,025,969 | download |
| `corporate-one-cool-minute` | One Cool Minute — Loyalty Freak Music (MINIMAL AMBIENT BOUNCE) | Corporate | 65.946 s | 5.944 s | 60.002 s | 0.3 %, 2.0 LU, 4.08 | 0.0022 / 0.0240 | 538,449 | installer |
| `corporate-work` | Work — Loyalty Freak Music (MELODIES WITH A BEAT) | Corporate | 129.062 s | 65.062 s | 64.000 s | 0.8 %, 3.4 LU, 2.88 | 0.0109 / 0.0339 | 1,051,173 | download |
| `lofi-coexistenz` | Coexistenz — Loyalty Freak Music (TO CHILL AND STAY AWAKE) | Lo-fi | 91.948 s | 34.598 s | 57.350 s | 4.8 %, 4.1 LU, 3.12 | 0.0133 / 0.1219 | 749,669 | installer |
| `lofi-find-your-peace` | Find Your Peace — HoliznaCC0 (Be Happy With Who You Are) | Lo-fi | 103.234 s | 30.975 s | 72.258 s | 3.2 %, 2.3 LU, 2.54 | 0.0416 / 0.0819 | 841,484 | download |
| `lofi-walking-away` | Walking Away — HoliznaCC0 (Public Domain Lofi) | Lo-fi | 143.010 s | 72.586 s | 70.425 s | **12.4 %**, 4.6 LU, 2.66 | 0.0106 / 0.2117 | 1,164,869 | download |
| `cinematic-lullabies-5` | Lullabies For The End Of The World #5 — HoliznaCC0 (Lullabies For The End Of The World) | Cinematic | 97.123 s | 51.409 s | 45.714 s | 2.0 %, 4.4 LU, 1.04 | 0.0054 / 0.0408 | 791,657 | download |
| `cinematic-dangerous-voyage` | Dangerous Voyage — HoliznaCC0 (Background Music) | Cinematic | 111.270 s | 8.870 s | 102.400 s | 5.9 %, 4.7 LU, 1.49 | 0.0021 / 0.0487 | 906,703 | download |

Bundled: 2,735,440 bytes. Downloads: 7,123,720 bytes (0.66–1.16 MB each). The seam step is the
largest sample-to-sample step across the loop point in the decoded file; it must be below the body's
99.9th percentile step, and is for every bed.

Upstream files (all under `https://files.freemusicarchive.org/storage-freemusicarchive-org/`):

| Id | Path | Bytes | SHA-256 |
|---|---|---|---|
| `calm-spring-on-the-horizon` | `tracks/XaPEssVQ1Ks8r4GzowzzHsP5xfIi2FcDxVmEM3Bn.mp3` | 3,673,165 | `3776c85ecae4f6052c4fe4645bef02f51de35ba7257380bca3e0707853d1aa6e` |
| `calm-drifting-piano` | `tracks/uGFgbWaUKc0LLRnbLShVKZ7yhiK5nsxczsKgpcvW.mp3` | 4,420,963 | `5d1d80af901c244bcedb618b5350b83874167258ba4fa17da83a2a005a26f95e` |
| `calm-old-key` | `music/Music_for_Video/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_03_-_Old_Key.mp3` | 6,393,217 | `5b11999f705881ce23ea39577c4af38aa404b1f38cf89cdd47eb6e4a2109406b` |
| `upbeat-sweet-sun` | `music/no_curator/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_04_-_Sweet_Sun.mp3` | 4,843,926 | `0e78c97159d005e5727fb8c406c1613047f17bfe74450d37e941dafbfe0975fa` |
| `upbeat-go-to-the-picnic` | `music/no_curator/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_01_-_Go_to_the_Picnic.mp3` | 7,544,987 | `dbeaad7bb137f39f5d3e7ee5c83b2ac53f4963cc92f3d3fe6321c490e1760cf1` |
| `corporate-one-cool-minute` | `music/Music_for_Video/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_02_-_One_Cool_Minute.mp3` | 7,799,650 | `8778d1e095ab7c6793d10ce9bbe1d9783c9ec6d558f11302ced2202b2c039a0c` |
| `corporate-work` | `music/Music_for_Video/Loyalty_Freak_Music/MELODIES_WITH_A_BEAT/Loyalty_Freak_Music_-_13_-_Work.mp3` | 5,862,743 | `b54cd1808040093efb07b59a81f706fe8f8b0f10dce99b67d7aa9ba95287c7bd` |
| `lofi-coexistenz` | `music/Music_for_Video/Loyalty_Freak_Music/TO_CHILL_AND_STAY_AWAKE/Loyalty_Freak_Music_-_01_-_Coexistenz.mp3` | 6,307,619 | `a30737e60dd04961b645312d9a33683b8cc7b2d591ed22892ef552dd1750c9f0` |
| `lofi-find-your-peace` | `tracks/XfRQmzUkddJ0aYUKbbbssERfuqtZ4kFD4f7tDbpm.mp3` | 5,574,925 | `d204810823d2910111e8eb9a5dce7fd4c659701cc3b9c350ff44a0f9c9a58e99` |
| `lofi-walking-away` | `tracks/WOtcP3GhbgTD8CuC6sEgpQOEXMyNeXYbTNmHjgN6.mp3` | 6,243,043 | `fd8a618a4076b76f02f69414d6beb4ad7ddf3b8c26164085bd6dc1a9fd2f7610` |
| `cinematic-lullabies-5` | `tracks/QQ7qGFBa7XvQ4zoITcak0W3PPq4CIDuJpXDtb8BB.mp3` | 5,799,523 | `d92076e65945f9703f99c45741cf09118c1a5d8bec54e1a1245f513f9f3134ed` |
| `cinematic-dangerous-voyage` | `tracks/Tvb0DDm30Pc0zqEJB3UAJscCXysMFzWj5iZn81Um.mp3` | 7,193,485 | `858da24c505574b60694f05ef70564555a18a05307cc7671c0efc642bf6036ff` |

Each track page (the catalogue's `page`) reads "<title> by <artist> is licensed under a CC0 1.0
Universal License". The pages, all under `https://freemusicarchive.org/music/`:
`holiznacc0/background-music/spring-on-the-horizon/`,
`holiznacc0/background-music/drifting-piano/`,
`Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_MINIMAL_AMBIENT_BOUNCE_-_03_Old_Key/`,
`Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_04_Sweet_Sun/`,
`Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_01_Go_to_the_Picnic/`,
`Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_MINIMAL_AMBIENT_BOUNCE_-_02_One_Cool_Minute/`,
`Loyalty_Freak_Music/MELODIES_WITH_A_BEAT/Loyalty_Freak_Music_-_MELODIES_WITH_A_BEAT_-_13_Work/`,
`Loyalty_Freak_Music/TO_CHILL_AND_STAY_AWAKE/Loyalty_Freak_Music_-_TO_CHILL_AND_STAY_AWAKE_-_01_Coexistenz/`,
`holiznacc0/be-happy-with-who-you-are/find-your-peace/`,
`holiznacc0/public-domain-lofi/walking-away-lofi-peaceful-motivating/`,
`holiznacc0/lullabies-for-the-end-of-the-world/lullabies-for-the-end-of-the-world-5/`,
`holiznacc0/background-music/dangerous-voyage/`. The upstream files are pinned for provenance and to
rebuild the prepared files; the app never downloads them.

Notes for the build: Drifting Piano is at −27.2 LUFS upstream and needs +11.1 dB (listen for hiss);
Old Key reached only −18.4 LUFS under the true-peak cap, so its preparation adds a gentle true-peak
limiter; Lullabies #5 (−16.8) and Dangerous Voyage (−16.7) are within 1 LU of the target and stay as
they are. Drifting Piano and Walking Away are over the 10 % band share: the listening pass checks
them under a voice first.

**Spares**, one per mood, measured for loops only (not prepared), to swap in when a bed fails the
listening pass; a swap is a new id, prepared and pinned like the others:

| Mood | Title — artist | Upstream path | Bytes | SHA-256 | Loop (similarity, seam correlation) |
|---|---|---|---|---|---|
| Calm | Hope On Repeat — HoliznaCC0 | `tracks/MvP2fPRhrWkQwsrgVB7U9rqSgLBtOfbD0vssM4LP.mp3` | 6,884,136 | `e781cf3926ea5b769f3b5667011234f4524cbcb06e539ba563c7f15fd805477a` | 64.691–121.161 s (0.993, 0.964) |
| Upbeat | Love Train — Loyalty Freak Music | `music/no_curator/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_03_-_Love_Train.mp3` | 4,905,575 | `c2462ccf48a5b8e1e36d09b4f66ee7aeb385ac2d9959c2679a037a9f1db1a45b` | 41.982–105.982 s (0.985, 1.000) |
| Corporate | Once more with you — Loyalty Freak Music | `music/Music_for_Video/Loyalty_Freak_Music/MINIMAL_AMBIENT_BOUNCE/Loyalty_Freak_Music_-_01_-_Once_more_with_you.mp3` | 7,415,127 | `c83d138661a2094875f2fa0148a1b0a96072bac0000ad8f6458eeae5a4fd8663` | 27.307–84.907 s (0.872, 0.928) |
| Lo-fi | Softly — Loyalty Freak Music | `music/Music_for_Video/Loyalty_Freak_Music/MELODIES_WITH_A_BEAT/Loyalty_Freak_Music_-_06_-_Softly.mp3` | 10,526,123 | `ff0fab6846810f7a6afa415f643e8573e2542a483629d44e7c3b5ce92b2a4433` | 157.663–239.949 s (0.980, 0.999) |
| Cinematic | Lullabies For The End Of The World #1 — HoliznaCC0 | `tracks/8RwpuRIdNOdkazzkaujnrvXrcDybVrGYRfdYItKD.mp3` | 6,595,363 | `f875477bd79039f6b69c09ce1685cc01b22a2e98c89efffeca9a84000e8caa4a` | 3.529–78.661 s (0.965, 0.780) |

**Sound effects** (16, all in the installer; mono 48 kHz; *peak* is the time from the start to the
loudest moment, used to line a sound up with the picture):

| Id | Title in the UI | Source (CC0) | Length | Peak | Prepared bytes | Offered for |
|---|---|---|---|---|---|---|
| `whoosh-in` | Whoosh | qubodup, "Swish - bamboo stick weapon swhoshes", swosh-03 | 0.576 s | 0.075 s | 3,458 | zoom in, titles |
| `whoosh-out` | Whoosh out | same pack, swosh-13 | 0.508 s | 0.116 s | 3,097 | zoom out |
| `whoosh-soft` | Soft whoosh | same pack, swosh-16 | 0.437 s | 0.073 s | 2,660 | zooms, titles, slides |
| `swish-quick` | Quick swish | artisticdude, "Swishes Sound Pack", swish-9 | 0.154 s | 0.059 s | 1,225 | callouts |
| `pop` | Pop | cogitollc, "Pop sounds", pop1 | 0.207 s | 0.036 s | 1,534 | callouts, badges, pop-ups |
| `pop-soft` | Soft pop | cogitollc, "Pop sounds", pop3 | 0.125 s | 0.045 s | 1,029 | callouts, pop-ups |
| `pop-bubble` | Bubble pop | wubitog, "3 Pop Sounds", pop1 | 0.236 s | 0.010 s | 1,674 | bubbles, pop-ups |
| `click` | Click | Kenney, Interface Sounds, click_001 | 0.097 s | 0.006 s | 677 | callouts |
| `tick` | Tick | Kenney, tick_002 | 0.020 s | 0.005 s | 419 | badges |
| `bell` | Bell | PWL, "Bell dings/chimes", bell_ding2 | 1.352 s | 0.030 s | 8,079 | titles |
| `chime` | Chime | Kenney, confirmation_001 | 0.290 s | 0.006 s | 2,760 | titles, callouts |
| `success` | Success | qubodup, "6 user interface ding clicks", dingCling-positive | 0.294 s | 0.103 s | 3,149 | callouts |
| `rise` | Rise | Kenney, maximize_004 | 0.402 s | 0.354 s | 3,351 | callouts |
| `fall` | Fall | Kenney, minimize_004 | 0.401 s | 0.048 s | 2,938 | callouts |
| `bubble-in` | Bubble | Kenney, question_001 | 0.487 s | 0.166 s | 3,269 | bubbles |
| `drop` | Drop | Kenney, drop_002 | 0.188 s | 0.006 s | 1,864 | badges |

Total 41,183 bytes. In the UI they are grouped (Whooshes, Pops, Clicks, Chimes); Captions Studio's
synthesised sounds sit in their own group, **Original** (*Original pop*, *Original ding*). Upstream
files (each from `https://opengameart.org/sites/default/files/`):

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

The members taken from the archives, each pinned (the catalogue's `member`):

| Effect | Archive › member path | Bytes | SHA-256 |
|---|---|---|---|
| `whoosh-in` | `swoshes.7z` › `swosh-03.flac` | 96,738 | `2111003e4c61b8f3589f926f549ffc36094319da7b99238624c7d64e91bddc09` |
| `whoosh-out` | `swoshes.7z` › `swosh-13.flac` | 94,634 | `a22c0da4eff26f4b6171721c830f291a0ad9fe5383f23d5f4530020e995dc4de` |
| `whoosh-soft` | `swoshes.7z` › `swosh-16.flac` | 72,696 | `0e882f9cef2ca536fae1efa9fadcfc5f8f1fc6a1dafc55d8c2ee62a95cd71b16` |
| `swish-quick` | `swishes.zip` › `swishes/swish-9.wav` | 52,906 | `123883f006ce55feecbff11eea5f87c4493df4399989983037144570a23723c1` |
| `pop-bubble` | `3pops.zip` › `3pops/pop1.ogg` | 11,616 | `e8ef22564c704a6f6217e03885cba51ebd7761360e59fc8e247b2f4f97bc4e0e` |
| `click` | `kenney_interfaceSounds.zip` › `Audio/click_001.ogg` | 4,876 | `ccfb7fa0cccdd9faec0eb16033c732b1e308d139d80f799161495d58f7adcdb9` |
| `tick` | same › `Audio/tick_002.ogg` | 4,514 | `869442f54214be902ec7437f79e400dc91c1bfd90d18a6dd2d5b7e41ffbf457b` |
| `chime` | same › `Audio/confirmation_001.ogg` | 8,968 | `063564703b6094d70718a3e787a55cc9141611e4ecd6b6637f8828f79b4a8c3a` |
| `success` | `dingclicks.7z` › `dingClicks/dingCling-positive.ogg` | 10,666 | `63387ecb70bbf54c79cab26b69a590776c0fd1663b5a562eae836121dafc1e14` |
| `rise` | `kenney_interfaceSounds.zip` › `Audio/maximize_004.ogg` | 17,723 | `59c7a24b204be24d2a44a86d1e4d18c2cf51fa0446967a14b2590e8fb3afaf34` |
| `fall` | same › `Audio/minimize_004.ogg` | 17,099 | `fcfe6fbb03a728e90b907f34d2ec7bf3ea1857397c3e47ee01990c1be059e4f6` |
| `bubble-in` | same › `Audio/question_001.ogg` | 11,700 | `abb8f9e4eb2071491b0b15f84ee302386b1847609310c1b000ae174639a6cc5a` |
| `drop` | same › `Audio/drop_002.ogg` | 6,411 | `4ac4d1cef7e936965cbf795852ca2020300b9e2ba7daa59f2bf4f1f7bf416218` |

`pop`, `pop-soft` and `bell` come from single files, pinned in the table above.

Six more measured CC0 effects (typing, keypress, shutter, scroll, toggle, error) wait for sound items
on the timeline (§20): no feature of this wave would play them.

### 10.2 Preparing the files (`scripts/build-sound-library.mjs`)

Run by a person with network access, never by the app or CI. It downloads each upstream file, checks
its bytes and SHA-256 (any mismatch stops it), and prepares:

- **Archives** are unpacked with 7-Zip (`7zz`), the only extractor the script runs; it records the
  binary's version and SHA-256 in `SOUNDS.md`. An archive is opened only after its own SHA-256
  matched. The script lists it first (`7zz l -slt`) and refuses an archive with an absolute member
  path, a `..` part or a link; then it extracts only the named members, by exact path, into a fresh
  temporary folder, and checks each member's bytes and SHA-256 against the catalogue's `member`.
- **Beds**: decode, resample to 48 kHz stereo, cut `[0, E)` at the analysed sample positions, bake
  a 1.0 s equal-power crossfade (the last second fades into the second before `loopStart`, so the
  file's end continues straight on at `loopStart`), append a 0.25 s pad (12,000 samples) of the
  loop's continuation (never played; it absorbs Opus's end-of-stream noise: without it the seam step
  was 0.096 against a body p99.9 of 0.034), gain to −16 LUFS integrated over one pass plus one loop
  with true peak ≤ −1.5 dBTP (with a gentle true-peak limiter where noted), encode Ogg Opus 64 kb/s
  constrained VBR with `-map_metadata -1 -fflags +bitexact`. Header gain 0 and no R128 tags
  (decoders differ on applying them; the gain is in the samples).
- **Effects**: decode, mono, trim silence at −60 dBFS, 2 ms fade in and 5 ms out, gain so the loudest
  400 ms is −20 LUFS unless the true peak would pass −1 dBTP (measured again after encoding, the gain
  lowered until it holds; Opus can add up to 1.5 dB), 20 ms of silence after, Ogg Opus 48 kb/s VBR,
  `-map_metadata -1 -fflags +bitexact`. Short clicks reach only −31 to −26 LUFS under the peak cap;
  that is their natural level.
- **The encoder** is the ffmpeg of the `ffmpeg-static` dev dependency on the machine that runs the
  script (7.0.2 on Linux, with libopus), pinned by the SHA-256 of its binary, recorded in `SOUNDS.md`
  as `packaging.cjs` records `ffmpeg.exe`'s.
- **Pinned once.** Opus output is not byte-identical across ffmpeg and libopus builds or CPUs. So
  the script writes the catalogue's `prepared` fields only for ids that have none. For every id that
  has them, it checks the committed file against them and never encodes it again; a run that would
  change one stops with an error. A changed file needs a new id, and a downloadable one a new release
  tag. Ids and tags are never reused.
- It writes `resources/sound-library/SOUNDS.md`: every file's source, page, licence, member, bytes
  and SHA-256, the artists' evidence, and the tools' versions and hashes. `--check` re-hashes the
  committed files against the catalogue without a network.

### 10.3 What ships and what downloads

- **In the installer**: `resources/sound-library/` (4 beds, 2,735,440 bytes; 16 effects, 41,183
  bytes; `SOUNDS.md`), shipped through `extraResources` outside `app.asar`, because ffmpeg reads
  them from a real path. Opus does not compress further (xz −9e saved 0.01 %), so the installer
  grows by about **2.78 MB**. `SOUND_LIBRARY_BUDGET = { compressed: 2.9e6, installed: 2.9e6 }` in
  `scripts/lib/packaging.cjs`; `verify-dist` checks every file's hash in the built app.
- **On request**: the 8 other beds, **7,123,720 bytes** (0.66–1.16 MB each), into
  `userData/sound-library/`, from the source chosen in §0 decision 1 (recommended: the release
  `sound-library-1` of `samiulakhan12/flown-sound-library`, with immutable releases on). Each
  through `downloadPinned` (`src/main/speech/download.ts:242`): never more than the pinned bytes,
  SHA-256 checked, resume, retries and `Retry-After`; a `.part` file renamed only after the check.
  Cap: the pinned bytes per file, 12 MB for the whole library.
- **Which URLs** (`allowSoundUrl(url, testBase)`, `src/main/soundLibrary/store.ts`, passed to
  `downloadPinned` as its `allow`; the font store's list does not change):
  - The first request is always the pinned URL: https on port 443, no credentials, no query, no
    fragment, under the exact prefix of the chosen source (for (a)
    `https://github.com/samiulakhan12/flown-sound-library/releases/download/sound-library-1/`),
    with no `..` part.
  - A redirect may go to another URL under that prefix (same rules), or to the source's CDN host:
    https on port 443, no credentials, no fragment, **any query**. A GitHub release asset answers
    with a 302 to `https://release-assets.githubusercontent.com/github-production-release-asset/…`
    and a signed query (checked 2026-11-06); `objects.githubusercontent.com`, GitHub's earlier asset
    host, is allowed too. For (c), the Hugging Face CDN hosts under `.hf.co`. The query is signed by
    the host and changes on every request; the bytes and the SHA-256 pin are what protect the
    content. (`allowAssetUrl` refuses any query, `assetStore.ts:78`, so it cannot be copied as is.)
  - Every other host or scheme is refused, at the first request and at every hop.
- **Release check** (`docs/RELEASING.md`): before `SOUND_LIBRARY_SOURCE` is set, one real asset is
  downloaded through `downloadPinned` and `allowSoundUrl` from the live host. With (b), the check
  also confirms that `/releases/latest` still names the app's version tag after the sound release is
  published.
- **Missing bed**: a project whose `music-<n>.ogg` is gone but has `music.library` gets a notice
  "The music file is missing. Copy it from the library again?" with one button, which copies (or
  downloads) the bed again by id. This also mends a version that points at a pruned pick.
- **Notices**: `resources/notices/37-sound-library.txt` lists every file, its author, source page
  and licence (CC0 needs no credit; the list is for provenance). `scripts/notices.mjs` folds it
  into `THIRD_PARTY_NOTICES.txt`.

### 10.4 Looping

**A bed's length** is `E / 48000` everywhere: the `MusicSound` duration the job carries, `musicEnd`,
the preview's stop time and the panel's "1:43". The pad is never played.

**Library beds in the export** (`musicGraph`, `audioPlan.ts:300`): with `bed`, main reads E and the
loop start S from the catalogue (never from the renderer) and checks the project file's SHA-256
against the catalogue's; on a mismatch it plays the file as a user's own file. With Loop on, the
graph (verified with ffmpeg 7.0.2, the app's own):

```
[m]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=E,asplit[h][b];
[b]atrim=start_sample=S,asetpts=PTS-STARTPTS,aloop=loop=-1:size=E-S[l];
[h][l]concat=n=2:v=0:a=1
```

With Loop off: `[m]aresample=48000,aformat=…,atrim=end_sample=E`, no `aloop`. Then today's volume,
fades, ducking and padding. No `-stream_loop`. 300 s renders of Go to the Picnic and Spring On The
Horizon matched `decoded[0:E] + repeat(decoded[S:E])` with a maximum difference of 0.0, and the steps
at the seams (0.0052 and 0.0060) were below the bodies' 99.9th percentile step (0.0929 and 0.0338).
`aloop` holds E − S samples: at most 113.1 s (Go to the Picnic), about 43.4 MB as stereo float.

**Library beds in the preview** (`previewAudio.ts`): the bed is decoded once with
`decodeAudioData` (from the project file through `studio-media://`) and played by an
`AudioBufferSourceNode` with `loop = true`, `loopStart = S / 48000`, `loopEnd = E / 48000`, started
at `bedTime(out)` = `out` while `out < E/48000`, else `S/48000 + (out − S/48000) mod ((E − S)/48000)`
(shared, pure). With Loop off, `loop = false` and the node stops at `E/48000`. It connects to today's
music gain chain, so volume, fades and ducking are today's.

It stays on the music's drift loop. The node's position is tracked from its start time and every
`playbackRate` change (position = offset + Σ rate · elapsed context time, wrapped at the loop). On
each `syncMusic` (`previewAudio.ts:818`) it is compared with `bedTime(out)`, out being the output time
of the video's clock: within `MUSIC_SEEK` (0.3 s) the rate is nudged within `MUSIC_NUDGE` (0.08)
through the node's `playbackRate` AudioParam, as `<audio>` music is today; beyond it the node is
stopped and a new one started at `bedTime(out)`. On the video's `waiting` or `stalled` the node
stops, and it starts again on `playing`. This matters because the video's clock stops at every cut
jump (`jumpTo` seeks the element) and every decode stall, while the context's clock does not:
without it, edit-by-text's hundreds of cuts would move the bed seconds away from where the export
puts it.

At preview speeds other than 1× the rate follows the preview speed, so the pitch moves like a tape;
playing backwards it is silent, as the recording is. The context keeps the device's rate (§3.2 row
29): loop points in seconds land between samples at 44.1 kHz, and the baked crossfade hides it.
Memory: a decoded bed is up to 55.0 MB (Walking Away, 6,876,501 samples as stereo float at 48 kHz;
50.5 MB at 44.1 kHz); the largest bundled one, Sweet Sun, 39.8 MB. The buffer is released when the
bed changes, the music is removed or the editor closes.

**Users' own music** (§0 decision 2): when music loops and its file is not WAV, FLAC, MP3 or Vorbis
(that is, Opus, M4A or AAC), main decodes it once with the app's ffmpeg into
`.cache/music-<n>.<first 16 hex of its SHA-256>.flac` and the job reads that file with today's
`-stream_loop -1`, which is exact on FLAC (measured error 0.0). The cache is made only when the music
is shorter than the video, and only up to the output's length (`-t`). Before decoding, main checks
the free space for `duration × 48000 × channels × 2` bytes plus the export's usual margin. The decode
runs under the export's cancel signal and timeout, and with an argument list (no shell). The finished
copy is renamed into place with a few tries while another app holds it (an antivirus scan, the indexer
or OneDrive), as an export's file is. When a new cache is made, older `music-*.flac` caches of the
project are deleted. `.cache/` is never copied by Duplicate or kept by versions. The preview keeps its
`<audio loop>`.

### 10.5 Loudness, ducking, fades and volume

- Beds are at −16 LUFS integrated (Old Key −18.4 before its limiter) with true peak ≤ −1.5 dBTP, the
  same target as the recording's normalisation (`LOUDNESS_TARGET`, `src/shared/audio/loudness.ts:12`).
- A bed uses today's `MusicSettings` and defaults (`DEFAULT_MUSIC`: volume 0.35, ducking 0.7, loop,
  fade in 1 s, out 2 s; `settings.ts:37`). Between phrases it sits at about −25.1 LUFS (0.35 is
  −9.12 dB), and while someone speaks the ducked gain is 0.35 × 0.3 = 0.105 (−19.6 dB), about
  −35.6 LUFS: roughly 19.6 dB under speech normalised to −16. Ducking (`DUCK_TIMING` 0.15 / 0.45 s,
  `musicDucking`, `duckExpression`) and `musicEnd` need no change beyond the bed's length (§10.4).
- Effects: one **Volume** (`soundFx.volume`, default 0.35, the synthesised pop's `POP_VOLUME`). A
  file at −20 LUFS at 0.35 plays at −29.1 LUFS, beside today's pop at −30.5. Effects are not ducked
  and do not duck the music. The synthesised pop and ding keep `POP_VOLUME`, so old projects sound
  the same.
- The whole soundtrack's fades (`AudioSettings.fadeIn` / `fadeOut`) apply to effects too, as they do
  to today's pops.

### 10.6 When effects sound (`sfxJob`, `src/shared/render/sfxJob.ts`, pure)

`sfxJob(project, startOf?)` gives every library effect's times in video seconds, for the export job
and the preview alike, through `sourceToOutput` and `editToVideo` as `popJob` does
(`popSound.ts:140`). `startOf(g)` is the same callback `popJob` gets: `graphicShown(project, g,
size).start` in the export (`exporter.ts:165`) and `graphicShown(p, g).start` in the preview
(`previewAudio.ts:854`), so a graphic sounds when it shows, whatever moves it (the text area, the
progress bar's band, the frame, the crop).

- **Zooming in**, for each zoom with `tin > 0` that does not pan from the previous zoom
  (`zoomTimings`, `src/shared/engine/zoom.ts:650`: `fromPrev` false): at the video time of source
  `seg.start + tin / 2`, the fastest point of easeInOutCubic, minus the effect's `peakAt`. For a
  0.7 s transition and Soft whoosh that is 0.277 s after the zoom starts, its peak at 0.35 s.
- **Zooming out**, for each zoom with `tout > 0` that does not pan into the next (`toNext` false): at
  source `seg.end − tout / 2`, minus `peakAt`. `zoomTimings` already merges connected zooms, so a pan
  never gets a whoosh for a move that does not happen. Auto zooms are regenerated wholesale, which is
  why zoom sounds are a project rule and not a field on each zoom.
- **Pull-backs.** A zoom whose level (`zoomTargetScale`) is below 100 % shrinks the picture as it
  starts and grows it back as it ends, so the two swap: its move in (`seg.start + tin / 2`) plays
  Zooming out and its move out (`seg.end − tout / 2`) plays Zooming in, under the same conditions. A
  zoom within 0.001 of 100 % shows no move and never sounds.
- **Title cards**, **texts and shapes**: at the video time of the item's start, plus half its enter
  motion (`enter.duration`, or its old fade: 0.35 s titles, 0.15 s texts and shapes), minus
  `peakAt`. The item's own `sound` wins over the rule; `'none'` silences it. Privacy shapes never
  sound.
- **Captions Studio's pop-ups** with an `SfxRef` sound: at `startOf(g)` (when the graphic starts to
  show), minus `peakAt`. `popJob` keeps `'pop'` and `'ding'` and skips `SfxRef`s, so old projects'
  pops are unchanged (§10.7).
- **Spacing for rules.** The times a rule makes (Zooming in, Zooming out, Title cards appear, Texts
  and shapes appear) are walked in order, and a time less than 3.0 s of video after the rule's last
  kept time is dropped. An item's own sound is never dropped this way. `sfxCounts(project)` gives
  each rule's kept count for the panel's "Plays 24 times".
- An item whose start lies in a cut never sounds (`shownFrom`, as `popJob`). Times below 0 become 0.
  Times of one effect closer than 0.05 s merge into the first. Each effect has at most 500 times
  (`MAX_POP_TIMES`), at most 16 effects per job.
- Gain per effect: `soundFx.volume ?? 0.35`.

### 10.7 Captions Studio item 12: sound on pops

`Graphic.sound` takes an `SfxRef` besides `'pop'` and `'ding'` (§4.1). The Graphics tab's Sound
select and *Make my captions great*'s sound option (`great.ts:40`, `:107`; `graphicRules.ts:35`)
list the library effects after the **Original** group (*Original pop*, *Original ding*).
`readGreatOptions` accepts an `SfxRef` of the catalogue and reads anything else as `'none'`. A pop-up
made by *Make my captions great* is already a Review row (phase B's `graphic` kind); its title names
the sound through `sfxTitle(ref)` (soundLibrary.ts), a line the contracts put into
`captionReview.ts`.

### 10.8 Export job and main (`src/main/exportJob.ts`, `src/shared/render/audioPlan.ts`)

- `ExportJob.effects?: { id, times, gain }[]`; `validEffects`: an array of at most 16, each `id` a
  catalogue effect and each once, `times` at most 500 finite numbers in 0..1e7, `gain` in 0..2.
  `MusicSound.bed?`: a catalogue bed id.
- `SoundParts` and `hasSound` (`exporter.ts:113-116`) count `effects`, so a silent recording whose
  only sound is a zoom whoosh exports with an audio track, an audio-only export of it works, and
  `rateOf` sizes the job with audio.
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
  Every effect the project names (`sfxIds`: its rules and items) starts decoding when the graph is
  brought in line with the project, so the first play has it. One still decoding when its sound is
  due keeps its place in the pass: once ready, a sound due meanwhile plays from where it has got to,
  as the export's does.
- `effectsOf` (`:849`) is made again when any input of `sfxJob` or `popJob` changes: today's list
  plus `zooms`, `annotations`, `shapes`, `titles`, `soundFx`, `effects` (Calm and badges) and
  `chapterBar` (whose band moves Captions Studio's graphics and so their shown time).
- A voice of a library effect stops (`stop(when)`) where the next sound of the same effect starts,
  as the export's click track cuts it. Today's synthesised pops keep their behaviour.
- `needsAudioGraph` (`settings.ts`) is true with library effects or a bed.

### 10.10 Credits

The Audio tab shows "Music: <title> by <artist> (CC0)" for a library bed. `musicCredit(project)`
(`soundLibrary.ts`) returns that line, and the publishing pack's YouTube description
(`composeYoutubeDescription`, `src/shared/publish/youtube.ts:77`) offers it as a last line (*Add the
music credit*, on by default when a bed is used). It meets Loyalty Freak Music's wish to be credited
where possible, and it is the best answer to a false Content ID claim (§0 decision 4).

---

## 11. Automatic changes, Polish and Review mode

**What is automatic.** Only two things in this wave change a project without the user choosing the
exact result: Polish's *Smooth cuts* step and *Auto colour*. Each writes a record of what was there
before, and Review mode lists it with Keep and Remove. Everything else (Smooth all cuts, a cut's
style, magnifiers, callouts and the motions new items are made with, the progress bar, looks,
sliders, LUTs, music, effect rules) is a choice the user makes and sees, and is not listed. Pop-ups
that *Make my captions great* makes with a library sound are already listed by phase B's `graphic`
rows.

**Polish** (`src/shared/editor/polish.ts`):

- `PolishStep` gains `'smoothCuts'`, after `'silences'` in `POLISH_STEPS`, so cuts that Remove
  silences makes are smoothed too. `PolishOptions.smoothCuts: boolean`; `DEFAULT_POLISH_OPTIONS`
  has `true` (§0 decision 3); `readPolishOptions` reads a missing value as `false`.
- `PolishSkip` gains `'no-cuts'` ("No cuts to smooth") and `'kept-style'` ("Your cut style is
  kept"): `joins.all` is present, whatever its kind. *Use hard cuts everywhere* stores
  `joins.all = { kind: 'cut' }`, so a user who chose hard cuts keeps them.
- The step sets `joins.all = { kind: 'smooth' }` and `joins.auto = { by: 'polish', was: <joins.all
  before, or null> }`, inside Polish's one update. `STEP_LABEL.smoothCuts` "Smooth cuts"; summary
  line "Smooth cuts at 37 cuts" (the cuts without their own style). Per-cut styles are kept.

**Review mode** (`src/shared/review/editingReview.ts`, hooked into `review.ts` the way
`captionReview.ts` is in phase B; the contracts write it as an aggregator of P1's `joinReview.ts`
and P4's `colourReview.ts`):

| Key | Kind (chip) | Title | Detail | Keep | Remove |
|---|---|---|---|---|---|
| `join:all` | `join` (*Cuts*) | "Smooth cuts at 37 cuts" (the count now) | "Polish" | drops `joins.auto` | `joins.all = was` (deleted when null), drops `joins.auto`; an empty `joins` is deleted |
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
| Length, Crossfade length, Punch-in size | slider | arrows 0.01 s (1 %), Page Up/Down 0.1 s (5 %), Home/End min/max | "0.15 seconds"; "110 percent" |
| Dip colour | `radiogroup` of swatches, each named ("Black", "White", "Brand colour 1, #0060df") | arrows | — |
| Slide from | `radiogroup` "Comes in from" | arrows | — |
| Smooth all cuts, Give them the same style | buttons | Enter, Space | live region: "Smoothed 37 cuts. Ctrl + Z to undo." |
| Previous cut, Next cut, Play this cut | buttons | Enter, Space | live: "Cut 6 of 37" |
| Cut marker on the timeline | button in the clip track's list, 24 × 24 px; name "Cut 5 of 37: 1:23.4 to 1:25.0, crossfade" | Enter selects it and focuses Cut style | — |
| Magnifier zoom | slider "Zoom" | arrows 0.25, Page 1, Home/End | "2 times" |
| Darkness | slider | arrows 5 %, Home/End | "20 percent" |
| Comes in, Goes out, Sound | `select` | arrows | — |
| Play an effect | toggle button `aria-pressed` "Play Soft whoosh" | Space | — |
| Badge number | `radiogroup`; text field checked by graphemes as typed (no `maxlength`), with an error text "At most 3 letters" tied by `aria-describedby` | — | — |
| Count with | `radiogroup`; the Bangla choice's sample has `lang="bn"` | arrows | "Bangla digits, ১ ২ ৩" |
| Restart at each chapter, Follows the zoom | `switch` | Space | — |
| Start from | number field | arrows | — |
| Badge and tail handles (preview) | focusable handles "Badge 3 on 52 %, 40 %"; "Tail points to 52 %, 40 %" | arrows 1 %, Shift 10 % | live: new position |
| Progress bar | `switch`; `radiogroup`s | Space, arrows | — |
| Looks | `radiogroup` of chips with text labels; thumbnails `alt=""` | arrows | — |
| Colour sliders | slider per control | arrows 1, Page 10, Home/End min/max (the ARIA slider pattern), Delete resets to 0 | "Warmer, +20"; "Cooler, −15"; "No change" at 0; Delete announces "Temperature reset" |
| Reset (per slider) | button "Reset Temperature" | Enter, Space; the button goes, and the keyboard's focus moves to its slider | live: "Temperature reset" |
| Compare | toggle button `aria-pressed` | Space | — |
| Import a LUT, Remove LUT, Auto colour, Reset colour | buttons | Enter; after Remove LUT the keyboard's focus moves to Import, after Reset colour (which then turns off) to the look *None* | live: notice text |
| Music library | `list`; per row: title, artist, mood (text chip), length ("1 minute 43 seconds" for screen readers) | Tab through rows | — |
| Play preview | toggle `aria-pressed` "Play preview of Sweet Sun"; on a row not downloaded `aria-disabled`, still focusable, described by "Download to listen" | Space; Esc stops while focus is in the list | live: "Playing preview: Sweet Sun, 1 minute 43 seconds" / "Stopped" |
| Use / Download and use | buttons "Use Sweet Sun", "Download and use Go to the Picnic, 1.0 megabytes" | Enter | then the button reads "In use" (`aria-disabled`, still focusable); a download has a `progressbar` with value text |
| Mood filter | `radiogroup` of chips | arrows | — |

Never colour alone: cut markers have shapes, looks have names, moods are words. The Compare and hover
previews are preview-only. Windows' animation setting affects only the editor's UI (thumbnails stay
still, previews never play by themselves); the video's motion is the project's Calm motion choice
(§7.5).

---

## 13. Bangla and other scripts

- **Step badges** count in native digits (`withDigits`): ১ ২ ৩ … ১০. *Count with* always offers
  Bangla digits, whatever the caption language, and a new badge uses them when the caption or
  transcript language is Bangla. Own text: up to 3 graphemes in any script ("ক্ষা" is one).
- **Speech bubbles** wrap by words and, without spaces, between graphemes (`Intl.Segmenter`), never
  inside a cluster: a conjunct or a vowel sign stays with its letter. Line height 1.4 with Bengali,
  Devanagari or Thai. Right-to-left text is drawn right-to-left. The font stack ends in the bundled
  script fonts (§7.6), loaded before the export's first frame.
- **Typewriter and Wipe** on texts reveal whole graphemes, from the reading start.
- **Progress bar names**: `cardFont`'s stack with the bundled script fonts; shortened by graphemes;
  right-to-left names drawn right-to-left. The bar itself fills left to right in every language in
  this wave (§20).
- **LUT titles** are plain text with bidi controls removed, shown with `dir="auto"`. **Music titles**
  are Latin ("Lullabies For The End Of The World #5"); moods are UI words for X-05 to translate.
- **Search** (`src/shared/search/extract.ts:82-100`): a bubble's text is an annotation's text and is
  indexed as today; an automatic badge has no text. The index stays at version 5.

---

## 14. Security

1. **LUT files are untrusted.** Main checks the size (16 MiB) before reading, parses strictly (§9.5:
   linear time, at most 65³ entries plus a 65,536-entry shaper, spans of at least 1e-6, no `eval`,
   no regular expression that can backtrack badly), and copies only a file that parsed. The title is
   sanitised. The renderer re-checks the SHA-256 and parses again before uploading; the textures are
   at most 5.2 MiB, and the shaper's texture is 256 wide, under every GPU's limit.
2. **Audio files.** The user's own music is checked as today (`looksLikeAudio`, 500 MB). Library
   files: the media protocol's `sounds` host serves only names of `soundFileRe()` (built from the
   catalogue, no path parts) from the bundled folder or `userData/sound-library/`. Bundled files are
   hash-checked by a unit test and by `verify-dist`; downloaded files on download, and again by main
   before a bed is copied into a project (a changed file is deleted and offered again for download).
3. **Pinned downloads** (§10.3): the first URL is under the exact prefix of the chosen source, https
   on port 443, with no credentials, query or fragment; a redirect may only go back under the prefix
   or to the source's named CDN host (https, port 443, no credentials or fragment; its signed query
   allowed); never more than the pinned bytes; SHA-256 checked; `.part` renamed after the check;
   free space checked first; `Retry-After` honoured up to 60 s. The library lives in its own
   repository, so publishing it never touches the app's update feed.
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
   (no shell) on a file name main built, under the export's cancel and timeout, after a free-space
   check, up to the output's length; older caches are deleted.
8. **Build-time archives** (§10.2): opened only after their SHA-256 matched; listed first; absolute
   paths, `..` parts and links refused; only named members extracted, into a fresh folder, each
   member's SHA-256 checked. Nothing of this runs in the app.
9. **CSP and windows**: unchanged. `media-src` and `connect-src` already allow `studio-media:`
   (`index.html:8`); downloads run in main, so the renderer gets no new origin.
10. **WebGL**: the shader sources are constants with no user text; context loss falls back to the
    CPU path.

---

## 15. Performance budget

Reference rig: Electron 44.9.3, Chromium CPU raster, 4-core Xeon, no GPU (as Captions Studio §9.8).
Today's default frame costs 8.8 ms at 1080p and 21.9 ms at 4K; a moving 2× zoom with motion blur and
the export's 10 sub-frames 20.3 / 104.2 ms; a zoom moving in 45.2 / 167.2 ms. Added per frame:

| Feature | 1080p measured | 1080p budget | 4K measured | 4K budget | When |
|---|---|---|---|---|---|
| Crossfade or Slide (A\* over B) | +1.05 ms | 2 ms | +23 ms | 25 ms | inside a window only |
| Composing A\* (one picture draw and one copy) | about 9.9 ms | 14 ms | about 45 ms | 55 ms | once per cut, outside the window's frames |
| Copying the two still frames (export) | about 2.1 ms (two full-frame draws) | 3 ms | about 46 ms | 50 ms | once per cut |
| Dip | +0.5 ms | 1 ms | +3 ms | 4 ms | inside a window only |
| Punch-in | none measurable (a camera's scale) | 0.2 ms | — | 0.5 ms | the punched clip |
| Magnifier | +1.9 ms | 3 ms | +9 ms | 12 ms | while shown, plus privacy and cursor inside it |
| One animated callout | — | 0.3 ms | — | 1 ms | while moving |
| Progress bar | — | 0.5 ms | — | 1.5 ms | always when on |
| Colour, WebGL2 shader | estimated 2–3 ms on an Intel UHD 620 (not measured: no GPU here) | 4 ms | estimated 8–12 ms | 14 ms | always when graded |
| Colour, the copy into a 2D canvas (screen when not cropped; camera) | estimated +1.05 ms (a full-frame draw) | 1.5 ms | estimated +23 ms | 25 ms | always when graded |
| Colour, the graded canvas drawn with `'high'` smoothing | to measure (the slower cubic path for canvas sources) | 2 ms | to measure | 12 ms | always when graded |
| Colour, CPU path | 41.9 ms | 45 ms | 90.1 ms | 95 ms | PCs without WebGL2 only |

- The colour rows marked estimated or to measure are measured in the `renderCost.test.ts` style
  during P4 and again on the reference Windows PC (§0 decision 6). If the `'high'` draw misses its
  budget, the single graded draw drops to `'medium'` (mipmapped bilinear) in the preview and the
  export together, the fallback the crop design already chose (`crop-in-editor.md` §692).
- **Preview**: a 60 fps proxy gives 16.7 ms a frame. With a GPU, every row fits. Without WebGL2 the
  colour notice says the preview may stutter; the export is not affected.
- **Export on the rig**, worst case at 1080p: a moving zoom (45.2) + a crossfade (1.05) + a magnifier
  (1.9) + callouts and bar (1) + CPU colour (41.9) + the copy (1.05) ≈ 92 ms a frame.
- **Memory**: one scratch target per raster mode for composing A\*, with one set of the layers'
  per-target copies (crop, rgb, two grade copies and the tilt canvas at the source's size: up to
  about 100 MB for a 4K recording), kept until the preview or the export ends; the A\* canvases at
  the target's size (8 MB at 1080p, 33 MB at 4K; 2 in the export, 4 in the preview at its size);
  the export's still copies, at most one window's (two frames) at a time; two `FreezeStills` LRUs of
  6; LUT and shaper textures up to 5.2 MiB; a decoded bed up to 55.0 MB in the preview; `aloop` up
  to 43.4 MB in the export. WebGL contexts: the grade's one, plus the tilt layer's on the scratch
  target when tilt is on, whatever the number of cuts.
- **Per-frame lookups**: `joinAt` is a binary search on a memoised plan; `punchAt` a lookup in a
  memoised per-clip array; `sfxJob` runs once per export and once per change in the preview.
- **Measuring on Windows**: the export logs per-frame decode, draw and encode times
  (`exporter.ts:541-544`). The e2e test logs them for a graded project with crossfades (§19.3).
  `tests/editingPerf.test.ts` holds the pure parts (joinPlan of 20,000 clips under 20 ms, joinAt
  under 2 µs, joinFeed of 20,000 output frames and 2,000 windows under 30 ms, curve baking under
  1 ms, parsing a 33³ cube under 40 ms).

---

## 16. Undo

One user action is one `store.update`:

- Smooth all cuts; Use hard cuts everywhere; Give them the same style; a cut's style, length, size,
  colour or direction (a slider drag merges through the gesture key, `editStore.ts:9-18`).
- Add magnifier (with its zoom and place); any magnifier setting.
- Adding a badge, a bubble or a shape (with its default motion); a callout's motion, speed or sound;
  a group change of motion or sound; a style change; dragging a badge, a tail or a body; a badge's
  numbering, *Start from*, *Restart at each chapter* or *Follows the zoom*.
- The progress bar's switch and each of its settings.
- A look; a slider drag; a slider's Reset; Import a LUT (the file copy is not undoable, as music
  picks are not; the update that uses it is); Remove LUT; Reset colour; Auto colour.
- Use a bed, or Download and use (the copy first, then one update); a sound-effect rule; *Soft
  whoosh when zooming in*; the effects volume.
- Polish (with its Smooth cuts step) stays one undo step. Keep and Remove in Review are one each.
- A download is not an edit and has no undo.

---

## 17. Files, exported signatures and builder parts

### 17.0 Contracts step (first; frozen afterwards)

Made by the lead on `rev/wave10-design` after `rev/versions` and Captions Studio phase B (with its
review fixes) have merged, before any part starts. Changed later only with every part's agreement,
recorded here. The contracts close every seam two parts would share: each existing file below is
completed here, calls only functions that live in one part's new files, and is not edited by any
part afterwards.

- **Types**: `src/shared/types.ts` (§4.1); `src/shared/api/export.ts` (`effects`, `bed`);
  `RenderScene.compare` (`compositor.ts`); `src/shared/api/soundLibrary.ts` (new:
  `SoundLibraryState { id: string; state: 'bundled' | 'downloaded' | 'missing' | 'downloading';
  bytes: number; progress?: number }`, the channel names, `SoundLibraryApi`) and
  `src/preload/soundLibrary.ts` (stub).
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
- **Data, final**: `src/shared/audio/soundLibrary.ts` (`MUSIC_BEDS`, `SOUND_EFFECTS`, `ARTISTS`,
  `REJECTED_ARTISTS`, `SOUND_LIBRARY_SOURCE` (null until §0 decision 1 is made), `soundBed(id)`,
  `soundEffect(id)`, `soundFileRe(): RegExp`, `sfxTitle(ref: SfxRef | 'pop' | 'ding'): string`,
  `musicCredit(project: Project): string | null`); `scripts/build-sound-library.mjs` and
  `scripts/sound-library/evidence/`; `resources/sound-library/` (4 beds, 16 effects, `SOUNDS.md`)
  committed after `build-sound-library.mjs --check` passes; `resources/notices/37-sound-library.txt`;
  `src/shared/render/looks.ts` (`LOOKS`, `SCREEN_LOOKS`, §9.4); `src/shared/render/editingFonts.ts`
  (`editingFontIds(project: Project): string[]`, §7.6).
- **Packaging**: the `extraResources` entry (`soundLibraryResource()` in `scripts/lib/packaging.cjs`)
  and `SOUND_LIBRARY_BUDGET`.
- **Shared seams, completed** (each call goes to a stub in the owning part's new file that returns
  its input or does nothing, so a part merged before another never changes how anything draws or
  sounds):
  - `compositor.ts`: `drawFrame` split into `drawFramePicture` and `drawFrameOverlays`; the
    `FrameExtras` parameter; `punchedCamera` on the frame's and the sub-frames' cameras,
    `beginJoin`, `endJoin` (P1: `joins.ts`, `joinLayer.ts`); `drawMagnifierLayer`, `drawChapterBar`
    (P2: `magnifierLayer.ts`, `chapterBarLayer.ts`); `gradeScreen` with `scene.compare` (P4:
    `gradeLayer.ts`).
  - `webcamLayer.ts`: `gradeCamera` and the blur cache key (P4); the framing zoom times
    `punchAt` in camera-led and side-by-side layouts (P1).
  - `safeZones.ts`: `textAreaWithoutBar` and the band from `barBand` (P2: `chapterBar.ts`).
  - `textOverlays.ts`, `shapesLayer.ts`, `titleCardLayer.ts`: a branch into `drawCallout`,
    `shapeCalloutPose`, `titleCalloutPose` (P3: `calloutLayer.ts`), taken only with the new fields.
    `titleCardLayer.ts` also exports `cardFont` and `CATALOG_FALLBACK`.
  - `fontLoader.ts`: `catalogIdsOf` adds `editingFontIds(project)` (one line).
  - `popSound.ts`: `popJob` skips `SfxRef` sounds (one line).
  - `exporter.ts`: `SoundParts` and `hasSound` count `effects`; `soundOf` sets `effects` from
    `sfxJob(project, startOf)` with the same `startOf` as `studioSounds` (P5; the stub returns `[]`,
    and an empty list is left out of the job) and `musicOf` sets `bed` from `music.library`;
    `prepare()`, `renderThumbnail` and the contrast probe's caller await
    `prepareEditingAssets(project)` (`src/renderer/src/editor/editingAssets.ts`, written in full:
    it awaits `prepareLuts` from P4's `lutCache.ts`, a stub that resolves at once).
  - `review.ts` and `copy.ts`: the kinds `join` and `colour`, `KIND_WORDS`, and the hook into
    `editingReview.ts`, written in full as an aggregator of `joinReview.ts` (P1) and
    `colourReview.ts` (P4), both stubs returning no items.
  - `captionReview.ts` (phase B): a pop-up's title names its sound through `sfxTitle` (in full).
  - `polish.ts`, `polishCopy.ts`, `PolishDialog.tsx`, `polishRunner.ts`: `'smoothCuts'` in
    `PolishStep` and `POLISH_STEPS`, its label and skip texts, and a runner entry that skips it as
    `'off'`, so every `Record<PolishStep, …>` compiles. P1 makes it run.
  - `commands.ts` and `shortcuts.ts`: the 13 command ids of §2.8 (titles, categories, keywords)
    after the versions branch's, each with `[]` in `DEFAULT_KEYMAP`. `Editor.tsx`: each command
    opens its tab until its part wires it; the settle chain gains `settleJoins` and `settleGrade`
    (stubs).
  - `player.ts`: the *Compare* toggle sets `scene.compare` for the preview only (P4 reads it in
    `gradeLayer`).
  - `Timeline.tsx`: the spotlight row asks `spotlightName(s)` and `spotlightIcon(s)` (P2:
    `magnifier.ts`; the stubs give today's name and icon).
  - `PreviewStage.tsx`: one mount line for `<CalloutHandles>` (P3, new file).
  - One mount line each for the new sections (stubs returning null): `ClipPanel.tsx` (`CutsSection`,
    `CutStyleSection`), `ShapesPanel.tsx` (`MagnifierSection`, `CalloutSection`), `ZoomPanel.tsx`
    (`MagnifierZoomRow`), `TextPanel.tsx` (`CalloutSection`, `BadgeSection`, `BubbleSection`,
    `ChapterBarSection`), `EffectsPanel.tsx` (`ScreenColourSection`, `CalmMotionRow`,
    `ProgressBarLink`), `CameraPanel.tsx` (`CameraColourSection`), `AudioPanel.tsx`
    (`MusicLibrarySection`, `SoundEffectsSection`), the Downloads settings
    (`MusicDownloadsSection`).
  - `versions.ts` `AREAS` and `namedFiles` (§4.6); `MEDIA_FILE_RE` (`lut-<n>.cube`) and the
    `sounds` host (stub: 404); `ASSET_SPECS.lut` with `checkCube` (calls `parseCube`).
- **Equivalence guard** (§19.2), written and passing against the code before the hooks go in, and
  passing again after.
- `tests/editingContracts.test.ts` (§19.1 tests 1–7).
- The `data-testid` list of §2 as a comment block at the top of `tests/e2e/editing-polish.e2e.cjs`.

**As made on `feat/wave10`** (the names the parts build on, where this section left a choice):

- Commands: `smoothAllCuts`, `hardCutsEverywhere`, `nextCut`, `previousCut`, `playCut`, `addMagnifier`,
  `addMagnifierCursor`, `addStepBadge`, `addSpeechBubble`, `toggleProgressBar`, `compareColour`,
  `autoColour`, `musicLibrary`.
- Readers: `joinData.ts` also exports `JOIN_LENGTHS` and `PUNCH_LIMITS` (P1's `JOIN_DEFAULTS` and
  `PUNCH_SCALE` are them), `JOIN_KINDS`, `SLIDE_FROM`; `calloutData.ts` exports `CALLOUT_ALLOWED`
  (P3's `CALLOUT_KINDS` is it), `readCalloutFields`, `isCallout` (the drawing code's test),
  `graphemesOf`, `calmOf`, `badgesByChapterOf`; `soundFxData.ts` `readItemSound` and
  `readGraphicSound`; `gradeData.ts` `LUT_FILE_RE`, `GRADE_SLIDERS`, `cleanLutTitle`;
  `shapeData.ts` `MAGNIFY_RANGE`.
- Catalogue: `BED_SOURCES`, `EFFECT_SOURCES`, `SFX_UPSTREAM` (by file name), `ARTISTS`,
  `REJECTED_ARTISTS` and `REJECTED_EVIDENCE`, `MOODS`, `LIBRARY_RATE`, `BED_PAD`; each bed's analysed
  loop as `loop { start, end }`; prepared files are `bed-<id>.ogg` and `sfx-<id>.ogg`, their pins in
  the JSON block `PREPARED` (`PREPARED_PINS`) that the build script writes once per id. The chosen
  release is `SOUND_LIBRARY_RELEASE`; `SOUND_LIBRARY_SOURCE` stays null until it exists.
- The build script runs 7-Zip's `7zz` when one is given (`--7zz`, `SEVEN_ZIP`) or on the PATH, else
  the system's libarchive through Python's ctypes (`scripts/sound-library/libarchive.py`); either way
  every archive is listed and checked first, and `SOUNDS.md` records the extractor that ran, its
  version and its SHA-256.
- `drawFramePicture` leaves the context saved once; `drawFrame` restores it after
  `drawFrameOverlays`. `drawAnnotations` takes the frame context as an optional last argument.
  `textAreaWithoutBar` is exported from `safeZones.ts`. `RenderScene.compare` is set by the
  player's `setCompare(on)`.
- Polish: `PolishSummary.smoothCuts?` (the cuts smoothed); until P1 the step is skipped as `'off'`
  and `polishAvailability` gives it `'off'`.
- Assets: an `AssetSpec` with `whole: true` (the LUT) is checked on its whole file, read once and
  stored from the same bytes; LUT picks prune to the three newest plus the saved project's two.
- The sound library's API: `soundLibraryList`, `soundLibraryDownload`, `soundLibraryCancel`,
  `soundLibraryRemove`, `soundLibraryUseBed`, `onSoundLibraryProgress` (channel
  `soundLibrary:progress`).

### 17.1 Part P1 · Smooth cuts

| File | Exports or change |
|---|---|
| `src/shared/render/joins.ts` (new) | `const JOIN_DEFAULTS: Readonly<Record<'crossfade' \| 'dip' \| 'slide', { duration: number; min: number; max: number }>>`; `const PUNCH_SCALE: { default: 1.1; min: 1.05; max: 1.2 }`; `const FLASH_GAP = 1.0`; `interface CutRef { index: number; clip: string; edit: number; video: number }`; `function cutsOf(clips: readonly Clip[], plan: FreezePlan): readonly CutRef[]`; `function cameraLed(project: Project, t: number): boolean`; `function resolvedJoin(project: Project, index: number): CutJoin \| null` (never `'smooth'`: resolved to `'crossfade'` or `'punch'`); `interface JoinWindow { index: number; clip: string; kind: 'crossfade' \| 'dip' \| 'slide'; from: number; to: number; at: number; still: { screen: number; held: boolean; camera: number \| null } \| null; color?: string; dir?: SlideFrom }`; `function joinPlan(project: Project): readonly JoinWindow[]`; `interface JoinAt { window: JoinWindow; p: number }`; `function joinAt(windows: readonly JoinWindow[], video: number): JoinAt \| null`; `interface TrackTimes { starts: Float64Array; half: number }`; `function trackTimes(samples: readonly { time: number; duration: number }[] \| null, fallbackFps: number, seconds: number): TrackTimes`; `function stillFrame(track: TrackTimes, instant: number, held: boolean, aStart: number): { index: number; ask: number }`; `function punchAt(project: Project, t: number): number`; `function punchedCamera(cam: Camera, project: Project, t: number): Camera`; `function joinPose(at: JoinAt, w: number, h: number): { live: { dx: number; dy: number }; still: { alpha: number; dx: number; dy: number } \| null; fill: { color: string; alpha: number } \| null }`; `function frameVideoTime(clips: Clip[], plan: FreezePlan, t: number, hold: { start: number; elapsed: number } \| null, leftHoldAt: number \| null): number`; `interface JoinFeed { screen: number[]; camera: number[]; draw: { screen: Int32Array; camera: Int32Array }; stills: { window: number; screen: number; camera: number \| null }[] }`; `function joinFeed(input: { pictures: readonly number[]; cameraTimes: readonly number[] \| null; windows: readonly JoinWindow[]; fps: number; screen: TrackTimes; camera: TrackTimes \| null }): JoinFeed` |
| `src/shared/editor/joinsEdit.ts` (new) | `function smoothAllCuts(project: Project): { project: Project; changed: number; kept: number }`; `function hardCutsEverywhere(project: Project): Project` (stores `{ kind: 'cut' }`); `function withJoinAll(project: Project, join: CutJoin \| null): Project`; `function withCutJoin(project: Project, clip: string, join: CutJoin \| null): Project` (null: same as every cut); `function giveSameStyle(project: Project): Project`; `function settleJoins(next: Project, prev: Project): Project`; `function cutCount(project: Project): number`; `function cutNumber(project: Project, start: number): { n: number; of: number } \| null`; `function joinLabel(join: CutJoin \| null): string`; `function nextCutAfter(project: Project, t: number): { start: number; end: number } \| null`; `function prevCutBefore(project: Project, t: number): { start: number; end: number } \| null`; `function smoothHere(project: Project, index: number): 'crossfade' \| 'punch'` |
| `src/shared/review/joinReview.ts` (new) | `function joinReviewItems(project: Project): ReviewItem[]`; `function joinItemStatus(project: Project, item: ReviewItem): ReviewStatus`; `function keepJoinItems(project: Project, items: readonly ReviewItem[]): Project`; `function removeJoinItems(project: Project, items: readonly ReviewItem[]): Project` |
| `src/renderer/src/render/joinLayer.ts` (new) | `function beginJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join']): void`; `function endJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join']): void`; `function scratchTarget(raster: 'gpu' \| 'cpu', w: number, h: number): CanvasRenderingContext2D`; `function releaseScratch(): void` (calls `releaseTilt` and `releaseGrade`); `function composeJoinStill(scratch: CanvasRenderingContext2D, out: HTMLCanvasElement, w: number, h: number, window: JoinWindow, scene: RenderScene, stills: { screen: FrameImage; camera: FrameImage \| null }, background: HTMLImageElement \| null): void` |
| `src/renderer/src/editor/joinStills.ts` (new) | `class JoinStills { constructor(screenUrl: string, webcamUrl: string \| null, onReady: () => void, segment?: (still: ImageBitmap) => Promise<void>); prepare(windows: readonly JoinWindow[], scene: RenderScene, w: number, h: number): void; still(window: JoinWindow, w: number, h: number): CanvasImageSource \| null; dispose(): void }` (opens both tracks with `openTrack`, composes ahead) |
| `player.ts`, `ExportPreview.tsx` | Video time per frame (`frameVideoTime`), the join and its still, stills of the next three cuts, the playing rule for late stills, *Play this cut*. |
| `exporter.ts` | `joinPlan` in the plan; `trackTimes` from `openTrack`; `joinFeed` for both sources; still copies; A\* composed on the scratch target before each window. |
| `PreviewStage.tsx` | Its three `frameCamera` calls go through `punchedCamera`. |
| `src/renderer/src/editor/panels/CutsSection.tsx`, `CutStyleSection.tsx`, `cuts.css` (new) | `function CutsSection(props: { project: Project }): JSX.Element \| null`; `function CutStyleSection(props: { project: Project; gap: { start: number; end: number } }): JSX.Element \| null` |
| `Timeline.tsx` | The cut markers (fixed size, 24 px targets, merging, names), after the versions branch's `Filmstrip`. |
| `polish.ts`, `polishCopy.ts`, `PolishDialog.tsx`, `polishRunner.ts` | The Smooth cuts step made to run. |
| `Editor.tsx` | Handlers of *Smooth all cuts*, *Use hard cuts everywhere*, *Go to next cut*, *Go to previous cut*, *Play this cut*; `settleJoins`. |
| Tests | 8–24, 74–76 (§19.1) |

### 17.2 Part P2 · Magnifier and progress bar

| File | Exports or change |
|---|---|
| `src/shared/render/magnifier.ts` (new) | `const MAGNIFIER: { enter: 0.3; exit: 0.22; size: 0.3; min: 1.5; max: 4; step: 0.25; defaultMin: 1.5; defaultMax: 2.5; targetPpr: 2; softAbove: 2.5; ring: 0.004; shadowY: 0.006; shadowBlur: 0.02; shadowAlpha: 0.35; corner: 0.18 }`; `function isMagnifier(s: Spotlight): boolean`; `function magnifierPhase(s: Spotlight, t: number, clips: Clip[], calm: boolean): { r: number; z: number; alpha: number } \| null`; `function lensCamera(cam: Camera, centre: { x: number; y: number }, z: number): Camera`; `function lensBox(s: Spotlight, centre: { x: number; y: number }, rect: Rect, cam: Camera, r: number, toOut: (x: number, y: number) => { x: number; y: number }): { cx: number; cy: number; rx: number; ry: number }`; `function defaultZoom(ppr: number): number`; `function newMagnifier(project: Project, t: number, view: { rect: Rect; cam: Camera; w: number; h: number; centre: { x: number; y: number }; cursor: { x: number; y: number } \| null }, mode: 'region' \| 'cursor'): { project: Project; id: string }`; `function spotlightName(s: Spotlight): string`; `function spotlightIcon(s: Spotlight): 'spotlight' \| 'magnifier'` |
| `src/renderer/src/render/magnifierLayer.ts` (new) | `function drawMagnifierLayer(fc: FrameContext): void` |
| `src/renderer/src/render/spotlightLayer.ts` | A magnifier's lit area and alpha from `magnifierPhase` (§6.4). |
| `src/shared/render/chapterBar.ts` (new) | `const CHAPTER_BAR: { inset: 0.03; thick: 0.008; edgeThick: 0.006; gap: 0.005; label: 0.042; labelTall: 0.036; labelGap: 0.01; pillAlpha: 0.55; grow: 1.5; growTime: 0.15; fade: 0.3; show: 3; cross: 0.2 }`; `interface BarSegment { from: number; to: number; title: string \| null; x0: number; x1: number }`; `interface BarLayout { edge: 'top' \| 'bottom'; x0: number; x1: number; y: number; th: number; gap: number; round: boolean; color: string; labels: ChapterBar['labels']; labelPx: number; segments: BarSegment[] }`; `function captionsAtTop(project: Project, w: number, h: number): boolean`; `function chapterBarLayout(project: Project, w: number, h: number, area: Rect \| null): BarLayout \| null`; `function barBand(project: Project, w: number, h: number): { edge: 'top' \| 'bottom'; size: number } \| null`; `function barState(layout: BarLayout, video: number, t: number, project: Project): { alpha: number; current: number; grow: number; labelAlpha: number }` (alpha includes the full-frame title card's fade) |
| `src/renderer/src/render/chapterBarLayer.ts` (new) | `function drawChapterBar(fc: FrameContext, video: number): void` |
| `src/renderer/src/editor/panels/MagnifierSection.tsx`, `MagnifierZoomRow.tsx`, `ChapterBarSection.tsx`, `ProgressBarLink.tsx`, `magnifier.css` (new) | `function MagnifierSection(props: { project: Project; selection: Selection }): JSX.Element`; `function MagnifierZoomRow(): JSX.Element`; `function ChapterBarSection(props: { project: Project }): JSX.Element`; `function ProgressBarLink(): JSX.Element` |
| `src/renderer/src/editor/playheadItems.ts` | `addMagnifierAt(services, mode, cursor, opts): Spotlight`, beside `addSpotlightAt`. |
| `Editor.tsx` | Handlers of *Add magnifier*, *Add magnifier on the cursor*, *Progress bar on the video*. |
| Tests | 25–35, 77 |

### 17.3 Part P3 · Animated callouts

| File | Exports or change |
|---|---|
| `src/shared/render/callouts.ts` (new) | `type CalloutItem = 'text' \| 'badge' \| 'bubble' \| 'arrow' \| 'box' \| 'highlight' \| 'title'`; `const CALLOUT_KINDS: Readonly<Record<CalloutItem, { enter: readonly CalloutMotionKind[]; exit: readonly CalloutMotionKind[] }>>`; `const CALLOUT_DEFAULTS: Readonly<Record<CalloutItem, { enter: CalloutMotion; exit: CalloutMotion }>>`; `function calloutItemOf(kind: AnnotationStyle \| ShapeKind \| 'title'): CalloutItem \| null`; `function withDefaultMotion<T extends Shape>(shape: T): T`; `interface CalloutPose extends ChunkPose { drawn: number }`; `function calloutPose(start: number, end: number, t: number, clips: Clip[], enter: CalloutMotion \| undefined, exit: CalloutMotion \| undefined, u: number, calm: boolean, oldFade: number): CalloutPose \| null`; `function graphemes(text: string): string[]`; `function badgeLabels(project: Project): ReadonlyMap<string, string>`; `function badgeTextColor(fill: string): '#ffffff' \| '#111111'`; `function badgeBox(label: string, px: number, measure: (text: string, px: number) => number): { w: number; h: number; px: number; radius: number }`; `function wrapCallout(text: string, maxWidth: number, measure: (s: string) => number): string[]`; `function bubbleBody(tip: { x: number; y: number }, body: { dx: number; dy: number }, size: { w: number; h: number }, s: number, area: Rect): Rect`; `function bubbleTail(body: Rect, tip: { x: number; y: number } \| null, f: number, radius: number): { base: [{ x: number; y: number }, { x: number; y: number }]; tip: { x: number; y: number } } \| null`; `function rectPerimeter(w: number, h: number): number`; `function ellipsePerimeter(a: number, b: number): number` |
| `src/shared/editor/calloutsEdit.ts` (new) | `function addBadge(project: Project, t: number, at: { pin: { x: number; y: number } \| null; x: number; y: number }, language: string \| null): { project: Project; id: string }`; `function addBubble(project: Project, t: number, at: { pin: { x: number; y: number }; body: { dx: number; dy: number }; x: number; y: number }): { project: Project; id: string }`; `function withCallout(project: Project, ref: { kind: 'annotation' \| 'shape' \| 'title'; id: string }, patch: { enter?: CalloutMotion \| null; exit?: CalloutMotion \| null; sound?: 'none' \| SfxRef \| null }): Project`; `function movePin(project: Project, id: string, pin: { x: number; y: number }, shownAt: { x: number; y: number }): Project`; `function moveBody(project: Project, id: string, body: { dx: number; dy: number }, shownAt: { x: number; y: number }): Project` |
| `src/renderer/src/render/calloutLayer.ts` (new) | `function drawCallout(c: CanvasRenderingContext2D, top: FrameContext, a: Annotation, label: string \| null): boolean` (false: not a callout, today's code draws it); `function shapeCalloutPose(fc: FrameContext, s: Shape): CalloutPose \| null`; `function titleCalloutPose(fc: FrameContext, card: TitleCard): CalloutPose \| null` |
| `src/shared/render/overlays.ts` | `annotationMetrics` covers badges and bubbles, through the frame's camera for pins, so the preview's handle matches what is drawn. |
| `src/shared/render/titleCards.ts` | The title card's pose hook for `titlePhase`. |
| `src/renderer/src/render/bubblePath.ts` (new), `studioLayer.ts` | `export function bubblePath(c: CanvasRenderingContext2D, r: Rect, radius: number, tail: number, target: { x: number; y: number } \| null): void`, moved; `studioLayer.ts` imports it. |
| `src/renderer/src/editor/playheadItems.ts` | `addShapeAt` passes new shapes through `withDefaultMotion`. |
| `src/shared/editor/groupEdit.ts` | The nine group fields of §7.1; *Copy look* carries `enter`, `exit`, `sound`, `color`, `numbering`. |
| `src/renderer/src/editor/CalloutHandles.tsx` (new) | `function CalloutHandles(props: { project: Project; selection: Selection; view: SceneView }): JSX.Element \| null` (badge and tail handles, drag and arrow keys) |
| `src/renderer/src/editor/panels/CalloutSection.tsx`, `BadgeSection.tsx`, `BubbleSection.tsx`, `CalmMotionRow.tsx`, `callouts.css` (new) | each `(props: { project: Project; selection: Selection }) => JSX.Element \| null` (`CalmMotionRow`: `{ project }`) |
| `Editor.tsx` | Handlers of *Add step badge*, *Add speech bubble* (placement by the cursor, focus on the bubble's text). |
| Tests | 36–45, 78–79 |

### 17.4 Part P4 · Colour

| File | Exports or change |
|---|---|
| `src/shared/render/colorGrade.ts` (new) | `interface ResolvedGrade { temperature: number; tint: number; exposure: number; brightness: number; contrast: number; highlights: number; shadows: number; fade: number; saturation: number; vibrance: number; split: { kS: number; kH: number }; lutStrength: number }`; `function resolveGrade(g: ColorGrade \| undefined, which: 'screen' \| 'camera'): ResolvedGrade \| null` (null: identity); `function whiteBalanceGains(temperature: number, tint: number): [number, number, number]`; `function gradeTable(g: ResolvedGrade): Float32Array` (768 linear values); `function gradeKey(g: ResolvedGrade \| null, lut: CubeLut \| null): string`; `function shaperSample(lut: CubeLut, v: number, channel: 0 \| 1 \| 2): number`; `function lutSample(lut: CubeLut, r: number, g: number, b: number): [number, number, number]` (shaper, then tetrahedral); `function gradePixel(rgb: readonly [number, number, number], g: ResolvedGrade, table: Float32Array, lut: CubeLut \| null): [number, number, number]` (the reference); `function gradePixelsCpu(data: Uint8ClampedArray, g: ResolvedGrade, table: Float32Array, lut: CubeLut \| null): void`; `function shaperTexel(i: number): [number, number]` |
| `src/renderer/src/render/gradeLayer.ts` (new) | `function gradeBackend(): 'gl' \| 'cpu'`; `function gradeBackendReason(): string \| null`; `function gradeScreen(target: CanvasRenderingContext2D, frame: FrameImage, grade: ColorGrade \| undefined, lut: CubeLut \| null, compare?: boolean): FrameImage`; `function gradeCamera(target: CanvasRenderingContext2D, frame: FrameImage, grade: ColorGrade \| undefined, lut: CubeLut \| null, compare?: boolean): FrameImage`; `function releaseGrade(target: CanvasRenderingContext2D): void`; `function forceGradeBackend(b: 'gl' \| 'cpu' \| null): void` (tests and e2e only) |
| `src/renderer/src/render/lutCache.ts` (new) | `function lutFor(project: Project, which: 'screen' \| 'camera'): CubeLut \| null`; `function lutProblem(project: Project, which: 'screen' \| 'camera'): string \| null`; `function prepareLuts(project: Project): Promise<void>`; `function onLutReady(cb: () => void): () => void` |
| `src/shared/editor/colourEdit.ts` (new) | `function withGrade(project: Project, which: 'screen' \| 'camera', patch: Partial<ColorGrade> \| null): Project`; `function resetSlider(project: Project, which: 'screen' \| 'camera', key: keyof ColorGrade): Project`; `function withLook(project: Project, which: 'screen' \| 'camera', look: LookId \| null, strength?: number): Project`; `function withLut(project: Project, which: 'screen' \| 'camera', lut: ColorLut \| null): Project`; `function settleGrade(next: Project, prev: Project): Project` |
| `src/shared/editor/autoColour.ts` (new) | `interface ColourSample { pixels: Uint8ClampedArray; mask: Uint8ClampedArray \| null; w: number; h: number; face: Rect \| null }`; `function autoCameraGrade(samples: readonly ColourSample[]): ColorGrade \| null`; `function withAutoColour(project: Project, grade: ColorGrade): Project` (keeps an existing `grade.auto.camera`) |
| `src/renderer/src/editor/autoColourRun.ts` (new) | `async function runAutoColour(deps: { project: Project; webcamUrl: string; signal: AbortSignal }): Promise<ColorGrade \| null>` |
| `src/shared/review/colourReview.ts` (new) | `colourReviewItems`, `colourItemStatus`, `keepColourItems`, `removeColourItems` (as P1's) |
| `src/main/lutImport.ts` (new), `src/main/assetIpc.ts` | `async function importLut(projectDir: string, source: string): Promise<{ file: string; sha256: string; title: string; size: number }>`; the `'lut'` kind's pick. |
| `src/renderer/src/editor/panels/ScreenColourSection.tsx`, `CameraColourSection.tsx`, `ColourControls.tsx`, `colour.css` (new) | `function ScreenColourSection(props: { project: Project }): JSX.Element`; `function CameraColourSection(props: { project: Project }): JSX.Element \| null`; `function ColourControls(props: { project: Project; which: 'screen' \| 'camera' }): JSX.Element` |
| `src/renderer/src/editor/ExportDialog.tsx` | The missing-LUT question before an export starts (§9.5). |
| `Editor.tsx` | *Compare with original colour*, *Auto colour for the camera*; `settleGrade`. |
| Tests | 46–58, 80–82 |

### 17.5 Part P5 · Music and sound effects

| File | Exports or change |
|---|---|
| `src/shared/audio/soundLibrary.ts` | Adds `function bedSeconds(bed: MusicBed): number` (E / 48000); `function bedTime(bed: MusicBed, out: number, loop: boolean): number`; `function bedLoop(bed: MusicBed): { start: number; end: number }` (samples at 48 kHz). |
| `src/shared/render/sfxJob.ts` (new) | `const SFX_VOLUME = 0.35`; `const MAX_SFX = 16`; `const RULE_GAP = 3.0`; `function sfxJob(project: Project, startOf?: (g: Graphic) => number): { id: string; times: number[]; gain: number }[]`; `function sfxCounts(project: Project, startOf?: (g: Graphic) => number): Readonly<Record<'zoomIn' \| 'zoomOut' \| 'titles' \| 'callouts', number>>` |
| `src/shared/render/audioPlan.ts` | `function bedGraph(m: MusicPart, loop: { start: number; end: number }, looping: boolean, duration: number, out?: string): string`; `planSoundtrack` adds effect inputs and the bed graph. |
| `src/main/exportJob.ts` | `validEffects`, the bed check, `resolveSoundInputs` for effects, beds and the loop cache. |
| `src/main/soundLibrary/paths.ts`, `store.ts`, `ipc.ts` (new) | `function bundledSoundDir(): string`; `function soundPath(file: string): string \| null`; `function allowSoundUrl(url: URL, testBase?: string \| null): boolean`; `async function listLibrary(): Promise<SoundLibraryState[]>`; `async function downloadBed(id: string, opts: { signal: AbortSignal; onProgress(p: number): void }): Promise<SoundLibraryState>`; `async function removeDownloadedBeds(): Promise<void>`; `async function useBed(projectDir: string, id: string): Promise<{ file: string }>`; `function registerSoundLibraryIpc(): void` (sender checks) |
| `src/main/musicLoopCache.ts` (new) | `async function loopableMusic(projectDir: string, file: string, ffmpeg: string, opts: { seconds: number; signal: AbortSignal; timeoutMs: number }): Promise<string>` (§0 decision 2; free space, `-t`, clean-up) |
| `src/main/mediaProtocol.ts`, `src/preload/soundLibrary.ts` | The `sounds` host; the preload API. |
| `src/renderer/src/editor/previewAudio.ts`, `src/shared/audio/settings.ts` | The bed's buffer node on the drift loop, library effects, the stop rule, `effectsOf`'s inputs; `needsAudioGraph`; `audioLook` reads `library`. |
| `src/renderer/src/editor/panels/MusicLibrarySection.tsx`, `SoundEffectsSection.tsx`, `soundLibrary.css`, `src/renderer/src/settings/MusicDownloadsSection.tsx` (new) | `function MusicLibrarySection(props: { project: Project }): JSX.Element`; `function SoundEffectsSection(props: { project: Project }): JSX.Element`; `function MusicDownloadsSection(): JSX.Element` |
| `GraphicsPanel.tsx`, `src/shared/captions/great.ts`, `graphicRules.ts` | Library sounds in the Sound select (with the Original group) and in *Make my captions great*. |
| `src/shared/publish/youtube.ts` | The music credit line. |
| `scripts/verify-dist.mjs`, `docs/RELEASING.md` | Every sound file's hash in the built app; the release check of §10.3. |
| Tests | 59–73, 83–84 |

### 17.6 Not touched, and merging

**Not touched by any part**: the recording side (listed at the top), `Home.tsx`,
`src/main/security.ts`, the CSP, the window options, `appSettings.ts`, `cutFades.ts` and the
preview's cut fades, `exportFrameTimes`, `videoFrames`, `outputDuration` (no length changes),
`frameView.ts` (frozen), `itemPose` and `motion.ts` (reused, not changed), `frameSource.ts` and
`feedPlan.ts` (the decoder is fed differently, not changed), the legacy caption code.

**Ownership of shared files.** The files completed by the contracts (§17.0: `compositor.ts`,
`webcamLayer.ts`, `safeZones.ts`, `textOverlays.ts`, `shapesLayer.ts`, `titleCardLayer.ts`,
`fontLoader.ts`, `popSound.ts`, `review.ts`, `copy.ts`, `editingReview.ts`, `editingAssets.ts`,
`captionReview.ts`, the Polish files' declarations, `commands.ts`, `shortcuts.ts`, the panels' mount
lines) are edited by no part. The other existing files have one owner each:

| Part | Existing files it edits |
|---|---|
| P1 | `player.ts`, `ExportPreview.tsx`, `exporter.ts` (the join feed, below the contracts' lines), `PreviewStage.tsx` (the `frameCamera` calls), `Timeline.tsx` (cut markers), the Polish files (the step's body) |
| P2 | `spotlightLayer.ts`, `playheadItems.ts` (`addMagnifierAt`) |
| P3 | `overlays.ts`, `titleCards.ts`, `studioLayer.ts` (one import), `groupEdit.ts`, `playheadItems.ts` (`addShapeAt`'s one line) |
| P4 | `ExportDialog.tsx`, `assetIpc.ts` |
| P5 | `previewAudio.ts`, `settings.ts`, `audioPlan.ts`, `exportJob.ts`, `mediaProtocol.ts`, `GraphicsPanel.tsx`, `great.ts`, `graphicRules.ts`, `youtube.ts`, `verify-dist.mjs`, `RELEASING.md` |

`playheadItems.ts` is edited by P2 (a new function) and P3 (one line in `addShapeAt`) in separate
places; `Editor.tsx` gets one handler block per part, in separate places of the command map. Both
merge without overlap.

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
| 1 | Old projects change through shared code (`drawFrame`'s split, `textArea`, the readers, `migrateProject`, `popJob`, `planSoundtrack`, `catalogIdsOf`, `hasSound`). | Every new step is behind a guard that returns at once without its field; the equivalence guard is written before the contracts and never regenerated (§19.2); audio graph strings are compared character for character. |
| 2 | A crossfade shows a frame the user cut out. | A\* is the frame that holds A's last instant, which starts inside A (§5.3), and is drawn with every privacy shape active there; nothing inside a cut is decoded for drawing that today's export does not already show; e2e step E5 checks a secret inside a cut never appears. |
| 3 | The export's decoder is fed a frame it has passed and throws "The video decoder skipped a frame" (`frameSource.ts:174`), falling to the slow path. | Stills are chosen from each track's own frame times and inserted at their sorted place in each feed, so indices never decrease (§5.8); a property test at many proxy, camera and output rates (test 12) and a test that runs the decoder's own skip rule over the feeds (test 74). |
| 4 | The preview's still is late and the cut looks hard, or the old frame flashes back mid-window. | Stills of the next three cuts are made and composed ahead; while playing, a window whose still was late stays hard to its end; the export is not affected. |
| 5 | Composing A\* multiplies memory and WebGL contexts. | One scratch target per raster mode, copies into plain canvases, release on dispose (§5.6); test 76 counts contexts. |
| 6 | The camera's blurred room flashes in A\*. | A\*'s camera frame gets its person mask before composing, in preview and export alike (§5.6). |
| 7 | Punch-in looks like a layout glitch or cuts off the camera bubble. | It scales only the content (§5.6); the card, padding, corners and bubble never move; e2e E4 checks the card's edges stay put. |
| 8 | Smooth ghosts faces. | Camera-led cuts punch in instead (§5.2); e2e E2 and test 75. |
| 9 | Flashing dips. | The flash rule (§5.2): a dip within 1 s of another draws as a crossfade. |
| 10 | The magnifier reveals a blurred secret, or a ring of bright screen shows around it. | Privacy shapes are drawn again inside the lens through the lens camera, without a shutter (§6.4); the dimming follows the lens's growth; tests 28–29 and e2e E6. |
| 11 | Badges and bubbles point at the wrong thing while the camera zooms. | They are pinned to the recording like shapes (§7.3, §7.4); test 78 and e2e E7. |
| 12 | Colour differs between preview and export, between GPU and CPU PCs, or at the start of an export. | One backend per session for both; the input is always a 2D-canvas copy; the shader matches the JS reference within one level (measured: at most 10 of 786,432 values); the self-test is orientation-sensitive and includes a shaper; LUTs and fonts load before the first frame (`prepareEditingAssets`, test 80). |
| 13 | The CPU colour path is slow (41.9 ms at 1080p). | Only on PCs without WebGL2; a notice says so; table-only grades take one lookup per channel; the export is correct, only slower. |
| 14 | GPU cost of colour and its copies on real laptops is not measured. | Estimated; measured in P4 and on the reference Windows PC after the build (§0 decision 6), with a fallback for the `'high'` draw (§15). |
| 15 | A malicious `.cube` file. | Strict linear parser with caps, rejected before copying, re-checked by hash and parsed again before use (§9.5, §14). |
| 16 | A bed's licence turns out not to be CC0, or the artist enforces a claim. | Only artists whose own pages agree with CC0, with dated evidence kept and checked by test 6; Bartmann's catalogue rejected; a bed can be dropped by removing its row (ids never reused). |
| 17 | Music loop points sound wrong, or a bed has vocals or clashes with speech. | The listening pass with criteria before release (§0 decision 5); the speech screen; a spare per mood. |
| 18 | CC0 music gets a false Content ID claim. | The credit line in the app and in the YouTube description (§10.10). |
| 19 | The download source does not exist at release, or breaks the app's updates. | Those rows are hidden until `SOUND_LIBRARY_SOURCE` is set; the library has its own repository; the release check downloads one real asset (§10.3). |
| 20 | The library's signed CDN redirects are refused. | `allowSoundUrl` allows the source's named CDN host with any query (§10.3); test 67 uses real-shaped `Location` headers. |
| 21 | A later build re-pins every bed and breaks downloads and projects. | The build script pins once and refuses to change an existing id (§10.2, test 84). |
| 22 | Preview and export sound differ for library sounds (Opus decoding, overlapping voices, drift). | Same files decoded by both; voices cut where the next one starts, as the export does; the bed on the music's drift loop; an acceptance test renders through `OfflineAudioContext` and through ffmpeg (test 69). If Chromium's Opus pre-skip handling differs, main serves a WAV decoded by its own ffmpeg (`userData/sound-cache/<sha256>.wav`) to the preview. |
| 23 | The loop fix (§0 decision 2) changes old exports' sound, or fills the disk. | Only users' looping Opus, M4A and AAC music, only by removing the glitch; owner decision; project files unchanged; the cache is bounded by the output's length, checked against free space and cleaned up. |
| 24 | Merge conflicts with the versions branch and phase B (`commands.ts`, `shortcuts.ts`, `Editor.tsx`, `Timeline.tsx`, `review.ts`, `copy.ts`, `PolishDialog.tsx`, `exporter.ts`, `previewAudio.ts`, `great.ts`, `GraphicsPanel.tsx`, `captionReview.ts`). | The contracts step comes after both merge; it completes every shared seam, and every other file has one owner (§17.6); new UI lives in new files mounted with one line each. |
| 25 | Many cuts (edit-by-text makes thousands of clips). | `joinPlan` is built once per change (20,000 clips under 20 ms), `joinAt` is a binary search, windows are clamped to half a clip, tiny clips get a hard cut; timeline markers merge when closer than 12 px. |
| 26 | Callout motion or sounds feel busy on tutorials. | Old items keep today's fades; defaults are short (0.18–0.45 s), exits shorter than entrances; Calm motion; rule sounds at most once every 3 s; whooshes only on zooming in; no "during" loops in this wave. |
| 27 | Badges, bubbles and bar names look different across PCs (fonts) or are unreadable on phones. | They use the bundled script fonts, loaded before the export (§7.6); badge digits 0.045 S and bar names 0.042 S on a pill; e2e E8 checks a phone-width scale. |
| 28 | The progress bar overlaps captions or a title card. | `textArea` shrinks by the bar's band, Auto picks the edge away from the captions, and the bar fades under full-frame title cards (§8). |
| 29 | E2E pixels under Xvfb vary by a level or two. | Colour classes and mixes are checked within tolerances, never exact values, except where the guard compares a build with itself. |

---

## 19. Test plan

### 19.1 Unit tests (vitest). Each fails without the code of its rule.

**Contracts and the guard** (§17.0)

1. **Migration**: the fixtures of `tests/fixtures/vertical-old-projects.json` and
   `tests/fixtures/wave8-old-projects.json`, a Captions Studio project and a project with every
   wave-8 field migrate to byte-equal JSON; no new key appears; each new reader returns undefined
   for absent input and is idempotent (`read(read(x)) = read(x)`).
2. `readJoins` and `readCutJoin`: an unknown kind is dropped; `'smooth'` keeps `duration` and
   `scale`; a repeated clip keeps the first; durations clamp to the kind's range; a colour is
   lower-cased; fields of another kind are dropped; an empty object reads undefined; 20,001 entries
   read as 20,000; `auto` with a bad `was` is dropped.
3. `readColorGrade` and `readProjectGrade`: clamps; non-finite values dropped; 0 kept as written; an
   unknown look dropped; `warm` dropped on the screen and kept on the camera; `lut` dropped for a bad
   file name, hash, size or a non-string title; a title with U+202E and a NUL comes back without them
   and cut to 80; `exposure` dropped on the screen.
4. `readChapterBar`, `readSoundFx`, `readSfxRef`, `readCalloutMotion` (`'blur'` rejected for every
   item; `'draw'` only on enter and only for arrows, lines, boxes; `'wipe'` only on enter), `readShape`
   (motions dropped on blur and pixelate), `readSpotlight` (`magnify` clamped, NaN dropped),
   `readTitleCard`, `Graphic.sound` (`'sfx:nope'` dropped), `calloutOf` (`pin` and `body` clamped,
   an unknown `numbering` read as `'1'`, `startAt` 0 and 1,000 dropped, a 5-grapheme badge text
   drawn as its first 3).
5. **`parseCube`**: accepts sizes 2, 17, 33 and 65, a Resolve shaper of 65,536 entries plus a 3D
   table, `DOMAIN_*` and `*_INPUT_RANGE`, CRLF, a BOM, tabs and comments; rejects a NUL byte, size
   66, a 1D size of 65,537, a domain or input range whose span is below 1e-6 (and `1e-40`), `NaN`,
   `1e999`, `17.5` (> 16), `0x1F`, a short file, an extra line, a keyword after the data,
   `LUT_2D_SIZE`, an unknown keyword, a 1,025-character line, invalid UTF-8 and 16 MiB + 1 byte; the
   error names the line; a 65³ file parses in under 150 ms.
6. **Catalogue**: ids are unique; every bundled file exists with its pinned bytes and SHA-256;
   every effect from an archive has its `member` pinned; `build-sound-library.mjs --check` passes;
   download rows have no file in `resources/`; the bundled total fits `SOUND_LIBRARY_BUDGET`; every
   licence is `'CC0-1.0'`; every bed's artist is in `ARTISTS` with a URL, a date, a quote and the
   SHA-256 of a saved evidence file that exists and matches; no bed's artist is in
   `REJECTED_ARTISTS`; `SOUNDS.md` and `37-sound-library.txt` list every file.
7. **Contracts**: each stub is an identity (a frame drawn with and without the hooks has the same call
   log); `settleJoins` and `settleGrade` return `next` itself for old projects; `editingReview`
   lists nothing for old projects; `editingFontIds` is empty and `prepareEditingAssets` does no work
   for them; `hasSound` is unchanged without `effects`; the Smooth cuts step compiles and skips as
   `'off'`; the 13 commands exist with `[]` keys and no key conflicts (`commands.test.ts`).

**P1 · Smooth cuts**

8. `cutsOf`: trims are not cuts; touching clips with two speeds are not cuts; a gap of 1e-6 s is
   not and 2e-6 s is; T includes the holds before it; a hold at B's start makes T the hold's start.
9. `resolvedJoin`: an override beats `all`; an override of kind `'cut'` gives none; Crossfade clamps
   to `len(B) / 2`; a 0.1 s clip with Crossfade 0.15 gets 0.05 s, under 2/30, so a hard cut; a Dip's
   half is bounded by both clips; Calm motion turns Slide into Crossfade; the result is never
   `'smooth'`.
10. **Flash rule**: dips with T at 0.5, 1.2, 1.9 and 3.5 s draw as dip, crossfade, dip, dip.
11. **Windows**: for 1,000 random edits with freezes the windows never overlap; `joinAt` equals a
    linear scan; p is 0 at the start and below 1 at the end.
12. **Still frames and the feed**, modelling the decoder exactly (`presentationIndex` with half a
    median frame of slack, `frameIndexAt` on the element path): screen proxies at 24, 25, 29.97, 30
    and 60 fps, cameras at 15, 24, 30 and 60 fps, outputs at 10, 15, 24, 25, 29.97, 30, 50, 60 and
    120 fps, 200 random edits with freezes and offsets each. `stillFrame` gives the frame that holds
    the instant (its start at or before it, the next start after it), never before A's first frame,
    and the freeze's own frame under a continue freeze; `askTime(k)` maps back to k under both
    rules; both feeds of `joinFeed` have non-decreasing indices; a still shares an existing entry of
    the same index; a window with no output frame adds no still; a still the feed reaches only after
    i0 makes its window hard; `draw` maps every output frame.
13. `frameVideoTime`: inside a hold, `start + elapsed`; the first frame after a hold at T reads
    `T + length`; without holds it equals `editToVideo`.
14. `punchAt` and `punchedCamera`: joins punch, punch, crossfade, punch give scales 1.1, 1, 1, 1.1;
    Smooth's punch-ins count; a speed split keeps the state; the join's `scale` is used; a hold
    shows its held frame's clip's scale; `punchedCamera` multiplies `scale` by s about the same
    centre, returns `cam` itself when s is 1 or the layout at t is camera-led or side-by-side, and
    its view never leaves the recording for 1,000 random cameras.
15. `joinPose`: Crossfade α = 1 − p; for the four Slide directions the two pictures are exactly one
    frame apart and cover it; a Dip's α is 0 at its ends and 1 at its middle.
16. `joinsEdit`: `smoothAllCuts` is one project out with `all = { kind: 'smooth' }`, overrides kept,
    and `{ changed: 34, kept: 3 }` for 37 cuts with 3 overrides; `hardCutsEverywhere` stores
    `{ kind: 'cut' }`; `giveSameStyle` clears overrides; `withCutJoin(…, null)` removes one;
    `settleJoins` drops an override whose clip was merged by `restoreRange` or no longer follows a
    cut, keeps the rest, drops `auto` when `all` changed by hand, and returns `next` itself when
    nothing applies; `cutNumber` gives "5 of 37"; `prevCutBefore` and `nextCutAfter` walk all cuts.
17. **Why not on `Clip`**: `splitAt` inside B keeps B's override on the cut before B only;
    `cutRange` inside B makes a new cut with the default style.
18. **Drawing** (recording fake context, as `verticalEquivalence.test.ts`): a crossfade draws A\*
    after the picture at α = 1 − p and before the overlays; captions, texts and titles are drawn
    once; Slide's transforms; the Dip's fill; with Punch-in the frame's camera and every motion-blur
    sub-frame camera are scaled by s while the card's rect, its shadow and the camera bubble's box
    are drawn exactly as without it; in a camera-only layout the camera's source rect is the framing
    zoomed by s about `cropX`, `cropY`; a null still draws a hard cut.
19. `composeJoinStill`: draws the picture only (no captions, texts, title cards, graphics, bar or
    watermark), with `blurSamples` 1, at the still's time, onto the scratch target, then one
    `drawImage` into `out`; the export path prepares the camera still's mask first.
20. `joinReview`: Polish's record makes one row with the cut count; Keep drops `auto`; Remove puts
    `was` back and deletes an empty `joins`; statuses after each; Keep all and Remove all include it;
    each is one project out.
21. **Polish**: the step runs after Remove silences and smooths the cuts it made; skips with
    `'no-cuts'`, and with `'kept-style'` whenever `joins.all` is present (Hard cut included); saved
    options without `smoothCuts` read false; the default is true; the whole Polish is still one undo
    step.
22. **Timeline markers** (`timelineCuts.test.ts`): every cut has a 12 px marker in a 24 × 24 px
    target whatever its block's width (a 1 px block included); markers closer than 12 px merge with a
    count and select the first; each style's glyph; the name "Cut 5 of 37: 1:23.4 to 1:25.0,
    crossfade".
23. `CutsSection` and `CutStyleSection` (testing-library): the radio group; the Length value text
    "0.15 seconds"; the flash-rule note's text; "Here: a punch-in (…)" for Smooth on a camera-led
    cut; *Previous cut*, *Next cut* and *Play this cut*; "Cut 5 of 37"; *Smooth all cuts* disabled
    when nothing would change, and its notice "Smoothed 34 cuts · 3 keep their own style · Ctrl + Z
    to undo"; *Give them the same style*; no Cut style for a trimmed start.
24. **Player** (fakes): video time through a hold; stills asked for the next three cuts at play;
    A\* composed when its stills arrive, never inside the frame callback; paused, a window whose still
    is not ready draws a hard cut and redraws on `onReady`; playing, a still that arrives mid-window
    is not shown until the next window.

**P2 · Magnifier and progress bar**

25. `magnifierPhase`: g = 0 at the start and the end, 1 in between; r and z from g; `dIn` and
    `dOut` at most half the item; Calm motion changes only α; a cursor magnifier is multiplied by the
    cursor's presence.
26. `lensCamera`: for 1,000 random cameras, centres and zooms, the centre maps to the same output
    point under both cameras (within 1e-9) and the scale is `cam.scale · z`.
27. `newMagnifier` and `defaultZoom`: 0.30 S across in the view at the playhead with and without a
    zoom; `defaultZoom` gives 2 for ppr 1, 2.25 for 0.85, 2.5 for 0.43 and 1.5 for 1.5; centred on
    the cursor when it shows in the view, else on the view's centre; 3 s; dim 0; one project out.
28. `drawMagnifierLayer` (fake context): nothing without `magnify`; inside the lens clip, the screen
    through the lens camera, then the privacy and cursor layers through it; the ring and hairline; in
    `drawFrame` it comes after the cursor and before the shapes; `drawSpotlightLayer` lights the
    lens's box scaled by r at α for a magnifier, so the dimming grows with the lens.
29. **Privacy in the lens**: a blur shape under a lens is drawn again inside the clip, at the box
    `toOutput(rect, lensCam)` gives, which covers the magnified secret; with motion blur on during a
    moving zoom, the box drawn inside the lens is still exactly that box (no sweep).
30. A magnifier is selected, moved, copied, nudged and snapped as a spotlight (the multi-select,
    clipboard and snapping tests gain one magnifier each); it survives a load and save;
    `spotlightName` gives "Magnifier, 2 times" and today's name for a spotlight.
31. `chapterBarLayout`: segments from `outputChapters` with the intro segment; holds included; one
    segment with fewer than two chapters; the gap and the minimum width; Floating and Edge at
    1920 × 1080 and 1080 × 1920 with app-safe zones (inside `COMMON_SAFE`; Edge drawn as Floating).
32. `barState`: the fill is linear in video time and moves through a hold; the current segment grows
    over 0.15 s; fades; *Show only when a chapter starts* shows 3 s; names hidden while an automatic
    chapter title card shows.
33. **Room for the bar**: `textArea` shrinks by the band with and without names (0.111 S with names
    in a wide frame); a Studio caption block and a legacy caption keep clear of the bar; without the
    bar `textArea` returns today's values for every fixture.
34. Names: *Current* clamped inside the bar; *All* shortened by graphemes with a Bangla name
    ("অধ্যায় তিন" never cut inside a conjunct); fewer than three graphemes hidden.
35. `MagnifierSection`, `MagnifierZoomRow` and `ChapterBarSection`: value texts ("2 times"), the
    *Darkness* label, the softness note from `ppr · z > 2.5`, radio groups, one update per change;
    the Zoom tab's *Add magnifier* runs the same command.

**P3 · Animated callouts**

36. `calloutPose`: equals `itemPose` for every `ItemMotion` kind; Draw gives `1 − (1 − p)³`; Wipe
    gives `emphDecel`; each side at most half the item; a missing exit fades over the old length;
    Calm clamps; durations in viewing time on a 2× clip.
37. Texts, shapes and title cards without the new fields have today's call logs (part of §19.2).
38. **Draw-on**: an arrow's shaft length and its head from `drawn = 0.8`; a rectangle's dash
    `[L · drawn, L]` with `L = 2(w + h)`; an ellipse's perimeter by Ramanujan (within 0.01 % of a
    numeric integral); a filled box's reveal; a highlight's wipe width.
39. A blur shape with `enter` in the file reads without it and covers fully from its first frame.
40. **Badges**: numbering by start, ties by id; moving a badge renumbers; restart at each chapter
    (on with two chapters, off with `badgesByChapter: false`); `startAt` 5 gives 5, 6, 7; own-text
    badges do not count; A–Z then AA; `'bn'` gives ১…১০ with English captions; a language without
    its own digits gives Western; `badgeTextColor('#0060df')` is white (5.61:1) and `('#ffd60a')`
    is #111111; `badgeBox` for 1, 2 and 3 graphemes at the 0.045 default, with "ক্ষা" and "👍🏽"
    counted as one grapheme each.
41. **Bubbles**: `wrapCallout` by words; "ক্ষমতা" never split inside "ক্ষ"; Chinese wraps between
    graphemes; the tail sits on the nearest edge, is left out inside or near the body, and its base
    clamps; Arabic text is right-to-left; a white or light fill gets the outline and a dark one does
    not.
42. `annotationMetrics` for badges and bubbles equals the drawn boxes (the preview's handle), pins
    included.
43. **Title cards**: the background keeps `titlePhase`'s opacity; the text takes the pose.
44. `bubblePath` moved: Captions Studio's Speech Bubble look has the same call log as before.
45. `CalloutSection`: the labels *Comes in* and *Goes out* and the Graphics tab's motion names; Draw
    only for arrows, lines and boxes, Wipe for highlights and text, nothing for blur; one update per
    change; *Copy look* carries the motions.

**P4 · Colour**

46. `whiteBalanceGains`: the values of §9.2 within 0.002; `W · gains = 1`.
47. `gradeTable`: monotonic per channel for every slider at ±1; black and white fixed by brightness
    and contrast; a zero grade gives the identity.
48. `resolveGrade`: no look, no LUT and zeros give null; a look times its strength plus the sliders,
    clamped; `exposure` ignored on the screen.
49. `gradePixel` and `gradePixelsCpu` agree on a 64 × 64 pattern for every look and a 17³ LUT with
    a 1,024-entry shaper.
50. Saturation keeps luminance (within 1e-6 before clipping); Mono gives R = G = B.
51. `lutSample`: exact on the grid and on the grey axis; an identity 33³ LUT changes nothing by more
    than one level; strength mixes; the domain maps; a shaper runs first and interpolates linearly.
52. **Why not one baked LUT**: a 33³ bake of Vivid differs from `gradePixel` by at least 10 levels
    somewhere (so a later "optimisation" fails this test).
53. **Auto colour** on synthetic frames: a warm cast (gains 1.2, 1, 0.75) loses at least 60 % of its
    angle; `|temperature| ≤ 0.6`; a dark frame gains at most 0.7 stops; a dark-skinned face over a
    bright wall does not raise exposure; the same input gives the same output.
54. `colourEdit`, `withAutoColour` and `settleGrade`: one project out per action; a hand edit of the
    camera grade drops `grade.auto`; Reset deletes an empty grade; a second Auto colour run keeps the
    first run's `grade.auto.camera`.
55. `colourReview`: Keep, Remove and statuses, as test 20; after two Auto colour runs, Remove puts
    back the colour from before the first.
56. `gradeLayer` (fakes): an identity grade returns the same `FrameImage` and makes no context;
    `compare` returns the input; the blur cache keys on the raw frame and the grade; the backend is
    chosen once; a lost context that cannot be made again switches the session to the CPU path.
57. LUT loading: a changed or missing file is not used and `lutProblem` says so.
58. `importLut` (main): a bad file is rejected before anything is copied; a good one is stored as
    `lut-<n>.cube`, pruned to the three newest plus the saved project's; `MEDIA_FILE_RE`,
    `copiedFile` and `namedFiles` accept it.

**P5 · Music and sound effects**

59. `bedTime` and `bedSeconds`: linear before E; from S after; continuous at E; without Loop, it
    stops at E; one pass is `E / 48000`, never the file's length.
60. `bedGraph`: the exact graph string for a catalogue bed with Loop on, and with Loop off
    (`atrim=end_sample=E`, no `aloop`); `musicGraph` without a bed gives today's strings exactly.
61. `sfxJob`, zooms: zoom in at `seg.start + tin/2` less `peakAt`, in video time; none for a pan
    from the previous zoom; zoom out only with `tout > 0` and no pan into the next; none for a zoom
    starting in a cut; holds shift the times; zooms 1 s apart give one whoosh every 3 s;
    `sfxCounts` equals the kept times; a pull-back plays Zooming out at its start and Zooming in at
    its end; a zoom at 100 % plays neither.
62. `sfxJob`, titles and callouts: half the enter duration (or the old fade) less `peakAt`; an item's
    sound beats the rule and is never dropped by the 3 s spacing; `'none'` silences; privacy shapes
    never sound; merging within 0.05 s; 500 times and 16 effects at most; the gain is the volume.
63. A graphic with an `SfxRef` sounds at `startOf(g)`, the same time `popJob` gives a `'pop'` on the
    same graphic, also when the progress bar's band moves it; `popJob` is unchanged for `'pop'` and
    `'ding'`.
64. `planSoundtrack` with effects: one `-i` per effect at its resolved file, a click track each,
    mixed; a job without effects or a bed gives today's graph string exactly.
65. `validEffects`: an unknown id, a repeated id, 17 effects, 501 times, a gain of 2.1 and an id like
    `../x` are rejected; an unknown bed id is rejected; a bed file whose hash differs plays as a
    user's own file.
66. **Loop cache**: a looping Opus music is decoded once to `.cache/…flac` (by its hash), only up
    to the output's length, and the job reads that file; MP3, WAV, FLAC and Vorbis are not; music
    longer than the video is not; too little free space fails with a message before ffmpeg runs; a
    cancelled export kills the decode; older `music-*.flac` files are deleted; Duplicate does not
    copy `.cache/`.
67. **Library store**: `allowSoundUrl` takes the prefix only with https, port 443, no credentials,
    no query, no fragment and no `..`; a 302 from the prefix to
    `https://release-assets.githubusercontent.com/github-production-release-asset/…?sp=r&sv=…&sig=…`
    and to `objects.githubusercontent.com` with a query is followed; a redirect to any other host,
    to http, or with credentials or a fragment is refused; a download stops at the pinned bytes, a
    wrong hash deletes the `.part`; `library.json` lists checked files only; `useBed` re-hashes the
    source and copies it as `music-<n>.ogg`; `fromApp` rejects another frame.
68. The `sounds` host serves catalogue names only; `../`, other names and project files get 404.
69. **Preview sound** (fakes, and one `OfflineAudioContext` render compared with ffmpeg's): the bed's
    `loopStart`, `loopEnd` and start offset after a seek; with Loop off it stops at `E / 48000`;
    with an 80 ms stall of the video's clock at each of 50 cuts, the bed stays within `MUSIC_SEEK`
    of `bedTime(out)` (nudged, or restarted beyond it); `waiting` stops it and `playing` restarts
    it; library voices stop at the next sound of the same effect; times match the export's exactly
    and levels within −60 dB; `effectsOf` is made again when `chapterBar`, `zooms` or `soundFx`
    change; old projects' graph is unchanged.
70. `readGreatOptions` takes a catalogue `SfxRef`; *Make my captions great* puts it on the pop-ups;
    the pop-up's Review title names it ("with Soft pop").
71. `musicCredit` and the YouTube description's credit line.
72. Packaging: `SOUND_LIBRARY_BUDGET` holds; `extraResources` has `sound-library`; `verify-dist`
    checks the hashes (`packaging.test.ts`).
73. `MusicLibrarySection`: mood chips; Play toggles and Esc; on a row not downloaded, one *Download
    and use* button and a disabled Play with "Download to listen"; *Use* is one update keeping
    volume, ducking and fades; progress; the live region's text.

**Added by the review**

74. **P1 · The decoder never skips.** A fake decoder that applies `DecoderFrameSource`'s own rules
    (`planFeed`, the `unique` list, the `matchPtr` check of `frameSource.ts:174`) is run over
    `joinFeed`'s feeds for the edits and rates of test 12: it never throws, and each still's copied
    frame has index k\*.
75. **P1 · Smooth by layout.** Camera-only or camera-large on both sides gives Punch-in; the bubble
    layout, screen-only and side-by-side give Crossfade; camera-large to the bubble layout gives
    Crossfade; a hidden camera gives Crossfade; the Review row and the Polish summary count both.
76. **P1 · Composing memory.** Composing 50 A\* stills in a row uses one scratch target and creates
    at most one extra tilt WebGL context; no `out` canvas is ever passed to a layer; `releaseScratch`
    calls `releaseTilt` and `releaseGrade` on dispose.
77. **P2 · Progress bar placement and size.** Auto is the top with bottom captions and the bottom
    with top captions; the bar's alpha is `1 − b` under a full-frame title card; names are 0.042 S
    in a 1920 × 1080 frame and 0.036 S in a 1080 × 1920 one, weight 700, on a pill of α 0.55.
78. **P3 · Pins.** Under a moving zoom (and a punch-in), a pinned badge is drawn at `toOut(pin)` on
    every frame; it is not drawn while the pin is outside the card's slot; a bubble's body is moved
    inside the text area and its tail left out while the tip is outside; *Follows the zoom* off
    draws at `x`, `y`; adding and moving write `x`, `y` where it shows.
79. **P3 · New items and groups.** `addBadge`, `addBubble` and `addShapeAt` write the defaults of
    §7.1 and old items are never given one; a new badge lands beside the cursor (or at the view's
    centre), takes the brand's first colour, and `'bn'` digits with Bangla captions or transcript;
    a new bubble's tip is on the cursor; the group fields offer the intersection of the selected
    items' kinds and change them in one update.
80. **P4 · Ready before the first frame.** With a LUT imported just before, `prepareEditingAssets`
    is awaited by `prepare()`, `renderThumbnail` and the contrast probe, and frame 0 of the export
    is graded with it; a badge's Bangla font is loaded before frame 0; a missing LUT makes the export
    dialog ask before starting.
81. **P4 · Shader details** (the pure reference and fakes): the fetch reads row `H − 1 − y`; a shaper
    entry i is read at `shaperTexel(i)`; a self-test result flipped top to bottom fails; a backend
    chosen as CPU logs its reason.
82. **P4 · Colour controls.** The screen offers None, Natural, Vivid and Mono only, with Mono's hint;
    Home and End move a slider to its minimum and maximum; Delete and the Reset button set 0 and are
    announced; each is one update.
83. **P5 · Effects only.** A recording with no audio and one zoom whoosh: `hasSound` is true, the job
    has an audio track, an audio-only export of it passes, and `rateOf` sizes it with audio.
84. **P5 · Pinned once, unpacked safely.** With a fake encoder whose output differs, the build script
    stops for an id that already has `prepared` fields and fills them for a new id; an archive
    listing with an absolute path, a `..` part or a link is refused; only named members are
    extracted; a member whose SHA-256 differs stops the build.

**Performance** (`tests/editingPerf.test.ts`): `joinPlan` of 20,000 clips under 20 ms; `joinAt`
under 2 µs; `joinFeed` of 20,000 output frames and 2,000 windows under 30 ms; `gradeTable` under
1 ms; `parseCube` of a 33³ file under 40 ms; `sfxJob` of 2,000 zooms and 500 callouts under 10 ms.

### 19.2 Equivalence guard for old projects

Written first, before the contracts' hooks, and never regenerated: for every fixture of
`vertical-old-projects.json`, `wave8-old-projects.json` and the Captions Studio fixtures, the
`drawFrame` call logs at 24 sampled times (cuts, freezes, zooms, spotlights, texts and title cards
included) and the export job's sound graph strings are recorded; after the contracts and after every
part they are the same. With §0 decision 2, a fixture that loops an Opus music changes only its
music input's file name (the decoded copy); the guard records that case separately.

### 19.3 End to end: `tests/e2e/editing-polish.e2e.cjs`

Fixtures: a recording whose screen is red before 4 s, has a green "secret" square from 4 to 6 s,
and is blue after; a camera file with a warm cast, recorded at 60 fps; captions; three chapters; a
pause freeze.

- **E1 Old projects**: an old fixture exports the same frames (pixel hashes) as the baseline the
  contracts step saved on the same machine, and the same audio.
- **E2 Smooth all cuts**: cut 4–6 s; *Smooth all cuts*; the notice; Ctrl + Z and redo. In the bubble
  layout the cut is a crossfade: paused in the window after a seek, the preview shows red and blue
  mixed once the still is ready; exports at 24 and 30 fps: the frame at T + 0.075 s is about half
  red, half blue (α 0.5 ± 0.1); the export log shows no fall back to the seeking path; the video's
  length is unchanged. With the layout set to camera-only on both sides, the same cut is a punch-in
  and no frame mixes two faces.
- **E3 Dip and the flash rule**: two dips 0.6 s apart: the frames never reach black at the second.
- **E4 Slide and Punch-in**: the frame at T + 0.2 s of a Slide shows blue on the right and red on the
  left; on a punched clip the screen's content is 1.10× larger while the card's edges, its corners
  and the camera bubble's box are at the same pixels as without the punch.
- **E5 Nothing from inside a cut**: no exported frame of any window shows the green secret.
- **E6 Magnifier**: added with the cursor showing, it lands on the cursor at 2× (the fixture is shown
  1:1); over a fine checker the lens shows larger squares; a blur box under the lens stays blurred,
  also with motion blur during a moving zoom; with Darkness 30 % no bright ring shows around the
  lens while it grows; the preview and the export agree at the same time within tolerance.
- **E7 Callouts**: two step badges show 1 and 2; with Bangla captions they show ১ and ২ (glyph
  pixels compared with a reference drawn in the test); a badge pinned on the green square stays on it
  (within 2 px) through a zoom that moves during it; an arrow added now draws itself (no tip at
  0.1 s, a tip at 0.4 s); a speech bubble with Bangla text draws its tail to the cursor's spot.
- **E8 Progress bar**: at the top with bottom captions; the fill grows linearly and keeps moving
  through the pause freeze; captions sit clear of it; it is hidden under a full-frame intro title
  card. A 1920 × 1080 export frame scaled to 390 px wide (a phone held upright) is saved for a
  person to look at, and its chapter name's cap height and a badge digit's height are each at least
  6 px.
- **E9 Colour**: Warm on the camera warms the camera and leaves the screen; Mono on the screen greys
  it; preview and export agree within 2 levels; with `forceGradeBackend('cpu')` the export agrees with
  the WebGL one within 1 level; Compare shows the original in the preview and the export is still
  graded.
- **E10 LUTs**: an identity 17³ cube changes nothing beyond 1 level; a red–blue swap cube swaps
  them; an export started right after the import is swapped from its first frame; a malformed cube
  shows its line; deleting the file shows the missing notice and the export's question.
- **E11 Auto colour**: on the warm camera, the camera grade is set, Review lists "Camera colour
  balanced", and Remove puts it back.
- **E12 Music**: *Use* Sweet Sun; a 120 s export has no step at the loop seam larger than 1.5× the
  body's p99.9; the music ducks under speech; the credit shows; Space plays a preview and Esc stops
  it, announced in the live region; with Loop off the music ends at 1:43.4.
- **E13 Downloads**: a bed downloads from the test server with progress through *Download and use*
  and is in use after; its Play was disabled before; a corrupted copy is rejected with the message
  and leaves no file.
- **E14 Effects**: *Soft whoosh when zooming in*; the export has the whoosh's peak at the zoom's start
  + 0.35 s (± 10 ms) and none on zooming out; four zooms 1 s apart give two whooshes; the panel says
  "Plays 2 times"; a Captions Studio pop-up with Soft pop sounds at its pop time.
- **E15 Polish and Review**: Polish with Smooth cuts is one undo step; Review lists "Smooth cuts at 1
  cut"; Remove gives hard cuts back; after *Use hard cuts everywhere*, Polish skips with "Your cut
  style is kept".
- **E16 Keyboard**: *Go to next cut* from the palette, then *Next cut* and *Previous cut* buttons;
  *Play this cut*; Crossfade with the arrow keys, Length with Page Up; a cut marker reached by Tab
  and Enter; a colour slider's Home, End and Delete; names checked; the Inspector still has 13 tabs.
- **E17 Versions**: after a version is saved, smoothing the cuts and grading the camera makes the
  comparison name "smooth cuts" and "colour".
- **E18 Cost**: the export's per-frame decode, draw and encode times for a 1080p graded project with
  crossfades and a magnifier are printed (and below a generous ceiling of 400 ms a frame under
  SwiftShader).

---

## 20. Later

- **Glide** (the camera glides from A's framing to B's) and **cross-zoom** cut styles.
- **Sound with dips** ("fade the sound too"), J and L cuts, and a swish on cuts.
- **Music in part of the video**: from a time to a time, or only where nobody speaks (an intro, an
  outro, silent stretches), as Camtasia, Descript and CapCut allow. It needs a range on
  `MusicSettings` (`range?: { from: number; to: number }`, source seconds, or `onlyWhenQuiet?:
  boolean` built on the ducking ranges), the job's `MusicSound` to carry it, and `musicGraph` and
  the preview's drift loop to start and stop the bed there. The library itself does not change.
- **Sound items on the timeline**, which would bring the six measured effects not shipped now
  (typing, keypress, shutter, scroll, toggle, error), a shutter on freezes and a chime on chapters.
- **Callouts**: "during" motions (an arrow's nudge, a badge's pulse), right-to-left wipes and a
  right-to-left progress bar.
- **Colour** in style presets, the brand kit and *Save as default*; film looks generated offline
  with the MIT-licensed spectral_film_lut (a 33³ half-float LUT is 215,622 bytes each); LUT
  thumbnails; local tone mapping.
- A 13th bed: Satie's Gymnopédie No. 1 (public domain, Musopen via Wikimedia Commons, 3,696,351
  bytes), once it is downloaded and measured (Wikimedia returned HTTP 429 during research).
- Kinoton's CC0 whooshes on Freesound (better than the bundled ones; a login is needed to download).
