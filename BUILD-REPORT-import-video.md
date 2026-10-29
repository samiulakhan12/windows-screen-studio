# Build report: Import a video (NW-07)

Branch `feat-import-video`, from `ccr-b6df7cf7-yked87` (aeca5c5, Flown 0.6.0). Design:
`docs/design/import-video.md` (§13 "As built" lists where the build differs from the plan).

## What was built

- **Import video** on Home (head of *Recent recordings*) and **drag and drop** of one file on
  the library. MP4, M4V, MOV, MKV and WebM.
- **Checks before anything is written**:
  - the path, the extension, a regular file, 1 KB to 64 GB, and the first bytes are MP4/MOV
    or Matroska/WebM;
  - ffmpeg's description of the file, and the plan rules: a picture stream that is not cover art,
    16–16384 px, at most 10 : 1, length 0.5 s to 4 h;
  - DRM: encrypted codec tags, ffmpeg's messages, and a `sinf`/`frma` scan of the first and last
    8 MB of an MP4;
  - a test decode of the first frame and 1 s of sound, then free disk space.
- **Refusals** are one plain sentence each (`IMPORT_COPY` in `src/shared/import/plan.ts`).
- **The editing copy** is the same `screen.mp4` a recording gets, via `proxyArgs` and
  `encodeWithFallback`:
  - 30 or 60 fps constant (variable frame rates handled by the conversion);
  - upright (autorotate, width and height swapped), square pixels (anamorphic widened), even
    sizes, at most 3840 × 2160 in either orientation;
  - interlaced video deinterlaced, HDR tone-mapped to BT.709 when the filters exist;
  - the first sound track used, and imported without sound when the sound cannot be read.
- **Progress, cleanup and notes**: progress with time left and Cancel. Cancel, a failure, a
  reload or quitting removes the folder; a crash leaves `import.json`, swept at the next start.
  Notes are shown before the editor opens (several sound tracks, no sound, HDR, scaled, capped).
- **The project** has `source: { kind: 'import', … }` and an empty invalid `cursor.json`. Auto
  zoom is off, and the saved style and brand kit are applied like a new recording.
- **Editor guards**: the Cursor, Zoom (auto zoom), Effects (shortcut overlay) and Camera tabs, plus
  the command palette and shortcut notices, say the video was imported and what that turns off.
  Manual zooms, cuts, captions, silences, text, shapes, images, title cards and export work.
  Every feature that needs cursor data already checked `cursor.valid`, so nothing new can crash.

## Decisions (details in the design)

- **Proxy only, no copy of the original.** The editor and exporter read only a constant-rate,
  short-GOP H.264 MP4. A 1 h 1080p30 phone file (about 7.2 GB) costs about 4.2 GB as a proxy,
  against 11.4 GB if the original were kept too, and the copy would never be read.
- **No ffprobe.** `ffmpeg-static` has none, and adding one would mean about 70 MB more and a new
  dependency. The `ffmpeg -i` log is parsed by a tested pure parser, and the test decode is the
  final check.
- **30/60 fps only**, because `capture.fps` is treated as 30 or 60 across the editor and analysis.
- **`Project.source` is additive.** `migrateProject` is untouched, so old projects load and save
  byte-for-byte as before (tested).
- **No new dependencies.** No changes to `projects.ts`, the recording side, `proxyArgs.ts`,
  `electron-builder.config.cjs`, `scripts/*` or `resources/*`.

## Files

- **New:**
  - `src/main/importVideo.ts`
  - `src/shared/import/{probe,plan,imported}.ts`
  - `src/shared/api/import.ts`
  - `src/preload/import.ts`
  - `src/renderer/src/import/{useVideoImport.ts,ImportButton.tsx,ImportDropZone.tsx,ImportDialog.tsx,import.css}`
  - `tests/{importProbe,importPlan,importMain,importedProject}.test.ts`
  - `tests/e2e/import-video.e2e.cjs`
  - `docs/design/import-video.md`
  - `docs/screenshots/import-video-*.png` (6, each under 300 KB)
- **Shared, additive lines:**
  - `src/shared/types.ts`, `src/shared/api.ts`, `src/preload/index.ts`
  - `src/main/index.ts` (register and dispose)
  - `src/renderer/src/views/Home.tsx` (10 lines, plus `idle` also waits for an import)
  - `src/renderer/src/views/Editor.tsx` (cursor notices through `noCursorText`)
  - `Cursor/Zoom/Effects/CameraPanel.tsx` (one condition each)
  - `docs/FEATURES.md`, `docs/ROADMAP.md`, `docs/RELEASE-NOTES.md`

