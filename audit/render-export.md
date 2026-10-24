# Audit: rendering and export

Scope: `src/renderer/src/render/*`, `src/renderer/src/editor/exporter.ts`, `media.ts`, `src/shared/render/*` (incl. `audioPlan.ts`), `src/shared/audio/*`, `src/shared/engine/*`, and in `src/main/`: `exportIpc.ts`, `exportArgs.ts`, `exportJob.ts`, `ffmpeg.ts`, `hwEncoders.ts`, `exportCleanup.ts`, `exportClipboard.ts`.

Baseline: commit `b25a136`. `npm ci` (Electron binary skipped) and `npx vitest run` both pass: 75 files, 1066 tests. To check the findings, I built the real `ffmpegPlan(...)` argument lists from `src/main/exportArgs.ts` with esbuild and ran them with the bundled ffmpeg (`ffmpeg-static`, 7.0.2) on synthetic inputs, then measured the output with ffprobe and a sample-accurate onset detector. Electron-only paths (WebCodecs, canvas) were checked by reading the code end to end.

Three findings survived the refutation pass. All three are medium severity. None is high.

| id | severity | area | one line |
|---|---|---|---|
| RE-1 | medium | audio sync | Slowed or sped-up clips: the exported audio plays early against the video (about 40 ms at 0.5x, 100–125 ms at 0.25x) |
| RE-2 | medium | audio graph | A mono source makes the whole exported soundtrack mono: stereo system sound and stereo music collapse |
| RE-3 | medium | privacy | The first frame of a blur or pixelate region can be exported uncovered (one-frame leak) |

---

## RE-1 (medium): retimed clips: exported audio leads the video by about (W/2)/speed per atempo stage

**Where:** `src/shared/render/audioPlan.ts:128` (`const tempo = … atempoChain(c.speed)`) and `src/shared/engine/timeline.ts:166` (`atempoChain`).

**Problem.** ffmpeg's `atempo` (WSOLA, window W = sample_rate/24 = 41.67 ms) puts its output about half a window of input early. In output time, each stage moves the content earlier by (W/2)/tempo, and later stages scale up the shift from earlier stages. `recordingGraph` already fixes each clip's length (`apad=whole_len…,atrim=end_sample…`), but that only pads or trims the end. The constant shift at the start stays, so every sound inside a retimed clip comes too early against the frames `exportFrameTimes` shows. The code comment ("atempo never returns exactly len/speed seconds … tens of ms off") covers the length error but not this offset.

**Failure scenario.** In the edit, the user sets a clip to 0.5x, or 0.25x for a slow-motion highlight. In the exported MP4, speech and the recording's own click and typing sounds in that clip come 40 ms early at 0.5x, 28 ms at 0.75x and 100–125 ms at 0.25x. A 100–125 ms audio lead is clearly visible lip and click desync; the usual detectability limit for audio leading video is about 45 ms. The preview has no such shift, because the media element keeps A/V in sync. Click *sound effects* stay correct (they are placed by sample), so they no longer line up with the recorded click sound in the same clip.

**Evidence** (beeps every 1 s of source; onsets measured on decoded samples):
- The real plan from `ffmpegPlan` with clips `[{1→3 @2x}, {4→7.5 @0.5x}]`. Expected onsets: 0.000, 0.500, 1.000, 3.000, 5.000, 7.000 s. Measured: 0.000, **0.488**, 1.000, **2.962, 4.966, 6.955** s.
- `atempo` alone, beep every 1 s:

  | tempo | measured onset error |
  |---|---|
  | 0.5 | −38 … −45 ms |
  | 0.25 (`atempo=0.5,atempo=0.5`) | −91 … −118 ms |
  | 0.75 | −28 ms |
  | 1.5 | −8 ms |
  | 2 | −12 ms |
- Pre-rolling the input does not help: the shift is constant over the whole clip.
- Adding `adelay` with the predicted lead after the chain removes it. Residual error:

  | tempo | delay | residual |
  |---|---|---|
  | 0.5 | 41.67 ms | −4 … +8 ms |
  | 0.75 | 27.78 ms | −4 … +12 ms |
  | 2 | 10.42 ms | −7 … +4 ms |
  | 0.25 | 125 ms | mean ≈ +20 ms (onset smear of a stretched 20 ms beep) |

