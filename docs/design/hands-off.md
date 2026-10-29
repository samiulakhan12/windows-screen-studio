# Hands-off long jobs and app health (F-12, X-03, F-26, F-11)

Status: built for 0.7.0 (branch `feat-hands-off`). This note covers four features that make Flown
easier to leave alone and easier to support:

| Id | Feature | One line |
|---|---|---|
| F-12 | Hands-off long jobs | Taskbar progress, Pause/Stop on the taskbar thumbnail, an "Export finished" notification with Open / Show in folder, the PC kept awake, a clean pause around sleep |
| X-03 | Diagnostics bundle | A small rotating, redacted log, and "Copy diagnostics" in Settings that shows the text before it copies it |
| F-26 | Storage manager | Disk use per recording and in total, clean-up rules the user approves, Recycle Bin only, never outside the projects folder |
| F-11 | Export bundle | SRT / VTT, chapter list, thumbnail and description next to the video, and "one file per chapter" |

Nothing here changes `project.json`: old projects load byte for byte as before (§9). New state
lives in userData (`logs/`, `storage.json`) and in the export dialog's localStorage.

---

## 1. What the code does today (read before deciding)

* **Exports are driven by the renderer.** `src/renderer/src/editor/exporter.ts` `renderAll()` draws
  every frame and pushes it to `src/main/exportIpc.ts` (`export:start` / `export:frame` /
  `export:finish`), which feeds ffmpeg (`src/main/ffmpeg.ts`). ffmpeg writes a hidden
  `.<name>.partial-*` file (`exportJob.ts` `partialPath`) that is renamed into place only after a
  successful finish (`moveIntoPlace`); a cancel or a crash deletes it (`cancelActive`, the
  `LeftoverLog` in userData). So a stopped export **never leaves a corrupt file**: the old file, if
  any, is untouched, and the new one does not exist until it is complete.
* **Batch export** (`exportBatch`) runs files one after another into a folder chosen with
  `export:chooseFolder`; each path comes from `export:batchPath` (`freeBatchPath`: an existing file
  is never replaced, " (2)" is added). Finished files of a cancelled batch stay.
* **The main window never throttles in the background** (`windows.ts`: `backgroundThrottling:
  false`), so an export keeps its speed when the window is hidden, minimised or the screen is locked.
* **Captions on this PC** run in main (`src/main/aiIpc.ts` `ai:transcribe` →
  `ai/transcribe.ts`), with progress sent to the page as `ai:transcribeProgress`
  (`TranscribeProgress`: `done/total`, and `fraction` on this PC). Cancel (`stopTranscription`) keeps
  the parts already made in `<project>/.cache/transcript-parts`. The speech helper's watchdogs are
  already reset when the PC wakes (`speechIpc.ts`: `powerMonitor.on('resume', resetSpeechWatchdogs)`).
* **Voice and speech analysis** (sound levels and the speech detector) run through
  `export:analyzeAudio` → `audioAnalysis.ts` `analyzeAudio()`.
* **No log file.** Main logs with `console.*`; nothing is kept. `nativeCapture.ts`
  `probeNativeCapture()` (never rejects, has a timeout) and `hwEncoders.ts` `detectH264Encoders()`
  answer the hardware questions; each project's `capture` (`types.ts` `CaptureInfo`) records how it
  was recorded.
* **A project folder** (`projects.ts`, `recording/finalize.ts`) holds `project.json`,
  `cursor.json`, the proxies `screen.mp4` / `webcam.mp4`, the stems `mic.m4a` / `system.m4a`, copied
  assets (`music.*`, `overlay-<n>.*`, `font-<n>.*`), `script.txt`, and `.cache/` (transcript parts,
  `speech.json`). **The proxies are the only copy of the recording**: `finalize.ts` deletes the raw
  capture once they exist ("The proxies are now the source of truth"). An unfinished recording has a
  `recording.json` manifest and raw files instead.
* **Deleting a project today is permanent** (`projects:delete` → `fs.rm`). Not changed here (Home is
  another area); the storage manager itself only ever uses the Recycle Bin.

## 2. Decisions

### 2.1 F-12 Where the job registry lives — **main process**, fed by both sides
* *Chosen:* `src/main/longJobs.ts` keeps every running long job (export, captions, analysis) and is
  the one owner of the taskbar button, the thumbnail buttons, the keep-awake blocker, the
  notifications and the power events. Jobs that run in main (captions, analysis) register directly;
  exports, which the renderer drives, register through three small IPC calls (`jobs:begin`,
  `jobs:update`, `jobs:end`), and commands go back to the page that owns the job (`jobs:command`).
