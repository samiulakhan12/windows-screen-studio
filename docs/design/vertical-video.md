# Vertical video that follows the action (NW-05) and Duplicate (X-04): final design

Roadmap items: `docs/ROADMAP.md` NW-05 (Editing · M) and X-04 (Editing · S; only **Duplicate** is in
scope, "Save as one .flown file" is under [Later](#12-later)). Written against `feat/vertical-video`
at `aeca5c5` (Flown 0.6.0 plus the image size fixes); every line number below refers to that
commit. "View space" means coordinates relative to the crop (`src/shared/engine/crop.ts`
`cropView`, line 297), which is what the scene draws in. "Output time" is edit time
(`src/shared/engine/timeline.ts`: clips back to back at their speeds). "Source time" is recording
time.

Everything runs on the PC, offline, from data the project already has: `cursor.json` (through
`effectiveTrack`, `src/shared/engine/inputTrack.ts:32`), zooms, clips, freezes, layouts and shapes.
Nothing on the recording side changes (`src/main/recording/*`, `src/main/recordingIpc.ts`,
`src/shared/recording/*`, `src/renderer/src/views/Home.tsx`, the recording bar,
`src/renderer/src/recorder/*`). No new runtime dependency. `src/main/security.ts`, the CSP and the
window options are unchanged; the one new IPC channel checks its sender.

---

## 1. Summary

- **Follow the action.** In a frame narrower than the recording (9:16 and 1:1, also 4:3, of a
  landscape recording), the screen fills its part of the frame and a *view* of that part's shape
  pans across the recording instead of the whole desktop being shrunk into a strip. The view is
  planned once, offline, from where the cursor comes to rest, where it is going, clicks, typing,
  drawn shapes, scrolls and zooms. It holds still most of the time and moves in calm, eased pans
  whose speed, acceleration and jerk are bounded. Pans start as the cursor starts moving and
  arrive in time for the click. Brief flicks, jitter and short visits do not move it. It cuts with
  the picture at a cut and never pans across one.
- **One camera, no new maths in the layers.** While following, the recording is drawn into a
  *virtual rectangle*, the screen's slot enlarged about its centre, so the existing `Camera`
  (`src/shared/engine/zoom.ts:476`) and every mapping built on it (`toOutput`, `viewSource`,
  `cardRect`, cursor size, shapes, blur, spotlights, the director's measurements, the preview's
  pointer mapping) keep working. The follow plan is the zoom camera's rest position. Zooms are
  relative to the view, gentler than in 16:9, and limited so the picture stays sharp.
- **Camera in a band.** In a tall frame with a camera, the camera sits in a band across the top
  (default) or bottom, or keeps its bubble. Square frames keep the bubble. Camera layouts over time
  and the camera director keep working; the band collapses smoothly when the camera hides.
- **Readable text.** With *Keep text clear of app buttons* on (tall frames), captions, key presses,
  the logo and lower-third titles are placed inside the area TikTok, Reels and Shorts leave free,
  and never over the camera band. *Make a vertical version* also moves text and images into that
  area once, as editable data.
- **Safe-zone preview.** A toggle under the preview (`G`) shades where each app's buttons and
  captions sit. It is DOM over the preview, never drawn by the compositor, so it can never reach an
  export, a thumbnail or the clipboard.
- **Steering it.** *Hold the view here* (`R`), dragging the picture, a zoom's fixed point, *Ignore
  click* and three *Movement* presets (Calm, Balanced, Lively). No new timeline track.
- **Duplicate.** A title-bar menu offers *Make a vertical version*, *Make a square version* and
  *Duplicate*. The copy is a new project folder: media are hard-linked where that is safe (copied
  otherwise, with progress and Cancel), other files are copied, `project.json` is written last
  from the editor's current state, and the copy opens. The original folder is never written.
- **Old projects are unchanged.** `Project.reframe` and `Project.copyOf` are absent in every
  existing project, including the 9:16 and 1:1 ones that fit the whole frame today. Every new
  path is gated on them, and the shared functions only gain optional parameters that reproduce
  today's results bit for bit when absent (equivalence tests are written first, §11.2).

---

## 2. What the user sees

### 2.1 The fast path: a Short from a 16:9 tutorial

1. In the editor, the user clicks the **copy** button right of the recording's name and picks
   **Make a vertical version** (or `Ctrl+K` › "Make a vertical version").
2. The copy is made. Hard links make it instant; when the media must be copied and that takes
   longer than 0.5 s, a progress window appears (§2.3).
3. The copy opens. Notice: *"Made a vertical version. Your original “Billing demo” is unchanged."*
   with an **Open original** button. The Inspector shows the Style tab, scrolled to **Vertical
   framing**.
4. The preview is 9:16: the face in a band on top, the screen below it, cropped in and gliding with
   the cursor, clicks and typing. Captions and key presses sit above the area the apps cover.
5. They press `G`: shaded areas show where TikTok, Reels and Shorts put their buttons and
   captions. Nothing important is under them.
6. At 0:41 the view followed a stray click: they press `Delete` on that click marker (*Ignore
   click*), or drag the picture back to the form, or press `R` (**Hold the view here**).
7. `Ctrl+E`, **TikTok** (or tick TikTok, Instagram Reels and YouTube Shorts in Batch), **Export**.
8. **Back** shows both videos in the library; the copy is at the top (its `createdAt` is the time it
   was made).

### 2.2 Entry points (exact copy)

**Title bar.** A new icon button right of the name field (`data-testid="copy-menu"`, icon `copy`,
`title` and `aria-label` "Duplicate or make a vertical version", `aria-haspopup="menu"`). It opens a
menu (`role="menu"`; `Up`/`Down` move, `Enter` runs, `Esc` closes and returns focus to the button):

| Item (`data-testid`) | Line 1 | Line 2 (muted) |
|---|---|---|
| `copy-vertical` | Make a vertical version | A 9:16 copy that follows your cursor, for TikTok, Reels and Shorts |
| `copy-square` | Make a square version | A 1:1 copy that follows your cursor |
| `copy-duplicate` | Duplicate | A copy you can edit separately |

*Make a vertical version* is disabled (`aria-disabled`, line 2 replaced) with "This video already
follows the action" when the project is 9:16 and follows, and with "Your recording is already tall"
when a 9:16 frame of the recording (as cropped) could not follow (§5.1). *Make a square version*:
"This video already follows the action" (1:1 and following) or "Your recording is already square
or tall". *Duplicate* is always available.

**Command palette** (category General, no default keys): "Make a vertical version", "Make a square
version", "Duplicate this video". Unavailable reasons are the same sentences.

**Style tab › Vertical framing**, when the current frame cannot follow but a 9:16 one could (a
landscape recording in Auto, 16:9 or 4:3): a row (`data-testid="vertical-callout"`) with the text
"Making a Short?" and a button **Make a vertical version**.

**Export dialog**, when the chosen output (preset, aspect chip, or any 9:16 or 1:1 batch item) is
9:16 or 1:1, it could follow, and the project does not follow: an info note
(`data-testid="export-follow-note"`): "Your whole screen is shrunk to fit 9:16. A vertical version
crops in and follows your cursor." (1:1: "Your whole screen is shrunk to fit a square. A square
version crops in and follows your cursor.") and a button **Make a vertical version** (or **Make a
square version**), which closes the dialog and runs the same command.

Home is not changed: the library lists project folders, so the copy simply appears there.

### 2.3 Making the copy

- The editor pauses and flushes the save (`saver.flush()`, as `goBack` does, `Editor.tsx:1212`).
  If that fails: `window.confirm` "Your latest changes could not be saved. Make the copy anyway? It
  will include them." The copy is built from the editor's current project, so it always has the
  latest edit.
- If the copy is still running after 0.5 s, a modal appears (`data-testid="copy-progress"`,
  `role="dialog"`, focus trapped with `useModalFocus`, `modalFocus.ts:26`): title "Making a vertical
  version" ("Making a square version", "Making a copy"), body "Copying “Billing demo” (1.4 GB). Your
  original stays as it is.", a progress bar (bytes; `aria-valuenow`), and **Cancel**. Cancel
  removes the half-made folder and closes the modal without a message.
- Errors, as a notice with `role="alert"` (beside the transport's polite live region, not inside
  it, so it is read once), all starting "Could not make the copy: ":
  - "there is not enough free space on this drive (it needs 1.4 GB, 0.6 GB is free)."
  - "some of the recording's files could not be read."
  - "Flown could not create a folder in Videos\Flown."
  - "a copy is already being made."
- Done: the copy opens (the App route changes; the editor remounts with the new id). Notices:
  - vertical: "Made a vertical version. Your original “{name}” is unchanged." + **Open original**
  - square: "Made a square version. Your original “{name}” is unchanged." + **Open original**
  - duplicate: "Made a copy. Your original “{name}” is unchanged." + **Open original**
  - **Open original** when the original was deleted meanwhile: "The original recording is no
    longer in your library."
- The copy's name: "{name} (vertical)", "{name} (square)" or "{name} (copy)", cut to 120
  characters; a blank name gives "Untitled recording (copy)" (and so on). It can be renamed in the
  title field as usual.

### 2.4 Turning following on in a video that is already tall or square

1. A project already set to 9:16 or 1:1 shows the whole recording, shrunk, with background above
   and below, exactly as today. Nothing is written to its file.
2. **Style › Vertical framing** shows the toggle **Follow the action**, off, with the hint "Your
   whole screen is shrunk to fit this shape. Turn this on to crop in and follow your cursor,
   clicks and typing."
3. Turning it on is one undo step and writes `reframe` (§4.2 `reframeOn`). The preview follows at
   once. Turning it off keeps the settings with `mode: 'fit'`, which draws exactly as before.

### 2.5 The Vertical framing section (Style tab, under Frame)

`data-testid="framing-section"`, title **Vertical framing**. Shown when the project's frame could
follow (§5.1 `canFollow`), or with only the callout of §2.2 when a 9:16 frame could.

| Control (`data-testid`) | Copy | Values and notes |
|---|---|---|
| Toggle `follow-toggle` | **Follow the action** | One undo step. Hint while off as in §2.4. |
| Status `follow-status` `data-state="following"` | "Following your cursor, clicks and typing." | |
| Status `data-state="no-input"` | "This recording has no cursor data, so the view stays where you put it." | `cursor.valid` false. |
| Slider `follow-level` | **How close**: `1×` … `2×` | 1–2, step 0.05, default 1. Hint when limited (§5.12): "Limited to keep the picture sharp." |
| Chips `follow-pace` | **Movement**: **Calm** · **Balanced** · **Lively** | Titles: "Moves less, and more slowly" / "Follows each new place you work in" / "Reacts sooner and moves faster". Default Balanced. |
| Chips `follow-camera` (tall frame, camera shown) | **Camera**: **Band on top** · **Band at the bottom** · **Bubble** | Titles: "Your camera above the screen" / "Your camera under the screen" / "Your camera bubble over the screen, as in the Camera tab". Hint under *Band at the bottom*: "The apps put their captions over the bottom of the video, so a band on top usually stays clearer." |
| Slider `follow-band` (band chosen) | **Camera size** `32%` | 20–50% of the frame inside the padding, default 32%. |
| Hint (square frame with a camera) | "Square videos keep the camera bubble." | No camera chips. |
| Sliders `follow-rest-x`, `follow-rest-y` (no cursor data) | **Where the view rests**: **Left to right**, **Top to bottom** | 0–100%, step 1%. *Top to bottom* only when the view is shorter than the recording. One undo step per slider gesture. |
| Button `follow-hold` | **Hold the view here** (`R`) | Hint: "Drag the picture to aim the view. Zooms still work inside it." |
| Sliders `follow-view-x`, `follow-view-y` (a zoom with a fixed point covers the playhead) | **View at the playhead**: **Left to right**, **Top to bottom** | Edit that zoom's point (§2.6). |
| Toggle `app-safe-toggle` (tall frames, following or not) | **Keep text clear of app buttons** | Hint: "Places captions, key presses, your logo and lower-third titles where TikTok, Reels and Shorts don't put buttons." |
| Note (tilt or device frame set, following) | "The 3D tilt and the device frame are left out while the view follows the action." | The data is kept; they come back in 16:9. |
| Tip (following, cursor data) | "A stray click pulled the view away? Ignore the click (Zoom › Selected click) and the view stays put." | |

### 2.6 Steering the view

The view decides by itself; the user can override it with tools the editor already has:

- **Hold the view here** (`R`, the section's button, the palette). At the playhead, outside any
  zoom: adds a zoom of level **1×** with a fixed point *at the view's current centre* (3 s, fitted
  into the free gap like `insertZoom`, `zoom.ts:794`; at least 1 s), so the picture does not change
  and automatic moves stop for that time. Inside a zoom: that zoom's focus becomes a fixed point at
  the current centre (a region zoom keeps its rectangle) and the zoom is selected. One undo step.
  Notice when there is no room: "There is no room for a new zoom here."
- **Drag the picture** (paused, following, pressing on the screen slot and not on an item the
  preview edits). The content moves with the pointer, like a map; the result is written as *Hold
  the view here* at the dragged centre (a region zoom's rectangle moves by the same amount). One
  undo step per drag. A press that moves less than 4 px (`CLICK_SLOP`, `PreviewStage.tsx:64`) is
  still a click that plays or pauses. Without cursor data and with no zoom at the playhead, the
  drag moves *Where the view rests* instead.
- **A zoom with a fixed point** moves the view there for the zoom's time. While following, the
  Zoom panel's level chips add **1×** (title "Only moves the view, no zoom").
- **Ignore click** (Zoom › Selected click, or `Delete` on a click marker) stops the view going to a
  stray click, as it stops the automatic zoom.
- **Movement** chips change the whole video at once.
- The Zoom panel's selected zoom, while following: "In the vertical frame this zoom is 1.4× (zooms
  are gentler there, and limited so the picture stays sharp)."

### 2.7 Videos without cursor data

Window recordings without coordinates and imported videos (`CursorTrack.valid === false`) keep one
framing: the centre of what is shown (after the crop), or where the user puts it with *Where the
view rests* or by dragging the picture. Zooms with a fixed point or a region (auto zooms of such
recordings are fixed already, `zoom.ts:367`), *Hold the view here* and drawn shapes still move it.

### 2.8 Safe-zone preview

- Under the preview, in the transport row right of the preview speed menu
  (`Transport.tsx:60`), shown only for a tall frame (height ≥ 1.25 × width): a toggle button
  (`data-testid="safe-zones-toggle"`, `aria-pressed`, phone icon, "Safe zones", title "Show where
  TikTok, Reels and Shorts put their buttons and captions (G)") and, while on, a select
  (`data-testid="safe-zones-platform"`): **All three** (default), **TikTok**, **Instagram Reels**,
  **YouTube Shorts**.
- The overlay (`data-testid="safe-zones"`, `data-platform`) shades each covered area and labels it
  ("Tabs and search", "Like, comment, share", "Name, caption and sound", §7). *All three* draws the
  union of the nine boxes with one label per edge: "Buttons and captions (all three)".
- A legend under the preview while it is on (`data-testid="safe-zones-legend"`): "Shaded parts are
  covered by the apps' buttons and captions. Shown only here, never exported. The apps move them
  from time to time, so leave a little room."
- `G` (command "Show safe zones") toggles it. On/off and the platform are a per-user view preference
  in `localStorage` (key `editor-safe-zones`), like the waveform toggle (`waveformPref.ts`), never in
  the project.

### 2.9 Export

- The TikTok, Instagram Reels and YouTube Shorts presets (`exportPresets.ts:39-41`, 1080×1920) and
  Square post (1080×1080) export the frame exactly as previewed. Batch can export all of them.
- Following only ever applies to frames narrower than the recording (§5.1). A following project
  exported as 16:9 (YouTube presets, a 16:9 batch item) shows the whole screen as before, with the
  note "In this shape the whole screen is shown: following the action applies to tall and square
  videos." A batch of *YouTube 1080p60* and *TikTok* gives a classic 16:9 file and a followed 9:16
  file.
- While following, the resolution chips lose their per-size "upscaled" tag (it would be on every
  size, `ExportDialog.tsx:448-456`). One line instead (`data-testid="export-magnify"`): "Shows your
  1920×1080 recording at 1.6× its size (up to 2.3× in zooms)," measured in the layout that shows
  the recording largest (`peakMagnification`, §5.12). From 2× on it is a warning and adds
  "Small text may look soft. Recording at 1440p or 4K keeps it sharp."
- The following note (`data-testid="export-follow-on"`): "The view follows the action: it crops in
  on your cursor, clicks and typing."
- Safe zones are never exported: they are not drawn on any canvas.

### 2.10 Hints elsewhere

- Camera tab › Layout, with a band: "While the view follows the action, the camera sits in a band
  at the top. Change it in Style › Vertical framing." (or "at the bottom"). The corner controls are
  `aria-disabled`; positions stay stored and are used again in bubble mode or 16:9.
- Style › Device frame, while following: "Device frames are not drawn while the view follows the
  action."
- Effects › 3D tilt, while following: "The 3D tilt is not drawn while the view follows the action."
- Camera tab › Auto director, with a band: the plan's reasons gain "The camera is in a band while
  the view follows the action, so it is not moved between corners."

### 2.11 Keyboard and accessibility

- New commands (`src/shared/editor/commands.ts`): `makeVertical` "Make a vertical version",
  `makeSquare` "Make a square version", `duplicateVideo` "Duplicate this video" (General, no keys);
  `toggleFollow` "Follow the action" (toggle, no key); `holdView` "Hold the view here" (`R`);
  `toggleSafeZones` "Show safe zones" (toggle, `G`). `R` and `G` are free in `DEFAULT_KEYMAP` and
  not in `RESERVED` (`shortcuts.ts:28-73, 381`). `toggleFollow` on a frame that cannot follow shows
  the notice "Following works in 9:16, 1:1 and other frames narrower than the recording. Choose one
  in Style › Frame."
- Every new control is a `Toggle`, `Chips`, `Slider` or `Section` from
  `src/renderer/src/editor/controls.tsx`, so it is focusable, labelled and keyboard operated. The
  copy menu follows the menu pattern of §2.2. The progress modal uses `useModalFocus`.
- Everything the drag does has a keyboard path: `R` and the *View at the playhead* sliders.
- Contrast with the tokens in `src/renderer/src/styles.css`: overlay labels and the legend chip are
  `--text-1` on `--surface-overlay` (above 15:1); zone fills are `--scrim` with a 1 px dashed
  `--warning` edge (non-text, above 3:1 on both light and dark video); hints use `--text-2` on
  `--surface-1` (7.2:1). The overlay is `aria-hidden`; the legend carries the same information.

---

## 3. Decisions

### 3.1 How this design was chosen

Two independent designs were compared against the code: **A** (motion first) and **B** (workflow
first). **Base: design A.** Its camera is planned like an operator would shoot: holds, and pans on
one C² glide (zero speed and acceleration at both ends), aimed at intent rather than the raw
cursor, with click deadlines and joined glides for drags. Its citations were the more precise.
Prototypes of both followers were run on the same synthetic tracks (scratch only): A's camera had
peak jerk of 12–123 views/s³ against 720–1440 for B's velocity follower, and B's no-overshoot clamp
(which sets the speed to 0 when the centre passes the target) produced a 152 views/s² spike on a
0.5 s visit. B kept the cursor in view somewhat more (out about 9% of a 60 s jittery random walk
against about 14% for A with the Balanced constants below); clicks were in view in both.

**Grafted from B:**

| From B | Why |
|---|---|
| The title-bar **copy menu** (no dialog), the "Making a Short?" callout, the Export note, the notice with **Open original**, `copyOf`, progress after 0.5 s with Cancel | Two clicks to a Short; the user always knows the original is safe and can go back. |
| **Movement** presets Calm / Balanced / Lively | One plain choice instead of tuning; each preset is a column of the constants table. |
| A confirmation window long enough that a far visit under 0.5 s never moves the view (A used 0.3 s) | Fast flicks to the other side of the screen must not cause two pans. The planner reads the future, so a longer window adds no lag. |
| **Gentler zooms** in the view (half strength) and a cap of 3 output pixels per recorded pixel; pull-backs mapped so 0.5 shows the whole recording | A's full-strength zooms would show a 1080p UI at about 3× in a 9:16 view; A's "pull back to 0.32×" is not reachable (levels are clamped to 0.5, `zoom.ts:13, 518-521`). |
| Cursor-focus zooms **aim at the follow plan**, not at `focusPath`; the planner measures distances in the **zoomed** view | One follower instead of two; inside a 1.4× zoom the view is 0.7 views wide and the dead zone must shrink with it. |
| **Drawn shapes** (arrow heads, boxes) and region spotlights are targets | An arrow the user drew stays in view. |
| **Drag the picture** and **Hold the view here** (`R`), and the *View at the playhead* / *Where the view rests* sliders | A direct, keyboard-accessible fix without a new track. Written as 1× fixed-point zooms, which change nothing in 16:9. |
| Safe-zone toggle under the preview, **All three** by default, `G`, view preference in `localStorage` | Next to what it explains; the waveform preference sets the precedent. |
| Main-process copy with a `.copying` marker, clean-up of stale copies, file times kept on copied files | A crash never leaves a visible half copy; the speech cache usually stays valid. |
| A **contracts commit** before the parallel parts | As in the camera director wave. |

**Not taken from B:** the per-axis velocity follower (jerk, the clamp spike, curved diagonal pans);
the **Framing track** with *Frame here* / *Whole screen* blocks (a new track, selection kind and
multi-select exception for what a 1× fixed zoom already does; under Later); copying every media
byte by default (a 1-hour 1440p proxy is several GB).

**Corrections to claims about the code** (both designs), applied in this spec:

- The zoom camera's spring (`focusPathFor`, `zoom.ts:27`; `SmoothedTrack` with smoothing 1 is
  ω = 5 rad/s, `cursor.ts:37`) lags a moving cursor by about 2/ω = 0.4 s, not 0.2 s (A).
- `drawKeystrokes` is at `textOverlays.ts:65`, not 90 (A).
- Zoom levels below 0.5 cannot be set (`ZOOM_MIN_SCALE`, `zoom.ts:13`; `zoomTargetScale`,
  `zoom.ts:518`), so "pull back to 0.32×" needs the mapping of §5.12 and a floor parameter (A).
- Long scrolls do not make a pull-back zoom: they are *breaks* with no zoom at all (`zoom.ts:157-163`,
  `zoomsFromEvents` from line 179), so the camera is at rest (the follow view) while they last (B).
- B's follower is not "velocity continuous": its overshoot clamp stops the view in one step; its
  acceleration is bang-bang (B).
- Motion-blur sub-frames inside a cut must use the frame's own clip (`at`, §5.4), not "the nearest
  kept time", which can blend the next clip's view into the last frame before a cut (B).
- The speech cache compares `mtimeMs` exactly (`src/main/speech/vad.ts:138`): a copy's time set
  with `utimes` may differ in the sub-microsecond digits, so it can be rebuilt (about 9 s per hour
  of microphone sound). A hard link keeps it exactly (B).
- `fs.copyFile` with `COPYFILE_FICLONE` asks for a copy-on-write clone and falls back to a plain
  copy; it does not promise block cloning (B).
- The existing `projects:*` handlers have no sender check (`projectsIpc.ts:50-127`); the new channel
  adds the `isAppUrl` check used by `exportIpc.ts:219` and the main-window check of
  `notes/notesIpc.ts:47` (both).
- The e2e helper `seedProject` **symlinks** `screen.mp4` (`tests/e2e/render-fixtures.cjs:213`);
  Duplicate copies regular files only, so the e2e test seeds real files (both missed it).

### 3.2 Decision table

| # | Topic | Decision | Alternatives and why not |
|---|---|---|---|
| 1 | Where the settings live | `Project.reframe?: ReframeSettings`, top level, like `crop` and `director`. | **`StyleSettings`**: `applyPreset` (`src/shared/editor/stylePresets.ts:166`), `lookOf` and `applyStyleDefaults` (`src/shared/editor/styleDefaults.ts:95, 309`) copy `style`, so a preset or the saved default style would switch following on in other recordings. **A new aspect value**: every `AspectRatio` switch (`layout.ts:12`, `exportPresets.ts:95`, batch) would need it, and the export's aspect override would lose it. **Export only**: the preview could never show it. The name `framing` is taken by the webcam framing (`directorData.ts:56`). |
| 2 | When following applies | `reframe.mode === 'follow'` and the frame is at least 10% narrower than the drawn recording: `outW/outH < 0.9 · vw/vh`. | **Only 9:16 and 1:1**: the generic rule costs nothing and also covers 4:3 and cropped windows. **Any frame**: a 16:9 export of a following project would crop for nothing, and batches could not mix the classic and the followed frame. |
| 3 | Coordinate model | A **virtual rectangle** (§5.2): the recording is drawn into the slot enlarged by `1/base`, so `toOutput` (`outputPoint.ts:11`) maps the view onto the slot. | **A new camera with a non-square viewport**: about 15 files would change their maths. **A crop that moves**: `cropProject` (`crop.ts:240`) remaps zooms, shapes and the track once per crop; per frame it would defeat every memo. |
| 4 | How the view moves | An **offline shot plan**: holds and C² glide pans with speed, acceleration and deadline rules (§5.7–5.10). | **An online follower** (a spring like `SmoothedTrack`, `cursor.ts:21`, or B's velocity follower): always slightly moving or bang-bang, cannot know a click is coming. **Global optimisation** (a QP over the path): smooth but hard to explain, test rule by rule, and rebuild per edit. |
| 5 | What it follows | **Intent**: zoom aims, typing places, clicks, drawn shapes, scroll positions, where a cursor move ends (`cursorMoves`, `cursorPath.ts:83`), and the cursor itself only while it wanders or drags. | **The smoothed cursor** (`focusPathFor`): drifts with every wiggle and lags 0.4 s. |
| 6 | Time base | **Planned in output time, read by source time.** Pans last what the viewer sees at any clip speed; cuts are known; `drawFrame` stays a function of source time (`compositor.ts:81`), so freeze frames hold the view for free. | **Source time**: pans would race on 4× clips. **Output time in the compositor**: would change `drawFrame`'s contract. |
| 7 | Zooms | Relative to the view, **half strength**, capped at 3 output px per recorded px; region zooms frame their rectangle inside the view; pull-backs 0.5–1 widen to the whole recording; cursor-focus zooms aim at the plan (§5.12). | **Override the view during zooms**: every zoom-in would add a sideways jump. **As set**: 1.8× in a 9:16 bubble view of 1080p is 2.95 output px per recorded px. |
| 8 | Determinism | The plan is a pure function of the drawn project, the drawn track and a **canonical frame** (`outputSize(aspect, vw, vh, 1080)`); drawing clamps with the real frame's view. | **Plan per render size**: the preview canvas is not exactly the export's shape (`PreviewStage.tsx:160-181`). **Store the plan in the project**: the export changes the aspect for presets (`exportPlan.ts:47`). |
| 9 | Tuning | Three **Movement** presets. | Sliders for dead zone, speed and look-ahead: nobody knows what they mean. |
| 10 | Camera | **Band on top** (default in tall frames with a shown camera), **band at the bottom**, or **bubble**; square frames keep the bubble. The band's side is the setting; segment corners and the director's corners only move a bubble. | **Bottom by default**: the apps cover the bottom 21–22% (§7). **Band in 1:1**: leaves a strip too wide to need following. **Side from each segment's corner**: the band would jump between top and bottom. |
| 11 | Device frames and 3D tilt while following | **Not drawn**, with hints; data kept for 16:9. | A browser frame around a moving crop claims a page that is only partly shown; a tilted narrow card shows the background at its edges. |
| 12 | Text and images | A **render rule** for automatic placements (captions, key presses, logo, lower thirds) behind `reframe.appSafe`, and a **one-time data refit** of user-placed text and images by *Make a vertical version*. | **Refit at render time**: the stored position and the drag handles would disagree. **Move nothing**: 16:9 lower thirds land under TikTok's caption. |
| 13 | Safe zones | One dated table (`src/shared/render/safeZones.ts`), a DOM overlay in `PreviewStage`, a `localStorage` preference; placement uses the area **all three** leave free. | **Drawn by the compositor behind a flag**: one forgotten flag exports it. **Per-platform placement**: a batch goes to all three. |
| 14 | Overrides | **Existing tools**: 1× fixed-point zooms (made by `R` and by dragging the picture), *Ignore click*, Movement. | **A Framing track** (B): new track, selection kind, multi-select exception and inspector for the same effect. Later. |
| 15 | No cursor data | A rest point (centre by default), set by sliders or dragging; zooms with a point and shapes move the view. | **Following picture changes** (frame differencing): a new decode pass. Later. |
| 16 | Click effects | Ripples, rings and pulses scale with the content while following (`fxGain`, §6.6), as the cursor does. | **Frame-relative**: next to a cursor drawn 1.9× larger they would look tiny. |
| 17 | Duplicate: who builds `project.json` | The **renderer** builds the copy with a pure function (`projectCopy`); **main** validates it with `migrateProject`, gives the id, copies files and writes `project.json` last. | **Main copies `project.json` from disk**: unsaved edits (autosave is debounced) would be lost, and the refit needs text measuring. |
| 18 | Duplicate: media | **Hard-link** `screen.mp4`, `webcam.mp4`, `mic.m4a`, `system.m4a` unless the folder is under OneDrive; else, or when linking fails, **copy** with progress and Cancel. Copy every other allow-listed file. | **Copy everything**: a 1-hour 1440p proxy is several GB and takes minutes. **Link everything**: assets reuse names (`background.<ext>`, `projectsIpc.ts:166`); a future writer that copies onto a name would change both projects. **Links under OneDrive**: the sync client and Files On-Demand placeholders do not handle shared file data reliably. |
| 19 | Duplicate: where | The **editor** (title bar, palette, Style, Export), and `App.tsx` for the route. | **Home's library**: `Home.tsx` belongs to the recording owner. Later. |
| 20 | The copy's identity | New folder id (`createProjectDir`, `projects.ts:62`), `createdAt` = now, `copyOf = { id, name }` of the source. Item ids kept. | **Keep `createdAt`**: the copy would sort far down a long library while the user is looking for it. |
| 21 | Cuts | The view may **jump at a cut** and never pans across one; it keeps its place when what follows is still visible. | **Pan across**: shows half of a move to a place that is gone. **Always recentre**: Remove silences makes many cuts. |
| 22 | Crash safety of a copy | `.copying` marker first, `project.json` last, stale marked folders removed at the next copy. | Relying only on "no `project.json` and no raw files is invisible": true (`projects.ts:142-153, 307-326`), but leaves the folder on disk for ever. |

---

## 4. Data model changes and migration

### 4.1 `src/shared/types.ts` (additive)

```ts
/** What a frame narrower than the recording shows (NW-05). */
export type ReframeMode = 'fit' | 'follow'
/** Where the camera goes while the view follows the action in a tall frame. */
export type ReframeCamera = 'top' | 'bottom' | 'bubble'
/** How readily the view moves (shared/engine/reframe.ts PACE). */
export type ReframePace = 'calm' | 'balanced' | 'lively'

/**
 * Following the action in frames narrower than the recording (docs/design/vertical-video.md).
 * Only takes effect in a frame at least 10% narrower than the drawn recording (reframeData.ts
 * followApplies); `appSafe` takes effect in any tall frame.
 */
export interface ReframeSettings {
  /** 'fit': the whole recording fitted with background around it, as before; 'follow': crop in and follow. */
  mode: ReframeMode
  /** How close the view is: 1 shows the recording's full height (or width), up to 2. */
  level: number
  /** Tall frames with a shown camera: a band across the top or bottom, or the bubble. Square frames always use the bubble. */
  camera: ReframeCamera
  /** Height of the camera band as a share of the frame inside the padding, 0.2..0.5. */
  band: number
  pace: ReframePace
  /** Tall frames: captions, key presses, the logo and lower-third titles stay clear of the apps' buttons. */
  appSafe: boolean
  /**
   * Where the view rests when there is nothing to follow (no cursor data, or before the first
   * action), normalised to the WHOLE recorded frame like every stored position (crop.ts maps it
   * into view space). Absent: the centre of what is shown.
   */
  rest?: { x: number; y: number }
}

/** The project a copy was made from (informational: "Open original"). */
export interface ProjectCopyOf {
  id: string
  name: string
}

export interface Project {
  // … after `crop`:
  /** Following the action in tall and square frames. Absent: the whole recording is fitted, as before. */
  reframe?: ReframeSettings
  /** Set on a copy made by Duplicate, Make a vertical version or Make a square version. */
  copyOf?: ProjectCopyOf
}
```

### 4.2 `src/shared/engine/reframeData.ts` (new): defaults and sanitising

```ts
export const REFRAME_LIMITS = { level: { min: 1, max: 2, step: 0.05 }, band: { min: 0.2, max: 0.5, step: 0.01 } } as const
/** A frame follows when outW/outH < FOLLOW_NARROWER × vw/vh. */
export const FOLLOW_NARROWER = 0.9
/** A tall frame: h >= TALL × w (9:16 is 1.78). Bands, safe zones and the text area need one. */
export const TALL = 1.25
export const DEFAULT_REFRAME: Readonly<ReframeSettings> = Object.freeze({ mode: 'follow', level: 1, camera: 'top', band: 0.32, pace: 'balanced', appSafe: true })

/** Stored settings, sanitised; undefined when absent or not a plain object. */
export function readReframe(raw: unknown): ReframeSettings | undefined
/** A stored copyOf, sanitised; undefined unless id matches /^[a-zA-Z0-9_-]+$/ and name is a string (cut to 200). */
export function readCopyOf(raw: unknown): ProjectCopyOf | undefined
/** Settings when following is turned on in a w × h frame: existing ones with mode 'follow', else DEFAULT_REFRAME (camera 'bubble' and appSafe false when the frame is not tall). */
export function reframeOn(project: Pick<Project, 'reframe'>, outW: number, outH: number): ReframeSettings
/** Whether a w × h frame of the drawn recording (vw × vh, after the crop) follows the action. */
export function followApplies(project: Pick<Project, 'reframe'>, outW: number, outH: number, vw: number, vh: number): boolean
/** Whether `aspect` could follow a vw × vh recording (the Style panel shows the toggle; Duplicate's menu enables its items). */
export function canFollow(aspect: AspectRatio, vw: number, vh: number): boolean
export const isTall = (w: number, h: number): boolean => h >= TALL * w
/** `p` with `patch` merged into its reframe settings (DEFAULT_REFRAME for missing ones). */
export function withReframe(p: Project, patch: Partial<ReframeSettings>): Project
/** `p` without following (pick modes, the crop tool): `reframe` dropped; the same object when absent. */
export function withoutFollow<P extends { reframe?: ReframeSettings }>(p: P): P
```

`readReframe(raw)`:

1. Not a plain object → `undefined`.
2. `mode`: `'fit'` or `'follow'`, else `'fit'` (a damaged file never turns following on).
3. `level`: finite → clamp to 1..2, else 1. `band`: finite → clamp to 0.2..0.5, else 0.32.
4. `camera`: one of its values, else `'top'`. `pace`: one of its values, else `'balanced'`.
5. `appSafe`: a boolean, else `false` (a damaged file never moves captions).
6. `rest`: kept only when `x` and `y` are finite, clamped to 0..1.
7. Idempotent: `readReframe(readReframe(x))` deep-equals `readReframe(x)`.

### 4.3 Migration (`src/shared/engine/project.ts`)

`migrateProject` (`project.ts:128`) adds `reframe, copyOf` to the destructure on line 134 and two
lines after `crop`:

```ts
const { trim: _legacyTrim, audioStems, transcript, captions, inputEdits, director, script, crop, freezes, overlays, fonts, brand, reframe, copyOf, ...rest } = p
// …
// Following the action in tall and square frames, sanitised (absent: fitted, as before).
...optional('reframe', readReframe(reframe)),
// The project this one was copied from (absent: an original).
...optional('copyOf', readCopyOf(copyOf)),
```

### 4.4 Old projects and settings load unchanged

- No existing `project.json` has `reframe` or `copyOf`. `optional` adds no key when the value is
  `undefined` (`project.ts:122`), so the migrated object has exactly the keys it had and saving
  writes the same JSON (test 2).
- That includes projects already set to 9:16 or 1:1: `followApplies` is false, so `sceneLayout`
  takes today's branch, `frameCamera` makes today's `cameraAt` call, the text area is `null`, and
  the compositor's call sequence is identical (tests 12, 13, 41, 47, 53).
- An older Flown build opening a newer file passes the keys through `...rest` untouched and draws
  the project fitted, as it always did.
- `createProject` (`project.ts:59`) is unchanged: new recordings have no `reframe` (the recording
  side is untouched).
- Style presets, *Save as default style* (`style-defaults.json`) and the brand kit never read or
  write `reframe` or `copyOf`: `sanitizeStyleLook` (`styleDefaults.ts:186`) keeps its field list and
  `applyPreset`/`applyStyleDefaults` only touch the style, cursor, camera, effects, zoom, watermark
  and tilt fields. Polish in one click does not turn following on.
- `cursor.json` is never changed. Editor preferences gain only the `localStorage` key
  `editor-safe-zones` (`'off'` or a choice; anything else is off).

### 4.5 Crop

`cropProject` (`crop.ts:240`) maps `reframe.rest` into view space (`toCrop`, then clamped to 0..1),
memoised with the project like the other mapped fields; `CroppableProject` (`crop.ts:233`) gains
`'reframe'`. Without a crop it returns the same object, as today. Edits of the rest point and of
zoom points from the preview go back through `fromCrop` (`crop.ts:144`), as zoom points already
do. While the crop tool is open, the Editor's drawn project (`Editor.tsx:344-348`) also goes through
`withoutFollow`, so the tool shows the whole recording.

### 4.6 Types used by the engine

```ts
// src/shared/engine/layout.ts
/** Size of the followed view at zoom 1, as shares of the recording (view space). */
export interface ViewSize { w: number; h: number }
/** While following: the part of the frame the screen fills, the view's size there, and the camera band (if any). */
export interface FollowGeometry { slot: Rect; base: ViewSize; band: Rect | null }
export interface SceneLayout {
  /** Where the recording is drawn at camera scale 1. While following: the virtual rectangle (larger than the frame). */
  screen: Rect
  camera: CameraBox | null
  moving: boolean
  /** Set only while following (§5.2). */
  follow?: FollowGeometry
}
export type SceneProject = Pick<Project, 'style' | 'layouts' | 'webcam' | 'hasWebcam'> & Partial<Pick<Project, 'clips' | 'duration' | 'reframe'>>

// src/shared/engine/zoom.ts
/** Anything with a position over time (SmoothedTrack, the follow plan). */
export interface PathLike { at(t: number): { x: number; y: number } }
/** The followed view a camera of scale 1 shows: centred on (cx, cy), w × h of the recording. */
export interface ViewBase { cx: number; cy: number; w: number; h: number }
```

### 4.7 Duplicate: what is copied, and how ids, files and assets are handled

```ts
// src/shared/api/projects.ts (ProjectsApi, additive)
export interface DuplicateProgress { done: number; total: number }
export interface DuplicateResult {
  id: string
  name: string
  /** False when a media file had to be copied (the copy then uses more disk). */
  linked: boolean
}
/**
 * Makes a new project folder holding `copy` (the editor's current state, already transformed by
 * projectCopy, still carrying the source's id) and the source's recording files. Rejects with a
 * readable message; the source folder is never written.
 */
duplicateProject(sourceId: string, copy: Project): Promise<DuplicateResult>
/** Progress of the running copy (bytes); returns an unsubscribe function. */
onDuplicateProgress(listener: (p: DuplicateProgress) => void): () => void
/** Stops the running copy; its promise rejects with an AbortError and the new folder is removed. */
cancelDuplicate(): void
```

Main (`src/main/projectCopy.ts`, new), behind `projects:duplicate`, `projects:duplicateCancel` and
the `projects:duplicateProgress` event:

1. **Sender**: the handler throws "Not allowed" unless
   `e.sender.id === getMainWindow()?.webContents.id && isAppUrl(e.senderFrame?.url ?? '')`
   (the rule of `notes/notesIpc.ts:47`). One copy at a time: a second call rejects with "a copy is
   already being made."
2. **Source**: `sourceId` must be a string; `projectDir(sourceId)` rejects anything outside
   `[a-zA-Z0-9_-]` (`projects.ts:29, 36`); `project.json` must exist there; its `name` is read from
   disk for `copyOf`.
3. **Copy**: `migrateProject(copy)` (throws on a non-project); its `id` must equal `sourceId` (the
   renderer may only duplicate the project it has open).
4. `removeStaleCopies()` (step 11), then `createProjectDir(new Date())` (`projects.ts:62`) reserves
   `rec-YYYYMMDD-HHMMSS[-n]` in the current root; the folder name is the new id (`readProject`
   forces it, `projects.ts:99`). The marker `.copying` (JSON `{ source, startedAt }`) is written
   first.
5. **Files**: `readdir(src)` and `lstat` each entry; only **regular files** whose names match the
   table below are handled (symlinks, folders other than `.cache`, and unknown names are skipped).
   Destination names equal source names, so no path from the renderer is ever used.
6. **Media** (`LINKED_MEDIA`): `fs.link` when `linkAllowed(root)`, i.e. the projects root is not
   inside a OneDrive folder (`process.env.OneDrive`, `OneDriveConsumer`, `OneDriveCommercial`,
   compared case-insensitively on Windows). On any error (`EXDEV` for a legacy root on another
   drive, `EPERM`, `ENOTSUP`, FAT drives, placeholders), or when linking is not allowed, the file is
   copied.
7. **Free space**: before the first byte copy, `fs.statfs(dir)`: `bavail × bsize` must be at least
   the bytes still to copy plus 64 MB, else reject with the free-space message (sizes in GB, one
   decimal) and create nothing that stays.
8. **Copies**: `fs.copyFile(src, dst, COPYFILE_EXCL | COPYFILE_FICLONE)` (copy-on-write where the
   file system offers it, else a plain copy), then `fs.utimes` with the source's times. Progress
   events at most 10 times a second; links count as done at once.
9. **`project.json` last** (`writeFileAtomicSync`): `{ ...copy, id, createdAt: now.toISOString(),
   name: copy.name.trim().slice(0, 120) || 'Untitled recording', copyOf: { id: sourceId, name:
   sourceName } }`. The renderer's `copyOf` and `createdAt` are ignored.
10. Remove `.copying`; resolve `{ id, name, linked }`.
11. **Failure or Cancel**: remove the new folder and reject. It is removed with its `.copying`
    marker last (each other entry with `fs.rm`, recursive, `maxRetries: 3`, then the folder), as
    every clean-up below does: a file another program holds (an antivirus scan, the indexer,
    OneDrive) makes the removal fail part way, and the folder then keeps its marker, so the next
    copy or the next start removes it.
    **Crash**: `removeStaleCopies()` removes folders in the current root that hold `.copying` with a
    `startedAt` more than one hour old (or an unreadable marker on a folder modified more than one
    hour ago), and only when they have no `project.json` and no raw recording files (`RAW`,
    `projects.ts:177`). Until then such a folder is invisible: no `project.json` (not listed by
    `listProjects`, `projects.ts:142`) and no raw bytes (not listed by `listUnfinished`,
    `projects.ts:307`).
    **Quit or closed window during a copy**: the copy is not finished and its folder stays, so at
    start-up `removeAbandonedCopies()` removes every such marked folder whatever its age (one
    instance runs at a time and no copy has started yet), with the same `project.json` and raw-file
    guard.

| File in the source folder | In the copy | Why |
|---|---|---|
| `project.json` | Written last from `copy` (step 9) | Unsaved edits are included; the original is never read for content. |
| `cursor.json` | Copied | Read-only after recording, small. |
| `screen.mp4`, `webcam.mp4`, `mic.m4a`, `system.m4a` (`LINKED_MEDIA`) | Linked (step 6), else copied | Never rewritten once the project exists; large. Deleting either project removes only its own link. |
| Every other `MEDIA_FILE_RE` name (`mediaProtocol.ts:11-12`): `background.*`, `cursor.*`, `watermark(-n).*`, `music(-n).*`, `overlay-n.*`, `font-n.*` | Copied | Small; some reuse their name when replaced (`copyIntoProject`, `projectsIpc.ts:148`). Unreferenced ones are copied too: cheap, never wrong. |
| `script.txt` (`SCRIPT_FILE`, `projects.ts:188`) | Copied | The speaker notes kept with the recording. |
| `.cache/speech.json` (`speech/vad.ts:26`) | Copied into a new `.cache` | Saves re-running the speech detector; keyed by the media file's size and time, kept exactly by a link. |
| `.cache/transcript-parts/` | Not copied | Only resumes an unfinished caption run. |
| `recording.json`, `screen.webm`, `native.mp4`, `webcam.webm`, `audio.webm` | Not copied | Exist only in unfinished recordings, which cannot be opened. |
| Anything else, symlinks, other folders | Not copied | Unknown files are never copied. |

Inside `project.json`, item ids (clips, zooms, captions, layouts, overlays, fonts) stay as they
are: they are unique only within a project, and item copy and paste already makes new ones. Asset
references (`overlay-3.png`, `font-1.woff2`, `watermark-2.png`, `music-1.mp3`, the background, the
custom cursor) keep their names because the files keep theirs; a reference to a missing file stays
missing, exactly as in the original (the panels already say so). Undo history, selection and
in-memory analysis caches are not copied; the copy opens fresh. The renderer could already write
any `project.json` through `projects:save`, so the channel adds no trust; the JSON is checked by
`migrateProject` and is at most 64 MB.

**Contract** (a comment in `projectCopy.ts` and test 64): *media files may be hard-linked between
projects; code outside `src/main/recording/` must never open `LINKED_MEDIA` for writing: write a
temporary file and rename it.*

### 4.8 What the copy changes (`src/shared/editor/duplicate.ts`, pure)

```ts
export type CopyKind = 'copy' | 'vertical' | 'square'
/** "Billing demo (copy)", "(vertical)", "(square)"; a blank name gives "Untitled recording (…)"; at most 120 characters. */
export function copyName(name: string, kind: CopyKind): string
/** Measures text as the compositor draws it (px wide). */
export type MeasureText = (text: string, px: number, font: string, weight: number) => number
/** Whether a copy of `kind` can be made, with the menu's reason when not (§2.2). vw × vh: the recording as cropped. */
export function canCopyAs(project: Project, kind: CopyKind, vw: number, vh: number): { ok: true } | { ok: false; reason: string }
/**
 * The project as copied (still with `project.id`; main gives the new id):
 *  - 'copy': only the name changes.
 *  - 'vertical' / 'square': aspectRatio '9:16' / '1:1'; reframe = { ...DEFAULT_REFRAME, ...project.reframe,
 *    mode: 'follow', camera: kind === 'vertical' ? (project.reframe?.camera ?? 'top') : 'bubble',
 *    appSafe: kind === 'vertical' }; text annotations and image overlays refitted (refitItems).
 * Never changes clips, zooms, layouts, captions, shapes, crop, freezes or any other field. Pure: the input is not mutated.
 */
export function projectCopy(project: Project, kind: CopyKind, measure: MeasureText | null): Project
/**
 * Text and images moved into `area` (output px of a w × h frame; §6.4): each item already inside is the same object;
 * else shifted in; if larger than the area, scaled down to fit but not below 60% of its size; a text still too wide
 * at 60% is broken at the space nearest its middle ("\n"), then shifted.
 */
export function refitItems(project: Pick<Project, 'annotations' | 'overlays'>, w: number, h: number, area: Rect, measure: MeasureText | null): Pick<Project, 'annotations' | 'overlays'>
```

The renderer flow (`src/renderer/src/editor/duplicateFlow.ts`, `runDuplicate`): pause, flush the
save, build with `projectCopy` (measuring text on a canvas as `captionsLayer.ts` does), call the API
with the progress modal, then leave the editor the way **Back** does and open the new id through
`onOpenProject(id, notice)` (§9, `App.tsx`).

---

## 5. The follow-the-action framing algorithm

### 5.1 When it applies

`followApplies(project, outW, outH, vw, vh)` = `project.reframe?.mode === 'follow' && outW/outH <
0.9 · vw/vh`, with `vw × vh` the drawn (cropped) recording. For a 16:9 recording: 9:16 (0.5625 <
1.6), 1:1 (1 < 1.6) and 4:3 (1.333 < 1.6) follow; 16:9 and Auto do not. A 1:1 frame of a 4:3 window
follows (1 < 1.2); a 9:16 frame of a 9:16 phone mirror does not. `canFollow(aspect, vw, vh)` is the
same test on `outputSize(aspect, vw, vh, 1080)`. `sceneLayout` (`layout.ts:374`) is the single
switch: when `followApplies` is false its body is today's, unchanged.

### 5.2 Coordinate model: slot, base view and virtual rectangle

Frame `W × H`, drawn recording `vw × vh`, `a_v = vw/vh`.

- **Slot**: the rectangle the screen fills while following (§5.3), `a_s = slot.w/slot.h`.
- **Base view**: the share of the recording the slot shows at zoom 1, cover-fitted and divided by
  the effective level `L` (§5.12):

  ```
  base.w = min(1, a_s / a_v) / L        base.h = min(1, a_v / a_s) / L
  ```

  Output px per recorded px are equal on both axes because `base.w/base.h = a_s/a_v`.
- **Virtual rectangle**, the slot enlarged about its own centre:

  ```
  virtualRect(slot, base) = { x: slot.x + slot.w/2 − slot.w/(2·base.w), y: slot.y + slot.h/2 − slot.h/(2·base.h),
                              w: slot.w/base.w, h: slot.h/base.h }
  ```

  `sceneLayout` returns it as `screen`, with `follow = { slot, base, band }`. With the existing
  `toOutput(rect, cam)` (`outputPoint.ts:11`):
  `out.x = rect.x + (x − (cx − 0.5/s))·s·rect.w = slot.x + slot.w/2 + (x − cx)·s·slot.w/base.w`,
  so the camera centre lands on the slot's centre and the slot shows `cx ± base.w/(2s)`. This is
  why `viewSource` and `cardRect` (`compositor.ts:298-320`), `cameraDisplacement`, `cursorHeight`
  (`overlays.ts:143`: `rect.h·cam.scale/vh` is exactly the magnification), the shape, blur and
  spotlight layers, the director and `PreviewStage`'s `mappingFor` (`PreviewStage.tsx:92`) need no
  new maths.
- **Card and clip**: while following, the card (shadow, corners, border, static layer key) and the
  clip path are `intersectRect(slot, cardRect(rect, cam))`. At scale ≥ 1 that is the slot itself:
  constant, so the static layer cache (`staticLayer.ts`, `paintStaticLayer`) serves it. Pulled
  back, it is the shrunken recording cut to the slot.

Worked numbers (1920×1080 recording, `L = 1`):

| Frame | Padding | Camera | Slot (px) | base.w | Recorded px across | Magnification |
|---|---|---|---|---|---|---|
| 1080×1920 | 0 | none or bubble | 1080×1920 | 0.3164 | 608 | 1.78× |
| 1080×1920 | 0.07 | none or bubble | 928.8×1768.8 | 0.2954 | 567 | 1.64× |
| 1080×1920 | 0 | top band 0.32 | 1080×1305.6 | 0.4653 | 893 | 1.21× |
| 1080×1920 | 0.07 | top band 0.32 | 928.8×1170.4 | 0.4464 | 857 | 1.08× |
| 1080×1080 | 0 | none or bubble | 1080×1080 | 0.5625 | 1080 | 1.00× |
| 1440×1080 (4:3) | 0 | none | 1440×1080 | 0.75 | 1440 | 1.00× |
| 1080×1920, L = 1.5 | 0 | top band 0.32 | 1080×1305.6 | 0.3102 (h 0.667) | 596 | 1.81× |

A 2560×1440 recording in a padding-free 9:16 frame shows 810 px across at 1.33×.

### 5.3 Follow layout geometry (`followGeometry`)

`area = paddedArea(W, H, style.padding)` (`layout.ts:143`), `m = min(W, H)`, `gap = style.padding
> 0 ? SIDE_GAP·m : 0` (`SIDE_GAP = 0.03`, `layout.ts:106`), `card = style.cornerRadius·m/1080`.
`place` = `reframe.camera` when the frame is tall and the camera is shown (`layoutsApply`,
`layout.ts:253`), else `'bubble'`.

`band(f, side)`: `bh = f·area.h`; the camera rect is `{ area.x, side === 'top' ? area.y : area.y +
area.h − bh, area.w, bh }` with radius `card` and opacity 1; the slot is the rest of the area minus
`gap`.

| Layout (`CameraLayout`) | place Top / Bottom | place Bubble, or no camera |
|---|---|---|
| `default` | `band(reframe.band, place)` | slot = area; camera = the bubble as `layoutGeometry` draws it (`webcamRect`, `layout.ts:87`, with the segment's corner) |
| `side-by-side` | `band(reframe.band, place)` | tall frame: `band(reframe.band, top corner ? 'top' : 'bottom')`; other frames: today's `sideBySide` with the screen part as the slot |
| `camera-large` | `band(min(0.52, 1.6·reframe.band), place)` (deeper leaves too little text area under a top band) | slot = area; the large bubble as today |
| `screen-only` | slot = area; camera = the band collapsed to height 0 at its outer edge, opacity 0 | slot = area; the hidden bubble as today |
| `camera-only` | camera = area (radius `card`); slot = the `default` slot scaled by `BEHIND_SCALE` (0.5, `layout.ts:110`) about its centre | camera = area; slot = area scaled by 0.5 |

Changes animate with `layoutPhaseAt` (`layout.ts:332`) and `easeInOutCubic`, as `sceneLayout`
does today: slot, camera rect, radius and opacity are lerped, and `base` and the virtual rectangle
are recomputed from the lerped slot, so the view widens or narrows continuously when the band
hides or shows. `moving` is true while the slot moves. The compositor reads `layout.moving`
instead of calling `layoutMoving`; for projects that do not follow this is the same value
(`sceneLayout` sets `moving: screenMoves(p)` exactly when `layoutMoving` would be true,
`layout.ts:368-386`; test 12 proves it). `camera-only` keeps the hidden slot's shape, so `base` and
the view do not change while the camera fills the frame.

### 5.4 Time base

- **Grid**: attention is sampled at `g = 1/30` s of output time: `o_k = k·g`, `k = 0..N−1`,
  `N = max(1, ⌈total/g⌉ + 1)`, `total = outputDuration(clips)` (`timeline.ts:37`). Each sample's
  source time `s_k = clip.start + (o_k − clipOut[c])·clip.speed` is found by one forward walk over
  the clips, like `exportFrameTimes` (`timeline.ts:92`).
- **Cuts**: sample `k` is the first after a cut when its clip's `start` differs from the previous
  clip's `end` by more than 1e-6 s. A split with only a speed change is not a cut.
- **Evaluation** `followCentre(plan, t, at = t)`: `c` = the clip containing `at` (`start ≤ at <
  end`; the last clip includes its end; a time inside a cut uses `playableFrom`'s clip,
  `timeline.ts:83`, else the last). `s = clamp(t, clip.start, clip.end)`, `o = clipOut[c] + (s −
  clip.start)/clip.speed`, then the segment containing `o` is found by binary search (§5.11). The
  compositor passes the frame's own time as `at` for every motion-blur sub-frame, so a shutter that
  reaches past a clip's end samples that clip's last view, never the next clip's.
- **Speed**: planning in output time makes a pan last the same on screen at any clip speed; on a 4×
  clip a 1 s pan covers 4 s of recording.
- **Freeze frames**: nothing in planning. The compositor draws the picture's source time
  (`pictures[i]`, `exporter.ts:434`; `pictureTime` in the player, `player.ts:408`), so
  `followCentre` returns the same point for every frame of a freeze: the view holds with the
  picture, and motion blur is already off for held frames (`frozen`, `exporter.ts:409`; `FROZEN`,
  `player.ts:39, 423`). After a *keep the sound playing* freeze the picture jumps to a later source
  time; the view jumps with it, like a cut.

### 5.5 The view the planner measures in

Distances are in **views** on each axis. At sample `k` the planner's view is
`view_k = { w: min(1, b_k.w / z_k), h: min(1, b_k.h / z_k) }`, where:

- `b_k` is the base of the steady layout state at `s_k` (computed once per state; during a layout
  change the smaller of the two states' bases, so the plan stays safe);
- `z_k = cameraAt(framed, s_k, null, style).scale` is the framed zooms' scale at `s_k` (§5.12; the
  scale never depends on the focus), floored at `fit`.

`dx = |a.x − b.x| / view_k.w`, `dy = |a.y − b.y| / view_k.h`, `dist = max(dx, dy)`; an axis whose
view is ≥ 1 contributes 0 and its centre stays 0.5. Inside a 1.4× zoom the view is 0.71 of the
unzoomed one, so the same target is 1.4× further in views.

### 5.6 Attention: what the view looks at

For each sample `k`, at most one **target** `A_k = (x, y)` in view space, its kind, and for firm
kinds the **event time** `e_k` (output seconds). The first rule that gives a target wins. The inputs
are the drawn project (`cropProject`) and the drawn track (`effectiveTrack`, then `cropTrack`):
ignored clicks are already gone and straightened moves already straight.

| # | Kind | Active at sample k | Target | Firm | Event |
|---|---|---|---|---|---|
| 1 | `zoom` | a framed zoom with `start ≤ s_k < end` (sorted, one forward pointer) | fixed: `(x, y)`; region: its centre; cursor focus: its anchor while `anchorWeight(z, s_k) ≥ 0.5` (`zoom.ts:499`), else fall through. Pull-backs fall through. | yes | `o(z.start)` |
| 2 | `typing` | `t0 ≤ s_k ≤ t1 + typingTail` for a session of `typingSessionsOf(track, zoomSettings.auto)` (the sessions auto zoom uses: zoom clicks, pause `max(TYPING_PAUSE, clusterGap)`, `zoom.ts:315, 386`) | the session's place (the click into the field, else the cursor where typing began) | yes | `o(t0)` |
| 3 | `click` | `o(tc) − clickBefore ≤ o_k ≤ o(tc) + clickAfter` for a click that is finite, inside 0..1 and not in a cut, and only on samples of the click's own clip piece (the window never reaches across a cut); any button; the latest wins when windows overlap | the click | yes | `o(tc)` |
| 4 | `shape` | a shape shown at `s_k` (not blur or pixelate) or a region spotlight; the latest `start` wins | arrow: its head `(x + w, y + h)`; line: its middle; box, ellipse, highlight, spotlight: its centre | no | |
| 5 | `scroll` | `start ≤ s_k ≤ end + scrollTail` for a session of `scrollSessions(track.scrolls)` (`scroll.ts:48`) | the latest wheel event's position at or before `s_k` | no | |
| 6 | `cursor` | the track is valid and has samples | the cursor's intent (below) | no | |
| – | none | nothing above, or the target is outside 0..1 | no target: the view holds | | |

**Cursor intent.** Moves come from `cursorMoves(track, vw/vh)` (`cursorPath.ts:83`, cached per
samples array); rests are the gaps between moves.

- Inside a rest: the rest's position (`to` of the move before it, or `from` of the first move).
- Inside a move no longer than `maxAimedMove` (2.5 s): the move's **destination** `to`. The view
  knows where the cursor is going, so a quick flight is one decision, not a chase.
- Inside a longer move (a drag, a wander), before the first rest and after the last: the recorded
  cursor `trackAhead` (0.3 s of output) ahead, `cursorAt(samples, s_k + 0.3·speed)` (`cursor.ts:5`).
- A position outside 0..1 gives no target: another monitor, beside a window or area recording, the
  cropped-away part, or a cursor over a window covering the recorded one (the tracker maps those
  outside).

`o(t)` is `sourceToOutput(clips, t)` (`timeline.ts:55`). Events in a cut give no attention; a typing
session that spans a cut uses its kept parts.

### 5.7 Shots: dead zone, confirmation and look-ahead

A **shot** is a held view `{ o0, centre, firm, firstFirm, lastFirm, cut, late }`. Walking `k`
forward with `cur` the current shot (shot 0 starts at `o = 0` with centre `fit(0, startAhead)`,
else the rest point, else (0.5, 0.5)):

1. **Cut**: if `k` is the first sample after a cut and `A_k` exists with `dist(A_k, cur.centre) >
   visible`, start a new shot at `k` with `cut = true` and centre `fit(k, lookAhead)`, without
   confirmation. Otherwise the shot goes on across the cut.
2. No target: continue (hold).
3. **Comfortable**: `dist(A_k, cur.centre) ≤ deadZone`: continue. A firm sample sets `cur.firm`,
   `cur.lastFirm = e_k`, and `cur.firstFirm` if unset.
4. **Confirmation** (soft targets only): every soft target in `k .. k + confirm/g` (same clip piece)
   must be outside the comfortable region. A firm sample in that span ends the check: confirmed if
   it is outside too, an excursion if inside. A soft target coming back inside makes it an
   excursion (a flick, an overshoot), and the view ignores it. The check reads the future, so a
   confirmed shot still starts at `o_k`: the window adds no lag.
5. **New centre**: `c' = fit(k, lookAhead)`. If `c'` is null or `dist(c', cur.centre) < minChange`,
   no new shot (the view is clamped at the recording's edge); a firm sample still marks `cur.firm`.
6. Otherwise push a shot at `o_k` with centre `c'`, `firm` = whether `A_k` is firm, and
   `firstFirm = lastFirm = e_k` for a firm sample.

`fit(k, span)`: walk `j = k ..` over at most `span` seconds within one clip piece, keeping per-axis
min and max of the targets, and stop before a target that would make `max − min > 2·deadZone·
view_j` on either axis. The centre is the midpoint per axis; an axis without targets keeps
`cur.centre`'s coordinate. Then clamp each axis to `[view.w/2, 1 − view.w/2]` (0.5 when the view is
≥ 1). The new view covers everything the next 1.2 s need, as far as one view can.

### 5.8 Short shots

Left to right, once:

- A shot that is not the first, not firm, not `cut`, and shorter than `minHold` is **dropped** when
  every target inside it stays within `visible` of the previous shot's centre; its time joins the
  previous shot. A visit the view can already see does not move it.
- Consecutive shots whose centres are less than `minChange` apart merge (the earlier centre).

### 5.9 Pans

For consecutive shots `A → B` where `B` is not a cut:

- `d = dist(A.centre, B.centre)` in views at `view(B.o0)`.
- **Duration** (the glide with ramp 0.5 has peak speed `2d/D` and peak acceleration `6d/D²`):

  ```
  D = max( clamp( max(minPan, 2d/maxSpeed, sqrt(6d/maxAccel)), minPan, maxPan ), 2d/hardSpeed )
  ```

  Balanced:

  | d (views) | 0.3 | 0.5 | 0.75 | 1 | 1.5 | 2 | 3.16 (whole width, 9:16) |
  |---|---|---|---|---|---|---|---|
  | D (s) | 0.600 | 0.775 | 1.000 | 1.333 | 1.500 | 1.500 | 2.107 |
  | peak speed (views/s) | 1.00 | 1.29 | 1.50 | 1.50 | 2.00 | 2.67 | 3.00 |
  | peak acceleration (views/s²) | 5.00 | 5.00 | 4.50 | 3.38 | 4.00 | 5.33 | 4.27 |

- **Start**: `t0 = max(B.o0, prevEnd)`, `prevEnd` = the end of the previous pan or of the latest cut
  at or before `B.o0`. For a cursor move `B.o0` is when the cursor starts moving.
- **Deadline** (firm shots, `firstFirm = e`): the event must be comfortably in view at `e`:
  `|P_e − F(e)| ≤ inView` views on both axes, `P_e` the event's target. With `δ = dist(P_e,
  B.centre)` (≤ deadZone by construction), the pan must reach progress `p_req = clamp(1 − (inView −
  δ)/d, 0, 1)` by `e`; `u* = glideInverse(p_req, 0.5)` (bisection, 40 steps). Then, in this order:
  1. if `t0 + u*·D ≤ e`: done;
  2. else **anticipate**: `t0 = max(e − u*·D, B.o0 − maxLead, prevEnd, A.lastFirm + settle,
     A.o0 + minShown)`: the view may leave up to `maxLead` early, never before the previous shot's
     last click has been seen nor before it was on screen `minShown`;
  3. if still `t0 + u*·D > e`: **hurry**: `D = max((e − t0)/u*, 2d/hardSpeed, minPan)`; if even
     that is late it stays late and the shot is marked `late` (diagnostics and tests).
- **Cuts**: a pan never crosses a cut. If a cut `c` lies in `(t0, t0 + D)`: when `c − t0 ≥ minPan/2`
  the pan ends at `c` (`D = c − t0`); otherwise there is no pan and the view changes at the cut.
- **Backlog**: if `t0 ≥ C.o0` for the shot `C` after `B`, `B`'s pan is dropped and the next pan
  goes from `A` to `C`.
- The segment is `{ o0: t0, o1: t0 + D, from: A.centre, to: B.centre, ramp: 0.5, kind: 'pan' }`.

### 5.10 The glide profile and joined glides

Every move uses one profile, the **glide**, with ramp `r ∈ (0, 0.5]`: velocity rises with a
smoothstep over the first `r`, cruises, and falls over the last `r`. With `S(y) = y³ − y⁴/2`:

```
glide(u, r) = 0                              u ≤ 0
            = r·S(u/r) / (1 − r)             0 < u < r
            = (u − r/2) / (1 − r)            r ≤ u ≤ 1 − r
            = 1 − r·S((1 − u)/r) / (1 − r)   1 − r < u < 1
            = 1                              u ≥ 1
```

It is C²: position, velocity and acceleration are continuous, velocity and acceleration are zero
at both ends, and jerk is bounded (`3/(r²(1 − r))` × d/D³). Peak velocity `1/(1 − r)` and peak
acceleration `1.5/(r(1 − r))` (× d/D and d/D²); at `r = 0.5` that is 2 and 6, close to minimum jerk
(1.875 and 5.77; `minJerk`, `cursorPath.ts:74`). Checked values: `glide(0.5, r) = 0.5` for every
`r`; `glide(0.25, 0.5) = 0.09375`; `glide(0.25, 0.25) = 0.16667`; `glide(0.1, 0.5) = 0.0072`.

**Joined glides (tracking).** Two consecutive pans `P`, `Q` with `Q.o0 − P.o1 ≤ joinGap`, not
separated by a cut, and not opposite on either axis (`sign(ΔP)·sign(ΔQ) ≥ 0`), become one glide
`{ o0: P.o0, o1: Q.o1, from: P.from, to: Q.to, ramp: min(0.5, glideRamp/(Q.o1 − P.o0)), kind:
'glide' }`, accepted only if every target in `[P.o0, Q.o1]` stays within 0.5 views of the glide
(soft) and within `inView` (firm). Applied left to right and greedily, so a slow drag across the
screen becomes one steady glide instead of pan, stop, pan, stop.

### 5.11 Evaluation and clamping

```ts
export interface FollowSegment { o0: number; o1: number; from: Pt; to: Pt; ramp: number; kind: 'hold' | 'pan' | 'glide' }
export interface FollowShot { o0: number; centre: Pt; firm: boolean; firstFirm: number; lastFirm: number; cut: boolean; late: boolean; kind: AttentionKind }
export interface FollowPlan {
  total: number
  clips: readonly Clip[]
  /** Output second at which each clip starts. */
  clipOut: Float64Array
  /** Back to back from 0 to total; holds between moves. */
  segments: FollowSegment[]
  /** segments[i].o0, for the binary search. */
  starts: Float64Array
  /** For tests, diagnostics and the Later "why it moved" view. */
  shots: FollowShot[]
}
```

`followCentre(plan, t, at)`: §5.4 gives `o`; the segment `i` is the last with `starts[i] ≤ o`. A hold
returns `from`; a pan or glide returns `from + (to − from)·glide((o − o0)/(o1 − o0), ramp)`. O(log n),
no allocation besides the result. The camera then clamps that centre with the **real** frame's base
at `t` (the slot at `t`, possibly mid layout change), through `clampCamera(…, base)`. The plan was
clamped with the canonical base, so this only differs by the pixel rounding of the frame size, or
while a layout change narrows the view.

### 5.12 Zooms in a followed frame

**Effective level and limits** (`followLimits`, computed at the canonical frame, cached per
project): `mag1` = output px per recorded px of the default layout's slot at level 1
(`slot.w/(base.w·vw)`), or of the whole area when the project has a `'screen-only'` segment and
the camera sits in a band (the band collapses there, so the recording is drawn larger;
`peakMagnification`); `L = clamp(reframe.level, 1, max(1, MAX_MAGNIFY/mag1))` (the *How close*
hint shows when this limits the slider); `mag = mag1·L`; `fit = min(base.w, base.h)` (the whole
recording in the view); `cap = max(1, MAX_MAGNIFY/mag)`. `MAX_MAGNIFY = 3`, `ZOOM_STRENGTH = 0.5`.

| Recording, frame | mag | cap | fit |
|---|---|---|---|
| 1080p, 9:16, padding 0.07, bubble | 1.64 | 1.83 | 0.2954 |
| 1080p, 9:16, padding 0.07, top band | 1.08 | 2.77 | 0.4464 |
| 1080p, 9:16, padding 0, bubble | 1.78 | 1.69 | 0.3164 |
| 4K, 9:16, padding 0.07, bubble | 0.82 | 3.66 | 0.2954 |
| 720p, 9:16, padding 0.07, bubble | 2.46 | 1.22 | 0.2954 |

**Framed zooms** (`framedZooms(zooms, limits)`, memoised per zooms array and limits; ids, times,
easing and anchors kept):

- level `s ≥ 1`: `s' = min(1 + (s − 1)·ZOOM_STRENGTH, cap)`: 1.8× → 1.4×, 2× → 1.5×, 3× → 2× (then the cap).
- region: `s' = clamp(min(base.w/r.w, base.h/r.h), fit, cap)`, focus unchanged: the rectangle is
  framed inside the view; one wider than the view pulls back.
- pull-back `0.5 ≤ s < 1`: `s' = fit + (1 − fit)·(s − 0.5)/0.5`: 0.5 shows the whole recording,
  0.75 → 0.648 in a padded 9:16 bubble.
- `zoomTargetScale(z, floor = ZOOM_MIN_SCALE)` gains the floor (`fit` here), and `planFor` keys its
  cache on it (`zoom.ts:591-600`).

**`cameraAt(zooms, t, focusTrack, style, base?)`** (`zoom.ts:712`). Without `base` every line runs
as today (test 13). With `base = { cx, cy, w, h }` (`cx, cy` = `followCentre(plan, t, at)`; `w, h` =
the layout's `follow.base`):

- **Rest**: `REST_b = clampCamera({ scale: 1, cx, cy }, base)` replaces `REST` (`zoom.ts:490`)
  everywhere it is returned or moved from.
- **Clamp**: `clampCamera(c, base)`: `s = max(0.05, c.scale)`, `hx = 0.5·base.w/s`, `hy =
  0.5·base.h/s`, `cx ∈ [min(hx, 1 − hx), max(hx, 1 − hx)]`, likewise `cy`. A unit base gives today's
  `half = 0.5/scale` (`zoom.ts:619-625`).
- **Target**: `cameraFor(scale, fx, fy, base) = clampCamera({ scale, cx: fx, cy: fy }, base)` at
  every scale; the pull-back formula of `zoom.ts:634` is for the unit base only.
- **Focus**: while following, `focusTrack` is the **plan** (`{ at: (u) => followCentre(plan, u, at)
  }`), not `focusPath`. Fixed and region zooms aim as today; a cursor zoom aims at
  `anchoredAim(seg, t, plan.at(t))` (`zoom.ts:640`), so anchors still win; a pull-back aims at the
  view's centre.
- **Blend**: `blendCameras(a, b, w, base)`: both at scale ≥ 1, centres lerp then clamp with the
  base; otherwise the source's edges lerp in view units, `e = 0.5 − c·s/base.w` (likewise y),
  `c = (0.5 − e)·base.w/s`. A unit base gives today's formula (`zoom.ts:666-679`).
- Connected zooms, easings, the bouncy guard (`move`, `zoom.ts:681`) and anchors are unchanged;
  scales are relative to the view.

Because zoom aims are firm targets (§5.6), the plan is already at a zoom's aim when it starts, so
zooming in is almost a pure change of scale, and zooming out returns to where the view rests.
`aimAt` (`zoom.ts:743`, the tilt's lean) is unchanged: the tilt is not drawn while following.

### 5.13 Crop

Following works in the crop's view: `vw × vh` is the cropped size, every input is already in view
space (`cropView`), the rest point is mapped (§4.5), and zoom aims were clamped into the crop by
`autoZoomsInFrame` (`crop.ts:336`).

### 5.14 Camera director

- **Bubble**: `computeCosts` (`directorCorners.ts:218`) measures where the cursor and clicks are
  drawn through `frameView` at the canonical frame instead of `styleContentRect` plus `cameraAt`
  (lines 225 and 267); a point counts as seen when it lies inside `layout.follow.slot`. The bubble
  then moves away from where the action is drawn in the tall frame. The cost cache key
  (`cornerCosts`, `directorCorners.ts:87`) gains `reframe` and the plan's identity.
- **Band**: corner moves mean nothing. `cameraDirector.ts:190` adds `&& !bandSide(…)` to its
  corner condition, so the director keeps intro, outro, hiding in silences and face framing, and
  leaves corners; the plan's reasons gain the sentence of §2.10.
- **Face framing in a box narrower than square** (a full-frame `camera-only` in 9:16): the cover
  crop already shows 32% of the picture's width, so while following the webcam layer uses
  `narrowBoxZoom(zoom, box.w/box.h) = max(1, zoom·min(1, box.w/box.h))`. A 1.6× framing becomes 1×
  there and stays 1.6× in a 1.6:1 band. Projects that do not follow are unchanged.
- No circularity: the plan depends on layouts only through the slot's shape, which is the same for
  every bubble corner and for `camera-only` (§5.3), so moving the bubble never changes the plan.

### 5.15 No cursor data

`track.valid === false`, or no samples and no clicks: only rules 1 (zooms with a fixed point or a
region; auto zooms of such recordings are fixed already, `zoom.ts:367`) and 4 (shapes) give
targets. The plan is one hold at the rest point (view space; default (0.5, 0.5)) plus pans to and
from those targets with the same limits.

### 5.16 Bad input

| Input | What happens |
|---|---|
| Stray clicks | Clicks ignored by the user or by stray detection are gone before attention (`effectiveTrack`). A used stray click moves the view like any click; *Ignore click* fixes it in one step. |
| Cursor off screen, on another monitor, beside a window or area, in the cropped-away part (−3..4) | No target: the view holds. Nothing is clamped to an edge, so the view is never dragged to the side the cursor left from. |
| Window recordings | Samples are already mapped into the window by the recording side; positions over another window are outside 0..1. |
| Jitter at rest | Within `PATH.restRadius` (`cursorPath.ts:13`), so the rest's position does not move. |
| Fast flicks and overshoots | Destinations, the confirmation window, and dropping short visible visits (§5.7, §5.8). |
| NaN or infinite samples, clicks, scrolls, shapes | Skipped (`Number.isFinite`, as the zoom code does). |
| Unsorted samples (a hand-edited `cursor.json`) | Detected in one O(n) pass; a sorted copy is cached and used, so the plan equals the sorted track's. |
| Zero-length or 0.1 s projects | `N ≥ 1`: one hold. |
| A layout hiding the screen (`camera-only`) | The slot is behind the camera with an unchanged base; the view keeps following, invisibly, and is in place when the screen comes back. |

### 5.17 Worked example

A 1920×1080 recording in a padding-free 9:16 frame without camera, Balanced: `base.w = 0.31641`,
free range `[0.1582, 0.8418]`, dead zone ±0.0949, visible ±0.1424. The cursor rests at x = 0.20 for
2 s, flies to x = 0.75 between 2.0 and 2.4 s, clicks there at 2.6 s, and rests.

1. Shot 0: `fit(0, 2 s)` sees 0.20 until the flight; the destination 0.75 would exceed the span
   0.190, so the centre is 0.20.
2. From `o = 2.0` the target is the destination 0.75 (`dist` 1.738 views > 0.30). The click at 2.6 s
   (window from 2.2 s) is firm and outside the old view's comfortable region, so the shot is
   confirmed at 2.0, centre 0.75, `firstFirm = 2.6`.
3. Pan: `d = 1.738`, `D = max(clamp(max(0.5, 2.318, 1.444), 0.5, 1.5), 1.159) = 1.5 s`.
4. Deadline: `p_req = 1 − 0.35/1.738 = 0.7987`, `u* = 0.6641`. Starting at 2.0 reaches `p_req` at
   3.0, after the click, so it anticipates: `t0 = max(2.6 − 0.996, 2.0 − 0.6, 0, −∞, 0.3) = 1.604`.
5. The pan runs 1.604–3.104 s, peak 2.32 views/s. At the click the view's centre is at 0.639: the
   click is 0.35 views from the centre, comfortably in view. The view leaves 0.4 s before the cursor.

The same rules on other tracks (prototype, Balanced): a slow 6 s drag across the screen is one
joined glide at 0.50 views/s with the cursor never out of view; a far visit of 0.3 s gives no pan;
clicks alternating between x = 0.2 and 0.8 every 1.5 s give one pan per click, every click in view.

### 5.18 Constants (`FOLLOW` and `PACE` in `src/shared/engine/reframe.ts`)

| Name | Calm | Balanced | Lively | Unit | Meaning |
|---|---|---|---|---|---|
| `grid` | 1/30 | 1/30 | 1/30 | s (output) | attention sampling |
| `deadZone` | 0.35 | 0.30 | 0.25 | views | a target this close to the centre needs no move |
| `visible` | 0.45 | 0.45 | 0.45 | views | in view with a margin (short visits, cuts) |
| `inView` | 0.35 | 0.35 | 0.35 | views | where a click, typing or zoom must be at its time |
| `confirm` | 0.70 | 0.50 | 0.35 | s | a soft target must stay out this long |
| `lookAhead` | 1.2 | 1.2 | 1.2 | s | a new view fits what the next 1.2 s need |
| `startAhead` | 2.0 | 2.0 | 2.0 | s | the first view looks this far ahead |
| `minChange` | 0.10 | 0.10 | 0.10 | views | smaller changes of centre are not made |
| `minHold` | 1.2 | 0.8 | 0.5 | s | shorter soft visits that stay visible are dropped |
| `clickBefore` / `clickAfter` | 0.4 / 0.6 | 0.4 / 0.6 | 0.4 / 0.6 | s (output) | click attention window |
| `typingTail`, `scrollTail` | 0.3 | 0.3 | 0.3 | s (source) | attention after the last key or wheel event |
| `maxAimedMove` | 2.5 | 2.5 | 2.5 | s (source) | longer moves are tracked, not aimed |
| `trackAhead` | 0.3 | 0.3 | 0.3 | s (output) | lead when tracking |
| `minPan` / `maxPan` | 0.5 / 1.5 | 0.5 / 1.5 | 0.5 / 1.5 | s | pan duration bounds |
| `maxSpeed` | 1.2 | 1.5 | 2.0 | views/s | normal peak speed |
| `maxAccel` | 4 | 5 | 6 | views/s² | normal peak acceleration |
| `hardSpeed` | 3 | 3 | 3 | views/s | never faster, even to meet a click |
| `maxLead` | 0.5 | 0.6 | 0.8 | s | longest anticipation |
| `minShown` | 0.3 | 0.3 | 0.3 | s | a shot is shown this long before the view anticipates the next |
| `settle` | 0.1 | 0.1 | 0.1 | s | after the previous shot's last firm event |
| `joinGap` | 0.6 | 0.6 | 0.6 | s | pans this close in the same direction join |
| `glideRamp` | 0.5 | 0.5 | 0.5 | s | ease in and out of a joined glide |

Plus `ZOOM_STRENGTH = 0.5` and `MAX_MAGNIFY = 3` (§5.12).

---

## 6. Camera, captions, text, shapes, images and cursor effects in a vertical frame

### 6.1 Camera

The band is a camera card (border, shadow, mirror, background blur and framing as today) drawn by
`webcamLayer.ts` at `sceneCameraBox` (`layout.ts:398`, now follow-aware, called with the drawn
project at `webcamLayer.ts:77`). `cameraSourceRect` (`layout.ts:421`) cover-crops the picture into
the band; a 32% band is about 1.6:1, so nearly the whole 16:9 picture shows. In a band the shape is
the card's rounded rectangle; the bubble keeps its shape setting. The export's person masks are
made exactly when `cameraShownAt` is true (`exporter.ts:412-416`, unchanged contract); a collapsed
band is not shown (`cameraBoxShown` needs `h ≥ 1`, `layout.ts:406`).

### 6.2 Screen card

While following, the device frame and the 3D tilt are not drawn: the compositor draws
`drawnForFrame(project, …)`, the project with framed zooms, a style without `frame` and no `tilt`
(memoised per project). Padding, corner radius, shadow and border apply to the slot. Padding 0 gives
a full-bleed video, and the band then touches the screen (gap 0).

### 6.3 Text area: captions, key presses, logo, lower thirds

`textArea(project, W, H, vw, vh, t): Rect | null` (`src/shared/render/safeZones.ts`):

1. Start from `COMMON_SAFE` in pixels when `reframe.appSafe` and the frame is tall:
   `{ 0.06W, 0.11H, 0.80W, 0.65H }` (§7). Otherwise from the whole frame.
2. While following with a band, move the edge on the band's side to the slot's edge (`max(y0,
   slot.y)` for a top band, `min(y1, slot.y + slot.h)` for a bottom band), so text never covers the
   camera. The push follows the layout's eased progress, so captions glide back as the band
   collapses (`screen-only` and `camera-only` give no push).
3. Neither applies: `null`, which means today's placement exactly.

At 1080×1920 the area is 864×1248 px from (65, 211); under a top band at padding 0.07 its top is
674 px.

| What | Rule with a text area (each an optional last parameter; `undefined` gives today's result) |
|---|---|
| Captions: `captionMetrics`, `captionLayout`, `placeChunk` (`src/shared/captions/layout.ts:290, 306, 407`) | Lines centred on the frame, `maxWidth = min(today's, 2·min(W/2 − area.x, area.x + area.w − W/2)) − 2·padX` (0.72W: 778 px at 1080 wide). `top`: `area.y + 0.02·u`; `middle`: the area's centre; `bottom`: `area.y + area.h − 0.02·u − height` (the area already keeps clear of the apps, so the 16:9 margins of `placeChunk` are not added). Font size unchanged (`size·min(w, h)`). `captionsLayer.ts`'s layout cache keys on the area. |
| Key presses: `drawKeystrokes` (`textOverlays.ts:65`), `captionBlockAt` (`captionsLayer.ts:209`) | `top` / `bottom` inside the area, still stacking against a caption at the same edge (both get the same area). When the area is too short for both (a large camera band with big keys and a big caption), the keys shrink about their centre into the room the caption leaves on their side, like the logo, so they never cover the camera or the caption. |
| Logo: `watermarkRect` (`src/shared/engine/watermark.ts:89`) | Corners inside the area, the margin applied within it; `center` unchanged. |
| Lower-third titles: `titleLayout` (`src/shared/render/titleCards.ts:219`) | The band's bottom at the area's bottom, its left at `max(TITLE_SAFE·u, area.x)`, width ≤ `area.w`. Centred and big cards are unchanged (they wrap to the frame). |

### 6.4 Text annotations and images

They are placed in the output frame by the user (`Annotation.x/y`, `ImageOverlay.x/y`,
`types.ts:433, 453`) and are never moved at render time. *Make a vertical version* (and *square*)
refits them once (`refitItems`, §4.8) into the new frame's text area at the item's start (the band
from the layout in effect there): text boxes measured with `annotationMetrics`
(`src/shared/render/overlays.ts:118`) and the renderer's `measure`, images with `overlayBox`
(`src/shared/render/imageOverlays.ts:19`) and their rotated bounds. Sizes are fractions of the
shorter side (1080 px in both 1080p 16:9 and 1080×1920), so text keeps its pixel size unless it must
shrink. Items added or moved later stay where they are put; the safe-zone overlay shows where that
is.

### 6.5 Shapes, blur, pixelate and spotlights

They are pinned to the recording (view space) and drawn through `fc.toOut`, which goes through the
virtual rectangle and the camera, inside the card clip (the slot), so they follow the view and are
cut at its edge. Privacy shapes cover every motion-blur sub-frame: `shutterCameras`
(`shapesLayer.ts:61-69`) uses `frameCamera` and, while following, no longer skips when there are no
zooms (pans are camera motion too). Privacy blur keeps its strength from the whole frame
(`sourceH`). The preview's shape and spotlight handles are clipped to the slot (`clip-path`).

### 6.6 Cursor and click effects

- The cursor's size comes from `rect.h·cam.scale/vh` (`cursorLayer.ts:77`). With the virtual
  rectangle that is the true magnification, so the cursor keeps its size relative to the interface
  (1.9× the pixels of a 1080p 16:9 export in a full-height padded 9:16 view).
- Ripples, rings and pulses use `k·cam.scale·0.8` (`cursorLayer.ts:161`). While following they are
  multiplied by `fc.fxGain = rect.h / styleContentRect(m·16/9, m, vw, vh, { padding, frame:
  undefined }).h` with `m = min(W, H)`: the magnification relative to the same recording in a 16:9
  frame with the same shorter side (1.904 at 1080×1920, padding 0.07, no band). `fxGain = 1` when
  not following.
- The highlight halo and the trail are sized from the cursor already. Hide when idle, loop home,
  the cursor tilt and click sounds are unchanged.

---

## 7. Safe-zone preview

`src/shared/render/safeZones.ts` holds one table: fractions of a 1080×1920 frame (`x`, `w` of the
width; `y`, `h` of the height), rounded to 0.01. **They are approximate, in line with common creator
guidance as of October 2026, not measurements made for this design.** The apps change their
layouts from time to time, and they differ between phones, languages, account types and paid
placements. Before release someone compares them with the three apps on a phone and records the date
in each platform's `checked` field; an update is one edit to the table (never stored in projects).

| Platform | Covered area (label) | x | y | w | h | Pixels at 1080×1920 |
|---|---|---|---|---|---|---|
| TikTok | Tabs and search | 0 | 0 | 1 | 0.08 | top 154 px |
| TikTok | Like, comment, share | 0.86 | 0.38 | 0.14 | 0.42 | right 151 px, y 730–1536 |
| TikTok | Name, caption and sound | 0 | 0.78 | 1 | 0.22 | bottom 422 px |
| Instagram Reels | Reels and camera | 0 | 0 | 1 | 0.11 | top 211 px |
| Instagram Reels | Like, comment, share | 0.87 | 0.45 | 0.13 | 0.37 | right 140 px, y 864–1574 |
| Instagram Reels | Name, caption and audio | 0 | 0.78 | 1 | 0.22 | bottom 422 px |
| YouTube Shorts | Search and menu | 0 | 0 | 1 | 0.08 | top 154 px |
| YouTube Shorts | Like, comment, share, remix | 0.86 | 0.40 | 0.14 | 0.44 | right 151 px, y 768–1613 |
| YouTube Shorts | Title, channel and subscribe | 0 | 0.79 | 1 | 0.21 | bottom 403 px |

**Common safe area** (`COMMON_SAFE`, used for placement, §6.3): `{ x: 0.06, y: 0.11, w: 0.80, h:
0.65 }`, 864×1248 px from (65, 211):

- top 0.11: the deepest top bar (Reels);
- bottom 0.76: the highest bottom zone (0.78) less a 0.02 margin, because captions in the apps grow
  upward with long text;
- right 0.86: the leftmost button column (TikTok, Shorts), taken over the full height for one simple
  rectangle;
- left 0.06: no buttons, but phones taller than 9:16 crop the sides to fill the screen.

A test checks that the area overlaps no box of any platform.

**Drawing**: `SafeZoneOverlay.tsx`, an absolutely positioned layer over the preview canvas's CSS
box in `PreviewStage`, `pointer-events: none`, `aria-hidden`. Each box is a `div` at `left = x·box.w`
(and so on), filled with `--scrim`, a 1 px dashed `--warning` outline and a 135° hatch, its label a
chip in `--text-1` 11 px on `--surface-overlay`. It is shown only for tall frames, only in the
editor's preview (not in the Export dialog's preview, not in thumbnails), and never on a canvas. The
compositor imports only `textArea` and `COMMON_SAFE`, which are placement rules, never the box table.

---

## 8. Preview/export parity and performance budget

### 8.1 Why preview and export match

1. **One drawing path.** Preview, scrubbing, thumbnails, the Export dialog's preview and export all
   call `drawFrame` (`compositor.ts:81`). It gets the layout from `sceneLayout`, the camera from
   `frameCamera` and the drawn project from `drawnForFrame`; they get the plan from `followPlanFor`.
   `PreviewStage` (`useStageView`, `PreviewStage.tsx:109-139`, and line 726), `shapesLayer` and the
   director use the same `frameCamera`; a contracts test asserts none of them calls `cameraAt`
   directly any more.
2. **A pure plan.** `followPlanFor(project, track)` is a function of the drawn project's clips,
   zooms, layouts, webcam visibility, `hasWebcam`, padding, aspect, size, zoom settings, shapes,
   spotlights and reframe settings, and of the drawn track's arrays. Its cache (a `WeakMap` on
   `track.samples`, four entries compared by those identities and values, like `cursorMoves`,
   `cursorPath.ts:83-96`) only avoids recomputing; a fresh build gives deep-equal segments (test 37).
3. **Canonical frame.** Planning uses `outputSize(aspect, vw, vh, 1080)` with the drawn project's
   own `width`/`height`, never the canvas size; the director already measures this way
   (`directorCorners.ts:224`).
4. **Stateless evaluation by source time.** `followCentre` keeps no state, so seeking backwards,
   scrubbing, J/K/L and export order give the same frame for the same `t`.
5. **The export's aspect override** (`prepare`, `exporter.ts:85-95`; `exportProject`,
   `exportPlan.ts:47`) gives a different project object, hence a different cache entry and the right
   plan for that frame. The Export dialog's preview uses the same override.
6. **Freeze frames, cuts and speed** go through the same `t` and `at` in preview (`displayTime`,
   `pictureTime`, `player.ts:407-424`) and export (`pictures[i]`, `exporter.ts:434`).
7. **Preview-only things never enter `drawFrame`**: the safe-zone overlay is DOM; the pick modes (a
   zoom's point or region, the crop tool) draw `withoutFollow` copies, as they already drop zooms
   (`unzoomedScene`, `player.ts:455-458`, also drops `reframe`).

### 8.2 Budget (reference: a 4-core 2020 laptop)

| Work | Budget | Notes |
|---|---|---|
| Plan build | ≤ 10 ms per 10 min of output, ≤ 60 ms per hour | Linear passes over a 30 Hz grid (108,000 samples per hour) with forward pointers; `fit` runs only at triggers; `cursorMoves` is cached already. A rebuild of `SmoothedTrack` (432,000 spring steps per hour) costs about the same and already happens on every smoothing step. |
| When it is rebuilt | Edits of clips, zooms, layouts, reframe, padding, aspect, shapes, spotlights, input edits or the camera's visibility | Text, captions, audio and colour edits hit the cache. |
| `followCentre` | ≤ 1 µs, no allocation besides the result | Binary search plus the glide formula. |
| Per exported frame | ≤ 14 evaluations | 1 frame, ≤ 10 motion-blur sub-frames (`EXPORT_BLUR_SAMPLES`, `exporter.ts:74`), 2 privacy shutter cameras, 1 layer. |
| Motion blur | Only while the view moves (typically 10–20% of a tutorial's frames), ≤ 4 sub-frames in the preview, ≤ 10 in export | Displacement measured at the slot's corners (`cameraDisplacement(a, b, rect, slot)`), not the larger virtual rectangle's, so pans get the sub-frames they need and no more. |
| Drawing | No extra full-frame pass | The screen's `drawImage` source rectangle is clipped to the slot (`viewSource(c, rect, clip)`), so it samples no more pixels than today. The static layer is cached (constant slot). A 1080×1920 frame has the pixel count of 1920×1080. |
| Export 1080×1920 | Within 5% of a 1080p 16:9 export of the same project | Logged by the e2e test, not asserted. |
| Memory | Transient 2 MB per hour while planning; the plan keeps < 1 MB | Attention as `Float32Array` x and y, `Uint8Array` kind, `Float64Array` event. |
| Preview | No React re-render per frame | `useSceneView` re-renders only while a layout change moves the slot, as `useSceneRect` does today (`sceneRect.ts:15-32`). |
| Safe zones | 0 canvas cost | DOM. |
| Duplicate | Links: instant. Copies: disk-bound, async in main, progress ≤ 10 per second | 1 GB in about 2–10 s on an SSD. |

A performance test (test 30) builds the plan for a synthetic hour (216,000 samples at 60 Hz, 600
clicks, 40 zooms, 20 cuts, 4 layout changes) under 400 ms on CI (a 6× margin).

If a profile shows hitches while dragging a zoom on a very long recording, the editor may keep the
previous plan during one drag gesture and rebuild on release; the export always rebuilds.

---

## 9. Files and exported signatures

### 9.0 Contracts commit (first; frozen afterwards)

Made by the integrator before the parts start, and changed later only with the agreement of every
part, recorded here:

- `src/shared/types.ts` (§4.1); `src/shared/engine/project.ts` (§4.3); `src/shared/engine/reframeData.ts`
  in full (small, §4.2).
- The **signatures** (bodies that throw `not implemented`) of every new export in §9.1–9.4,
  including the optional parameters of `zoom.ts`, `layout.ts`, the captions, watermark and title
  modules, and `src/shared/render/safeZones.ts` with its table and `COMMON_SAFE` (data, final).
- `src/shared/api/projects.ts` (§4.7) and the preload stub; `src/shared/editor/commands.ts` and
  `src/shared/editor/shortcuts.ts` (the six command ids, titles, categories, `R` and `G`).
- The `data-testid` list of §2 (as a comment block in `tests/e2e/vertical-video.e2e.cjs`).
- The **equivalence guard** (§11.2): `tests/verticalEquivalence.test.ts` with snapshots of today's
  outputs, and `tests/verticalContracts.test.ts`.

### 9.1 Part P1 · Engine (pure, `src/shared`)

Owns:

| File | Change |
|---|---|
| `src/shared/engine/layout.ts` | `ViewSize`, `FollowGeometry`, `SceneLayout.follow`, `SceneProject.reframe`; `export function baseView(slot: Rect, vw: number, vh: number, level: number): ViewSize`; `export function virtualRect(slot: Rect, base: ViewSize): Rect`; `export function intersectRect(a: Rect, b: Rect): Rect`; `export function followGeometry(layout: CameraLayout, project: SceneProject, outW: number, outH: number, vw: number, vh: number, corner?: Corner): { slot: Rect; camera: CameraBox; band: Rect \| null }`; `export function bandSide(project: SceneProject, outW: number, outH: number, vw: number, vh: number): 'top' \| 'bottom' \| null`; the follow branch of `sceneLayout` (`sceneContentRect`, `sceneCameraBox`, `cameraShownAt` follow through it). |
| `src/shared/engine/zoom.ts` | `PathLike`, `ViewBase`; optional `base` on `clampCamera(c, base?)`, `cameraFor(scale, fx, fy, base?)`, `blendCameras(a, b, w, base?)`, `cameraAt(zooms, t, focusTrack: PathLike \| null, style?, base?: ViewBase)`; `zoomTargetScale(z, floor?)` with `planFor` keyed on the floor; `export function typingSessionsOf(track: CursorTrack, settings: AutoZoomSettings): { t0: number; t1: number; place: { x: number; y: number } }[]` (wraps the private `typingSessions` as `autoZoomInput` calls it). |
| `src/shared/engine/reframe.ts` (new) | `FOLLOW`, `PACE: Record<ReframePace, PaceParams>`, `ZOOM_STRENGTH`, `MAX_MAGNIFY`; `export function glide(u: number, r: number): number`; `export function glideInverse(p: number, r: number): number`; `export function panDuration(d: number, pace?: PaceParams): number`; `FollowSegment`, `FollowShot`, `FollowPlan`; `export type FollowProject = Pick<Project, 'clips' \| 'zooms' \| 'layouts' \| 'webcam' \| 'hasWebcam' \| 'style' \| 'reframe' \| 'width' \| 'height' \| 'zoomSettings' \| 'duration' \| 'shapes' \| 'spotlights'>`; `export interface FollowLimits { base: ViewSize; level: number; mag: number; fit: number; cap: number }`; `export function followLimits(project: FollowProject): FollowLimits \| null`; `export function framedZooms(zooms: ZoomSegment[], limits: FollowLimits): ZoomSegment[]`; `export function followAttention(project: FollowProject, track: CursorTrack): { o: Float64Array; x: Float32Array; y: Float32Array; kind: Uint8Array; event: Float64Array }`; `export function planFollow(project: FollowProject, track: CursorTrack): FollowPlan` (uncached); `export function followPlanFor(project: FollowProject, track: CursorTrack): FollowPlan` (cached); `export function followCentre(plan: FollowPlan, t: number, at?: number): { x: number; y: number }`. |
| `src/shared/engine/frameView.ts` (new) | `export interface ViewScene { project: Project; cursor: CursorTrack; focusPath: PathLike }`; `export function drawnForFrame(project: Project, w: number, h: number, vw: number, vh: number): Project`; `export function frameCamera(scene: ViewScene, layout: SceneLayout, t: number, at?: number): Camera`; `export function frameView(scene: ViewScene, w: number, h: number, vw: number, vh: number, t: number, at?: number): { project: Project; layout: SceneLayout; cam: Camera }`; `export function followGain(layout: SceneLayout, w: number, h: number, vw: number, vh: number, padding: number): number`; `export function narrowBoxZoom(zoom: number, boxAspect: number): number`; `export function viewMagnification(project: Project, outW: number, outH: number, vw: number, vh: number): { rest: number; zoomed: number } \| null`. |
| `src/shared/engine/crop.ts` | `cropProject` maps `reframe.rest`; `CroppableProject` gains `'reframe'`. |
| `src/shared/editor/directorCorners.ts` | `computeCosts` measures through `frameView` when following (§5.14); cache key. |
| `src/shared/editor/cameraDirector.ts` | No corner moves with a band; the reason sentence. |
| Tests | `tests/reframeData.test.ts`, `tests/followLayout.test.ts`, `tests/zoomBase.test.ts`, `tests/framedZooms.test.ts`, `tests/reframePlan.test.ts`, `tests/frameView.test.ts`, `tests/directorFollow.test.ts`. |

May touch additively: none beyond its own files (the contracts files are frozen).

### 9.2 Part P2 · Render and placement (renderer layers, shared placement)

Owns:

| File | Change |
|---|---|
| `src/renderer/src/render/compositor.ts` | `frameView` for project, layout and camera; card `intersectRect(slot, cardRect(rect, cam))` while following; `layout.moving` instead of `layoutMoving`; `export function viewSource(c: Camera, rect: Rect, clip?: Rect)`; `motionSamples` through `frameCamera(scene, layout, st, t)` with no zoom-count shortcut while following and displacement at the slot's corners; the new `FrameContext` fields. |
| `src/renderer/src/render/frameContext.ts` | `layout: SceneLayout`, `following: boolean`, `textArea: Rect \| null`, `fxGain: number`. |
| `src/renderer/src/render/shapesLayer.ts` | `shutterCameras` via `frameCamera` (§6.5). |
| `src/renderer/src/render/cursorLayer.ts` | `fxGain` on click effects. |
| `src/renderer/src/render/webcamLayer.ts` | `narrowBoxZoom` while following. |
| `src/renderer/src/render/captionsLayer.ts`, `src/shared/captions/layout.ts` | `captionMetrics(settings, w, h, area?)`, `captionLayout(seg, settings, w, h, measure, area?)`, `placeChunk(layout, chunk, position, w, h, area?)`, `captionBlockAt(ctx, project, t, w, h, area?)`; cache key. |
| `src/renderer/src/render/textOverlays.ts` | `drawKeystrokes(ctx, w, h, t, project, cursor, area?)`. |
| `src/renderer/src/render/watermarkLayer.ts`, `src/shared/engine/watermark.ts` | `watermarkRect(w, h, wm, aspect, area?)`. |
| `src/renderer/src/render/titleCardLayer.ts`, `src/shared/render/titleCards.ts` | `titleLayout(card, w, h, measure, area?)`. |
| `src/shared/render/overlays.ts` | `cameraDisplacement(a, b, rect, clip?)`. |
| `src/shared/render/safeZones.ts` (table from 9.0) | `export type SafePlatform = 'tiktok' \| 'reels' \| 'shorts'`; `export type SafeChoice = SafePlatform \| 'all'`; `export interface SafeBox { x: number; y: number; w: number; h: number; label: string }`; `export const SAFE_ZONES: Readonly<Record<SafePlatform, { name: string; checked: string; boxes: readonly SafeBox[] }>>`; `export const COMMON_SAFE: Readonly<NormRect>`; `export function zonesFor(choice: SafeChoice): SafeBox[]`; `export function textArea(project: Project, w: number, h: number, vw: number, vh: number, t: number): Rect \| null`; `export function keepInArea(box: Rect, area: Rect, minScale?: number): { dx: number; dy: number; scale: number }`. |
| `src/renderer/src/editor/player.ts` | `unzoomedScene` also drops `reframe`. |
| Tests | `tests/compositorFollow.test.ts`, `tests/safeZones.test.ts`, `tests/textArea.test.ts`. |

May touch additively: none. Against P1's stubs it tests the compositor with `vi.mock` of
`frameView.ts` returning a hand-made layout and a constant camera.

### 9.3 Part P3 · Editor UI and the safe-zone preview

Owns:

| File | Change |
|---|---|
| `src/renderer/src/editor/panels/FollowSection.tsx` (new) | The section of §2.5. `export function FollowSection(props: { project: Project; vw: number; vh: number; onMakeVertical(): void }): JSX.Element`. |
| `src/renderer/src/editor/panels/StylePanel.tsx` | Mounts `FollowSection` under Frame; the device frame hint. |
| `src/renderer/src/editor/panels/ZoomPanel.tsx`, `CameraPanel.tsx`, `EffectsPanel.tsx`, `DirectorSection.tsx` | The 1× chip and the effective-level line; the band hint and disabled corners; the tilt hint; the director passes the scene for `frameView`. |
| `src/renderer/src/editor/PreviewStage.tsx` | `frameCamera` in `useStageView` and at line 726; `withoutFollow` geometry while picking or cropping; drag the picture (§2.6); `clip-path` on shape and spotlight editors; mounts `SafeZoneOverlay`. |
| `src/renderer/src/editor/SafeZoneOverlay.tsx`, `safeZones.css` (new) | `export function SafeZoneOverlay(props: { choice: SafeChoice; box: { w: number; h: number } }): JSX.Element`. |
| `src/renderer/src/editor/safeZonePref.ts` (new) | `export function safeZoneChoice(): SafeChoice \| 'off'`; `export function setSafeZoneChoice(v: SafeChoice \| 'off'): void`; `export function useSafeZoneChoice(): SafeChoice \| 'off'` (`localStorage` `editor-safe-zones`, like `waveformPref.ts`). |
| `src/renderer/src/editor/Transport.tsx` | The safe-zone toggle and platform select (tall frames). |
| `src/renderer/src/editor/sceneRect.ts` | `export function useSceneView(project: Project, w: number, h: number, vw: number, vh: number): SceneLayout`; `useSceneRect` wraps it. |
| `src/renderer/src/editor/ExportDialog.tsx` | `export-follow-note`, `export-follow-on`, `export-magnify`, no per-size upscale tag while following. |
| `src/renderer/src/views/Editor.tsx` | `withoutFollow` while cropping; the six commands and `R`/`G`; the notice after a copy; mounts P4's `CopyMenu` in the title bar; new prop `onOpenProject(id: string, notice?: string): void`; opens the Style tab after a vertical copy. |
| `src/renderer/src/editor/editor.css` | Styles of the section and the drag cursor. |
| `src/shared/editor/followEdit.ts` (new) | `export function holdViewAt(project: Project, t: number, centre: { x: number; y: number }, crop: NormRect \| null): { project: Project; zoomId: string } \| { project: null; reason: 'no-room' }` (inserts a 1× fixed zoom or fixes the zoom at `t`); `export function dragView(project: Project, t: number, delta: { x: number; y: number }, crop: NormRect \| null, noData: boolean): Project`; `export function followStatus(project: Project, cursorValid: boolean, vw: number, vh: number): 'off' \| 'following' \| 'no-input' \| 'unavailable'`. |
| Tests | `tests/followEdit.test.ts`, `tests/followSection.test.ts`, `tests/safeZonePref.test.ts`. |

May touch additively: `commands.ts` and `shortcuts.ts` only to fix wording found in review
(ids and keys are frozen).

### 9.4 Part P4 · Duplicate, the end-to-end test and the docs

Owns:

| File | Change |
|---|---|
| `src/shared/editor/duplicate.ts` (new) | `CopyKind`, `copyName`, `MeasureText`, `canCopyAs`, `projectCopy`, `refitItems` (§4.8). |
| `src/main/projectCopy.ts` (new) | `export const LINKED_MEDIA = ['screen.mp4', 'webcam.mp4', 'mic.m4a', 'system.m4a'] as const`; `export const COPYING_MARK = '.copying'`; `export function copiedFile(name: string): 'link' \| 'copy' \| null`; `export function linkAllowed(root: string, env?: NodeJS.ProcessEnv): boolean`; `export async function duplicateProject(sourceId: string, raw: unknown, opts?: { signal?: AbortSignal; onProgress?: (p: DuplicateProgress) => void; now?: Date }): Promise<DuplicateResult>`; `export async function removeStaleCopies(now?: number): Promise<number>`. |
| `src/main/projectsIpc.ts` | `projects:duplicate` and `projects:duplicateCancel` handlers with the sender check (§4.7), progress events to the sender. |
| `src/preload/projects.ts` | `duplicateProject`, `onDuplicateProgress`, `cancelDuplicate`. |
| `src/renderer/src/editor/CopyMenu.tsx`, `copy.css` (new) | `export function CopyMenu(props: { project: Project; vw: number; vh: number; run(kind: CopyKind): void }): JSX.Element` (the title-bar menu) and `export function CopyProgress(props: { kind: CopyKind; name: string; progress: DuplicateProgress \| null; onCancel(): void }): JSX.Element`. |
| `src/renderer/src/editor/duplicateFlow.ts` (new) | `export async function runDuplicate(kind: CopyKind, deps: { project: Project; flush(): Promise<boolean>; confirm(msg: string): boolean; onProgress(p: DuplicateProgress \| null): void; signal: AbortSignal }): Promise<{ id: string; notice: string } \| null>`. |
| `src/renderer/src/App.tsx` | `Route` gains `notice?: string`; `<Editor key={route.projectId} … onOpenProject={(id, notice) => setRoute({ view: 'editor', projectId: id, notice })} notice={route.notice} />` (the key change remounts the editor). |
| `tests/e2e/vertical-video.e2e.cjs` (new) | §11.3. |
| `docs/FEATURES.md`, `docs/ROADMAP.md`, `docs/IMPLEMENTATION.md` | At integration. |
| Tests | `tests/duplicate.test.ts`, `tests/projectCopy.test.ts`, `tests/copyMenu.test.ts`. |

May touch additively: none (P3 mounts `CopyMenu` through the frozen props above).

**Not touched by any part**: the recording side (listed at the top), `Home.tsx`,
`src/main/projects.ts`, `src/main/security.ts`, `src/main/mediaProtocol.ts`, the CSP, the window
options, `exportPresets.ts` (the presets exist), `exportPlan.ts` (sizes are unchanged),
`exporter.ts` (it already passes the scene and picture times).

**Integration**: merge P1 and P2, then P4, then P3; run both typechecks, all vitest, `npm run
build`, then under `xvfb-run`: `vertical-video`, `render`, `crop`, `camera`, `camera-director`,
`export`, `export-pack`, `freeze`, `multi-select`, `commands`, `smart-zoom`, `titles`, `captions`.

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | The constants feel too calm or too busy for some content. | One table (§5.18) with three presets, each constant pinned by a test; *Hold the view here* and *Ignore click* for single moments. |
| 2 | Whole-screen traverses are fast (up to 3 views/s). | Motion blur (on by default) smooths them; hurrying is used only to meet a click. *Pull back while travelling* is under Later. |
| 3 | Upscaling: a 1080p recording in a 9:16 bubble is 1.64–1.78× larger, so text is softer. | Gentle zooms with a 3× cap, the band (1.08–1.21×), *How close* defaulting to 1×, and the Export dialog's line. |
| 4 | Plan rebuilds on long recordings while dragging a zoom. | 60 ms per hour with a CI guard; the drag-gesture fallback of §8.2. |
| 5 | The apps move their buttons. | A preview-only overlay, a dated table, a conservative common area with a margin, a hint to leave room. Wrong numbers never change exported pixels except through the placement rule, which can be turned off. |
| 6 | Hard links: a future feature that rewrites media in place would change both projects; OneDrive and FAT cannot link safely. | The contract comment and test 64; links refused under OneDrive roots; copy fallback with a free-space check, progress and Cancel; `DuplicateResult.linked` reported. |
| 7 | Old projects change through shared code (`cameraAt`, `sceneLayout`, `viewSource`, captions, watermark, titles). | Only optional parameters; the equivalence guard written first (§11.2); the compositor call-log test for `mode: 'fit'` and for 16:9 with `'follow'`; the e2e export of an old 9:16 project. |
| 8 | A layer or a new caller forgets the follow camera (preview and export disagree). | `frameCamera` is the single entry; the contracts test greps the compositor, `shapesLayer`, `PreviewStage` and `directorCorners` for direct `cameraAt` calls. |
| 9 | Tilt and device frames silently off while following. | Hints in three panels (§2.10); data kept for 16:9. |
| 10 | Captions move up when *Keep text clear* is on. | Visible in the preview; one toggle; off in every existing project until the user turns following or the toggle on, or makes a copy. |
| 11 | Region zooms frame differently in a tall view (pulled back when wider than the view). | The Zoom panel's effective-level line; it is the honest result. |
| 12 | Determinism across the canonical and the real frame. | The plan uses the canonical frame and the clamp the real one; test 37 checks 1080p, 720p and a 405×720 preview give the same plan. |
| 13 | The recording owner's boundary. | No recording-owned file changes; Duplicate has no Home entry (Later). |
| 14 | A crash during a copy leaves a folder. | `.copying` marker, never listed meanwhile, cleaned at the next copy. |
| 15 | Text refit lands text on content. | It is data: the user moves it with the safe zones shown. |
| 16 | E2E pixels under Xvfb. | Saturated stripes and class counts by nearest colour, never exact values. |

---

## 11. Test plan

### 11.1 Unit tests (vitest). Each fails without the code of its rule.

**`tests/reframeData.test.ts`** (P1)

1. `readReframe`: `undefined`, `null`, arrays and strings give `undefined`; `mode: 'x'` → `'fit'`;
   `level: 9` → 2; `band: 0` → 0.2; `pace: 'fast'` → `'balanced'`; `appSafe: 'yes'` → `false`;
   `rest: { x: 2, y: NaN }` dropped; `rest: { x: 2, y: 0.5 }` → `{ 1, 0.5 }`; idempotent.
   `readCopyOf`: a bad id or a non-string name → `undefined`; a 300-character name cut to 200.
2. `migrateProject(OLD)` for fixtures from before this feature (16:9, 9:16 and 1:1) has no
   `reframe` or `copyOf` key, the same `Object.keys`, and byte-equal `JSON.stringify` to the
   snapshot committed in 9.0.
3. `reframeOn`: none in 1080×1920 → `DEFAULT_REFRAME`; in 1080×1080 → camera `'bubble'`, `appSafe`
   false; existing settings keep everything but `mode`. `followApplies`: 1080×1920 of 1920×1080
   true; 1920×1080 of 1920×1080 false; 1080×1080 of 1440×1080 true; 1080×1080 of 1200×1080 false;
   `mode: 'fit'` false. `withoutFollow` returns the same object without `reframe`.

**`tests/followLayout.test.ts`** (P1)

4. Top band, 1080×1920, padding 0.07, band 0.32: camera `{ 75.6, 75.6, 928.8, 566.0 }`, slot
   `{ 75.6, 674.0, 928.8, 1170.4 }` (gap 32.4); bottom band mirrored.
5. Padding 0: gap 0, the band touching the slot.
6. `screen-only`: slot = area; camera height 0, opacity 0, `cameraBoxShown` false.
7. `camera-only`: camera = area; slot = the band slot scaled 0.5 about its centre, same aspect, so
   the same `base`.
8. Bubble, and any square frame with `camera: 'top'`: slot = area; camera = `webcamRect`.
9. `baseView` gives the §5.2 table; `toOutput(virtualRect, { 1, cx, cy })(cx, cy)` is the slot's
   centre and the slot's edges are at `cx ± base.w/2`.
10. No stretch: output px per recorded px are equal on both axes (1e-9) for every row of §5.2.
11. Band to `screen-only`: slot and base are continuous over the 0.4 s ramp (sampled at 1 ms, every
    step under 1% of the slot), and `moving` is true meanwhile.
12. Non-following equivalence: for the 12 fixture projects of 9.0 (16:9, 9:16 and 1:1 fitted;
    layouts with corners; side-by-side; crop; padding and device frames), `sceneLayout` at 500
    seeded times equals the snapshot, has no `follow`, and its `moving` equals `layoutMoving`.

**`tests/zoomBase.test.ts`** (P1)

13. Without `base`, `cameraAt`, `clampCamera`, `blendCameras` and `cameraFor` equal the snapshot of
    today's values for 10,000 seeded cameras and zoom lists (bit for bit), and the existing zoom
    suites pass unchanged.
14. With a base and no zooms: `cameraAt` equals `clampCamera({ 1, cx, cy }, base)`; a centre at 0.02
    clamps to `base.w/2`. With `{ w: 0.452, h: 1 }`: range [0.226, 0.774] at scale 1, [0.113, 0.887]
    × [0.25, 0.75] at 2.
15. A cursor zoom with an anchor aims at the anchor while `anchorWeight` is 1 and at the focus track
    (the plan stub) after the release.
16. A pull-back aims at the base centre, not 0.5; `zoomTargetScale(z, 0.3)` keeps 0.3, without a
    floor it gives 0.5.
17. `blendCameras` with a unit base equals today's formula; with a base its edges move linearly in
    view units.

**`tests/framedZooms.test.ts`** (P1)

18. `followLimits` for the §5.12 table rows (mag, cap, fit ±0.005); level 2 on a 720p bubble is
    limited to 1.22.
19. `framedZooms`: 2 → 1.5, 1.8 → 1.4, 3 → 1.83 (capped); 0.5 → fit, 0.75 → 0.648; region
    `{ 0.2, 0.3, 0.4, 0.2 }` in a base 0.452 × 1 → 1.13; region 0.5 wide in 0.3164 → 0.633; the same
    output array for the same inputs; ids, times and anchors kept.

**`tests/reframePlan.test.ts`** (P1; fixtures as literals)

20. `glide`: continuity at `r` and `1 − r`, monotone, the values of §5.10, peak velocity `1/(1 − r)`
    and acceleration `1.5/(r(1 − r))` numerically (1e-3); `glideInverse(glide(u, r), r) = u` (1e-9).
21. `panDuration` gives the §5.9 table (1e-3).
22. A still cursor: one hold, centre = the cursor, clamped.
23. Rest A, flight to B, rest: exactly one pan, starting at the flight's start (output time), from
    A' to B', lasting `panDuration(d)`.
24. Dead zone: a destination 0.29 views away gives no pan; 0.31 gives one (Balanced).
25. Confirmation: a far soft visit (1.2 views) out and back within 0.45 s gives no pan; one of 0.6 s
    gives two (Balanced); Calm ignores 0.65 s, Lively follows 0.4 s.
26. Short visible visit (0.5 s, 0.4 views away) dropped; short far visit with a click kept.
27. The worked example (§5.17): pan [1.604, 3.104] (1e-3); the click 0.35 views from the centre at
    2.6 s; peak 2.32 views/s.
28. Hurry and late: two clicks 0.5 s and 1.74 views apart (`base.w = 0.3164`): the pan starts at the
    first click + 0.1 s, is hurried to `D = 2d/hardSpeed = 1.159 s` (peak exactly 3.0 views/s), and
    the shot is marked `late`.
29. Typing holds: the cursor wandering ±0.3 during a typing session does not move the view.
30. Performance: the synthetic hour of §8.2 under 400 ms; 1e6 `followCentre` calls under 300 ms.
31. Zoom aims: a fixed-point zoom at P from 5 s: the plan is at P by 5 s and holds through it; an
    auto zoom's anchor is reached by `z.start`. Inside a framed 1.4× zoom a 0.25-view step of the
    unzoomed view (0.35 zoomed views) moves the view; outside the zoom it does not.
32. Shapes: an arrow shown 3–6 s while the cursor wanders keeps its head in view; a blur shape does
    not move the view.
33. Off-frame: samples at x = 1.7 for 10 s give a hold; the return to x = 0.3 gives one pan. Crop: a
    rest outside the crop (view space x = −0.2) gives no target.
34. No data (`valid: false`): one hold at the rest point (view space, after the crop) or the centre;
    a fixed-point zoom gives two pans.
35. Cuts: after a cut a target 0.6 views away changes the view at the cut (no segment crosses it);
    0.4 views away changes nothing. Speed: on a 4× clip the pan for the same move lasts the same
    output seconds (1e-9) and covers 4× the source time. `followCentre(plan, clipEnd + 0.05, at =
    clipEnd − 0.01)` equals the value at the clip's end.
36. Joining: a slow drag gives one `glide` segment with the cursor always in view; with a click the
    glide would leave beyond `inView`, there is no join.
37. Determinism: `planFollow` twice is deep-equal; 10,000 random-order evaluations equal sequential
    ones; the same plan for 1080p, 720p and a 405×720 preview of the same aspect.
38. Robustness: shuffled samples give the plan of the sorted ones; NaN samples, clicks, scrolls and
    shapes give no throw and the plan without them.
39. Layout change: band to `screen-only` at 8 s: the clamped centre at 60 fps never jumps more than
    `maxSpeed/60` views beyond the planned motion.
40. Smoothness fuzz (seeded, 10 minutes of random walk with jumps and clicks, each pace): every
    segment's peak speed ≤ 3 views/s; per-frame acceleration and jerk at 120 Hz below the glide's
    bounds for its `d` and `D`; no segment reverses direction; at most 30 pans per minute; holds
    between unjoined pans ≥ 0; Calm makes no more pans than Balanced, Balanced no more than Lively.

**`tests/frameView.test.ts`** (P1)

41. Not following: `frameView` equals `{ sceneLayout, cameraAt(…) }` at 500 seeded times for the 12
    fixtures, and `drawnForFrame` returns the same project object.
42. Following, no zooms: `cam.cx = clamp(followCentre(…))`, scale 1; `drawnForFrame` drops `frame`
    and `tilt` and keeps the stored project unchanged.
43. A zoom ramp from the follow rest changes the centre by less than 1% of a view when the zoom aims
    where the view is (a pure change of scale).
44. `narrowBoxZoom(1.6, 0.5625) = 1`, `narrowBoxZoom(1.6, 1.75) = 1.6`, `narrowBoxZoom(1.2, 1) = 1.2`.
45. `followGain` = 1.904 for 1080×1920, padding 0.07, no band; 1 when not following.
    `viewMagnification` gives 1.64 / 2.29 (rest / with a 1.8× auto zoom) for a 1080p padded bubble.

**`tests/directorFollow.test.ts`** (P1)

46. In a 9:16 bubble project, a cursor at x 0.85 of the recording but centred in the view costs the
    corners as drawn (centre), not the 16:9 right side; a band project plans no corner change and
    keeps intro, outro and hidden parts.

**`tests/compositorFollow.test.ts`** (P2, the call-recording canvas of `tests/compositorCrop.test.ts`)

47. Following 9:16: the screen `drawImage` lands inside the slot with a source width of `base.w·vw`
    (±1 px) around the planned centre; the clip path is the slot; no tilt or device-frame calls.
    `reframe: { mode: 'fit' }` gives exactly the call log of no `reframe`; a 16:9 frame with `mode:
    'follow'` gives exactly the call log of no `reframe`; both equal the 9.0 snapshot.
48. Following without zooms but during a pan: motion blur draws several sub-frames, counted from the
    slot's corners; not following and without zooms: one.
49. Pull-back 0.5 while following: the card is the intersection, smaller than the slot, background
    above and below.
50. A held freeze frame (`pictures[i]` constant): the same screen source rectangle for every held
    frame. A frame whose shutter crosses a cut draws only its own clip's views.

**`tests/safeZones.test.ts`** (P2)

51. Every box inside 0..1; `COMMON_SAFE` equals `{ 0.06, 0.11, 0.80, 0.65 }` and overlaps no box of
    any platform; `zonesFor('all')` has 9 boxes, each platform 3; every platform has a `checked` date.

**`tests/textArea.test.ts`** (P2)

52. `textArea` is null without `appSafe` and without a band; the common area for a tall frame with
    `appSafe`; pushed to the slot under a top band (674 px at padding 0.07); the push follows the
    layout's eased progress.
53. Captions `bottom` end at `0.76·H − 0.02·u` (±1 px) with lines ≤ 0.72·W; key presses
    at the area's bottom stay above the caption; logo corners inside the area; the lower-third band
    inside the area. Without an area all four equal the 9.0 snapshots for 1920×1080 and 1080×1920.

**`tests/followEdit.test.ts`** (P3)

54. `holdViewAt` outside a zoom inserts a 1× fixed zoom at the given centre (full-frame coordinates
    through `fromCrop`), 3 s, fitted into the gap, at least 1 s; with no room it reports `no-room`;
    inside a cursor zoom it fixes that zoom's focus at the centre and keeps its times; a region zoom
    keeps its rectangle.
55. `dragView` moves the zoom's point by the drag in recording units (content follows the pointer);
    without cursor data and without a zoom it moves `reframe.rest`; each is one `store.update`.

**`tests/followSection.test.ts`** (P3)

56. `followStatus` for each state; the section's sentences for each state (§2.5); the section
    hidden for a frame that cannot follow and the callout shown when 9:16 could; the camera chips
    hidden for square frames and without a shown camera; the toggle writes `reframe` in one
    `store.update`; `holdView` (`R`) and `toggleSafeZones` (`G`) present without conflicts (the
    existing shortcut tests run over them).

**`tests/safeZonePref.test.ts`** (P3)

57. Absent or invalid stored values read as `'off'`; a blocked `localStorage` keeps the value for the
    session (the `waveformPref.ts` pattern).

**`tests/duplicate.test.ts`** (P4, pure)

58. `copyName` for each kind, a blank name and a 150-character name.
59. `projectCopy('vertical')`: aspect 9:16, the `reframe` defaults with camera top and `appSafe`
    true, existing `rest` and `pace` kept; `'square'`: 1:1, bubble, `appSafe` false; `'copy'`: only
    the name; every other field deep-equal; the frozen input not mutated.
60. `refitItems`: a text at y 0.9 moves into the area; a too-wide text shrinks to fit, not below 60%,
    then breaks at the space nearest its middle; an image is shifted with its rotated bounds; items
    already inside are the same objects. `canCopyAs` gives each reason of §2.2.

**`tests/projectCopy.test.ts`** (P4, main; electron mocked as in `tests/appSettings.test.ts`, temporary folders)

61. Media are linked (same `ino`); `cursor.json`, assets, `script.txt` and `.cache/speech.json` are
    copied (different `ino`, same bytes, same `mtime` to the millisecond); `transcript-parts`, raw
    files, `recording.json`, `desktop.ini`, symlinks and other folders are not.
62. `project.json` is written last (a spy on the order) with the new id, `createdAt` = now,
    `copyOf` from disk (the renderer's ignored), the name trimmed; the marker exists during the copy
    and is gone after; the source folder's file hashes and times are unchanged.
63. `fs.link` throwing `EXDEV`, or `linkAllowed` false under an `OneDrive` env root, copies with
    progress events and `linked: false`; `statfs` reporting too little space rejects with the sizes
    and leaves no folder; an abort mid-copy removes the folder; a second concurrent call rejects.
    `removeStaleCopies` removes only marked folders older than an hour without `project.json` or raw
    files.
64. A bad `sourceId` (`../x`, `..\\x`), a `copy.id` different from `sourceId` and a non-project
    `copy` are rejected and create no folder; the handler throws "Not allowed" for another window and
    a non-app page; no module in `src/main` outside `recording/` and `projectCopy.ts` writes a
    `LINKED_MEDIA` name (source scan).

**`tests/copyMenu.test.ts`** (P4)

65. The menu's items and disabled reasons; `Up`/`Down`, `Enter`, `Esc` returning focus; the progress
    modal appears only after 0.5 s and Cancel aborts.

**`tests/verticalContracts.test.ts`** (9.0)

66. Every export named in §9 exists with its arity; `COMMAND_IDS` includes the six commands with
    `R` and `G`; the compositor, `shapesLayer`, `PreviewStage` and `directorCorners` no longer call
    `cameraAt` directly.

### 11.2 Equivalence guard for old projects

Tests 2, 12, 13, 41, 47 and 53 are the "unchanged" guard. Their fixtures and snapshots are written
in the contracts commit against today's code (`aeca5c5`), before any shared file is touched, and must
pass unchanged after every part merges.

### 11.3 End to end: `tests/e2e/vertical-video.e2e.cjs`

**Fixtures** (cached like `crop.e2e.cjs` `taskbarVideo`):

- `stripesVideo()`: 1280×720, 8 s, 60 fps, lossless, eight vertical stripes of 160 px in saturated
  colours (#ff0000, #ff8000, #ffff00, #00ff00, #00ffff, #0000ff, #8000ff, #ff00ff); none is white.
- A solid green camera video (`render-fixtures.cjs` `solidVideo`, `00c000`).
- A cursor track: a sample every 1/60 s at (0.0625, 0.5) (stripe 0) until 3.0 s, linear to
  (0.8125, 0.5) (stripe 6) by 3.3 s, held; a left click at 5.0 s at (0.8125, 0.5); `valid: true`.
- Projects seeded with `seedProject` (padding 0, black background, cursor not shown, no click
  effect, motion blur 0, no zooms), then `screen.mp4` (and `webcam.mp4`) **replaced by real copies**
  of the fixtures, because `seedProject` symlinks them (`render-fixtures.cjs:213`) and Duplicate
  copies regular files only: **Stripes** (aspect auto), **Old** (aspect 9:16, no `reframe`: a
  project from before this feature), **Cam** (aspect auto, the green camera, a transcript with one
  caption 1–4 s "Hello vertical world", captions shown at the bottom), **NoData** (aspect auto,
  `valid: false`).

Colours are classified by the nearest fixture colour; "shows stripe n" means at least 80% of the
sampled pixels in that column or row are that class.

**Steps and assertions**

1. **Old project unchanged.** Open *Old*: `project.json` bytes are unchanged after closing without
   edits. The Vertical framing section shows the toggle off with the "shrunk to fit" hint. Export
   720p MP4: the frame at 6.0 s shows all eight stripes across the full width, the recording
   exactly in the fitted rectangle (720 × 405 at y 437.5, ±2 px, from `contentRect`), black above and
   below.
2. **Turn following on.** In *Old*, focus `follow-toggle` with `Tab` and press `Space`: the preview's
   centre column shows stripe 1 at 1.5 s and stripe 6 at 6.0 s; `project.json` has `reframe.mode
   'follow'`. `Ctrl+Z` gives the fitted view and no `reframe` key; `Ctrl+Y` the followed view.
3. **Parity and smoothness.** Export *Old* (following) 720×1280 at 30 fps. The frames at 1.5 s and
   6.0 s show the same centre-column stripe as the preview. Over frames 60–150 the view's left edge
   (from the visible stripe boundaries) starts moving no earlier than 2.9 s and has arrived by 4.6 s;
   it is monotonic; per-frame displacement ≤ 3 views/s × 1/30 × 720 px × 1.15 (the planned peak is
   2.76 views/s, 66 px); the change of displacement between frames ≤ 10 px (planned 4.4 px plus
   measurement).
4. **Safe zones are preview only.** Press `G`: `safe-zones` is visible with `data-platform="all"`
   and 9 boxes; choose *TikTok*: 3 boxes; the legend text is shown. An export frame at 6.0 s with the
   zones on is class-equal to step 3's at every sampled pixel, including (0.93W, 0.6H) under the
   button column and the top 8%. Press `G` again; after reopening the editor the last state returns.
5. **Make a vertical version.** Open *Cam*; read every file's bytes and inode in its folder. Open
   `copy-menu`, press `Down`, `Enter` on *Make a vertical version*: a new folder appears whose
   `project.json` has `aspectRatio: '9:16'`, `reframe.mode: 'follow'`, `reframe.camera: 'top'`,
   `appSafe: true`, name "Cam (vertical)", `copyOf.id` = *Cam*'s id; `screen.mp4` and `webcam.mp4`
   have the same inode as the original's (or equal bytes when the file system cannot link);
   `cursor.json` is byte-identical; *Cam*'s folder is byte-identical to before and has no new
   file. The title field reads "Cam (vertical)" and the notice contains "Your original “Cam” is
   unchanged". **Open original** opens *Cam*; going back to the copy works from the library.
6. **Camera band and captions.** Export the copy at 720×1280: in the frame at 2.0 s, rows from 0 to
   0.30H are green (the band is 0.32 of the height at padding 0), no stripe colour appears above
   0.31H, and rows from 0.34H down show stripes; pixels with R, G and B above 235 (the caption) lie
   only between 0.32H and 0.76H and between 0.06W and 0.86W.
7. **Steering.** In the copy, paused at 6.0 s, press `R`: one zoom of level 1 with a fixed point
   within 0.01 of the view's centre (0.767: the band view at padding 0 is 0.4653 wide, so 0.8125 is
   clamped to 0.767) and a pixel-equal preview. Drag the picture right by 20% of the card's width:
   the zoom's `focus.x` is 0.767 − 0.2 × 0.4653 = 0.674 ± 0.01 and the centre column shows stripe 5.
   `Ctrl+Z` once: the point is back; `Ctrl+Z` again: no zoom.
8. **No cursor data.** Open *NoData*, run *Make a vertical version* from the palette: `follow-status`
   has `data-state="no-input"`; the centre column shows stripe 3 or 4 at 1.5 s and 6.0 s. Focus
   `follow-rest-x` and press `Home`: the card's left edge shows stripe 0 and its centre column stripe
   1; `reframe.rest.x` is saved in one undo step; an export frame at 1.5 s agrees.
9. **Duplicate.** In *Stripes*, `Ctrl+K`, type "Duplicate", `Enter`: a new folder whose
   `project.json` equals the original's except `id`, `name` "Stripes (copy)", `createdAt` and
   `copyOf`; the editor shows it with the notice.
10. **Keyboard.** The copy menu opens with `Enter` on `copy-menu`, moves with `Up`/`Down`, and `Esc`
    closes it with the focus back on the button; `Tab` reaches `follow-toggle` in the Style panel.

Regression at integration: `render`, `crop`, `camera`, `camera-director`, `export`, `export-pack`,
`freeze`, `multi-select`, `commands`, `smart-zoom`, `titles` and `captions` unchanged and passing.

---

## 12. Later

- **Duplicate from the Home library**, and **Save as one .flown file** (the rest of X-04), using
  `projectCopy.ts`'s allow-list, once the Home owner schedules it.
- **A Framing track** with *Frame here* and *Whole screen* blocks, and ticks on the timeline that say
  why the view moved (the plan's shots already carry their kind).
- **Following picture changes** for recordings without cursor data: frame differencing on a
  low-resolution decode in a worker, then the same planner with a "change" attention kind.
- **Pull back while travelling**: on pans longer than 1.5 views, widen the view through the middle of
  the pan instead of a fast traverse.
- **Following in frames wider than the recording** (a portrait window recording in 16:9) and a band
  in square frames.
- **Carry following in style presets and the default style** for people who only make Shorts, and
  let Polish turn it on for tall projects.
- **Re-anchoring texts** to the content they point at, so they move with the view.
- **Captions at the seam** between the band and the screen as a caption position.
- **More platforms** in the safe-zone table, per-platform placement picked by export preset, and
  refreshing the table without a release (with NW-15).
- **An opt-in screen-description hint** from the user's own AI provider key to pick what matters
  when the cursor is idle; never required.
- **Incremental plan rebuilds** during drags on very long recordings.
- **Several vertical cuts from one recording** (LT-02 highlight clips) built on Duplicate.

---

## 13. Review notes

Written at integration (`feat/vertical-video`: the contracts commit `d60de6a`, then `feat/vv-p1`,
`feat/vv-p2`, `feat/vv-p4` and `feat/vv-p3`, merged in that order with `--no-ff`). The four parts
changed disjoint files, so the merges had no conflicts. Each part was reviewed by a checker after
its first version; every finding below was reproduced and fixed on the part's branch before the
merge. The body of this document is kept as designed; where the code proved it wrong, the code does
the correct thing and the difference is listed here.

### 13.1 Corrections to the design

- **§5.10 jerk bound.** The third derivative of `S(y) = y³ − y⁴/2` is `6 − 12y`, so the glide's
  peak jerk is `6/(r²(1 − r))` × d/D³, not `3/(r²(1 − r))`. Test 40 checks the correct bound.
- **§5.7 and §5.11 disagree on the clamp.** Shot centres are clamped with `view_k`, which is narrower
  inside a zoom and, during a layout change, uses the smaller base; a centre clamped there can lie
  beyond the edge of the wider view that is drawn later, so the drawn camera sat still on the edge
  and then jolted into the next pan (measured 57.7 views/s² against `maxAccel` 5). Each pan's `from`
  and `to` are now clamped into the widest view over the pan's own samples (`t0 … t0 + D`, one clip
  piece); a plan held beyond that edge first glides onto it with a short **settle** move before the
  pan (it appears as a `'pan'` segment; it is never joined into a glide, delays the pan when the last
  move ended less than its length before, and the shot's deadline is checked again). A pan shortened
  to end at a cut ends at a `to` clamped for the uncut pan's span. Measured after the fix: 4.57
  views/s² in the reported case, 2.68 for the band coming back during a pan. §5.11's "differ only by
  pixel rounding or while a layout change narrows the view" holds only with this rule. The settle is
  also measured in the default layout's view on an axis the pan's view covers (whose centre is 0.5
  there): a pull-back draws the plan's place on that axis, so without it the camera jumped there.
- **§6.3 text placement margins.** "The area already keeps clear of the apps, so the 16:9 margins of
  `placeChunk` are not added" holds only for edges that come from `COMMON_SAFE` or the band push.
  Where the area's edge is the frame's own edge (*Keep text clear* off, the side away from the
  band), captions, key presses and lower thirds keep today's margins: the area rule is applied with
  `max` (top) or `min` (bottom) against today's position. A whole-frame area therefore places text
  exactly like no area, and with *Keep text clear* on the numbers of §6.3 are unchanged.
- **§6.3 step 2, the band push.** It applies whether or not `appSafe` is on, for every band
  `followGeometry` draws, including a bubble's `side-by-side` segment in a tall frame (which §5.3
  draws as a band); otherwise captions were drawn over the camera. `textArea` finds the band from
  `followGeometry` for each layout state at `t`, not from `bandSide`. With `appSafe` off it is `null`
  when nothing pushes.
- **§2.6 and §3: Hold the view here in 16:9.** Fitted exactly like `insertZoom`, a new 1× hold next
  to a zoom could connect to it, and the classic camera then panned between them instead of zooming
  out (a 16:9 export changed). The hold now keeps a connect gap (`connectGap`, the average of the two
  transitions, 0.7 s by default) from the zooms on either side; a playhead inside that gap gets "There
  is no room for a new zoom here." A new hold changes nothing in 16:9; fixing or moving the point of
  a zoom that already exists (`R` inside a cursor zoom, dragging the picture) changes that zoom in
  every frame, as §2.6 asks.
- **§5.6 rule 2, typing with the cursor off the frame.** `typingSessions` takes its place from
  `cursorPlace`, which clamps into 0..1, so a cursor parked outside a window recording dragged the
  view to the edge (against §5.16). For a session whose place comes from the cursor (no click into a
  field), `typingSessionsOf` now returns the cursor where typing began, unclamped, so a place outside
  0..1 gives no target. Auto zoom's own anchors are unchanged. `typingSessionsOf`'s return type is
  frozen by the contracts test, so no flag was added.
- **§4.7 step 8, copies.** One `fs.copyFile` cannot be interrupted, so Cancel left main copying
  gigabytes for minutes while new copies were refused. Files over 4 MiB are copied in 4 MiB pieces
  (`'wx'`, abort checked before each piece, both handles closed before the folder is removed, times
  kept with `utimes`, progress within the file); smaller files keep `copyFile` with `COPYFILE_EXCL |
  COPYFILE_FICLONE`. Large copied files lose copy-on-write where a file system offers it; NTFS has
  none, and the fallback cases (EXDEV, OneDrive) could not clone anyway.
- **Test 64, the media scan.** The contract says "write a temporary file and rename it", so `rename`,
  `renameSync`, `link`, `linkSync` and `writeFileAtomicSync` (a temporary file and a rename) are
  allowed; `copyFile`, `cp`, `writeFile`, `appendFile`, `truncate`, `createWriteStream` and `open`
  with `w`, `a` or `r+` on a linked name are still flagged.

### 13.2 Part P1 (engine)

- A cut shot starts at the cut's own output time, not at the first grid sample after it, so the first
  frame of the new clip never shows the old view.
- A pan shortened to end at a cut is kept only when its peak speed stays at or below `hardSpeed`;
  otherwise the view changes at the cut (§5.9 had only the `c − t0 ≥ minPan/2` test).
- A deadline is set only for a firm event at or after the shot's start (one grid step allowed); an
  event already past (a zoom ending during typing under way) sets none.
- Without cursor data, when no rule gives a target the rest point is a soft target, which gives
  §5.15's pans to and back from zoom points (test 34). `followAttention` still reports kind 0 there.
- A rule whose target is outside 0..1 gives no target and the next rule is tried (the "–" row of
  §5.6).
- `zoomTargetScale(z, floor)` clamps `z.scale` to `[floor, 5]` for every focus mode, regions
  included, because `framedZooms` writes each region's framed level into `scale`. With a base,
  `cameraAt` uses `floor = min(base.w, base.h)` of the frame's own base.
- `cursorPath.ts` does not expose rests; the first and last rest are found with the walk
  `cursorMoves` uses.
- `typingSessionsOf` is not gated on auto zoom's `enabled` or `onTyping`; the planner gates typing on
  cursor data instead.
- `FollowGeometry.band`: `screen-only` gives the band collapsed to height 0 at its outer edge;
  `camera-only` gives `null`.
- The director measures corner costs in the default layout's follow geometry (bubble time is always
  the default layout), so its cache stays valid when layouts change.
- Outside P1's file list: `directorCopy.ts` gains `NOTE_TEXT.band` (`Record<DirectorNote, …>` needs
  it); `CornerProject` gains `hasWebcam`, `layouts`, `reframe`, `shapes` and `spotlights`, and
  `DirectorProject` gains `reframe`, `shapes` and `spotlights`. Extra exports: `followLevel`
  (layout.ts) and `viewLimits` (reframe.ts).
- Test readings: test 26's visible visit is followed by a move 0.4 views away (otherwise the 1.2 s
  look-ahead merges the return into one centre); test 28 uses 1.738 views so `2d/3 = 1.159 s`
  exactly; in test 35 "0.4 views changes nothing" means nothing changes at the cut; test 39 checks
  frames before the segment's end (at exactly `end`, `layoutPhaseAt` is already back to default).
  Five more tests pin rules no test caught by mutation (the smaller base during a layout change,
  both ways; pull-backs give no target; `maxLead`; the backlog; typing off the frame).

### 13.3 Part P2 (render and placement)

- Key presses use the captions' `0.02·u` inset and are kept inside the area across; a logo in a
  corner shrinks to fit the area; the new export `TEXT_INSET = 0.02`.
- Key presses also shrink to fit the room a caption leaves them in the area (`keepInArea` with no
  floor, while there is any room). Stacking alone put the largest keys (7%) over the largest
  caption (9%) above the area's top, over a large camera band; a middle caption left them even
  less room. The default sizes never shrink.
- While following, the card's radius and shadow are not shrunk with `cam.scale` (a view scale below
  1 still spans the slot one way).
- `webcamLayer` keeps calling `sceneCameraBox` (§6.1) rather than reading `fc.layout.camera`.
- The lower third's cached picture is keyed on its whole layout (band, lines, widths and sizes) plus
  the old fields, so a text area of another width repaints it and old projects reuse pictures as
  before.
- `tests/compositorFollow.test.ts` re-imports the compositor per variant for the "equal the 9.0
  snapshot" part of test 47 (the digests depend on the order the module caches fill); it mocks
  `frameView.ts` as §9.2 asks. `tests/previewNoFollow.test.ts` covers `unzoomedScene`.

### 13.4 Part P3 (editor)

- `FollowSection`'s frozen props carry no cursor data, so `FollowSection.tsx` exports
  `FollowEnvContext` (`cursorValid`, `reveal`), provided by the Editor; the section's, the Style
  callout's and the Export note's buttons run editor commands through the existing
  `GroupContext.command`.
- `dragView`'s frozen signature has no view centre, so it cannot hold the view by itself: when
  there is no point to move, the preview applies `holdViewAt` at `frameCamera`'s centre first, in
  the same gesture and undo step. `holdViewAt` inside a region zoom returns the project unchanged
  with that zoom's id.
- The overlay paints the union of the boxes once (SVG) so overlapping `--scrim` fills do not darken;
  the `.safe-zone-box` elements (9 or 3) carry the labels and no paint.
- Copy the design did not give: "Turn on Follow the action first, in Style › Vertical framing." (`R`
  while not following); "Safe zones are shown for tall frames, such as 9:16." (`G` in another
  frame); "A copy is already being made" (palette reason); "Follow the action on/off" and "Safe zones
  on/off" (toggle notices, like the other toggles).
- Keyboard: a toggle reached with the keyboard keeps `Space` (§11.3 step 2 turns following on with
  Tab and Space). `focus.ts` records whether the keyboard or the pointer moved focus
  (`isKeyboardToggle`); a toggle clicked with the mouse still lets `Space` play. The safe-zones app
  select keeps focus after a keyboard choice.
- The *Open original* notice: the message is ellipsised in its own span and the button sits beside
  it (only a notice with a button is a flex row, so other notices keep their look); a notice with a
  button stays while hovered or focused. The separate branch `fix/vv-p3-notice` (the same fix
  written from P4's side, making every notice a flex row) was **not merged**: P3 fixed it on its own
  branch, and that branch would break `ui.e2e`'s check that the editor notice is not `display: flex`.
- The magnification warning applies from 2× at rest. A rejection without the "Could not make the
  copy: " prefix gets it added.
- Extra `data-testid`s (the frozen list is unchanged): `layout-band-hint`, `zoom-framed-level`,
  `export-follow-off`.
- `DirectorSection.tsx` is unchanged: it already plans from `cropView(project, cursor)`, which
  carries `reframe`, and P1's director builds the `frameView` scene itself.
- `useSceneView` re-renders when the screen rectangle or the slot changes, not on camera-only moves.
- `tests/e2e/editor.e2e.cjs` scrolls the Padding slider into view before dragging it (the Vertical
  framing section under Frame pushes it down); its assertions are unchanged.

### 13.5 Part P4 (Duplicate)

- `refitItems` breaks a text that is still too wide at 60% repeatedly (at the run of spaces nearest
  the widest line's middle) until it fits or cannot break; test 60 checks the single break. With
  `measure` null a character is estimated at 0.55 × the font size.
- `projectCopy` refits each item into the text area at its own start, with the project's fonts;
  `refitItems` itself (whose `Pick<>` has no fonts) measures with the fallback font.
- The 0.5 s delay is inside `CopyProgress`, which the Editor mounts as soon as a copy starts.
- Cancel answers at once in the renderer; main finishes its current piece and removes the folder. A
  copy that finishes just as Cancel is pressed is deleted with `deleteProject`.
- Main rejects with the reason only and `runDuplicate` adds the prefix. `ENOSPC` gives the free-space
  message; `ENOENT`, `EACCES`, `EPERM`, `EIO` and `EBUSY` give "some of the recording's files could
  not be read."; a failed `createProjectDir` gives the Videos\Flown message. `linkAllowed` is also
  checked for the source folder; the progress total includes linked bytes, done at once.
- Opened by a click or `Enter`, the menu takes focus itself, so the first `Down` reaches *Make a
  vertical version* (§11.3 step 5); `Down`/`Up` on the button open it at the first or last item.
- The copy icon is a local SVG in `CopyMenu.tsx` (no change to the shared `EditorIcon.tsx`).
- E2E: step 10 runs in *Old* before step 5; step 4 also checks that TikTok comes back after
  reopening; step 9 first edits and restores the name so the original's `project.json` is in the
  editor's saved form, then compares without regard to key order.
- The copy is built from the editor's state (`store.state`), not from the saved form
  (`withRecordedStems`/`withRecordedCamera`): a project opened while a stem or camera file is
  missing is copied without `audioStems` or `hasWebcam`, which matches the files the copy gets.

### 13.6 Integration

- Test 66's source check is added to `tests/verticalContracts.test.ts`: the compositor,
  `shapesLayer`, `PreviewStage` and `directorCorners` neither call nor import `cameraAt` and use
  `frameCamera`/`frameView`; it fails on the contracts commit's files.
- The stand-ins the parts used while the others were stubs are removed:
  `tests/textArea.test.ts` now runs against P1's real `followGeometry` and `bandSide`, and
  `tests/duplicate.test.ts` and `tests/copyMenu.test.ts` against P2's real `textArea` and
  `keepInArea` (`tests/safeZoneStandIns.ts` deleted). All pass unchanged.
- The e2e tests that use the speech detector (`camera-director`, `captions`) need the host speech
  helper (`npm run build:speech-host`, `native/bin/`) and the test model (`npm run
  fetch:test-speech`, `.cache/test-speech/`) in the worktree; both are ignored by git, so a fresh
  worktree fails them with that message until they are built or copied in.
- Verified at integration: `npm run typecheck` clean; `npx vitest run` 237 files, 3312 tests
  passed; `npm run build`; under Xvfb `vertical-video` and the regression list of §11.3 (`render`,
  `crop`, `camera`, `camera-director`, `export`, `export-pack`, `freeze`, `multi-select`,
  `commands`, `smart-zoom`, `titles`, `captions`) all pass, and so do `editor`, `cursor`, `ui`,
  `zoom`, `style-pack`, `tilt`, `shapes` and `preview-speed`, which the parts' changes touch.
- Looked at by eye in the built app on a 1920×1080 recording with a camera, captions, clicks, typing
  and an auto zoom (`docs/screenshots/vertical-video-*.png`): the copy menu, the 9:16 copy with the
  band on top, the safe zones (all three and TikTok), the band at the bottom, the bubble, the square
  version, the Export dialog's notes, a 1080×1920 export (pans with motion blur, the zoom inside the
  view, captions and key presses inside the text area) and an export with `screen-only` and
  `camera-only` segments (the band collapses and comes back, the view widens and narrows with it).
  Nothing needed changing.

### 13.7 Open

- **Before release**: compare the safe-zone table with the three apps on a phone and set each
  platform's `checked` date (§7).
- *Windows-unverified*: hard links on NTFS, the OneDrive root check, copy speed and Cancel of large
  copies on a real disk.
- Plan time for the synthetic hour of test 30 on the integration machine: about 115–130 ms on the
  first plan and 57–68 ms warm, against the §8.2 budget of 60 ms per hour (the CI guard of 400 ms
  passes). The incremental rebuild of §8.2 (and §12) is the way down if drags on very long
  recordings hitch.
- An export at 720×1280 took 3.8 s following against 3.6 s fitted in the e2e run (§8.2 asks within
  5%; logged, not asserted).
- During the 0.4 s layout animation the drawn view can still kink where the eased edge meets a moving
  plan (§5.11 accepts this); a settle inside a zoom shows as a small drift of at most about 0.35
  zoomed views before the pan.
- A valid track with typing but no samples and no clicks still gives a firm typing target at the
  centre; §5.15 says only zooms and shapes give targets there (behaviour of the shared typing
  sessions, older than this feature).