**Proposed fix.** Delay each retimed clip by the chain's lead before the existing exact-length cut. The tail is already trimmed by `atrim=end_sample`, so the clip length does not change.

```ts
// timeline.ts: expose the stages atempoChain uses
export function atempoStages(speed: number): number[] { /* same loop as atempoChain, returning the numbers */ }
export const atempoChain = (speed: number): string => atempoStages(speed).map((s) => `atempo=${+s.toFixed(6)}`).join(',')

// audioPlan.ts
/** atempo plays its output half a window (1/24 s) early, per stage, in that stage's output time. */
const ATEMPO_HALF_WINDOW = 1 / 48
export function atempoLead(speed: number): number {
  let lead = 0
  for (const s of atempoStages(speed)) lead = (lead + ATEMPO_HALF_WINDOW) / s
  return lead
}
// in recordingGraph:
const tempo = Math.abs(c.speed - 1) > 1e-6
  ? `,${atempoChain(c.speed)},adelay=delays=${(atempoLead(c.speed) * 1000).toFixed(3)}:all=1`
  : ''
```

Add a unit test that the graph contains `adelay=delays=41.667` for 0.5x and `125.000` for 0.25x, and an ffmpeg-level test like the one above. Before shipping, check that ffmpeg 6.1 (the Windows build) behaves the same as 7.0.

---

## RE-2 (medium): a mono source makes the export's whole soundtrack mono (stereo system sound and music collapse)

**Where:** `src/shared/render/audioPlan.ts:123` (stems `amix`), `:236` (`[rec][mus][clk]amix`), `:188` (music branch). Nothing upmixes the branches to one layout.

**Problem.** When `amix`'s inputs have different channel layouts, it outputs the layout of the **first** input. The click branch already works around this (`[clk0]aresample[clk]`, see the comment at `audioPlan.ts:226`), but the recording stems and the music do not:
- In the stems path the mic comes first (`STEM_KINDS = ['mic','system']`). The mic is recorded with `echoCancellation: true, noiseSuppression: true` (`recorder/session.ts:112`). Chromium delivers such a track mono, MediaRecorder keeps it mono, and `stemArgs` (`proxyArgs.ts:156`) does not set `-ac`. So `[mic(mono)][system(stereo)]amix` gives mono.
- In `soundtrackGraph`, `[rec]` comes first. When the recording branch is mono (the stems case above, or a mic-only recording whose proxy track is the mic track itself, `session.ts:205`), the stereo background music is downmixed to mono.

The stems path is used as soon as the user changes the mic or system volume, mutes one source, or turns on noise reduction (`settings.ts` `recordingMix`), which are all routine. The preview (Web Audio) keeps everything stereo, so the export does not sound like the preview.

**Failure scenario.** The user records mic plus system audio, turns the system sound down to 80% or enables noise reduction, adds stereo music, and exports MP4. The file is mono (1 channel). The stereo image of the system sound and of the music is lost, and the left-only content of a stereo source drops by about 6 dB (it is averaged into one channel).

**Evidence.**
- `ffmpegPlan` for an M4A job with `stems:{mic:1, system:0.8}`, `noiseReduction:0.3` and stereo music, with a mono mic file and a stereo system file. The output is `1,mono` per ffprobe.
- Plain `amix` with `[mono][stereo]` gives mono; with `[stereo][mono]` it gives stereo.
- The full-plan run with a mono recording plus stereo looped music also came out with `channels=1`.

