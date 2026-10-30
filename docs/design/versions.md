# Versions, filmstrip and frame nudge (E-12, E-07, E-09)

Status: built for the next release (branch `feat-versions`). Three editor features:

| Id | Feature | One line |
|---|---|---|
| E-12 | Versions | Save named versions of an edit ("Before captions", "v1 for client"), list, rename, delete, compare and open any of them; an automatic version before risky actions |
| E-07 | Filmstrip on the clip track | Small frames along the clip track at the timeline's zoom, made once from the proxy and cached |
| E-09 | Nudge by one frame | ← / → move the selected item(s) one frame, Shift + ← / → ten frames, one undo step per run of presses |

Nothing here adds a field to `project.json`: old projects load byte for byte as before (§9). New
state lives in the project folder (`versions/`, `.cache/filmstrip.*`) and in the editor's
localStorage (the filmstrip toggle).

---

## 1. What the code does today (read before deciding)

* **The edit is one file.** `project.json` (schema v2, `src/shared/types.ts` `Project`) holds the
  whole edit; the media (`screen.mp4`, `webcam.mp4`, stems, assets) sit next to it and are never
  rewritten (`src/main/projectCopy.ts` CONTRACT). The editor keeps it in an `EditStore`
  (`src/shared/editor/editStore.ts`): every change is a `store.update`, undo has 200 steps and
  is lost when the editor closes. Autosave writes `project.json` with `writeFileAtomicSync`
  (`src/main/atomicWrite.ts`: a `.tmp` file and a rename, retried while Windows briefly locks it).
* **Saves come from the page.** `projects:save` takes the renderer's project; main writes it as is
  (`saveProjectNow`, `src/main/projectsIpc.ts`). The id names the folder through
  `projects.projectDir()` (`ID_RE`, no escape from the projects root); `projects:duplicate`
  additionally accepts only the main window's own app page (`fromMainWindow`).
* **The editor follows the project state.** The background image, fonts, overlays and the
  scene are derived from `store.state`, so undo and redo of any change (also a whole-project
  change) redraw correctly (`Editor.tsx`, the background effect keyed on its path).
* **Assets stay in the folder**, except picked music and logos: `assetIpc.ts` `prunePicks`
  keeps the latest few picks and the saved one. An older edit may therefore name a music or logo
  file that is gone (§2.6).
* **Duplicate** (`projectCopy.ts`) copies only allow-listed top-level files and the speech cache
  (`planFiles`): any other folder is left out today.
* **Storage** (`src/main/storage.ts`) counts every byte under a recording folder (`folderSize`) and
  reports `.cache/` apart; the cache rule moves only `.cache/` to the Recycle Bin.
* **Background ffmpeg work** on a project's files runs in main and is registered in a
  `ProjectProcesses` set, so `stopAnalyses(id)` (`analysisIpc.ts`) can stop it when the editor
  closes or the project is deleted (Windows cannot delete a file ffmpeg has open). Still detection
  decodes only key frames (`-skip_frame nokey`): the proxy has one every 15 frames (`proxyArgs.ts`
  `-g 15`: 0.25 s at 60 fps, 0.5 s at 30 fps).
* **The clip track** (`Timeline.tsx`) is 40 px tall, in source time at `px` pixels per second,
  drawn only over a render window `win`. The waveform (`ClipWaveform.tsx`, E-04) is one canvas over
  that window, redrawn only when what it shows changes, toggled by a localStorage preference
  (`waveformPref.ts`).
* **Arrow keys** run `stepBack` / `stepForward` (← / →, 1/30 s) and `jumpBack` / `jumpForward`
  (Shift + ← / →, 1 s) whatever is selected (`shortcuts.ts` `DEFAULT_KEYMAP`, `Editor.tsx`). A focused
  slider keeps its own arrows (`isSliderKey`), text fields keep theirs (`isTextEntry`).
* **Moving several items** is pure in `src/shared/editor/groupMove.ts`: `groupMovePlan` (limits:
  the recording's ends, unselected zooms, a freeze frame's clip), `groupAccepts` (freeze frames),
  `moveGroup`. The notices are in `multiSelectCopy.ts` (`movedNotice`, `stopNotice`).