## Tests

- **Unit (58 new):**
  - Probe parsing of real ffmpeg 7.0 logs: rotation, HDR transfer, SAR, interlacing, cover art,
    an unknown length, encryption only from tags or messages (never the file name or metadata),
    output sections.
  - Every plan rule at its limits; `importArgs` on the real `proxyArgs`; space and time-left maths.
  - The import record: sanitising it, and old projects loading unchanged.
  - Main with the real bundled ffmpeg:
    - imports of a 641 × 361 MOV with sound, a rotated MP4, a VP9 WebM, a 60 fps MKV with two
      sound tracks, anamorphic DV (checked in the pixels: no bars), a 10-bit HEVC PQ file
      (tone-mapped) and a live WebM with no length;
    - refusals: sound only, ffmpeg-encrypted CENC, too short (including the unknown-length case),
      a text file named .mp4, a bad extension, empty, a folder, a path with a line break;
    - low disk space, cancel, an encoder failure and the sweep, each leaving the right folders;
    - the sound-less fallback and an undecodable picture.
  - Each rule was checked to fail without its code (16 code changes made deliberately, plus the
    SAR, short-length and new-path fixes, each caught by a test).
- **e2e** (`tests/e2e/import-video.e2e.cjs`, two tests):
  - The button imports a rotated phone MOV. The project is upright 360 × 640 at 30 fps with sound.
    The Cursor, Zoom, Effects and Camera tabs explain what is off, every other tab opens without
    page errors, and `Z` adds a manual zoom that is saved. The export is a 1080 × 1920 MP4 with
    sound, 3 s long, and an old seeded project still opens.
  - Drop:
    - the drop zone shows while dragging;
    - refusals for sound only, a fake .mp4 and two files, with focus on Close and Esc closing;
    - Cancel during the copy leaves no folder;
    - a two-track MKV shows its note, then *Open in editor* opens a 1280 × 720 60 fps project.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npx vitest run --testTimeout=60000` | 220 files, **3005 tests passed** |
| `npm run build` | pass |
| `xvfb-run … npm run test:e2e` (full suite) | **52/54 files passed** on the first run (the build before the review fixes) |

The two failures in the full run, and their re-run:
- **`audio-pack.e2e.cjs`:** two tests failed with "the speech helper is missing". This machine
  had not run `npm run build:speech-host` yet. After building it, the file passes (10/10).
- **`import-video.e2e.cjs`:** my test expected exactly the three files the import writes, but
  the editor had already started its own `.cache` folder (only once the speech helper existed).
  The test now ignores dot-folders and passes.
- **Re-run of both files** on the final build: **2/2 files passed** (12 tests).

The known 20 ms microphone-stem flake did not show up. I did not run the full suite again after
the review fixes; only these two files were re-run.

## Review

An independent adversarial review found these, all fixed:
- anamorphic video imported with bars;
- the HDR tone-map left the YUV conversion to swscale's BT.601;
- `-xerror` could refuse files that start mid-GOP;
- an import stranded after a page reload;
- probe processes not stopped on quit;
- short unknown-length videos accepted;
- shortcut notices still said "This recording";
- Cancel possible while the project was being written;
- an indeterminate bar that looked complete;
- the time left counted the checks;
- file names with line breaks could forge log lines;
- doc and code mismatches.

## Needs a real Windows PC

- The Windows ffmpeg build: whether the `zscale` and `tonemap` filters are present (if not,
  HDR imports with the "paler" note), and HEVC, AV1 and ProRes decoding through the test decode.
- GPU encoders (NVENC, Quick Sync, AMF, Media Foundation) for import copies; the libx264
  fallback is what runs here.
- `webUtils.getPathForFile` with files dropped from Explorer, OneDrive placeholders (cloud-only
  files) and network shares.
- `fs.statfs` free space on NTFS and on a recordings folder on another drive.
- Import speed and the time left for long 4K HEVC phone videos.

## Left for later

- Remux without re-encoding when a file already meets the proxy rules.
- Keep 24, 25 and 50 fps as the project rate.
- Choose among several sound tracks.
- A separate camera file, AVI / WMV / MTS, several files at once.
- F-28: auto zoom from the picture.
