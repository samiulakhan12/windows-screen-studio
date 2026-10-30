# Build report: versions, filmstrip and frame nudge (E-12, E-07, E-09)

Branch `feat-versions`, from `546e479`. Design: [`docs/design/versions.md`](docs/design/versions.md).

## What was built

* **Versions (E-12).** A *Versions* button in the editor's title bar and two palette commands,
  *Save a version…* (`Ctrl+Shift+S`) and *Versions…*. The dialog saves a named version, and lists
  every kept version: newest first, with its time, length and counts. For each one it can
  *Compare* (the counts and length that differ from the edit now, plus which settings differ),
  *Open*, *Rename* and *Delete*.
  * *Open* first keeps the edit now as an automatic version, and opens nothing if that fails. It
    then puts the version in place as **one undo step**. The recording's own fields stay as they
    are now: id, name, media facts, copy-of, script.
  * Automatic versions are kept before *Polish in one click*, *Remove all* in the transcript review,
    *Make a vertical / square version* and *Open*. The newest 5 are kept, and an edit that is
    already kept is not kept again. The limit is 50 named versions.
  * Storage: `<project>/versions/` holds one file per version (its meta and the project) plus an
    `index.json`, which is rebuilt from the files when it is missing or behind. Main writes it
    atomically, the snapshot first.
  * IPC accepts calls only from the main window's app page. Ids and paths are validated, the folder
    must not be a link, and sizes are capped.
  * Duplicate leaves `versions/` with the original (`NOT_COPIED_DIRS`). Settings › Storage shows
    "· 1.2 MB in versions", and the cache rule never touches them.
* **Filmstrip (E-07).** Frames along the clip track, under the waveform.
  * Main runs ffmpeg once per proxy: key frames only, at most 400 frames, tiled into one JPEG,
    below normal priority, with a time limit. The sheet is cached in `.cache/filmstrip.jpg` and
    `.json`, keyed on the proxy's size and time. The run stops with the project's other analyses.
  * The renderer asks for the sheet at idle, decodes it once with `createImageBitmap`, and draws one
    canvas over the render window on a fixed grid (no shimmer while scrolling). The crop is applied
    while drawing, and it never redraws per playback frame.
  * *Frames on the clip track* in the palette hides it; the choice is kept in localStorage.
* **Nudge (E-09).** While movable items are selected, the keys of *Step back / forward one frame*
  move them one frame (1/30 s, the editor's frame step) and the keys of *Back / forward one second*
  move them ten frames.
  * The move goes through the multi-select move (`groupMove.ts`: limits, freeze frames, zooms made
    yours).
  * Presses less than 800 ms apart are one undo step, and a notice says how far the run moved.
  * With nothing movable selected the keys step the playhead as before.
  * There are four rebindable commands. The shortcuts editor shows the borrowed keys as
    "while items are selected" chips.

## Decisions and why (details in the design)

* **Versions live in the project folder, one file each, with an index used as a cache.** The
  folder is what users move and back up. A single file would rewrite megabytes on every save, and
  `project.json` must stay unchanged. Each file carries its own meta, so a lost index loses nothing.
* **Snapshots come from the renderer's state**, so they include edits not yet autosaved. They are
  checked the way a Duplicate's copy is: `migrateProject`, the folder's own id, at most 64 MB.
* **Opening a version is undoable and keeps an automatic version first**, so it is never lossy. The
  version being opened is protected from pruning (the review found that opening the oldest
  automatic version could otherwise delete it before it was read).
* **Duplicate does not copy versions.** A copy (for example a vertical version) starts its own
  history.
* **The filmstrip decodes key frames only**, so an hour of recording decodes 14 400 frames instead
  of 216 000 and the editor is never blocked. One sheet serves every zoom level.
* **The nudge reuses the step keys while items are selected** rather than using new keys (Alt+arrows
  is "Back" in Chromium). One frame is 1/30 s, so an item moves exactly as far as the playhead does.
* No new dependencies. Nothing is added to `project.json`; old projects load byte for byte.

## Tests

New unit tests:

| File | Tests | Covers |
|---|---|---|
| `tests/versions.test.ts` | 19 | names, summaries, comparison, restore, metas, pruning, times |
| `tests/versionsMain.test.ts` | 20 | save, list, rename, delete, read, limits, dedupe, index rebuild and adoption, protect on open, link refusal |
| `tests/filmstrip.test.ts` | 17 | plan, ffmpeg arguments, showinfo count, tiles, crop, a real ffmpeg run with cache reuse, shared runs, linked cache, stop, sender check |
| `tests/nudge.test.ts` | 12 | moves, limits, freeze refusal, the undo run, `nudgeInstead`, `commandKeys`, keymap |

Added to existing files: `projectCopy.test.ts` (versions are not copied) and `storageMain.test.ts`
(`versionBytes`). I checked that each rule's test fails without its code: for example, the
protect test fails without `protect`, and the rename-rebuild test fails without rewriting the file.

End to end, `tests/e2e/versions.e2e.cjs` has three scenarios:

* Save, compare, open (Ctrl+Z goes back), the automatic version, rename and delete.
* The filmstrip is drawn, cached, not redrawn while playing, and hidden by its toggle.
* Nudge by 1 and by 10+10 frames, one undo step per run, and → steps the playhead after Esc.

## Verification

See the end of this file (filled in from the final runs).

## Needs a real Windows PC

* `os.setPriority(BELOW_NORMAL)` on the ffmpeg run, and the time a one-hour proxy takes (expected:
  seconds).
* Renaming over `.cache/filmstrip.jpg` while Defender or the indexer holds it. If that fails, the
  strip is simply not shown that session.
* The arrow keys on non-US layouts, and with a focused Inspector list.
