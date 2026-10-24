# Fix report: export audio and raw-frame export

Branch `fix-audit-audio-export`, based on `f3db4cb`. Findings from `audit/render-export.md` (RE-1, RE-2) and
`audit/performance.md` (F2, F6). Each was re-checked against `f3db4cb` before it was fixed.

| id | status | change | proved by |
|----|--------|--------|-----------|
| RE-1 | fixed | re-timed clips are aligned for atempo's lead, with no gap at their start | `tests/audioPlan.test.ts`, `tests/e2e/audit-audio-export.e2e.cjs` |
| RE-2 | fixed | every source mixed with another is made stereo first | `tests/audioPlan.test.ts`, `tests/e2e/audit-audio-export.e2e.cjs` |
| F2 | fixed (main part) | raw video frames are sent as 4:2:0 YUV, 2.7x less to copy over IPC | `tests/rawYuv.test.ts`, `tests/e2e/audit-audio-export.e2e.cjs` |
| F6 | fixed | still detection decodes only the key frames of 60 fps proxies | `tests/analysisIpc.test.ts` |

## RE-1: retimed clips play their sound early

**Re-check.** Still present at `f3db4cb`. `recordingGraph` (`src/shared/render/audioPlan.ts`) still runs
`atempo` and only fixes the clip's length.

**Change** (`src/shared/render/audioPlan.ts`, `src/shared/engine/timeline.ts`):

- `atempoStages` returns the tempo of each atempo filter. `atempoChain` is built from it and produces the
  same strings as before.
- `atempoLead(speed)` is the auditor's model: 1/48 s per stage, scaled by each later stage. That gives
  41.7 ms at 0.5x, 125 ms at 0.25x and 10.4 ms at 2x.
- A re-timed clip now goes through `adelay` (twice the lead, in recording time) → the atempo chain →
  `atrim=start_sample=<lead>`, then the existing exact-length cut.

**Why not the auditor's `adelay` after atempo.** I tried it first. It puts 10–125 ms of silence at the
start of every re-timed clip: an audible dropout at every speed change, and smart speed makes many of
those. It also plays a sound that sits exactly on the cut that much late.

**Why the pre-roll is silence.** Feeding atempo the real audio from before the cut also aligns the clip,
but measured, 10–105 ms of the cut-out sound is then heard at the clip start, because atempo plays its
first window at once. Silence leaks nothing. The only side effect is a short fade-in at the cut: atempo's
first window rises from silence, so a 4 ms click exactly on the cut comes out softer.

**What remains.** Atempo's real lead varies with the sound.

- Old code, measured on onsets: 17–54 ms early at 0.5x; 45–150 ms early at 0.25x.
- After the fix, by the same measures: 0.5x within about −10…+25 ms; 0.25x within about −20…+80 ms.
- A slowed-down beep also rises over tens of ms, so onset times depend on the threshold.

The full model lead is taken back, so what is left errs late. Audio ahead of the picture is noticeable
from about 45 ms; a lag of this size is tolerated. ffmpeg 6.1 (system) and 7.0 (ffmpeg-static) gave
identical results.

**Unchanged arguments.** Projects without re-timed clips keep byte-identical arguments: the `cuts`,
`clicks` and `m4a` cases of `tests/fixtures/legacy-audio-args.json` still pass unchanged. The re-timed
cases (`audio`, `audioClicks`) differ only by the new chain, which the test spells out.

**Tests.**

- `tests/audioPlan.test.ts` › "the sound inside a re-timed clip plays with its frames, not ahead of them"
  runs the real graph through ffmpeg with ticks inside clips at 0.5x, 0.25x, 2x, 0.75x and 1.5x. It requires
  the mean error per clip to be under 20 ms.
  - Without the fix it fails: 0.5x mean −47 ms; 0.25x −93 ms; 0.75x −26 ms.
  - With it the means are −5…+16 ms.
- "no drift over many speed changes" now places its ticks 50 ms into each clip, because of the fade-in at
  the cut. It fails without the fix: 40 ms off at 0.5x.
