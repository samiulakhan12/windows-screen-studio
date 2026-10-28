# Build report: hands-off long jobs and app health (F-12, X-03, F-26, F-11)

Branch `feat-hands-off`, from `aeca5c5` (`ccr-b6df7cf7-yked87`, Flown 0.6.0). Design:
[`docs/design/hands-off.md`](docs/design/hands-off.md).

## What was built

**Hands-off long jobs (F-12)**
- One registry of running jobs in main (`src/main/longJobs.ts`), and the one owner of what they show
  outside the window, through a small port (`longJobsPort.ts`) that tests replace:
  - **Taskbar progress:** the export first, then captions, then analysis. It turns yellow when
    paused, is indeterminate while finalizing, and stays red for 4 s after a failure. A job younger
    than 1 s is not shown, so quick analyses don't flicker.
  - **Thumbnail buttons:** Pause / Resume and Stop. Pause is disabled while finalizing; captions get
    Stop only.
  - **Keep-awake:** `prevent-app-suspension`, held while a job runs and is not paused.
  - **Notifications:** "Export finished" with **Open** / **Show in folder**, only when Flown is in
    the background, and the taskbar button flashes. A batch gets one notification that says how many
    files failed or that it stopped early. Also "Export failed" and "Captions are ready".
- **Which jobs feed it:**
  - Exports report through `jobs:begin/update/end` and get commands back on `jobs:command`
    (`editor/exportJobs.ts`).
  - Captions on this PC and with AI providers report from `aiIpc.ts`, a few added lines. Stop keeps
    the parts already made.
  - Voice and speech analysis reports from `export:analyzeAudio`.
- **Pause:** a gate in the export loop (`shared/jobs/pauseGate.ts`, one awaited line in
  `renderAll`). Nothing is killed while paused; ffmpeg waits for its next frame. Pause and Resume are
  in the running and batch views of the export dialog, and on the taskbar thumbnail.
- **Lock and sleep:**
  - A locked screen keeps exporting; that is the point of hands-off. Lock and unlock are logged.
  - On `suspend` the registry pauses pausable jobs. On `resume` it resumes the ones it paused, 3 s
    later. The dialog shows "Paused while the PC slept. Carrying on…".
  - Files are never left corrupt; this rests on the existing temp file + rename.

**Diagnostics (X-03)**
- **Log:** `src/main/appLog.ts` copies the main process's console lines into
  `userData/logs/main.log`.
  - Each file is capped at 1 MiB, with one rotation to `main.1.log`, so at most 2 MiB in all.
  - Writes are buffered every 500 ms and flushed at quit. Entries are cut at 2000 characters.
- **Redaction** (`shared/diagnostics/redact.ts`), applied on write and again on read:
  - Keys and tokens become `<secret>`; this covers `sk-…`, `AIza…`, Bearer tokens, `key=` values,
    JWTs and long runs of key-like characters. E-mail addresses become `<email>`.
  - Paths inside the app's own folders keep their place, e.g. `<userData>\logs\main.log`.
  - Every other path becomes `<path>`, including doubled separators in logged objects, and names
    with spaces or apostrophes.
  - As a last guard, the home folder and the account name are replaced literally wherever they
    still appear.
- **Settings › Diagnostics:**
  - *Show diagnostics* shows the report: app and runtime versions, Windows build, CPU and memory,
    displays, GPU ids and driver, GPU features, H.264 encoders, the capture helper's probe, how the
    last recording was made, the recording count, running jobs, and the last 300 log lines. Each
    part has a 10 s limit and says "unavailable" with its reason.
  - *Copy diagnostics* copies exactly the report shown: main copies its own report, by id.
  - *Open log folder*.

**Storage manager (F-26)**
- **Scan** (`src/main/storage.ts`):
  - Covers only the current projects folder and never follows links. Each recording is walked at
    most 8 deep and 20,000 entries wide; past that its size shows as "at least".
  - Lists each recording's name, date, last use, size and cache size, and whether it is finished.
  - Shows free space from `fs.statfs`.
- **Settings › Storage:**
  - Recordings are listed largest first, with the total and *Show*.
  - **Rules:** clear the caches of recordings not used for 14 / 30 / 60 / 90 days (default 30;
    automatic at most once a day, off by default), and remove recordings not used for 30–365 days
    (default off).
  - *Review clean-up…* lists every item with a tick. Only *Move N to the Recycle Bin* acts.
