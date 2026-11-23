# Privacy evaluation tools (auto-blur, F-07 / LT-05)

These scripts and the frames in `tests/fixtures/privacy-eval` are the evidence behind
`docs/design/auto-blur.md`. None of it ships in the app. No model file is stored here: the reader's
models are downloaded by their pinned size and SHA-256 (`reader-models.json`).

Measured on 23 Nov 2026 on a shared 4-CPU machine (Intel Xeon 2.10 GHz, AVX2 and AVX-512),
every reader on one thread. Absolute times are inflated by the other job (load 1.4-6); ratios
between configurations are the reliable part.

## The evaluation set

`tests/fixtures/privacy-eval/`:

- `01-…png` to `24-…png`: 24 lossless 1920x1080 PNG screenshots (3,470,088 bytes), 12 scenes
  (code editor, small-font editor, terminal, logs, dashboard, CRM, inbox, settings, 2FA setup,
  checkout and bank forms, chat, docs), each dark and light, at 100, 125 and 150% scale.
- `truth.json.gz`: every planted item (510: 240 to cover by default, 16 off by default, 255
  ordinary texts that must stay visible) with its kind, text and pixel rectangles, read back from
  the rendered page. `holdout-truth.json.gz`: the same for the held-out set (below).
- `reads/*.json.gz`: the PP-OCRv6 reads of both sets (`tiny`, `careful-narrow`, and `careful-long`
  built by `careful_long.py`), as `score_reader.py read` wrote them: each line's quad, box, text, confidence and the x-range of
  every character. The text rules can be scored on these without the models.
- `rule-vectors.json`: 178 screen and 25 speech vectors for the text rules. Token-shaped values
  are seeded placeholders (`«=ghp_|A36»`), expanded by `detect/runVectors.mjs`.

Every name, company, address, number, key and token in the set is invented. People: Priya Raman,
Tomasz Kowalczyk, Aisha Rahman, Jordan Ellis and Mei Lin Chen (the listed names), and others
marked ordinary. Mail domains are reserved (`.test`, `.example`, `example.com`) or invented
(`acme-cloud.io`, Contoso, Fabrikam, Northwind). Phone numbers use the fiction ranges where a
country has one (US 555-01xx, UK 07700 900xxx and 020 7946 0xxx, France 01 99 00, Australia
0491 570 xxx and 02 5550, Germany 030 23125); for countries without one (Poland, Spain,
Bangladesh, Japan, Brazil) they are made-up sequences. Cards and IBANs are random numbers that
pass Luhn or mod 97. Keys and tokens are random strings in the real formats.

Because the truth file, the reads and the scores hold those fake keys in their real formats, they
are stored gzip-compressed (`gzip -n -9`), so secret scanning does not take them for leaked
credentials. `tests/fixtures/privacy-eval/.gitignore` keeps an unpacked copy out of the tree.
Unpack before using the Python tools:

    gzip -dkf tests/fixtures/privacy-eval/truth.json.gz

## Rendering it again

    node scripts/privacy/make-eval-set.mjs                       # tests/fixtures/privacy-eval
    node scripts/privacy/make-eval-set.mjs /tmp/holdout --holdout
    node scripts/privacy/make-eval-set.mjs /tmp/holdout2 --holdout --seed 9000
    node scripts/privacy/make-eval-set.mjs /tmp/x2 --scale 2       # 3840x2160 (1.5: 2880x1620)

`--seed` starts the tokens at another seed: `--holdout --seed 9000` is the second held-out set,
rendered only at test time by A16 and the release check and never committed, so no rule is tuned
on it. `--scale` draws the same layout at a device scale of 1.5 or 2, with every truth rectangle
scaled with it (R18). Without them the output is byte for byte what it was.

Needs Playwright 1.63 with Chromium 157.0.8103.78 (`CHROMIUM_PATH` picks the executable) and the
fonts Inter, JetBrains Mono, DejaVu Sans Mono, Liberation Sans and Mono, and Carlito. A second
render on the same machine was byte-identical. The held-out set has new tokens (seeds 5000+),
dark and light swapped and the scales rotated (100 to 125 to 150 to 100); its frames are not
committed. `eval-qr.json` holds the QR codes' module matrices, written by `make_qr.py` (segno
1.6.6, BSD-3-Clause).

## Scoring a reader