- e2e `audit-audio-export.e2e.cjs` › "slowed-down clips (0.5x, 0.25x) keep their sound on their frames"
  exports in the real app. It checks each beep is no more than 15 ms ahead of and no more than 100 ms after
  its frame.
  - Old build: beeps at 3.980 s and 9.945 s for 4 s and 10 s, so it fails.
  - New build: 2.020, 4.025, 6.065 and 10.075 s.
- `tests/e2e/audio-pack.e2e.cjs` › "an older project…" hard-codes the expected graph for a project with
  re-timed clips. It was updated to the new chain.

## RE-2: a mono source makes the whole soundtrack mono

**Re-check.** Still present at `f3db4cb`, in both places: the stems `amix` (microphone first) and the
recording + music `amix`.

**Change** (`src/shared/render/audioPlan.ts`). `STEREO = 'pan=stereo|FL=FL+FC|FR=FR+FC'` puts a mono
source on both sides at full level, as Web Audio's upmix does, and leaves stereo unchanged. It is applied:

- to each stem before the stems `amix`;
- to the music;
- to the recording when it is mixed with music.

A lone mono recording, with or without clicks, stays mono: there is nothing stereo to keep. The legacy
fixtures have no stems and no music, so they are unchanged. A source with more than two channels loses
its surround channels in `pan`; recordings and music are mono or stereo in practice.

**Tests.**

- `tests/audioPlan.test.ts` › "a mono microphone or recording keeps stereo system sound and music stereo…"
  uses a mono mic stem with a left-only stereo system stem, and a mono recording under left-only stereo
  music. It checks for 2 channels, the mono source at its own level on both sides, and the stereo source
  staying on the left. It fails without the fix (1 channel). Each half was checked to fail on its own.
- e2e › "a mono microphone keeps stereo system sound and music stereo":
  - Old build: 1 channel, with system sound and music averaged to 0.088 on both sides.
  - New build: 2 channels; mic 0.0997/0.0997; system and music 0.125 on the left and 0 on the right.

## F2: the raw-frame export route is capped by IPC copies

**Re-check.** Still present at `f3db4cb`: `RawFrameSink` sends one RGBA/BGRA frame per `export:frame`.

**Change.**

- `rgbToI420` (`src/shared/render/codec.ts`) converts the frame with ffmpeg's matrix (BT.601, limited
  range, `EXPORT_COLOR`), averaging chroma over each 2x2 block.
- `RawFrameSink` (`src/renderer/src/render/encoders.ts`) converts each frame before sending it when `yuv`
  is set. The exporter (`src/renderer/src/editor/exporter.ts`) sets it for every format except GIF, whose
  palette wants RGB.
- The job's `pixelFormat` is then `yuv420p`. `RawPixelFormat` gains that value; the 32-bit byte orders
  are now `Rgb32Format`.
- The main process accepts `yuv420p` for videos only (`src/main/exportJob.ts`).
- ffmpeg's export filter (`scale=out_color_matrix=bt601:out_range=tv,format=…`) passes the I420 input
  through unchanged, and still repacks it to NV12 for hardware encoders. Colour tags are unchanged.

**Accuracy.** Compared with ffmpeg's own conversion of the same frame:

- Luma within 1 level.
- Chroma differs only along sharp colour edges, because swscale filters chroma differently from a 2x2
  mean. The mean difference is 0.26 levels.
- In the e2e colour check, x264 colours are within 3 levels.

**Cost and gain.**

- Conversion takes 8 ms per 1080p frame and 34 ms per 4K frame (V8).
- Bytes over IPC per frame: 8.3 MB → 3.1 MB at 1080p, 33 MB → 12.4 MB at 4K.
- Measured end to end in this container (Software/x264, 4 s at 60 fps, encode/IPC ms per frame): 1080p
  28.5 → 27.1, 4K 120.3 → 111.5. Wall time 9.5 → 9.7 s at 1080p (no real change) and 38.6 → 36.4 s at 4K.