* **Undo coalescing:** `store.update(fn, key)`: consecutive updates with the same key less than
  800 ms apart are one undo step (`History.push`, a rolling window).

---

## 2. Versions (E-12)

### 2.1 Where versions live — **the project folder, `versions/`, one file per version plus an index**

* *Chosen:* `<project>/versions/<versionId>.json` holds one version: `{ "format":
  "flown-version", "v": 1, "meta": {…}, "project": {…} }`, the project exactly as the editor had
  it. `<project>/versions/index.json` lists the metas (`{ "v": 1, "items": [...] }`) so the list
  opens without reading every snapshot. The folder is the unit the user moves, backs up and
  deletes, so the versions go with it.
* *Rejected:* versions inside `project.json`: every autosave (one per edit) would rewrite every
  version, and old projects would change shape.
* *Rejected:* userData: a project moved or restored from a backup would lose its versions, and
  deleting a project would leave them behind.
* *Rejected:* one file holding all versions: every save rewrites megabytes (a transcript makes a
  `project.json` of 1–5 MB), and one bad write loses every version.
* **The index is a cache of the files.** Each snapshot carries its own meta, so a missing or
  unreadable index is rebuilt from the files (`rebuildIndex`); an index entry whose file is gone
  is dropped; a snapshot file the index does not list (a crash between the two writes) is adopted
  at the next listing. Nothing is ever lost because of the index.

### 2.2 What a version is

```ts
// src/shared/editor/versions.ts
export interface VersionMeta {
  id: string            // 'v-<base36 ms>-<8 hex>', made by main
  name: string          // 1..80 characters
  auto: boolean         // made by Flown before a risky action
  reason?: AutoReason   // why (auto versions only)
  createdAt: string     // ISO
  bytes: number         // the snapshot file's size
  hash: string          // sha-256 (hex) of the snapshot's project JSON
  summary: VersionSummary
}
export type AutoReason = 'polish' | 'fillers' | 'vertical' | 'square' | 'open'
export interface VersionSummary {
  duration: number   // video length in seconds (edit plus freeze holds), as the export makes it
  cuts: number       // cuts between clips (timelineGaps kind 'cut')
  trimmed: boolean   // the start or the end is trimmed
  zooms: number
  captions: number   // transcript segments
  texts: number      // text annotations plus title cards
  shapes: number     // shapes plus spotlights
  images: number     // image overlays
  chapters: number
  freezes: number
}
```

* **Snapshot from the page.** The renderer sends `store.state` (the edit as the user sees it, even
  before the autosave caught up). Main checks it as it checks a copy (`projectCopy.ts`):
  `migrateProject` must accept it, its id must be the folder's id, and it is at most 64 MB as JSON.
  The file stores what `migrateProject` returned, so a version always opens with today's code.
* **Hash** of that JSON: an automatic version identical to any kept version is not saved again
  (the edit is already kept). A named version is always saved (the user asked for that name).

### 2.3 Limits (numbers)

| What | Value | Why |
|---|---|---|
| Named versions | at most **50** | A long project's worth; then "You have 50 saved versions. Delete one to save another." |
| Automatic versions | the newest **5** kept | Enough to undo the last few risky actions; the oldest automatic one goes when a sixth is made |
| Name | 1–80 characters, trimmed, control characters removed | Empty → "Version N" (N = named versions + 1) |
| Snapshot | at most 64 MB (as `projectCopy.ts` `PROJECT_MAX`) | A larger one is refused: "This edit is too large to keep as a version." |
| Index | at most 200 entries read | Anything beyond is ignored, never acted on |

### 2.4 Exact behaviour

* **Save a version** (Versions dialog, *Save a version…* in the palette, Ctrl + Shift + S): the
  name field (placeholder "Version 3") and **Save version**. The new row appears on top; notice
  "Saved “v1 for client”".
* **Automatic versions** are made just before:
  * **Polish in one click** — when **Polish** is pressed in its dialog: "Before Polish in one click";
  * **Remove all** in the Transcript tab's review list (fillers and retakes): "Before removing fillers";
  * **Make a vertical version** / **Make a square version**: "Before making a vertical version" /
    "Before making a square version" (the source is not changed by a copy, but the copy is made
    from this moment: the user can always find the edit it came from);
  * **Open this version**: "Before opening “v1 for client”".

  The snapshot is taken synchronously (the IPC message is sent with the state before the action
  changes it), so an action never waits for the disk and is never lost; a failure is logged and
  does not stop the action (it changes nothing that undo cannot bring back in this session).
