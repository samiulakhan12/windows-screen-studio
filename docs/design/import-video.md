# Import a video (NW-07)

Status: designed and built on `feat-import-video` (from `ccr-b6df7cf7-yked87`, Flown 0.6.0). §13
"As built" records where the build differs. Roadmap: `docs/ROADMAP.md` NW-07 ("Import an existing
video").

Code read for this design: `src/main/{ffmpeg,projects,projectsIpc,proxyArgs,assetIpc,security,
styleDefaults,analysisIpc,mediaProtocol,index,windows}.ts`, `src/main/recording/{finalize,proxyRunner}.ts`,
`src/shared/{types,api,mediaUrl}.ts`, `src/shared/api/projects.ts`, `src/shared/engine/{project,
timeline}.ts`, `src/shared/editor/{polish,polishCopy,projectName,freezeEdit}.ts`, `src/preload/
{index,projects,ipc}.ts`, `src/renderer/src/{App.tsx,styles.css}`, `views/{Home,Editor}.tsx`,
`editor/{Inspector,player,modalFocus,polishRunner}.ts(x)`, `editor/panels/{Cursor,Zoom,Effects,
Camera,Director,Clip,Shapes}Panel.tsx`, `render/shapesLayer.ts`, `tests/e2e/helpers.cjs`.

The rules earlier waves set still hold:
- Every visual is a function of source time, so preview, scrubbing and export agree.
- Every edit is one undo step.
- Projects and settings made before this feature open, preview and export exactly as before.

Other branches being built at the same time own the recording side (`src/main/recording/*`,
`recordingIpc.ts`, `windows.ts`, the recorder), vertical framing (`layout.ts`, export presets,
Duplicate in `projects.ts`), transcript editing, clean voice and long-job health. This feature
reads `finalize.ts`, `proxyRunner.ts` and `proxyArgs.ts` but changes none of them, and touches the
shared files only with the few additive lines listed in §10.

## 1. What the user gets

- **Import video** on the Home screen, in the head of *Recent recordings*, opens a file picker
  (MP4, MOV, MKV, WebM; M4V too).
- **Drag and drop**: dropping a video file anywhere on the *Recent recordings* list imports it.
  While a file is dragged over the list, it shows *Drop a video to import it*.
- A dialog shows the import: *Checking the video…*, then *Making an editing copy…* with a
  progress bar, percent and *About 3 min left*, then *Finishing…*. **Cancel** stops it at once
  and leaves nothing behind.
- The new project opens in the editor. Backgrounds and style, the brand kit, crop, cuts and
  speed, remove silences, smart speed, captions (on this PC or with a provider), text, shapes,
  images, title cards, chapters, freeze frames, music, manual zooms and export all work as they
  do for a recording.
- Things that need the cursor, clicks or keys recorded by Flown are off and say why: auto zoom,
  the smooth cursor, click effects and sounds, the keystroke overlay, cursor-following zooms,
  spotlights and 3D tilt, and the camera director (an imported video has no separate camera).
- What cannot be edited is refused before anything is written, with one plain sentence (§5.3).
- The user's file is never changed, moved or kept open after the import.

## 2. Decisions

### 2.1 Make an editing copy (the proxy); do not keep a copy of the original

The editor and the exporter read **one kind of file**: `screen.mp4`, a constant-rate H.264 MP4
with a key frame every 15 frames (`proxyArgs.ts`). The renderer demuxes it with its own MP4 reader
(`render/mp4*.ts`), decodes with WebCodecs, seeks frame-exactly thanks to the short GOP, and
`exportFrameTimes`, freeze frames (`freezeEdit.ts`) and the player's frame step (`player.ts`)
assume a constant rate of `capture.fps`. An MKV, a VP9 WebM, a phone's variable-rate HEVC or an
MP4 with 2-second GOPs breaks one of those. So an import must produce that proxy, exactly as a
recording does.

| Option | Disk for a 1-hour 1080p30 phone video (about 16 Mbit/s, 7.2 GB) | Editor works | Notes |
|---|---|---|---|
| A. Copy the file, edit it directly | 7.2 GB | **No** (container, codec, GOP, rate) | Would mean a second decode path in preview and export. |
| B. Copy the file **and** make the proxy | 7.2 + about 4.2 GB = **11.4 GB** | Yes | The copy is never read: export renders from the proxy, as for recordings. |
| **C. Make the proxy only (chosen)** | about **4.2 GB** (§5.2 estimate) | Yes | The original stays where it is, untouched. |
| D. Remux when the file is already a proxy-like MP4 | 7.2 GB | Rarely possible | Only files with H.264, constant rate, GOP ≤ 15 and even sizes qualify: almost none (phones use 1–2 s GOPs). Left for later (§12). |

C keeps disk use at about 60 % of the source for a typical phone video, works for every size, and
has the same quality as a recording: x264 at CRF 17 (or the GPU encoder recordings use), which is
visually lossless for screen and camera content. A project that later needs the original's full
quality can be re-imported. The copy is made into the project folder, so the project stays
self-contained like a recording and is unaffected when the original is moved or deleted.

### 2.2 Probe with the bundled ffmpeg, not ffprobe

`ffmpeg-static` ships `ffmpeg` only; there is no bundled `ffprobe`, and adding one (`ffprobe-static`)
would add about 70 MB to the installer and a dependency. `proxyRunner.ts` already reads the input's
size and audio from ffmpeg's log (`parseInputSize`, `parseInputHasAudio`); the import reads the
same log (`ffmpeg -hide_banner -nostdin -i <file>`) more fully in a pure, unit-tested parser
(`src/shared/import/probe.ts`): duration, start, every stream with its type, codec, codec tag,
pixel format and colour transfer, size, SAR, frame rate, field order, the `attached pic`
disposition and the display-matrix rotation. The log's format has been stable for a decade; the
parser is tested against logs of the bundled 7.0 build and keeps working on unknown lines.

Then a **decode test** (`-frames:v 1`, plus 1 s of the chosen audio stream, to `-f null`) proves
the bundled ffmpeg can really decode the streams before any disk space is used. A missing decoder,
a damaged file or an encrypted stream fails here, not 20 minutes into the copy.

### 2.3 One frame rate rule: 30 or 60

The proxy runs at `capture.fps`, which the code treats as 30 or 60 (absent: 60;
`analysisIpc.ts` reads key frames only unless it is 30). So the import picks **60 when the
source's average rate is above 31 fps, else 30**, and converts with `-fps_mode cfr -r <rate>`.
That one rule **handles variable frame rate**: phones and Game Bar write VFR, ffmpeg places every
frame on its timestamp and repeats or drops frames to the constant rate, so sound stays in sync.
No VFR detection is needed (it would need a full decode pass). 24 and 25 fps sources become 30 fps
with a repeated frame every 4 or 5 frames, as any 30 fps export of them would; keeping 24/25 is
left for later (§12).

### 2.4 One output size rule

The proxy is the display size of the picture (after rotation and non-square pixels), fitted
inside 3840 × 2160 in either orientation, rounded down to even numbers:
`scale = min(1, 3840 / longSide, 2160 / shortSide)`. 4K UHD and 1080p phone video pass unscaled;
a 5.7K action camera file becomes 3840 × 1920. Chromium's H.264 decoders handle up to level 5.2
(4096 × 2304), and every editor and export path was tested with 4K recordings.

### 2.5 Rotation, odd sizes, non-square pixels, interlacing, HDR

- **Rotation**: ffmpeg rotates frames by the display matrix by default (autorotate) and the
  proxy is written upright with no rotation tag (checked on the bundled build). The plan swaps
  width and height for 90° and 270°, so `Project.width/height` match the upright picture.
- **Odd sizes** (641 × 361): rounded down to even (640 × 360); the fit filter scales without
  stretching (`fitFilters` adds no bars when the aspect is kept within a pixel).
- **Non-square pixels** (`SAR 4:3`, DV, some phones): the display width is `width × SAR`, and
  `fitFilters` ends in `setsar=1`.
- **Interlaced** (`top first` / `bottom first` in the log): `yadif` is added before scaling.
- **HDR** (transfer `smpte2084` or `arib-std-b67`): when the bundled ffmpeg has `zscale` and
  `tonemap` (checked once with `-filters`), the picture is tone-mapped to SDR BT.709
  (`zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`).
  A picture that tags only its transfer (`unknown/unknown/smpte2084`) gets the BT.2020 primaries
  and matrix it leaves out first (`setparams=color_primaries=bt2020:colorspace=bt2020nc`), or
  zscale finds no path to linear light; tags that are present are kept.
  Without them it is imported anyway with the note *This is an HDR video, so its colours may look
  paler in Flown.*

### 2.6 How the imported project is marked, and why `capture` stays a recording's shape

`Project.source` (new, optional) records where the video came from: `{ kind: 'import', fileName,
… }` (§3). `capture` gets ordinary values: `method: 'chromium'`, `cursorInVideo: true` (whatever
cursor the video shows is in its pixels), `region: null`, `target: 'screen'`, `fps: 30 | 60`. A
new `capture.method` value was rejected: `method` is matched as `'native' | 'chromium'` in the
recorder, finalize and their tests, which belong to another team, and nothing in the editor needs
to tell an import from a Chromium recording **for rendering**; only the explanations differ, and
they read `source`.

`cursor.json` is written as an empty, invalid track (`valid: false`). The editor already treats
an invalid track as "no cursor data" everywhere (window recordings without positions): the smooth
cursor, click effects and sounds, cursor focus, cursor spotlights and tilt are disabled, and
`polishAvailability` skips auto zoom with `no-input`. So the "never crashes" part rests on paths
that ship today; the import adds explanations (§5.4) and a test that walks every tab.

### 2.7 Drop gives a path through the preload; picks never leave main

The picker runs in main (`dialog.showOpenDialog`), so its path never passes through the renderer.
A dropped file is a `File` in the renderer; Electron 32+ no longer has `File.path`, so the preload
exposes `webUtils.getPathForFile` (the only supported way) as `importPathForFile(file)`. Main
validates that path like any untrusted input (§7).

### 2.8 One import at a time, independent of recording

Main runs at most one import; a second request gets *Another video is being imported. Wait for it
to finish.* Home disables the button and ignores drops while it records, processes or imports
(`idle`), so an import and a recording never compete for the CPU. Main does not look at the
recording state: that would mean reading `recordingIpc.ts`, which another team owns, and the
renderer-side guard covers the only UI that starts both.

## 3. Data model

### `src/shared/types.ts` (additive; one optional field and one new interface)

```ts
/** Where a project's video came from when Flown did not record it (docs/design/import-video.md). */
export interface ImportedSource {
  kind: 'import'
  /** The file's name when it was imported (no folder), shown in the editor. */
  fileName: string
  /** Size of the imported file in bytes. */
  bytes: number
  /** ffmpeg's container and codec names: 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac' (null: no sound). */
  container: string
  videoCodec: string
  audioCodec: string | null
  /** The picture as the file stores it, before rotation, and its rotation (clockwise degrees). */
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
  /** Average frame rate the file reports (null: not reported). */
  fps: number | null
  /** The picture was HDR and was tone-mapped (true) or imported as is (false); absent: SDR. */
  hdr?: boolean
  importedAt: string
}

export interface Project {
  …
  /** Absent: recorded in Flown (every project from before NW-07). */
  source?: ImportedSource
}
```

### Migration

`migrateProject` (`src/shared/engine/project.ts`) is **not changed**: it spreads every field it
does not handle (`...rest`), so `source` survives load and save as stored, and a project without
it gets no key at all. Old projects therefore load **byte-for-byte unchanged** (tested: the
migration of every fixture project is deep-equal before and after this branch, and a saved old
project has no `source` key). Readers never trust the stored value: `importedSource(project)` in
`src/shared/import/imported.ts` returns a sanitised `ImportedSource` or null (a hand-edited
`"source": 5` reads as "recorded"), and every UI check goes through it.

`ProjectSummary`, `cursor.json`'s format, settings, style defaults and the brand kit are unchanged.

### Files in an imported project folder

| File | When |
|---|---|
| `import.json` | Written first; `{ version: 1, startedAt, fileName }`. Removed when the project is written. A folder holding it and no `project.json` is a cancelled or crashed import (§4.6). |
| `screen.mp4` | The proxy (§2.1). Written as `screen.part.mp4` (ffmpeg picks the format by extension) and renamed when ffmpeg succeeded, retried for about 1.5 s while another app (an antivirus scan, OneDrive) holds the new file. |
| `cursor.json` | The empty track `{ samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }`. |
| `project.json` | Written last. |
| brand kit files | When the brand kit applies to new projects (`applyStyleDefaults`). |

## 4. Behaviour

### 4.1 Steps (`src/main/importVideo.ts`, `importVideo(path, signal, onProgress)`)

1. **Check the file** (§7): absolute path, extension in the list, regular file, 1 KB to 64 GB,
   first 64 bytes look like MP4/MOV (`ftyp`, `moov`, `mdat`, `wide`, `free`, `skip` box at
   offset 4) or Matroska/WebM (`1A 45 DF A3`). Wrong content for the extension family is refused.
2. **Probe**: `ffmpeg -hide_banner -nostdin -i <file>`, 30 s time limit, log capped at 256 KB.
   `parseProbe(log)` → `ProbeInfo`.
3. **Plan**: `planImport(probe, { bytes, tonemap })` → refusal or `ImportPlan` (pure, §5).
   A file that does not say how long it is (`Duration: N/A`: a live WebM, an unfinished MKV) is
   measured first (`measureDuration`): `-map 0:<video> -c copy -stats_period 3600 -progress
   pipe:1 -f null -` (no decoding, about as fast as the file can be read), 10 min limit; the
   final `out_time_us` (the last packet's time, a few frames short when frames are reordered,
   well within the cap's 2 s) is the length, and the plan is made again with it. So the length
   limits, the space check, the progress, the time left and the cap apply as to a stated length,
   and a file whose timestamps jump hours ahead is not padded with frames for hours. When the
   length cannot be told (ffmpeg failed, a read error, over the time limit), it stays unknown.
4. **Decode test**: `-map 0:<video> [-map 0:<audio>] -frames:v 1 -f null -`, 60 s limit (no
   `-t`: the picture of a stream-copy trim can start seconds after its sound).
   If it fails with the audio stream mapped, it is run again without: success means the sound
   cannot be read, so the import goes on without sound and with a note. Failure without audio is
   a refusal with the codec sentence (§5.3). DRM is found before this, by the probe (encrypted
   codec tags, ffmpeg's messages) and by a scan of the first and last 8 MB of an MP4/MOV for a
   protected sample entry (`sinf` with `frma`): ffmpeg shows a CENC-encrypted track with its
   original codec and merely fails to decode it. The test decode does not use `-xerror` (files
   that start mid-GOP log errors before their first good frame); it passes when a frame was
   decoded and ffmpeg exited cleanly.
5. **Space**: `fs.statfs` on the projects folder; refused when free space is below the plan's
   estimate (§5.2).
6. **Folder**: `projects.createProjectDir()` (the same never-reused `rec-…` ids as recordings),
   then `import.json`.
7. **Encode**: `proxyArgs(input, part, withAudio, { fps, size, progress: true, encoder })`
   with the video and audio maps pointed at the chosen streams, the plan's pre-filters (yadif,
   tone-map) placed first in `-vf`, and `-t` at the stated length plus 2 s (`-t 14400` when the
   length could not be measured; never more than 4 h): the encode follows the packets' timestamps, which a
   header can understate, and a constant rate fills every gap with frames; through
   `encodeWithFallback` (the first working GPU encoder, then libx264), like a recording. Progress
   is frames ÷ (duration × fps). The output goes to `screen.part.mp4`, renamed to `screen.mp4`.
   ffmpeg ends the copy without an error where the file ends, and also where reading it fails (a
   share that dropped and came back, a cloud file whose download failed, a failing card reader:
   it logs `[in#0/… @ …] Error during demuxing: Input/output error` and exits 0). So the import
   is refused rather than saved shorter when the log shows such a read error (`READ_ERROR_RE`;
   *Invalid data found* is not one: a damaged file keeps what can be read), or when the file,
   checked again afterwards, is gone or its size or modification time changed (cut short,
   rewritten, its drive or share disconnected).
8. **Project**: `createProject` with the frame-count duration (`frames / fps`, like `finalize.ts`),
   the proxy's size and `hasAudio`; then `applyStyleDefaults` (the saved look and the brand kit,
   like a recording); then `autoZoom: false`, `zoomSettings.auto.enabled: false`, `zooms: []`,
   `source`, `name` (§4.4). `cursor.json`, then `project.json`, then `import.json` is removed.
9. Returns `{ ok: true, projectId, notes }`.

A failure or cancel at any step after 6 removes the whole folder (it was created by this import
and holds nothing else). Cancel kills ffmpeg at once (`AbortSignal`, `runFfmpegProgress`).

### 4.2 Sound

- The first audio stream that is not an attached picture is used. With more than one (OBS
  multi-track, a phone's commentary track), the note says *This video has 3 sound tracks; Flown
  uses the first one.*
- Sound is placed on its timestamps (`ON_TIMESTAMPS`, as recordings), re-encoded to AAC 192 kbit/s.
  It starts at 0 (`first_pts=0`): sound that starts after the picture (an audio delay, a
  stream-copy trim) is padded with silence, since the editor's level and speech analysis read the
  track from its first sample.
- Mono stays mono; more channels are mixed down to stereo (`aformat=channel_layouts=stereo|mono`),
  as a recording's proxy is: AAC refuses some layouts (5.1.4, 22.2) and the WebM export's Opus
  others (2.1, 4.0, more than 8 channels).
- No sound stream: `hasAudio: false` (the Audio tab already says *This recording has no sound.
  You can still add music below.*).
- No stems: `audioStems` is absent; the editor plays the proxy's track, as for Chromium recordings.

### 4.3 Video stream choice

The first video stream that is not an `attached pic` (cover art in MP4, MKV and M4V files). The
map uses the stream's absolute index (`0:<n>`), never `0:v:0`, which can be the cover.

### 4.4 Name

The file name without its extension, with control characters removed, whitespace collapsed and at
most 120 characters; empty → *Imported video*. `createdAt` is the import time (the library sorts
by it, so the new project comes first).

### 4.5 Progress and time left

`importProgress(frames, plan)` → `{ stage: 'converting', progress: 0..1 }`; `etaSeconds(start,
now, progress)`: shown after 5 s and 3 % progress, rounded to *About N min left* (N ≥ 1) or *Less
than a minute left*; hidden when the length is unknown (it could not be measured, §4.1 step 3). Main throttles progress messages to 10
per second.

### 4.6 Leftovers

At start-up (`registerImportIpc`) and before each import, `sweepAbandonedImports()` removes every
folder in the current projects root (imports never go to a legacy root) whose name matches the project id pattern and that
holds `import.json` but no `project.json`, after checking it is a directory and not a link. A
folder with a `project.json` is never removed, even if `import.json` survived (the project
opens; the marker is removed on the next sweep). The sweep and the clean-up after a cancel or a
failure remove `import.json` last: when a file cannot be removed yet (held by an antivirus scan or
OneDrive), the folder keeps its marker and the next sweep tries again.

### 4.7 The editor with an imported project

`importedSource(project)` non-null:
- **Cursor tab**: the callout reads *This video was imported, so Flown has no cursor data for it.
  The smooth cursor, click effects and click sounds are off; a cursor in the video stays as it
  was.* (`data-testid="cursor-not-recorded"` with `data-imported`). The controls stay disabled as for any invalid track.
- **Zoom tab**, Auto zoom: *This video was imported, so there are no clicks or typing to zoom on.
  Add zooms yourself: double-click the zoom track (or press Z).* (`data-testid="auto-zoom-summary"` with `data-imported`,
  with the real shortcut through `orPress`). Manual zooms with a fixed or region focus work as
  today; *Follow cursor* is disabled with its existing title.
- **Effects tab**, Keyboard shortcuts: *This video was imported, so no keyboard shortcuts were
  recorded.*
- **Camera tab**: *This video was imported, so it has no separate camera.* (replaces *This
  recording has no camera. Pick a camera on the home screen before recording.*). The director
  shows only with a camera file, so it never shows.
- **Command palette and shortcuts** that need cursor data: the reason reads *This video was
  imported, so it has no cursor data* instead of *This recording has no cursor data*
  (`noCursorText(project)`).
- Polish in one click: unchanged; auto zoom is skipped with *No clicks were captured*, the
  director with *This recording has no camera*.
- **Export**: the file is first offered as *demo (edited).mp4* (`exportBaseName`), never under the
  imported video's own name: the save dialog opens in Videos, often where the original is, and
  one Replace click would overwrite it.

## 5. Rules with numbers (`src/shared/import/plan.ts`)

### 5.1 Accept

| What | Rule |
|---|---|
| Extensions | `.mp4 .m4v .mov .mkv .webm` (case-insensitive) |
| File size | 1 KB ≤ size ≤ 64 GB |
| Duration | 0.5 s ≤ d ≤ 4 h, stated or measured (`N/A`, live WebM: §4.1 step 3); a known length is cut at d + 2 s; one that could not be measured is accepted and cut at 4 h (`-t 14400`) |
| Picture | each side 16 to 16384 px; long ÷ short ≤ 10 |
| Codecs | whatever the bundled ffmpeg decodes (decode test): H.264, HEVC, VP8, VP9, AV1, ProRes, MPEG-4 … |
| Proxy rate | 60 when the average rate > 31 fps, else 30 (unknown: 30) |
| Proxy size | display size × min(1, 3840 ÷ long, 2160 ÷ short), each rounded down to even, ≥ 16 |

### 5.2 Space

`proxyBitrate = clamp(w × h × fps × 0.15, 4 Mbit/s, 40 Mbit/s)` (the bitrate `proxyArgs` gives the
Media Foundation encoder: 9.3 Mbit/s at 1080p30, 37 Mbit/s at 4K30), so
`needed = proxyBitrate ÷ 8 × duration × 1.25 + 512 MB` (sound and margin; sizes in binary GB, as
Explorer shows them). 1 h 1080p30 → 5.4 GB; 1 h 4K30 → 20.0 GB. A length that could not be measured: `needed = 2 × fileBytes + 512 MB`. Refused when free space is
smaller: *There is not enough free space for this video: it needs about 5.4 GB and 2.1 GB is free.*

### 5.3 Refusals (exact copy)

| Case | Message |
|---|---|
| Extension | *Flown can import MP4, MOV, MKV and WebM videos.* |
| Not a file / missing | *That file could not be opened.* |
| Empty or < 1 KB | *This file is empty.* |
| > 64 GB | *This file is too large to import (64 GB at most).* |
| Content is not the container | *This file is not a video Flown can read, even though its name ends in .mp4.* |
| ffmpeg cannot open it | *This file could not be read as a video (it may be damaged).* |
| No video stream / only cover art | *This file has sound but no picture. To use it as music, open a project and add it in the Audio tab.* (no streams at all: *This file has no video in it.*) |
| Encrypted (codec tag `encv`, `enca`, `drms`, `drmi`, or "encrypt" in the log) | *This video is copy-protected (DRM), so it cannot be edited.* |
| Decode test fails | *Flown cannot read this video's format (prores_raw). Convert it to MP4 (H.264) and try again.* |
| Duration 0 or < 0.5 s | *This video is too short to edit (less than half a second).* |
| Duration > 4 h | *This video is longer than 4 hours. Trim it or split it into parts first.* |
| Side < 16 or > 16384 | *This video's picture size (20000 × 1080) is not supported.* |
| Aspect > 10 : 1 | *This video's picture is too narrow to edit (12000 × 1080).* |
| Disk | §5.2 |
| Busy | *Another video is being imported. Wait for it to finish.* |
| Several files dropped | *Drop one video at a time.* |
| Encoder failed | *The video could not be converted (<ffmpeg's last line>).* / disk full: *Your disk is full. Free some space and try again.* |
| File gone, changed or not readable to the end during the copy | *The video could not be read to the end (it changed, or its drive was disconnected). Try again.* |

### 5.4 Notes (shown after an import that succeeded with something to say)

- *This video has 3 sound tracks; Flown uses the first one.*
- *The sound in this video could not be read, so it was imported without sound.*
- *This is an HDR video; its colours were converted for normal screens.* / *… so its colours may
  look paler in Flown.* (no tone-map filters)
- *This video was larger than 4K, so the editing copy is 3840 × 1920.*
- *Only the first 4 hours were imported.* (the copy reached the 4-hour cap and the file had more
  than it said)

## 6. UI and copy

- **Button** (`ImportButton.tsx`): ghost button with the upload icon, label *Import video*,
  title *Open a video made with another app as a new project*. In `.home-section-head` of Recent
  recordings. Disabled while not idle.
- **Empty library**: the existing empty state gets one more line: *Or import a video made with
  another app: use Import video or drop it here.* (inside `ImportDropZone`, which wraps the
  section's content).
- **Drop zone** (`ImportDropZone.tsx`): wraps the library section. `dragenter`/`dragover` with
  `Files` in `dataTransfer.types` shows an overlay (dashed `--accent` border on `--accent-softer`,
  text *Drop a video to import it* in `--accent-text` and *MP4, MOV, MKV or WebM* in `--text-2`). Only
  file drags are accepted (`preventDefault` only then), so text drags and the app's other drags
  are unaffected; the window-level guard against navigating to a dropped file stays as it is.
- **Dialog** (`ImportDialog.tsx`), `role="dialog"`, `aria-modal`, labelled by its title, focus
  kept inside with `useModalFocus` (Esc = Cancel while running, Close afterwards):
  - running: title *Importing "screen-capture"*; status line (`role="status"`, polite):
    *Checking the video…* → *Making an editing copy…* → *Finishing…*; progress bar
    (`role="progressbar"`, `aria-valuenow`); *42 % · About 3 min left*; button **Cancel**
    (focused).
  - done with notes: title *Imported "screen-capture"*; the notes as a list, which describes the
    dialog (`aria-describedby`), so a screen reader reads them with the title; **Open in editor**
    (focused) and **Close**.
  - done without notes: the editor opens at once.
  - refused or failed: title *Could not import "screen-capture"*; the message (`role="alert"`);
    **Close** (focused).
  - cancelled: the dialog closes.
- **Contrast** (WCAG AA; the modal is on `--surface-1` `#141418`, ratios below on `#0e0e11`, all within 0.6 of those on `--surface-1`): `--text-1` and `--text-2`
  (17.6 : 1 and 7.5 : 1) for body text, `--warning-text` (#fcd34d, 13.4 : 1) for notes,
  `--danger-text` (#fb7185, 7.2 : 1) for the error, `--accent-text` (#9d94ff, 7.5 : 1; 7.1 : 1 on
  `--surface-1` behind the drop zone) for the drop zone's heading; the progress fill uses
  `--accent` on `--surface-sunken` (non-text, 3 : 1 is enough: 3.9 : 1).

## 7. Security

- **Paths**: a picked path never leaves main. A dropped path comes from the renderer and is
  checked in main: a string under 4096 characters, absolute, no NUL, an allowed extension, `stat`
  is a regular file (not a directory, device, pipe or FIFO; `fs.stat` follows a link to its
  target, which is then checked the same way), and its first bytes match the container. The file
  is opened read-only by ffmpeg; nothing is written next to it.
- **Sender check**: `import:*` handlers accept calls only from the app's page
  (`isAppUrl(e.senderFrame.url)`, as `assetIpc.ts` and `brandKitIpc.ts`), so a page that somehow
  loaded elsewhere cannot make main read files.
- **ffmpeg runs** with an argument array (no shell), `-nostdin`, `windowsHide`, the file passed as
  one argument after `-i` (a name starting with `-` is safe: it follows `-i`, and the path is
  absolute so it cannot start with `-`). Probe, length measurement and decode test have time
  limits (30 s, 10 min, 60 s) and output caps; the encode can be cancelled and is killed on quit (`killAllFfmpeg` covers every
  `runFfmpegProgress` process).
- **Sizes** are checked before any work (§5.1) and the disk before writing (§5.2), so an absurd
  file cannot fill the disk or run for days.
- **Project folder**: created by `createProjectDir` (validated ids, never reused); the cleanup
  only removes folders this feature marked, matching the id pattern, never following links.
- **Parsing**: the probe parser works on a capped string with linear regular expressions (no
  nested quantifiers), and every number it reads is checked to be finite and in range.
- **Names**: the file name is shown as text (React escapes it), stored after cleaning (§4.4) and
  never used to build a path.
- **Metadata**: the editing copy keeps none of the file's tags (a phone's GPS location, make and
  model, author, comments) or chapters (`-map_metadata -1 -map_chapters -1` in `importArgs`).
  Exports take only the project's own chapters and no input's tags (`chapterArgs` in
  `exportArgs.ts`), which also covers projects imported before this rule; a failed encode logs
  ffmpeg's report without its `Metadata:` blocks (`withoutMetadata`).
- Not weakened: `security.ts`, the sandbox, `guardWebContents` (a file dropped outside the drop
  zone still cannot navigate the window), the media protocol's file-name rule (`screen.mp4`).

## 8. Undo

An import is not an edit: it creates a project, so there is nothing to undo in the editor; the
project can be deleted from Home. Inside the editor, every edit of an imported project is the same
one-step undo as for a recording. The import changes no existing project or setting.

## 9. Performance

The encode costs what a recording's processing costs: x264 `superfast` runs 3–6× real time at
1080p30 on a 4-core laptop, a GPU encoder faster; software decoding of 4K HEVC is the slowest
part (about 1–2× real time). The dialog shows the time left; Cancel is immediate. The probe and
decode test take under a second for a normal file. No new renderer work: the editor reads a proxy
as it does today.

## 10. Files

New:
- `src/shared/import/probe.ts` — `parseProbe(log): ProbeInfo`, `ProbeStream`, `isEncrypted`.
- `src/shared/import/plan.ts` — `IMPORT_LIMITS`, `IMPORT_EXTENSIONS`, `planImport(probe, ctx):
  PlanResult`, `proxySizeFor`, `proxyFpsFor`, `spaceNeeded`, `importArgs(base, plan)`,
  `importName(fileName)`, `sniffContainer(head)`, `etaText(…)`, `IMPORT_COPY`.
- `src/shared/import/imported.ts` — `importedSource(project): ImportedSource | null`, the editor's
  explanation strings.
- `src/shared/api/import.ts` — `ImportApi`, `ImportProgress`, `ImportResult`.
- `src/main/importVideo.ts` — `checkImportFile`, `probeFile`, `decodeTest`, `importVideo`,
  `sweepAbandonedImports`, `registerImportIpc`, with a `deps` seam (ffmpeg runner, `statfs`,
  filters probe) for tests.
- `src/preload/import.ts` — `importApi`.
- `src/renderer/src/import/{ImportButton,ImportDropZone,ImportDialog}.tsx`, `useVideoImport.ts`,
  `import.css`.
- `tests/importProbe.test.ts`, `tests/importPlan.test.ts`, `tests/importMain.test.ts`,
  `tests/importedProject.test.ts`, `tests/e2e/import-video.e2e.cjs`.

Shared, additive lines:
- `src/shared/types.ts`: `ImportedSource` and `Project.source?`.
- `src/shared/api.ts`: one import, `& ImportApi`, one re-export.
- `src/preload/index.ts`: one import and `...importApi`.
- `src/main/index.ts`: one import and `registerImportIpc()`.
- `src/renderer/src/views/Home.tsx`: the button in the library head, the drop zone around the
  library's content, the dialog; about 10 lines.
- Panels: `CursorPanel.tsx`, `ZoomPanel.tsx`, `EffectsPanel.tsx`, `CameraPanel.tsx` one condition
  each; `Editor.tsx` the `noCursor` text.

Not touched: `src/main/projects.ts` (the import uses its exported `createProjectDir`,
`projectDir`, `projectsRoot`, `writeProject`, `writeCursor`), `project.ts`, the recording side,
`proxyArgs.ts`, `electron-builder.config.cjs`, `scripts/*`, `resources/*`, `package.json`
dependencies.

## 11. Risks

- **ffmpeg log format** changes with an ffmpeg upgrade → parser tests on real logs; unknown lines
  are ignored, and the decode test is the final word on readability.
- **Windows ffmpeg build differences** (filters available, decoders): the tone-map is used only
  when the filters are listed; decoders are proven by the decode test. Needs a Windows check.
- **Long imports** block Home for their length → progress, time left and Cancel; a "finish
  later" queue is left for later.
- **Disk estimate** can be low for very noisy camera footage at CRF 17 → 25 % margin plus 512 MB;
  a full disk mid-encode fails cleanly (*Your disk is full…*, from ffmpeg's *No space left on
  device*, whatever its last log line) and removes the folder; the next encoder is not tried.
- **HDR tone-map** look differs from the phone's own → a note says the colours were converted.
- **Drag and drop** of a file from a zip or a virtual folder gives an empty path → *That file
  could not be opened.*

## 12. Left for later

- Remux without re-encoding when the file already meets the proxy rules (option D).
- Keeping 24/25/50 fps as the project rate.
- Choosing the sound track when there are several.
- Importing a separate camera file with the screen video, and AVI / WMV / MTS containers.
- Auto zoom for imported videos from motion in the picture (F-28), watch folders.
- Importing several files at once (a queue), and "finish later" for imports.

## 13. As built

Built as designed, with these differences and additions (most from the adversarial review):

- **Non-square pixels** are widened to square before proxyArgs' fit (`scale=w=trunc(iw*sar/2)*2:h=ih,setsar=1`
  in the plan's pre-filters): the fit scales stored pixels and would otherwise pad an anamorphic
  picture with bars. Tested on the pixels of a DV-style 720 × 576 SAR 16:15 file.
- **Tone-map** ends in `format=yuv420p`, so zscale (not swscale's BT.601 default) converts to
  BT.709 YUV. Tested end to end on a 10-bit HEVC PQ file.
- **DRM**: besides codec tags and ffmpeg's messages, the first and last 8 MB of an MP4/MOV are
  scanned for a protected sample entry (`sinf` box whose first child is `frma`); ffmpeg reports a
  CENC-encrypted track as plain `avc1` (tested with a file ffmpeg itself encrypted).
- **Decode test** without `-xerror`: a frame decoded and a clean exit is the test.
- **Unknown length**: measured before the copy from the video's packets (§4.1 step 3), so the
  length limits and the space check apply; the copy's frame count still gives the project's
  length and decides the 0.5 s minimum (tested with a live WebM, and with unfinished MKVs whose
  last frame is at 50 min, refused for space, and at 5 h, refused as too long).
- **Quit and reload**: `disposeImport()` (from `will-quit`) stops the import and the probe
  processes; an import whose page reloads or closes is cancelled (`did-start-navigation` of the
  main frame, `destroyed`), so nobody is left with a stuck "Another video is being imported".
- **Paths** with a line break are refused (they could forge lines in ffmpeg's log).
- **Dialog**: Cancel is disabled (and Esc does nothing) while the project is written
  (*Finishing…*); the bar of an unknown length is an animated indeterminate bar (stripes with
  reduced motion); the time left counts from the start of the copy.
- **Shortcut notices** in the editor read *This video was imported, so it has no cursor data*
  through `noCursorText(project)`; the panel titles (*No cursor data in this recording*) are
  unchanged, as they stay true.
- `src/renderer/src/editor/ImportedNote.tsx` was not needed: each panel uses one condition and
  `IMPORTED_COPY`.
- `ImportDeps.decodes` was added as a seam so the sound-less fallback is tested in main.
