# ssw-ocr: Flown's text reader helper

The helper Find private info runs to read text on screen in a recording (docs/design/auto-blur.md
§5, §10.4, §16.2). It reads PaddlePaddle's PP-OCRv6 models with [tract](https://github.com/sonos/tract)
on this PC, one JSON command a line on stdin and one JSON answer a line on stdout
(`src/shared/privacy/protocol.ts`). It opens no port, writes no file and runs nothing it
downloaded: the models are data, checked by size and SHA-256 before they are parsed.

Main runs it through `src/main/privacy/readerHelper.ts` (`OcrHelper`); `readerModels.ts` downloads
and checks the models. Nothing here is UI.

## The models

The five pinned files of `src/shared/privacy/readerCatalog.ts`, compiled in again in
`src/models.rs` (both must agree: `open` refuses pins that are not these):

| File | Upstream @ commit | Bytes | SHA-256 |
|---|---|---|---|
| `PP-OCRv6_tiny_det_onnx/inference.onnx` | `PaddlePaddle/PP-OCRv6_tiny_det_onnx` @ `2ba1506c…` | 1,780,590 | `193bab7a…` |
| `PP-OCRv6_tiny_rec_onnx/inference.onnx` | `PaddlePaddle/PP-OCRv6_tiny_rec_onnx` @ `2612ab37…` | 4,462,639 | `9ef676d6…` |
| `PP-OCRv6_tiny_rec_onnx/inference.yml` | same | 55,571 | `66170210…` |
| `PP-OCRv6_small_rec_onnx/inference.onnx` | `PaddlePaddle/PP-OCRv6_small_rec_onnx` @ `b8f84f0b…` | 21,159,378 | `5435fd74…` |
| `PP-OCRv6_small_rec_onnx/inference.yml` | same | 150,579 | `ab078671…` |

27,608,757 bytes in all, Apache-2.0 (`resources/notices/41-paddleocr-models.txt`). The tiny
detector's own `inference.yml` is not downloaded: its four numbers are constants in `src/read.rs`
(`DET_THRESH` 0.2, `DET_BOX_THRESH` 0.4, `DET_UNCLIP_RATIO` 1.4, `DET_MAX_CANDIDATES` 3000), which
test 85 compares with `scripts/privacy/reader-models.json`. The character lists come from the
recognisers' `inference.yml` (6,904 and 18,708 entries, plus the CTC blank and the trailing space:
6,906 and 18,710 classes, the recognisers' output widths).

`open` reads each file once, hashes every buffer before parsing any, and parses the hashed buffer
(`model_for_read`), so a file swapped on disk after the check is never parsed (§10.2, R2). It then
builds every plan a read can need and keeps them: the detector at 640×352, 960×544 and 1920×1088,
and each recogniser at widths 320, 448, 640, 896 and 1280 (13 plans; R1 counts them). After a
caught panic the plans are built again from the parsed models (R9).

## What it does

- **Threads** (§5.5): the stdin dispatcher (it handles `careful` first, `release`, `cancel`,
  `pause`, `resume` and `stop` between commands), a look worker with its own ffmpeg, one inference
  worker for `open`, reads, careful re-reads and follow sessions, and a heartbeat every 2 s from
  the start. The helper ends when stdin ends or a write to stdout fails (R20).
- **Reads**: ffmpeg seeks to the key frame main names (`-ss <key> -copyts`), decodes with one thread
  and keeps the frames selected by time; reads less than a second apart share one run, and the next
  read's frame is decoded while the current one is read. Frame times are each frame's pts times its
  filter's time base (showinfo's `pts_time` has six significant digits). A recording over
  7680 px on a side or 40 megapixels is refused from its MP4 header before ffmpeg starts (R3).
- **Buckets, packing and tiles**: an area is padded to the smallest bucket that holds it; small
  areas of one read are shelf-packed into one bucket, tallest first, 32 px apart, none cut; an area
  larger than 1920×1088 is cut into as few 1920×1088 tiles as cover it, spread evenly (a 4K frame is
  four tiles, 7680×2160 eight). Lines of neighbouring tiles that meet within a 64 px band around
  their seam (side by side on one baseline, or one above the other over the same columns) are joined
  and read again; lines of one tile never are (R5).