* **List:** newest first; each row: name, *Automatic* badge, date and time ("Today 14:02",
  "12 Mar 14:02"), and the summary line "2:13 · 3 cuts · 5 zooms · 42 captions" (zero counts left
  out, never more than five parts).
* **Open this version:** first an automatic version of the edit now (skipped when it equals a kept
  version), then the version is read, checked and put in place as **one undo step** (`store.seal`,
  `store.update`, `store.seal`), so Ctrl + Z goes straight back too. Fields that belong to the
  recording, not to the edit, stay as they are now: `id`, `createdAt`, `name`, `duration`, `width`,
  `height`, `hasWebcam`, `hasAudio`, `webcamOffset`, `capture`, `audioStems`, `source`, `copyOf`,
  `script` (`RECORDING_FIELDS`, `restoreVersion()`). The selection is cleared; the dialog closes;
  notice "Opened “v1 for client”. Your edit before it is kept as a version · Ctrl + Z to undo".
* **Compare** (per row): the version is read and compared with the edit now, in the row:

  | | This version | Now |
  |---|---|---|
  | Length | 2:13 | 1:58 |
  | Cuts | 3 | 5 |
  | … only the counts that differ … |

  followed by "Also different: style, camera." (`changedAreas`: style, cursor, camera, sound,
  effects, captions look, crop, vertical framing, brand, watermark, transcript text) or "Same as your
  edit now." when nothing differs.
* **Rename:** the name turns into a field (Enter saves, Esc cancels); same rules as §2.3.
* **Delete:** the row asks "Delete “v1”? This cannot be undone." with **Delete** and **Keep**.
  Deleting is permanent: a version is a few hundred kilobytes of text, and the confirmation is
  in the row it removes.
* **Files a version names that are gone** (a music or logo file pruned since, §1): opening says
  "Opened “v1”. Its music file is no longer in the project folder." (`missingFiles` checks the
  background, cursor, logo, music, image overlays and fonts the version names).

### 2.5 IPC and security

`src/main/versionsIpc.ts`, channels `versions:list`, `versions:save`, `versions:rename`,
`versions:delete`, `versions:read`:

* **Sender:** only the main window's own app page (the rule of `projectsIpc.ts` `fromMainWindow`).
* **Ids:** the project id goes through `projects.projectDir()` (throws for anything but
  `[a-zA-Z0-9_-]+`); a version id must match `VERSION_ID_RE = /^v-[0-9a-z]{6,12}-[0-9a-f]{8}$/`;
  paths are built by main only (`<dir>/versions/<id>.json`). The `versions` folder must be a real
  folder (`lstat`, not a link or junction); a snapshot file must be a regular file of at most 64 MB
  before it is read.
* **Values:** the snapshot as in §2.2; names as in §2.3; a `reason` outside `AutoReason` is refused.
* **Writes** are synchronous and atomic (`writeFileAtomicSync`): the snapshot first, then the
  index, so two requests can never interleave and a crash leaves either the old state or a
  snapshot the next listing adopts.

### 2.6 Duplicate, Make a vertical version, storage

* **Duplicate does not copy versions.** A copy starts its own history: a vertical version's
  "before" versions would be landscape edits, opening one there would undo the reframing; the
  original keeps them, and the copy names it (`copyOf`). `projectCopy.ts` gets an explicit
  `NOT_COPIED_DIRS` (`versions`) with a test, so a later change of `planFiles` cannot start copying
  them by accident.
* **Storage** counts them: `RecordingUsage.versionBytes` (bytes under `versions/`, absent when
  none); Settings › Storage shows "· incl. 1.2 MB in versions". The cache rule never touches
  `versions/` (it is not a cache); removing a recording moves its versions to the Recycle Bin with it.

### 2.7 UI

A **Versions** button in the editor's title bar, after Undo / Redo (a clock icon with "Versions"),
and two palette commands: *Save a version…* (Ctrl + Shift + S, opens the dialog with the name field
focused) and *Versions…*. The dialog (`src/renderer/src/versions/VersionsDialog.tsx`) is a modal like
the shortcuts dialog (`useModalFocus`: Tab stays inside, Esc closes, focus goes back).