* *Rejected:* counting frames in `export:frame` to derive progress in main: with the WebCodecs
  routes the page sends batches of encoded bytes, not frames, so main cannot know the fraction.
* *Rejected:* a renderer-only registry: the taskbar, notifications and power events are main-only
  APIs, and captions run in main.

### 2.2 F-12 Pause — **a gate in the export loop**
* *Chosen:* a pausable export waits at a gate before drawing its next frame
  (`src/renderer/src/editor/pauseGate.ts`, one awaited line in `renderAll`). ffmpeg simply waits on
  its input; nothing is killed, nothing is written meanwhile. The fps / ETA window is reset after a
  pause so the estimate is not skewed.
* Pause is offered while frames are being rendered. It is **not offered while finalizing** (ffmpeg's
  own passes: muxing, two-pass size targets, GIF palettes), where only Stop is.
* Captions: no Pause (a helper run cannot be held safely mid-part); Stop keeps the parts made, as
  the Captions tab's Cancel does. Analysis: neither (seconds long).
* *Rejected:* suspending ffmpeg (`SIGSTOP` / `NtSuspendProcess`): not portable, and would hold the
  partial file open indefinitely.

### 2.3 F-12 Lock and sleep
* **Lock (`lock-screen`): the job keeps running.** "Hands-off" means a user can press Win+L and
  walk away; the window is never throttled (§1) and the PC is kept awake (below). *Rejected:* the
  roadmap's first sketch "lock pauses": it would make a locked PC finish nothing, the opposite of
  the feature. The log notes lock and unlock so diagnostics show it.
* **Keep awake:** `powerSaveBlocker.start('prevent-app-suspension')` while at least one job runs
  and is not paused, stopped otherwise (a paused export may wait for hours). It stops idle sleep; it does not keep the display on (the display may turn
  off, which costs nothing). *Rejected:* `prevent-display-sleep`: burns the screen for nothing.
* **Sleep that happens anyway** (lid closed, battery critical, Start › Sleep): on `suspend` every
  running pausable job is paused (marked *paused for sleep*); on `resume` those jobs are resumed after
  **3 s**, so the GPU and disk are back first. A job the user paused stays paused. The notice "Paused
  while the PC slept" shows in the export dialog until it resumes. This is best effort: Windows may
  freeze the app before the page handles the pause; the guarantee that no file is ever corrupt comes
  from the temp-file-and-rename of §1, not from the pause. If the GPU encoder is lost across sleep,
  the export's existing encoder fallback restarts it on the next route (`exportVideo`), as today.
* **Shut down / quit while a job runs:** unchanged: `before-quit` cancels the export and deletes its
  partial file (`exportIpc.ts`).

### 2.4 F-12 Notifications
* Electron 44 supports notification buttons on Windows (`NotificationConstructorOptions.actions`,
  the `action` event). On a successful export: **"Export finished"**, body the file name and size,
  buttons **Open** and **Show in folder**; a click on the body focuses Flown. A batch or chapter
  export notifies once at its end ("3 files exported"). On a failed export: "Export failed" and the
  first line of the reason.
* **Only when Flown's window is not focused** (otherwise the export dialog already says it), and the
  taskbar button flashes (`flashFrame`) until the window is focused. Captions finishing while the
  window is in the background notify "Captions are ready" (no buttons).