- **Detection**: the probability map over 0.2, 8-connected blobs, each blob's minimum-area
  rectangle scored by the mean probability inside it (0.4), grown by the unclip distance
  (area × 1.4 / perimeter), as PP-OCRv6's DBPostProcess.
- **Recognition**: each line at height 48, padded to the next width; lines wider than 1280 are read
  in 1280-wide chunks overlapping by 64 and joined at the overlap's middle (R6). CTC decoding gives
  each character's x-range, one span a UTF-16 code unit of the text (R7). A line tilted more than 2°
  is cut with a rotated crop; one 1.5 times taller than wide is read turned a quarter, and each of
  its characters gets the line's width.
- **Ring colour**: the median RGB of a 2 px ring outside the line's padded box, and the largest
  per-channel median absolute deviation as its spread.
- **QR codes**: finder patterns found by a 1:1:3:1:1 scan of rows and columns, dark on light and
  light on dark, grouped three to a code, then rqrr on each group's square (twice the size when its
  modules are small). Three finder patterns rqrr cannot read are still reported, with no payload.
  Payloads go only into the read's answer (R15).
- **Caps** (§10.3): 64 detector runs, 3,000 blobs in a run and 1,000 lines a read. A read that
  reaches one answers `partial` with what it did not finish (R21).
- **The careful pass** (§5.6): `careful { read, lines }` re-reads those lines' crops with the small
  recogniser and frees them; `release { read }` frees them without.
- **The look pass** (§5.2): every `step`-th frame scaled to 1/k in grey; 8×8 tiles changed when
  their mean absolute difference is over 2 levels or their largest over 24; changed tiles joined
  into regions (8-connected, boxes within 2 tiles merged); for a region of 12×6 tiles or more, the
  move found from its gradient's row and column profiles, refined to an eighth of a look pixel, the
  best and up to two alternatives at 0.85 of it scored by 2-D gradient NCC, and the diagonal one
  when that NCC is 0.9 or more (R11, R12).
  `tiles` is base64 of the bit string over the tile grid, row by row, tile i in bit i % 8 of byte
  i / 8 (lowest bit first); the first frame has every tile changed. A move's `dx`, `dy` are how far
  the region's content moved since the last analysed frame, in video pixels, positive right and
  down; its `box` is the region at this frame.
- **Follow sessions** (§5.8): a session decodes its span once at half size in grey, forward as asked,
  backward half a second at a time newest first with two pieces kept (R22). A track's parts are
  templates of Sobel gradient magnitude (selection and dark mode do not change it, R13). A
  candidate `{ dx, dy, scale }` moves the whole track: a point p of the track at its template frame
  goes to C + scale·(p − C) + (dx, dy), C the centre of its parts then. A match searches ±4 template
  pixels around each candidate's place and answers the best candidate refined, every asked part's
  score at that one placement, and `second`, the best score of any other place more than 2 video
  pixels away, so main can refuse a match that is not clearly the best (R14).
- **Crashes** (§10.4, §10.5): each read runs inside `catch_unwind` and answers `panic`; the panic
  hook prints `ssw-ocr: panic at <file>:<line>` and nothing of the payload (R19). On Windows the
  helper calls `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)`,
  `WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP)` and `SetUnhandledExceptionFilter` with a filter that
  ends the process with `TerminateProcess`, all from kernel32, and runs ffmpeg in a job object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (R8). The installer also excludes it from Windows Error
  Reporting (`build/installer.nsh`).
- **The Windows reader** (§5.13): `open { reader: 'windows' }` uses `Windows.Media.Ocr`; each word's
  characters get equal shares of its box. The app never asks for it while `WINDOWS_READER_ALLOWED`
  is false; R10 measures it on the reference PC.

## Building

    node scripts/build-native.mjs --ocr        # Windows x64 (MinGW, from Linux): native/bin/ssw-ocr.exe
    node scripts/build-native.mjs --ocr-host   # this machine: native/bin/ssw-ocr (the end-to-end runs)