- **How the clean-up acts:**
  - Main scans again and acts only on items still in the plan. It checks each target is a real
    folder directly inside the real projects folder.
  - It skips the open recording, checked again right before each move, and unfinished recordings.
  - It uses `shell.trashItem` only, with no permanent delete. A Recycle Bin failure is reported and
    the files stay.
- **Last use:** the later of the `project.json` time and the editor's last opening, kept in
  `userData/storage.json`. `project.json` is never written.

**Export bundle and one file per chapter (F-11)**
- **Also save** (export dialog Settings): Captions (SRT), Captions (VTT), Chapter list, Thumbnail,
  Description. Off by default and remembered.
  - Files are named after the video: `Demo.srt`, `Demo - chapters.txt`, `Demo - thumbnail.png`,
    `Demo - description.txt`.
  - Contents come from the existing `subtitleFile`, `outputChapters` / `youtubeChapters` and
    `renderThumbnail`.
  - Main writes them only next to a file exported in this session, at a path it builds itself, and
    checks the content first.
  - An existing file is never replaced. The exception is when that export replaced the video of the
    same name, and then only once per kind; otherwise " (2)" is added.
  - The bundle applies to single and batch exports. GIFs are saved alone; M4A gets no thumbnail.
- **One file per chapter:** exports `01 Intro.mp4`, `02 Billing.mp4`, … into a folder, through the
  batch export, with Pause, progress and Cancel.
  - Each part is the project with its clips cut to the chapter's range (`chapterParts`, pure), so it
    shows the same frames as that range of the whole export. Each part gets its own SRT, thumbnail
    and description.
  - It is refused, with the reason shown, when a freeze that keeps the sound playing runs across a
    chapter start.

## Decisions and why

- **Lock keeps running; sleep pauses.** The roadmap sketch said "lock pauses". That would make a
  locked PC finish nothing, the opposite of hands-off. The window is never throttled
  (`backgroundThrottling: false`), so exports keep their speed while locked.
- **Caches, not proxies.** The roadmap example said "delete proxies and caches". In Flown the
  proxies are the recording itself: `finalize.ts` deletes the raw capture once they exist. Clearing
  them would delete the recording, so only `.cache` is offered.
- **Last use lives in userData, not `project.json`.** Writing to `project.json` on open would change
  old projects and race the editor's autosave.
- **Pause is a gate in the renderer's loop.** Suspending ffmpeg is not portable and would hold the
  partial file open. Pause is not offered while ffmpeg finalizes; Stop is.
- **The registry lives in main.** The taskbar, notifications and power events are main-only.
  Exports are driven by the page, so the page reports progress; main cannot know it from frames
  sent as encoded batches.
- **No new dependency.** The log, the redaction and the icons are written in code.
- **Shared files** were changed additively only: `index.ts`, `api.ts`, `preload/index.ts`,
  `exporter.ts`, `ExportDialog.tsx`, `SettingsDialog.tsx` (two lines), `Editor.tsx` (one line),
  `exportIpc.ts` and `aiIpc.ts` (the captions job). Untouched: `types.ts`, `project.ts`,
  the recording side, speech, `electron-builder.config.cjs`, `scripts/` and `resources/`.

## Review

An independent adversarial review of the whole diff found nine issues. All are fixed, each with a
test (`a3766f5`):
1. **Redaction leaks.** Paths printed by `util.inspect` (doubled backslashes), names with an
   apostrophe or two spaces. Fixed by wider patterns and the literal home folder / account name
   guard. The new tests fail on the old code.
2. **A recording opened during a clean-up could be trashed.** It is now checked again right before
   each move.
3. **Per-chapter parity.** A part starting inside a "keep the sound playing" freeze would show live
   video. Now refused with the reason shown.
4. **Focus.** Pause uses `aria-disabled`, so it never drops focus. Focus moves to the clean-up
   result. Disabled chips state their reasons as text.
5. **Pause offered too early.** The taskbar offered Pause before frames were drawn, which an M4A
   export never does.