* **Open** opens only a file this session exported (`exportIpc.ts`'s `exportedFiles`), with
  `shell.openPath`; Show in folder uses `shell.showItemInFolder`. A path in a notification never comes
  from the page unchecked.
* Notifications need the AppUserModelID (`index.ts` already sets it) and the Start-menu shortcut the
  installer creates; unpackaged runs may show none (documented as Windows-unverified).

### 2.5 X-03 The log — **userData/logs, size-capped, redacted when written**
* *Chosen:* `src/main/appLog.ts` tees the main process's `console.log/info/warn/error` into
  `userData/logs/main.log`. **Cap 1 MiB; when the next write would pass it, `main.log` becomes
  `main.1.log` (replacing the older one)**: at most 2 MiB on disk. Lines are buffered and appended
  every **500 ms** (never a synchronous write per line), flushed synchronously at `will-quit`. Each
  line: ISO time, level, text, at most **2000 characters**.
* **Every line is redacted before it is written** (`src/shared/diagnostics/redact.ts`, pure): API
  keys and tokens (`sk-…`, `sk-ant-…`, `AIza…`, `Bearer …`, `key=`/`token=`/`api_key=` values, JWTs,
  hex or base64 runs of 32+ characters) become `<secret>`; e-mail addresses `<email>`; a path inside
  the app's own folders keeps only its place (separators may be doubled, as logged objects print
  them; segments may hold spaces and apostrophes) (`<userData>\logs\main.log`, `<projects>\rec-…\screen.mp4`,
  `<app>\…`, `<temp>\…`); **any other absolute path** (Windows drive, UNC, POSIX) becomes `<path>`.
  The user name therefore never appears (it is in every home path); as a last guard the home
  folder and the account name are replaced literally (any case, any separators) by `<path>` / `<user>`. File contents are never logged:
  only the lines the app already prints, and those never contain file contents. A failed ffmpeg
  run logs ffmpeg's report without its `Metadata:` blocks, dropped line by line as ffmpeg writes
  them, so keeping only the head and tail of a long report never splits a block (`metadataLines`
  in `src/main/recording/proxyRunner.ts`): an imported phone video's tags (GPS location, make and
  model, author, comments, chapter titles) are never logged.
* *Rejected:* `electron-log` (a new dependency for 150 lines of code), Crashpad uploads (no
  server, and privacy).
* The log is also redacted again when read for diagnostics (defence in depth: a log written by an
  older build, or by hand).

### 2.6 X-03 Diagnostics — **made in main, shown, then copied by main**
* `src/main/diagnostics.ts` collects (each part with a 10 s time limit, a part that fails says
  "unavailable"): app name and version, Electron / Chromium / Node versions, packaged or not; the
  Windows build (`process.getSystemVersion()`, e.g. `10.0.26100`), architecture, CPU model and logical
  cores, total memory; displays (size, scale, refresh rate; no names); GPU (`app.getGPUInfo('basic')`:
  vendor and device ids, driver version, plus `getGPUFeatureStatus()`); the detected H.264 encoders
  (`detectH264Encoders`); the capture helper's probe (`probeNativeCapture`: supported, window capture,
  cursor and border toggles, its encoders, reason); the capture method last used (the newest
  project's `capture.method` and `target`, and whether its cursor is in the video; imported videos
  and copies are passed over, since an import was never captured and a copy is dated when it was
  made); the number of recordings; and the **last 300 log lines**.
* Settings › Diagnostics: **Show diagnostics** fetches the text and shows it in a read-only box;
  **Copy diagnostics** then copies exactly that text (main's `clipboard.writeText` of the report it
  made itself, by id; the page never hands main text to copy). **Open log folder** opens
  `userData/logs`.
* The whole report goes through the redactor once more before it is shown.

### 2.7 F-26 Storage — **scan in main, rules in shared, Recycle Bin only**
* A scan walks **only the current projects folder** (`projects.ts` `projectsRoot()`), one level of
  project folders (`rec-…` names, `ID_RE`), each at most **8 levels deep and 20 000 entries**
  (a folder past that is reported as "at least" its counted size). Symbolic links and junctions are
  **never followed** (`lstat`); they count as their own size. Legacy roots (`brandMigration.ts`) are not
  listed: they are outside the projects folder and the clean-up must never touch them. They are only
  read for the names a shared file has there (below).
