# Build report: editing polish (wave 10)

Branch `feat/wave10` in `/home/user/wt-w10b`. Design: [`docs/design/editing-polish.md`](docs/design/editing-polish.md)
(§0 holds the owner's decisions, §17 the files and parts, §19 the tests). The branch starts at the
head of Captions Studio phase B (everything through wave 8, versions, filmstrip and nudge), then
the design commits and the contracts commit `d746e5e`. Nothing was pushed.

## What was built

Six features, each a section of an existing Inspector tab (the rail keeps its 13 tabs):

* **Smooth cuts** (NW-06, §2.1, §5). Every cut can have a style: *Hard cut* (as before), *Smooth*
  (a crossfade where the screen fills the picture, a punch-in where the camera fills most of it on
  both sides), *Crossfade*, *Dip to colour*, *Slide* or *Punch-in*. The Clip tab's *Cuts* section
  sets every cut and has *Smooth all cuts*; a selected cut gets *Cut style* with *Previous cut*,
  *Next cut* and *Play this cut*. Each cut has a 24 px marker on the clip track. The video keeps its
  length and no frame from inside a cut is ever shown: the outgoing still (A\*) is a frame the
  decoder already feeds, chosen by the decoder's own rule, so the preview and the export draw the
  same frames at any frame rate and after any seek. Polish has a *Smooth cuts* step and Review mode
  lists it.
* **Magnifier** (LT-12, §2.2, §6). A round or rounded lens 1.5–4× over a detail, from the
  recording's own pixels, with a default zoom picked from the recording's resolution. It grows in
  and out, sits on its content or follows the cursor, keeps blurred and pixelated areas hidden, and
  its Darkness lights exactly the lens.
* **Animated callouts** (LT-11, §2.3, §7). Comes in, Goes out, Speed and Sound for texts, shapes
  and title cards, with *Draw* and *Wipe*; step badges (1 2 3, A B C, ১ ২ ৩, numbered in time order
  and per chapter) and speech bubbles, both pinned to their spot through zooms. Items made before
  keep their fades exactly.
* **Progress bar** (LT-11, §2.4, §8). Split at the chapters, with the current chapter's name (or
  all, or none), placed clear of the captions and inside the safe zones, faded under full-frame
  title cards, and running on through pause freezes.
* **Colour** (LT-16, §2.5, §9). Sliders, looks and `.cube` LUTs for the screen and the camera
  separately, Compare, and Auto colour for the camera (with its Review mode row). One WebGL2 shader
  with a self-test and a CPU path that matches it within one level; LUT files are parsed with the
  design's caps in main, SHA-256 checked, and checked again before use.
* **Music and sound effects** (LT-13, §2.6, §10). A music library (four CC0 beds bundled, each
  looping sample-exact from its own loop points), sixteen CC0 sound effects on zooms, title cards,
  texts and shapes and on Captions Studio's pop-ups (one rule at most once every 3 s), the credit
  line in the YouTube description, and the fix for the loop glitch in users' own Opus and M4A music.

The parts' own reports, summarised: P1 (Smooth cuts) 12 commits, P2 (magnifier and progress bar)
6, P3 (animated callouts) 8, P4 (colour) 8, P5 (music and sound effects) 13, each built on the
contracts commit in its own worktree, each with its numbered tests (§19.1) checked to fail without
their code by a mutation run (P1 36 breaks, P2 about 40, P3 28, P4 27, P5 46 plus extras).

## The owner's decisions as applied (§0)

1. **Where the eight extra beds download from**: (a), a release in a separate repository
   `samiulakhan12/flown-sound-library`, tag `sound-library-1`. That repository **does not exist
   yet**. Its address is kept as data (`SOUND_LIBRARY_RELEASE` in `src/shared/audio/soundLibrary.ts`)
   and the source the app uses, `SOUND_LIBRARY_SOURCE`, is `null`, so the eight download rows and
   Settings › Downloads › More music are hidden and the four bundled beds work alone. No repository
   was created and nothing was uploaded. `docs/RELEASING.md` says how to make the release and check
   it before the source is set.
2. **Fix the loop glitch in users' own music**: done in this wave (§10.4). A looping Opus, AAC,
   M4A or Ogg Opus file shorter than the video is decoded once into the project's `.cache/` as FLAC
   (free space checked first, stopped by the export's cancel or after 5 minutes, older copies
   pruned) and the export loops that. Project files do not change.
3. **Polish gets the Smooth cuts step, on by default for new Polish options**: done. Saved Polish
   options without the step read it as off; it skips with "No cuts to smooth" or "Your cut style
   is kept".