6. **Keep-awake while paused.** A paused export kept the PC awake.
7. **Batch notices.** Batch notifications now say what failed or stopped.
8. **Listener build-up.** Listeners piled up on repeated opens and flashes.
9. **Sidecar replacement scope.** Replacing sidecar files was allowed for the rest of the session;
   now once per export.

Checked and sound:
- **Sender checks:** every new handler checks `isAppUrl`, and job updates also check the sender
  that owns the job.
- **Notifications** open only exported files.
- **Clipboard:** gets main's own report only.
- **Pause gate:** no deadlock; Cancel releases it.
- **Contrast:** the new text uses `--text-1/2/3` and `--danger-text` on `--surface-1/2`, all ≥ 4.5:1.

## Tests

Unit tests (vitest; the ones for the review fixes were checked to fail on the old code):
- `longJobsRules` — taskbar priority and modes, the 1 s rule, thumbnail buttons, notification copy,
  icons.
- `longJobsMain` — keep-awake, commands go to the owner, sleep pause and resume despite stale
  progress, lock, owner gone, background-only notices, Open only for exported files, red after a
  failure, sleeping allowed while paused.
- `pauseGate` — waiting, resume, abort, progress share.
- `exportBundle` — options, kinds per format, names, parts across cuts, speed and freezes (every
  frame in exactly one part), stills across chapters, captions per part, file names, texts.
- `exportBundleMain` — paths, refusals, no overwrite, replace-once, content checks.
- `storageRules` — sanitising, last use, both rules, open and unfinished excluded, formatting.
- `storageMain` — scan sizes, links not followed, caps, re-checked plan, Recycle Bin only, open
  during a clean-up, refused targets, `storage.json`.
- `appLog` — redaction on write, line cap, rotation, sync flush.
- `redact` — roots, paths with spaces / apostrophes / doubled separators, UNC, `file://`, keys,
  e-mails, home folder and account name.
- `diagnostics` — the report, unavailable parts, timeouts.
- `handsOffContracts` — old projects unchanged, defaults, wiring, no permanent delete.

End to end (`tests/e2e/hands-off.e2e.cjs`, the built app under Xvfb), all 5 pass:
- **Export bundle:** the five extra files with their exact contents; an existing `Demo.vtt` is kept
  (`Demo (2).vtt`); re-exporting over the video replaces its own files; main refuses a foreign anchor
  or kind. The taskbar trace shows progress, then cleared; keep-awake on, then off; Pause and Stop
  offered. The notification reads "Demo.mp4 · …" with Open and Show in folder.
- **One file per chapter:** three 60-frame parts whose frames are exactly source frames
  120·i … 120·i + 118. Part 2's SRT is in its own time; a part has no chapter list. One batch
  notification.
- **Pause:** a 20 s 1080p60 software export paused from the dialog renders nothing and the taskbar
  shows "paused". It is resumed, then paused and resumed again by a simulated `suspend` / `resume`.
  All 1200 frames are present, in order.
- **Storage:** sizes, largest first; links not counted; the review lists only the old recording and
  the old cache; nothing moves before confirmation; exactly those two go to a stubbed Recycle Bin;
  sneaky requests do nothing; rules are saved.
- **Diagnostics:** report sections, last capture, a logged path and key redacted, no home path;
  the clipboard equals the text shown; `main.log` is written without the home path or the key.

## Verification (final state of the branch)

VERIFY_PLACEHOLDER

## Needs a real Windows PC

- Taskbar progress colours and the thumbnail buttons (`setThumbarButtons`, the icons drawn in code).
- Notification buttons (Open / Show in folder) on a packaged install with its Start-menu shortcut.
  Unpackaged runs may show no toast.
- `powerSaveBlocker` keeping a laptop awake; real `suspend` / `resume` timing (the pause on sleep is
  best effort; correctness of the files does not depend on it).
- `shell.trashItem` on local, network and OneDrive folders; `fs.statfs` free space on NTFS.
- `process.getSystemVersion()`, the GPU driver field and the capture helper's probe in the
  diagnostics report.

## Left for later

- Moving the library to another drive (F-26).
- Pausing captions between parts.
- Crash reports (minidumps) next to the log.
- A chapter list for a whole set of parts.
- Storage use of export folders.