* Per recording: name (from `project.json`), created, **last used**, total bytes, of which
  **caches** (`.cache/`) and the rest; unfinished recordings (no `project.json`) are listed as
  "Unfinished" and are never part of a rule (Home's Unfinished recordings list handles them).
  Free and total disk space come from `fs.statfs`.
* **Files with several names** (Duplicate hard-links the media into a copy, vertical-video.md
  §4.7) take their bytes once: a file whose link count is above 1 is identified by its drive and
  file id (`lstat` with bigints, as NTFS ids pass 2^53) and counted once in a folder and once in the
  total. Each row still shows what its folder holds, with "· 1.9 GB shared with a copy". A removal
  is offered at the bytes it frees by itself (files with a name in another recording stay), and the
  review's totals and the result's "freed" count a shared file only when every one of its names
  goes. Only names in recording folders the library lists count (the projects folder and the legacy
  roots): once an original is in the Recycle Bin, its copy holds the media alone and is offered at
  its full size, while an original still in a legacy root keeps holding them.
* **Last used** = the later of: `project.json`'s modification time (every edit autosaves it) and
  the last time the editor opened it, noted in `userData/storage.json` (`storage:opened` from
  `Editor.tsx`, one additive line). An export needs the recording open, so it counts through that. *Rejected:* the file's access time (NTFS often does not update it), and a field in
  `project.json` (would change old projects on open, and the file belongs to the editor's autosave).
* **Proxies are not offered for deletion**: in Flown they are the recording itself (§1). The roadmap's
  "delete proxies" becomes "delete caches", which Flown rebuilds when needed (transcript parts are
  only a speed-up; the speech detector runs again in seconds).
* **Rules** (saved in `storage.json`, the user sets them in Settings):
  1. **Clear caches of recordings not used for** 30 days (choices 14 / 30 / 60 / 90, or Off;
     default 30). Optionally **"Do this automatically"** (default off): then it runs at most once a
     day, 60 s after the app starts, while no job runs and no recording is open.
  2. **Remove recordings not used for** N days (choices 30 / 60 / 90 / 180 / 365, default Off).
     Never automatic: **Review clean-up…** lists every recording it would remove (name, date, last
     used, size) with a tick each, and only **Move N to the Recycle Bin** removes them.
* **Run:** the page asks for a plan (`storage:plan`), shows it, and sends back the ids the user
  ticked. Main **scans again and recomputes the plan**; only items still in it are removed; paths are
  built by main (`<root>/<id>` or `<root>/<id>/.cache`), checked to be a real directory directly
  inside the real projects folder (no link anywhere on the way), and the open recording is skipped,
  asked again right before each move (a recording opened during a clean-up stays).
  Each goes to the Recycle Bin with `shell.trashItem`. **There is no permanent-delete fallback**: if the
  Recycle Bin refuses (a network drive, a full bin on some setups), that item is reported as "could not
  be moved to the Recycle Bin" and stays.
* *Rejected:* moving the library to another drive (roadmap F-26 "move the library"): the projects
  folder belongs to the recording side (`projectsRoot()`), and moving gigabytes safely needs its own
  design. Left for later.

### 2.8 F-11 Export bundle — **renderer makes the files, main writes them next to an exported file**
* Options in the export dialog (*Also save*, all off by default, remembered in localStorage):
  **Captions (SRT)**, **Captions (VTT)**, **Chapter list**, **Thumbnail**, **Description**, and
  **One file per chapter**.
* The contents reuse the existing pure code: `subtitleFile` (SRT/VTT, following cuts, speed and
  freezes), `outputChapters` + `youtubeChapters` (chapter list), `renderThumbnail` (the frame of the
  dialog's Frame slider, at that file's export size), and a small new `descriptionText` (title and the
  chapters as YouTube lines).
* **Names:** next to `Demo.mp4`: `Demo.srt`, `Demo.vtt` (same base name, so players pick them up),
  `Demo - chapters.txt`, `Demo - thumbnail.png`, `Demo - description.txt`.
* **Writing** (`exportBundle:write`, in `src/main/exportBundle.ts`): main accepts only an anchor
  file **exported in this session** (`exportIpc.ts` `exportedFiles`), builds the sidecar path itself
  from a fixed kind list (the page sends a kind, not a path), validates the content (subtitles with
  `validSubtitle`; text: a string ≤ 1 MiB without NUL; PNG: signature and ≤ 200 MB, as thumbnails
  today) and writes atomically (temp file + rename). **An existing file is never replaced** unless the
  export itself replaced the video of the same name (the user confirmed that in the save dialog),
  and then each kind only once, by that export's own bundle; otherwise " (2)" is added, like batch
  files. SRT gets a byte order mark, as `captionsIpc.ts` does.
* Formats: MP4 / MOV / WebM get all of them; M4A gets captions, chapter list and description (no
  thumbnail); GIF gets none ("GIFs are saved alone").
* **One file per chapter** (single mode only): one export per chapter into a folder, named
  `01 Intro.mp4`, `02 Billing.mp4` (two digits; three past 99). Each part is the project with its
  clips cut to the chapter's range (`chapterParts`, pure): the chapter starts are the export's chapter
  times (`outputChapters`, video time), mapped back to edit time (`videoToEdit`) and to clip pieces;
  everything else stays in source time, so zooms, text, captions and freezes inside the range appear
  exactly as in the full export. The first part starts at 0:00 (what comes before the first chapter
  belongs to it, as YouTube reads chapters). A part has no chapter markers of its own. Background
  music starts again at the start of each part, with its fades (it plays on each file's own clock).
  Refused (with the reason shown) when a freeze that keeps the sound playing runs across a chapter
  start: a part cannot begin inside a still, so it would differ from the whole export
  (`stillAcrossChapters`). Sound fades and the music start again in each part (the dialog says so).
  It runs through `exportBatch` (one added optional field per job: its own source), so the batch
  view shows progress and a cancel keeps the parts already done. The bundle options apply to each
  part (its own SRT, thumbnail at 1 s into the part, description "01 Intro").

## 3. Data model and compatibility

* **project.json: unchanged.** No field added; `shared/engine/project.ts` untouched.
* **userData/storage.json** (new, version 1):
  ```json
  { "version": 1, "rules": { "cacheDays": 30, "autoCaches": false, "removeDays": null },
    "used": { "rec-20261028-101500": "2026-10-28T10:20:00.000Z" }, "lastAutoClean": null }
  ```
  Missing or unreadable → defaults. `used` keeps at most 5000 ids (oldest dropped). Written with
  `writeFileAtomicSync`.
* **userData/logs/main.log, main.1.log** (new).
* **localStorage `export-bundle`** (new): `{ srt, vtt, chapters, thumbnail, description, perChapter }`
  booleans; unknown or missing → all off. Older settings keys are untouched.
* **Settings and old projects open unchanged**: no existing file changes shape.

## 4. Exact behaviour and numbers

| Item | Value |
|---|---|
| Taskbar | the export's fraction (normal), "paused" mode (yellow) while paused, indeterminate while finalizing / for captions without a fraction / analysis, red "error" for **4 s** after a failure, cleared when no job runs |
| Several jobs | the taskbar shows the export first, then captions, then analysis; a job younger than **1 s** is not shown (no flicker for quick analysis) |
| Thumbnail buttons | export rendering: **Pause** / **Resume** and **Stop**; export finalizing: Pause disabled, Stop; captions: Stop; none otherwise. Windows only |
| Keep awake | `prevent-app-suspension` while ≥ 1 job runs |
| Sleep | pause pausable jobs on `suspend`; resume those after **3 s** on `resume` |
| Notification | only when the window is not focused; export done / failed, captions ready |
| Log | 1 MiB + one 1 MiB rotation; flush every 500 ms; 2000 chars per line |
| Diagnostics | last 300 log lines; 10 s per probe |
| Storage scan | projects folder only; depth 8; 20 000 entries per recording |
| Rules | caches 14/30/60/90 days (default 30, manual); auto at most daily, 60 s after start; remove 30/60/90/180/365 days (default off), always confirmed |
| Bundle text | ≤ 1 MiB; PNG ≤ 200 MB |

## 5. UI and copy

**Export dialog, Settings panel** — a new row *Also save* (chips that toggle):
`Captions (SRT)` `Captions (VTT)` `Chapter list` `Thumbnail` `Description`, and below it a check
chip `One file per chapter`. Disabled chips say why in their tooltip: "This video has no captions
yet", "This video has no chapters", "GIFs are saved alone", "Audio files have no thumbnail",
"Add chapters first". With one file per chapter, the summary lists the files ("01 Intro.mp4 …")
and the button reads **Export 4 chapters…** (a folder dialog).

**Export dialog, running** — a **Pause** button next to *Cancel export* while rendering; paused:
"Paused · Resume to carry on" and **Resume**; after sleep: "Paused while the PC slept. Carrying on…".
**Done** — under the file: "Also saved: Demo.srt, Demo - thumbnail.png" (or "Could not save Demo.srt: …").

**Notification** — title "Export finished", body "Demo.mp4 · 24.1 MB", buttons "Open", "Show in
folder". Batch: "3 files exported" / body the folder name. Failure: "Export failed", body the reason's
first line. Captions: "Captions are ready", body the recording's name.

**Settings › Storage**
```
Storage
Recordings use 12.4 GB · 210 GB free on this drive          [Refresh]
  Demo of billing     28 Oct 2026 · used today        1.2 GB  [Show]
  …(sorted by size, largest first; caches shown as "incl. 40 MB cache")
Clean-up rules
  Clear caches of recordings not used for [30 days ▾]   ☐ Do this automatically
  Remove recordings not used for          [Off ▾]
  Removed files go to the Recycle Bin. Nothing outside the projects folder is touched.
  [Review clean-up…]
```
Review: "Clear caches (3 recordings, 120 MB)" / "Move to the Recycle Bin (2 recordings, 3.4 GB)",
each row ticked, then **Move to the Recycle Bin** (danger style) and **Cancel**. Result: "Moved 2
items to the Recycle Bin · freed 3.5 GB" or per item "Could not move … to the Recycle Bin".
Nothing to do: "Nothing to clean up with these rules."

**Settings › Diagnostics**
```
Diagnostics
If something goes wrong, copy this report and send it to us. It lists your Windows version,
graphics card, encoders and recent app messages. Keys, file contents and your own folders are left out.
[Show diagnostics]  [Open log folder]
(read-only box with the text)     [Copy diagnostics]  → "Copied"
```

Keyboard: every control is a button, select or checkbox in tab order; the report box is focusable
and scrollable; the review list is a list of checkboxes; Esc closes Settings as before. Colours use
the tokens in `styles.css` only (`--text-2` on `--surface-1/2` and `--danger-text`, all AA).

## 6. Security

* Every new IPC handler checks the sender is the app's page (`isAppUrl(e.senderFrame.url)`), as
  `aiIpc.ts` does. `jobs:update` is a one-way message: unknown ids and malformed values are ignored.
* **Notifications open only files exported in this session.** Commands from the taskbar go only to
  the page that began the job; a job whose page goes away (destroyed, crashed, navigated) ends.
* **Storage deletes**: ids must match `ID_RE`; the page only sends ids; main recomputes the plan from
  its own scan; the target is `realpath`-checked to be directly inside the real projects folder with
  no symbolic link or junction on the way; only `shell.trashItem`, never `fs.rm`; the open recording is
  skipped; unfinished recordings (manifest present or no `project.json`) are never targets.
* **Sidecar writes**: anchor must be in `exportedFiles`; the kind is from a fixed list; main builds
  the path (same folder, the video's base name and a fixed suffix); content validated by kind; no
  overwrite unless that export replaced the same-named video; atomic write.
* **Log and diagnostics** redact keys, tokens, e-mail addresses and paths outside the app's folders;
  the clipboard gets only main's own report; Open log folder opens a fixed folder.
* `security.ts`, sandboxing and existing checks are unchanged.

## 7. Files and exported signatures

Main
* `src/main/longJobs.ts` — `beginJob(spec): JobHandle` (`update`, `end`), `registerJobsIpc()`,
  `disposeJobs()`, `setTaskbarPort(port)` (test seam), `jobsSnapshot()`.
* `src/main/longJobsPort.ts` — the Electron implementation of `TaskbarPort` (progress bar, thumbnail
  buttons with 16 px icons drawn in code, flash, notifications, power events, keep-awake).
* `src/main/appLog.ts` — `startAppLog(dir, roots)`, `recentLogLines(n)`, `flushAppLogSync()`, `logDir()`.
* `src/main/diagnostics.ts` — `collectDiagnostics(deps)`, `registerDiagnosticsIpc()`.
* `src/main/storage.ts` — `scanProjects(root, deps)`, `trashPlan(...)`; `src/main/storageStore.ts`
  (storage.json); `src/main/storageIpc.ts` — `registerStorageIpc()`.
* `src/main/exportBundle.ts` — `sidecarTarget(...)`, `writeSidecar(...)`, `registerExportBundleIpc()`.
* Additive: `index.ts` (register calls, `startAppLog` first), `exportIpc.ts` (`isExportedFile`,
  `replacedExport`, the analysis job), `aiIpc.ts` (the captions job, 6 lines).

Shared (pure)
* `src/shared/jobs/longJobs.ts` — `JobKind`, `JobView`, `taskbarState(jobs, now)`, `thumbarButtons(jobs)`,
  `notificationFor(outcome)`, `JOB_TIMING`.
* `src/shared/diagnostics/redact.ts` — `redactLine(line, roots)`, `RedactRoots`.
* `src/shared/diagnostics/report.ts` — `formatDiagnostics(report)`.
* `src/shared/storage/rules.ts` — `StorageRules`, `sanitizeRules`, `cleanupPlan(projects, rules, now, openIds)`,
  `lastUsed(...)`, `formatBytes`.
* `src/shared/render/exportBundle.ts` — `BundleOptions`, `normalizeBundle`, `bundleKinds(options, format, has)`,
  `sidecarName(base, kind)`, `chapterParts(project)`, `partProject(project, part)`, `partFileNames(...)`,
  `descriptionText(...)`.
* APIs: `src/shared/api/jobs.ts`, `diagnostics.ts`, `storage.ts`, `exportBundle.ts`; preload files of
  the same names; additive lines in `src/shared/api.ts` and `src/preload/index.ts`.

Renderer
* `src/renderer/src/editor/pauseGate.ts`, `exportJobs.ts` (begins/updates/ends a job and answers
  taskbar commands), `exportBundleRun.ts` (writes the sidecars), `ExportBundleOptions.tsx`.
* `src/renderer/src/settings/HealthSections.tsx` → `StorageSection.tsx`, `DiagnosticsSection.tsx`,
  `health.css`.
* Additive: `exporter.ts` (pause gate, per-job source, an after-each-file hook), `ExportDialog.tsx`,
  `SettingsDialog.tsx` (two lines), `Editor.tsx` (one line).

No new dependency. `electron-builder.config.cjs`, `scripts/*`, `resources/*` untouched.

## 8. Risks

* **Notification buttons on real Windows** (toast activation, Start-menu shortcut): unverified here;
  without buttons the toast still shows, and a click focuses the app.
* **Thumbnail buttons** exist only on Windows; Linux/macOS calls are skipped by the port.
* **Pause during sleep** is best effort (§2.3).
* **`shell.trashItem` on network drives** fails: reported, nothing deleted.
* **Redaction is pattern based**: a secret in an unusual format could slip through; mitigations: the
  app does not print keys today, the report is shown before copying, and 32+ character runs are cut.
* **Per-chapter music** restarts in each part; documented in the dialog tooltip.

## 9. Test plan

Unit (vitest; each fails without its code):
* `longJobsRules.test.ts` — taskbar state priority, paused/indeterminate/error, 1 s visibility,
  thumbar buttons per phase, notification copy.
* `longJobsMain.test.ts` — the registry with a fake port: keep-awake starts/stops, sleep pauses and
  resumes after 3 s only jobs it paused, commands go to the owner, owner gone ends the job,
  notification only when unfocused, Open only for exported files.
* `pauseGate.test.ts` — wait blocks while paused, abort releases, reports that it paused.
* `redact.test.ts` — keys, tokens, e-mails, Windows/UNC/POSIX paths, app roots kept relative.
* `appLog.test.ts` — rotation at the cap, line cap, buffering, redaction on write.
* `diagnostics.test.ts` — report with fake probes, timeouts → "unavailable", last-used capture.
* `storageRules.test.ts` — last used, cache rule, remove rule, open/unfinished excluded, sanitising,
  shared files counted once and freed only with every name.
* `storageDuplicate.test.ts` — after Duplicate, the linked media count once in the total, a removal
  offers and frees only its own files, a pair removed together frees the media, a copy whose
  original is in the Recycle Bin is offered at, and frees, its full size, and a copy whose original
  is in a legacy root frees only its own files.
* `storageMain.test.ts` — scan sizes, no symlink follow, depth/entry caps, trash plan recomputed,
  paths outside root and links refused, no permanent delete on trash failure, store load/save.
* `exportBundle.test.ts` — names, kinds per format, chapter parts (cuts, speed, freezes, first at
  0), part file names, description.
* `exportBundleMain.test.ts` — sidecar target, refuse unknown anchor/kind/content, no overwrite
  unless the video was replaced.
* `handsOffContracts.test.ts` — old projects and settings untouched (`project.json` round trip
  byte for byte), additive wiring present.

End-to-end (`tests/e2e/hands-off.e2e.cjs`, built app under Xvfb): export with SRT, VTT, chapter
list, thumbnail and description and check each file; one file per chapter produces "01 …", "02 …"
with the right lengths; pause and resume an export from the dialog and from a simulated taskbar
command; the job registry drives the (fake-recorded) progress values; Settings › Storage lists the
seeded recordings with sizes and moves a cache to a stubbed Recycle Bin; Settings › Diagnostics shows
a report without the home folder path and copies it.

## 10. Later

* Move the library to another drive (F-26).
* Pausing captions between parts.
* A crash reporter (minidumps) next to the log.
* "Open" for a whole batch folder in the notification.
* Storage use of export folders (only the projects folder is scanned).