Python 3.13 with onnxruntime 1.32.0, opencv-python-headless 5.1.0.95, numpy 2.5.5, pyclipper
1.4.0, shapely 2.2.0, pyyaml 6.0.4, onnx 1.23.2, psutil 7.2.2 and brotli 1.2.1, run with `-I`.
`--models` is a folder holding the six `PP-OCRv6_<size>_<det|rec>_onnx` repositories at the
commits pinned in `reader-models.json`.

    python3 -I scripts/privacy/score_reader.py read --set tests/fixtures/privacy-eval \
        --models MODELS --config tiny --out reads/tiny.json
    python3 -I scripts/privacy/score_reader.py score --set tests/fixtures/privacy-eval reads/*.json

- `ppocr.py`: PaddleOCR-equivalent pre- and post-processing (DB boxes with unclip, rotated crops of
  height 48, CTC decoding, each character's x-range from its CTC steps).
- `rules.py`: stand-in detection rules used by the scorer. They are not the product's rules
  (those are `detect/rules.mjs`, the prototype of `src/shared/privacy/detect`).
- `tract_parity.py`: compares tract (through `tract-skeleton`'s `parity` tool) with ONNX Runtime
  on the detector maps and the recognisers' CTC steps.
- `careful_long.py`: builds the reads of the careful pass this design ships (careful-narrow's
  trigger plus any line holding 16 or more token characters) from a careful-narrow and a careful run.
  Its frames keep careful-narrow's timings; the added re-reads cost the small recogniser's mean per
  line (66-72 ms on these frames), which the design adds by hand.
- `results/contracts-rescore.txt`: the shipped bytes measured again from their pinned commits by the
  build's contracts step; every figure equals the design's §5.6.
- `results/score-main.json.gz`, `score-main-timing.json.gz`, `score-holdout.json.gz`,
  `score-careful-long-main.json.gz`, `score-careful-long-holdout.json.gz`,
  `tract-parity.json`, `tract-profiles-speed.json`: the measurements the design quotes.

## The text rules prototype (`detect/`)

`detect/RULES.md` is the full rule table (exact patterns, scores, sources). `detect/rules.mjs` is a
prototype of every rule. With `src/shared/publish/tlds.ts` and libphonenumber-js 1.13.16's
`metadata.max.json` (read as data):

    node scripts/privacy/detect/runVectors.mjs tests/fixtures/privacy-eval/rule-vectors.json \
        src/shared/publish/tlds.ts METADATA.max.json
    node scripts/privacy/detect/evalReads.mjs truth.json reads/main-tiny.json \
        src/shared/publish/tlds.ts METADATA.max.json
    node scripts/privacy/detect/corpus.mjs . src/shared/publish/tlds.ts METADATA.max.json
    node scripts/privacy/detect/speechFp.mjs .

Results: all 203 vectors pass; on the tiny reads 233 of 233 text items found and 227 fully covered
(`results/detect-eval-reads.txt`), and on the held-out reads 229 found and 224 covered
(`results/detect-eval-reads-holdout.txt`: wrapped JWTs and tokens, a key read with a space); false hits per corpus in `results/detect-corpus.txt` and
`results/detect-speech-fp.txt`. `phone_rate.py` measures how many random digit strings a
country's phone metadata accepts; `gl_extract.py` prints gitleaks rules from its `gitleaks.toml`
(v8.30.1, MIT); `closure.mjs` lists the files a vendored ES module reaches; `gen.mjs` and
`gen2.mjs` print the Luhn and mod-97 values the vectors use.

## The tract skeleton (`tract-skeleton/`)

A Rust crate (tract-onnx 0.23.10, MIT OR Apache-2.0, Rust 1.91 or later) that checks each model's
size and SHA-256 before parsing it, reads one 1920x1088 tile and its lines, and prints JSON lines.
It measured the size tract adds to a Windows helper:

    cargo build --release --target x86_64-pc-windows-gnu      # also --profile release-mixed, release-s
    node scripts/privacy/tract-skeleton/brotli-size.cjs target/x86_64-pc-windows-gnu/release/skeleton.exe

| Profile | Installed | Brotli 11 |
|---|---|---|
| opt-level 3 | 18,983,936 B | 4,188,088 B |
| mixed (s, with tract-linalg and tract-core at 3) | 14,267,904 B | 3,336,375 B |
| opt-level s | 11,014,656 B | 2,669,488 B |

Its Windows imports are bcryptprimitives, kernel32, api-ms-win-core-synch-l1-2-0, ntdll and msvcrt.

## Plans and decoding (`bench-buckets.sh`, `decode-speed.sh`)

`bench-buckets.sh` builds tract plans for the reader's fixed buckets with the skeleton's `parity`
tool (mixed profile) on zero inputs, one thread, one CPU: the tiny detector at 640x352, 960x544
and 1920x1088, and both recognisers at the five line widths. It prints each plan's build time,
each run's time and the process's peak memory, alone and with every bucket's plan kept.
`results/tract-buckets.txt` (23 Nov 2026, load 1.0-1.4):

| Plans kept | Build | One run | Peak memory |
|---|---|---|---|
| tiny det 640x352 | 127 ms | 71-77 ms | 46,680 KB |
| tiny det 960x544 | 144 ms | 141-215 ms | 79,068 KB |
| tiny det 1920x1088 | 150 ms | 871-909 ms | 250,896 KB |
| tiny det, all three | 367 ms | as above | 258,564 KB |
| small rec, 320-1280 | 533 ms | 35-160 ms | 188,260 KB |
| tiny rec, 320-1280 | 232 ms | 8.5-54 ms | 58,144 KB |

`decode-speed.sh` encodes a 20 s 1080p60 scrolling clip as Flown's proxy is (libx264, constant
rate, a key frame every 15 frames) and times ffmpeg 6.1.1 on one thread
(`results/decode-speed.txt`). CPU time a frame, two runs: decode only 1.77-1.86 ms; decoded and
scaled to the look pass's 480x270 grey 2.47-2.49 ms; to the follow pass's 960x540 grey
3.05-3.06 ms; to full-size RGB24 3.69-4.05 ms. One read made by seeking to the key frame before
it costs 0.094-0.106 s of CPU and 0.10-0.12 s, or 0.16 s wall with the process start.