- Here x264 itself is the limit, so the gain is small. On the auditor's machine IPC was about half of
  each frame's time (49 of 103 ms at 1080p), and there the 2.7x smaller copies should matter more.

**Not done.**

- Item 2 of the proposed fix, overlapping readback with the next draw. The getImageData fallback must
  read the canvas before the next frame is drawn, and frames must reach ffmpeg in order. Doing it safely
  needs more restructuring than this finding warrants.
- Item 3, an ETA note in the export dialog. That is UI copy.
- A WebGL conversion pass. The CPU conversion is simpler and already far cheaper than the copies it
  saves.

**Tests.**

- `tests/rawYuv.test.ts`:
  - the conversion against ffmpeg's;
  - both byte orders;
  - the export filter leaves I420 input unchanged;
  - `RawFrameSink` sends `W*H*1.5` bytes as `yuv420p` for videos and `W*H*4` RGBA for GIFs (fails without
    the fix);
  - the main process accepts YUV for videos only (fails without the fix).
- e2e › the Software export is watched in `/proc`: ffmpeg reads `-pix_fmt yuv420p` (the old build:
  `bgr0`), and every exported frame shows its source frame.

## F6: smart-speed still detection decodes every proxy frame

**Re-check.** Still present at `f3db4cb`: `freezeDetectArgs` in `src/main/analysisIpc.ts` decodes every
frame before `fps=10` drops most of them.

**Change** (`src/main/analysisIpc.ts`).

- When the project's `capture.fps` is not 30 (60, or absent in older projects, which are 60),
  `-skip_frame nokey` is added before the input. The proxy then decodes only its key frames, one every
  0.25 s (`proxyArgs` `-g 15`).
- `fps=10` is left out in that mode: its copies of each key frame would look still.
- Stretch ends move back one key-frame interval (`parseFreezeLog`'s new `endEarly`), so a stretch never
  reaches past the frame where the picture changes again. The change happened after the previous key
  frame.
- 30 fps proxies, with a key frame only every 0.5 s, keep full decoding.

**Measured** on a 20 s 1080p60 proxy-like file: 1.86 s → 0.67 s wall, and the same stretch found
(3 → 9 s).

**Tests** (`tests/analysisIpc.test.ts`).

- Argument test: the option comes before `-i`, and there is no `fps=10`.
- `parseFreezeLog` with `endEarly`.
- "decodes only the key frames of a 60 fps proxy, and every frame of a 30 fps one" uses real ffmpeg on
  60 fps files, with project files that give the rate and that leave it out. It fails without the fix
  (no `-skip_frame`). Stretches are found with ends never past the change.

## Verification

Run on the final commit of the branch.

- `npm run typecheck`: pass
- `npx vitest run`: pass (83 files, 1203 tests)
- `npm run build`: pass
- e2e, one at a time with `xvfb-run -a -s "-screen 0 1920x1080x24"`:
  - `audit-audio-export.e2e.cjs`: pass (2 tests)
  - `export.e2e.cjs`: running
  - `export-pack.e2e.cjs`: running
  - `audio-pack.e2e.cjs`: running
  - `commands.e2e.cjs`: running

## Files touched

- `src/shared/render/audioPlan.ts`, `src/shared/engine/timeline.ts` (RE-1, RE-2)
- `src/main/analysisIpc.ts` (F6)
- `src/shared/render/codec.ts`, `src/shared/api/export.ts`, `src/renderer/src/render/encoders.ts`,
  `src/main/exportJob.ts`, and one line in `src/renderer/src/editor/exporter.ts` (F2)
- `docs/IMPLEMENTATION.md`
- Tests:
  - `tests/audioPlan.test.ts`, `tests/exportArgs.test.ts`, `tests/analysisIpc.test.ts`
  - new: `tests/rawYuv.test.ts`, `tests/e2e/audit-audio-export.e2e.cjs`
  - `tests/e2e/audio-pack.e2e.cjs`: its expected graph for re-timed clips