4. **CC0 music with the credit line on by default**: done. The credit ("Music: Sweet Sun by Loyalty
   Freak Music (CC0)") shows under the music row and is the YouTube description's last line whenever
   a library bed is the music. It cannot be switched off yet (an opt-out would need a stored field).
5. **A listening pass before release** and 6. **measurements on the reference Windows PC**: left
   for a person (see *What needs a person*).

## Merging

`integ/wave8` first (`63f48c1`: five commits of Captions Studio phase B's word maps), then the parts
one at a time with `git merge --no-ff` in the design's order (§17.6):

| Merge | Part | Conflicts and how both sides were kept |
|---|---|---|
| `35b876e` | P4 Colour | none |
| `5fc2e3d` | P1 Smooth cuts | `tests/e2e/editing-polish.e2e.cjs`: both parts' one-line calls into their step modules kept. |
| `90dd941` | P2 Magnifier and progress bar | `Editor.tsx`: P1's `cutCommands`, P2's magnifier and progress-bar handlers and P4's Compare and Auto colour handlers all kept in the command map. `labelContrast.test.ts`: both blocks kept. The e2e file: P2's steps written inline, kept with P1's and P4's calls. |
| `3143ae0` | P3 Animated callouts | `playheadItems.ts`: the imports of both (P2's `addMagnifierAt`, P3's `newShapeForPlayhead` in `addShapeAt`). `Editor.tsx`: P3's `calloutCommands` replaces the two Text-tab stand-ins next to P2's handlers. The e2e file: P3's helpers and E7 steps added. |
| `5dd8d0e` | P5 Music and sound effects | `labelContrast.test.ts`: all four blocks kept. The e2e file: P5's helpers and E12–E14 added. |

### Integration fixes (found by running the parts together)

Each has a test that fails without it (checked by taking the code out and running the test):

1. **A unit test hung** (`tests/captionLookSection.test.ts`, every run, from the P3 merge on). With
   P2 and P3 together, the caption settings reach `captions/colors.ts` through
   `safeZones → chapterBar → titleCards → callouts → colors`. The test mocks `colors.ts` with the
   Captions Studio stand-ins, which import the caption settings, so the mock waited on itself and
   vitest never finished. The colour stand-ins moved to `tests/studioColourStandIns.ts` (re-exported
   by `studioStandIns.ts`, so the other users are unchanged) and the test mocks `colors.ts` with them
   alone. No assertion changed; the four tests that use the stand-ins pass (78 tests).
2. **The export and the thumbnail now let go of the colour grade's copies** of their canvas, as
   they already did for the 3D tilt (P4's merge note). New `tests/exportReleaseGrade.test.ts`
   (after an export, after a thumbnail and after a cancel).
3. **Several pop-ups selected offer the same Sound list as the Graphics tab** (P5's merge note): the
   multi-select panel offered only Pop and Ding. It now offers None, Original pop, Original ding and
   the library's effects (pop-ups' first), writes only catalogue effects, and reads them back. New
   tests in `tests/librarySoundsCaptions.test.ts`.
4. **A magnifier is named "Magnifier, 2 times" in the snap guides** too, as on its block (P2's merge
   note; §2.2). `tests/magnifier.test.ts` expected the old "Spotlight" label for a magnifier and now
   expects the design's name.
5. **E1, E17 and E18 of §19.3 written** (`tests/e2e/editing-polish-whole.cjs`), which no part owned:
   E1 exports an old project with Flown from before wave 10 and with this build and compares every
   frame's hash and the decoded sound; E17 saves a version, smooths the cuts and grades the camera,
   and checks the comparison names "smooth cuts" and "colour"; E18 prints the per-frame times of a
   1080p graded export with crossfades and a magnifier. `tests/e2e/helpers.cjs`'s `launch` takes an
   optional `appDir` for E1's baseline build.

## Tests

Run on this machine (Linux, 4 CPUs shared with other work, Xvfb, SwiftShader for WebGL2), on the
final code:

* **Typecheck** (`npm run typecheck`, node and web): clean.
* **Unit tests** (`npx vitest run --maxWorkers=2`): **454 files, 6,194 tests, all passing**, the
  equivalence guard (`tests/editingEquivalence.test.ts`, §19.2) unchanged and passing. The parts'
  numbered tests 1–84 are where their reports say (P1: `joins`, `joinsEdit`, `joinDrawing`,
  `joinCompose`, `joinExport`, `joinsReview`, `timelineCuts`, `cutsSection`, `joinPreview`,
  `joinsPerf`; P2: `magnifier`, `magnifierLayer`, `chapterBar`, `magnifierPanels`; P3: `callouts`,
  `calloutLayer`, `calloutsEdit`, `calloutPanels`; P4: `colorGrade`, `gradeLayer`, `lutCache`,
  `colourEdit`, `lutImport`, `colourControls`, `colourPerf`; P5: `sfxJob`, `audioPlanLibrary`,
  `exportLibrary`, `soundLibraryStore`, `previewLibrary`, `librarySoundsCaptions`, `packaging`,
  `musicLibrarySection`, `effectsOnlyExport`, `soundLibraryBuildP5`, `editingPerfSound`; contracts:
  `editingContracts` and the build script's tests).
* **Build** (`npm run -s build`, electron-vite): exit 0, with the usual chunk-size warning.
* **Sound library** (`node scripts/build-sound-library.mjs --check`): "The sound library matches its
  pins: 28 files."
* **End to end**, under `xvfb-run -a -s "-screen 0 1920x1080x24"`, one file at a time, at least
  10 GB free before each:

| File | Result |
|---|---|
| `editing-polish` | 19 PASS: E1, E2+E5, E3+E4, E15, E16, E6 (2), E8 (2), E7 (2), E9, E10, E11 (with E16's slider keys), E12, E13, E14, E17, E18 |
| `render` | 3 PASS |
| `export` | 10 PASS |
| `export-pack` | 5 PASS |
| `freeze` | 1 PASS |
| `edit-by-text` | 4 PASS |
| `review-mode` | 10 PASS |
| `polish` | 5 PASS |
| `one-click-polish` | 3 PASS |
| `captions-studio` | 8 PASS |
| `titles` | 6 PASS |
| `shapes` | 6 PASS |
| `camera` | 5 PASS |
| `tilt` | 6 PASS |
| `vertical-video` | 1 PASS |
| `multi-select` | 5 PASS |
| `brand-kit` | 6 PASS |
| `style-pack` | 7 PASS after a fix (below; 6 PASS, 1 FAIL in the run and alone before it) |
| `audio-pack` | 10 PASS |
| `audit-audio-export` | 2 PASS |
| `clean-voice` | 3 PASS |
| `sound-finder` | 5 PASS |
| `versions` | 3 PASS |
| `commands` | 5 PASS after a fix (below; 3 PASS, 2 FAIL in the run) |
| `ui` | 5 PASS |
| `search` | 3 PASS |
| `bangla-captions` | 4 PASS |
| `publish-pack` | 4 PASS |
| `packaging` | 2 PASS (the installer check says SKIP: no `dist/win-unpacked` was built) |

Every name §17.6 lists exists; none was skipped.

The two e2e failures, each re-run alone before it was treated as real:

* **`commands`, 2 steps**: they expected an arrow added at the playhead to start one fade (0.15 s)
  early. §7.1 makes it start one entrance early (an arrow draws itself over 0.35 s), as P3's unit
  test `shapesPlayhead.test.ts` already says. The two expectations now use 3 − 0.35 s, with the
  same tolerances; both pass alone.
* **`style-pack`, "presets apply as one undo step"**: it failed the same way on the build from before
  wave 10 (`dd368c7`), so it is not a wave 10 regression. Main reads `editor-prefs.json` once and
  keeps it, and Home had already read a preference before the test wrote the file. The test now
  writes the file while the app is closed and starts it again; all 7 steps pass.

Measurements printed by the e2e (SwiftShader, so slower than a real GPU):

* **E1**: an old project (a cut, a zoom, a text, an arrow, a spotlight, a lower third, the
  recording's sound) exported at 720p 30 fps by Flown from before wave 10 (`dd368c7`, built in a
  scratch worktree) and by this build: 156 frames, every frame's hash the same, and the decoded sound
  the same, sample for sample (249,856 samples).
* **E2**: the frame at T + 0.075 s is (139, 18, 109) at 30 fps and (111, 17, 140) at 60 fps, about
  half red and half blue; the export decoded with WebCodecs and never fell back to seeking.
* **E9**: per-frame draw at 720p: plain 5.2 ms; warm camera 24 ms and mono screen 53 ms on WebGL2
  (SwiftShader); 6.6 ms and 13.1 ms on the CPU path. The CPU export equals the WebGL one.
* **E18**: a 1080p export graded on WebGL2 (SwiftShader) with crossfades and a magnifier: decode
  7.8 ms, draw 138.1 ms, encode 28.8 ms a frame (the ceiling is 400 ms).

Screenshots of the new UI, taken from the built app with a seeded project (each under 300 KB):
`docs/screenshots/editing-polish-editor.png` (badges, a speech bubble, an arrow, a magnifier, the
progress bar and a warm camera in the preview; the cut markers and the magnifier's block on the
timeline), `-cuts.png`, `-cut-markers.png`, `-cut-style.png`, `-magnifier.png`, `-badge.png`,
`-animation.png`, `-progress-bar.png`, `-camera-colour.png`, `-screen-colour.png`, `-music.png`,
`-sound-effects.png` and `-review.png`.

Hard rules checked on the merged branch: no file under `src/main/recording/`,
`src/shared/recording/`, `src/renderer/src/recorder/`, `src/renderer/src/views/Toolbar.*`, nor
`src/main/recordingIpc.ts`, `src/main/windows.ts`, `src/main/appSettings.ts`,
`src/main/security.ts` or the CSP in `src/renderer/index.html` changed since `dd368c7`. The sound
host in `mediaProtocol.ts` serves only catalogue names (`soundPath`); the LUT pattern added to
`MEDIA_FILE_RE` is `lut-<n>.cube`.

## What needs a person

* **The listening pass (decision 5, required before release)**: all 12 beds under a voice with
  §10.1's criteria (no vocals, nothing busy in the speech band, steady energy, no game feel, a clean
  loop point; the loop points were found by analysis only, and each mood has a measured spare), and
  the 16 effects' levels.
* **Measurements on the reference Windows PC (decision 6, required after the build)**: the colour
  shader's cost on a real GPU and the copies grading needs (here SwiftShader made WebGL2 slower than
  the CPU path), the preview's smoothness with crossfades and the cost of composing A\*, the
  magnifier's cost (budget 3 ms a frame at 1080p), the loop cache's decode time, the preview's music
  drift, the export time with effects, the installer's size, and one real download through the
  chosen host.
* **Creating the sound library's repository**: make `samiulakhan12/flown-sound-library` with
  immutable releases on, publish the release `sound-library-1` with the eight pinned files, run the
  release check in `docs/RELEASING.md`, and only then set `SOUND_LIBRARY_SOURCE` to
  `SOUND_LIBRARY_RELEASE`. Until then E13 runs against a local copy of the files
  (`SSW_E2E_SOUND_RELEASE`).

## Known gaps and notes

From the parts' reports, still true after the merge:

* **E2 exports at 30 and 60 fps**, not 24 and 30: the export dialog offers only 30 and 60. Unit
  tests 12 and 74 cover 24 fps and every output rate from 10 to 120.
* **Not automated end to end**: E2's camera-only punch-in ("no frame mixes two faces") and E4's
  punch-in check that the card's edges and the camera bubble stay put (unit test 18 covers both);
  E6's preview-against-export comparison and the blur under the lens during a moving zoom with
  motion blur (unit test 29); ducking under a bed and a Captions Studio pop-up with Soft pop in E12
  and E14 (unit test 63); the preview's rendered music (emulated in unit test 69).
* **A camera that pulls back** (zoom below 1×) is not punched in, so a punch-in switches on as a
  pull-back zoom passes 1×.
* **Changing the background blur after a preview A\* was segmented** does not segment it again until
  a new still is made (preview only; the export prepares the mask on every compose).
* **A new magnifier starts one grow-in before the playhead** (0.3 s) so it is fully shown where it
  is added (E6 expects it shown at 2×); §2.2 says it starts at the playhead.
* **Title cards' Wipe always starts from the left** (titleCardLayer.ts is frozen), and a card's
  Typewriter shows whole graphemes in proportion rather than by measured advances.
* **A selected badge in the Text tab** shows TextPanel's own text field beside the badge's
  grapheme-checked *Your own text* field.
* **Follows the zoom** (a badge) and **Tail** (a bubble) need a frame held in the preview; while it
  plays they change nothing.
* **The music credit cannot be switched off** (decision 4 asks for it on by default; an opt-out
  needs a stored field, a contract change).
* **The performance tests** are in `tests/joinsPerf.test.ts`, `tests/colourPerf.test.ts` and
  `tests/editingPerfSound.test.ts`, not one shared `tests/editingPerf.test.ts` (§19.1), so the parts
  did not edit one file.
* **Contract changes made by the parts** (each the smallest the part needed): PickedAsset gains an
  optional `lut` (P4); ShapesPanel hides its spotlight panel for a magnifier, passes the cursor track
  to MagnifierSection, names magnifiers and exports three helpers (P2); JoinStills.prepare takes an
  optional background (P1); P5 added optional parameters to `resolveSoundInputs`, `loopableMusic`,
  `useBed`, `composeYoutubeDescription` and `descriptionToCheck`, and small seams in `exportIpc.ts`,
  `exportArgs.ts`, `AudioPanel.tsx` and `PublishDialog.tsx`.
* **`tests/bleepBangla.test.ts` is close to vitest's 5 s limit**: one of its tests takes 4.2 s alone,
  as it did before wave 10 (4.3 s at `dd368c7`), and timed out once (5.07 s) while the suite ran on
  the shared machine. It passed in the final full run; it was not changed.
* **The Music library command** opens the Audio tab; it does not scroll to the Library.
* **Four merge commit messages** (`5fc2e3d`, `90dd941`, `3143ae0`, `5dd8d0e`, the merges that had
  conflicts) end with git's "# Conflicts:" list after the two attribution lines, because they were
  committed with `--no-edit`. History was not rewritten to change them.