**Proposed fix.** Bring every branch to stereo before mixing, with a pan that keeps a mono source at full level on both sides (as Web Audio's mono→stereo upmix does) and leaves stereo unchanged. `aformat=channel_layouts=stereo` would drop mono sources by 3 dB.

```ts
const STEREO = 'pan=stereo|FL=FL+FC|FR=FR+FC'
// recordingGraph: after `${resample}` on the mixed track and on each stem
head = `[${rec.input}]${resample},${STEREO}${denoise}`
parts.push(`[${s.input}]${resample},${STEREO}${s.denoise ? denoise : ''}${gainFilter(s.gain)}[m${i}]`)
// musicGraph:
const chain = [`[${m.input}]aresample=async=1:first_pts=0`, STEREO, `atrim=end=${sec(end)}`]
```

I verified that this pan gives the same RMS on both channels as the mono input (−21.13 dB), and leaves a left-only stereo input unchanged (−3.47 dB / −inf). With both stems upmixed this way, the stems amix outputs 2 channels. A click-only or all-mono soundtrack would then also be stereo (two identical channels), which is harmless. Update the graph snapshots in `tests/audioPlan.test.ts` and `tests/exportSound.test.ts`.

---

## RE-3 (medium, privacy): the first frame of a blur/pixelate region can be exported uncovered

**Where:** `src/renderer/src/render/shapesLayer.ts:36` (`fc.t >= s.start && fc.t < s.end`) together with the export's frame choice: `src/shared/render/feedPlan.ts:25` (`presentationIndex(order, t, frame / 2)`) and `src/shared/render/frameTiming.ts:20` (`frameIndexAt` = round), used by both export frame sources.

**Problem.** For output time `t`, the export draws the source frame **nearest** to `t`: any frame starting up to half a frame after `t`. But it decides whether a privacy shape is active from `t` itself. When a shape starts at the frame where the secret appears (start = that frame's timestamp, or anywhere inside the frame as the preview shows it), every export sample `t` in `[start − ½ frame, start)` draws the secret frame with the shape still inactive. The paused preview shows the frame that *contains* `t` (`currentTime = t`, floor), so the user never sees the leak in the editor.

The export's samples fall in that window whenever the source-time grid is not aligned to the proxy's frame grid. That is the normal case: any trim or cut at a non-frame position, or any clip speed other than 1, shifts it.

**Failure scenario.** A password appears in proxy frame 120 (2.000 s at 60 fps). The user adds a blur over it starting at 2.000 s, which looks correct in the preview. They trim the edit start to 0.995 s and export at 60 fps. Output frame 60 is sampled at t = 1.995 s, shows proxy frame 120 (the password) and is **not blurred**. It is a single frame, but a frame-step or a paused thumbnail reveals it, and it is exactly what the privacy tool exists to prevent.

**Evidence.** A script using the real `exportFrameTimes` + `planFeed` + `frameIndexAt` (60 fps proxy, clip `{start: 0.995, end: 6}`, shape `{start: 2.0, end: 4.0}`) prints: `output frame 60: t=1.9950 shows proxy frame 120 (element path: 120), privacy active=false`. The mirror case at the end (frame 180, a frame covered after the secret is gone) is harmless.

**Proposed fix.** Make privacy coverage conservative by half a source frame, so it covers whichever neighbouring frame either path (export rounding, preview floor) may show:

```ts
// drawPrivacyLayer
const slack = 0.5 / (fc.project.capture?.fps ?? 60)
if (!isPrivacyKind(s.kind) || !(fc.t + slack >= s.start && fc.t - slack < s.end)) continue
```

A more exact alternative: pass the presentation time of the frame actually drawn (the decoder already knows it) through `FrameImage`, and test the shape against that. Then privacy, and optionally the other overlays, are timed to the picture, not to the sample. Other overlays (cursor, annotations) have the same half-frame skew, but there it is only cosmetic.

---

## Checked and fine

- **Frame timing with cuts and speed.** `exportFrameTimes`, `clipSampleBounds` and the per-clip `apad/atrim end_sample` agree. The video length is `round(D·fps)/fps` and the audio is cut to exactly `frames/fps`. Measured: 1x multi-clip exports put onsets on the exact expected samples; output durations equal the frame count / fps.
- **Noise reduction and loudness.** The `denoiseFilter` latency compensation and the `loudnorm` + `aresample` chain keep onsets sample-aligned. Measured with `noiseReduction: 0.5` + `normalize`: onsets at 0.5/1.5/2.5/3.0/4.0/5.0 s, exactly as expected.
- **Clicks and fades.** Click-track sample placement, the click → recording-layout `aresample`, and fades applied to the mix were all correct in the measurement. Click sounds dropped in cuts and re-spaced after speed-ups were correct by reading.
- **Music.** Looping (`-stream_loop -1` + `first_pts=0`), `musicEnd`, `fitFades`, and ducking (`duckExpression` as a binary-search expression, externalized with the graph when long) run and come out the right length.
- **Two-pass size target.** x264 and VP9 over the lossless intermediate. Ran it: CFR output (60/1 and 30/1, `nb_frames` = job frames, no ms-rounding jitter from the MKV intermediate), VP9 case 2.7% over its bit-rate budget. Two-pass log and intermediate names match `GIF_TEMP`, so the startup sweep collects leftovers.
- **GIF.** Capture → palette → encode, `nextGifFit`/`fitGif` loop, even sizes. Ran a 15 fps GIF: 150 frames, delays 7/7/6 cs, exactly 10.000 s.
- **Colour.** Consistent tagging on every route: BT.601 matrix, limited range, BT.709 primaries/transfer. That covers the raw route (`yuvFilter` + `h264_metadata` + container tags), the WebCodecs route (`colorTagsFrom` + bsf) and VP9 (`vp9_metadata`); MP4/MOV use `write_colr`.
- **WebCodecs routes.** Reordering detection, dropped-frame check, IVF framing/pts, the `-r` on raw H.264 input, and back-pressure in `WebCodecsSink` and `RawFrameSink`. A byte-order change after the first frame falls back to `getImageData` with a swizzle.
- **Frame sources.** `DecoderFrameSource` feed plan / keyframe jumps / slow-motion frame reuse, edit-list handling in `mp4.ts`, `ResilientFrameSource` switching mid-export, and `ElementFrameSource` seek-to-mid-frame with timestamp verification. Webcam times with negative offset or past the end clamp to the first/last frame, the same as the preview.
- **Encoder fallback.** `exportRoutes` ordering, hardware probe options matching real encodes (`h264_mf -hw_encoding 1`), and `NOT_ENCODER_RELATED` stopping retries for disk/permission errors. Batch path approval survives a fallback restart; single-export approval is cleared only on success.
- **Cancel and cleanup.** Cancel during start, render, finishing passes and GIF fitting: `cancelActive` kills both processes, waits for exit (bounded), then deletes. In-flight frame IPC from a failed route cannot reach the next route's ffmpeg, because IPC is ordered and the old job is cancelled before the new start. Partial files are renamed only on success with retries. The leftover log and the temp sweep (dead-pid and age guarded) are in place, and the quit path waits for cleanup.
- **Security.** `export:start` only accepts dialog-approved paths or batch paths; `projectId` is validated by `projectDir`. Music names are validated against `MUSIC_FILE_RE` and stems come from fixed names, so ffmpeg reads nothing outside the project folder. The thumbnail is size- and PNG-checked. The clipboard command passes paths via env/argv, never a shell.
- **Aspect overrides and batch.** `exportProject` copies and never mutates the project; preview, export and thumbnail share `exportSize`. Even sizes, the `MAX_EXPORT_SIDE` cap and `maxWidth` are handled. `batchFileNames` is unique, case-insensitively.
- **Size-target maths.** `targetBitrates` for video and audio-only, and how the audio bitrate reaches the muxer, are consistent with `rateOf`.
- **Pull-back, device frames, motion blur.** Pull-back with device frames uses the vector card plus the background layer and sorts sub-frames largest-first. Privacy boxes during motion blur are swept over the shutter's end cameras; any residual from the slight spring overshoot is sub-pixel at shutter ≤ 1 frame.
- **Not a defect (performance note).** Click tracks scale super-linearly with the number of clicks, but stay usable at realistic counts. Measured M4A encode times:

  | clicks | length | encode |
  |---|---|---|
  | 2,000 | 10 min | 10 s |
  | 4,000 | 20 min | 20 s |
  | 6,000 | 30 min | 45 s |
  | none | 30 min | 6 s |