Copy:

* Title "Versions"; intro "A version keeps this edit as it is now. Your recording is never changed."
* Empty list: "No versions yet. Save one before a big change, so you can always go back."
* Footer hint: "Flown also keeps a version before Polish, Remove all and Make a vertical version (the last 5)."
* Buttons: "Save version", "Open", "Compare", "Rename", "Delete", "Keep", "Close".
* Errors: "Could not save the version: …", "Could not open this version: …".

---

## 3. Filmstrip on the clip track (E-07)

### 3.1 Making the frames — **one ffmpeg run on the proxy's key frames, tiled into one JPEG**

* *Chosen:* main runs ffmpeg once per proxy:
  `-skip_frame nokey -i screen.mp4 -an -vf fps=R,scale=W:H:flags=area,showinfo,tile=CxR -frames:v 1 -q:v 5`.
  Only key frames are decoded (one per 0.25 s, §1): a one-hour recording decodes 14 400 frames,
  not 216 000. `fps=R` picks the frame nearest each step; `tile` packs them into one sheet (a
  sheet left part-filled is written at the end of the input; `showinfo` counts the frames).
  ffmpeg runs at below-normal priority (`os.setPriority`), so editing and playback keep the CPU.
* **Numbers:** step `interval = max(key interval, duration / 400)` (at most **400 frames**; 0.25 s
  steps up to 100 s long recordings, 9 s in an hour); tile height **72 px** (the 40 px track at 1.8×
  scale), width from the recording's aspect, `W = clamp(round(72 × aspect / 2) × 2, 24, 256)`;
  **20 columns**. A 16:9 sheet of 400 frames is 2560 × 1440 px, about 0.5–1 MB as JPEG.
* **Cache:** `.cache/filmstrip.jpg` and `.cache/filmstrip.json` (`{ v, key, interval, count, cols,
  tileW, tileH }`), `key` = the proxy's size and modification time plus the numbers above. Written
  through temporary files and renames, the JSON last. A matching cache is returned without running
  ffmpeg; anything else (no cache, another proxy, unreadable) runs it again. The cache rule of
  Settings › Storage may remove it: it is made again the next time.
* **Time limit:** 60 s plus 0.25 s per second of recording; then ffmpeg is killed and the strip
  says nothing (the editor works as before). Stopped by `stopAnalyses(id)` (one added line in
  `analysisIpc.ts`), so closing the editor or deleting the project never waits on it.