Both build `--release --locked` into `native/ocr/target/<win|host>`. The release profile is the
mixed one: `opt-level = "s"` with LTO, one codegen unit and symbols stripped, `opt-level = 3` for
`tract-linalg` and `tract-core`, and `panic = "unwind"` (reads run inside `catch_unwind`). The
Windows build's imports must be `OCR_IMPORTS`, its size within `OCR_BUDGET`, and it must not hold
the test build's `readImage` (`scripts/lib/packaging.cjs`, checked again by `verify-dist`).

## Testing

    cd native/ocr
    cargo test --bins                                        # the unit tests
    SSW_OCR_MODELS=<folder of the five files> SSW_OCR_PYTHON=<python with numpy, opencv-python-headless, pyyaml> \
      cargo test --profile test-fast --features fixture --test cli -- --test-threads 2

The `fixture` feature (test builds only) adds `readImage { png, areas }`, `stats` (the counters of
`src/stats.rs`) and `panicOn { text }`. The scored tests (R4, R17, R18) read the evaluation set
with `tests/eval_reads.py` and score it with `scripts/privacy/score_reader.py`'s rules; R18 renders
the set at 150% and 200% with `scripts/privacy/make-eval-set.mjs --scale` (Playwright and
Chromium). They fail, never skip, without their prerequisites. R8 and R10 need Windows: they are
ignored elsewhere and run on the reference PC (decision 8).

`npm run test:native` also runs `tests/native/ocr.spec.ts`: main's `OcrHelper` against the host
build (`SSW_OCR_HELPER_TEST`, or native/bin/ssw-ocr) with the models in `SSW_OCR_MODELS`.

## Measured (23 Nov 2026, the shared 4-CPU Linux machine, one thread, the `test-fast` profile)

- **R4, careful-long on the 24 evaluation frames** (scored with `score_reader.py`'s stand-in rules):
  pattern recall 99.6, padded coverage 99.6 (ONNX Runtime 100.0 and 100.0, §5.6); every item's ink
  under the reader's padded lines 98.7 (ONNX Runtime 98.3); folded exact text 95.4 (94.6); 2 of 255
  ordinary items touched, 4 stray covers. The one item missed reads `DB_PASSWORD："…"` with a
  full-width colon.
- **R17, the same frames through settle-shaped areas** (each planted text's row to 64 px past it,
  64 px above and below, packed, padded and tiled): 99.2 and 99.2, within 0.5 of whole frames. Areas
  cut tight around a value alone lose the label beside or above it (97.9: the first build's number),
  which is the plan's to keep, not the reader's.
- **R18**: at 150% (2880×1620) every item's ink is under its lines as at 100% (98.7).
- **R16**: a read at 19 minutes of a 20-minute clip decodes 11 frames (one key-frame interval is 15).
- **R11**: the look pass analyses a 480×270 look frame of a whole-screen scroll in about 2.2 ms (the
  worst case: one region the size of the frame); a still frame costs the tile difference only.
- **R22**: 20 tracks of one part each over 300 frames: each frame decoded once, matching 0.008 ms a
  part a frame.
- **Open**: 1.4 s with every plan built. A whole 1080p frame reads in 1.2-1.9 s with the tiny
  recogniser, and its careful re-reads add about 0.15 s a line.

**The Windows build** (MinGW, the mixed profile, 23 Nov 2026): 16,323,072 bytes, 4,083,315 bytes
brotli-compressed (quality 11, 16 MB window), under decision 1's 5 MB line; the tract skeleton alone
was 3,336,375. Its imports are exactly `OCR_IMPORTS`. `opt-level = "z"` for everything but tract's
kernels and this crate made it larger (21.5 MB, 4.74 MB compressed). Under wine it starts, answers
`opened` with every plan built in about 2 s, and ends when its stdin closes.

The reference PC measures speed and memory again at 1080p, 4K and 7680×2160 before release
(decision 8), with the Windows build.