* *Rejected:* decoding in the renderer with WebCodecs (the exporter's decoder): it would share the
  GPU decoder with playback and the preview, and a seek per frame is slower than one ffmpeg run.
* *Rejected:* a sheet per zoom level: the frames of one step are enough at every zoom (§3.2), and
  one file is one cache entry.

### 3.2 Drawing — **frames on a fixed grid of the track, the nearest frame in each**

* One canvas over the timeline's render window, like the waveform: tile `i` covers
  `[i·w, (i+1)·w)` CSS pixels of the track (`w` = 40 px × aspect of the shown picture), so frames
  never shimmer while scrolling; it shows the frame nearest its middle's source time
  (`filmstripTiles()`, pure). Zoomed far in, neighbouring tiles show the same frame; zoomed out,
  tiles skip frames. Crop is applied when drawing (the frames are of the whole picture, `Project.crop`
  is normalised to it), so cropping never makes the strip again.
* Under the waveform (same z-index, earlier in the DOM) and over the clip colour at **55 %**
  opacity while the waveform shows (the waveform stays readable), **85 %** without it. Cuts and
  trims keep a fainter strip over their hatching (like the waveform's `gapAlpha`), and a speed
  badge's box is left clear.
* It redraws only when the window, the scale, the clips, the crop or the sheet change, never per
  playback frame. The sheet is decoded once with `createImageBitmap` (off the main thread).
* Requested at idle (`requestIdleCallback`, 1.5 s at most) after the editor opens, only while
  shown. The editor never waits on it: until it is ready the track looks as before.

### 3.3 The setting

*Frames on the clip track* (Timeline, a toggle, on by default), in the palette and the shortcuts
editor (no default key); stored as `localStorage['editor-filmstrip']` like the waveform's. The
clip track's tooltip adds " · Frames: hover to find a moment by sight" when shown; "Reading frames…"
while they are made.

### 3.4 IPC

`filmstrip:get(projectId)` → `{ meta, jpeg: Uint8Array }` or null when it cannot be made (no proxy,
ffmpeg failed: logged). Only the app's page may call it (as `projects:detectStill`); the id goes
through `projectDir`; requests for the same proxy share one run.

---

## 4. Nudge by one frame (E-09)

### 4.1 Keys — **the step keys move the selection when items are selected**

* With **items selected** (one zoom, text, shape, spotlight, image, title card, chapter or freeze
  frame, or a group of them: the keys `groupKeyOf` / the group give), the keys of *Step back one
  frame* and *Step forward one frame* (← / →) move them one frame earlier / later, and the keys of
  *Back one second* / *Forward one second* (Shift + ← / →) ten frames.
* With **nothing selected**, or a clip, cut, range, click, caption or camera layout selected (they
  cannot move this way), the keys do what they always did. Esc clears the selection, so the
  playhead keys are one key away.
* The nudges are also commands of their own (*Move selected items one frame earlier / later*,
  *… ten frames earlier / later*, Edit), which a user may bind to other keys; they show the step
  keys as theirs (`commandKeys`) while those are bound. If a user binds the step keys elsewhere,
  the nudge follows the step command's keys (`nudgeInstead()` in `shortcuts.ts`).
* Text fields and focused sliders keep their arrows (unchanged rules).
* *Rejected:* Alt + arrows (Premiere's choice): Alt + ← is "Back" in Chromium and in many mice
  bindings, and the arrows are what the roadmap and users expect.

### 4.2 One frame — **1/30 s of source time**

The editor's frame everywhere (the frame step, J/K/L frame steps, the export dialog's time
fields): an item moves exactly as far as the playhead does with the same key. A 60 fps recording
is nudged two of its frames at a time. *Rejected:* `capture.fps`: the playhead would then step
twice as far as the item.

### 4.3 The move — **`moveGroup` from `groupMove.ts`, limited and never drifting**

`nudgeItems(p, keys, frames)` (pure, `src/shared/editor/nudge.ts`): plan the group
(`groupMovePlan`), clamp the delta to its limits, refuse a delta its freeze frames do not accept
(`groupAccepts`, then no move), `moveGroup`. Zooms become yours (`auto: false`), as with a drag. A
move cut short says why with the multi-select wording ("Moved 0.1 s later: the end of the
recording"), at most once per run of presses; a move that is not possible says "Not moved: …".

### 4.4 Undo — **one step per run of presses**

Each nudge is a `store.update(…, 'nudge:<sorted keys>')`: presses less than 800 ms apart (holding
the key repeats every ~33 ms; tapping) are one undo step; a pause, another edit or another
selection starts a new one.

---

## 5. Files and signatures

New:

* `src/shared/editor/versions.ts` — `VersionMeta`, `VersionSummary`, `AutoReason`,
  `VERSION_ID_RE`, `LIMITS`, `cleanVersionName(raw, fallback)`, `autoVersionName(reason, about?)`,
  `versionSummary(p)`, `summaryLine(s)`, `compareSummaries(a, b)`, `changedAreas(a, b)`,
  `restoreVersion(current, version)`, `RECORDING_FIELDS`, `missingFileNames(p)`, `sanitizeMeta(raw)`.
* `src/main/versions.ts` — `versionsDir(dir)`, `listVersions(dir)`, `saveVersion(dir, id, raw, opts)`,
  `renameVersion(dir, vid, name)`, `deleteVersion(dir, vid)`, `readVersion(dir, projectId, vid)`.
* `src/main/versionsIpc.ts` — `registerVersionsIpc()`.
* `src/shared/api/versions.ts`, `src/preload/versions.ts` — `VersionsApi`.
* `src/renderer/src/versions/VersionsDialog.tsx`, `versions.css`, `autoVersion.ts`
  (`keepVersionBefore(project, reason, about?)`), `VersionsIcon.tsx`.
* `src/main/filmstrip.ts` — `filmstripPlan(duration, w, h, keyInterval)`, `filmstripArgs(…)`,
  `countShowinfo(log)`, `getFilmstrip(id)`, `stopFilmstrip(id)`, `registerFilmstripIpc()`.
* `src/shared/editor/filmstrip.ts` — `FilmstripMeta`, `filmstripTiles(meta, win, px, tileW, total)`.
* `src/renderer/src/editor/Filmstrip.tsx`, `filmstripPref.ts`, `filmstrip.css`.
* `src/shared/editor/nudge.ts` — `NUDGE_FRAME`, `nudgeItems(p, keys, frames)`, `nudgeUndoKey(keys)`.
* Tests: `tests/versions.test.ts`, `tests/versionsMain.test.ts`, `tests/filmstrip.test.ts`,
  `tests/nudge.test.ts`, `tests/e2e/versions.e2e.cjs`.

Additive lines in shared files: `commands.ts` (seven commands), `shortcuts.ts` (`Ctrl+Shift+S`,
`NUDGE_OF`, `nudgeInstead`, `commandKeys`), `Editor.tsx` (the button, the dialog, the commands, the
key swap), `Timeline.tsx` (`<Filmstrip>`), `TranscriptPanel.tsx` and `PolishDialog.tsx` (one call
each), `projectCopy.ts` (`NOT_COPIED_DIRS`), `storage.ts` and `shared/storage/rules.ts`
(`versionBytes`), `StorageSection.tsx` (one line), `analysisIpc.ts` (stop the filmstrip),
`index.ts`, `preload/index.ts`, `api.ts`. No new dependency.

---

## 6. Risks

* **Disk:** 50 named versions of a 5 MB `project.json` are 250 MB. Storage shows them; the list
  shows each version's size in its tooltip. Acceptable for text the user asked to keep.
* **A version and pruned assets** (§2.4): said when opening, never a failure.
* **Nudging changes the arrow keys while something is selected.** A user who selected a zoom and
  pressed → to step the playhead now moves the zoom. Mitigations: the move is one undo step, the
  notice says what moved ("Moved 1 item 1 frame later"), and Esc gives the old keys back.
* **ffmpeg on unusual proxies** (an imported video with a long GOP would decode few key frames):
  the strip then repeats frames; never wrong, only coarser.

## 7. Test plan

* Unit: names, summaries, comparison and areas, restore keeps the recording's fields, meta
  sanitising; main: save/list/rename/delete/read in a temp folder, limits (50 named, 5 automatic),
  duplicate automatic skipped, index rebuilt from files, orphan adopted, bad ids, symlinked folder,
  oversize, wrong project id; filmstrip plan numbers, ffmpeg arguments, showinfo count, tile maths,
  a real ffmpeg run on a generated video, the cache reused; nudge: one and ten frames, limits,
  freeze refusal, chapters, zooms made yours, undo key; `nudgeInstead` and `commandKeys`;
  duplicate leaves `versions/` out; storage counts `versionBytes`. Each test fails without its code.
* End-to-end (`tests/e2e/versions.e2e.cjs`, the built app under Xvfb): save a named version, change
  the edit, compare, open the version (the edit comes back, an automatic version appears, Ctrl + Z
  goes back), rename and delete; the filmstrip appears on the clip track and hides with its toggle;
  ← moves a selected zoom by one frame and Shift + → by ten, one undo step each, and ← steps the
  playhead again after Esc.

## 8. Left for later

* Comparing two versions with each other (today: a version with the edit now).
* A preview thumbnail per version.
* Versions in the Home library (open an older version from the list of recordings).
* Keeping music and logo picks that versions name (`prunePicks` reading the versions).
* A finer filmstrip when zoomed far in (a second sheet of a part of the recording).

## 9. Old projects and settings

Nothing is added to `project.json` or to `migrateProject`: a project without `versions/` lists no
versions, and opening one changes nothing on disk until the user saves a version. The keymap gains
commands with no default keys (`nudge*`, `toggleFilmstrip`, `versions`) and one with
Ctrl + Shift + S (`saveVersion`); stored shortcut changes load as before (`sanitizeShortcuts`), and a
user who already gave Ctrl + Shift + S to another command keeps it (`resolveKeymap`: their choices
win). The filmstrip preference is new and defaults to on.
